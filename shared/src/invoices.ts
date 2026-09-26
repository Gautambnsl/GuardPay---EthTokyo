import { createPublicClient, formatUnits, http, parseAbi } from "viem";
import { baseSepolia } from "viem/chains";
import { cfg, USDC_DECIMALS } from "./config.js";

export interface Invoice {
  id: number;
  issuer?: `0x${string}`; // supplier that issued it (initial NFT holder)
  payer?: `0x${string}`; // company that owes it
  supplier: `0x${string}`; // payTo for the x402 payment
  amount: bigint; // USDC atomic units (6 decimals)
  dueDate: number; // unix seconds
  paid: boolean;
  source: "chain" | "local";
}

export const invoiceTokenAbi = parseAbi([
  "struct Invoice { address issuer; address payer; address payTo; uint256 amount; uint64 dueDate; bool paid; bytes32 paymentRef; }",
  "function getInvoice(uint256 id) view returns (Invoice)",
  "function issue(address payer, address payTo, uint256 amount, uint64 dueDate) returns (uint256)",
  "function markPaid(uint256 id, bytes32 paymentRef)",
  "event InvoiceIssued(uint256 indexed id, address indexed issuer, address indexed payer, address payTo, uint256 amount, uint64 dueDate)",
]);

/**
 * Offline fallback when INVOICE_TOKEN_ADDRESS is not set (no chain, no listener).
 */
function localInvoices(): Invoice[] {
  const due = Math.floor(Date.now() / 1000) + 14 * 86400;
  return [
    { id: 1, supplier: cfg.cleanSupplier(), amount: 50_000n, dueDate: due, paid: false, source: "local" },
    { id: 2, supplier: cfg.riskySupplier(), amount: 50_000n, dueDate: due, paid: false, source: "local" },
    { id: 3, supplier: cfg.cleanSupplier(), amount: 2_000_000n, dueDate: due, paid: false, source: "local" },
    { id: 4, supplier: cfg.cleanSupplier(), amount: 2_000_000n, dueDate: due, paid: false, source: "local" },
  ];
}

export const publicClient = () => createPublicClient({ chain: baseSepolia, transport: http(cfg.rpcUrl()) });

export async function getInvoice(id: number): Promise<Invoice | undefined> {
  const token = cfg.invoiceToken();
  if (!token) return localInvoices().find((i) => i.id === id);
  try {
    const inv = await publicClient().readContract({
      address: token,
      abi: invoiceTokenAbi,
      functionName: "getInvoice",
      args: [BigInt(id)],
    });
    return {
      id,
      issuer: inv.issuer,
      payer: inv.payer,
      supplier: inv.payTo,
      amount: inv.amount,
      dueDate: Number(inv.dueDate),
      paid: inv.paid,
      source: "chain",
    };
  } catch {
    return undefined; // UnknownInvoice
  }
}

export const formatUsdc = (atomic: bigint) => formatUnits(atomic, USDC_DECIMALS);
