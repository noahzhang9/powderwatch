/**
 * Forecast-verification archive: a compact record of what the forecasts said for local days 1–10, built from
 * responses the snapshot has already fetched (no extra Open-Meteo calls). Pure (no I/O), so tests can
 * build records from canned responses.
 *
 * One record per global cycle (00Z/12Z, from the model catalogue's full-length runs): every snapshot run
 * builds the record for the newest cycle that the global models every resort shows carry, and the workflow's
 * `archive` job keeps only the first one it sees for each cycle (it never overwrites a file). So the
 * archived record comes from the first snapshot run that carried the cycle.
 *
 * Contents, per resort: the mid band (blend, each model, ensembles, and NOAA NBM's own product at US
 * resorts) and each station's own point (each scenario model, ensembles) where the snapshot holds the
 * Snowpack tab's station-point requests. Snow, rain
 * and snow level go through the same physics as the site (`deriveModel`, `deriveMembers`), and days use
 * `forecast.toDaily`'s convention. Stored metric: cm, mm, °C, m; chances 0–1.
 *
 * scripts/validate_verification.py validates and re-serialises these files before they are committed to the
 * `data/verification` branch; keep the two in step (scripts/verification.test.ts runs the validator on a record).
 */
import { ENSEMBLES, MODELS, NBM } from '../src/config/models';
import { RESORTS, type Resort } from '../src/config/resorts';
import { stationsFor, type StationDef } from '../src/config/stations';
import {
  CHANCE_HORIZONS_H, CHANCE_THRESHOLDS_CM, alignMembers, deriveMembers, probabilityAtLeast, windowQuantiles, windowTotals,
  type MemberSeries,
} from '../src/lib/ensemble';
import { nbmDaily } from '../src/lib/benchmarks';
import { nonNegativePrecip } from '../src/lib/physics';
import { blend, dailyCentres, deriveModel, toDaily, type DailyRow, type DerivedHourly } from '../src/lib/forecast';
import type { StationFile } from '../src/lib/obs';
import {
  PREVIOUS_RUN_LEADS, ensembleUrl, nbmUrl, parseEnsemble, parseNbm, parsePreviousRuns, parseProfiles, parseSurface, profileUrl, type OmResponse,
  type Point, type Profiles, type RunMeta,
} from '../src/lib/openmeteo';
import { SCENARIO_MODELS, hasData, metaIdOf, midBand, pointOf } from '../src/lib/requests';
import { round } from '../src/lib/stats';
import { addDays, localDate, localMidnightUnix } from '../src/lib/time';
import type { WpcCategory, WpcFile, WpcPeriod } from '../src/lib/wpc';
import { midSurfaceUrl, servedDates, snowpackRequests } from './snapshot-plan';

export const RECORD_VERSION = 1;
/** Local days 1–10 after the cycle. */
export const RECORD_DAYS = 10;
/** The "Chance of snow totals" thresholds in the default (imperial) units, cm. */
export const RECORD_THRESHOLDS_CM = [...CHANCE_THRESHOLDS_CM.imperial];
/** Multi-day windows from the start of day 1, as in the "Chance of snow totals" table. */
export const RECORD_WINDOWS_D = CHANCE_HORIZONS_H.map((h) => h / 24);

/**
 * Global models that define a cycle: those every resort shows. A global model that only some resorts show
 * stays out, so a slow one (JMA's GSM is available about 9.5 h after its start) can't hold every resort's
 * record back; the record still holds its latest run, with that run's time in `runs`.
 */
export const cycleModels = (resorts: Resort[] = RESORTS) =>
  resorts.map((r) => r.models.filter((id) => MODELS[id]?.kind === 'global')).reduce((a, b) => a.filter((id) => b.includes(id)));
/** UTC hours of the full-length cycles all of `models` run (the catalogue's `historyRunsUtc`). */
export const cycleHours = (models: string[]) => models.map((id) => MODELS[id].historyRunsUtc).reduce((a, b) => a.filter((h) => b.includes(h)));
export const CYCLE_MODELS = cycleModels();
export const CYCLE_HOURS = cycleHours(CYCLE_MODELS);

