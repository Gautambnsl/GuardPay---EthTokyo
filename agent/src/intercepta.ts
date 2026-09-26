import { env, optionalEnv } from "@guardpay/shared";
import type { EvmExactAuthorization } from "./x402.js";

/**
 * Intercepta (Web3 Antivirus) screening pipeline. Live API only, no mocks.
 * Docs: https://docs.web3antivirus.io/reference/api-overview
 *
 * Intercepta's intelligence is mainnet data, but our payments run on Base Sepolia.
 * So we screen the *real* payTo address as-is, and map the testnet asset / EIP-712 domain
 * to their Base mainnet equivalents (same token, same authorization shape).
 */

export type ScreenVerdict = "CLEAN" | "CAUTION" | "HOLD" | "BLOCK";
const SEVERITY: Record<ScreenVerdict, number> = { CLEAN: 0, CAUTION: 1, HOLD: 2, BLOCK: 3 };
export const worst = (vs: ScreenVerdict[]): ScreenVerdict =>
  vs.reduce((a, b) => (SEVERITY[b] > SEVERITY[a] ? b : a), "CLEAN");

export interface CheckResult {
  check: "payTo" | "token" | "authorization";
  endpoint: string;
  verdict: ScreenVerdict;
  reason: string;
  ms: number;
  raw?: unknown;
}

export interface Screening {
  verdict: ScreenVerdict;
  reasons: string[];
  checks: CheckResult[];
}

// Base Sepolia -> Base mainnet asset mapping (Intercepta has no testnet data).
const MAINNET_EQUIVALENT: Record<string, `0x${string}`> = {
  "0x036cbd53842c5426634e7929541ec2318f3dcf7e": "0x833589fCD6eDb6E08f4c7C32D4f71b54bda02913", // USDC
};
export const mainnetAsset = (testnetAsset: string) =>
  MAINNET_EQUIVALENT[testnetAsset.toLowerCase()] ?? (testnetAsset as `0x${string}`);

const base = () => env("INTERCEPTA_BASE_URL", "https://api.web3antivirus.io");
const chainId = () => env("INTERCEPTA_CHAIN_ID", "8453");

class InterceptaError extends Error {}

