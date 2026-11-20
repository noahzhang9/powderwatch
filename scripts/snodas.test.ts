import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { RESORTS } from '../src/config/resorts';
import { SNODAS_CITATION, SNODAS_DOI, SNODAS_POINTS, STATIONS, snowpackChoicesFor, stationsFor } from '../src/config/stations';
import type { StationFile } from '../src/lib/obs';
import {
  MAX_DEPTH_CM, MAX_SWE_MM, SnodasFormatError, cellIndex, extractDay, parseHeader, readCells, readTarMembers, scaleCell, snodasUrl, toMetres,
  type SnodasGrid,
} from './snodas';

const OBS_DIR = fileURLToPath(new URL('../public/data/obs', import.meta.url));
const VALIDATOR = fileURLToPath(new URL('./validate_obs.py', import.meta.url));

/** A header in the layout of the real files (NOHRSC GIS/RS raster file v1.1), trimmed to the fields that matter. */
function header(o: Partial<{ cols: number; rows: number; minX: number; maxY: number; res: number; units: string; type: string; bytes: number; slope: number; intercept: number; date: string; hour: number }> = {}) {
  const g = { cols: 4, rows: 3, minX: -122, maxY: 48, res: 0.5, units: 'Meters / 1000.000000', type: 'integer', bytes: 2, slope: 1, intercept: 0, date: '2026-11-18', hour: 6, ...o };
  const [y, m, d] = g.date.split('-').map(Number);
  return [
    'Format version: NOHRSC GIS/RS raster file v1.1',
    'Description: Modeled snow layer thickness, total of snow layers',
    `Data units: ${g.units}`,
    `Data type: ${g.type}`,
    `Data bytes per pixel: ${g.bytes}`,
    `Data intercept: ${g.intercept}`,
    `Data slope: ${g.slope}`,
    'No data value: -9999.00000000000',
    `Number of columns: ${g.cols}      `,
    `Number of rows: ${g.rows}      `,
    `Benchmark x-axis coordinate: ${g.minX + g.res / 2}`,
    `Benchmark y-axis coordinate: ${g.maxY - g.res / 2}`,
    `X-axis resolution: ${g.res}`,
    `Y-axis resolution: ${g.res}`,
    `Minimum x-axis coordinate: ${g.minX}`,
    `Maximum x-axis coordinate: ${g.minX + g.cols * g.res}`,
    `Minimum y-axis coordinate: ${g.maxY - g.rows * g.res}`,
    `Maximum y-axis coordinate: ${g.maxY}`,
    `Start year: ${y}`, `Start month: ${m} `, `Start day: ${d}`, `Start hour: ${g.hour} `,
    'Stop year: 2026',
  ].join('\n');
}

/** Big-endian int16 grid, rows from the north. */
const grid = (values: number[]) => {
  const b = Buffer.alloc(values.length * 2);
  values.forEach((v, i) => b.writeInt16BE(v, i * 2));
  return b;
};

