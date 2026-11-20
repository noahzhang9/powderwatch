/**
 * Fetches snow-depth (and SWE where measured) history for every station in
 * src/config/stations.ts and writes compact daily series to public/data/obs/.
 *
 * Runs server-side on a schedule (see README): several sources send no CORS
 * headers, SNOTEL's API is flaky and needs retries, and SLF's terms ask that
 * clients not call its services per end-user request.
 *
 * Incremental by default: when a station file already exists, only the last
 * ~6 weeks are fetched and merged in. FULL_REFRESH=1 re-downloads complete
 * histories (the scheduled workflow does this weekly).
 *
 *   npm run obs                      # all stations, incremental
 *   FULL_REFRESH=1 npm run obs       # full histories
 *   npm run obs -- slf-ATT2 snotel-642
 *
 * Env: PW_CONTACT (URL added to the User-Agent), ARCHIVE_MAX_AGE_DAYS (BC archive cache age).
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATIONS, type StationDef } from '../src/config/stations';
import { SNAPSHOT_INTERVAL_H } from '../src/lib/cache';
import type { StationFile } from '../src/lib/obs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public/data/obs');
const CACHE = join(ROOT, '.cache');
const CONTACT = process.env.PW_CONTACT;
const UA = `PowderWatch/0.2 (personal snow dashboard; scheduled fetch every ${SNAPSHOT_INTERVAL_H} h${CONTACT ? `; +${CONTACT}` : ''})`;
const FULL = process.env.FULL_REFRESH === '1';
const ARCHIVE_MAX_AGE_DAYS = Number(process.env.ARCHIVE_MAX_AGE_DAYS ?? 30);
/** Incremental window: long enough to pick up late QC revisions. */
const RECENT_DAYS = 45;

type Daily = Map<string, { depth?: number; swe?: number; newSnow?: number }>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url: string, { retries = 6, encoding = 'utf-8' } = {}): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (res.ok) return new TextDecoder(encoding).decode(await res.arrayBuffer());
      lastErr = new Error(`HTTP ${res.status} for ${url}`);
      if (res.status !== 403 && res.status !== 429 && res.status < 500) break; // not transient
    } catch (err) {
      lastErr = err;
    }
    await sleep(Math.min(30_000, 1500 * 2 ** attempt));
  }
  throw lastErr;
}

/** Download with an on-disk cache for large, rarely-changing archive files. */
async function cachedDownload(url: string, maxAgeDays: number): Promise<string> {
  const file = join(CACHE, url.replace(/[^a-zA-Z0-9.]+/g, '_'));
  try {
    const s = await stat(file);
    if ((Date.now() - s.mtimeMs) / 86_400_000 < maxAgeDays) return await readFile(file, 'utf-8');
  } catch {
    /* not cached yet */
  }
  const text = await fetchText(url);
  await mkdir(CACHE, { recursive: true });
  await writeFile(file, text);
  return text;
}

