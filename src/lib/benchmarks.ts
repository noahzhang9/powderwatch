/**
 * Official guidance shown as benchmarks behind the Storm tracker's "Compare with official guidance"
 * toggle: the provider's own product, never run through PowderWatch physics and never blended.
 */
import { toDaily, type DailyRow } from './forecast';
import type { NbmHourly } from './openmeteo';

/** NBM per local day (forecast.toDaily's convention): its own snowfall, precipitation, temperature and snow level; no rain field. */
export function nbmDaily(n: NbmHourly, tz: string): DailyRow[] {
  return toDaily({ time: n.time, snowCm: n.snowCm, rainMm: [], precip: n.precip, omSnowCm: [], tC: n.tC, fzl: [], snowLevel: n.snowLevel, gust: [] }, tz);
}
