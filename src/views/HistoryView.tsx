import { useCallback, useMemo, useState } from 'react';
import { HISTORY_MODELS, MODELS } from '../config/models';
import type { BandKey, Resort } from '../config/resorts';
import { bandInText } from '../config/resorts';
import { Chart, baseOption, tipHeader, tipRow, type EChartsCoreOption } from '../components/Chart';
import { Disclosure, Loading, ModelChip, Notice, Section, Seg } from '../components/ui';
import { useBandForecast, useRunMeta } from '../hooks/data';
import { useAsync } from '../hooks/useAsync';
import { NOT_IN_SNAPSHOT, isNotInSnapshot } from '../lib/cache';
import { deriveModel, lastValidTime, windowSum, type DerivedHourly } from '../lib/forecast';
import { fetchSingleRun } from '../lib/openmeteo';
import { alpha, slotColor, type ChartPalette } from '../lib/palette';
import { useFmt, type Fmt } from '../lib/prefs';
import { isNum } from '../lib/stats';
import { addDays, dayLabel, localMidnightUnix, nowUnix, runLabel, todayIn } from '../lib/time';
import { useNarrow } from '../hooks/useNarrow';
import { useHashParam } from '../hooks/useRoute';

const shortDayFromUnix = (u: number) => new Date(u * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

const RUNS_BACK = 14; // 7 days of 00Z/12Z runs

interface RunResult {
  modelId: string;
  run: number;
  derived: DerivedHourly;
  snowCm: number | null;
  precipMm: number | null;
  fzlMax: number | null;
  leadDays: number;
}

export function HistoryView({ resort }: { resort: Resort }) {
  const fmt = useFmt();
  const [bandKey, setBandKey] = useHashParam<BandKey>('band', 'mid', ['base', 'mid', 'summit']);
  // Supporting charts (same data, no extra requests) sit under "More detail", as on the Storm tracker.
  const [more, setMore] = useHashParam<'0' | '1'>('more', '0', ['0', '1']);
  const band = resort.bands.find((b) => b.key === bandKey)!;
  const available = HISTORY_MODELS.filter((m) => resort.models.includes(m));
  const [selected, setSelected] = useState<string[]>(['ecmwf_ifs025', 'gfs_global', 'gem_global'].filter((m) => available.includes(m)));
  const [len, setLen] = useState(3);
  const [startOverride, setStart] = useState<string | null>(null);
  const meta = useRunMeta(available);
  const fc = useBandForecast(resort, band);

  // Default target window: the wettest `len`-day window in the next 10 days of the blend.
  const suggested = useMemo(() => {
    const today = todayIn(resort.tz);
    const days = fc.data?.blendDaily.filter((d) => d.date > today).slice(0, 10) ?? [];
    let best = addDays(today, 1);
    let bestTotal = -1;
    for (let i = 0; i + len <= days.length; i++) {
      const tot = days.slice(i, i + len).reduce((s, d) => s + (d.snowCm ?? 0), 0);
      if (tot > bestTotal) {
        bestTotal = tot;
        best = days[i].date;
      }
    }
    return best;
  }, [fc.data, len, resort.tz]);
  const start = startOverride ?? suggested;
  const from = localMidnightUnix(start, resort.tz);
  const to = localMidnightUnix(addDays(start, len), resort.tz);

  const runs = useAsync(async () => {
    let notInSnapshot = 0;
    const now = nowUnix();
    const latest12 = Math.floor((now - 4 * 3600) / 43200) * 43200; // runs are published ~4–8 h after init
    const tasks: Promise<RunResult | null>[] = [];
    for (const modelId of selected) {
      const lastInit = meta.data?.[modelId]?.initUnix ?? latest12;
      for (let k = 0; k < RUNS_BACK; k++) {
        const run = latest12 - k * 43200;
        if (run > lastInit || run >= to) continue;
        const leadDays = (from - run) / 86400;
        if (leadDays > 15) continue;
        tasks.push(
          fetchSingleRun({ lat: band.lat, lon: band.lon, elevation: band.elevation }, modelId, run, resort.tz)
            .then((raw) => {
              const derived = deriveModel(raw);
              const end = lastValidTime(derived.time, derived.precip);
              if (end == null || end < to - 3600) return null; // run doesn't reach the window end
              const fz = derived.time.map((t, i) => (t > from && t <= to ? derived.fzl[i] : null)).filter(isNum);
              return {
                modelId, run, derived, leadDays,
                snowCm: windowSum(derived.time, derived.snowCm, from, to),
                precipMm: windowSum(derived.time, derived.precip, from, to),
                fzlMax: fz.length ? Math.max(...fz) : null,
              };
            })
            .catch((err) => {
              if (isNotInSnapshot(err)) notInSnapshot++;
              return null;
            }),
        );
      }
    }
    const results = (await Promise.all(tasks)).filter((r): r is RunResult => r != null).sort((a, b) => a.run - b.run);
    return { results, notInSnapshot, requested: tasks.length };
  }, [selected.join(','), band.key, from, to, meta.data != null]);
  const runResults = runs.data?.results;

  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const [focusPick, setFocus] = useState<string | null>(null);
  const focus = focusPick && selected.includes(focusPick) ? focusPick : selected[0];

  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-center gap-3">
        <Seg label="Elevation band" value={bandKey} onChange={setBandKey} options={resort.bands.map((b) => ({ value: b.key, label: `${b.label} · ${fmt.elev(b.elevation)}` }))} />
        <label className="text-sm text-ink-2 flex items-center gap-2">
          Window starts
          <input type="date" className="field" value={start} onChange={(e) => setStart(e.target.value || null)} />
        </label>
        <Seg label="Window length" value={String(len)} onChange={(v) => setLen(Number(v))} options={[1, 2, 3, 5, 7].map((n) => ({ value: String(n), label: `${n} d` }))} />
        {startOverride && <button type="button" className="chip" onClick={() => setStart(null)}>Reset to wettest window</button>}
      </div>
      <div className="flex flex-wrap gap-2 mt-3">
        {available.map((id) => (
          <ModelChip key={id} color={`var(--s${MODELS[id].slot})`} label={MODELS[id].label} on={selected.includes(id)} onToggle={() => toggle(id)} />
        ))}
      </div>
      <Section
        title={`How the forecast for ${dayLabel(start)} – ${dayLabel(addDays(start, len - 1))} changed`}
        subtitle={`Snowfall forecast for this ${len}-day window at ${bandInText(band)} (${fmt.elev(band.elevation)}), by model run (00Z and 12Z runs, last 7 days). Each point is one run; read left to right to see a storm appear, vanish or return. Past runs come from Open-Meteo's single-run archive, processed with the same snow physics as live forecasts.`}
      >
        {runs.error && <Notice tone="error">{runs.error.message}</Notice>}
        {runs.data?.notInSnapshot ? (
          <Notice>{NOT_IN_SNAPSHOT}: {runs.data.notInSnapshot} of {runs.data.requested} past runs (run history is not part of the snapshot).</Notice>
        ) : null}
        {!runResults ? (
          <Loading what="past model runs" />
        ) : runResults.length === 0 ? (
          runs.data?.notInSnapshot ? null : <Notice>No archived runs cover this window yet. Pick a window within the next ~10 days.</Notice>
        ) : (
          <>
            <TrendChart runs={runResults} fmt={fmt} />
            <Summary runs={runResults} fmt={fmt} />
          </>
        )}
      </Section>
      {runResults && runResults.length > 0 && (
        <Disclosure label="More detail" hint="Storm evolution run by run · run table" open={more === '1'} onToggle={(o) => setMore(o ? '1' : '0')}>
          {focus && runResults.some((r) => r.modelId === focus) && (
            <Section
              title={`${MODELS[focus].label}: storm evolution run by run`}
              subtitle="Cumulative snowfall through the window as forecast by each run. Older runs fade; the latest two are labelled."
              right={
                <label className="text-xs text-ink-2 flex items-center gap-2">
                  Storm evolution for
                  <select className="field" value={focus} onChange={(e) => setFocus(e.target.value)}>
                    {selected.map((id) => <option key={id} value={id}>{MODELS[id].label}</option>)}
                  </select>
                </label>
              }
            >
              <EvolutionChart runs={runResults.filter((r) => r.modelId === focus)} from={from} to={to} tz={resort.tz} fmt={fmt} />
            </Section>
          )}
          <Section title="Run table">
            <RunTable runs={runResults} fmt={fmt} />
          </Section>
        </Disclosure>
      )}
    </div>
  );
}