function setVal(d: Daily, date: string, key: 'depth' | 'swe' | 'newSnow', v: number | null | undefined) {
  if (v == null || !Number.isFinite(v)) return;
  const e = d.get(date) ?? {};
  e[key] = v;
  d.set(date, e);
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Plausibility filter: negative sensor offsets → 0; absurd values dropped. */
const cleanDepth = (cm: number) => (cm < 0 ? (cm > -5 ? 0 : NaN) : cm > 1500 ? NaN : cm);

// ---------------------------------------------------------------- SNOTEL
async function snotel(st: StationDef, since: string | null): Promise<Daily> {
  const today = new Date().toISOString().slice(0, 10);
  const url =
    'https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1/data?' +
    `stationTriplets=${st.sourceId}&elements=SNWD,WTEQ&duration=DAILY&beginDate=${since ?? '1978-10-01'}&endDate=${today}`;
  const json = JSON.parse(await fetchText(url, { retries: 10 })) as {
    data: { stationElement: { elementCode: string; storedUnitCode: string }; values: { date: string; value: number }[] }[];
  }[];
  const d: Daily = new Map();
  for (const el of json[0]?.data ?? []) {
    const isDepth = el.stationElement.elementCode === 'SNWD';
    const toMetric = el.stationElement.storedUnitCode === 'in' ? (isDepth ? 2.54 : 25.4) : 1;
    for (const v of el.values) {
      const x = v.value * toMetric;
      setVal(d, v.date.slice(0, 10), isDepth ? 'depth' : 'swe', isDepth ? cleanDepth(x) : x < 0 ? 0 : x);
    }
  }
  return d;
}

// ---------------------------------------------------------------- ECCC
async function eccc(st: StationDef, since: string | null): Promise<Daily> {
  const d: Daily = new Map();
  const limit = 10_000;
  const range = since ? `&datetime=${since}/${new Date().toISOString().slice(0, 10)}` : '';
  for (let offset = 0; ; offset += limit) {
    const url =
      'https://api.weather.gc.ca/collections/climate-daily/items?f=json' +
      `&CLIMATE_IDENTIFIER=${st.sourceId}&properties=LOCAL_DATE,SNOW_ON_GROUND,TOTAL_SNOW&sortby=LOCAL_DATE` +
      `${range}&limit=${limit}&offset=${offset}`;
    const json = JSON.parse(await fetchText(url)) as {
      features: { properties: { LOCAL_DATE: string; SNOW_ON_GROUND: number | null; TOTAL_SNOW: number | null } }[];
    };
    for (const f of json.features) {
      const day = f.properties.LOCAL_DATE.slice(0, 10);
      setVal(d, day, 'depth', f.properties.SNOW_ON_GROUND == null ? null : cleanDepth(f.properties.SNOW_ON_GROUND));
      const hn = f.properties.TOTAL_SNOW;
      if (hn != null && hn >= 0 && hn < 300) setVal(d, day, 'newSnow', hn); // snowfall during the climatological day
    }
    if (json.features.length < limit) break;
  }
  return d;
}

// ---------------------------------------------------------------- BC ASWS
const BC = 'https://www.env.gov.bc.ca/wsd/data_searches/snow/asws/data';

function splitCsvLine(line: string): string[] {
  if (!line.includes('"')) return line.split(',');
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === ',' && !q) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Wide BC file → per-station daily median (PST days). Hourly rows are UTC. */
function bcWide(text: string, stationId: string, key: 'depth' | 'swe', d: Daily) {
  const lines = text.split(/\r?\n/);
  const header = splitCsvLine(lines[0]);
  const col = header.findIndex((h) => h.trim().replace(/^"|"$/g, '').startsWith(`${stationId} `));
  if (col < 0) throw new Error(`${stationId} not in BC file header`);
  const byDay = new Map<string, number[]>();
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const cells = splitCsvLine(line);
    const raw = cells[col];
    if (raw === undefined || raw.trim() === '') continue;
    const v = Number(raw);
    if (!Number.isFinite(v)) continue;
    const stamp = cells[0].trim();
    let day: string;
    if (stamp.length > 10) {
      const utc = Date.parse(`${stamp.replace(' ', 'T').slice(0, 16)}:00Z`);
      day = new Date(utc - 8 * 3600_000).toISOString().slice(0, 10); // PST climatological day
    } else {
      day = stamp.slice(0, 10);
    }
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push(v);
  }
  for (const [day, vals] of byDay) {
    const m = median(vals);
    setVal(d, day, key, key === 'depth' ? cleanDepth(m) : m < 0 ? 0 : m);
  }
}

const bcFiles = new Map<string, Promise<string>>();
const bcFile = (name: string, maxAgeDays: number) => {
  if (!bcFiles.has(name)) bcFiles.set(name, cachedDownload(`${BC}/${name}`, maxAgeDays));
  return bcFiles.get(name)!;
};

