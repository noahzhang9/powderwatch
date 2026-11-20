/**
 * Forecast snapshot: fetches the Open-Meteo responses the first screens need
 * and writes them, with a manifest, into the built site (dist/data/fc/), so
 * normal visits read same-origin files instead of calling Open-Meteo.
 *
 * The manifest maps each request URL — built by the same functions the browser
 * uses (src/lib/openmeteo.ts, src/lib/requests.ts) — to its file and fetch
 * time. The browser uses a copy younger than SNAPSHOT_MAX_AGE_S (4.5 h) and calls
 * Open-Meteo itself for anything missing or older (src/lib/cache.ts). Nothing here is committed:
 * it ships only with the Pages deploy.
 *
 *   npm run build && npm run snapshot
 *
 * Polite to the free tier: at most 3 concurrent requests, paced under the
 * per-minute limit, 429/5xx retried with backoff (Retry-After honoured), and a
 * per-run budget in Open-Meteo's weighted calls; lower-priority groups are
 * skipped when it runs out, but the first screens always fit (see runBudget in
 * scripts/snapshot-plan.ts). Failed requests are logged and left out of the
 * manifest; the exit code is 1 if any failed.
 *
 * It also keeps a copy in .cache/fc/ (gitignored, best effort), which survives
 * `vite build` emptying dist/: `npm run preview:local` builds a snapshot-only
 * site from it without calling Open-Meteo again.
 *
 * Alongside, it queries NOAA/NWS WPC's winter precipitation chances for the US
 * resorts (scripts/fetch-wpc.ts) and writes them as one more content-addressed
 * file, `wpc-<hash>.json`, named by the manifest's `wpc` entry: the browser reads
 * only that same-origin file and never calls NOAA.
 *
 * From the same responses (no extra calls) it writes the forecast-verification
 * record for the global cycle this run carries (scripts/verification.ts) to
 * .cache/verification/<cycle>.json, best effort. The workflow uploads it and its
 * `archive` job commits it to the data/verification branch; it is never deployed.
 *
 * Env: PW_CONTACT (URL added to the User-Agent), SNAPSHOT_MAX_COST (per-run
 * budget, default 1,250 weighted calls, raised to fit the first screens),
 * SNAPSHOT_OUT (output directory), VERIFICATION_OUT (record directory).
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RESORTS } from '../src/config/resorts';
import { STATIONS } from '../src/config/stations';
import {
  LOCAL_SNAPSHOT_DIR, SNAPSHOT_DIR, SNAPSHOT_FILE_RE, SNAPSHOT_INTERVAL_H, SNAPSHOT_MANIFEST, WPC_FILE_RE, type SnapshotEntry, type SnapshotManifest,
} from '../src/lib/cache';
import type { WpcFile } from '../src/lib/wpc';
import { fetchWpc } from './fetch-wpc';
import type { StationFile } from '../src/lib/obs';
import { parseRunMeta, parseSurface, runMetaUrl, type OmResponse, type RunMeta, type SurfaceHourly } from '../src/lib/openmeteo';
import {
  DEFAULT_MAX_COST, FIRST_SCREENS, PRIORITY, RUNS_PER_DAY, estimateCost, firstScreenCost, groupCost, metaIdsFor, midSurfaceUrl, planSnapshot, runBudget,
  selectWithinBudget,
} from './snapshot-plan';
import { buildVerificationRecord, recordFileName } from './verification';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.SNAPSHOT_OUT ? resolve(process.env.SNAPSHOT_OUT) : join(ROOT, 'dist', SNAPSHOT_DIR);
/** Copy kept across builds for snapshot-only local previews. */
const LOCAL_COPY = join(ROOT, LOCAL_SNAPSHOT_DIR);
const OBS = join(ROOT, 'public/data/obs');
const VERIFICATION_OUT = process.env.VERIFICATION_OUT ? resolve(process.env.VERIFICATION_OUT) : join(ROOT, '.cache/verification');
const CONTACT = process.env.PW_CONTACT;
const UA = `PowderWatch/0.2 (personal snow dashboard; forecast snapshot every ${SNAPSHOT_INTERVAL_H} h${CONTACT ? `; +${CONTACT}` : ''})`;
const MAX_CONCURRENT = 3;
/** Free tier: 600 weighted calls a minute per client. */
const COST_PER_MINUTE = 400;
const MAX_COST = Number(process.env.SNAPSHOT_MAX_COST ?? DEFAULT_MAX_COST);
const RETRIES = 4;
/** Stop starting requests after this long so the deploy is never held up; what arrived is still written. */
const DEADLINE_MS = 7 * 60_000;
const REQUEST_TIMEOUT_MS = 90_000;
/** WPC requests start only within this long of the run's start. */
const WPC_DEADLINE_MS = 3 * 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;
const fmtCost = (c: number) => c.toLocaleString('en-US', { maximumFractionDigits: 1 });

