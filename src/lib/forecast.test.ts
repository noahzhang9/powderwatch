import { describe, expect, it } from 'vitest';
import { ENSEMBLES, MODELS } from '../config/models';
import type { MemberSeries } from './ensemble';
import { RESORTS } from '../config/resorts';
import { DRIVEN_MIN_CM, blend, blendSnowParts, deriveModel, drivenDays, toDaily, type DerivedHourly } from './forecast';
import { PRESSURE_LEVELS, parseProfiles, type OmResponse, type SurfaceHourly } from './openmeteo';

const TZ = 'UTC';
const DAY = '2026-11-20';
const T0 = Date.UTC(2026, 10, 20) / 1000;
// 01:00 … 24:00 UTC: with the hour-ending convention, all 24 values belong to Nov 20.
const time = Array.from({ length: 24 }, (_, i) => T0 + (i + 1) * 3600);

/** A model snowing `perHour` cm every hour, with data for the first `hours` hours. */
const model = (id: string, perHour: number, hours = 24): DerivedHourly => {
  const on = <T,>(v: T) => time.map((_, i) => (i < hours ? v : null));
  return {
    model: MODELS[id], time, tC: on(-5), rh: on(90), precip: on(perHour / 10), snowCm: on(perHour), rainMm: on(0),
    omSnowCm: on(perHour * 0.7), fzl: on(1000), fzlSource: 'model', snowLevel: on(500), gust: on(20),
  };
};
const band = (models: DerivedHourly[]) => ({ models, blendDaily: toDaily(blend(models)!, TZ) });

const member = (defIdx: number, perHour: number): MemberSeries => ({
  def: ENSEMBLES[defIdx], member: 0, time, precip: time.map(() => 1), tC: time.map(() => -5), rh: time.map(() => 90),
  snowCm: time.map(() => perHour), fzl: time.map(() => 1000),
});
// One member each from ECMWF ENS, GEFS, GEPS, ICON-EPS: four centres.
const ens = (...perHour: number[]) => ({ time, members: perHour.map((v, k) => member([0, 2, 3, 4][k], v)) });

describe('blendSnowParts', () => {
  it("adds up to the blend's daily snowfall, using the blend's own weights", () => {
    const models = [model('ecmwf_ifs025', 2), model('ecmwf_aifs025_single', 0), model('gfs_global', 0.5), model('gem_global', 0.5)];
    const parts = blendSnowParts(models, TZ).get(DAY)!;
    const total = [...parts.values()].reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(band(models).blendDaily.find((d) => d.date === DAY)!.snowCm!);
    // ECMWF's weight (1/3) is split between IFS and AIFS: IFS gets 1/6 of each hour's blend.
    expect(parts.get('ecmwf_ifs025')).toBeCloseTo((24 * 2) / 6);
    expect(parts.get('gfs_global')).toBeCloseTo((24 * 0.5) / 3);
  });
});

describe('drivenDays', () => {
  it('flags a day one centre drives, naming its model', () => {
    // The Crystal case: GEM far above ECMWF and GFS.
    const models = [model('gem_global', 1.2), model('ecmwf_ifs025', 0.11), model('ecmwf_aifs025_single', 0.1), model('gfs_global', 0.01)];
    const d = drivenDays(band(models), TZ).get(DAY)!;
    expect(d.reasons).toEqual(['one-centre']);
    expect(d.driver?.family).toBe('ECCC');
    expect(d.driver?.models.map((m) => m.id)).toEqual(['gem_global']);
    expect(d.driver?.share).toBeGreaterThan(0.9);
    expect(d.ensP90).toBeNull();
  });

  it('does not flag agreement', () => {
    const models = [model('gem_global', 0.5), model('ecmwf_ifs025', 0.5), model('gfs_global', 0.4)];
    expect(drivenDays(band(models), TZ, ens(0.4, 0.5, 0.6, 0.5)).size).toBe(0);
  });

  it("uses the centre's weight, not its model's raw amount", () => {
    // IFS gives 64% of the models' summed snow, but ECMWF's weight is shared with AIFS: 47% of the blend.
    const models = [model('ecmwf_ifs025', 1.8), model('ecmwf_aifs025_single', 0), model('gfs_global', 0.5), model('gem_global', 0.5)];
    expect(drivenDays(band(models), TZ).has(DAY)).toBe(false);
  });

  it("lists a centre's models largest part first", () => {
    const models = [model('ecmwf_aifs025_single', 1), model('ecmwf_ifs025', 2), model('gfs_global', 0.1), model('gem_global', 0.1)];
    const d = drivenDays(band(models), TZ).get(DAY)!;
    expect(d.driver?.family).toBe('ECMWF');
    expect(d.driver?.models.map((m) => m.id)).toEqual(['ecmwf_ifs025', 'ecmwf_aifs025_single']);
  });

  it('ignores days under the minimum amount', () => {
    const perHour = (DRIVEN_MIN_CM * 0.9 * 3) / 24; // the blend gets a third of it: well under the minimum
    const models = [model('gem_global', perHour), model('ecmwf_ifs025', 0), model('gfs_global', 0)];
    expect(drivenDays(band(models), TZ, ens(0, 0, 0, 0)).size).toBe(0);
  });

  it('leaves days with fewer than 3 centres to the low-confidence mark', () => {
    const models = [model('gem_global', 1), model('gfs_global', 0.1)];
    expect(drivenDays(band(models), TZ).size).toBe(0);
  });

  it('ignores incomplete days', () => {
    const models = [model('gem_global', 2, 12), model('ecmwf_ifs025', 0, 12), model('gfs_global', 0, 12)];
    expect(drivenDays(band(models), TZ).size).toBe(0);
  });

  it('flags a blend above 90% of ensemble members, when enough centres cover the day', () => {
    const models = [model('gem_global', 0.5), model('ecmwf_ifs025', 0.5), model('gfs_global', 0.4)];
    const d = drivenDays(band(models), TZ, ens(0.1, 0.1, 0.2, 0.1)).get(DAY)!;
    expect(d.reasons).toEqual(['above-ensemble']);
    expect(d.driver).toBeNull();
    expect(d.ensP90).toBeCloseTo(0.2 * 24, 0);
    // Two ensemble centres aren't enough to judge by.
    expect(drivenDays(band(models), TZ, { time, members: ens(0.1, 0.1).members }).size).toBe(0);
  });

  it('gives both reasons when both apply', () => {
    const models = [model('gem_global', 1.2), model('ecmwf_ifs025', 0.1), model('gfs_global', 0.05)];
    expect(drivenDays(band(models), TZ, ens(0.05, 0.05, 0.1, 0.05)).get(DAY)?.reasons).toEqual(['one-centre', 'above-ensemble']);
  });
});