async function bcAsws(st: StationDef, since: string | null): Promise<Daily> {
  const d: Daily = new Map();
  if (!since) {
    // Prior water years: large files that change once a year.
    bcWide(await bcFile('SD_Archive.csv', ARCHIVE_MAX_AGE_DAYS), st.sourceId, 'depth', d);
    bcWide(await bcFile('SW_DailyArchive.csv', ARCHIVE_MAX_AGE_DAYS), st.sourceId, 'swe', d);
  }
  bcWide(await bcFile('SD.csv', 0.02), st.sourceId, 'depth', d);
  bcWide(await bcFile('SW.csv', 0.02), st.sourceId, 'swe', d);
  return d;
}

// ---------------------------------------------------------------- SLF IMIS
let slfRecent: Promise<{ station_code: string; measure_date: string; HS: number | null; HN_1D: number | null }[]> | null = null;

async function slf(st: StationDef, since: string | null): Promise<Daily> {
  const d: Daily = new Map();
  // Incremental runs use only the 7-day public API (scheduled runs are hours apart; the weekly full refresh backfills).
  const hist = since ? '' : await fetchText(`https://measurement-data.slf.ch/imis/data/daily_snow_values/daily_snow_by_station/daily_snow_${st.sourceId}.csv`);
  const lines = hist ? hist.split(/\r?\n/) : [''];
  const header = lines[0].split(',');
  const iDate = header.indexOf('measure_date');
  const iHs = header.indexOf('HS');
  const iHn = header.indexOf('HN_1D');
  for (const line of lines.slice(1)) {
    if (!line) continue;
    const c = line.split(',');
    const day = c[iDate].slice(0, 10);
    if (c[iHs] !== '' && c[iHs] !== undefined) setVal(d, day, 'depth', cleanDepth(Number(c[iHs])));
    if (iHn >= 0 && c[iHn] !== '' && c[iHn] !== undefined) setVal(d, day, 'newSnow', Math.max(0, Number(c[iHn])));
  }
  // The history file lags a few days; the public API has the last week.
  slfRecent ??= fetchText('https://measurement-api.slf.ch/public/api/imis/daily-snow?period_in_days=7').then((t) => JSON.parse(t));
  for (const r of await slfRecent) {
    if (r.station_code !== st.sourceId) continue;
    if (r.HS != null) setVal(d, r.measure_date.slice(0, 10), 'depth', cleanDepth(r.HS));
    if (r.HN_1D != null) setVal(d, r.measure_date.slice(0, 10), 'newSnow', Math.max(0, r.HN_1D));
  }
  return d;
}

// ---------------------------------------------------------------- MeteoSwiss
async function meteoswiss(st: StationDef, since: string | null): Promise<Daily> {
  const d: Daily = new Map();
  const code = st.sourceId.toLowerCase();
  // `_d_recent` covers Jan 1 → yesterday; `_d_historical` everything before.
  for (const part of since ? ['recent'] : ['historical', 'recent']) {
    const url = `https://data.geo.admin.ch/ch.meteoschweiz.ogd-nime/${code}/ogd-nime_${code}_d_${part}.csv`;
    const text = await fetchText(url, { encoding: 'latin1' });
    const lines = text.split(/\r?\n/);
    const header = lines[0].split(';');
    const iDate = header.indexOf('reference_timestamp');
    const iHs = header.indexOf('hto000d0');
    const iHn = header.indexOf('hns000d0');
    for (const line of lines.slice(1)) {
      if (!line) continue;
      const c = line.split(';');
      const [dd, mm, yyyy] = c[iDate].slice(0, 10).split('.');
      const day = `${yyyy}-${mm}-${dd}`;
      // Blank = not observed, never 0.
      const hs = c[iHs]?.trim();
      if (hs) setVal(d, day, 'depth', cleanDepth(Number(hs)));
      const hn = iHn >= 0 ? c[iHn]?.trim() : '';
      if (hn) setVal(d, day, 'newSnow', Math.max(0, Number(hn))); // 06 UTC this day → 06 UTC next day
    }
  }
  return d;
}

// ---------------------------------------------------------------- output
const FETCHERS: Record<StationDef['source'], (s: StationDef, since: string | null) => Promise<Daily>> = {
  SNOTEL: snotel, ECCC: eccc, 'BC-ASWS': bcAsws, SLF: slf, MeteoSwiss: meteoswiss,
};

