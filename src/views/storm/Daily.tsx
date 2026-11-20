/**
 * Daily outlook for one elevation band: snowfall bars (shaded by amount,
 * faded where fewer than three forecast centres contribute, flagged when the
 * ensemble is split or one model drives the total), plus aligned rain,
 * precipitation-type and gust strips.
 */
import { useCallback, type CSSProperties } from 'react';
import type { Resort } from '../../config/resorts';
import { Chart, baseOption, tipHeader, tipRow, type EChartsCoreOption } from '../../components/Chart';
import { NBM } from '../../config/models';
import type { BandForecast, NbmForecast } from '../../hooks/data';
import type { DayDist } from '../../lib/ensemble';
import { DRIVEN_MIN_CM, DRIVEN_SHARE, LOW_CENTRES, type DailyRow, type DerivedHourly, type DrivenDay, type Phase } from '../../lib/forecast';
import { SNOW_CLASSES_CM, alpha, slotColor, snowClass, type ChartPalette } from '../../lib/palette';
import type { Fmt } from '../../lib/prefs';
import { dayLabel, runLabel, shortDate } from '../../lib/time';

/** Shared plot margins so every strip lines up with the bars. */
const GRID_L = 52;
const GRID_R = 16;
/** Defined in lib/forecast (drivenDays uses it too); re-exported for the views that import it from here. */
export { LOW_CENTRES };
const WIND_HOLD_KMH = 64; // ≈ 40 mph gusts: lift-hold territory
/** Series name of the NBM benchmark mark (kept out of the per-model tooltip rows). */
const NBM_SERIES = NBM.label;

export interface DailyContext {
  data: BandForecast;
  days: DailyRow[];
  dists: Map<string, DayDist> | null;
  /** Days whose blended total rests on one model (drivenDays). */
  driven: Map<string, DrivenDay> | null;
  centres: Map<string, number>;
  phases: Map<string, Phase[]>;
  visible: DerivedHourly[];
  resort: Resort;
  fmt: Fmt;
  narrow: boolean;
  rawSnow: boolean;
  today: string;
  /** NOAA NBM when "Compare with official guidance" is on: its own snowfall as a benchmark mark. */
  nbm?: NbmForecast | null;
}

const longDay = (iso: string) => `${dayLabel(iso).split(' ')[0]} ${shortDate(iso)}`;

function snowText(fmt: Fmt, cm: number | null | undefined, narrow: boolean) {
  if (cm == null || cm < 0.5) return '–';
  return narrow ? fmt.snow(cm).replace(/ (in|cm)$/, '') : fmt.snow(cm);
}

/** A driving centre's share as a whole percentage, never shown as 50% or less (the rule is "more than half"). */
const sharePct = (share: number) => Math.max(Math.round(share * 100), Math.floor(DRIVEN_SHARE * 100) + 1);
const driverNames = (dr: DrivenDay) => dr.driver?.models.map((m) => m.label).join(' + ') ?? '';

/** One sentence on why a day is marked outlier (table cell, screen readers). */
export function drivenSummary(dr: DrivenDay): string {
  const why = [
    dr.driver ? `${driverNames(dr)} ${dr.driver.models.length > 1 ? 'supply' : 'supplies'} ${sharePct(dr.driver.share)}% of the blend's snow` : '',
    dr.ensP90 != null ? 'the blend is above 90% of ensemble members' : '',
  ].filter(Boolean);
  return `Outlier: ${why.join('; ')}.`;
}

/** NBM's own snowfall for a day, if it covers the day (the same ≥ 20 h rule as the model marks). */
export function nbmSnowOn(nbm: NbmForecast | null | undefined, date: string): number | null {
  const r = nbm?.daily.find((x) => x.date === date);
  return r && r.hours >= 20 ? r.snowCm : null;
}

