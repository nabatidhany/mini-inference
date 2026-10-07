/**
 * eval.ts — evaluation harness (PDF: "around 30 held-out cases ... run it
 * against two configurations, for example two prompts or two models").
 *
 * Runs the 30-case held-out set through the gateway via HTTP (the same
 * request path the console uses) under two router configurations:
 *
 *   A: routing ON  (short-circuit threshold 0.75 — extractive serves clear matches)
 *   B: routing OFF  (threshold null — the real model synthesizes everything)
 *
 * Reports per configuration: intent accuracy (final vs expected), the
 * retrieval-vote vs LLM-reported intent accuracy (both recorded in metering),
 * answer quality via ROUGE-1/ROUGE-L F1 against the ground-truth response
 * (plus an optional LLM judge with --judge), refusal accuracy on out-of-scope
 * cases, in-scope refusal rate, client-measured latency percentiles, and
 * metered tokens/cost. Writes docs/eval-results.md.
 *
 * Usage:
 *   npx tsx src/scripts/eval.ts [--api-base http://localhost:8080]
 *     [--api-key sk-demo-eval-0004] [--admin-key ...] [--judge]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

interface EvalCase {
  id: number;
  outOfScope: boolean;
  message: string;
  expectedIntent: string | null;
  expectedAnswer: string | null;
}

interface CaseResult {
  id: number;
  message: string;
  outOfScope: boolean;
  expectedIntent: string | null;
  expectedAnswer: string | null;
  outcome: string;
  backend: string;
  routeRule: string;
  intent: string | null;
  intentVote: string | null;
  intentLLM: string | null;
  confidence: number | null;
  ttfbMs: number;
  totalMs: number;
  costUsd: number;
  promptTokens: number;
  completionTokens: number;
  answer: string;
}

// --- CLI flags -----------------------------------------------------------------
const args = process.argv.slice(2);
function flag(name: string, def: string): string {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : def;
}
const has = (name: string): boolean => args.includes(`--${name}`);
const API_BASE = flag('api-base', 'http://localhost:8080');
const API_KEY = flag('api-key', 'sk-demo-eval-0004');
const ADMIN_KEY = flag('admin-key', config.adminKey);
const TENANT = flag('tenant', 'eval');
const USE_JUDGE = has('judge');
const OUT_PATH = join(serverRoot, '..', 'docs', 'eval-results.md');

// --- HTTP helpers (incl. a tiny SSE reader — same as the console client) ------
async function admin(path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`admin ${path} -> HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

interface StreamedRequest {
  answer: string;
  done?: Record<string, unknown>;
  error?: Record<string, unknown>;
}

async function chatOnce(message: string): Promise<StreamedRequest> {
  const res = await fetch(`${API_BASE}/v1/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) {
    return { answer: '', error: { code: `HTTP_${res.status}`, message: await res.text() } };
  }
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let answer = '';
  let done: Record<string, unknown> | undefined;
  let error: Record<string, unknown> | undefined;
  for (;;) {
    const { done: rdDone, value } = await reader.read();
    if (rdDone) break;
    buf += decoder.decode(value, { stream: true });
    let sep = buf.indexOf('\n\n');
    while (sep >= 0) {
      const raw = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      sep = buf.indexOf('\n\n');
      let event = '';
      let data = '';
      for (const line of raw.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7).trim();
        else if (line.startsWith('data: ')) data = line.slice(6);
      }
      if (!data) continue;
      const payload = JSON.parse(data) as Record<string, unknown>;
      if (event === 'delta') answer += String((payload as { text?: string }).text ?? '');
      else if (event === 'done') done = payload;
      else if (event === 'error') error = payload;
    }
  }
  return { answer, done, error };
}

async function usageRow(requestId: string): Promise<Record<string, unknown> | null> {
  const j = (await admin(`/admin/usage?request_id=${encodeURIComponent(requestId)}`)) as { request?: Record<string, unknown> };
  return j.request ?? null;
}

// --- ROUGE (token-level F1) ----------------------------------------------------
function normTokens(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
}

function rouge1F1(cand: string, ref: string): number {
  const c = normTokens(cand);
  const r = normTokens(ref);
  if (c.length === 0 || r.length === 0) return 0;
  const rCounts = new Map<string, number>();
  for (const t of r) rCounts.set(t, (rCounts.get(t) ?? 0) + 1);
  let overlap = 0;
  const cCounts = new Map<string, number>();
  for (const t of c) cCounts.set(t, (cCounts.get(t) ?? 0) + 1);
  for (const [t, n] of cCounts) overlap += Math.min(n, rCounts.get(t) ?? 0);
  const p = overlap / c.length;
  const rc = overlap / r.length;
  return p + rc === 0 ? 0 : (2 * p * rc) / (p + rc);
}

function rougeLF1(cand: string, ref: string): number {
  const c = normTokens(cand);
  const r = normTokens(ref);
  if (c.length === 0 || r.length === 0) return 0;
  // LCS dynamic programming
  const dp: number[][] = Array.from({ length: c.length + 1 }, () => new Array<number>(r.length + 1).fill(0));
  for (let i = c.length - 1; i >= 0; i--) {
    for (let j = r.length - 1; j >= 0; j--) {
      dp[i]![j] = c[i] === r[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const lcs = dp[0]![0]!;
  const p = lcs / c.length;
  const rc = lcs / r.length;
  return p + rc === 0 ? 0 : (2 * p * rc) / (p + rc);
}

// --- LLM judge (optional) -------------------------------------------------------
async function judge(cand: string, ref: string, question: string): Promise<number> {
  const res = await fetch(`${config.groqBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.groqApiKey}` },
    body: JSON.stringify({
      model: config.groqModel,
      messages: [
        {
          role: 'system',
          content: 'You rate customer-support answers. Compare the candidate answer to the reference answer for the given customer question. Respond with ONLY a single integer from 1 (wrong/unhelpful) to 5 (excellent).',
        },
        { role: 'user', content: `Customer question: ${question}\n\nReference answer: ${ref}\n\nCandidate answer: ${cand}` },
      ],
      temperature: 0,
      max_completion_tokens: 8,
      ...(config.groqModel.includes('gpt-oss') ? { reasoning_effort: 'low' } : {}),
    }),
  });
  if (!res.ok) return Number.NaN;
  const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const m = /\d/.exec(j.choices?.[0]?.message?.content ?? '');
  return m ? Math.min(5, Math.max(1, Number(m[0]))) : Number.NaN;
}

// --- metrics --------------------------------------------------------------------
function pctile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i]!;
}
const round = (n: number, d = 2): number => Math.round(n * 10 ** d) / 10 ** d;
const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

interface ConfigReport {
  label: string;
  results: CaseResult[];
  intentAccuracy: number;
  voteAccuracy: number;
  llmAccuracy: number;
  rouge1: number;
  rougeL: number;
  judgeAvg: number | null;
  refusalAccuracy: number;
  inScopeRefusalRate: number;
  ttfbP50: number;
  ttfbP95: number;
  totalP50: number;
  totalP95: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  routeCounts: Record<string, number>;
  outcomeCounts: Record<string, number>;
}

async function runConfig(label: string, cases: EvalCase[], threshold: number | null): Promise<ConfigReport> {
  await admin('/admin/router', { shortCircuitThreshold: threshold });
  const results: CaseResult[] = [];
  for (const c of cases) {
    const r = await chatOnce(c.message);
    const done = (r.done ?? {}) as Record<string, unknown>;
    const row = done['request_id'] ? await usageRow(String(done['request_id'])) : null;
    results.push({
      id: c.id,
      message: c.message,
      outOfScope: c.outOfScope,
      expectedIntent: c.expectedIntent,
      expectedAnswer: c.expectedAnswer,
      outcome: String(done['outcome'] ?? r.error?.['code'] ?? 'error'),
      backend: String(done['backend'] ?? 'unknown'),
      routeRule: String(row?.['route_rule'] ?? done['route_rule'] ?? 'unknown'),
      intent: (done['intent'] as string | null) ?? null,
      intentVote: (row?.['intent_vote'] as string | null) ?? null,
      intentLLM: (row?.['intent_llm'] as string | null) ?? null,
      confidence: (done['confidence'] as number | null) ?? null,
      ttfbMs: Number(done['latency_ttfb_ms'] ?? 0),
      totalMs: Number(done['latency_total_ms'] ?? 0),
      costUsd: Number(done['cost_usd'] ?? 0),
      promptTokens: Number(done['prompt_tokens'] ?? 0),
      completionTokens: Number(done['completion_tokens'] ?? 0),
      answer: r.answer,
    });
    await new Promise((resolve) => setTimeout(resolve, 150)); // be gentle
  }

  const inScope = results.filter((r) => !r.outOfScope);
  const outScope = results.filter((r) => r.outOfScope);

  const answered = inScope.filter((r) => r.outcome === 'ok' || r.outcome === 'fallback');
  const intentAcc = inScope.filter((r) => r.intent === r.expectedIntent).length / Math.max(1, inScope.length);
  const withBoth = inScope.filter((r) => r.intentVote && r.intentLLM);
  const voteAcc = withBoth.filter((r) => r.intentVote === r.expectedIntent).length / Math.max(1, withBoth.length);
  const llmAcc = withBoth.filter((r) => r.intentLLM === r.expectedIntent).length / Math.max(1, withBoth.length);
  const rouges = answered
    .map((r) => ({ r1: rouge1F1(r.answer, r.expectedAnswer ?? ''), rl: rougeLF1(r.answer, r.expectedAnswer ?? '') }));
  const refusalAcc = outScope.filter((r) => r.outcome === 'refused').length / Math.max(1, outScope.length);
  const inScopeRefusalRate = inScope.filter((r) => r.outcome === 'refused').length / Math.max(1, inScope.length);

  let judgeAvg: number | null = null;
  if (USE_JUDGE) {
    const scores: number[] = [];
    for (const r of answered.slice(0, 15)) { // judge a sample of 15 to stay light
      const s = await judge(r.answer, r.expectedAnswer ?? '', r.message);
      if (!Number.isNaN(s)) scores.push(s);
    }
    judgeAvg = scores.length > 0 ? mean(scores) : null;
  }

  const ttfb = results.map((r) => r.ttfbMs).sort((a, b) => a - b);
  const total = results.map((r) => r.totalMs).sort((a, b) => a - b);
  const routeCounts: Record<string, number> = {};
  const outcomeCounts: Record<string, number> = {};
  for (const r of results) {
    routeCounts[r.routeRule] = (routeCounts[r.routeRule] ?? 0) + 1;
    outcomeCounts[r.outcome] = (outcomeCounts[r.outcome] ?? 0) + 1;
  }

  return {
    label,
    results,
    intentAccuracy: intentAcc,
    voteAccuracy: voteAcc,
    llmAccuracy: llmAcc,
    rouge1: rouges.length > 0 ? mean(rouges.map((x) => x.r1)) : 0,
    rougeL: rouges.length > 0 ? mean(rouges.map((x) => x.rl)) : 0,
    judgeAvg,
    refusalAccuracy: refusalAcc,
    inScopeRefusalRate,
    ttfbP50: pctile(ttfb, 50),
    ttfbP95: pctile(ttfb, 95),
    totalP50: pctile(total, 50),
    totalP95: pctile(total, 95),
    tokensIn: results.reduce((a, r) => a + r.promptTokens, 0),
    tokensOut: results.reduce((a, r) => a + r.completionTokens, 0),
    costUsd: results.reduce((a, r) => a + r.costUsd, 0),
    routeCounts,
    outcomeCounts,
  };
}

function mdTable(a: ConfigReport, b: ConfigReport): string {
  const rows: [string, string, string][] = [
    ['intent accuracy (27 in-scope)', `${round(a.intentAccuracy * 100, 1)}%`, `${round(b.intentAccuracy * 100, 1)}%`],
    ['retrieval-vote intent accuracy (groq cases)', `${round(a.voteAccuracy * 100, 1)}%`, `${round(b.voteAccuracy * 100, 1)}%`],
    ['LLM-reported intent accuracy (groq cases)', `${round(a.llmAccuracy * 100, 1)}%`, `${round(b.llmAccuracy * 100, 1)}%`],
    ['answer ROUGE-1 F1', round(a.rouge1, 3).toFixed(3), round(b.rouge1, 3).toFixed(3)],
    ['answer ROUGE-L F1', round(a.rougeL, 3).toFixed(3), round(b.rougeL, 3).toFixed(3)],
    ['refusal accuracy (3 out-of-scope)', `${round(a.refusalAccuracy * 100, 0)}%`, `${round(b.refusalAccuracy * 100, 0)}%`],
    ['in-scope refusal rate', `${round(a.inScopeRefusalRate * 100, 1)}%`, `${round(b.inScopeRefusalRate * 100, 1)}%`],
    ['TTFB p50 / p95 (ms)', `${a.ttfbP50} / ${a.ttfbP95}`, `${b.ttfbP50} / ${b.ttfbP95}`],
    ['total latency p50 / p95 (ms)', `${a.totalP50} / ${a.totalP95}`, `${b.totalP50} / ${b.totalP95}`],
    ['tokens in / out (metered)', `${a.tokensIn} / ${a.tokensOut}`, `${b.tokensIn} / ${b.tokensOut}`],
    ['metered cost (USD)', `$${round(a.costUsd, 6)}`, `$${round(b.costUsd, 6)}`],
  ];
  if (a.judgeAvg !== null && b.judgeAvg !== null) {
    rows.push(['LLM judge (1-5, sample of 15)', round(a.judgeAvg, 2).toFixed(2), round(b.judgeAvg, 2).toFixed(2)]);
  }
  const routeRow = (r: ConfigReport): string =>
    Object.entries(r.routeCounts).map(([k, v]) => `${k}:${v}`).join(', ') || '—';
  rows.push(['route rules', routeRow(a), routeRow(b)]);
  rows.push(['outcomes', Object.entries(a.outcomeCounts).map(([k, v]) => `${k}:${v}`).join(', '), Object.entries(b.outcomeCounts).map(([k, v]) => `${k}:${v}`).join(', ')]);

  const head = `| metric | A: ${a.label} | B: ${b.label} |`;
  const sep = '|---|---|---|';
  const body = rows.map(([m, x, y]) => `| ${m} | ${x} | ${y} |`).join('\n');
  return [head, sep, body].join('\n');
}

async function main(): Promise<void> {
  const cases = JSON.parse(readFileSync(join(serverRoot, 'datasets', 'eval-cases.json'), 'utf-8')) as EvalCase[];
  console.log(`Eval: ${cases.length} cases (${cases.filter((c) => !c.outOfScope).length} in-scope, ${cases.filter((c) => c.outOfScope).length} out-of-scope) against ${API_BASE}`);
  console.log(`Judge: ${USE_JUDGE ? 'enabled (ROUGE + LLM judge)' : 'disabled (ROUGE only)'}\n`);

  await admin('/admin/quota-reset', { tenant: TENANT });

  const a = await runConfig('routing ON (short-circuit 0.75)', cases, 0.75);
  console.log(`Config A done: ${Object.entries(a.outcomeCounts).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  await admin('/admin/quota-reset', { tenant: TENANT });
  const b = await runConfig('routing OFF (always real model)', cases, null);
  console.log(`Config B done: ${Object.entries(b.outcomeCounts).map(([k, v]) => `${k}=${v}`).join(' ')}\n`);

  await admin('/admin/router', { shortCircuitThreshold: 0.75 }); // restore default

  const table = mdTable(a, b);
  console.log(table);

  const md = [
    '# Evaluation results',
    '',
    `Held-out set: 30 cases (27 in-scope, 1 per intent, + 3 crafted out-of-scope) from the Bitext customer-support dataset — never used for threshold calibration (that used the dev split, see src/scripts/calibrate.ts).`,
    '',
    `Two configurations:`,
    `- **A — routing ON**: retrieval dominance >= 0.75 short-circuits to the extractive backend (verbatim KB answer, zero cost).`,
    `- **B — routing OFF**: every request is synthesized by the real model (\`${config.groqModel}\`).`,
    '',
    'Answer quality method: token-level ROUGE-1 / ROUGE-L F1 against the ground-truth response' + (USE_JUDGE ? ' plus an LLM judge (1-5, sample of 15 answered cases) — the judge calls the provider directly, outside the metered gateway path.' : ' (run with --judge to add the LLM judge).'),
    '',
    table,
    '',
    '## Notes',
    '',
    `- Latency percentiles are client-measured (the eval script is the client).`,
    `- Tokens/cost come from the gateway metering (provider-reported on the groq path, chars/4 estimated on the extractive path).`,
    `- Out-of-scope refusal accuracy: correct behaviour is refusing (coverage gate), not guessing.`,
    '',
    '## Raw results per case',
    '',
    ...['A', 'B'].map((cfg) => {
      const r = cfg === 'A' ? a : b;
      return [
        `### Config ${cfg} — ${r.label}`,
        '',
        '| # | expected | outcome | backend | intent | conf | R1 | ttfb | total |',
        '|---|---|---|---|---|---|---|---|---|',
        ...r.results.map((x) =>
          `| ${x.outOfScope ? 'oos' : x.id} | ${x.outOfScope ? '(refuse)' : x.expectedIntent} | ${x.outcome} | ${x.backend} | ${x.intent ?? '—'} | ${x.confidence ?? '—'} | ${x.outOfScope ? '—' : round(rouge1F1(x.answer, x.expectedAnswer ?? ''), 2)} | ${x.ttfbMs} | ${x.totalMs} |`,
        ),
        '',
      ].join('\n');
    }),
  ].join('\n');

  writeFileSync(OUT_PATH, md);
  console.log(`\nWrote ${OUT_PATH}`);
}

main().catch((err) => {
  console.error('eval failed:', err);
  process.exitCode = 1;
});
