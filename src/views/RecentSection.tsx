import { useCallback, useMemo, useState } from 'react';
import type { Band, Resort } from '../config/resorts';
import { bandInText } from '../config/resorts';
import { stationsFor, type StationDef } from '../config/stations';
import { Chart, baseOption, tipHeader, tipRow, type EChartsCoreOption } from '../components/Chart';
import { Loading, Notice, Section, Seg } from '../components/ui';
import { loadRecentModels } from '../hooks/data';
import { NOT_IN_SNAPSHOT, isNotInSnapshot } from '../lib/cache';
import { useAsync } from '../hooks/useAsync';
import { useNarrow } from '../hooks/useNarrow';
import { windowSum, type DerivedHourly } from '../lib/forecast';
import { MIN_SWE_GAIN_MM, estimateOn, estimateText, estimatesNewSnow, ratioFallback, totalEstimate, type DayEstimate, type EstimateTotal } from '../lib/newsnow';
import { loadStation, type StationFile } from '../lib/obs';
import { alpha, slotColor, type ChartPalette } from '../lib/palette';
import { useFmt, type Fmt } from '../lib/prefs';
import { measuresNewSnow, recentReports, sumOrNull, type RecentDay } from '../lib/recent';
import { RECENT_DAYS as DAYS, pointOf } from '../lib/requests';
import { addDays, dayLabel, daysBetween, localMidnightUnix, todayIn } from '../lib/time';

/** Modelled snowfall for the 24 h ending 06:00 local on each report date. */
function modelDaily(series: { time: number[]; snowCm: (number | null)[] }, dates: string[], tz: string) {
  return dates.map((d) => {
    const end = localMidnightUnix(d, tz) + 6 * 3600;
    return windowSum(series.time, series.snowCm, end - 86400, end);
  });
}

export function RecentSection({ resort, band }: { resort: Resort; band: Band }) {
  const fmt = useFmt();
  const stations = stationsFor(resort.id);
  const [stationPick, setStationId] = useState<string | null>(null);
  const today = todayIn(resort.tz);
  const dates = useMemo(() => Array.from({ length: DAYS }, (_, i) => addDays(today, i - DAYS + 1)), [today]);

  const files = useAsync(() => Promise.all(stations.map((s) => loadStation(s.id))), [resort.id]);
  // Per-station failures leave that station's model bars out; snapshot-only builds say why.
  const atStations = useAsync(async () => {
    let notInSnapshot = false;
    const models = await Promise.all(stations.map((s) => loadRecentModels(pointOf(s), resort).catch((err) => {
      if (isNotInSnapshot(err)) notInSnapshot = true;
      return null;
    })));
    return { models, notInSnapshot };
  }, [resort.id]);
  const atBand = useAsync(() => loadRecentModels(pointOf(band), resort), [resort.id, band.key]);
  // SNOTEL stations (US resorts) can show new snow estimated from the water their pillow gained; off by default.
  const canEstimate = stations.some((s) => s.source === 'SNOTEL' && s.swe);
  const [estimate, setEstimate] = useState(false);

  const rows = useMemo(() => {
    if (!files.data) return null;
    return stations.map((st, i) => {
      const f = files.data![i];
      const mp = atStations.data?.models[i] ?? null;
      return {
        st,
        file: f,
        reports: f ? recentReports(st, f, today, DAYS) : null,
        newSnow: f ? measuresNewSnow(st, f) : false,
        ...(f && estimatesNewSnow(st, f)
          ? { estimates: dates.map((d) => estimateOn(f, d)), estimateTotal: totalEstimate(f, dates[0], dates[dates.length - 1]) }
          : { estimates: null, estimateTotal: null }),
        model: mp ? modelDaily(mp.blend, dates, resort.tz) : null,
        perModel: mp ? mp.models.map((m) => ({ m, vals: modelDaily(m, dates, resort.tz) })) : null,
      };
    });
  }, [files.data, atStations.data, stations, today, dates, resort.tz]);

  const bandModel = atBand.data ? modelDaily(atBand.data.blend, dates, resort.tz) : null;
  // Default: first station (preference order) that reported in the last 3 days.
  const silent = (f: StationFile | null) => !f?.lastDepthDate || daysBetween(f.lastDepthDate, today) > 3;
  const defaultId = rows?.find((r) => !silent(r.file))?.st.id ?? stations[0].id;
  const stationId = stationPick ?? defaultId;
  const sel = rows?.find((r) => r.st.id === stationId) ?? rows?.[0];
  const [showTable, setShowTable] = useState(false);

  return (
    <Section
      title="Last 7 days — measured vs. modelled"
      subtitle={
        <>
          Each column is the 24 h ending on that morning. Measured: new snow where the station reports it (SLF, MeteoSwiss); otherwise the change in snow depth,
          which undercounts storms because new snow settles, plus water gained for snow-pillow stations. Modelled: the same physics as the forecast,
          applied to the models' short-range output at the station's location and elevation. Source day boundaries differ by up to about 6 h.
        </>
      }
      right={
        <div className="flex flex-wrap items-center gap-2">
        {canEstimate && (
          <button
            type="button" className="chip" aria-pressed={estimate} onClick={() => setEstimate((s) => !s)}
            title="SNOTEL stations: new snow estimated from the water the snow pillow gained, as a range, instead of the depth change. An estimate, not a measurement; the Methods page gives the rule."
          >
            Estimated new snow
          </button>
        )}
        <button type="button" className="chip" aria-pressed={showTable} onClick={() => setShowTable((s) => !s)}>All stations table</button>
        <Seg
          label="Station"
          value={sel?.st.id ?? stationId}
          onChange={setStationId}
          options={stations.map((s, i) => ({ value: s.id, label: `${s.name.replace(/ \(.*\)$/, '')}${files.data && silent(files.data[i]) ? ' (silent)' : ''}` }))}
        />
        </div>
      }
    >
      {files.error && <Notice tone="error">{files.error.message}</Notice>}
      {atStations.data?.notInSnapshot && <Notice>{NOT_IN_SNAPSHOT}: modelled snowfall at the stations.</Notice>}
      {!rows || !sel ? (
        <Loading what="recent observations" />
      ) : (
        <>
          {sel.reports ? <RecentChart row={sel} dates={dates} fmt={fmt} estimate={estimate} /> : <Notice>No data file for {sel.st.name}.</Notice>}
          {showTable && <RecentTable rows={rows} dates={dates} bandModel={bandModel} band={band} fmt={fmt} estimate={estimate} />}
        </>
      )}
    </Section>
  );
}