interface Result {
  ok: boolean;
  body?: string;
  fetchedAt?: number;
  attempts: number;
  error?: string;
}

const t0 = Date.now();
const stats = { requests: 0, retries: 0, bytes: 0, cost: 0 };

// Pacing: estimated cost started in the last 60 s stays under COST_PER_MINUTE.
const lastMinute: { t: number; cost: number }[] = [];
async function pace(cost: number) {
  for (;;) {
    while (lastMinute.length && lastMinute[0].t < Date.now() - 60_000) lastMinute.shift();
    const used = lastMinute.reduce((s, x) => s + x.cost, 0);
    if (!lastMinute.length || used + cost <= COST_PER_MINUTE) {
      lastMinute.push({ t: Date.now(), cost });
      return;
    }
    await sleep(lastMinute[0].t + 60_050 - Date.now());
  }
}

function reasonOf(text: string): string {
  try {
    const r = (JSON.parse(text) as { reason?: string }).reason;
    return r ? ` ${r}` : '';
  } catch {
    return '';
  }
}

async function get(url: string): Promise<Result> {
  const est = estimateCost(url);
  let error = '';
  let attempts = 0;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (Date.now() - t0 > DEADLINE_MS) {
      error ||= 'deadline reached';
      break;
    }
    await pace(est);
    attempts++;
    stats.requests++;
    if (attempt) stats.retries++;
    let wait = Math.min(60_000, 5000 * 3 ** attempt) * (0.75 + Math.random() * 0.5);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      const text = await res.text();
      stats.bytes += Buffer.byteLength(text);
      stats.cost += Number(res.headers.get('x-ratelimit-cost')) || 0;
      if (res.ok) {
        JSON.parse(text); // only valid JSON is published
        return { ok: true, body: text, fetchedAt: Math.floor(Date.now() / 1000), attempts };
      }
      error = `HTTP ${res.status}${reasonOf(text)}`;
      if (res.status !== 429 && res.status < 500) break; // not transient (e.g. 400: run not published)
      const retryAfter = Number(res.headers.get('retry-after'));
      if (retryAfter > 0) wait = Math.min(70_000, retryAfter * 1000 + 500);
    } catch (err) {
      error = (err as Error).message;
    }
    if (attempt < RETRIES && Date.now() - t0 + wait < DEADLINE_MS) await sleep(wait);
  }
  return { ok: false, attempts, error };
}

async function fetchAll(urls: string[], into: Map<string, Result>) {
  const queue = urls.filter((u) => !into.has(u));
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT, queue.length) }, async () => {
    while (next < queue.length) {
      const u = queue[next++];
      into.set(u, await get(u));
    }
  }));
}

async function readObs(): Promise<Record<string, StationFile | null>> {
  const out: Record<string, StationFile | null> = {};
  for (const st of STATIONS) {
    out[st.id] = await readFile(join(OBS, `${st.id}.json`), 'utf-8').then((t) => JSON.parse(t) as StationFile).catch(() => null);
  }
  return out;
}

