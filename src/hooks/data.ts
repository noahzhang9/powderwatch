/**
 * Data hooks that assemble API calls into derived forecast products.
 * The `load*` functions are the views' exact requests, kept outside React so
 * the snapshot tests can replay them.
 */
import { ENSEMBLES, NBM } from '../config/models';
import type { Band, Resort } from '../config/resorts';
import { NotInSnapshotError, isNotInSnapshot, snapshotWpc } from '../lib/cache';
import { nbmDaily } from '../lib/benchmarks';
import { alignMembers, deriveMembers, type MemberSeries } from '../lib/ensemble';
import { blend, deriveModel, toDaily, type BlendHourly, type DailyRow, type DerivedHourly } from '../lib/forecast';
import {
  fetchEnsemble, fetchNbm, fetchProfiles, fetchRunMeta, fetchSingleRun, fetchSurface, type Point, type RunMeta, type SurfaceHourly,
} from '../lib/openmeteo';
import type { ProfileLevel } from '../lib/physics';
import { RECENT_SURFACE, SCENARIO_MODELS, hasData, metaIdOf, midBand, pointOf, previousRun, scenarioSurface } from '../lib/requests';
import { parseWpcFile, type WpcFile } from '../lib/wpc';
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

/** Null when no model has data at the point (nothing to blend). */
export function buildBandForecast(resort: Resort, surface: SurfaceHourly[], profiles?: Profiles): BandForecast | null {
  const usable = surface.filter(hasData);
  const models = usable.map((x) => deriveModel(x, profiles));
  const b = blend(models);
  if (!b) return null;
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
  const built = useMemo(
    () => (surface.data ? buildBandForecast(resort, surface.data, profiles.data) : undefined),
    [surface.data, profiles.data, resort],
  );
  // A response in which no model has data shows as a failed request (with Retry), not a crash.
  const empty = useMemo(() => (built === null ? new Error('no model returned data at this point') : undefined), [built]);
  return {
    data: built ?? undefined,
    error: surface.error ?? empty,
    loading: surface.loading,
    retry: surface.retry,
    levelsPending: !profiles.data && !profiles.error,
  };
}

export interface EnsembleSet {
  time: number[];
  members: MemberSeries[];
  /** Ensembles that failed to load (rate limit, outage). */
  failed: string[];
}

/** All ensembles at a point. Rejects with NotInSnapshotError only when none is in a snapshot-only build's snapshot. */
export async function loadEnsembles(pt: Point, tz: string, pastDays?: number, withFreezingLevel = true): Promise<EnsembleSet> {
  const results = await Promise.allSettled(ENSEMBLES.map((e) => fetchEnsemble(pt, e.id, tz, { pastDays, withFreezingLevel })));
  const sets: MemberSeries[][] = [];
  const failed: string[] = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value.members.length) sets.push(deriveMembers(r.value));
    else failed.push(ENSEMBLES[i].label);
  });
  const miss = results.find((r) => r.status === 'rejected' && isNotInSnapshot(r.reason));
  if (!sets.length && miss) throw (miss as PromiseRejectedResult).reason;
  return { ...alignMembers(sets), failed };
}

export function useEnsembles(pt: Point | null, tz: string, enabled = true, pastDays?: number, withFreezingLevel = true) {
  return useAsync(
    () => loadEnsembles(pt!, tz, pastDays, withFreezingLevel),
    [pt?.lat, pt?.lon, pt?.elevation, tz, pastDays, withFreezingLevel],
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

/**
 * The run 12 h before each model's latest run, at a band (run-to-run panel). Rejects with
 * NotInSnapshotError only when none of them is in a snapshot-only build's snapshot.
 */
export async function loadRunChange(
  resort: Resort, band: Band, ids: string[], meta: Record<string, RunMeta | null> | undefined,
): Promise<Record<string, DerivedHourly | null>> {
  const out: Record<string, DerivedHourly | null> = {};
  const misses: NotInSnapshotError[] = [];
  await Promise.all(ids.map(async (id) => {
    const init = meta?.[id]?.initUnix;
    if (!init) return (out[id] = null);
    try {
      out[id] = deriveModel(await fetchSingleRun(pointOf(band), id, previousRun(init), resort.tz));
    } catch (err) {
      if (isNotInSnapshot(err)) misses.push(err);
      out[id] = null;
    }
  }));
  if (misses.length && Object.values(out).every((m) => m == null)) throw misses[0];
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
  fetchSurface(pt, SCENARIO_MODELS, tz, { ...scenarioSurface(pastDays), priority: 'low' });

export interface NbmForecast {
  daily: DailyRow[];
  /** NBM's run (null: run metadata unavailable). */
  run: RunMeta | null;
}

/** NOAA NBM at a band, with its run time: the "Compare with official guidance" benchmark. */
export async function loadNbm(resort: Resort, band: Band): Promise<NbmForecast> {
  const [n, run] = await Promise.all([fetchNbm(pointOf(band), resort.tz), fetchRunMeta(NBM.metaId)]);
  return { daily: nbmDaily(n, resort.tz), run };
}

/** Requests nothing unless `enabled` (the toggle is on and the resort is covered). */
export function useNbm(resort: Resort, band: Band, enabled: boolean) {
  return useAsync(() => loadNbm(resort, band), [resort.id, band.key], enabled);
}

/** WPC's winter chances from the file deployed with the snapshot (null: none); never a call to NOAA. */
export async function loadWpc(): Promise<WpcFile | null> {
  return parseWpcFile(await snapshotWpc());
}

/** Reads nothing unless `enabled` (the toggle is on and the resort is covered). */
export function useWpc(enabled: boolean) {
  return useAsync(loadWpc, [], enabled);
}
