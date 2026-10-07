# Mini Inference Router

A small version of a shared LLM gateway with one capability on top: a **customer-support assistant** that answers a customer message from a support knowledge base and returns the detected intent.

Built for the Mekari "Code Challenge: Mini Inference Router" assessment. See [`docs/REPORT.md`](docs/REPORT.md) for design decisions, trade-offs and evaluation numbers.

## What it does

- **Gateway** (Node.js/Express): `POST /v1/chat` with **SSE streaming**, authenticated by a **per-tenant API key**, with a **per-tenant daily token quota that fails closed** (429 before any model call), and **metering per request** (model, tokens, latency, cost, outcome — stored in SQLite).
- **Routing**: two backends behind one interface — a **real model** (Groq, `openai/gpt-oss-20b`) and an **extractive backend** that serves the top-retrieved KB answer verbatim. Routing rules are reasoned and observable: high retrieval evidence short-circuits to the cheap extractive backend; everything else is synthesized by the real model.
- **Fallback**: if the chosen backend fails or is too slow to start (TTFB timeout), the request falls back to the other backend — **pre-first-token only** (a half-delivered answer is never retried). Every decision is recorded and inspectable.
- **Support assistant**: retrieval (BM25) over a slice of the [Bitext customer-support dataset](https://huggingface.co/datasets/bitext/Bitext-customer-support-llm-chatbot-training-dataset) (~27k QA pairs / 27 intents). Returns answer, detected intent, retrieved entries and a **confidence signal**; **refuses instead of guessing** when evidence/confidence is low, including a pre-flight gate that refuses without calling any model.
- **Console** (React + Vite + Tailwind): chat playground where the answer streams in and you can see which model served it, whether fallback fired, what was retrieved, the intent, tokens, latency and cost — plus a per-tenant usage view with remaining quota.
- **Evaluation** (`server/src/scripts/eval.ts`): ~30 held-out cases reporting intent accuracy, answer quality (ROUGE + LLM judge), refusal accuracy, latency and cost — run against two router configurations and compared.

## Architecture

```
┌─────────────────┐   x-api-key (tenant)   ┌───────────────────────────────┐
│  React Console   │ ─────────────────────► │        Express Gateway          │
│  (Vercel)        │ ◄───── SSE stream ─── │                                 │
└─────────────────┘                        │  1. zod validation              │
                                           │  2. auth (api key → tenant)    │
                                           │  3. retrieval (BM25 over KB)   │
                                           │  4. refusal gate (coverage)     │
                                           │  5. quota reserve (fail closed) │
                                           │  6. route → backend             │
                                           │       ├─► Groq (real model)      │
                                           │       └─► Extractive (KB, $0)    │
                                           │  7. fallback pre-first-token    │
                                           │  8. confidence gate → ok/refused│
                                           │  9. metering → SQLite           │
                                           └───────────────────────────────┘
```

## Repository layout

```
server/                     Express gateway (TypeScript)
  src/
    index.ts                entrypoint (CORS, routes, seed-on-boot)
    config.ts              all tunables (thresholds, timeouts, prices)
    types.ts               shared domain + SSE contract types
    lib/                   db (SQLite schema), auth, quota (reserve-then-settle),
                            metering, sse helpers, seed, runtime state
    backends/              backend contract, Groq client, extractive backend,
                            chaos wrapping + timeout arming, router policy
    assistant/             BM25, retrieval signals, prompt, sentinel parser
    routes/                chat (the orchestrator), usage, admin
    scripts/               slice-dataset, calibrate, eval
  datasets/                committed slices: kb-slice.json (486), eval-cases.json (30),
                            dev-cases.json (81)
  test/                    unit tests: BM25, sentinel parser, quota
web/                       React console (Vite + Tailwind)
docs/                      REPORT.md, eval-results.md
```

## Quickstart

Requirements: Node 20+.

```bash
# 1. Gateway
cd server
npm install
GROQ_API_KEY=<your-key> npm run dev        # http://localhost:8080
# (a .env file also works; see .env.example — DB and seeds are created on boot)

# 2. Console (separate terminal)
cd web
npm install
npm run dev                                 # http://localhost:5173 (proxies /v1 to :8080)
```

Demo tenants are seeded on boot (keys are public demo data, not secrets):

| tenant | api key | quota (tokens/day) |
|---|---|---|
| acme | `sk-demo-acme-0001` | 50,000 |
| globex | `sk-demo-globex-0002` | **200** (demonstrates 429 fail-closed) |
| initech | `sk-demo-initech-0003` | 50,000 |
| eval | `sk-demo-eval-0004` | 500,000 (evaluation harness) |

## API

### `POST /v1/chat` (SSE)

```bash
curl -N -X POST http://localhost:8080/v1/chat \
  -H 'content-type: application/json' \
  -H 'x-api-key: sk-demo-acme-0001' \
  -d '{"message":"help me reset my PIN"}'
```

Events (in order): `meta` (request id, intent vote, dominance/coverage, retrieved entries) → `delta`* (streamed answer) → `done` (backend, model, route rule, fallback info, intent, confidence, tokens, ttfb/total latency, cost, outcome) — or `error` (stream-level failure).

Errors before the stream starts are clean HTTP JSON: `400 INVALID_INPUT`, `401 INVALID_API_KEY`, `429 QUOTA_EXCEEDED` (with `used_tokens`, `limit_tokens`, `reset_at`).

### `GET /v1/usage` (same API key)

Quota snapshot, today's aggregates per outcome, recent requests.

### `/admin/*` (header `x-admin-key`)

- `GET /admin/state` — current chaos/mock/router state
- `POST /admin/chaos {backend, mode: off|error|slow}` — failure drill on any backend (fallback demo)
- `POST /admin/mock {latencyMs?, failureRate?}` — extractive mock behaviour
- `POST /admin/router {shortCircuitThreshold: number|null}` — runtime routing policy (used by the eval script)
- `GET /admin/usage[?request_id=|?limit=]` — full internal metering rows
- `POST /admin/quota-reset {tenant}` — reset today's ledger (dev/eval)

## Evaluation

```bash
cd server
GROQ_API_KEY=<your-key> npx tsx src/scripts/eval.ts --judge
```

Runs the 30-case held-out set under routing ON vs OFF and writes `docs/eval-results.md`. Thresholds themselves were calibrated on a separate dev split (`npx tsx src/scripts/calibrate.ts`), never on the eval set.

## Tests

```bash
cd server && npm test      # BM25, sentinel parser, quota (reserve-then-settle)
```

## Deployment

- **Gateway**: Render web service (root: `server/`, start `npm start`). Env vars: `GROQ_API_KEY`, `ADMIN_KEY`, `CORS_ORIGIN`, `DB_PATH`.
- **Console**: Vercel (root: `web/`), env `VITE_API_URL=https://<render-service>.onrender.com`.

Step-by-step (with a demo/video checklist): **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**. Known free-tier trade-off: the Render service spins down after ~15 min idle; the first request after that pays a ~50s cold start — wake it with `curl <url>/healthz` before demoing.

## Dataset

[bitext/Bitext-customer-support-llm-chatbot-training-dataset](https://huggingface.co/datasets/bitext/Bitext-customer-support-llm-chatbot-training-dataset) (26,872 QA pairs, 27 intents). `server/src/scripts/slice-dataset.ts` produces, deterministically (seeded shuffle): the KB slice (18/intent = 486 entries), the held-out eval set (27 in-scope + 3 crafted out-of-scope), and a dev split (3/intent) used only for threshold calibration.
