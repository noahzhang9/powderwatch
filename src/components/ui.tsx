import type { ReactNode } from 'react';

export function Seg<T extends string>({ value, options, onChange, label }: {
  value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; label: string;
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Tile({ label, value, sub, title }: { label: string; value: ReactNode; sub?: ReactNode; title?: string }) {
  return (
    <div className="card px-4 py-3 min-w-0" title={title}>
      <div className="text-[11px] uppercase tracking-wide text-ink-3">{label}</div>
      <div className="text-2xl font-semibold leading-tight mt-0.5 break-words">{value}</div>
      {sub != null && <div className="text-xs text-ink-2 mt-0.5">{sub}</div>}
    </div>
  );
}

export function Section({ title, subtitle, right, children }: { title: string; subtitle?: ReactNode; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="card p-4 mt-4">
      <div className="flex flex-wrap items-start justify-between gap-2 mb-2">
        <div>
          <h2 className="text-base font-semibold">{title}</h2>
          {subtitle && <div className="text-xs text-ink-2 mt-0.5 max-w-3xl">{subtitle}</div>}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'error'; children: ReactNode }) {
  const icon = tone === 'error' ? '⛔' : tone === 'warn' ? '⚠️' : 'ℹ️';
  const border = tone === 'error' ? 'var(--critical)' : tone === 'warn' ? 'var(--warning)' : 'var(--axis)';
  return (
    <div className="text-xs text-ink-2 rounded-lg px-3 py-2 mt-2 bg-surface-2" style={{ borderLeft: `3px solid ${border}` }} role={tone === 'error' ? 'alert' : undefined}>
      <span aria-hidden className="mr-1.5">{icon}</span>
      {children}
    </div>
  );
}

export function Loading({ what }: { what: string }) {
  return <div className="text-sm text-ink-3 py-10 text-center">Loading {what}…</div>;
}

/** Legend + visibility toggle for a model; mirrors the line mark it controls. */
export function ModelChip({ color, label, on, onToggle, title, thick }: {
  color: string; label: string; on: boolean; onToggle: () => void; title?: string; thick?: boolean;
}) {
  return (
    <button type="button" className="chip" aria-pressed={on} onClick={onToggle} title={title}>
      <span aria-hidden style={{ width: 14, height: thick ? 3 : 2, background: color, display: 'inline-block', borderRadius: 1 }} />
      {label}
    </button>
  );
}

export function Pct({ p }: { p: number | null }) {
  if (p == null) return <>—</>;
  return <>{Math.round(p * 100)}%</>;
}
