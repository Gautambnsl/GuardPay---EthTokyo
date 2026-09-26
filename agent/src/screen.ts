import { cfg } from "@guardpay/shared";
import { screenPayment } from "./intercepta.js";

/** Live Intercepta check for any payTo: `npm run screen -w agent -- 0xAddress` */
const payTo = (process.argv[2] ?? cfg.riskySupplier()) as `0x${string}`;
const from = "0x0000000000000000000000000000000000000001";
const s = await screenPayment({
  payTo,
  asset: cfg.usdc(),
  amount: "50000",
  domain: { name: "USDC", version: "2" },
  authorization: { from, to: payTo, value: "50000", validAfter: "0", validBefore: "9999999999", nonce: `0x${"00".repeat(32)}` },
});
console.log(JSON.stringify(s, null, 2));
