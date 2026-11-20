import { describe, expect, it } from 'vitest';
import { localMidnightUnix, localParts, runHour, runLabel, zoneName } from './time';

describe('time', () => {
  it('finds local midnight', () => {
    expect(localMidnightUnix('2026-11-20', 'America/Los_Angeles')).toBe(Date.parse('2026-11-20T08:00:00Z') / 1000);
    expect(localMidnightUnix('2026-07-01', 'Europe/Zurich')).toBe(Date.parse('2026-06-30T22:00:00Z') / 1000);
  });
  it('reports local date and hour', () => {
    // America/Los_Angeles: stable rules (PST, UTC−8, in November). America/Vancouver moved to
    // permanent UTC−7 on 2026-11-01 (tzdata 2026b), so its result depends on the runtime's tz data.
    expect(localParts(Date.parse('2026-11-20T07:30:00Z') / 1000, 'America/Los_Angeles')).toEqual({ date: '2026-11-19', hour: 23 });
  });
});

describe('run times in the resort’s local time', () => {
  const run12z = Date.UTC(2026, 10, 19, 12) / 1000; // the 12Z cycle on Nov 19
  it('labels a run by its local start', () => {
    expect(runLabel(run12z, 'America/Los_Angeles')).toBe('Nov 19, 4 AM');
    expect(runHour(run12z, 'America/Los_Angeles')).toBe('4 AM');
    expect(runHour(run12z, 'Europe/Zurich')).toBe('1 PM');
    // 00Z is the evening before. (Not America/Vancouver: see 'reports local date and hour' above.)
    expect(runLabel(Date.UTC(2026, 10, 20, 0) / 1000, 'America/Los_Angeles')).toBe('Nov 19, 4 PM');
  });

  it('names the zone, with daylight saving', () => {
    expect(zoneName('America/Los_Angeles', run12z)).toBe('PST');
    expect(zoneName('America/Los_Angeles', Date.UTC(2026, 6, 1) / 1000)).toBe('PDT');
    expect(zoneName('Europe/Zurich', run12z)).toBe('GMT+1');
  });
});
