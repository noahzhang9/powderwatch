/**
 * NOAA/NWS Weather Prediction Center (WPC) probabilistic winter precipitation outlook: the chance of at
 * least 4, 8 and 12 inches of snow in each of WPC's Day 1–3 periods, at each US resort's mid band.
 *
 * The scheduled job (scripts/snapshot-forecasts.ts) queries WPC's ArcGIS service and writes a small static
 * file next to the forecast snapshot; the browser only ever reads that same-origin file, so visits make no
 * calls to NOAA and the Content-Security-Policy needs no new host. This module is pure: the job's parser,
 * the file format, and the browser's validation of the file.
 *
 * WPC publishes categories, not values: polygons for "Slight (10-39%)", "Moderate (40-69%)" and "High
 * (70-100%)" (field `dn` 1/2/3), nested, so a point inside a High area also lies in the Moderate and Slight
 * ones. A point's category is the highest polygon it falls in; outside every polygon the chance is under 10%.
 * Each WPC day is a 24 h period (00Z–00Z or 12Z–12Z, by issuance), not a local calendar day.
 */
import type { Resort } from '../config/resorts';
import { midBand } from './requests';

export const WPC_SERVICE = 'https://mapservices.weather.noaa.gov/vector/rest/services/precip/wpc_prob_winter_precip/MapServer';
export const WPC_PAGE = 'https://www.wpc.ncep.noaa.gov/wwd/winter_wx.shtml';
export const WPC_ATTRIBUTION = 'NOAA/NWS Weather Prediction Center';
export const WPC_THRESHOLDS_IN = [4, 8, 12] as const;
/** Layer ids by [day − 1][threshold index]: Day 1 ≥ 4/8/12 in = layers 1–3, Day 2 = 6–8, Day 3 = 11–13. */
export const WPC_LAYERS = [[1, 2, 3], [6, 7, 8], [11, 12, 13]] as const;
export const WPC_DAYS = WPC_LAYERS.length;

/** 0: under 10% (outside every polygon), 1: 10–39%, 2: 40–69%, 3: 70% or more. */
export type WpcCategory = 0 | 1 | 2 | 3;
export const WPC_CATEGORY_LABEL = ['< 10%', '10–39%', '40–69%', '≥ 70%'] as const;
/** The `outlook` text WPC pairs with each `dn` code. */
const OUTLOOK_PREFIX = ['', 'Slight', 'Moderate', 'High'];

export const wpcPointUrl = (layer: number, lon: number, lat: number) =>
  `${WPC_SERVICE}/${layer}/query?geometry=${lon},${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=false&f=json`;
/** Every distinct issue/valid time in a layer, so a day's period is known even where no polygon reaches a resort. */
export const wpcTimesUrl = (layer: number) =>
  `${WPC_SERVICE}/${layer}/query?where=1%3D1&outFields=issue_time,start_time,end_time&returnDistinctValues=true&returnGeometry=false&f=json`;

export interface WpcPeriod {
  /** UTC, 'YYYY-MM-DDTHH:MMZ'. */
  start: string;
  end: string;
  issued: string;
}

export interface WpcFile {
  v: 1;
  /** When the job queried WPC, unix s. */
  fetchedAt: number;
  thresholdsIn: number[];
  /** Day 1–3 periods; null when WPC's layers for that day gave no times and none could be inferred. */
  days: (WpcPeriod | null)[];
  /** Per resort id: the mid band's point and category[day − 1][threshold] (null: unknown, e.g. a failed query). */
  points: Record<string, { lat: number; lon: number; cat: (WpcCategory | null)[][] }>;
}

const WPC_TIME = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}):\d{2}$/;
const ISO_MIN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/;

/** '2026-11-20 00:00:00' (UTC) → '2026-11-20T00:00Z'; null for anything else. */
export function wpcTime(x: unknown): string | null {
  const m = typeof x === 'string' ? WPC_TIME.exec(x) : null;
  return m ? `${m[1]}T${m[2]}Z` : null;
}

const attrsOf = (json: unknown): Record<string, unknown>[] | null => {
  if (!json || typeof json !== 'object' || 'error' in json) return null;
  const f = (json as { features?: unknown }).features;
  if (!Array.isArray(f)) return null;
  const out: Record<string, unknown>[] = [];
  for (const x of f) {
    const a = (x as { attributes?: unknown } | null)?.attributes;
    if (!a || typeof a !== 'object') return null;
    out.push(a as Record<string, unknown>);
  }
  return out;
};

const periodOf = (a: Record<string, unknown>): WpcPeriod | null => {
  const start = wpcTime(a.start_time);
  const end = wpcTime(a.end_time);
  const issued = wpcTime(a.issue_time);
  return start && end && issued && Date.parse(end.replace('Z', ':00Z')) > Date.parse(start.replace('Z', ':00Z')) ? { start, end, issued } : null;
};

/** A layer's period from its distinct-times response: the latest issuance (a layer mid-update can list two). Null if none. */
export function parseLayerTimes(json: unknown): WpcPeriod | null | undefined {
  const attrs = attrsOf(json);
  if (!attrs) return undefined; // not a valid response
  const ps = attrs.map(periodOf).filter((p): p is WpcPeriod => p != null);
  return ps.sort((a, b) => (a.issued < b.issued ? 1 : -1))[0] ?? null;
}

/**
 * A point's category from its point-query response: the highest of the polygons it falls in, 0 when it falls
 * in none, null when the response isn't a valid query result or a polygon's code and label disagree.
 * Also returns the polygons' period, to check it against the day's.
 */
