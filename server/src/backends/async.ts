/** Shared async plumbing for backends: abortable sleep + timeout arming. */

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const sig = signal;
    if (sig?.aborted) {
      reject(sig.reason instanceof Error ? sig.reason : new Error('ABORTED'));
      return;
    }
    const t = setTimeout(() => {
      sig?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(sig?.reason instanceof Error ? sig.reason : new Error('ABORTED'));
    };
    sig?.addEventListener('abort', onAbort, { once: true });
  });
}

export type TimeoutKind = 'TTFB_TIMEOUT' | 'TOTAL_TIMEOUT';

/**
 * Arms the two timeouts of a request on one abort controller:
 *  - TTFB timer: fires if the backend has not produced its first delta yet
 *    (a "too slow to start" backend is a fallback candidate)
 *  - total timer: fires no matter what (a stalled stream mid-answer is an
 *    error, not a fallback — the client already saw half the answer)
 *
 * The abort controller's signal is the one handed to the backend, so an abort
 * tears down the upstream fetch too.
 */
export interface ArmedTimeouts {
  onDelta(): void;
  clear(): void;
  firstDeltaSeen(): boolean;
}

export function armTimeouts(
  ctl: AbortController,
  opts: { ttfbMs: number; totalMs: number },
): ArmedTimeouts {
  let firstDelta = false;
  const ttfb = setTimeout(() => ctl.abort(new Error('TTFB_TIMEOUT')), opts.ttfbMs);
  const total = setTimeout(() => ctl.abort(new Error('TOTAL_TIMEOUT')), opts.totalMs);
  return {
    onDelta() {
      if (!firstDelta) {
        firstDelta = true;
        clearTimeout(ttfb);
      }
    },
    clear() {
      clearTimeout(ttfb);
      clearTimeout(total);
    },
    firstDeltaSeen: () => firstDelta,
  };
}

/** Classify an in-flight failure using the abort reason (best effort). */
export function classifyAbort(ctl: AbortController): TimeoutKind | 'CLIENT_ABORT' | null {
  const reason = ctl.signal.reason;
  const msg = reason instanceof Error ? reason.message : String(reason ?? '');
  if (msg.includes('TTFB_TIMEOUT')) return 'TTFB_TIMEOUT';
  if (msg.includes('TOTAL_TIMEOUT')) return 'TOTAL_TIMEOUT';
  if (msg.includes('CLIENT_ABORT')) return 'CLIENT_ABORT';
  return null;
}
