/**
 * Precipitation-phase, snow-ratio and freezing-level physics.
 *
 * Every model is run through the same functions, so differences between
 * models come from their forcing (precipitation, temperature, humidity),
 * not from each provider's own snowfall post-processing.
 */

/** Wet-bulb temperature (°C) from air temperature (°C) and RH (%) — Stull (2011). */
export function wetBulb(tC: number, rhPct: number): number {
  const rh = Math.min(99, Math.max(5, rhPct));
  return (
    tC * Math.atan(0.151977 * Math.sqrt(rh + 8.313659)) +
    Math.atan(tC + rh) -
    Math.atan(rh - 1.676331) +
    0.00391838 * Math.pow(rh, 1.5) * Math.atan(0.023101 * rh) -
    4.686035
  );
}

/** Wet-bulb temperature at which precipitation is 50 % snow / 50 % rain. */
export const PHASE_TW_MID = 1.0;
/** Half-width of the linear rain/snow transition, in °C of wet-bulb. */
export const PHASE_TW_HALF_WIDTH = 1.0;

/** Fraction of precipitation falling as snow (0..1) for a given wet-bulb temperature. */
export function snowFraction(twC: number): number {
  const lo = PHASE_TW_MID - PHASE_TW_HALF_WIDTH; // all snow at or below
  const hi = PHASE_TW_MID + PHASE_TW_HALF_WIDTH; // all rain at or above
  if (twC <= lo) return 1;
  if (twC >= hi) return 0;
  return (hi - twC) / (hi - lo);
}

/**
 * Fresh-snow density (kg/m³) from air temperature — Hedstrom & Pomeroy (1998)
 * for T ≤ 0 °C, linearly extended to wetter snow above freezing (capped).
 */
export function freshSnowDensity(tC: number): number {
  if (tC <= 0) return 67.92 + 51.25 * Math.exp(tC / 2.59);
  return Math.min(200, 119.17 + 30 * tC);
}

/** Snow-to-liquid ratio implied by the fresh-snow density (≈8 at 0 °C, ≈14 at −10 °C). */
export function snowToLiquidRatio(tC: number): number {
  return 1000 / freshSnowDensity(tC);
}

export interface PhaseSplit {
  /** Snow water equivalent, mm. */
  snowWaterMm: number;
  /** Rain, mm. */
  rainMm: number;
  /** New snow depth, cm. */
  snowCm: number;
}

/** Split one hour of liquid-equivalent precipitation into snow and rain. */
/**
 * Hourly precipitation as the physics counts it: below zero (an artefact of some models'
 * de-accumulated output) is none, as in splitPrecip, so no total, blend or day is ever lowered by it.
 */
export const nonNegativePrecip = (s: readonly (number | null)[]): (number | null)[] => s.map((v) => (v == null ? null : Math.max(0, v)));

export function splitPrecip(precipMm: number, tC: number, rhPct: number): PhaseSplit {
  if (!(precipMm > 0)) return { snowWaterMm: 0, rainMm: 0, snowCm: 0 };
  const frac = snowFraction(wetBulb(tC, rhPct));
  const snowWaterMm = precipMm * frac;
  return {
    snowWaterMm,
    rainMm: precipMm - snowWaterMm,
    snowCm: (snowWaterMm * snowToLiquidRatio(tC)) / 10,
  };
}

export interface ProfileLevel {
  /** Geopotential height, m. */
  z: number;
  /** Temperature, °C. */
  t: number;
  /** Relative humidity, % (optional). */
  rh?: number | null;
}

/**
 * Height (m) where `value(level)` crosses `threshold`, scanning from the top
 * of the profile downward — i.e. the top of any warm layer. Returns the lowest
 * level height when the whole profile is colder than the threshold, and null
 * when the profile is empty or entirely warmer.
 */
function crossingHeight(levels: ProfileLevel[], value: (l: ProfileLevel) => number | null, threshold: number): number | null {
  const pts = levels
    .map((l) => ({ z: l.z, v: value(l) }))
    .filter((p): p is { z: number; v: number } => Number.isFinite(p.z) && p.v != null && Number.isFinite(p.v))
    .sort((a, b) => b.z - a.z); // top → bottom
  if (pts.length === 0) return null;
  for (let i = 0; i + 1 < pts.length; i++) {
    const upper = pts[i];
    const lower = pts[i + 1];
    if (upper.v <= threshold && lower.v > threshold) {
      const f = (threshold - lower.v) / (upper.v - lower.v);
      return lower.z + f * (upper.z - lower.z);
    }
  }
  if (pts[pts.length - 1].v <= threshold) return pts[pts.length - 1].z; // frozen to the lowest level
  return null; // warmer than threshold everywhere (above the profile top)
}

/** Freezing level (0 °C height), m. */
export function freezingLevel(levels: ProfileLevel[]): number | null {
  return crossingHeight(levels, (l) => l.t, 0);
}

/** Typical depth of the melting layer when only a freezing level is known, m. */
export const SNOW_LEVEL_OFFSET_M = 300;

/**
 * Snow level (m): the height where precipitation becomes mostly snow, taken
 * as the wet-bulb = PHASE_TW_MID crossing so it agrees with `snowFraction`.
 * Falls back to freezing level − SNOW_LEVEL_OFFSET_M when humidity is missing.
 */
export function snowLevel(levels: ProfileLevel[]): number | null {
  const haveRh = levels.some((l) => l.rh != null);
  if (haveRh) {
    return crossingHeight(levels, (l) => (l.rh == null ? null : wetBulb(l.t, l.rh)), PHASE_TW_MID);
  }
  const fzl = freezingLevel(levels);
  return fzl == null ? null : fzl - SNOW_LEVEL_OFFSET_M;
}

/** Snow level from a freezing level alone (ensembles, models without RH aloft). */
export function snowLevelFromFreezingLevel(fzl: number | null | undefined): number | null {
  return fzl == null ? null : fzl - SNOW_LEVEL_OFFSET_M;
}
