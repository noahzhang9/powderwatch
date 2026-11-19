import { describe, expect, it } from 'vitest';
import { dailyDistributions, type MemberSeries } from './ensemble';
import { ENSEMBLES } from '../config/models';

const T0 = Date.UTC(2026, 10, 20) / 1000;
const time = Array.from({ length: 24 }, (_, i) => T0 + (i + 1) * 3600);
const member = (defIdx: number, perHour: number): MemberSeries => ({
  def: ENSEMBLES[defIdx], member: 0, time, precip: time.map(() => 1), tC: time.map(() => -5), rh: time.map(() => 90),
  snowCm: time.map(() => perHour), fzl: time.map(() => 1000),
});
const day = () => '2026-11-20';

describe('dailyDistributions', () => {
  it('flags a split day when centres disagree', () => {
    // ECMWF dry (0 cm), NOAA stormy (24 cm), ECCC stormy.
    const d = dailyDistributions(time, [member(0, 0), member(2, 1), member(3, 1)], day).get('2026-11-20')!;
    expect(d.split).toBe(true);
    expect(d.pLow).toBeCloseTo(1 / 3);
    expect(d.pHigh).toBeCloseTo(2 / 3);
    expect(d.highMedian).toBeCloseTo(24);
    expect(d.centres).toBe(3);
  });
  it('does not flag agreement', () => {
    const d = dailyDistributions(time, [member(0, 1), member(2, 1)], day).get('2026-11-20')!;
    expect(d.split).toBe(false);
    expect(d.p50).toBeCloseTo(24);
  });
});
