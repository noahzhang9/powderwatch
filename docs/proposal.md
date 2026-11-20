# PowderWatch
### Personal Ski Forecasting & Snowpack Analytics Platform

**Project Proposal — Revision 3, 20 November 2026**

**Status (as of 2026-11-20):** Phases 1–3 are implemented for five resorts. At the three US resorts, the Snowpack tab also offers NOAA SNODAS modelled snowpack at each band; it is ingested daily from 2026-11-15, and its history arrives through a manually run backfill workflow. Phase 4 (verification) has its forecast archive: two records a day on the `data/verification` branch, and a one-time backfill from 2026-10-01; the verification analysis is still to build. Phase 5 (alerts and personalization) is partly done: trips exist, alerts do not.

---

## 1. Project Overview

PowderWatch is a personal ski-forecasting dashboard. It combines many weather models, run-to-run forecast history and measured mountain snowpack in one transparent interface.

It is not a single snowfall number. It shows:

- how models disagree,
- how their forecasts change from run to run,
- what precipitation becomes at each elevation,
- what the forecast means for snowpack measured against that station's own history,
- at the US resorts, NOAA's modelled snowpack (SNODAS) at the resort's own elevation bands, as an opt-in alternative to stations that sit below the ski terrain.

**Resorts**

- Crystal Mountain, WA
- Snoqualmie / Alpental (The Summit at Snoqualmie), WA
- Stevens Pass, WA
- Whistler Blackcomb, BC
- Verbier / 4 Vallées, CH

Adding a resort is configuration alone: a resort entry (bands, model list, links) and its stations.

**Primary objectives**

- Consolidate ski-weather information into one dashboard.
- Compare global, regional high-resolution and ensemble models on one timeline.
- Track snow depth and snow water equivalent (SWE) against historical percentiles for the same station.
- Project snowpack 10–15 days ahead with an explicit, calibrated physical model.
- Show uncertainty honestly: model spread is labelled as spread until it is verified.
- Run at $0/month on public data and static hosting.

---

## 2. Design Decisions

These decisions shape everything below.

| Decision | Choice | Reason |
|---|---|---|
| Forecast source | Open-Meteo forecast, ensemble and single-run APIs, **snapshotted every 4 hours by the scheduled job**; the browser calls them directly only for what the snapshot lacks | Free for non-commercial use, CORS-enabled (`Access-Control-Allow-Origin: *`), no key. Covers every needed model. Open-Meteo rate-limits per IP, so visitors on shared networks (corporate VPN egress) get HTTP 429; normal visits therefore read the snapshot. No backend required for forecasts. |
| Snowfall | **Computed by PowderWatch's own physics**, not taken from providers | Open-Meteo's `snowfall` uses a fixed 7:1 snow-to-liquid ratio. Providers also split rain and snow differently. One method for all models makes differences meaningful. |
| Model ids | **Pure single-model ids** (`gfs_global`, `gem_global`, `icon_global`, …) | The `*_seamless` ids splice regional models in. For example, `gfs_seamless` is HRRR for the first 48 h in North America. That would double-count models in a blend and mislabel lines. |
| Run history | **Open-Meteo Single Runs API**, fetched on demand | Past runs are retrievable for about 5 months: runs from 2026-07-01 are available, runs from 2026-04-01 are not. Storm-evolution views therefore need no archive. |
| Observations | **Scheduled server-side fetch → static JSON** | BC ASWS, SLF and NWAC send no CORS headers. SNOTEL's API fails about half of requests at random. SLF's terms forbid per-end-user calls. |
| Modelled snowpack | **NOAA NOHRSC SNODAS at every band of the US resorts, as opt-in pseudo-stations** on the Snowpack tab, in the station file format; the scheduled job adds each day, and a manual workflow on GitHub's runners fills the history | The stations often sit well below the ski terrain (Stevens Pass SNOTEL is about 580 m below the summit). SNODAS models every 1 km cell of the lower 48 daily, so it gives an estimate at the bands themselves. It is model output, so it is labelled modelled everywhere, is never a default and appears only on the Snowpack tab. Each day is one file of up to 35 MB from NSIDC (no API, no CORS), so the browser reads a processed same-origin file and the Content-Security-Policy is unchanged; the history is 60–90 GB of downloads. |
| Snapshot cadence | **Every 4 hours** (six runs a day), with a per-run budget that always fits the first screens | Five resorts' first screens cost about 1,170 weighted calls a run (§8); eight runs a day would need about 9,400 of the free tier's 10,000 before any push or manual run. The global models update every 6 to 12 hours, so a 4-hourly snapshot still picks up every cycle. |
| Snoqualmie and Alpental | **One resort, with Alpental as its upper band** | The Summit's four base areas lie within 4 km of each other on one ticket, in one NWAC zone (Snoqualmie Pass) and near the same SNOTEL stations, and the 9–25 km global models cannot tell Alpental from Summit Central. What differs is elevation: Alpental runs from 3,140 to 5,420 ft, Summit West/Central/East from about 2,600 to 3,865 ft. Bands carry their own coordinates and elevations, so the summit band sits at Alpental's Top Station. A separate Alpental resort would repeat almost identical first screens for about 230 more weighted calls a run. |
| Hosting | **Static site on GitHub Pages**, built and deployed every 4 hours by a **scheduled GitHub Action** that also writes the forecast snapshot into the site (`data/fc/`, not committed) | One account, no secrets. The snapshot holds raw API responses; ensemble processing (212 members × 384 h) stays in the browser, so no server compute is needed. Netlify's free plan (300 credits/month, 15 per production deploy) cannot absorb 4-hourly deploys; Cloudflare Pages (500 deploys/month, free Access login) is the alternative if the site must be private. |

---

## 3. Core Features

### Feature 1 — Multi-Model Storm Tracker *(implemented)*

**Deterministic models per resort**

| Model | Centre | Grid | Range | Freezing level | Resorts |
|---|---|---|---|---|---|
| ECMWF IFS | ECMWF | 0.25° | 15 d | computed from pressure levels | all |
| ECMWF AIFS (AI model) | ECMWF | 0.25° | 15 d | computed | all |
| GFS | NOAA | 0.11–0.25° | 16 d | native | all |
| GEM global | ECCC | 15 km | 10 d | computed | all |
| ICON global | DWD | 13 km | 7.5 d | native | all |
| UKMO global | UK Met Office | 10 km | 7 d | computed | all |
| HRRR | NOAA | 3 km | 48 h | native | Crystal, Snoqualmie, Stevens, Whistler |
| HRDPS | ECCC | 2.5 km | 48 h | computed | Crystal, Snoqualmie, Stevens, Whistler |
| ICON-CH1 | MeteoSwiss | 1 km | 33 h | native | Verbier |
| ICON-CH2 | MeteoSwiss | 2 km | 5 d | native | Verbier |