function fromFile(f: StationFile): Daily {
  const d: Daily = new Map();
  const put = (arr: (number | null)[] | null | undefined, key: 'depth' | 'swe' | 'newSnow') =>
    arr?.forEach((v, i) => {
      if (v == null) return;
      const date = new Date(Date.parse(`${f.start}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10);
      setVal(d, date, key, v);
    });
  put(f.depthCm, 'depth');
  put(f.sweMm, 'swe');
  put(f.newSnowCm, 'newSnow');
  return d;
}

function toFile(st: StationDef, d: Daily): StationFile {
  const dates = [...d.keys()].sort();
  const withDepth = dates.filter((x) => d.get(x)!.depth != null);
  const withSwe = dates.filter((x) => d.get(x)!.swe != null);
  const start = [withDepth[0], withSwe[0]].filter(Boolean).sort()[0] ?? dates[0];
  const end = dates[dates.length - 1];
  const n = Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000) + 1;
  const depthCm: (number | null)[] = new Array(n).fill(null);
  const sweMm: (number | null)[] = new Array(n).fill(null);
  const newSnowCm: (number | null)[] = new Array(n).fill(null);
  for (const [date, v] of d) {
    const i = Math.round((Date.parse(date) - Date.parse(start)) / 86_400_000);
    if (i < 0 || i >= n) continue;
    if (v.depth != null) depthCm[i] = Math.round(v.depth * 10) / 10;
    if (v.swe != null) sweMm[i] = Math.round(v.swe * 10) / 10;
    if (v.newSnow != null) newSnowCm[i] = Math.round(v.newSnow * 10) / 10;
  }
  return {
    id: st.id,
    updated: new Date().toISOString(),
    start,
    depthCm,
    sweMm: withSwe.length ? sweMm : null,
    newSnowCm: newSnowCm.some((x) => x != null) ? newSnowCm : null,
    lastDepthDate: withDepth[withDepth.length - 1] ?? null,
    lastSweDate: withSwe[withSwe.length - 1] ?? null,
  };
}

async function main() {
  const only = process.argv.slice(2);
  const targets = STATIONS.filter((s) => !only.length || only.includes(s.id));
  await mkdir(OUT, { recursive: true });
  let failures = 0;
  for (const st of targets) {
    const t0 = Date.now();
    try {
      const path = join(OUT, `${st.id}.json`);
      const previous = await readFile(path, 'utf-8').then((t) => JSON.parse(t) as StationFile).catch(() => null);
      const since = FULL || !previous ? null : new Date(Date.now() - RECENT_DAYS * 86_400_000).toISOString().slice(0, 10);
      const fetched = await FETCHERS[st.source](st, since);
      if (!fetched.size && !previous) throw new Error('no data returned');
      // Incremental: overlay the recent window onto the existing record.
      const daily = since && previous ? fromFile(previous) : new Map() as Daily;
      for (const [date, v] of fetched) daily.set(date, { ...daily.get(date), ...v });
      const file = toFile(st, daily);
      // Skip the write (and so the commit) when only the fetch timestamp would change.
      const sameData = previous != null && JSON.stringify({ ...previous, updated: '' }) === JSON.stringify({ ...file, updated: '' });
      if (!sameData) await writeFile(path, JSON.stringify(file));
      const nDepth = file.depthCm.filter((v) => v != null).length;
      console.log(`${sameData ? '=' : '✓'} ${since ? 'recent' : 'full  '} ${st.id.padEnd(14)} ${file.start} → ${file.lastDepthDate}  depth days ${nDepth}${file.sweMm ? `, swe through ${file.lastSweDate}` : ''}${sameData ? '  (unchanged)' : ''}  (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    } catch (err) {
      failures++;
      console.error(`✗ ${st.id}: ${(err as Error).message} — keeping previous file if any`);
    }
  }
  process.exitCode = failures ? 1 : 0;
}

void main();
