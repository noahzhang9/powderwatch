import { useCallback, useMemo, useState } from 'react';
import { MODELS } from '../config/models';
import type { BandKey, Resort } from '../config/resorts';
import { bandInText } from '../config/resorts';
import { Chart, baseOption, tipHeader, tipRow, type EChartsCoreOption } from '../components/Chart';
import { Lazy, Loading, ModelChip, Notice, Section, Seg } from '../components/ui';
import { useBandForecast, useEnsembles, useRunMeta, type BandForecast, type EnsembleSet } from '../hooks/data';
import { useNarrow } from '../hooks/useNarrow';
import { useHashParam } from '../hooks/useRoute';
import { cumulativePlume, dailyDistributions } from '../lib/ensemble';
import { dailyCentres, dailyPhase, lastValidTime, type DerivedHourly } from '../lib/forecast';
import { slotColor, type ChartPalette } from '../lib/palette';
import { useFmt, type Fmt } from '../lib/prefs';
import { isNum } from '../lib/stats';
import { dayLabel, localDate, localHourLabel, nowUnix, todayIn } from '../lib/time';
import { RecentSection } from './RecentSection';
import { DailyLegend, DailySnowChart, PhaseGustStrip, RainStrip } from './storm/Daily';
import { Chances, RunChange, RunsRow, Totals } from './storm/Panels';

const BANDS = ['base', 'mid', 'summit'] as const;
const VIEWS = ['daily', 'cumulative'] as const;

