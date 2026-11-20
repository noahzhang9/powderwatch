import { describe, expect, it } from 'vitest';
import { MODELS, horizonText } from './models';

describe('horizonText', () => {
  it('shows hours up to three days and whole days beyond', () => {
    expect(horizonText(33)).toBe('33 h');
    expect(horizonText(48)).toBe('48 h');
    expect(horizonText(120)).toBe('5 d');
    expect(horizonText(384)).toBe('16 d');
  });

  it('gives every regional model a range shorter than the global models', () => {
    const regional = Object.values(MODELS).filter((m) => m.kind === 'regional');
    expect(regional.length).toBeGreaterThan(0);
    const shortestGlobal = Math.min(...Object.values(MODELS).filter((m) => m.kind === 'global').map((m) => m.horizonH));
    for (const m of regional) expect(m.horizonH).toBeLessThan(shortestGlobal);
  });
});
