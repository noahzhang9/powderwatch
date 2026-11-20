/**
 * SNODAS history for the modelled points (SNODAS_POINTS), one season at a time, written as station files
 * (public/data/obs/ format, holding only the days fetched) to an output directory. The manually triggered
 * `backfill-snodas` workflow runs it once per season on GitHub's runners; its write job validates and merges
 * the files into public/data/obs/ with scripts/validate_obs.py. A season is Oct 1 – Jun 30 (the climatology's
 * season) and ~3–4 GB of downloads, so don't run whole seasons from a laptop.
 *
 *   npm run backfill:snodas -- --season 2025 --out DIR [--skip-existing] [--deadline-min 130]
 *   npm run backfill:snodas -- --dates 2026-11-15,2026-11-16 --out DIR [--compare]
 *   npm run backfill:snodas -- --tar FILE.tar --date 2025-02-15 --compare     # a tar already on disk
 *
 * --skip-existing  skip days public/data/obs/ already has, so a re-run fetches only what is missing
 * --deadline-min   stop starting new days after this many minutes and write what is done (a re-run resumes)
 * --compare        also read the cells of the SNOTEL stations Morse Lake, Stevens Pass and Olallie Meadows and
 *                  print them beside the measured values (a bias sanity check; nothing is tuned from it)
 *
 * Polite to NSIDC: one request at a time (the workflow runs at most two seasons at once), a User-Agent with
 * PW_CONTACT, retries with backoff, and each download stops once the depth and SWE members are in.
 */
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { SNODAS_POINTS, STATIONS, type StationDef } from '../src/config/stations';
import { seasonDate, SEASON_DAYS } from '../src/lib/climatology';
import { valueOn, type StationFile } from '../src/lib/obs';
import { setVal, toFile, type Daily } from './obs-file';
import { extractDay, fetchSnodasDay, type SnodasDay } from './snodas';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OBS = join(ROOT, 'public/data/obs');
const CONTACT = process.env.PW_CONTACT;
const UA = `PowderWatch/0.2 (personal snow dashboard; SNODAS history backfill, one request at a time${CONTACT ? `; +${CONTACT}` : ''})`;
/** SNOTEL stations whose own cells --compare reads. */
const COMPARE = ['snotel-642', 'snotel-791', 'snotel-672'];

const { values: args } = parseArgs({
  options: {
    season: { type: 'string' },
    dates: { type: 'string' },
    tar: { type: 'string' },
    date: { type: 'string' },
    out: { type: 'string' },
    'skip-existing': { type: 'boolean', default: false },
    'deadline-min': { type: 'string' },
    compare: { type: 'boolean', default: false },
  },
});

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const fail = (msg: string): never => {
  console.error(msg);
  process.exit(2);
};

/** The season's days (Oct 1 – Jun 30, Feb 29 included), up to today (UTC). */
function seasonDates(season: number): string[] {
  const today = new Date().toISOString().slice(0, 10);
  const out: string[] = [];
  for (let k = 0; k < SEASON_DAYS; k++) {
    const d = seasonDate(season, k);
    if (d > today) break;
    out.push(d);
    if (d.endsWith('-02-28') && new Date(Date.UTC(season + 1, 1, 29)).getUTCDate() === 29) out.push(`${season + 1}-02-29`);
  }
  return out;
}

const fmt = (x: number | null | undefined, unit: string) => (x == null ? '   —   ' : `${x.toFixed(1).padStart(6)} ${unit}`);

