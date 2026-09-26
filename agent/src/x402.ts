import { x402Client, x402HTTPClient } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { privateKeyToAccount } from "viem/accounts";
import { cfg, env } from "@guardpay/shared";

/**
 * x402 buyer, split into explicit steps so GuardPay can screen the exact payment
 * authorization before it ever leaves the process:
 *   quote()  -> 402 PaymentRequired (payTo, asset, amount)
 *   sign()   -> EIP-3009 TransferWithAuthorization (screened by Intercepta scan-message)
 *   submit() -> retry with PAYMENT-SIGNATURE, facilitator settles, returns tx hash
 */
export const agentAccount = () => privateKeyToAccount(env("AGENT_PRIVATE_KEY") as `0x${string}`);

let _http: x402HTTPClient | undefined;
function http() {
  if (!_http) {
    // GuardPay's policy engine enforces limits; x402's built-in $1 cap would block approved large invoices.
    const client = new x402Client().setSpendControls(false);
    client.register("eip155:*", new ExactEvmScheme(agentAccount()));
    _http = new x402HTTPClient(client);
  }
  return _http;
}

export interface Quote {
  url: string;
  paymentRequired: PaymentRequired;
  requirements: PaymentRequirements;
}

export async function quote(invoiceId: number): Promise<Quote> {
  const url = `${cfg.sellerUrl()}/invoices/${invoiceId}/pay`;
  const res = await fetch(url, { method: "POST" });
  if (res.status !== 402) throw new Error(`Expected 402 from seller, got ${res.status}: ${await res.text()}`);
  const body = await res.json().catch(() => undefined);
  const paymentRequired = http().getPaymentRequiredResponse((h) => res.headers.get(h), body);
  const requirements = paymentRequired.accepts[0];
  if (!requirements) throw new Error("Seller offered no payment options");
  return { url, paymentRequired, requirements };
}

export interface EvmExactAuthorization {
  from: `0x${string}`;
  to: `0x${string}`;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: `0x${string}`;
}

export async function sign(q: Quote): Promise<PaymentPayload> {
  // Only offer the option we screened, so the client can't pick a different payTo/asset.
  return http().createPaymentPayload({ ...q.paymentRequired, accepts: [q.requirements] });
}

export const authorizationOf = (p: PaymentPayload) =>
  (p.payload as { authorization: EvmExactAuthorization }).authorization;

export interface Settlement {
  ok: boolean;
  txHash?: `0x${string}`;
  error?: string;
  body?: unknown;
}

export async function submit(q: Quote, payload: PaymentPayload): Promise<Settlement> {
  const res = await fetch(q.url, { method: "POST", headers: http().encodePaymentSignatureHeader(payload) });
  const body = await res.json().catch(() => undefined);
  if (!res.ok) {
    let error = `seller responded ${res.status}`;
    try {
      const pr = http().getPaymentRequiredResponse((h) => res.headers.get(h), body);
      if (pr.error) error += `: ${pr.error}`;
    } catch {}
    return { ok: false, error, body };
  }
  const settle = http().getPaymentSettleResponse((h) => res.headers.get(h));
  return {
    ok: settle.success,
    txHash: settle.transaction as `0x${string}`,
    error: settle.success ? undefined : settle.errorReason,
    body,
  };
}
