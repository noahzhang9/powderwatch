import { describe, expect, it } from 'vitest';
import { sameDeps, visibleResult, type StoredResult } from './useAsync';

const stored = (over: Partial<StoredResult<string>> = {}): StoredResult<string> => ({
  deps: ['crystal', 'mid'], data: 'mid data', error: undefined, loading: false, ...over,
});

describe('sameDeps', () => {
  it('compares element by element, as React does', () => {
    expect(sameDeps(['a', 1, true], ['a', 1, true])).toBe(true);
    expect(sameDeps([NaN], [NaN])).toBe(true);
    expect(sameDeps(['a', 1], ['a', 2])).toBe(false);
    expect(sameDeps(['a'], ['a', undefined])).toBe(false);
    expect(sameDeps([{}], [{}])).toBe(false);
    expect(sameDeps(null, [])).toBe(false);
  });
});

describe('visibleResult', () => {
  it('returns the data loaded for the current deps', () => {
    expect(visibleResult(stored(), ['crystal', 'mid'], true)).toEqual({ data: 'mid data', error: undefined, loading: false });
  });

  it('keeps the data while a retry for the same deps reloads', () => {
    expect(visibleResult(stored({ loading: true }), ['crystal', 'mid'], true)).toEqual({ data: 'mid data', error: undefined, loading: true });
  });

  it('never shows data loaded for other deps, and reports loading until the new result arrives', () => {
    expect(visibleResult(stored(), ['crystal', 'summit'], true)).toEqual({ data: undefined, error: undefined, loading: true });
    expect(visibleResult(stored({ loading: true }), ['stevens', 'mid'], true)).toEqual({ data: undefined, error: undefined, loading: true });
  });

  it("hides another key's error as well as its data", () => {
    const failed = stored({ data: undefined, error: new Error('HTTP 429') });
    expect(visibleResult(failed, ['crystal', 'mid'], true).error?.message).toBe('HTTP 429');
    expect(visibleResult(failed, ['crystal', 'summit'], true).error).toBeUndefined();
  });

  it('is not loading when disabled before any result', () => {
    expect(visibleResult(stored({ deps: null, data: undefined }), ['crystal', 'mid'], false)).toEqual({ data: undefined, error: undefined, loading: false });
  });
});
