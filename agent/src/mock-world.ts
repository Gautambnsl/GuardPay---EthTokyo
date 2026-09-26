import { createHash, randomBytes, randomUUID } from "node:crypto";
import express, { Router } from "express";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { ORB_ACR } from "./worldid.js";

/**
 * Mock World ID issuer (WORLD_MODE=mock). Proofs are mocked, the protocol is not:
 * it implements the same OIDC discovery, device_authorization, token and JWKS endpoints as
 * sandbox.auth.world.org and signs real RS256 id_tokens, so worldid.ts verifies them with the
 * exact code used against World. The "World App" side (approve/deny) is exposed for the dashboard.
 */

interface DeviceRequest {
  deviceCode: string;
  userCode: string;
  clientId: string;
  bindingMessage: string;
  createdAt: number;
  expiresAt: number;
  state: "pending" | "approved" | "denied";
  approvedAt?: number;
  sub?: string;
  issued?: boolean;
}

export async function mockWorldRouter(issuer: string): Promise<Router> {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const kid = randomUUID();
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" };
  const requests = new Map<string, DeviceRequest>(); // by deviceCode
  const EXPIRES_IN = 600;

  const byUserCode = (code: string) => [...requests.values()].find((r) => r.userCode === code);
  const r = Router();
  r.use(express.urlencoded({ extended: false }), express.json());

  r.get("/.well-known/openid-configuration", (_req, res) =>
    res.json({
      issuer,
      device_authorization_endpoint: `${issuer}/api/v1/device_authorization`,
      token_endpoint: `${issuer}/api/v1/token`,
      jwks_uri: `${issuer}/.well-known/jwks.json`,
      grant_types_supported: ["urn:ietf:params:oauth:grant-type:device_code"],
      acr_values_supported: [ORB_ACR],
      id_token_signing_alg_values_supported: ["RS256"],
      subject_types_supported: ["pairwise"],
    }),
  );
  r.get("/.well-known/jwks.json", (_req, res) => res.json({ keys: [jwk] }));

  const clientIdOf = (req: express.Request) => {
    const auth = req.headers.authorization;
    if (auth?.startsWith("Basic ")) return decodeURIComponent(Buffer.from(auth.slice(6), "base64").toString().split(":")[0]!);
    return req.body?.client_id as string;
  };

  r.post("/api/v1/device_authorization", (req, res) => {
    const clientId = clientIdOf(req);
    if (!clientId) return res.status(401).json({ error: "invalid_client" });
    const userCode = randomBytes(4).toString("hex").toUpperCase().replace(/(.{4})/, "$1-");
    const d: DeviceRequest = {
      deviceCode: randomBytes(24).toString("base64url"),
      userCode,
      clientId,
      bindingMessage: String(req.body?.binding_message ?? "Approve agent action"),
      createdAt: Date.now(),
      expiresAt: Date.now() + EXPIRES_IN * 1000,
      state: "pending",
    };
    requests.set(d.deviceCode, d);
    res.json({
      device_code: d.deviceCode,
      user_code: userCode,
      verification_uri: `${issuer}/activate`,
      verification_uri_complete: `${issuer}/activate?user_code=${userCode}`,
      expires_in: EXPIRES_IN,
      interval: 1,
    });
  });

  r.post("/api/v1/token", async (req, res) => {
    if (req.body?.grant_type !== "urn:ietf:params:oauth:grant-type:device_code")
      return res.status(400).json({ error: "unsupported_grant_type" });
    const d = requests.get(String(req.body?.device_code));
    if (!d || d.clientId !== clientIdOf(req)) return res.status(400).json({ error: "invalid_grant" });
    if (Date.now() > d.expiresAt) return res.status(400).json({ error: "expired_token" });
    if (d.state === "denied") return res.status(400).json({ error: "access_denied" });
    if (d.state === "pending") return res.status(400).json({ error: "authorization_pending" });
    if (d.issued) return res.status(400).json({ error: "invalid_grant", error_description: "device_code already used" });
    d.issued = true;
    const now = Math.floor(Date.now() / 1000);
    const id_token = await new SignJWT({
      acr: ORB_ACR,
      amr: ["orb"],
      auth_time: Math.floor(d.approvedAt! / 1000),
    })
      .setProtectedHeader({ alg: "RS256", kid, typ: "JWT" })
      .setIssuer(issuer)
      .setAudience(d.clientId)
      .setSubject(d.sub!)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .setJti(randomUUID())
      .sign(privateKey);
    res.json({ access_token: randomBytes(24).toString("base64url"), token_type: "Bearer", expires_in: 300, id_token });
  });

  // ── "World App" side, used by the dashboard's approval card ─────────────────
  r.get("/app/requests", (_req, res) =>
    res.json(
      [...requests.values()]
        .filter((d) => d.state === "pending" && Date.now() < d.expiresAt)
        .map((d) => ({ userCode: d.userCode, bindingMessage: d.bindingMessage, createdAt: d.createdAt })),
    ),
  );
  r.post("/app/requests/:userCode/:action", (req, res) => {
    const d = byUserCode(req.params.userCode);
    if (!d || d.state !== "pending") return res.status(404).json({ error: "no pending request" });
    if (req.params.action === "approve") {
      d.state = "approved";
      d.approvedAt = Date.now();
      // Pairwise subject for the (mock) Orb-verified human who approved.
      const human = String(req.body?.human ?? "treasurer");
      d.sub = createHash("sha256").update(`${human}:${d.clientId}`).digest("hex").slice(0, 32);
    } else if (req.params.action === "deny") {
      d.state = "denied";
    } else return res.status(400).json({ error: "action must be approve or deny" });
    res.json({ ok: true, state: d.state });
  });

  return r;
}