// The API key is rate limited per second: space requests out and retry 429s with backoff.
const MIN_SPACING_MS = 400;
let nextSlot = 0;
async function slot() {
  const wait = Math.max(0, nextSlot - Date.now());
  nextSlot = Math.max(Date.now(), nextSlot) + MIN_SPACING_MS;
  if (wait) await new Promise((r) => setTimeout(r, wait));
}

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const key = optionalEnv("INTERCEPTA_API_KEY");
  // Without a key every check fails closed to HOLD (human approval).
  if (!key) throw new InterceptaError("INTERCEPTA_API_KEY not set");
  for (let attempt = 0; ; attempt++) {
    await slot();
    const res = await fetch(`${base()}${path}`, {
      method,
      headers: { "X-API-KEY": key, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    if (res.status === 429 && attempt < 3) {
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      continue;
    }
    if (!res.ok) throw new InterceptaError(`HTTP ${res.status} ${text.slice(0, 200)}`);
    return JSON.parse(text) as T;
  }
}

// ─── Address: quick-scan (+ deep scan when anything shows up) ─────────────────

interface ToxicScoreTrait { risk: number; name: string; txsCount: number; description: string }
interface ToxicScoreResponse { toxicScore: number; traits: ToxicScoreTrait[] }

const HARD_BLOCK_TRAITS = new Set([
  "known_scammer",
  "sanction_address",
  "blacklist",
  "initiator_scam_transactions",
  "fake_phishing_transfer",
  "fake_phishing_contract_communication",
  "attack_money_target",
  "rug_pull",
  "zero_address_risk",
]);

export function addressVerdict(r: ToxicScoreResponse): { verdict: ScreenVerdict; reason: string } {
  const traits = r.traits ?? [];
  const hard = traits.filter((t) => HARD_BLOCK_TRAITS.has(t.name));
  const names = traits.map((t) => t.name).join(", ");
  if (hard.length) return { verdict: "BLOCK", reason: `payTo flagged: ${hard.map((t) => t.name).join(", ")} (toxicScore ${r.toxicScore})` };
  if (r.toxicScore >= 70) return { verdict: "BLOCK", reason: `payTo toxicScore ${r.toxicScore} >= 70 (${names || "no traits"})` };
  if (r.toxicScore >= 40) return { verdict: "HOLD", reason: `payTo toxicScore ${r.toxicScore} >= 40 (${names || "no traits"})` };
  if (r.toxicScore > 0 || traits.length) return { verdict: "CAUTION", reason: `payTo minor risk: toxicScore ${r.toxicScore}${names ? ` (${names})` : ""}` };
  return { verdict: "CLEAN", reason: "payTo has no known risk traits" };
}

async function screenAddress(address: string): Promise<CheckResult> {
  const t0 = Date.now();
  let endpoint = `GET /api/public/v2/extension/account/${address}/quick-scan`;
  try {
    const quick = await call<ToxicScoreResponse>("GET", `/api/public/v2/extension/account/${address}/quick-scan`);
    let r = quick;
    if (quick.toxicScore > 0 || quick.traits?.length) {
      // Something showed up: get the full picture before deciding.
      endpoint = `GET /api/public/v2/extension/account/${address}/toxic-score`;
      r = await call<ToxicScoreResponse>("GET", `/api/public/v2/extension/account/${address}/toxic-score`).catch(() => quick);
    }
    return { check: "payTo", endpoint, ...addressVerdict(r), ms: Date.now() - t0, raw: r };
  } catch (e) {
    return failClosed("payTo", endpoint, e, t0);
  }
}

// ─── Token: scan-token ─────────────────────────────────────────────────────────

interface TokenRiskResponse {
  riskScore: number;
  riskLevel: "neutral" | "low" | "medium" | "high";
  trust: "whitelist" | "blocklist" | "neutral";
  action: "block" | "warn" | "info";
  detectors: { code: string; description: string }[];
  token?: { symbol: string };
}

export function tokenVerdict(r: TokenRiskResponse): { verdict: ScreenVerdict; reason: string } {
  const codes = (r.detectors ?? []).map((d) => d.code).filter((c) => c !== "HIGH_REPUTATION_TOKEN");
  const label = `${r.token?.symbol ?? "token"} riskLevel=${r.riskLevel} action=${r.action} trust=${r.trust}`;
  if (r.action === "block" || r.trust === "blocklist" || r.riskLevel === "high")
    return { verdict: "BLOCK", reason: `${label}${codes.length ? ` [${codes.join(", ")}]` : ""}` };
  if (r.action === "warn" || r.riskLevel === "medium")
    return { verdict: "CAUTION", reason: `${label}${codes.length ? ` [${codes.join(", ")}]` : ""}` };
  return { verdict: "CLEAN", reason: label };
}

async function screenToken(testnetAsset: string): Promise<CheckResult> {
  const t0 = Date.now();
  const asset = mainnetAsset(testnetAsset);
  const path = `/api/public/v2/extension/token-intelligence/token/${asset}/risks?chainId=${chainId()}`;
  const endpoint = `GET ${path}`;
  try {
    const r = await call<TokenRiskResponse>("GET", path);
    return { check: "token", endpoint, ...tokenVerdict(r), ms: Date.now() - t0, raw: r };
  } catch (e) {
    return failClosed("token", endpoint, e, t0);
  }
}

// ─── Payment authorization: scan-message (EIP-712) ────────────────────────────

interface SignatureAnalysis {
  riskGroup: "Low" | "Medium" | "High";
  messageType?: string | null;
  detectors: { code: string; description: string }[];
  addresses?: { address: string; detectors: string[] }[];
}

const MESSAGE_BLOCK_DETECTORS = new Set([
  "KNOWN_MALICIOUS",
  "WALLET_DRAINER",
  "SCAM_ADDRESS",
  "POISONING_ATTACK",
  "INITIATOR_SCAM_TRANSACTIONS",
  "RUG_PULL_RELATED",
]);

export function messageVerdict(r: SignatureAnalysis): { verdict: ScreenVerdict; reason: string } {
  const codes = (r.detectors ?? []).map((d) => d.code);
  const hard = codes.filter((c) => MESSAGE_BLOCK_DETECTORS.has(c));
  const label =
    `authorization riskGroup=${r.riskGroup}${codes.length ? ` [${codes.join(", ")}]` : ""}` +
    (r.messageType ? "" : " (Intercepta did not decode EIP-3009; recipient covered by payTo scan)");
  if (hard.length || r.riskGroup === "High") return { verdict: "BLOCK", reason: label };
  if (r.riskGroup === "Medium") return { verdict: "HOLD", reason: label };
  return { verdict: "CLEAN", reason: label };
}

/** The EIP-3009 typed data x402 signs, re-expressed on Base mainnet for screening. */
export function authorizationTypedData(auth: EvmExactAuthorization, testnetAsset: string, name: string, version: string) {
  return {
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    domain: { name, version, chainId: Number(chainId()), verifyingContract: mainnetAsset(testnetAsset) },
    message: auth,
  };
}

/** Local integrity check: the signed authorization must pay exactly the screened payTo and amount. */
export function authorizationMismatch(auth: EvmExactAuthorization, payTo: string, amount: string): string | undefined {
  if (auth.to.toLowerCase() !== payTo.toLowerCase()) return `authorization pays ${auth.to}, not the screened payTo ${payTo}`;
  if (auth.value !== amount) return `authorization value ${auth.value} != quoted amount ${amount}`;
}

async function screenAuthorization(input: ScreenInput): Promise<CheckResult> {
  const { authorization: auth, asset: testnetAsset, domain } = input;
  const t0 = Date.now();
  const endpoint = "POST /api/public/v2/extension/analysis/signature";
  const mismatch = authorizationMismatch(auth, input.payTo, input.amount);
  if (mismatch) return { check: "authorization", endpoint: "local integrity check", verdict: "BLOCK", reason: mismatch, ms: 0 };
  try {
    const typed = authorizationTypedData(auth, testnetAsset, domain.name, domain.version);
    const r = await call<SignatureAnalysis>("POST", "/api/public/v2/extension/analysis/signature", {
      from: auth.from,
      message: JSON.stringify(typed),
      chainId: chainId(),
      website: "guardpay.local",
    });
    return { check: "authorization", endpoint, ...messageVerdict(r), ms: Date.now() - t0, raw: r };
  } catch (e) {
    return failClosed("authorization", endpoint, e, t0);
  }
}

// ─── Pipeline ──────────────────────────────────────────────────────────────────

/** Fail closed: if we can't screen, a human decides (HOLD -> ESCALATE), never auto-pay. */
function failClosed(check: CheckResult["check"], endpoint: string, e: unknown, t0: number): CheckResult {
  const msg = e instanceof Error ? e.message : String(e);
  return { check, endpoint, verdict: "HOLD", reason: `screening unavailable (${msg}); failing closed`, ms: Date.now() - t0 };
}

export interface ScreenInput {
  payTo: string;
  asset: string;
  amount: string; // atomic, from the 402 quote
  authorization: EvmExactAuthorization;
  domain: { name: string; version: string };
}

export async function screenPayment(input: ScreenInput): Promise<Screening> {
  const checks = await Promise.all([
    screenAddress(input.payTo),
    screenToken(input.asset),
    screenAuthorization(input),
  ]);
  const verdict = worst(checks.map((c) => c.verdict));
  return {
    verdict,
    reasons: checks.filter((c) => c.verdict === verdict).map((c) => c.reason),
    checks,
  };
}