/** Latest full-length cycle time at or before `initUnix`. */
export function cycleOf(initUnix: number, hours = CYCLE_HOURS): number {
  const day = Math.floor(initUnix / 86400) * 86400;
  let best = -Infinity;
  for (const d of [day, day - 86400]) for (const h of hours) if (d + h * 3600 <= initUnix) best = Math.max(best, d + h * 3600);
  return best;
}

export interface CycleChoice {
  /** Newest cycle (unix s) that every current cycle model has run. */
  cycleS: number;
  /** Cycle models without run metadata, or more than one cycle behind the newest: they don't hold the cycle back. */
  lagging: string[];
}

/**
 * The cycle this snapshot carries, from run metadata (by metaId). A model more than one cycle behind
 * the others (an outage) is left out so it cannot stall the archive; at least half must report.
 */
export function chooseCycle(meta: Record<string, RunMeta | null>, models = CYCLE_MODELS, hours = CYCLE_HOURS): CycleChoice | null {
  const spacing = 86400 / hours.length;
  const cycles = models.map((id) => {
    const init = meta[metaIdOf(id)]?.initUnix;
    return { id, c: init ? cycleOf(init, hours) : null };
  });
  const known = cycles.filter((x): x is { id: string; c: number } => x.c != null && Number.isFinite(x.c));
  if (known.length < Math.ceil(models.length / 2)) return null;
  const lead = Math.max(...known.map((x) => x.c));
  const current = known.filter((x) => x.c >= lead - spacing);
  const ids = new Set(current.map((x) => x.id));
  return { cycleS: Math.min(...current.map((x) => x.c)), lagging: models.filter((id) => !ids.has(id)) };
}

/** '2026-11-20T00Z': the record's name and `cycle`. */
export const cycleName = (cycleS: number) => `${new Date(cycleS * 1000).toISOString().slice(0, 13)}Z`;
/** '2026-11-20T06:00Z' */
export const runName = (unix: number) => `${new Date(unix * 1000).toISOString().slice(0, 16)}Z`;

/** Day 1: the first local day that starts at or after the cycle time. */
export function firstDay(cycleS: number, tz: string): string {
  const d0 = localDate(cycleS, tz);
  return localMidnightUnix(d0, tz) >= cycleS ? d0 : addDays(d0, 1);
}

type Vals = (number | null)[];

/** Daily values, one per record day; null where the day isn't fully covered. */
export interface Fields {
  snow: Vals;
  precip: Vals;
  rain?: Vals;
  tmin: Vals;
  tmax: Vals;
  slmin?: Vals;
  slmax?: Vals;
  /** Blend only: forecast centres with ≥ 20 h of the day (the chart's confidence rule). */
  centres?: Vals;
}

export interface Quantiles {
  p10: Vals;
  p50: Vals;
  p90: Vals;
}

export interface EnsembleFields {
  /** Ensembles present (catalogue ids) and their total members. */
  ensembles: string[];
  members: number;
  /** Centres whose members cover each whole day. */
  centres: Vals;
  snow: Quantiles;
  precip: Quantiles;
  /** Chance of at least each of `thresholdsCm`, per day: [day][threshold]. */
  pge: Vals[];
  /** Windows of `RECORD_WINDOWS_D` days from the start of day 1: snowfall quantiles and chances ([window][threshold]). */
  win: { days: number[]; snow: Quantiles; pge: Vals[] };
}

export interface PointRecord {
  resort: string;
  kind: 'mid' | 'station';
  /** 'mid', or the station id. */
  id: string;
  lat: number;
  lon: number;
  elev: number;
  tz: string;
  days: string[];
  blend?: Fields;
  models: Record<string, Fields>;
  ens: EnsembleFields | null;
  /** Mid band of US resorts: NOAA NBM's own snowfall, precipitation, temperatures and snow level (no rain field). */
  nbm?: Fields;
  /**
   * Mid band of US resorts: WPC's Day 1–3 chance categories (0: < 10%, 1: 10–39%, 2: 40–69%, 3: ≥ 70%) for
   * ≥ 4/8/12 in, cat[day − 1][threshold], with each WPC day's 24 h period. As fetched in this run.
   */
  wpc?: { days: (WpcPeriod | null)[]; cat: (WpcCategory | null)[][] };
}

export type SkipReason = 'no-projection' | 'not-in-snapshot';

