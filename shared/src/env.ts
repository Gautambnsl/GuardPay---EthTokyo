import { config } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Every package reads the single root .env. Secrets never leave the Node processes.
export const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
config({ path: resolve(ROOT_DIR, ".env"), quiet: true });

export function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === "" || v === "0x...") {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing env var ${name} (see .env.example)`);
  }
  return v;
}

export function optionalEnv(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" || v === "0x..." ? undefined : v;
}
