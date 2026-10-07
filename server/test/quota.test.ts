import { beforeEach, describe, expect, it } from 'vitest';
import { QuotaExceededError, QuotaTracker } from '../src/lib/quota.js';
import type { Tenant } from '../src/types.js';

// In-memory ledger store so the test needs no SQLite file.
class MemoryLedger {
  store = new Map<string, number>();
  key(tenantId: number, day: string) { return `${tenantId}:${day}`; }
  getSettled(tenantId: number, day: string) { return this.store.get(this.key(tenantId, day)) ?? 0; }
  addSettled(tenantId: number, day: string, tokens: number) {
    const k = this.key(tenantId, day);
    this.store.set(k, (this.store.get(k) ?? 0) + tokens);
  }
  clearDay(tenantId: number, day: string) { this.store.delete(this.key(tenantId, day)); }
}

const tenant = (name: string, quotaPerDay: number): Tenant => ({ id: 1, name, apiKey: `sk-${name}`, tokenQuotaPerDay: quotaPerDay });

describe('QuotaTracker (reserve-then-settle, fail closed)', () => {
  let ledger: MemoryLedger;
  let tracker: QuotaTracker;

  beforeEach(() => {
    ledger = new MemoryLedger();
    tracker = new QuotaTracker(ledger);
  });

  it('reserves when the estimate fits and settles with actual tokens', () => {
    const t = tenant('acme', 1000);
    tracker.reserve(t, 400);
    expect(tracker.remaining(t)).toBe(600); // reserved but not settled
    tracker.settle(t, 400, 350); // actual usage came in lower
    expect(tracker.used(t)).toBe(350);
    expect(tracker.remaining(t)).toBe(650);
  });

  it('fails closed when the estimate cannot fit (429 path)', () => {
    const t = tenant('globex', 200);
    expect(() => tracker.reserve(t, 900)).toThrow(QuotaExceededError);
    expect(() => tracker.reserve(t, 900)).toThrow(/quota exceeded/i);
    expect(tracker.used(t)).toBe(0); // rejected request consumed nothing
  });

  it('blocks a second concurrent request via the reservation', () => {
    const t = tenant('acme', 1000);
    tracker.reserve(t, 800); // in flight
    expect(() => tracker.reserve(t, 300)).toThrow(QuotaExceededError); // 800+300 > 1000
    tracker.settle(t, 800, 500); // actual was 500
    expect(() => tracker.reserve(t, 300)).not.toThrow(); // now it fits again
  });

  it('a crashed request drops its reservation instead of leaking it', () => {
    const t = tenant('acme', 1000);
    // simulate: reserve, then the process "restarts" (fresh tracker, same ledger)
    tracker.reserve(t, 900);
    const afterRestart = new QuotaTracker(ledger);
    expect(afterRestart.used(t)).toBe(0); // reservation was in memory only
  });
});
