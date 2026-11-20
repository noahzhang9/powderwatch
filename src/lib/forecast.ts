/**
 * Turns raw model output into comparable, elevation-specific products:
 * per-model hourly snow/rain, freezing and snow levels, local-day totals,
 * and a family-balanced multi-model blend.
 */
import { MODELS, type Family, type ModelDef } from '../config/models';
import { dailyDistributions, type MemberSeries } from './ensemble';
import { freezingLevel, nonNegativePrecip, snowLevel, snowLevelFromFreezingLevel, splitPrecip, type ProfileLevel } from './physics';
import { familyWeights, isNum, weightedMean, weightedQuantile, type Num, type Series } from './stats';
import type { SurfaceHourly } from './openmeteo';
import { localDate, localParts } from './time';

export interface DerivedHourly {
  model: ModelDef;
  time: number[];
  tC: Series;
  rh: Series;
  precip: Series;
  snowCm: Series;
  rainMm: Series;
  omSnowCm: Series;
  fzl: Series;
  fzlSource: 'model' | 'computed' | 'none';
  snowLevel: Series;
  gust: Series;
}

export interface DailyRow {
  date: string;
  /** Hours with data in this local day (24 = complete). */
  hours: number;
  snowCm: number | null;
  rainMm: number | null;
  precipMm: number | null;
  omSnowCm: number | null;
  tMin: number | null;
  tMax: number | null;
  fzlMin: number | null;
  fzlMax: number | null;
  snowLevelMin: number | null;
  snowLevelMax: number | null;
  gustMax: number | null;
}

type Profiles = Record<string, { time: number[]; levels: ProfileLevel[][] }>;

/** Derive one model's products at one elevation. */
export function deriveModel(raw: SurfaceHourly, profiles?: Profiles): DerivedHourly {
  const model = MODELS[raw.modelId];
  const n = raw.time.length;
  const snowCm: Series = new Array(n).fill(null);
  const rainMm: Series = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const p = raw.precip[i];
    const t = raw.tC[i];
    if (p == null || t == null) continue;
    const s = splitPrecip(p, t, raw.rh[i] ?? 90);
    snowCm[i] = s.snowCm;
    rainMm[i] = s.rainMm;
  }

  // Freezing level: prefer the model's own field; else compute from its pressure levels.
  const prof = profiles?.[raw.modelId];
  const profAt = (i: number): ProfileLevel[] | null => {
    if (!prof) return null;
    const j = prof.time === raw.time ? i : prof.time.indexOf(raw.time[i]);
    const lv = j >= 0 ? prof.levels[j] : null;
    return lv && lv.length >= 3 ? lv : null;
  };
  const nativeFzl = raw.fzl.some(isNum);
  let fzlSource: DerivedHourly['fzlSource'] = nativeFzl ? 'model' : 'none';
  const fzl: Series = raw.fzl.slice();
  const sl: Series = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const lv = profAt(i);
    if (!nativeFzl && lv) {
      fzl[i] = freezingLevel(lv);
      if (fzl[i] != null) fzlSource = 'computed';
    }
    sl[i] = lv ? snowLevel(lv) : snowLevelFromFreezingLevel(fzl[i]);
    // Only meaningful where the model has data at all.
    if (raw.precip[i] == null) {
      fzl[i] = null;
      sl[i] = null;
    }
  }

  return {
    model, time: raw.time, tC: raw.tC, rh: raw.rh, precip: nonNegativePrecip(raw.precip), snowCm, rainMm,
    omSnowCm: raw.omSnowCm, fzl, fzlSource, snowLevel: sl, gust: raw.gust,
  };
}

const sumOrNull = (vals: Num[]) => (vals.some(isNum) ? vals.reduce<number>((s, v) => s + (isNum(v) ? v : 0), 0) : null);
const minOrNull = (vals: Num[]) => {
  const v = vals.filter(isNum);
  return v.length ? Math.min(...v) : null;
};
const maxOrNull = (vals: Num[]) => {
  const v = vals.filter(isNum);
  return v.length ? Math.max(...v) : null;
};

