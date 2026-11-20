# AGENTS.md

Guidance for AI coding agents (and humans) working on PowderWatch. User-facing overview: `README.md`. Design, data sources, methods and roadmap: `docs/proposal.md`.

PowderWatch is a static React + TypeScript site (Vite, Tailwind, ECharts). It has no backend. A scheduled GitHub Actions workflow fetches station observations and a forecast snapshot, then publishes `dist/` to GitHub Pages. Browsers read the static files and call Open-Meteo directly only when the snapshot is missing or stale.

## Commands

```bash
npm ci                 # install (see "Lockfile" below)
npm test               # vitest: physics, stats, climatology, snowpack, time zones, snapshot plan/URL parity, cache
npm run typecheck
npm run build          # tsc + vite build → dist/
npm run preview        # serve dist/ on 127.0.0.1:4173
npm run build:local    # snapshot-only build (VITE_SNAPSHOT_ONLY=1): copies .cache/fc/ into dist/data/fc/
npm run preview:local  # build:local, then serve it on 127.0.0.1:4173. Makes no Open-Meteo calls
npm run dev            # 127.0.0.1:5173 with hot reload
npm run obs            # refresh station data → public/data/obs/*.json (incremental; FULL_REFRESH=1 for full history)
npm run snapshot       # fetch the forecast snapshot → dist/data/fc/ and .cache/fc/ (costs ~1,250 Open-Meteo weighted calls);
                       # also writes the verification record → .cache/verification/
npm run backfill:verification -- --dry-run   # one-time archive backfill (Previous Runs API, ~540 weighted calls); see README
npx tsx scripts/backtest-snowpack.ts   # snowpack calibration against SNOTEL (~2 min, uses ERA5 via Open-Meteo)
```

Run `npm test`, `npm run typecheck` and `npm run build` before every commit. For UI changes, check every touched view in a real browser, at desktop width and at 390 px, in light and dark mode. Watch for overlapping labels, clipped text and console errors.

For browser checks, use `npm run preview:local`, not a fresh `npm run snapshot`. It serves the copy of the last snapshot kept in `.cache/fc/` at any age and never calls Open-Meteo. Requests the snapshot doesn't hold (Run history, base/summit ensembles, anything after the snapshot's local dates) show "Not in the local snapshot (snapshot-only mode)" inline, and a banner gives the snapshot's age.

## Layout

