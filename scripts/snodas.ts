/**
 * NOAA NOHRSC SNODAS (NSIDC data set G02158, masked daily archive): modelled snow depth and snow water
 * equivalent on a 30-arc-second (~1 km) grid over the lower 48. Used for the US resorts' modelled points
 * (SNODAS_POINTS in src/config/stations.ts) by scripts/fetch-obs.ts (daily) and scripts/backfill-snodas.ts (history).
 *
 * Format (NSIDC user guide for G02158 v1, §1.2–1.7, and each file's own header):
 *  - One tar per day, `masked/YYYY/MM_Mon/SNODAS_YYYYMMDD.tar`, holding eight gzipped flat binary grids
 *    and their gzipped text headers. Product 1036 is snow depth, 1034 SWE; both are the model state at
 *    06:00 UTC (`…T0001TTNATS<date>05HP001`: the end of the one-hour step that starts at 05Z).
 *  - Grids are 16-bit signed big-endian integers, read across rows from the north-west corner.
 *  - The header gives the grid: `Minimum x-axis coordinate` / `Maximum y-axis coordinate` are the outer
 *    edges of the west column and the north row (not cell centres), with `X/Y-axis resolution` spacing.
 *    The grid shifted by 5% of a cell on 2013-10-01; reading each file's own header handles both eras.
 *  - `Data units: Meters / 1000.000000`, slope 1, intercept 0: integers are millimetres. -9999 is no data,
 *    and 32767 is a clipped value (SWE ≥ 32.767 m, an artefact at some high-elevation cells, §1.9.1).
 *
 * Nothing is written to disk: the tar is streamed, only the two products' members are kept in memory
 * (1–8 MB gzipped each), and their decompressed bytes are scanned once for the wanted cells and dropped.
 */
import { createGunzip, gunzipSync } from 'node:zlib';

export const SNODAS_BASE = 'https://noaadata.apps.nsidc.org/NOAA/G02158/masked';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The day's masked tar, e.g. `…/masked/2026/11_Nov/SNODAS_20261118.tar`. */
export function snodasUrl(date: string): string {
  const [y, m, d] = date.split('-');
  return `${SNODAS_BASE}/${y}/${m}_${MONTHS[Number(m) - 1]}/SNODAS_${y}${m}${d}.tar`;
}

/** Product codes in the member names (user guide Table 1 and Table 4). */
export const SNODAS_PRODUCTS = { depth: '1036', swe: '1034' } as const;
type Product = keyof typeof SNODAS_PRODUCTS;
const PRODUCT_OF: Record<string, Product> = { '1036': 'depth', '1034': 'swe' };

/** Members kept: depth and SWE at 06:00 UTC, data (`.dat`) and header (`.txt`; `.hdr`/`.Hdr` before NSIDC renamed them in 2019). */
const MEMBER_RE = /^us_ssmv1(1034|1036)tS__T0001TTNATS(\d{8})05HP001\.(dat|txt|hdr|Hdr)\.gz$/;

/** Bad or unexpected content (not worth retrying, unlike a network error). */
export class SnodasFormatError extends Error {}

export interface SnodasGrid {
  cols: number;
  rows: number;
  /** West edge of the first column, degrees east. */
  minX: number;
  /** North edge of the first row, degrees north. */
  maxY: number;
  dx: number;
  dy: number;
  noData: number;
  /** Physical value (metres) = (raw × slope + intercept) / unitsDivisor. */
  slope: number;
  intercept: number;
  unitsDivisor: number;
  /** Valid time from the header, ISO UTC. */
  validUtc: string;
}

