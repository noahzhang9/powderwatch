/**
 * The Forecast tab's exports, built from data the page has already loaded (no requests):
 *  - forecastMarkdown: a compact summary to paste into an AI chat or a note, with a data dictionary;
 *  - forecastDailyCsv: the same days in tidy rows (date, series, variable, value, unit).
 * Values are in the units the page shows. Snowfall is PowderWatch physics; Open-Meteo's own (7:1) snowfall
 * appears in the CSV only, labelled as a comparison.
 */
import { MODELS, NBM, centresOf } from '../config/models';
import type { Band, Resort } from '../config/resorts';
import type { BandForecast, EnsembleSet, NbmForecast } from '../hooks/data';
import { CHANCE_HORIZONS_H, CHANCE_THRESHOLDS_CM, probabilityAtLeast, windowQuantiles, windowTotals, type DayDist } from './ensemble';
import { LOW_CENTRES, type DailyRow, type DrivenDay, type Phase } from './forecast';
import type { RunMeta } from './openmeteo';
import type { Fmt } from './prefs';
import { localDate, runLabel, zoneName } from './time';
import { dayBlocks } from './blocks';

export interface ForecastExportInput {
  resort: Resort;
  band: Band;
  data: BandForecast;
  fmt: Fmt;
  nowS: number;
  /** The resort's local date today: days before it are left out. */
  today: string;
  dists?: Map<string, DayDist> | null;
  driven?: Map<string, DrivenDay> | null;
  centres?: Map<string, number>;
  phases?: Map<string, Phase[]>;
  ens?: EnsembleSet;
  meta?: Record<string, RunMeta | null>;
  /** NOAA NBM, only when "Compare with official guidance" is on. */
  nbm?: NbmForecast | null;
  /** When the snapshot behind the page was taken (null: none, so the page fetched live). */
  snapshotAt?: number | null;
  siteUrl: string;
}

/** Hours of data a local day needs to count as complete (as elsewhere: 20 of 24). */
const FULL_DAY_H = 20;

const round = (v: number | null | undefined, digits: number) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** digits) / 10 ** digits);

/** Snow digits: tenths of an inch, whole centimetres (tenths under 10 cm). */
const snowDigits = (fmt: Fmt, v: number | null) => (fmt.units === 'imperial' || (v != null && Math.abs(v) < 10) ? 1 : 0);

function units(fmt: Fmt) {
  return {
    snow: (cm: number | null | undefined) => { const v = fmt.snowVal(cm); return round(v, snowDigits(fmt, v)); },
    water: (mm: number | null | undefined) => round(fmt.waterVal(mm), fmt.units === 'imperial' ? 2 : 1),
    elev: (m: number | null | undefined) => { const v = fmt.elevVal(m); return v == null ? null : Math.round(v / 10) * 10; },
    temp: (c: number | null | undefined) => round(fmt.tempVal(c), 0),
    wind: (kmh: number | null | undefined) => round(fmt.windVal(kmh), 0),
  };
}

const days = (input: ForecastExportInput) => input.data.blendDaily.filter((d) => d.date >= input.today);
const rowOn = (rows: DailyRow[] | undefined, date: string) => rows?.find((r) => r.date === date);

/** Plain-language flags for one day, the ones the Forecast tab marks on its chart. */
function dayFlags(input: ForecastExportInput, d: DailyRow): string[] {
  const out: string[] = [];
  const bandIndex = input.resort.bands.indexOf(input.band);
  const phase = input.phases?.get(d.date)?.[bandIndex];
  if (phase === 'rain' || phase === 'mixed') out.push(`${phase} at this elevation`);
  if (d.hours < FULL_DAY_H) out.push(`partial day (${d.hours} h)`);
  const centres = input.centres?.get(d.date);
  if (centres != null && centres < LOW_CENTRES) out.push(`only ${centres} forecast centre${centres === 1 ? '' : 's'}`);
  const dist = input.dists?.get(d.date);
  if (dist?.split) out.push(`split: ${Math.round(dist.pLow * 100)}% of ensemble members little or none, ${Math.round(dist.pHigh * 100)}% a lot`);
  const drv = input.driven?.get(d.date);
  if (drv) {
    const parts: string[] = [];
    if (drv.driver) parts.push(`${drv.driver.models.map((m) => m.label).join(' + ')} supplies ${Math.round(drv.driver.share * 100)}% of the blend`);
    if (drv.ensP90 != null) parts.push('blend above 90% of ensemble members');
    out.push(`outlier (${parts.join('; ')})`);
  }
  return out;
}

