import type { Resort } from '../config/resorts';
import { href } from '../hooks/useRoute';
import { StormView } from './StormView';
import { HistoryView } from './HistoryView';
import { SnowpackView } from './SnowpackView';

export const TABS = [
  { id: 'storm', label: 'Forecast' },
  { id: 'history', label: 'Run history' },
  { id: 'snowpack', label: 'Snowpack' },
] as const;

export function ResortView({ resort, tab }: { resort: Resort; tab?: string }) {
  const active = TABS.find((t) => t.id === tab)?.id ?? 'storm';
  const qs = window.location.hash.split('?')[1];
  return (
    <div>
      <div className="pt-5">
        <h1 className="text-2xl font-semibold tracking-tight">{resort.name}</h1>
        <div className="text-sm text-ink-2">{resort.region}</div>
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
      {resort.note && (
        <p className="text-xs text-ink-2 mt-1.5">
          {resort.note.text}{' '}
          <a href={resort.note.link.url} target="_blank" rel="noreferrer" className="underline decoration-[var(--axis)] hover:text-ink">
            {resort.note.link.label} ↗
          </a>
        </p>
      )}
      {/* A tab bar on its own rule, so the views read as tabs, distinct from the band and view toggles below. */}
      <nav className="mt-3 flex border-b border-line" aria-label="Views">
        {TABS.map((t) => (
          <a
            key={t.id}
            href={`${href('resort', resort.id, t.id)}${qs ? `?${qs}` : ''}`}
            aria-current={active === t.id ? 'page' : undefined}
            className={`flex-1 sm:flex-none text-center px-4 py-2 -mb-px border-b-2 text-sm rounded-t-md focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${
              active === t.id ? 'border-ink text-ink font-semibold' : 'border-transparent text-ink-2 hover:text-ink hover:bg-surface-2 hover:border-line'
            }`}
          >
            {t.label}
          </a>
        ))}
      </nav>
      {active === 'storm' && <StormView resort={resort} />}
      {active === 'history' && <HistoryView resort={resort} />}
      {active === 'snowpack' && <SnowpackView resort={resort} />}
    </div>
  );
}
