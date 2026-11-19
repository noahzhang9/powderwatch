import { describe, expect, it } from 'vitest';
import { freezingLevel, freshSnowDensity, snowFraction, snowLevel, snowToLiquidRatio, splitPrecip, wetBulb } from './physics';

describe('wetBulb', () => {
  it('matches Stull (2011) reference value', () => {
    expect(wetBulb(20, 50)).toBeCloseTo(13.7, 1);
  });
  it('equals air temperature when saturated (within formula error)', () => {
    expect(Math.abs(wetBulb(0, 99) - 0)).toBeLessThan(0.5);
  });
});

describe('phase split', () => {
  it('is all snow below 0 °C wet-bulb and all rain above 2 °C', () => {
    expect(snowFraction(-1)).toBe(1);
    expect(snowFraction(1)).toBeCloseTo(0.5);
    expect(snowFraction(3)).toBe(0);
  });
  it('uses a temperature-dependent snow ratio', () => {
    expect(snowToLiquidRatio(0)).toBeCloseTo(8.4, 1);
    expect(snowToLiquidRatio(-10)).toBeGreaterThan(14);
    expect(freshSnowDensity(5)).toBe(200);
  });
  it('conserves water', () => {
    const s = splitPrecip(10, 0.8, 95);
    expect(s.snowWaterMm + s.rainMm).toBeCloseTo(10);
    expect(s.snowCm).toBeGreaterThan(0);
  });
});

describe('profile levels', () => {
  const profile = [
    { z: 110, t: 6, rh: 90 },
    { z: 760, t: 3, rh: 92 },
    { z: 1450, t: -1, rh: 95 },
    { z: 3000, t: -9, rh: 80 },
  ];
  it('interpolates the 0 °C height', () => {
    expect(freezingLevel(profile)).toBeCloseTo(760 + (3 / 4) * 690, 0);
  });
  it('places the snow level below the freezing level', () => {
    const fzl = freezingLevel(profile)!;
    const sl = snowLevel(profile)!;
    expect(sl).toBeLessThan(fzl);
    expect(sl).toBeGreaterThan(760);
  });
  it('reports the lowest level when fully frozen', () => {
    expect(freezingLevel([{ z: 100, t: -2 }, { z: 1500, t: -10 }])).toBe(100);
  });
  it('uses the top of a warm nose', () => {
    expect(freezingLevel([{ z: 100, t: -2 }, { z: 1000, t: 2 }, { z: 2000, t: -2 }])).toBeCloseTo(1500, 0);
  });
});
