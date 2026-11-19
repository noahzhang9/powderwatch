/**
 * Backtest and calibrate the snowpack model's settling physics against
 * SNOTEL stations that measure both depth and SWE.
 *
 * Observation-forced: snowfall water = observed daily SWE gain, melt =
 * observed SWE loss, temperature = ERA5 (Open-Meteo archive) at the
 * station's elevation. Precipitation-forecast error is removed, so the
 * score isolates how well the model turns water into depth over 10 days.
 *
 *   npx tsx scripts/backtest-snowpack.ts
 */
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATIONS } from '../src/config/stations';
import { DEFAULT_PARAMS, runSnowpack, type ForcingHour, type SnowpackParams } from '../src/lib/snowpack';
import type { StationFile } from '../src/lib/obs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIRST_SEASON = 2015;
const LAST_SEASON = 2025;
const HORIZON_D = 10;
const STEP_D = 3;

interface Case { forcing: ForcingHour[]; depth0: number; swe0: number; month: number; obsEnd: number; obsStart: number; newSwe: number }

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

async function era5(lat: number, lon: number, elevation: number): Promise<Map<number, number>> {
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&elevation=${elevation}` +
    `&start_date=${FIRST_SEASON}-10-01&end_date=${LAST_SEASON + 1}-06-30&hourly=temperature_2m&timeformat=unixtime&timezone=GMT`;
  for (let i = 0; i < 5; i++) {
    const r = await fetch(url);
    if (r.ok) {
      const d = (await r.json()) as { hourly: { time: number[]; temperature_2m: (number | null)[] } };
      const m = new Map<number, number>();
      d.hourly.time.forEach((t, j) => { const v = d.hourly.temperature_2m[j]; if (v != null) m.set(t, v); });
      return m;
    }
    await new Promise((res) => setTimeout(res, 3000 * (i + 1)));
  }
  throw new Error('ERA5 fetch failed');
}

async function buildCases(): Promise<Case[]> {
  const cases: Case[] = [];
  for (const st of STATIONS.filter((s) => s.source === 'SNOTEL')) {
    const f = JSON.parse(await readFile(join(ROOT, 'public/data/obs', `${st.id}.json`), 'utf-8')) as StationFile;
    const val = (arr: (number | null)[] | null, iso: string) => {
      const i = Math.round((Date.parse(iso) - Date.parse(f.start)) / 86_400_000);
      return arr && i >= 0 && i < arr.length ? arr[i] : null;
    };
    const temps = await era5(st.lat, st.lon, st.elevation);
    for (let season = FIRST_SEASON; season <= LAST_SEASON; season++) {
      for (let d = `${season}-11-15`; d <= `${season + 1}-03-31`; d = addDays(d, STEP_D)) {
        const depth0 = val(f.depthCm, d);
        const swe0 = val(f.sweMm, d);
        const end = addDays(d, HORIZON_D);
        const depthEnd = val(f.depthCm, end);
        if (depth0 == null || swe0 == null || depthEnd == null || depth0 < 20) continue;
        // PST midnight = 08 UTC.
        const t0 = Date.parse(`${d}T08:00:00Z`) / 1000;
        const forcing: ForcingHour[] = [];
        let ok = true;
        let newSwe = 0;
        for (let k = 0; k < HORIZON_D && ok; k++) {
          const a = val(f.sweMm, addDays(d, k));
          const b = val(f.sweMm, addDays(d, k + 1));
          if (a == null || b == null) { ok = false; break; }
          const dSwe = b - a;
          const gain = dSwe > 2 ? dSwe : 0; // pillow noise floor
          const loss = dSwe < -2 ? -dSwe : 0;
          newSwe += gain;
          for (let h = 1; h <= 24; h++) {
            const t = t0 + (k * 24 + h) * 3600;
            const tC = temps.get(t);
            if (tC == null) { ok = false; break; }
            forcing.push({ time: t, precipMm: gain / 24, tC, rhPct: 95, snowWaterMm: gain / 24, meltOverrideMm: loss / 24 });
          }
        }
        if (!ok) continue;
        cases.push({ forcing, depth0, swe0, month: Number(d.slice(5, 7)) - 1, obsStart: depth0, obsEnd: depthEnd, newSwe });
      }
    }
    console.log(`${st.id}: ${cases.length} cases so far`);
  }
  return cases;
}

function score(cases: Case[], params: SnowpackParams) {
  let se = 0, bias = 0, n = 0, seStorm = 0, nStorm = 0;
  for (const c of cases) {
    const out = runSnowpack({ depthCm: c.depth0, sweMm: c.swe0, month: c.month }, c.forcing, params);
    const pred = out[out.length - 1]?.depthCm;
    if (pred == null) continue;
    const err = pred - c.obsEnd;
    se += err * err; bias += err; n++;
    if (c.newSwe >= 50) { seStorm += err * err; nStorm++; }
  }
  return { rmse: Math.sqrt(se / n), bias: bias / n, n, stormRmse: Math.sqrt(seStorm / nStorm), nStorm };
}

/** Baselines: persistence, and persistence + new SWE at a fixed 10:1 with no settling. */
function baselines(cases: Case[]) {
  let sp = 0, s10 = 0;
  for (const c of cases) {
    sp += (c.obsStart - c.obsEnd) ** 2;
    s10 += (c.obsStart + c.newSwe - c.obsEnd) ** 2; // 1 mm water → 1 cm at 10:1
  }
  return { persistence: Math.sqrt(sp / cases.length), tenToOne: Math.sqrt(s10 / cases.length) };
}

async function main() {
  const cases = await buildCases();
  const fmt = (s: ReturnType<typeof score>) => `RMSE ${s.rmse.toFixed(1)} cm · bias ${s.bias >= 0 ? '+' : ''}${s.bias.toFixed(1)} cm · RMSE when ≥50 mm new SWE ${s.stormRmse.toFixed(1)} cm (n=${s.nStorm})`;
  const b = baselines(cases);
  console.log(`\n${cases.length} ten-day cases, seasons ${FIRST_SEASON}-${LAST_SEASON + 1}, 3 SNOTEL stations`);
  console.log(`baseline persistence       RMSE ${b.persistence.toFixed(1)} cm`);
  console.log(`baseline +new SWE at 10:1  RMSE ${b.tenToOne.toFixed(1)} cm`);
  console.log(`default params             ${fmt(score(cases, DEFAULT_PARAMS))}`);

  // Split-sample calibration: fit on even seasons, report on held-out odd seasons.
  const seasonOf = (c: Case) => {
    const d = new Date(c.forcing[0].time * 1000);
    return d.getUTCFullYear() - (d.getUTCMonth() < 7 ? 1 : 0);
  };
  const train = cases.filter((c) => seasonOf(c) % 2 === 0);
  const test = cases.filter((c) => seasonOf(c) % 2 === 1);
  const grid: Partial<Record<keyof SnowpackParams, number[]>> = {
    settleTauH: [30, 50, 80, 120, 180, 260],
    settleTauPerDegC: [0, 3, 6, 12],
    rhoMaxDry: [220, 260, 300, 340, 380],
    rhoMaxWet: [380, 450, 520],
    overburdenPerMm: [0, 0.06, 0.12, 0.25, 0.4],
  };
  let best = { ...DEFAULT_PARAMS };
  let bestScore = score(train, best).rmse;
  for (let pass = 0; pass < 3; pass++) {
    for (const [k, values] of Object.entries(grid) as [keyof SnowpackParams, number[]][]) {
      for (const v of values) {
        const trial = { ...best, [k]: v };
        const sc = score(train, trial).rmse;
        if (sc < bestScore - 1e-6) { bestScore = sc; best = trial; }
      }
    }
  }
  console.log(`fit on ${train.length} even-season cases; held-out ${test.length} odd-season cases:`);
  console.log(`  default    ${fmt(score(test, DEFAULT_PARAMS))}`);
  console.log(`  calibrated ${fmt(score(test, best))}`);
  console.log('calibrated:', JSON.stringify({ settleTauH: best.settleTauH, settleTauPerDegC: best.settleTauPerDegC, rhoMaxDry: best.rhoMaxDry, rhoMaxWet: best.rhoMaxWet, overburdenPerMm: best.overburdenPerMm }));
  // Single-parameter sensitivity on held-out seasons (is one change doing the work?).
  for (const [k, v] of [['rhoMaxDry', 340], ['settleTauH', 120], ['overburdenPerMm', 0.25]] as [keyof SnowpackParams, number][]) {
    console.log(`  default with ${k}=${v}: ${fmt(score(test, { ...DEFAULT_PARAMS, [k]: v }))}`);
  }
}

void main();
