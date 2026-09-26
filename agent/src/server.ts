import { existsSync } from "node:fs";
import { resolve } from "node:path";
import express from "express";
import { cfg, formatUsdc, optionalEnv, ROOT_DIR } from "@guardpay/shared";
import { payInvoice } from "./agent.js";
import { onChain, payerAddress, supplierIssueInvoice } from "./chain.js";
import { startListener } from "./listener.js";
import { allRecords, clearRecords, type DecisionRecord } from "./log.js";
import { mockWorldRouter } from "./mock-world.js";
import { limitsFromEnv } from "./policy.js";
import { SCENARIOS, scenario, type HumanAction, type Scenario } from "./scenarios.js";
import { cancelApproval, listApprovals, worldConfig } from "./worldid.js";
import type { IssuedInvoice } from "./listener.js";

/** Agent API for the dashboard. All secrets stay here; the browser only sees decisions. */

let busy = false;

/** Invoices a demo supplier just issued, waiting for the listener to pick them up. Keyed by tx hash. */
interface PendingIssue { scenario: string; human: HumanAction; ttlSeconds?: number; since: number; txHash: string; resolve: (r: DecisionRecord) => void }
const pendingIssues = new Map<string, PendingIssue>();

export async function runScenario(s: Scenario, human: HumanAction): Promise<DecisionRecord> {
  if (!onChain()) return payInvoice(s.localInvoiceId, { scenario: s.key, human, ttlSeconds: s.ttlSeconds });
  // The supplier issues the invoice on-chain; the agent's listener detects it and processes it.
  return new Promise<DecisionRecord>((resolve, reject) => {
    supplierIssueInvoice(s.supplier(), s.amount)
      .then((txHash) => {
        pendingIssues.set(txHash.toLowerCase(), { scenario: s.key, human, ttlSeconds: s.ttlSeconds, since: Date.now(), txHash, resolve });
        console.log(`[supplier] issued invoice for scenario ${s.key} (tx ${txHash})`);
      })
      .catch(reject);
  });
}

function onInvoiceIssued(inv: IssuedInvoice) {
  const p = pendingIssues.get(inv.txHash.toLowerCase());
  pendingIssues.delete(inv.txHash.toLowerCase());
  // Invoices from outside the demo wait for a real human if escalated.
  return payInvoice(inv.id, { scenario: p?.scenario, human: p?.human ?? "manual", ttlSeconds: p?.ttlSeconds, origin: inv }).then(
    (rec) => p?.resolve(rec),
  );
}

export async function runAll(human: "auto" | "manual" = "auto") {
  const out: DecisionRecord[] = [];
  for (const s of SCENARIOS) out.push(await runScenario(s, human === "auto" ? s.autoHuman : "manual"));
  return out;
}

export async function startServer() {
  const app = express();
  app.use(express.json());
  const world = worldConfig();
  if (world.mode === "mock") app.use("/mock-world", await mockWorldRouter(world.issuer));

  app.get("/api/state", (_req, res) => {
    const l = limitsFromEnv();
    res.json({
      busy,
      issuing: [...pendingIssues.values()].map(({ resolve: _r, ...p }) => p),
      records: allRecords(),
      approvals: listApprovals().filter((a) => a.status === "pending"),
      scenarios: SCENARIOS.map(({ supplier, amount, ...s }) => ({ ...s, supplier: supplier(), amountUsdc: formatUsdc(amount) })),
      config: {
        network: "Base Sepolia (eip155:84532)",
        autoPayLimitUsdc: formatUsdc(l.autoPayLimit),
        capLimitUsdc: formatUsdc(l.capLimit),
        worldMode: world.mode,
        worldIssuer: world.issuer,
        interceptaConfigured: Boolean(optionalEnv("INTERCEPTA_API_KEY")),
        agentWalletConfigured: Boolean(optionalEnv("AGENT_PRIVATE_KEY")),
        invoiceToken: cfg.invoiceToken() ?? null,
        payer: optionalEnv("AGENT_PRIVATE_KEY") ? payerAddress() : null,
        listening: onChain(),
      },
    });
  });

  const guard = (fn: () => Promise<unknown>) => {
    if (busy) return false;
    busy = true;
    fn().finally(() => (busy = false));
    return true;
  };

  app.post("/api/scenarios/:key/run", (req, res) => {
    const s = scenario(req.params.key);
    if (!s) return res.status(404).json({ error: "unknown scenario" });
    const human: HumanAction = req.body?.human === "manual" ? "manual" : s.autoHuman;
    if (!guard(() => runScenario(s, human))) return res.status(409).json({ error: "a run is in progress" });
    res.status(202).json({ started: s.key, human });
  });

  app.post("/api/demo/run", (req, res) => {
    const human = req.body?.human === "manual" ? "manual" : "auto";
    if (!guard(() => runAll(human))) return res.status(409).json({ error: "a run is in progress" });
    res.status(202).json({ started: "all", human });
  });

  app.post("/api/approvals/:id/cancel", (req, res) => {
    cancelApproval(req.params.id);
    res.json({ ok: true });
  });

  app.delete("/api/log", (_req, res) => {
    clearRecords();
    res.json({ ok: true });
  });

  const dist = resolve(ROOT_DIR, "web/dist");
  if (existsSync(dist)) app.use(express.static(dist));

  await new Promise<void>((ok) =>
    app.listen(cfg.agentPort(), () => {
      console.log(`[agent] API on http://localhost:${cfg.agentPort()}  (World ID: ${world.mode} @ ${world.issuer})`);
      ok();
    }),
  );
  startListener(onInvoiceIssued);
}

if (process.argv[1]?.endsWith("server.ts")) await startServer();
