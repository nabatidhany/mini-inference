import { useState } from 'react';
import ChatPanel from './components/ChatPanel';
import InspectorPanel from './components/InspectorPanel';
import UsageView from './components/UsageView';
import TenantSwitcher from './components/TenantSwitcher';
import { TENANTS } from './tenants';
import type { DoneEvent, MetaEvent, StreamErrorEvent } from './types';

export interface InspectedRequest {
  streaming: boolean;
  meta?: MetaEvent;
  done?: DoneEvent;
  error?: StreamErrorEvent & { status?: number };
}

type View = 'chat' | 'usage';

export default function App() {
  const [tenant, setTenant] = useState(TENANTS[0]!);
  const [view, setView] = useState<View>('chat');
  const [inspected, setInspected] = useState<InspectedRequest>({ streaming: false });

  return (
    <div className="flex h-full flex-col bg-slate-100 text-slate-900">
      <header className="flex items-center gap-4 border-b border-slate-200 bg-white px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 font-bold text-white">R</div>
          <div>
            <h1 className="text-sm font-semibold leading-tight">Inference Router Console</h1>
            <p className="text-xs text-slate-500">shared gateway · routing · fallback · metering</p>
          </div>
        </div>

        <div className="ml-auto flex items-center gap-3">
          <nav className="flex rounded-lg bg-slate-100 p-1 text-sm font-medium">
            <button
              className={`rounded-md px-3 py-1.5 ${view === 'chat' ? 'bg-white shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
              onClick={() => setView('chat')}
            >
              Chat playground
            </button>
            <button
              className={`rounded-md px-3 py-1.5 ${view === 'usage' ? 'bg-white shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
              onClick={() => setView('usage')}
            >
              Usage
            </button>
          </nav>
          <TenantSwitcher
            tenants={TENANTS}
            selected={tenant}
            onSelect={(t) => {
              setTenant(t);
              setInspected({ streaming: false });
            }}
          />
        </div>
      </header>

      <main className="min-h-0 flex-1">
        {view === 'chat' ? (
          <div className="grid h-full grid-cols-1 lg:grid-cols-[minmax(0,1fr)_400px]">
            <div className="min-h-0 overflow-hidden border-r border-slate-200">
              {/* remount per tenant: fresh conversation per tenant */}
              <ChatPanel
                key={tenant.name}
                apiKey={tenant.apiKey}
                tenantName={tenant.name}
                onMeta={(meta) => setInspected({ streaming: true, meta })}
                onDelta={() => setInspected((prev) => (prev.streaming ? prev : { ...prev, streaming: true }))}
                onDone={(done) => setInspected((prev) => ({ streaming: false, meta: prev.meta, done }))}
                onError={(error) => setInspected((prev) => ({ streaming: false, meta: prev.meta, done: prev.done, error }))}
              />
            </div>
            <div className="hidden min-h-0 overflow-y-auto lg:block">
              <InspectorPanel inspected={inspected} />
            </div>
          </div>
        ) : (
          <UsageView apiKey={tenant.apiKey} tenantName={tenant.name} />
        )}
      </main>
    </div>
  );
}