export function DailySnowChart(ctx: DailyContext) {
  const { data, days, dists, driven, centres, visible, fmt, narrow, rawSnow, today, nbm } = ctx;
  const key = rawSnow ? 'omSnowCm' : 'snowCm';
  const option = useCallback(
    (p: ChartPalette): EChartsCoreOption => {
      const base = baseOption(p) as Record<string, unknown>;
      const firstLow = days.findIndex((d) => (centres.get(d.date) ?? 0) < LOW_CENTRES);
      const lowConf = (d: DailyRow) => (centres.get(d.date) ?? 0) < LOW_CENTRES;
      const modelVal = (m: DerivedHourly, date: string) => {
        const r = data.daily[m.model.id]?.find((x) => x.date === date);
        return r && r.hours >= 20 ? fmt.snowVal(r[key]) : null;
      };
      // Italic notes under a day's total; both describe PowderWatch physics, so neither shows with raw snowfall.
      const notes = (date: string) => (rawSnow ? [] : [dists?.get(date)?.split ? 'split' : '', driven?.has(date) ? 'outlier' : ''].filter(Boolean));
      const extraLines = Math.max(0, ...days.map((d) => notes(d.date).length - 1));
      return {
        ...base,
        grid: { left: GRID_L, right: GRID_R, top: 18, bottom: (narrow ? 50 : 60) + 13 * extraLines },
        xAxis: {
          ...(base.xAxis as object), type: 'category', data: days.map((d) => d.date),
          axisLabel: {
            interval: 0, margin: 10,
            formatter: (date: string) => {
              const d = days.find((x) => x.date === date);
              const v = d?.[key];
              const name = date === today ? 'Today' : narrow ? dayLabel(date).split(' ')[0].slice(0, 2) : dayLabel(date);
              return `{d|${name}}\n{${v != null && v >= 0.5 ? 'v' : 'z'}|${snowText(fmt, v, narrow)}}${notes(date).map((n) => `\n{s|${n}}`).join('')}`;
            },
            rich: {
              d: { color: p.ink3, fontSize: 11, lineHeight: 15 },
              v: { color: p.ink1, fontSize: narrow ? 11 : 12, fontWeight: 600, lineHeight: 16 },
              z: { color: p.ink3, fontSize: 11, lineHeight: 16 },
              s: { color: p.ink2, fontSize: 10, lineHeight: 13, fontStyle: 'italic' },
            },
          },
        },
        yAxis: { ...(base.yAxis as object), type: 'value', name: fmt.snowUnit, nameTextStyle: { color: p.ink3 } },
        tooltip: {
          ...(base.tooltip as object),
          formatter: (params: { seriesName: string; value: number | null | { value: number }; color: string; dataIndex: number }[]) => {
            const i = params[0]?.dataIndex ?? 0;
            const d = days[i];
            if (!d) return '';
            const num = (x: (typeof params)[number]) => (x.value != null && typeof x.value === 'object' ? x.value.value : x.value);
            const show = (v: number | null | undefined) => fmt.snow(fmt.units === 'imperial' && v != null ? v * 2.54 : v);
            const dist = dists?.get(d.date);
            const dr = rawSnow ? undefined : driven?.get(d.date);
            const lines = [
              tipRow(p.ink1, 'blend', fmt.snow(d[key]), p),
              dist && !rawSnow ? tipRow(p.proj.line, `ensemble median (10–90%: ${fmt.snowRange(dist.p10, dist.p90)})`, fmt.snow(dist.p50), p) : '',
              dist?.split && !rawSnow
                ? `<div style="color:${p.ink1};margin:4px 0 2px;font-weight:600">Models split</div>` +
                  tipRow(p.ink3, `of members ≤ ${fmt.snow(2.5)} (typical ${fmt.snow(dist.lowMedian)})`, `${Math.round(dist.pLow * 100)}%`, p) +
                  tipRow(p.ink3, `of members ≥ ${fmt.snow(15)} (typical ${fmt.snow(dist.highMedian)})`, `${Math.round(dist.pHigh * 100)}%`, p)
                : '',
              dr
                ? `<div style="color:${p.ink1};margin:4px 0 2px;font-weight:600">Outlier</div>` +
                  (dr.driver ? tipRow(p.ink3, `of the blend's snow from ${driverNames(dr)}`, `${sharePct(dr.driver.share)}%`, p) : '') +
                  (dr.ensP90 != null ? tipRow(p.ink3, 'blend above 90% of ensemble members (90th percentile)', fmt.snow(dr.ensP90), p) : '')
                : '',
              nbm ? tipRow(p.ink1, `${NBM.label} (official guidance, its own snowfall)`, fmt.snow(nbmSnowOn(nbm, d.date)), p, 'tick') : '',
              ...params
                .filter((x) => x.seriesName !== 'Blend' && x.seriesName !== NBM_SERIES && num(x) != null)
                .sort((a, b) => (num(b) ?? 0) - (num(a) ?? 0))
                .map((x) => tipRow(x.color, x.seriesName, show(num(x)), p)),
              tipRow(p.rain, 'rain (blend)', fmt.water(d.rainMm), p),
              tipRow(p.ink3, 'snow level (blend)', fmt.elevRange(d.snowLevelMin, d.snowLevelMax), p),
              tipRow(p.ink3, 'forecast centres', String(centres.get(d.date) ?? 0), p),
            ];
            return tipHeader(longDay(d.date), p) + lines.join('');
          },
        },
        series: [
          {
            type: 'bar', name: 'Blend', barWidth: '58%', z: 1,
            data: days.map((d) => {
              const c = p.snowRamp[snowClass(d[key])];
              return {
                value: fmt.snowVal(d[key]),
                itemStyle: lowConf(d)
                  ? { color: alpha(c, 0.3), borderColor: c, borderWidth: 1.5, borderRadius: [4, 4, 0, 0] }
                  : { color: c, borderRadius: [4, 4, 0, 0] },
              };
            }),
            markArea: firstLow >= 0 ? {
              silent: true, itemStyle: { color: alpha(p.ink3, 0.07) },
              label: { show: !narrow, position: 'insideTopLeft', color: p.ink3, fontSize: 10, formatter: 'fewer than 3 forecast centres' },
              data: [[{ xAxis: days[firstLow].date }, { xAxis: days[days.length - 1].date }]],
            } : undefined,
          },
          ...visible.map((m) => ({
            type: 'scatter', name: m.model.label, symbolSize: m.model.kind === 'regional' ? 10 : 9, z: 3,
            symbol: m.model.kind === 'regional' ? 'diamond' : 'circle',
            itemStyle: { color: slotColor(p, m.model.slot), borderColor: p.surface, borderWidth: 2 },
            data: days.map((d) => modelVal(m, d.date)),
          })),
          // Benchmark mark: a short bar in the ink colour (no model slot), outlined so it reads on any snow bar.
          ...(nbm ? [{
            type: 'scatter', name: NBM_SERIES, symbol: 'rect', symbolSize: [narrow ? 14 : 24, 4], z: 4,
            itemStyle: { color: p.ink1, borderColor: p.surface, borderWidth: 1 },
            data: days.map((d) => fmt.snowVal(nbmSnowOn(nbm, d.date))),
          }] : []),
        ],
      };
    },
    [data, days, dists, driven, centres, visible, fmt, narrow, rawSnow, today, key, nbm],
  );
  const total = days.reduce((s, d) => s + (d[key] ?? 0), 0);
  const biggest = days.reduce<DailyRow | null>((b, d) => ((d[key] ?? 0) > (b?.[key] ?? 0) ? d : b), null);
  const outliers = rawSnow ? [] : days.filter((d) => driven?.has(d.date));
  return (
    <Chart
      option={option}
      height={narrow ? 260 : 300}
      ariaLabel={`Daily snowfall, next ${days.length} days: blend total ${fmt.snow(total)}${biggest ? `, biggest day ${longDay(biggest.date)} with ${fmt.snow(biggest[key])}` : ''}.` +
        (outliers.length ? ` Outlier totals, resting on one model: ${outliers.map((d) => longDay(d.date)).join(', ')}.` : '') +
        (nbm ? ` ${NBM.long}, its own snowfall: ${fmt.snow(days.reduce((s, d) => s + (nbmSnowOn(nbm, d.date) ?? 0), 0))} over the days it covers.` : '')}
    />
  );
}