/** Parses a SNODAS header (`NOHRSC GIS/RS raster file v1.1`) and checks it describes what this code reads. */
export function parseHeader(text: string): SnodasGrid {
  const h = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) h.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  const str = (k: string) => {
    const v = h.get(k);
    if (v == null) throw new SnodasFormatError(`header has no "${k}"`);
    return v;
  };
  const num = (k: string) => {
    const v = Number(str(k));
    if (!Number.isFinite(v)) throw new SnodasFormatError(`header "${k}" is not a number`);
    return v;
  };
  if (str('Data type') !== 'integer' || num('Data bytes per pixel') !== 2) throw new SnodasFormatError('grid is not 2-byte integers');
  const units = /^Meters\s*\/\s*([0-9.]+)$/.exec(str('Data units'));
  if (!units || !(Number(units[1]) > 0)) throw new SnodasFormatError(`unexpected units "${str('Data units')}"`);
  const g: SnodasGrid = {
    cols: num('Number of columns'),
    rows: num('Number of rows'),
    minX: num('Minimum x-axis coordinate'),
    maxY: num('Maximum y-axis coordinate'),
    dx: num('X-axis resolution'),
    dy: num('Y-axis resolution'),
    noData: num('No data value'),
    slope: num('Data slope'),
    intercept: num('Data intercept'),
    unitsDivisor: Number(units[1]),
    validUtc: '',
  };
  if (!Number.isInteger(g.cols) || !Number.isInteger(g.rows) || g.cols <= 0 || g.rows <= 0 || !(g.dx > 0) || !(g.dy > 0)) {
    throw new SnodasFormatError('bad grid dimensions');
  }
  // The edges must agree with the size and spacing (the header's own float noise is ~1e-11 degrees).
  const tol = g.dx / 100;
  if (Math.abs(g.minX + g.cols * g.dx - num('Maximum x-axis coordinate')) > tol || Math.abs(g.maxY - g.rows * g.dy - num('Minimum y-axis coordinate')) > tol) {
    throw new SnodasFormatError('grid edges disagree with its size');
  }
  const p2 = (k: string) => String(num(k)).padStart(2, '0');
  g.validUtc = `${num('Start year')}-${p2('Start month')}-${p2('Start day')}T${p2('Start hour')}:00:00Z`;
  return g;
}

/**
 * The cell containing a point, or null outside the grid. Cells are half-open: a point exactly on a cell
 * boundary belongs to the cell east or south of it, so the grid covers [minX, minX + cols·dx) in longitude
 * and (maxY − rows·dy, maxY] in latitude. A tolerance of 1e-9 cell absorbs floating-point error at a boundary.
 */
export function cellIndex(g: Pick<SnodasGrid, 'cols' | 'rows' | 'minX' | 'maxY' | 'dx' | 'dy'>, lat: number, lon: number): { row: number; col: number } | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const col = Math.floor((lon - g.minX) / g.dx + 1e-9);
  const row = Math.floor((g.maxY - lat) / g.dy + 1e-9);
  return col >= 0 && col < g.cols && row >= 0 && row < g.rows ? { row, col } : null;
}

/** A raw grid integer in metres, or null for no data, a clipped value (32767) or a negative one. */
export function toMetres(raw: number, g: Pick<SnodasGrid, 'noData' | 'slope' | 'intercept' | 'unitsDivisor'>): number | null {
  if (raw === g.noData || raw >= 32767 || raw < 0) return null;
  const m = (raw * g.slope + g.intercept) / g.unitsDivisor;
  return Number.isFinite(m) && m >= 0 ? m : null;
}

/** Bounds the obs validator accepts (scripts/validate_obs.py); SNODAS values beyond them are dropped as implausible. */
export const MAX_DEPTH_CM = 1500;
export const MAX_SWE_MM = 5000;

/** Depth in cm and SWE in mm from the two products' raw cell values. */
export function scaleCell(product: Product, raw: number, g: SnodasGrid): number | null {
  const m = toMetres(raw, g);
  if (m == null) return null;
  const v = Math.round((product === 'depth' ? m * 100 : m * 1000) * 10) / 10;
  return v <= (product === 'depth' ? MAX_DEPTH_CM : MAX_SWE_MM) ? v : null;
}

// ---------------------------------------------------------------- tar stream

const BLOCK = 512;

function parseOctal(b: Buffer): number {
  if (b[0] & 0x80) throw new SnodasFormatError('tar member too large');
  const s = b.toString('latin1').replace(/\0.*$/s, '').trim();
  if (!/^[0-7]*$/.test(s)) throw new SnodasFormatError('bad tar header number');
  return s ? parseInt(s, 8) : 0;
}

