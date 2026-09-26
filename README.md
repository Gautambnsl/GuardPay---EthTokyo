# GuardPay

**A treasury AI agent that pays tokenized supplier invoices over x402, screens every payment with Intercepta before signing it away, and requires a fresh World ID-verified human approval for anything large or risky.**

Built at ETHGlobal Tokyo. Testnet USDC on Base Sepolia.

## Team

| Name | Role | Handle |
| --- | --- | --- |
| _TODO_ | | @ |
| _TODO_ | | @ |

## How it works

```
 invoice NFT (InvoiceToken)                                         dashboard (web/)
        │                                                                 ▲
        ▼                                                                 │ decision log
 ┌───────────┐  402 quote   ┌────────────────────┐   verdict   ┌──────────┴─┐
 │  seller   │─────────────▶│ agent: sign EIP-3009│────────────▶│   policy   │
 │ x402 POST │              │ authorization (kept │  Intercepta │  engine    │
 │ /invoices │◀─────────────│ in memory)          │  screening  └──┬───┬───┬─┘
 │ /:id/pay  │  paid retry  └────────────────────┘                │   │   │
 └───────────┘      ▲                                    PAY / CAP│   │   │REFUSE → never sent
                    │                                             │   │ESCALATE
                    │         World ID for Agents: device-code    │   ▼
                    └──────── approval, id_token verified on ─────┴── human
                              the backend (JWKS, acr=orb, fresh,      (World App)
                              single-use, bound to this payment)
```

For every invoice, the agent ([agent/src/agent.ts](agent/src/agent.ts)):

1. **Quote.** It calls `POST /invoices/:id/pay` on the seller and gets back a **402 Payment Required**. The payTo (the supplier), the asset (USDC) and the amount all come from the InvoiceToken.
2. **Sign.** It builds the exact EIP-3009 `TransferWithAuthorization` that x402 would send. The signed payload stays in memory; nothing goes to the seller yet.
3. **Screen with Intercepta.** Three live calls run in parallel. Each returns a verdict of `CLEAN`, `CAUTION`, `HOLD` or `BLOCK`:
   - the **payTo address** (quick-scan, plus a deep scan if anything turns up)
   - the **token**
   - the **payment authorization itself** (scan-message on the EIP-712 payload)
4. **Policy** ([agent/src/policy.ts](agent/src/policy.ts)):

   | Screening verdict | Amount | Decision |
   | --- | --- | --- |
   | `BLOCK` | any | **REFUSE**: never paid, no override |
   | `HOLD` (flagged, or Intercepta unreachable) | any | **ESCALATE** to World ID |
   | `CAUTION` | ≤ `CAP_LIMIT_USDC` | **CAP**: auto-pay under the reduced cap |
   | `CAUTION` | > cap | **ESCALATE** |
   | `CLEAN` | ≤ `AUTO_PAY_LIMIT_USDC` | **PAY** |
   | `CLEAN` | > limit | **ESCALATE** |

5. **Escalate.** The agent requests a fresh human approval through World ID for Agents and waits.
   - It pays only if the id_token passes backend validation.
   - A **denied**, **expired**, **cancelled** or **invalid** approval means the payment is **not made**.
   - After approval, the agent signs a fresh authorization and screens it again.
6. **Execute.** It sends the x402 payment. The facilitator settles on Base Sepolia, and then the agent calls `InvoiceToken.markPaid(id, txHash)`.
7. **Log.** Every decision is recorded with its verdict, reasons, approval claims and tx hash, and appears on the dashboard.

Screening **fails closed**: if Intercepta can't be reached, the verdict is `HOLD`, so a human decides. The agent never auto-pays unscreened.

## Repo layout

