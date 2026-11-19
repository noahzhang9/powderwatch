# PowderWatch
### Personal Ski Forecasting & Snowpack Analytics Platform

**Project Proposal — Revision 2, 19 November 2026**

**Status (as of 2026-11-19):** Phases 1–3 are implemented. Phase 4 (verification) needs a forecast archive. Phase 5 (alerts and personalization) is partly done: trips exist, alerts do not.

---

## 1. Project Overview

PowderWatch is a personal ski-forecasting dashboard. It combines many weather models, run-to-run forecast history and measured mountain snowpack in one transparent interface.

It is not a single snowfall number. It shows:

- how models disagree,
- how their forecasts change from run to run,
- what precipitation becomes at each elevation,
- what the forecast means for snowpack measured against that station's own history.

**Resorts at launch**

- Crystal Mountain, WA
- Whistler Blackcomb, BC
- Verbier / 4 Vallées, CH

Stevens Pass and Snoqualmie can be added with configuration alone: a resort entry, bands and stations.

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
| Forecast source | Open-Meteo forecast, ensemble and single-run APIs, called **directly from the browser** | Free for non-commercial use, CORS-enabled (`Access-Control-Allow-Origin: *`), no key. Covers every needed model. No backend required for forecasts. |
| Snowfall | **Computed by PowderWatch's own physics**, not taken from providers | Open-Meteo's `snowfall` uses a fixed 7:1 snow-to-liquid ratio. Providers also split rain and snow differently. One method for all models makes differences meaningful. |
| Model ids | **Pure single-model ids** (`gfs_global`, `gem_global`, `icon_global`, …) | The `*_seamless` ids splice regional models in. For example, `gfs_seamless` is HRRR for the first 48 h in North America. That would double-count models in a blend and mislabel lines. |
| Run history | **Open-Meteo Single Runs API**, fetched on demand | Past runs are retrievable for about 5 months: runs from 2026-07-01 are available, runs from 2026-04-01 are not. Storm-evolution views therefore need no archive. |
| Observations | **Scheduled server-side fetch → static JSON** | BC ASWS, SLF and NWAC send no CORS headers. SNOTEL's API fails about half of requests at random. SLF's terms forbid per-end-user calls. |
| Hosting | **Static site on GitHub Pages**, built and deployed by a **scheduled GitHub Action** | One account, no secrets. Ensemble processing (212 members × 384 h) belongs in the browser, so no server compute is needed. Netlify's free plan (300 credits/month, 15 per production deploy) cannot absorb 6-hourly deploys; Cloudflare Pages (500 deploys/month, free Access login) is the alternative if the site must be private. |

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
| HRRR | NOAA | 3 km | 48 h | native | Crystal, Whistler |
| HRDPS | ECCC | 2.5 km | 48 h | computed | Crystal, Whistler |
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

- **Elevation bands:** base, mid and summit. Each band has its own coordinates and elevation for downscaling.
- **Snowfall:** daily view or cumulative view (one line per model plus the blend).
  - Daily blend bars are shaded by amount on a six-step scale, with the day's total printed under each bar and one dot per model.
  - Rain at the band has its own aligned strip in a separate colour, because rain (mm) and snow (cm) cannot share an axis.
- **Confidence shown in the marks, not just the tooltips:**
  - Days with fewer than three forecast centres are outlined and shaded.
  - A day is flagged *split* when at least 25% of ensemble members give ≤ 1 in and at least 25% give ≥ 6 in. The tooltip shows both camps and how many members back each.
  - Totals of 7 days or more lead with the ensemble median and its 10–90% range, and warn when the blend leaves the range of the models that remain.
- **Precipitation type and wind:** under the bars, a strip shows snow, mixed or rain at each elevation band, plus the day's peak gust, flagged at 40 mph and above.
- **Run-to-run change:** a panel compares each global model's latest run with its run 12 hours earlier for the next 3 and 7 days. Run times show on screen, and runs initialised more than 18 h ago are flagged as stale.
- **Phones:** 8 days by default with a 16-day toggle; model chips, links and settings collapse.
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

*Still to build:* season-scale verification. Comparing a forecast with what actually fell needs PowderWatch's own archive (Phase 4), because single-run retention is about 5 months.

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

**Links:** official snow report, webcams, lift status, avalanche bulletins (NWAC, Avalanche Canada, SLF) and the national weather service.

**Operating and terrain status:** **no free machine-readable feed exists** for any of the three resorts.

- Whistler (Vail) and Crystal pages block non-browser clients.
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
| Reanalysis (backtests) | `archive-api.open-meteo.com/v1/archive` | ERA5. |

### Snow observations

