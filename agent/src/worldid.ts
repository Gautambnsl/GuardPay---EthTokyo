import { createHash, randomUUID } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { cfg, env, optionalEnv } from "@guardpay/shared";

/**
 * World ID for Agents: fresh human approval for high-risk payments.
 *
 * Flow = OIDC Device Authorization Grant (RFC 8628), which World ID for Agents supports for
 * "confidential-client device login with explicit human approval":
 *   1. agent POSTs device_authorization -> user_code + verification_uri shown to the treasurer
 *   2. treasurer opens it in World App and approves (or denies / lets it expire)
 *   3. agent polls token endpoint -> id_token
 *   4. id_token is validated HERE, on the backend (JWKS signature, iss, aud, exp, acr=orb,
 *      auth_time freshness, single-use jti, bound to one payment intent). Only then may we pay.
 *
 * WORLD_MODE=oidc -> https://sandbox.auth.world.org (needs WORLD_CLIENT_ID/SECRET)
 * WORLD_MODE=mock -> local issuer in mock-world.ts speaking the same protocol with real RS256
 *                    tokens, so this exact verification code runs in both modes.
 */

export const ORB_ACR = "https://world.org/oidc/acr/orb-v3";

export interface PaymentIntent {
  invoiceId: number;
  payTo: string;
  asset: string;
  amount: string; // atomic
  network: string;
}

export const intentHash = (i: PaymentIntent) =>
  "0x" +
  createHash("sha256")
    .update(JSON.stringify([i.invoiceId, i.payTo.toLowerCase(), i.asset.toLowerCase(), i.amount, i.network]))
    .digest("hex");

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "cancelled" | "invalid";

export interface Approval {
  id: string;
  intent: PaymentIntent;
  intentHash: string;
  bindingMessage: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  requestedAt: number; // ms
  expiresAt: number; // ms
  status: ApprovalStatus;
  reason?: string;
  claims?: Pick<JWTPayload, "sub" | "iss" | "aud" | "jti"> & { acr?: string; auth_time?: number };
}

interface WorldConfig {
  mode: "mock" | "oidc";
  issuer: string;
  clientId: string;
  clientSecret: string;
  ttlSeconds: number;
  maxAuthAgeSeconds: number;
  approverSubs?: string[];
}

export function worldConfig(): WorldConfig {
  const mode = env("WORLD_MODE", "mock") === "oidc" ? "oidc" : "mock";
  if (mode === "oidc") {
    return {
      mode,
      issuer: env("WORLD_ISSUER", "https://sandbox.auth.world.org"),
      // TODO(team): register a sandbox app (world-id-agent-plugin) and set these to go live.
      clientId: env("WORLD_CLIENT_ID"),
      clientSecret: env("WORLD_CLIENT_SECRET"),
      ttlSeconds: Number(env("WORLD_APPROVAL_TTL_SECONDS", "90")),
      maxAuthAgeSeconds: Number(env("WORLD_MAX_AUTH_AGE_SECONDS", "300")),
      approverSubs: optionalEnv("WORLD_APPROVER_SUBS")?.split(","),
    };
  }
  return {
    mode,
    issuer: `http://localhost:${cfg.agentPort()}/mock-world`,
    clientId: "guardpay-treasury-agent",
    clientSecret: "mock-secret",
    ttlSeconds: Number(env("WORLD_APPROVAL_TTL_SECONDS", "90")),
    maxAuthAgeSeconds: Number(env("WORLD_MAX_AUTH_AGE_SECONDS", "300")),
    approverSubs: optionalEnv("WORLD_APPROVER_SUBS")?.split(","),
  };
}

// ─── Discovery / JWKS ─────────────────────────────────────────────────────────

interface Discovery { issuer: string; device_authorization_endpoint: string; token_endpoint: string; jwks_uri: string }
const discoveryCache = new Map<string, Promise<Discovery>>();
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function discover(issuer: string): Promise<Discovery> {
  if (!discoveryCache.has(issuer)) {
    const p = fetch(`${issuer}/.well-known/openid-configuration`).then(async (r) => {
      if (!r.ok) throw new Error(`OIDC discovery failed: ${r.status}`);
      return (await r.json()) as Discovery;
    });
    p.catch(() => discoveryCache.delete(issuer));
    discoveryCache.set(issuer, p);
  }
  return discoveryCache.get(issuer)!;
}

