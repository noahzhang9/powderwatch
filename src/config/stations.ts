/**
 * Snow-depth observation stations. These are measurement sites near each
 * resort, NOT resort-reported base depths — the UI always labels them as such.
 * Order within a resort is the preference order for the dashboard headline
 * (first station that reported in the last few days wins).
 */

export type StationSource = 'SNOTEL' | 'ECCC' | 'BC-ASWS' | 'SLF' | 'MeteoSwiss';

export interface StationDef {
  id: string;
  resortId: string;
  name: string;
  source: StationSource;
  sourceId: string;
  lat: number;
  lon: number;
  elevation: number;
  /** Measures snow water equivalent as well as depth. */
  swe: boolean;
  url: string;
  attribution: string;
  /** How the source defines a "daily" value. */
  dailyNote: string;
  caveat?: string;
}

const SNOTEL_ATTR = 'USDA NRCS National Water and Climate Center (SNOTEL)';
const ECCC_ATTR = 'Data Source: Environment and Climate Change Canada (ECCC Data Servers End-use Licence)';
const BC_ATTR = 'BC River Forecast Centre ASWS — contains information licensed under the Open Government Licence – British Columbia';
const SLF_ATTR = 'WSL Institute for Snow and Avalanche Research SLF (CC BY 4.0)';
const MS_ATTR = 'Source: MeteoSwiss (CC BY 4.0)';