function TrendChart({ runs, fmt }: { runs: RunResult[]; fmt: Fmt }) {
  const narrow = useNarrow();
  const option = useCallback(
    (p: ChartPalette): EChartsCoreOption => {
      const base = baseOption(p) as Record<string, unknown>;
      const ids = Array.from(new Set(runs.map((r) => r.modelId)));
      return {
        ...base,
        xAxis: { ...(base.xAxis as object), type: 'time', minInterval: 86_400_000, splitNumber: narrow ? 3 : 7, axisLabel: { color: p.ink3, fontSize: 11, formatter: (v: number) => (narrow ? shortDayFromUnix(v / 1000) : runLabel(v / 1000)) } },
        yAxis: { ...(base.yAxis as object), type: 'value', name: fmt.snowUnit, min: 0, nameTextStyle: { color: p.ink3 } },
        tooltip: {
          ...(base.tooltip as object),
          trigger: 'item',
          formatter: (x: { seriesName: string; value: [number, number]; color: string }) =>
            tipHeader(`${x.seriesName} · run ${runLabel(x.value[0] / 1000)}`, p) + tipRow(x.color, 'window snowfall', `${x.value[1].toFixed(fmt.units === 'imperial' ? 1 : 0)} ${fmt.snowUnit}`, p),
        },
        series: ids.map((id) => ({
          type: 'line', name: MODELS[id].label, symbol: 'circle', symbolSize: 9,
          lineStyle: { width: 2, color: slotColor(p, MODELS[id].slot) },
          itemStyle: { color: slotColor(p, MODELS[id].slot), borderColor: p.surface, borderWidth: 1.5 },
          data: runs.filter((r) => r.modelId === id).map((r) => [r.run * 1000, fmt.snowVal(r.snowCm)]),
          endLabel: { show: true, formatter: MODELS[id].label, color: p.ink2, fontSize: 11 },
        })),
        grid: { left: 52, right: 80, top: 16, bottom: 28 },
      };
    },
    [runs, fmt, narrow],
  );
  return <Chart option={option} height={300} ariaLabel="Window snowfall by model run" />;
}

