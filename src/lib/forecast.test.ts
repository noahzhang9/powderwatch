import { describe, expect, it } from 'vitest';
import { RESORTS } from '../config/resorts';
import { blend, deriveModel } from './forecast';
import type { SurfaceHourly } from './openmeteo';

const [ID_A, ID_B] = RESORTS[0].models;
const T0 = Date.parse('2026-11-20T00:00:00Z') / 1000;
const surface = (modelId: string, precip: (number | null)[]): SurfaceHourly => {
  const time = precip.map((_, i) => T0 + i * 3600);
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
