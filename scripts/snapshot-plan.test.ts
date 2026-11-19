import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HISTORY_MODELS } from '../src/config/models';
import { RESORTS } from '../src/config/resorts';
import { STATIONS, stationsFor } from '../src/config/stations';
import {
  loadBandSurface, loadEnsembles, loadProfiles, loadRecentModels, loadRunChange, loadRunMeta, loadScenarios,
} from '../src/hooks/data';
import { SNAPSHOT_MAX_AGE_S, clearCache } from '../src/lib/cache';
import { loadStation, type StationFile } from '../src/lib/obs';
import { parseRunMeta, type RunMeta, type SurfaceHourly } from '../src/lib/openmeteo';
import { hasData, midBand, pointOf, projectionStart, runChangeModels, SNOWPACK_WITH_FREEZING_LEVEL } from '../src/lib/requests';
import { todayIn } from '../src/lib/time';
import { PRIORITY, estimateCost, metaIdsFor, planSnapshot, selectWithinBudget, type PlanGroup } from './snapshot-plan';

// 23:30 in Verbier: its local date changes while this snapshot is served; Crystal/Whistler's doesn't.
const NOW_S = Date.parse('2026-11-19T22:30:00Z') / 1000;
const LATER_S = NOW_S + SNAPSHOT_MAX_AGE_S - 60;
const INIT_S = Date.parse('2026-11-19T12:00:00Z') / 1000;
const OBS_DIR = fileURLToPath(new URL('../public/data/obs', import.meta.url));
const WHISTLER_MID = midBand(RESORTS.find((r) => r.id === 'whistler')!);

const fakeMeta = () => ({ last_run_initialisation_time: INIT_S, last_run_availability_time: INIT_S + 5 * 3600, update_interval_seconds: 21600 });

/** A minimal Open-Meteo response for any forecast/ensemble/single-run URL. GEM has no data at Whistler mid. */
function fakeOpenMeteo(u: URL) {
  if (u.pathname.endsWith('/meta.json')) return fakeMeta();
  const vars = u.searchParams.get('hourly')!.split(',');
  const models = u.searchParams.get('models')!.split(',');
  const hourly: Record<string, unknown> = { time: [NOW_S, NOW_S + 3600] };
  for (const m of models) {
    const empty = m === 'gem_global' && u.searchParams.get('latitude') === String(WHISTLER_MID.lat) && !u.host.startsWith('ensemble');
    for (const v of vars) hourly[models.length > 1 ? `${v}_${m}` : v] = empty ? [null, null] : [1, 1];
  }
  return { hourly, elevation: Number(u.searchParams.get('elevation') ?? 0) };
}

const requested = new Set<string>();

function stubNetwork() {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(input);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const obs = url.match(/data\/obs\/([\w-]+)\.json$/);
    if (obs) return new Response(readFileSync(join(OBS_DIR, `${obs[1]}.json`), 'utf-8'));
    if (!url.startsWith('https://')) return new Response('not found', { status: 404 }); // no snapshot manifest
    requested.add(url);
    return json(fakeOpenMeteo(new URL(url)));
  });
}

/**
 * Replays the views' requests: dashboard, storm tracker (mid band, plus the deterministic
 * forecast after switching band), run history's run timing, snowpack at every station.
 */
async function browserRequests(atS: number) {
  vi.setSystemTime(atS * 1000);
  await clearCache();
  requested.clear();
  const midSurface: Record<string, SurfaceHourly[]> = {};
  for (const r of RESORTS) {
    const mid = midBand(r);
    const surface = await loadBandSurface(r, mid);
    midSurface[r.id] = surface;
    await loadProfiles(r);
    const meta = await loadRunMeta(r.models);
    await loadEnsembles(pointOf(mid), r.tz);
    await loadRunChange(r, mid, runChangeModels(surface.filter(hasData).map((s) => s.modelId)), meta);
    for (const p of [...stationsFor(r.id), mid]) await loadRecentModels(pointOf(p), r);
    for (const b of r.bands) await loadBandSurface(r, b);
    await loadRunMeta(HISTORY_MODELS.filter((m) => r.models.includes(m)));
    for (const st of stationsFor(r.id)) {
      const { stale, pastDays } = projectionStart(await loadStation(st.id), 'depthCm', todayIn(r.tz));
      if (stale) continue;
      await loadEnsembles(pointOf(st), r.tz, pastDays, SNOWPACK_WITH_FREEZING_LEVEL);
      await loadScenarios(pointOf(st), r.tz, pastDays);
    }
  }
  return { urls: new Set(requested), midSurface };
}

const obsFiles = (): Record<string, StationFile | null> =>
  Object.fromEntries(STATIONS.map((s) => [s.id, JSON.parse(readFileSync(join(OBS_DIR, `${s.id}.json`), 'utf-8')) as StationFile]));
const allUrls = (plan: PlanGroup[]) => plan.flatMap((g) => g.urls);