| Path | What lives there |
|---|---|
| `src/config/` | `models.ts` (model catalogue, colour slots, ensembles), `resorts.ts` (bands, model lists, links), `stations.ts` (observation stations, attribution) |
| `src/lib/physics.ts` | Rain/snow split, snow ratio, freezing level, snow level. The single source for snow physics |
| `src/lib/forecast.ts` | Per-model products, local-day totals, family-balanced blend, centre counts, precipitation type per band |
| `src/lib/ensemble.ts` | Ensemble members, plumes, exceedance probabilities, split-day detection |
| `src/lib/snowpack.ts` | Layered snowpack model. `DEFAULT_PARAMS` are calibrated; see the backtest |
| `src/lib/climatology.ts`, `obs.ts`, `recent.ts` | Station history, percentiles, last-7-days alignment |
| `src/lib/openmeteo.ts` | Pure URL builders + fetchers for every Open-Meteo request |
| `src/lib/requests.ts` | Each view's request choices (points, model lists, `pastDays`, …), shared by the views and the snapshot plan |
| `src/lib/cache.ts` | Fetch cache: memory → IndexedDB → snapshot manifest → live, with priority scheduling and 429 backoff. Snapshot-only builds never go live (`snapshotUse`) |
| `src/hooks/data.ts` | `load*` functions and hooks that assemble requests into view data |
| `src/views/` | Dashboard, Storm tracker (`StormView.tsx`, `storm/`), Run history, Snowpack, Methods (`About.tsx`) |
| `scripts/` | `fetch-obs.ts` (station ingest), `snapshot-plan.ts` + `snapshot-forecasts.ts` (forecast snapshot), `verification.ts` (verification record builder), `validate_verification.py` (the archive job's validator), `backfill-verification.ts`, `backtest-snowpack.ts` |
| `public/data/obs/` | Generated station series (committed by the workflow; never edit by hand) |
| `.github/workflows/refresh-and-deploy.yml` | Every 4 h + on push to `main`: refresh → commit → build + snapshot → deploy, and archive (verification record → `data/verification`) |
| `data/verification` branch | Forecast-verification archive (`cycles/YYYY-MM/<cycle>.json`, `backfill/YYYY-MM/<date>.json`). Written only by the `archive` job and the validated backfill; never merged into `main` |

## Invariants: don't break these

**Snapshot URL parity.** The snapshot is keyed by the exact request URL the browser builds. When adding or changing an Open-Meteo request:
1. Build the URL with a pure function in `openmeteo.ts`, and put the view's parameter choices in `requests.ts`.
2. If the request belongs on a first screen, add it to `planSnapshot` in `scripts/snapshot-plan.ts`.
3. Keep `scripts/snapshot-plan.test.ts` passing. It replays the browser's loaders and requires the plan to match them exactly.

If parity drifts, the cache silently stops working, and visits fall back to live calls (and to rate limits on shared networks).

**Open-Meteo budget.** The free tier is non-commercial and allows fewer than 10,000 *weighted* calls a day (cost grows with variables × models × ensemble members, and with days beyond 14). The snapshot runs 6 times a day (`SNAPSHOT_INTERVAL_H` in `src/lib/cache.ts`, kept in step with the workflow cron) with a per-run cap (`DEFAULT_MAX_COST` in `snapshot-plan.ts`, 1,250). `runBudget` raises a run's cap to fit the first screens (groups up to `FIRST_SCREENS`), never above `HARD_MAX_COST`. Before adding requests, check `estimateCost`/`groupCost`/`firstScreenCost` and the plan's skipped groups. Prefer dropping unused variables to raising the cap.

**One physics for all models.** Never use a provider's own snowfall field for display; it's for comparison only (Open-Meteo's is a fixed 7:1 ratio). Snowfall, phase and snow level go through `physics.ts`, so every model is treated the same.

**Exception: benchmarks show the provider's own product.** Official guidance (`NBM` in `models.ts`, WPC in `src/lib/benchmarks.ts`) is shown as the provider publishes it, because its calibration is the point: NOAA NBM's own snowfall (its ASNOW field) and snow level, never re-derived through `physics.ts`. Benchmarks are not in `MODELS`, never enter the family-balanced blend, centre counts or any total, get no model colour slot (they draw in the ink colour with their own mark), and appear only behind the Storm tracker's "Compare with official guidance" toggle (`officialGuidance` resorts, i.e. inside NOAA's CONUS products).

**Use pure single-model ids.** Don't use the `*_seamless` ids for deterministic models: they splice in regional models and would double-count them in the blend. `ncep_gefs_seamless` for the GEFS ensemble is the deliberate exception (it only extends one ensemble's range).

**Workflow security** (`.github/workflows/refresh-and-deploy.yml`):
- Top-level `permissions: {}`. Only the `commit` and `archive` jobs get `contents: write`, and they run **no npm code** (checkout, artifact download, system `python3`, `git`).
- `refresh` and `build` are read-only with `persist-credentials: false`. `refresh` installs with `--ignore-scripts`.
- Pin every action to a full commit SHA, with the tag in a comment. Don't add `pull_request`, `pull_request_target` or `workflow_run` triggers, and don't interpolate `${{ github.event.* }}` into `run:`; pass values through `env`.
- The `commit` job validates incoming data (names, shape, finite bounded numbers) and re-serialises it rather than copying raw bytes.
- The `archive` job does the same for the verification record the read-only `build` job uploads: `scripts/validate_verification.py` (copied from `main` before switching branch, run with `python3 -I`) checks the file name, an allowed key set, finite bounded numbers and a size cap, then re-serialises it. It pushes **only** to `data/verification` (created as an orphan branch on first use) and never overwrites an archived file. `deploy` doesn't depend on it, and nothing in `build` that produces the record can fail the build. When you change the record (`scripts/verification.ts`), change the validator with it; `scripts/verification.test.ts` runs one on the other.

**Browser security.**
- The production build ships a Content-Security-Policy meta tag (`vite.config.ts`). A new API host must be added to `connect-src`, or the browser will block it.
- Render untrusted strings (API, station data, localStorage, URL hash) with React or the escaping helpers `tipRow`/`tipHeader`. Never use `innerHTML`.
- Validate anything read from localStorage.

**Local servers bind to 127.0.0.1 only** (`vite.config.ts`, `package.json`). Never `0.0.0.0` or `--host` without an address.

**Snapshot-only builds are local only.** `VITE_SNAPSHOT_ONLY=1` makes the client use snapshot copies of any age and never call Open-Meteo, drops the Open-Meteo hosts from `connect-src`, and turns on the `local-snapshot` build plugin that copies `.cache/fc/` into `dist/`. Never set it in the workflow; the production build must keep going live for anything missing or stale.

