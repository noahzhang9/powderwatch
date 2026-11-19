/** Data hooks that assemble API calls into derived forecast products. */
import { ENSEMBLES, MODELS } from '../config/models';
import type { Band, Resort } from '../config/resorts';
import { alignMembers, deriveMembers, type MemberSeries } from '../lib/ensemble';
import { blend, deriveModel, toDaily, type BlendHourly, type DailyRow, type DerivedHourly } from '../lib/forecast';
import { fetchEnsemble, fetchProfiles, fetchRunMeta, fetchSurface, type Point, type RunMeta } from '../lib/openmeteo';
import { useAsync } from './useAsync';

export interface BandForecast {
  models: DerivedHourly[];
  daily: Record<string, DailyRow[]>;
  blend: BlendHourly;
  blendDaily: DailyRow[];
  /** Models requested but returning no data at this point. */
  missing: string[];
}

export async function loadBandForecast(resort: Resort, band: Band): Promise<BandForecast> {
  const mid = resort.bands.find((b) => b.key === 'mid') ?? band;
  const [surface, profiles] = await Promise.all([
    fetchSurface({ lat: band.lat, lon: band.lon, elevation: band.elevation }, resort.models, resort.tz),
    // Freezing/snow level is a free-atmosphere quantity: one profile per resort.
    fetchProfiles({ lat: mid.lat, lon: mid.lon }, resort.models, resort.tz).catch(() => undefined),
  ]);
  const usable = surface.filter((s) => s.precip.some((v) => v != null));
  const models = usable.map((s) => deriveModel(s, profiles));
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

export function useBandForecast(resort: Resort, band: Band) {
  return useAsync(() => loadBandForecast(resort, band), [resort.id, band.key]);
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

export function useRunMeta(modelIds: string[]) {
  return useAsync(async () => {
    const out: Record<string, RunMeta | null> = {};
    await Promise.all(modelIds.map(async (id) => (out[id] = await fetchRunMeta(MODELS[id]?.metaId ?? id))));
    return out;
  }, [modelIds.join(',')]);
}
