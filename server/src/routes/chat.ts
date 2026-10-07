/**
 * POST /v1/chat — the product surface of the gateway.
 *
 * Request path (in order):
 *   1. zod validation           -> 400 INVALID_INPUT
 *   2. API-key auth             -> 401 INVALID_API_KEY
 *   3. retrieval (BM25)         -> meta signals: dominance, intent vote
 *   4. pre-flight refusal gate  -> no evidence? refuse WITHOUT a model call
 *   5. quota reservation        -> 429 QUOTA_EXCEEDED (fail closed, clean
 *                                  HTTP error before the stream starts)
 *   6. SSE: meta -> delta* -> done (or error)
 *      routing: short-circuit | default; fallback once pre-first-token
 *      post-flight: confidence gate -> ok | fallback | refused
 *   7. metering row + quota settlement (provider-reported tokens when available)
 */
import { randomUUID } from 'node:crypto';
import type { Response, Router } from 'express';
import express from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { requireTenant, type AuthedRequest } from '../lib/auth.js';
import { recordUsage } from '../lib/metering.js';
import { quota, QuotaExceededError } from '../lib/quota.js';
import { initSse, sendEvent, endSse } from '../lib/sse.js';
import { estimateTokens } from '../lib/tokenize.js';
import { buildMessages, estimatePromptTokens } from '../assistant/prompt.js';
import { retrieve } from '../assistant/retrieval.js';
import { SentinelFilter } from '../assistant/sentinel.js';
import { armTimeouts, classifyAbort } from '../backends/async.js';
import { getBackend, route, theOtherBackend } from '../backends/registry.js';
import type { BackendEvent, ChatBackend, ChatTask, UsageReport } from '../backends/types.js';
import type { DoneEvent, MetaEvent, RouteRule } from '../types.js';

const bodySchema = z.object({
  message: z.string().trim().min(1).max(config.maxMessageChars),
});

const REFUSAL_TEXT =
  "I don't have a confident answer for that in our support knowledge base, and I'd rather not guess. Could you rephrase your question, or contact our human support team?";

const LOW_CONFIDENCE_CAVEAT =
  "\n\n—\nI'm not fully confident this answer is grounded in our support knowledge base, so please treat it with care or contact our human support team.";

interface AttemptOutcome {
  answer: string; // raw answer (may include the unparsed sentinel tail)
  intentLLM: string | null;
  confidenceLLM: number | null;
  usage: UsageReport | null;
  ttfbMs: number;
  backendId: string;
  model: string;
  routeRule: RouteRule;
  fallbackFired: boolean;
  fallbackReason: string | null;
  failure: { code: string; message: string } | null;
  clientAbort: boolean;
}

export const chatRouter: Router = express.Router();
chatRouter.post('/v1/chat', requireTenant, (req: AuthedRequest, res: Response) => {
  void handleChat(req, res);
});

