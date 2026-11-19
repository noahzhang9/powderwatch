/**
 * Fetch-through cache: in-memory map + IndexedDB, keyed by URL.
 * Past model runs are immutable and cached indefinitely; live forecasts use a TTL.
 * Before going to the network it consults the forecast snapshot that the
 * scheduled job publishes with the site (scripts/snapshot-forecasts.ts).
 * Also limits concurrent network requests to stay polite to free APIs.
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
/** Snapshot copies younger than this are used instead of calling Open-Meteo (the job runs every 3 h). */
export const SNAPSHOT_MAX_AGE_S = 3.5 * 3600;
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

const snapshotBase = () => `${import.meta.env.BASE_URL}${SNAPSHOT_DIR}`;

let manifest: { loadedAt: number; entries: Promise<Map<string, SnapshotEntry> | null> } | null = null;

/** The manifest, fetched once per page (revalidated, never a stale HTTP-cache copy). */
function snapshotEntries(): Promise<Map<string, SnapshotEntry> | null> {
  if (!manifest || Date.now() - manifest.loadedAt > MANIFEST_RELOAD_MS) {
    manifest = {
      loadedAt: Date.now(),
      entries: fetch(`${snapshotBase()}${SNAPSHOT_MANIFEST}`, { cache: 'no-cache' })
        .then((r) => (r.ok ? r.json() : null))
        .then(parseManifest)
        .catch(() => null), // no snapshot deployed (dev server, first deploy): everything goes live
    };
  }
  return manifest.entries;
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
    if (snap && snapshotIsFresh(snap, now)) {
      if (storedCovers) return keep(stored);
      try {
        return await readSnapshot(true);
      } catch {
        /* snapshot file missing: go live */
      }
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
