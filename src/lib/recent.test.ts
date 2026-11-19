import { describe, expect, it } from 'vitest';
import { recentReports } from './recent';
import type { StationDef } from '../config/stations';
import type { StationFile } from './obs';

const base = { id: 'x', resortId: 'r', name: 'X', sourceId: 'X', lat: 0, lon: 0, elevation: 2000, swe: false, url: '', attribution: '', dailyNote: '' };
const file = (over: Partial<StationFile>): StationFile => ({
  id: 'x', updated: '', start: '2026-11-10', depthCm: [10, 10, 30, 28, 27], sweMm: null, newSnowCm: [0, 0, 20, 0, 5], lastDepthDate: null, lastSweDate: null, ...over,
});

describe('recentReports', () => {
  it('keeps SLF new snow on its own date and diffs depth', () => {
    const r = recentReports({ ...base, source: 'SLF' } as StationDef, file({}), '2026-11-14', 3);
    expect(r.map((d) => d.date)).toEqual(['2026-11-12', '2026-11-13', '2026-11-14']);
    expect(r.map((d) => d.newSnowCm)).toEqual([20, 0, 5]);
    expect(r.map((d) => d.depthChangeCm)).toEqual([20, -2, -1]);
  });
  it('shifts MeteoSwiss 06→06 UTC new snow to the next morning', () => {
    const r = recentReports({ ...base, source: 'MeteoSwiss' } as StationDef, file({}), '2026-11-14', 3);
    expect(r.map((d) => d.newSnowCm)).toEqual([0, 20, 0]);
  });
  it('has no new-snow value for depth-only sources', () => {
    const r = recentReports({ ...base, source: 'SNOTEL' } as StationDef, file({ newSnowCm: null }), '2026-11-14', 2);
    expect(r.every((d) => d.newSnowCm == null)).toBe(true);
  });
});
