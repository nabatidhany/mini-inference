/** SQLite bootstrap: schema + connection. One file, zero setup (see REPORT.md). */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config.js';

mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS tenants (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  name                TEXT NOT NULL UNIQUE,
  api_key             TEXT NOT NULL UNIQUE,
  token_quota_per_day INTEGER NOT NULL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS kb_entries (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  question TEXT NOT NULL,
  answer   TEXT NOT NULL,
  intent   TEXT NOT NULL,
  category TEXT NOT NULL
);

-- Metering: one row per request (see README for column docs).
CREATE TABLE IF NOT EXISTS usage (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id        TEXT NOT NULL,
  tenant_id         INTEGER NOT NULL,
  route_rule        TEXT NOT NULL,
  backend           TEXT NOT NULL,
  model             TEXT NOT NULL,
  prompt_tokens     INTEGER NOT NULL,
  completion_tokens INTEGER NOT NULL,
  latency_ttfb_ms   INTEGER NOT NULL,
  latency_total_ms  INTEGER NOT NULL,
  cost_usd          REAL NOT NULL,
  outcome           TEXT NOT NULL,
  fallback_fired    INTEGER NOT NULL DEFAULT 0,
  fallback_reason   TEXT,
  intent            TEXT,
  intent_vote       TEXT,
  intent_llm        TEXT,
  confidence        REAL,
  dominance         REAL NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_usage_tenant_time ON usage(tenant_id, created_at DESC);

-- Settled token consumption per tenant per UTC day (quota accounting).
CREATE TABLE IF NOT EXISTS token_ledger (
  tenant_id      INTEGER NOT NULL,
  day            TEXT NOT NULL,
  settled_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, day)
);
`);

/** UTC day key, e.g. "2026-10-06" (quota resets at UTC midnight). */
export function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Next UTC midnight in ISO — used in 429 bodies ("resets at"). */
export function nextResetIso(): string {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return d.toISOString();
}
