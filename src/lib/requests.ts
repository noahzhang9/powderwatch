/**
 * Which Open-Meteo requests each view makes: points, model lists and day
 * counts. The views and scripts/snapshot-forecasts.ts both build their
 * requests from these helpers and the URL builders in ./openmeteo, so the
 * snapshot holds exactly the URLs the browser asks for.
 */
import { HISTORY_MODELS, MODELS } from '../config/models';
import type { Band, Resort } from '../config/resorts';
import { latest, type StationFile, type Variable } from './obs';
import type { Point, SurfaceHourly, SurfaceOpts } from './openmeteo';
import { daysBetween } from './time';

/** Deterministic models run as single-model scenarios in the snowpack projection. */
export const SCENARIO_MODELS = ['ecmwf_ifs025', 'gfs_global', 'gem_global', 'icon_global', 'ecmwf_aifs025_single'];

/** Length of the "last N days, measured vs. modelled" panel. */
export const RECENT_DAYS = 7;
/**
 * That panel's surface request: one extra past day so the first 24 h window is complete.
 * It shows modelled snowfall only, so it asks for the physics inputs alone.
 */
export const RECENT_SURFACE: SurfaceOpts = { pastDays: RECENT_DAYS + 1, forecastDays: 1, forcingOnly: true };
/** The snowpack scenarios' surface request: the model runs only on precipitation, temperature and humidity. */
export const scenarioSurface = (pastDays: number): SurfaceOpts => ({ pastDays, forcingOnly: true });

/** The run-to-run panel compares each model's latest run with the run this much earlier. */
export const RUN_CHANGE_OFFSET_S = 12 * 3600;

/** A snowpack projection starts only from a reading at most this many days old. */
export const PROJECTION_MAX_AGE_DAYS = 5;
/** Stations that reported within this many days are preferred as the default. */
export const DEFAULT_STATION_MAX_AGE_DAYS = 3;

export const pointOf = (p: { lat: number; lon: number; elevation: number }): Point => ({ lat: p.lat, lon: p.lon, elevation: p.elevation });

/**
 * Mid-mountain band, the most representative elevation for a ski day: used by the dashboard,
 * the where-and-when grid and trips, the storm tracker's default, and the pressure-profile point.
 */
export const midBand = (r: Resort): Band => r.bands.find((b) => b.key === 'mid') ?? r.bands[0];

/** A model "has data" at a point when any hour has precipitation. */
export const hasData = (s: SurfaceHourly) => s.precip.some((v) => v != null);

export const metaIdOf = (modelId: string) => MODELS[modelId]?.metaId ?? modelId;

/** Global models the run-change panel compares, given the models with data at the band. */
export const runChangeModels = (modelsWithData: string[]) => HISTORY_MODELS.filter((id) => modelsWithData.includes(id));

/** The earlier run the run-change panel fetches for a model whose latest run started at `initUnix`. */
export const previousRun = (initUnix: number) => initUnix - RUN_CHANGE_OFFSET_S;

/**
 * Where a station's snowpack projection starts: its latest reading, whether
 * that reading is too old to project from, and how many past days of forcing
 * the projection requests (from the reading's day up to today).
 */
export function projectionStart(file: StationFile | null, v: Variable, today: string) {
  const last = file ? latest(file, v) : null;
  const stale = !last || daysBetween(last.date, today) > PROJECTION_MAX_AGE_DAYS;
  const pastDays = last && !stale ? Math.min(6, daysBetween(last.date, today) + 1) : 0;
  return { last, stale, pastDays };
}

/** Index of the station a view opens by default: the first (preference order) that reported recently. */
export function defaultStationIndex(files: (StationFile | null)[], today: string): number {
  const i = files.findIndex((f) => f?.lastDepthDate && daysBetween(f.lastDepthDate, today) <= DEFAULT_STATION_MAX_AGE_DAYS);
  return Math.max(0, i);
}

/** The snowpack projection doesn't use freezing level, so its ensemble requests leave it out (cheaper). */
export const SNOWPACK_WITH_FREEZING_LEVEL = false;