const [ID_A, ID_B] = RESORTS[0].models;
const S0 = Date.parse('2026-11-20T00:00:00Z') / 1000;
const surface = (modelId: string, precip: (number | null)[]): SurfaceHourly => {
  const time = precip.map((_, i) => S0 + i * 3600);
  return {
    modelId, time, precip,
    tC: time.map(() => 4), rh: time.map(() => 90), omSnowCm: time.map(() => null), fzl: time.map(() => 1500), gust: time.map(() => 20),
  };
};

describe('negative hourly precipitation (de-accumulation artefacts)', () => {
  it('counts as none in a model', () => {
    expect(deriveModel(surface(ID_A, [-3, 1.5, null])).precip).toEqual([0, 1.5, null]);
  });

  it('never lowers the blend', () => {
    const b = blend([deriveModel(surface(ID_A, [-3, 1.5])), deriveModel(surface(ID_B, [2, 1.5]))])!;
    expect(b.precip[0]).toBeGreaterThan(0);
    expect(b.precip[1]).toBeCloseTo(1.5);
  });
});

describe('a model without gusts or a freezing level of its own (JMA)', () => {
  const t = [S0, S0 + 3600, S0 + 7200];
  const Z: Record<number, number> = { 1000: 100, 925: 750, 850: 1450, 800: 1950, 700: 3000, 600: 4200, 500: 5600 };
  const ids = ['ecmwf_ifs025', 'gfs_global', 'jma_gsm'];
  // The pressure profile as Open-Meteo returns it for several models (6 °C − 6.5 °C/km): GSM has no 800 hPa level.
  const hourly: OmResponse['hourly'] = { time: t };
  for (const m of ids) {
    for (const p of PRESSURE_LEVELS) {
      const v = (x: number) => t.map(() => (m === 'jma_gsm' && p === 800 ? null : x));
      hourly[`temperature_${p}hPa_${m}`] = v(6 - 0.0065 * Z[p]);
      hourly[`relative_humidity_${p}hPa_${m}`] = v(90);
      hourly[`geopotential_height_${p}hPa_${m}`] = v(Z[p]);
    }
  }
  const profiles = parseProfiles({ hourly }, ids);
  const raw = (modelId: string, gust: number | null): SurfaceHourly => ({
    modelId, time: t, precip: t.map(() => 1), tC: t.map(() => -2), rh: t.map(() => 90), omSnowCm: t.map(() => 0.7),
    fzl: t.map(() => null), gust: t.map(() => gust),
  });
  const models = [deriveModel(raw('ecmwf_ifs025', 20), profiles), deriveModel(raw('gfs_global', 40), profiles), deriveModel(raw('jma_gsm', null), profiles)];

  it('computes its freezing and snow level from the profile, without the missing level', () => {
    expect(models[2].fzlSource).toBe('computed');
    expect(models[2].fzl[0]).toBeCloseTo(923, 0);
    expect(models[2].snowLevel[0]).not.toBeNull();
  });

  it("leaves it out of the blend's gust (and so the gust strip) but not its snow", () => {
    const b = blend(models)!;
    expect(b.count).toEqual([3, 3, 3]);
    expect(b.gust[0]).toBeCloseTo(30);
    expect(toDaily(models[2], TZ).map((d) => d.gustMax)).toEqual([null, null]);
    expect(toDaily(b, TZ).map((d) => d.gustMax)).toEqual([30, 30]);
  });
});
