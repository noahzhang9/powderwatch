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

/** Fetch JSON with caching. `ttlSec = Infinity` caches forever. */
export async function cachedJson<T>(url: string, ttlSec: number, priority: Priority = 'high'): Promise<T> {
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
    const fetchFresh = withSlot(priority, async () => {
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
