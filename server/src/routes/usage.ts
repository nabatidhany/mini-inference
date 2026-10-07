/**
 * GET /v1/usage — per-tenant usage summary for the console (same API key as
 * chat): quota snapshot, today's aggregates per outcome, recent requests.
 */
import type { Router } from 'express';
import express from 'express';
import { db } from '../lib/db.js';
import { requireTenant, type AuthedRequest } from '../lib/auth.js';
import { quota } from '../lib/quota.js';

export const usageRouter: Router = express.Router();

usageRouter.get('/v1/usage', requireTenant, (req: AuthedRequest, res) => {
  const tenant = req.tenant!;
  const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 25) || 25));

  const requests = db.prepare(`
    SELECT request_id, created_at, model, route_rule, outcome, fallback_fired,
           fallback_reason, intent, prompt_tokens, completion_tokens,
           latency_ttfb_ms, latency_total_ms, cost_usd
    FROM usage WHERE tenant_id = ? ORDER BY id DESC LIMIT ?
  `).all(tenant.id, limit) as Record<string, unknown>[];

  const todayAgg = db.prepare(`
    SELECT COUNT(*) AS requests,
           COALESCE(SUM(cost_usd), 0) AS cost_usd,
           SUM(CASE WHEN outcome = 'ok' THEN 1 ELSE 0 END) AS ok,
           SUM(CASE WHEN outcome = 'fallback' THEN 1 ELSE 0 END) AS fallback,
           SUM(CASE WHEN outcome = 'refused' THEN 1 ELSE 0 END) AS refused,
           SUM(CASE WHEN outcome = 'error' THEN 1 ELSE 0 END) AS error,
           COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS tokens
    FROM usage WHERE tenant_id = ? AND created_at >= datetime('now', 'start of day')
  `).get(tenant.id) as Record<string, number>;

  res.json({
    tenant: tenant.name,
    quota: quota.snapshot(tenant),
    today: {
      requests: todayAgg['requests'] ?? 0,
      tokens: todayAgg['tokens'] ?? 0,
      cost_usd: Math.round((todayAgg['cost_usd'] ?? 0) * 1e6) / 1e6,
      outcomes: {
        ok: todayAgg['ok'] ?? 0,
        fallback: todayAgg['fallback'] ?? 0,
        refused: todayAgg['refused'] ?? 0,
        error: todayAgg['error'] ?? 0,
      },
    },
    requests,
  });
});
