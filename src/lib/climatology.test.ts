import { describe, expect, it } from 'vitest';
import { buildClimatology, percentileRank, seasonDate, seasonIndex, typicalDayFor, SEASON_DAYS } from './climatology';
import type { StationFile } from './obs';

describe('season calendar', () => {
  it('maps dates to season days and back', () => {
    expect(seasonIndex('2025-10-01')).toEqual({ season: 2025, k: 0 });
    expect(seasonIndex('2026-01-01')).toEqual({ season: 2025, k: 92 });
    expect(seasonDate(2025, 92)).toBe('2026-01-01');
    expect(seasonDate(2025, SEASON_DAYS - 1)).toBe('2026-06-30');
    expect(seasonIndex('2024-02-29')!.k).toBe(seasonIndex('2024-02-28')!.k);
    expect(seasonIndex('2026-08-01')).toBeNull();
  });
});

describe('buildClimatology', () => {
  // Sixteen synthetic seasons (2010–2025); season s peaks at 100 + 10*s cm on Mar 1, linear ramps.
  const start = '2010-10-01';
  const days = Math.round((Date.parse('2026-11-19') - Date.parse(start)) / 86_400_000) + 1;
  const depth: (number | null)[] = Array.from({ length: days }, (_, i) => {
    const d = new Date(Date.parse(start) + i * 86_400_000).toISOString().slice(0, 10);
    const si = seasonIndex(d);
    if (!si || si.season > 2025) return null;
    const peakK = seasonIndex('2011-03-01')!.k;
    const peak = 100 + 10 * (si.season - 2010);
    return si.k <= peakK ? (peak * si.k) / peakK : Math.max(0, peak * (1 - (si.k - peakK) / 120));
  });
  const f: StationFile = { id: 't', updated: '', start, depthCm: depth, sweMm: null, lastDepthDate: null, lastSweDate: null };
  const c = buildClimatology(f, 'depthCm', '2026-11-19')!;
  it('uses complete past seasons only', () => {
    expect(c.seasons).toHaveLength(16);
    expect(c.seasons).not.toContain(2026);
  });
  it('orders percentiles', () => {
    const k = seasonIndex('2026-02-01')!.k;
    expect(c.p10[k]!).toBeLessThan(c.p50[k]!);
    expect(c.p50[k]!).toBeLessThan(c.p90[k]!);
  });
  it('ranks and dates a value', () => {
    const k = seasonIndex('2026-03-01')!.k;
    expect(percentileRank(c, k, 1000)).toBe(100);
    expect(percentileRank(c, k, 0)).toBe(0);
    const day = typicalDayFor(c, c.p50[k]!)!;
    expect(Math.abs(day - k)).toBeLessThanOrEqual(3);
  });
});
