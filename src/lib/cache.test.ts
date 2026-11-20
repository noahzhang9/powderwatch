import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SNAPSHOT_INTERVAL_H, SNAPSHOT_MAX_AGE_S, cachedJson, clearCache, parseManifest, snapshotIsFresh, type SnapshotEntry } from './cache';

const NOW = Date.parse('2026-11-19T22:30:00Z');
const NOW_S = NOW / 1000;
const A = 'https://api.open-meteo.com/v1/forecast?latitude=1&models=a';
const B = 'https://api.open-meteo.com/v1/forecast?latitude=2&models=b';
const FILE_A = '0123456789abcdef-0123456789.json';
const FILE_B = 'fedcba9876543210-9876543210.json';
const TTL = 30 * 60;

interface Site {
  manifest?: unknown;
  /** Snapshot files by name. */
  files?: Record<string, unknown>;
  /** Status for Open-Meteo requests (200 → `{ live: url }`). */
  liveStatus?: number;
}

let calls: { url: string; init?: RequestInit }[] = [];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function serve(site: Site) {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.startsWith('https://')) {
      const status = site.liveStatus ?? 200;
      return status === 200 ? json({ live: url }) : json({ error: true, reason: 'Too many concurrent requests' }, status);
    }
    if (url === '/data/fc/manifest.json') return site.manifest === undefined ? new Response('not found', { status: 404 }) : json(site.manifest);
    const file = url.replace('/data/fc/', '');
    return site.files && file in site.files ? json(site.files[file]) : new Response('not found', { status: 404 });
  });
}

const manifest = (entries: Record<string, SnapshotEntry>) => ({ version: 1, generatedAt: NOW_S - 600, entries });
const live = () => calls.filter((c) => c.url.startsWith('https://'));
const manifestLoads = () => calls.filter((c) => c.url.endsWith('manifest.json'));

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  await clearCache();
  calls = [];
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('snapshotIsFresh', () => {
  it('accepts copies younger than one refresh interval plus 30 minutes', () => {
    expect(SNAPSHOT_MAX_AGE_S).toBe((SNAPSHOT_INTERVAL_H + 0.5) * 3600);
    expect(snapshotIsFresh({ file: FILE_A, fetchedAt: NOW_S - SNAPSHOT_INTERVAL_H * 3600 }, NOW_S)).toBe(true);
    expect(snapshotIsFresh({ file: FILE_A, fetchedAt: NOW_S - SNAPSHOT_MAX_AGE_S + 1 }, NOW_S)).toBe(true);
    expect(snapshotIsFresh({ file: FILE_A, fetchedAt: NOW_S - SNAPSHOT_MAX_AGE_S }, NOW_S)).toBe(false);
  });
});

describe('parseManifest', () => {
  it('keeps well-formed entries and drops the rest', () => {
    const m = parseManifest(manifest({
      [A]: { file: FILE_A, fetchedAt: NOW_S },
      [B]: { file: '../../index.html', fetchedAt: NOW_S },
      'http://example.com/x': { file: FILE_B, fetchedAt: NOW_S },
      'https://api.open-meteo.com/v1/forecast?x': { file: FILE_B, fetchedAt: Number.NaN },
    }));
    expect([...m!.keys()]).toEqual([A]);
  });
  it('rejects other versions and non-objects', () => {
    expect(parseManifest({ version: 2, entries: {} })).toBeNull();
    expect(parseManifest('<!doctype html>')).toBeNull();
    expect(parseManifest(null)).toBeNull();
  });
});

describe('cachedJson with a forecast snapshot', () => {
  it('serves fresh snapshot copies without calling Open-Meteo, reading the manifest once', async () => {
    serve({
      manifest: manifest({ [A]: { file: FILE_A, fetchedAt: NOW_S - 2 * 3600 }, [B]: { file: FILE_B, fetchedAt: NOW_S - 600 } }),
      files: { [FILE_A]: { snap: 'a' }, [FILE_B]: { snap: 'b' } },
    });
    expect(await Promise.all([cachedJson(A, TTL), cachedJson(B, TTL, 'low')])).toEqual([{ snap: 'a' }, { snap: 'b' }]);
    // Older than the TTL but as new as the snapshot: kept in memory, not re-read.
    expect(await cachedJson(A, TTL)).toEqual({ snap: 'a' });
    expect(live()).toHaveLength(0);
    expect(manifestLoads()).toHaveLength(1);
    expect(manifestLoads()[0].init?.cache).toBe('no-cache');
    expect(calls.filter((c) => c.url.endsWith(FILE_A))).toHaveLength(1);
  });

  it('goes live when the entry is stale', async () => {
    serve({ manifest: manifest({ [A]: { file: FILE_A, fetchedAt: NOW_S - SNAPSHOT_MAX_AGE_S - 60 } }), files: { [FILE_A]: { snap: 'a' } } });
    expect(await cachedJson(A, TTL)).toEqual({ live: A });
    expect(live()).toHaveLength(1);
  });

  it('goes live when the entry is missing, the manifest is missing or not JSON', async () => {
    serve({ manifest: manifest({ [B]: { file: FILE_B, fetchedAt: NOW_S } }), files: { [FILE_B]: { snap: 'b' } } });
    expect(await cachedJson(A, TTL)).toEqual({ live: A });
    await clearCache();
    serve({});
    expect(await cachedJson(A, TTL)).toEqual({ live: A });
    await clearCache();
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) =>
      String(input).startsWith('https://') ? json({ live: String(input) }) : new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } }));
    expect(await cachedJson(A, TTL)).toEqual({ live: A });
  });

  it('goes live when a fresh entry points at a missing file', async () => {
    serve({ manifest: manifest({ [A]: { file: FILE_A, fetchedAt: NOW_S - 60 } }), files: {} });
    expect(await cachedJson(A, TTL)).toEqual({ live: A });
  });

  it('falls back to the stale snapshot copy when Open-Meteo rate-limits', async () => {
    serve({
      manifest: manifest({ [A]: { file: FILE_A, fetchedAt: NOW_S - 6 * 3600 } }),
      files: { [FILE_A]: { snap: 'old' } },
      liveStatus: 429,
    });
    const p = cachedJson(A, TTL);
    await vi.advanceTimersByTimeAsync(60_000); // the client's own retry backoff
    expect(await p).toEqual({ snap: 'old' });
    expect(live()).toHaveLength(3); // first try + two retries
  });

  it('still fails when there is no copy anywhere', async () => {
    serve({ liveStatus: 429 });
    const p = cachedJson(A, TTL).catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(String(await p)).toContain('429');
  });
});
