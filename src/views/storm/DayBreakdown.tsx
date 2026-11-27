/**
 * A day's 3-hour breakdown, opened from the daily chart: blended snowfall per block with the ensemble's
 * 10–90% range and each model's mark, then aligned rows for rain, rain/snow at this elevation,
 * temperature, snow level and gusts. Built from the hourly data the page already holds (no requests).
 */
import { useCallback, useEffect, useMemo, useRef, type CSSProperties } from 'react';
import type { Band, Resort } from '../../config/resorts';
import { Chart, baseOption, tipHeader, tipRow, type EChartsCoreOption } from '../../components/Chart';
import { MODELS } from '../../config/models';
import type { BandForecast, EnsembleSet } from '../../hooks/data';
import { BLOCK_H, blockLabel, dayBlocks, snowiestBlock, type Block } from '../../lib/blocks';
import type { DerivedHourly, Phase } from '../../lib/forecast';
import { alpha, slotColor, type ChartPalette } from '../../lib/palette';
import type { Fmt } from '../../lib/prefs';
import { dayLabel, shortDate, zoneName } from '../../lib/time';
import { GRID_L, GRID_R } from './Daily';

const longDay = (iso: string) => `${dayLabel(iso).split(' ')[0]} ${shortDate(iso)}`;
/** "3a", "12p": a block's start on a phone's axis. */
const shortHour = (t: number, tz: string) => new Date(t * 1000).toLocaleString('en-US', { hour: 'numeric', timeZone: tz }).replace(' AM', 'a').replace(' PM', 'p');
const PHASE_TEXT: Record<Phase, string> = { snow: 'snow', mixed: 'mixed', rain: 'rain', dry: 'dry' };

export interface DayBreakdownProps {
  date: string;
  /** The days the chart shows, for previous/next. */
  dates: string[];
  data: BandForecast;
  ens?: EnsembleSet;
  visible: DerivedHourly[];
  resort: Resort;
  band: Band;
  fmt: Fmt;
  narrow: boolean;
  rawSnow: boolean;
  onSelect: (date: string) => void;
  onClose: () => void;
}

/** One sentence: when it snows most, and when it rains or mixes at this elevation. */
function summary(blocks: Block[], key: 'snowCm' | 'omSnowCm', fmt: Fmt, tz: string): string {
  const withTotals = blocks.filter((b) => b[key] != null);
  if (!withTotals.length) return 'The forecast doesn\'t cover a full 3-hour block of this day.';
  const best = snowiestBlock(blocks, key);
  const wet = blocks.filter((b) => b.phase === 'rain' || b.phase === 'mixed');
  const parts: string[] = [];
  if (best && (best[key] ?? 0) >= 0.5) parts.push(`Most snow ${blockLabel(best.start, best.end, tz)} (≈ ${fmt.snow(best[key])})`);
  else if (!wet.length) parts.push('Little or no snow');
  if (wet.length) {
    const kind = wet.some((b) => b.phase === 'rain') ? 'rain' : 'mixed';
    const from = new Date(wet[0].start * 1000).toLocaleString('en-US', { hour: 'numeric', timeZone: tz });
    parts.push(`${kind} at this elevation from ${from}`);
  }
  return parts.join('; ') + '.';
}

