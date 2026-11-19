import { useCallback, useMemo, useState } from 'react';
import { MODELS } from '../config/models';
import type { BandKey, Resort } from '../config/resorts';
import { Chart, baseOption, tipHeader, tipRow, type EChartsCoreOption } from '../components/Chart';
import { Loading, ModelChip, Notice, Section, Seg, Tile } from '../components/ui';
import { useBandForecast, useEnsembles, useRunMeta, type BandForecast } from '../hooks/data';
import { cumulativePlume, probabilityAtLeast, probabilityFzlAbove, windowQuantiles, windowTotals } from '../lib/ensemble';
import { lastValidTime, windowSum, type DerivedHourly } from '../lib/forecast';
import { SNOW_CLASSES_CM, slotColor, snowClass, type ChartPalette } from '../lib/palette';
import { useFmt, type Fmt } from '../lib/prefs';
import { isNum } from '../lib/stats';
import { ago, dayLabel, localHourLabel, nowUnix, runLabel, todayIn } from '../lib/time';
import type { EnsembleSet } from '../hooks/data';
import { RecentSection } from './RecentSection';

const WINDOWS = [
  { label: 'Next 24 h', hours: 24 },
  { label: 'Next 3 days', hours: 72 },
  { label: 'Next 7 days', hours: 168 },
  { label: 'Next 14 days', hours: 336 },
];