interface Row {
  st: StationDef;
  file: StationFile | null;
  reports: RecentDay[] | null;
  newSnow: boolean;
  /** New snow estimated from SWE per report date, for stations where the UI estimates it (src/lib/newsnow.ts). */
  estimates: (DayEstimate | null)[] | null;
  estimateTotal: EstimateTotal | null;
  model: (number | null)[] | null;
  perModel: { m: DerivedHourly; vals: (number | null)[] }[] | null;
}

function measured(r: Row): (number | null)[] {
  return (r.reports ?? []).map((d) => (r.newSnow ? d.newSnowCm : d.depthChangeCm));
}

const EST_LOW = 'est-low';
const EST_RANGE = 'est-range';

function RecentChart({ row, dates, fmt, estimate }: { row: Row; dates: string[]; fmt: Fmt; estimate: boolean }) {
  const narrow = useNarrow();
  // With the toggle on, SNOTEL bars show the estimate's range (solid to the low end, outlined to the high end).
  const est = estimate ? row.estimates : null;
  const flagged = !!est?.some((e) => e?.kind === 'rain-or-mixed');
  const option = useCallback(
    (p: ChartPalette): EChartsCoreOption => {
      const base = baseOption(p) as Record<string, unknown>;
      const meas = measured(row);
      const measLabel = row.newSnow ? 'Measured new snow' : 'Measured depth change';
      const toDisp = (v: number) => (fmt.units === 'imperial' ? v * 2.54 : v);
      const signed = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmt.snow(Math.abs(v))}`;
      const flag = narrow ? 'rain/mix' : 'rain/mixed';
      const estRow = (e: DayEstimate | null | undefined) =>
        !e
          ? tipRow(p.ink1, 'new snow, estimated from SWE', '—', p, 'band')
          : e.kind === 'snow'
            ? tipRow(p.ink1, 'new snow, estimated from SWE', fmt.snowRange(e.lowCm, e.highCm), p, 'band') +
              tipRow(p.ink3, e.tavgC != null ? `snow ratio at a mean ${fmt.temp(e.tavgC)}${fmt.units === 'imperial' ? 'F' : 'C'}` : 'snow ratio (no temperature reading)', `${Math.round(e.slr)}:1`, p)
            : e.kind === 'none'
              ? tipRow(p.ink1, `new snow, estimated from SWE (under ${fmt.water(MIN_SWE_GAIN_MM)} water gained)`, 'none', p, 'band')
              : tipRow(p.ink1, 'rain or mixed: depth fell while water was gained', 'no estimate', p, 'band');
      return {
        ...base,
        grid: { ...(base.grid as object), bottom: flagged ? 42 : 28 },
        xAxis: {
          ...(base.xAxis as object), type: 'category', data: dates.map(dayLabel),
          axisLabel: est
            ? {
                interval: 0,
                // Every day keeps its label (a flag needs its day), so phones shorten them: "Sa 14".
                formatter: (v: string, i: number) => {
                  const d = narrow ? v.replace(/^(\w\w)\w*/, '$1') : v;
                  return est[i]?.kind === 'rain-or-mixed' ? `{d|${d}}\n{s|${flag}}` : `{d|${d}}`;
                },
                rich: { d: { color: p.ink3, fontSize: 11, lineHeight: 15 }, s: { color: p.ink2, fontSize: 10, lineHeight: 13, fontStyle: 'italic' } },
              }
            : { color: p.ink3, fontSize: 11 },
        },
        yAxis: { ...(base.yAxis as object), type: 'value', name: fmt.snowUnit, nameTextStyle: { color: p.ink3 } },
        tooltip: {
          ...(base.tooltip as object),
          formatter: (params: { seriesName: string; value: number | null; color: string; dataIndex: number }[]) => {
            const i = params[0]?.dataIndex ?? 0;
            const rep = row.reports?.[i];
            const lines = [
              ...(est ? [estRow(est[i])] : []),
              ...params
                .filter((x) => x.value != null && x.seriesName !== EST_LOW && x.seriesName !== EST_RANGE)
                .map((x) => tipRow(x.seriesName === measLabel ? p.ink1 : x.seriesName === 'Model blend' ? p.ink3 : x.color, x.seriesName, fmt.snow(toDisp(x.value!)), p)),
            ];
            if (rep?.sweChangeMm != null) lines.push(tipRow(p.ink3, 'water gained (SWE)', fmt.water(rep.sweChangeMm), p));
            if (est && rep?.depthChangeCm != null) lines.push(tipRow(p.ink3, 'depth change', signed(rep.depthChangeCm), p));
            if (rep?.depthCm != null) lines.push(tipRow(p.ink3, 'depth that morning', fmt.snow(rep.depthCm), p));
            return tipHeader(`24 h to morning of ${dates[i]}`, p) + lines.join('');
          },
        },
        series: [
          ...(est
            ? [
                {
                  type: 'bar', name: EST_LOW, stack: 'est', barGap: '15%', barWidth: '28%', itemStyle: { color: p.ink1 },
                  data: est.map((e) => fmt.snowVal(e?.kind === 'snow' ? e.lowCm : e?.kind === 'none' ? 0 : null)),
                },
                {
                  type: 'bar', name: EST_RANGE, stack: 'est', barWidth: '28%',
                  itemStyle: { color: alpha(p.ink1, 0.15), borderColor: p.ink1, borderWidth: 1, borderType: 'dashed', borderRadius: [4, 4, 0, 0] },
                  data: est.map((e) => fmt.snowVal(e?.kind === 'snow' ? e.highCm - e.lowCm : null)),
                },
              ]
            : [{
                type: 'bar', name: measLabel, barGap: '15%', barWidth: '28%',
                itemStyle: { color: p.ink1, borderRadius: [4, 4, 0, 0] },
                data: meas.map((v) => fmt.snowVal(v)),
              }]),
          {
            type: 'bar', name: 'Model blend', barWidth: '28%',
            itemStyle: { color: alpha(p.ink3, 0.45), borderRadius: [4, 4, 0, 0] },
            data: (row.model ?? []).map((v) => fmt.snowVal(v)),
          },
          ...(row.perModel ?? []).map(({ m, vals }) => ({
            type: 'scatter', name: m.model.label, symbolSize: 8, z: 3,
            itemStyle: { color: slotColor(p, m.model.slot), borderColor: p.surface, borderWidth: 1.5 },
            data: vals.map((v) => fmt.snowVal(v)),
          })),
        ],
      };
    },
    [row, dates, fmt, est, flagged, narrow],
  );
  const fallback = est && row.estimateTotal ? ratioFallback(row.file, row.estimateTotal) : null;
  return (
    <>
      {est && row.estimateTotal && (
        <p className="text-sm mb-2">
          <b>Last 7 days:</b> {estimateText(row.estimateTotal, row.st, fmt)}.{fallback && <span className="text-ink-2 text-xs"> {fallback}</span>}
        </p>
      )}
      <div className="flex flex-wrap gap-3 text-xs text-ink-2 mb-1" aria-label="Legend">
        {est ? (
          <span className="flex items-center gap-1.5">
            <span aria-hidden className="inline-flex flex-col" style={{ width: 12, height: 12 }}>
              <span style={{ flex: 1, border: '1px dashed var(--ink-1)', borderBottom: 0, borderRadius: '2px 2px 0 0', background: 'color-mix(in srgb, var(--ink-1) 15%, transparent)' }} />
              <span style={{ flex: 1, background: 'var(--ink-1)' }} />
            </span>
            New snow at {row.st.name}, estimated from SWE: solid to the low end, outlined to the high end
          </span>
        ) : (
          <span className="flex items-center gap-1.5"><span aria-hidden style={{ width: 12, height: 10, background: 'var(--ink-1)', borderRadius: 2 }} />{row.newSnow ? 'Measured new snow' : 'Measured depth change'} at {row.st.name}</span>
        )}
        <span className="flex items-center gap-1.5"><span aria-hidden style={{ width: 12, height: 10, background: 'var(--ink-3)', opacity: 0.6, borderRadius: 2 }} />Model blend at the station</span>
        <span>Dots: individual models</span>
        {flagged && <span><i>rain/mixed</i> = depth fell while water was gained: no estimate</span>}
      </div>
      <Chart option={option} height={flagged ? 254 : 240} ariaLabel={`${est ? 'Estimated' : 'Measured'} vs modelled snow, last 7 days, ${row.st.name}`} />
    </>
  );
}

function RecentTable({ rows, dates, bandModel, band, fmt, estimate }: {
  rows: Row[]; dates: string[]; bandModel: (number | null)[] | null; band: Band; fmt: Fmt; estimate: boolean;
}) {
  const estCell = (e: DayEstimate | null) =>
    e == null ? '—' : e.kind === 'snow' ? fmt.snowRange(e.lowCm, e.highCm) : e.kind === 'none' ? fmt.snow(0) : <i>rain/mixed</i>;
  const signed = (v: number | null) => (v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmt.snow(Math.abs(v))}`);
  const signedW = (v: number | null) => (v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmt.water(Math.abs(v))}`);
  return (
    <div className="overflow-x-auto mt-3">
      <table className="data">
        <thead>
          <tr>
            <th>Station / series</th>
            {dates.map((d) => <th key={d}>{dayLabel(d)}</th>)}
            <th>7 days</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            if (!r.reports) return null;
            const meas = measured(r);
            const swe = r.reports.map((d) => d.sweChangeMm);
            return [
              <tr key={`${r.st.id}-h`}>
                <td colSpan={dates.length + 2} style={{ paddingTop: 10 }}>
                  <b>{r.st.name}</b> <span className="text-ink-3">· {fmt.elev(r.st.elevation)} · {r.st.source}</span>
                </td>
              </tr>,
              <tr key={`${r.st.id}-m`}>
                <td className="text-ink-2">{r.newSnow ? 'New snow (measured)' : 'Depth change (measured)'}</td>
                {meas.map((v, i) => <td key={i}><b>{r.newSnow ? fmt.snow(v) : signed(v)}</b></td>)}
                <td><b>{r.newSnow ? fmt.snow(sumOrNull(meas)) : signed(sumOrNull(meas))}</b></td>
              </tr>,
              estimate && r.estimates && r.estimateTotal ? (
                <tr key={`${r.st.id}-e`}>
                  <td className="text-ink-2">New snow (estimated from SWE)</td>
                  {r.estimates.map((e, i) => <td key={i}>{estCell(e)}</td>)}
                  <td>{r.estimateTotal.snowDays ? fmt.snowRange(r.estimateTotal.lowCm, r.estimateTotal.highCm) : r.estimateTotal.days ? fmt.snow(0) : '—'}</td>
                </tr>
              ) : null,
              r.st.swe ? (
                <tr key={`${r.st.id}-w`}>
                  <td className="text-ink-2">Water gained (SWE)</td>
                  {swe.map((v, i) => <td key={i}>{signedW(v)}</td>)}
                  <td>{signedW(sumOrNull(swe))}</td>
                </tr>
              ) : null,
              <tr key={`${r.st.id}-mod`}>
                <td className="text-ink-2">Models at station (blend)</td>
                {(r.model ?? dates.map(() => null)).map((v, i) => <td key={i}>{fmt.snow(v)}</td>)}
                <td>{fmt.snow(r.model ? sumOrNull(r.model) : null)}</td>
              </tr>,
            ];
          })}
          {bandModel && (
            <tr>
              <td style={{ paddingTop: 10 }}><b>Models at {bandInText(band)}</b> <span className="text-ink-3">· {fmt.elev(band.elevation)}</span></td>
              {bandModel.map((v, i) => <td key={i} style={{ paddingTop: 10 }}>{fmt.snow(v)}</td>)}
              <td style={{ paddingTop: 10 }}>{fmt.snow(sumOrNull(bandModel))}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
