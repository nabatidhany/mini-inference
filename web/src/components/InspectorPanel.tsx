import type { InspectedRequest } from '../App';

export default function InspectorPanel({ inspected }: { inspected: InspectedRequest }) {
  const { meta, done, error, streaming } = inspected;

  if (!meta && !done && !error) {
    return (
      <div className="p-6 text-sm text-slate-400">
        <h2 className="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-400">Request inspector</h2>
        <p>Send a message — every request shows up here: routing decision, retrieved entries, intent, confidence, tokens, latency and cost.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400">Request inspector</h2>
        <span className={`text-[11px] font-semibold ${streaming ? 'animate-pulse text-indigo-500' : 'text-emerald-600'}`}>
          {streaming ? '● streaming' : '● complete'}
        </span>
      </div>

      {meta && (
        <Section title="Retrieval (pre-flight)">
          <Row label="intent vote" value={meta.intent_vote ?? '—'} mono />
          <Row label="dominance" value={meta.dominance.toFixed(2)} />
          <Row label="coverage" value={meta.coverage.toFixed(2)} />
          <div className="mt-2 flex flex-col gap-1.5">
            {meta.retrieved.map((r, i) => (
              <div key={i} className={`rounded-lg border px-2.5 py-1.5 text-[11px] leading-snug ${i === 0 ? 'border-indigo-200 bg-indigo-50' : 'border-slate-200 bg-slate-50'}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono font-semibold text-slate-600">{r.intent}</span>
                  <span className="text-slate-400">score {r.score}</span>
                </div>
                <div className="truncate text-slate-500">{r.question}</div>
              </div>
            ))}
          </div>
        </Section>
      )}

      {done && (
        <Section title="Result (post-flight)">
          <Row label="outcome" value={<OutcomeBadge outcome={done.outcome} />} />
          <Row label="backend" value={done.backend} mono />
          <Row label="model" value={done.model} mono />
          <Row label="route rule" value={done.route_rule} mono />
          <Row
            label="fallback"
            value={done.fallback_fired ? <span className="font-semibold text-orange-600">fired</span> : 'no'}
          />
          {done.fallback_reason && <Row label="reason" value={done.fallback_reason} wrap />}
          <Row label="intent" value={done.intent ?? '—'} mono />
          <Row label="confidence" value={done.confidence?.toFixed(2) ?? '—'} />
        </Section>
      )}

      {done && (
        <Section title="Metering">
          <Row label="tokens" value={`${done.prompt_tokens} in / ${done.completion_tokens} out`} mono />
          <Row label="ttfb" value={`${done.latency_ttfb_ms} ms`} mono />
          <Row label="total" value={`${done.latency_total_ms} ms`} mono />
          <Row label="cost" value={`$${done.cost_usd.toFixed(6)}`} mono />
        </Section>
      )}

      {error && (
        <Section title="Error">
          <Row label="code" value={error.code} mono />
          <Row label="message" value={error.message} wrap />
          {'status' in error && error.status !== undefined && <Row label="http" value={String(error.status)} mono />}
        </Section>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">{title}</h3>
      {children}
    </div>
  );
}

function Row({ label, value, mono, wrap }: { label: string; value: React.ReactNode; mono?: boolean; wrap?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5 text-xs">
      <span className="shrink-0 text-slate-400">{label}</span>
      <span className={`text-right text-slate-700 ${mono ? 'font-mono' : ''} ${wrap ? 'whitespace-pre-wrap' : 'truncate'}`}>
        {value}
      </span>
    </div>
  );
}

function OutcomeBadge({ outcome }: { outcome: string }) {
  const styles: Record<string, string> = {
    ok: 'bg-emerald-100 text-emerald-700',
    fallback: 'bg-orange-100 text-orange-700',
    refused: 'bg-amber-100 text-amber-700',
    error: 'bg-red-100 text-red-700',
  };
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${styles[outcome] ?? 'bg-slate-100'}`}>{outcome}</span>;
}
