import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseStationFile } from './obs';

const OBS_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '../../public/data/obs');
const good = { id: 's1', updated: '2026-11-20T04:00:00Z', start: '2026-11-18', depthCm: [10, null, 12], sweMm: null, lastDepthDate: '2026-11-20', lastSweDate: null };

describe('parseStationFile', () => {
  it('accepts every committed station file', () => {
    const names = readdirSync(OBS_DIR).filter((n) => n.endsWith('.json'));
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) expect(parseStationFile(JSON.parse(readFileSync(join(OBS_DIR, n), 'utf-8')), n.slice(0, -5)), n).not.toBeNull();
  });

  it('fills absent optional series with null', () => {
    expect(parseStationFile(good, 's1')).toEqual({ ...good, newSnowCm: null });
  });

  it('rejects files that are not this station or not the right shape', () => {
    expect(parseStationFile(good, 's2')).toBeNull();
    expect(parseStationFile({ ...good, start: '18 Nov' }, 's1')).toBeNull();
    expect(parseStationFile({ ...good, depthCm: [1, '2'] }, 's1')).toBeNull();
    expect(parseStationFile({ ...good, sweMm: [1, 2] }, 's1')).toBeNull(); // length differs from depthCm
    expect(parseStationFile({ ...good, lastDepthDate: 5 }, 's1')).toBeNull();
    expect(parseStationFile(null, 's1')).toBeNull();
    expect(parseStationFile('<!doctype html>', 's1')).toBeNull();
  });
});

describe('loadStation', () => {
  let status = 503;
  let fetches = 0;
  beforeEach(() => {
    vi.resetModules();
    fetches = 0;
    vi.stubGlobal('fetch', async () => {
      fetches++;
      return status === 200
        ? new Response(JSON.stringify(good), { headers: { 'content-type': 'application/json' } })
        : new Response('error', { status });
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches again after a server error', async () => {
    const { loadStation } = await import('./obs');
    status = 503;
    expect(await loadStation('s1')).toBeNull();
    status = 200;
    expect((await loadStation('s1'))?.depthCm).toEqual(good.depthCm);
    expect(fetches).toBe(2);
  });

  it('remembers a missing file', async () => {
    const { loadStation } = await import('./obs');
    status = 404;
    expect(await loadStation('s1')).toBeNull();
    expect(await loadStation('s1')).toBeNull();
    expect(fetches).toBe(1);
  });
});
