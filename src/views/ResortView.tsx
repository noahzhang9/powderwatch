import type { Resort } from '../config/resorts';
import { href } from '../hooks/useRoute';
import { StormView } from './StormView';
import { HistoryView } from './HistoryView';
import { SnowpackView } from './SnowpackView';

export const TABS = [
  { id: 'storm', label: 'Storm tracker' },
  { id: 'history', label: 'Run history' },
  { id: 'snowpack', label: 'Snowpack' },
] as const;

export function ResortView({ resort, tab }: { resort: Resort; tab?: string }) {
  const active = TABS.find((t) => t.id === tab)?.id ?? 'storm';
  const qs = window.location.hash.split('?')[1];
  return (
    <div>
      <div className="flex flex-wrap items-end gap-x-6 gap-y-2 pt-5">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{resort.name}</h1>
          <div className="text-sm text-ink-2">{resort.region}</div>
        </div>
        <nav className="flex gap-1 ml-auto" aria-label="Views">
          {TABS.map((t) => (
            <a
              key={t.id}
              href={`${href('resort', resort.id, t.id)}${qs ? `?${qs}` : ''}`}
              aria-current={active === t.id ? 'page' : undefined}
              className={`px-3 py-1.5 rounded-lg text-sm ${active === t.id ? 'bg-surface-2 text-ink font-semibold' : 'text-ink-2 hover:text-ink'}`}
            >
              {t.label}
            </a>
          ))}
        </nav>
      </div>
      <details className="mt-2 sm:open:block" open={window.matchMedia('(min-width: 641px)').matches}>
        <summary className="text-xs text-ink-2 sm:hidden">Links ▾</summary>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2 mt-1">
          {resort.links.map((l) => (
            <a key={l.url} href={l.url} target="_blank" rel="noreferrer" className="underline decoration-[var(--axis)] hover:text-ink">
              {l.label} ↗
            </a>
          ))}
        </div>
      </details>
      {active === 'storm' && <StormView resort={resort} />}
      {active === 'history' && <HistoryView resort={resort} />}
      {active === 'snowpack' && <SnowpackView resort={resort} />}
    </div>
  );
}
