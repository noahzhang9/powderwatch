import { describe, expect, it } from 'vitest';
import { RESORTS } from '../config/resorts';
import { buildBandForecast } from '../hooks/data';
import { BLOCK_H, blockLabel, dayBlocks, snowiestBlock } from './blocks';
import { forecastBlocksCsv } from './export';
import type { SurfaceHourly } from './openmeteo';
import { makeFmt } from './prefs';
import { localMidnightUnix } from './time';

const resort = RESORTS.find((r) => r.id === 'crystal')!;
const band = resort.bands.find((b) => b.key === 'mid')!;
const [A, B] = resort.models;
const TZ = resort.tz;

/** Two models over the given local days, hour-ending stamps from local midnight; precipitation per hour by index. */
function forecast(firstDate: string, hours: number, precipA: (i: number) => number, precipB: (i: number) => number, tC = -4, fzlM = 900) {
  const start = localMidnightUnix(firstDate, TZ);
  const time = Array.from({ length: hours }, (_, i) => start + (i + 1) * 3600);
  const surface = (modelId: string, f: (i: number) => number): SurfaceHourly => ({
    modelId, time, tC: time.map(() => tC), rh: time.map(() => 95), precip: time.map((_, i) => f(i)),
    omSnowCm: time.map(() => 0), fzl: time.map(() => fzlM), gust: time.map((_, i) => 20 + i),
  });
  return buildBandForecast(resort, [surface(A, precipA), surface(B, precipB)])!;
}

describe('dayBlocks', () => {
  const data = forecast('2026-11-27', 48, (i) => (i >= 3 && i < 9 ? 1 + (i % 3) * 0.5 : 0), () => 0.6);

  it('splits a local day into eight 3-hour blocks whose snow adds up to the day', () => {
    const blocks = dayBlocks(data, '2026-11-27', TZ, band.elevation);
    expect(blocks).toHaveLength(24 / BLOCK_H);
    expect(blocks.every((b) => b.hours === 3)).toBe(true);
    const day = data.blendDaily.find((d) => d.date === '2026-11-27')!;
    const sum = blocks.reduce((s, b) => s + (b.snowCm ?? 0), 0);
    expect(sum).toBeCloseTo(day.snowCm!, 6);
    expect(blockLabel(blocks[0].start, blocks[0].end, TZ)).toBe('12–3 AM');
    expect(blockLabel(blocks[3].start, blocks[3].end, TZ)).toBe('9 AM–12 PM');
    // Temperature and gusts are the block's own extremes (gust rises 1 km/h an hour in this fixture).
    expect([blocks[1].tMin, blocks[1].tMax]).toEqual([-4, -4]);
    expect(blocks[1].gustMax).toBe(20 + 5);
    expect(blocks[2].snowLevelMin).not.toBeNull();
  });

  it('finds the snowiest block', () => {
    const blocks = dayBlocks(data, '2026-11-27', TZ, band.elevation);
    const best = snowiestBlock(blocks)!;
    expect([blocks[1].start, blocks[2].start]).toContain(best.start);
  });

  it('flags a model whose block holds one spread value (coarser output), not one that varies', () => {
    const blocks = dayBlocks(data, '2026-11-27', TZ, band.elevation);
    const b = blocks[2]; // hours 6–9: model A varies 1, 1.5, 2; model B is 0.6 every hour
    expect(b.models.find((m) => m.id === A)?.coarse).toBe(false);
    expect(b.models.find((m) => m.id === B)?.coarse).toBe(true);
    // A dry block is never "coarse".
    const dry = forecast('2026-11-27', 24, () => 0, () => 0);
    expect(dayBlocks(dry, '2026-11-27', TZ, band.elevation).some((x) => x.models.some((m) => m.coarse))).toBe(false);
  });

  it('gives a partial block no total, and handles a 25-hour day', () => {
    const short = forecast('2026-11-27', 10, () => 1, () => 1);
    const blocks = dayBlocks(short, '2026-11-27', TZ, band.elevation);
    expect(blocks[3].hours).toBe(1);
    expect(blocks[3].snowCm).toBeNull();
    expect(blocks[4].hours).toBe(0);
    // America/Los_Angeles falls back on 2026-11-01: 25 local hours, so a ninth, one-hour block.
    const dst = forecast('2026-11-01', 30, () => 0.5, () => 0.5);
    const fall = dayBlocks(dst, '2026-11-01', TZ, band.elevation);
    expect(fall).toHaveLength(9);
    expect(fall.reduce((s, b) => s + b.hours, 0)).toBe(25);
  });

  it('calls a warm block rain and a dry one dry', () => {
    const warm = forecast('2026-11-27', 24, () => 2, () => 2, 8, 3000); // freezing level well above the band
    expect(dayBlocks(warm, '2026-11-27', TZ, band.elevation)[0].phase).toBe('rain');
    const dry = forecast('2026-11-27', 24, () => 0, () => 0);
    expect(dayBlocks(dry, '2026-11-27', TZ, band.elevation)[0].phase).toBe('dry');
  });
});

describe('forecastBlocksCsv', () => {
  it('writes local start/end times and the blend, models and flags', () => {
    const data = forecast('2026-11-27', 48, (i) => (i < 6 ? 1 + i * 0.1 : 0), () => 0.6);
    const csv = forecastBlocksCsv({ resort, band, data, fmt: makeFmt('metric'), nowS: localMidnightUnix('2026-11-27', TZ), today: '2026-11-27', siteUrl: 'https://example.org/' });
    const lines = csv.trim().split('\n');
    expect(lines.slice(0, 3).every((l) => l.startsWith('#') && !l.includes(','))).toBe(true);
    expect(lines[3]).toBe('start,end,series,variable,value,unit');
    const rows = lines.slice(4).map((l) => l.split(','));
    expect(rows[0].slice(0, 4)).toEqual(['2026-11-27T00:00', '2026-11-27T03:00', 'blend', 'snow']);
    expect(rows.some((r) => r[3] === 'spread_from_coarser_output')).toBe(true);
    expect(rows.some((r) => r[3] === 'precipitation_type' && r[4] === 'snow')).toBe(true);
  });
});
