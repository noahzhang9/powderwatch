/**
 * Forecast model catalogue. Open-Meteo ids are the *pure* single-model ids —
 * not the "_seamless" blends, which silently splice in regional models
 * (e.g. gfs_seamless = HRRR for the first 48 h in North America) and would
 * double-count them in a blend.
 */

export type Family = 'ECMWF' | 'NOAA' | 'ECCC' | 'DWD' | 'UKMO' | 'MeteoSwiss';

export interface ModelDef {
  id: string;
  label: string;
  family: Family;
  /** Categorical colour slot 1–8 (fixed per model, never re-assigned by rank). */
  slot: number;
  kind: 'global' | 'regional';
  resolutionKm: number;
  /** Nominal forecast length, hours. */
  horizonH: number;
  /** Id under https://api.open-meteo.com/data/{metaId}/static/meta.json (run timing). */
  metaId: string;
  /** Model outputs its own freezing level (otherwise computed from pressure levels). */
  nativeFreezingLevel: boolean;
  /** Runs used for run-history comparisons (full-length cycles), UTC hours. */
  historyRunsUtc: number[];
  blurb: string;
}

export const MODELS: Record<string, ModelDef> = {
  ecmwf_ifs025: {
    id: 'ecmwf_ifs025', label: 'ECMWF IFS', family: 'ECMWF', slot: 1, kind: 'global', resolutionKm: 25, horizonH: 360,
    metaId: 'ecmwf_ifs025', nativeFreezingLevel: false, historyRunsUtc: [0, 12],
    blurb: 'European Centre flagship physics model (open-data 0.25°).',
  },
  gfs_global: {
    id: 'gfs_global', label: 'GFS', family: 'NOAA', slot: 2, kind: 'global', resolutionKm: 13, horizonH: 384,
    metaId: 'ncep_gfs013', nativeFreezingLevel: true, historyRunsUtc: [0, 12],
    blurb: 'NOAA Global Forecast System.',
  },
  gem_global: {
    id: 'gem_global', label: 'GEM', family: 'ECCC', slot: 3, kind: 'global', resolutionKm: 15, horizonH: 240,
    metaId: 'cmc_gem_gdps_15km', nativeFreezingLevel: false, historyRunsUtc: [0, 12],
    blurb: 'Environment Canada Global Deterministic Prediction System.',
  },
  icon_global: {
    id: 'icon_global', label: 'ICON', family: 'DWD', slot: 4, kind: 'global', resolutionKm: 13, horizonH: 180,
    metaId: 'dwd_icon', nativeFreezingLevel: true, historyRunsUtc: [0, 12],
    blurb: 'German Weather Service global model.',
  },
  ecmwf_aifs025_single: {
    id: 'ecmwf_aifs025_single', label: 'ECMWF AIFS', family: 'ECMWF', slot: 5, kind: 'global', resolutionKm: 25, horizonH: 360,
    metaId: 'ecmwf_aifs025_single', nativeFreezingLevel: false, historyRunsUtc: [0, 12],
    blurb: 'ECMWF machine-learning forecast model (deterministic).',
  },
  ukmo_global_deterministic_10km: {
    id: 'ukmo_global_deterministic_10km', label: 'UKMO', family: 'UKMO', slot: 6, kind: 'global', resolutionKm: 10, horizonH: 168,
    metaId: 'ukmo_global_deterministic_10km', nativeFreezingLevel: false, historyRunsUtc: [0, 12],
    blurb: 'UK Met Office Unified Model, global configuration.',
  },
  ncep_hrrr_conus: {
    id: 'ncep_hrrr_conus', label: 'HRRR', family: 'NOAA', slot: 7, kind: 'regional', resolutionKm: 3, horizonH: 48,
    metaId: 'ncep_hrrr_conus', nativeFreezingLevel: true, historyRunsUtc: [0, 6, 12, 18],
    blurb: 'NOAA 3 km convection-allowing model, updated hourly; four runs a day reach 48 h, the others 18 h.',
  },
  gem_hrdps_continental: {
    id: 'gem_hrdps_continental', label: 'HRDPS', family: 'ECCC', slot: 8, kind: 'regional', resolutionKm: 2.5, horizonH: 48,
    metaId: 'cmc_gem_hrdps', nativeFreezingLevel: false, historyRunsUtc: [0, 6, 12, 18],
    blurb: 'Environment Canada 2.5 km High Resolution Deterministic Prediction System.',
  },
  meteoswiss_icon_ch1: {
    id: 'meteoswiss_icon_ch1', label: 'ICON-CH1', family: 'MeteoSwiss', slot: 7, kind: 'regional', resolutionKm: 1, horizonH: 33,
    metaId: 'meteoswiss_icon_ch1', nativeFreezingLevel: true, historyRunsUtc: [0, 3, 6, 9, 12, 15, 18, 21],
    blurb: 'MeteoSwiss 1 km Alpine model.',
  },
  meteoswiss_icon_ch2: {
    id: 'meteoswiss_icon_ch2', label: 'ICON-CH2', family: 'MeteoSwiss', slot: 8, kind: 'regional', resolutionKm: 2, horizonH: 120,
    metaId: 'meteoswiss_icon_ch2', nativeFreezingLevel: true, historyRunsUtc: [0, 6, 12, 18],
    blurb: 'MeteoSwiss 2 km Alpine model, 5-day range.',
  },
};