/** Writes the snapshot files and manifest (atomically) to `dir`, then removes files from earlier runs. */
async function writeSnapshot(dir: string, files: Map<string, string>, manifest: SnapshotManifest) {
  await mkdir(dir, { recursive: true });
  for (const [file, body] of files) await writeFile(join(dir, file), body);
  const tmp = join(dir, `${SNAPSHOT_MANIFEST}.tmp`);
  await writeFile(tmp, JSON.stringify(manifest));
  await rename(tmp, join(dir, SNAPSHOT_MANIFEST));
  for (const f of await readdir(dir)) if ((SNAPSHOT_FILE_RE.test(f) || WPC_FILE_RE.test(f)) && !files.has(f)) await rm(join(dir, f));
}

function parsed<T>(r: Result | undefined, f: (json: never) => T): T | undefined {
  if (!r?.ok) return undefined;
  try {
    return f(JSON.parse(r.body!) as never);
  } catch {
    return undefined;
  }
}

async function main() {
  const nowS = Math.floor(t0 / 1000);
  if (!process.env.SNAPSHOT_OUT && !existsSync(join(ROOT, 'dist/index.html'))) {
    console.warn('dist/ has no build yet. Run `npm run build` first: it empties dist/, snapshot included.');
  }
  const obs = await readObs();
  const results = new Map<string, Result>();
  // NOAA WPC, in parallel (another host, so outside the Open-Meteo pacing). It can never fail the snapshot, and
  // its own shorter deadline keeps a hung service from holding up the snapshot's write (it normally takes ~2 s).
  const wpcRun = fetchWpc({ ua: UA, deadline: t0 + WPC_DEADLINE_MS }).catch((err: Error) => {
    console.warn(`::warning::WPC chances not fetched: ${err.message}`);
    return { file: null, requests: 0, failed: 0 };
  });

  // Stage 1: run metadata and the mid-band forecasts, which decide the run-change requests.
  const stage1 = planSnapshot({ nowS, obs }).filter((g) => g.priority <= PRIORITY.firstPaint);
  await fetchAll(stage1.flatMap((g) => g.urls), results);
  const meta: Record<string, RunMeta | null> = {};
  for (const id of metaIdsFor()) meta[id] = parsed(results.get(runMetaUrl(id)), parseRunMeta) ?? null;
  const midSurface: Record<string, SurfaceHourly[]> = {};
  for (const r of RESORTS) {
    const s = parsed(results.get(midSurfaceUrl(r)), (d) => parseSurface(d, r.models));
    if (s) midSurface[r.id] = s;
  }

  // Stage 2: everything else, in priority order, within the budget.
  const plan = planSnapshot({ nowS, obs, meta, midSurface });
  const budget = runBudget(plan, MAX_COST);
  const { included, skipped, cost: planned } = selectWithinBudget(plan, budget);
  const total = plan.reduce((s, g) => s + groupCost(g), 0);
  console.log(`plan: ${plan.flatMap((g) => g.urls).length} URLs in ${plan.length} groups, est. ${fmtCost(total)} calls ` +
    `(first screens ${fmtCost(firstScreenCost(plan))}); budget ${fmtCost(budget)} → ${included.flatMap((g) => g.urls).length} URLs, est. ${fmtCost(planned)} calls`);
  if (skipped.some((g) => g.priority <= FIRST_SCREENS)) console.log('::warning::first-screen groups skipped: their cost is over HARD_MAX_COST');
  await fetchAll(included.flatMap((g) => g.urls), results);

  const entries: Record<string, SnapshotEntry> = {};
  const files = new Map<string, string>();
  let saved = 0;
  let savedBytes = 0;
  const failed: string[] = [];
  for (const g of included) {
    let ok = 0;
    let bytes = 0;
    const errors: string[] = [];
    for (const u of g.urls) {
      const r = results.get(u)!;
      if (!r.ok) {
        errors.push(`${new URL(u).searchParams.get('models') ?? new URL(u).pathname}: ${r.error}`);
        failed.push(u);
        continue;
      }
      const file = `${sha(u).slice(0, 16)}-${sha(r.body!).slice(0, 10)}.json`;
      if (!SNAPSHOT_FILE_RE.test(file)) throw new Error(`bad snapshot file name ${file}`);
      files.set(file, r.body!);
      entries[u] = { file, fetchedAt: r.fetchedAt! };
      ok++;
      bytes += Buffer.byteLength(r.body!);
    }
    saved += ok;
    savedBytes += bytes;
    const mark = ok === g.urls.length ? '✓' : ok ? '~' : '✗';
    console.log(`${mark} ${g.label.padEnd(44)} ${ok}/${g.urls.length}  ${mb(bytes).padStart(8)}  est. ${fmtCost(groupCost(g))}${errors.length ? `  (${errors.join('; ')})` : ''}`);
  }
  for (const g of skipped) console.log(`– ${g.label.padEnd(44)} skipped: over the per-run budget (est. ${fmtCost(groupCost(g))})`);

  const wpc = await wpcRun;
  const wpcFile: WpcFile | null = wpc.file;
  const manifest: SnapshotManifest = { version: 1, generatedAt: nowS, entries };
  if (wpcFile) {
    const body = JSON.stringify(wpcFile);
    const file = `wpc-${sha(body).slice(0, 10)}.json`;
    if (!WPC_FILE_RE.test(file)) throw new Error(`bad WPC file name ${file}`);
    files.set(file, body);
    manifest.wpc = { file, fetchedAt: wpcFile.fetchedAt };
  }
  console.log(`${wpcFile ? '✓' : '✗'} ${'NOAA WPC winter chances (US resorts, mid)'.padEnd(44)} ${wpc.requests - wpc.failed}/${wpc.requests} requests` +
    (wpcFile ? `  days ${wpcFile.days.map((d) => (d ? `${d.start}–${d.end.slice(11)}` : '?')).join(', ')}` : '  (none written: the site says so)'));
  await writeSnapshot(OUT, files, manifest);
  if (resolve(LOCAL_COPY) !== resolve(OUT)) {
    // Best effort: the local copy must never fail a deploy.
    await writeSnapshot(LOCAL_COPY, files, manifest).then(
      () => console.log(`local copy: ${files.size} files + manifest in ${LOCAL_COPY} (npm run preview:local)`),
      (err: Error) => console.warn(`local copy in ${LOCAL_COPY} not written: ${err.message}`),
    );
  }

  // Verification record: from responses already fetched; it must never fail the snapshot or the deploy.
  try {
    const memo = new Map<string, OmResponse | undefined>();
    const json = (u: string) => {
      if (!memo.has(u)) memo.set(u, parsed(results.get(u), (d: OmResponse) => d));
      return memo.get(u);
    };
    const rec = buildVerificationRecord({ nowS, meta, obs, json, wpc: wpcFile });
    if (rec) {
      const body = JSON.stringify(rec);
      await mkdir(VERIFICATION_OUT, { recursive: true });
      await writeFile(join(VERIFICATION_OUT, recordFileName(rec)), body);
      console.log(`verification record ${rec.cycle}: ${rec.points.length} points, ${rec.skipped.length} stations skipped ` +
        `(${rec.skipped.map((x) => `${x.id} ${x.reason}`).join(', ') || 'none'}), ${(Buffer.byteLength(body) / 1e3).toFixed(1)} kB → ${VERIFICATION_OUT}`);
    } else console.log('verification record: run metadata names no cycle; none written');
  } catch (err) {
    console.warn(`::warning::verification record not written: ${(err as Error).message}`);
  }

  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`done in ${secs} s: ${stats.requests} HTTP requests (${stats.retries} retries), ${saved} saved, ${failed.length} failed, ` +
    `${skipped.length} groups skipped; ${mb(stats.bytes)} downloaded, ${mb(savedBytes)} written to ${OUT}`);
  console.log(`Open-Meteo cost: ${fmtCost(stats.cost)} calls (X-RateLimit-Cost), est. ${fmtCost(planned)}; ` +
    `at ${RUNS_PER_DAY} runs a day ≈ ${stats.requests * RUNS_PER_DAY} requests, ${fmtCost(stats.cost * RUNS_PER_DAY)} calls (free tier: < 10,000)`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((err) => {
  console.error(`snapshot failed: ${(err as Error).stack ?? err}`);
  process.exitCode = 1;
});
