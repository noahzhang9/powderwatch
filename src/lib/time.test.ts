import { describe, expect, it } from 'vitest';
import { localMidnightUnix, localParts } from './time';

describe('time', () => {
  it('finds local midnight', () => {
    expect(localMidnightUnix('2026-11-20', 'America/Los_Angeles')).toBe(Date.parse('2026-11-20T08:00:00Z') / 1000);
    expect(localMidnightUnix('2026-07-01', 'Europe/Zurich')).toBe(Date.parse('2026-06-30T22:00:00Z') / 1000);
  });
  it('reports local date and hour', () => {
    expect(localParts(Date.parse('2026-11-20T07:30:00Z') / 1000, 'America/Vancouver')).toEqual({ date: '2026-11-19', hour: 23 });
  });
});