export interface EnsembleDef {
  id: string;
  label: string;
  family: Family;
  slot: number;
  members: number;
  horizonH: number;
  metaId: string;
}

/** Ensembles via the Open-Meteo ensemble API (control + perturbed members). */
/** A forecast range as the UI shows it: '48 h' up to three days, whole days beyond ('5 d'). */
export const horizonText = (h: number) => (h < 72 ? `${h} h` : `${Math.round(h / 24)} d`);

export const ENSEMBLES: EnsembleDef[] = [
  { id: 'ecmwf_ifs025', label: 'ECMWF ENS', family: 'ECMWF', slot: 1, members: 51, horizonH: 360, metaId: 'ecmwf_ifs025_ensemble' },
  { id: 'ecmwf_aifs025', label: 'AIFS ENS', family: 'ECMWF', slot: 5, members: 51, horizonH: 360, metaId: 'ecmwf_aifs025_ensemble' },
  { id: 'ncep_gefs_seamless', label: 'GEFS', family: 'NOAA', slot: 2, members: 31, horizonH: 384, metaId: 'ncep_gefs025' },
  { id: 'gem_global', label: 'GEPS', family: 'ECCC', slot: 3, members: 21, horizonH: 384, metaId: 'cmc_gem_geps' },
  { id: 'icon_global', label: 'ICON-EPS', family: 'DWD', slot: 4, members: 40, horizonH: 180, metaId: 'dwd_icon_eps' },
  { id: 'ukmo_global_ensemble_20km', label: 'MOGREPS-G', family: 'UKMO', slot: 6, members: 18, horizonH: 240, metaId: 'ukmo_global_ensemble_20km' },
];

/** Models offered in run-history comparisons (all global; regional runs are too short). */
export const HISTORY_MODELS = ['ecmwf_ifs025', 'gfs_global', 'gem_global', 'icon_global', 'ecmwf_aifs025_single'];

/**
 * Benchmarks: an official provider's own finished product, shown only for comparison behind the Storm
 * tracker's "Compare with official guidance" toggle. Never in MODELS, never in the blend, and (the one
 * exception to "one physics for all models") its own snowfall field is what's shown. See AGENTS.md.
 */
export interface BenchmarkDef {
  id: string;
  label: string;
  long: string;
  metaId: string;
  /** Days requested (its range). */
  forecastDays: number;
  resolutionKm: number;
  blurb: string;
}

/** NOAA's National Blend of Models (CONUS), via Open-Meteo: its own calibrated snowfall (ASNOW). */
export const NBM: BenchmarkDef = {
  id: 'ncep_nbm_conus', label: 'NOAA NBM', long: 'NOAA National Blend of Models', metaId: 'ncep_nbm_conus',
  // NBM runs 264 h (11 days). 12 days from local midnight still cover a 12Z cycle's day 10 (its day 1 is
  // tomorrow) for the verification archive, at the same weighted cost (1).
  forecastDays: 12, resolutionKm: 2.5,
  blurb: "NOAA's calibrated blend of many models, updated hourly. Shown with its own snowfall on its 2.5 km grid, not adjusted to the band's elevation.",
};