async function handleChat(req: AuthedRequest, res: Response): Promise<void> {
  const tenant = req.tenant!;
  const startedAt = Date.now();

  // 1. input validation -------------------------------------------------------
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: 'INVALID_INPUT',
        message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      },
    });
    return;
  }
  const message = parsed.data.message;
  const requestId = randomUUID();

  // 3. retrieval (local, pre-flight) ------------------------------------------
  const retrieval = retrieve(message);

  // 4. pre-flight refusal gate: weak absolute evidence -> refuse without a model
  if (retrieval.topScore === 0 || retrieval.coverage < config.coverageFloor) {
    servePreFlightRefusal(res, { requestId, tenant, retrieval, startedAt });
    return;
  }

  // 5. quota reservation (fail closed) -----------------------------------------
  const { system, user } = buildMessages(message, retrieval.entries, []);
  const promptEstimate = estimatePromptTokens(system, user);
  const estimate = promptEstimate + config.completionBudget;
  try {
    quota.reserve(tenant, estimate);
  } catch (err) {
    if (err instanceof QuotaExceededError) {
      res.status(429).json({
        error: {
          code: 'QUOTA_EXCEEDED',
          message: err.message,
          used_tokens: err.usedTokens,
          limit_tokens: err.limitTokens,
          reset_at: err.resetAt,
        },
      });
      return;
    }
    throw err;
  }

  // 6. SSE stream ---------------------------------------------------------------
  initSse(res);
  let finished = false;
  let activeCtl: AbortController | null = null;
  // Client-disconnect detection: res 'close' fires both after a normal end
  // (writableEnded === true) and on a premature disconnect — only a premature
  // one aborts the in-flight backend call. (req 'close' cannot be used: it
  // fires as soon as the request body has been consumed.)
  res.on('close', () => {
    if (!finished && !res.writableEnded) activeCtl?.abort(new Error('CLIENT_ABORT'));
  });

  const meta: MetaEvent = {
    request_id: requestId,
    tenant: tenant.name,
    intent_vote: retrieval.intentVote,
    dominance: Number(retrieval.dominance.toFixed(3)),
    coverage: Number(retrieval.coverage.toFixed(3)),
    retrieved: retrieval.entries.map((e) => ({ question: e.entry.question, intent: e.entry.intent, score: e.score })),
  };
  sendEvent(res, 'meta', meta);

  const task: ChatTask = {
    system,
    user,
    extractiveAnswer: retrieval.entries[0]?.entry.answer,
  };

  const decision = route(retrieval.coverage, retrieval.dominance);
  const first = getBackend(decision.backendId);
  if (!first) {
    sendEvent(res, 'error', { code: 'NO_BACKEND', message: `backend ${decision.backendId} not registered` });
    finished = true;
    settleAndMeter({
      requestId, tenant, retrieval, routeRule: decision.routeRule,
      backend: 'none', model: 'internal/none', outcome: 'error',
      fallbackFired: false, fallbackReason: `backend ${decision.backendId} not registered`,
      result: null, promptEstimate, estimate, startedAt, ttfbMs: 0,
      promptTokens: 0, completionTokens: 0,
    });
    endSse(res);
    return;
  }

  const result = await runWithFallback(first, decision.routeRule, task, res, startedAt, (ctl) => { activeCtl = ctl; });

  // 7. post-flight ---------------------------------------------------------------
  const answerText = result.answer.replace(/\s*<<<META[\s\S]*$/, '').trim();
  const promptTokens = result.usage?.promptTokens ?? promptEstimate;
  const completionTokens = result.usage?.completionTokens ?? estimateTokens(result.answer);

  if (result.clientAbort) {
    // client vanished: abort what we can, still meter + settle
    finished = true;
    settleAndMeter({
      requestId, tenant, retrieval, routeRule: result.routeRule,
      backend: result.backendId, model: result.model, outcome: 'error',
      fallbackFired: result.fallbackFired, fallbackReason: 'client_abort',
      result, promptEstimate, estimate, startedAt, ttfbMs: result.ttfbMs,
      promptTokens, completionTokens,
    });
    endSse(res);
    return;
  }

  if (result.failure) {
    finished = true;
    sendEvent(res, 'error', { code: result.failure.code, message: result.failure.message, request_id: requestId });
    settleAndMeter({
      requestId, tenant, retrieval, routeRule: result.routeRule,
      backend: result.backendId, model: result.model, outcome: 'error',
      fallbackFired: result.fallbackFired,
      fallbackReason: result.fallbackReason ?? result.failure.code,
      result, promptEstimate, estimate, startedAt, ttfbMs: result.ttfbMs,
      promptTokens, completionTokens,
    });
    endSse(res);
    return;
  }

  // confidence gate --------------------------------------------------------------
  let outcome: 'ok' | 'fallback' | 'refused';
  let finalIntent: string | null;
  let finalConfidence: number;

  if (result.backendId === 'groq') {
    let confidence: number;
    if (result.confidenceLLM === null) {
      // unusable sentinel -> degrade to the retrieval signal alone (never guess)
      confidence = retrieval.retrievalConfidence;
    } else {
      confidence = (retrieval.retrievalConfidence + result.confidenceLLM) / 2;
      if (result.intentLLM !== null && retrieval.intentVote !== null && result.intentLLM !== retrieval.intentVote) {
        confidence *= 0.8; // retrieval and model disagree -> cut confidence
      }
    }
    finalIntent = result.intentLLM ?? retrieval.intentVote;
    finalConfidence = Number(Math.min(1, Math.max(0, confidence)).toFixed(3));

    if (answerText.length === 0) {
      // unusable model output (empty answer) -> refuse instead of guessing
      streamText(res, REFUSAL_TEXT);
      outcome = 'refused';
      finalConfidence = 0;
    } else if (finalConfidence < config.confidenceThreshold) {
      // answer already streamed; append an honest caveat and mark refused
      sendEvent(res, 'delta', { text: LOW_CONFIDENCE_CAVEAT });
      outcome = 'refused';
    } else {
      outcome = result.fallbackFired ? 'fallback' : 'ok';
    }
  } else {
    // extractive: answer is verbatim from the KB; confidence = retrieval signal
    finalIntent = retrieval.intentVote;
    finalConfidence = Number(retrieval.retrievalConfidence.toFixed(3));
    outcome = result.fallbackFired ? 'fallback' : 'ok';
  }

  const totalMs = Date.now() - startedAt;
  const price = config.prices[result.model] ?? { input: 0, output: 0 };
  const costUsd = Math.round(((promptTokens / 1e6) * price.input + (completionTokens / 1e6) * price.output) * 1e6) / 1e6;

  finished = true;
  sendEvent(res, 'done', {
    request_id: requestId,
    backend: result.backendId,
    model: result.model,
    route_rule: result.routeRule,
    fallback_fired: result.fallbackFired,
    fallback_reason: result.fallbackReason,
    intent: finalIntent,
    confidence: finalConfidence,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    latency_ttfb_ms: result.ttfbMs,
    latency_total_ms: totalMs,
    cost_usd: costUsd,
    outcome,
  } satisfies DoneEvent);

  recordUsage({
    request_id: requestId,
    tenant_id: tenant.id,
    route_rule: result.routeRule,
    backend: result.backendId,
    model: result.model,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    latency_ttfb_ms: result.ttfbMs,
    latency_total_ms: totalMs,
    outcome,
    fallback_fired: result.fallbackFired,
    fallback_reason: result.fallbackReason,
    intent: finalIntent,
    intent_vote: retrieval.intentVote,
    intent_llm: result.intentLLM,
    confidence: finalConfidence,
    dominance: retrieval.dominance,
  });
  quota.settle(tenant, estimate, promptTokens + completionTokens);
  endSse(res);
}

