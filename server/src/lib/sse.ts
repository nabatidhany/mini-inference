/** SSE response helpers (meta/delta/done/error contract — see README). */
import type { Response } from 'express';

export function initSse(res: Response): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
}

export function sendEvent<T>(res: Response, event: string, data: T): void {
  if (res.destroyed || res.writableEnded) return;
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    // client vanished mid-stream; the request 'close' handler takes over
  }
}

export function endSse(res: Response): void {
  if (!res.destroyed && !res.writableEnded) res.end();
}