export interface VerificationRecord {
  v: typeof RECORD_VERSION;
  kind: 'cycle';
  cycle: string;
  /** When the snapshot run started. */
  generatedAt: string;
  thresholdsCm: number[];
  /** Latest run of every deterministic model, and of NOAA NBM, at snapshot time (null: no run metadata). */
  runs: Record<string, string | null>;
  /** Global models that didn't hold the cycle back (see chooseCycle). */
  lagging: string[];
  points: PointRecord[];
  /**
   * Stations without a station-point forecast in this snapshot: their latest reading is too old for a
   * projection (`no-projection`), or the run skipped or failed those requests (`not-in-snapshot`).
   */
  skipped: { resort: string; id: string; reason: SkipReason }[];
}

export interface RecordInput {
  /** Snapshot start, unix s. */
  nowS: number;
  /** Run metadata by metaId. */
  meta: Record<string, RunMeta | null>;
  obs: Record<string, StationFile | null>;
  /** A response the snapshot fetched successfully, parsed; undefined if it has none for this URL. */
  json: (url: string) => OmResponse | undefined;
  /** WPC chances fetched in this run (null: none). */
  wpc?: WpcFile | null;
  resorts?: Resort[];
}

const r1 = (v: number | null | undefined) => round(v, 1);
const r3 = (v: number | null | undefined) => round(v, 3);
const r0 = (v: number | null | undefined) => round(v, 0);

const midnight = (date: string, tz: string) => localMidnightUnix(date, tz);

const hoursIn = (date: string, tz: string) => (midnight(addDays(date, 1), tz) - midnight(date, tz)) / 3600;

/** Per-day fields from `toDaily` rows; a day counts only when every hour of it has data. */
function dailyFields(rows: DailyRow[], days: string[], tz: string, opts: { rain?: boolean; levels?: boolean } = {}): Fields {
  const by = new Map(rows.map((r) => [r.date, r]));
  const full = days.map((d) => {
    const r = by.get(d);
    return r && r.hours >= hoursIn(d, tz) ? r : null;
  });
  const col = (f: (r: DailyRow) => number | null, rnd = r1) => full.map((r) => (r ? rnd(f(r)) : null));
  const out: Fields = { snow: col((r) => r.snowCm), precip: col((r) => r.precipMm), tmin: col((r) => r.tMin), tmax: col((r) => r.tMax) };
  if (opts.rain !== false) out.rain = col((r) => r.rainMm);
  if (opts.levels !== false) {
    out.slmin = col((r) => r.snowLevelMin, r0);
    out.slmax = col((r) => r.snowLevelMax, r0);
  }
  return out;
}

function ensembleFields(time: number[], members: MemberSeries[], ids: string[], days: string[], tz: string): EnsembleFields | null {
  if (!members.length) return null;
  const quant = (): Quantiles => ({ p10: [], p50: [], p90: [] });
  const push = (q: Quantiles, v: (number | null)[]) => {
    q.p10.push(r1(v[0]));
    q.p50.push(r1(v[1]));
    q.p90.push(r1(v[2]));
  };
  const out: EnsembleFields = {
    ensembles: ids, members: members.length, centres: [], snow: quant(), precip: quant(), pge: [],
    win: { days: RECORD_WINDOWS_D, snow: quant(), pge: [] },
  };
  const chances = (ws: ReturnType<typeof windowTotals>) => RECORD_THRESHOLDS_CM.map((t) => r3(probabilityAtLeast(ws, t)));
  for (const d of days) {
    const from = midnight(d, tz);
    const to = midnight(addDays(d, 1), tz);
    const ws = windowTotals(time, members, from, to, 'snowCm');
    push(out.snow, windowQuantiles(ws, [0.1, 0.5, 0.9]));
    push(out.precip, windowQuantiles(windowTotals(time, members, from, to, 'precip'), [0.1, 0.5, 0.9]));
    out.pge.push(chances(ws));
    out.centres.push(ws.families.length);
  }
  for (const n of RECORD_WINDOWS_D) {
    const ws = windowTotals(time, members, midnight(days[0], tz), midnight(addDays(days[0], n), tz), 'snowCm');
    push(out.win.snow, windowQuantiles(ws, [0.1, 0.5, 0.9]));
    out.win.pge.push(chances(ws));
  }
  return out;
}

