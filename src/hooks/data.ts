/**
 * Data hooks that assemble API calls into derived forecast products.
 * The `load*` functions are the views' exact requests, kept outside React so
 * the snapshot tests can replay them.
 */
import { ENSEMBLES } from '../config/models';
import type { Band, Resort } from '../config/resorts';
import { alignMembers, deriveMembers, type MemberSeries } from '../lib/ensemble';
import { blend, deriveModel, toDaily, type BlendHourly, type DailyRow, type DerivedHourly } from '../lib/forecast';
import {
  fetchEnsemble, fetchProfiles, fetchRunMeta, fetchSingleRun, fetchSurface, type Point, type RunMeta, type SurfaceHourly,
} from '../lib/openmeteo';
import type { ProfileLevel } from '../lib/physics';
import { RECENT_SURFACE, SCENARIO_MODELS, hasData, metaIdOf, midBand, pointOf, previousRun } from '../lib/requests';
import { useMemo } from 'react';
import { useAsync } from './useAsync';

type Profiles = Record<string, { time: number[]; levels: ProfileLevel[][] }>;

export interface BandForecast {
  models: DerivedHourly[];
  daily: Record<string, DailyRow[]>;
  blend: BlendHourly;
  blendDaily: DailyRow[];
  /** Models requested but returning no data at this point. */
  missing: string[];
}

function buildBandForecast(resort: Resort, surface: SurfaceHourly[], profiles?: Profiles): BandForecast {
  const usable = surface.filter(hasData);
  const models = usable.map((x) => deriveModel(x, profiles));
  const b = blend(models)!;
  const daily: Record<string, DailyRow[]> = {};
  for (const m of models) daily[m.model.id] = toDaily(m, resort.tz);
  return {
    models,
    daily,
    blend: b,
    blendDaily: toDaily(b, resort.tz),
    missing: resort.models.filter((id) => !usable.some((u) => u.modelId === id)),
  };
}

export const loadBandSurface = (resort: Resort, band: Band) => fetchSurface(pointOf(band), resort.models, resort.tz);

/** One pressure-level profile per resort, at mid-mountain. */
export function loadProfiles(resort: Resort) {
  return fetchProfiles(pointOf(midBand(resort)), resort.models, resort.tz);
}

/**
 * Band forecast in two stages: models appear as soon as the surface request
 * returns; freezing level and snow level for models that don't publish them
 * fill in when the pressure-level profile arrives (one profile per resort).
 */
export function useBandForecast(resort: Resort, band: Band) {
  const surface = useAsync(() => loadBandSurface(resort, band), [resort.id, band.key]);
  const profiles = useAsync(() => loadProfiles(resort), [resort.id]);
  const data = useMemo(
    () => (surface.data ? buildBandForecast(resort, surface.data, profiles.data) : undefined),
    [surface.data, profiles.data, resort],
  );
  return { data, error: surface.error, loading: surface.loading, retry: surface.retry, levelsPending: !profiles.data && !profiles.error };
}

export interface EnsembleSet {
  time: number[];
  members: MemberSeries[];
  /** Ensembles that failed to load (rate limit, outage). */
  failed: string[];
}

export async function loadEnsembles(pt: Point, tz: string, pastDays?: number): Promise<EnsembleSet> {
  const results = await Promise.allSettled(ENSEMBLES.map((e) => fetchEnsemble(pt, e.id, tz, { pastDays })));
  const sets: MemberSeries[][] = [];
  const failed: string[] = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value.members.length) sets.push(deriveMembers(r.value));
    else failed.push(ENSEMBLES[i].label);
  });
  return { ...alignMembers(sets), failed };
}

export function useEnsembles(pt: Point | null, tz: string, enabled = true, pastDays?: number) {
  return useAsync(
    () => loadEnsembles(pt!, tz, pastDays),
    [pt?.lat, pt?.lon, pt?.elevation, tz, pastDays],
    enabled && pt != null,
  );
}

/** Latest-run timing per model id. */
export async function loadRunMeta(modelIds: string[]): Promise<Record<string, RunMeta | null>> {
  const out: Record<string, RunMeta | null> = {};
  await Promise.all(modelIds.map(async (id) => (out[id] = await fetchRunMeta(metaIdOf(id)))));
  return out;
}

export function useRunMeta(modelIds: string[]) {
  return useAsync(() => loadRunMeta(modelIds), [modelIds.join(',')]);
}

/** The run 12 h before each model's latest run, at a band (run-to-run panel). */
export async function loadRunChange(
  resort: Resort, band: Band, ids: string[], meta: Record<string, RunMeta | null> | undefined,
): Promise<Record<string, DerivedHourly | null>> {
  const out: Record<string, DerivedHourly | null> = {};
  await Promise.all(ids.map(async (id) => {
    const init = meta?.[id]?.initUnix;
    if (!init) return (out[id] = null);
    try {
      out[id] = deriveModel(await fetchSingleRun(pointOf(band), id, previousRun(init), resort.tz));
    } catch {
      out[id] = null;
    }
  }));
  return out;
}

export interface RecentModels {
  models: DerivedHourly[];
  blend: BlendHourly;
}

/** Short-range model output over the last days at a point (last-7-days panel). */
export async function loadRecentModels(pt: Point, resort: Resort): Promise<RecentModels | null> {
  const raw = await fetchSurface(pt, resort.models, resort.tz, { ...RECENT_SURFACE, priority: 'low' });
  const models = raw.filter(hasData).map((s) => deriveModel(s));
  const b = blend(models);
  return b ? { models, blend: b } : null;
}

/** Single-model snowpack scenarios at a station's point. */
export const loadScenarios = (pt: Point, tz: string, pastDays: number) =>
  fetchSurface(pt, SCENARIO_MODELS, tz, { pastDays, priority: 'low' });
