import { describe, expect, it } from 'vitest';
import { cumulative, exceedance, familyWeights, quantile, rangeAcross, weightedMean, weightedQuantile } from './stats';

describe('stats', () => {
  it('quantile matches linear interpolation', () => {
    expect(quantile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([10, 0], 0)).toBe(0);
    expect(quantile([10, 0], 1)).toBe(10);
  });
  it('weighted quantile respects weights', () => {
    expect(weightedQuantile([0, 10], [3, 1], 0.5)!).toBeLessThan(5);
  });
  it('family weights give each family equal total weight', () => {
    const w = familyWeights(['A', 'A', 'B'], [true, true, true]);
    expect(w).toEqual([0.25, 0.25, 0.5]);
    const w2 = familyWeights(['A', 'A', 'B'], [true, false, true]);
    expect(w2).toEqual([0.5, 0, 0.5]);
  });
  it('weighted mean and exceedance', () => {
    expect(weightedMean([2, 4, null], [1, 1, 1])).toBe(3);
    expect(exceedance([5, 25, 30], [1, 1, 2], 20)).toBe(0.75);
  });
  it('cumulative stops at end of data', () => {
    expect(cumulative([1, null, 2, null])).toEqual([1, 1, 3, null]);
  });
  it('range across series skips gaps and needs two values by default', () => {
    const r = rangeAcross([[1, -4, null, 5], [3, 2, 7], [2, null, null, NaN]]);
    expect(r.lo).toEqual([1, -4, null, null]);
    expect(r.hi).toEqual([3, 2, null, null]);
    expect(r.n).toEqual([3, 2, 1, 1]);
    expect(rangeAcross([[4, null]], 1)).toEqual({ lo: [4, null], hi: [4, null], n: [1, 0] });
    expect(rangeAcross([])).toEqual({ lo: [], hi: [], n: [] });
  });
});
