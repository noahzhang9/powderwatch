import { afterEach, describe, expect, it, vi } from 'vitest';
import { storageGet, storageRemove, storageSet } from './storage';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('storage', () => {
  it('reads, writes and removes', () => {
    const items = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => items.get(k) ?? null,
      setItem: (k: string, v: string) => void items.set(k, v),
      removeItem: (k: string) => void items.delete(k),
    });
    storageSet('pw-units', 'metric');
    expect(storageGet('pw-units')).toBe('metric');
    storageRemove('pw-units');
    expect(storageGet('pw-units')).toBeNull();
  });

  it('never throws when the browser blocks storage or the quota is full', () => {
    const blocked = () => { throw new DOMException('blocked', 'SecurityError'); };
    vi.stubGlobal('localStorage', { getItem: blocked, setItem: () => { throw new DOMException('full', 'QuotaExceededError'); }, removeItem: blocked });
    expect(storageGet('pw-units')).toBeNull();
    expect(() => storageSet('pw-units', 'metric')).not.toThrow();
    expect(() => storageRemove('pw-trips')).not.toThrow();
  });
});
