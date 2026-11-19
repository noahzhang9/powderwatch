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
  lastDepthDate: string | null;
  lastSweDate: string | null;
}

export type Variable = 'depthCm' | 'sweMm';
export type Series = 'depthCm' | 'sweMm' | 'newSnowCm';

const cache = new Map<string, Promise<StationFile | null>>();

export function loadStation(id: string): Promise<StationFile | null> {
  if (!cache.has(id)) {
    cache.set(
      id,
      fetch(`${import.meta.env.BASE_URL}data/obs/${id}.json`, { cache: 'no-cache' })
        .then((r) => (r.ok ? (r.json() as Promise<StationFile>) : null))
        .catch(() => null),
    );
  }
  return cache.get(id)!;
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