| Path | What |
| --- | --- |
| [contracts/src/InvoiceToken.sol](contracts/src/InvoiceToken.sol) | ERC-721 invoice (supplier, amount, dueDate, paid, paymentRef). `markPaid` is agent-only |
| [contracts/script/Deploy.s.sol](contracts/script/Deploy.s.sol) | Deploys the contract and issues the 4 demo invoices |
| [seller/src/server.ts](seller/src/server.ts) | Express x402 resource server. `POST /invoices/:id/pay` is priced per invoice |
| [agent/src/x402.ts](agent/src/x402.ts) | x402 buyer, split into quote → sign → submit |
| [agent/src/intercepta.ts](agent/src/intercepta.ts) | Intercepta screening pipeline and verdict mapping |
| [agent/src/policy.ts](agent/src/policy.ts) | Policy engine: PAY / REFUSE / CAP / ESCALATE |
| [agent/src/worldid.ts](agent/src/worldid.ts) | World ID for Agents: device-code approval and backend token validation |
| [agent/src/mock-world.ts](agent/src/mock-world.ts) | Mock World issuer (same protocol, real RS256 tokens) for `WORLD_MODE=mock` |
| [agent/src/agent.ts](agent/src/agent.ts) | The agent loop |
| [agent/src/server.ts](agent/src/server.ts) | Dashboard API. Secrets stay server-side |
| [web/](web/) | Vite/React dashboard |

## Setup

Requirements: Node 20+, Foundry.

```bash
npm install
npm run contracts:install      # forge-std + OpenZeppelin into contracts/lib
cp .env.example .env           # then fill it in (see below)
```

Minimum `.env` for the demo:

