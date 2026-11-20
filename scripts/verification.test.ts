import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ENSEMBLES, MODELS } from '../src/config/models';
import { RESORTS } from '../src/config/resorts';
import { STATIONS } from '../src/config/stations';
import type { StationFile } from '../src/lib/obs';
import { PREVIOUS_RUN_LEADS, previousRunsUrl, type OmResponse, type RunMeta } from '../src/lib/openmeteo';
import { splitPrecip } from '../src/lib/physics';
import { SCENARIO_MODELS, metaIdOf, pointOf } from '../src/lib/requests';
import { addDays, localDate, localMidnightUnix } from '../src/lib/time';
import { snowpackRequests } from './snapshot-plan';
import {
  CYCLE_HOURS, CYCLE_MODELS, RECORD_DAYS, RECORD_THRESHOLDS_CM, buildBackfillRecords, buildVerificationRecord, chooseCycle, cycleOf, firstDay,
  recordFileName,
} from './verification';

const T = (iso: string) => Date.parse(iso) / 1000;
const NOW_S = T('2026-11-20T08:20:00Z');
const CRYSTAL = RESORTS.find((r) => r.id === 'crystal')!;
const VALIDATOR = fileURLToPath(new URL('./validate_verification.py', import.meta.url));

const metaAt = (inits: Record<string, string>): Record<string, RunMeta | null> =>
  Object.fromEntries(Object.entries(inits).map(([id, iso]) => [metaIdOf(id), { initUnix: T(iso), availableUnix: T(iso) + 4 * 3600, updateIntervalSec: 21600 }]));
const allAt = (iso: string, over: Record<string, string> = {}) =>
  metaAt({ ...Object.fromEntries([...new Set(RESORTS.flatMap((r) => r.models))].map((id) => [id, iso])), ...over });

describe('cycle choice', () => {
  it('uses the full-length cycles the catalogue lists for every global model', () => {
    expect(CYCLE_HOURS).toEqual([0, 12]);
    expect(CYCLE_MODELS).toEqual(expect.arrayContaining(['ecmwf_ifs025', 'gfs_global', 'gem_global', 'icon_global', 'ecmwf_aifs025_single']));
    expect(CYCLE_MODELS.every((id) => MODELS[id].kind === 'global')).toBe(true);
  });

  it('floors a run to its full-length cycle', () => {
    expect(cycleOf(T('2026-11-20T06:00:00Z'))).toBe(T('2026-11-20T00:00:00Z'));
    expect(cycleOf(T('2026-11-20T12:00:00Z'))).toBe(T('2026-11-20T12:00:00Z'));
    expect(cycleOf(T('2026-11-20T03:00:00Z'))).toBe(T('2026-11-20T00:00:00Z'));
  });

  it('names the newest cycle every current global model carries', () => {
    // GFS has moved on to 06Z; that still carries the 00Z cycle.
    expect(chooseCycle(allAt('2026-11-20T00:00Z', { gfs_global: '2026-11-20T06:00Z' }))).toEqual({ cycleS: T('2026-11-20T00:00:00Z'), lagging: [] });
    // ECMWF still on yesterday's 12Z: the 00Z cycle isn't complete yet.
    expect(chooseCycle(allAt('2026-11-20T00:00Z', { ecmwf_ifs025: '2026-11-19T12:00Z' }))!.cycleS).toBe(T('2026-11-19T12:00:00Z'));
  });

  it("doesn't let a model in an outage or without metadata stall the archive", () => {
    const meta = allAt('2026-11-21T00:00Z', { gem_global: '2026-11-20T00:00Z' });
    meta[metaIdOf('icon_global')] = null;
    expect(chooseCycle(meta)).toEqual({ cycleS: T('2026-11-21T00:00:00Z'), lagging: ['gem_global', 'icon_global'] });
    expect(chooseCycle({})).toBeNull();
  });

  it('starts day 1 at the first local midnight at or after the cycle', () => {
    expect(firstDay(T('2026-11-20T00:00:00Z'), 'America/Los_Angeles')).toBe('2026-11-20'); // 16:00 the day before
    expect(firstDay(T('2026-11-20T12:00:00Z'), 'America/Los_Angeles')).toBe('2026-11-21'); // 04:00
    expect(firstDay(T('2026-11-20T00:00:00Z'), 'Europe/Zurich')).toBe('2026-11-21'); // 01:00
    expect(firstDay(T('2026-11-20T08:00:00Z'), 'America/Los_Angeles')).toBe('2026-11-20'); // exactly midnight
  });
});

