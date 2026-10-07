/**
 * Seed-on-boot: the server self-heals on a fresh deploy (Render free tier has
 * an ephemeral disk). If the KB is empty we import the committed dataset
 * slices; if tenants are missing we insert the demo tenants.
 *
 * Demo API keys are seeded constants, not secrets: they exist so the console
 * can act as a "product team" tenant. Real tenants would get keys out-of-band
 * (see REPORT.md trade-offs).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface DemoTenant {
  name: string;
  apiKey: string;
  tokenQuotaPerDay: number;
  note: string;
}

/** Demo tenants for the console switcher + eval script (keys are public demo data). */
export const DEMO_TENANTS: DemoTenant[] = [
  { name: 'acme', apiKey: 'sk-demo-acme-0001', tokenQuotaPerDay: 50_000, note: 'normal tenant' },
  { name: 'globex', apiKey: 'sk-demo-globex-0002', tokenQuotaPerDay: 200, note: 'tiny quota — demonstrates 429 fail-closed' },
  { name: 'initech', apiKey: 'sk-demo-initech-0003', tokenQuotaPerDay: 50_000, note: 'second tenant for usage comparison' },
  // Dedicated eval tenant with a large quota so two eval configurations never
  // trip 429 mid-run; the eval script resets its ledger via /admin anyway.
  { name: 'eval', apiKey: 'sk-demo-eval-0004', tokenQuotaPerDay: 500_000, note: 'evaluation harness tenant' },
];

export function seedIfEmpty(): void {
  const kbCount = (db.prepare('SELECT COUNT(*) AS n FROM kb_entries').get() as { n: number }).n;
  if (kbCount === 0) {
    const slice = JSON.parse(readFileSync(join(serverRoot, 'datasets', 'kb-slice.json'), 'utf-8')) as {
      question: string; answer: string; intent: string; category: string;
    }[];
    const insert = db.prepare('INSERT INTO kb_entries (question, answer, intent, category) VALUES (?, ?, ?, ?)');
    db.transaction(() => {
      for (const r of slice) insert.run(r.question, r.answer, r.intent, r.category);
    })();
    console.log(`[seed] imported KB slice: ${slice.length} entries`);
  }

  const tenantCount = (db.prepare('SELECT COUNT(*) AS n FROM tenants').get() as { n: number }).n;
  if (tenantCount === 0) {
    const insert = db.prepare('INSERT INTO tenants (name, api_key, token_quota_per_day) VALUES (?, ?, ?)');
    db.transaction(() => {
      for (const t of DEMO_TENANTS) insert.run(t.name, t.apiKey, t.tokenQuotaPerDay);
    })();
    console.log(`[seed] inserted demo tenants: ${DEMO_TENANTS.map((t) => t.name).join(', ')}`);
  }
}
