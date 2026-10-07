/**
 * Second backend: extractive. It serves the top-retrieved KB answer verbatim —
 * a deterministic, zero-cost degraded mode that (a) the router short-circuits
 * to when retrieval dominance is high, and (b) acts as fallback when the real
 * model fails or is too slow.
 *
 * The PDF explicitly allows a mock second backend with configurable latency
 * and failure; here the mock is also genuinely useful — it answers from the
 * KB instead of fabricating text. Latency/failure are admin-configurable
 * at runtime (POST /admin/mock).
 */
import { estimateTokens } from '../lib/tokenize.js';
import { runtime } from '../lib/runtime.js';
import { sleep } from './async.js';
import type { BackendEvent, ChatBackend, ChatTask } from './types.js';

const WORD_DELAY_MS = 15;

export function createExtractiveBackend(): ChatBackend {
  return {
    id: 'extractive',
    model: 'internal/extractive',

    async *streamChat(task: ChatTask, signal: AbortSignal): AsyncGenerator<BackendEvent> {
      // configurable mock failure (pre-first-token -> fallback drill)
      const mock = runtime.mock.get();
      if (mock.failureRate > 0 && Math.random() < mock.failureRate) {
        throw new Error('MOCK_FAILURE_RATE');
      }
      // configurable mock latency
      await sleep(mock.latencyMs, signal);

      const answer = task.extractiveAnswer;
      if (!answer) throw new Error('EXTRACTIVE_NO_ANSWER');

      const parts = answer.split(/(\s+)/); // keep whitespace, stream word-by-word
      for (const part of parts) {
        if (part.length === 0) continue;
        if (signal.aborted) {
          throw signal.reason instanceof Error ? signal.reason : new Error('ABORTED');
        }
        yield { type: 'delta', text: part };
        await sleep(WORD_DELAY_MS, signal);
      }

      yield {
        type: 'usage',
        promptTokens: estimateTokens(task.system) + estimateTokens(task.user),
        completionTokens: estimateTokens(answer),
        source: 'estimated',
      };
    },
  };
}