export function RainStrip({ days, fmt }: Pick<DailyContext, 'days' | 'fmt'>) {
  const total = days.reduce((s, d) => s + (d.rainMm ?? 0), 0);
  const option = useCallback(
    (p: ChartPalette): EChartsCoreOption => {
      const base = baseOption(p) as Record<string, unknown>;
      return {
        ...base,
        grid: { left: GRID_L, right: GRID_R, top: 16, bottom: 4 },
        xAxis: { ...(base.xAxis as object), type: 'category', data: days.map((d) => d.date), axisLabel: { show: false } },
        yAxis: { type: 'value', show: false, min: 0 },
        tooltip: {
          ...(base.tooltip as object),
          formatter: (params: { dataIndex: number }[]) => {
            const d = days[params[0]?.dataIndex ?? 0];
            return d ? tipHeader(longDay(d.date), p) + tipRow(p.rain, 'rain (blend)', fmt.water(d.rainMm), p) : '';
          },
        },
        series: [{
          type: 'bar', name: 'Rain', barWidth: '58%',
          itemStyle: { color: p.rain, borderRadius: [3, 3, 0, 0] },
          label: {
            show: true, position: 'top', color: p.ink2, fontSize: 10,
            formatter: (x: { value: number | null }) =>
              x.value != null && x.value >= (fmt.units === 'imperial' ? 0.02 : 0.5) ? (fmt.units === 'imperial' ? x.value.toFixed(2) : x.value.toFixed(0)) : '',
          },
          data: days.map((d) => fmt.waterVal(d.rainMm)),
        }],
      };
    },
    [days, fmt],
  );
  if (total < 0.5) return <div className="text-xs text-ink-3 mt-1" style={{ paddingLeft: GRID_L }}>No rain forecast at this elevation.</div>;
  return (
    <div className="mt-1">
      <div className="flex items-center gap-1.5 text-xs text-ink-2" style={{ paddingLeft: GRID_L }}>
        <span aria-hidden style={{ width: 10, height: 10, background: 'var(--rain)', borderRadius: 2 }} />
        Rain at this elevation ({fmt.waterUnit}) — {fmt.water(total)} over {days.length} days
      </div>
      <Chart option={option} height={64} ariaLabel={`Rain forecast: ${fmt.water(total)} over ${days.length} days`} />
    </div>
  );
}