export function StormView({ resort }: { resort: Resort }) {
  const fmt = useFmt();
  const narrow = useNarrow();
  const [bandKey, setBandKey] = useHashParam<BandKey>('band', 'mid', BANDS);
  const [mode, setMode] = useHashParam<(typeof VIEWS)[number]>('view', 'daily', VIEWS);
  const band = resort.bands.find((b) => b.key === bandKey)!;
  const fc = useBandForecast(resort, band);
  const ens = useEnsembles({ lat: band.lat, lon: band.lon, elevation: band.elevation }, resort.tz);
  const meta = useRunMeta(resort.models);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [rawSnow, setRawSnow] = useState(false);
  const [showTable, setShowTable] = useState(false);
  const [allDays, setAllDays] = useState(false);

  const toggle = (id: string) =>
    setHidden((h) => {
      const n = new Set(h);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const data = fc.data;
  const now = useMemo(() => nowUnix(), [data]);
  const today = todayIn(resort.tz);
  const visible = useMemo(() => (data ? data.models.filter((m) => !hidden.has(m.model.id)) : []), [data, hidden]);
  const dayCount = narrow && !allDays ? 8 : 16;
  const days = useMemo(() => (data ? data.blendDaily.filter((d) => d.date >= today).slice(0, dayCount) : []), [data, today, dayCount]);
  const centres = useMemo(() => (data ? dailyCentres(data.models, resort.tz) : new Map<string, number>()), [data, resort.tz]);
  const phases = useMemo(() => (data ? dailyPhase(data.blend, resort.tz, resort.bands.map((b) => b.elevation)) : new Map()), [data, resort]);
  const dists = useMemo(() => (ens.data ? dailyDistributions(ens.data.time, ens.data.members, (t) => localDate(t, resort.tz)) : null), [ens.data, resort.tz]);

  const chips = data && (
    <div className="flex flex-wrap gap-2" role="group" aria-label="Models (toggle visibility)">
      <span className="chip" style={{ cursor: 'default' }} title="Family-balanced blend of all models">
        <span aria-hidden style={{ width: 14, height: 3, background: 'var(--ink-1)', display: 'inline-block', borderRadius: 1 }} />
        Blend
      </span>
      {data.models.map((m) => {
        const end = lastValidTime(m.time, m.precip);
        return (
          <ModelChip
            key={m.model.id}
            color={`var(--s${m.model.slot})`}
            label={`${m.model.kind === 'regional' ? '◆ ' : ''}${m.model.label}`}
            on={!hidden.has(m.model.id)}
            onToggle={() => toggle(m.model.id)}
            title={`${m.model.blurb}\n${m.model.resolutionKm} km${end ? ` · data to ${localHourLabel(end, resort.tz)}` : ''}\nFreezing level: ${m.fzlSource === 'model' ? 'model output' : m.fzlSource === 'computed' ? 'computed from pressure levels' : 'unavailable'}`}
          />
        );
      })}
    </div>
  );

  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-center gap-3">
        <Seg
          label="Elevation band"
          value={bandKey}
          onChange={setBandKey}
          options={resort.bands.map((b) => ({ value: b.key, label: narrow ? b.label : `${b.label} · ${fmt.elev(b.elevation)}` }))}
        />
        <Seg label="Snowfall view" value={mode} onChange={setMode} options={[{ value: 'daily', label: 'Daily' }, { value: 'cumulative', label: 'Cumulative' }]} />
        <details className="text-xs text-ink-2">
          <summary className="btn">Advanced</summary>
          <label className="flex items-center gap-1.5 mt-2">
            <input type="checkbox" checked={rawSnow} onChange={(e) => setRawSnow(e.target.checked)} />
            Show Open-Meteo raw snowfall (fixed 7:1 ratio) instead of PowderWatch physics
          </label>
        </details>
      </div>
      {data && (narrow ? (
        <details className="mt-3">
          <summary className="btn">Models ({data.models.length}) ▾</summary>
          <div className="mt-2">{chips}</div>
          <RunsRow ids={resort.models} meta={meta.data} />
        </details>
      ) : <div className="mt-3">{chips}<RunsRow ids={resort.models} meta={meta.data} /></div>)}
      <div aria-live="polite">
        {fc.error && (
          <Notice tone="error">
            Forecast request failed: {fc.error.message} <button type="button" className="btn ml-2" onClick={fc.retry}>Retry</button>
          </Notice>
        )}
        {!data && !fc.error && <Loading what="model forecasts" />}
      </div>
      {data?.missing.length ? <Notice>No data at this point from: {data.missing.map((id) => MODELS[id]?.label ?? id).join(', ')}.</Notice> : null}
      {data && (
        <>
          <Totals data={data} now={now} ens={ens.data} fmt={fmt} rawSnow={rawSnow} resort={resort} band={band} />
          <Section
            title={`Snowfall at ${bandInText(band)} (${fmt.elev(band.elevation)})`}
            subtitle={mode === 'daily'
              ? 'Blend of all models, shaded by amount, total under each day. Hover a day for every model, the ensemble range and whether the models are split.'
              : 'Cumulative snowfall from now. Thick line: blend.'}
            right={
              <div className="flex gap-2">
                {mode === 'daily' && narrow && <button type="button" className="btn" onClick={() => setAllDays((a) => !a)}>{allDays ? '8 days' : '16 days'}</button>}
                <button type="button" className="btn" aria-pressed={showTable} onClick={() => setShowTable((s) => !s)}>{showTable ? 'Hide table' : 'Table'}</button>
              </div>
            }
          >
            {mode === 'daily' ? (
              <>
                <DailySnowChart data={data} days={days} dists={dists} centres={centres} phases={phases} visible={visible} resort={resort} fmt={fmt} narrow={narrow} rawSnow={rawSnow} today={today} />
                <RainStrip days={days} fmt={fmt} />
                <PhaseGustStrip days={days} phases={phases} resort={resort} fmt={fmt} narrow={narrow} />
                <DailyLegend fmt={fmt} />
              </>
            ) : (
              <CumulativeChart data={data} visible={visible} now={now} tz={resort.tz} fmt={fmt} rawSnow={rawSnow} />
            )}
            {showTable && <DailyTable data={data} tz={resort.tz} fmt={fmt} />}
          </Section>
          {ens.error && (
            <Notice tone="error">Ensemble request failed: {ens.error.message} <button type="button" className="btn ml-2" onClick={ens.retry}>Retry</button></Notice>
          )}
          <Chances ens={ens.data} now={now} resort={resort} fmt={fmt} />
          <Lazy><RunChange data={data} meta={meta.data} band={band} resort={resort} now={now} fmt={fmt} /></Lazy>
          <Section
            title="Freezing level & snow level"
            subtitle="Thin lines: each model's freezing level (0 °C). Thick line: blended snow level, solid while precipitating. Rules: this resort's elevation bands."
          >
            <LevelsChart data={data} visible={visible} resort={resort} fmt={fmt} />
          </Section>
          <Section title={`Temperature at ${bandInText(band)}`} subtitle="Model 2 m temperature downscaled to the band elevation.">
            <TempChart data={data} visible={visible} tz={resort.tz} fmt={fmt} />
          </Section>
          <EnsembleSection ens={ens.data} loading={ens.loading} error={undefined} data={data} now={now} band={band} resort={resort} fmt={fmt} />
          <Lazy><RecentSection resort={resort} band={band} /></Lazy>
        </>
      )}
    </div>
  );
}

/** Cumulative snowfall from now, one line per model plus the blend. */
function CumulativeChart({ data, visible, now, tz, fmt, rawSnow }: {
  data: BandForecast; visible: DerivedHourly[]; now: number; tz: string; fmt: Fmt; rawSnow: boolean;
}) {
  const option = useCallback(
    (p: ChartPalette): EChartsCoreOption => {
      const base = baseOption(p) as Record<string, unknown>;
      const key = rawSnow ? 'omSnowCm' : 'snowCm';
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
    [data, visible, now, tz, fmt, rawSnow],
  );
  return <Chart option={option} height={300} ariaLabel="Cumulative snowfall by model" />;
}

function LevelsChart({ data, visible, resort, fmt }: { data: BandForecast; visible: DerivedHourly[]; resort: Resort; fmt: Fmt }) {
  const option = useCallback(
    (p: ChartPalette): EChartsCoreOption => {
      const base = baseOption(p) as Record<string, unknown>;
      const pts = (time: number[], s: (number | null)[]) => time.map((t, i) => [t * 1000, fmt.elevVal(s[i])] as [number, number | null]);
      return {
        ...base,
        grid: { left: 52, right: 16, top: 16, bottom: 28 },
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
            // Faint everywhere; solid only while it is precipitating, when snow level matters.
            type: 'line', name: 'Snow level, dry hours', showSymbol: false, z: 4, silent: true,
            lineStyle: { width: 2, color: p.ink1, opacity: 0.25 }, itemStyle: { color: p.ink1 }, tooltip: { show: false },
            data: pts(data.blend.time, data.blend.snowLevel),
          },
          {
            type: 'line', name: 'Snow level (blend)', showSymbol: false, z: 5, connectNulls: false,
            lineStyle: { width: 3.5, color: p.ink1 }, itemStyle: { color: p.ink1 },
            data: pts(data.blend.time, data.blend.snowLevel.map((v, i) => ((data.blend.precip[i] ?? 0) >= 0.3 ? v : null))),
            markLine: {
              silent: true, symbol: 'none',
              lineStyle: { color: p.ink3, type: 'solid', width: 1 },
              label: {
                color: p.ink2, fontSize: 11, position: 'insideStartTop', formatter: (x: { name: string }) => x.name,
                backgroundColor: p.surface, padding: [1, 3], borderRadius: 2,
              },
              // The lowest band's label sits under its line, so bands a few hundred metres apart don't overprint.
              data: resort.bands.map((b) => ({
                yAxis: fmt.elevVal(b.elevation), name: `${b.label} ${fmt.elev(b.elevation)}`,
                ...(b.elevation === Math.min(...resort.bands.map((x) => x.elevation)) ? { label: { position: 'insideStartBottom' } } : {}),
              })),
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
              <td>{d.date === today ? 'Today' : dayLabel(d.date)}</td>
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
      title="Ensemble plume"
      subtitle={
        <>
          {ens ? `${ens.members.length} members from ${new Set(ens.members.map((m) => m.def.label)).size} ensembles` : 'Ensembles'} at {bandInText(band)} ({fmt.elev(band.elevation)}).
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
        <div>
          <div className="text-xs text-ink-2 mb-1">Cumulative snowfall from now — shaded: 10–90% and 25–75% of members; dark line: median; grey line: deterministic blend.</div>
          <Chart option={option} height={280} ariaLabel="Ensemble cumulative snowfall plume" />
        </div>
      )}
    </Section>
  );
}