// ---------------------------------------------------------------- record builder on canned responses

const P_MM = 1;
const T_C = -5;
const RH = 90;
const SNOW_PER_H = splitPrecip(P_MM, T_C, RH).snowCm;
/** Hours of data each model/ensemble has, from the start of its response (others: all). */
const HORIZON_H: Record<string, number> = { ncep_hrrr_conus: 48, gem_hrdps_continental: 48, icon_global: 180 };

/** A canned Open-Meteo response for any URL the builder asks for: constant 1 mm/h at −5 °C. */
function fakeResponse(url: string): OmResponse {
  const u = new URL(url);
  const q = u.searchParams;
  const tz = q.get('timezone')!;
  const past = Number(q.get('past_days') ?? 0);
  const start = localMidnightUnix(addDays(localDate(NOW_S, tz), -past), tz);
  const n = (past + Number(q.get('forecast_days') ?? 7)) * 24;
  const time = Array.from({ length: n }, (_, i) => start + i * 3600);
  const vars = q.get('hourly')!.split(',');
  const models = q.get('models')!.split(',');
  const value = (v: string) => (v.startsWith('temperature') ? T_C : v.startsWith('relative_humidity') ? RH : v.startsWith('geopotential') ? 1500 : v === 'freezing_level_height' ? 1200 : P_MM);
  const hourly: OmResponse['hourly'] = { time };
  const ensemble = u.host.startsWith('ensemble');
  for (const m of models) {
    const h = HORIZON_H[m] ?? Infinity;
    const s = (v: string) => time.map((_, i) => (i < h ? value(v) : null));
    if (ensemble) {
      for (let k = 0; k < 3; k++) for (const v of vars) hourly[k ? `${v}_member0${k}` : v] = s(v);
    } else for (const v of vars) hourly[models.length > 1 ? `${v}_${m}` : v] = s(v);
  }
  return { hourly, elevation: Number(q.get('elevation') ?? 0) };
}

const station = (id: string, lastDaysAgo: number): StationFile => {
  const today = localDate(NOW_S, CRYSTAL.tz);
  return {
    id, updated: '2026-11-20T08:00:00Z', start: addDays(today, -40), depthCm: Array.from({ length: 41 - lastDaysAgo }, () => 50),
    sweMm: null, lastDepthDate: addDays(today, -lastDaysAgo), lastSweDate: null,
  };
};

function buildCrystal() {
  // Morse Lake reported yesterday; Corral Pass too, but this run skipped its requests; Cayuse Pass is silent.
  const obs = { 'snotel-642': station('snotel-642', 1), 'snotel-418': station('snotel-418', 1), 'snotel-1085': station('snotel-1085', 30) };
  const corral = snowpackRequests(CRYSTAL, STATIONS.find((s) => s.id === 'snotel-418')!, obs['snotel-418'], localDate(NOW_S, CRYSTAL.tz))!;
  const skip = new Set([...corral.ensembles, corral.scenario]);
  return buildVerificationRecord({
    nowS: NOW_S,
    meta: allAt('2026-11-20T00:00Z', { gfs_global: '2026-11-20T06:00Z', ncep_hrrr_conus: '2026-11-20T07:00Z' }),
    obs,
    json: (u) => (skip.has(u) ? undefined : fakeResponse(u)),
    resorts: [CRYSTAL],
  })!;
}

