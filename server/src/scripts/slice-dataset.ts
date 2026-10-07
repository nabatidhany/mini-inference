/**
 * slice-dataset.ts — Phase 0 dataset preparation.
 *
 * Reads the full Bitext customer-support CSV (data-raw/bitext-full.csv, 26,872
 * rows across 27 intents) and produces two committed, reproducible slices:
 *
 *   datasets/kb-slice.json    ~18 entries per intent  -> the knowledge base
 *   datasets/eval-cases.json 1 in-scope case per intent (27) + 3 crafted
 *                             out-of-scope cases -> held-out evaluation set
 *
 * The shuffle is seeded, so re-running this script yields identical slices.
 * Eval cases are drawn AFTER the KB slice from the same shuffled pool, so the
 * two sets are disjoint by construction (held-out = never in the KB).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = join(here, '..', '..');
const RAW_CSV = join(serverRoot, 'data-raw', 'bitext-full.csv');
const KB_OUT = join(serverRoot, 'datasets', 'kb-slice.json');
const EVAL_OUT = join(serverRoot, 'datasets', 'eval-cases.json');
const DEV_OUT = join(serverRoot, 'datasets', 'dev-cases.json');

const KB_PER_INTENT = 18; // 18 x 27 = 486 entries
const DEV_PER_INTENT = 3; // 3 x 27 = 81 threshold-calibration cases (eval set stays untouched)
const SEED = 20261006;

// --- tiny deterministic PRNG (mulberry32) so slices are reproducible ---------
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(arr: T[], rand: () => number): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

// --- minimal RFC-4180 CSV parser (quoted fields, "" escapes) ------------------
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else if (c !== '\r') {
      field += c;
    }
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);

  const header = rows.shift()!;
  return rows.map((r) => {
    const obj: Record<string, string> = {};
    header.forEach((h, i) => { obj[h] = r[i] ?? ''; });
    return obj;
  });
}

interface Row {
  question: string; // "instruction"
  answer: string;   // "response"
  category: string;
  intent: string;
  flags: string;
}

// 3 crafted messages that are clearly outside the customer-support domain.
// Correct behaviour is a refusal, not a guess — measured as refusal accuracy.
const OUT_OF_SCOPE_CASES = [
  "What's the weather forecast for tomorrow in Jakarta?",
  'Can you recommend a good sci-fi movie to watch tonight?',
  'Who won the last World Cup final and what was the score?',
] as const;

function main() {
  const csv = readFileSync(RAW_CSV, 'utf-8');
  const rows: Row[] = parseCsv(csv).map((r) => ({
    question: r['instruction'] ?? '',
    answer: r['response'] ?? '',
    category: r['category'] ?? '',
    intent: r['intent'] ?? '',
    flags: r['flags'] ?? '',
  }));

  const byIntent = new Map<string, Row[]>();
  for (const row of rows) {
    const list = byIntent.get(row.intent) ?? [];
    list.push(row);
    byIntent.set(row.intent, list);
  }
  const intents = [...byIntent.keys()].sort();
  console.log(`Total rows: ${rows.length}, intents: ${intents.length}`);

  const rand = mulberry32(SEED);
  const kb: Row[] = [];
  const evalInScope: { message: string; expectedIntent: string; expectedAnswer: string }[] = [];
  const devInScope: { message: string; expectedIntent: string; expectedAnswer: string }[] = [];

  for (const intent of intents) {
    const pool = shuffled(byIntent.get(intent) ?? [], rand)
      .filter((r) => r.question.length > 0 && r.answer.length > 0);
    const kbRows = pool.slice(0, KB_PER_INTENT);
    const evalRow = pool[KB_PER_INTENT]; // next one => guaranteed held-out
    const devRows = pool.slice(KB_PER_INTENT + 1, KB_PER_INTENT + 1 + DEV_PER_INTENT);
    kb.push(...kbRows);
    if (evalRow) {
      evalInScope.push({
        message: evalRow.question,
        expectedIntent: intent,
        expectedAnswer: evalRow.answer,
      });
    }
    for (const r of devRows) {
      devInScope.push({ message: r.question, expectedIntent: intent, expectedAnswer: r.answer });
    }
  }

  const evalCases = [
    ...evalInScope.map((c, i) => ({ id: i + 1, outOfScope: false, ...c })),
    ...OUT_OF_SCOPE_CASES.map((message, i) => ({
      id: evalInScope.length + i + 1,
      outOfScope: true,
      message,
      expectedIntent: null,
      expectedAnswer: null,
    })),
  ];

  writeFileSync(KB_OUT, JSON.stringify(kb, null, 1));
  writeFileSync(EVAL_OUT, JSON.stringify(evalCases, null, 1));
  writeFileSync(DEV_OUT, JSON.stringify(devInScope, null, 1));

  console.log(`Total rows: ${rows.length}, intents: ${intents.length}`);
  console.log(`KB slice: ${kb.length} entries (${KB_PER_INTENT}/intent)`);
  console.log(`Eval cases: ${evalCases.length} (${evalInScope.length} in-scope + ${OUT_OF_SCOPE_CASES.length} out-of-scope)`);
  console.log(`Dev cases: ${devInScope.length} (threshold calibration; disjoint from KB and eval)`);
  console.log('Wrote:', KB_OUT, EVAL_OUT, DEV_OUT);
}

main();
