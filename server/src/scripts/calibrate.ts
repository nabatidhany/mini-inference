/**
 * calibrate.ts — measure the retrieval signal distributions on the DEV split
 * (81 in-scope cases + out-of-scope probes) and recommend thresholds for:
 *   COVERAGE_FLOOR          — refusal gate (absolute evidence)
 *   SHORT_CIRCUIT_THRESHOLD — extractive routing (cross-intent dominance)
 *
 * The held-out EVAL split is never touched here: thresholds are selected on
 * dev data, then the eval script judges them (REPORT.md documents the numbers).
 *
 * Usage: npx tsx src/scripts/calibrate.ts
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedIfEmpty } from '../lib/seed.js';
import { retrieve } from '../assistant/retrieval.js';

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const OUT_OF_SCOPE_PROBES = [
  "What's the weather forecast for tomorrow in Jakarta?",
  'Can you recommend a good sci-fi movie to watch tonight?',
  'Who won the last World Cup final and what was the score?',
  'What is the capital city of France?',
  'Write me a poem about autumn leaves.',
  'How do I factory reset my Android phone?',
];

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i]!;
}

function stats(label: string, values: number[]): void {
  const s = [...values].sort((a, b) => a - b);
  console.log(
    `${label.padEnd(28)} n=${String(s.length).padStart(3)}  min=${pct(s, 0).toFixed(2)}  p05=${pct(s, 5).toFixed(2)}  p25=${pct(s, 25).toFixed(2)}  p50=${pct(s, 50).toFixed(2)}  p75=${pct(s, 75).toFixed(2)}  p95=${pct(s, 95).toFixed(2)}  max=${pct(s, 100).toFixed(2)}`,
  );
}

function main(): void {
  seedIfEmpty(); // ensures the KB is imported (DB_PATH configurable)

  const dev = JSON.parse(readFileSync(join(serverRoot, 'datasets', 'dev-cases.json'), 'utf-8')) as {
    message: string; expectedIntent: string;
  }[];

  const covIn: number[] = [];
  const domIn: number[] = [];
  const voteCorrect: number[] = [];
  for (const c of dev) {
    const r = retrieve(c.message);
    covIn.push(r.coverage);
    domIn.push(r.dominance);
    voteCorrect.push(r.intentVote === c.expectedIntent ? 1 : 0);
  }

  const covOut: number[] = [];
  const domOut: number[] = [];
  for (const m of OUT_OF_SCOPE_PROBES) {
    const r = retrieve(m);
    covOut.push(r.coverage);
    domOut.push(r.dominance);
  }

  console.log('=== DEV split, in-scope (81 cases) ===');
  stats('coverage', covIn);
  stats('cross-intent dominance', domIn);
  console.log(`retrieval intent vote accuracy: ${(voteCorrect.reduce((a, b) => a + b, 0) / voteCorrect.length * 100).toFixed(1)}%`);
  console.log();
  console.log('=== out-of-scope probes ===');
  stats('coverage', covOut);
  stats('cross-intent dominance', domOut);

  const covOutMax = Math.max(...covOut);
  const covInP05 = pct([...covIn].sort((a, b) => a - b), 5);
  console.log();
  console.log(`Recommended COVERAGE_FLOOR: separate in-scope p05 (${covInP05.toFixed(2)}) from out-of-scope max (${covOutMax.toFixed(2)})`);
  console.log('Short-circuit: how often would dominance >= X fire on in-scope dev cases?');
  for (const t of [0.5, 0.6, 0.7, 0.75, 0.8, 0.9]) {
    const fired = domIn.filter((d) => d >= t).length;
    console.log(`  threshold ${t.toFixed(2)}: short-circuits ${(fired / domIn.length * 100).toFixed(1)}% of in-scope dev cases`);
  }
}

main();
