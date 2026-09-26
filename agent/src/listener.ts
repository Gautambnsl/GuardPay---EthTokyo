import type { Hex } from "viem";
import { cfg, getInvoice, invoiceTokenAbi, publicClient } from "@guardpay/shared";
import { payerAddress } from "./chain.js";

/**
 * The agent's ears: watches InvoiceToken for InvoiceIssued events addressed to our company
 * (payer = agent wallet) and hands each new invoice to the agent loop, one at a time.
 */

export interface IssuedInvoice {
  id: number;
  issuer: Hex;
  payTo: Hex;
  amount: bigint;
  dueDate: number;
  txHash: Hex;
  blockNumber: bigint;
  detectedAt: number;
}

type Handler = (inv: IssuedInvoice) => Promise<void>;

export function startListener(handler: Handler) {
  const token = cfg.invoiceToken();
  if (!token) {
    console.log("[listener] INVOICE_TOKEN_ADDRESS not set; listener off");
    return () => {};
  }
  const seen = new Set<number>();
  let queue = Promise.resolve();

  const unwatch = publicClient().watchContractEvent({
    address: token,
    abi: invoiceTokenAbi,
    eventName: "InvoiceIssued",
    args: { payer: payerAddress() },
    poll: true,
    pollingInterval: 2_000,
    onError: (e) => console.warn("[listener]", e.message.split("\n")[0]),
    onLogs: (logs) => {
      for (const log of logs) {
        const id = Number(log.args.id);
        if (seen.has(id)) continue;
        seen.add(id);
        const inv: IssuedInvoice = {
          id,
          issuer: log.args.issuer!,
          payTo: log.args.payTo!,
          amount: log.args.amount!,
          dueDate: Number(log.args.dueDate),
          txHash: log.transactionHash!,
          blockNumber: log.blockNumber!,
          detectedAt: Date.now(),
        };
        console.log(`[listener] InvoiceIssued #${id} from ${inv.issuer} (block ${inv.blockNumber})`);
        queue = queue.then(async () => {
          // Load-balanced RPCs can lag; make sure the seller will see the invoice too.
          for (let i = 0; i < 15 && !(await getInvoice(id)); i++) await new Promise((r) => setTimeout(r, 1000));
          await handler(inv).catch((e) => console.error("[listener] handler failed", e));
        });
      }
    },
  });
  console.log(`[listener] watching ${token} for invoices payable by ${payerAddress()}`);
  return unwatch;
}
