/**
 * Fetches WPC's Day 1–3 winter precipitation chances (src/lib/wpc.ts) for the US resorts' mid band.
 * Called by scripts/snapshot-forecasts.ts in the scheduled job; the browser never calls NOAA.
 *
 * Per run: one distinct-times query per layer (9) and one point query per layer and resort (9 × 3), at
 * most 3 at a time, each retried twice (the service sometimes answers 504 or an empty body). A request
 * that still fails leaves its cells unknown (null), never "under 10%".
 */
import { RESORTS } from '../src/config/resorts';
import { WPC_LAYERS, buildWpcFile, wpcPoints, wpcPointUrl, wpcTimesUrl, type WpcFile } from '../src/lib/wpc';

const MAX_CONCURRENT = 3;
const TIMEOUT_MS = 30_000;
const RETRIES = 2;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson(url: string, ua: string, deadline: number): Promise<unknown> {
  for (let attempt = 0; attempt <= RETRIES && Date.now() < deadline; attempt++) {
    if (attempt) await sleep(2000 * 3 ** (attempt - 1));
    try {
      const res = await fetch(url, { headers: { 'User-Agent': ua, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) continue;
      const json = JSON.parse(await res.text()) as unknown;
      // ArcGIS reports some failures as HTTP 200 with an `error` member.
      if (json && typeof json === 'object' && !('error' in json)) return json;
    } catch {
      /* timeout, network error or a non-JSON body: retry */
    }
  }
  return undefined;
}

export async function fetchWpc(opts: { ua: string; deadline: number }): Promise<{ file: WpcFile | null; requests: number; failed: number }> {
  const points = wpcPoints(RESORTS);
  const layers = WPC_LAYERS.flat();
  const jobs = [
    ...layers.map((l) => ({ key: `t${l}`, url: wpcTimesUrl(l) })),
    ...layers.flatMap((l) => points.map((p) => ({ key: `p${l}:${p.id}`, url: wpcPointUrl(l, p.lon, p.lat) }))),
  ];
  const got = new Map<string, unknown>();
  let next = 0;
  await Promise.all(Array.from({ length: MAX_CONCURRENT }, async () => {
    while (next < jobs.length) {
      const j = jobs[next++];
      got.set(j.key, await getJson(j.url, opts.ua, opts.deadline));
    }
  }));
  const failed = [...got.values()].filter((v) => v === undefined).length;
  const file = buildWpcFile({
    fetchedAt: Math.floor(Date.now() / 1000),
    points,
    times: (l) => got.get(`t${l}`),
    point: (l, id) => got.get(`p${l}:${id}`),
  });
  // Nothing usable (the service is down): no file, so the site says so instead of showing unknowns.
  const usable = Object.values(file.points).some((p) => p.cat.flat().some((c) => c != null)) && file.days.some((d) => d != null);
  return { file: usable ? file : null, requests: jobs.length, failed };
}
