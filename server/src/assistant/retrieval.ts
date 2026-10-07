/**
 * Retrieval over the KB slice: BM25 top-k plus three derived, pre-flight
 * (no model call) signals — each with a distinct job:
 *
 *   coverage       fraction of the query's content words found in the top-1
 *                  entry — ABSOLUTE evidence strength; powers the refusal
 *                  gate (weak evidence -> refuse instead of guessing)
 *   dominance      top1 / (top1 + best score of a top-k entry from a
 *                  DIFFERENT intent) — how clearly the winner owns the query
 *                  against competing answers; powers short-circuit routing
 *                  (same-intent runner-ups are template variants, not risks)
 *   intentVote     score-weighted majority intent across top-k
 *
 * Signals were calibrated on the dev split (see src/scripts/calibrate.ts);
 * the held-out eval split was never used for threshold selection.
 */
import { BM25Index, tokenize, type Bm25Scored } from './bm25.js';
import { db } from '../lib/db.js';
import { config } from '../config.js';
import type { KbEntry, RetrievalResult, RetrievedEntry } from '../types.js';

let index: BM25Index | null = null;
let entriesById: Map<number, KbEntry> | null = null;

function ensureIndex(): void {
  if (index && entriesById) return;
  const rows = db.prepare('SELECT id, question, answer, intent, category FROM kb_entries').all() as KbEntry[];
  entriesById = new Map(rows.map((r) => [r.id, r]));
  index = new BM25Index(rows.map((r) => ({ id: r.id, text: `${r.question} ${r.intent.replace(/_/g, ' ')}` })));
}

export function retrieve(message: string): RetrievalResult {
  ensureIndex();
  const scored: Bm25Scored[] = index!.search(message).slice(0, config.retrievalTopK);
  const entries: RetrievedEntry[] = [];
  for (const s of scored) {
    const entry = entriesById!.get(s.id)!;
    if (entry) entries.push({ entry, score: Math.round(s.score * 1000) / 1000 });
  }

  const top = entries[0];
  const topScore = top?.score ?? 0;

  // absolute evidence: best fraction of the query's content words matched by
  // ANY top-k entry (the LLM prompt carries all top-k, so evidence anywhere
  // in the set counts; the refusal gate asks "does the KB hold evidence?")
  const queryTerms = tokenize(message);
  let coverage = 0;
  if (entries.length > 0 && queryTerms.length > 0) {
    let bestCov = 0;
    for (const e of entries) {
      const docTerms = new Set(tokenize(`${e.entry.question} ${e.entry.intent.replace(/_/g, ' ')}`));
      const hits = queryTerms.filter((t) => docTerms.has(t)).length;
      bestCov = Math.max(bestCov, hits / queryTerms.length);
    }
    coverage = bestCov;
  }

  // relative signal: winner vs the best DIFFERENT-intent competitor in top-k
  let dominance = 0;
  if (top) {
    let cross = 0;
    for (const e of entries) {
      if (e.entry.intent !== top.entry.intent && e.score > cross) cross = e.score;
    }
    dominance = cross > 0 ? top.score / (top.score + cross) : 1;
  }

  // score-weighted intent vote across top-k
  const voteWeights = new Map<string, number>();
  for (const e of entries) {
    voteWeights.set(e.entry.intent, (voteWeights.get(e.entry.intent) ?? 0) + e.score);
  }
  let intentVote: string | null = null;
  let best = 0;
  for (const [intent, w] of voteWeights) {
    if (w > best) { best = w; intentVote = intent; }
  }

  const retrievalConfidence = entries.length > 0 ? (coverage + dominance) / 2 : 0;

  return {
    entries,
    topScore,
    coverage,
    dominance,
    intentVote,
    retrievalConfidence,
  };
}
