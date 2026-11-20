import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recordVisit, sinceLastVisit } from './visits';

const K = 'crystal:mid:72';
const T0 = 1_790_000_000;
let items: Map<string, string>;

beforeEach(() => {
  items = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, v),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('since your last visit', () => {
  it('shows nothing on the first visit, nor on re-renders within it', () => {
    expect(sinceLastVisit(K, 20, T0)).toBeNull();
    recordVisit(K, 20, T0);
    expect(sinceLastVisit(K, 22, T0 + 600)).toBeNull();
  });

  it('compares with the previous visit, and stays the same across re-renders of this one', () => {
    recordVisit(K, 20, T0);
    const later = T0 + 3 * 3600;
    expect(sinceLastVisit(K, 25, later)).toEqual({ delta: 5, sinceS: 3 * 3600 });
    recordVisit(K, 25, later);
    expect(sinceLastVisit(K, 26, later + 60)).toEqual({ delta: 6, sinceS: 3 * 3600 + 60 });
  });

  it('reading never writes', () => {
    recordVisit(K, 20, T0);
    const before = items.get('pw-seen:' + K);
    sinceLastVisit(K, 30, T0 + 7200);
    expect(items.get('pw-seen:' + K)).toBe(before);
  });

  it('ignores malformed stored values', () => {
    items.set('pw-seen:' + K, JSON.stringify({ cur: { t: T0, v: 20 }, prev: { t: 'x', v: 1 } }));
    expect(sinceLastVisit(K, 25, T0 + 600)).toBeNull();
    items.set('pw-seen:' + K, '{not json');
    expect(sinceLastVisit(K, 25, T0 + 600)).toBeNull();
  });

  it('copes with storage that throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new DOMException('blocked', 'SecurityError'); },
      setItem: () => { throw new DOMException('full', 'QuotaExceededError'); },
    });
    expect(() => recordVisit(K, 20, T0)).not.toThrow();
    expect(sinceLastVisit(K, 20, T0 + 7200)).toBeNull();
  });
});
