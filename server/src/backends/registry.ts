/**
 * Backend registry. Chaos wrapping is applied to every backend uniformly:
 * POST /admin/chaos {backend, mode} can force 'error' or 'slow' (15s TTFB)
 * for failure drills — the reliable way to demonstrate fallback against the
 * real backend in the demo video. Decisions remain visible in metering.
 */
import { config } from '../config.js';
import { runtime } from '../lib/runtime.js';
import { sleep } from './async.js';
import { createExtractiveBackend } from './extractive.js';
import { createGroqBackend } from './groq.js';
import type { BackendEvent, ChatBackend, ChatTask } from './types.js';

const CHAOS_SLOW_MS = 15_000; // > ttfb timeout -> drills the fallback-on-slow path

function withChaos(backend: ChatBackend): ChatBackend {
  return {
    id: backend.id,
    model: backend.model,
    async *streamChat(task: ChatTask, signal: AbortSignal): AsyncGenerator<BackendEvent> {
      const mode = runtime.chaos.get(backend.id);
      if (mode === 'error') throw new Error('CHAOS_SIMULATED_ERROR');
      if (mode === 'slow') await sleep(CHAOS_SLOW_MS, signal);
      yield* backend.streamChat(task, signal);
    },
  };
}

const backends: ChatBackend[] = [
  withChaos(createGroqBackend()),
  withChaos(createExtractiveBackend()),
];

export function getBackend(id: string): ChatBackend | undefined {
  return backends.find((b) => b.id === id);
}

export function theOtherBackend(id: string): ChatBackend | undefined {
  return backends.find((b) => b.id !== id);
}

/**
 * Router policy: which backend serves this request, and why. The coverage
 * floor has already been enforced upstream (refusal gate), so here the
 * decision is the cross-intent dominance: with no different-intent
 * competitor in sight, the top KB entry IS the answer — synthesis by the
 * real model would only add cost and latency.
 */
export interface RouteDecision {
  backendId: string;
  routeRule: 'short_circuit' | 'default';
  reason: string;
}

export function route(coverage: number, dominance: number): RouteDecision {
  const threshold = runtime.router.get().shortCircuitThreshold;
  if (threshold !== null && dominance >= threshold) {
    return {
      backendId: 'extractive',
      routeRule: 'short_circuit',
      reason: `retrieval dominance ${dominance.toFixed(2)} >= short-circuit threshold ${threshold}; KB entry is the answer (coverage ${coverage.toFixed(2)})`,
    };
  }
  return {
    backendId: 'groq',
    routeRule: 'default',
    reason: threshold === null
      ? 'short-circuit disabled by config; always use the real model'
      : `retrieval dominance ${dominance.toFixed(2)} < short-circuit threshold ${threshold}; synthesis needed (coverage ${coverage.toFixed(2)})`,
  };
}

export const backendDefaults = {
  ttfbTimeoutMs: config.ttfbTimeoutMs,
  totalTimeoutMs: config.totalTimeoutMs,
};
