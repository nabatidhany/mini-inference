# Technical report — Mini Inference Router

A one-day build of a small shared LLM gateway with one capability on top: a customer-support assistant (RAG over a Bitext customer-support KB slice) that answers a customer message and returns the detected intent. This report explains the design choices, what was measured, the trade-offs accepted, and what was deliberately cut.

## 1. What was built

| Requirement | Implementation |
|---|---|
| Chat endpoint with streaming, per-tenant API key | `POST /v1/chat`, SSE (`meta` → `delta`* → `done`/`error`), `x-api-key` → tenant lookup |
| Per-tenant quota that fails closed | Daily **token** quota, **reserve-then-settle**, 429 with `used/limit/reset_at` before any model call |
| Metering per request (model, tokens, latency, cost, outcome) | One `usage` row per request in SQLite; tokens provider-reported on the real-model path; cost from a per-model price table |
| ≥2 model backends with defensible routing rules | Groq `openai/gpt-oss-20b` (real) + extractive backend (verbatim top-retrieved KB answer); rule-based routing (§2) |
| Fallback on failure/slow, decision recorded + inspectable | Pre-first-token failover, `route_rule` / `fallback_fired` / `fallback_reason` metered and shown in the console |
| Retrieval over the KB slice | BM25 (k1=1.5, b=0.75) over KB questions + intent tokens, top-5 |
| Returns answer, intent, retrieved entries, confidence | `meta` event (pre-flight: intent vote, dominance, coverage, retrieved) + `done` event (final intent, confidence, metering) |
| Handles unusable model output; refuses instead of guessing | Sentinel-tail structured output; malformed/missing sentinel degrades to the retrieval signal; three-layer refusal policy (§4) |
| Console (chat playground + usage view) | React + Vite + Tailwind: split view with live request inspector; usage view with quota, per-outcome aggregates, per-request metering (5s polling) |
| ~30 held-out cases, script reporting accuracy/quality/latency/cost, two configurations compared | `src/scripts/eval.ts` (§5), results in `docs/eval-results.md` |
| Deployed URL | Gateway on Render, console on Vercel (see README) |

## 2. Routing rules (reasoned, and measured)

Both backends sit behind one interface (`backends/types.ts`). The router (`backends/registry.ts`) picks per request:

1. **Short-circuit (extractive)** — when retrieval shows the top KB entry already *is* the answer, serving it verbatim is strictly cheaper (zero model cost, deterministic, ~250ms). The condition uses two pre-flight signals computed from BM25 over the top-5:
   - **cross-intent dominance** ≥ 0.75 — the winner's score is ≥ 3× the best **different-intent** competitor in the top-5. Same-intent runner-ups are template variants, not risks; what would make extraction wrong is a *different* answer winning.
   - (coverage was already enforced by the refusal gate — see §4)
2. **Default (real model)** — otherwise the request needs synthesis, and only the real model can paraphrase/combine evidence.
3. **Fallback** — if the chosen backend fails or is too slow to produce its first token (TTFB > 12s), the request fails over to the other backend, **once**. After the first token has been forwarded, a failure is an `error`, not a retry: the client has already seen half an answer, and a silent restart would corrupt the transcript.

Why these thresholds are not arbitrary: they were **calibrated on a dev split** (81 held-out cases, disjoint from both KB and eval — `src/scripts/calibrate.ts`):

- out-of-scope probes: coverage max **0.33**; in-scope dev cases: coverage p25 **0.50**, p50 **0.67** → the coverage floor of **0.40** separates the two distributions with margin.
- dominance ≥ 0.75 fires on **48%** of dev cases (essentially all cases where no different-intent competitor exists at all) — i.e. the cheap path carries roughly half the traffic, and the eval (§5) prices what that saves.

The routing threshold is runtime-adjustable (`POST /admin/router`) — that is how the eval runs its two configurations without redeploys.

## 3. Model & retrieval choices