/** Group hourly products into local calendar days. Precip at time t is the preceding hour's total. */
export function toDaily(d: Pick<DerivedHourly, 'time' | 'snowCm' | 'rainMm' | 'precip' | 'omSnowCm' | 'tC' | 'fzl' | 'snowLevel' | 'gust'>, tz: string): DailyRow[] {
  const groups = new Map<string, number[]>();
  d.time.forEach((t, i) => {
    // Shift by one hour so the 00:00 value (accumulated 23–24 h) counts for the previous day.
    const { date } = localParts(t - 3600, tz);
    if (!groups.has(date)) groups.set(date, []);
    groups.get(date)!.push(i);
  });
  const rows: DailyRow[] = [];
  for (const [date, idx] of groups) {
    const at = (s: Series) => idx.map((i) => s[i]);
    const hours = idx.filter((i) => isNum(d.precip[i])).length;
    rows.push({
      date, hours,
      snowCm: sumOrNull(at(d.snowCm)), rainMm: sumOrNull(at(d.rainMm)), precipMm: sumOrNull(at(d.precip)),
      omSnowCm: sumOrNull(at(d.omSnowCm)),
      tMin: minOrNull(at(d.tC)), tMax: maxOrNull(at(d.tC)),
      fzlMin: minOrNull(at(d.fzl)), fzlMax: maxOrNull(at(d.fzl)),
      snowLevelMin: minOrNull(at(d.snowLevel)), snowLevelMax: maxOrNull(at(d.snowLevel)),
      gustMax: maxOrNull(at(d.gust)),
    });
  }
  return rows;
}

export interface BlendHourly {
  time: number[];
  snowCm: Series;
  rainMm: Series;
  precip: Series;
  omSnowCm: Series;
  tC: Series;
  fzl: Series;
  snowLevel: Series;
  gust: Series;
  /** Spread across models: min / max of hourly snowfall. */
  snowMin: Series;
  snowMax: Series;
  /** Number of models contributing each hour. */
  count: number[];
}

/**
 * Family-balanced blend. Amounts (snow, rain) use the weighted mean so daily
 * and cumulative totals stay consistent; levels and temperatures use the
 * weighted median, which resists a single outlier model.
 */
export function blend(models: DerivedHourly[]): BlendHourly | null {
  if (!models.length) return null;
  const time = models[0].time;
  const fams = models.map((m) => m.model.family);
  const out: BlendHourly = {
    time, snowCm: [], rainMm: [], precip: [], omSnowCm: [], tC: [], fzl: [], snowLevel: [], gust: [], snowMin: [], snowMax: [], count: [],
  };
  for (let i = 0; i < time.length; i++) {
    const { present, w } = blendWeights(models, fams, i);
    const col = (k: keyof Pick<DerivedHourly, 'snowCm' | 'rainMm' | 'precip' | 'omSnowCm' | 'tC' | 'fzl' | 'snowLevel' | 'gust'>) =>
      models.map((m, j) => (present[j] ? m[k][i] : null));
    out.snowCm.push(weightedMean(col('snowCm'), w));
    out.rainMm.push(weightedMean(col('rainMm'), w));
    out.precip.push(weightedMean(col('precip'), w));
    out.omSnowCm.push(weightedMean(col('omSnowCm'), w));
    out.tC.push(weightedQuantile(col('tC'), w, 0.5));
    out.fzl.push(weightedQuantile(col('fzl'), w, 0.5));
    out.snowLevel.push(weightedQuantile(col('snowLevel'), w, 0.5));
    out.gust.push(weightedQuantile(col('gust'), w, 0.5));
    const s = col('snowCm').filter(isNum);
    out.snowMin.push(s.length ? Math.min(...s) : null);
    out.snowMax.push(s.length ? Math.max(...s) : null);
    out.count.push(present.filter(Boolean).length);
  }
  return out;
}

