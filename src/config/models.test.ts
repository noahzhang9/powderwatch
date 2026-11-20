import { describe, expect, it } from 'vitest';
import { MODELS, centresOf, horizonText } from './models';
import { RESORTS } from './resorts';

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

describe('model catalogue', () => {
  it("never shows two of a resort's models in the same colour", () => {
    for (const r of RESORTS) expect(new Set(r.models.map((id) => MODELS[id].slot)).size).toBe(r.models.length);
  });

  it('names the forecast centres of the models the resorts show, and no others', () => {
    const shown = RESORTS.flatMap((r) => r.models);
    expect(centresOf(shown)).toEqual(['ECMWF', 'NOAA', 'ECCC', 'DWD', 'UK Met Office', 'MeteoSwiss']);
    expect(new Intl.ListFormat('en-GB').format(centresOf(shown))).toBe('ECMWF, NOAA, ECCC, DWD, UK Met Office and MeteoSwiss');
    // JMA joins the list only once a resort shows one of its models.
    expect(shown.some((id) => MODELS[id].family === 'JMA')).toBe(false);
    expect(centresOf([...shown, 'jma_gsm'])).toEqual(['ECMWF', 'NOAA', 'ECCC', 'DWD', 'UK Met Office', 'MeteoSwiss', 'JMA']);
  });

  it("gives JMA's models their published range, runs and grids", () => {
    expect(MODELS.jma_gsm).toMatchObject({ family: 'JMA', kind: 'global', horizonH: 264, historyRunsUtc: [0, 12], resolutionKm: 55, nativeFreezingLevel: false });
    expect(MODELS.jma_msm).toMatchObject({ family: 'JMA', kind: 'regional', horizonH: 78, historyRunsUtc: [0, 12], resolutionKm: 5, nativeFreezingLevel: false });
    // The site shows local times: no cycle names in what the model pill says.
    for (const m of [MODELS.jma_gsm, MODELS.jma_msm]) expect(m.blurb).not.toMatch(/\d\dZ\b|UTC/);
  });
});
