/**
 * Open-Meteo API access (forecast, ensemble, single-run archive, run metadata).
 * Free tier, CORS-enabled, no key. https://open-meteo.com/en/docs — non-commercial use, < 10k calls/day.
 *
 * The URL builders below are pure and shared with scripts/snapshot-forecasts.ts:
 * the snapshot is keyed by the exact URL the browser builds, so both sides must
 * build it the same way. `cachedJson` serves a URL from the snapshot when it is
 * fresh and calls Open-Meteo directly otherwise.
 */
import { cachedJson, type Priority } from './cache';
import type { ProfileLevel } from './physics';
import type { Series } from './stats';

export type { Series };

export const FORECAST = 'https://api.open-meteo.com/v1/forecast';
export const ENSEMBLE = 'https://ensemble-api.open-meteo.com/v1/ensemble';
export const SINGLE_RUN = 'https://single-runs-api.open-meteo.com/v1/forecast';
export const META = 'https://api.open-meteo.com/data';

const FORECAST_TTL = 30 * 60;
const META_TTL = 10 * 60;

export interface Point {
  lat: number;
  lon: number;
  /** Elevation for statistical downscaling of temperature/humidity, m. */
  elevation: number;
}

/** Raw hourly surface fields for one model at one point. */
export interface SurfaceHourly {
  modelId: string;
  time: number[];
  tC: Series;
  rh: Series;
  precip: Series;
  /** Open-Meteo's own snowfall (fixed 7:1 ratio), cm — kept for comparison only. */
  omSnowCm: Series;
  fzl: Series;
  wind: Series;
  gust: Series;
  windDir: Series;
}

const SURFACE_VARS = [
  'temperature_2m', 'relative_humidity_2m', 'precipitation', 'snowfall',
  'freezing_level_height', 'wind_speed_10m', 'wind_gusts_10m', 'wind_direction_10m',
];
const SINGLE_RUN_VARS = ['temperature_2m', 'relative_humidity_2m', 'precipitation', 'freezing_level_height'];
const ENSEMBLE_VARS = ['precipitation', 'temperature_2m', 'relative_humidity_2m', 'freezing_level_height'];

export const PRESSURE_LEVELS = [1000, 925, 850, 800, 700, 600, 500];
const PROFILE_VARS = PRESSURE_LEVELS.flatMap((p) => [
  `temperature_${p}hPa`, `relative_humidity_${p}hPa`, `geopotential_height_${p}hPa`,
]);

export interface OmResponse {
  hourly: Record<string, Series | number[]>;
  elevation?: number;
  latitude?: number;
  longitude?: number;
}

function qs(params: Record<string, string | number | undefined>): string {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');
}

/** Multi-model responses suffix keys with `_<model>`; single-model ones don't. */
function pick(h: OmResponse['hourly'], variable: string, modelId: string, multi: boolean): Series {
  const v = (multi ? h[`${variable}_${modelId}`] : h[variable]) ?? h[`${variable}_${modelId}`];
  return (v as Series | undefined) ?? [];
}

export interface SurfaceOpts {
  pastDays?: number;
  forecastDays?: number;
}

/** Deterministic surface forecast for several models at one point. */
export function surfaceUrl(pt: Point, modelIds: string[], tz: string, opts: SurfaceOpts = {}): string {
  return `${FORECAST}?${qs({
    latitude: pt.lat, longitude: pt.lon, elevation: pt.elevation,
    hourly: SURFACE_VARS.join(','), models: modelIds.join(','),
    forecast_days: opts.forecastDays ?? 16, past_days: opts.pastDays,
    timezone: tz, timeformat: 'unixtime',
  })}`;
}

/** One run of a single model, identified by its initialisation time. */
export function singleRunUrl(pt: Point, modelId: string, runUnix: number, tz: string, forecastDays = 16): string {
  const run = new Date(runUnix * 1000).toISOString().slice(0, 16);
  return `${SINGLE_RUN}?${qs({
    latitude: pt.lat, longitude: pt.lon, elevation: pt.elevation,
    hourly: SINGLE_RUN_VARS.join(','),
    models: modelId, run, forecast_days: forecastDays, timezone: tz, timeformat: 'unixtime',
  })}`;
}

/** Pressure-level profile (no elevation: levels are absolute). */
export function profileUrl(pt: Omit<Point, 'elevation'>, modelIds: string[], tz: string): string {
  return `${FORECAST}?${qs({
    latitude: pt.lat, longitude: pt.lon,
    hourly: PROFILE_VARS.join(','), models: modelIds.join(','),
    forecast_days: 16, timezone: tz, timeformat: 'unixtime',
  })}`;
}

/** All members of one ensemble at one point. */
/**
 * `withFreezingLevel: false` drops freezing_level_height (about a quarter of
 * the request's weighted cost); the snowpack projection doesn't use it.
 */
export function ensembleUrl(pt: Point, modelId: string, tz: string, opts: { pastDays?: number; withFreezingLevel?: boolean } = {}): string {
  const vars = opts.withFreezingLevel === false ? ENSEMBLE_VARS.filter((v) => v !== 'freezing_level_height') : ENSEMBLE_VARS;
  return `${ENSEMBLE}?${qs({
    latitude: pt.lat, longitude: pt.lon, elevation: pt.elevation,
    hourly: vars.join(','),
    models: modelId, forecast_days: 16, past_days: opts.pastDays, timezone: tz, timeformat: 'unixtime',
  })}`;
}