describe('verification record', () => {
  const rec = buildCrystal();
  const mid = rec.points.find((p) => p.kind === 'mid')!;
  const morse = rec.points.find((p) => p.id === 'snotel-642')!;

  it('names the cycle, the runs and days 1–10', () => {
    expect(rec.cycle).toBe('2026-11-20T00Z');
    expect(recordFileName(rec)).toBe('2026-11-20T00Z.json');
    expect(rec.runs.gfs_global).toBe('2026-11-20T06:00Z');
    expect(rec.runs.ncep_hrrr_conus).toBe('2026-11-20T07:00Z');
    expect(mid.days).toEqual(Array.from({ length: RECORD_DAYS }, (_, i) => addDays('2026-11-20', i)));
    expect(rec.thresholdsCm).toEqual(RECORD_THRESHOLDS_CM.map((t) => Math.round(t * 100) / 100));
  });

  it('archives the mid band: blend, every model, ensembles', () => {
    const day = Math.round(24 * SNOW_PER_H * 10) / 10;
    expect(Object.keys(mid.models).sort()).toEqual([...CRYSTAL.models].sort());
    expect(mid.blend!.snow[0]).toBeCloseTo(day, 1);
    expect(mid.blend!.precip).toEqual(Array(RECORD_DAYS).fill(24));
    expect(mid.blend!.rain).toEqual(Array(RECORD_DAYS).fill(0));
    expect(mid.models.ecmwf_ifs025.tmin[0]).toBe(T_C);
    expect(mid.models.ecmwf_ifs025.slmin![0]).not.toBeNull(); // from the mid pressure profile
    // HRRR's 48 h cover day 1 only; a partly covered day is left out rather than undercounted.
    expect(mid.models.ncep_hrrr_conus.snow).toEqual([day, ...Array(RECORD_DAYS - 1).fill(null)]);
    // ICON ends after 180 h: days 1–7 complete (its response starts at local midnight).
    expect(mid.models.icon_global.snow.filter((x) => x != null)).toHaveLength(7);
    const ens = mid.ens!;
    expect(ens.ensembles).toEqual(ENSEMBLES.map((e) => e.id));
    expect(ens.members).toBe(3 * ENSEMBLES.length);
    expect(ens.snow.p50[0]).toBeCloseTo(day, 1);
    // ≥ 1, 4, 8, 12 in reached (31.8 cm), 20 in not.
    expect(ens.pge[0]).toEqual([1, 1, 1, 1, 0]);
    expect(ens.win.days).toEqual([3, 7, 10]);
    expect(ens.win.snow.p50[0]).toBeCloseTo(3 * 24 * SNOW_PER_H, 0);
    expect(mid.blend!.centres![0]).toBe(5); // ECMWF, NOAA, ECCC, DWD, UKMO
  });

  it("archives each station's own point where the snapshot has it, and says why it skipped the others", () => {
    expect(morse.lat).toBe(46.9059);
    expect(Object.keys(morse.models)).toEqual(['ecmwf_ifs025', 'gfs_global', 'gem_global', 'icon_global', 'ecmwf_aifs025_single']);
    expect(morse.models.gfs_global.snow[0]).toBeCloseTo(24 * SNOW_PER_H, 1);
    expect(morse.models.gfs_global.slmax![0]).not.toBeNull();
    expect(morse.ens!.members).toBe(3 * ENSEMBLES.length);
    expect(morse.blend).toBeUndefined();
    expect(rec.skipped).toEqual([
      { resort: 'crystal', id: 'snotel-418', reason: 'not-in-snapshot' },
      { resort: 'crystal', id: 'snotel-1085', reason: 'no-projection' },
    ]);
  });

  it('counts negative hourly precipitation (de-accumulation artefacts) as none', () => {
    const json = (u: string) => {
      const d = fakeResponse(u);
      for (const [k, v] of Object.entries(d.hourly)) if (k.startsWith('precipitation')) d.hourly[k] = (v as (number | null)[]).map((x, i) => (i % 24 === 5 ? -3 : x));
      return d;
    };
    const r = buildVerificationRecord({ nowS: NOW_S, meta: allAt('2026-11-20T00:00Z'), obs: {}, json, resorts: [CRYSTAL] })!;
    const m = r.points[0];
    expect(m.models.gfs_global.precip[0]).toBe(23);
    expect(m.blend!.precip[0]).toBe(23);
    expect(m.ens!.precip.p10[0]).toBe(23);
  });

  it('returns no record when the run metadata names no cycle', () => {
    expect(buildVerificationRecord({ nowS: NOW_S, meta: {}, obs: {}, json: () => undefined, resorts: [CRYSTAL] })).toBeNull();
  });
});

