/**
 * "Last N days" station reports, aligned to one convention: each value is the
 * 24 h ending on the morning of the report date (ski-report style).
 *
 * Sources define their daily values differently, so each is shifted to match:
 *  - SLF HN_1D on date D           → already "24 h to the morning of D"
 *  - MeteoSwiss hns000d0 on date D → 06 UTC D → 06 UTC D+1, so it reports on D+1
 *  - ECCC TOTAL_SNOW on date D     → snowfall during climatological day D, reports on D+1
 *  - JMA 降雪 on date D             → snowfall during JST day D (00–24), reports on D+1
 *  - Depth/SWE changes             → reading(D) − reading(D−1); SNOTEL reads at midnight,
 *    ECCC in the morning, SLF/MeteoSwiss at 00/06 UTC, BC uses the day's median
 *    (about half a day later than the others), JMA the day's maximum (JST).
 */
import type { StationDef, StationSource } from '../config/stations';
import { valueOn, type StationFile } from './obs';
import { addDays } from './time';

/** Days to add to a source's new-snow date to get its report date. */
const NEW_SNOW_SHIFT: Partial<Record<StationSource, number>> = { SLF: 0, MeteoSwiss: 1, ECCC: 1, JMA: 1 };

export interface RecentDay {
  /** Report date: the 24 h ending on this morning. */
  date: string;
  newSnowCm: number | null;
  depthCm: number | null;
  depthChangeCm: number | null;
  sweChangeMm: number | null;
}

export function recentReports(st: StationDef, f: StationFile, lastDate: string, days = 7): RecentDay[] {
  const shift = NEW_SNOW_SHIFT[st.source];
  const out: RecentDay[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = addDays(lastDate, -i);
    const prev = addDays(date, -1);
    const d1 = valueOn(f, 'depthCm', date);
    const d0 = valueOn(f, 'depthCm', prev);
    const s1 = f.sweMm ? valueOn(f, 'sweMm', date) : null;
    const s0 = f.sweMm ? valueOn(f, 'sweMm', prev) : null;
    out.push({
      date,
      newSnowCm: shift != null && f.newSnowCm ? valueOn(f, 'newSnowCm', addDays(date, -shift)) : null,
      depthCm: d1,
      depthChangeCm: d1 != null && d0 != null ? d1 - d0 : null,
      sweChangeMm: s1 != null && s0 != null ? s1 - s0 : null,
    });
  }
  return out;
}

/** Does this station measure new snow directly (vs. only depth change)? */
export function measuresNewSnow(st: StationDef, f: StationFile): boolean {
  return NEW_SNOW_SHIFT[st.source] != null && !!f.newSnowCm;
}

export function sumOrNull(xs: (number | null)[]): number | null {
  const v = xs.filter((x): x is number => x != null);
  return v.length ? v.reduce((a, b) => a + b, 0) : null;
}