const dateLabel = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const cell = (v: number | null | undefined) => (v == null ? '–' : String(v));
const range = (a: number | null | undefined, b: number | null | undefined) => (a == null || b == null ? '–' : a === b ? String(a) : `${a}–${b}`);

/** Each model's latest run in the resort's local time, and the forecast centres behind the blend. */
function runsLine(input: ForecastExportInput): string {
  const { resort, meta } = input;
  const runs = input.data.models.map((m) => {
    const r = meta?.[m.model.id];
    return `${m.model.label} ${r ? runLabel(r.initUnix, resort.tz) : 'run time unknown'}`;
  });
  return `${runs.join('; ')} (${zoneName(resort.tz, input.nowS)})`;
}

export function forecastMarkdown(input: ForecastExportInput): string {
  const { resort, band, data, fmt, nowS } = input;
  const u = units(fmt);
  const ds = days(input);
  const models = data.models;
  const zone = zoneName(resort.tz, nowS);
  const exported = new Date(nowS * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: resort.tz });
  const out: string[] = [];

  out.push(`# PowderWatch forecast: ${resort.name}, ${band.label.toLowerCase()} band (${fmt.elev(band.elevation)})`);
  out.push('');
  out.push(`- Exported ${exported} ${zone}. Days are local calendar days in ${resort.tz}.`);
  out.push(`- Units: snow ${fmt.snowUnit}, water ${fmt.waterUnit}, elevation ${fmt.elevUnit}, temperature ${fmt.tempUnit}, wind ${fmt.windUnit}.`);
  out.push(`- Point: ${band.lat}, ${band.lon} at ${fmt.elev(band.elevation)}; models are downscaled to this elevation.`);
  out.push(`- Latest model runs: ${runsLine(input)}.`);
  if (input.snapshotAt != null) {
    const ageH = Math.max(0, Math.round((nowS - input.snapshotAt) / 3600));
    out.push(`- Data from the site's scheduled forecast snapshot taken about ${ageH} h before export (fetched live where missing or stale).`);
  }
  if (data.missing.length) out.push(`- No data at this point from: ${data.missing.map((id) => MODELS[id]?.label ?? id).join(', ')}.`);
  out.push('');

  const nbm = input.nbm?.daily;
  const head = ['Date', 'Blend snow', 'Ensemble 10/50/90%', ...models.map((m) => m.model.label), ...(nbm ? [`${NBM.label} (official)`] : []),
    'Rain', 'Snow level', 'Freezing level', 'Temp min/max', 'Gust max', 'Centres', 'Notes'];
  out.push(`## Daily forecast (snow and rain in ${fmt.snowUnit === fmt.waterUnit ? fmt.snowUnit : `${fmt.snowUnit} and ${fmt.waterUnit}`})`);
  out.push('');
  out.push(`| ${head.join(' | ')} |`);
  out.push(`|${head.map(() => '---').join('|')}|`);
  for (const d of ds) {
    const dist = input.dists?.get(d.date);
    const ensCell = dist && dist.p50 != null ? `${cell(u.snow(dist.p10))} / ${cell(u.snow(dist.p50))} / ${cell(u.snow(dist.p90))}` : '–';
    const row = [
      dateLabel(d.date),
      cell(u.snow(d.snowCm)),
      ensCell,
      ...models.map((m) => cell(u.snow(rowOn(data.daily[m.model.id], d.date)?.snowCm))),
      ...(nbm ? [cell(u.snow(rowOn(nbm, d.date)?.snowCm))] : []),
      cell(u.water(d.rainMm)),
      range(u.elev(d.snowLevelMin), u.elev(d.snowLevelMax)),
      range(u.elev(d.fzlMin), u.elev(d.fzlMax)),
      `${cell(u.temp(d.tMin))} / ${cell(u.temp(d.tMax))}`,
      cell(u.wind(d.gustMax)),
      cell(input.centres?.get(d.date)),
      dayFlags(input, d).join('; ') || '',
    ];
    out.push(`| ${row.join(' | ')} |`);
  }
  out.push('');

  if (input.ens?.members.length) {
    const ens = input.ens;
    const thresholds = CHANCE_THRESHOLDS_CM[fmt.units === 'imperial' ? 'imperial' : 'metric'];
    const stats = CHANCE_HORIZONS_H.map((h) => windowTotals(ens.time, ens.members, nowS, nowS + h * 3600));
    out.push(`## Ensemble totals from now (${ens.members.length} members, each forecast centre weighted equally)`);
    out.push('');
    out.push(`| | ${CHANCE_HORIZONS_H.map((h) => `next ${h / 24} days`).join(' | ')} |`);
    out.push(`|---|${CHANCE_HORIZONS_H.map(() => '---').join('|')}|`);
    const q = stats.map((ws) => windowQuantiles(ws, [0.1, 0.5, 0.9]).map((v) => u.snow(v)));
    out.push(`| Snow, 10th / 50th / 90th percentile | ${q.map(([a, b, c]) => `${cell(a)} / ${cell(b)} / ${cell(c)}`).join(' | ')} |`);
    for (const th of thresholds) {
      out.push(`| Chance of at least ${fmt.snow(th, 0)} | ${stats.map((ws) => { const p = probabilityAtLeast(ws, th); return p == null ? '–' : `${Math.round(p * 100)}%`; }).join(' | ')} |`);
    }
    if (ens.failed.length) out.push(`\nEnsembles that failed to load: ${ens.failed.join(', ')}.`);
    out.push('');
  }

  out.push('## How to read this');
  out.push('');
  out.push(`- **Snowfall** is PowderWatch's own calculation, the same for every model: each hour's precipitation is split into rain and snow from the model's temperature and humidity at ${fmt.elev(band.elevation)}, and snow is converted with a temperature-dependent snow-to-liquid ratio. It is not the providers' own snowfall field.`);
  out.push(`- **Blend** is the mean of the models with every forecast centre (${centresOf(models.map((m) => m.model.id)).join(', ')}) weighted equally, split among its models. **Centres** is how many centres had a full day of data; fewer than ${LOW_CENTRES} means low confidence.`);
  out.push('- **Ensemble 10/50/90%** are percentiles of the ensemble members\' daily snowfall (model spread, not a calibrated probability). The same goes for every "chance" above.');
  out.push('- **Snow level** is the blend\'s snow level while precipitating (where snow turns to rain); **freezing level** is the 0 °C height. Ranges are the day\'s minimum–maximum.');
  out.push('- **Outlier** days rest on one model: one centre supplies over half of the blend, or the blend is above 90% of ensemble members. **Split** days have ensemble members clustered at both little and a lot.');
  if (nbm) out.push(`- **${NBM.label}** is NOAA's calibrated official guidance with its own snowfall; it is not part of the blend.`);
  out.push('- Models smooth terrain; expect local differences, especially on wind-exposed or sheltered slopes.');
  out.push('');
  out.push('## Sources');
  out.push('');
  out.push(`- Forecast data: Open-Meteo (open-meteo.com, CC BY 4.0), from ${centresOf(models.map((m) => m.model.id)).join(', ')} models${nbm ? '; NOAA National Blend of Models via Open-Meteo' : ''}.`);
  if (resort.note) out.push(`- ${resort.note.text} ${resort.note.link.label}: ${resort.note.link.url}`);
  out.push(`- Exported from PowderWatch: ${input.siteUrl}`);
  return out.join('\n') + '\n';
}

