import { formatUsdc } from "@guardpay/shared";
import { agentAccount, authorizationOf, quote, sign, submit } from "./x402.js";

/** Raw x402 payment, no GuardPay checks. Smoke test: `npx tsx agent/src/pay.ts 1` */
const id = Number(process.argv[2] ?? 1);
const q = await quote(id);
console.log(`invoice #${id}: pay ${formatUsdc(BigInt(q.requirements.amount))} USDC to ${q.requirements.payTo}`);
const payload = await sign(q);
console.log("signed authorization from", agentAccount().address, authorizationOf(payload));
const s = await submit(q, payload);
console.log(s.ok ? `settled: https://sepolia.basescan.org/tx/${s.txHash}` : `failed: ${s.error}`, s.body ?? "");