/** The blend's weights at hour i: which models have data, and each one's share of its centre's equal weight. */
function blendWeights(models: DerivedHourly[], fams: string[], i: number): { present: boolean[]; w: number[] } {
  const present = models.map((m) => isNum(m.precip[i]) && isNum(m.tC[i]));
  return { present, w: familyWeights(fams, present) };
}

/**
 * Each model's part of the blend's snowfall per local day, cm: its hourly snowfall times the weight the
 * blend gives it that hour, summed over the day (same day convention as toDaily). A day's parts add up
 * to the blend's daily snowfall.
 */
export function blendSnowParts(models: DerivedHourly[], tz: string): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  if (!models.length) return out;
  const fams = models.map((m) => m.model.family);
  models[0].time.forEach((t, i) => {
    const { present, w } = blendWeights(models, fams, i);
    // Normalise as weightedMean does, over the models whose snowfall is a number.
    const total = models.reduce((s, m, j) => s + (present[j] && isNum(m.snowCm[i]) ? w[j] : 0), 0);
    if (!(total > 0)) return;
    const { date } = localParts(t - 3600, tz);
    if (!out.has(date)) out.set(date, new Map());
    const day = out.get(date)!;
    models.forEach((m, j) => {
      const v = m.snowCm[i];
      if (present[j] && isNum(v)) day.set(m.model.id, (day.get(m.model.id) ?? 0) + (v * w[j]) / total);
    });
  });
  return out;
}

/** Sum of a series over [fromUnix, toUnix). */
export function windowSum(time: number[], s: Series, fromUnix: number, toUnix: number): number | null {
  let total = 0;
  let any = false;
  for (let i = 0; i < time.length; i++) {
    if (time[i] > fromUnix && time[i] <= toUnix && isNum(s[i])) {
      total += s[i] as number;
      any = true;
    }
  }
  return any ? total : null;
}

/** Last hour with data, unix seconds. */
export function lastValidTime(time: number[], s: Series): number | null {
  for (let i = s.length - 1; i >= 0; i--) if (isNum(s[i])) return time[i];
  return null;
}

// ---------------------------------------------------------------- confidence & phase

/** Days with fewer forecast centres than this are low confidence: outlined on the charts, and not judged by drivenDays. */
export const LOW_CENTRES = 3;

/** Number of forecast centres with ≥ 20 h of data on each local day. */
export function dailyCentres(models: DerivedHourly[], tz: string): Map<string, number> {
  const per = new Map<string, Set<string>>();
  for (const m of models) {
    for (const r of toDaily(m, tz)) {
      if (r.hours < 20) continue;
      if (!per.has(r.date)) per.set(r.date, new Set());
      per.get(r.date)!.add(m.model.family);
    }
  }
  return new Map([...per].map(([d, s]) => [d, s.size]));
}

export type Phase = 'snow' | 'mixed' | 'rain' | 'dry';

/** Transition half-width around the snow level, m: within it precipitation is mixed. */
export const PHASE_BAND_M = 150;

/**
 * Precipitation type at each elevation for each local day, from the blended
 * snow level during hours with precipitation (≥ 0.3 mm/h). Dry when the day's
 * blended precipitation is under 1 mm.
 */
export function dailyPhase(b: BlendHourly, tz: string, elevations: number[]): Map<string, Phase[]> {
  const days = new Map<string, number[]>();
  b.time.forEach((t, i) => {
    const { date } = localParts(t - 3600, tz);
    if (!days.has(date)) days.set(date, []);
    days.get(date)!.push(i);
  });
  const out = new Map<string, Phase[]>();
  for (const [date, idx] of days) {
    const total = idx.reduce((s, i) => s + (b.precip[i] ?? 0), 0);
    const wet = idx.filter((i) => (b.precip[i] ?? 0) >= 0.3 && isNum(b.snowLevel[i]));
    out.set(
      date,
      elevations.map((z) => {
        if (total < 1 || !wet.length) return 'dry';
        const kinds = new Set(wet.map((i) => {
          const sl = b.snowLevel[i]!;
          return z >= sl + PHASE_BAND_M ? 'snow' : z <= sl - PHASE_BAND_M ? 'rain' : 'mixed';
        }));
        return kinds.size === 1 ? ([...kinds][0] as Phase) : 'mixed';
      }),
    );
  }
  return out;
}

