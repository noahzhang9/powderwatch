/** Station observation files (written by scripts/fetch-obs.ts) and helpers. */
import { addDays } from './time';

export interface StationFile {
  id: string;
  /** ISO timestamp of the fetch. */
  updated: string;
  /** Date of index 0 in the daily arrays (YYYY-MM-DD). */
  start: string;
  depthCm: (number | null)[];
  sweMm: (number | null)[] | null;
  /** Measured new snow per day, where the source reports it (SLF, MeteoSwiss, some ECCC). */
  newSnowCm?: (number | null)[] | null;
  /**
   * Mean air temperature over the date (midnight to midnight, station time), °C, where the source reports it
   * (SNOTEL TAVG). Older files and other sources have none.
   */
  tavgC?: (number | null)[] | null;
  lastDepthDate: string | null;
  lastSweDate: string | null;
}

export type Variable = 'depthCm' | 'sweMm';
export type Series = 'depthCm' | 'sweMm' | 'newSnowCm' | 'tavgC';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (x: unknown): x is string => typeof x === 'string' && DATE.test(x);
const isSeries = (x: unknown): x is (number | null)[] =>
  Array.isArray(x) && x.every((v) => v === null || (typeof v === 'number' && Number.isFinite(v)));

/**
 * A station file's shape, checked like any untrusted input (the commit job's validator,
 * scripts/validate_obs.py, also bounds the values). Null if it isn't the file for `id`.
 */
export function parseStationFile(x: unknown, id: string): StationFile | null {
  if (typeof x !== 'object' || x == null) return null;
  const { id: fileId, updated, start, depthCm, sweMm = null, newSnowCm = null, tavgC = null, lastDepthDate = null, lastSweDate = null } =
    x as Record<string, unknown>;
  if (fileId !== id || typeof updated !== 'string' || !isDate(start) || !isSeries(depthCm)) return null;
  const sameLength = (v: unknown): v is (number | null)[] | null => v === null || (isSeries(v) && v.length === depthCm.length);
  if (!sameLength(sweMm) || !sameLength(newSnowCm) || !sameLength(tavgC)) return null;
  if ((lastDepthDate !== null && !isDate(lastDepthDate)) || (lastSweDate !== null && !isDate(lastSweDate))) return null;
  return { id, updated, start, depthCm, sweMm, newSnowCm, tavgC, lastDepthDate, lastSweDate };
}

const cache = new Map<string, Promise<StationFile | null>>();

/**
 * A station's file (null: none for this station). A missing or malformed file is remembered for
 * the page; a network or server error isn't, so the next use (a retry, another view) fetches again.
 */
export function loadStation(id: string): Promise<StationFile | null> {
  const hit = cache.get(id);
  if (hit) return hit;
  const p = fetch(`${import.meta.env.BASE_URL}data/obs/${id}.json`, { cache: 'no-cache' })
    .then(async (r) => {
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const text = await r.text();
      try {
        return parseStationFile(JSON.parse(text), id);
      } catch {
        return null; // not JSON (a dev server's HTML fallback): no file
      }
    })
    .catch(() => {
      cache.delete(id);
      return null;
    });
  cache.set(id, p);
  return p;
}

export function valueOn(f: StationFile, v: Series, date: string): number | null {
  const arr = f[v];
  if (!arr) return null;
  const i = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${f.start}T00:00:00Z`)) / 86_400_000);
  return i >= 0 && i < arr.length ? arr[i] : null;
}

export function dateAt(f: StationFile, i: number): string {
  return addDays(f.start, i);
}

/** Most recent non-null value of a variable. */
export function latest(f: StationFile, v: Variable): { date: string; value: number } | null {
  const arr = f[v];
  if (!arr) return null;
  for (let i = arr.length - 1; i >= 0; i--) {
    const x = arr[i];
    if (x != null) return { date: dateAt(f, i), value: x };
  }
  return null;
}