**Ensembles** (all six at every resort)

| Ensemble | Members | Range | Freezing level |
|---|---:|---|---|
| ECMWF ENS | 51 | 15 d | not published (estimated) |
| AIFS ENS | 51 | 15 d | not published (estimated) |
| GEFS (`ncep_gefs_seamless`) | 31 | 16 d | native |
| GEPS | 21 | 16 d | native |
| ICON-EPS | 40 | 7.5 d | native |
| MOGREPS-G | 18 | 10 d | native |

Notes on the ensembles:

- GEFS uses `ncep_gefs_seamless`: 0.25° grid to day 10, then 0.5° to day 16.
- For ECMWF ENS and AIFS ENS, each member's freezing level is estimated from its downscaled temperature (6.5 °C/km).

**Official guidance** (benchmarks at Crystal, Snoqualmie and Stevens, behind one toggle)

| Benchmark | Source | What is shown | Range |
|---|---|---|---|
| NOAA NBM (`ncep_nbm_conus`) | NOAA, via Open-Meteo | NBM's own snowfall per local day (its calibrated ASNOW field, not PowderWatch physics), on its 2.5 km grid | about 11 days, hourly runs |
| WPC probabilistic winter precipitation | NOAA/NWS Weather Prediction Center, ArcGIS service | Chance of ≥ 4, 8 and 12 in in each of WPC's Day 1–3 periods at mid-mountain, as WPC's ranges: under 10%, 10–39%, 40–69%, 70% or more | Day 1–3, issued about 09Z and 21Z |

- Benchmarks are the provider's finished product, so they are the one exception to "one physics for all models". They never join the blend, the centre counts or any total, and they have no model colour slot.
- NBM is taken at the band's coordinates; its snowfall is not adjusted to the band's elevation.
- WPC publishes nested polygons per range (field `dn`: 1 Slight 10–39%, 2 Moderate 40–69%, 3 High 70–100%), so a resort gets the highest range its point falls in, and under 10% outside them all. Each WPC day is a 24 h period from 00Z (21Z issuance) or 12Z (09Z issuance), not a local calendar day.

Candidates not yet added:

- **AROME-France HD** (1.3 km; covers Verbier, but publishes no snowfall).

**Views**

- **Elevation bands:** base, mid and summit. Each band has its own coordinates and elevation for downscaling. At Snoqualmie the summit band is Alpental's Top Station.
- **Snowfall:** daily view or cumulative view (one line per model plus the blend).
  - Daily blend bars are shaded by amount on a six-step scale, with the day's total printed under each bar and one dot per model.
  - Rain at the band has its own aligned strip in a separate colour, because rain (mm) and snow (cm) cannot share an axis.
- **Confidence shown in the marks, not just the tooltips:**
  - Days with fewer than three forecast centres are outlined and shaded.
  - A day is flagged *split* when at least 25% of ensemble members give ≤ 1 in and at least 25% give ≥ 6 in. The tooltip shows both camps and how many members back each.
  - Totals of 7 days or more lead with the ensemble median and its 10–90% range, and warn when the blend leaves the range of the models that remain.
- **Precipitation type and wind:** under the bars, a strip shows snow, mixed or rain at each elevation band, plus the day's peak gust, flagged at 40 mph and above.
- **Run-to-run change:** a panel compares each global model's latest run with its run 12 hours earlier for the next 3 and 7 days. Run times show on screen, and runs initialised more than 18 h ago are flagged as stale.
- **Phones:** 8 days by default with a 16-day toggle; model chips, links and settings collapse, and the resort nav scrolls sideways.
- **Last 7 days, measured vs. modelled:** for every station, each column is the 24 h ending that morning.
  - Measured: new snow where the station reports it (SLF, MeteoSwiss); otherwise depth change plus water gained.
  - Modelled: the same physics applied to the models' short-range output at the station's location and elevation, which is the first step towards Phase 4 verification.
  - Source day boundaries are aligned to within about 6 h.
- **Freezing level vs. snow level:** the blended freezing level over a band spanning the lowest to highest of the models selected with the chips, the blended snow level (solid while precipitating), and horizontal rules at the resort's bands. An "Each model" toggle, off by default, adds each model's line in its colour.
- **Temperature** at the selected band: the blend over the same kind of band, with the same "Each model" toggle.
- **Model chips:** each chip toggles a model and shows its run time, publish delay and data horizon.
- **Compare with official guidance** (US resorts; off by default, `official=1` in the URL): the daily chart gains NBM's daily snowfall as a short dark bar on each day, with its own legend entry (and run time), a tooltip row and a table column; and a "WPC official chances" table follows "Chance of snow totals", with each WPC day's period in local time and the issue time. With the toggle off, nothing about either is shown or requested.
- **Totals:**
  - 24 h, 3, 7 and 14 days, each with the model range and the ensemble 10–90% range.
  - Snow level during precipitation over the next 72 h.
  - Rain at the band.
- **Ensemble outlook:**
  - Cumulative-snow plume with 10–90% and 25–75% bands.
  - Probability of at least 10/20/30/50 cm in 3/7/10 days.
  - Probability that the freezing level rises above mid-mountain or the summit.
- **Table view** of every daily value, for accessibility and for colours with low contrast.

### Feature 2 — Seasonal Snowpack Tracker *(implemented)*

The chart runs October to June for one station. It shows:

- the record min–max range;
- 10–90% and 25–75% percentile bands;
- the median;
- the current season;
- last season;
- the projection.

It can display either **snow depth or SWE**, wherever the station measures SWE.

**Modelled points (US resorts).** After the stations, the station picker lists NOAA SNODAS at each of the resort's bands ("Mid-mountain · 5,710 ft · modelled (SNODAS)"); the choice is kept in the URL (`station=`). The default is always a measurement station. With a SNODAS point:

- the headline tile reads "Modelled <date>", the chart title "Modelled snow depth at <resort> <band> (SNODAS)", and the legend and tooltip "This season (modelled)";
- the station line says in one sentence what SNODAS is, gives the 06:00 UTC valid time, and warns that a 1 km cell's terrain is not the band's elevation;
- the climatology compares the point only with its own SNODAS history, under the same rules as a station;
- until the history is backfilled, the chart shows this season alone with a "History not yet backfilled" note, and the tiles that need normals show "no SNODAS history yet".

Headline numbers:

- current reading and date;
- % of the median for that date;
- percentile rank;
- "typical for" date, with days ahead or behind normal;
- projected depth in 7 days, with its spread.

Climatology rules:

- One station's own record only. Resort-reported depths are never mixed in.
- A past season counts only if ≥ 80% of its Nov–May days are present. The current season never counts.
- Feb 29 is folded into Feb 28, so every season has 273 comparable days.
- Percentiles are computed per calendar day across seasons, then smoothed with a 7-day running mean.

### Feature 3 — Snowpack Projection *(implemented)*

- The projection starts from the station's latest reading. It is attempted only if that reading is no older than 5 days.
- It uses the station's measured SWE when available. Otherwise it uses a seasonal bulk density.
- From a SNODAS point it starts from the modelled depth and SWE, with forcing at the band's coordinates and elevation. Those requests are not in the snapshot: they are fetched live when a visitor picks the point.
- **Forcing is taken at the station's coordinates and elevation**, not the resort's. The projection therefore stays comparable with that station's history.
- The model runs once for every ensemble member (212 runs). The family-weighted 10th/50th/90th percentiles are shown.
- ECMWF, GFS, GEM, ICON and AIFS can be overlaid as labelled single-model scenarios.
- Days 10–15 are shaded as low confidence. The band is labelled as model spread, not as a confidence interval.

**Snowpack model** (layered, hourly):

- New snow arrives at fresh-snow density (Hedstrom & Pomeroy 1998). This is the same density that sets the snowfall ratio, so the forecast charts and the snowpack agree.
- Each layer's density relaxes exponentially toward a maximum. The maximum is higher when the snow is wet and under overburden. Settling slows as temperature drops.
- Melt uses a degree-day factor that varies by month, plus rain-on-snow melt. Rain drains through the pack but wets it.
- **Calibration and backtest** (`scripts/backtest-snowpack.ts`):
  - Test set: 1,355 ten-day cases from three Cascade SNOTEL stations, 2015–2026.
  - Forcing: observed SWE change plus ERA5 temperature, so only the depth physics is tested.
  - Fit on even-numbered seasons, scored on odd-numbered seasons.

  | Method (10-day depth change) | RMSE |
  |---|---:|
  | Persistence | 39.8 cm |
  | New SWE at a fixed 10:1, no settling | 91.2 cm |
  | Uncalibrated model | 18.7 cm |
  | Calibrated model | 17.7 cm |

  Real projections add precipitation-forecast error on top of this. The calibration is not yet validated for BC or the Alps.

### Feature 4 — Model-Run History *(implemented; verification pending)*

- Pick an elevation band, a target window (1–7 days) and models. By default the window is the wettest stretch in the next 10 days.
- PowderWatch fetches every 00Z/12Z run from the last 7 days that reaches the end of the window. Each run is processed with the same physics as live forecasts.
- **Trend chart:** window snowfall by run time, one line per model.
- **Storm evolution:** cumulative snowfall through the window for each run of the focus model. Older runs fade; the latest is boldest.
- **Run table:** lead time, snow, change vs. the previous run, water, and maximum freezing level.

Example (Whistler alpine, window 24–26 Nov, live on 2026-11-19):

| ECMWF IFS run | Window snowfall |
|---|---:|
| Nov 17 12Z | 102 cm |
| Nov 18 00Z | 41 cm |
| Nov 18 12Z | 40 cm |
| Nov 19 00Z | 98 cm |

The same period's GFS runs read 74 → 20 → 14 → 0 → 25 cm. A storm vanishing and reappearing between runs is exactly what this view is meant to expose.

*Still to build:* season-scale verification. Single-run retention is about 5 months, so it reads PowderWatch's own forecast archive (§6, Phase 4), which keeps every 00Z and 12Z cycle.

### Feature 5 — Freezing Level and Elevation Analysis *(implemented)*

- **Freezing level:**
  - Uses the model's own field where it publishes one.
  - Otherwise it is interpolated from pressure-level temperatures and geopotential heights (1000–500 hPa).
  - With a warm layer aloft, the top of the warm layer is used.
- **Snow level** is a separate quantity from the freezing level. It is the height where the wet-bulb temperature crosses 1 °C, which is the same threshold as the rain/snow split.
  - Without humidity aloft, it falls back to the freezing level minus 300 m.
  - In saturated air it typically sits 200–450 m below the freezing level. Example: Verbier on 2026-11-20, GFS freezing level 1,720 m, snow level about 1,540 m.
- **Rain/snow split at each band:**
  - Based on wet-bulb temperature (Stull 2011), from downscaled 2 m temperature and humidity.
  - All snow at or below 0 °C, all rain at or above 2 °C, linear in between.

### Feature 6 — Resort and Trip Dashboard *(implemented, except operating status)*

**Where & when grid:** every resort against the next 10 days on one shared colour scale. The best day per resort is starred, low-confidence days are outlined, and rain or mixed at the summit is marked.

**Resort cards:**

