import { useCallback, useMemo, useState } from 'react';
import type { Band, Resort } from '../config/resorts';
import { stationsFor, type StationDef } from '../config/stations';
import { Chart, baseOption, tipHeader, tipRow, type EChartsCoreOption } from '../components/Chart';
import { Loading, Notice, Section, Seg } from '../components/ui';
import { loadRecentModels } from '../hooks/data';
import { useAsync } from '../hooks/useAsync';
import { windowSum, type DerivedHourly } from '../lib/forecast';
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
  const atStations = useAsync(
    () => Promise.all(stations.map((s) => loadRecentModels(pointOf(s), resort).catch(() => null))),
    [resort.id],
  );
  const atBand = useAsync(() => loadRecentModels(pointOf(band), resort), [resort.id, band.key]);

  const rows = useMemo(() => {
    if (!files.data) return null;
    return stations.map((st, i) => {
      const f = files.data![i];
      const mp = atStations.data?.[i] ?? null;
      return {
        st,
        file: f,
        reports: f ? recentReports(st, f, today, DAYS) : null,
        newSnow: f ? measuresNewSnow(st, f) : false,
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
      {!rows || !sel ? (
        <Loading what="recent observations" />
      ) : (
        <>
          {sel.reports ? <RecentChart row={sel} dates={dates} fmt={fmt} /> : <Notice>No data file for {sel.st.name}.</Notice>}
          {showTable && <RecentTable rows={rows} dates={dates} bandModel={bandModel} band={band} fmt={fmt} />}
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
  model: (number | null)[] | null;
  perModel: { m: DerivedHourly; vals: (number | null)[] }[] | null;
}

function measured(r: Row): (number | null)[] {
  return (r.reports ?? []).map((d) => (r.newSnow ? d.newSnowCm : d.depthChangeCm));
}

function RecentChart({ row, dates, fmt }: { row: Row; dates: string[]; fmt: Fmt }) {
  const option = useCallback(
    (p: ChartPalette): EChartsCoreOption => {
      const base = baseOption(p) as Record<string, unknown>;
      const meas = measured(row);
      const measLabel = row.newSnow ? 'Measured new snow' : 'Measured depth change';
      const toDisp = (v: number) => (fmt.units === 'imperial' ? v * 2.54 : v);
      return {
        ...base,
        xAxis: { ...(base.xAxis as object), type: 'category', data: dates.map(dayLabel) },
        yAxis: { ...(base.yAxis as object), type: 'value', name: fmt.snowUnit, nameTextStyle: { color: p.ink3 } },
        tooltip: {
          ...(base.tooltip as object),
          formatter: (params: { seriesName: string; value: number | null; color: string; dataIndex: number }[]) => {
            const i = params[0]?.dataIndex ?? 0;
            const rep = row.reports?.[i];
            const lines = params
              .filter((x) => x.value != null)
              .map((x) => tipRow(x.seriesName === measLabel ? p.ink1 : x.seriesName === 'Model blend' ? p.ink3 : x.color, x.seriesName, fmt.snow(toDisp(x.value!)), p));
            if (rep?.sweChangeMm != null) lines.push(tipRow(p.ink3, 'water gained (SWE)', fmt.water(rep.sweChangeMm), p));
            if (rep?.depthCm != null) lines.push(tipRow(p.ink3, 'depth that morning', fmt.snow(rep.depthCm), p));
            return tipHeader(`24 h to morning of ${dates[i]}`, p) + lines.join('');
          },
        },
        series: [
          {
            type: 'bar', name: measLabel, barGap: '15%', barWidth: '28%',
            itemStyle: { color: p.ink1, borderRadius: [4, 4, 0, 0] },
            data: meas.map((v) => fmt.snowVal(v)),
          },
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
    [row, dates, fmt],
  );
  return (
    <>
      <div className="flex flex-wrap gap-3 text-xs text-ink-2 mb-1" aria-label="Legend">
        <span className="flex items-center gap-1.5"><span aria-hidden style={{ width: 12, height: 10, background: 'var(--ink-1)', borderRadius: 2 }} />{row.newSnow ? 'Measured new snow' : 'Measured depth change'} at {row.st.name}</span>
        <span className="flex items-center gap-1.5"><span aria-hidden style={{ width: 12, height: 10, background: 'var(--ink-3)', opacity: 0.6, borderRadius: 2 }} />Model blend at the station</span>
        <span>Dots: individual models</span>
      </div>
      <Chart option={option} height={240} ariaLabel={`Measured vs modelled snow, last 7 days, ${row.st.name}`} />
    </>
  );
}

function RecentTable({ rows, dates, bandModel, band, fmt }: {
  rows: Row[]; dates: string[]; bandModel: (number | null)[] | null; band: Band; fmt: Fmt;
}) {
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
              <td style={{ paddingTop: 10 }}><b>Models at {band.label.toLowerCase()}</b> <span className="text-ink-3">· {fmt.elev(band.elevation)}</span></td>
              {bandModel.map((v, i) => <td key={i} style={{ paddingTop: 10 }}>{fmt.snow(v)}</td>)}
              <td style={{ paddingTop: 10 }}>{fmt.snow(sumOrNull(bandModel))}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
