import { describe, expect, it } from 'vitest';
import { FALLBACK_LAPSE, dailyDistributions, deriveMembers, probabilityFzlAbove, type MemberSeries } from './ensemble';
import { ENSEMBLES } from '../config/models';
import { ensembleUrl, parseEnsemble, type OmResponse } from './openmeteo';

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

describe('ensemble freezing level', () => {
  const pt = { lat: 46.93, lon: -121.49, elevation: 1740 };
  const hours = Array.from({ length: 48 }, (_, i) => T0 + (i + 1) * 3600);
  /** A response holding exactly the variables the URL asks for: two members at 2 °C, freezing level 2500 m where asked. */
  const respond = (url: string): OmResponse => {
    const hourly: OmResponse['hourly'] = { time: hours };
    for (const v of new URL(url).searchParams.get('hourly')!.split(',')) {
      const value = v === 'temperature_2m' ? 2 : v === 'freezing_level_height' ? 2500 : 1;
      for (const key of [v, `${v}_member01`]) hourly[key] = hours.map(() => value);
    }
    return { hourly, elevation: pt.elevation };
  };

  it('is requested only from the ensembles that publish one', () => {
    const vars = (id: string, opts?: { withFreezingLevel?: boolean }) => new URL(ensembleUrl(pt, id, 'UTC', opts)).searchParams.get('hourly')!.split(',');
    for (const e of ENSEMBLES) {
      expect(vars(e.id).includes('freezing_level_height')).toBe(e.nativeFreezingLevel);
      expect(vars(e.id, { withFreezingLevel: false })).toEqual(['precipitation', 'temperature_2m', 'relative_humidity_2m']);
    }
    expect(ENSEMBLES.filter((e) => e.nativeFreezingLevel).map((e) => e.id)).toEqual(['ncep_gefs_seamless']);
  });

  it("is estimated from each member's temperature where the ensemble has none, and feeds the freezing-level chances", () => {
    const sets = ENSEMBLES.map((e) => deriveMembers(parseEnsemble(respond(ensembleUrl(pt, e.id, 'UTC')), e.id, pt)));
    ENSEMBLES.forEach((e, i) => {
      expect(sets[i]).toHaveLength(2);
      for (const m of sets[i]) expect(m.fzl[0]).toBeCloseTo(e.nativeFreezingLevel ? 2500 : pt.elevation + 2 / FALLBACK_LAPSE);
    });
    const members = sets.flat();
    // 2 °C at 1740 m puts the estimate near 2050 m: above 2000 m for every member, below 2100 m.
    expect(probabilityFzlAbove(hours, members, T0, T0 + 48 * 3600, 2000)).toBe(1);
    // Only GEFS (2500 m) is above 2100 m: one centre of five.
    expect(probabilityFzlAbove(hours, members, T0, T0 + 48 * 3600, 2100)).toBeCloseTo(1 / 5);
  });
});