export const STATIONS: StationDef[] = [
  // --- Crystal Mountain ---
  {
    id: 'snotel-642', resortId: 'crystal', name: 'Morse Lake', source: 'SNOTEL', sourceId: '642:WA:SNTL',
    lat: 46.9059, lon: -121.4827, elevation: 1646, swe: true,
    url: 'https://wcc.sc.egov.usda.gov/nwcc/site?sitenum=642', attribution: SNOTEL_ATTR,
    dailyNote: 'Midnight (PST) reading; depth since 2005, SWE since 1978.',
  },
  {
    id: 'snotel-418', resortId: 'crystal', name: 'Corral Pass', source: 'SNOTEL', sourceId: '418:WA:SNTL',
    lat: 47.0187, lon: -121.4646, elevation: 1771, swe: true,
    url: 'https://wcc.sc.egov.usda.gov/nwcc/site?sitenum=418', attribution: SNOTEL_ATTR,
    dailyNote: 'Midnight (PST) reading; depth since 2006, SWE since 1981.',
  },
  {
    id: 'snotel-1085', resortId: 'crystal', name: 'Cayuse Pass', source: 'SNOTEL', sourceId: '1085:WA:SNTL',
    lat: 46.8696, lon: -121.5343, elevation: 1603, swe: true,
    url: 'https://wcc.sc.egov.usda.gov/nwcc/site?sitenum=1085', attribution: SNOTEL_ATTR,
    dailyNote: 'Midnight (PST) reading; record since 2006.',
  },
  // --- Summit at Snoqualmie & Alpental ---
  {
    id: 'snotel-672', resortId: 'snoqualmie', name: 'Olallie Meadows', source: 'SNOTEL', sourceId: '672:WA:SNTL',
    lat: 47.3741, lon: -121.4421, elevation: 1222, swe: true,
    url: 'https://wcc.sc.egov.usda.gov/nwcc/site?sitenum=672', attribution: SNOTEL_ATTR,
    dailyNote: 'Midnight (PST) reading; depth since 2003, SWE since 1982. Same drainage as Alpental and Summit West (upper South Fork Snoqualmie).',
  },
  {
    id: 'snotel-899', resortId: 'snoqualmie', name: 'Tinkham Creek', source: 'SNOTEL', sourceId: '899:WA:SNTL',
    lat: 47.332, lon: -121.4698, elevation: 914, swe: true,
    url: 'https://wcc.sc.egov.usda.gov/nwcc/site?sitenum=899', attribution: SNOTEL_ATTR,
    dailyNote: 'Midnight (PST) reading; depth since 2005, SWE since 1993.',
    caveat: 'At base-area elevation, 9 km south-southwest in the Cedar River headwaters: below most of the ski terrain, so it sees rain sooner and holds less snow.',
  },
  {
    id: 'snotel-788', resortId: 'snoqualmie', name: 'Stampede Pass', source: 'SNOTEL', sourceId: '788:WA:SNTL',
    lat: 47.2743, lon: -121.3416, elevation: 1173, swe: true,
    url: 'https://wcc.sc.egov.usda.gov/nwcc/site?sitenum=788', attribution: SNOTEL_ATTR,
    dailyNote: 'Midnight (PST) reading; depth since 2002, SWE since 1982.',
    caveat: 'At mid-mountain elevation but 16 km south-southeast, on a separate pass in the Green River drainage.',
  },
  // --- Stevens Pass ---
  {
    id: 'snotel-791', resortId: 'stevens', name: 'Stevens Pass', source: 'SNOTEL', sourceId: '791:WA:SNTL',
    lat: 47.7461, lon: -121.0929, elevation: 1201, swe: true,
    url: 'https://wcc.sc.egov.usda.gov/nwcc/site?sitenum=791', attribution: SNOTEL_ATTR,
    dailyNote: 'Midnight (PST) reading; depth since 2002, SWE since 1980. At the pass beside the base area (upper Tye River).',
    caveat: 'Just below the base area and about 580 m below the summit: upper-mountain depths are usually greater.',
  },
  {
    id: 'snotel-478', resortId: 'stevens', name: 'Fish Lake', source: 'SNOTEL', sourceId: '478:WA:SNTL',
    lat: 47.5357, lon: -121.0855, elevation: 1049, swe: true,
    url: 'https://wcc.sc.egov.usda.gov/nwcc/site?sitenum=478', attribution: SNOTEL_ATTR,
    dailyNote: 'Midnight (PST) reading; depth since 2000, SWE since 1983.',
    caveat: '22 km south, east of the Cascade crest (Cle Elum River headwaters) and 190 m below the base: it usually holds less snow than Stevens Pass.',
  },
  // --- Whistler Blackcomb ---
  {
    id: 'eccc-1108906', resortId: 'whistler', name: 'Whistler Roundhouse', source: 'ECCC', sourceId: '1108906',
    lat: 50.0678, lon: -122.9472, elevation: 1835, swe: false,
    url: 'https://climate.weather.gc.ca/', attribution: ECCC_ATTR,
    dailyNote: 'Daily "snow on ground"; on-mountain record since 1980.',
    caveat: 'No reports since 2026-09-23 — history is usable, current season may be missing.',
  },
  {
    id: 'bc-3A20P', resortId: 'whistler', name: 'Callaghan Creek', source: 'BC-ASWS', sourceId: '3A20P',
    lat: 50.1371, lon: -123.1029, elevation: 1017, swe: true,
    url: 'https://www.env.gov.bc.ca/wsd/data_searches/snow/asws/data/', attribution: BC_ATTR,
    dailyNote: 'Median of hourly readings per day (PST); record since 2018.',
  },
  {
    id: 'bc-3A25P', resortId: 'whistler', name: 'Squamish River Upper', source: 'BC-ASWS', sourceId: '3A25P',
    lat: 50.15, lon: -123.433, elevation: 1387, swe: true,
    url: 'https://www.env.gov.bc.ca/wsd/data_searches/snow/asws/data/', attribution: BC_ATTR,
    dailyNote: 'Median of hourly readings per day (PST); depth since 2003, SWE since 1989.',
    caveat: '36 km west of Whistler, in a wetter coastal drainage.',
  },
  {
    id: 'eccc-1101300', resortId: 'whistler', name: 'Callaghan Valley', source: 'ECCC', sourceId: '1101300',
    lat: 50.1439, lon: -123.1106, elevation: 884, swe: false,
    url: 'https://climate.weather.gc.ca/', attribution: ECCC_ATTR,
    dailyNote: 'Daily "snow on ground"; record since 2005.',
  },
  // --- Verbier / 4 Vallées ---
  {
    id: 'slf-ATT2', resortId: 'verbier', name: 'Lac des Vaux (ATT2)', source: 'SLF', sourceId: 'ATT2',
    lat: 46.1053, lon: 7.2699, elevation: 2550, swe: false,
    url: 'https://www.slf.ch/en/avalanche-bulletin-and-snow-situation/measured-values/', attribution: SLF_ATTR,
    dailyNote: 'IMIS automatic daily snow height; inside the Verbier ski area; record since 1993.',
  },
  {
    id: 'slf-NEN3', resortId: 'verbier', name: 'Combatzeline (NEN3)', source: 'SLF', sourceId: 'NEN3',
    lat: 46.1432, lon: 7.3353, elevation: 2203, swe: false,
    url: 'https://www.slf.ch/en/avalanche-bulletin-and-snow-situation/measured-values/', attribution: SLF_ATTR,
    dailyNote: 'IMIS automatic daily snow height (Nendaz sector); record since 2010.',
  },
  {
    id: 'ms-FIO', resortId: 'verbier', name: 'Fionnay', source: 'MeteoSwiss', sourceId: 'FIO',
    lat: 46.0314, lon: 7.309, elevation: 1500, swe: false,
    url: 'https://www.meteoswiss.admin.ch/services-and-publications/applications/measurement-values.html',
    attribution: MS_ATTR,
    dailyNote: 'Manual observer reading at 06 UTC (Val de Bagnes); record since 2008, gaps on many days.',
  },
];

export const stationsFor = (resortId: string) => STATIONS.filter((s) => s.resortId === resortId);
