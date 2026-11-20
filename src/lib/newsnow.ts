/**
 * New snow estimated from SWE at SNOTEL stations, which measure snow depth and water (SWE) at midnight but not
 * new snow. Always an estimate: the UI labels it "estimated from SWE", with the station's name and elevation.
 *
 * Each report date D is the 24 h ending at the midnight that opens D (src/lib/recent.ts). With the water gained
 * ΔSWE = SWE(D) − SWE(D−1) and the depth change ΔHS = depth(D) − depth(D−1):
 *  - ΔSWE below MIN_SWE_GAIN_MM: no new snow. In mid-winter the pillow steps up and down by SNOTEL's 0.1 in about
 *    equally often, so single steps are mostly noise, and a depth rise without water is drift or sensor noise.
 *  - Water gained while depth fell: "rain or mixed", and no estimate.
 *  - Otherwise new snow ≈ max(ΔHS, ΔSWE × SLR), SLR being physics.ts's snow-to-liquid ratio at the station's mean
 *    temperature over those 24 h (TAVG of D−1), the forecasts' physics; DEFAULT_SLR when there is no temperature.
 *    The range scales SLR by SLR_RANGE.
 */
import type { StationDef } from '../config/stations';
import { MIN_SEASON_COVERAGE, currentSeason, seasonDate, seasonIndex } from './climatology';
import { valueOn, type StationFile } from './obs';
import type { Fmt } from './prefs';
import { snowToLiquidRatio } from './physics';
import { measuresNewSnow } from './recent';
import { quantile } from './stats';
import { addDays } from './time';

/** Smallest water gain (mm) that counts as new snow: two of SNOTEL's 0.1 in steps. */
export const MIN_SWE_GAIN_MM = 5;
/** The estimate's range: the snow-to-liquid ratio scaled by these factors. */
export const SLR_RANGE = { low: 0.8, high: 1.3 } as const;
/** Snow-to-liquid ratio for a day without a temperature reading. */
export const DEFAULT_SLR = 10;
/** Typical error of such an estimate in the Washington Cascades (%), for a single day and for a season. */
export const ESTIMATE_ERROR_PCT = { day: [30, 50], season: 25 } as const;
/** Fewest past seasons the Snowpack tab compares this season's estimate with. */
export const MIN_COMPARE_SEASONS = 5;

export type DayEstimate =
  | { kind: 'snow'; cm: number; lowCm: number; highCm: number; sweGainMm: number; depthChangeCm: number; slr: number; tavgC: number | null }
  | { kind: 'none' | 'rain-or-mixed'; sweGainMm: number; depthChangeCm: number };

/** One report date's estimate from the readings that open the day before and the day itself; null without all four. */
export function estimateDay(
  depth0: number | null, depth1: number | null, swe0: number | null, swe1: number | null, tavgC: number | null,
): DayEstimate | null {
  if (depth0 == null || depth1 == null || swe0 == null || swe1 == null) return null;
  const sweGainMm = swe1 - swe0;
  const depthChangeCm = depth1 - depth0;
  // Files keep 0.1 mm, so two 0.1 in steps can read 5.0 or 5.1 mm, and float subtraction a hair less.
  if (sweGainMm < MIN_SWE_GAIN_MM - 0.05) return { kind: 'none', sweGainMm, depthChangeCm };
  if (depthChangeCm < 0) return { kind: 'rain-or-mixed', sweGainMm, depthChangeCm };
  const slr = tavgC != null ? snowToLiquidRatio(tavgC) : DEFAULT_SLR;
  const at = (k: number) => Math.max(depthChangeCm, (sweGainMm * slr * k) / 10);
  return { kind: 'snow', cm: at(1), lowCm: at(SLR_RANGE.low), highCm: at(SLR_RANGE.high), sweGainMm, depthChangeCm, slr, tavgC };
}

/** Does the UI estimate new snow for this station? SNOTEL stations with SWE; never one that measures new snow. */
export function estimatesNewSnow(st: StationDef, f: StationFile): boolean {
  return st.source === 'SNOTEL' && st.swe && !st.modelled && f.sweMm != null && !measuresNewSnow(st, f);
}

/** The estimate for report date `date` (see the header). */
export function estimateOn(f: StationFile, date: string): DayEstimate | null {
  const prev = addDays(date, -1);
  return estimateDay(
    valueOn(f, 'depthCm', prev), valueOn(f, 'depthCm', date), valueOn(f, 'sweMm', prev), valueOn(f, 'sweMm', date),
    valueOn(f, 'tavgC', prev),
  );
}

