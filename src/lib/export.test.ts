import { describe, expect, it } from 'vitest';
import { RESORTS } from '../config/resorts';
import { buildBandForecast } from '../hooks/data';
import { forecastDailyCsv, forecastMarkdown, exportFileName, type ForecastExportInput } from './export';
import type { DayDist } from './ensemble';
import { dailyCentres, type DrivenDay } from './forecast';
import type { SurfaceHourly } from './openmeteo';
import { makeFmt } from './prefs';
import { localMidnightUnix } from './time';

const resort = RESORTS.find((r) => r.id === 'crystal')!;
const band = resort.bands.find((b) => b.key === 'mid')!;
const [A, B] = resort.models;
const start = localMidnightUnix('2026-11-27', resort.tz);
// Two full local days and part of a third, hour-ending stamps.
const time = Array.from({ length: 60 }, (_, i) => start + (i + 1) * 3600);
const surface = (modelId: string, precip: number): SurfaceHourly => ({
  modelId, time,
  tC: time.map(() => -4), rh: time.map(() => 95), precip: time.map(() => precip),
  omSnowCm: time.map(() => precip * 0.7), fzl: time.map(() => 900), gust: time.map(() => 30),
});
const data = buildBandForecast(resort, [surface(A, 0.5), surface(B, 0.3)])!;
const dist: DayDist = { p10: 2, p50: 6, p90: 14, pLow: 0.3, pHigh: 0.3, lowMedian: 1, highMedian: 18, split: true, centres: 4, members: 120 };

function input(units: 'imperial' | 'metric', over: Partial<ForecastExportInput> = {}): ForecastExportInput {
  return {
    resort, band, data, fmt: makeFmt(units), nowS: start + 3600, today: '2026-11-27',
    centres: dailyCentres(data.models, resort.tz),
    dists: new Map([['2026-11-28', dist]]),
    driven: new Map<string, DrivenDay>([['2026-11-27', { blendCm: 9, reasons: ['one-centre'], driver: { family: data.models[0].model.family, share: 0.7, models: [data.models[0].model] }, ensP90: null }]]),
    siteUrl: 'https://example.org/#/resort/crystal/storm',
    ...over,
  };
}

describe('forecastMarkdown', () => {
  const md = forecastMarkdown(input('imperial'));

  it('states the place, units, runs and sources', () => {
    expect(md).toContain(`# PowderWatch forecast: ${resort.name}, mid band`);
    expect(md).toContain('Units: snow in, water in, elevation ft');
    expect(md).toContain('Latest model runs:');
    expect(md).toContain('Open-Meteo (open-meteo.com, CC BY 4.0)');
    expect(md).toContain('Exported from PowderWatch: https://example.org/');
    expect(md).toContain('## How to read this');
  });

  it('has one table row per day from today, with a column per model', () => {
    const rows = md.split('\n').filter((l) => /^\| (Fri|Sat|Sun|Mon|Tue|Wed|Thu),/.test(l));
    expect(rows.map((r) => r.split(' | ')[0])).toEqual(['| Fri, Nov 27', '| Sat, Nov 28', '| Sun, Nov 29']);
    const header = md.split('\n').find((l) => l.startsWith('| Date'))!;
    for (const m of data.models) expect(header).toContain(m.model.label);
  });

  it('spells out the flags the chart marks', () => {
    expect(md).toContain('outlier (');
    expect(md).toContain('supplies 70% of the blend');
    expect(md).toContain('split: 30% of ensemble members little or none, 30% a lot');
    expect(md).toMatch(/partial day \(12 h\)/);
    expect(md).toMatch(/only 2 forecast centres/);
  });

  it('carries the resort note where there is one (Niseko)', () => {
    const niseko = RESORTS.find((r) => r.id === 'niseko')!;
    const out = forecastMarkdown(input('metric', { resort: niseko, band: niseko.bands[1] }));
    expect(out).toContain('Model output, not an official forecast');
  });
});

describe('forecastDailyCsv', () => {
  it('writes tidy rows in the units shown, from today on', () => {
    const csv = forecastDailyCsv(input('metric'));
    const lines = csv.trim().split('\n');
    expect(lines.filter((l) => l.startsWith('#'))).toHaveLength(3);
    expect(lines.filter((l) => l.startsWith('#')).every((l) => !l.includes(','))).toBe(true);
    expect(lines[3]).toBe('date,series,variable,value,unit');
    const rows = lines.slice(4).map((l) => l.split(','));
    expect(rows.every((r) => r.length === 5)).toBe(true);
    expect(new Set(rows.map((r) => r[0]))).toEqual(new Set(['2026-11-27', '2026-11-28', '2026-11-29']));
    expect(rows.find((r) => r[1] === 'blend' && r[2] === 'snow')?.[4]).toBe('cm');
    expect(rows.find((r) => r[1] === 'ensemble' && r[2] === 'snow_p50')).toEqual(['2026-11-28', 'ensemble', 'snow_p50', '6', 'cm']);
    // Open-Meteo's own snowfall only for the blend, and named as a comparison.
    const raw = rows.filter((r) => r[2].startsWith('open_meteo_snowfall'));
    expect(raw.length).toBeGreaterThan(0);
    expect(raw.every((r) => r[1] === 'blend')).toBe(true);
  });

  it('converts to imperial', () => {
    const rows = forecastDailyCsv(input('imperial')).trim().split('\n').slice(4).map((l) => l.split(','));
    expect(rows.find((r) => r[1] === 'blend' && r[2] === 'snow')?.[4]).toBe('in');
    expect(rows.find((r) => r[2] === 'temperature_min')?.[4]).toBe('°F');
  });

  it('names files by resort, band and date', () => {
    expect(exportFileName(input('metric'), 'daily.csv')).toBe('powderwatch-crystal-mid-2026-11-27-daily.csv');
  });
});
