/** Timezone-aware date helpers. All times are unix seconds (UTC) internally. */

const dateFmtCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = dateFmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
    });
    dateFmtCache.set(tz, f);
  }
  return f;
}

/** Local calendar date 'YYYY-MM-DD' and hour (0–23) of a unix time in a timezone. */
export function localParts(unix: number, tz: string): { date: string; hour: number } {
  const parts = partsFormatter(tz).formatToParts(new Date(unix * 1000));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) % 24 };
}

export const localDate = (unix: number, tz: string) => localParts(unix, tz).date;

/** Add days to an ISO date string (calendar arithmetic, timezone-free). */
export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export const nowUnix = () => Math.floor(Date.now() / 1000);

export function todayIn(tz: string): string {
  return localDate(nowUnix(), tz);
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function weekday(iso: string): string {
  return WEEKDAYS[new Date(`${iso}T12:00:00Z`).getUTCDay()];
}

/** 'Sat 22' style label for an ISO date. */
export function dayLabel(iso: string): string {
  return `${weekday(iso)} ${Number(iso.slice(8, 10))}`;
}

export function shortDate(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** A model run's start in the resort's local time: 'Nov 19, 4 AM' (pair it with zoneName once per view). */
export function runLabel(unix: number, tz: string): string {
  return new Date(unix * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', timeZone: tz });
}

/** A model run's start hour in the resort's local time: '4 AM'. */
export function runHour(unix: number, tz: string): string {
  return new Date(unix * 1000).toLocaleString('en-US', { hour: 'numeric', timeZone: tz });
}

/** The time zone's short name at `unix`: 'PST' / 'PDT' for the Pacific resorts, 'GMT+1' / 'GMT+2' for Verbier. */
export function zoneName(tz: string, unix: number): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(new Date(unix * 1000))
    .find((p) => p.type === 'timeZoneName')?.value ?? tz;
}

/** Human "3 h ago" for a unix time. */
export function ago(unix: number): string {
  const s = nowUnix() - unix;
  if (s < 90) return 'just now';
  if (s < 3600 * 1.5) return `${Math.round(s / 60)} min ago`;
  if (s < 86400 * 1.5) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export function localHourLabel(unix: number, tz: string): string {
  return new Date(unix * 1000).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', timeZone: tz });
}

/** Unix time of local midnight at the start of `iso` in `tz` (whole-hour offsets). */
export function localMidnightUnix(iso: string, tz: string): number {
  const guess = Date.parse(`${iso}T00:00:00Z`) / 1000;
  for (const shift of [0, -86400, 86400]) {
    const g = guess + shift;
    // Search the 24 h around the guess for the hour whose local time is iso 00:00.
    for (let h = -14; h <= 14; h++) {
      const t = g + h * 3600;
      const p = localParts(t, tz);
      if (p.date === iso && p.hour === 0) return t;
    }
  }
  return guess;
}