export function StormView({ resort }: { resort: Resort }) {
  const fmt = useFmt();
  const [bandKey, setBandKey] = useState<BandKey>('summit');
  const band = resort.bands.find((b) => b.key === bandKey)!;
  const fc = useBandForecast(resort, band);
  const ens = useEnsembles({ lat: band.lat, lon: band.lon, elevation: band.elevation }, resort.tz);
  const meta = useRunMeta(resort.models);
  const [mode, setMode] = useState<'daily' | 'cumulative'>('daily');
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [rawSnow, setRawSnow] = useState(false);
  const [showTable, setShowTable] = useState(false);

  const toggle = (id: string) =>
    setHidden((h) => {
      const n = new Set(h);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const data = fc.data;
  const now = useMemo(() => nowUnix(), [data]);
  const visible = useMemo(() => (data ? data.models.filter((m) => !hidden.has(m.model.id)) : []), [data, hidden]);

  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-center gap-3">
        <Seg
          label="Elevation band"
          value={bandKey}
          onChange={setBandKey}
          options={resort.bands.map((b) => ({ value: b.key, label: `${b.label} · ${fmt.elev(b.elevation)}` }))}
        />
        <Seg label="Snowfall view" value={mode} onChange={setMode} options={[{ value: 'daily', label: 'Daily' }, { value: 'cumulative', label: 'Cumulative' }]} />
        <label className="text-xs text-ink-2 flex items-center gap-1.5">
          <input type="checkbox" checked={rawSnow} onChange={(e) => setRawSnow(e.target.checked)} />
          Compare Open-Meteo raw snowfall (fixed 7:1)
        </label>
      </div>
      {data && (
        <div className="flex flex-wrap gap-2 mt-3" aria-label="Models (toggle visibility)">
          <ModelChip color="var(--ink-1)" label="Blend" on thick onToggle={() => undefined} title="Family-balanced blend of all shown and hidden models" />
          {data.models.map((m) => {
            const rm = meta.data?.[m.model.id];
            const end = lastValidTime(m.time, m.precip);
            return (
              <ModelChip
                key={m.model.id}
                color={`var(--s${m.model.slot})`}
                label={m.model.label}
                on={!hidden.has(m.model.id)}
                onToggle={() => toggle(m.model.id)}
                title={`${m.model.blurb}\n${m.model.resolutionKm} km · ${rm ? `run ${runLabel(rm.initUnix)}, published ${ago(rm.availableUnix)}` : 'run time unknown'}${end ? ` · data to ${localHourLabel(end, resort.tz)}` : ''}\nFreezing level: ${m.fzlSource === 'model' ? 'model output' : m.fzlSource === 'computed' ? 'computed from pressure levels' : 'unavailable'}`}
              />
            );
          })}
        </div>
      )}
      {fc.error && <Notice tone="error">Forecast request failed: {fc.error.message}</Notice>}
      {data?.missing.length ? <Notice>No data at this point from: {data.missing.map((id) => MODELS[id]?.label ?? id).join(', ')}.</Notice> : null}
      {!data ? (
        <Loading what="model forecasts" />
      ) : (
        <>
          <Totals data={data} now={now} ens={ens.data} fmt={fmt} rawSnow={rawSnow} />
          <Section
            title={`Snowfall at ${band.label.toLowerCase()} (${fmt.elev(band.elevation)})`}
            subtitle={
              mode === 'daily'
                ? 'Bars: family-balanced blend, shaded by amount, with the total under each day. Dots: individual models (omitted when a model covers less than 20 h of the day). Rain at this elevation is shown in its own strip.'
                : 'Cumulative snowfall from now. Thick line: blend.'
            }
            right={
              <button type="button" className="chip" aria-pressed={showTable} onClick={() => setShowTable((s) => !s)}>
                Table view
              </button>
            }
          >
            <SnowChart data={data} visible={visible} mode={mode} now={now} tz={resort.tz} fmt={fmt} rawSnow={rawSnow} />
            {mode === 'daily' && <RainStrip data={data} tz={resort.tz} fmt={fmt} />}
            {mode === 'daily' && <SnowRampLegend fmt={fmt} />}
            {showTable && <DailyTable data={data} tz={resort.tz} fmt={fmt} />}
          </Section>
          <RecentSection resort={resort} band={band} />
          <Section
            title="Freezing level & snow level"
            subtitle="Thin lines: each model's freezing level (0 °C). Thick line: blended snow level (where precipitation turns mostly to snow). Horizontal rules: this resort's elevation bands. Snow falls well below the freezing level, so the two are not the same."
          >
            <LevelsChart data={data} visible={visible} resort={resort} fmt={fmt} />
          </Section>
          <Section title={`Temperature at ${band.label.toLowerCase()}`} subtitle="Model 2 m temperature downscaled to the band elevation.">
            <TempChart data={data} visible={visible} tz={resort.tz} fmt={fmt} />
          </Section>
          <EnsembleSection ens={ens.data} loading={ens.loading} error={ens.error} data={data} now={now} band={band} resort={resort} fmt={fmt} />
        </>
      )}
    </div>
  );
}

function modelWindow(m: DerivedHourly, from: number, hours: number, key: 'snowCm' | 'omSnowCm' | 'rainMm' = 'snowCm') {
  const to = from + hours * 3600;
  const end = lastValidTime(m.time, m.precip);
  if (end == null || end < to - 3600) return null;
  return windowSum(m.time, m[key], from, to);
}

function Totals({ data, now, ens, fmt, rawSnow }: { data: BandForecast; now: number; ens?: EnsembleSet; fmt: Fmt; rawSnow: boolean }) {
  const key = rawSnow ? 'omSnowCm' : 'snowCm';
  const sl = useMemo(() => {
    const vals: number[] = [];
    data.blend.time.forEach((t, i) => {
      if (t > now && t <= now + 72 * 3600 && (data.blend.precip[i] ?? 0) >= 0.3 && isNum(data.blend.snowLevel[i])) vals.push(data.blend.snowLevel[i]!);
    });
    return vals.length ? { min: Math.min(...vals), max: Math.max(...vals) } : null;
  }, [data, now]);
  const rain7 = windowSum(data.blend.time, data.blend.rainMm, now, now + 168 * 3600);
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mt-4">
      {WINDOWS.map((w) => {
        const total = windowSum(data.blend.time, data.blend[key], now, now + w.hours * 3600);
        const per = data.models.map((m) => modelWindow(m, now, w.hours, key)).filter(isNum);
        const range = per.length >= 2 ? `${per.length} models: ${fmt.snowRange(Math.min(...per), Math.max(...per))}` : 'single model';
        let ensTxt: string | null = null;
        if (ens && !rawSnow && w.hours >= 72) {
          const ws = windowTotals(ens.time, ens.members, now, now + w.hours * 3600);
          const [p10, p90] = windowQuantiles(ws, [0.1, 0.9]);
          if (p10 != null && p90 != null) ensTxt = `ensemble 10–90%: ${fmt.snowRange(p10, p90)}`;
        }
        return <Tile key={w.label} label={w.label} value={fmt.snow(total)} sub={<>{range}{ensTxt && <><br />{ensTxt}</>}</>} />;
      })}
      <Tile
        label="Snow level, next 72 h"
        value={sl ? (Math.abs(sl.max - sl.min) < 100 ? fmt.elev(sl.min) : fmt.elevRange(sl.min, sl.max)) : '—'}
        sub={sl ? 'blend, during precipitation' : 'little precipitation forecast'}
      />
      <Tile label="Rain at this elevation, 7 d" value={fmt.water(rain7)} sub="blend" />
    </div>
  );
}