const PHASE_LETTER: Record<Phase, string> = { snow: 'S', mixed: 'M', rain: 'R', dry: '' };

/** Precipitation type at each elevation band per day, and the day's peak gust at the selected band. */
export function PhaseGustStrip({ days, phases, resort, fmt, narrow }: Pick<DailyContext, 'days' | 'phases' | 'resort' | 'fmt' | 'narrow'>) {
  const bands = [...resort.bands].reverse(); // summit on top
  const option = useCallback(
    (p: ChartPalette): EChartsCoreOption => {
      const base = baseOption(p) as Record<string, unknown>;
      const rows = ['Gust', ...bands.map((b) => b.label)];
      const colour = (ph: Phase) => (ph === 'snow' ? p.snowRamp[2] : ph === 'mixed' ? p.mixed : ph === 'rain' ? p.rain : 'transparent');
      const textOn = (ph: Phase) => (ph === 'snow' ? p.snowInk[2] : '#ffffff');
      const cellW = narrow ? 20 : 34;
      const cells = days.flatMap((d, di) =>
        bands.map((b, bi) => {
          const ph = phases.get(d.date)?.[resort.bands.indexOf(b)] ?? 'dry';
          return {
            value: [di, bi + 1], phase: ph, band: b.label,
            itemStyle: { color: colour(ph), borderColor: ph === 'dry' ? p.grid : 'transparent', borderWidth: 1 },
            label: { show: ph !== 'dry', formatter: PHASE_LETTER[ph], color: textOn(ph), fontSize: 10, fontWeight: 600 },
          };
        }),
      );
      const gusts = days.map((d, di) => ({
        value: [di, 0], gust: d.gustMax,
        label: {
          show: true, fontSize: 10, color: (d.gustMax ?? 0) >= WIND_HOLD_KMH ? p.ink1 : p.ink3,
          fontWeight: (d.gustMax ?? 0) >= WIND_HOLD_KMH ? 700 : 400,
          formatter: d.gustMax == null ? '' : `${(d.gustMax ?? 0) >= WIND_HOLD_KMH ? '⚠' : ''}${Math.round(fmt.windVal(d.gustMax)!)}`,
        },
      }));
      return {
        ...base,
        grid: { left: GRID_L, right: GRID_R, top: 4, bottom: 4 },
        xAxis: { type: 'category', data: days.map((d) => d.date), show: false },
        yAxis: {
          type: 'category', data: rows, inverse: true, axisLine: { show: false }, axisTick: { show: false }, splitLine: { show: false },
          axisLabel: { color: p.ink3, fontSize: 10, formatter: (v: string) => (v === 'Gust' ? `Gust ${fmt.windUnit}` : v) },
        },
        tooltip: {
          ...(base.tooltip as object), trigger: 'item',
          formatter: (x: { data: { value: [number, number]; phase?: Phase; band?: string; gust?: number | null } }) => {
            const d = days[x.data.value[0]];
            if (!d) return '';
            if (x.data.band) return tipHeader(`${longDay(d.date)} · ${x.data.band}`, p) + tipRow(p.ink3, 'precipitation type', x.data.phase ?? 'dry', p) + tipRow(p.ink3, 'snow level (blend)', fmt.elevRange(d.snowLevelMin, d.snowLevelMax), p);
            return tipHeader(longDay(d.date), p) + tipRow(p.ink3, 'peak gust (blend)', fmt.wind(x.data.gust), p);
          },
        },
        series: [
          { type: 'scatter', symbol: 'roundRect', symbolSize: [cellW, 15], data: cells, z: 2 },
          { type: 'scatter', symbolSize: 1, itemStyle: { color: 'transparent' }, data: gusts },
        ],
      };
    },
    [days, phases, resort, fmt, narrow], // eslint-disable-line react-hooks/exhaustive-deps
  );
  return <Chart option={option} height={22 * (bands.length + 1) + 8} ariaLabel="Precipitation type by elevation and peak gust per day" />;
}

