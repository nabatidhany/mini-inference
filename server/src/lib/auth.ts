/** API-key auth: header x-api-key -> tenant. */
import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';
import { db } from './db.js';
import type { Tenant } from '../types.js';

export interface AuthedRequest extends Request {
  tenant?: Tenant;
}

export function requireTenant(req: AuthedRequest, res: Response, next: NextFunction): void {
  const key = req.header('x-api-key');
  if (!key) {
    res.status(401).json({ error: { code: 'INVALID_API_KEY', message: 'Missing x-api-key header.' } });
    return;
  }
  const tenant = db.prepare('SELECT id, name, api_key, token_quota_per_day AS tokenQuotaPerDay FROM tenants WHERE api_key = ?').get(key) as Tenant | undefined;
  if (!tenant) {
    res.status(401).json({ error: { code: 'INVALID_API_KEY', message: 'Unknown API key.' } });
    return;
  }
  req.tenant = tenant;
  next();
}

/** Admin auth for /admin/* (chaos switches, router config, internal metering). */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const key = req.header('x-admin-key');
  if (key !== config.adminKey) {
    res.status(401).json({ error: { code: 'INVALID_ADMIN_KEY', message: 'Unknown admin key.' } });
    return;
  }
  next();
}
