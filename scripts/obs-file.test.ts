import { describe, expect, it } from 'vitest';
import { addDays } from '../src/lib/time';
import { datedADayEarly, fromFile, toFile, type Daily } from './obs-file';

/** Daily SNOTEL values from inches, from `start` on, as scripts/fetch-obs.ts stores them. */
const daily = (start: string, depthIn: number[], sweIn: number[]): Daily =>
  new Map(depthIn.map((d, i) => [addDays(start, i), { depth: d * 2.54, swe: sweIn[i] * 25.4 }]));
/** Through a station file and back, so values carry the file's rounding. */
const viaFile = (d: Daily) => fromFile(toFile({ id: 'snotel-x' }, d));

describe('station files', () => {
  it('carry a mean-temperature series only when there are temperatures', () => {
    const d = daily('2026-11-18', [10, 12], [1.5, 1.6]);
    expect('tavgC' in toFile({ id: 'snotel-x' }, d)).toBe(false);
    d.get('2026-11-18')!.tavg = -3.27;
    const f = toFile({ id: 'snotel-x' }, d);
    expect(f.tavgC).toEqual([-3.3, null]);
    expect(Object.keys(f)).toEqual(['id', 'updated', 'start', 'depthCm', 'sweMm', 'newSnowCm', 'tavgC', 'lastDepthDate', 'lastSweDate']);
    expect(fromFile(f).get('2026-11-18')).toMatchObject({ tavg: -3.3 });
  });
});

describe('datedADayEarly', () => {
  // Stevens Pass SNOTEL (791:WA:SNTL), 2025-12-01 to 04, from AWDB: the default dating and periodRef=START.
  const awdbDefault = daily('2025-12-01', [10, 9, 9, 12], [1.5, 1.5, 1.5, 1.9]);
  const awdbStart = daily('2025-12-01', [10, 10, 9, 9], [1.3, 1.5, 1.5, 1.5]);

  it('spots a file in AWDB’s default dating against a periodRef=START fetch', () => {
    expect(datedADayEarly(viaFile(awdbDefault), awdbStart)).toBe(true);
  });

  it('accepts a file that already uses periodRef=START, also after a QC revision', () => {
    expect(datedADayEarly(viaFile(awdbStart), awdbStart)).toBe(false);
    const revised = daily('2025-12-01', [10, 10, 9, 9, 15, 22, 21], [1.3, 1.5, 1.5, 1.5, 2.4, 3.1, 3.1]);
    const before = daily('2025-12-01', [10, 10, 9, 9, 15, 23, 21], [1.3, 1.5, 1.5, 1.5, 2.4, 3.0, 3.1]);
    expect(datedADayEarly(viaFile(before), revised)).toBe(false);
  });

  it('never judges a window without any change early', () => {
    const flat = daily('2026-08-01', new Array(45).fill(0), new Array(45).fill(0));
    expect(datedADayEarly(viaFile(flat), flat)).toBe(false);
    expect(datedADayEarly(new Map(), awdbStart)).toBe(false);
  });
});
