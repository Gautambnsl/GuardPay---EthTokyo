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

  const client = publicClient();
  const payer = payerAddress();
  let lastBlock: bigint | undefined;
  let stopped = false;

  // Our own poller: public RPCs are load-balanced, so the head block from one node can be ahead of
  // the node answering eth_getLogs. Only advance the cursor after a successful fetch.
  const tick = async () => {
    try {
      const head = await client.getBlockNumber({ cacheTime: 0 });
      if (lastBlock === undefined) lastBlock = head - 1n; // start from now; don't pay old invoices
      if (head <= lastBlock) return;
      const toBlock = head - lastBlock > 500n ? lastBlock + 500n : head;
      const logs = await client.getContractEvents({
        address: token,
        abi: invoiceTokenAbi,
        eventName: "InvoiceIssued",
        args: { payer },
        fromBlock: lastBlock + 1n,
        toBlock,
      });
      lastBlock = toBlock;
      onLogs(logs);
    } catch (e) {
      console.warn("[listener] poll failed, will retry:", (e as Error).message.split("\n")[0]);
    }
  };

  const onLogs = (logs: Awaited<ReturnType<typeof client.getContractEvents<typeof invoiceTokenAbi, "InvoiceIssued">>>) => {
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
  };

  (async () => {
    while (!stopped) {
      await tick();
      await new Promise((r) => setTimeout(r, 2_000));
    }
  })();
  const unwatch = () => void (stopped = true);
  console.log(`[listener] watching ${token} for invoices payable by ${payerAddress()}`);
  return unwatch;
}
