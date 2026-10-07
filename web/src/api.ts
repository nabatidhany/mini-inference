/**
 * POST + SSE client. The native EventSource only supports GET without
 * headers, so we stream the gateway's text/event-stream over fetch and parse
 * it ourselves (handles chunks that split events mid-line).
 */

export interface SseEvent<T = unknown> {
  event: string;
  data: T;
}

export class HttpError extends Error {
  code?: string;
  status: number;
  payload?: Record<string, unknown>;
  constructor(message: string, status: number, code?: string, payload?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.payload = payload;
  }
}

export async function postSse(
  url: string,
  apiKey: string,
  body: unknown,
  onEvent: (e: SseEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    let payload: { error?: { code?: string; message?: string } & Record<string, unknown> } | null = null;
    try {
      payload = await res.json();
    } catch {
      // non-JSON error body
    }
    const err = new HttpError(
      payload?.error?.message ?? `HTTP ${res.status}`,
      res.status,
      payload?.error?.code,
      payload?.error,
    );
    throw err;
  }
  if (!res.body) throw new HttpError('no response body', 502);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep = buf.indexOf('\n\n');
    while (sep >= 0) {
      const raw = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      sep = buf.indexOf('\n\n');
      let event = 'message';
      const dataLines: string[] = [];
      for (const line of raw.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7).trim();
        else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
      }
      if (dataLines.length > 0) {
        try {
          onEvent({ event, data: JSON.parse(dataLines.join('\n')) });
        } catch {
          // tolerate malformed fragment
        }
      }
    }
  }
}

export async function getJson<T>(url: string, apiKey?: string): Promise<T> {
  const headers: Record<string, string> = {};
  if (apiKey) headers['x-api-key'] = apiKey;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { error?: { message?: string } };
      message = j.error?.message ?? message;
    } catch {
      // keep default
    }
    throw new HttpError(message, res.status);
  }
  return res.json() as Promise<T>;
}

export async function postJson<T>(url: string, apiKey: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { error?: { message?: string } };
      message = j.error?.message ?? message;
    } catch {
      // keep default
    }
    throw new HttpError(message, res.status);
  }
  return res.json() as Promise<T>;
}
