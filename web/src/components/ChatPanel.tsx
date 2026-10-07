import { useEffect, useRef, useState } from 'react';
import { HttpError, postSse } from '../api';
import type { DoneEvent, MetaEvent, StreamErrorEvent } from '../types';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  meta?: MetaEvent;
  done?: DoneEvent;
  error?: StreamErrorEvent;
}

const SUGGESTIONS = [
  'help me reset my PIN',
  'should i cancel my order or just change it instead',
  'what is the capital city of France',
  'i want to follow up on my refund',
];

export default function ChatPanel(props: {
  apiKey: string;
  tenantName: string;
  onMeta: (meta: MetaEvent) => void;
  onDelta: () => void;
  onDone: (done: DoneEvent) => void;
  onError: (error: StreamErrorEvent & { status?: number }) => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy) return;
    setInput('');
    setBusy(true);

    const userId = `u-${Date.now()}`;
    const assistantId = `a-${Date.now()}`;
    setMessages((m) => [
      ...m,
      { id: userId, role: 'user', text: message },
      { id: assistantId, role: 'assistant', text: '' },
    ]);

    const patch = (fn: (m: ChatMessage) => ChatMessage) =>
      setMessages((list) => list.map((m) => (m.id === assistantId ? fn(m) : m)));

    try {
      await postSse('/v1/chat', props.apiKey, { message }, (e) => {
        if (e.event === 'meta') {
          const meta = e.data as MetaEvent;
          patch((m) => ({ ...m, meta }));
          props.onMeta(meta);
        } else if (e.event === 'delta') {
          const d = e.data as { text: string };
          patch((m) => ({ ...m, text: m.text + d.text }));
          props.onDelta();
        } else if (e.event === 'done') {
          const done = e.data as DoneEvent;
          patch((m) => ({ ...m, done }));
          props.onDone(done);
        } else if (e.event === 'error') {
          const err = e.data as StreamErrorEvent;
          patch((m) => ({ ...m, error: err }));
          props.onError(err);
        }
      });
      // stream ended without a done/error event -> stop the spinner
      setMessages((list) => {
        const last = list.find((m) => m.id === assistantId);
        if (last && !last.done && !last.error) props.onError({ code: 'STREAM_ENDED', message: 'stream ended without a result event' });
        return list;
      });
    } catch (err) {
      const payload =
        err instanceof HttpError
          ? { code: err.code ?? `HTTP_${err.status}`, message: err.message, status: err.status }
          : { code: 'CLIENT_ERROR', message: err instanceof Error ? err.message : String(err) };
      patch((m) => ({ ...m, error: payload }));
      props.onError(payload);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-8">
        {messages.length === 0 ? (
          <div className="mx-auto mt-12 max-w-xl text-center">
            <div className="mb-2 text-3xl">🛒</div>
            <h2 className="text-lg font-semibold">Customer support assistant</h2>
            <p className="mt-1 text-sm text-slate-500">
              Answers stream in through the gateway — check the inspector on the right for the routing, fallback and
              metering internals of every request.
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => void send(s)}
                  className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-600 shadow-sm transition hover:border-indigo-300 hover:text-indigo-700"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="mx-auto flex max-w-2xl flex-col gap-4">
            {messages.map((m) => (
              <MessageBubble key={m.id} message={m} />
            ))}
          </div>
        )}
      </div>

      <form
        className="border-t border-slate-200 bg-white px-4 py-3 sm:px-8"
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
      >
        <div className="mx-auto flex max-w-2xl items-center gap-2">
          <input
            className="flex-1 rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm shadow-sm focus:border-indigo-400 focus:bg-white focus:outline-none"
            placeholder={`Ask anything — tenant ${props.tenantName}`}
            value={input}
            maxLength={2000}
            onChange={(e) => setInput(e.target.value)}
            disabled={busy}
          />
          <button
            type="submit"
            disabled={busy || input.trim().length === 0}
            className="rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? '…' : 'Send'}
          </button>
        </div>
      </form>
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-indigo-600 px-4 py-2.5 text-sm text-white shadow-sm">
          {message.text}
        </div>
      </div>
    );
  }

  const outcome = message.done?.outcome;
  const refused = outcome === 'refused';

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 text-[11px] font-medium text-slate-400">
        <span className="text-slate-500">assistant</span>
        {message.done && (
          <>
            <span>·</span>
            <span>{message.done.backend === 'groq' ? '🤖 real model' : message.done.backend === 'none' ? '—' : '📄 KB extractive'}</span>
            <span>·</span>
            <span>{message.done.model}</span>
          </>
        )}
      </div>
      <div
        className={`max-w-[92%] whitespace-pre-wrap rounded-2xl rounded-bl-md border px-4 py-2.5 text-sm shadow-sm ${
          message.error
            ? 'border-red-200 bg-red-50 text-red-800'
            : refused
              ? 'border-amber-200 bg-amber-50 text-amber-900'
              : 'border-slate-200 bg-white text-slate-800'
        }`}
      >
        {message.error ? (
          <span>
            <strong>{message.error.code}</strong> — {message.error.message}
          </span>
        ) : message.text.length === 0 ? (
          <span className="inline-flex gap-1">
            <Dot delay="0ms" />
            <Dot delay="150ms" />
            <Dot delay="300ms" />
          </span>
        ) : (
          message.text
        )}
      </div>
      {message.done?.fallback_fired && (
        <div className="text-[11px] font-medium text-orange-600">
          ⚡ fallback fired — {message.done.fallback_reason}
        </div>
      )}
    </div>
  );
}

function Dot({ delay }: { delay: string }) {
  return <span className="animate-bounce rounded-full bg-slate-400" style={{ animationDelay: delay, width: 5, height: 5 }} />;
}
