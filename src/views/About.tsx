import { ENSEMBLES, MODELS, NBM, centresOf, horizonText } from '../config/models';
import { RESORTS } from '../config/resorts';
import { SNODAS_ABOUT, SNODAS_CITATION, SNODAS_DOI, SNODAS_FIRST_SEASON, SNODAS_POINTS, SNODAS_RESORTS, STATIONS } from '../config/stations';
import { SNAPSHOT_INTERVAL_H, SNAPSHOT_MAX_AGE_S } from '../lib/cache';
import { PHASE_TW_HALF_WIDTH, PHASE_TW_MID, SNOW_LEVEL_OFFSET_M, snowToLiquidRatio } from '../lib/physics';
import { DEFAULT_PARAMS } from '../lib/snowpack';
import { GAP_FILL_DAYS, MIN_SEASON_COVERAGE, SMOOTH_HALF_DAYS } from '../lib/climatology';
import { CHANCE_THRESHOLDS_CM, SPLIT_HIGH_CM, SPLIT_LOW_CM, SPLIT_MIN_SHARE } from '../lib/ensemble';
import { DRIVEN_MIN_CM, DRIVEN_SHARE, LOW_CENTRES, PHASE_BAND_M } from '../lib/forecast';
import { DEFAULT_SLR, ESTIMATE_ERROR_PCT, MIN_COMPARE_SEASONS, MIN_SWE_GAIN_MM, SLR_RANGE } from '../lib/newsnow';
import { useFmt } from '../lib/prefs';
import { WPC_ATTRIBUTION, WPC_CATEGORY_LABEL, WPC_THRESHOLDS_IN } from '../lib/wpc';
import { BEST_DAY_MIN_CM, GRID_DAYS, NARROW_GRID_DAYS } from './Dashboard';

/** The models some resort shows: the catalogue may hold more, which the page doesn't mention. */
const SHOWN = RESORTS.flatMap((r) => r.models);

