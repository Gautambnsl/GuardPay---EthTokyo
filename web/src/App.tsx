import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import type { Approval, DecisionRecord, State } from "./types";
import { short, stagesFor, usd, type Stage } from "./stages";

const time = (iso: string) => new Date(iso).toLocaleTimeString();
const scan = (kind: "tx" | "address", v: string) => `https://sepolia.basescan.org/${kind}/${v}`;
const dollars = (v: string) => `$${Number(v).toFixed(2)}`;

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
  const [manual, setManual] = useState(true);
  const [selected, setSelected] = useState<string>(); // record id; undefined = follow live
  const [replayFrom, setReplayFrom] = useState(0);

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
    const t = setInterval(refresh, 800);
    return () => clearInterval(t);
  }, [refresh]);

  const act = (fn: () => Promise<void>) => fn().then(refresh).catch((e: Error) => setError(e.message));
  const human = manual ? "manual" : "auto";
  const run = (path: string) => {
    setSelected(undefined);
    act(() => post(path, { human }));
  };

  const issuing = state?.issuing[0];
  const focus = useMemo(() => {
    if (!state) return undefined;
    if (selected) return state.records.find((r) => r.id === selected);
    if (issuing) return undefined; // brand-new invoice, no record yet
    return state.records[0];
  }, [state, selected, issuing]);

  return (
    <div className="page">
      <header className="top">
        <div className="brand">
          <div className="logo" aria-hidden>
            <svg viewBox="0 0 24 24"><path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3Z" /><path className="tick" d="m8.5 12 2.5 2.5 4.5-5" /></svg>
          </div>
          <div>
            <h1>GuardPay</h1>
            <p className="sub">An autonomous treasury agent that pays tokenized invoices over x402, but only after Intercepta screens every payment and a World ID-verified human approves the big or risky ones.</p>
          </div>
        </div>
        {state && <StatusStrip s={state} />}
      </header>

      {error && <div className="banner error">{error}</div>}

      {state && (
        <>
          <section className="panel flow-panel">
            <div className="panel-head">
              <div>
                <h2>{focus ? `Invoice #${focus.invoiceId}` : issuing ? "New invoice" : "Live flow"}</h2>
                <p className="dim small">
                  {selected ? "Replaying a past run. " : "Following the latest invoice live. "}
                  {selected && (
                    <button className="link" onClick={() => setSelected(undefined)}>Back to live</button>
                  )}
                </p>
              </div>
              {focus && <Outcome r={focus} />}
            </div>
            <Pipeline stages={stagesFor(focus, issuing)} replayFrom={selected ? replayFrom : 0} />
            {state.approvals.length > 0 && (
              <div className="approvals">
                {state.approvals.map((a) => (
                  <WorldApp key={a.id} a={a} mode={state.config.worldMode} onDone={refresh} onError={setError} />
                ))}
              </div>
            )}
            {focus && <FocusDetails r={focus} />}
          </section>

          <BackendConsole />

          <section className="panel">
            <div className="panel-head">
              <div>
                <h2>Supplier console</h2>
                <p className="dim small">Each button makes the supplier issue a real invoice NFT on Base Sepolia, addressed to our company. The agent picks it up from the chain.</p>
              </div>
              <div className="controls">
                <label className="toggle">
                  <input type="checkbox" checked={manual} onChange={(e) => setManual(e.target.checked)} />
                  I'm the treasurer (approve in World App myself)
                </label>
                <button className="primary" disabled={state.busy} onClick={() => run("/api/demo/run")}>
                  {state.busy ? "Running…" : "Run all scenarios"}
                </button>
              </div>
            </div>
            <div className="scenarios">
              {state.scenarios.map((s) => (
                <button key={s.key} className="scenario" disabled={state.busy} onClick={() => run(`/api/scenarios/${s.key}/run`)}>
                  <span className="scenario-top">
                    <span className="num">{s.key}</span>
                    <span className="amount">{dollars(s.amountUsdc)}</span>
                  </span>
                  <span className="title">{s.title}</span>
                  <span className="expect">{s.expect}</span>
                  <span className="mono dim">payTo {short(s.supplier)}</span>
                  <span className="issue-cta">Issue invoice →</span>
                </button>
              ))}
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>Decision log</h2>
              <button className="ghost" disabled={state.busy} onClick={() => act(() => fetch("/api/log", { method: "DELETE" }).then(() => {}))}>
                Clear
              </button>
            </div>
            {state.records.length === 0 ? (
              <p className="dim">No invoices processed yet. Issue one from the supplier console.</p>
            ) : (
              <div className="log">
                {state.records.map((r) => (
                  <LogRow
                    key={r.id}
                    r={r}
                    active={focus?.id === r.id}
                    onClick={() => {
                      setSelected(r.id);
                      setReplayFrom(Date.now());
                      window.scrollTo({ top: 0, behavior: "smooth" });
                    }}
                  />
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function StatusStrip({ s }: { s: State }) {
  const c = s.config;
  return (
    <div className="status">
      <span className={`pill ${c.listening ? "live" : ""}`}>
        <span className="dot" /> {c.listening ? "Agent listening on Base Sepolia" : "Agent idle"}
      </span>
      <a className="pill" href={c.invoiceToken ? scan("address", c.invoiceToken) : undefined} target="_blank" rel="noreferrer">
        InvoiceToken {short(c.invoiceToken ?? undefined)}
      </a>
      {c.payer && (
        <a className="pill" href={scan("address", c.payer)} target="_blank" rel="noreferrer">Treasury {short(c.payer)}</a>
      )}
      <span className={`pill ${c.interceptaConfigured ? "ok" : "warn"}`}>Intercepta {c.interceptaConfigured ? "live" : "fail-closed"}</span>
      <span className="pill">World ID {c.worldMode === "oidc" ? "sandbox" : "mock"}</span>
      <span className="pill">Auto-pay ≤ {dollars(c.autoPayLimitUsdc)}</span>
    </div>
  );
}

const ICONS: Record<Stage["actor"], ReactElement> = {
  supplier: <path d="M4 20V9l8-5 8 5v11M9 20v-6h6v6" />,
  chain: <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />,
  agent: <><rect x="5" y="8" width="14" height="11" rx="3" /><path d="M12 4v4M9 13h.01M15 13h.01" /></>,
  x402: <path d="M4 7h16v10H4zM4 11h16M8 15h3" />,
  intercepta: <><circle cx="11" cy="11" r="6" /><path d="m20 20-4.5-4.5" /></>,
  policy: <path d="M12 3v18M5 7h14M7 7l-3 7a3 3 0 0 0 6 0L7 7Zm10 0-3 7a3 3 0 0 0 6 0l-3-7Z" />,
  world: <><circle cx="12" cy="12" r="8" /><path d="M4 12h16M12 4a12 12 0 0 1 0 16 12 12 0 0 1 0-16" /></>,
};

function Pipeline({ stages, replayFrom }: { stages: Stage[]; replayFrom: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!replayFrom) return;
    const t = setInterval(() => tick((n) => n + 1), 120);
    const stop = setTimeout(() => clearInterval(t), stages.length * 450 + 300);
    return () => (clearInterval(t), clearTimeout(stop));
  }, [replayFrom, stages.length]);
  // Replay: reveal stages one by one.
  const revealed = replayFrom ? Math.floor((Date.now() - replayFrom) / 450) : Infinity;

  return (
    <ol className="pipeline">
      {stages.map((st, i) => {
        const status = i > revealed ? "todo" : i === revealed && st.status !== "skip" ? "active" : st.status;
        return (
          <li key={st.key} className={`stage s-${status} a-${st.actor}`}>
            <div className="node">
              <svg viewBox="0 0 24 24" aria-hidden>{ICONS[st.actor]}</svg>
            </div>
            {i < stages.length - 1 && <div className="wire"><span /></div>}
            <div className="label">
              <span className="stage-title">{st.title}</span>
              <span className="stage-detail">{status === "todo" ? "" : st.detail}</span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function Outcome({ r }: { r: DecisionRecord }) {
  const text = { PENDING: "Processing", PAID: "Paid", REFUSED: "Refused", NOT_PAID: "Not paid", FAILED: "Failed" }[r.outcome];
  return <div className={`outcome o-${r.outcome.toLowerCase()}`}>{text}</div>;
}

function FocusDetails({ r }: { r: DecisionRecord }) {
  return (
    <div className="focus">
      <div className="facts">
        <Fact k="Amount" v={`$${usd(r.amount)} USDC`} />
        <Fact k="Issued by" v={short(r.issuer)} href={r.issuer && scan("address", r.issuer)} />
        <Fact k="Pay to" v={short(r.payTo)} href={r.payTo && scan("address", r.payTo)} />
        <Fact k="Due" v={r.dueDate ? new Date(r.dueDate * 1000).toLocaleDateString() : "—"} />
        {r.issueTx && <Fact k="Mint tx" v={short(r.issueTx)} href={scan("tx", r.issueTx)} />}
        {r.txHash && <Fact k="Payment tx" v={short(r.txHash)} href={scan("tx", r.txHash)} />}
        {r.markPaidTx && <Fact k="markPaid tx" v={short(r.markPaidTx)} href={scan("tx", r.markPaidTx)} />}
      </div>
      {r.screening && (
        <div className="checks">
          {r.screening.checks.map((c) => (
            <div key={c.check} className={`check v-${c.verdict.toLowerCase()}`}>
              <div className="check-head">
                <span className="check-name">{{ payTo: "Payee address", token: "Token", authorization: "Signed authorization" }[c.check] ?? c.check}</span>
                <Chip v={c.verdict} />
              </div>
              <div className="check-reason">{c.reason}</div>
              <div className="mono dim tiny">{c.endpoint.replace(/0x[0-9a-fA-F]{40}/, (a) => short(a))} · {c.ms}ms</div>
            </div>
          ))}
        </div>
      )}
      {(r.outcomeReason || r.decisionReason) && <p className="why"><b>Why:</b> {r.outcomeReason ?? r.decisionReason}</p>}
      {r.approval?.claims && (
        <p className="mono tiny dim">
          World ID verified: sub {r.approval.claims.sub?.slice(0, 16)}… · acr {r.approval.claims.acr?.split("/").pop()} · jti {r.approval.claims.jti?.slice(0, 8)}…
        </p>
      )}
    </div>
  );
}

function Fact({ k, v, href }: { k: string; v: string; href?: string }) {
  return (
    <div className="fact">
      <span className="dim tiny">{k}</span>
      {href ? <a className="mono" href={href} target="_blank" rel="noreferrer">{v}</a> : <span className="mono">{v}</span>}
    </div>
  );
}

function Countdown({ until }: { until: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  return <>{Math.max(0, Math.ceil((until - now) / 1000))}s</>;
}

function WorldApp(props: { a: Approval; mode: "mock" | "oidc"; onDone: () => void; onError: (e: string) => void }) {
  const { a, mode } = props;
  const run = (fn: () => Promise<void>) => fn().then(props.onDone).catch((e: Error) => props.onError(e.message));
  return (
    <div className="world-row">
      <div className="phone">
        <div className="phone-notch" />
        <div className="world-head">
          <span className="orb" /> World App {mode === "mock" && <span className="dim">(mock)</span>}
        </div>
        <div className="world-title">GuardPay needs your approval</div>
        <p className="binding">{a.bindingMessage}</p>
        <div className="mono dim small">code {a.userCode} · expires in <Countdown until={a.expiresAt} /></div>
        {mode === "mock" ? (
          <div className="row">
            <button className="primary" onClick={() => run(() => post(`/mock-world/app/requests/${a.userCode}/approve`))}>Verify &amp; approve</button>
            <button className="danger" onClick={() => run(() => post(`/mock-world/app/requests/${a.userCode}/deny`))}>Deny</button>
          </div>
        ) : (
          <a className="button primary" href={a.verificationUriComplete ?? a.verificationUri} target="_blank" rel="noreferrer">Open World ID</a>
        )}
      </div>
      <div className="world-side">
        <p className="small">The agent paused. The payment only executes after a <b>fresh</b>, Orb-verified human approval that the backend validates: signature, audience, freshness, single use, and bound to this exact invoice, payee and amount.</p>
        <button className="ghost" onClick={() => run(() => post(`/api/approvals/${a.id}/cancel`))}>Cancel request (operator)</button>
      </div>
    </div>
  );
}

function Chip({ v }: { v?: string }) {
  if (!v) return <span className="chip">—</span>;
  return <span className={`chip c-${v.toLowerCase()}`}>{v.replace("_", " ")}</span>;
}

function LogRow({ r, active, onClick }: { r: DecisionRecord; active: boolean; onClick: () => void }) {
  return (
    <button className={`entry ${active ? "active" : ""}`} onClick={onClick}>
      <span className="mono dim">{time(r.startedAt)}</span>
      <span className="num">{r.scenario ?? "·"}</span>
      <span>Invoice #{r.invoiceId}</span>
      <span className="mono">${usd(r.amount)}</span>
      <span className="mono dim">→ {short(r.payTo)}</span>
      <span className="chips">
        <Chip v={r.screening?.verdict} />
        <Chip v={r.decision} />
        {r.approval && <Chip v={r.approval.status} />}
        <Chip v={r.outcome} />
      </span>
    </button>
  );
}

interface LogLine { t: number; source: string; level: "info" | "warn" | "error"; msg: string }

const TAG = /^\[([a-z0-9-]+)\]\s*/i;

/** Live tail of the agent + seller processes (their real stdout), for showing the backend at work. */
function BackendConsole() {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [open, setOpen] = useState(true);
  const [follow, setFollow] = useState(true);
  const boxRef = useRef<HTMLDivElement>(null);
  const since = useRef(Date.now() - 5 * 60_000);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const res = await fetch(`/api/logs?since=${since.current}`);
        const next: LogLine[] = await res.json();
        if (alive && next.length) {
          since.current = next[next.length - 1]!.t;
          setLines((prev) => [...prev, ...next].slice(-400));
        }
      } catch {}
    };
    poll();
    const t = setInterval(poll, 700);
    return () => ((alive = false), clearInterval(t));
  }, []);

  useEffect(() => {
    if (follow && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [lines, follow]);

  return (
    <section className="panel console-panel">
      <div className="panel-head">
        <div>
          <h2>Backend console</h2>
          <p className="dim small">Live output of the treasury agent and the supplier's x402 server running on this machine.</p>
        </div>
        <div className="controls">
          <label className="toggle"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow</label>
          <button className="ghost" onClick={() => setLines([])}>Clear</button>
          <button className="ghost" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? "Hide" : "Show"}</button>
        </div>
      </div>
      {open && (
        <div className="terminal" ref={boxRef} role="log" aria-live="polite">
          {lines.length === 0 && <div className="dim">Waiting for activity… issue an invoice from the supplier console.</div>}
          {lines.map((l, i) => {
            const m = l.msg.match(TAG);
            const tag = m?.[1] ?? l.source;
            const rest = m ? l.msg.slice(m[0].length) : l.msg;
            return (
              <div key={i} className={`tl lvl-${l.level}`}>
                <span className="tt">{new Date(l.t).toLocaleTimeString([], { hour12: false })}</span>
                <span className={`tag tag-${tag}`}>{tag}</span>
                <span className="tm">{rest}</span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
