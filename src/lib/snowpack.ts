/**
 * Transparent layered snowpack model (hourly step).
 *
 * State is a stack of layers, each with snow water equivalent (SWE, mm) and
 * density (kg/m³). Depth is derived: depth_cm = Σ SWE / density × 100.
 *
 *  - New snow: SWE from the phase split, density from Hedstrom–Pomeroy, so the
 *    snowfall shown on forecast charts and the snow added here agree.
 *  - Settling: each layer's density relaxes exponentially toward a maximum
 *    (higher when wet, and higher under overburden), faster when warm.
 *  - Melt: temperature-index (degree-day) melt from the top, with a
 *    season-dependent factor, plus rain-on-snow sensible-heat melt.
 *  - Rain: drains through the pack (no SWE gain) but wets it, which speeds
 *    settling toward wet-snow density.
 *
 * Deliberately simple and fully inspectable; parameters are exported so they
 * can be calibrated against station depth/SWE records.
 */
import { freshSnowDensity, splitPrecip } from './physics';

export interface SnowpackParams {
  /** e-folding time for settling at 0 °C, hours. */
  settleTauH: number;
  /** Extra settling time per °C below 0 (colder snow settles more slowly), hours. */
  settleTauPerDegC: number;
  /** Maximum density reached by dry settling, kg/m³. */
  rhoMaxDry: number;
  /** Maximum density for wet/rained-on snow, kg/m³. */
  rhoMaxWet: number;
  /** Additional maximum density per mm of SWE above a layer, kg/m³. */
  overburdenPerMm: number;
  /** Hard cap on density, kg/m³. */
  rhoCap: number;
  /** Air temperature above which melt starts, °C. */
  meltThresholdC: number;
  /** Degree-day factor by month (index 0 = Jan), mm SWE per °C per day. */
  ddfByMonth: number[];
  /** Hours a layer stays "wet" after rain or above-freezing air. */
  wetHours: number;
}

/**
 * Settling parameters calibrated by scripts/backtest-snowpack.ts on three
 * Cascade SNOTEL stations (10-day depth change, observation-forced; fit on
 * even seasons 2016–2024, held-out odd seasons RMSE 17.7 cm vs 18.7 cm for
 * the uncalibrated set and 39.8 cm for persistence). Not yet validated for
 * BC or Alpine stations.
 */
export const DEFAULT_PARAMS: SnowpackParams = {
  settleTauH: 80,
  settleTauPerDegC: 12,
  rhoMaxDry: 340,
  rhoMaxWet: 380,
  overburdenPerMm: 0.4,
  rhoCap: 550,
  meltThresholdC: 0,
  ddfByMonth: [2.5, 3.0, 3.5, 4.5, 5.5, 6.0, 6.0, 6.0, 5.0, 3.5, 2.5, 2.0],
  wetHours: 24,
};

interface Layer {
  swe: number;
  rho: number;
  ageH: number;
  wetH: number;
}

export interface ForcingHour {
  /** Unix seconds (UTC). */
  time: number;
  /** Liquid-equivalent precipitation, mm. */
  precipMm: number | null;
  tC: number | null;
  rhPct: number | null;
  /**
   * Observation-forced mode (calibration): when set, these replace the
   * phase split and the degree-day melt for this hour.
   */
  snowWaterMm?: number;
  meltOverrideMm?: number;
}

export interface SnowpackPoint {
  time: number;
  depthCm: number;
  sweMm: number;
  newSnowCm: number;
  meltMm: number;
}

export interface InitialState {
  depthCm: number;
  /** SWE if measured (e.g. SNOTEL pillow); otherwise estimated from a seasonal bulk density. */
  sweMm?: number | null;
  /** Month (0–11) of the initial observation, used for the bulk-density guess. */
  month: number;
}

/** Bulk density guess (kg/m³) for an existing pack when SWE is not measured. */
export function seasonalBulkDensity(month: number): number {
  // Oct..Jun climatological progression for maritime/transitional packs.
  const byMonth = [300, 320, 340, 380, 420, 450, 450, 450, 450, 220, 250, 280];
  return byMonth[month] ?? 300;
}

const MAX_LAYERS = 48;

