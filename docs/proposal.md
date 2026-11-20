# PowderWatch
### Personal Ski Forecasting & Snowpack Analytics Platform

**Project Proposal — Revision 3, 20 November 2026**

**Status (as of 2026-11-20):** Phases 1–3 are implemented for five resorts. Phase 4 (verification) has its forecast archive: two records a day on the `data/verification` branch, and a one-time backfill from 2026-10-01; the verification analysis is still to build. Phase 5 (alerts and personalization) is partly done: trips exist, alerts do not.

---

## 1. Project Overview

PowderWatch is a personal ski-forecasting dashboard. It combines many weather models, run-to-run forecast history and measured mountain snowpack in one transparent interface.

It is not a single snowfall number. It shows:

- how models disagree,
- how their forecasts change from run to run,
- what precipitation becomes at each elevation,
- what the forecast means for snowpack measured against that station's own history.

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

Candidates not yet added:

- **NBM** (NOAA's calibrated National Blend; covers Crystal) as a reference line.
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
- **Freezing level vs. snow level:** freezing level per model, blended snow level, and horizontal rules at the resort's bands.
- **Temperature** at the selected band, per model.
- **Model chips:** each chip toggles a model and shows its run time, publish delay and data horizon.
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
- **Dashboard flag:** "rain risk up high" when the 72-hour snow level comes within 100 m of the summit band.

### Feature 6 — Resort and Trip Dashboard *(implemented, except operating status)*

**Where & when grid:** every resort against the next 10 days on one shared colour scale. The best day per resort is starred, low-confidence days are outlined, and rain or mixed at the summit is marked.

**Resort cards:**

- station depth, % of median and percentile, labelled as a station, never as "base";
- blended snowfall at 3, 7, 10 and 14 days, each with the model range;
- a 7-day mini forecast on a shared scale (bars shaded by amount, rain flagged), the last 7 days measured at the station, and changes since your last visit;
- a model-agreement label;
- the next day with at least 10 cm (4 in);
- the 72-hour snow-level range.

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
| Past runs | `single-runs-api.open-meteo.com/v1/forecast?run=…` | Retention about 5 months. Requests for runs that aren't published yet return HTTP 400. |
| Run timing | `api.open-meteo.com/data/<id>/static/meta.json` | Initialisation time, availability time and update interval. |
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
- **What counts as "daily"** differs by source, and each station records its own:
  - SNOTEL: midnight PST.
  - ECCC: the morning observation.
  - BC: median of the hourly readings for each PST day.
  - SLF: daily value.
  - MeteoSwiss: the 06 UTC reading.

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
  ├── /data/obs/*.json  station series (static, committed by the scheduled job)
  └── /data/fc/*.json   forecast snapshot + manifest.json (static, deployed by the scheduled job, never committed)

GitHub Action (every 4 h at :20 UTC, full station history in the Sunday 00:20 run, and on push)
  refresh: npm run obs → commit: public/data if changed
  → build (read-only): test → vite build → npm run snapshot (dist/data/fc/, + verification record) → deploy-pages
                                                                        └→ archive (write, no npm): data/verification branch
```

- **Forecast snapshot** (`scripts/snapshot-forecasts.ts`, `npm run snapshot`):
  - Fetches the Open-Meteo responses the first screens request and writes them unmodified to `dist/data/fc/`, with `manifest.json` mapping each request URL to `{file, fetchedAt}`. File names hash the URL and the content, so each file is immutable; the manifest is fetched with `no-cache`.
  - **URL parity:** the browser and the script build every URL with the same pure functions (`src/lib/openmeteo.ts` for parameters, `src/lib/requests.ts` for points, model lists and day counts). A unit test replays the views' requests and requires the planned list to match exactly.
  - **Contents, per resort:** the deterministic forecast for all three bands; the pressure profile and all six ensembles at mid-mountain; run timing for every model; the run 12 h before each global model's latest run, at mid (run-change panel); the last-7-days requests at each station and at mid; and the snowpack-projection inputs (six ensembles and the single-model scenarios, with the `past_days` that station's latest reading implies) at the station the Snowpack tab opens by default, then at the other stations while the budget allows (§8). When a resort's local date changes within the next 4.5 h, the next day's snowpack variant is included too.
  - **Live only:** Run-history past runs, and ensembles at base and summit.
  - **Freshness:** a copy serves for 4.5 h after it was fetched (`SNAPSHOT_MAX_AGE_S`). The job runs every 4 h (`SNAPSHOT_INTERVAL_H`), so a scheduled run delayed by more than about 30 minutes leaves a gap that is served live.
  - **Politeness:** User-Agent with a contact URL (`PW_CONTACT`), at most 3 concurrent requests, paced under 400 weighted calls a minute (free tier: 600), 429/5xx retried with backoff and `Retry-After`, and a per-run budget in weighted calls.
  - **Failure handling:** a failed request is left out of the manifest and the browser fetches it live. The snapshot step cannot block the deploy: it has a 7-minute internal deadline, a 9-minute step timeout and `continue-on-error`.
  - The Content-Security-Policy is unchanged: `connect-src 'self'` covers the snapshot.

- **Verification archive** (`scripts/verification.ts`, branch `data/verification`):
  - **Which runs:** every snapshot run names the newest 00Z or 12Z cycle that all current global models have run, from the run metadata it already fetches (the cycle hours are the model catalogue's full-length runs; a model more than one cycle behind is listed as lagging rather than holding the cycle back). It writes that cycle's record, and the `archive` job keeps the first record it sees for each cycle and never overwrites it. So each cycle is archived from the first snapshot run that carried it; which run that is depends on when the slowest global model publishes.
  - **What:** for local days 1–10 (day 1 is the first local day starting after the cycle time; days follow `toDaily`'s convention), at each resort's mid band the blend (with its daily centre count) and each model, and at each station's own point each snowpack-scenario model: daily snowfall through PowderWatch physics, precipitation (negative hourly values, an artefact of some models' de-accumulated output, count as none, as in the rain/snow split), rain, Tmin/Tmax and snow-level range (from the resort's pressure profile, as in the views). Ensembles at both: daily p10/p50/p90 of snowfall and precipitation, the chance of each "Chance of snow totals" threshold (1, 4, 8, 12, 20 in) per day, and the same over 3, 7 and 10 days from day 1. Plus each model's run time and the stations skipped and why. A day counts only when every hour of it has data.
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
- **Tests:** Vitest covers the physics, statistics, climatology, snowpack and time-zone logic, snapshot URL parity and the cache's snapshot freshness and fallback. Run `npm test`.

---

## 7. Development Roadmap

| Phase | Scope | Status |
|---|---|---|
| 1 — Forecast dashboard | Multi-model snowfall, bands, freezing/snow level, temperatures, ensembles, run timing | **Done** |
| 2 — Snowpack tracker | Station history, percentiles, previous season, depth/SWE | **Done** |
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

Done: trips.

Next:

- Alerts through a scheduled job: storm totals over a threshold, the snow level crossing the summit, or a run-to-run jump bigger than X.
- Optional NBM line.

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
| Domain | optional |

- **Open-Meteo budget** (as of 2026-11-20, five resorts):
  - Open-Meteo counts weighted calls: variables × models (× members, for ensembles) ÷ 10, scaled by days ÷ 14 beyond two weeks, at least 1 per request. Each response reports its cost in `X-RateLimit-Cost`, and `estimateCost` in `scripts/snapshot-plan.ts` reproduces it. Free tier: under 10,000 a day, 5,000 an hour and 600 a minute.
  - Requests carry only the variables their view uses: six surface variables for the forecast views; temperature, humidity and precipitation alone for the last-7-days panel and the snowpack scenarios; no freezing level in the snowpack ensembles.
  - Typical costs: the six ensembles at mid, about 97 calls; the snowpack ensembles at a station, about 77–82 (1–2 past days); a band's deterministic forecast (8 models), 5.5; a pressure profile, 19.2; a last-7-days request, 2.4; a snowpack scenario request, about 1.9; a single past run, 1; run metadata, 0.
  - **First screens** (every band's forecast, mid ensembles and profile, run change, last 7 days, the default Snowpack station): about 1,170 calls a run for five resorts. The 04:20 UTC run needs about 1,500, because its snapshot is still served after Pacific midnight and so also carries the next day's snowpack inputs for the four Pacific resorts.
  - **Schedule and budget:** six scheduled runs a day. Each run's budget is 1,250 calls (`SNAPSHOT_MAX_COST`, a sixth of 7,500), raised by `runBudget` to fit the first screens and never above 2,000. What is left after the first screens buys other stations' snowpack inputs. Planned total: about 7,500 calls a day. A push or manual run adds about 1,200–1,500, so one a day keeps the total under 10,000.
  - **One snapshot run** (measured 2026-11-20 00:24 UTC): 147 requests, no retries or failures, 19.8 MB, 1,233.4 weighted calls (`X-RateLimit-Cost`, equal to the estimate), 181 s. First screens took 1,149.7 of those; the rest bought one more station (Corral Pass). Eight lower-priority snowpack groups were skipped.
  - Full coverage would cost about 1,900–2,900 calls a run, mostly snowpack inputs at up to 15 stations (about 77–88 calls each, twice near a local midnight).
  - **Visitors:** with a fresh snapshot, the dashboard, the Storm tracker at mid (including the lazy panels), the last 7 days and the default Snowpack station make no Open-Meteo calls. Live calls remain for Run history (about 40 small requests per cold load), base/summit ensembles (6 requests, about 97 calls), other snowpack stations (7 requests, about 80 calls), and anything once the snapshot is older than 4.5 h. These count against the visitor's own IP, not the job's. Live forecasts are cached for 30 minutes and past runs indefinitely.
- **Single-provider risk:** all forecast data comes through Open-Meteo. The fallback is NOAA NOMADS and ECMWF open data, which means GRIB processing on a server. That is out of scope unless Open-Meteo becomes unavailable.

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
