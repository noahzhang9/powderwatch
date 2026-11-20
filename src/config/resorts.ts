/** Resorts, their elevation bands, and the forecast models that cover them. */

export type BandKey = 'base' | 'mid' | 'summit';

export interface Band {
  key: BandKey;
  label: string;
  /** Elevation used for downscaling and phase, m. */
  elevation: number;
  lat: number;
  lon: number;
  /** The label as it reads mid-sentence ("snowfall at mid"); defaults to the label in lower case. */
  inText?: string;
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
  /**
   * Inside NOAA's CONUS products (NBM, WPC winter probabilities): the Forecast tab offers
   * "Compare with official guidance".
   */
  officialGuidance?: boolean;
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
    officialGuidance: true,
    links: [
      { label: 'Mountain report', url: 'https://www.crystalmountainresort.com/the-mountain/mountain-report' },
      { label: 'Webcams', url: 'https://www.crystalmountainresort.com/the-mountain/mountain-report-and-webcams/webcams' },
      { label: 'NWAC avalanche forecast', url: 'https://nwac.us/forecasts/avalanche' },
      { label: 'NWAC weather stations', url: 'https://www.nwac.us/weather/stations/' },
      { label: 'NWS Seattle', url: 'https://www.weather.gov/sew/' },
    ],
  },
  {
    // The Summit at Snoqualmie: one resort, four base areas on one ticket. Alpental (north of I-90) is the upper band rather than its own
    // resort: it is 4 km from Summit Central, shares its stations and NWAC zone, and the global models can't
    // tell the two apart, so only elevation differs — which is what bands are for.
    id: 'snoqualmie',
    name: 'Snoqualmie / Alpental',
    short: 'Snoqualmie',
    region: 'Washington Cascades',
    tz: 'America/Los_Angeles',
    bands: [
      // Summit Central base area (bottom of Central Express); the operator publishes no base figure (USGS 3DEP).
      { key: 'base', label: 'Base', elevation: 896, lat: 47.4078, lon: -121.4123 },
      // Top of Summit Central, 3,865 ft (operator trail map); the upper end of Summit West/Central/East.
      { key: 'mid', label: 'Mid', elevation: 1178, lat: 47.4019, lon: -121.4248 },
      // Alpental Top Station, 5,420 ft (operator trail map).
      { key: 'summit', label: 'Alpental top', inText: 'Alpental top', elevation: 1652, lat: 47.4388, lon: -121.4428 },
    ],
    models: [...GLOBAL, 'ncep_hrrr_conus', 'gem_hrdps_continental'],
    officialGuidance: true,
    links: [
      { label: 'Mountain report', url: 'https://www.summitatsnoqualmie.com/mountain-report' },
      { label: 'Webcams', url: 'https://www.summitatsnoqualmie.com/webcams' },
      { label: 'NWAC avalanche forecast — Snoqualmie Pass', url: 'https://nwac.us/forecasts/avalanche/snoqualmie-pass' },
      { label: 'NWAC weather stations — Alpental', url: 'https://nwac.us/weather/stations/alpental' },
      { label: 'NWAC weather stations — Snoqualmie Pass', url: 'https://nwac.us/weather/stations/snoqualmie-pass' },
      { label: 'NWS Seattle', url: 'https://www.weather.gov/sew/' },
    ],
  },
  {
    id: 'stevens',
    name: 'Stevens Pass',
    short: 'Stevens',
    region: 'Washington Cascades',
    tz: 'America/Los_Angeles',
    bands: [
      // Base 4,061 ft and highest point 5,845 ft (Cowboy Mountain): operator's mountain stats.
      { key: 'base', label: 'Base', elevation: 1238, lat: 47.744, lon: -121.0925 },
      // Top of Hogsback Express (USGS 3DEP).
      { key: 'mid', label: 'Mid', elevation: 1480, lat: 47.736, lon: -121.0974 },
      { key: 'summit', label: 'Summit', elevation: 1782, lat: 47.7322, lon: -121.1022 },
    ],
    models: [...GLOBAL, 'ncep_hrrr_conus', 'gem_hrdps_continental'],
    officialGuidance: true,
    links: [
      { label: 'Snow & weather report', url: 'https://www.stevenspass.com/the-mountain/mountain-conditions/weather-report.aspx' },
      { label: 'Mountain cams', url: 'https://www.stevenspass.com/the-mountain/mountain-conditions/mountain-cams.aspx' },
      { label: 'NWAC avalanche forecast — Stevens Pass', url: 'https://nwac.us/forecasts/avalanche/stevens-pass' },
      { label: 'NWAC weather stations — Stevens Pass', url: 'https://nwac.us/weather/stations/stevens-ski-area' },
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

export const bandInText = (b: Pick<Band, 'label' | 'inText'>) => b.inText ?? b.label.toLowerCase();