**Lockfile.** `package-lock.json` must resolve from `https://registry.npmjs.org/`. If you install through a private npm mirror, rewrite the `resolved` URLs before committing (the integrity hashes are identical), and check that no private host appears in the diff.

**Data sources and licences.**
- SLF, BC ASWS and NWAC send no CORS headers, and SLF's terms forbid per-user calls. Fetch them only from `scripts/fetch-obs.ts` on the schedule, never from the browser.
- NWAC has no public API or licence: links only.
- NOAA NBM comes through Open-Meteo (`ncep_nbm_conus`, CONUS only, about 11 days, hourly runs), so it needs no new browser host. The snapshot holds it at mid for the `officialGuidance` resorts; other bands are fetched live when the toggle is on.
- Keep the attribution strings in `stations.ts`, the footer in `App.tsx` and `public/data/NOTICE.md` intact, and update them when adding a source.
- Never commit `dist/`, `.cache/` or snapshot files. Verification records go to the `data/verification` branch only, never `main`.

**Station depths are not resort base depths.** The UI must always label them as measurements at a named station and elevation.

## UI principle: don't overwhelm the user

The site stays calm and scannable as data sources are added. A new feature that doesn't fit these rules goes behind a choice, not onto a default view.

- **Dashboard: one glance per resort.** Depth vs normal, the next 3 and 7 days, the best day. A new source may add at most a one-word badge to a card.
- **New data sources are opt-in.** Benchmark sources (NOAA NBM, WPC probabilities, SNODAS, satellite snow cover) go behind a toggle or an extra choice. Never add a new line or panel to a default view.
- **One main question per screen.** Supporting material sits under one clearly labelled **More detail** disclosure, closed by default, keyboard-accessible, with its state in the URL hash query (`more=1`).
  - Storm tracker: "how much snow, and do the models agree?" Open by default: the band/view controls, the headline tiles, the daily snowfall chart with its rain and phase/gust strips and legend, "Chance of snow totals", and a one-line run-to-run summary. Under More detail: the full run-change table, freezing level & snow level, temperature, the ensemble plume, and the last 7 days measured vs modelled.
  - "Compare with official guidance" (US resorts; off by default, `official=1` in the hash query) is the one switch for benchmark sources: NOAA NBM's mark on the daily chart, its legend entry, tooltip row and table column. With it off, nothing about them is shown or requested.
  - Run history: the run-by-run trend chart and its summary. Under More detail: storm evolution by run and the run table.
- **Collapsed panels request nothing until opened.** Mount them only when the disclosure opens (`Disclosure` in `src/components/ui.tsx`), and keep below-the-fold ones in `Lazy`. A panel's requests stay in the snapshot plan if they were there, so opening it doesn't go live; the default screen's requests must stay what `planSnapshot` covers.
- **Explanations live in hovers, expanders and the Methods page.** Charts default to their simplest form; extra series (single-model scenarios, Open-Meteo's raw snowfall) start switched off behind a toggle.

## Chart and UI conventions

- **Colour follows the model.** Each model has a fixed categorical slot (`models.ts`), never re-assigned by rank or filter. The palette is validated for colour-vision deficiency; the light and dark values in `src/index.css` are chosen separately, not inverted.
- **One y-axis per chart.** Two measures on different scales get separate, aligned charts (as with the snow bars and the rain strip).
- **Legends and tooltip keys mirror the marks:** dashed for dashed lines, filled blocks for bands. Text uses the ink colours, never a series colour. Direct-label lines when there are four or fewer.
- **Snow amounts use the ordinal ramp** (`--snow-1..5`, `SNOW_CLASSES_CM`). Rain uses `--rain`. Status colours are reserved for status and always come with an icon or text.
- **Show uncertainty, never hide it.**
  - Days with fewer than 3 forecast centres are outlined.
  - Split days are flagged.
  - Totals of 7 days or more lead with the ensemble median and its 10–90% range.
  - Anything labelled a probability is model spread unless verified.
- **The Methods page (`About.tsx`) renders constants from the code.** When you change a threshold, check that the page still describes it correctly.
- **Units:** imperial is the default; everything is stored metric (cm, mm, m, °C, km/h) and converted at display time through `useFmt()`.

## Commits

Conventional Commits (`feat:`, `fix:`, `perf:`, `docs:`, `chore:`), imperative subject ≤ 50 characters, wrapped body explaining what and why. One logical change per commit.
