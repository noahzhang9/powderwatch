/**
 * The forecast snapshot's request list: every Open-Meteo URL the first screens
 * request, in priority groups, plus Open-Meteo's cost for each request. Pure
 * (no I/O), so tests can compare it with the URLs the browser code requests.
 *
 * Not included, by design: Run-history past runs, and ensembles at base or
 * summit. Those are fetched live when a visitor opens them.
 */
import { ENSEMBLES } from '../src/config/models';
import { RESORTS, type Resort } from '../src/config/resorts';
import { stationsFor } from '../src/config/stations';
import { SNAPSHOT_INTERVAL_H, SNAPSHOT_MAX_AGE_S } from '../src/lib/cache';
import type { StationFile } from '../src/lib/obs';
import { ENSEMBLE, ensembleUrl, profileUrl, runMetaUrl, singleRunUrl, surfaceUrl, type RunMeta, type SurfaceHourly } from '../src/lib/openmeteo';
import {
  RECENT_DAYS, RECENT_SURFACE, SCENARIO_MODELS, defaultStationIndex, hasData, metaIdOf, midBand, pointOf, previousRun,
  projectionStart, runChangeModels, scenarioSurface, SNOWPACK_WITH_FREEZING_LEVEL,
} from '../src/lib/requests';
import { localDate } from '../src/lib/time';

/** Lower runs first and is the last to be dropped when the budget runs out. */
export const PRIORITY = {
  meta: 0,
  /** Dashboard and the storm tracker's first paint: mid-band surface + pressure profile. */
  firstPaint: 1,
  otherBands: 2,
  midEnsembles: 3,
  runChange: 4,
  recent: 5,
  /** Snowpack inputs at the station each resort's Snowpack tab opens by default. */
  snowpackDefault: 6,
  /** The same after local midnight, when the projection asks for one more past day. */
  snowpackDefaultNextDay: 7,
  snowpackOther: 8,
  snowpackOtherNextDay: 9,
} as const;

/**
 * Groups up to this priority are what a visit sees first (every band's forecast, mid ensembles, run change,
 * the default Snowpack station) or one click away (last 7 days, under the Storm tracker's "More detail").
 * A run's budget grows to fit them (see runBudget).
 */
export const FIRST_SCREENS = PRIORITY.snowpackDefaultNextDay;

/**
 * Open-Meteo free tier: < 10,000 weighted calls a day. The scheduled runs share about 7,500 of them
 * (runBudget can add a little), which leaves room for a push or manual run on the same day.
 */
export const DAILY_BUDGET = 7500;
export const RUNS_PER_DAY = 24 / SNAPSHOT_INTERVAL_H;
/** Each run's share. Beyond the first screens it buys other stations' snowpack inputs while it lasts. */
export const DEFAULT_MAX_COST = DAILY_BUDGET / RUNS_PER_DAY;
/** Ceiling for one run, even when the first screens cost more than that (a stop against config growth). */
export const HARD_MAX_COST = 2000;

export interface PlanGroup {
  priority: number;
  label: string;
  urls: string[];
}

export interface PlanInput {
  nowS: number;
  /** Station files by station id, as deployed with the site. */
  obs: Record<string, StationFile | null>;
  /** Run metadata by metaId. With `midSurface`, enables the run-change requests. */
  meta?: Record<string, RunMeta | null>;
  /** Parsed mid-band surface forecast per resort id (decides which models the run-change panel lists). */
  midSurface?: Record<string, SurfaceHourly[]>;
  /** How long the snapshot will be served; snowpack requests cover a local date change within it. */
  servedForS?: number;
  resorts?: Resort[];
}

/** Every run-metadata id a view requests (storm tracker: all models; run history: a subset). */
export const metaIdsFor = (resorts: Resort[] = RESORTS) => [...new Set(resorts.flatMap((r) => r.models.map(metaIdOf)))];

/** The storm tracker's surface request at mid-mountain (its default band). */
export const midSurfaceUrl = (r: Resort) => surfaceUrl(pointOf(midBand(r)), r.models, r.tz);

