/** Mirror of the gateway SSE contract (server/src/types.ts). */

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
  route_rule: string;
  fallback_fired: boolean;
  fallback_reason: string | null;
  intent: string | null;
  confidence: number | null;
  prompt_tokens: number;
  completion_tokens: number;
  latency_ttfb_ms: number;
  latency_total_ms: number;
  cost_usd: number;
  outcome: 'ok' | 'fallback' | 'refused' | 'error';
}

export interface StreamErrorEvent {
  code: string;
  message: string;
  request_id?: string;
}

export interface UsageResponse {
  tenant: string;
  quota: {
    limit_tokens_per_day: number;
    used_tokens_today: number;
    remaining_tokens_today: number;
    reset_at: string;
  };
  today: {
    requests: number;
    tokens: number;
    cost_usd: number;
    outcomes: { ok: number; fallback: number; refused: number; error: number };
  };
  requests: {
    request_id: string;
    created_at: string;
    model: string;
    route_rule: string;
    outcome: string;
    fallback_fired: number;
    fallback_reason: string | null;
    intent: string | null;
    prompt_tokens: number;
    completion_tokens: number;
    latency_ttfb_ms: number;
    latency_total_ms: number;
    cost_usd: number;
  }[];
}