async function main() {
  const compare = args.compare ? STATIONS.filter((s) => COMPARE.includes(s.id)) : [];
  const points: StationDef[] = [...SNODAS_POINTS, ...compare];
  let dates: string[];
  if (args.tar) {
    if (!args.date || !ISO.test(args.date)) fail('--tar needs --date YYYY-MM-DD');
    dates = [args.date!];
  } else if (args.season) {
    const season = Number(args.season);
    if (!Number.isInteger(season) || season < 2003 || season > new Date().getUTCFullYear()) fail(`bad --season ${args.season}`);
    dates = seasonDates(season);
  } else if (args.dates) {
    dates = args.dates.split(',');
    if (!dates.every((d) => ISO.test(d))) fail('--dates takes YYYY-MM-DD,YYYY-MM-DD,…');
  } else {
    fail('give --season, --dates or --tar');
  }
  dates = dates!;

  // Days the committed files already have (any point: one file serves them all).
  if (args['skip-existing']) {
    const have = await Promise.all(SNODAS_POINTS.map((p) => readFile(join(OBS, `${p.id}.json`), 'utf-8').then((t) => JSON.parse(t) as StationFile).catch(() => null)));
    const before = dates.length;
    dates = dates.filter((d) => !have.some((f) => f && valueOn(f, 'depthCm', d) != null));
    console.log(`${before - dates.length} of ${before} days already in public/data/obs; ${dates.length} to fetch`);
  }

  const daily = new Map<string, Daily>(SNODAS_POINTS.map((p) => [p.id, new Map()]));
  const deadline = args['deadline-min'] ? Date.now() + Number(args['deadline-min']) * 60_000 : Infinity;
  let written = false;
  const write = async () => {
    if (written || !args.out) return;
    written = true;
    await mkdir(args.out, { recursive: true });
    let n = 0;
    for (const [id, d] of daily) {
      if (!d.size) continue;
      await writeFile(join(args.out, `${id}.json`), JSON.stringify(toFile({ id }, d)));
      n++;
    }
    console.log(`wrote ${n} files to ${args.out}`);
  };
  // A cancelled or timed-out job still hands over the days it finished.
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => void write().finally(() => process.exit(130)));

  const t0 = Date.now();
  let fetched = 0;
  let missing = 0;
  let failed = 0;
  let stoppedAt: string | null = null;
  const obs = new Map<string, StationFile | null>();
  for (const [i, date] of dates.entries()) {
    if (Date.now() > deadline) {
      stoppedAt = date;
      break;
    }
    let day: SnodasDay | null;
    try {
      day = args.tar ? await extractDay(createReadStream(args.tar), date, points) : await fetchSnodasDay(date, points, { ua: UA });
    } catch (err) {
      failed++;
      console.error(`✗ ${date}: ${(err as Error).message}`);
      continue;
    }
    if (!day) {
      missing++;
      console.log(`· ${date}: no file at NSIDC`);
      continue;
    }
    fetched++;
    for (const p of SNODAS_POINTS) {
      const v = day.values.get(p.id)!;
      setVal(daily.get(p.id)!, date, 'depth', v.depthCm);
      setVal(daily.get(p.id)!, date, 'swe', v.sweMm);
    }
    if (i % 20 === 0 || dates.length < 40) {
      const eta = ((Date.now() - t0) / (i + 1)) * (dates.length - i - 1) / 60_000;
      console.log(`✓ ${date} (${i + 1}/${dates.length}, grid origin ${day.origin.minX.toFixed(6)}, ${day.origin.maxY.toFixed(6)}; ~${eta.toFixed(0)} min left)`);
    }
    if (args.compare) {
      console.log(`  ${'point'.padEnd(26)} ${'cell'.padEnd(10)} ${'SNODAS depth'.padStart(12)} ${'SWE'.padStart(10)}   ${'measured depth'.padStart(14)} ${'SWE'.padStart(10)}   ${'Δ depth'.padStart(10)} ${'Δ SWE'.padStart(10)}`);
      for (const p of points) {
        const v = day.values.get(p.id)!;
        if (!obs.has(p.id)) obs.set(p.id, p.modelled ? null : await readFile(join(OBS, `${p.id}.json`), 'utf-8').then((t) => JSON.parse(t) as StationFile).catch(() => null));
        const f = obs.get(p.id);
        const md = f ? valueOn(f, 'depthCm', date) : null;
        const ms = f ? valueOn(f, 'sweMm', date) : null;
        const dd = md != null && v.depthCm != null ? v.depthCm - md : null;
        const ds = ms != null && v.sweMm != null ? v.sweMm - ms : null;
        console.log(`  ${`${p.id} (${p.name})`.slice(0, 26).padEnd(26)} ${`${v.row},${v.col}`.padEnd(10)} ${fmt(v.depthCm, 'cm')}  ${fmt(v.sweMm, 'mm')}   ${p.modelled ? ''.padEnd(28) : `${fmt(md, 'cm')}  ${fmt(ms, 'mm')}`}   ${p.modelled ? '' : `${fmt(dd, 'cm')}  ${fmt(ds, 'mm')}`}`);
      }
    }
  }
  console.log(`${fetched} days read, ${missing} missing at NSIDC, ${failed} failed, in ${((Date.now() - t0) / 60_000).toFixed(1)} min`);
  if (stoppedAt) console.log(`::warning::deadline reached at ${stoppedAt}; ${dates.length - dates.indexOf(stoppedAt)} days left for a re-run`);
  if (failed) console.log(`::warning::${failed} days failed; a re-run with --skip-existing retries them`);
  await write();
  process.exitCode = failed ? 1 : 0;
}

void main();
