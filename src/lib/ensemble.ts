/**
 * Multi-centre ensemble products: snowfall plumes, exceedance probabilities
 * and freezing-level risk. Every centre (family) gets equal weight; members
 * share their family's weight equally. Outputs are *model spread*, not
 * calibrated probabilities, until verified against observations.
 */
import { ENSEMBLES, type EnsembleDef } from '../config/models';
import type { EnsembleHourly } from './openmeteo';
import { nonNegativePrecip, splitPrecip } from './physics';
import { familyWeights, isNum, weightedQuantile, exceedance, type Series } from './stats';

export interface MemberSeries {
  def: EnsembleDef;
  member: number;
  time: number[];
  precip: Series;
  tC: Series;
  rh: Series;
  snowCm: Series;
  fzl: Series;
}

/** Moist-adiabatic-ish lapse rate used to estimate a freezing level from one temperature, °C/m. */
export const FALLBACK_LAPSE = 0.0065;

export function deriveMembers(ens: EnsembleHourly): MemberSeries[] {
  const def = ENSEMBLES.find((e) => e.id === ens.modelId)!;
  return ens.members.map((m, k) => ({
    def, member: k, time: ens.time, precip: nonNegativePrecip(m.precip), tC: m.tC, rh: m.rh,
    // Most ensembles publish no freezing level (and aren't asked for one, see `nativeFreezingLevel`):
    // estimate it from the member's own downscaled temperature.
    fzl: m.fzl.some(isNum) ? m.fzl : m.tC.map((t) => (t == null ? null : Math.max(0, ens.elevation + t / FALLBACK_LAPSE))),
    snowCm: m.precip.map((p, i) => {
      const t = m.tC[i];
      return p == null || t == null ? null : splitPrecip(p, t, m.rh[i] ?? 90).snowCm;
    }),
  }));
}

/** Align members from several ensembles onto one time axis (they share hourly steps). */
export function alignMembers(sets: MemberSeries[][]): { time: number[]; members: MemberSeries[] } {
  const all = sets.flat();
  if (!all.length) return { time: [], members: [] };
  const time = Array.from(new Set(all.flatMap((m) => m.time))).sort((a, b) => a - b);
  const index = new Map(time.map((t, i) => [t, i]));
  const reindex = (m: MemberSeries, s: Series): Series => {
    const out: Series = new Array(time.length).fill(null);
    m.time.forEach((t, i) => {
      out[index.get(t)!] = s[i] ?? null;
    });
    return out;
  };
  return {
    time,
    members: all.map((m) => ({
      ...m, time, precip: reindex(m, m.precip), tC: reindex(m, m.tC), rh: reindex(m, m.rh),
      snowCm: reindex(m, m.snowCm), fzl: reindex(m, m.fzl),
    })),
  };
}

/** Total of a member series over (from, to]; null unless the member covers the whole window. */
function memberWindow(time: number[], s: Series, from: number, to: number): number | null {
  let total = 0;
  let covered = false;
  for (let i = 0; i < time.length; i++) {
    if (time[i] <= from || time[i] > to) continue;
    if (!isNum(s[i])) return null;
    total += s[i] as number;
    covered = true;
  }
  // Require data through the end of the window.
  const lastT = time.filter((t, i) => t <= to && isNum(s[i])).pop();
  return covered && lastT != null && lastT >= to - 3600 ? total : null;
}

export interface WindowStats {
  values: (number | null)[];
  weights: number[];
  families: string[];
}

export function windowTotals(time: number[], members: MemberSeries[], from: number, to: number, key: 'snowCm' | 'precip' = 'snowCm'): WindowStats {
  const values = members.map((m) => memberWindow(time, m[key], from, to));
  const families = members.map((m) => m.def.family);
  const weights = familyWeights(families, values.map(isNum));
  return { values, weights, families: Array.from(new Set(families.filter((_, i) => isNum(values[i])))) };
}

export function probabilityAtLeast(ws: WindowStats, threshold: number): number | null {
  return exceedance(ws.values, ws.weights, threshold);
}

export function windowQuantiles(ws: WindowStats, qs: number[]): (number | null)[] {
  return qs.map((q) => weightedQuantile(ws.values, ws.weights, q));
}

export interface Plume {
  time: number[];
  p10: Series;
  p25: Series;
  p50: Series;
  p75: Series;
  p90: Series;
  families: number[];
}

