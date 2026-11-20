/**
 * Fetch-through cache: in-memory map + IndexedDB, keyed by URL.
 * Past model runs are immutable and cached indefinitely; live forecasts use a TTL.
 * Before going to the network it consults the forecast snapshot that the
 * scheduled job publishes with the site (scripts/snapshot-forecasts.ts).
 * Also limits concurrent network requests to stay polite to free APIs.
 *
 * Snapshot-only builds (VITE_SNAPSHOT_ONLY=1, `npm run preview:local`) never
 * call Open-Meteo: they use snapshot copies of any age, and anything not in
 * the snapshot fails with NotInSnapshotError, which views show inline.
 */

const DB_NAME = 'powderwatch';
const STORE = 'http';
const mem = new Map<string, { t: number; data: unknown }>();
const inflight = new Map<string, Promise<unknown>>();

let dbPromise: Promise<IDBDatabase | null> | null = null;
function db(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => {
      // Close on a delete/upgrade request so "clear cache" isn't blocked by this connection.
      req.result.onversionchange = () => req.result.close();
      resolve(req.result);
    };
    req.onerror = () => resolve(null);
  });
  return dbPromise;
}

async function idbGet(key: string): Promise<{ t: number; data: unknown } | undefined> {
  const d = await db();
  if (!d) return undefined;
  return new Promise((resolve) => {
    const req = d.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(undefined);
  });
}

