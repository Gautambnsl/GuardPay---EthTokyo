import { env, optionalEnv } from "./env.js";

export const NETWORK = "eip155:84532" as const; // Base Sepolia (CAIP-2)
export const USDC_DECIMALS = 6;

/**
 * Known-risky MAINNET address used as the payTo in scenario 2 (override with RISKY_SUPPLIER_ADDRESS).
 * Ronin bridge exploiter (Lazarus Group, OFAC-sanctioned). Live Intercepta quick-scan returns
 * toxicScore 100 with known_scammer, sanction_address, blacklist. The payment itself would run on
 * Base Sepolia, but GuardPay refuses it before anything is sent.
 */
export const RISKY_SUPPLIER_PLACEHOLDER = "0x098B716B8Aaf21512996dC57EB0615e2383E2f96";

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
