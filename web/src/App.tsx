import { useCallback, useEffect, useState } from "react";
import type { Approval, DecisionRecord, State } from "./types";

const short = (a?: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");
const usdc = (atomic?: string) => (atomic ? (Number(atomic) / 1e6).toFixed(2) : "—");
const dollars = (v: string) => `$${Number(v).toFixed(2)}`;
const time = (iso: string) => new Date(iso).toLocaleTimeString();
const scan = (tx: string) => `https://sepolia.basescan.org/tx/${tx}`;

async function post(path: string, body?: unknown) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
}

export function App() {
  const [state, setState] = useState<State>();
  const [error, setError] = useState<string>();
  const [manual, setManual] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/state");
      setState(await res.json());
      setError(undefined);
    } catch {
      setError("Agent API unreachable. Is `npm run agent` running?");
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 1000);
    return () => clearInterval(t);
  }, [refresh]);

  const act = (fn: () => Promise<void>) => fn().then(refresh).catch((e: Error) => setError(e.message));
  const human = manual ? "manual" : "auto";

  return (
    <div className="page">
      <header>
        <div>
          <h1>GuardPay</h1>
          <p className="sub">
            Treasury agent that pays tokenized invoices over x402, screened by Intercepta, with World ID
            human approval for anything risky or large.
          </p>
        </div>
        {state && <ConfigBadges cfg={state.config} />}
      </header>

      {error && <div className="banner error">{error}</div>}

      {state && (
        <>
          <section className="panel">
            <div className="panel-head">
              <h2>Demo scenarios</h2>
              <div className="controls">
                <label className="toggle" title="Manual: you approve/deny in the World App card below">
                  <input type="checkbox" checked={manual} onChange={(e) => setManual(e.target.checked)} />
                  I'll be the human approver
                </label>
                <button className="primary" disabled={state.busy} onClick={() => act(() => post("/api/demo/run", { human }))}>
                  {state.busy ? "Running…" : "Run demo"}
                </button>
                <button className="ghost" disabled={state.busy} onClick={() => act(() => fetch("/api/log", { method: "DELETE" }).then(() => {}))}>
                  Clear log
                </button>
              </div>
            </div>
            <div className="scenarios">
              {state.scenarios.map((s) => (
                <div key={s.key} className="scenario">
                  <div className="scenario-top">
                    <span className="num">{s.key}</span>
                    <span className="amount">{dollars(s.amountUsdc)}</span>
                  </div>
                  <div className="title">{s.title}</div>
                  <div className="expect">Expect: {s.expect}</div>
                  <div className="mono dim">payTo {short(s.supplier)}</div>
                  <button disabled={state.busy} onClick={() => act(() => post(`/api/scenarios/${s.key}/run`, { human }))}>
                    Run
                  </button>
                </div>
              ))}
            </div>
          </section>

          {state.approvals.length > 0 && (
            <section className="panel approvals">
              <h2>World ID approval required</h2>
              {state.approvals.map((a) => (
                <ApprovalCard key={a.id} a={a} mode={state.config.worldMode} onDone={refresh} onError={setError} />
              ))}
            </section>
          )}

          <section className="panel">
            <h2>Decision log</h2>
            {state.records.length === 0 ? (
              <p className="dim">No payments yet. Run a scenario.</p>
            ) : (
              <div className="log">
                {state.records.map((r) => (
                  <LogRow key={r.id} r={r} />
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function ConfigBadges({ cfg }: { cfg: State["config"] }) {
  return (
    <div className="badges">
      <span className="badge">{cfg.network}</span>
      <span className="badge">auto-pay ≤ {dollars(cfg.autoPayLimitUsdc)}</span>
      <span className="badge">cap ≤ {dollars(cfg.capLimitUsdc)}</span>
      <span className={`badge ${cfg.interceptaConfigured ? "ok" : "warn"}`}>
        Intercepta {cfg.interceptaConfigured ? "live" : "no key: fail-closed"}
      </span>
      <span className="badge">World ID: {cfg.worldMode}</span>
      <span className={`badge ${cfg.agentWalletConfigured ? "ok" : "warn"}`}>
        wallet {cfg.agentWalletConfigured ? "ready" : "missing"}
      </span>
      <span className="badge">{cfg.invoiceToken ? `InvoiceToken ${short(cfg.invoiceToken)}` : "local invoices"}</span>
    </div>
  );
}

function Countdown({ until }: { until: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  return <span className="mono">{Math.max(0, Math.ceil((until - now) / 1000))}s</span>;
}

function ApprovalCard(props: { a: Approval; mode: "mock" | "oidc"; onDone: () => void; onError: (e: string) => void }) {
  const { a, mode } = props;
  const run = (fn: () => Promise<void>) => fn().then(props.onDone).catch((e: Error) => props.onError(e.message));
  return (
    <div className="approval">
      <div className="world-app">
        <div className="world-head">
          <span className="orb" /> World App {mode === "mock" && <span className="dim">(mock)</span>}
        </div>
        <p className="binding">{a.bindingMessage}</p>
        <div className="mono dim">
          code {a.userCode} · expires in <Countdown until={a.expiresAt} />
        </div>
        {mode === "mock" ? (
          <div className="row">
            <button className="primary" onClick={() => run(() => post(`/mock-world/app/requests/${a.userCode}/approve`))}>
              Verify with World ID &amp; approve
            </button>
            <button className="danger" onClick={() => run(() => post(`/mock-world/app/requests/${a.userCode}/deny`))}>
              Deny
            </button>
          </div>
        ) : (
          <a className="button primary" href={a.verificationUriComplete ?? a.verificationUri} target="_blank" rel="noreferrer">
            Open World ID to approve
          </a>
        )}
      </div>
      <button className="ghost" onClick={() => run(() => post(`/api/approvals/${a.id}/cancel`))}>
        Cancel request (operator)
      </button>
    </div>
  );
}

function Chip({ v }: { v?: string }) {
  if (!v) return <span className="chip">—</span>;
  return <span className={`chip c-${v.toLowerCase()}`}>{v.replace("_", " ")}</span>;
}

function LogRow({ r }: { r: DecisionRecord }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`entry ${open ? "open" : ""}`}>
      <button className="entry-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="mono dim">{time(r.startedAt)}</span>
        <span className="num">{r.scenario ?? "·"}</span>
        <span>invoice #{r.invoiceId}</span>
        <span className="mono">${usdc(r.amount)}</span>
        <span className="mono dim">→ {short(r.payTo)}</span>
        <span className="chips">
          <Chip v={r.screening?.verdict} />
          <Chip v={r.decision} />
          {r.approval && <Chip v={r.approval.status} />}
          <Chip v={r.outcome} />
        </span>
      </button>
      <div className="reason">
        {r.outcomeReason ?? r.decisionReason ?? ""}
        {r.txHash && (
          <>
            {" · "}
            <a href={scan(r.txHash)} target="_blank" rel="noreferrer" className="mono">tx {short(r.txHash)}</a>
          </>
        )}
      </div>
      {open && (
        <div className="details">
          {r.screening && (
            <>
              <h3>Intercepta checks</h3>
              <table>
                <tbody>
                  {r.screening.checks.map((c) => (
                    <tr key={c.check}>
                      <td>{c.check}</td>
                      <td><Chip v={c.verdict} /></td>
                      <td>{c.reason}<div className="mono dim small">{c.endpoint} · {c.ms}ms</div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          {r.approval?.claims && (
            <>
              <h3>Verified World ID claims</h3>
              <div className="mono small">
                sub {r.approval.claims.sub} · acr {r.approval.claims.acr} · auth_time{" "}
                {r.approval.claims.auth_time && new Date(r.approval.claims.auth_time * 1000).toLocaleTimeString()} · jti{" "}
                {r.approval.claims.jti}
              </div>
            </>
          )}
          <h3>Timeline</h3>
          <ol className="timeline">
            {r.steps.map((s, i) => (
              <li key={i}>
                <span className="mono dim">{time(s.at)}</span> <b>{s.label}</b>
                {s.detail && <span className="dim"> {s.detail}</span>}
              </li>
            ))}
          </ol>
          {r.markPaidTx && (
            <div className="small">
              InvoiceToken.markPaid <a className="mono" href={scan(r.markPaidTx)} target="_blank" rel="noreferrer">{short(r.markPaidTx)}</a>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
