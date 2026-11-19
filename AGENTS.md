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
npm run dev            # 127.0.0.1:5173 with hot reload
npm run obs            # refresh station data → public/data/obs/*.json (incremental; FULL_REFRESH=1 for full history)
npm run snapshot       # fetch the forecast snapshot → dist/data/fc/ (run after build; costs ~1,000 Open-Meteo weighted calls)
npx tsx scripts/backtest-snowpack.ts   # snowpack calibration against SNOTEL (~2 min, uses ERA5 via Open-Meteo)
```

Run `npm test`, `npm run typecheck` and `npm run build` before every commit. For UI changes, check every touched view in a real browser, at desktop width and at 390 px, in light and dark mode. Watch for overlapping labels, clipped text and console errors.

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
| `src/lib/cache.ts` | Fetch cache: memory → IndexedDB → snapshot manifest → live, with priority scheduling and 429 backoff |
| `src/hooks/data.ts` | `load*` functions and hooks that assemble requests into view data |
| `src/views/` | Dashboard, Storm tracker (`StormView.tsx`, `storm/`), Run history, Snowpack, Methods (`About.tsx`) |
| `scripts/` | `fetch-obs.ts` (station ingest), `snapshot-plan.ts` + `snapshot-forecasts.ts` (forecast snapshot), `backtest-snowpack.ts` |
| `public/data/obs/` | Generated station series (committed by the workflow; never edit by hand) |
| `.github/workflows/refresh-and-deploy.yml` | Every 3 h + on push to `main`: refresh → commit → build + snapshot → deploy |

## Invariants: don't break these

**Snapshot URL parity.** The snapshot is keyed by the exact request URL the browser builds. When adding or changing an Open-Meteo request:
1. Build the URL with a pure function in `openmeteo.ts`, and put the view's parameter choices in `requests.ts`.
2. If the request belongs on a first screen, add it to `planSnapshot` in `scripts/snapshot-plan.ts`.
3. Keep `scripts/snapshot-plan.test.ts` passing. It replays the browser's loaders and requires the plan to match them exactly.

If parity drifts, the cache silently stops working, and visits fall back to live calls (and to rate limits on shared networks).

**Open-Meteo budget.** The free tier is non-commercial and allows fewer than 10,000 *weighted* calls a day (cost grows with variables × models × ensemble members, and with days beyond 14). The snapshot runs 8 times a day with a per-run cap (`DEFAULT_MAX_COST` in `snapshot-plan.ts`, ~1,125). Before adding requests, check `estimateCost`/`groupCost` and the plan's skipped groups. Prefer dropping unused variables to raising the cap.

**One physics for all models.** Never use a provider's own snowfall field for display; it's for comparison only (Open-Meteo's is a fixed 7:1 ratio). Snowfall, phase and snow level go through `physics.ts`, so every model is treated the same.

**Use pure single-model ids.** Don't use the `*_seamless` ids for deterministic models: they splice in regional models and would double-count them in the blend. `ncep_gefs_seamless` for the GEFS ensemble is the deliberate exception (it only extends one ensemble's range).

**Workflow security** (`.github/workflows/refresh-and-deploy.yml`):
- Top-level `permissions: {}`. Only the `commit` job gets `contents: write`, and it runs **no npm code** (checkout, artifact download, system `python3`, `git`).
- `refresh` and `build` are read-only with `persist-credentials: false`. `refresh` installs with `--ignore-scripts`.
- Pin every action to a full commit SHA, with the tag in a comment. Don't add `pull_request`, `pull_request_target` or `workflow_run` triggers, and don't interpolate `${{ github.event.* }}` into `run:`; pass values through `env`.
- The `commit` job validates incoming data (names, shape, finite bounded numbers) and re-serialises it rather than copying raw bytes.

**Browser security.**
- The production build ships a Content-Security-Policy meta tag (`vite.config.ts`). A new API host must be added to `connect-src`, or the browser will block it.
- Render untrusted strings (API, station data, localStorage, URL hash) with React or the escaping helpers `tipRow`/`tipHeader`. Never use `innerHTML`.
- Validate anything read from localStorage.

**Local servers bind to 127.0.0.1 only** (`vite.config.ts`, `package.json`). Never `0.0.0.0` or `--host` without an address.

**Lockfile.** `package-lock.json` must resolve from `https://registry.npmjs.org/`. If you install through a private npm mirror, rewrite the `resolved` URLs before committing (the integrity hashes are identical), and check that no private host appears in the diff.

**Data sources and licences.**
- SLF, BC ASWS and NWAC send no CORS headers, and SLF's terms forbid per-user calls. Fetch them only from `scripts/fetch-obs.ts` on the schedule, never from the browser.
- NWAC has no public API or licence: links only.
- Keep the attribution strings in `stations.ts`, the footer in `App.tsx` and `public/data/NOTICE.md` intact, and update them when adding a source.
- Never commit `dist/`, `.cache/` or snapshot files.

**Station depths are not resort base depths.** The UI must always label them as measurements at a named station and elevation.

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