export interface EstimateTotal {
  /** Estimated new snow, cm: central, low, high. Rain-or-mixed days add nothing. */
  cm: number;
  lowCm: number;
  highCm: number;
  /** Water gained on the days counted as snow, mm. */
  sweGainMm: number;
  /** Days in the span, and those with all the readings an estimate needs. */
  span: number;
  days: number;
  snowDays: number;
  rainOrMixedDays: number;
  /** Snow days without a temperature reading, which used DEFAULT_SLR. */
  defaultRatioDays: number;
}

/** Estimates summed over the report dates `from` … `to`. */
export function totalEstimate(f: StationFile, from: string, to: string): EstimateTotal {
  const t: EstimateTotal = { cm: 0, lowCm: 0, highCm: 0, sweGainMm: 0, span: 0, days: 0, snowDays: 0, rainOrMixedDays: 0, defaultRatioDays: 0 };
  for (let d = from; d <= to; d = addDays(d, 1)) {
    t.span++;
    const e = estimateOn(f, d);
    if (!e) continue;
    t.days++;
    if (e.kind === 'rain-or-mixed') t.rainOrMixedDays++;
    if (e.kind !== 'snow') continue;
    t.snowDays++;
    t.cm += e.cm;
    t.lowCm += e.lowCm;
    t.highCm += e.highCm;
    t.sweGainMm += e.sweGainMm;
    if (e.tavgC == null) t.defaultRatioDays++;
  }
  return t;
}

export interface SeasonEstimate {
  /** Season (by the year it starts) and the last report date counted. */
  season: number;
  through: string;
  total: EstimateTotal;
  /** Past seasons with readings on at least MIN_SEASON_COVERAGE of the same span, Oct 1 to the same date. */
  pastSeasons: number;
  /** Their medians (cm) of the central, low and high estimates; null with fewer than MIN_COMPARE_SEASONS of them. */
  pastMedian: { cm: number; lowCm: number; highCm: number } | null;
}

/**
 * This season's estimate from Oct 1 through the latest day with depth and SWE, and the median of the station's own
 * past seasons over the same span, each estimated by the same rule. Null without such a day this season.
 */
export function seasonEstimate(f: StationFile, today: string): SeasonEstimate | null {
  const last = [f.lastDepthDate, f.lastSweDate].every(Boolean) ? [f.lastDepthDate!, f.lastSweDate!].sort()[0] : null;
  const at = last ? seasonIndex(last) : null;
  if (!last || !at || at.season !== currentSeason(today)) return null;
  const total = totalEstimate(f, seasonDate(at.season, 0), last);
  const past: EstimateTotal[] = [];
  const firstSeason = Number(f.start.slice(0, 4)) - 1;
  for (let s = firstSeason; s < at.season; s++) {
    const t = totalEstimate(f, seasonDate(s, 0), seasonDate(s, at.k));
    if (t.days >= MIN_SEASON_COVERAGE * t.span) past.push(t);
  }
  const median = (k: 'cm' | 'lowCm' | 'highCm') => quantile(past.map((t) => t[k]), 0.5)!;
  return {
    season: at.season,
    through: last,
    total,
    pastSeasons: past.length,
    pastMedian: past.length >= MIN_COMPARE_SEASONS ? { cm: median('cm'), lowCm: median('lowCm'), highCm: median('highCm') } : null,
  };
}

/** Does any day of this file carry a mean temperature? */
export const hasTemperatures = (f: StationFile) => !!f.tavgC?.some((x) => x != null);

// ---------------------------------------------------------------- labels

/** "Stevens Pass SNOTEL, 1,200 m": how every estimate names its station. */
export const estimateWhere = (st: StationDef, fmt: Fmt) => `${st.name} SNOTEL, ${fmt.elev(st.elevation)}`;

/** What an estimate fell back to: no temperature in the file yet, or none on some days. */
export function ratioFallback(file: StationFile | null, t: EstimateTotal): string | null {
  if (file && !hasTemperatures(file)) return `This station's file has no temperatures yet, so every day uses ${DEFAULT_SLR}:1.`;
  if (t.defaultRatioDays) return `${t.defaultRatioDays === 1 ? 'One day' : `${t.defaultRatioDays} days`} without a temperature reading used ${DEFAULT_SLR}:1.`;
  return null;
}

/** One phrase for a span's estimate: "≈ 9–14 in new snow (estimated from 1.2 in water gained at …)". */
export function estimateText(t: EstimateTotal, st: StationDef, fmt: Fmt): string {
  return t.snowDays
    ? `≈ ${fmt.snowRange(t.lowCm, t.highCm)} new snow (estimated from ${fmt.water(t.sweGainMm)} water gained at ${estimateWhere(st, fmt)})`
    : `no new snow estimated from SWE at ${estimateWhere(st, fmt)}`;
}
