/**
 * "Since your last visit" deltas: remembers the value shown for a key and
 * reports the change against the previous visit (≥ 30 min earlier).
 */
interface Rec { t: number; v: number }
interface Store { cur: Rec; prev: Rec | null }

const PREFIX = 'pw-seen:';
const MIN_GAP_S = 30 * 60;

export function sinceLastVisit(key: string, value: number | null): { delta: number; sinceS: number } | null {
  if (value == null || !Number.isFinite(value)) return null;
  const now = Date.now() / 1000;
  let store: Store | null = null;
  try {
    const raw = JSON.parse(localStorage.getItem(PREFIX + key) ?? 'null');
    if (raw && typeof raw.cur?.t === 'number' && typeof raw.cur?.v === 'number') store = raw as Store;
  } catch {
    store = null;
  }
  let baseline: Rec | null = null;
  let next: Store;
  if (!store) next = { cur: { t: now, v: value }, prev: null };
  else if (now - store.cur.t >= MIN_GAP_S) {
    baseline = store.cur;
    next = { cur: { t: now, v: value }, prev: store.cur };
  } else {
    baseline = store.prev;
    next = { cur: { t: store.cur.t, v: value }, prev: store.prev };
  }
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(next));
  } catch {
    /* storage full or disabled */
  }
  return baseline ? { delta: value - baseline.v, sinceS: now - baseline.t } : null;
}
