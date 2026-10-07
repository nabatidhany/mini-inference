/** Shared domain types. */

export interface Tenant {
  id: number;
  name: string;
  apiKey: string;
  tokenQuotaPerDay: number;
}

export interface KbEntry {
  id: number;
  question: string;
  answer: string;
  intent: string;
  category: string;
}

export interface RetrievedEntry {
  entry: KbEntry;
  score: number;
}

export interface RetrievalResult {
  entries: RetrievedEntry[]; // top-k, descending score
  topScore: number;
  /** fraction of the query's content words present in the top-1 entry */
  coverage: number;
  /** top1 / (top1 + best different-intent score in top-k); 1 = no competitor */
  dominance: number;
  /** score-weighted majority intent over top-k */
  intentVote: string | null;
  /** (coverage + dominance) / 2 — the retrieval side of blended confidence */
  retrievalConfidence: number;
}

export type Outcome = 'ok' | 'fallback' | 'refused' | 'error';

export type RouteRule =
  | 'short_circuit' // high retrieval dominance -> extractive backend
  | 'default' // normal path -> real model
  | 'fallback_error' // chosen backend failed pre-first-token -> other backend
  | 'fallback_timeout' // chosen backend TTFB timeout -> other backend
  | 'no_evidence_refusal'; // no retrieval evidence -> refuse without a model call

export type ChaosMode = 'off' | 'error' | 'slow';

export interface UsageRow {
  id: number;
  request_id: string;
  tenant_id: number;
  route_rule: RouteRule;
  backend: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  latency_ttfb_ms: number;
  latency_total_ms: number;
  cost_usd: number;
  outcome: Outcome;
  fallback_fired: number;
  fallback_reason: string | null;
  intent: string | null;
  intent_vote: string | null;
  intent_llm: string | null;
  confidence: number | null;
  dominance: number;
  created_at: string;
}

/** SSE payload contract (product-facing; internal extras go to /admin/usage). */
export interface MetaEvent {
  request_id: string;
  tenant: string;
  intent_vote: string | null;
  dominance: number;
  coverage: number;
  retrieved: { question: string; intent: string; score: number }[];
}

export interface DoneEvent {
  request_id: string;
  backend: string;
  model: string;
  route_rule: RouteRule;
  fallback_fired: boolean;
  fallback_reason: string | null;
  intent: string | null;
  confidence: number | null;
  prompt_tokens: number;
  completion_tokens: number;
  latency_ttfb_ms: number;
  latency_total_ms: number;
  cost_usd: number;
  outcome: Outcome;
}

export interface ErrorEvent {
  code: string;
  message: string;
  request_id?: string;
}