export function planSnapshot(input: PlanInput): PlanGroup[] {
  const resorts = input.resorts ?? RESORTS;
  const servedFor = input.servedForS ?? SNAPSHOT_MAX_AGE_S;
  const groups: PlanGroup[] = [];
  const add = (priority: number, label: string, urls: string[]) => groups.push({ priority, label, urls });

  add(PRIORITY.meta, 'run metadata', metaIdsFor(resorts).map(runMetaUrl));
  for (const r of resorts) {
    const mid = midBand(r);
    const midPt = pointOf(mid);
    add(PRIORITY.firstPaint, `${r.id}: mid surface + profile`, [midSurfaceUrl(r), profileUrl(midPt, r.models, r.tz)]);
    add(PRIORITY.otherBands, `${r.id}: other bands`, r.bands.filter((b) => b.key !== mid.key).map((b) => surfaceUrl(pointOf(b), r.models, r.tz)));
    add(PRIORITY.midEnsembles, `${r.id}: ensembles at mid`, ENSEMBLES.map((e) => ensembleUrl(midPt, e.id, r.tz)));

    const surface = input.midSurface?.[r.id];
    if (input.meta && surface) {
      const ids = runChangeModels(surface.filter(hasData).map((s) => s.modelId));
      add(PRIORITY.runChange, `${r.id}: run change`, ids.flatMap((id) => {
        const init = input.meta![metaIdOf(id)]?.initUnix;
        return init ? [singleRunUrl(midPt, id, previousRun(init), r.tz)] : [];
      }));
    }

    const stations = stationsFor(r.id);
    add(PRIORITY.recent, `${r.id}: last ${RECENT_DAYS} days`, [...stations, mid].map((p) => surfaceUrl(pointOf(p), r.models, r.tz, RECENT_SURFACE)));

    // Snowpack projection inputs at each station, for the local date now and, if it changes
    // while this snapshot is served, the next one (the projection then needs one more past day).
    const files = stations.map((s) => input.obs[s.id] ?? null);
    const dates = [...new Set([localDate(input.nowS, r.tz), localDate(input.nowS + servedFor, r.tz)])];
    const def = defaultStationIndex(files, dates[0]);
    stations.forEach((st, i) => {
      dates.forEach((today, k) => {
        const { stale, pastDays } = projectionStart(files[i], 'depthCm', today);
        if (stale) return;
        const pt = pointOf(st);
        const priority = (i === def ? PRIORITY.snowpackDefault : PRIORITY.snowpackOther) + k;
        add(priority, `${r.id}: snowpack ${st.id}${k ? ` (from ${today})` : ''}`, [
          ...ENSEMBLES.map((e) => ensembleUrl(pt, e.id, r.tz, { pastDays, withFreezingLevel: SNOWPACK_WITH_FREEZING_LEVEL })),
          surfaceUrl(pt, SCENARIO_MODELS, r.tz, scenarioSurface(pastDays)),
        ]);
      });
    });
  }

  // Priority order; a URL is kept only in the first group that asks for it.
  const seen = new Set<string>();
  return groups
    .sort((a, b) => a.priority - b.priority)
    .map((g) => ({ ...g, urls: g.urls.filter((u) => !seen.has(u) && seen.add(u)) }))
    .filter((g) => g.urls.length > 0);
}

const MEMBERS = new Map(ENSEMBLES.map((e) => [e.id, e.members]));

/**
 * Open-Meteo's charge for one request, in "API calls" (the free tier allows
 * < 10,000 a day): variables × models (× members for ensembles) / 10, scaled by
 * days / 14 beyond two weeks, minimum 1. Run metadata is a static file and free.
 * Same formula as the server's `calculateQueryWeight`; responses report it as X-RateLimit-Cost.
 */
export function estimateCost(url: string): number {
  const u = new URL(url);
  if (u.pathname.endsWith('/meta.json')) return 0;
  const vars = (u.searchParams.get('hourly') ?? '').split(',').filter(Boolean).length;
  const models = (u.searchParams.get('models') ?? '').split(',').filter(Boolean);
  const ensemble = url.startsWith(ENSEMBLE);
  const members = models.reduce((n, m) => n + (ensemble ? MEMBERS.get(m) ?? 1 : 1), 0);
  const days = Number(u.searchParams.get('forecast_days') ?? 7) + Number(u.searchParams.get('past_days') ?? 0);
  const v = (vars * members) / 10;
  return Math.max(1, v, (v * days) / 14);
}

export const groupCost = (g: PlanGroup) => g.urls.reduce((s, u) => s + estimateCost(u), 0);

export const firstScreenCost = (groups: PlanGroup[]) => groups.filter((g) => g.priority <= FIRST_SCREENS).reduce((s, g) => s + groupCost(g), 0);

/**
 * A run's budget: `maxCost`, raised to cover the first screens when they cost more, never above
 * HARD_MAX_COST. That happens on a run whose snapshot is still served after a resort's local
 * midnight, because it also carries the next day's snowpack inputs.
 */
export const runBudget = (groups: PlanGroup[], maxCost = DEFAULT_MAX_COST) =>
  Math.min(HARD_MAX_COST, Math.max(maxCost, firstScreenCost(groups)));

/** Keeps whole groups in priority order while the estimated cost fits the budget. */
export function selectWithinBudget(groups: PlanGroup[], maxCost: number): { included: PlanGroup[]; skipped: PlanGroup[]; cost: number } {
  const included: PlanGroup[] = [];
  const skipped: PlanGroup[] = [];
  let cost = 0;
  for (const g of groups) {
    const c = groupCost(g);
    if (cost + c > maxCost) skipped.push(g);
    else {
      included.push(g);
      cost += c;
    }
  }
  return { included, skipped, cost };
}
