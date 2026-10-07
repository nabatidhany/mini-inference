/**
 * In-memory runtime state — deliberately tunable at runtime so failure
 * drills, mock behaviour and routing policy can be demonstrated without a
 * redeploy (see video storyboard). Resets on restart; defaults from config.
 */
import { config } from '../config.js';
import type { ChaosMode } from '../types.js';

export interface MockConfig {
  latencyMs: number;   // artificial delay before the extractive backend answers
  failureRate: number; // 0..1, pre-first-token failure (drills fallback)
}

export interface RouterConfig {
  shortCircuitThreshold: number | null; // null disables extractive short-circuit
}

const state = {
  chaos: new Map<string, ChaosMode>(), // backendId -> 'off' | 'error' | 'slow'
  mock: { latencyMs: 250, failureRate: 0 } as MockConfig,
  router: { shortCircuitThreshold: config.shortCircuitThreshold } as RouterConfig,
};

export const runtime = {
  chaos: {
    get(backendId: string): ChaosMode {
      return state.chaos.get(backendId) ?? 'off';
    },
    set(backendId: string, mode: ChaosMode): void {
      state.chaos.set(backendId, mode);
    },
    clear(): void {
      state.chaos.clear();
    },
  },
  mock: {
    get(): MockConfig {
      return { ...state.mock };
    },
    set(patch: Partial<MockConfig>): MockConfig {
      if (patch.latencyMs !== undefined) state.mock.latencyMs = Math.max(0, patch.latencyMs);
      if (patch.failureRate !== undefined) state.mock.failureRate = Math.min(1, Math.max(0, patch.failureRate));
      return { ...state.mock };
    },
  },
  router: {
    get(): RouterConfig {
      return { ...state.router };
    },
    set(patch: Partial<RouterConfig>): RouterConfig {
      if (patch.shortCircuitThreshold !== undefined) state.router.shortCircuitThreshold = patch.shortCircuitThreshold;
      return { ...state.router };
    },
  },
  snapshot() {
    return {
      chaos: Object.fromEntries(state.chaos),
      mock: this.mock.get(),
      router: this.router.get(),
    };
  },
};
