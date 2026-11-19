import { ENSEMBLES, MODELS } from '../config/models';
import { RESORTS } from '../config/resorts';
import { STATIONS } from '../config/stations';
import { PHASE_TW_HALF_WIDTH, PHASE_TW_MID, SNOW_LEVEL_OFFSET_M, snowToLiquidRatio } from '../lib/physics';
import { DEFAULT_PARAMS } from '../lib/snowpack';
import { SPLIT_HIGH_CM, SPLIT_LOW_CM, SPLIT_MIN_SHARE } from '../lib/ensemble';
import { PHASE_BAND_M } from '../lib/forecast';
import { useFmt } from '../lib/prefs';
import { LOW_CENTRES } from './storm/Daily';

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
        <li>Blend: every forecast centre (ECMWF, NOAA, ECCC, DWD, UK Met Office, MeteoSwiss) gets equal weight each hour, split among its models that have data. Snow and rain use the weighted mean (totals stay consistent across daily and cumulative views); temperatures and levels use the weighted median.</li>
        <li>High-resolution regional models join the blend only within their range (HRRR/HRDPS 48 h, ICON-CH1 33 h, ICON-CH2 120 h).</li>
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
        <li>Totals of 7 days or more lead with the ensemble median and its 10–90% range. The multi-model blend is still shown, with a warning when it falls outside the range of the models that cover the whole window (late in the window fewer centres remain, so the blend can drift).</li>
        <li>Precipitation type per elevation: snow when the band is more than {fmt.elev(PHASE_BAND_M)} above the blended snow level during wet hours, rain when more than {fmt.elev(PHASE_BAND_M)} below, mixed otherwise.</li>
        <li>Gusts are flagged at 40 mph (64 km/h) and above, where lift holds become likely. Dashboard: "next big day" is the first day with at least 4 in (10 cm); model agreement compares the spread of 7-day totals with the blend (under 0.6 broad agreement, over 1.2 strong disagreement); "rain risk up high" means the 72-hour snow level comes within 100 m of the summit band.</li>
        <li>"Since your last visit" compares with what this browser showed at least 30 minutes earlier. "Change since the previous run" compares each global model's latest run with its run 12 hours earlier.</li>
      </ul>

      <h2>Snowpack projection</h2>
      <ul className="list-disc pl-5">
        <li>Starts from the station's latest reading (and its SWE if the station measures it; otherwise a seasonal bulk density).</li>
        <li>Forcing is taken at the station's own coordinates and elevation, not the resort's, so the projection is comparable with that station's history.</li>
        <li>
          Layered model, hourly: new snow at fresh-snow density; each layer settles toward {DEFAULT_PARAMS.rhoMaxDry} kg/m³ when dry and {DEFAULT_PARAMS.rhoMaxWet} kg/m³ when wet (plus overburden), e-folding in about {DEFAULT_PARAMS.settleTauH} h at 0 °C and more slowly when colder;
          degree-day melt ({DEFAULT_PARAMS.ddfByMonth[11]}–{DEFAULT_PARAMS.ddfByMonth[4]} mm/°C/day by month) and rain-on-snow melt.
        </li>
        <li>Run for every ensemble member; the band shows the family-weighted 10th–90th percentile. Single-model runs are shown as scenarios.</li>
      </ul>

      <h2>Climatology</h2>
      <ul className="list-disc pl-5">
        <li>Season = Oct 1 – Jun 30. A past season counts only with ≥80% of Nov–May days present. The current season never counts toward normals.</li>
        <li>Percentile bands are computed across seasons for each calendar day, then smoothed with a 7-day running mean.</li>
        <li>Each comparison uses one station's own record — never mixed with resort-reported depths.</li>
      </ul>

      <h2>Coverage</h2>
      <ul className="list-disc pl-5">
        {RESORTS.map((r) => (
          <li key={r.id}>
            <b className="text-ink">{r.name}:</b> {r.models.map((m) => MODELS[m].label).join(', ')}. Stations:{' '}
            {STATIONS.filter((s) => s.resortId === r.id).map((s) => `${s.name} (${s.source}, ${fmt.elev(s.elevation)})`).join('; ')}.
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
