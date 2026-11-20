import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The database connection is module state, so each test imports a fresh copy of the cache.
const A = 'https://api.open-meteo.com/v1/forecast?latitude=1&models=a';
const TTL = 30 * 60;

/** A fake IndexedDB whose `open` and `transaction` behave as given. */
function fakeIndexedDb(opts: { open?: () => never; transaction?: () => never }) {
  const stats = { opens: 0 };
  const indexedDB = {
    open() {
      stats.opens++;
      if (opts.open) opts.open();
      const req: { result?: unknown; onsuccess?: () => void } = {};
      const conn = { transaction: opts.transaction, close() {} };
      void Promise.resolve().then(() => {
        req.result = conn;
        req.onsuccess?.();
      });
      return req;
    },
  };
  vi.stubGlobal('indexedDB', indexedDB);
  return stats;
}

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('https://')) return new Response(JSON.stringify({ live: url }), { status: 200 });
    return new Response('not found', { status: 404 }); // no snapshot deployed
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('cachedJson when IndexedDB fails', () => {
  it('goes live when opening the database throws (storage blocked)', async () => {
    fakeIndexedDb({ open: () => { throw new DOMException('blocked', 'SecurityError'); } });
    const { cachedJson } = await import('./cache');
    await expect(cachedJson(A, TTL)).resolves.toEqual({ live: A });
  });

  it('goes live when the connection has been closed, and reopens it on next use', async () => {
    const stats = fakeIndexedDb({ transaction: () => { throw new DOMException('closed', 'InvalidStateError'); } });
    const { cachedJson } = await import('./cache');
    await expect(cachedJson(A, TTL)).resolves.toEqual({ live: A });
    expect(stats.opens).toBeGreaterThan(1);
  });
});
