import { describe, expect, it } from 'vitest';
import { RESORTS } from '../config/resorts';
import type { SurfaceHourly } from '../lib/openmeteo';
import { buildBandForecast } from './data';

const resort = RESORTS[0];
const T0 = Date.parse('2026-11-20T00:00:00Z') / 1000;
const time = Array.from({ length: 48 }, (_, i) => T0 + i * 3600);
const surface = (modelId: string, precip: number | null): SurfaceHourly => ({
  modelId, time,
  tC: time.map(() => -4), rh: time.map(() => 90), precip: time.map(() => precip),
  omSnowCm: time.map(() => null), fzl: time.map(() => 800), gust: time.map(() => 20),
});

describe('buildBandForecast', () => {
  it('is null, not a crash, when no model has data at the point', () => {
    expect(buildBandForecast(resort, resort.models.map((id) => surface(id, null)))).toBeNull();
    expect(buildBandForecast(resort, [])).toBeNull();
  });

  it('blends the models that have data and lists the rest as missing', () => {
    const [withData, ...without] = resort.models;
    const fc = buildBandForecast(resort, [surface(withData, 1), ...without.map((id) => surface(id, null))]);
    expect(fc?.models.map((m) => m.model.id)).toEqual([withData]);
    expect(fc?.missing).toEqual(without);
    expect(fc?.blendDaily.length).toBeGreaterThan(0);
  });
});