/** Run timing for one model (`metaId` from the model catalogue). */
export function runMetaUrl(metaId: string): string {
  return `${META}/${metaId}/static/meta.json`;
}

export function parseSurface(d: OmResponse, modelIds: string[]): SurfaceHourly[] {
  const multi = modelIds.length > 1;
  const time = d.hourly.time as number[];
  return modelIds.map((m) => ({
    modelId: m,
    time,
    tC: pick(d.hourly, 'temperature_2m', m, multi),
    rh: pick(d.hourly, 'relative_humidity_2m', m, multi),
    precip: pick(d.hourly, 'precipitation', m, multi),
    omSnowCm: pick(d.hourly, 'snowfall', m, multi),
    fzl: pick(d.hourly, 'freezing_level_height', m, multi),
    wind: pick(d.hourly, 'wind_speed_10m', m, multi),
    gust: pick(d.hourly, 'wind_gusts_10m', m, multi),
    windDir: pick(d.hourly, 'wind_direction_10m', m, multi),
  }));
}

export async function fetchSurface(
  pt: Point, modelIds: string[], tz: string, opts: SurfaceOpts & { priority?: Priority } = {},
): Promise<SurfaceHourly[]> {
  const url = surfaceUrl(pt, modelIds, tz, opts);
  return parseSurface(await cachedJson<OmResponse>(url, FORECAST_TTL, opts.priority ?? 'high'), modelIds);
}

/** One past (or the latest) run of a single model — immutable once complete. */
export async function fetchSingleRun(
  pt: Point, modelId: string, runUnix: number, tz: string, forecastDays = 16,
): Promise<SurfaceHourly> {
  const url = singleRunUrl(pt, modelId, runUnix, tz, forecastDays);
  const ageH = (Date.now() / 1000 - runUnix) / 3600;
  const d = await cachedJson<OmResponse>(url, ageH > 30 ? Infinity : FORECAST_TTL, 'low');
  const [s] = parseSurface(d, [modelId]);
  return s;
}

/** Pressure-level profile per hour for each model (used to compute freezing/snow level). */
export async function fetchProfiles(
  pt: Omit<Point, 'elevation'>, modelIds: string[], tz: string,
): Promise<Record<string, { time: number[]; levels: ProfileLevel[][] }>> {
  const d = await cachedJson<OmResponse>(profileUrl(pt, modelIds, tz), FORECAST_TTL, 'high');
  const multi = modelIds.length > 1;
  const time = d.hourly.time as number[];
  const out: Record<string, { time: number[]; levels: ProfileLevel[][] }> = {};
  for (const m of modelIds) {
    const t = PRESSURE_LEVELS.map((p) => pick(d.hourly, `temperature_${p}hPa`, m, multi));
    const rh = PRESSURE_LEVELS.map((p) => pick(d.hourly, `relative_humidity_${p}hPa`, m, multi));
    const z = PRESSURE_LEVELS.map((p) => pick(d.hourly, `geopotential_height_${p}hPa`, m, multi));
    out[m] = {
      time,
      levels: time.map((_, i) =>
        PRESSURE_LEVELS.flatMap((_p, k) => {
          const tv = t[k][i];
          const zv = z[k][i];
          return tv == null || zv == null ? [] : [{ z: zv, t: tv, rh: rh[k][i] ?? null }];
        }),
      ),
    };
  }
  return out;
}

export interface EnsembleHourly {
  modelId: string;
  /** Elevation the members were downscaled to, m. */
  elevation: number;
  time: number[];
  /** One entry per member (index 0 = control). */
  members: { precip: Series; tC: Series; rh: Series; fzl: Series }[];
}

export async function fetchEnsemble(
  pt: Point, modelId: string, tz: string, opts: { pastDays?: number; withFreezingLevel?: boolean } = {},
): Promise<EnsembleHourly> {
  const d = await cachedJson<OmResponse>(ensembleUrl(pt, modelId, tz, opts), FORECAST_TTL, 'low');
  const h = d.hourly;
  const keyFor = (v: string, member: number) => (member === 0 ? v : `${v}_member${String(member).padStart(2, '0')}`);
  const members: EnsembleHourly['members'] = [];
  for (let m = 0; m < 200; m++) {
    const precip = h[keyFor('precipitation', m)] as Series | undefined;
    if (!precip) {
      if (m === 0) continue; // some ensembles have no unsuffixed control
      break;
    }
    members.push({
      precip,
      tC: (h[keyFor('temperature_2m', m)] as Series) ?? [],
      rh: (h[keyFor('relative_humidity_2m', m)] as Series) ?? [],
      fzl: (h[keyFor('freezing_level_height', m)] as Series) ?? [],
    });
  }
  return { modelId, elevation: d.elevation ?? pt.elevation, time: h.time as number[], members };
}

export interface RunMeta {
  initUnix: number;
  availableUnix: number;
  updateIntervalSec: number;
}

interface OmMeta {
  last_run_initialisation_time: number;
  last_run_availability_time: number;
  update_interval_seconds: number;
}

export function parseRunMeta(d: OmMeta): RunMeta {
  return {
    initUnix: d.last_run_initialisation_time,
    availableUnix: d.last_run_availability_time,
    updateIntervalSec: d.update_interval_seconds,
  };
}

export async function fetchRunMeta(metaId: string): Promise<RunMeta | null> {
  try {
    return parseRunMeta(await cachedJson<OmMeta>(runMetaUrl(metaId), META_TTL, 'low'));
  } catch {
    return null;
  }
}