/** Quantiles of cumulative snowfall since `fromUnix`, per hour. */
export function cumulativePlume(time: number[], members: MemberSeries[], fromUnix: number, key: 'snowCm' | 'precip' = 'snowCm', minFamilies = 3): Plume {
  const start = time.findIndex((t) => t > fromUnix);
  const t0 = start < 0 ? time.length : start;
  const cum = members.map((m) => {
    let acc = 0;
    let alive = true;
    return time.slice(t0).map((_, j) => {
      const v = m[key][t0 + j];
      if (!alive || !isNum(v)) {
        alive = false;
        return null;
      }
      acc += v;
      return acc;
    });
  });
  const fams = members.map((m) => m.def.family);
  const plume: Plume = { time: time.slice(t0), p10: [], p25: [], p50: [], p75: [], p90: [], families: [] };
  for (let j = 0; j < plume.time.length; j++) {
    const vals = cum.map((c) => c[j]);
    const present = vals.map(isNum);
    const w = familyWeights(fams, present);
    plume.p10.push(weightedQuantile(vals, w, 0.1));
    plume.p25.push(weightedQuantile(vals, w, 0.25));
    plume.p50.push(weightedQuantile(vals, w, 0.5));
    plume.p75.push(weightedQuantile(vals, w, 0.75));
    plume.p90.push(weightedQuantile(vals, w, 0.9));
    plume.families.push(new Set(fams.filter((_, i) => present[i])).size);
  }
  // Quantiles jump when a centre's members end; stop once fewer than `minFamilies` remain.
  const cut = plume.families.findIndex((n) => n < minFamilies);
  if (cut >= 0) {
    for (const k of ['time', 'p10', 'p25', 'p50', 'p75', 'p90', 'families'] as const) (plume[k] as unknown[]).length = cut;
  }
  return plume;
}

/** Weighted probability that the freezing level exceeds `heightM` at any hour in (from, to]. */
export function probabilityFzlAbove(time: number[], members: MemberSeries[], from: number, to: number, heightM: number): number | null {
  const hit = members.map((m) => {
    let any = false;
    let covered = false;
    for (let i = 0; i < time.length; i++) {
      if (time[i] <= from || time[i] > to) continue;
      const v = m.fzl[i];
      if (!isNum(v)) continue;
      covered = true;
      if (v > heightM) any = true;
    }
    return covered ? (any ? 1 : 0) : null;
  });
  const w = familyWeights(members.map((m) => m.def.family), hit.map(isNum));
  return exceedance(hit, w, 1);
}

// ---------------------------------------------------------------- "Chance of snow totals"

/** The "Chance of snow totals" table's thresholds, cm: whole inches in imperial units (the default), round centimetres in metric. */
export const CHANCE_THRESHOLDS_CM = {
  imperial: [1, 4, 8, 12, 20].map((x) => x * 2.54),
  metric: [2.5, 10, 20, 30, 50],
} as const;
/** The table's windows from now, hours. */
export const CHANCE_HORIZONS_H = [72, 168, 240];

// ---------------------------------------------------------------- per-day distributions

/** "Little or nothing" and "a real storm" thresholds for split-day detection, cm. */
export const SPLIT_LOW_CM = 2.5;
export const SPLIT_HIGH_CM = 15;
/** Both camps need at least this weighted share of members for a day to count as split. */
export const SPLIT_MIN_SHARE = 0.25;

export interface DayDist {
  p10: number | null;
  p50: number | null;
  p90: number | null;
  /** Weighted share of members at or below SPLIT_LOW_CM / at or above SPLIT_HIGH_CM. */
  pLow: number;
  pHigh: number;
  /** Median of the members in each camp. */
  lowMedian: number | null;
  highMedian: number | null;
  split: boolean;
  centres: number;
  members: number;
}

/**
 * Daily snowfall distribution across all ensemble members, by local date
 * (same day convention as forecast.toDaily: the value at hh:00 belongs to the
 * hour before it). A member counts for a day only if it covers ≥ 20 h of it.
 */
export function dailyDistributions(time: number[], members: MemberSeries[], dayOf: (unix: number) => string): Map<string, DayDist> {
  const days = new Map<string, number[]>();
  time.forEach((t, i) => {
    const d = dayOf(t - 3600);
    if (!days.has(d)) days.set(d, []);
    days.get(d)!.push(i);
  });
  const fams = members.map((m) => m.def.family);
  const out = new Map<string, DayDist>();
  for (const [date, idx] of days) {
    const vals = members.map((m) => {
      let s = 0;
      let n = 0;
      for (const i of idx) {
        const v = m.snowCm[i];
        if (isNum(v)) {
          s += v;
          n++;
        }
      }
      return n >= 20 ? s : null;
    });
    const present = vals.map(isNum);
    if (!present.some(Boolean)) continue;
    const w = familyWeights(fams, present);
    const total = w.reduce((a, b) => a + b, 0);
    const share = (pred: (v: number) => boolean) => vals.reduce<number>((s, v, i) => s + (isNum(v) && pred(v) ? w[i] : 0), 0) / total;
    const camp = (pred: (v: number) => boolean) => {
      const cv = vals.map((v) => (isNum(v) && pred(v) ? v : null));
      return weightedQuantile(cv, w, 0.5);
    };
    const pLow = share((v) => v <= SPLIT_LOW_CM);
    const pHigh = share((v) => v >= SPLIT_HIGH_CM);
    out.set(date, {
      p10: weightedQuantile(vals, w, 0.1),
      p50: weightedQuantile(vals, w, 0.5),
      p90: weightedQuantile(vals, w, 0.9),
      pLow,
      pHigh,
      lowMedian: camp((v) => v <= SPLIT_LOW_CM),
      highMedian: camp((v) => v >= SPLIT_HIGH_CM),
      split: pLow >= SPLIT_MIN_SHARE && pHigh >= SPLIT_MIN_SHARE,
      centres: new Set(fams.filter((_, i) => present[i])).size,
      members: present.filter(Boolean).length,
    });
  }
  return out;
}
