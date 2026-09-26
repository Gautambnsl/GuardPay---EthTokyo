import type { DecisionRecord, Issuing } from "./types";

export type StageStatus = "todo" | "active" | "done" | "fail" | "skip";

export interface Stage {
  key: string;
  actor: "supplier" | "chain" | "agent" | "intercepta" | "policy" | "world" | "x402";
  title: string;
  status: StageStatus;
  detail?: string;
  at?: string;
}

const find = (r: DecisionRecord | undefined, prefix: string) => r?.steps.find((s) => s.label.startsWith(prefix));

/** Derive the 9 pipeline stages from a decision record's timeline (or a pending supplier issue). */
export function stagesFor(r: DecisionRecord | undefined, issuing?: Issuing): Stage[] {
  const issued = find(r, "Invoice issued");
  const detected = find(r, "Agent detected");
  const quote = find(r, "402 quote");
  const screen = find(r, "Intercepta:");
  const policy = find(r, "Policy:");
  const worldReq = find(r, "World ID approval requested");
  const worldDone = r?.steps.find((s) => s.label.startsWith("World ID:"));
  const settled = find(r, "x402 settled") ?? find(r, "Recovered");
  const settleFail = find(r, "x402 settlement failed");
  const marked = find(r, "InvoiceToken.markPaid");
  const escalated = r?.decision === "ESCALATE";
  const refused = r?.outcome === "REFUSED";
  const ended = r && r.outcome !== "PENDING";

  const s: Stage[] = [
    {
      key: "issue", actor: "supplier", title: "Supplier issues invoice",
      status: issued || r ? "done" : issuing ? "active" : "todo",
      detail: issuing && !r ? "signing InvoiceToken.issue(…)" : r?.issuer ? `from ${short(r.issuer)}` : undefined,
    },
    {
      key: "mint", actor: "chain", title: "Invoice NFT minted",
      status: issued ? "done" : issuing ? "active" : r ? "skip" : "todo",
      detail: issued ? `#${r!.invoiceId} on Base Sepolia` : issuing ? "waiting for block…" : undefined, at: issued?.at,
    },
    {
      key: "detect", actor: "agent", title: "Agent detects event",
      status: detected ? "done" : issued ? "active" : r ? "skip" : "todo",
      detail: detected ? "InvoiceIssued → payer = us" : undefined, at: detected?.at,
    },
    {
      key: "quote", actor: "x402", title: "x402 quote (402)",
      status: quote ? "done" : r && !ended ? "active" : r?.outcome === "FAILED" ? "fail" : "todo",
      detail: r?.amount ? `$${usd(r.amount)} → ${short(r.payTo)}` : undefined, at: quote?.at,
    },
    {
      key: "screen", actor: "intercepta", title: "Intercepta screening",
      status: screen ? (r?.screening?.verdict === "BLOCK" ? "fail" : "done") : quote ? "active" : "todo",
      detail: r?.screening ? r.screening.verdict : "payTo · token · authorization", at: screen?.at,
    },
    {
      key: "policy", actor: "policy", title: "Policy decision",
      status: policy ? (r?.decision === "REFUSE" ? "fail" : "done") : screen ? "active" : "todo",
      detail: r?.decision, at: policy?.at,
    },
    {
      key: "world", actor: "world", title: "World ID approval",
      status: !policy ? "todo" : !escalated ? "skip"
        : worldDone ? (r?.approval?.status === "approved" ? "done" : "fail") : worldReq ? "active" : "active",
      detail: !policy ? "only if escalated" : !escalated ? "not needed" : r?.approval?.status ?? "requesting…",
      at: worldDone?.at ?? worldReq?.at,
    },
    {
      key: "settle", actor: "x402", title: "x402 USDC settlement",
      status: settled ? "done" : settleFail && ended ? "fail" : refused || r?.outcome === "NOT_PAID" ? "skip"
        : policy && (!escalated || r?.approval?.status === "approved") && !ended ? "active" : "todo",
      detail: settled ? `tx ${short(r?.txHash)}` : refused || r?.outcome === "NOT_PAID" ? "nothing sent" : undefined,
      at: settled?.at,
    },
    {
      key: "paid", actor: "chain", title: "Invoice marked paid",
      status: marked ? "done" : settled && !ended ? "active" : refused || r?.outcome === "NOT_PAID" ? "skip" : "todo",
      detail: marked ? "InvoiceToken.markPaid" : undefined, at: marked?.at,
    },
  ];
  return s;
}

export const short = (a?: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");
export const usd = (atomic?: string) => (atomic ? (Number(atomic) / 1e6).toFixed(2) : "—");