describe('snapshot plan', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    stubNetwork();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('holds exactly the URLs the browser requests, now and until the snapshot expires', async () => {
    const now = await browserRequests(NOW_S);
    const later = await browserRequests(LATER_S);
    const meta: Record<string, RunMeta | null> = Object.fromEntries(metaIdsFor().map((id) => [id, parseRunMeta(fakeMeta())]));
    const plan = planSnapshot({ nowS: NOW_S, obs: obsFiles(), meta, midSurface: now.midSurface, servedForS: LATER_S - NOW_S });
    const planned = allUrls(plan);

    expect(new Set(planned).size).toBe(planned.length);
    expect([...planned].sort()).toEqual([...new Set([...now.urls, ...later.urls])].sort());
    // The local date change at Verbier really changed some requests.
    expect([...later.urls].some((u) => !now.urls.has(u))).toBe(true);
    // GEM had no data at Whistler mid, so neither side asks for its previous run there.
    expect(planned.some((u) => u.includes('single-runs') && u.includes(`latitude=${WHISTLER_MID.lat}`) && u.includes('models=gem_global'))).toBe(false);
  });

  it('leaves out run history and base/summit ensembles', () => {
    const meta = Object.fromEntries(metaIdsFor().map((id) => [id, parseRunMeta(fakeMeta())]));
    const midSurface = Object.fromEntries(RESORTS.map((r) => [r.id, r.models.map((m) => ({ modelId: m, precip: [1] }) as SurfaceHourly)]));
    const urls = allUrls(planSnapshot({ nowS: NOW_S, obs: obsFiles(), meta, midSurface }));
    const offMid = RESORTS.flatMap((r) => r.bands.filter((b) => b.key !== 'mid'));
    for (const u of urls.filter((x) => x.includes('ensemble-api'))) {
      const q = new URL(u).searchParams;
      expect(offMid.some((b) => q.get('latitude') === String(b.lat) && q.get('longitude') === String(b.lon))).toBe(false);
    }
    const runs = urls.filter((u) => u.includes('single-runs')).map((u) => new URL(u).searchParams.get('run'));
    expect(new Set(runs)).toEqual(new Set([new Date((INIT_S - 12 * 3600) * 1000).toISOString().slice(0, 16)]));
    expect(runs.length).toBe(RESORTS.length * HISTORY_MODELS.length);
  });

  it('asks the last-7-days and snowpack-scenario requests for the physics inputs only', () => {
    const urls = allUrls(planSnapshot({ nowS: NOW_S, obs: obsFiles() })).filter((u) => u.includes('/v1/forecast') && u.includes('past_days'));
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) expect(new URL(u).searchParams.get('hourly')).toBe('temperature_2m,relative_humidity_2m,precipitation');
  });
});

describe('estimateCost (Open-Meteo weighted calls)', () => {
  const q = (base: string, p: Record<string, string>) => `${base}?${new URLSearchParams(p)}`;
  const F = 'https://api.open-meteo.com/v1/forecast';
  const E = 'https://ensemble-api.open-meteo.com/v1/ensemble';
  const vars = (n: number) => Array.from({ length: n }, (_, i) => `v${i}`).join(',');
  it('follows the published examples and the measured X-RateLimit-Cost', () => {
    expect(estimateCost(q(F, { hourly: vars(15), models: 'gfs_global', forecast_days: '14' }))).toBeCloseTo(1.5);
    expect(estimateCost(q(F, { hourly: vars(15), models: 'gfs_global', forecast_days: '28' }))).toBeCloseTo(3.0);
    expect(estimateCost(q(F, { hourly: vars(3), models: 'gfs_global', forecast_days: '16' }))).toBe(1);
    // Measured: GEPS (21 members), 1 variable, 1 day → X-RateLimit-Cost 2.1.
    expect(estimateCost(q(E, { hourly: 'precipitation', models: 'gem_global', forecast_days: '1' }))).toBeCloseTo(2.1);
    // Multi-model requests count every model; ensembles every member.
    expect(estimateCost(q(F, { hourly: vars(8), models: 'a,b,c,d,e,f,g,h', forecast_days: '16' }))).toBeCloseTo((64 / 10) * (16 / 14));
    expect(estimateCost(q(E, { hourly: vars(4), models: 'ecmwf_ifs025', forecast_days: '16', past_days: '2' }))).toBeCloseTo((204 / 10) * (18 / 14));
    expect(estimateCost('https://api.open-meteo.com/data/ncep_gfs013/static/meta.json')).toBe(0);
  });
});

describe('selectWithinBudget', () => {
  it('keeps whole groups in priority order and skips what does not fit', () => {
    const F = 'https://api.open-meteo.com/v1/forecast?hourly=a&models=x&forecast_days=1';
    const g = (priority: number, n: number): PlanGroup => ({ priority, label: `p${priority}`, urls: Array.from({ length: n }, (_, i) => `${F}&i=${priority}-${i}`) });
    const { included, skipped, cost } = selectWithinBudget([g(PRIORITY.meta, 2), g(PRIORITY.midEnsembles, 5), g(PRIORITY.snowpackOther, 2)], 5);
    expect(included.map((x) => x.label)).toEqual(['p0', 'p8']);
    expect(skipped.map((x) => x.label)).toEqual(['p3']);
    expect(cost).toBe(4);
  });
});