/** A canned Previous Runs response for local dates start..end: 1 mm/h at −5 °C for every lead, except ICON's 7th (beyond its range). */
function fakePreviousRuns(url: string): OmResponse {
  const q = new URL(url).searchParams;
  const tz = q.get('timezone')!;
  const start = localMidnightUnix(q.get('start_date')!, tz);
  const n = (Date.parse(`${q.get('end_date')}T00:00:00Z`) - Date.parse(`${q.get('start_date')}T00:00:00Z`)) / 3600_000 + 24;
  const time = Array.from({ length: n }, (_, i) => start + i * 3600);
  const hourly: OmResponse['hourly'] = { time };
  for (const m of q.get('models')!.split(',')) {
    for (const v of q.get('hourly')!.split(',')) {
      const off = m === 'icon_global' && v.endsWith('_previous_day7');
      hourly[`${v}_${m}`] = time.map(() => (off ? null : v.startsWith('temperature') ? T_C : v.startsWith('relative') ? RH : P_MM));
    }
  }
  return { hourly };
}

const STEVENS = RESORTS.find((r) => r.id === 'stevens')!;
const backfill = () => {
  const st = STATIONS.find((s) => s.id === 'snotel-791')!;
  const json = fakePreviousRuns(previousRunsUrl(pointOf(st), SCENARIO_MODELS, STEVENS.tz, '2026-11-17', '2026-11-19'));
  return buildBackfillRecords({ generatedAtS: NOW_S, dates: ['2026-11-17', '2026-11-18'], stations: [{ resort: STEVENS, station: st, json }] });
};

describe('backfill records', () => {
  it('give each date every model as forecast 1–7 days ahead', () => {
    const recs = backfill();
    expect(recs.map((r) => r.date)).toEqual(['2026-11-17', '2026-11-18']);
    const p = recs[0].points[0];
    expect(p).toMatchObject({ resort: 'stevens', kind: 'station', id: 'snotel-791', tz: STEVENS.tz });
    expect(recs[0].leads).toEqual(PREVIOUS_RUN_LEADS);
    expect(p.models.gfs_global.snow).toEqual(Array(7).fill(Math.round(24 * SNOW_PER_H * 10) / 10));
    expect(p.models.icon_global.precip).toEqual([24, 24, 24, 24, 24, 24, null]);
  });
});

// ---------------------------------------------------------------- the workflow's validator agrees with the builder

const python = spawnSync('python3', ['--version']).status === 0;

