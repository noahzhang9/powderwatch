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
 * Also updates the modelled SNODAS points (SNODAS_POINTS): one NSIDC file per day serves all of
 * them, and only days missing from the last SNODAS_LOOKBACK_DAYS are fetched, so a run downloads
 * at most one or two files. FULL_REFRESH doesn't apply to them; their history comes from the
 * backfill workflow (scripts/backfill-snodas.ts).
 *
 *   npm run obs                      # all stations and SNODAS points, incremental
 *   FULL_REFRESH=1 npm run obs       # full histories
 *   npm run obs -- slf-ATT2 snotel-642
 *   npm run obs -- snodas            # the SNODAS points only
 *
 * Env: PW_CONTACT (URL added to the User-Agent), ARCHIVE_MAX_AGE_DAYS (BC archive cache age),
 * SNODAS_LOOKBACK_DAYS (default 10).
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SNODAS_POINTS, STATIONS, type StationDef } from '../src/config/stations';
import { SNAPSHOT_INTERVAL_H } from '../src/lib/cache';
import type { StationFile } from '../src/lib/obs';
import { addDays } from '../src/lib/time';
import { fromFile, sameData, setVal, toFile, type Daily } from './obs-file';
import { fetchSnodasDay } from './snodas';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public/data/obs');
const CACHE = join(ROOT, '.cache');
const CONTACT = process.env.PW_CONTACT;
const UA = `PowderWatch/0.2 (personal snow dashboard; scheduled fetch every ${SNAPSHOT_INTERVAL_H} h${CONTACT ? `; +${CONTACT}` : ''})`;
const FULL = process.env.FULL_REFRESH === '1';
const ARCHIVE_MAX_AGE_DAYS = Number(process.env.ARCHIVE_MAX_AGE_DAYS ?? 30);
/** Incremental window: long enough to pick up late QC revisions. */
const RECENT_DAYS = 45;

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
const FETCHERS: Partial<Record<StationDef['source'], (s: StationDef, since: string | null) => Promise<Daily>>> = {
  SNOTEL: snotel, ECCC: eccc, 'BC-ASWS': bcAsws, SLF: slf, MeteoSwiss: meteoswiss,
};

const readPrevious = (id: string) => readFile(join(OUT, `${id}.json`), 'utf-8').then((t) => JSON.parse(t) as StationFile).catch(() => null);

const summary = (st: StationDef, file: StationFile, mode: string, unchanged: boolean, t0: number) => {
  const nDepth = file.depthCm.filter((v) => v != null).length;
  return `${unchanged ? '=' : '✓'} ${mode} ${st.id.padEnd(14)} ${file.start} → ${file.lastDepthDate}  depth days ${nDepth}${file.sweMm ? `, swe through ${file.lastSweDate}` : ''}${unchanged ? '  (unchanged)' : ''}  (${((Date.now() - t0) / 1000).toFixed(1)} s)`;
};

// ---------------------------------------------------------------- SNODAS (modelled; NSIDC G02158)
/**
 * Days back the update looks for SNODAS days the files don't have. NSIDC posts each day's file once, at
 * about 14 UTC, so a day already in the files is never fetched again, and the day not posted yet is one
 * cheap 404 per run.
 */
const SNODAS_LOOKBACK_DAYS = Number(process.env.SNODAS_LOOKBACK_DAYS ?? 10);

async function snodasUpdate(points: StationDef[]): Promise<number> {
  const t0 = Date.now();
  if (FULL) console.log('· SNODAS: incremental only; history comes from the backfill workflow');
  const previous = await Promise.all(points.map((p) => readPrevious(p.id)));
  const daily = previous.map((f) => (f ? fromFile(f) : (new Map() as Daily)));
  const today = new Date().toISOString().slice(0, 10);
  // One file serves every point, so a day is done once any point has it (a point without a file yet needs them all).
  const dates = Array.from({ length: SNODAS_LOOKBACK_DAYS }, (_, i) => addDays(today, i + 1 - SNODAS_LOOKBACK_DAYS))
    .filter((d) => previous.some((f) => !f) || !daily.some((m) => m.get(d)?.depth != null));
  let failures = 0;
  for (const date of dates) {
    try {
      const day = await fetchSnodasDay(date, points, { ua: UA });
      if (!day) {
        console.log(`· SNODAS ${date}: no file at NSIDC (not posted yet, or a missing day)`);
        continue;
      }
      points.forEach((p, i) => {
        const v = day.values.get(p.id)!;
        setVal(daily[i], date, 'depth', v.depthCm);
        setVal(daily[i], date, 'swe', v.sweMm);
      });
      console.log(`· SNODAS ${date}: read ${points.length} cells`);
    } catch (err) {
      failures++;
      console.error(`✗ SNODAS ${date}: ${(err as Error).message}`);
    }
  }
  for (const [i, st] of points.entries()) {
    if (!daily[i].size) {
      failures++;
      console.error(`✗ ${st.id}: no SNODAS values — keeping previous file if any`);
      continue;
    }
    const file = toFile(st, daily[i]);
    const unchanged = sameData(previous[i], file);
    if (!unchanged) await writeFile(join(OUT, `${st.id}.json`), JSON.stringify(file));
    console.log(summary(st, file, 'snodas', unchanged, t0));
  }
  return failures;
}

async function main() {
  const only = process.argv.slice(2);
  const targets = STATIONS.filter((s) => !only.length || only.includes(s.id));
  const snodasTargets = SNODAS_POINTS.filter((s) => !only.length || only.includes('snodas') || only.includes(s.id));
  await mkdir(OUT, { recursive: true });
  let failures = 0;
  for (const st of targets) {
    const t0 = Date.now();
    try {
      const path = join(OUT, `${st.id}.json`);
      const previous = await readPrevious(st.id);
      const since = FULL || !previous ? null : new Date(Date.now() - RECENT_DAYS * 86_400_000).toISOString().slice(0, 10);
      const fetcher = FETCHERS[st.source];
      if (!fetcher) throw new Error(`no fetcher for ${st.source}`);
      const fetched = await fetcher(st, since);
      if (!fetched.size && !previous) throw new Error('no data returned');
      // Incremental: overlay the recent window onto the existing record.
      const daily = since && previous ? fromFile(previous) : new Map() as Daily;
      for (const [date, v] of fetched) daily.set(date, { ...daily.get(date), ...v });
      const file = toFile(st, daily);
      // Skip the write (and so the commit) when only the fetch timestamp would change.
      const unchanged = sameData(previous, file);
      if (!unchanged) await writeFile(path, JSON.stringify(file));
      console.log(summary(st, file, since ? 'recent' : 'full  ', unchanged, t0));
    } catch (err) {
      failures++;
      console.error(`✗ ${st.id}: ${(err as Error).message} — keeping previous file if any`);
    }
  }
  if (snodasTargets.length) failures += await snodasUpdate(snodasTargets);
  process.exitCode = failures ? 1 : 0;
}

void main();
