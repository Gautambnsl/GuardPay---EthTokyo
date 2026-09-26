import { cfg } from "@guardpay/shared";

export type HumanAction = "approve" | "deny" | "expire" | "manual";

export interface Scenario {
  key: string;
  title: string;
  expect: string;
  localInvoiceId: number; // id in the local registry / Deploy.s.sol
  supplier: () => `0x${string}`;
  amount: bigint; // USDC atomic, matches Deploy.s.sol
  /** What the simulated human does if the payment is escalated (auto demo only). */
  autoHuman: HumanAction;
  ttlSeconds?: number;
}

export const SCENARIOS: Scenario[] = [
  {
    key: "1", title: "Small invoice, clean supplier", expect: "auto PAY",
    localInvoiceId: 1, supplier: cfg.cleanSupplier, amount: 50_000n, autoHuman: "approve",
  },
  {
    key: "2", title: "Payout address swapped to a sanctioned wallet", expect: "REFUSE",
    localInvoiceId: 2, supplier: cfg.riskySupplier, amount: 50_000n, autoHuman: "deny",
  },
  {
    key: "3", title: "Large invoice, clean supplier", expect: "ESCALATE → World ID approve → PAY",
    localInvoiceId: 3, supplier: cfg.cleanSupplier, amount: 2_000_000n, autoHuman: "approve",
  },
  {
    key: "4", title: "Large invoice, human denies", expect: "ESCALATE → denied → NOT PAID",
    localInvoiceId: 4, supplier: cfg.cleanSupplier, amount: 2_000_000n, autoHuman: "deny",
  },
  {
    key: "4b", title: "Large invoice, approval expires", expect: "ESCALATE → expired → NOT PAID",
    localInvoiceId: 4, supplier: cfg.cleanSupplier, amount: 2_000_000n, autoHuman: "expire", ttlSeconds: 8,
  },
];

export const scenario = (key: string) => SCENARIOS.find((s) => s.key === key);