function parseTarHeader(h: Buffer): { name: string; size: number; regular: boolean } | null {
  if (h.every((x) => x === 0)) return null; // end of archive
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i];
  if (sum !== parseOctal(h.subarray(148, 156))) throw new SnodasFormatError('tar header checksum mismatch');
  const cstr = (a: number, b: number) => h.toString('latin1', a, b).replace(/\0.*$/s, '');
  const ustar = h.toString('latin1', 257, 262) === 'ustar';
  const prefix = ustar ? cstr(345, 500) : '';
  const name = prefix ? `${prefix}/${cstr(0, 100)}` : cstr(0, 100);
  const type = h[156];
  return { name, size: parseOctal(h.subarray(124, 136)), regular: type === 0x30 || type === 0 };
}

/**
 * Reads a tar stream, keeping the regular files `want` accepts (by base name) and skipping the rest. Returns as
 * soon as `done` says it has everything; the caller then cancels the rest of the download.
 */
export async function readTarMembers(
  chunks: AsyncIterable<Uint8Array>,
  want: (name: string) => boolean,
  done: (got: Map<string, Buffer>) => boolean,
): Promise<Map<string, Buffer>> {
  const got = new Map<string, Buffer>();
  const header = Buffer.alloc(BLOCK);
  let headerFill = 0;
  /** Bytes left in the current member's data and padding; -1 while reading a header. */
  let left = -1;
  let dataLeft = 0;
  let keep: { name: string; parts: Buffer[] } | null = null;
  for await (const c of chunks) {
    let chunk = Buffer.from(c.buffer, c.byteOffset, c.byteLength);
    while (chunk.length) {
      if (left < 0) {
        const n = Math.min(BLOCK - headerFill, chunk.length);
        chunk.copy(header, headerFill, 0, n);
        headerFill += n;
        chunk = chunk.subarray(n);
        if (headerFill < BLOCK) break;
        headerFill = 0;
        const m = parseTarHeader(header);
        if (!m) return got;
        dataLeft = m.size;
        left = Math.ceil(m.size / BLOCK) * BLOCK;
        const base = m.name.split('/').pop()!;
        keep = m.regular && want(base) ? { name: base, parts: [] } : null;
        if (left === 0) left = -1;
        continue;
      }
      const n = Math.min(left, chunk.length);
      const d = Math.min(dataLeft, n);
      if (keep && d > 0) keep.parts.push(Buffer.from(chunk.subarray(0, d)));
      dataLeft -= d;
      left -= n;
      chunk = chunk.subarray(n);
      if (left === 0) {
        left = -1;
        if (keep) {
          got.set(keep.name, Buffer.concat(keep.parts));
          keep = null;
          if (done(got)) return got;
        }
      }
    }
  }
  if (left >= 0 || headerFill) throw new SnodasFormatError('tar stream ended inside a member');
  return got;
}

// ---------------------------------------------------------------- cells

/**
 * Raw values at the given cell indices (row × cols + col) of a gzipped grid, decompressed as a stream so
 * the whole grid is never held. Checks the grid's size against the header.
 */
export async function readCells(gz: Buffer, g: SnodasGrid, cells: number[]): Promise<Map<number, number>> {
  const wanted = [...new Set(cells)].sort((a, b) => a - b);
  const out = new Map<number, number>();
  const gunzip = createGunzip();
  gunzip.end(gz);
  let pos = 0;
  let i = 0;
  let hi: number | null = null; // first byte of a value split across chunks
  try {
    for await (const chunk of gunzip as AsyncIterable<Buffer>) {
      let j = 0;
      if (hi != null) {
        out.set(wanted[i++], ((hi << 8) | chunk[0]) << 16 >> 16);
        hi = null;
      }
      while (i < wanted.length && (j = wanted[i] * 2 - pos) < chunk.length) {
        if (j + 1 < chunk.length) out.set(wanted[i++], ((chunk[j] << 8) | chunk[j + 1]) << 16 >> 16);
        else {
          hi = chunk[j];
          break;
        }
      }
      pos += chunk.length;
    }
  } catch (err) {
    throw new SnodasFormatError(`bad gzip member: ${(err as Error).message}`);
  }
  if (pos !== g.cols * g.rows * 2) throw new SnodasFormatError(`grid holds ${pos} bytes, header says ${g.cols * g.rows * 2}`);
  return out;
}

export interface PointRef {
  id: string;
  lat: number;
  lon: number;
}

