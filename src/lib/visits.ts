/**
 * "Since your last visit" deltas: remembers the value shown for a key and
 * reports the change against the previous visit (≥ 30 min earlier).
 */
import { useEffect } from 'react';

interface Rec { t: number; v: number }
interface Store { cur: Rec; prev: Rec | null }
export interface VisitDelta { delta: number; sinceS: number }

const PREFIX = 'pw-seen:';
const MIN_GAP_S = 30 * 60;

const isRec = (x: unknown): x is Rec =>
  typeof x === 'object' && x != null && Number.isFinite((x as Rec).t) && Number.isFinite((x as Rec).v);

function read(key: string): Store | null {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(PREFIX + key) ?? 'null');
    if (typeof raw !== 'object' || raw == null) return null;
    const { cur, prev } = raw as Partial<Store>;
    return isRec(cur) ? { cur, prev: isRec(prev) ? prev : null } : null;
  } catch {
    return null;
  }
}

/** A new visit starts once the remembered one is 30 min old; until then the shown value is updated in place. */
const startsVisit = (store: Store, now: number) => now - store.cur.t >= MIN_GAP_S;

/** The change since the previous visit for the value shown now. Reads only. */
export function sinceLastVisit(key: string, value: number | null, now = Date.now() / 1000): VisitDelta | null {
  if (value == null || !Number.isFinite(value)) return null;
  const store = read(key);
  const baseline = !store ? null : startsVisit(store, now) ? store.cur : store.prev;
  return baseline ? { delta: value - baseline.v, sinceS: now - baseline.t } : null;
}

/** Remembers the value shown now. */
export function recordVisit(key: string, value: number | null, now = Date.now() / 1000): void {
  if (value == null || !Number.isFinite(value)) return;
  const store = read(key);
  const next: Store = !store
    ? { cur: { t: now, v: value }, prev: null }
    : startsVisit(store, now)
      ? { cur: { t: now, v: value }, prev: store.cur }
      : { cur: { t: store.cur.t, v: value }, prev: store.prev };
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(next));
  } catch {
    /* storage full or disabled */
  }
}

/**
 * Deltas for the values a view shows, by key (null: nothing shown). Reads during render
 * and records once the render has committed, so rendering itself writes nothing.
 */
export function useSinceLastVisit(shown: Record<string, number | null>): Record<string, VisitDelta | null> {
  const now = Date.now() / 1000;
  const signature = JSON.stringify(shown);
  useEffect(() => {
    const t = Date.now() / 1000;
    for (const [key, value] of Object.entries(shown)) recordVisit(key, value, t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
  return Object.fromEntries(Object.entries(shown).map(([key, value]) => [key, sinceLastVisit(key, value, now)]));
}
