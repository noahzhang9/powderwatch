/**
 * One-time backfill for the verification archive, from Open-Meteo's Previous Runs API: what each
 * snowpack-scenario model forecast for each past day, 1 to 7 days ahead, at each station's own point.
 * Writes one record per valid local date (scripts/verification.ts, `buildBackfillRecords`) to
 * .cache/verification-backfill/; it pushes nothing. README ("Forecast-verification archive") has the
 * steps that validate the files and add them to the data/verification branch.
 *
 *   npm run backfill:verification -- --dry-run          # plan and estimated cost only, no requests
 *   npm run backfill:verification                       # 2026-10-01 to yesterday (UTC)
 *   npm run backfill:verification -- --from 2026-10-01 --to 2026-11-19
 *
 * Stations that reported nothing since --from are left out (nothing to verify them against). The run
 * refuses to start when the estimated weighted cost is over BACKFILL_MAX_COST (default 1,500).
 *
 * Env: PW_CONTACT (URL added to the User-Agent), BACKFILL_OUT (output directory), BACKFILL_MAX_COST.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RESORTS } from '../src/config/resorts';
import { stationsFor } from '../src/config/stations';
import type { StationFile } from '../src/lib/obs';
import { previousRunsUrl, type OmResponse } from '../src/lib/openmeteo';
import { SCENARIO_MODELS, pointOf } from '../src/lib/requests';
import { addDays, daysBetween } from '../src/lib/time';
import { estimateCost } from './snapshot-plan';
import { buildBackfillRecords } from './verification';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.BACKFILL_OUT ? resolve(process.env.BACKFILL_OUT) : join(ROOT, '.cache/verification-backfill');
const MAX_COST = Number(process.env.BACKFILL_MAX_COST ?? 1500);
const CONTACT = process.env.PW_CONTACT;
const UA = `PowderWatch/0.2 (personal snow dashboard; one-time verification backfill${CONTACT ? `; +${CONTACT}` : ''})`;
/** Paced well under the free tier's 600 weighted calls a minute. */
const COST_PER_MINUTE = 300;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};

async function get(url: string): Promise<{ json: OmResponse; cost: number }> {
  let wait = 5000;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(120_000) });
    const text = await res.text();
    if (res.ok) return { json: JSON.parse(text) as OmResponse, cost: Number(res.headers.get('x-ratelimit-cost')) || 0 };
    if (attempt >= 3 || (res.status !== 429 && res.status < 500)) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    const retryAfter = Number(res.headers.get('retry-after'));
    await sleep(retryAfter > 0 ? retryAfter * 1000 + 500 : wait);
    wait *= 3;
  }
}

async function main() {
  const from = arg('--from') ?? '2026-10-01';
  const to = arg('--to') ?? addDays(new Date().toISOString().slice(0, 10), -1);
  if (!DATE.test(from) || !DATE.test(to) || daysBetween(from, to) < 0) throw new Error(`bad window ${from}..${to}`);
  const dates = Array.from({ length: daysBetween(from, to) + 1 }, (_, i) => addDays(from, i));

  const jobs: { resort: (typeof RESORTS)[number]; station: ReturnType<typeof stationsFor>[number]; url: string }[] = [];
  const left: string[] = [];
  for (const r of RESORTS) {
    for (const st of stationsFor(r.id)) {
      const file = await readFile(join(ROOT, 'public/data/obs', `${st.id}.json`), 'utf-8').then((t) => JSON.parse(t) as StationFile).catch(() => null);
      if (!file?.lastDepthDate || file.lastDepthDate < from) {
        left.push(st.id);
        continue;
      }
      // One more day so the last date's final hour (00:00 the next day) is included.
      jobs.push({ resort: r, station: st, url: previousRunsUrl(pointOf(st), SCENARIO_MODELS, r.tz, from, addDays(to, 1)) });
    }
  }
  const cost = jobs.reduce((s, j) => s + estimateCost(j.url), 0);
  console.log(`backfill ${from}..${to} (${dates.length} days): ${jobs.length} station points × ${SCENARIO_MODELS.length} models, ` +
    `est. ${cost.toFixed(1)} weighted calls (${estimateCost(jobs[0]?.url ?? 'https://x/?').toFixed(1)} each); left out (no readings since ${from}): ${left.join(', ') || 'none'}`);
  if (cost > MAX_COST) throw new Error(`estimated cost ${cost.toFixed(0)} is over BACKFILL_MAX_COST (${MAX_COST}); shorten the window`);
  if (process.argv.includes('--dry-run')) return;

  const fetched: { resort: (typeof RESORTS)[number]; station: (typeof jobs)[number]['station']; json: OmResponse }[] = [];
  let measured = 0;
  const started: { t: number; cost: number }[] = [];
  for (const j of jobs) {
    const c = estimateCost(j.url);
    for (;;) {
      while (started.length && started[0].t < Date.now() - 60_000) started.shift();
      if (!started.length || started.reduce((s, x) => s + x.cost, 0) + c <= COST_PER_MINUTE) break;
      await sleep(started[0].t + 60_050 - Date.now());
    }
    started.push({ t: Date.now(), cost: c });
    try {
      const { json, cost: x } = await get(j.url);
      measured += x;
      fetched.push({ resort: j.resort, station: j.station, json });
      console.log(`✓ ${j.station.id.padEnd(14)} cost ${x || '?'}`);
    } catch (err) {
      console.warn(`✗ ${j.station.id}: ${(err as Error).message}`);
    }
  }

  const records = buildBackfillRecords({ generatedAtS: Math.floor(Date.now() / 1000), dates, stations: fetched });
  await mkdir(OUT, { recursive: true });
  let bytes = 0;
  for (const rec of records) {
    const body = JSON.stringify(rec);
    bytes += Buffer.byteLength(body);
    await writeFile(join(OUT, `${rec.date}.json`), body);
  }
  console.log(`${records.length} daily records, ${(bytes / 1e3).toFixed(0)} kB → ${OUT}; Open-Meteo cost ${measured.toFixed(1)} (X-RateLimit-Cost), est. ${cost.toFixed(1)}`);
  if (fetched.length < jobs.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`backfill failed: ${(err as Error).message}`);
  process.exitCode = 1;
});