export function DailyLegend({ fmt, nbm }: { fmt: Fmt; nbm?: NbmForecast | null }) {
  const bounds = SNOW_CLASSES_CM.map((b) => {
    const v = fmt.snowVal(b)!;
    return fmt.units === 'imperial' ? Math.round(v) : Math.round(v * 10) / 10;
  });
  const labels = [`< ${bounds[0]}`, ...bounds.slice(1).map((b, i) => `${bounds[i]}–${b}`), `${bounds.at(-1)}+`];
  const sw = (bg: string, extra?: CSSProperties) => <span aria-hidden style={{ width: 12, height: 10, background: bg, borderRadius: 2, display: 'inline-block', ...extra }} />;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-ink-2 mt-2" style={{ paddingLeft: GRID_L }} aria-label="Legend">
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        Snow per day ({fmt.snowUnit}):
        {labels.map((l, i) => <span key={l} className="flex items-center gap-1">{sw(`var(--snow-${i + 1})`)}{l}</span>)}
      </span>
      <span className="flex items-center gap-1">{sw('transparent', { border: '1.5px solid var(--snow-3)' })}fewer than 3 centres</span>
      <span><i>split</i> = models disagree</span>
      <span
        title={`At least ${fmt.snow(DRIVEN_MIN_CM, 0)}, and one forecast centre supplies more than ${Math.round(DRIVEN_SHARE * 100)}% of the blend's snow or the blend is above 90% of ensemble members. Hover the day for which.`}
      >
        <i>outlier</i> = one model drives the total
      </span>
      <span className="flex items-center gap-2">
        <span className="flex items-center gap-1">{sw('var(--snow-3)')}S snow</span>
        <span className="flex items-center gap-1">{sw('var(--mixed)')}M mixed</span>
        <span className="flex items-center gap-1">{sw('var(--rain)')}R rain</span>
      </span>
      <span>● global model · ◆ high-res model</span>
      {nbm && (
        <span className="flex items-center gap-1" title={`${NBM.long}. ${NBM.blurb} Not part of the blend.`}>
          <span aria-hidden style={{ width: 14, height: 4, background: 'var(--ink-1)', borderRadius: 1, boxShadow: '0 0 0 1px var(--surface-1)', display: 'inline-block' }} />
          {NBM.label}{nbm.run ? ` ${runLabel(nbm.run.initUnix).split(' ').at(-1)}` : ''}: official guidance, its own snowfall
        </span>
      )}
    </div>
  );
}