describe.skipIf(!python)('validate_verification.py', () => {
  const run = (...args: string[]) => spawnSync('python3', ['-I', VALIDATOR, ...args], { encoding: 'utf-8' });
  const rec = buildCrystal();
  const dir = mkdtempSync(join(tmpdir(), 'pw-verify-'));
  const write = (name: string, body: string) => {
    const d = mkdtempSync(join(dir, 'in-'));
    writeFileSync(join(d, name), body);
    return join(d, name);
  };
  const tampered = (f: (r: Record<string, unknown>) => void) => {
    const r = JSON.parse(JSON.stringify(rec));
    f(r);
    return write(recordFileName(rec), JSON.stringify(r));
  };

  it('accepts what the builder writes', () => {
    const res = run('--check', write(recordFileName(rec), JSON.stringify(rec)));
    expect(res.stderr).toBe('');
    expect(res.status).toBe(0);
  });

  it.each([
    ['an unknown key', (r: Record<string, unknown>) => (r.extra = 1)],
    ['a non-finite number', (r: Record<string, unknown>) => ((r.points as { models: Record<string, { snow: unknown[] }> }[])[0].models.gfs_global.snow[0] = 'NaN')],
    ['an implausible snowfall', (r: Record<string, unknown>) => ((r.points as { blend: { snow: number[] } }[])[0].blend.snow[0] = 9999)],
    ['a chance above 1', (r: Record<string, unknown>) => ((r.points as { ens: { pge: number[][] } }[])[0].ens.pge[0][0] = 1.5)],
    ['a short series', (r: Record<string, unknown>) => (r.points as { days: string[] }[])[0].days.pop()],
    ['a cycle that differs from the file name', (r: Record<string, unknown>) => (r.cycle = '2026-11-21T00Z')],
    ['an unknown skip reason', (r: Record<string, unknown>) => ((r.skipped as { reason: string }[])[0].reason = 'because')],
  ])('rejects %s', (_label, f) => {
    const res = run('--check', tampered(f));
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/^rejected: /);
  });

  it('rejects NaN literals, duplicate keys and unexpected names', () => {
    expect(run('--check', write(recordFileName(rec), JSON.stringify(rec).replace('"v":1', '"v":NaN'))).status).toBe(1);
    expect(run('--check', write(recordFileName(rec), JSON.stringify(rec).replace('"v":1', '"v":1,"v":1'))).status).toBe(1);
    expect(run('--check', write('2026-11-20T00Z.json.sh', JSON.stringify(rec))).status).toBe(1);
    expect(run('--check', write('2026-11-20T24Z.json', JSON.stringify(rec))).status).toBe(1);
  });

  it('re-serialises into cycles/YYYY-MM/ and never overwrites an archived cycle', () => {
    const incoming = mkdtempSync(join(dir, 'incoming-'));
    const root = mkdtempSync(join(dir, 'archive-'));
    writeFileSync(join(incoming, recordFileName(rec)), JSON.stringify(rec, null, 2));
    expect(run('--kind', 'cycle', incoming, root).stdout).toContain('added: cycles/2026-11/2026-11-20T00Z.json');
    const stored = readFileSync(join(root, 'cycles/2026-11/2026-11-20T00Z.json'), 'utf-8');
    expect(stored).toBe(`${JSON.stringify(rec)}\n`);
    writeFileSync(join(incoming, recordFileName(rec)), JSON.stringify({ ...rec, generatedAt: '2026-11-20T12:20:00Z' }));
    expect(run('--kind', 'cycle', incoming, root).stdout).toContain('exists, kept');
    expect(readFileSync(join(root, 'cycles/2026-11/2026-11-20T00Z.json'), 'utf-8')).toBe(stored);
  });

  it('accepts backfill records into backfill/YYYY-MM/', () => {
    const incoming = mkdtempSync(join(dir, 'incoming-'));
    const root = mkdtempSync(join(dir, 'archive-'));
    for (const r of backfill()) writeFileSync(join(incoming, `${r.date}.json`), JSON.stringify(r));
    const res = run('--kind', 'backfill', incoming, root);
    expect(res.stderr).toBe('');
    expect(readdirSync(join(root, 'backfill/2026-11')).sort()).toEqual(['2026-11-17.json', '2026-11-18.json']);
    // The CI job only takes cycle records.
    expect(run('--kind', 'cycle', incoming, root).status).toBe(1);
  });

  it('writes nothing when any incoming file fails', () => {
    const incoming = mkdtempSync(join(dir, 'incoming-'));
    const root = mkdtempSync(join(dir, 'archive-'));
    writeFileSync(join(incoming, '2026-11-20T00Z.json'), JSON.stringify(rec));
    writeFileSync(join(incoming, '2026-11-20T12Z.json'), JSON.stringify(rec)); // cycle doesn't match its name
    expect(run('--kind', 'cycle', incoming, root).status).toBe(1);
    mkdirSync(join(root, 'cycles'), { recursive: true });
    expect(readdirSync(join(root, 'cycles'))).toEqual([]);
  });
});