- `AGENT_PRIVATE_KEY`: a Base Sepolia wallet funded with testnet USDC from [faucet.circle.com](https://faucet.circle.com). Add a little ETH if you deploy the contract, to pay for `markPaid` gas.
- `CLEAN_SUPPLIER_ADDRESS`: any address you control. It receives the USDC.
- `RISKY_SUPPLIER_ADDRESS`: a known-risky **mainnet** address. It defaults to the Ronin bridge exploiter (OFAC-sanctioned, toxicScore 100 in Intercepta); see [shared/src/config.ts](shared/src/config.ts).
- `INTERCEPTA_API_KEY`: without it, every payment fails closed to ESCALATE.
- `WORLD_MODE=mock` (the default). Or `oidc` with `WORLD_CLIENT_ID` and `WORLD_CLIENT_SECRET` from a registered sandbox app.

Optionally, deploy the InvoiceToken. Without it, the seller uses a local registry with the same four invoices.

```bash
npm run deploy                 # prints INVOICE_TOKEN_ADDRESS=0x… → put it in .env
```

With the token deployed, each dashboard run issues a fresh invoice NFT and marks it paid on-chain.

## Run

Use three terminals:

```bash
npm run seller   # x402 seller    http://localhost:4021
npm run agent    # agent API      http://localhost:4000 (+ mock World issuer at /mock-world)
npm run web      # dashboard      http://localhost:5173
```

In the dashboard, you have two ways to run things:

- **Run demo** runs all scenarios with a simulated human.
- Tick **"I'll be the human approver"** to click Approve or Deny yourself in the World App card.

Each scenario also has its own **Run** button.

Headless: with the seller running, `npm run demo` runs every scenario and prints a summary.

### Demo scenarios

| # | Invoice | Expected |
| --- | --- | --- |
| 1 | $0.05 to a clean supplier | Intercepta CLEAN → **PAY** (tx hash logged) |
| 2 | $0.05 to a known-risky mainnet payTo | Intercepta BLOCK → **REFUSE**, reason shown, nothing sent |
| 3 | $2.00 to a clean supplier | over the $1 limit → **ESCALATE** → World ID approve → **PAY** |
| 4 | $2.00 to a clean supplier | **ESCALATE** → human denies → **NOT PAID** |
| 4b | $2.00 to a clean supplier | **ESCALATE** → approval expires after 8s → **NOT PAID** |

## Test

```bash
npm test          # forge tests (InvoiceToken) + agent tests (policy, verdicts, World ID validation)
npm run typecheck
npm run screen -w agent -- 0xSomeMainnetAddress   # one live Intercepta screening, printed as JSON
npx tsx agent/src/pay.ts 1                        # raw x402 payment of invoice #1, no GuardPay checks
```

The World ID tests cover approve, deny, expire and cancel. They also check that the backend rejects a **replayed** token, a **stale** session, a **forged** token (bad signature), a **wrong audience**, and an approval reused for a **different payment**.

---

## Intercepta: Safe Agent-to-Agent Payments with x402

All calls are live (`https://api.web3antivirus.io`, `X-API-KEY` header). There are no mocks.

| What | Endpoint | Where |
| --- | --- | --- |
| HTTP client (auth, timeout, rate-limit spacing + 429 retry) | – | [agent/src/intercepta.ts:46-75](agent/src/intercepta.ts#L46-L75) |
| payTo quick scan | `GET /api/public/v2/extension/account/{address}/quick-scan` | [agent/src/intercepta.ts:108](agent/src/intercepta.ts#L108) |
| payTo deep scan (if the quick scan finds anything) | `GET /api/public/v2/extension/account/{address}/toxic-score` | [agent/src/intercepta.ts:113](agent/src/intercepta.ts#L113) |
| token scan | `GET /api/public/v2/extension/token-intelligence/token/{address}/risks` | [agent/src/intercepta.ts:148](agent/src/intercepta.ts#L148) |
| payment authorization (EIP-712) | `POST /api/public/v2/extension/analysis/signature` | [agent/src/intercepta.ts:223](agent/src/intercepta.ts#L223) |
| authorization integrity (signed `to`/`value` must equal the screened payTo/amount) | local | [agent/src/intercepta.ts:210](agent/src/intercepta.ts#L210) |
| pipeline entry | `screenPayment()` | [agent/src/intercepta.ts:251](agent/src/intercepta.ts#L251) |
| called from the agent loop, before any payment is sent | | [agent/src/agent.ts:54](agent/src/agent.ts#L54) (and a re-screen after approval at [:77](agent/src/agent.ts#L77)) |
| verdict → decision | `decide()` | [agent/src/policy.ts:27](agent/src/policy.ts#L27), called at [agent/src/agent.ts:58](agent/src/agent.ts#L58) |

**Mainnet data, testnet payment.** Intercepta has no Base Sepolia data, so GuardPay handles the two sides differently:

- It screens the **real payTo address** unchanged.
- It maps the testnet asset and the EIP-712 domain to their **Base mainnet** equivalents: testnet USDC becomes `0x8335…2913`, with chainId 8453.

**Live results** (`npm run screen -w agent -- <address>`):

| payTo | payTo check | token check | authorization check | Verdict |
| --- | --- | --- | --- | --- |
| `0x098B…2F96` (Ronin exploiter, OFAC) | BLOCK: toxicScore 100, `known_scammer`, `sanction_address`, `blacklist`, `fake_phishing_transfer` | CLEAN: USDC whitelisted | riskGroup Low | **BLOCK → REFUSE** |
| `0xd8dA…6045` (vitalik.eth) | CLEAN: toxicScore 0 | CLEAN | riskGroup Low | **CLEAN → PAY** |

**API feedback:**

- The per-endpoint OpenAPI specs, and the `.md` versions of the docs, made the integration quick. An agent can read them directly. Address and token scans returned clear, actionable results within about 1s.
- **`scan-message` doesn't decode EIP-3009 `TransferWithAuthorization`**, which is the exact thing x402 signs. It returns `messageType: null`, `domain` fields null, no addresses and riskGroup `Low`, even when `to` is a sanctioned address. We cover this with the payTo scan plus a local check that the signed `to` and `value` match the screened payTo and amount. Native x402/EIP-3009 support would make this endpoint the natural single check.
- The API key is rate-limited per second, so three parallel calls hit **HTTP 429**. We space requests 400ms apart and retry. Documenting the limit, or adding a `Retry-After` header, would help.
- `quick-scan` returns **404** for contract addresses ("An Externally Owned Account with this address doesn't exist"). A payTo can legitimately be a contract, such as a smart wallet or a splitter, so a verdict for contracts would help. We fail closed to human approval.
- The `toxicScore` scale isn't documented; from live data it appears to be 0–100. A recommended action, like the `action: block|warn` on token scans, would remove guesswork from our thresholds (≥70 BLOCK, ≥40 HOLD, >0 CAUTION). `scan-message` also takes `message` as a JSON **string**, and its `chainId` enum has no testnets.

## World: Best Use of World ID for Agents

GuardPay uses World ID for Agents as a **step-up approval** for money movement.

- **The flow is the OIDC Device Authorization Grant.** World ID for Agents lists it for "confidential-client device login with explicit human approval". The agent is headless, so a redirect flow doesn't fit.
- **Mock mode (the default)** mocks only the proof. [agent/src/mock-world.ts](agent/src/mock-world.ts) is a local issuer that implements the same discovery, `device_authorization`, `token` and JWKS endpoints as `sandbox.auth.world.org`, and signs real RS256 id_tokens.
- **The backend validation is identical in both modes.**
- **Real mode:** set `WORLD_MODE=oidc` with a registered sandbox client.

**Backend validation** ([agent/src/worldid.ts:231](agent/src/worldid.ts#L231)). An approval counts only if every check passes:

- JWKS signature (RS256) from the issuer's `jwks_uri`, `iss`, `aud` = this agent's client, and `exp`
- `acr = https://world.org/oidc/acr/orb-v3`: an Orb-verified human
- **freshness**: `auth_time` must be after this approval request, which rules out a reused earlier session, and within `WORLD_MAX_AUTH_AGE_SECONDS`
- **single use**: a `jti` replay cache. Each approval is consumed once and is bound to one payment intent: a hash of the invoice, payTo, asset, amount and network ([consumeApproval, :266](agent/src/worldid.ts#L266))
- optional `WORLD_APPROVER_SUBS`, an allowlist of pairwise subjects for authorized treasurers

Where it's called: the request is at [worldid.ts:132](agent/src/worldid.ts#L132), polling and the deny, expire and cancel handling at [:181](agent/src/worldid.ts#L181), and the use in the agent loop at [agent/src/agent.ts:68-73](agent/src/agent.ts#L68-L73).

### Why human approval is the minimum sufficient trust for large payments

**Screening can't answer whether the payment was intended.** Intercepta can tell the agent that a payTo is *not known to be bad*. It can't tell it that *this* $2,000 invoice is legitimate. A clean-looking address can still belong to an invoice-fraud scheme, a compromised supplier account or a prompt-injected agent.

**Weaker controls fail against the threats that matter.**
- **More automated checks** can be fooled by the same attacker who fooled the agent.
- **An API key or a second agent** can be stolen or prompt-injected along with the first one.
- **A long-lived session** doesn't prove that anyone looked at *this* payment.

**The minimum that closes the gap is one real, unique human**, freshly authenticated, who explicitly approves exactly this payment within a short window. World ID provides that without KYC or identity data: we learn only that an Orb-verified person approved, under a pairwise subject.

**Anything more would be overkill here.** Multi-sig quorums or KYC would add friction without addressing a threat this flow faces.

**Anything less** (no approval, a cached session, or a replayable token) leaves the agent as a single point of failure.

**The cost stays low.** Small, clean payments stay fully autonomous, so humans only see the few payments that need them.

### Debrief

- **Time to first success.** About 5 minutes from starting `worldid.ts` to the first backend-verified approval, in mock mode against our local issuer. We haven't yet run the real sandbox issuer end to end, because registering an app needs the plugin and portal sign-in. The client code is the same, so it's configuration only.
- **Friction.** `sandbox.auth.world.org/docs` is conceptual. We found the concrete endpoints (device authorization, token, JWKS, `acr` values) by reading `/.well-known/openid-configuration`. The agent plugin is for a *coding* agent to register apps, not a runtime SDK for an autonomous agent. Callback URLs must be HTTPS, which rules out localhost redirect flows during a hackathon.
- **Missing docs.**
  - An end-to-end device-flow example: which errors to expect (`authorization_pending`, `access_denied`, `expired_token`), the default `expires_in` and `interval`, and a sample id_token.
  - How to **bind an approval to a specific action**, such as a transaction summary shown in World App (CIBA `binding_message` or RAR `authorization_details`).
  - Whether `auth_time` is guaranteed fresh on every device-flow approval.
- **Top improvement.** First-class *action-bound approvals*: the agent sends a human-readable, hash-bound description of the action ("Pay 2,000 USDC to 0xabc… for invoice #3"), World App displays it, and the id_token includes that hash. Today the binding is enforced server-side by GuardPay. Having it in the token would make "this human approved this exact payment" verifiable by anyone.

## Curvegrid: Best AI Agent Project

**GuardPay is an autonomous treasury agent with guardrails:**

- It quotes, screens, decides and pays by itself.
- It stops for a human only when policy requires it.
- It records every decision with an auditable reason.
- It settles tokenized invoices on-chain.

**MultiBaas: not used.** The contract is deployed with Foundry, and the agent talks to the chain directly with viem.

## Security notes

- All secrets live in `.env`, which is git-ignored, and are read only by the Node processes. The browser talks to `/api` and never sees a key.
- World ID results are validated on the server only. The dashboard can't mark anything approved; it can only relay the (mock) human's action to the issuer, or cancel.
- `REFUSE` is final. A signed-but-refused authorization is never sent to the seller.
