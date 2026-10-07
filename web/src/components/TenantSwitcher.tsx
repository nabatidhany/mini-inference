import type { DemoTenant } from '../tenants';

export default function TenantSwitcher(props: { tenants: DemoTenant[]; selected: DemoTenant; onSelect: (t: DemoTenant) => void }) {
  return (
    <label className="flex items-center gap-2 text-xs text-slate-500">
      Tenant
      <select
        className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm font-medium text-slate-800 shadow-sm focus:border-indigo-400 focus:outline-none"
        value={props.selected.name}
        onChange={(e) => props.onSelect(props.tenants.find((t) => t.name === e.target.value)!)}
      >
        {props.tenants.map((t) => (
          <option key={t.name} value={t.name}>
            {t.name}
          </option>
        ))}
      </select>
      <span className="hidden max-w-52 truncate text-slate-400 xl:inline">{props.selected.note}</span>
    </label>
  );
}
