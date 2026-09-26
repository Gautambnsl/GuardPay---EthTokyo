import { env, optionalEnv } from "./env.js";

export const NETWORK = "eip155:84532" as const; // Base Sepolia (CAIP-2)
export const USDC_DECIMALS = 6;

/**
 * TODO(team): paste a known-risky MAINNET address from the Intercepta Discord here or set
 * RISKY_SUPPLIER_ADDRESS in .env. Scenario 2 uses it as the invoice payTo. Intercepta screens it
 * against mainnet intelligence; the payment itself would run on Base Sepolia (it never does, it's refused).
 * The default below is the example address from the Intercepta API reference.
 */
export const RISKY_SUPPLIER_PLACEHOLDER = "0x0d775e010f0b6c32c9468d43ba599ef47d596e47";

/** Clean supplier fallback (Base Sepolia USDC receiver). Override with CLEAN_SUPPLIER_ADDRESS. */
export const CLEAN_SUPPLIER_PLACEHOLDER = "0x4200000000000000000000000000000000000011";

export const cfg = {
  rpcUrl: () => env("BASE_SEPOLIA_RPC_URL", "https://sepolia.base.org"),
  usdc: () => env("USDC_ADDRESS", "0x036CbD53842c5426634e7929541eC2318f3dCF7e") as `0x${string}`,
  invoiceToken: () => optionalEnv("INVOICE_TOKEN_ADDRESS") as `0x${string}` | undefined,
  cleanSupplier: () => env("CLEAN_SUPPLIER_ADDRESS", CLEAN_SUPPLIER_PLACEHOLDER) as `0x${string}`,
  riskySupplier: () => env("RISKY_SUPPLIER_ADDRESS", RISKY_SUPPLIER_PLACEHOLDER) as `0x${string}`,
  sellerPort: () => Number(env("SELLER_PORT", "4021")),
  sellerUrl: () => env("SELLER_URL", "http://localhost:4021"),
  agentPort: () => Number(env("AGENT_PORT", "4000")),
  facilitatorUrl: () => env("X402_FACILITATOR_URL", "https://x402.org/facilitator"),
};
