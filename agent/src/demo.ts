import { formatUsdc } from "@guardpay/shared";
import { runAll, startServer } from "./server.js";

/** Runs all demo scenarios headless (simulated human in mock World App). Needs the seller running. */
await startServer();
const results = await runAll("auto");
console.log("\n──────── GuardPay demo summary ────────");
for (const r of results) {
  console.log(
    `[${r.scenario}] invoice #${r.invoiceId} ${r.amount ? formatUsdc(BigInt(r.amount)) : "?"} USDC → ${r.payTo ?? "?"}\n` +
      `     screening=${r.screening?.verdict ?? "-"} decision=${r.decision ?? "-"} approval=${r.approval?.status ?? "-"} ` +
      `outcome=${r.outcome}${r.txHash ? ` tx=${r.txHash}` : ""}\n     ${r.outcomeReason ?? ""}`,
  );
}
process.exit(0);
