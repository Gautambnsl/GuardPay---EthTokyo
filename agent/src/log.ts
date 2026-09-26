import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Screening } from "./intercepta.js";
import type { Decision } from "./policy.js";
import type { Approval } from "./worldid.js";

/** Decision log: every payment attempt with verdict, reason, approval and tx hash. */

export type Outcome = "PENDING" | "PAID" | "REFUSED" | "NOT_PAID" | "FAILED";

export interface Step { at: string; label: string; detail?: string }

export interface DecisionRecord {
  id: string;
  scenario?: string;
  invoiceId: number;
  issuer?: string; // supplier wallet that issued the invoice NFT
  issueTx?: string;
  dueDate?: number;
  payTo?: string;
  asset?: string;
  amount?: string; // atomic USDC
  network?: string;
  screening?: Screening;
  decision?: Decision;
  decisionReason?: string;
  approval?: Omit<Approval, "intent">;
  outcome: Outcome;
  outcomeReason?: string;
  txHash?: string;
  markPaidTx?: string;
  steps: Step[];
  startedAt: string;
  finishedAt?: string;
}

const FILE = resolve(dirname(fileURLToPath(import.meta.url)), "../data/decisions.json");
let records: DecisionRecord[] = [];
try {
  records = JSON.parse(readFileSync(FILE, "utf8"));
} catch {}

function persist() {
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(records, null, 2));
}

export const allRecords = () => records;
export function clearRecords() {
  records = [];
  persist();
}

export function newRecord(r: Pick<DecisionRecord, "id" | "invoiceId" | "scenario">): DecisionRecord {
  const rec: DecisionRecord = { ...r, outcome: "PENDING", steps: [], startedAt: new Date().toISOString() };
  records.unshift(rec);
  persist();
  return rec;
}

export function update(rec: DecisionRecord, patch: Partial<DecisionRecord>, step?: string, detail?: string) {
  Object.assign(rec, patch);
  if (step) {
    rec.steps.push({ at: new Date().toISOString(), label: step, detail });
    console.log(`[agent] #${rec.invoiceId} ${step}${detail ? ` — ${detail}` : ""}`);
  }
  if (rec.outcome !== "PENDING" && !rec.finishedAt) rec.finishedAt = new Date().toISOString();
  persist();
}