// ---------------------------------------------------------------- days one model drives

/** Smallest blended daily snowfall that can be flagged as driven by one model, cm (about 2 in). */
export const DRIVEN_MIN_CM = 5;
/** A forecast centre supplying more than this share of the blend's daily snowfall drives the day. */
export const DRIVEN_SHARE = 0.5;

/** 'one-centre': one forecast centre supplies more than DRIVEN_SHARE of the blend. 'above-ensemble': the blend is above the ensemble's 90th percentile. */
export type DrivenReason = 'one-centre' | 'above-ensemble';

export interface DrivenDay {
  /** The blend's snowfall that day, cm. */
  blendCm: number;
  reasons: DrivenReason[];
  /** 'one-centre': the centre, its share of the blend's snowfall, and its models, largest part first. */
  driver: { family: Family; share: number; models: ModelDef[] } | null;
  /** 'above-ensemble': the ensemble's (centre-weighted) 90th percentile for the day, which the blend exceeds. */
  ensP90: number | null;
}

/**
 * Local days whose blended snowfall rests on one model: at least DRIVEN_MIN_CM, a complete day (≥ 20 h),
 * and either one forecast centre supplies more than DRIVEN_SHARE of it, using the blend's own hourly
 * weights (only on days with at least LOW_CENTRES centres; fewer is already marked low confidence), or
 * the blend is above the ensemble's 90th percentile for the day (when at least LOW_CENTRES ensemble
 * centres cover it). The blend itself is unchanged: this only says when its mean is one model's number.
 */
export function drivenDays(
  data: { models: DerivedHourly[]; blendDaily: DailyRow[] },
  tz: string,
  ens?: { time: number[]; members: MemberSeries[] } | null,
): Map<string, DrivenDay> {
  const parts = blendSnowParts(data.models, tz);
  const centres = dailyCentres(data.models, tz);
  const dists = ens?.members.length ? dailyDistributions(ens.time, ens.members, (t) => localDate(t, tz)) : null;
  const out = new Map<string, DrivenDay>();
  for (const d of data.blendDaily) {
    const total = d.snowCm;
    if (total == null || total < DRIVEN_MIN_CM || d.hours < 20) continue;
    const reasons: DrivenReason[] = [];

    let driver: DrivenDay['driver'] = null;
    const byModel = parts.get(d.date);
    if (byModel && (centres.get(d.date) ?? 0) >= LOW_CENTRES) {
      const byFamily = new Map<Family, number>();
      for (const m of data.models) byFamily.set(m.model.family, (byFamily.get(m.model.family) ?? 0) + (byModel.get(m.model.id) ?? 0));
      const [family, cm] = [...byFamily].reduce((a, b) => (b[1] > a[1] ? b : a));
      if (cm > DRIVEN_SHARE * total) {
        const models = data.models
          .filter((m) => m.model.family === family && (byModel.get(m.model.id) ?? 0) > 0)
          .sort((a, b) => (byModel.get(b.model.id) ?? 0) - (byModel.get(a.model.id) ?? 0))
          .map((m) => m.model);
        driver = { family, share: cm / total, models };
        reasons.push('one-centre');
      }
    }

    const dist = dists?.get(d.date);
    const ensP90 = dist && dist.centres >= LOW_CENTRES && dist.p90 != null && total > dist.p90 ? dist.p90 : null;
    if (ensP90 != null) reasons.push('above-ensemble');

    if (reasons.length) out.set(d.date, { blendCm: total, reasons, driver, ensP90 });
  }
  return out;
}