/** A CSV field: quoted when it holds a comma, quote or line break. */
const csvField = (v: string | number | null) => {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Tidy daily rows: date,series,variable,value,unit. Comment lines (#) carry the context and sources. */
export function forecastDailyCsv(input: ForecastExportInput): string {
  const { resort, band, data, fmt } = input;
  const u = units(fmt);
  const ds = days(input);
  const rows: (string | number | null)[][] = [];
  const add = (date: string, series: string, variable: string, value: number | null, unit: string) => {
    if (value != null) rows.push([date, series, variable, value, unit]);
  };
  const addDaily = (series: string, r: DailyRow | undefined, date: string, withRaw = false) => {
    if (!r) return;
    add(date, series, 'snow', u.snow(r.snowCm), fmt.snowUnit);
    add(date, series, 'rain', u.water(r.rainMm), fmt.waterUnit);
    add(date, series, 'precipitation', u.water(r.precipMm), fmt.waterUnit);
    add(date, series, 'temperature_min', u.temp(r.tMin), fmt.tempUnit);
    add(date, series, 'temperature_max', u.temp(r.tMax), fmt.tempUnit);
    add(date, series, 'freezing_level_min', u.elev(r.fzlMin), fmt.elevUnit);
    add(date, series, 'freezing_level_max', u.elev(r.fzlMax), fmt.elevUnit);
    add(date, series, 'snow_level_min', u.elev(r.snowLevelMin), fmt.elevUnit);
    add(date, series, 'snow_level_max', u.elev(r.snowLevelMax), fmt.elevUnit);
    add(date, series, 'gust_max', u.wind(r.gustMax), fmt.windUnit);
    add(date, series, 'hours_with_data', r.hours, 'h');
    if (withRaw) add(date, series, 'open_meteo_snowfall_7to1_comparison_only', u.snow(r.omSnowCm), fmt.snowUnit);
  };
  for (const d of ds) {
    addDaily('blend', d, d.date, true);
    const centres = input.centres?.get(d.date);
    if (centres != null) add(d.date, 'blend', 'forecast_centres', centres, 'count');
    add(d.date, 'blend', 'outlier', input.driven?.has(d.date) ? 1 : 0, 'flag');
    for (const m of data.models) addDaily(m.model.label, rowOn(data.daily[m.model.id], d.date), d.date);
    const dist = input.dists?.get(d.date);
    if (dist && dist.p50 != null) {
      add(d.date, 'ensemble', 'snow_p10', u.snow(dist.p10), fmt.snowUnit);
      add(d.date, 'ensemble', 'snow_p50', u.snow(dist.p50), fmt.snowUnit);
      add(d.date, 'ensemble', 'snow_p90', u.snow(dist.p90), fmt.snowUnit);
      add(d.date, 'ensemble', 'members', dist.members, 'count');
      add(d.date, 'ensemble', 'split', dist.split ? 1 : 0, 'flag');
    }
    const nbm = rowOn(input.nbm?.daily, d.date);
    if (nbm) add(d.date, `${NBM.label} (official guidance)`, 'snow', u.snow(nbm.snowCm), fmt.snowUnit);
  }
  const exported = new Date(input.nowS * 1000).toISOString().slice(0, 16) + 'Z';
  const header = [
    // Comment lines hold no commas, so a spreadsheet that ignores the # still sees one cell per line.
    `# PowderWatch daily forecast: ${resort.name}; ${band.label.toLowerCase()} band at lat ${band.lat} lon ${band.lon} and ${u.elev(band.elevation)} ${fmt.elevUnit}; local days in ${resort.tz}; exported ${exported} (${localDate(input.nowS, resort.tz)} local)`,
    '# Snow is PowderWatch physics for every model; the blend weights each forecast centre equally; ensemble percentiles and flags are model spread and not calibrated probabilities.',
    `# Source: Open-Meteo (open-meteo.com; CC BY 4.0) from ${centresOf(data.models.map((m) => m.model.id)).join(' / ')} models. Exported from PowderWatch: ${input.siteUrl.replace(/,/g, '%2C')}`,
  ];
  return [...header, 'date,series,variable,value,unit', ...rows.map((r) => r.map(csvField).join(','))].join('\n') + '\n';
}

/** 3-hour blocks for every day from today: start,end (local ISO),series,variable,value,unit. */
export function forecastBlocksCsv(input: ForecastExportInput): string {
  const { resort, band, data, fmt } = input;
  const u = units(fmt);
  const rows: (string | number | null)[][] = [];
  const iso = (t: number) => {
    const d = new Date(t * 1000).toLocaleString('sv-SE', { timeZone: resort.tz, hour12: false }).replace(' ', 'T');
    return d.slice(0, 16);
  };
  for (const d of days(input)) {
    for (const b of dayBlocks(data, d.date, resort.tz, band.elevation, input.ens)) {
      const at = [iso(b.start), iso(b.end)];
      const add = (series: string, variable: string, value: number | string | null, unit: string) => {
        if (value != null) rows.push([...at, series, variable, value, unit]);
      };
      add('blend', 'snow', u.snow(b.snowCm), fmt.snowUnit);
      add('blend', 'rain', u.water(b.rainMm), fmt.waterUnit);
      add('blend', 'precipitation', u.water(b.precipMm), fmt.waterUnit);
      add('blend', 'temperature_min', u.temp(b.tMin), fmt.tempUnit);
      add('blend', 'temperature_max', u.temp(b.tMax), fmt.tempUnit);
      add('blend', 'snow_level_min', u.elev(b.snowLevelMin), fmt.elevUnit);
      add('blend', 'snow_level_max', u.elev(b.snowLevelMax), fmt.elevUnit);
      add('blend', 'gust_max', u.wind(b.gustMax), fmt.windUnit);
      add('blend', 'precipitation_type', b.phase, 'text');
      add('blend', 'open_meteo_snowfall_7to1_comparison_only', u.snow(b.omSnowCm), fmt.snowUnit);
      for (const m of b.models) {
        add(MODELS[m.id]?.label ?? m.id, 'snow', u.snow(m.snowCm), fmt.snowUnit);
        if (m.coarse) add(MODELS[m.id]?.label ?? m.id, 'spread_from_coarser_output', 1, 'flag');
      }
      if (b.ens) {
        add('ensemble', 'snow_p10', u.snow(b.ens.p10), fmt.snowUnit);
        add('ensemble', 'snow_p50', u.snow(b.ens.p50), fmt.snowUnit);
        add('ensemble', 'snow_p90', u.snow(b.ens.p90), fmt.snowUnit);
      }
    }
  }
  const header = [
    `# PowderWatch 3-hourly forecast: ${resort.name}; ${band.label.toLowerCase()} band at lat ${band.lat} lon ${band.lon} and ${u.elev(band.elevation)} ${fmt.elevUnit}; times are local (${resort.tz}) and each block runs from start to end`,
    '# Snow is PowderWatch physics for every model; a coarse model (3- or 6-hourly output) has its amount spread evenly so its timing within a block is approximate; ensemble percentiles are model spread.',
    `# Source: Open-Meteo (open-meteo.com; CC BY 4.0) from ${centresOf(data.models.map((m) => m.model.id)).join(' / ')} models. Exported from PowderWatch: ${input.siteUrl.replace(/,/g, '%2C')}`,
  ];
  return [...header, 'start,end,series,variable,value,unit', ...rows.map((r) => r.map(csvField).join(','))].join('\n') + '\n';
}

/** A file name such as powderwatch-crystal-mid-2026-11-27-daily.csv. */
export const exportFileName = (input: Pick<ForecastExportInput, 'resort' | 'band' | 'today'>, suffix: string) =>
  `powderwatch-${input.resort.id}-${input.band.key}-${input.today}-${suffix}`;
