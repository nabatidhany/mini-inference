/** Metering: one usage row per request, cost from the price table. */
import { db } from './db.js';
import { config } from '../config.js';
import type { Outcome, RouteRule, UsageRow } from '../types.js';

export interface MeteringInput {
  request_id: string;
  tenant_id: number;
  route_rule: RouteRule;
  backend: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  latency_ttfb_ms: number;
  latency_total_ms: number;
  outcome: Outcome;
  fallback_fired: boolean;
  fallback_reason: string | null;
  intent: string | null;
  intent_vote: string | null;
  intent_llm: string | null;
  confidence: number | null;
  dominance: number;
}

export function estimatedCostUsd(model: string, promptTokens: number, completionTokens: number): number {
  const price = config.prices[model] ?? { input: 0, output: 0 };
  const cost = (promptTokens / 1e6) * price.input + (completionTokens / 1e6) * price.output;
  // round to micro-dollars so the DB (and reports) stay tidy
  return Math.round(cost * 1e6) / 1e6;
}

export function recordUsage(input: MeteringInput): void {
  const cost = estimatedCostUsd(input.model, input.prompt_tokens, input.completion_tokens);
  db.prepare(`
    INSERT INTO usage (request_id, tenant_id, route_rule, backend, model,
      prompt_tokens, completion_tokens, latency_ttfb_ms, latency_total_ms,
      cost_usd, outcome, fallback_fired, fallback_reason,
      intent, intent_vote, intent_llm, confidence, dominance)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.request_id, input.tenant_id, input.route_rule, input.backend, input.model,
    input.prompt_tokens, input.completion_tokens, input.latency_ttfb_ms, input.latency_total_ms,
    cost, input.outcome, input.fallback_fired ? 1 : 0, input.fallback_reason,
    input.intent, input.intent_vote, input.intent_llm, input.confidence, input.dominance,
  );
}

function rowToUsageRow(r: Record<string, unknown>): UsageRow {
  return {
    id: r.id as number,
    request_id: r.request_id as string,
    tenant_id: r.tenant_id as number,
    route_rule: r.route_rule as RouteRule,
    backend: r.backend as string,
    model: r.model as string,
    prompt_tokens: r.prompt_tokens as number,
    completion_tokens: r.completion_tokens as number,
    latency_ttfb_ms: r.latency_ttfb_ms as number,
    latency_total_ms: r.latency_total_ms as number,
    cost_usd: r.cost_usd as number,
    outcome: r.outcome as Outcome,
    fallback_fired: r.fallback_fired as number,
    fallback_reason: (r.fallback_reason as string | null) ?? null,
    intent: (r.intent as string | null) ?? null,
    intent_vote: (r.intent_vote as string | null) ?? null,
    intent_llm: (r.intent_llm as string | null) ?? null,
    confidence: (r.confidence as number | null) ?? null,
    dominance: r.dominance as number,
    created_at: r.created_at as string,
  };
}

export function recentUsage(tenantId: number, limit = 50): UsageRow[] {
  const rows = db.prepare(
    'SELECT * FROM usage WHERE tenant_id = ? ORDER BY id DESC LIMIT ?',
  ).all(tenantId, limit) as Record<string, unknown>[];
  return rows.map(rowToUsageRow);
}

export function usageByRequestId(requestId: string): UsageRow | undefined {
  const row = db.prepare('SELECT * FROM usage WHERE request_id = ? ORDER BY id DESC LIMIT 1').get(requestId) as Record<string, unknown> | undefined;
  return row ? rowToUsageRow(row) : undefined;
}

export function allUsage(limit = 500): UsageRow[] {
  const rows = db.prepare('SELECT * FROM usage ORDER BY id DESC LIMIT ?').all(limit) as Record<string, unknown>[];
  return rows.map(rowToUsageRow);
}
