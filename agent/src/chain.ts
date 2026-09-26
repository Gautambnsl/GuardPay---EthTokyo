import { createWalletClient, decodeEventLog, http, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { cfg, getInvoice, invoiceTokenAbi, optionalEnv, publicClient } from "@guardpay/shared";

const issueAbi = parseAbi([
  "function issue(address supplier, uint256 amount, uint64 dueDate) returns (uint256)",
  "event InvoiceIssued(uint256 indexed id, address indexed supplier, uint256 amount, uint64 dueDate)",
]);

const wallet = (key: string) =>
  createWalletClient({ account: privateKeyToAccount(key as Hex), chain: baseSepolia, transport: http(cfg.rpcUrl()) });

/** On-chain mode is on when the InvoiceToken is deployed. */
export const onChain = () => Boolean(cfg.invoiceToken());

/** Issue a fresh invoice NFT for a demo run (so every run pays a new, unpaid invoice). */
export async function issueInvoice(supplier: `0x${string}`, amount: bigint): Promise<number | undefined> {
  const token = cfg.invoiceToken();
  const key = optionalEnv("DEPLOYER_PRIVATE_KEY");
  if (!token || !key) return undefined;
  const hash = await wallet(key).writeContract({
    address: token,
    abi: issueAbi,
    functionName: "issue",
    args: [supplier, amount, BigInt(Math.floor(Date.now() / 1000) + 14 * 86400)],
  });
  const receipt = await publicClient().waitForTransactionReceipt({ hash });
  for (const log of receipt.logs) {
    try {
      const ev = decodeEventLog({ abi: issueAbi, ...log });
      if (ev.eventName === "InvoiceIssued") return await visible(Number(ev.args.id));
    } catch {}
  }
  throw new Error("InvoiceIssued event not found");
}

/** Public RPCs are load-balanced; wait until the new invoice is readable before the seller is asked for it. */
async function visible(id: number): Promise<number> {
  for (let i = 0; i < 20; i++) {
    if (await getInvoice(id)) return id;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return id;
}

/** Agent marks the invoice NFT paid, referencing the x402 settlement tx. */
export async function markPaid(invoiceId: number, paymentTx: Hex): Promise<Hex | undefined> {
  const token = cfg.invoiceToken();
  const key = optionalEnv("AGENT_PRIVATE_KEY");
  if (!token || !key) return undefined;
  const hash = await wallet(key).writeContract({
    address: token,
    abi: invoiceTokenAbi,
    functionName: "markPaid",
    args: [BigInt(invoiceId), paymentTx],
  });
  await publicClient().waitForTransactionReceipt({ hash });
  return hash;
}
