import { useEffect, useState } from 'react';
import { getJson } from '../api';
import type { UsageResponse } from '../types';

export default function UsageView({ apiKey, tenantName }: { apiKey: string; tenantName: string }) {
  const [data, setData] = useState<UsageResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      getJson<UsageResponse>('/v1/usage', apiKey)
        .then((d) => {
          if (alive) {
            setData(d);
            setError(null);
          }
        })
        .catch((e) => {
          if (alive) setError(e instanceof Error ? e.message : String(e));
        });
    };
    load();
    const timer = setInterval(load, 5000); // poll every 5s
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [apiKey]);

  if (error && !data) {
    return <div className="p-6 text-sm text-red-600">Failed to load usage: {error}</div>;
  }
  if (!data) {
    return <div className="p-6 text-sm text-slate-400">Loading usage…</div>;
  }

  const usedPct = Math.min(100, (data.quota.used_tokens_today / Math.max(1, data.quota.limit_tokens_per_day)) * 100);

  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="mb-1 flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">Usage — tenant {tenantName}</h2>
        <span className="text-xs text-slate-400">auto-refreshes every 5s</span>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-3">
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm md:col-span-2">
          <div className="flex items-baseline justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">Daily token quota</span>
            <span className="font-mono text-sm">
              {data.quota.used_tokens_today.toLocaleString()} / {data.quota.limit_tokens_per_day.toLocaleString()}
            </span>
          </div>
          <div className="mt-2 h-3 overflow-hidden rounded-full bg-slate-100">
            <div
              className={`h-full rounded-full ${usedPct > 85 ? 'bg-red-500' : 'bg-indigo-500'}`}
              style={{ width: `${usedPct}%` }}
            />
          </div>
          <p className="mt-2 text-xs text-slate-400">
            remaining {data.quota.remaining_tokens_today.toLocaleString()} · resets {new Date(data.quota.reset_at).toUTCString()}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Stat label="requests today" value={data.today.requests.toLocaleString()} />
            <Stat label="tokens today" value={data.today.tokens.toLocaleString()} />
            <Stat label="cost today" value={`$${data.today.cost_usd.toFixed(6)}`} />
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">Outcomes today</span>
          <div className="mt-3 flex flex-col gap-2 text-sm">
            <OutcomeRow label="ok" value={data.today.outcomes.ok} className="text-emerald-600" />
            <OutcomeRow label="fallback" value={data.today.outcomes.fallback} className="text-orange-600" />
            <OutcomeRow label="refused" value={data.today.outcomes.refused} className="text-amber-600" />
            <OutcomeRow label="error" value={data.today.outcomes.error} className="text-red-600" />
          </div>
        </div>
      </div>

      <div className="mt-6 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full text-left text-xs">
          <thead className="bg-slate-50 text-[11px] uppercase tracking-wider text-slate-400">
            <tr>
              <th className="px-3 py-2">time</th>
              <th className="px-3 py-2">outcome</th>
              <th className="px-3 py-2">model</th>
              <th className="px-3 py-2">route</th>
              <th className="px-3 py-2">intent</th>
              <th className="px-3 py-2 text-right">tokens</th>
              <th className="px-3 py-2 text-right">ttfb</th>
              <th className="px-3 py-2 text-right">total</th>
              <th className="px-3 py-2 text-right">cost</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.requests.length === 0 && (
              <tr>
                <td colSpan={9} className="px-3 py-6 text-center text-slate-400">
                  No requests yet for this tenant.
                </td>
              </tr>
            )}
            {data.requests.map((r) => (
              <tr key={r.request_id} className="hover:bg-slate-50">
                <td className="whitespace-nowrap px-3 py-2 text-slate-500">{r.created_at.replace('T', ' ').slice(0, 19)}</td>
                <td className="px-3 py-2">
                  <span
                    className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                      r.outcome === 'ok'
                        ? 'bg-emerald-100 text-emerald-700'
                        : r.outcome === 'fallback'
                          ? 'bg-orange-100 text-orange-700'
                          : r.outcome === 'refused'
                            ? 'bg-amber-100 text-amber-700'
                            : 'bg-red-100 text-red-700'
                    }`}
                  >
                    {r.outcome}
                  </span>
                  {r.fallback_fired === 1 && <span className="ml-1" title={r.fallback_reason ?? ''}>⚡</span>}
                </td>
                <td className="px-3 py-2 font-mono text-slate-500">{r.model.replace('groq/', '').replace('internal/', '')}</td>
                <td className="px-3 py-2 font-mono text-slate-500">{r.route_rule}</td>
                <td className="px-3 py-2 font-mono text-slate-500">{r.intent ?? '—'}</td>
                <td className="whitespace-nowrap px-3 py-2 text-right font-mono">{r.prompt_tokens + r.completion_tokens}</td>
                <td className="whitespace-nowrap px-3 py-2 text-right font-mono">{r.latency_ttfb_ms}ms</td>
                <td className="whitespace-nowrap px-3 py-2 text-right font-mono">{r.latency_total_ms}ms</td>
                <td className="whitespace-nowrap px-3 py-2 text-right font-mono">${r.cost_usd.toFixed(6)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-slate-50 px-3 py-2">
      <div className="text-[11px] uppercase tracking-wider text-slate-400">{label}</div>
      <div className="font-mono text-sm font-semibold text-slate-700">{value}</div>
    </div>
  );
}

function OutcomeRow({ label, value, className }: { label: string; value: number; className: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className={`font-semibold ${className}`}>{label}</span>
      <span className="font-mono text-slate-700">{value}</span>
    </div>
  );
}
