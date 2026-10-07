/**
 * Token quota per tenant per UTC day — reserve-then-settle, fail closed.
 *
 *  reserve(tenant, estimate) -> ok | QuotaExceededError   (pre-flight, before any model call)
 *  settle(tenant, estimate, actual)                        (post-flight, with provider-reported tokens)
 *
 * "Reserved" tokens are in-flight reservations held in memory: concurrent
 * requests cannot collectively overshoot the daily limit. A crash simply
 * drops the reservation (it was never spent). Settled tokens are durable in
 * the token_ledger table.
 */
import { db, nextResetIso, todayKey } from './db.js';
import type { Tenant } from '../types.js';

export class QuotaExceededError extends Error {
  readonly usedTokens: number;
  readonly limitTokens: number;
  readonly resetAt: string;

  constructor(usedTokens: number, limitTokens: number) {
    super(`Daily token quota exceeded: ${usedTokens}/${limitTokens} used. Resets at ${nextResetIso()}.`);
    this.name = 'QuotaExceededError';
    this.usedTokens = usedTokens;
    this.limitTokens = limitTokens;
    this.resetAt = nextResetIso();
  }
}

interface LedgerStore {
  getSettled(tenantId: number, day: string): number;
  addSettled(tenantId: number, day: string, tokens: number): void;
  clearDay(tenantId: number, day: string): void;
}

class SqliteLedger implements LedgerStore {
  getSettled(tenantId: number, day: string): number {
    const row = db.prepare('SELECT settled_tokens FROM token_ledger WHERE tenant_id = ? AND day = ?').get(tenantId, day) as { settled_tokens: number } | undefined;
    return row?.settled_tokens ?? 0;
  }
  addSettled(tenantId: number, day: string, tokens: number): void {
    db.prepare(
      `INSERT INTO token_ledger (tenant_id, day, settled_tokens) VALUES (?, ?, ?)
       ON CONFLICT(tenant_id, day) DO UPDATE SET settled_tokens = settled_tokens + excluded.settled_tokens`,
    ).run(tenantId, day, tokens);
  }
  clearDay(tenantId: number, day: string): void {
    db.prepare('DELETE FROM token_ledger WHERE tenant_id = ? AND day = ?').run(tenantId, day);
  }
}

export class QuotaTracker {
  private readonly inFlight = new Map<number, number>(); // tenantId -> reserved tokens

  constructor(private readonly store: LedgerStore = new SqliteLedger()) {}

  private day(): string {
    return todayKey();
  }

  /** Tokens already spent today (settled) + reserved by in-flight requests. */
  used(tenant: Tenant): number {
    return this.store.getSettled(tenant.id, this.day()) + (this.inFlight.get(tenant.id) ?? 0);
  }

  remaining(tenant: Tenant): number {
    return Math.max(0, tenant.tokenQuotaPerDay - this.used(tenant));
  }

  snapshot(tenant: Tenant) {
    return {
      limit_tokens_per_day: tenant.tokenQuotaPerDay,
      used_tokens_today: this.used(tenant),
      remaining_tokens_today: this.remaining(tenant),
      reset_at: nextResetIso(),
    };
  }

  /** Pre-flight reservation. Throws QuotaExceededError (fail closed) if the
   *  estimated cost of serving the request would overshoot the daily limit. */
  reserve(tenant: Tenant, estimate: number): void {
    const remaining = this.remaining(tenant);
    if (estimate > remaining) {
      throw new QuotaExceededError(this.used(tenant), tenant.tokenQuotaPerDay);
    }
    this.inFlight.set(tenant.id, (this.inFlight.get(tenant.id) ?? 0) + estimate);
  }

  /** Post-flight: release the reservation and record the actual consumption. */
  settle(tenant: Tenant, estimate: number, actual: number): void {
    const reserved = this.inFlight.get(tenant.id) ?? 0;
    this.inFlight.set(tenant.id, Math.max(0, reserved - estimate));
    this.store.addSettled(tenant.id, this.day(), Math.max(0, actual));
  }

  /** Dev/demo tooling (admin): wipe today's settled usage for a tenant. */
  clearToday(tenant: Tenant): void {
    this.store.clearDay(tenant.id, this.day());
    this.inFlight.delete(tenant.id);
  }
}

export const quota = new QuotaTracker();
