import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HISTORY_MODELS } from '../src/config/models';
import { RESORTS } from '../src/config/resorts';
import { STATIONS, stationsFor } from '../src/config/stations';
import {
  loadBandSurface, loadDashboardEnsembles, loadEnsembles, loadNbm, loadProfiles, loadRecentModels, loadRunChange, loadRunMeta, loadScenarios,
} from '../src/hooks/data';
import { SNAPSHOT_MAX_AGE_S, clearCache, type SnapshotEntry } from '../src/lib/cache';
import { loadStation, type StationFile } from '../src/lib/obs';
import { parseRunMeta, type RunMeta, type SurfaceHourly } from '../src/lib/openmeteo';
import { hasData, midBand, pointOf, projectionStart, runChangeModels, SNOWPACK_WITH_FREEZING_LEVEL } from '../src/lib/requests';
import { todayIn } from '../src/lib/time';
import {
  FIRST_SCREENS, HARD_MAX_COST, PRIORITY, estimateCost, firstScreenCost, groupCost, metaIdsFor, planSnapshot, runBudget, selectWithinBudget,
  type PlanGroup,
} from './snapshot-plan';

// 23:30 in Verbier: its local date changes while this snapshot is served; the Pacific resorts' doesn't.
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
 * Replays the views' requests: dashboard, storm tracker (mid band with "More detail" open and, where
 * offered, "Compare with official guidance" on, plus the deterministic forecast after switching band),
 * run history's run timing, snowpack at every station.
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
    await loadDashboardEnsembles(r); // never live: no request here, see "the dashboard's ensembles" below
    const meta = await loadRunMeta(r.models);
    await loadEnsembles(pointOf(mid), r.tz);
    await loadRunChange(r, mid, runChangeModels(surface.filter(hasData).map((s) => s.modelId)), meta);
    for (const p of [...stationsFor(r.id), mid]) await loadRecentModels(pointOf(p), r);
    if (r.officialGuidance) await loadNbm(r, mid);
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
    vi.stubEnv('VITE_SNAPSHOT_ONLY', ''); // replay the production build's requests
    stubNetwork();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
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

  describe("the dashboard's ensembles", () => {
    const fileName = (i: number) => `${i.toString(16).padStart(16, '0')}-0000000000.json`;

    it('are read from the snapshot alone: exactly the Storm tracker\'s mid ensembles in the plan, never live', async () => {
      vi.setSystemTime(NOW_S * 1000);
      await clearCache();
      const plan = planSnapshot({ nowS: NOW_S, obs: obsFiles() });
      // A deployed snapshot holding every planned request.
      const byFile = new Map(allUrls(plan).map((u, i) => [fileName(i), u]));
      const entries: Record<string, SnapshotEntry> = Object.fromEntries([...byFile].map(([f, u]) => [u, { file: f, fetchedAt: NOW_S - 600 }]));
      const read = new Set<string>();
      vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
        const url = String(input);
        const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
        if (url.startsWith('https://')) {
          requested.add(url);
          return json(fakeOpenMeteo(new URL(url)));
        }
        if (url.endsWith('/data/fc/manifest.json')) return json({ version: 1, generatedAt: NOW_S - 600, entries });
        const planned = byFile.get(url.split('/').pop()!);
        if (!planned) return new Response('not found', { status: 404 });
        read.add(planned);
        return json(fakeOpenMeteo(new URL(planned)));
      });
      requested.clear();
      for (const r of RESORTS) {
        const ens = await loadDashboardEnsembles(r);
        expect(ens.failed).toEqual([]);
        expect(ens.members.length).toBeGreaterThan(0);
      }
      expect(requested.size).toBe(0);
      const midEnsembles = plan.filter((g) => g.priority === PRIORITY.midEnsembles).flatMap((g) => g.urls);
      expect(midEnsembles.length).toBeGreaterThan(0);
      expect([...read].sort()).toEqual([...midEnsembles].sort());
    });

    it('request nothing when the snapshot has no copy', async () => {
      vi.setSystemTime(NOW_S * 1000);
      await clearCache();
      requested.clear();
      for (const r of RESORTS) expect((await loadDashboardEnsembles(r)).members).toEqual([]);
      expect(requested.size).toBe(0);
    });
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