/** The ensembles among `urls` (in ENSEMBLES order) that the snapshot holds, aligned like the views' loadEnsembles. */
function loadMembers(json: RecordInput['json'], urls: string[], pt: Point) {
  const sets: MemberSeries[][] = [];
  const ids: string[] = [];
  urls.forEach((u, i) => {
    const d = json(u);
    if (!d) return;
    const e = parseEnsemble(d, ENSEMBLES[i].id, pt);
    if (!e.members.length) return;
    sets.push(deriveMembers(e));
    ids.push(ENSEMBLES[i].id);
  });
  return { ...alignMembers(sets), ids };
}

function modelFields(models: DerivedHourly[], days: string[], tz: string): Record<string, Fields> {
  return Object.fromEntries(models.map((m) => [m.model.id, dailyFields(toDaily(m, tz), days, tz)]));
}

/** Builds the record for the cycle this snapshot carries; null when the run metadata can't name one. */
export function buildVerificationRecord(input: RecordInput): VerificationRecord | null {
  const resorts = input.resorts ?? RESORTS;
  const cycleIds = cycleModels(resorts);
  const cycle = chooseCycle(input.meta, cycleIds, cycleHours(cycleIds));
  if (!cycle) return null;
  const points: PointRecord[] = [];
  const skipped: VerificationRecord['skipped'] = [];
  const allModels = [...new Set(resorts.flatMap((r) => r.models))];
  const runIds = [...allModels.map((id) => [id, metaIdOf(id)]), ...(resorts.some((r) => r.officialGuidance) ? [[NBM.id, NBM.metaId]] : [])];

  for (const r of resorts) {
    const day1 = firstDay(cycle.cycleS, r.tz);
    const days = Array.from({ length: RECORD_DAYS }, (_, i) => addDays(day1, i));
    const mid = midBand(r);
    const midPt = pointOf(mid);
    const profJson = input.json(profileUrl(midPt, r.models, r.tz));
    // One pressure profile per resort, at mid (as in the views): it gives every point's snow level.
    const profiles: Profiles | undefined = profJson ? parseProfiles(profJson, r.models) : undefined;
    const base = { resort: r.id, tz: r.tz, days };

    const midJson = input.json(midSurfaceUrl(r));
    if (midJson) {
      const models = parseSurface(midJson, r.models).filter(hasData).map((s) => deriveModel(s, profiles));
      const b = blend(models);
      const ens = loadMembers(input.json, ENSEMBLES.map((e) => ensembleUrl(midPt, e.id, r.tz)), midPt);
      const centres = dailyCentres(models, r.tz);
      const nbm = r.officialGuidance ? input.json(nbmUrl(midPt, r.tz)) : undefined;
      const nbmHourly = nbm ? parseNbm(nbm) : undefined;
      points.push({
        ...base, kind: 'mid', id: 'mid', lat: mid.lat, lon: mid.lon, elev: mid.elevation,
        blend: b ? { ...dailyFields(toDaily(b, r.tz), days, r.tz), centres: days.map((d) => centres.get(d) ?? 0) } : undefined,
        models: modelFields(models, days, r.tz),
        ens: ensembleFields(ens.time, ens.members, ens.ids, days, r.tz),
        ...(nbmHourly ? { nbm: dailyFields(nbmDaily({ ...nbmHourly, precip: nonNegativePrecip(nbmHourly.precip) }, r.tz), days, r.tz, { rain: false }) } : {}),
        ...(r.officialGuidance && input.wpc?.points[r.id] ? { wpc: { days: input.wpc.days, cat: input.wpc.points[r.id].cat } } : {}),
      });
    }

    for (const st of stationsFor(r.id)) {
      const file = input.obs[st.id] ?? null;
      // The Snowpack tab's requests for each local date the snapshot serves; the first one it holds wins.
      const reqs = servedDates(input.nowS, r.tz).map((d) => snowpackRequests(r, st, file, d)).filter((x) => x != null);
      const req = reqs.find((q) => input.json(q.scenario));
      if (!req) {
        skipped.push({ resort: r.id, id: st.id, reason: reqs.length ? 'not-in-snapshot' : 'no-projection' });
        continue;
      }
      const pt = pointOf(st);
      const models = parseSurface(input.json(req.scenario)!, SCENARIO_MODELS).filter(hasData).map((s) => deriveModel(s, profiles));
      const ens = loadMembers(input.json, req.ensembles, pt);
      points.push({
        ...base, kind: 'station', id: st.id, lat: st.lat, lon: st.lon, elev: st.elevation,
        models: modelFields(models, days, r.tz),
        ens: ensembleFields(ens.time, ens.members, ens.ids, days, r.tz),
      });
    }
  }

  return {
    v: RECORD_VERSION,
    kind: 'cycle',
    cycle: cycleName(cycle.cycleS),
    generatedAt: new Date(input.nowS * 1000).toISOString().replace(/\.\d+Z$/, 'Z'),
    thresholdsCm: RECORD_THRESHOLDS_CM.map((t) => round(t, 2)!),
    runs: Object.fromEntries(runIds.map(([id, metaId]) => {
      const init = input.meta[metaId]?.initUnix;
      return [id, init ? runName(init) : null];
    })),
    lagging: cycle.lagging,
    points,
    skipped,
  };
}