export function About() {
  const fmt = useFmt();
  const lo = PHASE_TW_MID - PHASE_TW_HALF_WIDTH;
  const hi = PHASE_TW_MID + PHASE_TW_HALF_WIDTH;
  return (
    <article className="pt-5 max-w-3xl text-sm leading-relaxed text-ink-2 [&_h2]:text-ink [&_h2]:font-semibold [&_h2]:text-base [&_h2]:mt-6 [&_h2]:mb-1 [&_p]:mt-2 [&_li]:mt-1">
      <h1 className="text-2xl font-semibold tracking-tight text-ink">Methods</h1>
      <p>
        PowderWatch runs every forecast model through the same physics, so differences between models come from their weather, not from each
        provider's own snowfall post-processing. Everything below is what the code does today.
      </p>

      <h2>Snowfall</h2>
      <ul className="list-disc pl-5">
        <li>Input: hourly liquid-equivalent precipitation, 2 m temperature and humidity, statistically downscaled by Open-Meteo to each band's elevation.</li>
        <li>
          Rain/snow split by wet-bulb temperature (Stull 2011): all snow at or below {lo} °C, all rain at or above {hi} °C, linear between (50/50 at {PHASE_TW_MID} °C).
        </li>
        <li>
          Snow-to-liquid ratio from fresh-snow density (Hedstrom &amp; Pomeroy 1998): about {snowToLiquidRatio(0).toFixed(0)}:1 at 0 °C,{' '}
          {snowToLiquidRatio(-5).toFixed(0)}:1 at −5 °C, {snowToLiquidRatio(-10).toFixed(0)}:1 at −10 °C. Open-Meteo's own snowfall uses a fixed 7:1 ratio; it can be shown for comparison.
        </li>
        <li>Pure model ids are used (e.g. GFS, not "GFS seamless", which splices in HRRR), so each line is one model.</li>
      </ul>

      <h2>Freezing level and snow level</h2>
      <ul className="list-disc pl-5">
        <li>Freezing level: the model's own field when published (GFS, ICON, HRRR, ICON-CH); otherwise interpolated from its pressure-level temperatures and heights. With a warm layer aloft, the top of the warm layer is used.</li>
        <li>Snow level: the height where wet-bulb temperature crosses {PHASE_TW_MID} °C in the pressure-level profile — the same threshold as the rain/snow split. Without humidity aloft: freezing level − {SNOW_LEVEL_OFFSET_M} m.</li>
      </ul>

      <h2>Blend and ensembles</h2>
      <ul className="list-disc pl-5">
        <li>Blend: every forecast centre ({centresOf(SHOWN).join(', ')}) gets equal weight each hour, split among its models that have data. Snow and rain use the weighted mean (totals stay consistent across daily and cumulative views); temperatures and levels use the weighted median.</li>
        <li>
          High-resolution regional models resolve terrain and the timing of showers better than the global models, but run only a day or two
          ahead, so later days rest on the global models. They join the blend only within their range (
          {Object.values(MODELS).filter((m) => m.kind === 'regional' && SHOWN.includes(m.id)).map((m) => `${m.label} ${horizonText(m.horizonH)}`).join(', ')}). On the
          Forecast tab their mark is a diamond, and their model pill shows that range.
        </li>
        <li>Official guidance (below) is never part of the blend.</li>
        <li>Ensembles: {ENSEMBLES.map((e) => `${e.label} (${e.members})`).join(', ')}. Centres are weighted equally, members equally within a centre. Probabilities are model spread until verified against observations.</li>
        <li>The blend is not assumed to be more accurate than any single model. Skill weighting waits on verification data.</li>
      </ul>

      <h2>Confidence rules on the charts</h2>
      <ul className="list-disc pl-5">
        <li>Days with fewer than {LOW_CENTRES} forecast centres contributing are drawn outlined and shaded: the blend there averages only one or two centres.</li>
        <li>
          A day is <i>split</i> when at least {Math.round(SPLIT_MIN_SHARE * 100)}% of ensemble members (centre-weighted) give {fmt.snow(SPLIT_LOW_CM)} or less
          and at least {Math.round(SPLIT_MIN_SHARE * 100)}% give {fmt.snow(SPLIT_HIGH_CM)} or more. On split days the average is not a likely outcome; hover the day for both camps.
        </li>
        <li>
          A day's total is marked <i>outlier</i> when the blend gives at least {fmt.snow(DRIVEN_MIN_CM, 0)} over the whole day and either one forecast
          centre supplies more than {Math.round(DRIVEN_SHARE * 100)}% of it, counted with the blend's own hourly weights (judged only on days with at
          least {LOW_CENTRES} centres), or it is above the ensemble's 90th percentile for that day: more than 90% of members, centre-weighted, give
          less (judged when at least {LOW_CENTRES} ensemble centres cover the day). The blend stays the plain mean, which keeps daily and cumulative
          totals consistent; the mark says one model's number is carrying it. Hover the day for the model, or the ensemble's 90th percentile.
        </li>
        <li>Totals of 7 days or more lead with the ensemble median and its 10–90% range. The multi-model blend is still shown, with a warning when it falls outside the range of the models that cover the whole window (late in the window fewer centres remain, so the blend can drift). When only one model reaches the end of a window, the blend there is that model, so the tile names it and gives its own total instead.</li>
        <li>Precipitation type per elevation: snow when the band is more than {fmt.elev(PHASE_BAND_M)} above the blended snow level during wet hours, rain when more than {fmt.elev(PHASE_BAND_M)} below, mixed otherwise.</li>
        <li>Gusts are flagged at 40 mph (64 km/h) and above, where lift holds become likely. Dashboard: ★ marks each resort's snowiest day among those Where &amp; when shows ({GRID_DAYS}, or {NARROW_GRID_DAYS} on phones) that brings at least {fmt.snow(BEST_DAY_MIN_CM, 1)} and isn't an <i>outlier</i> day, and each card names it as the best day.</li>
        <li>"Since your last visit" compares with what this browser showed at least 30 minutes earlier. "Change since the previous run" compares each global model's latest run with its run 12 hours earlier.</li>
      </ul>

      <h2>Snowpack projection</h2>
      <ul className="list-disc pl-5">
        <li>Starts from the station's latest reading (and its SWE if the station measures it; otherwise a seasonal bulk density).</li>
        <li>Forcing is taken at the station's own coordinates and elevation, not the resort's, so the projection is comparable with that station's history.</li>
        <li>From a SNODAS point (below) it starts from the modelled depth and SWE, with forcing at the band itself; those inputs aren't in the snapshot and are fetched when the point is picked.</li>
        <li>
          Layered model, hourly: new snow at fresh-snow density; each layer settles toward {DEFAULT_PARAMS.rhoMaxDry} kg/m³ when dry and {DEFAULT_PARAMS.rhoMaxWet} kg/m³ when wet (plus overburden), e-folding in about {DEFAULT_PARAMS.settleTauH} h at 0 °C and more slowly when colder;
          degree-day melt ({DEFAULT_PARAMS.ddfByMonth[11]}–{DEFAULT_PARAMS.ddfByMonth[4]} mm/°C/day by month) and rain-on-snow melt.
        </li>
        <li>Run for every ensemble member; the band shows the family-weighted 10th–90th percentile. Single-model runs are shown as scenarios.</li>
      </ul>

      <h2>Climatology</h2>
      <ul className="list-disc pl-5">
        <li>
          Season = Oct 1 – Jun 30. A missing day takes the nearest reading within {GAP_FILL_DAYS} days, since depth changes slowly. A past
          season counts only when at least {Math.round(MIN_SEASON_COVERAGE * 100)}% of its Nov–May days then have a value, so a station
          reporting at least once every {2 * GAP_FILL_DAYS + 1} days counts as complete. The current season never counts toward normals.
        </li>
        <li>Percentile bands are computed across seasons for each calendar day, then smoothed with a {2 * SMOOTH_HALF_DAYS + 1}-day running mean.</li>
        <li>Each comparison uses one station's own record — never mixed with resort-reported depths.</li>
      </ul>

      <h2>New snow estimated from SWE (SNOTEL)</h2>
      <ul className="list-disc pl-5">
        <li>
          SNOTEL stations measure snow depth and water (SWE) at midnight, not new snow. Behind "Estimated new snow" in the Forecast tab's last 7 days,
          and in one line on the Snowpack tab, it is estimated from the water the snow pillow gained, always labelled "estimated from SWE" with the
          station's name and elevation. Stations that measure new snow (SLF, MeteoSwiss, ECCC) keep their measurements; stations without SWE get no estimate.
        </li>
        <li>
          Each day is the 24 h ending at the midnight reading that opens it. A day counts only when the pillow gained at least {fmt.water(MIN_SWE_GAIN_MM)} of
          water, two of SNOTEL's 0.1 in steps: single steps up and down are about equally common in mid-winter, so they are mostly noise. Less is no new
          snow, whatever the depth did.
        </li>
        <li>
          When water was gained but the depth fell, the day is marked <i>rain or mixed</i> and gets no estimate. Otherwise new snow ≈ the larger of the
          depth gain and the water gained × the snow-to-liquid ratio at the station's mean temperature over those 24 h (TAVG), from the same fresh-snow
          density as the forecasts (about {snowToLiquidRatio(0).toFixed(0)}:1 at 0 °C, {snowToLiquidRatio(-5).toFixed(0)}:1 at −5 °C). A day without a
          temperature reading uses {DEFAULT_SLR}:1, and the page says when it did.
        </li>
        <li>
          It is shown as a range, the ratio × {SLR_RANGE.low} to × {SLR_RANGE.high}. In the Washington Cascades such an estimate is typically off by
          {' '}{ESTIMATE_ERROR_PCT.day[0]}–{ESTIMATE_ERROR_PCT.day[1]}% for a single day and by about {ESTIMATE_ERROR_PCT.season}% over a season.
        </li>
        <li>
          Snowpack tab: this season's sum from Oct 1 to the latest reading, against the median of the station's own past seasons over the same dates,
          each estimated the same way. A past season counts when at least {Math.round(MIN_SEASON_COVERAGE * 100)}% of those days have readings, and the
          median needs {MIN_COMPARE_SEASONS} such seasons. Rain-or-mixed days add nothing, so storms that turned to rain are undercounted.
        </li>
      </ul>

      <h2>Modelled snowpack: SNODAS (US resorts)</h2>
      <ul className="list-disc pl-5">
        <li>
          {SNODAS_ABOUT} The Snowpack tab offers it at every band of {RESORTS.filter((r) => SNODAS_RESORTS.includes(r.id)).map((r) => r.short).join(', ')} as
          extra choices marked "modelled (SNODAS)". The default is always a measurement station, every SNODAS value is labelled modelled, and SNODAS
          appears nowhere else on the site.
        </li>
        <li>
          Values: snow depth (product 1036) and snow water equivalent (product 1034) at 06:00 UTC, 10 pm PST the evening before, about two hours
          before the SNOTEL stations' midnight reading for the same date. Each point reads the one 30-arc-second (about 1 km) cell that contains the
          band's coordinates; SNODAS estimates the cell, so its terrain is not the band's elevation.
        </li>
        <li>
          Source files: NSIDC's masked daily archive (data set G02158), 16-bit big-endian integers in millimetres. No-data cells (−9999) and
          clipped values (32,767, where SWE runs away at some high-elevation cells) are dropped. The grid moved by 5% of a cell on 2013-10-01; each
          file's own header places the cell, and every resort point stays in the same cell across that shift.
        </li>
        <li>
          History: seasons from {SNODAS_FIRST_SEASON}–{String(SNODAS_FIRST_SEASON + 1).slice(2)} on, Oct 1 – Jun 30, filled by a manually run
          backfill; the scheduled job adds each new day. NSIDC advises against SNODAS before October 2004, when routine assimilation began. Until the
          history is in, the tab shows this season alone and says so. A SNODAS point is compared only with its own modelled history, never with
          station measurements.
        </li>
        <li>
          Known limits: it is model output, not an observation. NOHRSC's erroneous zeros of 2014-10-09 to 2019-10-10 affect cells along coasts and
          lakes, not these {SNODAS_POINTS.length} points (they hold valid values before 2014-10-09, which the affected cells don't).
        </li>
        <li>
          Citation: {SNODAS_CITATION.slice(0, SNODAS_CITATION.indexOf(SNODAS_DOI))}
          <a className="underline" href={SNODAS_DOI}>{SNODAS_DOI}</a>
          {SNODAS_CITATION.slice(SNODAS_CITATION.indexOf(SNODAS_DOI) + SNODAS_DOI.length)}
        </li>
      </ul>

      <h2>Data freshness</h2>
      <ul className="list-disc pl-5">
        <li>
          A scheduled job refreshes station observations and a forecast snapshot every {SNAPSHOT_INTERVAL_H} hours ({24 / SNAPSHOT_INTERVAL_H} times a day). With the
          snapshot, the dashboard, the Forecast tab at mid-mountain, the last 7 days and each resort's default Snowpack station need no direct calls to Open-Meteo.
        </li>
        <li>
          The same job adds each new SNODAS day (NSIDC posts it around 14:00 UTC), so the modelled points lag by up to a day. A snapshot copy is used until it is {SNAPSHOT_MAX_AGE_S / 3600} hours old. Past that, and for what the snapshot leaves out (Run history, base and summit
          ensembles, some Snowpack stations), the browser asks Open-Meteo directly and caches the answer.
        </li>
        <li>
          The dashboard's ensembles are the exception: it never asks Open-Meteo for them. Its 7-day figure is the ensemble median from a snapshot (or
          cached) copy under {SNAPSHOT_MAX_AGE_S / 3600} hours old, the copy the Forecast tab would use, and otherwise the blend, labelled "blend".
        </li>
      </ul>

      <h2>Official guidance (US resorts)</h2>
      <ul className="list-disc pl-5">
        <li>
          "Compare with official guidance" on the Forecast tab adds NOAA's own products as benchmarks. They are shown as NOAA publishes them, not run
          through the physics above, because their calibration is the point; they never join the blend, the centre counts or any total.
        </li>
        <li>
          {NBM.long} ({NBM.label}): NOAA's statistically calibrated blend of many models, updated hourly, about 11 days ahead. The daily
          chart marks its own snowfall per local day with a short dark bar. It is taken at the band's coordinates on NBM's {NBM.resolutionKm} km grid and
          is not adjusted to the band's elevation.
        </li>
        <li>
          {WPC_ATTRIBUTION} (WPC): the chance of at least {WPC_THRESHOLDS_IN.map((t) => fmt.snow(t * 2.54, 0)).join(', ')} of snow in each of its Day 1–3
          periods, at mid-mountain. WPC publishes ranges ({WPC_CATEGORY_LABEL.join(', ')}) as nested areas on a map; a resort gets the highest range it
          falls in. Each WPC day is a 24-hour period from 00Z or 12Z, shown in local time, so it doesn't match the calendar days or windows of the
          ensemble table. The scheduled job reads WPC every {SNAPSHOT_INTERVAL_H} hours (WPC updates twice a day); your browser never contacts NOAA.
        </li>
      </ul>

      <h2>Verification archive</h2>
      <ul className="list-disc pl-5">
        <li>
          For every 00Z and 12Z cycle, the scheduled job keeps what the forecasts said for the next 10 days: at each resort's mid band (blend and each
          model) and at each station's own coordinates (the snowpack-scenario models), with the ensemble's 10th/50th/90th percentiles and its chances
          for the "Chance of snow totals" thresholds ({CHANCE_THRESHOLDS_CM.imperial.map((t) => fmt.snow(t, 0)).join(', ')}). It reuses the snapshot's
          responses, so it costs no extra Open-Meteo calls, and lives on a separate <code>data/verification</code> branch of the repository.
          At US resorts it also keeps {NBM.label}'s own forecast and WPC's chances at mid.
        </li>
        <li>Those records are what the verification against station measurements will use. Until then, every chance on this site is model spread.</li>
      </ul>

      <h2>Coverage</h2>
      <ul className="list-disc pl-5">
        {RESORTS.map((r) => (
          <li key={r.id}>
            <b className="text-ink">{r.name}:</b> {r.bands.map((b) => `${b.label} ${fmt.elev(b.elevation)}`).join(', ')}.{' '}
            {r.models.map((m) => MODELS[m].label).join(', ')}. Stations:{' '}
            {STATIONS.filter((s) => s.resortId === r.id).map((s) => `${s.name} (${s.source}, ${fmt.elev(s.elevation)})`).join('; ')}.
            {SNODAS_RESORTS.includes(r.id) && ' Modelled: SNODAS at each band.'}
          </li>
        ))}
      </ul>

      <h2>Known limits</h2>
      <ul className="list-disc pl-5">
        <li>Global models (9–25 km) smooth the terrain; their precipitation at a specific resort can be badly biased. Local verification is the only fix.</li>
        <li>
          Snowpack settling is calibrated on three Cascade SNOTEL stations: given the observed water input, the 10-day depth error is about 18 cm RMSE
          (persistence: 40 cm). Real projections add precipitation-forecast error on top, and the calibration is not yet checked for BC or the Alps.
          Run <code>npx tsx scripts/backtest-snowpack.ts</code> to reproduce.
        </li>
        <li>No free machine-readable feed exists for resort base depths or lift status; those are links only.</li>
      </ul>
    </article>
  );
}
