import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { BarChart, LineChart, ScatterChart } from 'echarts/charts';
import { GridComponent, MarkAreaComponent, MarkLineComponent, MarkPointComponent, TooltipComponent, AxisPointerComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import type { EChartsCoreOption } from 'echarts/core';
import { usePrefs } from '../lib/prefs';
import { readPalette, type ChartPalette } from '../lib/palette';

echarts.use([BarChart, LineChart, ScatterChart, GridComponent, TooltipComponent, AxisPointerComponent, MarkLineComponent, MarkAreaComponent, MarkPointComponent, SVGRenderer]);

export type { EChartsCoreOption };

/**
 * What a click reports: a series item (`dataIndex`), an axis label with `triggerEvent` (`value`), or a click
 * on empty plot space (`componentType: 'grid'`, with the category under it as `dataIndex`).
 */
export interface ChartClick {
  componentType: string;
  dataIndex?: number;
  value?: unknown;
}

interface Props {
  /** Builds the option from the current theme palette. */
  option: (p: ChartPalette) => EChartsCoreOption;
  height: number;
  ariaLabel: string;
  onClick?: (e: ChartClick) => void;
}

/** Thin ECharts wrapper: SVG renderer, resize-aware, rebuilds on theme change. */
export function Chart({ option, height, ariaLabel, onClick }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const inst = useRef<echarts.ECharts | null>(null);
  const click = useRef(onClick);
  click.current = onClick;
  const { dark } = usePrefs();

  useEffect(() => {
    if (!ref.current) return;
    inst.current = echarts.init(ref.current, undefined, { renderer: 'svg' });
    inst.current.on('click', (e) => click.current?.(e as ChartClick));
    // Empty plot space (above a short bar, between marks): report the category column under the pointer.
    inst.current.getZr().on('click', (e) => {
      const chart = inst.current;
      if (!chart || e.target || !click.current) return;
      const at: [number, number] = [e.offsetX, e.offsetY];
      if (!chart.containPixel('grid', at)) return;
      const index = (chart.convertFromPixel({ gridIndex: 0 }, at) as number[] | undefined)?.[0];
      if (Number.isInteger(index)) click.current({ componentType: 'grid', dataIndex: index as number });
    });
    const ro = new ResizeObserver(() => inst.current?.resize());
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      inst.current?.dispose();
      inst.current = null;
    };
  }, []);

  useEffect(() => {
    // The theme attribute is applied before re-render, so CSS variables are current here.
    inst.current?.setOption(option(readPalette()), { notMerge: true });
  }, [option, dark]);

  return <div ref={ref} role="img" aria-label={ariaLabel} style={{ height, width: '100%', cursor: onClick ? 'pointer' : undefined }} />;
}

/** Shared axis/grid/tooltip styling. */
export function baseOption(p: ChartPalette): EChartsCoreOption {
  const axisCommon = {
    axisLine: { lineStyle: { color: p.axis } },
    axisTick: { show: false },
    axisLabel: { color: p.ink3, fontSize: 11 },
    splitLine: { lineStyle: { color: p.grid, width: 1 } },
  };
  return {
    animation: false,
    textStyle: { fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif', color: p.ink2 },
    grid: { left: 52, right: 16, top: 16, bottom: 28, containLabel: false },
    tooltip: {
      trigger: 'axis',
      confine: true,
      backgroundColor: p.surface,
      borderColor: p.axis,
      textStyle: { color: p.ink1, fontSize: 12 },
      axisPointer: { type: 'line', lineStyle: { color: p.ink3, width: 1 } },
    },
    xAxis: { ...axisCommon, splitLine: { show: false } },
    yAxis: { ...axisCommon, axisLine: { show: false } },
  };
}

/** Tooltip row: short line key in series colour, value strong, label secondary. */
export type TipKey = 'line' | 'dashed' | 'band' | 'tick';

export function tipRow(color: string, label: string, value: string, p: ChartPalette, key: TipKey = 'line'): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const swatch =
    key === 'band'
      ? `<span style="display:inline-block;width:12px;height:10px;border-radius:2px;background:${color}"></span>`
      : key === 'dashed'
        ? `<span style="display:inline-block;width:12px;height:0;border-top:2px dashed ${color}"></span>`
        : key === 'tick'
          ? `<span style="display:inline-block;width:12px;height:4px;border-radius:1px;background:${color};box-shadow:0 0 0 1px ${p.surface}"></span>`
          : `<span style="display:inline-block;width:12px;height:2px;background:${color}"></span>`;
  return `<div style="display:flex;align-items:center;gap:8px;line-height:18px">` +
    swatch +
    `<b style="color:${p.ink1};min-width:56px;text-align:right" class="tnum">${esc(value)}</b>` +
    `<span style="color:${p.ink2}">${esc(label)}</span></div>`;
}

export function tipHeader(text: string, p: ChartPalette): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<div style="color:${p.ink2};font-size:11px;margin-bottom:4px">${esc(text)}</div>`;
}