async function idbPut(key: string, value: { t: number; data: unknown }): Promise<void> {
  const d = await db();
  if (!d) return;
  await new Promise<void>((resolve) => {
    const tx = d.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

export async function clearCache(): Promise<void> {
  mem.clear();
  manifest = null;
  const d = await db();
  if (!d) return;
  await new Promise<void>((resolve) => {
    const tx = d.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

// --- concurrency limiter with two priorities ---
// High-priority requests (the forecast on screen) always go first; low-priority
// ones (ensembles, past runs, side panels) start only when no high-priority
// request is running or waiting, so they never compete for bandwidth with it.
export type Priority = 'high' | 'low';
const MAX_CONCURRENT = 4;
let active = 0;
let activeHigh = 0;
const queues: Record<Priority, (() => void)[]> = { high: [], low: [] };

function pump() {
  while (active < MAX_CONCURRENT) {
    const next = queues.high.shift() ?? (activeHigh === 0 ? queues.low.shift() : undefined);
    if (!next) break;
    next();
  }
}

async function withSlot<T>(priority: Priority, fn: () => Promise<T>): Promise<T> {
  await new Promise<void>((r) => {
    queues[priority].push(() => {
      active++;
      if (priority === 'high') activeHigh++;
      r();
    });
    pump();
    notify();
  });
  try {
    return await fn();
  } finally {
    active--;
    if (priority === 'high') activeHigh--;
    pump();
    notify();
  }
}

// --- network status, so loading messages can say why they are waiting ---
export interface NetStatus {
  active: number;
  queued: number;
  /** Unix ms until which a rate-limited request is backing off, if any. */
  retryUntil: number | null;
  lastHttpStatus: number | null;
}
let retryUntil: number | null = null;
let lastHttpStatus: number | null = null;
const listeners = new Set<() => void>();
function notify() {
  for (const l of listeners) l();
}
export function netStatus(): NetStatus {
  return { active, queued: queues.high.length + queues.low.length, retryUntil, lastHttpStatus };
}
export function subscribeNet(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// --- forecast snapshot: same-origin copies of Open-Meteo responses, keyed by request URL ---
/** Snapshot location, relative to the site root. */
export const SNAPSHOT_DIR = 'data/fc/';
export const SNAPSHOT_MANIFEST = 'manifest.json';
/**
 * Where `npm run snapshot` also keeps its output, relative to the repo root. `vite build` empties
 * dist/ (snapshot included); snapshot-only builds copy this back in (vite.config.ts). Gitignored.
 */
export const LOCAL_SNAPSHOT_DIR = '.cache/fc/';
/** The scheduled job refreshes the snapshot this often (keep in step with the workflow's cron). */
export const SNAPSHOT_INTERVAL_H = 4;
/** Snapshot copies younger than this are used instead of calling Open-Meteo: one interval plus 30 minutes for a late run. */
export const SNAPSHOT_MAX_AGE_S = (SNAPSHOT_INTERVAL_H + 0.5) * 3600;
/** `<url hash>-<content hash>.json`: content-addressed, so a cached copy is never out of date. */
export const SNAPSHOT_FILE_RE = /^[0-9a-f]{16}-[0-9a-f]{10}\.json$/;
/** A tab open this long re-reads the manifest once, to pick up the next snapshot. */
const MANIFEST_RELOAD_MS = 60 * 60 * 1000;

export interface SnapshotEntry {
  file: string;
  /** When the job received the response, unix seconds. */
  fetchedAt: number;
}

export interface SnapshotManifest {
  version: 1;
  /** When the job started, unix seconds. */
  generatedAt: number;
  entries: Record<string, SnapshotEntry>;
}

/** Validates a manifest; anything malformed is treated as "no snapshot". */
export function parseManifest(x: unknown): Map<string, SnapshotEntry> | null {
  if (!x || typeof x !== 'object') return null;
  const m = x as Partial<SnapshotManifest>;
  if (m.version !== 1 || !m.entries || typeof m.entries !== 'object') return null;
  const out = new Map<string, SnapshotEntry>();
  for (const [url, e] of Object.entries(m.entries)) {
    if (!url.startsWith('https://') || !e || typeof e.file !== 'string' || !SNAPSHOT_FILE_RE.test(e.file)) continue;
    if (typeof e.fetchedAt !== 'number' || !Number.isFinite(e.fetchedAt)) continue;
    out.set(url, { file: e.file, fetchedAt: e.fetchedAt });
  }
  return out;
}

export const snapshotIsFresh = (e: SnapshotEntry, nowS: number) => nowS - e.fetchedAt < SNAPSHOT_MAX_AGE_S;

/**
 * Build-time switch for local testing: `VITE_SNAPSHOT_ONLY=1` (set by `npm run build:local` and
 * `npm run preview:local`, never by the deploy workflow). Read when called, so the snapshot
 * scripts can import this module outside Vite.
 */
export const isSnapshotOnly = (): boolean => import.meta.env.VITE_SNAPSHOT_ONLY === '1';

/** What a request uses: the snapshot copy, a live Open-Meteo call, or neither (snapshot-only mode, no copy). */
export type SnapshotUse = 'snapshot' | 'live' | 'unavailable';

/** Normal builds use a fresh snapshot copy and go live otherwise; snapshot-only builds use any copy and never go live. */
export function snapshotUse(entry: SnapshotEntry | undefined, nowS: number, snapshotOnly: boolean): SnapshotUse {
  if (snapshotOnly) return entry ? 'snapshot' : 'unavailable';
  return entry && snapshotIsFresh(entry, nowS) ? 'snapshot' : 'live';
}

export const NOT_IN_SNAPSHOT = 'Not in the local snapshot (snapshot-only mode)';

/** A request a snapshot-only build can't serve; views show it as an inline message, not a failure. */
export class NotInSnapshotError extends Error {
  readonly url: string;
  constructor(url: string) {
    super(NOT_IN_SNAPSHOT);
    this.name = 'NotInSnapshotError';
    this.url = url;
  }
}

export const isNotInSnapshot = (err: unknown): err is NotInSnapshotError => err instanceof NotInSnapshotError;

/** The manifest's own timestamp (when the job started), if it is a plausible unix time. */
export function manifestGeneratedAt(x: unknown): number | null {
  const t = (x as Partial<SnapshotManifest> | null)?.generatedAt;
  return typeof t === 'number' && Number.isFinite(t) && t > 0 ? t : null;
}

const snapshotBase = () => `${import.meta.env.BASE_URL}${SNAPSHOT_DIR}`;

interface LoadedManifest {
  entries: Map<string, SnapshotEntry>;
  generatedAt: number | null;
}

let manifest: { loadedAt: number; data: Promise<LoadedManifest | null> } | null = null;

/** The manifest, fetched once per page (revalidated, never a stale HTTP-cache copy). */
function loadManifest(): Promise<LoadedManifest | null> {
  if (!manifest || Date.now() - manifest.loadedAt > MANIFEST_RELOAD_MS) {
    manifest = {
      loadedAt: Date.now(),
      data: fetch(`${snapshotBase()}${SNAPSHOT_MANIFEST}`, { cache: 'no-cache' })
        .then((r) => (r.ok ? r.json() : null))
        .then((json: unknown) => {
          const entries = parseManifest(json);
          return entries && { entries, generatedAt: manifestGeneratedAt(json) };
        })
        .catch(() => null), // no snapshot deployed (dev server, first deploy): everything goes live
    };
  }
  return manifest.data;
}

const snapshotEntries = async () => (await loadManifest())?.entries ?? null;

/** When the deployed snapshot was taken and how many requests it holds (null: no snapshot). */
export async function snapshotInfo(): Promise<{ generatedAt: number | null; entries: number } | null> {
  const m = await loadManifest();
  return m && { generatedAt: m.generatedAt, entries: m.entries.size };
}

async function fetchSnapshotFile<T>(file: string): Promise<T> {
  const res = await fetch(`${snapshotBase()}${file}`);
  if (!res.ok) throw new HttpError(res.status, `snapshot ${file}: ${res.status}`);
  return (await res.json()) as T;
}

async function fetchLive<T>(url: string): Promise<T> {
  let res = await fetch(url);
  // Rate limits and server hiccups: retry twice with jittered backoff (~5 s, ~15 s).
  for (const waitMs of [5000, 15000]) {
    if (res.ok || !(res.status === 429 || res.status >= 500)) break;
    lastHttpStatus = res.status;
    const wait = waitMs * (0.75 + Math.random() * 0.5);
    retryUntil = Date.now() + wait;
    notify();
    await new Promise((r) => setTimeout(r, wait));
    retryUntil = null;
    notify();
    res = await fetch(url);
  }
  if (!res.ok) {
    let reason = res.statusText;
    try {
      const body = await res.json();
      reason = body.reason ?? reason;
    } catch {
      /* non-JSON error body */
    }
    throw new HttpError(res.status, `${res.status}: ${reason}`);
  }
  return (await res.json()) as T;
}

/**
 * Fetch JSON with caching. `ttlSec = Infinity` caches forever.
 *
 * Order: a cached copy within `ttlSec` → a fresh snapshot copy (or a cached
 * copy at least as new) → Open-Meteo → on failure, the newest older copy
 * (stale snapshot or stale cache), so a rate limit never empties a chart
 * that has any data to show.
 *
 * Snapshot-only builds treat every snapshot copy as fresh and replace the
 * Open-Meteo call with a NotInSnapshotError (after any older cached copy).
 */
export async function cachedJson<T>(url: string, ttlSec: number, priority: Priority = 'high'): Promise<T> {
  const now = Date.now() / 1000;
  const m = mem.get(url);
  if (m && now - m.t < ttlSec) return m.data as T;
  const pending = inflight.get(url);
  if (pending) return pending as Promise<T>;

  const p = (async () => {
    const stored = m ?? (await idbGet(url));
    const keep = (entry: { t: number; data: unknown }) => {
      mem.set(url, entry);
      if (entry !== stored) void idbPut(url, entry);
      return entry.data as T;
    };
    if (stored && now - stored.t < ttlSec) return keep(stored);

    const snap = (await snapshotEntries())?.get(url);
    // A cached copy at least as new as the snapshot's makes the snapshot redundant.
    const storedCovers = stored != null && snap != null && stored.t >= snap.fetchedAt;
    let snapTried = false;
    // A fresh copy is read in a slot, so on-screen data still loads first. A fallback read
    // after a failed live request is not: it must not queue behind other requests' backoff.
    const readSnapshot = async (queued: boolean) => {
      snapTried = true;
      const read = () => fetchSnapshotFile<T>(snap!.file);
      const data = await (queued ? withSlot(priority, read) : read());
      return keep({ t: snap!.fetchedAt, data });
    };
    const snapshotOnly = isSnapshotOnly();
    if (snapshotUse(snap, now, snapshotOnly) === 'snapshot') {
      if (storedCovers) return keep(stored);
      try {
        return await readSnapshot(true);
      } catch {
        /* snapshot file missing: go live */
      }
    }
    if (snapshotOnly) {
      // Never call Open-Meteo: an older cached copy if there is one, otherwise say why there's no data.
      if (stored) return keep(stored);
      throw new NotInSnapshotError(url);
    }

    try {
      const data = await withSlot(priority, () => fetchLive<T>(url));
      return keep({ t: now, data });
    } catch (err) {
      // Offline or rate-limited: an older copy beats an empty chart.
      if (snap && !storedCovers && !snapTried) {
        try {
          return await readSnapshot(false);
        } catch {
          /* fall through to the cached copy */
        }
      }
      if (stored) return keep(stored);
      throw err;
    }
  })();
  inflight.set(url, p);
  try {
    return await p;
  } finally {
    inflight.delete(url);
  }
}