// --- helpers ---------------------------------------------------------------------

function streamText(res: Response, text: string): void {
  // word-by-word so refusal messages render like streamed model output
  for (const part of text.split(/(\s+)/)) {
    if (part.length > 0) sendEvent(res, 'delta', { text: part });
  }
}

function servePreFlightRefusal(
  res: Response,
  ctx: {
    requestId: string;
    tenant: NonNullable<AuthedRequest['tenant']>;
    retrieval: ReturnType<typeof retrieve>;
    startedAt: number;
  },
): void {
  const { requestId, tenant, retrieval, startedAt } = ctx;
  initSse(res);
  sendEvent(res, 'meta', {
    request_id: requestId,
    tenant: tenant.name,
    intent_vote: retrieval.intentVote,
    dominance: Number(retrieval.dominance.toFixed(3)),
    coverage: Number(retrieval.coverage.toFixed(3)),
    retrieved: retrieval.entries.map((e) => ({ question: e.entry.question, intent: e.entry.intent, score: e.score })),
  });
  streamText(res, REFUSAL_TEXT);
  const totalMs = Date.now() - startedAt;
  sendEvent(res, 'done', {
    request_id: requestId,
    backend: 'none',
    model: 'internal/none',
    route_rule: 'no_evidence_refusal',
    fallback_fired: false,
    fallback_reason: `no retrieval evidence (top score ${retrieval.topScore.toFixed(2)}, coverage ${retrieval.coverage.toFixed(2)})`,
    intent: null,
    confidence: Number(retrieval.retrievalConfidence.toFixed(3)),
    prompt_tokens: 0,
    completion_tokens: 0,
    latency_ttfb_ms: 0,
    latency_total_ms: totalMs,
    cost_usd: 0,
    outcome: 'refused',
  } satisfies DoneEvent);
  recordUsage({
    request_id: requestId,
    tenant_id: tenant.id,
    route_rule: 'no_evidence_refusal',
    backend: 'none',
    model: 'internal/none',
    prompt_tokens: 0,
    completion_tokens: 0,
    latency_ttfb_ms: 0,
    latency_total_ms: totalMs,
    outcome: 'refused',
    fallback_fired: false,
    fallback_reason: 'no retrieval evidence',
    intent: null,
    intent_vote: retrieval.intentVote,
    intent_llm: null,
    confidence: retrieval.retrievalConfidence,
    dominance: retrieval.dominance,
  });
  endSse(res);
}

interface SettleAndMeterCtx {
  requestId: string;
  tenant: NonNullable<AuthedRequest['tenant']>;
  retrieval: ReturnType<typeof retrieve>;
  routeRule: RouteRule;
  backend: string;
  model: string;
  outcome: 'error';
  fallbackFired: boolean;
  fallbackReason: string | null;
  result: AttemptOutcome | null;
  promptEstimate: number;
  estimate: number;
  startedAt: number;
  ttfbMs: number;
  promptTokens: number;
  completionTokens: number;
}

function settleAndMeter(ctx: SettleAndMeterCtx): void {
  recordUsage({
    request_id: ctx.requestId,
    tenant_id: ctx.tenant.id,
    route_rule: ctx.routeRule,
    backend: ctx.backend,
    model: ctx.model,
    prompt_tokens: ctx.promptTokens,
    completion_tokens: ctx.completionTokens,
    latency_ttfb_ms: ctx.ttfbMs,
    latency_total_ms: Date.now() - ctx.startedAt,
    outcome: ctx.outcome,
    fallback_fired: ctx.fallbackFired,
    fallback_reason: ctx.fallbackReason,
    intent: null,
    intent_vote: ctx.retrieval.intentVote,
    intent_llm: ctx.result?.intentLLM ?? null,
    confidence: null,
    dominance: ctx.retrieval.dominance,
  });
  quota.settle(ctx.tenant, ctx.estimate, ctx.promptTokens + ctx.completionTokens);
}

