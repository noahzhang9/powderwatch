/** Resorts, their elevation bands, and the forecast models that cover them. */

export type BandKey = 'base' | 'mid' | 'summit';

export interface Band {
  key: BandKey;
  label: string;
  /** Elevation used for downscaling and phase, m. */
  elevation: number;
  lat: number;
  lon: number;
}

export interface Link {
  label: string;
  url: string;
}

export interface Resort {
  id: string;
  name: string;
  short: string;
  region: string;
  tz: string;
  bands: Band[];
  /** Deterministic models (global + the regional high-res models that cover it). */
  models: string[];
  links: Link[];
}

const GLOBAL = ['ecmwf_ifs025', 'gfs_global', 'gem_global', 'icon_global', 'ecmwf_aifs025_single', 'ukmo_global_deterministic_10km'];

export const RESORTS: Resort[] = [
  {
    id: 'crystal',
    name: 'Crystal Mountain',
    short: 'Crystal',
    region: 'Washington Cascades',
    tz: 'America/Los_Angeles',
    bands: [
      { key: 'base', label: 'Base', elevation: 1340, lat: 46.9353, lon: -121.4747 },
      { key: 'mid', label: 'Mid', elevation: 1740, lat: 46.931, lon: -121.49 },
      { key: 'summit', label: 'Summit', elevation: 2100, lat: 46.9283, lon: -121.504 },
    ],
    models: [...GLOBAL, 'ncep_hrrr_conus', 'gem_hrdps_continental'],
    links: [
      { label: 'Mountain report', url: 'https://www.crystalmountainresort.com/the-mountain/mountain-report' },
      { label: 'Webcams', url: 'https://www.crystalmountainresort.com/the-mountain/mountain-report-and-webcams/webcams' },
      { label: 'NWAC avalanche forecast', url: 'https://nwac.us/forecasts/avalanche' },
      { label: 'NWAC weather stations', url: 'https://www.nwac.us/weather/stations/' },
      { label: 'NWS Seattle', url: 'https://www.weather.gov/sew/' },
    ],
  },
  {
    id: 'whistler',
    name: 'Whistler Blackcomb',
    short: 'Whistler',
    region: 'BC Coast Mountains',
    tz: 'America/Vancouver',
    bands: [
      { key: 'base', label: 'Base', elevation: 675, lat: 50.115, lon: -122.948 },
      { key: 'mid', label: 'Mid', elevation: 1500, lat: 50.08, lon: -122.95 },
      { key: 'summit', label: 'Alpine', elevation: 2100, lat: 50.06, lon: -122.949 },
    ],
    models: [...GLOBAL, 'ncep_hrrr_conus', 'gem_hrdps_continental'],
    links: [
      { label: 'Snow & weather report', url: 'https://www.whistlerblackcomb.com/the-mountain/mountain-conditions/snow-and-weather-report.aspx' },
      { label: 'Mountain cams', url: 'https://www.whistlerblackcomb.com/the-mountain/mountain-conditions/mountain-cams.aspx' },
      { label: 'Avalanche Canada — Sea to Sky', url: 'https://avalanche.ca/forecasts/sea-to-sky' },
    ],
  },
  {
    id: 'verbier',
    name: 'Verbier / 4 Vallées',
    short: 'Verbier',
    region: 'Valais Alps',
    tz: 'Europe/Zurich',
    bands: [
      { key: 'base', label: 'Village', elevation: 1500, lat: 46.0965, lon: 7.2286 },
      { key: 'mid', label: 'Mid', elevation: 2200, lat: 46.088, lon: 7.248 },
      { key: 'summit', label: 'Upper', elevation: 2900, lat: 46.0835, lon: 7.2985 },
    ],
    models: [...GLOBAL, 'meteoswiss_icon_ch1', 'meteoswiss_icon_ch2'],
    links: [
      { label: 'Weather & snow', url: 'https://www.verbier4vallees.ch/en/useful-information/weather' },
      { label: 'Webcams', url: 'https://www.verbier4vallees.ch/en/useful-information/webcams' },
      { label: 'Lift status', url: 'https://www.verbier4vallees.ch/en/useful-information/live-information-winter' },
      { label: 'SLF avalanche bulletin', url: 'https://www.slf.ch/en/avalanche-bulletin-and-snow-situation/' },
      { label: 'MeteoSwiss', url: 'https://www.meteoswiss.admin.ch/' },
    ],
  },
];

export const resortById = (id: string) => RESORTS.find((r) => r.id === id);