- station depth, % of median and percentile, labelled as a station, never as "base";
- the next 3 days' blended snowfall with the model range, and the next 7 days' ensemble median with its 10–90% range (the Storm tracker's mid ensembles, read from the snapshot only; the blend, labelled, when it has no copy under 4.5 hours old), each with the change since your last visit;
- the best day, the one the Where & when grid stars.

The day-by-day numbers live in the grid alone; the Storm tracker has the snow level and the last 7 days measured.

**Trips** (saved in browser localStorage only):

- **Within 14 days:** expected new snow from 2 days before arrival to the last day, snow level, and a confidence label by lead time.
- **Further out:** the station's median depth for the trip dates.

**Links:** official snow report, webcams, lift status, avalanche bulletins (NWAC zone forecasts, Avalanche Canada, SLF), NWAC weather-station pages and the national weather service.

**Operating and terrain status:** **no free machine-readable feed exists** for any of the five resorts.

- Whistler and Stevens Pass (both Vail) and Crystal pages block non-browser clients; Stevens Pass answers scripted requests with an error page and HTTP 200.
- Summit at Snoqualmie shows lift and trail status only on its mountain-report page, filled in by the browser.
- Liftie is behind a Cloudflare challenge.
- Verbier's live-information page is server-rendered HTML that could be scraped, but it has no API and no reuse terms.

These remain links.

---

## 4. Forecast Blending Strategy

**A. Individual models.** Every model goes through the same physics. Regional models appear only within their range.

**B. Family-balanced blend** (default):

- Each forecast centre present in a given hour gets equal weight: ECMWF, NOAA, ECCC, DWD, UKMO and MeteoSwiss.
- A centre's weight is split equally among its models that have data that hour. ECMWF IFS and AIFS share ECMWF's weight; HRRR shares NOAA's with GFS.
- **Snow and rain use the weighted mean**, so daily and cumulative totals agree.
- **Temperature, freezing level and snow level use the weighted median**, which resists a single outlier model.
- Membership changes with lead time. Beyond about day 10 only ECMWF and NOAA remain, so the 14-day blend can exceed every model that covers the full 14 days. The totals tile shows the model count for each window.

**C. Ensemble probabilities:**

- Six ensembles from five centres: 212 members in total.
- Weights are equal per centre and equal per member within a centre.
- A member counts towards a window only if it covers the whole window.
- The plume stops when fewer than three centres remain.
- Results are labelled as model spread, not calibrated probability.

**Next step (Phase 4):** weight models by skill at each band and lead time, from the archive. Calibrate ensemble probabilities with reliability diagrams and rank histograms.

---

## 5. Data Sources

### Forecasts

| Need | Source | Notes |
|---|---|---|
| Deterministic models | `api.open-meteo.com/v1/forecast` | Downscaled with `elevation` (lapse rate; RH held constant). |
| Pressure levels | same | Seven levels from 1000 to 500 hPa. ECMWF has no 800 hPa level. |
| Ensembles | `ensemble-api.open-meteo.com/v1/ensemble` | Member keys: `var`, `var_member01…`. |
| NOAA NBM (benchmark) | `api.open-meteo.com/v1/forecast?models=ncep_nbm_conus` | CONUS only. `snowfall` is NBM's own ASNOW (cm), `snowfall_height` its SNOWLVL (m); hourly to 36 h, 6-hourly sums after that, spread over the hours by Open-Meteo. Hourly runs; run timing at `data/ncep_nbm_conus/static/meta.json`. 1 weighted call per request. |
| Past runs | `single-runs-api.open-meteo.com/v1/forecast?run=…` | Retention about 5 months. Requests for runs that aren't published yet return HTTP 400. |
| Run timing | `api.open-meteo.com/data/<id>/static/meta.json` | Initialisation time, availability time and update interval. |
| WPC winter chances (benchmark) | `mapservices.weather.noaa.gov/vector/rest/services/precip/wpc_prob_winter_precip/MapServer` | Layers 1–3, 6–8 and 11–13: Day 1/2/3 chance of ≥ 4/8/12 in, as polygons with `dn`, `outlook`, `issue_time`, `start_time`, `end_time` (UTC). Queried by the scheduled job only (a point query per layer and resort, plus each layer's distinct times); the service sometimes answers 504 or an empty body, so requests are retried. |
| Previous runs (archive backfill) | `previous-runs-api.open-meteo.com/v1/forecast` | `<var>_previous_day1…7`: each hour as forecast 1–7 days earlier, at fixed 24 h lead offsets (so one day mixes runs). Deterministic models only, archived from January 2024. Used once, by `npm run backfill:verification`. |
| Reanalysis (backtests) | `archive-api.open-meteo.com/v1/archive` | ERA5. |

### Snow observations

| Resort | Station (source) | Elev. | Depth / SWE record | Access |
|---|---|---|---|---|
| Crystal | Morse Lake 642 (SNOTEL) | 1,646 m | depth 2005→ / SWE 1978→ | AWDB REST, CORS, flaky |
| Crystal | Corral Pass 418 (SNOTEL) | 1,771 m | 2006→ / 1981→ | same |
| Crystal | Cayuse Pass 1085 (SNOTEL) | 1,603 m | 2006→ / 2006→ | same |
| Snoqualmie | Olallie Meadows 672 (SNOTEL) | 1,222 m | 2003→ / 1982→ | same; 3 km from mid, same drainage as Alpental and Summit West |
| Snoqualmie | Tinkham Creek 899 (SNOTEL) | 914 m | 2005→ / 1993→ | same; base-area elevation, Cedar River headwaters |
| Snoqualmie | Stampede Pass 788 (SNOTEL) | 1,173 m | 2002→ / 1982→ | same; 16 km SSE, a separate pass in the Green River drainage |
| Stevens | Stevens Pass 791 (SNOTEL) | 1,201 m | 2002→ / 1980→ | same; beside the base area, about 580 m below the summit |
| Stevens | Fish Lake 478 (SNOTEL) | 1,049 m | 2000→ / 1983→ | same; 22 km S, east of the crest (Cle Elum River headwaters) |
| Whistler | Whistler Roundhouse 1108906 (ECCC) | 1,835 m | depth 1980→2026-09 | GeoMet OGC API, CORS. **Silent since 2026-09-23.** |
| Whistler | Callaghan Creek 3A20P (BC ASWS) | 1,017 m | 2018→ / 2018→ | wide CSVs, no CORS |
| Whistler | Squamish River Upper 3A25P (BC ASWS) | 1,387 m | 2003→ / 1989→ | same; 36 km west |
| Whistler | Callaghan Valley 1101300 (ECCC) | 884 m | 2005→ | GeoMet, CORS |
| Verbier | Lac des Vaux ATT2 (SLF IMIS) | 2,550 m | 1993→ | daily CSV + 7-day API, no CORS. Inside the ski area. |
| Verbier | Combatzeline NEN3 (SLF IMIS) | 2,203 m | 2010→ | same |
| Verbier | Fionnay FIO (MeteoSwiss, manual) | 1,500 m | 2008→, gappy | OGD CSV, CORS |

- Lyman Lake 606 (SNOTEL, 1,826 m) has a long record but sits 52 km from Stevens Pass in the Lake Chelan drainage, so it is not used.
- **Band elevations** for the two Washington additions:

  | Resort | Base | Mid | Summit | Source |
  |---|---|---|---|---|
  | Snoqualmie / Alpental | 896 m (2,940 ft), Summit Central base | 1,178 m (3,865 ft), top of Summit Central | 1,652 m (5,420 ft), Alpental Top Station | Operator trail maps (Summit Central top, Alpental Top Station); USGS 3DEP for the Central base, which the operator does not publish |
  | Stevens Pass | 1,238 m (4,061 ft) | 1,480 m (4,853 ft), top of Hogsback Express | 1,782 m (5,845 ft), Cowboy Mountain | Operator mountain stats (base, highest point); USGS 3DEP for mid |
- **NWAC** has on-site stations at Crystal, Alpental, Snoqualmie Pass and Stevens Pass, but no public API and no stated licence. Data before the current water year isn't accessible, and its CSV export sits behind Turnstile. NWAC is linked, not ingested.
- **Licences:**
  - NRCS: US federal data.
  - ECCC: ECCC Data Servers End-use Licence (credit: "Data Source: Environment and Climate Change Canada").
  - BC: OGL-BC.
  - SLF: CC BY 4.0, credited "WSL Institute for Snow and Avalanche Research SLF".
  - MeteoSwiss: CC BY 4.0, credited "Source: MeteoSwiss".
  - Open-Meteo: CC BY 4.0, non-commercial use, fewer than 10,000 calls a day.
  - NOAA NBM and WPC: US federal government data, credited "NOAA National Blend of Models" and "NOAA/NWS Weather Prediction Center".
  - SNODAS: US government data distributed by NSIDC, which requires its citation as a condition of use (in `public/data/NOTICE.md`, the footer and the Methods page): National Operational Hydrologic Remote Sensing Center. (2004). Snow Data Assimilation System (SNODAS) Data Products at NSIDC. (G02158, Version 1). [Data Set]. Boulder, Colorado USA. National Snow and Ice Data Center. https://doi.org/10.7265/N5TB14TC.
- **What counts as "daily"** differs by source, and each station records its own:
  - SNODAS: the model state at 06:00 UTC (10 pm PST the evening before).
  - SNOTEL: midnight PST.
  - ECCC: the morning observation.
  - BC: median of the hourly readings for each PST day.
  - SLF: daily value.
  - MeteoSwiss: the 06 UTC reading.

### Modelled snowpack (SNODAS)

NOAA NOHRSC's Snow Data Assimilation System runs a physically based snowpack model on a 30-arc-second grid, driven by downscaled weather-model forcing (RAP and HRRR since 2018) and updated toward satellite, airborne and ground snow observations once a day. NSIDC archives it as data set G02158. Sources: NSIDC's user guide for G02158 v1 and the files' own headers.

| Property | Value |
|---|---|
| Files | `noaadata.apps.nsidc.org/NOAA/G02158/masked/YYYY/MM_Mon/SNODAS_YYYYMMDD.tar`, public HTTPS without login; posted about 14:00 UTC the same day; 1.2–35 MB. Each holds eight gzipped grids and their gzipped text headers. |
| Products used | 1036 snow depth and 1034 SWE (`us_ssmv11036tS__T0001TTNATS<date>05HP001`): the state at 06:00 UTC. |
| Grid | Masked lower 48: 6,935 columns × 3,351 rows, 0.008333° (30″) spacing, WGS 84, read across rows from the north-west corner. The header's `Minimum x-axis` / `Maximum y-axis coordinate` are the outer edges of the west column and north row; the `Benchmark` coordinates are the north-west cell's centre. |
| Grid change | On 2013-10-01 the grid moved 5% of a cell east and north: before, edges at −124.73375° and 52.874583°; from then, −124.733333° and 52.875°. Each file's own header places the cells, and all nine resort points (and the three SNOTEL cells below) fall in the same cell in both eras. |
| Values | 16-bit signed big-endian integers; `Data units: Meters / 1000`, slope 1, intercept 0, so integers are millimetres. −9999 is no data; 32,767 is a clipped value (SWE ≥ 32.767 m, an artefact at some high-elevation cells). Both are dropped, as are depths over 1,500 cm and SWE over 5,000 mm. |
| Record | Masked files from 2003-09-30; NSIDC discourages data before October 2004, when routine assimilation began, so the backfill starts with the 2004–05 season. NSIDC lists 18 masked days with no file (a 404, skipped) and two whose SWE grid is missing or all zeros (2003-10-30, 2005-07-31, both outside the backfilled seasons; a tar lacking one product still gives the other). Header files were renamed from `.hdr` to `.txt` in 2019; the reader accepts both. |
| Known artefacts | From 2014-10-09 to 2019-10-10, 126,950 cells along coasts and lakes hold erroneous zeros (before that, no data). The nine resort cells hold valid values in 2004 and 2012, so they are not among them. |

**Reading it.** `scripts/snodas.ts` streams a day's tar, keeps only the depth and SWE members (1–8 MB gzipped each), parses each header and reads the wanted cells while decompressing, so no grid is ever written to disk or held whole; the download stops once both products are in. A point's cell is `floor((lon − minX) / dx)`, `floor((maxY − lat) / dy)`, with cells half-open (a point on a boundary belongs to the cell east or south of it).

**Spot comparison with SNOTEL** at the stations' own cells (SNODAS 06 UTC minus the station's midnight reading on the same date). SNODAS assimilates ground observations, so agreement at these cells is not an independent test:

| Date | Morse Lake 642 depth / SWE | Olallie Meadows 672 depth / SWE | Stevens Pass 791 depth / SWE |
|---|---|---|---|
| 2012-02-15 | +2 cm / −3 mm | +33 cm / −9 mm | −5 cm / +1 mm |
| 2017-02-15 | +30 cm / −10 mm | +53 cm / −96 mm | +16 cm / +5 mm |
| 2025-02-15 | −44 cm / −39 mm | 0 cm / −19 mm | −13 cm / −21 mm |
| 2026-11-15 to 18 | −7 to −18 cm / −64 to −67 mm | 0 to −5 cm / −3 to +1 mm | 0 to +0.2 cm / 0 mm |

In mid-winter SWE agrees within 0–10% at all three stations, and depth less closely (−44 to +53 cm). In the season's first weeks SNODAS holds far less water than Morse Lake reports (5–10 mm against 71–76 mm). On 2004-02-29, before routine assimilation, it differs by −30 to +24 cm and −57 to +79 mm, and it gives 489 cm at Crystal's mid band, against 221 cm at the base and 274 cm at the summit.

---

## 6. Technical Architecture

```
Browser (React + TypeScript + ECharts, static on GitHub Pages)
  ├── cachedJson(url): one path for every Open-Meteo request, keyed by request URL
  │     1. memory / IndexedDB copy within its TTL (live forecasts 30 min, past runs forever)
  │     2. /data/fc/ snapshot copy younger than 4.5 h (manifest read once per page)
  │     3. Open-Meteo forecast / ensemble / single-run APIs (direct, CORS; ≤ 4 concurrent,
  │        on-screen requests first; 429/5xx retried twice)
  │     4. if that fails: the newest older copy (stale snapshot or stale cache)
  ├── physics.ts     phase split, snow ratio, freezing level, snow level
  ├── forecast.ts    per-model products, local-day totals, blend
  ├── ensemble.ts    plumes, exceedance probabilities
  ├── snowpack.ts    layered snowpack model
  ├── climatology.ts percentiles by season day
  ├── /data/obs/*.json  station series and SNODAS pseudo-station series (static, committed by the workflows)
  └── /data/fc/*.json   forecast snapshot + manifest.json (static, deployed by the scheduled job, never committed)

GitHub Action (every 4 h at :20 UTC, full station history in the Sunday 00:20 run, and on push)
  refresh: npm run obs (+ new SNODAS days) → commit (write, no npm): validate_obs.py → public/data if changed
  → build (read-only): test → vite build → npm run snapshot (dist/data/fc/, + verification record) → deploy-pages
                                                                        └→ archive (write, no npm): data/verification branch

GitHub Action backfill-snodas (manual only)
  plan (no token): seasons from the inputs → extract (read-only, one job per season, two at a time): SNODAS cells
  → commit (write, no npm): validate_obs.py --backfill merges into public/data/obs → one commit to main
```

- **SNODAS ingest:**
  - **Daily:** `npm run obs` looks at the last 10 days and fetches each day that no SNODAS point has yet. One file serves all nine points, so a run downloads at most a file or two, and a day not yet posted is one 404. The weekly full refresh doesn't apply to SNODAS.
  - **History:** `backfill-snodas.yml`, run by hand. `plan` checks `first_season` and `last_season` (passed through `env`) and lists the seasons. `extract` runs `npm run backfill:snodas -- --season <year> --skip-existing --deadline-min 130` for each season, at most two at a time, one request at a time each, with a User-Agent carrying `PW_CONTACT`, retries with backoff (2 s doubling to 60 s) and a 404 counted as missing. It skips days `main` already has and uploads a `snodas-<season>` artifact of station files, also after a failure or at its deadline. `commit` (`contents: write`, no npm code) runs `validate_obs.py --backfill` on the artifacts and pushes one commit to `main`, starting again from the new `main` if a scheduled commit landed in between.
  - **Validation:** `scripts/validate_obs.py` is the validator of both commit jobs: file names that already exist on `main`, the station-file keys, ISO dates, equal-length series, finite values within bounds, 2 MB per file, re-serialised. SNODAS files are merged day by day with `main`'s copy (incoming values win, every other day is kept), so a scheduled refresh that read the files before a backfill commit can't drop the history, and merging a season twice changes nothing.

- **Forecast snapshot** (`scripts/snapshot-forecasts.ts`, `npm run snapshot`):
  - Fetches the Open-Meteo responses the first screens request and writes them unmodified to `dist/data/fc/`, with `manifest.json` mapping each request URL to `{file, fetchedAt}`. File names hash the URL and the content, so each file is immutable; the manifest is fetched with `no-cache`.
  - **URL parity:** the browser and the script build every URL with the same pure functions (`src/lib/openmeteo.ts` for parameters, `src/lib/requests.ts` for points, model lists and day counts). A unit test replays the views' requests and requires the planned list to match exactly.
  - **Contents, per resort:** the deterministic forecast for all three bands; the pressure profile and all six ensembles at mid-mountain; run timing for every model; the run 12 h before each global model's latest run, at mid (run-change panel); NOAA NBM at mid for the three US resorts ("Compare with official guidance", and archived); the last-7-days requests at each station and at mid; and the snowpack-projection inputs (six ensembles and the single-model scenarios, with the `past_days` that station's latest reading implies) at the station the Snowpack tab opens by default, then at the other stations while the budget allows (§8). When a resort's local date changes within the next 4.5 h, the next day's snowpack variant is included too.
  - **Live only:** Run-history past runs, ensembles at base and summit, and NBM at base and summit.
  - **WPC chances:** the same run queries WPC's service (36 small requests to NOAA, no Open-Meteo cost) and writes `wpc-<hash>.json` next to the snapshot, named by the manifest's `wpc` entry. The browser reads only that same-origin file, so it never calls NOAA and the Content-Security-Policy is unchanged. A failed query leaves its cell unknown; if nothing usable came back, the run writes no file and the table says so.
  - **Freshness:** a copy serves for 4.5 h after it was fetched (`SNAPSHOT_MAX_AGE_S`). The job runs every 4 h (`SNAPSHOT_INTERVAL_H`), so a scheduled run delayed by more than about 30 minutes leaves a gap that is served live.
  - **Politeness:** User-Agent with a contact URL (`PW_CONTACT`), at most 3 concurrent requests, paced under 400 weighted calls a minute (free tier: 600), 429/5xx retried with backoff and `Retry-After`, and a per-run budget in weighted calls.
  - **Failure handling:** a failed request is left out of the manifest and the browser fetches it live. The snapshot step cannot block the deploy: it has a 7-minute internal deadline, a 9-minute step timeout and `continue-on-error`.
  - The Content-Security-Policy is unchanged: `connect-src 'self'` covers the snapshot and the WPC file, and NBM comes from `api.open-meteo.com`, which it already allows.

