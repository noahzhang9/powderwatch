/**
 * Daily series ↔ station files (public/data/obs/<id>.json, `StationFile` in src/lib/obs.ts), shared by
 * scripts/fetch-obs.ts and scripts/backfill-snodas.ts.
 */
import type { StationDef } from '../src/config/stations';
import type { StationFile } from '../src/lib/obs';
import { addDays } from '../src/lib/time';

export type Daily = Map<string, { depth?: number; swe?: number; newSnow?: number; tavg?: number }>;

export function setVal(d: Daily, date: string, key: 'depth' | 'swe' | 'newSnow' | 'tavg', v: number | null | undefined) {
  if (v == null || !Number.isFinite(v)) return;
  const e = d.get(date) ?? {};
  e[key] = v;
  d.set(date, e);
}

export function fromFile(f: StationFile): Daily {
  const d: Daily = new Map();
  const put = (arr: (number | null)[] | null | undefined, key: 'depth' | 'swe' | 'newSnow' | 'tavg') =>
    arr?.forEach((v, i) => {
      if (v == null) return;
      const date = new Date(Date.parse(`${f.start}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10);
      setVal(d, date, key, v);
    });
  put(f.depthCm, 'depth');
  put(f.sweMm, 'swe');
  put(f.newSnowCm, 'newSnow');
  put(f.tavgC, 'tavg');
  return d;
}

/** The station file for a non-empty daily series. */
export function toFile(st: Pick<StationDef, 'id'>, d: Daily): StationFile {
  const dates = [...d.keys()].sort();
  const withDepth = dates.filter((x) => d.get(x)!.depth != null);
  const withSwe = dates.filter((x) => d.get(x)!.swe != null);
  const start = [withDepth[0], withSwe[0]].filter(Boolean).sort()[0] ?? dates[0];
  const end = dates[dates.length - 1];
  const n = Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000) + 1;
  const depthCm: (number | null)[] = new Array(n).fill(null);
  const sweMm: (number | null)[] = new Array(n).fill(null);
  const newSnowCm: (number | null)[] = new Array(n).fill(null);
  const tavgC: (number | null)[] = new Array(n).fill(null);
  for (const [date, v] of d) {
    const i = Math.round((Date.parse(date) - Date.parse(start)) / 86_400_000);
    if (i < 0 || i >= n) continue;
    if (v.depth != null) depthCm[i] = Math.round(v.depth * 10) / 10;
    if (v.swe != null) sweMm[i] = Math.round(v.swe * 10) / 10;
    if (v.newSnow != null) newSnowCm[i] = Math.round(v.newSnow * 10) / 10;
    if (v.tavg != null) tavgC[i] = Math.round(v.tavg * 10) / 10;
  }
  return {
    id: st.id,
    updated: new Date().toISOString(),
    start,
    depthCm,
    sweMm: withSwe.length ? sweMm : null,
    newSnowCm: newSnowCm.some((x) => x != null) ? newSnowCm : null,
    // Only files with temperatures carry the key, so every other file stays byte for byte as it was.
    ...(tavgC.some((x) => x != null) ? { tavgC } : {}),
    lastDepthDate: withDepth[withDepth.length - 1] ?? null,
    lastSweDate: withSwe[withSwe.length - 1] ?? null,
  };
}

/** Same readings, ignoring the fetch time (a write that would change only `updated` is skipped). */
export const sameData = (a: StationFile | null, b: StationFile) => a != null && JSON.stringify({ ...a, updated: '' }) === JSON.stringify({ ...b, updated: '' });

/**
 * Does `previous` hold `fetched`'s readings one day early? That is how SNOTEL files were dated before
 * scripts/fetch-obs.ts asked AWDB for periodRef=START. Counts, over both depth and SWE, the fetched readings that
 * `previous` has on the same date and those it has on the day before. Only days when a reading changed tell the
 * two apart, so a window without one (snow-free all along) is never judged early.
 */
export function datedADayEarly(previous: Daily, fetched: Daily): boolean {
  const near = (a: number | undefined, b: number) => a != null && Math.abs(a - b) < 0.05; // files keep 0.1 cm / 0.1 mm
  let same = 0;
  let early = 0;
  for (const [date, v] of fetched) {
    for (const key of ['depth', 'swe'] as const) {
      const x = v[key];
      if (x == null) continue;
      const r = Math.round(x * 10) / 10;
      if (near(previous.get(date)?.[key], r)) same++;
      if (near(previous.get(addDays(date, -1))?.[key], r)) early++;
    }
  }
  return early > same;
}
