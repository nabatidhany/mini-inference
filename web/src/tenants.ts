/**
 * Demo tenants — mirrors server/src/lib/seed.ts. These are seeded demo API
 * keys (public demo data, not secrets): the console plays the role of a
 * "product team" calling the shared gateway with its tenant key.
 */
export interface DemoTenant {
  name: string;
  apiKey: string;
  note: string;
}

export const TENANTS: DemoTenant[] = [
  { name: 'acme', apiKey: 'sk-demo-acme-0001', note: 'normal tenant — 50k tokens/day' },
  { name: 'globex', apiKey: 'sk-demo-globex-0002', note: 'tiny quota — 200 tokens/day (demo 429)' },
  { name: 'initech', apiKey: 'sk-demo-initech-0003', note: 'second tenant — 50k tokens/day' },
];

export const ADMIN_KEY = 'dev-admin-key';
