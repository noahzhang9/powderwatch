import { useCallback, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { MODELS, NBM, horizonText } from '../config/models';
import type { Band, BandKey, Resort } from '../config/resorts';
import { bandInText } from '../config/resorts';
import { Chart, baseOption, tipHeader, tipRow, type EChartsCoreOption } from '../components/Chart';
import { Disclosure, Lazy, Loading, ModelChip, Notice, RequestError, Section, Seg } from '../components/ui';
import { useBandForecast, useEnsembles, useNbm, useRunMeta, useWpc, type BandForecast, type EnsembleSet, type NbmForecast } from '../hooks/data';
import { useNarrow } from '../hooks/useNarrow';
import { useHashParam } from '../hooks/useRoute';
import { cumulativePlume, dailyDistributions } from '../lib/ensemble';
import { dailyCentres, dailyPhase, drivenDays, lastValidTime, type DerivedHourly, type DrivenDay } from '../lib/forecast';
import { alpha, slotColor, type ChartPalette } from '../lib/palette';
import { useFmt, usePrefs, type Fmt } from '../lib/prefs';
import { isNum, rangeAcross, type Series } from '../lib/stats';
import { dayLabel, localDate, localHourLabel, nowUnix, todayIn } from '../lib/time';
import { RecentSection } from './RecentSection';
import { DailyLegend, DailySnowChart, PhaseGustStrip, RainStrip, drivenSummary, nbmSnowOn } from './storm/Daily';
import { Chances, RunChangeSummary, RunChangeTable, RunsRow, Totals, WpcChances, useRunChange } from './storm/Panels';
import { ExportMenu } from './storm/Export';
import { DayBreakdown } from './storm/DayBreakdown';

const BANDS = ['base', 'mid', 'summit'] as const;
const VIEWS = ['daily', 'cumulative'] as const;
const MORE = ['0', '1'] as const;
const OFFICIAL = ['0', '1'] as const;
const RUN_TABLE_ID = 'run-change';

export function StormView({ resort }: { resort: Resort }) {
  const fmt = useFmt();
  const narrow = useNarrow();
  const [bandKey, setBandKey] = useHashParam<BandKey>('band', 'mid', BANDS);
  const [mode, setMode] = useHashParam<(typeof VIEWS)[number]>('view', 'daily', VIEWS);
  // "More detail": closed by default, remembered in the URL; its panels mount (and fetch) only when open.
  const [more, setMore] = useHashParam<(typeof MORE)[number]>('more', '0', MORE);
  // "Compare with official guidance": off by default, remembered in the URL; nothing is requested while off.
  const [officialParam, setOfficial] = useHashParam<(typeof OFFICIAL)[number]>('official', '0', OFFICIAL);
  const official = resort.officialGuidance === true && officialParam === '1';
  const band = resort.bands.find((b) => b.key === bandKey)!;
  const fc = useBandForecast(resort, band);
  const ens = useEnsembles({ lat: band.lat, lon: band.lon, elevation: band.elevation }, resort.tz);
  const meta = useRunMeta(resort.models);
  const nbm = useNbm(resort, band, official);
  const nbmData = official ? nbm.data ?? null : null;
  const wpc = useWpc(official);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [rawSnow, setRawSnow] = useState(false);
  const [showTable, setShowTable] = useState(false);
  const [allDays, setAllDays] = useState(false);

  /** The summary's "full table" link: open More detail, then bring the table into view. */
  const showRunTable = () => {
    setMore('1');
    const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    setTimeout(() => document.getElementById(RUN_TABLE_ID)?.scrollIntoView({ behavior, block: 'start' }), 50);
  };

  const toggle = (id: string) =>
    setHidden((h) => {
      const n = new Set(h);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const data = fc.data;
  const now = useMemo(() => nowUnix(), [data]);
  const runChange = useRunChange(data, meta.data, band, resort, now);
  const today = todayIn(resort.tz);
  const visible = useMemo(() => (data ? data.models.filter((m) => !hidden.has(m.model.id)) : []), [data, hidden]);
  const dayCount = narrow && !allDays ? 8 : 16;
  const days = useMemo(() => (data ? data.blendDaily.filter((d) => d.date >= today).slice(0, dayCount) : []), [data, today, dayCount]);
  const centres = useMemo(() => (data ? dailyCentres(data.models, resort.tz) : new Map<string, number>()), [data, resort.tz]);
  const phases = useMemo(() => (data ? dailyPhase(data.blend, resort.tz, resort.bands.map((b) => b.elevation)) : new Map()), [data, resort]);
  const dists = useMemo(() => (ens.data ? dailyDistributions(ens.data.time, ens.data.members, (t) => localDate(t, resort.tz)) : null), [ens.data, resort.tz]);
  const driven = useMemo(() => (data ? drivenDays(data, resort.tz, ens.data) : null), [data, ens.data, resort.tz]);
  // The day whose 3-hour breakdown is open (daily view only), remembered in the URL: any forecast day from today.
  const dayDates = useMemo(() => (data ? data.blendDaily.filter((d) => d.date >= today).map((d) => d.date) : []), [data, today]);
  const [openDay, setOpenDay] = useHashParam<string>('day', '', ['', ...dayDates]);
  const toggleDay = (date: string) => setOpenDay(date === openDay ? '' : date);

  const chips = data && (
    <div className="flex flex-wrap gap-2" role="group" aria-label="Models (toggle visibility)">
      {data.models.map((m) => {
        const end = lastValidTime(m.time, m.precip);
        return (
          <ModelChip
            key={m.model.id}
            color={`var(--s${m.model.slot})`}
            label={m.model.label}
            mark={m.model.kind === 'regional' ? 'diamond' : 'dot'}
            // Regional models run only a day or two ahead: say so on the pill, not only in the popover.
            note={m.model.kind === 'regional' ? horizonText(m.model.horizonH) : undefined}
            on={!hidden.has(m.model.id)}
            onToggle={() => toggle(m.model.id)}
            info={[
              m.model.blurb,
              `${m.model.kind === 'regional' ? `High-res regional model, ${horizonText(m.model.horizonH)} range` : 'Global model'}, ${m.model.resolutionKm} km${end ? ` · data to ${localHourLabel(end, resort.tz)}` : ''}`,
              `Freezing level: ${m.fzlSource === 'model' ? 'model output' : m.fzlSource === 'computed' ? 'computed from pressure levels' : 'unavailable'}`,
            ].join('\n')}
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
        {resort.officialGuidance && (
          <label
            className="btn text-xs"
            title={`Adds NOAA's own forecasts for comparison: the ${NBM.long}'s snowfall on the daily chart, and the Weather Prediction Center's chances of heavy snow. Neither joins the blend.`}
          >
            <input type="checkbox" checked={official} onChange={(e) => setOfficial(e.target.checked ? '1' : '0')} style={{ width: 12, height: 12, margin: 0 }} />
            {narrow ? 'Official guidance' : 'Compare with official guidance'}
          </label>
        )}
      </div>
      {data && (narrow ? (
        <details className="mt-3">
          <summary className="btn">Models ({data.models.length}) ▾</summary>
          <div className="mt-2">{chips}</div>
          <RunsRow ids={resort.models} meta={meta.data} tz={resort.tz} />
        </details>
      ) : <div className="mt-3">{chips}<RunsRow ids={resort.models} meta={meta.data} tz={resort.tz} /></div>)}
      <div aria-live="polite">
        {fc.error && <RequestError what="Forecast" error={fc.error} retry={fc.retry} />}
        {!data && !fc.error && <Loading what="model forecasts" />}
      </div>
      {data?.missing.length ? <Notice>No data at this point from: {data.missing.map((id) => MODELS[id]?.label ?? id).join(', ')}.</Notice> : null}
      {data && (
        <>
          <Totals data={data} now={now} ens={ens.data} fmt={fmt} rawSnow={rawSnow} resort={resort} band={band} />
          <RunChangeSummary rc={runChange} fmt={fmt} onShowTable={showRunTable} />
          <Section
            title={`Snowfall at ${bandInText(band)} (${fmt.elev(band.elevation)})`}
            subtitle={mode === 'daily'
              ? 'Blend of all models, shaded by amount, total under each day. Hover a day for every model, the ensemble range and whether the models are split; click it for its 3-hour breakdown.'
              : 'Cumulative snowfall from now, the blend and each model shown.'}
            right={
              <div className="flex flex-wrap gap-2">
                {mode === 'daily' && narrow && <button type="button" className="btn" onClick={() => setAllDays((a) => !a)}>{allDays ? '8 days' : '16 days'}</button>}
                {/* Off by default: Open-Meteo's own snowfall, for comparison with PowderWatch physics. */}
                <label className="btn" title="Show Open-Meteo's own snowfall (fixed 7:1 snow-to-liquid ratio) instead of PowderWatch physics, here and in the totals above. For comparison only.">
                  <input type="checkbox" checked={rawSnow} onChange={(e) => setRawSnow(e.target.checked)} style={{ width: 12, height: 12, margin: 0 }} />
                  {narrow ? 'Raw 7:1' : 'Open-Meteo raw snowfall (7:1)'}
                </label>
                <button type="button" className="btn" aria-pressed={showTable} onClick={() => setShowTable((s) => !s)}>{showTable ? 'Hide table' : 'Table'}</button>
                <ExportMenu input={{ resort, band, data, fmt, nowS: now, today, dists, driven, centres, phases, ens: ens.data, meta: meta.data, nbm: nbmData }} />
              </div>
            }
          >
            {mode === 'daily' ? (
              <>
                {/* Keyboard path to the breakdown (the chart's bars aren't focusable): shown once focus enters it. */}
                <div className="sr-only focus-within:not-sr-only focus-within:flex flex-wrap items-center gap-1 text-xs mb-2" role="group" aria-label="3-hour breakdown by day">
                  <span className="text-ink-2 mr-1">3-hour breakdown:</span>
                  {days.map((d) => (
                    <button key={d.date} type="button" className="btn" aria-pressed={d.date === openDay} onClick={() => toggleDay(d.date)}>
                      {d.date === today ? 'Today' : dayLabel(d.date)}
                    </button>
                  ))}
                </div>
                <DailySnowChart data={data} days={days} dists={dists} driven={driven} centres={centres} phases={phases} visible={visible} resort={resort} fmt={fmt} narrow={narrow} rawSnow={rawSnow} today={today} nbm={nbmData} onDayClick={toggleDay} selected={openDay || undefined} />
                <RainStrip days={days} fmt={fmt} />
                <PhaseGustStrip days={days} phases={phases} resort={resort} fmt={fmt} narrow={narrow} />
                <DailyLegend fmt={fmt} nbm={nbmData} tz={resort.tz} />
                {openDay && (
                  <DayBreakdown
                    date={openDay} dates={dayDates} data={data} ens={ens.data} visible={visible} resort={resort} band={band}
                    fmt={fmt} narrow={narrow} rawSnow={rawSnow} onSelect={setOpenDay} onClose={() => setOpenDay('')}
                  />
                )}
                {official && nbm.error && <RequestError what={NBM.label} error={nbm.error} retry={nbm.retry} />}
              </>
            ) : (
              <>
                <CumulativeChart data={data} visible={visible} now={now} tz={resort.tz} fmt={fmt} rawSnow={rawSnow} />
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-ink-2 mt-2" aria-label="Legend">
                  <span className="flex items-center gap-1.5">
                    <span aria-hidden style={{ width: 16, height: 3.5, background: 'var(--ink-1)', display: 'inline-block', borderRadius: 1 }} />
                    Blend
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span aria-hidden style={{ width: 16, height: 2, background: 'var(--ink-3)', display: 'inline-block', borderRadius: 1 }} />
                    each model, in its chip's colour
                  </span>
                </div>
              </>
            )}
            {showTable && <DailyTable data={data} tz={resort.tz} fmt={fmt} nbm={nbmData} driven={driven} />}
          </Section>
          {ens.error && <RequestError what="Ensemble" error={ens.error} retry={ens.retry} />}
          <Chances ens={ens.data} now={now} resort={resort} fmt={fmt} />
          {official && <WpcChances wpc={wpc.data} loading={wpc.loading} error={wpc.error} resort={resort} fmt={fmt} />}
          <Disclosure
            label="More detail"
            hint="Run-to-run table · freezing & snow level · temperature · ensemble plume · last 7 days measured vs modelled"
            open={more === '1'}
            onToggle={(o) => setMore(o ? '1' : '0')}
          >
            <div id={RUN_TABLE_ID} className="scroll-mt-4"><RunChangeTable rc={runChange} fmt={fmt} tz={resort.tz} /></div>
            <LevelsSection data={data} visible={visible} resort={resort} fmt={fmt} />
            <TempSection data={data} visible={visible} band={band} tz={resort.tz} fmt={fmt} />
            <EnsembleSection ens={ens.data} loading={ens.loading} error={undefined} data={data} now={now} band={band} resort={resort} fmt={fmt} />
            <Lazy><RecentSection resort={resort} band={band} /></Lazy>
          </Disclosure>
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

/**
 * The hourly charts under More detail lead with the blend and a band spanning the models shown,
 * lowest to highest at each hour (with a handful of models, percentiles would only interpolate
 * between them). "Each model" adds one line per model in its colour. The model chips choose which
 * models feed the band and the lines; the blend is always every model's, as on the rest of the page.
 */
const spreadAlpha = (dark: boolean) => (dark ? 0.32 : 0.22);
const spreadFill = (p: ChartPalette) => alpha(p.ink3, spreadAlpha(p.dark));
/** Opacity of the snow level in dry hours (chart line and legend key). */
const DRY_ALPHA = 0.25;

/** The band as two stacked lines: an invisible lower edge, then the (upper − lower) height, filled. */
function spreadSeries(name: string, time: number[], lo: Series, hi: Series, fill: string) {
  const common = { type: 'line', stack: name, stackStrategy: 'all', symbol: 'none', silent: true, connectNulls: false, z: 1, lineStyle: { opacity: 0 } };
  return [
    { ...common, name: `${name} lower`, data: time.map((t, i) => [t * 1000, lo[i]]) },
    { ...common, name, areaStyle: { color: fill, opacity: 1 }, data: time.map((t, i) => [t * 1000, lo[i] == null || hi[i] == null ? null : hi[i]! - lo[i]!]) },
  ];
}

/** Every series is built on the blend's hours, so a tooltip's data index is the hour index. */
type AxisParams = { dataIndex: number }[];
const tipTime = (unix: number, tz: string) => new Date(unix * 1000).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', timeZone: tz });
/** Sort key for a possibly missing value (missing last). */
const sortVal = (v: number | null | undefined) => (isNum(v) ? v : -Infinity);

/** "Each model" switch for a More detail chart: off by default. */
function EachModelToggle({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="btn text-xs" title="Draw each model's own line, in its colour. The model chips above choose which models are drawn and which feed the shaded range.">
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} style={{ width: 12, height: 12, margin: 0 }} />
      Each model
    </label>
  );
}

/** Legend under a More detail chart; each key mirrors its mark. */
function SpreadLegend({ items }: { items: { key: ReactNode; label: string }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-ink-2 mt-2" style={{ paddingLeft: 52 }} aria-label="Legend">
      {items.map((x) => <span key={x.label} className="flex items-center gap-1.5">{x.key}{x.label}</span>)}
    </div>
  );
}

const lineKey = (style: CSSProperties) => <span aria-hidden style={{ width: 16, display: 'inline-block', ...style }} />;
/** The band's fill as a legend swatch (the same mix the chart uses). */
const bandKey = (dark: boolean) => (
  <span aria-hidden style={{ width: 12, height: 10, background: `color-mix(in srgb, var(--ink-3) ${spreadAlpha(dark) * 100}%, transparent)`, borderRadius: 2, display: 'inline-block' }} />
);
/** Short segments in the first few shown models' colours, for "each model's line". */
const modelsKey = (models: DerivedHourly[]) => (
  <span aria-hidden className="inline-flex gap-0.5">
    {models.slice(0, 3).map((m) => <span key={m.model.id} style={{ width: 6, height: 2, background: `var(--s${m.model.slot})`, display: 'inline-block' }} />)}
  </span>
);

function LevelsSection({ data, visible, resort, fmt }: { data: BandForecast; visible: DerivedHourly[]; resort: Resort; fmt: Fmt }) {
  const [lines, setLines] = useState(false);
  const { dark } = usePrefs();
  const shown = useMemo(() => visible.filter((m) => m.fzl.some(isNum)), [visible]);
  const range = useMemo(() => rangeAcross(shown.map((m) => m.fzl)), [shown]);
  const option = useCallback(
    (p: ChartPalette): EChartsCoreOption => {
      const base = baseOption(p) as Record<string, unknown>;
      const b = data.blend;
      const conv = (s: Series) => s.map((v) => fmt.elevVal(v));
      const pts = (s: Series) => b.time.map((t, i) => [t * 1000, fmt.elevVal(s[i])] as [number, number | null]);
      const wet = (i: number) => (b.precip[i] ?? 0) >= 0.3;
      const faint = alpha(p.ink1, DRY_ALPHA);
      return {
        ...base,
        grid: { left: 52, right: 16, top: 16, bottom: 28 },
        xAxis: { ...(base.xAxis as object), type: 'time' },
        yAxis: { ...(base.yAxis as object), type: 'value', name: fmt.elevUnit, min: 0, nameTextStyle: { color: p.ink3 } },
        tooltip: {
          ...(base.tooltip as object),
          formatter: (params: AxisParams) => {
            const i = params[0]?.dataIndex;
            if (i == null || b.time[i] == null) return '';
            const rows = [
              isNum(b.fzl[i]) ? tipRow(p.ink2, 'freezing level, blend', fmt.elev(b.fzl[i]), p, 'dashed') : '',
              isNum(range.lo[i]) ? tipRow(spreadFill(p), `freezing level, range of ${range.n[i]} models`, fmt.elevRange(range.lo[i], range.hi[i]), p, 'band') : '',
              ...(lines
                ? shown
                  .filter((m) => isNum(m.fzl[i]))
                  .sort((x, y) => sortVal(y.fzl[i]) - sortVal(x.fzl[i]))
                  .map((m) => tipRow(slotColor(p, m.model.slot), `${m.model.label} freezing level`, fmt.elev(m.fzl[i]), p))
                : []),
              isNum(b.snowLevel[i]) ? tipRow(wet(i) ? p.ink1 : faint, wet(i) ? 'snow level, blend' : 'snow level, blend (dry hour)', fmt.elev(b.snowLevel[i]), p) : '',
            ];
            return tipHeader(tipTime(b.time[i], resort.tz), p) + rows.join('');
          },
        },
        series: [
          ...spreadSeries('Freezing level range', b.time, conv(range.lo), conv(range.hi), spreadFill(p)),
          ...(lines
            ? shown.map((m) => ({
              type: 'line', name: `${m.model.label} freezing level`, showSymbol: false, connectNulls: false, z: 2,
              lineStyle: { width: 1.5, color: slotColor(p, m.model.slot) }, itemStyle: { color: slotColor(p, m.model.slot) },
              data: pts(m.fzl),
            }))
            : []),
          {
            type: 'line', name: 'Freezing level (blend)', showSymbol: false, connectNulls: false, z: 3,
            lineStyle: { width: 2, color: p.ink2, type: 'dashed' }, itemStyle: { color: p.ink2 },
            data: pts(b.fzl),
          },
          {
            // Faint everywhere; solid only while it is precipitating, when snow level matters.
            type: 'line', name: 'Snow level, dry hours', showSymbol: false, z: 4, silent: true,
            lineStyle: { width: 2, color: faint }, itemStyle: { color: faint },
            data: pts(b.snowLevel),
          },
          {
            type: 'line', name: 'Snow level (blend)', showSymbol: false, z: 5, connectNulls: false,
            lineStyle: { width: 3.5, color: p.ink1 }, itemStyle: { color: p.ink1 },
            data: pts(b.snowLevel.map((v, i) => (wet(i) ? v : null))),
            markLine: {
              // Above every line (markLine's own z defaults to 5), so the snow level never covers a label.
              silent: true, symbol: 'none', z: 6,
              lineStyle: { color: p.ink3, type: 'solid', width: 1 },
              label: {
                color: p.ink2, fontSize: 11, position: 'insideStartTop', formatter: (x: { name: string }) => x.name,
                backgroundColor: p.surface, padding: [1, 3], borderRadius: 2,
              },
              // The lowest band's label sits under its line, so bands a few hundred metres apart don't overprint.
              data: resort.bands.map((bd) => ({
                yAxis: fmt.elevVal(bd.elevation), name: `${bd.label} ${fmt.elev(bd.elevation)}`,
                ...(bd.elevation === Math.min(...resort.bands.map((x) => x.elevation)) ? { label: { position: 'insideStartBottom' } } : {}),
              })),
            },
          },
        ],
      };
    },
    [data, shown, range, lines, resort, fmt],
  );
  return (
    <Section
      title="Freezing level & snow level"
      subtitle="Freezing level (0 °C) and snow level blended across all models. Shading: the lowest to highest freezing level of the models selected above, hour by hour. Rules: this resort's elevation bands."
      right={<EachModelToggle on={lines} onChange={setLines} />}
    >
      <Chart
        option={option}
        height={300}
        ariaLabel={`Freezing level and snow level: blend${shown.length >= 2 ? `, with the range of ${shown.length} models` : ''}${lines ? ', and each model' : ''}`}
      />
      <SpreadLegend
        items={[
          { key: lineKey({ height: 0, borderTop: '2px dashed var(--ink-2)' }), label: 'freezing level, blend' },
          ...(shown.length >= 2 ? [{ key: bandKey(dark), label: `freezing level, range of ${shown.length} models` }] : []),
          ...(lines && shown.length ? [{ key: modelsKey(shown), label: "each model's freezing level (colours as the chips)" }] : []),
          { key: lineKey({ height: 3.5, background: 'var(--ink-1)', borderRadius: 1 }), label: 'snow level, blend, while precipitating' },
          { key: lineKey({ height: 2, background: `color-mix(in srgb, var(--ink-1) ${DRY_ALPHA * 100}%, transparent)` }), label: 'snow level, dry hours' },
        ]}
      />
    </Section>
  );
}

function TempSection({ data, visible, band, tz, fmt }: { data: BandForecast; visible: DerivedHourly[]; band: Band; tz: string; fmt: Fmt }) {
  const [lines, setLines] = useState(false);
  const { dark } = usePrefs();
  const shown = useMemo(() => visible.filter((m) => m.tC.some(isNum)), [visible]);
  const range = useMemo(() => rangeAcross(shown.map((m) => m.tC)), [shown]);
  const option = useCallback(
    (p: ChartPalette): EChartsCoreOption => {
      const base = baseOption(p) as Record<string, unknown>;
      const b = data.blend;
      const conv = (s: Series) => s.map((v) => fmt.tempVal(v));
      const deg = (c: number) => fmt.tempVal(c)!.toFixed(0);
      const temp = (c: number) => `${deg(c)}${fmt.tempUnit}`;
      // "−5 to 2 °C" reads better than "−5–2 °C".
      const tempRange = (lo: number, hi: number) => `${deg(lo)}${fmt.tempVal(lo)! < 0 ? ' to ' : '–'}${deg(hi)}${fmt.tempUnit}`;
      return {
        ...base,
        xAxis: { ...(base.xAxis as object), type: 'time' },
        yAxis: { ...(base.yAxis as object), type: 'value', name: fmt.tempUnit, nameTextStyle: { color: p.ink3 } },
        tooltip: {
          ...(base.tooltip as object),
          formatter: (params: AxisParams) => {
            const i = params[0]?.dataIndex;
            if (i == null || b.time[i] == null) return '';
            const rows = [
              isNum(b.tC[i]) ? tipRow(p.ink1, 'blend', temp(b.tC[i]!), p) : '',
              isNum(range.lo[i]) && isNum(range.hi[i]) ? tipRow(spreadFill(p), `range of ${range.n[i]} models`, tempRange(range.lo[i]!, range.hi[i]!), p, 'band') : '',
              ...(lines
                ? shown
                  .filter((m) => isNum(m.tC[i]))
                  .sort((x, y) => sortVal(y.tC[i]) - sortVal(x.tC[i]))
                  .map((m) => tipRow(slotColor(p, m.model.slot), m.model.label, temp(m.tC[i]!), p))
                : []),
            ];
            return tipHeader(tipTime(b.time[i], tz), p) + rows.join('');
          },
        },
        series: [
          ...spreadSeries('Temperature range', b.time, conv(range.lo), conv(range.hi), spreadFill(p)),
          ...(lines
            ? shown.map((m) => ({
              type: 'line', name: m.model.label, showSymbol: false, connectNulls: false, z: 2,
              lineStyle: { width: 1.5, color: slotColor(p, m.model.slot) }, itemStyle: { color: slotColor(p, m.model.slot) },
              data: b.time.map((t, i) => [t * 1000, fmt.tempVal(m.tC[i])]),
            }))
            : []),
          {
            type: 'line', name: 'Blend', showSymbol: false, connectNulls: false, z: 3,
            lineStyle: { width: 2.5, color: p.ink1 }, itemStyle: { color: p.ink1 },
            data: b.time.map((t, i) => [t * 1000, fmt.tempVal(b.tC[i])]),
            markLine: {
              // Above the lines (markLine's own z defaults to 5), with a backing so its label stays legible.
              silent: true, symbol: 'none', z: 6, lineStyle: { color: p.ink3, type: 'solid', width: 1 },
              label: { color: p.ink2, fontSize: 11, formatter: 'freezing', position: 'insideEndTop', backgroundColor: p.surface, padding: [1, 3], borderRadius: 2 },
              data: [{ yAxis: fmt.units === 'imperial' ? 32 : 0 }],
            },
          },
        ],
      };
    },
    [data, shown, range, lines, tz, fmt],
  );
  return (
    <Section
      title={`Temperature at ${bandInText(band)}`}
      subtitle="Model 2 m temperature downscaled to the band elevation, blended across all models. Shading: the lowest to highest of the models selected above, hour by hour."
      right={<EachModelToggle on={lines} onChange={setLines} />}
    >
      <Chart
        option={option}
        height={240}
        ariaLabel={`Temperature: blend${shown.length >= 2 ? `, with the range of ${shown.length} models` : ''}${lines ? ', and each model' : ''}`}
      />
      <SpreadLegend
        items={[
          { key: lineKey({ height: 2.5, background: 'var(--ink-1)', borderRadius: 1 }), label: 'blend' },
          ...(shown.length >= 2 ? [{ key: bandKey(dark), label: `range of ${shown.length} models` }] : []),
          ...(lines && shown.length ? [{ key: modelsKey(shown), label: 'each model (colours as the chips)' }] : []),
        ]}
      />
    </Section>
  );
}

function DailyTable({ data, tz, fmt, nbm, driven }: {
  data: BandForecast; tz: string; fmt: Fmt; nbm: NbmForecast | null; driven: Map<string, DrivenDay> | null;
}) {
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
            {nbm && <th title={`${NBM.long}: official guidance, its own snowfall, not in the blend`}>{NBM.label}</th>}
          </tr>
        </thead>
        <tbody>
          {days.map((d) => {
            const dr = driven?.get(d.date);
            return (
              <tr key={d.date}>
                <td>{d.date === today ? 'Today' : dayLabel(d.date)}</td>
                <td>
                  <b>{fmt.snow(d.snowCm)}</b>
                  {dr && <i className="ml-1.5 text-ink-2" title={drivenSummary(dr)}>outlier<span className="sr-only"> ({drivenSummary(dr)})</span></i>}
                </td>
                <td>{fmt.water(d.rainMm)}</td>
                <td>{d.snowLevelMin == null ? '—' : fmt.elevRange(d.snowLevelMin, d.snowLevelMax)}</td>
                {data.models.map((m) => {
                  const r = data.daily[m.model.id]?.find((x) => x.date === d.date);
                  return <td key={m.model.id}>{r && r.hours >= 20 ? fmt.snow(r.snowCm) : '—'}</td>;
                })}
                {nbm && <td>{fmt.snow(nbmSnowOn(nbm, d.date))}</td>}
              </tr>
            );
          })}
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
