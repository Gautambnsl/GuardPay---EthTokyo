import { env } from "@guardpay/shared";
import { parseUnits } from "viem";
import type { ScreenVerdict } from "./intercepta.js";

/**
 * Policy engine: screening verdict + amount -> decision.
 *
 *   BLOCK                         -> REFUSE    never pay, no override
 *   HOLD (flagged / screening down) -> ESCALATE  fresh World ID human approval
 *   CAUTION, amount <= capLimit   -> CAP       pay under the tightened cap
 *   CAUTION, amount >  capLimit   -> ESCALATE
 *   CLEAN,   amount <= limit      -> PAY
 *   CLEAN,   amount >  limit      -> ESCALATE
 */
export type Decision = "PAY" | "REFUSE" | "CAP" | "ESCALATE";

export interface PolicyLimits {
  autoPayLimit: bigint; // USDC atomic
  capLimit: bigint; // USDC atomic
}

export const limitsFromEnv = (): PolicyLimits => ({
  autoPayLimit: parseUnits(env("AUTO_PAY_LIMIT_USDC", "1.00"), 6),
  capLimit: parseUnits(env("CAP_LIMIT_USDC", "0.10"), 6),
});

export function decide(
  verdict: ScreenVerdict,
  amount: bigint,
  limits: PolicyLimits = limitsFromEnv(),
): { decision: Decision; reason: string } {
  const usd = (v: bigint) => `$${(Number(v) / 1e6).toFixed(2)}`;
  switch (verdict) {
    case "BLOCK":
      return { decision: "REFUSE", reason: "Intercepta flagged this payment as malicious" };
    case "HOLD":
      return { decision: "ESCALATE", reason: "Screening raised a hold; a verified human must approve" };
    case "CAUTION":
      return amount <= limits.capLimit
        ? { decision: "CAP", reason: `Minor risk signals; ${usd(amount)} is within the reduced cap of ${usd(limits.capLimit)}` }
        : { decision: "ESCALATE", reason: `Minor risk signals and ${usd(amount)} exceeds the reduced cap of ${usd(limits.capLimit)}` };
    case "CLEAN":
      return amount <= limits.autoPayLimit
        ? { decision: "PAY", reason: `Clean and ${usd(amount)} is within the auto-pay limit of ${usd(limits.autoPayLimit)}` }
        : { decision: "ESCALATE", reason: `${usd(amount)} exceeds the auto-pay limit of ${usd(limits.autoPayLimit)}` };
  }
}

/** Decisions that allow the agent to execute without a human. */
export const autoExecutable = (d: Decision) => d === "PAY" || d === "CAP";
