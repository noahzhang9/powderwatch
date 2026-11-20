import { describe, expect, it } from 'vitest';
import type { StationDef } from '../config/stations';
import {
  DEFAULT_SLR, MIN_COMPARE_SEASONS, MIN_SWE_GAIN_MM, SLR_RANGE, estimateDay, estimateOn, estimatesNewSnow, seasonEstimate, totalEstimate,
} from './newsnow';
import type { StationFile } from './obs';
import { snowToLiquidRatio } from './physics';
import { addDays, daysBetween } from './time';

const station = (over: Partial<StationDef> = {}): StationDef => ({
  id: 'snotel-x', resortId: 'r', name: 'X', source: 'SNOTEL', sourceId: '1:WA:SNTL', lat: 0, lon: 0, elevation: 1200, swe: true,
  url: '', attribution: '', dailyNote: '', ...over,
});
const file = (start: string, depthCm: (number | null)[], sweMm: (number | null)[] | null, tavgC?: (number | null)[]): StationFile => ({
  id: 'snotel-x', updated: '', start, depthCm, sweMm, newSnowCm: null, tavgC: tavgC ?? null,
  lastDepthDate: addDays(start, depthCm.length - 1), lastSweDate: sweMm ? addDays(start, sweMm.length - 1) : null,
});

describe('estimateDay', () => {
  it('takes the water gained times the ratio at the mean temperature when that is more than the depth gain', () => {
    const slr = snowToLiquidRatio(-5);
    const e = estimateDay(100, 110, 300, 320, -5);
    expect(e).toMatchObject({ kind: 'snow', slr, tavgC: -5, sweGainMm: 20, depthChangeCm: 10 });
    if (e?.kind !== 'snow') throw new Error('not snow');
    expect(e.cm).toBeCloseTo(2 * slr, 9);
    expect(e.lowCm).toBeCloseTo(2 * slr * SLR_RANGE.low, 9);
    expect(e.highCm).toBeCloseTo(2 * slr * SLR_RANGE.high, 9);
  });

  it('keeps the depth gain when it is more (the low end first)', () => {
    // 10 mm at 0 °C is about 8 cm of snow; ×1.3 is about 11 cm, still under the 30 cm the depth gained.
    expect(estimateDay(50, 80, 100, 110, 0)).toMatchObject({ kind: 'snow', cm: 30, lowCm: 30, highCm: 30 });
    const e = estimateDay(50, 60, 100, 110, 0);
    if (e?.kind !== 'snow') throw new Error('not snow');
    expect([e.lowCm, e.cm]).toEqual([10, 10]); // 6.7 and 8.4 cm from the water
    expect(e.highCm).toBeCloseTo(1.3 * snowToLiquidRatio(0), 9);
  });

  it('flags water gained while depth fell as rain or mixed, with no estimate', () => {
    expect(estimateDay(120, 112, 400, 425, 1.5)).toEqual({ kind: 'rain-or-mixed', sweGainMm: 25, depthChangeCm: -8 });
  });

  it(`counts no new snow below ${MIN_SWE_GAIN_MM} mm of water, whatever depth did`, () => {
    expect(estimateDay(100, 105, 35.6, 38.1, -8)).toMatchObject({ kind: 'none' }); // one 0.1 in step
    expect(estimateDay(100, 95, 35.6, 38.1, -8)).toMatchObject({ kind: 'none' }); // settling, not rain
    expect(estimateDay(100, 100, 35.6, 40.6, -8)).toMatchObject({ kind: 'snow' }); // two steps: 5.0 mm
    expect(estimateDay(100, 100, 33.0, 38.1, -8)).toMatchObject({ kind: 'snow' }); // two steps: 5.1 mm
  });

  it(`falls back to ${DEFAULT_SLR}:1 without a temperature`, () => {
    expect(estimateDay(100, 101, 300, 320, null)).toMatchObject({ kind: 'snow', slr: DEFAULT_SLR, tavgC: null, cm: 20, lowCm: 16, highCm: 26 });
  });

  it('needs both readings of depth and SWE', () => {
    expect(estimateDay(null, 101, 300, 320, -3)).toBeNull();
    expect(estimateDay(100, 101, 300, null, -3)).toBeNull();
  });
});

describe('estimateOn', () => {
  it("uses the mean temperature of the day before the report date (the 24 h ending at that date's midnight)", () => {
    const f = file('2026-11-18', [10, 10, 30], [20, 20, 45], [5, -10, 4]);
    expect(estimateOn(f, '2026-11-20')).toMatchObject({ kind: 'snow', tavgC: -10, slr: snowToLiquidRatio(-10) });
    expect(estimateOn(f, '2026-11-19')).toMatchObject({ kind: 'none' });
    expect(estimateOn(f, '2026-11-18')).toBeNull(); // no reading the day before
  });
});

