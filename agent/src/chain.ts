import { createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { cfg, env, invoiceTokenAbi, optionalEnv, publicClient } from "@guardpay/shared";

const wallet = (key: string) =>
  createWalletClient({ account: privateKeyToAccount(key as Hex), chain: baseSepolia, transport: http(cfg.rpcUrl()) });

/** On-chain mode is on when the InvoiceToken is deployed. */
export const onChain = () => Boolean(cfg.invoiceToken());

/** The company this treasury agent pays for (its wallet is the invoice `payer`). */
export const payerAddress = () => privateKeyToAccount(env("AGENT_PRIVATE_KEY") as Hex).address;

/**
 * Supplier side: issue an invoice to our company. The NFT is minted to the supplier's wallet.
 * `payTo` is where the supplier asks to be paid (scenario 2: a swapped, sanctioned payout address).
 * Returns as soon as the tx is submitted; the agent's listener picks up the InvoiceIssued event.
 */
export async function supplierIssueInvoice(payTo: `0x${string}`, amount: bigint, dueInDays = 14): Promise<Hex> {
  const token = cfg.invoiceToken();
  if (!token) throw new Error("INVOICE_TOKEN_ADDRESS not set");
  return wallet(env("SUPPLIER_PRIVATE_KEY")).writeContract({
    address: token,
    abi: invoiceTokenAbi,
    functionName: "issue",
    args: [payerAddress(), payTo, amount, BigInt(Math.floor(Date.now() / 1000) + dueInDays * 86400)],
  });
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