| Resort | Station (source) | Elev. | Depth / SWE record | Access |
|---|---|---|---|---|
| Crystal | Morse Lake 642 (SNOTEL) | 1,646 m | depth 2005→ / SWE 1978→ | AWDB REST, CORS, flaky |
| Crystal | Corral Pass 418 (SNOTEL) | 1,771 m | 2006→ / 1981→ | same |
| Crystal | Cayuse Pass 1085 (SNOTEL) | 1,603 m | 2006→ / 2006→ | same |
| Whistler | Whistler Roundhouse 1108906 (ECCC) | 1,835 m | depth 1980→2026-09 | GeoMet OGC API, CORS. **Silent since 2026-09-23.** |
| Whistler | Callaghan Creek 3A20P (BC ASWS) | 1,017 m | 2018→ / 2018→ | wide CSVs, no CORS |
| Whistler | Squamish River Upper 3A25P (BC ASWS) | 1,387 m | 2003→ / 1989→ | same; 36 km west |
| Whistler | Callaghan Valley 1101300 (ECCC) | 884 m | 2005→ | GeoMet, CORS |
| Verbier | Lac des Vaux ATT2 (SLF IMIS) | 2,550 m | 1993→ | daily CSV + 7-day API, no CORS. Inside the ski area. |
| Verbier | Combatzeline NEN3 (SLF IMIS) | 2,203 m | 2010→ | same |
| Verbier | Fionnay FIO (MeteoSwiss, manual) | 1,500 m | 2008→, gappy | OGD CSV, CORS |

- **NWAC** has on-site stations at Crystal, but no public API and no stated licence. Data before the current water year isn't accessible, and its CSV export sits behind Turnstile. NWAC is linked, not ingested.
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
  ├── Open-Meteo forecast / ensemble / single-run APIs  (direct, CORS)
  │     cached in IndexedDB: live forecasts 30 min, past runs forever,
  │     stale copy served if offline or rate-limited; ≤ 4 concurrent requests
  ├── physics.ts     phase split, snow ratio, freezing level, snow level
  ├── forecast.ts    per-model products, local-day totals, blend
  ├── ensemble.ts    plumes, exceedance probabilities
  ├── snowpack.ts    layered snowpack model
  ├── climatology.ts percentiles by season day
  └── /data/obs/*.json  (static, produced by the scheduled job)

GitHub Action (every 6 h + on push) ─ npm run obs → commit public/data if changed → test → build → deploy-pages
```

- **Frontend:** React 19, Vite 8, Tailwind 4, ECharts 6 (SVG renderer). The bundle is about 280 kB gzipped, mostly ECharts.
- **Charts:**
  - One categorical colour per model, fixed and never re-assigned by rank. The palette is validated for colour-vision deficiency in light and dark modes.
  - Light and dark modes are designed separately, not auto-inverted.
  - Every chart has a crosshair tooltip and a table or text alternative.
  - Never two y-axes on one chart.
- **No D1, Workers or R2 in the MVP.** R2 (or JSON files in the repo) enters with Phase 4 archiving.
- **Tests:** Vitest covers the physics, statistics, climatology, snowpack and time-zone logic. Run `npm test`.

---

## 7. Development Roadmap

| Phase | Scope | Status |
|---|---|---|
| 1 — Forecast dashboard | Multi-model snowfall, bands, freezing/snow level, temperatures, ensembles, run timing | **Done** |
| 2 — Snowpack tracker | Station history, percentiles, previous season, depth/SWE | **Done** |
| 3 — Snowpack projection | Layered model, ensemble spread, scenarios, backtest | **Done** (Cascades calibration) |
| 4 — Verification | See below | Next |
| 5 — Personalization & alerts | See below | Trips done |

**Phase 4 — Verification**

1. Archive, from the 6-hourly job, each model's day-1 to day-10 daily snow, precipitation and freezing level per band and station into JSON (or R2): about 50 kB a day for all resorts.
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
- Stevens Pass and Snoqualmie: stations to be confirmed.
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
| GitHub Actions (6-hourly job, about 1–2 min a run) | $0 for a public repo |
| Open-Meteo | $0 under non-commercial terms |
| Station data | $0 |
| Domain | optional |

- **Open-Meteo budget:**
  - A cold load of one resort's Storm tracker is about 10 requests (bands, profile and six ensembles).
  - A cold load of Run history is about 40 small requests.
  - Live forecasts are cached for 30 minutes and past runs indefinitely.
  - Personal use stays far below 10,000 calls a day.
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

Run locally with `npm run preview` (127.0.0.1:4173). The included GitHub Action deploys to GitHub Pages every 6 hours.

---

## 12. Open Decisions

- **Deployment visibility.** GitHub Pages on a free account is public, and so is the repository. The content is public weather data, and trips never leave the browser. Moving to Cloudflare Pages + Access is a workflow swap if privacy is needed later.
- **Next resorts.** Stevens Pass and Snoqualmie need stations confirmed: SNOTEL near each pass, and NWAC is link-only.
