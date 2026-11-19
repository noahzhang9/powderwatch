import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { BarChart, LineChart, ScatterChart } from 'echarts/charts';
import { GridComponent, MarkAreaComponent, MarkLineComponent, TooltipComponent, AxisPointerComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import type { EChartsCoreOption } from 'echarts/core';
import { usePrefs } from '../lib/prefs';
import { readPalette, type ChartPalette } from '../lib/palette';

echarts.use([BarChart, LineChart, ScatterChart, GridComponent, TooltipComponent, AxisPointerComponent, MarkLineComponent, MarkAreaComponent, SVGRenderer]);

export type { EChartsCoreOption };

interface Props {
  /** Builds the option from the current theme palette. */
  option: (p: ChartPalette) => EChartsCoreOption;
  height: number;
  ariaLabel: string;
}

/** Thin ECharts wrapper: SVG renderer, resize-aware, rebuilds on theme change. */
export function Chart({ option, height, ariaLabel }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const inst = useRef<echarts.ECharts | null>(null);
  const { dark } = usePrefs();

  useEffect(() => {
    if (!ref.current) return;
    inst.current = echarts.init(ref.current, undefined, { renderer: 'svg' });
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

  return <div ref={ref} role="img" aria-label={ariaLabel} style={{ height, width: '100%' }} />;
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
export function tipRow(color: string, label: string, value: string, p: ChartPalette): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<div style="display:flex;align-items:center;gap:8px;line-height:18px">` +
    `<span style="display:inline-block;width:12px;height:2px;background:${color}"></span>` +
    `<b style="color:${p.ink1};min-width:56px;text-align:right" class="tnum">${esc(value)}</b>` +
    `<span style="color:${p.ink2}">${esc(label)}</span></div>`;
}

export function tipHeader(text: string, p: ChartPalette): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<div style="color:${p.ink2};font-size:11px;margin-bottom:4px">${esc(text)}</div>`;
}