export function DayBreakdown({ date, dates, data, ens, visible, resort, band, fmt, narrow, rawSnow, onSelect, onClose }: DayBreakdownProps) {
  const key = rawSnow ? 'omSnowCm' : 'snowCm';
  const blocks = useMemo(() => dayBlocks(data, date, resort.tz, band.elevation, ens), [data, date, resort.tz, band.elevation, ens]);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    heading.current?.scrollIntoView({ block: 'nearest', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }, [date]);
  const i = dates.indexOf(date);
  const prev = i > 0 ? dates[i - 1] : null;
  const next = i >= 0 && i < dates.length - 1 ? dates[i + 1] : null;
  const zone = zoneName(resort.tz, blocks[0]?.start ?? Date.now() / 1000);
  const coarse = Array.from(new Set(blocks.flatMap((b) => b.models.filter((m) => m.coarse && visible.some((v) => v.model.id === m.id)).map((m) => m.id))));
  const labels = blocks.map((b) => (narrow ? shortHour(b.start, resort.tz) : blockLabel(b.start, b.end, resort.tz)));

  const option = useCallback(
    (p: ChartPalette): EChartsCoreOption => {
      const base = baseOption(p) as Record<string, unknown>;
      const ensRange = blocks.map((b) => (b.ens && !rawSnow && b.ens.p10 != null && b.ens.p90 != null ? [fmt.snowVal(b.ens.p10), fmt.snowVal(b.ens.p90)] as const : null));
      return {
        ...base,
        grid: { left: GRID_L, right: GRID_R, top: 26, bottom: 26 },
        xAxis: { ...(base.xAxis as object), type: 'category', data: labels, axisLabel: { color: p.ink3, fontSize: narrow ? 10 : 11, interval: 0 } },
        yAxis: { ...(base.yAxis as object), type: 'value', name: fmt.snowUnit, nameTextStyle: { color: p.ink3 }, min: 0 },
        tooltip: {
          ...(base.tooltip as object),
          formatter: (params: { dataIndex: number }[]) => {
            const b = blocks[params[0]?.dataIndex ?? 0];
            if (!b) return '';
            const rows = [
              tipRow(p.ink1, 'blend', fmt.snow(b[key]), p),
              b.ens && !rawSnow ? tipRow(p.ink3, `ensemble median (10–90%: ${fmt.snowRange(b.ens.p10, b.ens.p90)})`, fmt.snow(b.ens.p50), p, 'dashed') : '',
              ...b.models
                .filter((m) => m.snowCm != null && visible.some((v) => v.model.id === m.id))
                .sort((x, y) => (y.snowCm ?? 0) - (x.snowCm ?? 0))
                .map((m) => tipRow(slotColor(p, MODELS[m.id].slot), `${MODELS[m.id].label}${m.coarse ? ' (spread from 3- or 6-hourly output)' : ''}`, fmt.snow(m.snowCm), p)),
              tipRow(p.rain, 'rain (blend)', fmt.water(b.rainMm), p),
              tipRow(p.ink3, `at ${fmt.elev(band.elevation)}`, PHASE_TEXT[b.phase], p),
            ];
            return tipHeader(`${longDay(date)} · ${blockLabel(b.start, b.end, resort.tz)} ${zone}`, p) + rows.join('');
          },
        },
        series: [
          // The ensemble's 10–90% range: an invisible base up to p10, then a dashed outline up to p90.
          { type: 'bar', name: 'ens base', stack: 'ens', barWidth: '62%', silent: true, itemStyle: { color: 'transparent' }, data: ensRange.map((r) => r?.[0] ?? null), z: 2 },
          {
            type: 'bar', name: 'Ensemble 10–90%', stack: 'ens', barWidth: '62%', z: 2,
            itemStyle: { color: alpha(p.ink3, 0.08), borderColor: p.ink3, borderWidth: 1, borderType: 'dashed' },
            data: ensRange.map((r) => (r && r[0] != null && r[1] != null ? Math.max(0, r[1] - r[0]) : null)),
          },
          {
            type: 'bar', name: 'Blend', barWidth: '62%', barGap: '-100%', z: 1,
            // One ramp step for every block: the daily ramp's classes are per day, and the bar's height carries the amount.
            itemStyle: { color: p.snowRamp[2], borderRadius: [3, 3, 0, 0] },
            data: blocks.map((b) => fmt.snowVal(b[key])),
          },
          ...visible.map((m) => ({
            type: 'scatter', name: m.model.label, symbolSize: m.model.kind === 'regional' ? 9 : 8, z: 3,
            symbol: m.model.kind === 'regional' ? 'diamond' : 'circle',
            itemStyle: { color: slotColor(p, m.model.slot), borderColor: p.surface, borderWidth: 1.5 },
            data: blocks.map((b) => fmt.snowVal(b.models.find((x) => x.id === m.model.id)?.snowCm ?? null)),
          })),
        ],
      };
    },
    [blocks, labels, fmt, narrow, rawSnow, key, visible, band.elevation, date, resort.tz, zone],
  );

  const cols: CSSProperties = { display: 'grid', gridTemplateColumns: `repeat(${blocks.length}, minmax(0, 1fr))`, paddingLeft: GRID_L, paddingRight: GRID_R, position: 'relative' };
  const rowLabel: CSSProperties = { position: 'absolute', left: 0, width: GRID_L - 6, textAlign: 'right', whiteSpace: 'nowrap' };
  const phaseStyle = (ph: Phase): CSSProperties =>
    ph === 'dry' ? {} : {
      background: `color-mix(in srgb, ${ph === 'snow' ? 'var(--snow-3)' : ph === 'mixed' ? 'var(--mixed)' : 'var(--rain)'} 22%, transparent)`,
      border: `1px solid ${ph === 'snow' ? 'var(--snow-3)' : ph === 'mixed' ? 'var(--mixed)' : 'var(--rain)'}`,
    };
  const elevK = (m: number | null) => (m == null ? '–' : narrow ? `${((fmt.elevVal(m) ?? 0) / 1000).toFixed(1)}k` : fmt.elev(m).replace(/ (ft|m)$/, ''));
  const row = (label: string, cells: string[], title?: string) => (
    <div style={cols} className="text-[11px] text-ink-2 tnum py-0.5" title={title}>
      <span style={rowLabel} className="text-ink-3">{label}</span>
      {cells.map((c, k) => <span key={k} className="text-center truncate">{c}</span>)}
    </div>
  );

  return (
    <section
      className="mt-4 rounded-lg border border-line p-3"
      aria-labelledby={`day-${date}`}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 id={`day-${date}`} ref={heading} tabIndex={-1} className="text-sm font-semibold outline-none">
          {longDay(date)} · every {BLOCK_H} hours at {fmt.elev(band.elevation)}
        </h3>
        <span className="text-[11px] text-ink-3">times in {zone}</span>
        <div className="ml-auto flex gap-1">
          <button type="button" className="btn" disabled={!prev} onClick={() => prev && onSelect(prev)} aria-label="Previous day">‹</button>
          <button type="button" className="btn" disabled={!next} onClick={() => next && onSelect(next)} aria-label="Next day">›</button>
          <button type="button" className="btn" onClick={onClose} aria-label="Close the 3-hour breakdown">Close</button>
        </div>
      </div>
      <p className="text-xs text-ink-2 mt-1">{summary(blocks, key, fmt, resort.tz)}</p>
      <Chart
        option={option}
        height={narrow ? 200 : 220}
        ariaLabel={`${longDay(date)}, snowfall every ${BLOCK_H} hours: ${blocks.map((b) => `${blockLabel(b.start, b.end, resort.tz)} ${fmt.snow(b[key])}`).join(', ')}.`}
      />
      <div className="mt-1 space-y-0.5">
        {row('Rain', blocks.map((b) => (b.rainMm != null && b.rainMm >= 0.1 ? String(fmt.waterVal(b.rainMm)?.toFixed(fmt.units === 'imperial' ? 2 : 1)) : '–')))}
        <div style={cols} className="text-[11px] py-0.5">
          <span style={rowLabel} className="text-ink-3">Type</span>
          {blocks.map((b, k) => (
            <span key={k} className="mx-auto px-1 rounded text-ink-1" style={phaseStyle(b.phase)} title={`${PHASE_TEXT[b.phase]} at ${fmt.elev(band.elevation)}`}>
              {b.phase === 'dry' ? '–' : b.phase[0].toUpperCase()}
            </span>
          ))}
        </div>
        {narrow
          ? row('High', blocks.map((b) => (b.tMax == null ? '–' : String(Math.round(fmt.tempVal(b.tMax)!)))), 'Highest temperature in the block')
          : row('Temp', blocks.map((b) => (b.tMin == null ? '–' : `${Math.round(fmt.tempVal(b.tMin)!)}/${Math.round(fmt.tempVal(b.tMax)!)}`)), 'Temperature, lowest/highest in the block')}
        {row('Snow lvl', blocks.map((b) => (b.snowLevelMin == null ? '–' : elevK(b.snowLevelMin))), 'Lowest snow level while precipitating (blend)')}
        {row('Gust', blocks.map((b) => (b.gustMax == null ? '–' : String(Math.round(fmt.windVal(b.gustMax)!)))))}
      </div>
      <p className="text-[11px] text-ink-3 mt-2">
        Bars: the blend; dashed box: the ensemble's 10–90%; marks: each model. Rain in {fmt.waterUnit}, temperature {narrow ? 'high' : 'low/high'} in {fmt.tempUnit}, snow level (lowest while precipitating) in {narrow ? `thousands of ${fmt.elevUnit}` : fmt.elevUnit}, gusts in {fmt.windUnit}. Type: S snow, M mixed, R rain at this elevation.
        {coarse.length > 0 && <> {coarse.map((id) => MODELS[id]?.label ?? id).join(', ')}: 3- or 6-hourly output spread evenly over the hours, so their timing within a block is approximate.</>}
        {' '}Hour-by-hour timing is less certain than the day's total.
      </p>
    </section>
  );
}