export function parsePointCategory(json: unknown): { cat: WpcCategory; period: WpcPeriod | null } | null {
  const attrs = attrsOf(json);
  if (!attrs) return null;
  let cat: WpcCategory = 0;
  let period: WpcPeriod | null = null;
  for (const a of attrs) {
    const dn = a.dn;
    if (dn !== 1 && dn !== 2 && dn !== 3) return null;
    if (typeof a.outlook !== 'string' || !a.outlook.startsWith(OUTLOOK_PREFIX[dn])) return null;
    if (dn > cat) cat = dn;
    period ??= periodOf(a);
  }
  return { cat, period };
}

const samePeriod = (a: WpcPeriod | null, b: WpcPeriod | null) => a != null && b != null && a.start === b.start && a.end === b.end;
const shift = (iso: string, h: number) => new Date(Date.parse(iso.replace('Z', ':00Z')) + h * 3600_000).toISOString().slice(0, 16) + 'Z';

/** The resorts WPC covers, at their mid band. */
export const wpcPoints = (resorts: Resort[]) =>
  resorts.filter((r) => r.officialGuidance).map((r) => {
    const m = midBand(r);
    return { id: r.id, lat: m.lat, lon: m.lon };
  });

/**
 * Builds the static file from the job's responses: `times(layer)` is the distinct-times response,
 * `point(layer, resortId)` the point query (undefined: the request failed).
 */
export function buildWpcFile(input: {
  fetchedAt: number;
  points: { id: string; lat: number; lon: number }[];
  times: (layer: number) => unknown;
  point: (layer: number, resortId: string) => unknown;
}): WpcFile {
  const layerPeriod = new Map<number, WpcPeriod | null | undefined>();
  for (const row of WPC_LAYERS) for (const l of row) layerPeriod.set(l, parseLayerTimes(input.times(l)));
  // A day's period: the newest issuance among its layers (WPC updates them one by one; a layer with no polygons
  // anywhere has no times).
  const days: (WpcPeriod | null)[] = WPC_LAYERS.map((row) =>
    row.map((l) => layerPeriod.get(l)).filter((p): p is WpcPeriod => p != null).sort((a, b) => (a.issued < b.issued ? 1 : -1))[0] ?? null);
  // Days are consecutive 24 h periods: fill a day with no times from a neighbour.
  const known = days.findIndex((d) => d != null);
  if (known >= 0) {
    const k = days[known]!;
    days.forEach((d, i) => {
      if (!d) days[i] = { start: shift(k.start, 24 * (i - known)), end: shift(k.end, 24 * (i - known)), issued: k.issued };
    });
  }
  const points: WpcFile['points'] = {};
  for (const p of input.points) {
    points[p.id] = {
      lat: p.lat, lon: p.lon,
      cat: WPC_LAYERS.map((row, d) => row.map((l) => {
        const r = parsePointCategory(input.point(l, p.id));
        if (!r) return null;
        // A polygon from another issuance than the day's (the service mid-update) can't be read against that period.
        if (r.cat > 0 && !samePeriod(r.period, days[d])) return null;
        // A layer whose own times differ from the day's is from another issuance too.
        const own = layerPeriod.get(l);
        if (own && !samePeriod(own, days[d])) return null;
        return r.cat;
      })),
    };
  }
  return { v: 1, fetchedAt: input.fetchedAt, thresholdsIn: [...WPC_THRESHOLDS_IN], days, points };
}

/** Validates the static file as the browser reads it (untrusted); anything malformed is treated as no file. */
export function parseWpcFile(x: unknown): WpcFile | null {
  if (!x || typeof x !== 'object') return null;
  const f = x as Partial<WpcFile>;
  if (f.v !== 1 || typeof f.fetchedAt !== 'number' || !Number.isFinite(f.fetchedAt)) return null;
  if (!Array.isArray(f.thresholdsIn) || f.thresholdsIn.join() !== WPC_THRESHOLDS_IN.join()) return null;
  if (!Array.isArray(f.days) || f.days.length !== WPC_DAYS) return null;
  const days: (WpcPeriod | null)[] = [];
  for (const d of f.days) {
    if (d === null) {
      days.push(null);
      continue;
    }
    if (!d || typeof d !== 'object' || ![d.start, d.end, d.issued].every((t) => typeof t === 'string' && ISO_MIN.test(t))) return null;
    days.push({ start: d.start, end: d.end, issued: d.issued });
  }
  if (!f.points || typeof f.points !== 'object') return null;
  const points: WpcFile['points'] = {};
  for (const [id, p] of Object.entries(f.points)) {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(id) || !p || typeof p !== 'object') return null;
    const { lat, lon, cat } = p as WpcFile['points'][string];
    if (![lat, lon].every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
    if (!Array.isArray(cat) || cat.length !== WPC_DAYS) return null;
    const rows: (WpcCategory | null)[][] = [];
    for (const row of cat) {
      if (!Array.isArray(row) || row.length !== WPC_THRESHOLDS_IN.length) return null;
      if (!row.every((c) => c === null || c === 0 || c === 1 || c === 2 || c === 3)) return null;
      rows.push(row as (WpcCategory | null)[]);
    }
    points[id] = { lat, lon, cat: rows };
  }
  return { v: 1, fetchedAt: f.fetchedAt, thresholdsIn: [...WPC_THRESHOLDS_IN], days, points };
}
