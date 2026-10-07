/**
 * Central configuration. Everything tunable lives here so the technical report
 * can point at one place. Thresholds are also runtime-adjustable via
 * POST /admin/router (used by the eval script to compare configurations).
 */
import 'node:process';

function num(name: string, def: number): number {
  const v = process.env[name];
  return v !== undefined && !Number.isNaN(Number(v)) ? Number(v) : def;
}

export const config = {
  port: num('PORT', 8080),
  dbPath: process.env.DB_PATH ?? 'data/app.db',

  // --- provider -------------------------------------------------------------
  groqApiKey: process.env.GROQ_API_KEY ?? '',
  groqBaseUrl: process.env.GROQ_BASE_URL ?? 'https://api.groq.com/openai/v1',
  groqModel: process.env.GROQ_MODEL ?? 'openai/gpt-oss-20b',

  // --- secrets --------------------------------------------------------------
  adminKey: process.env.ADMIN_KEY ?? 'dev-admin-key',

  // --- CORS -----------------------------------------------------------------
  corsOrigin: process.env.CORS_ORIGIN ?? '*',

  // --- timeouts ------------------------------------------------------------
  // TTFB timeout guards "backend too slow to start answering" -> fallback.
  ttfbTimeoutMs: num('TTFB_TIMEOUT_MS', 12_000),
  // Total timeout guards a stalled stream mid-answer (no fallback possible
  // after the first token has been forwarded to the client).
  totalTimeoutMs: num('TOTAL_TIMEOUT_MS', 30_000),

  // --- routing / assistant thresholds (defaults; runtime-tunable) ----------
  // Signals (see assistant/retrieval.ts):
  //   coverage  — fraction of query content words in the top-1 KB entry
  //   dominance — top1 vs best different-intent competitor in top-k
  // Routing: coverage >= coverageFloor AND dominance >= shortCircuitThreshold
  //          -> answer verbatim from KB (cheap extractive backend).
  // Refusal gate: coverage < coverageFloor -> refuse without any model call.
  // Blended confidence below confidenceThreshold -> outcome=refused.
  // Calibrated on the dev split (src/scripts/calibrate.ts): out-of-scope
  // coverage max 0.33 vs in-scope p25 0.50 -> floor 0.40; dominance >= 0.75
  // means the winner scores 3x its best cross-intent competitor.
  shortCircuitThreshold: num('SHORT_CIRCUIT_THRESHOLD', 0.75),
  coverageFloor: num('COVERAGE_FLOOR', 0.4),
  confidenceThreshold: num('CONFIDENCE_THRESHOLD', 0.35),

  retrievalTopK: num('RETRIEVAL_TOP_K', 5),
  // Reserve-then-settle: completion budget reserved per request for the
  // pre-flight quota check (max_tokens sent to the provider).
  completionBudget: num('COMPLETION_BUDGET', 400),
  maxMessageChars: num('MAX_MESSAGE_CHARS', 2000),

  // --- price table (USD per 1M tokens) — used for metered estimated cost ---
  // Groq list prices for openai/gpt-oss-20b (checked Oct 2026; env-tunable
  // via GROQ_MODEL — update this table when the model changes).
  prices: {
    'groq/openai/gpt-oss-20b': { input: 0.075, output: 0.3 },
    // Extractive backend: no model call, only local retrieval.
    'internal/extractive': { input: 0, output: 0 },
  } as Record<string, { input: number; output: number }>,
};

export type AppConfig = typeof config;
