import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useAsync } from '../hooks/useAsync';
import { NOT_IN_SNAPSHOT, SNAPSHOT_MAX_AGE_S, isNotInSnapshot, netStatus, snapshotInfo, subscribeNet } from '../lib/cache';
import { ago, nowUnix } from '../lib/time';

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

/**
 * A failed request. In a snapshot-only build, a request the local snapshot doesn't hold is an
 * inline note rather than a failure; anything else is an error with an optional Retry.
 */
export function RequestError({ what, error, retry }: { what: string; error: Error; retry?: () => void }) {
  if (isNotInSnapshot(error)) return <Notice>{NOT_IN_SNAPSHOT}: {what.toLowerCase()} data.</Notice>;
  return (
    <Notice tone="error">
      {what} request failed: {error.message}
      {retry && <button type="button" className="btn ml-2" onClick={retry}>Retry</button>}
    </Notice>
  );
}

/** Snapshot-only builds: says so, and how old the snapshot is. */
export function SnapshotOnlyBanner() {
  const info = useAsync(snapshotInfo, []);
  const t = info.data?.generatedAt ?? null;
  const taken = t == null ? null : new Date(t * 1000).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return (
    <div className="bg-surface-2 border-b border-line text-xs text-ink-2" role="note" aria-label="Snapshot-only mode">
      <div className="max-w-7xl mx-auto px-4 py-1.5">
        <b className="text-ink">Snapshot-only preview</b>
        {info.loading ? ' · reading the local snapshot…' : info.data ? (
          <>
            {' '}· forecasts from the local snapshot taken {t == null ? 'at an unknown time' : <>{ago(t)} ({taken})</>}, {info.data.entries} requests
            {t != null && nowUnix() - t > SNAPSHOT_MAX_AGE_S ? ', older than the live site would use' : ''}
          </>
        ) : ' · no local snapshot found (.cache/fc/ is empty)'}
        {' '}· no live Open-Meteo calls.
      </div>
    </div>
  );
}

let snapshot = netStatus();
const getSnapshot = () => {
  const n = netStatus();
  if (n.active !== snapshot.active || n.queued !== snapshot.queued || n.retryUntil !== snapshot.retryUntil) snapshot = n;
  return snapshot;
};

/** Loading text that says what it is waiting for (queue, rate-limit backoff). */
export function Loading({ what }: { what: string }) {
  const net = useSyncExternalStore(subscribeNet, getSnapshot);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!net.retryUntil) return;
    const id = setInterval(() => tick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [net.retryUntil]);
  const wait = net.retryUntil ? Math.max(0, Math.ceil((net.retryUntil - Date.now()) / 1000)) : null;
  return (
    <div className="text-sm text-ink-3 py-10 text-center" aria-live="polite">
      Loading {what}…
      {wait != null ? (
        <div className="text-xs mt-1">Open-Meteo is rate-limiting this network ({net.lastHttpStatus}); retrying in {wait} s. Shared networks such as a corporate VPN hit this sooner.</div>
      ) : net.active + net.queued > 0 ? (
        <div className="text-xs mt-1">{net.active} request{net.active === 1 ? '' : 's'} in flight{net.queued ? `, ${net.queued} queued` : ''}</div>
      ) : null}
    </div>
  );
}

/** Renders children only once scrolled near the viewport (defers their network requests). */
export function Lazy({ children, minHeight = 200 }: { children: ReactNode; minHeight?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (shown || !ref.current) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setShown(true), { rootMargin: '600px' });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [shown]);
  return <div ref={ref} style={shown ? undefined : { minHeight }}>{shown ? children : null}</div>;
}

/**
 * Disclosure for supporting material ("More detail"). Children mount only while open, so their
 * requests wait until someone asks for them. A button with aria-expanded, so it works from the keyboard.
 */
export function Disclosure({ label, hint, open, onToggle, children }: {
  label: string; hint?: ReactNode; open: boolean; onToggle: (open: boolean) => void; children: ReactNode;
}) {
  const id = useId();
  return (
    <section className="mt-4" aria-label={label}>
      <button type="button" className="disclosure" aria-expanded={open} aria-controls={id} onClick={() => onToggle(!open)}>
        <span aria-hidden className="disclosure-mark">▸</span>
        <span className="font-semibold text-ink">{label}</span>
        {hint && <span className="text-xs text-ink-2">{hint}</span>}
      </button>
      <div id={id} hidden={!open}>{open ? children : null}</div>
    </section>
  );
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