function SnowChart({ data, visible, mode, now, tz, fmt, rawSnow }: {
  data: BandForecast; visible: DerivedHourly[]; mode: 'daily' | 'cumulative'; now: number; tz: string; fmt: Fmt; rawSnow: boolean;
}) {
  const option = useCallback(
    (p: ChartPalette): EChartsCoreOption => {
      const base = baseOption(p) as Record<string, unknown>;
      const key = rawSnow ? 'omSnowCm' : 'snowCm';
      if (mode === 'daily') {
        const today = todayIn(tz);
        const days = data.blendDaily.filter((d) => d.date >= today).slice(0, 16);
        const val = (m: DerivedHourly, date: string) => {
          const r = data.daily[m.model.id]?.find((x) => x.date === date);
          return r && r.hours >= 20 ? fmt.snowVal(r[key]) : null;
        };
        const byDate = new Map(days.map((d) => [d.date, d]));
        return {
          ...base,
          grid: { left: 52, right: 16, top: 16, bottom: 46 },
          xAxis: {
            ...(base.xAxis as object), type: 'category', data: days.map((d) => d.date),
            axisLabel: {
              interval: 0, margin: 10,
              formatter: (date: string) => {
                const d = byDate.get(date);
                const v = d?.[key];
                const txt = v != null && v >= 0.5 ? fmt.snow(v) : '–';
                return `{d|${dayLabel(date)}}\n{${v != null && v >= 0.5 ? 'v' : 'z'}|${txt}}`;
              },
              rich: {
                d: { color: p.ink3, fontSize: 11, lineHeight: 15 },
                v: { color: p.ink1, fontSize: 12, fontWeight: 600, lineHeight: 17 },
                z: { color: p.ink3, fontSize: 12, lineHeight: 17 },
              },
            },
          },
          yAxis: { ...(base.yAxis as object), type: 'value', name: fmt.snowUnit, nameTextStyle: { color: p.ink3 } },
          tooltip: {
            ...(base.tooltip as object),
            formatter: (params: { seriesName: string; value: number | null | { value: number }; color: string; dataIndex: number }[]) => {
              const i = params[0]?.dataIndex ?? 0;
              const num = (x: (typeof params)[number]) => (x.value != null && typeof x.value === 'object' ? x.value.value : x.value);
              const rows = params
                .filter((x) => num(x) != null)
                .sort((a, b) => (a.seriesName === 'Blend' ? -1 : b.seriesName === 'Blend' ? 1 : (num(b) ?? 0) - (num(a) ?? 0)))
                .map((x) => tipRow(x.seriesName === 'Blend' ? p.ink1 : x.color, x.seriesName, fmt.snow(fmt.units === 'imperial' ? (num(x) ?? 0) * 2.54 : num(x)), p));
              const d = days[i];
              const extra = d
                ? tipRow(p.rain, 'rain (blend)', fmt.water(d.rainMm), p) + tipRow(p.ink3, 'snow level (blend)', fmt.elevRange(d.snowLevelMin, d.snowLevelMax), p)
                : '';
              return tipHeader(d ? d.date : '', p) + rows.join('') + extra;
            },
          },
          series: [
            {
              // Bar colour encodes the amount (ordinal ramp, see legend); the value is printed under each bar.
              type: 'bar', name: 'Blend', barWidth: '58%', z: 1,
              data: days.map((d) => ({
                value: fmt.snowVal(d[key]),
                itemStyle: { color: p.snowRamp[snowClass(d[key])], borderRadius: [4, 4, 0, 0] },
              })),
            },
            ...visible.map((m) => ({
              type: 'scatter', name: m.model.label, symbolSize: 8, z: 3,
              itemStyle: { color: slotColor(p, m.model.slot), borderColor: p.surface, borderWidth: 1.5 },
              data: days.map((d) => val(m, d.date)),
            })),
          ],
        };
      }
      // cumulative
      const cum = (time: number[], s: (number | null)[]) => {
        let acc = 0;
        const out: [number, number | null][] = [];
        for (let i = 0; i < time.length; i++) {
          if (time[i] <= now) continue;
          if (!isNum(s[i])) break;
          acc += s[i]!;
          out.push([time[i] * 1000, fmt.snowVal(acc)]);
        }
        return out;
      };
      return {
        ...base,
        xAxis: { ...(base.xAxis as object), type: 'time' },
        yAxis: { ...(base.yAxis as object), type: 'value', name: fmt.snowUnit, nameTextStyle: { color: p.ink3 } },
        tooltip: {
          ...(base.tooltip as object),
          formatter: (params: { seriesName: string; value: [number, number]; color: string }[]) =>
            tipHeader(new Date(params[0]?.value[0]).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', timeZone: tz }), p) +
            params
              .filter((x) => x.value?.[1] != null)
              .sort((a, b) => b.value[1] - a.value[1])
              .map((x) => tipRow(x.seriesName === 'Blend' ? p.ink1 : x.color, x.seriesName, `${x.value[1].toFixed(fmt.units === 'imperial' ? 1 : 0)} ${fmt.snowUnit}`, p))
              .join(''),
        },
        series: [
          ...visible.map((m) => ({
            type: 'line', name: m.model.label, showSymbol: false, lineStyle: { width: 2, color: slotColor(p, m.model.slot) },
            itemStyle: { color: slotColor(p, m.model.slot) }, data: cum(m.time, m[key]),
          })),
          { type: 'line', name: 'Blend', showSymbol: false, z: 5, lineStyle: { width: 3.5, color: p.ink1 }, itemStyle: { color: p.ink1 }, data: cum(data.blend.time, data.blend[key]) },
        ],
      };
    },
    [data, visible, mode, now, tz, fmt, rawSnow],
  );
  return <Chart option={option} height={300} ariaLabel="Snowfall forecast by model" />;
}

function LevelsChart({ data, visible, resort, fmt }: { data: BandForecast; visible: DerivedHourly[]; resort: Resort; fmt: Fmt }) {
  const option = useCallback(
    (p: ChartPalette): EChartsCoreOption => {
      const base = baseOption(p) as Record<string, unknown>;
      const pts = (time: number[], s: (number | null)[]) => time.map((t, i) => [t * 1000, fmt.elevVal(s[i])] as [number, number | null]);
      return {
        ...base,
        grid: { left: 60, right: 90, top: 16, bottom: 28 },
        xAxis: { ...(base.xAxis as object), type: 'time' },
        yAxis: { ...(base.yAxis as object), type: 'value', name: fmt.elevUnit, min: 0, nameTextStyle: { color: p.ink3 } },
        tooltip: {
          ...(base.tooltip as object),
          formatter: (params: { seriesName: string; value: [number, number | null]; color: string }[]) =>
            tipHeader(new Date(params[0]?.value[0]).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', timeZone: resort.tz }), p) +
            params
              .filter((x) => x.value?.[1] != null)
              .map((x) => tipRow(x.seriesName.startsWith('Snow level') ? p.ink1 : x.color, x.seriesName, `${Math.round(x.value[1]!).toLocaleString()} ${fmt.elevUnit}`, p))
              .join(''),
        },
        series: [
          ...visible.map((m) => ({
            type: 'line', name: `${m.model.label} freezing level`, showSymbol: false, connectNulls: false,
            lineStyle: { width: 1.5, color: slotColor(p, m.model.slot) }, itemStyle: { color: slotColor(p, m.model.slot) },
            data: pts(m.time, m.fzl),
          })),
          {
            type: 'line', name: 'Snow level (blend)', showSymbol: false, z: 5,
            lineStyle: { width: 3.5, color: p.ink1 }, itemStyle: { color: p.ink1 },
            data: pts(data.blend.time, data.blend.snowLevel),
            markLine: {
              silent: true, symbol: 'none',
              lineStyle: { color: p.ink3, type: 'solid', width: 1 },
              label: { color: p.ink2, fontSize: 11, position: 'end', formatter: (x: { name: string }) => x.name },
              data: resort.bands.map((b) => ({ yAxis: fmt.elevVal(b.elevation), name: `${b.label} ${fmt.elev(b.elevation)}` })),
            },
          },
        ],
      };
    },
    [data, visible, resort, fmt],
  );
  return <Chart option={option} height={300} ariaLabel="Freezing level and snow level by model" />;
}

function TempChart({ data, visible, tz, fmt }: { data: BandForecast; visible: DerivedHourly[]; tz: string; fmt: Fmt }) {
  const option = useCallback(
    (p: ChartPalette): EChartsCoreOption => {
      const base = baseOption(p) as Record<string, unknown>;
      return {
        ...base,
        xAxis: { ...(base.xAxis as object), type: 'time' },
        yAxis: { ...(base.yAxis as object), type: 'value', name: fmt.tempUnit, nameTextStyle: { color: p.ink3 } },
        tooltip: {
          ...(base.tooltip as object),
          formatter: (params: { seriesName: string; value: [number, number | null]; color: string }[]) =>
            tipHeader(new Date(params[0]?.value[0]).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', timeZone: tz }), p) +
            params.filter((x) => x.value?.[1] != null).sort((a, b) => b.value[1]! - a.value[1]!)
              .map((x) => tipRow(x.color, x.seriesName, `${x.value[1]!.toFixed(0)}${fmt.tempUnit}`, p)).join(''),
        },
        series: visible.map((m, idx) => ({
          type: 'line', name: m.model.label, showSymbol: false,
          lineStyle: { width: 1.5, color: slotColor(p, m.model.slot) }, itemStyle: { color: slotColor(p, m.model.slot) },
          data: m.time.map((t, i) => [t * 1000, fmt.tempVal(m.tC[i])]),
          markLine: idx === 0 ? {
            silent: true, symbol: 'none', lineStyle: { color: p.ink3, type: 'solid', width: 1 },
            label: { color: p.ink2, fontSize: 11, formatter: 'freezing', position: 'insideEndTop' },
            data: [{ yAxis: fmt.units === 'imperial' ? 32 : 0 }],
          } : undefined,
        })),
      };
    },
    [data, visible, tz, fmt],
  );
  return <Chart option={option} height={240} ariaLabel="Temperature by model" />;
}

function DailyTable({ data, tz, fmt }: { data: BandForecast; tz: string; fmt: Fmt }) {
  const today = todayIn(tz);
  const days = data.blendDaily.filter((d) => d.date >= today).slice(0, 16);
  return (
    <div className="overflow-x-auto mt-3">
      <table className="data">
        <thead>
          <tr>
            <th>Day</th>
            <th>Blend snow</th>
            <th>Rain</th>
            <th>Snow level</th>
            {data.models.map((m) => <th key={m.model.id}>{m.model.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {days.map((d) => (
            <tr key={d.date}>
              <td>{dayLabel(d.date)}</td>
              <td><b>{fmt.snow(d.snowCm)}</b></td>
              <td>{fmt.water(d.rainMm)}</td>
              <td>{d.snowLevelMin == null ? '—' : fmt.elevRange(d.snowLevelMin, d.snowLevelMax)}</td>
              {data.models.map((m) => {
                const r = data.daily[m.model.id]?.find((x) => x.date === d.date);
                return <td key={m.model.id}>{r && r.hours >= 20 ? fmt.snow(r.snowCm) : '—'}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EnsembleSection({ ens, loading, error, data, now, band, resort, fmt }: {
  ens?: EnsembleSet; loading: boolean; error?: Error; data: BandForecast; now: number;
  band: { label: string; elevation: number }; resort: Resort; fmt: Fmt;
}) {
  const thresholdsCm = fmt.units === 'imperial' ? [4, 8, 12, 20].map((x) => x * 2.54) : [10, 20, 30, 50];
  const horizons = [72, 168, 240];
  const plume = useMemo(() => (ens ? cumulativePlume(ens.time, ens.members, now) : null), [ens, now]);
  const option = useCallback(
    (p: ChartPalette): EChartsCoreOption => {
      const base = baseOption(p) as Record<string, unknown>;
      if (!plume) return base;
      const t = plume.time.map((x) => x * 1000);
      const v = (s: (number | null)[]) => s.map((x) => fmt.snowVal(x));
      const lo90 = v(plume.p10);
      const hi90 = v(plume.p90);
      const lo50 = v(plume.p25);
      const hi50 = v(plume.p75);
      const diff = (a: (number | null)[], b: (number | null)[]) => a.map((x, i) => (x == null || b[i] == null ? null : x - b[i]!));
      let acc = 0;
      const blendCum: [number, number | null][] = [];
      data.blend.time.forEach((tt, i) => {
        if (tt <= now || !isNum(data.blend.snowCm[i])) return;
        acc += data.blend.snowCm[i]!;
        blendCum.push([tt * 1000, fmt.snowVal(acc)]);
      });
      const band = (name: string, lower: (number | null)[], upper: (number | null)[], color: string) => [
        { type: 'line', name: `${name} lower`, stack: name, symbol: 'none', lineStyle: { opacity: 0 }, data: t.map((x, i) => [x, lower[i]]), tooltip: { show: false } },
        { type: 'line', name, stack: name, symbol: 'none', lineStyle: { opacity: 0 }, areaStyle: { color }, data: t.map((x, i) => [x, diff(upper, lower)[i]]) },
      ];
      return {
        ...base,
        xAxis: { ...(base.xAxis as object), type: 'time' },
        yAxis: { ...(base.yAxis as object), type: 'value', name: fmt.snowUnit, nameTextStyle: { color: p.ink3 } },
        tooltip: {
          ...(base.tooltip as object),
          formatter: (params: { dataIndex: number; value: [number, number] }[]) => {
            const i = params[0]?.dataIndex ?? 0;
            const f = (x: number | null | undefined) => (x == null ? '—' : `${x.toFixed(fmt.units === 'imperial' ? 1 : 0)} ${fmt.snowUnit}`);
            return tipHeader(new Date(t[i]).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', timeZone: resort.tz }), p) +
              tipRow(p.proj.outer, '90th percentile', f(hi90[i]), p) +
              tipRow(p.proj.inner, '75th', f(hi50[i]), p) +
              tipRow(p.proj.line, 'median', f(v(plume.p50)[i]), p) +
              tipRow(p.proj.inner, '25th', f(lo50[i]), p) +
              tipRow(p.proj.outer, '10th percentile', f(lo90[i]), p) +
              tipRow(p.ink3, 'centres contributing', String(plume.families[i]), p);
          },
        },
        series: [
          ...band('10–90%', lo90, hi90, p.proj.outer),
          ...band('25–75%', lo50, hi50, p.proj.inner),
          { type: 'line', name: 'Ensemble median', symbol: 'none', lineStyle: { width: 2.5, color: p.proj.line }, data: t.map((x, i) => [x, v(plume.p50)[i]]) },
          { type: 'line', name: 'Deterministic blend', symbol: 'none', lineStyle: { width: 1.5, color: p.ink2 }, data: blendCum, tooltip: { show: false } },
        ],
      };
    },
    [plume, data, now, fmt, resort.tz],
  );
  return (
    <Section
      title="Ensemble outlook"
      subtitle={
        <>
          {ens ? `${ens.members.length} members from ${new Set(ens.members.map((m) => m.def.label)).size} ensembles` : 'Ensembles'} at {band.label.toLowerCase()} ({fmt.elev(band.elevation)}).
          Each forecast centre gets equal weight. This is model spread, not a verified probability.
          Fewer centres contribute at longer leads (ICON-EPS ends near day 7, MOGREPS-G near day 10); the plume stops when fewer than three centres remain.
        </>
      }
    >
      {error && <Notice tone="error">Ensemble request failed: {error.message}</Notice>}
      {ens?.failed.length ? <Notice tone="warn">Unavailable right now: {ens.failed.join(', ')}.</Notice> : null}
      {!ens ? (
        loading ? <Loading what="ensembles" /> : null
      ) : (
        <div className="grid lg:grid-cols-[1fr_320px] gap-4">
          <div>
            <div className="text-xs text-ink-2 mb-1">Cumulative snowfall from now — shaded: 10–90% and 25–75% of members; dark line: median; grey line: deterministic blend.</div>
            <Chart option={option} height={280} ariaLabel="Ensemble cumulative snowfall plume" />
          </div>
          <div>
            <table className="data">
              <thead>
                <tr>
                  <th>Chance of at least</th>
                  {horizons.map((h) => <th key={h}>{h / 24} days</th>)}
                </tr>
              </thead>
              <tbody>
                {thresholdsCm.map((th) => (
                  <tr key={th}>
                    <td>{fmt.snow(th)}</td>
                    {horizons.map((h) => {
                      const ws = windowTotals(ens.time, ens.members, now, now + h * 3600);
                      const pr = probabilityAtLeast(ws, th);
                      return <td key={h} title={`${ws.families.length} centres`}>{pr == null ? '—' : `${Math.round(pr * 100)}%`}</td>;
                    })}
                  </tr>
                ))}
                {resort.bands.slice(1).map((b) => (
                  <tr key={b.key}>
                    <td>Freezing level above {b.label.toLowerCase()}</td>
                    {horizons.map((h) => {
                      const pr = probabilityFzlAbove(ens.time, ens.members, now, now + h * 3600, b.elevation);
                      return <td key={h}>{pr == null ? '—' : `${Math.round(pr * 100)}%`}</td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="text-[11px] text-ink-3 mt-2">Freezing-level rows: share of members whose 0 °C level rises above that elevation at any hour in the window.</div>
          </div>
        </div>
      )}
    </Section>
  );
}

/** Rain at the band, aligned under the daily snowfall bars (mm can't share the snow axis). */
function RainStrip({ data, tz, fmt }: { data: BandForecast; tz: string; fmt: Fmt }) {
  const today = todayIn(tz);
  const days = data.blendDaily.filter((d) => d.date >= today).slice(0, 16);
  const total = days.reduce((s, d) => s + (d.rainMm ?? 0), 0);
  const option = useCallback(
    (p: ChartPalette): EChartsCoreOption => {
      const base = baseOption(p) as Record<string, unknown>;
      return {
        ...base,
        grid: { left: 52, right: 16, top: 16, bottom: 4 },
        xAxis: { ...(base.xAxis as object), type: 'category', data: days.map((d) => d.date), axisLabel: { show: false }, axisLine: { lineStyle: { color: p.axis } } },
        yAxis: { type: 'value', show: false, min: 0 },
        tooltip: {
          ...(base.tooltip as object),
          formatter: (params: { dataIndex: number }[]) => {
            const d = days[params[0]?.dataIndex ?? 0];
            return d ? tipHeader(d.date, p) + tipRow(p.rain, 'rain (blend)', fmt.water(d.rainMm), p) : '';
          },
        },
        series: [{
          type: 'bar', name: 'Rain', barWidth: '58%',
          itemStyle: { color: p.rain, borderRadius: [3, 3, 0, 0] },
          label: {
            show: true, position: 'top', color: p.ink2, fontSize: 10,
            formatter: (x: { value: number | null }) => (x.value != null && x.value >= (fmt.units === 'imperial' ? 0.02 : 0.5) ? (fmt.units === 'imperial' ? x.value.toFixed(2) : x.value.toFixed(0)) : ''),
          },
          data: days.map((d) => fmt.waterVal(d.rainMm)),
        }],
      };
    },
    [days, fmt],
  );
  if (total < 0.5) return <div className="text-xs text-ink-3 mt-1 pl-[52px]">No rain forecast at this elevation.</div>;
  return (
    <div className="mt-1">
      <div className="flex items-center gap-1.5 text-xs text-ink-2 pl-[52px]">
        <span aria-hidden style={{ width: 10, height: 10, background: 'var(--rain)', borderRadius: 2 }} />
        Rain at this elevation ({fmt.waterUnit}) — {fmt.water(total)} over {days.length} days
      </div>
      <Chart option={option} height={70} ariaLabel="Rain forecast by day" />
    </div>
  );
}

function SnowRampLegend({ fmt }: { fmt: Fmt }) {
  const bounds = SNOW_CLASSES_CM.map((b) => Math.round(fmt.snowVal(b)!));
  const labels = [`< ${bounds[0]}`, ...bounds.slice(1).map((b, i) => `${bounds[i]}–${b}`), `${bounds.at(-1)}+`];
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-2 mt-2 pl-[52px]" aria-label="Snow amount colour scale">
      <span>Snow per day ({fmt.snowUnit}):</span>
      {labels.map((l, i) => (
        <span key={l} className="flex items-center gap-1">
          <span aria-hidden style={{ width: 12, height: 10, background: `var(--snow-${i + 1})`, borderRadius: 2 }} />
          {l}
        </span>
      ))}
    </div>
  );
}