/** One ustar member (512-byte header with checksum, data padded to 512). */
function tarEntry(name: string, data: Buffer): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 'latin1');
  h.write('0000644\0', 100);
  h.write('0001750\0', 108);
  h.write('0001750\0', 116);
  h.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
  h.write('15112054560\0', 136);
  h.fill(0x20, 148, 156);
  h[156] = 0x30;
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (const x of h) sum += x;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return Buffer.concat([h, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}

/** Feeds a buffer in small chunks, so headers and 2-byte values straddle chunk boundaries. */
async function* chunked(b: Buffer, size = 7) {
  for (let i = 0; i < b.length; i += size) yield new Uint8Array(b.subarray(i, i + size));
}

const name = (code: string, date: string, ext: string) => `us_ssmv1${code}tS__T0001TTNATS${date.replaceAll('-', '')}05HP001.${ext}.gz`;

// 4 × 3 grid, 0.5° cells, west edge -122, north edge 48: row 0 is 47.5–48 N, col 0 is 122–121.5 W.
const DEPTH = [0, 15, 1883, -9999, 32767, 2, 3, 4, 5, 6, 7, 8];
const SWE = [0, 5, 753, -9999, 32767, 1, 1, 1, 1, 1, 1, 9];

function dayTar(date: string, { depth = DEPTH, swe = SWE, extra = true, hdrExt = 'txt' } = {}) {
  return Buffer.concat([
    ...(extra ? [tarEntry('us_ssmv01025SlL00T0024TTNATS2026111805DP001.dat.gz', gzipSync(grid(new Array(12).fill(1))))] : []),
    tarEntry(name('1036', date, hdrExt), gzipSync(Buffer.from(header({ date }), 'latin1'))),
    tarEntry(name('1036', date, 'dat'), gzipSync(grid(depth))),
    tarEntry(name('1034', date, 'dat'), gzipSync(grid(swe))),
    tarEntry(name('1034', date, hdrExt), gzipSync(Buffer.from(header({ date }), 'latin1'))),
    Buffer.alloc(1024),
  ]);
}

describe('SNODAS file names', () => {
  it('builds the masked archive URL', () => {
    expect(snodasUrl('2026-11-18')).toBe('https://noaadata.apps.nsidc.org/NOAA/G02158/masked/2026/11_Nov/SNODAS_20261118.tar');
    expect(snodasUrl('2004-02-29')).toBe('https://noaadata.apps.nsidc.org/NOAA/G02158/masked/2004/02_Feb/SNODAS_20040229.tar');
  });
});

describe('SNODAS header', () => {
  it('reads the grid from the edges and checks it against its size', () => {
    const g = parseHeader(header());
    expect(g).toMatchObject({ cols: 4, rows: 3, minX: -122, maxY: 48, dx: 0.5, dy: 0.5, noData: -9999, slope: 1, intercept: 0, unitsDivisor: 1000, validUtc: '2026-11-18T06:00:00Z' });
  });

  it('refuses what this reader would misread', () => {
    expect(() => parseHeader(header({ units: 'Kelvin / 1.000000' }))).toThrow(SnodasFormatError);
    expect(() => parseHeader(header({ type: 'float' }))).toThrow(SnodasFormatError);
    expect(() => parseHeader(header({ bytes: 4 }))).toThrow(SnodasFormatError);
    expect(() => parseHeader(header().replace('Maximum x-axis coordinate: -120', 'Maximum x-axis coordinate: -119'))).toThrow(/edges/);
    expect(() => parseHeader(header().replace(/^Number of rows.*$/m, ''))).toThrow(/Number of rows/);
  });

  it('reads the older v1.0 header, which has no slope or intercept (2017-03-23 to 04-03)', () => {
    const v10 = header().replace('raster file v1.1', 'raster file v1.0').replace(/^Data (slope|intercept):.*\n/gm, '');
    expect(parseHeader(v10)).toMatchObject({ slope: 1, intercept: 0, unitsDivisor: 1000, cols: 4, rows: 3 });
    // A v1.1 header still needs both, and a v1.0 header that has one of them is read as written.
    expect(() => parseHeader(header().replace(/^Data slope:.*\n/m, ''))).toThrow(/Data slope/);
    const partial = header({ slope: 2 }).replace('raster file v1.1', 'raster file v1.0').replace(/^Data intercept:.*\n/m, '');
    expect(() => parseHeader(partial)).toThrow(/Data intercept/);
  });
});

describe('SNODAS cell indexing', () => {
  const g = parseHeader(header());

  it('finds the cell containing a point, row 0 at the north', () => {
    expect(cellIndex(g, 47.75, -121.75)).toEqual({ row: 0, col: 0 }); // centre of the north-west cell
    expect(cellIndex(g, 46.75, -120.25)).toEqual({ row: 2, col: 3 }); // centre of the south-east cell
    expect(cellIndex(g, 47.2, -120.9)).toEqual({ row: 1, col: 2 });
  });

  it('puts a point on a boundary in the cell east or south of it', () => {
    expect(cellIndex(g, 48, -122)).toEqual({ row: 0, col: 0 }); // the grid's own north-west corner
    expect(cellIndex(g, 47.5, -121.5)).toEqual({ row: 1, col: 1 });
    // A boundary that floating point lands a hair short of: -122 + 3 × 0.1 is 0.30000000000000004 cells off.
    const fine = parseHeader(header({ cols: 10, rows: 10, res: 0.1, maxY: 48 }));
    expect(cellIndex(fine, 48 - 3 * 0.1, -122 + 3 * 0.1)).toEqual({ row: 3, col: 3 });
  });

  it('is null off the grid (east and south edges are outside)', () => {
    expect(cellIndex(g, 48.0001, -121.75)).toBeNull();
    expect(cellIndex(g, 47.75, -122.0001)).toBeNull();
    expect(cellIndex(g, 47.75, -120)).toBeNull(); // east edge
    expect(cellIndex(g, 46.5, -121.75)).toBeNull(); // south edge
    expect(cellIndex(g, Number.NaN, -121.75)).toBeNull();
  });

  it('keeps every resort point in the same cell across the 2013-10-01 grid shift', () => {
    // Edges from the real headers: 2004–2013 files, and 2013-10-01 onwards (5% of a cell east and north).
    const before = { cols: 6935, rows: 3351, minX: -124.733749999998366, maxY: 52.874583333332339, dx: 0.008333333333333, dy: 0.008333333333333 };
    const after = { cols: 6935, rows: 3351, minX: -124.733333333328, maxY: 52.8749999999979, dx: 0.008333333333333, dy: 0.008333333333333 };
    for (const p of SNODAS_POINTS) expect(cellIndex(before, p.lat, p.lon), p.id).toEqual(cellIndex(after, p.lat, p.lon));
    const crystalMid = SNODAS_POINTS.find((p) => p.id === 'snodas-crystal-mid')!;
    expect(cellIndex(after, crystalMid.lat, crystalMid.lon)).toEqual({ row: 713, col: 389 });
    // Stevens Pass SNOTEL sits in the base band's cell.
    const st791 = STATIONS.find((s) => s.id === 'snotel-791')!;
    const base = SNODAS_POINTS.find((p) => p.id === 'snodas-stevens-base')!;
    expect(cellIndex(after, st791.lat, st791.lon)).toEqual(cellIndex(after, base.lat, base.lon));
  });
});

describe('SNODAS scaling', () => {
  const g = parseHeader(header());

  it('turns integer millimetres into depth (cm) and SWE (mm)', () => {
    expect(toMetres(1883, g)).toBeCloseTo(1.883, 9);
    expect(scaleCell('depth', 1883, g)).toBe(188.3);
    expect(scaleCell('swe', 753, g)).toBe(753);
    expect(scaleCell('depth', 0, g)).toBe(0);
    expect(scaleCell('depth', 7, g)).toBe(0.7);
  });

  it('drops no data, clipped and implausible values', () => {
    expect(scaleCell('depth', -9999, g)).toBeNull();
    expect(scaleCell('swe', 32767, g)).toBeNull(); // SWE ≥ 32.767 m, clipped (user guide §1.9.1)
    expect(scaleCell('depth', -3, g)).toBeNull();
    expect(scaleCell('depth', MAX_DEPTH_CM * 10, g)).toBe(MAX_DEPTH_CM);
    expect(scaleCell('depth', MAX_DEPTH_CM * 10 + 1, g)).toBeNull();
    expect(scaleCell('swe', MAX_SWE_MM + 1, g)).toBeNull();
  });

  it('applies the header slope, intercept and units', () => {
    const odd = parseHeader(header({ units: 'Meters / 100.000000', slope: 2, intercept: 10 }));
    expect(toMetres(45, odd)).toBeCloseTo(1, 9); // (45 × 2 + 10) / 100
  });
});

describe('SNODAS tar stream', () => {
  const date = '2026-11-18';
  // Points at the centres of cells (0,1), (0,2), (0,3), (1,0) and (2,3), and one off the grid.
  const points = [
    { id: 'a', lat: 47.75, lon: -121.25 },
    { id: 'b', lat: 47.75, lon: -120.75 },
    { id: 'nodata', lat: 47.75, lon: -120.25 },
    { id: 'clipped', lat: 47.25, lon: -121.75 },
    { id: 'se', lat: 46.75, lon: -120.25 },
    { id: 'off', lat: 50, lon: -121 },
  ];

  it('reads only the depth and SWE members and the wanted cells', async () => {
    const day = await extractDay(chunked(dayTar(date)), date, points);
    expect(Object.fromEntries([...day.values].map(([id, v]) => [id, [v.depthCm, v.sweMm]]))).toEqual({
      a: [1.5, 5], b: [188.3, 753], nodata: [null, null], clipped: [null, null], se: [0.8, 9], off: [null, null],
    });
    expect(day.values.get('se')).toMatchObject({ row: 2, col: 3 });
    expect(day.origin).toEqual({ minX: -122, maxY: 48 });
  });

  it('reads headers named .Hdr (before NSIDC renamed them) too', async () => {
    const day = await extractDay(chunked(dayTar(date, { hdrExt: 'Hdr', extra: false }), 512), date, points.slice(0, 2));
    expect(day.values.get('b')).toMatchObject({ depthCm: 188.3, sweMm: 753 });
  });

  it('keeps the product a day has when its tar lacks the other', async () => {
    const depthOnly = Buffer.concat([
      tarEntry(name('1036', date, 'txt'), gzipSync(Buffer.from(header({ date }), 'latin1'))),
      tarEntry(name('1036', date, 'dat'), gzipSync(grid(DEPTH))),
      Buffer.alloc(1024),
    ]);
    const day = await extractDay(chunked(depthOnly), date, points.slice(0, 2));
    expect(day.values.get('b')).toMatchObject({ depthCm: 188.3, sweMm: null });
  });

  it('stops reading as soon as both products are in', async () => {
    // Anything after the last wanted member, even garbage, is never read.
    const tar = Buffer.concat([dayTar(date).subarray(0, -1024), Buffer.from('not a tar header'.repeat(40))]);
    await expect(extractDay(chunked(tar, 1000), date, points)).resolves.toBeTruthy();
  });

  it('rejects a damaged, truncated or mismatched archive', async () => {
    const tar = dayTar(date);
    const bad = Buffer.from(tar);
    bad[10] ^= 1; // the first header's name: checksum no longer matches
    await expect(extractDay(chunked(bad), date, points)).rejects.toThrow(/checksum/);
    await expect(extractDay(chunked(tar.subarray(0, 3000)), date, points)).rejects.toThrow(SnodasFormatError);
    await expect(extractDay(chunked(tar), '2026-11-19', points)).rejects.toThrow(/lacks/);
    const wrongTime = Buffer.concat([
      tarEntry(name('1036', date, 'txt'), gzipSync(Buffer.from(header({ date, hour: 18 })))),
      tarEntry(name('1036', date, 'dat'), gzipSync(grid(DEPTH))),
      tarEntry(name('1034', date, 'txt'), gzipSync(Buffer.from(header({ date })))),
      tarEntry(name('1034', date, 'dat'), gzipSync(grid(SWE))),
      Buffer.alloc(1024),
    ]);
    await expect(extractDay(chunked(wrongTime), date, points)).rejects.toThrow(/valid at/);
  });

  it('checks the decompressed grid against the header size', async () => {
    const g: SnodasGrid = parseHeader(header());
    await expect(readCells(gzipSync(grid(DEPTH.slice(0, 11))), g, [0])).rejects.toThrow(/header says 24/);
    expect([...(await readCells(gzipSync(grid(DEPTH)), g, [11, 2, 2]))]).toEqual([[2, 1883], [11, 8]]);
  });

  it('skips members it was not asked for', async () => {
    const got = await readTarMembers(chunked(dayTar(date)), (n) => n.includes('1025'), () => false);
    expect([...got.keys()]).toEqual(['us_ssmv01025SlL00T0024TTNATS2026111805DP001.dat.gz']);
  });
});

describe('SNODAS points', () => {
  it('are one modelled pseudo-station per band of each lower-48 resort', () => {
    expect(SNODAS_POINTS.map((p) => p.id)).toEqual([
      'snodas-crystal-base', 'snodas-crystal-mid', 'snodas-crystal-summit',
      'snodas-snoqualmie-base', 'snodas-snoqualmie-mid', 'snodas-snoqualmie-summit',
      'snodas-stevens-base', 'snodas-stevens-mid', 'snodas-stevens-summit',
    ]);
    for (const p of SNODAS_POINTS) {
      const band = RESORTS.find((r) => r.id === p.resortId)!.bands.find((b) => p.id.endsWith(`-${b.key}`))!;
      expect([p.lat, p.lon, p.elevation, p.modelled, p.source]).toEqual([band.lat, band.lon, band.elevation, true, 'SNODAS']);
    }
    expect(SNODAS_POINTS.find((p) => p.id === 'snodas-snoqualmie-summit')!.name).toBe('Alpental top');
  });

  it('are never measurement stations, and come after them in the Snowpack choices', () => {
    expect(STATIONS.some((s) => s.modelled || s.source === 'SNODAS')).toBe(false);
    for (const r of ['crystal', 'snoqualmie', 'stevens']) {
      const choices = snowpackChoicesFor(r);
      expect(choices.slice(0, stationsFor(r).length)).toEqual(stationsFor(r));
      expect(choices.slice(stationsFor(r).length).every((s) => s.modelled)).toBe(true);
    }
    expect(snowpackChoicesFor('whistler')).toEqual(stationsFor('whistler'));
  });

  it("cite NSIDC's DOI (the Methods page links it inside the citation)", () => {
    expect(SNODAS_CITATION).toContain(SNODAS_DOI);
    expect(SNODAS_CITATION).toMatch(/^National Operational Hydrologic Remote Sensing Center\. \(2004\)\. Snow Data Assimilation System \(SNODAS\) Data Products at NSIDC\./);
  });

  it('have committed files, so the commit job accepts their refreshes', () => {
    const files = new Set(readdirSync(OBS_DIR));
    for (const p of SNODAS_POINTS) {
      expect(files.has(`${p.id}.json`), p.id).toBe(true);
      const f = JSON.parse(readFileSync(join(OBS_DIR, `${p.id}.json`), 'utf-8')) as StationFile;
      expect(f.id).toBe(p.id);
      expect(f.sweMm).not.toBeNull();
    }
  });
});

const python = spawnSync('python3', ['--version']).status === 0;

describe.skipIf(!python)('validate_obs.py', () => {
  const run = (...args: string[]) => spawnSync('python3', ['-I', VALIDATOR, ...args], { encoding: 'utf-8' });
  const file = (id: string, start: string, depthCm: (number | null)[], sweMm: (number | null)[] | null, updated = '2026-11-20T02:00:00.000Z'): StationFile => ({
    id, updated, start, depthCm, sweMm, newSnowCm: null, lastDepthDate: null, lastSweDate: null,
  });
  const setup = (dest: Record<string, unknown>, incoming: Record<string, Record<string, unknown>>) => {
    const root = mkdtempSync(join(tmpdir(), 'pw-obs-'));
    mkdirSync(join(root, 'dest'));
    for (const [n, f] of Object.entries(dest)) writeFileSync(join(root, 'dest', n), JSON.stringify(f));
    for (const [dir, files] of Object.entries(incoming)) {
      mkdirSync(join(root, dir));
      for (const [n, f] of Object.entries(files)) writeFileSync(join(root, dir, n), typeof f === 'string' ? f : JSON.stringify(f));
    }
    return root;
  };
  const read = (root: string, n: string) => JSON.parse(readFileSync(join(root, 'dest', n), 'utf-8'));

  it('passes every committed file through unchanged', () => {
    const all = Object.fromEntries(readdirSync(OBS_DIR).filter((n) => n.endsWith('.json')).map((n) => [n, JSON.parse(readFileSync(join(OBS_DIR, n), 'utf-8'))]));
    const root = setup(all, { incoming: all });
    const r = run(join(root, 'incoming'), join(root, 'dest'));
    expect(r.stderr).toBe('');
    for (const n of Object.keys(all)) expect(readFileSync(join(root, 'dest', n), 'utf-8')).toBe(readFileSync(join(OBS_DIR, n), 'utf-8'));
  });

  it('merges SNODAS days instead of replacing the history', () => {
    const history = file('snodas-x', '2025-01-01', [100, 101, 102], [300, 301, 302], '2026-11-01T00:00:00.000Z');
    // 2025-01-03 → 2026-11-17: no depth for 2025-01-03 (kept from the history), a different SWE (wins).
    const refresh = file('snodas-x', '2025-01-03', [null, ...new Array(681).fill(null), 4, 5], [333, ...new Array(681).fill(null), 7, 8]);
    const root = setup({ 'snodas-x.json': history, 'snotel-1.json': file('snotel-1', '2026-11-01', [1], [1]) }, { incoming: { 'snodas-x.json': refresh } });
    expect(run(join(root, 'incoming'), join(root, 'dest')).status).toBe(0);
    const f = read(root, 'snodas-x.json');
    expect(f.start).toBe('2025-01-01');
    expect(f.depthCm.slice(0, 3)).toEqual([100, 101, 102]); // kept where the refresh had nothing
    expect(f.sweMm.slice(0, 3)).toEqual([300, 301, 333]); // incoming wins where it has a value
    expect(f.depthCm.slice(-2)).toEqual([4, 5]);
    expect(f.depthCm).toHaveLength(686);
    expect([f.lastDepthDate, f.lastSweDate, f.updated]).toEqual(['2026-11-17', '2026-11-17', '2026-11-20T02:00:00.000Z']);
  });

  it('backfills only SNODAS files from season artifacts, idempotently', () => {
    const recent = file('snodas-x', '2026-11-15', [1, 2], [3, 4]);
    const season = file('snodas-x', '2024-10-01', [0, 0, 1.5], [0, 0, 2]);
    const root = setup({ 'snodas-x.json': recent, 'snotel-1.json': file('snotel-1', '2026-11-01', [1], [1]) }, { 'snodas-2024': { 'snodas-x.json': season } });
    expect(run('--backfill', join(root, 'snodas-2024'), join(root, 'dest')).status).toBe(0);
    const once = readFileSync(join(root, 'dest', 'snodas-x.json'), 'utf-8');
    expect(run('--backfill', join(root, 'snodas-2024'), join(root, 'dest')).status).toBe(0);
    expect(readFileSync(join(root, 'dest', 'snodas-x.json'), 'utf-8')).toBe(once);
    const f = JSON.parse(once);
    expect([f.start, f.depthCm[2], f.depthCm.at(-1), f.lastDepthDate]).toEqual(['2024-10-01', 1.5, 2, '2026-11-16']);
  });

  it("accepts and bounds a station's mean-temperature series (tavgC), which may be negative", () => {
    const snotel = { ...file('snotel-1', '2026-11-18', [20, 25, 30], [50, 60, 70]), tavgC: [-12.5, null, 3.1] };
    const ok = setup({ 'snotel-1.json': file('snotel-1', '2026-11-01', [1], [1]) }, { incoming: { 'snotel-1.json': snotel } });
    expect(run(join(ok, 'incoming'), join(ok, 'dest')).stderr).toBe('');
    expect(read(ok, 'snotel-1.json')).toEqual(snotel);
    const cases: [unknown, RegExp][] = [
      [[-70, null, 0], /implausible value -70 in tavgC/],
      [[0, 0, 51], /implausible value 51 in tavgC/],
      [[0, 0], /lengths differ/],
      ['cold', /bad series tavgC/],
    ];
    for (const [tavgC, msg] of cases) {
      const root = setup({ 'snotel-1.json': file('snotel-1', '2026-11-01', [1], [1]) }, { incoming: { 'snotel-1.json': { ...snotel, tavgC } } });
      const r = run(join(root, 'incoming'), join(root, 'dest'));
      expect(r.status, msg.source).toBe(1);
      expect(r.stderr).toMatch(msg);
    }
  });

  it('rejects anything else', () => {
    const ok = file('snodas-x', '2026-11-15', [1], [1]);
    const cases: [string[], Record<string, Record<string, unknown>>, RegExp][] = [
      [['--backfill'], { 'snodas-2024': { 'snotel-1.json': file('snotel-1', '2026-11-01', [1], [1]) } }, /not a SNODAS file/],
      [['--backfill'], { evil: { 'snodas-x.json': ok } }, /unexpected artifact directory/],
      [[], { incoming: { 'snodas-new.json': file('snodas-new', '2026-11-15', [1], [1]) } }, /unexpected file/],
      [[], { incoming: { 'snodas-x.json': file('snodas-x', '2026-11-15', [1600], [1]) } }, /implausible value 1600/],
      [[], { incoming: { 'snodas-x.json': file('snodas-x', '2026-11-15', [1, 2], [1]) } }, /lengths differ/],
      [[], { incoming: { 'snodas-x.json': '{"id":"snodas-x","updated":"2026-11-20T02:00:00Z","start":"2026-11-15","depthCm":[NaN],"sweMm":null}' } }, /non-finite/],
      [[], { incoming: { 'snodas-x.json': { ...ok, extra: 1 } } }, /unexpected structure/],
      [[], { incoming: { 'snodas-x.json': file('snodas-x', '1999-01-01', [1], [1]) } }, /outside/],
    ];
    for (const [flags, incoming, msg] of cases) {
      const root = setup({ 'snodas-x.json': ok, 'snotel-1.json': file('snotel-1', '2026-11-01', [1], [1]) }, incoming);
      const r = run(...flags, ...Object.keys(incoming).map((d) => join(root, d)), join(root, 'dest'));
      expect(r.status, msg.source).toBe(1);
      expect(r.stderr).toMatch(msg);
      expect(read(root, 'snodas-x.json')).toEqual(ok); // nothing written
    }
  });
});