describe('runBudget', () => {
  const F = 'https://api.open-meteo.com/v1/forecast?hourly=a,b,c,d,e,f,g,h,i,j&models=x&forecast_days=1'; // 1 call each
  const g = (priority: number, n: number): PlanGroup => ({ priority, label: `p${priority}`, urls: Array.from({ length: n }, (_, i) => `${F}&i=${priority}-${i}`) });
  it('grows to fit the first screens, never past the hard ceiling', () => {
    expect(runBudget([g(PRIORITY.firstPaint, 3), g(PRIORITY.snowpackOther, 50)], 10)).toBe(10);
    expect(runBudget([g(PRIORITY.firstPaint, 8), g(PRIORITY.snowpackDefaultNextDay, 6), g(PRIORITY.snowpackOther, 50)], 10)).toBe(14);
    expect(runBudget([g(PRIORITY.firstPaint, HARD_MAX_COST + 5)], 10)).toBe(HARD_MAX_COST);
  });
  it("fits every resort's first screens, including across a local midnight", () => {
    const meta = Object.fromEntries(metaIdsFor().map((id) => [id, parseRunMeta(fakeMeta())]));
    const midSurface = Object.fromEntries(RESORTS.map((r) => [r.id, r.models.map((m) => ({ modelId: m, precip: [1] }) as SurfaceHourly)]));
    // 20:20 PST: the Pacific resorts' snapshot is still served after their midnight.
    const nowS = Date.parse('2026-11-20T04:20:00Z') / 1000;
    const plan = planSnapshot({ nowS, obs: obsFiles(), meta, midSurface });
    expect(plan.some((g) => g.priority === PRIORITY.snowpackDefaultNextDay)).toBe(true);
    const { skipped } = selectWithinBudget(plan, runBudget(plan));
    expect(skipped.filter((g) => g.priority <= PRIORITY.snowpackDefaultNextDay)).toEqual([]);
  });
});

describe('daily budget', () => {
  /** The six scheduled runs of one day (the workflow's cron), each with its own plan and budget. */
  const simulateDay = (drop?: (g: PlanGroup) => boolean) => {
    const meta = Object.fromEntries(metaIdsFor().map((id) => [id, parseRunMeta(fakeMeta())]));
    const midSurface = Object.fromEntries(RESORTS.map((r) => [r.id, r.models.map((m) => ({ modelId: m, precip: [1] }) as SurfaceHourly)]));
    return [0, 4, 8, 12, 16, 20].map((h) => {
      const nowS = Date.parse(`2026-11-20T${String(h).padStart(2, '0')}:20:00Z`) / 1000;
      const plan = planSnapshot({ nowS, obs: obsFiles(), meta, midSurface }).filter((g) => !drop?.(g));
      return { firstScreens: firstScreenCost(plan), ...selectWithinBudget(plan, runBudget(plan)) };
    });
  };

  it('keeps the six scheduled runs under 9,000 weighted calls a day, first screens in every run', () => {
    const runs = simulateDay();
    for (const r of runs) expect(r.skipped.filter((g) => g.priority <= FIRST_SCREENS)).toEqual([]);
    const total = runs.reduce((s, r) => s + r.cost, 0);
    expect(total).toBeLessThan(9000);
  });

  it('spends 1 weighted call per US resort and run on NOAA NBM', () => {
    const nbm = planSnapshot({ nowS: NOW_S, obs: obsFiles() }).filter((g) => g.priority === PRIORITY.benchmarks);
    expect(nbm.map((g) => g.label)).toEqual(RESORTS.filter((r) => r.officialGuidance).map((r) => `${r.id}: NOAA NBM at mid`));
    for (const g of nbm) expect(groupCost(g)).toBe(1);
  });
});

describe('selectWithinBudget', () => {
  it('keeps whole groups in priority order and skips what does not fit', () => {
    const F = 'https://api.open-meteo.com/v1/forecast?hourly=a&models=x&forecast_days=1';
    const g = (priority: number, n: number): PlanGroup => ({ priority, label: `p${priority}`, urls: Array.from({ length: n }, (_, i) => `${F}&i=${priority}-${i}`) });
    const { included, skipped, cost } = selectWithinBudget([g(PRIORITY.meta, 2), g(PRIORITY.midEnsembles, 5), g(PRIORITY.snowpackOther, 2)], 5);
    expect(included.map((x) => x.label)).toEqual([`p${PRIORITY.meta}`, `p${PRIORITY.snowpackOther}`]);
    expect(skipped.map((x) => x.label)).toEqual([`p${PRIORITY.midEnsembles}`]);
    expect(cost).toBe(4);
  });
});
