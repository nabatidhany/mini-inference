/**
 * /admin/* — internal observability + demo tooling, guarded by x-admin-key.
 *  GET  /admin/state              current chaos/mock/router state
 *  POST /admin/chaos              {backend, mode: off|error|slow}  failure drill
 *  POST /admin/mock               {latencyMs?, failureRate?}        extractive mock
 *  POST /admin/router             {shortCircuitThreshold: number|null}
 *  GET  /admin/usage              full metering rows (internal fields)
 *  POST /admin/quota-reset        {tenant} — reset today's ledger (dev/eval)
 */
import type { Router } from 'express';
import express from 'express';
import { z } from 'zod';
import { requireAdmin } from '../lib/auth.js';
import { db } from '../lib/db.js';
import { allUsage, usageByRequestId } from '../lib/metering.js';
import { quota } from '../lib/quota.js';
import { runtime } from '../lib/runtime.js';
import type { ChaosMode } from '../types.js';

export const adminRouter: Router = express.Router();
adminRouter.use('/admin', requireAdmin);

adminRouter.get('/admin/state', (_req, res) => {
  res.json(runtime.snapshot());
});

const chaosSchema = z.object({
  backend: z.string(),
  mode: z.enum(['off', 'error', 'slow']),
});
adminRouter.post('/admin/chaos', (req, res) => {
  const parsed = chaosSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'expected {backend: string, mode: off|error|slow}' } });
    return;
  }
  runtime.chaos.set(parsed.data.backend, parsed.data.mode as ChaosMode);
  res.json(runtime.snapshot());
});

const mockSchema = z.object({
  latencyMs: z.number().min(0).optional(),
  failureRate: z.number().min(0).max(1).optional(),
});
adminRouter.post('/admin/mock', (req, res) => {
  const parsed = mockSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'expected {latencyMs?: number, failureRate?: 0..1}' } });
    return;
  }
  res.json({ mock: runtime.mock.set(parsed.data) });
});

const routerSchema = z.object({
  shortCircuitThreshold: z.number().min(0).max(1).nullable(),
});
adminRouter.post('/admin/router', (req, res) => {
  const parsed = routerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'expected {shortCircuitThreshold: number|null} (null disables)' } });
    return;
  }
  res.json({ router: runtime.router.set(parsed.data) });
});

adminRouter.get('/admin/usage', (req, res) => {
  const requestId = typeof req.query.request_id === 'string' ? req.query.request_id : null;
  if (requestId) {
    const row = usageByRequestId(requestId);
    if (!row) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: `no metering row for ${requestId}` } });
      return;
    }
    res.json({ request: row });
    return;
  }
  const limit = Math.min(1000, Math.max(1, Number(req.query.limit ?? 200) || 200));
  res.json({ requests: allUsage(limit) });
});

const quotaResetSchema = z.object({ tenant: z.string() });
adminRouter.post('/admin/quota-reset', (req, res) => {
  const parsed = quotaResetSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'expected {tenant: name}' } });
    return;
  }
  const tenant = db.prepare('SELECT id, name, api_key, token_quota_per_day AS tokenQuotaPerDay FROM tenants WHERE name = ?').get(parsed.data.tenant);
  if (!tenant) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: `unknown tenant ${parsed.data.tenant}` } });
    return;
  }
  quota.clearToday(tenant as never);
  res.json({ ok: true, tenant: parsed.data.tenant });
});