export interface SnodasDay {
  date: string;
  /** Per point: depth (cm) and SWE (mm); null where the cell has no data or the point is off the grid. */
  values: Map<string, { depthCm: number | null; sweMm: number | null; row: number | null; col: number | null }>;
  /** The grid's north-west corner (depth's, unless the day lacks it), to tell the two grid eras apart. */
  origin: { minX: number; maxY: number };
}

/** Extracts the points' depth and SWE from one day's tar stream (see the module comment). */
export async function extractDay(chunks: AsyncIterable<Uint8Array>, date: string, points: PointRef[]): Promise<SnodasDay> {
  const ymd = date.replaceAll('-', '');
  const role = (name: string) => {
    const m = MEMBER_RE.exec(name);
    return m && m[2] === ymd ? { product: PRODUCT_OF[m[1]], kind: m[3] === 'dat' ? 'dat' : 'hdr' } : null;
  };
  const complete = (got: Map<string, Buffer>) => {
    const have = new Set([...got.keys()].map((n) => { const r = role(n)!; return `${r.product}.${r.kind}`; }));
    return have.size === 4;
  };
  const got = await readTarMembers(chunks, (n) => role(n) != null, complete);
  const member = (product: Product, kind: string) => {
    const name = [...got.keys()].find((n) => { const r = role(n)!; return r.product === product && r.kind === kind; });
    return name ? got.get(name)! : null;
  };
  // NSIDC lists a few days whose tar lacks one product (G02158_missing_files.txt): keep the other one.
  const products = (['depth', 'swe'] as const).filter((p) => member(p, 'hdr') && member(p, 'dat'));
  if (!products.length) throw new SnodasFormatError(`tar lacks the depth/SWE members for ${date}`);
  const values: SnodasDay['values'] = new Map(points.map((p) => [p.id, { depthCm: null, sweMm: null, row: null, col: null }]));
  let origin = { minX: NaN, maxY: NaN };
  for (const product of products) {
    const g = parseHeader(gunzipSync(member(product, 'hdr')!).toString('latin1'));
    if (g.validUtc !== `${date}T06:00:00Z`) throw new SnodasFormatError(`${product} header is valid at ${g.validUtc}, not ${date}T06:00:00Z`);
    if (product === products[0]) origin = { minX: g.minX, maxY: g.maxY };
    const idx = points.map((p) => cellIndex(g, p.lat, p.lon));
    const raw = await readCells(member(product, 'dat')!, g, idx.filter((c) => c != null).map((c) => c.row * g.cols + c.col));
    points.forEach((p, k) => {
      const c = idx[k];
      const v = values.get(p.id)!;
      if (!c) return;
      v.row = c.row;
      v.col = c.col;
      v[product === 'depth' ? 'depthCm' : 'sweMm'] = scaleCell(product, raw.get(c.row * g.cols + c.col)!, g);
    });
  }
  return { date, values, origin };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Downloads one day and extracts the points, retrying network errors, 403/429 and 5xx with backoff (2 s, 4 s, …
 * up to 60 s). Null when NSIDC has no file for the day (404: not posted yet, or one of its known missing days).
 * The download stops as soon as both products are in hand.
 */
export async function fetchSnodasDay(date: string, points: PointRef[], opts: { ua: string; retries?: number }): Promise<SnodasDay | null> {
  const url = snodasUrl(date);
  const retries = opts.retries ?? 5;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await sleep(Math.min(60_000, 2000 * 2 ** (attempt - 1)));
    let res: Response | undefined;
    try {
      res = await fetch(url, { headers: { 'User-Agent': opts.ua } });
      if (res.status === 404) return null;
      if (!res.ok || !res.body) {
        lastErr = new Error(`HTTP ${res.status} for ${url}`);
        if (res.status !== 403 && res.status !== 429 && res.status < 500) break;
        continue;
      }
      return await extractDay(res.body as unknown as AsyncIterable<Uint8Array>, date, points);
    } catch (err) {
      if (err instanceof SnodasFormatError) throw new SnodasFormatError(`${url}: ${err.message}`);
      lastErr = err;
    } finally {
      await res?.body?.cancel().catch(() => {});
    }
  }
  throw lastErr;
}