const basicAuth = (c: WorldConfig) =>
  "Basic " + Buffer.from(`${encodeURIComponent(c.clientId)}:${encodeURIComponent(c.clientSecret)}`).toString("base64");

// ─── Approval lifecycle ───────────────────────────────────────────────────────

const approvals = new Map<string, Approval & { deviceCode: string; interval: number }>();
const usedJti = new Set<string>();
const listeners = new Set<(a: Approval) => void>();

export const onApprovalChange = (fn: (a: Approval) => void) => (listeners.add(fn), () => listeners.delete(fn));
const publicView = ({ deviceCode: _d, interval: _i, ...a }: Approval & { deviceCode: string; interval: number }): Approval => a;
export const listApprovals = () => [...approvals.values()].map(publicView);

function setStatus(id: string, status: ApprovalStatus, reason?: string, claims?: Approval["claims"]) {
  const a = approvals.get(id);
  if (!a || a.status !== "pending") return;
  Object.assign(a, { status, reason, claims });
  listeners.forEach((fn) => fn(publicView(a)));
}

export function bindingMessageFor(intent: PaymentIntent) {
  return `Approve GuardPay payment: invoice #${intent.invoiceId}, ${(Number(intent.amount) / 1e6).toFixed(2)} USDC to ${intent.payTo}`;
}

/** Step 1: ask World ID for a fresh human approval of exactly this payment. */
export async function requestApproval(intent: PaymentIntent, opts: { ttlSeconds?: number } = {}): Promise<Approval> {
  const c = worldConfig();
  const d = await discover(c.issuer);
  const hash = intentHash(intent);
  const bindingMessage = bindingMessageFor(intent);
  const res = await fetch(d.device_authorization_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", authorization: basicAuth(c) },
    body: new URLSearchParams({
      client_id: c.clientId,
      scope: "openid",
      acr_values: ORB_ACR,
      // Shown to the human by the mock issuer; unknown params are ignored by standard servers.
      binding_message: bindingMessage,
    }),
  });
  const body = (await res.json()) as {
    device_code: string; user_code: string; verification_uri: string; verification_uri_complete?: string;
    expires_in: number; interval?: number; error?: string; error_description?: string;
  };
  if (!res.ok) throw new Error(`device_authorization failed: ${body.error ?? res.status} ${body.error_description ?? ""}`);

  console.log(`[world] POST ${new URL(d.device_authorization_endpoint).pathname} → user_code ${body.user_code} (${c.issuer})`);
  const now = Date.now();
  const ttl = Math.min(body.expires_in, opts.ttlSeconds ?? c.ttlSeconds);
  const a = {
    id: randomUUID(),
    intent,
    intentHash: hash,
    bindingMessage,
    userCode: body.user_code,
    verificationUri: body.verification_uri,
    verificationUriComplete: body.verification_uri_complete,
    requestedAt: now,
    expiresAt: now + ttl * 1000,
    status: "pending" as ApprovalStatus,
    deviceCode: body.device_code,
    interval: body.interval ?? 2,
  };
  approvals.set(a.id, a);
  listeners.forEach((fn) => fn(publicView(a)));
  return publicView(a);
}

/** Operator cancelled the pending approval (dashboard). The payment will not execute. */
export function cancelApproval(id: string) {
  setStatus(id, "cancelled", "approval request cancelled by operator");
}