/** File name for a record: `<cycle>.json`. */
export const recordFileName = (rec: Pick<VerificationRecord, 'cycle'>) => `${rec.cycle}.json`;

// ---------------------------------------------------------------- one-time backfill (Previous Runs API)

/** Daily values by lead offset (index 0 = forecast 1 day ahead); no snow level (the backfill has no profiles). */
export type LeadFields = Pick<Fields, 'snow' | 'precip' | 'rain' | 'tmin' | 'tmax'>;

/**
 * Backfill record for one valid local date: what each scenario model forecast for that day 1–7 days
 * ahead, at each station's own point. Not the same as a cycle record: each hour comes from whichever run
 * was 24 h × lead before it, so a day mixes runs; there are no ensembles and no snow level.
 */
export interface BackfillRecord {
  v: typeof RECORD_VERSION;
  kind: 'backfill';
  date: string;
  generatedAt: string;
  source: 'open-meteo-previous-runs';
  leads: number[];
  points: (Omit<PointRecord, 'days' | 'blend' | 'models' | 'ens' | 'kind'> & { kind: 'station'; models: Record<string, LeadFields> })[];
}

export function buildBackfillRecords(input: {
  generatedAtS: number;
  dates: string[];
  stations: { resort: Resort; station: StationDef; json: OmResponse }[];
}): BackfillRecord[] {
  const byDate = new Map<string, BackfillRecord['points']>(input.dates.map((d) => [d, []]));
  for (const { resort: r, station: st, json } of input.stations) {
    const models: Record<string, Record<string, LeadFields>> = Object.fromEntries(input.dates.map((d) => [d, {}]));
    for (const lead of PREVIOUS_RUN_LEADS) {
      for (const m of parsePreviousRuns(json, SCENARIO_MODELS, lead).filter(hasData).map((s) => deriveModel(s))) {
        const rows = toDaily(m, r.tz);
        input.dates.forEach((d) => {
          const f = dailyFields(rows, [d], r.tz, { levels: false });
          const at = (models[d][m.model.id] ??= {
            snow: Array(PREVIOUS_RUN_LEADS.length).fill(null), precip: Array(PREVIOUS_RUN_LEADS.length).fill(null),
            rain: Array(PREVIOUS_RUN_LEADS.length).fill(null), tmin: Array(PREVIOUS_RUN_LEADS.length).fill(null),
            tmax: Array(PREVIOUS_RUN_LEADS.length).fill(null),
          });
          for (const k of ['snow', 'precip', 'rain', 'tmin', 'tmax'] as const) at[k]![lead - 1] = f[k]![0];
        });
      }
    }
    for (const d of input.dates) {
      const ms = Object.fromEntries(Object.entries(models[d]).filter(([, f]) => f.precip.some((v) => v != null)));
      if (!Object.keys(ms).length) continue;
      byDate.get(d)!.push({ resort: r.id, kind: 'station', id: st.id, lat: st.lat, lon: st.lon, elev: st.elevation, tz: r.tz, models: ms });
    }
  }
  const generatedAt = new Date(input.generatedAtS * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
  return [...byDate].filter(([, pts]) => pts.length).map(([date, points]) => ({
    v: RECORD_VERSION, kind: 'backfill', date, generatedAt, source: 'open-meteo-previous-runs', leads: PREVIOUS_RUN_LEADS, points,
  }));
}