function Summary({ runs, fmt }: { runs: RunResult[]; fmt: Fmt }) {
  const ids = Array.from(new Set(runs.map((r) => r.modelId)));
  const latest = ids.map((id) => runs.filter((r) => r.modelId === id).at(-1)!).filter(Boolean);
  const vals = latest.map((r) => r.snowCm).filter(isNum);
  const spread = vals.length >= 2 ? Math.max(...vals) - Math.min(...vals) : null;
  return (
    <div className="grid md:grid-cols-2 gap-x-6 gap-y-1 mt-3 text-sm">
      {ids.map((id) => {
        const rs = runs.filter((r) => r.modelId === id).slice(-5);
        return (
          <div key={id} className="flex items-baseline gap-2">
            <span className="text-ink-2 w-24 shrink-0">{MODELS[id].label}</span>
            <span className="tnum">{rs.map((r) => fmt.snow(r.snowCm)).join(' → ')}</span>
          </div>
        );
      })}
      {spread != null && (
        <div className="md:col-span-2 text-xs text-ink-2 mt-1">
          Latest runs span {fmt.snow(Math.min(...vals))} – {fmt.snow(Math.max(...vals))} (spread {fmt.snow(spread)}).
        </div>
      )}
    </div>
  );
}

function EvolutionChart({ runs, from, to, tz, fmt }: { runs: RunResult[]; from: number; to: number; tz: string; fmt: Fmt }) {
  const narrow = useNarrow();
  const option = useCallback(
    (p: ChartPalette): EChartsCoreOption => {
      const base = baseOption(p) as Record<string, unknown>;
      const ramp = p.emphasisRamp.slice(1); // older runs recede (floor above the faintest step), latest run has most contrast
      return {
        ...base,
        grid: { left: 52, right: narrow ? 16 : 130, top: 16, bottom: 28 },
        xAxis: { ...(base.xAxis as object), type: 'time', min: from * 1000, max: to * 1000, splitNumber: narrow ? 3 : 6 },
        yAxis: { ...(base.yAxis as object), type: 'value', name: fmt.snowUnit, nameTextStyle: { color: p.ink3 } },
        tooltip: {
          ...(base.tooltip as object),
          formatter: (params: { seriesName: string; value: [number, number]; color: string }[]) =>
            tipHeader(new Date(params[0]?.value[0]).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', timeZone: tz }), p) +
            [...params].reverse().map((x) => tipRow(x.color, x.seriesName, `${x.value[1].toFixed(fmt.units === 'imperial' ? 1 : 0)} ${fmt.snowUnit}`, p)).join(''),
        },
        series: runs.map((r, i) => {
          const color = ramp[Math.round((i / Math.max(1, runs.length - 1)) * (ramp.length - 1))];
          let acc = 0;
          const pts: [number, number | null][] = [];
          r.derived.time.forEach((t, j) => {
            if (t <= from || t > to) return;
            acc += r.derived.snowCm[j] ?? 0;
            pts.push([t * 1000, fmt.snowVal(acc)]);
          });
          const latest = i === runs.length - 1;
          const previous = i === runs.length - 2;
          const endTotal = pts.length ? pts[pts.length - 1][1] : null;
          return {
            type: 'line', name: `run ${runLabel(r.run)}`, showSymbol: false,
            lineStyle: { width: latest ? 3 : previous ? 2 : 1.5, color }, itemStyle: { color }, z: latest ? 5 : previous ? 4 : 2, data: pts,
            endLabel: (latest || previous) && !narrow ? { show: true, color: p.ink1, fontSize: 11, fontWeight: latest ? 600 : 400, formatter: `${runLabel(r.run)} · ${endTotal == null ? '—' : `${endTotal.toFixed(fmt.units === 'imperial' ? 1 : 0)} ${fmt.snowUnit}`}` } : undefined,
            areaStyle: latest ? { color: alpha(color, 0.08) } : undefined,
          };
        }),
      };
    },
    [runs, from, to, tz, fmt, narrow],
  );
  return <Chart option={option} height={260} ariaLabel="Storm evolution by run" />;
}

function RunTable({ runs, fmt }: { runs: RunResult[]; fmt: Fmt }) {
  const rows = [...runs].sort((a, b) => (a.modelId === b.modelId ? b.run - a.run : a.modelId.localeCompare(b.modelId)));
  return (
    <div className="overflow-x-auto">
      <table className="data">
        <thead>
          <tr><th>Model</th><th>Run</th><th>Lead to window</th><th>Snow</th><th>Change vs prior run</th><th>Precip (water)</th><th>Max freezing level</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const prev = runs.filter((x) => x.modelId === r.modelId && x.run < r.run).at(-1);
            const delta = prev && isNum(prev.snowCm) && isNum(r.snowCm) ? r.snowCm - prev.snowCm : null;
            return (
              <tr key={`${r.modelId}-${r.run}`}>
                <td>{MODELS[r.modelId].label}</td>
                <td>{runLabel(r.run)}</td>
                <td>{r.leadDays.toFixed(1)} d</td>
                <td><b>{fmt.snow(r.snowCm)}</b></td>
                <td>{delta == null ? '—' : `${delta >= 0 ? '+' : '−'}${fmt.snow(Math.abs(delta))}`}</td>
                <td>{fmt.water(r.precipMm)}</td>
                <td>{r.fzlMax == null ? 'n/a' : fmt.elev(r.fzlMax)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="text-[11px] text-ink-3 mt-2">
        Freezing level is shown only for models that publish it (GFS, ICON); others are n/a here. Lead = days from model initialisation to the window start.
      </div>
    </div>
  );
}
