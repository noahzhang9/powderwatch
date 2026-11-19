/**
 * Fetch-through cache: in-memory map + IndexedDB, keyed by URL.
 * Past model runs are immutable and cached indefinitely; live forecasts use a TTL.
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
  const d = await db();
  if (!d) return;
  await new Promise<void>((resolve) => {
    const tx = d.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

// --- simple concurrency limiter ---
const MAX_CONCURRENT = 4;
let active = 0;
const queue: (() => void)[] = [];
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) await new Promise<void>((r) => queue.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    queue.shift()?.();
  }
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Fetch JSON with caching. `ttlSec = Infinity` caches forever. */
export async function cachedJson<T>(url: string, ttlSec: number): Promise<T> {
  const now = Date.now() / 1000;
  const m = mem.get(url);
  if (m && now - m.t < ttlSec) return m.data as T;
  const pending = inflight.get(url);
  if (pending) return pending as Promise<T>;

  const p = (async () => {
    const stored = await idbGet(url);
    if (stored && now - stored.t < ttlSec) {
      mem.set(url, stored);
      return stored.data as T;
    }
    const fetchFresh = withSlot(async () => {
      const res = await fetch(url);
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
    });
    let data: T;
    try {
      data = await fetchFresh;
    } catch (err) {
      // Offline or rate-limited: a stale copy beats an empty chart.
      if (stored) {
        mem.set(url, stored);
        return stored.data as T;
      }
      throw err;
    }
    const entry = { t: now, data };
    mem.set(url, entry);
    void idbPut(url, entry);
    return data;
  })();
  inflight.set(url, p);
  try {
    return await p;
  } finally {
    inflight.delete(url);
  }
}