export function initialLayers(init: InitialState): Layer[] {
  if (!(init.depthCm > 0)) return [];
  const rho =
    init.sweMm != null && init.sweMm > 0
      ? Math.min(550, Math.max(100, (init.sweMm / init.depthCm) * 100))
      : seasonalBulkDensity(init.month);
  return [{ swe: (init.depthCm / 100) * rho, rho, ageH: 24 * 30, wetH: 0 }];
}

const depthOf = (layers: Layer[]) => layers.reduce((s, l) => s + (l.swe / l.rho) * 100, 0);
const sweOf = (layers: Layer[]) => layers.reduce((s, l) => s + l.swe, 0);

/** Run the model forward from an initial state over hourly forcing. */
export function runSnowpack(
  init: InitialState,
  forcing: ForcingHour[],
  params: SnowpackParams = DEFAULT_PARAMS,
): SnowpackPoint[] {
  let layers = initialLayers(init); // index 0 = top
  const out: SnowpackPoint[] = [];
  for (const h of forcing) {
    if (h.precipMm == null || h.tC == null) break; // forcing ended
    const t = h.tC;
    const rh = h.rhPct ?? 90;
    const month = new Date(h.time * 1000).getUTCMonth();
    const split = h.snowWaterMm != null
      ? { snowWaterMm: h.snowWaterMm, rainMm: 0, snowCm: (h.snowWaterMm / freshSnowDensity(t)) * 100 }
      : splitPrecip(h.precipMm, t, rh);

    // 1. New snow joins the top layer while it is < 24 h old, else starts a new layer.
    if (split.snowWaterMm > 0) {
      const rhoNew = freshSnowDensity(t);
      const top = layers[0];
      if (top && top.ageH < 24) {
        const vol = top.swe / top.rho + split.snowWaterMm / rhoNew;
        top.swe += split.snowWaterMm;
        top.rho = top.swe / vol;
      } else {
        layers.unshift({ swe: split.snowWaterMm, rho: rhoNew, ageH: 0, wetH: 0 });
      }
    }

    // 2. Melt from the top: degree-day + rain-on-snow sensible heat.
    let melt = 0;
    if (layers.length) {
      const ddf = params.ddfByMonth[month] ?? 3;
      melt = h.meltOverrideMm ?? (ddf / 24) * Math.max(0, t - params.meltThresholdC);
      if (h.meltOverrideMm == null && split.rainMm > 0 && t > 0) melt += (split.rainMm * t) / 80;
      let remaining = melt;
      while (remaining > 0 && layers.length) {
        const top = layers[0];
        if (top.swe > remaining) {
          top.swe -= remaining;
          remaining = 0;
        } else {
          remaining -= top.swe;
          layers.shift();
        }
      }
      melt -= remaining; // can't melt more than exists
    }

    // 3. Wetting and settling.
    const wetNow = split.rainMm > 0.1 || t > 0.5;
    let overburden = 0;
    for (const l of layers) {
      if (wetNow) l.wetH = params.wetHours;
      const wet = l.wetH > 0;
      const rhoMax = Math.min(
        params.rhoCap,
        Math.max(l.rho, (wet ? params.rhoMaxWet : params.rhoMaxDry) + params.overburdenPerMm * overburden),
      );
      const tau = params.settleTauH + params.settleTauPerDegC * Math.max(0, -t);
      l.rho = rhoMax + (l.rho - rhoMax) * Math.exp(-1 / tau);
      l.ageH += 1;
      if (l.wetH > 0) l.wetH -= 1;
      overburden += l.swe;
    }

    // 4. Keep the stack bounded by merging the two deepest layers.
    while (layers.length > MAX_LAYERS) {
      const a = layers[layers.length - 2];
      const b = layers[layers.length - 1];
      const vol = a.swe / a.rho + b.swe / b.rho;
      a.swe += b.swe;
      a.rho = a.swe / vol;
      a.ageH = Math.max(a.ageH, b.ageH);
      layers = layers.slice(0, -1);
    }

    out.push({ time: h.time, depthCm: depthOf(layers), sweMm: sweOf(layers), newSnowCm: split.snowCm, meltMm: melt });
  }
  return out;
}