- **Verification archive** (`scripts/verification.ts`, branch `data/verification`):
  - **Which runs:** every snapshot run names the newest 00Z or 12Z cycle that all current global models have run, from the run metadata it already fetches (the cycle hours are the model catalogue's full-length runs; a model more than one cycle behind is listed as lagging rather than holding the cycle back). It writes that cycle's record, and the `archive` job keeps the first record it sees for each cycle and never overwrites it. So each cycle is archived from the first snapshot run that carried it; which run that is depends on when the slowest global model publishes.
  - **What:** for local days 1–10 (day 1 is the first local day starting after the cycle time; days follow `toDaily`'s convention), at each resort's mid band the blend (with its daily centre count) and each model, and at each station's own point each snowpack-scenario model: daily snowfall through PowderWatch physics, precipitation (negative hourly values, an artefact of some models' de-accumulated output, count as none, as in the rain/snow split), rain, Tmin/Tmax and snow-level range (from the resort's pressure profile, as in the views). At the US resorts' mid band, NBM's own snowfall, precipitation, Tmin/Tmax and snow level, and WPC's Day 1–3 categories with their periods, too. Ensembles at both: daily p10/p50/p90 of snowfall and precipitation, the chance of each "Chance of snow totals" threshold (1, 4, 8, 12, 20 in) per day, and the same over 3, 7 and 10 days from day 1. Plus each model's run time and the stations skipped and why. A day counts only when every hour of it has data.
  - **No extra Open-Meteo calls:** the record reuses the snapshot's responses. Station points come from the Snowpack tab's requests, so a station is archived only when this run's snapshot holds them; a station whose latest reading is too old for a projection (`no-projection`), or whose requests the run skipped for budget (`not-in-snapshot`), is listed in `skipped`. Ensemble run times are not in the snapshot and are not recorded.
  - **Format:** one JSON file per cycle, `cycles/YYYY-MM/2026-11-20T00Z.json`, about 40–60 kB (10–14 kB gzipped), two a day: 30–45 MB a year as JSON, about a quarter of that as git stores it. Per-cycle files are append-only by construction (a new file per cycle, none ever edited), need no merge, and let the archive job keep the first run's record by checking whether the file exists.
  - **Path:** the read-only `build` job writes the record to `.cache/verification/` (never into `dist/`) and uploads it as an artifact (kept 7 days, so a failed archive job can be re-run). The `archive` job holds `contents: write` and runs no npm code: it copies `scripts/validate_verification.py` from `main`, switches to `data/verification` (an orphan branch, created on first use), validates the record (allowed key set, finite bounded numbers, 512 kB cap, strict file names) and re-serialises it, then commits and pushes to that branch only. Deploy does not depend on it.
  - **Backfill:** `npm run backfill:verification` reads the Previous Runs API for 2026-10-01 to 2026-11-19 at the 14 stations that reported in that window (Whistler Roundhouse is silent): 535.5 weighted calls, one request per station. Its records (`backfill/YYYY-MM/<date>.json`) hold, for each valid local date and scenario model, the day as forecast 1–7 days earlier; there are no ensembles or snow levels, and each hour comes from the run 24 h × lead before it rather than from one cycle.

- **Frontend:** React 19, Vite 8, Tailwind 4, ECharts 6 (SVG renderer). The bundle is about 280 kB gzipped, mostly ECharts.
- **Charts:**
  - One categorical colour per model, fixed and never re-assigned by rank. The palette is validated for colour-vision deficiency in light and dark modes.
  - Light and dark modes are designed separately, not auto-inverted.
  - Every chart has a crosshair tooltip and a table or text alternative.
  - Never two y-axes on one chart.
- **No D1, Workers or R2.** The verification archive is JSON files on the repository's `data/verification` branch, so `main` does not grow.
- **Tests:** Vitest covers the physics, statistics, climatology, snowpack and time-zone logic, snapshot URL parity and the cache's snapshot freshness and fallback, the SNODAS reader (cell indexing and its edge cases, scaling, header checks, and the tar and gzip path on a synthetic grid) and `validate_obs.py`, including its SNODAS merge. Run `npm test`.

---

## 7. Development Roadmap

| Phase | Scope | Status |
|---|---|---|
| 1 — Forecast dashboard | Multi-model snowfall, bands, freezing/snow level, temperatures, ensembles, run timing | **Done** |
| 2 — Snowpack tracker | Station history, percentiles, previous season, depth/SWE; SNODAS modelled points at the US resorts' bands | **Done** (SNODAS history pending its backfill run) |
| 3 — Snowpack projection | Layered model, ensemble spread, scenarios, backtest | **Done** (Cascades calibration) |
| 4 — Verification | See below | Archive running; analysis next |
| 5 — Personalization & alerts | See below | Trips done |

**Phase 4 — Verification**

1. **Archive** (done): every 00Z and 12Z cycle's day-1 to day-10 forecasts at each resort's mid band and each station's own point, with ensemble quantiles and chances, on the `data/verification` branch (§6). Backfilled from 2026-10-01 with the Previous Runs API (days 1–7, deterministic only).
2. Verify against observations:
   - Precipitation: SNOTEL and BC ΔSWE.
   - Snowfall: SLF `HN_1D`, MeteoSwiss `hns000d0` and ECCC/BC Δdepth.
3. Report bias and MAE by model, band and lead time. Weight the blend by skill.
4. Produce ensemble reliability diagrams and calibrate the probabilities.
5. Run the snowpack backtest for BC (3A20P, 3A25P) and for ATT2 using depth-only forcing.

**Phase 5 — Personalization & alerts**

Done: trips; NOAA NBM and WPC winter chances as opt-in benchmarks ("Compare with official guidance").

Next:

- Alerts through a scheduled job: storm totals over a threshold, the snow level crossing the summit, or a run-to-run jump bigger than X.

**Success criteria (measurable):**

- **Phase 1:** a user can tell from the Storm tracker in under 30 seconds whether models agree and whether precipitation is snow at the chosen band.
- **Phase 3:** 10-day projected depth change has an RMSE below persistence on held-out seasons with *forecast* forcing (not only observed forcing).
- **Phase 4:** at least one full season of archived forecasts. Blend MAE at least 10% better than the median single model at days 1–3, or the blend is changed.

---

## 8. Cost Considerations

| Component | Monthly cost |
|---|---:|
| GitHub Pages (static, public repo) | $0 |
| GitHub Actions (4-hourly job; the snapshot step takes about 3 min) | $0 for a public repo |
| Open-Meteo | $0 under non-commercial terms |
| Station data | $0 |
| NSIDC SNODAS (a file a day; the one-time history backfill runs on GitHub's runners) | $0 |
| Domain | optional |

- **Open-Meteo budget** (as of 2026-11-20, five resorts):
  - Open-Meteo counts weighted calls: variables × models (× members, for ensembles) ÷ 10, scaled by days ÷ 14 beyond two weeks, at least 1 per request. Each response reports its cost in `X-RateLimit-Cost`, and `estimateCost` in `scripts/snapshot-plan.ts` reproduces it. Free tier: under 10,000 a day, 5,000 an hour and 600 a minute.
  - Requests carry only the variables their view uses: six surface variables for the forecast views; temperature, humidity and precipitation alone for the last-7-days panel and the snowpack scenarios; no freezing level in the snowpack ensembles.
  - Typical costs: the six ensembles at mid, about 97 calls; the snowpack ensembles at a station, about 77–82 (1–2 past days); a band's deterministic forecast (8 models), 5.5; a pressure profile, 19.2; a last-7-days request, 2.4; a snowpack scenario request, about 1.9; a single past run, 1; NOAA NBM at a point, 1; run metadata, 0.
  - **First screens** (every band's forecast, mid ensembles and profile, run change, NBM at the US resorts' mid band, last 7 days, the default Snowpack station): about 1,170 calls a run for five resorts. The 04:20 UTC run needs about 1,500, because its snapshot is still served after Pacific midnight and so also carries the next day's snowpack inputs for the four Pacific resorts.
  - **Schedule and budget:** six scheduled runs a day. Each run's budget is 1,250 calls (`SNAPSHOT_MAX_COST`, a sixth of 7,500), raised by `runBudget` to fit the first screens and never above 2,000. What is left after the first screens buys other stations' snowpack inputs. Planned total: about 7,500 calls a day (the plan's simulation of the six scheduled runs: 7,511, of which NBM is 18; a test keeps it under 9,000 with the first screens in every run). A push or manual run adds about 1,200–1,500, so one a day keeps the total under 10,000.
  - **One snapshot run** (measured 2026-11-20 01:53 UTC): 151 Open-Meteo requests, no retries or failures, 19.8 MB, 1,236.4 weighted calls (`X-RateLimit-Cost`, equal to the estimate), 184 s. First screens took 1,152.7 of those, NBM 3 of them; the rest bought one more station (Corral Pass), and eight lower-priority snowpack groups were skipped. WPC took 36 requests to NOAA; one failed after retries, a layer's distinct-times query, so no cell was left unknown. The verification record it wrote (cycle 2026-11-19T12Z, 11 points, 9 stations skipped) is 44.6 kB, 10.4 kB gzipped.
  - Full coverage would cost about 1,900–2,900 calls a run, mostly snowpack inputs at up to 15 stations (about 77–88 calls each, twice near a local midnight).
  - **Visitors:** with a fresh snapshot, the dashboard, the Storm tracker at mid (including the lazy panels), the last 7 days and the default Snowpack station make no Open-Meteo calls. Live calls remain for Run history (about 40 small requests per cold load), base/summit ensembles (6 requests, about 97 calls), other snowpack stations (7 requests, about 80 calls), and anything once the snapshot is older than 4.5 h. These count against the visitor's own IP, not the job's. Live forecasts are cached for 30 minutes and past runs indefinitely.
- **NSIDC SNODAS:** one file of up to 35 MB a day from the scheduled job (each download stops once the depth and SWE members are in). The history backfill is about 6,300 files, 60–90 GB, in up to 23 runner jobs of a few minutes to two hours each, two at a time; public repositories don't pay for runner minutes. No key and no stated quota.
- **NOAA WPC:** 36 requests a run to NOAA's ArcGIS service (9 distinct-times queries and 27 point queries), at most 3 at a time; no key and no stated quota.
- **Single-provider risk:** all model forecast data comes through Open-Meteo. The fallback is NOAA NOMADS and ECMWF open data, which means GRIB processing on a server. That is out of scope unless Open-Meteo becomes unavailable.

---

## 9. Key Technical Challenges

| Challenge | Mitigation in place | Remaining |
|---|---|---|
| Global models smooth terrain | Regional 1–3 km models within range; downscaled temperature per band; station-based verification planned | Precipitation bias correction needs Phase 4 data |
| Provider snowfall inconsistent | One phase/ratio method for all models; Open-Meteo raw 7:1 available as a toggle | Ratio not yet verified against HN observations |
| Snow depth ≠ cumulative snowfall | Layered settling/melt model, calibrated (17.7 cm 10-day RMSE held out) | BC and Alpine calibration; wind redistribution ignored |
| Spread ≠ probability | Labelled as spread; equal centre weights; coverage rules | Reliability calibration (Phase 4) |
| Changing blend membership with lead time | Model counts shown; ensemble plume stops below three centres | Optional fixed-membership blend for days 10–15 |
| Station gaps and silence | Coverage threshold, gap filling of ≤ 2 days, preference order with automatic fallback, caveats in the UI | Whistler Roundhouse may never resume |
| Stations sit below the ski terrain | SNODAS modelled points at each US band, opt-in and labelled modelled | SNODAS's bias at the bands is unknown: no measurements exist there, and the SNOTEL spot comparison (§5) is not independent. No equivalent for Whistler or Verbier |
| Flaky or unfriendly sources | Server-side fetch with backoff, previous file kept on failure, on-disk cache for BC archives | NWAC stays link-only unless a licensed feed appears |
| Long-range reliability | Days 10–15 shaded low confidence; run history exposes flip-flopping | — |

---

## 10. Product Design Principles

- **Transparency over false precision.** Every number traces to a visible method (see the in-app Methods page), and spread is shown with every total.
- **Observed data first.** Station measurements anchor snowpack charts, and each station is compared only with its own history.
- **Model-independent architecture.** Adding a model is one catalogue entry: id, family, colour slot, range. Adding a resort means bands, a model list and stations.
- **Elevation-aware.** Base, mid and summit are separate forecasts, and snow level is compared with each.
- **Decision support.** The dashboard leads with what matters: how much snow, whether models agree, whether it will rain up high, and how the trip looks.
- **Personal use first.** No accounts and no backend database. Trips stay in the browser.

---

## 11. Deliverable

A responsive static web app with:

1. **Dashboard** — resort cards and trips.
2. **Storm tracker** — models, blend, freezing/snow level, temperature and ensembles.
3. **Run history** — how the forecast for a chosen window evolved, run by run.
4. **Snowpack** — season chart against percentiles, with the ensemble projection and scenarios.
5. **Methods** — the exact physics and parameters in use.

Run locally with `npm run preview` (127.0.0.1:4173). The included GitHub Action deploys to GitHub Pages every 4 hours, with a fresh forecast snapshot.

---

## 12. Open Decisions

- **Deployment visibility.** GitHub Pages on a free account is public, and so is the repository. The content is public weather data, and trips never leave the browser. Moving to Cloudflare Pages + Access is a workflow swap if privacy is needed later.