/**
 * Run the chosen backend; on a pre-first-token failure (error or TTFB
 * timeout) fall back ONCE to the other backend. Mid-stream failures cannot
 * be retried (the client already saw part of the answer) -> hard error.
 */
async function runWithFallback(
  first: ChatBackend,
  baseRule: 'short_circuit' | 'default',
  task: ChatTask,
  res: Response,
  requestStart: number,
  setActiveCtl: (ctl: AbortController) => void,
): Promise<AttemptOutcome> {
  let chosen: ChatBackend = first;
  let routeRule: RouteRule = baseRule;
  let fallbackFired = false;
  let fallbackReason: string | null = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const ctl = new AbortController();
    setActiveCtl(ctl);
    const timers = armTimeouts(ctl, { ttfbMs: config.ttfbTimeoutMs, totalMs: config.totalTimeoutMs });
    const filter = chosen.id === 'groq' ? new SentinelFilter() : null;
    let answer = '';
    let usage: UsageReport | null = null;
    let firstDeltaAt: number | null = null;
    let intentLLM: string | null = null;
    let confidenceLLM: number | null = null;

    try {
      for await (const ev of chosen.streamChat(task, ctl.signal) as AsyncGenerator<BackendEvent>) {
        if (ev.type === 'delta') {
          timers.onDelta();
          if (firstDeltaAt === null) firstDeltaAt = Date.now();
          answer += ev.text;
          const out = filter ? filter.push(ev.text) : ev.text;
          if (out.length > 0) sendEvent(res, 'delta', { text: out });
        } else {
          usage = ev;
        }
      }
      timers.clear();

      // flush held-back tail + parse the sentinel (groq only)
      if (filter) {
        const { tail, meta } = filter.finish();
        if (tail.length > 0) sendEvent(res, 'delta', { text: tail });
        intentLLM = meta?.intent ?? null;
        confidenceLLM = meta?.confidence ?? null;
      }

      return {
        answer,
        intentLLM,
        confidenceLLM,
        usage,
        ttfbMs: firstDeltaAt !== null ? firstDeltaAt - requestStart : 0,
        backendId: chosen.id,
        model: chosen.model,
        routeRule,
        fallbackFired,
        fallbackReason,
        failure: null,
        clientAbort: false,
      };
    } catch (err) {
      timers.clear();
      const kind = classifyAbort(ctl);
      const msg = err instanceof Error ? err.message : String(err);

      if (kind === 'CLIENT_ABORT') {
        return {
          answer, intentLLM, confidenceLLM, usage,
          ttfbMs: firstDeltaAt !== null ? firstDeltaAt - requestStart : 0,
          backendId: chosen.id, model: chosen.model, routeRule,
          fallbackFired, fallbackReason, failure: null, clientAbort: true,
        };
      }

      if (firstDeltaAt !== null) {
        // mid-stream failure: deltas already reached the client, no clean retry
        return {
          answer, intentLLM, confidenceLLM, usage,
          ttfbMs: firstDeltaAt - requestStart,
          backendId: chosen.id, model: chosen.model, routeRule,
          fallbackFired, fallbackReason,
          failure: { code: 'MID_STREAM_FAILURE', message: `backend ${chosen.id} failed mid-stream: ${msg.slice(0, 200)}` },
          clientAbort: false,
        };
      }

      // pre-first-token failure -> fallback candidate
      if (attempt === 1) {
        const other = theOtherBackend(chosen.id);
        if (other) {
          fallbackFired = true;
          fallbackReason = kind === 'TTFB_TIMEOUT'
            ? `ttfb timeout (${config.ttfbTimeoutMs}ms) on ${chosen.id}; fell back to ${other.id}`
            : `error on ${chosen.id}: ${msg.slice(0, 200)}; fell back to ${other.id}`;
          routeRule = kind === 'TTFB_TIMEOUT' ? 'fallback_timeout' : 'fallback_error';
          chosen = other;
          continue;
        }
      }

      return {
        answer, intentLLM, confidenceLLM, usage,
        ttfbMs: 0,
        backendId: chosen.id, model: chosen.model, routeRule,
        fallbackFired, fallbackReason,
        failure: { code: 'UPSTREAM_FAILED', message: `backend ${chosen.id} failed with no usable fallback: ${msg.slice(0, 300)}` },
        clientAbort: false,
      };
    }
  }

  throw new Error('UNREACHABLE'); // the loop always returns
}
