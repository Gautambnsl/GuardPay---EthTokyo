// Mirrors agent/src/log.ts + worldid.ts public views (no secrets).

export type Verdict = "CLEAN" | "CAUTION" | "HOLD" | "BLOCK";
export type Decision = "PAY" | "REFUSE" | "CAP" | "ESCALATE";
export type Outcome = "PENDING" | "PAID" | "REFUSED" | "NOT_PAID" | "FAILED";
export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "cancelled" | "invalid";

export interface Check { check: string; endpoint: string; verdict: Verdict; reason: string; ms: number }

export interface Approval {
  id: string;
  intentHash: string;
  bindingMessage: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  requestedAt: number;
  expiresAt: number;
  status: ApprovalStatus;
  reason?: string;
  claims?: { sub?: string; iss?: string; acr?: string; auth_time?: number; jti?: string };
}

export interface DecisionRecord {
  id: string;
  scenario?: string;
  invoiceId: number;
  issuer?: string;
  issueTx?: string;
  dueDate?: number;
  payTo?: string;
  amount?: string;
  screening?: { verdict: Verdict; reasons: string[]; checks: Check[] };
  decision?: Decision;
  decisionReason?: string;
  approval?: Approval;
  outcome: Outcome;
  outcomeReason?: string;
  txHash?: string;
  markPaidTx?: string;
  steps: { at: string; label: string; detail?: string }[];
  startedAt: string;
}

export interface Scenario {
  key: string;
  title: string;
  expect: string;
  supplier: string;
  amountUsdc: string;
  autoHuman: string;
}

export interface Issuing { scenario: string; human: string; since: number; txHash: string }

export interface State {
  busy: boolean;
  issuing: Issuing[];
  records: DecisionRecord[];
  approvals: Approval[];
  scenarios: Scenario[];
  config: {
    network: string;
    autoPayLimitUsdc: string;
    capLimitUsdc: string;
    worldMode: "mock" | "oidc";
    worldIssuer: string;
    interceptaConfigured: boolean;
    agentWalletConfigured: boolean;
    invoiceToken: string | null;
    payer: string | null;
    listening: boolean;
  };
}
