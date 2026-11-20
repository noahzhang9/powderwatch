/**
 * Day-of-season climatology from a station's daily record.
 *
 * Season = Oct 1 → Jun 30, labelled by the year it starts ("2025" = 2025–26).
 * Day index k counts from Oct 1 on a 365-day calendar (Feb 29 is folded into
 * Feb 28) so every season has 273 comparable days. Only seasons with good
 * coverage of Nov–May contribute, and the current season never does.
 */
import { quantile, isNum } from './stats';
import { valueOn, type StationFile, type Variable } from './obs';

export const SEASON_DAYS = 273;
/**
 * A missing day takes the nearest reading within this many days (depth changes slowly), so a
 * gap of up to twice this many days is filled completely.
 */
export const GAP_FILL_DAYS = 2;
/**
 * A past season counts toward normals when at least this share of its Nov–May days has a value,
 * counted after gap-filling: a station reporting at least once every 2·GAP_FILL_DAYS + 1 days scores 100%.
 */
export const MIN_SEASON_COVERAGE = 0.8;
/** Percentile bands are smoothed with a running mean over ±this many days. */
export const SMOOTH_HALF_DAYS = 3;
const MONTH_DAYS = [31, 30, 31, 31, 28, 31, 30, 31, 30]; // Oct..Jun
const SEASON_MONTHS = [10, 11, 12, 1, 2, 3, 4, 5, 6];

/** ISO date for season day k of the season starting in `seasonYear`. */
export function seasonDate(seasonYear: number, k: number): string {
  let rem = k;
  for (let m = 0; m < MONTH_DAYS.length; m++) {
    if (rem < MONTH_DAYS[m]) {
      const month = SEASON_MONTHS[m];
      const year = month >= 10 ? seasonYear : seasonYear + 1;
      return `${year}-${String(month).padStart(2, '0')}-${String(rem + 1).padStart(2, '0')}`;
    }
    rem -= MONTH_DAYS[m];
  }
  return `${seasonYear + 1}-06-30`;
}

/** Season year and day index for a date; null for Jul–Sep. */
export function seasonIndex(iso: string): { season: number; k: number } | null {
  const [y, mo, d] = iso.split('-').map(Number);
  const mi = SEASON_MONTHS.indexOf(mo);
  if (mi < 0) return null;
  let k = 0;
  for (let m = 0; m < mi; m++) k += MONTH_DAYS[m];
  k += Math.min(d, MONTH_DAYS[mi]) - 1; // Feb 29 → Feb 28
  return { season: mo >= 10 ? y : y - 1, k };
}

export interface Climatology {
  variable: Variable;
  seasons: number[];
  min: (number | null)[];
  p10: (number | null)[];
  p25: (number | null)[];
  p50: (number | null)[];
  p75: (number | null)[];
  p90: (number | null)[];
  max: (number | null)[];
  /** Per-season values, for percentile ranks and season overlays. */
  bySeason: Map<number, (number | null)[]>;
}

/** Daily values of one season (a missing day takes the nearest reading within GAP_FILL_DAYS). */
export function seasonSeries(f: StationFile, v: Variable, season: number): (number | null)[] {
  const raw = Array.from({ length: SEASON_DAYS }, (_, k) => valueOn(f, v, seasonDate(season, k)));
  return raw.map((x, k) => {
    if (x != null) return x;
    for (let dk = 1; dk <= GAP_FILL_DAYS; dk++) {
      const a = raw[k - dk];
      const b = raw[k + dk];
      if (a != null) return a;
      if (b != null) return b;
    }
    return null;
  });
}

const smooth = (xs: (number | null)[], half = SMOOTH_HALF_DAYS) =>
  xs.map((_, i) => {
    const w = xs.slice(Math.max(0, i - half), i + half + 1).filter(isNum);
    return w.length ? w.reduce((s, x) => s + x, 0) / w.length : null;
  });

export function currentSeason(todayIso: string): number {
  const [y, m] = todayIso.split('-').map(Number);
  return m >= 7 ? y : y - 1;
}

export function buildClimatology(f: StationFile, v: Variable, todayIso: string, minCoverage = MIN_SEASON_COVERAGE): Climatology | null {
  if (!f[v]) return null;
  const first = seasonIndex(f.start);
  const firstSeason = first ? (first.k === 0 ? first.season : first.season + 1) : Number(f.start.slice(0, 4));
  const thisSeason = currentSeason(todayIso);
  const bySeason = new Map<number, (number | null)[]>();
  const used: number[] = [];
  const coreFrom = seasonIndex('2001-11-01')!.k;
  const coreTo = seasonIndex('2002-05-31')!.k;
  for (let s = Math.min(firstSeason, thisSeason); s <= thisSeason; s++) {
    const series = seasonSeries(f, v, s);
    bySeason.set(s, series);
    if (s === thisSeason) continue;
    const core = series.slice(coreFrom, coreTo + 1);
    if (core.filter(isNum).length / core.length >= minCoverage) used.push(s);
  }
  if (used.length === 0) return { variable: v, seasons: [], min: [], p10: [], p25: [], p50: [], p75: [], p90: [], max: [], bySeason };
  const col = (k: number) => used.map((s) => bySeason.get(s)![k]);
  const stat = (fn: (vals: (number | null)[]) => number | null) => smooth(Array.from({ length: SEASON_DAYS }, (_, k) => fn(col(k))));
  const finite = (vals: (number | null)[]) => vals.filter(isNum);
  return {
    variable: v,
    seasons: used,
    min: stat((x) => (finite(x).length ? Math.min(...finite(x)) : null)),
    p10: stat((x) => quantile(x, 0.1)),
    p25: stat((x) => quantile(x, 0.25)),
    p50: stat((x) => quantile(x, 0.5)),
    p75: stat((x) => quantile(x, 0.75)),
    p90: stat((x) => quantile(x, 0.9)),
    max: stat((x) => (finite(x).length ? Math.max(...finite(x)) : null)),
    bySeason,
  };
}

/** Percentile rank (0–100) of `value` among climatology seasons on day k (mid-rank for ties). */
export function percentileRank(c: Climatology, k: number, value: number): number | null {
  const vals = c.seasons.map((s) => c.bySeason.get(s)![k]).filter(isNum);
  if (vals.length < 5) return null;
  const below = vals.filter((x) => x < value).length;
  const equal = vals.filter((x) => x === value).length;
  return (100 * (below + 0.5 * equal)) / vals.length;
}

/**
 * First season day on which the median reaches `value` during accumulation.
 * Used for "typical depth for <date>" and "N days ahead/behind normal".
 */
export function typicalDayFor(c: Climatology, value: number): number | null {
  const peak = c.p50.reduce<number>((best, x, i) => (isNum(x) && x > (c.p50[best] ?? -1) ? i : best), 0);
  for (let k = 0; k <= peak; k++) {
    const x = c.p50[k];
    if (isNum(x) && x >= value) return k;
  }
  return null;
}