describe('totalEstimate', () => {
  it('sums snow days only, and counts the rest', () => {
    const f = file('2026-11-14', [0, 10, 10, 4, 20, 20, 20], [0, 12, 12, 30, 45, 46, null], [null, 0, 0, -4, -3, -3, -3]);
    const t = totalEstimate(f, '2026-11-15', '2026-11-21');
    // 11-15: +12 mm, +10 cm, no temperature for 11-14 → 10:1, 12 cm. 11-16: nothing gained. 11-17: +18 mm while depth
    // fell 6 cm, rain or mixed. 11-18: +15 mm at −4 °C, more than the 16 cm depth gain. 11-19: +1 mm. 11-20, 11-21: no SWE.
    expect(t).toMatchObject({ span: 7, days: 5, snowDays: 2, rainOrMixedDays: 1, defaultRatioDays: 1, sweGainMm: 27 });
    const day18 = 1.5 * snowToLiquidRatio(-4);
    expect(day18).toBeGreaterThan(16);
    expect(t.cm).toBeCloseTo(12 + day18, 9);
    expect(t.lowCm).toBeCloseTo(Math.max(10, 12 * 0.8) + Math.max(16, day18 * 0.8), 9);
    expect(t.highCm).toBeCloseTo(12 * 1.3 + day18 * 1.3, 9);
  });
});

describe('estimatesNewSnow', () => {
  const f = file('2026-11-18', [10], [20]);
  it('is for SNOTEL stations with SWE only', () => {
    expect(estimatesNewSnow(station(), f)).toBe(true);
    expect(estimatesNewSnow(station(), { ...f, sweMm: null })).toBe(false);
    expect(estimatesNewSnow(station({ swe: false }), f)).toBe(false);
    expect(estimatesNewSnow(station({ source: 'BC-ASWS' }), f)).toBe(false);
    expect(estimatesNewSnow(station({ source: 'SLF', swe: false }), { ...f, newSnowCm: [3] })).toBe(false);
    expect(estimatesNewSnow(station({ source: 'SNODAS', modelled: true }), f)).toBe(false);
  });
});

describe('seasonEstimate', () => {
  /** Snow on the 5th, 10th, … of each month (12 mm, +12 cm), settling 1 cm a day otherwise, −2 °C throughout. */
  function history(start: string, end: string, gap?: [string, string]) {
    const n = daysBetween(start, end) + 1;
    const depth: (number | null)[] = [];
    const swe: (number | null)[] = [];
    let d = 0;
    let w = 0;
    for (let i = 0; i < n; i++) {
      const date = addDays(start, i);
      const snow = Number(date.slice(8)) % 5 === 0;
      d = snow ? d + 12 : Math.max(0, d - 1);
      w = snow ? w + 12 : w;
      const missing = gap && date >= gap[0] && date <= gap[1];
      depth.push(missing ? null : d);
      swe.push(missing ? null : w);
    }
    return file(start, depth, swe, new Array(n).fill(-2));
  }

  it('sums this season to the last reading and compares it with past seasons over the same span', () => {
    const f = history('2019-09-30', '2026-11-20', ['2021-10-05', '2021-10-25']);
    const s = seasonEstimate(f, '2026-11-20')!;
    expect([s.season, s.through, s.total.span]).toEqual([2026, '2026-11-20', 51]);
    expect(s.total.snowDays).toBe(10); // Oct 5 … Nov 20, every 5th
    expect(s.total.cm).toBeCloseTo(10 * Math.max(12, 1.2 * snowToLiquidRatio(-2)), 9);
    expect(s.pastSeasons).toBe(6); // 2019–2025 but 2021, whose October is missing
    expect(s.pastMedian!.cm).toBeCloseTo(s.total.cm, 9); // the same days of snow every season
    expect(s.pastMedian!.lowCm).toBeCloseTo(s.total.lowCm, 9);
    expect(s.pastMedian!.highCm).toBeCloseTo(s.total.highCm, 9);
  });

  it(`gives no median with fewer than ${MIN_COMPARE_SEASONS} past seasons, and nothing without a reading this season`, () => {
    const f = history('2023-09-30', '2026-11-20');
    expect(seasonEstimate(f, '2026-11-20')).toMatchObject({ pastSeasons: 3, pastMedian: null });
    expect(seasonEstimate(history('2023-09-30', '2026-06-30'), '2026-11-20')).toBeNull();
  });
});
