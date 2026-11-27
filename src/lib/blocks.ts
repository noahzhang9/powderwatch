/**
 * A local day split into 3-hour blocks, for the Forecast tab's day breakdown and the 3-hourly CSV.
 *
 * Hourly values are hour-ending (the value stamped t covers t − 1 h to t), so a block (start, end] sums the
 * hours stamped after its start up to its end. A block's amounts need every hour present; a partial block
 * (the forecast's first or last hours) has no total.
 *
 * Open-Meteo spreads a coarser model's precipitation (3- or 6-hourly output: e.g. ECMWF AIFS, IFS beyond
 * about 6 days, JMA GSM) evenly over the hours it covers, so block sums stay right but the timing within
 * that model's step is unknown. Such a model is marked `coarse` in a block whose hours all carry the same
 * non-zero amount.
 */
import type { BandForecast } from '../hooks/data';
import { isNum, type Series } from './stats';
import { PHASE_BAND_M, type Phase } from './forecast';
import { windowQuantiles, windowTotals, type MemberSeries } from './ensemble';
import { addDays, localMidnightUnix } from './time';

export const BLOCK_H = 3;
/** A block with less blended precipitation than this is dry, mm (the daily rule uses 1 mm a day). */
export const BLOCK_DRY_MM = 0.5;
/** An hour wet enough to judge snow vs rain from the snow level, mm (as in dailyPhase). */
const WET_HOUR_MM = 0.3;
/** Equal hourly amounts above this (mm) mark a model's output in a block as spread from a coarser step. */
const COARSE_MIN_MM = 0.05;

export interface BlockModel {
  id: string;
  snowCm: number | null;
  /** The model's hours in this block all carry one spread value: its timing within the block is unknown. */
  coarse: boolean;
}

export interface Block {
  /** (start, end], unix seconds. */
  start: number;
  end: number;
  hours: number;
  snowCm: number | null;
  omSnowCm: number | null;
  rainMm: number | null;
  precipMm: number | null;
  tMin: number | null;
  tMax: number | null;
  snowLevelMin: number | null;
  snowLevelMax: number | null;
  gustMax: number | null;
  /** Rain or snow at this block's elevation, from the blend's snow level while precipitating. */
  phase: Phase;
  models: BlockModel[];
  /** Ensemble members' block totals (centre-weighted): null without ensembles or full coverage. */
  ens: { p10: number | null; p50: number | null; p90: number | null } | null;
}

const indicesIn = (time: number[], from: number, to: number) => time.flatMap((t, i) => (t > from && t <= to ? [i] : []));

/** Sum over the block's hours, or null when any hour is missing. */
function sumAll(s: Series, idx: number[]): number | null {
  if (!idx.length) return null;
  let total = 0;
  for (const i of idx) {
    if (!isNum(s[i])) return null;
    total += s[i] as number;
  }
  return total;
}

const extreme = (s: Series, idx: number[], pick: (a: number, b: number) => number) => {
  const v = idx.map((i) => s[i]).filter(isNum);
  return v.length ? v.reduce((a, b) => pick(a, b)) : null; // not reduce(pick): reduce also passes the index
};

function phaseAt(data: BandForecast, idx: number[], elevation: number): Phase {
  const b = data.blend;
  const total = idx.reduce((s, i) => s + (b.precip[i] ?? 0), 0);
  const wet = idx.filter((i) => (b.precip[i] ?? 0) >= WET_HOUR_MM && isNum(b.snowLevel[i]));
  if (total < BLOCK_DRY_MM || !wet.length) return 'dry';
  const kinds = new Set(wet.map((i) => {
    const sl = b.snowLevel[i]!;
    return elevation >= sl + PHASE_BAND_M ? 'snow' : elevation <= sl - PHASE_BAND_M ? 'rain' : 'mixed';
  }));
  return kinds.size === 1 ? ([...kinds][0] as Phase) : 'mixed';
}

/** The blocks of one local day (8, or 7/9 on a daylight-saving change), with the band's elevation for the phase. */
export function dayBlocks(
  data: BandForecast, date: string, tz: string, elevation: number,
  ens?: { time: number[]; members: MemberSeries[] } | null,
): Block[] {
  const start = localMidnightUnix(date, tz);
  const next = localMidnightUnix(addDays(date, 1), tz);
  const b = data.blend;
  const out: Block[] = [];
  for (let s = start; s < next; s += BLOCK_H * 3600) {
    const e = Math.min(s + BLOCK_H * 3600, next);
    const idx = indicesIn(b.time, s, e);
    const full = idx.length === (e - s) / 3600;
    const wetIdx = idx.filter((i) => (b.precip[i] ?? 0) >= WET_HOUR_MM);
    let ensQ: Block['ens'] = null;
    if (ens?.members.length && full) {
      const ws = windowTotals(ens.time, ens.members, s, e);
      const [p10, p50, p90] = windowQuantiles(ws, [0.1, 0.5, 0.9]);
      if (p50 != null) ensQ = { p10, p50, p90 };
    }
    out.push({
      start: s, end: e, hours: idx.length,
      snowCm: full ? sumAll(b.snowCm, idx) : null,
      omSnowCm: full ? sumAll(b.omSnowCm, idx) : null,
      rainMm: full ? sumAll(b.rainMm, idx) : null,
      precipMm: full ? sumAll(b.precip, idx) : null,
      tMin: extreme(b.tC, idx, Math.min),
      tMax: extreme(b.tC, idx, Math.max),
      snowLevelMin: extreme(b.snowLevel, wetIdx, Math.min),
      snowLevelMax: extreme(b.snowLevel, wetIdx, Math.max),
      gustMax: extreme(b.gust, idx, Math.max),
      phase: phaseAt(data, idx, elevation),
      models: data.models.map((m) => {
        const p = idx.map((i) => m.precip[i]);
        const coarse = idx.length > 1 && p.every((v) => isNum(v) && v > COARSE_MIN_MM && Math.abs(v - (p[0] as number)) < 1e-9);
        return { id: m.model.id, snowCm: full ? sumAll(m.snowCm, idx) : null, coarse };
      }),
      ens: ensQ,
    });
  }
  return out;
}

/** "12–3 AM", "9 AM–12 PM": a block's local clock span. */
export function blockLabel(start: number, end: number, tz: string): string {
  const parts = (t: number) => {
    const s = new Date(t * 1000).toLocaleString('en-US', { hour: 'numeric', timeZone: tz }); // "3 AM"
    const [h, ap] = s.split(' ');
    return { h, ap };
  };
  const a = parts(start);
  const z = parts(end);
  return a.ap === z.ap ? `${a.h}–${z.h} ${z.ap}` : `${a.h} ${a.ap}–${z.h} ${z.ap}`;
}

/** The block with the most snow (blend), if any block has a total. */
export function snowiestBlock(blocks: Block[], key: 'snowCm' | 'omSnowCm' = 'snowCm'): Block | null {
  return blocks.reduce<Block | null>((best, x) => ((x[key] ?? -1) > (best?.[key] ?? -1) ? x : best), null);
}

