import { randomUUID } from "node:crypto";
import { formatUsdc } from "@guardpay/shared";
import { screenPayment } from "./intercepta.js";
import { autoExecutable, decide } from "./policy.js";
import { newRecord, update, type DecisionRecord } from "./log.js";
import { markPaid } from "./chain.js";
import { authorizationOf, quote, sign, submit, type Quote } from "./x402.js";
import {
  consumeApproval,
  requestApproval,
  waitForApproval,
  worldConfig,
  type Approval,
  type PaymentIntent,
} from "./worldid.js";
import type { HumanAction } from "./scenarios.js";
import type { IssuedInvoice } from "./listener.js";

/**
 * GuardPay agent loop for one invoice:
 *   quote (x402 402) -> sign authorization -> Intercepta screening -> policy
 *   -> [World ID human approval] -> x402 settle -> markPaid on InvoiceToken -> log
 * Nothing is sent to the seller until screening + policy (+ approval) allow it.
 */

export interface RunOptions {
  scenario?: string;
  /** Mock-mode only: simulate the human in World App. "manual" waits for the dashboard. */
  human?: HumanAction;
  ttlSeconds?: number;
  /** Set when the invoice was picked up by the on-chain listener. */
  origin?: IssuedInvoice;
}

const intentOf = (invoiceId: number, q: Quote): PaymentIntent => ({
  invoiceId,
  payTo: q.requirements.payTo,
  asset: q.requirements.asset,
  amount: q.requirements.amount,
  network: q.requirements.network,
});

export async function payInvoice(invoiceId: number, opts: RunOptions = {}): Promise<DecisionRecord> {
  const rec = newRecord({ id: randomUUID(), invoiceId, scenario: opts.scenario });
  try {
    const o = opts.origin;
    if (o) {
      update(rec, { issuer: o.issuer, issueTx: o.txHash, dueDate: o.dueDate },
        "Invoice issued by supplier", `NFT #${o.id} minted to ${o.issuer} (tx ${o.txHash})`);
      update(rec, {}, "Agent detected InvoiceIssued", `block ${o.blockNumber}, due ${new Date(o.dueDate * 1000).toISOString().slice(0, 10)}`);
    }
    // 1. Ask the supplier what it wants (x402 402 Payment Required)
    const q = await quote(invoiceId);
    const r = q.requirements;
    update(rec, { payTo: r.payTo, asset: r.asset, amount: r.amount, network: r.network },
      "402 quote", `${formatUsdc(BigInt(r.amount))} USDC → ${r.payTo}`);

    // 2. Sign the exact EIP-3009 authorization (kept in memory, not sent)
    let payload = await sign(q);
    const domain = r.extra as { name: string; version: string };

    // 3. Intercepta screening of payTo, token and the authorization itself
    const screening = await screenPayment({ payTo: r.payTo, asset: r.asset, amount: r.amount, authorization: authorizationOf(payload), domain });
    update(rec, { screening }, `Intercepta: ${screening.verdict}`, screening.reasons.join("; "));

    // 4. Policy
    const { decision, reason } = decide(screening.verdict, BigInt(r.amount));
    update(rec, { decision, decisionReason: reason }, `Policy: ${decision}`, reason);

    if (decision === "REFUSE") {
      update(rec, { outcome: "REFUSED", outcomeReason: screening.reasons.join("; ") }, "Refused, nothing signed was sent");
      return rec;
    }

    // 5. Escalation: fresh World ID human approval, validated on the backend
    if (!autoExecutable(decision)) {
      const approval = await getHumanApproval(rec, intentOf(invoiceId, q), opts);
      if (approval.status !== "approved") {
        update(rec, { outcome: "NOT_PAID", outcomeReason: approval.reason }, `Not paid: approval ${approval.status}`);
        return rec;
      }
      consumeApproval(approval.id, intentOf(invoiceId, q));

      // The first authorization may have aged while the human decided; sign a fresh one and re-screen it.
      payload = await sign(q);
      const rescreen = await screenPayment({ payTo: r.payTo, asset: r.asset, amount: r.amount, authorization: authorizationOf(payload), domain });
      if (rescreen.verdict === "BLOCK") {
        update(rec, { screening: rescreen, outcome: "REFUSED", outcomeReason: rescreen.reasons.join("; ") },
          "Re-screen after approval: BLOCK, refused");
        return rec;
      }
      update(rec, {}, `Re-screen after approval: ${rescreen.verdict}`);
    }

    // 6. Execute the x402 payment
    const s = await submit(q, payload);
    if (!s.ok) {
      update(rec, { outcome: "FAILED", outcomeReason: s.error }, "x402 settlement failed", s.error);
      return rec;
    }
    update(rec, { outcome: "PAID", outcomeReason: reason, txHash: s.txHash }, "x402 settled", s.txHash);

    // 7. Mark the tokenized invoice paid on-chain
    try {
      const tx = await markPaid(invoiceId, s.txHash!);
      if (tx) update(rec, { markPaidTx: tx }, "InvoiceToken.markPaid", tx);
    } catch (e) {
      update(rec, {}, "markPaid failed (payment already settled)", (e as Error).message.split("\n")[0]);
    }
    return rec;
  } catch (e) {
    update(rec, { outcome: "FAILED", outcomeReason: (e as Error).message }, "Error", (e as Error).message);
    return rec;
  }
}

async function getHumanApproval(rec: DecisionRecord, intent: PaymentIntent, opts: RunOptions): Promise<Approval> {
  const pending = await requestApproval(intent, { ttlSeconds: opts.ttlSeconds });
  const { intent: _i, ...view } = pending;
  update(rec, { approval: view }, "World ID approval requested",
    `code ${pending.userCode}, expires in ${Math.round((pending.expiresAt - Date.now()) / 1000)}s`);

  if (worldConfig().mode === "mock" && opts.human && opts.human !== "manual" && opts.human !== "expire") {
    // Simulated treasurer acting in (mock) World App a moment later.
    setTimeout(() => {
      fetch(`${worldConfig().issuer}/app/requests/${pending.userCode}/${opts.human}`, { method: "POST" }).catch(() => {});
    }, 2500);
  }

  const done = await waitForApproval(pending.id);
  const { intent: _j, ...doneView } = done;
  update(rec, { approval: doneView }, `World ID: ${done.status}`,
    done.status === "approved" ? `human ${done.claims?.sub?.slice(0, 10)}… verified (acr orb, fresh, single-use)` : done.reason);
  return done;
}
