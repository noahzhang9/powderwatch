import { describe, expect, it } from 'vitest';
import { runSnowpack, type ForcingHour } from './snowpack';

const hours = (n: number, f: (i: number) => Partial<ForcingHour>): ForcingHour[] =>
  Array.from({ length: n }, (_, i) => ({ time: Date.UTC(2026, 0, 1) / 1000 + i * 3600, precipMm: 0, tC: -5, rhPct: 90, ...f(i) }));

describe('runSnowpack', () => {
  it('accumulates and then settles a cold storm', () => {
    // 20 mm water at −5 °C over 10 h ≈ 26 cm of new snow.
    const out = runSnowpack({ depthCm: 0, month: 0 }, hours(96, (i) => ({ precipMm: i < 10 ? 2 : 0 })));
    const peak = Math.max(...out.map((p) => p.depthCm));
    expect(peak).toBeGreaterThan(20);
    expect(peak).toBeLessThan(30);
    const end = out[out.length - 1];
    expect(end.depthCm).toBeLessThan(peak * 0.8); // settled
    expect(end.depthCm).toBeGreaterThan(peak * 0.4);
    expect(end.sweMm).toBeCloseTo(20, 5); // no melt when cold
  });
  it('keeps an old cold pack nearly unchanged', () => {
    const out = runSnowpack({ depthCm: 150, sweMm: 500, month: 1 }, hours(72, () => ({})));
    expect(out[out.length - 1].depthCm).toBeGreaterThan(140);
  });
  it('melts in warm rain', () => {
    const out = runSnowpack({ depthCm: 100, month: 2 }, hours(48, () => ({ tC: 6, precipMm: 2, rhPct: 99 })));
    const end = out[out.length - 1];
    expect(end.depthCm).toBeLessThan(85);
    expect(out.every((p) => p.newSnowCm === 0)).toBe(true);
  });
  it('stops when forcing ends', () => {
    const f = hours(10, (i) => ({ precipMm: i > 4 ? null : 0 }));
    expect(runSnowpack({ depthCm: 10, month: 0 }, f)).toHaveLength(5);
  });
});