/** Steps 3 + 4: poll until approved/denied/expired; an approval only counts once the id_token verifies. */
export async function waitForApproval(id: string): Promise<Approval> {
  const a = approvals.get(id);
  if (!a) throw new Error(`unknown approval ${id}`);
  const c = worldConfig();
  const d = await discover(c.issuer);
  let interval = a.interval;

  while (a.status === "pending") {
    if (Date.now() >= a.expiresAt) {
      setStatus(id, "expired", "no human approval before the deadline");
      break;
    }
    await new Promise((r) => setTimeout(r, interval * 1000));
    if (a.status !== "pending") break; // cancelled while waiting

    const res = await fetch(d.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", authorization: basicAuth(c) },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: a.deviceCode,
        client_id: c.clientId,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { id_token?: string; error?: string; error_description?: string };
    console.log(`[world] POST token (device_code) → ${res.ok && body.id_token ? "id_token received" : body.error}`);
    if (res.ok && body.id_token) {
      try {
        const claims = await verifyApprovalToken(body.id_token, a, c, d);
        console.log(`[world] id_token verified: iss ✓ aud ✓ sig(JWKS) ✓ acr=orb ✓ fresh ✓ jti single-use ✓ (sub ${claims.sub?.slice(0, 10)}…)`);
        setStatus(id, "approved", "verified World ID human approval", claims);
      } catch (e) {
        setStatus(id, "invalid", `id_token rejected: ${(e as Error).message}`);
      }
    } else if (body.error === "authorization_pending") {
      continue;
    } else if (body.error === "slow_down") {
      interval += 5;
    } else if (body.error === "access_denied") {
      setStatus(id, "denied", "human denied the approval in World ID");
    } else if (body.error === "expired_token") {
      setStatus(id, "expired", "World ID approval request expired");
    } else {
      setStatus(id, "invalid", `token endpoint error: ${body.error ?? res.status} ${body.error_description ?? ""}`);
    }
  }
  return publicView(a);
}

/**
 * Backend validation of the World ID id_token. Every check must pass for the approval to count.
 */
export async function verifyApprovalToken(
  idToken: string,
  a: Pick<Approval, "requestedAt" | "intentHash">,
  c: WorldConfig = worldConfig(),
  d?: Discovery,
): Promise<NonNullable<Approval["claims"]>> {
  d ??= await discover(c.issuer);
  if (!jwksCache.has(d.jwks_uri)) jwksCache.set(d.jwks_uri, createRemoteJWKSet(new URL(d.jwks_uri)));
  const { payload } = await jwtVerify(idToken, jwksCache.get(d.jwks_uri)!, {
    issuer: c.issuer, // token minted by World ID (or the configured mock issuer)
    audience: c.clientId, // for this agent, not another app
    algorithms: ["RS256"],
    requiredClaims: ["sub", "exp", "iat", "auth_time"],
  });
  const p = payload as JWTPayload & { acr?: string; auth_time?: number };

  if (p.acr !== ORB_ACR) throw new Error(`acr ${p.acr ?? "missing"} is not Orb-verified human`);
  const authMs = (p.auth_time ?? 0) * 1000;
  // Fresh: the human authenticated for THIS request, not a reused earlier session.
  if (authMs < a.requestedAt - 5_000) throw new Error("auth_time predates this approval request (stale session)");
  if (Date.now() - authMs > c.maxAuthAgeSeconds * 1000) throw new Error("approval too old");
  if (!p.jti) throw new Error("jti missing");
  if (usedJti.has(p.jti)) throw new Error("replayed approval token");
  if (c.approverSubs && !c.approverSubs.includes(p.sub!)) throw new Error("human is not an authorized treasury approver");
  usedJti.add(p.jti);

  return { sub: p.sub, iss: p.iss, aud: p.aud, jti: p.jti, acr: p.acr, auth_time: p.auth_time };
}

export function getApproval(id: string) {
  const a = approvals.get(id);
  return a && publicView(a);
}

/** Single-use: an approval is consumed by exactly one payment of exactly this intent. */
export function consumeApproval(id: string, intent: PaymentIntent): Approval {
  const a = approvals.get(id);
  if (!a) throw new Error("unknown approval");
  if (a.status !== "approved") throw new Error(`approval is ${a.status}`);
  if (a.intentHash !== intentHash(intent)) throw new Error("approval was granted for a different payment");
  if (Date.now() - (a.claims?.auth_time ?? 0) * 1000 > worldConfig().maxAuthAgeSeconds * 1000)
    throw new Error("approval went stale before execution");
  approvals.delete(id);
  return publicView(a);
}