- **Real model: Groq `openai/gpt-oss-20b`** (free tier). Any OpenAI-compatible provider works via `GROQ_BASE_URL`/`GROQ_MODEL`. Tokens are taken from the provider's `usage` field when streaming (`stream_options.include_usage`) so metering is **accurate**, not estimated, on the model path.
- **Second backend: extractive, not a fake LLM.** The assessment allows a mock second backend; making it *useful* (serve the top-retrieved KB answer verbatim, honestly labelled) means fallback is degraded-but-correct instead of garbage. Its latency and failure rate are admin-configurable at runtime (`POST /admin/mock`) — that is how the mock drill behaviour the PDF suggests is demonstrated.
- **Chaos switch** (`POST /admin/chaos`) forces `error`/`slow` on any backend, including the real one. This is how fallback is demonstrable on demand (Groq won't fail on request); it is the standard failure-drill pattern, and every fired fallback is visible in metering with its reason.
- **Retrieval: BM25 over questions + intent tokens.** Bitext questions are short and lexical; BM25 needs no embedding dependency, is explainable ("why was this retrieved" = term scores), and is fast at this scale. Trade-off: paraphrases with no lexical overlap are missed — measured (coverage gate) rather than assumed, and mitigated by the fact that the eval set comes from the same distribution.
- **Streaming + structured output conflict**: solved with a **sentinel tail line** — the model streams a natural answer ending in `<<<META intent=... confidence=...>>>`; the gateway parses it server-side, never forwards it, and survives chunk boundaries that split the marker (unit-tested). JSON mode would have killed answer streaming; two calls would have doubled cost/latency.

## 4. Confidence & refusal (three layers, never guess)

1. **Pre-flight gate**: if no KB evidence (top score 0) or **coverage < 0.40** (less than 40% of the query's content words appear in the retrieved evidence), the gateway refuses **without calling any model** — metered as `route_rule=no_evidence_refusal`, zero tokens, zero cost.
2. **Model instruction**: the prompt orders the model to say it cannot help and set confidence low when the entries are irrelevant — so the streamed answer *is* the refusal in that case.
3. **Post-flight gate**: final confidence blends the retrieval signal (`(coverage+dominance)/2`) with the model's self-report (mean; ×0.8 if the model and the retrieval vote disagree on intent). Below 0.35 → `outcome=refused`, and a caveat is appended to the already-streamed answer rather than silently shipping low confidence.

Unusable model output: missing/malformed sentinel → degrade to the retrieval intent + retrieval confidence (never guess), `intent_llm` stays null in metering; empty answer → refusal.

## 5. How it was evaluated

`src/scripts/eval.ts` runs 30 held-out cases (27 in-scope, one per intent, plus 3 crafted out-of-scope where the correct behaviour is *refusing*) through the real HTTP path (auth → quota → SSE → metering), twice:

- **A — routing ON** (short-circuit at 0.75)
- **B — routing OFF** (every request synthesized by the real model)

Metrics: intent accuracy (final vs ground truth), retrieval-vote vs LLM-reported intent accuracy, answer quality via token-level ROUGE-1/ROUGE-L F1 against the ground-truth response plus an LLM judge (1–5, sample of 15), refusal accuracy on out-of-scope cases, in-scope refusal rate, client-measured TTFB/total percentiles, and metered tokens/cost. Results: `docs/eval-results.md`.

Methodological note: thresholds were calibrated on the **dev** split only; the eval set was never used for threshold selection.

## 6. Trade-offs accepted

- **SQLite, one file, no migrations.** Right size for a one-day, one-node gateway; metering volume here is trivial. Production would move metering to a time-series store and tenants to Postgres.
- **Failover only pre-first-token.** Mid-stream restarts were rejected deliberately (§2.3) — the honest error is cheaper than a corrupted answer.
- **ROUGE as the primary quality metric.** Crude on paraphrase, but deterministic, free, reproducible; the LLM judge adds the semantic view on top.
- **Token quota reserve-then-settle.** Reservations are in-memory (a crash drops them instead of leaking); settled usage is durable. A single request can overshoot the daily limit only by the difference between reserved budget and actuals, which is bounded by `max_completion_tokens`.
- **Free-tier deployment** (Render/Vercel): cold starts (~50s after idle spin-down) and ephemeral disks. The server re-seeds its KB and tenants on boot, so a fresh instance self-heals.

## 7. What was cut (deliberately, with reasons)

- **API keys stored as plain text** (seeded demo keys are public data). Production: hashed keys, rotation, per-key scopes. Called out as the biggest security cut.
- **No console user auth** — the console switches between seeded demo tenants instead of managing logins; the *gateway* auth (API keys) is what the assessment grades.
- **No per-minute rate limiting** — the daily token quota is the enforced limit; per-minute bursts are unconstrained.
- **No stemming in BM25** — Bitext questions are short and lexical; Porter stemming added complexity for marginal gain (measured: 87.7% vote accuracy on dev without it).
- **Single capability** — one assistant, one endpoint; a multi-capability registry (task → prompt → model) was out of scope for one day.
- **Unit tests cover the three riskiest pure components** (BM25, sentinel parser, quota); no HTTP-level integration test suite (the eval script effectively exercises the full path with 60 real requests).
- **No prompt-layer config comparison** in the eval — routing ON/OFF was the more interesting axis for this architecture; prompts live in one file (`assistant/prompt.ts`) if wanted.

## 8. Request-path correctness summary (what was smoke-tested)

`400` invalid input (zod) · `401` unknown key · `429` quota fail-closed (before stream, with `reset_at`) · `meta`→`delta`→`done` happy path on both backends · short-circuit path · fallback on backend error (GROQ unset) · fallback on TTFB timeout (chaos `slow`) · `error` event after mid-stream/upstream failure · no-evidence refusal · client disconnect mid-stream still meters and settles (`CLIENT_ABORT`) · usage view aggregates.
