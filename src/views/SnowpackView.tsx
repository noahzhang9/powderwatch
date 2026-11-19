import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { MODELS } from '../config/models';
import type { Resort } from '../config/resorts';
import { stationsFor, type StationDef } from '../config/stations';
import { Chart, baseOption, tipHeader, tipRow, type EChartsCoreOption } from '../components/Chart';
import { Loading, Notice, Section, Seg, Tile } from '../components/ui';
import { loadScenarios, useEnsembles } from '../hooks/data';
import { useAsync } from '../hooks/useAsync';
import { buildClimatology, currentSeason, percentileRank, SEASON_DAYS, seasonDate, seasonIndex, typicalDayFor, type Climatology } from '../lib/climatology';
import { deriveModel } from '../lib/forecast';
import { loadStation, valueOn, type StationFile, type Variable } from '../lib/obs';
import { alpha, slotColor, type ChartPalette } from '../lib/palette';
import { useFmt, type Fmt } from '../lib/prefs';
import { runSnowpack, type ForcingHour } from '../lib/snowpack';
import { familyWeights, isNum, weightedQuantile, type Series } from '../lib/stats';
import { addDays, ago, daysBetween, localMidnightUnix, shortDate, todayIn } from '../lib/time';
import { useHashParam } from '../hooks/useRoute';
import { defaultStationIndex, pointOf, projectionStart, SNOWPACK_WITH_FREEZING_LEVEL } from '../lib/requests';

const PROJECTION_DAYS = 15;
const MONTH_STARTS = [0, 31, 61, 92, 123, 151, 182, 212, 243];
const MONTH_NAMES = ['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'];

function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
  const r = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lon - a.lon) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

interface Projection {
  /** Season day index → quantiles. */
  ks: number[];
  p10: (number | null)[];
  p50: (number | null)[];
  p90: (number | null)[];
  scenarios: { modelId: string; values: (number | null)[] }[];
  members: number;
  initDate: string;
}

export function SnowpackView({ resort }: { resort: Resort }) {
  const fmt = useFmt();
  const stations = stationsFor(resort.id);
  const [picked, setStationId] = useState<string | null>(null);
  // Default to the first station (preference order) that reported in the last 3 days.
  const defaultId = useAsync(async () => {
    const files = await Promise.all(stations.map((s) => loadStation(s.id)));
    return stations[defaultStationIndex(files, todayIn(resort.tz))].id;
  }, [resort.id]);
  const stationId = picked ?? defaultId.data ?? stations[0].id;
  const st = stations.find((s) => s.id === stationId)!;
  const [variable, setVariable] = useState<Variable>('depthCm');
  const v: Variable = variable === 'sweMm' && !st.swe ? 'depthCm' : variable;
  const [showPrev, setShowPrev] = useState(true);
  const [showScenarios, setShowScenarios] = useState(false);
  const [range, setRange] = useHashParam<'sofar' | 'full'>('range', 'sofar', ['sofar', 'full']);
  const file = useAsync(() => loadStation(st.id), [st.id]);
  const today = todayIn(resort.tz);
  const clim = useMemo(() => (file.data ? buildClimatology(file.data, v, today) : null), [file.data, v, today]);
  const { last, stale, pastDays } = projectionStart(file.data ?? null, v, today);
  const point = pointOf(st);

  const ens = useEnsembles(point, resort.tz, !stale, pastDays, SNOWPACK_WITH_FREEZING_LEVEL);
  const det = useAsync(() => loadScenarios(point, resort.tz, pastDays), [st.id, pastDays], !stale);

  const projection = useMemo<Projection | null>(() => {
    if (!file.data || !last || stale || !ens.data) return null;
    const initDate = last.date;
    const initT = localMidnightUnix(initDate, resort.tz);
    const depth0 = valueOn(file.data, 'depthCm', initDate);
    const swe0 = file.data.sweMm ? valueOn(file.data, 'sweMm', initDate) : null;
    const init = { depthCm: depth0 ?? (swe0 != null ? swe0 / 3 : 0), sweMm: swe0, month: Number(initDate.slice(5, 7)) - 1 };
    const dates = Array.from({ length: daysBetween(initDate, today) + PROJECTION_DAYS }, (_, i) => addDays(initDate, i + 1));
    const dayTimes = dates.map((d) => localMidnightUnix(d, resort.tz));
    const run = (time: number[], precip: Series, tC: Series, rh: Series) => {
      const forcing: ForcingHour[] = [];
      time.forEach((t, i) => {
        if (t > initT) forcing.push({ time: t, precipMm: precip[i], tC: tC[i], rhPct: rh[i] });
      });
      const out = runSnowpack(init, forcing);
      const byT = new Map(out.map((o) => [o.time, o]));
      return dayTimes.map((t) => {
        const o = byT.get(t);
        return o ? (v === 'depthCm' ? o.depthCm : o.sweMm) : null;
      });
    };
    const memberVals = ens.data.members.map((m) => run(ens.data!.time, m.precip, m.tC, m.rh));
    const fams = ens.data.members.map((m) => m.def.family);
    const q = (j: number, qq: number) => {
      const vals = memberVals.map((mv) => mv[j]);
      return weightedQuantile(vals, familyWeights(fams, vals.map(isNum)), qq);
    };
    const ks = dates.map((d) => seasonIndex(d)?.k ?? -1);
    const scenarios = (det.data ?? []).map((raw) => {
      const d = deriveModel(raw);
      return { modelId: raw.modelId, values: run(d.time, d.precip, d.tC, d.rh) };
    });
    return {
      ks,
      p10: dates.map((_, j) => q(j, 0.1)),
      p50: dates.map((_, j) => q(j, 0.5)),
      p90: dates.map((_, j) => q(j, 0.9)),
      scenarios,
      members: memberVals.length,
      initDate,
    };
  }, [file.data, last?.date, stale, ens.data, det.data, v, resort.tz, today]); // eslint-disable-line react-hooks/exhaustive-deps

  const season = currentSeason(today);
  const kToday = seasonIndex(today)?.k ?? null;

  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-sm text-ink-2 flex items-center gap-2">
          Station
          <select className="field" value={stationId} onChange={(e) => setStationId(e.target.value)}>
            {stations.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} · {fmt.elev(s.elevation)} · {s.source}
              </option>
            ))}
          </select>
        </label>
        {st.swe ? (
          <Seg label="Variable" value={v} onChange={setVariable} options={[{ value: 'depthCm', label: 'Snow depth' }, { value: 'sweMm', label: 'Water equivalent' }]} />
        ) : (
          <span className="text-sm text-ink-2">Snow depth</span>
        )}
        <Seg label="Time range" value={range} onChange={setRange} options={[{ value: 'sofar', label: 'Season so far' }, { value: 'full', label: 'Full season' }]} />
        <label className="text-xs text-ink-2 flex items-center gap-1.5">
          <input type="checkbox" checked={showPrev} onChange={(e) => setShowPrev(e.target.checked)} /> Last season
        </label>
        <label className="text-xs text-ink-2 flex items-center gap-1.5">
          <input type="checkbox" checked={showScenarios} onChange={(e) => setShowScenarios(e.target.checked)} /> Single-model scenarios
        </label>
      </div>
      <StationInfo st={st} resort={resort} clim={clim} file={file.data ?? null} fmt={fmt} />
      {file.error && <Notice tone="error">{file.error.message}</Notice>}
      {!file.data || !clim ? (
        file.loading ? <Loading what="station history" /> : <Notice tone="error">No data file for this station. Run <code>npm run obs</code>.</Notice>
      ) : (
        <>
          <Stats clim={clim} last={last} today={today} projection={projection} fmt={fmt} v={v} stale={stale} />
          {stale && (
            <Notice tone="warn">
              {last ? `Latest reading is from ${shortDate(last.date)}, too old to start a projection.` : 'No readings this season.'} Climatology is still shown.
            </Notice>
          )}
          {ens.error && <Notice tone="error">Ensemble request failed: {ens.error.message}</Notice>}
          <Section
            title={`${v === 'depthCm' ? 'Snow depth' : 'Snow water equivalent'} at ${st.name}, ${season}–${String(season + 1).slice(2)} season`}
            subtitle={
              <>
                Compared with this station's own history ({clim.seasons.length} seasons). The projection runs {projection ? `${projection.members} ensemble members` : 'the ensembles'} through a settling/melt model from the latest reading;
                its band is model spread, not a calibrated confidence interval, and beyond 10 days it is low confidence.
              </>
            }
          >
            <SeasonChart clim={clim} season={season} kToday={kToday} projection={projection} showPrev={showPrev} showScenarios={showScenarios} fmt={fmt} v={v} zoom={range === 'sofar'} />
          </Section>
        </>
      )}
    </div>
  );
}

function StationInfo({ st, resort, clim, file, fmt }: { st: StationDef; resort: Resort; clim: Climatology | null; file: StationFile | null; fmt: Fmt }) {
  const mid = resort.bands.find((b) => b.key === 'mid')!;
  const d = distanceKm(st, mid);
  return (
    <div className="text-xs text-ink-2 mt-3 leading-relaxed">
      <b className="text-ink">{st.name}</b> ({st.source} {st.sourceId}) · {fmt.elev(st.elevation)} · {d.toFixed(0)} km from {resort.short} mid-mountain.{' '}
      {st.dailyNote}{' '}
      {clim && clim.seasons.length > 0 && <>Climatology uses {clim.seasons.length} seasons with ≥80% Nov–May coverage ({clim.seasons[0]}–{clim.seasons.at(-1)! + 1}). </>}
      {file && <>Station data updated {ago(Math.floor(Date.parse(file.updated) / 1000))}. </>}
      <a className="underline" href={st.url} target="_blank" rel="noreferrer">{st.attribution} ↗</a>
      {st.caveat && <Notice tone="warn">{st.caveat}</Notice>}
      <div className="mt-1 text-ink-3">This is a measurement site, not the resort's reported base depth. Wind, aspect and grooming make on-piste depths differ.</div>
    </div>
  );
}

function Stats({ clim, last, today, projection, fmt, v, stale }: {
  clim: Climatology; last: { date: string; value: number } | null; today: string; projection: Projection | null; fmt: Fmt; v: Variable; stale: boolean;
}) {
  const show = (x: number | null | undefined) => (v === 'depthCm' ? fmt.snow(x) : fmt.water(x));
  if (!last) return null;
  const k = seasonIndex(last.date)?.k ?? null;
  const median = k != null ? clim.p50[k] : null;
  const pct = k != null ? percentileRank(clim, k, last.value) : null;
  const typical = typicalDayFor(clim, last.value);
  const lag = k != null && typical != null ? typical - k : null;
  const j7 = projection ? projection.ks.findIndex((x, i) => i >= daysBetween(projection.initDate, today) + 6 && x >= 0) : -1;
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 mt-3">
      <Tile label={`Measured ${shortDate(last.date)}`} value={show(last.value)} sub={v === 'depthCm' ? 'snow depth' : 'snow water equivalent'} />
      <Tile
        label="vs median for the date"
        value={median != null && median >= 1 ? `${Math.round((100 * last.value) / median)}%` : '—'}
        sub={median != null ? `median ${show(median)}` : 'no climatology'}
      />
      {clim.seasons.length < 10
        ? <Tile label="Percentile" value="—" sub={`short record (${clim.seasons.length} seasons) — not enough for percentiles`} />
        : <Tile label="Percentile" value={pct == null ? '—' : `${Math.round(pct)}th`} sub={`among ${clim.seasons.length} seasons`} />}
      <Tile
        label="Typical for"
        value={!(last.value > 0) || k == null ? '—' : typical != null ? shortDate(seasonDate(2001, typical)) : 'above peak'}
        sub={!(last.value > 0) || k == null ? 'no snow on the ground' : lag == null ? 'deeper than the median ever gets' : lag === 0 ? 'right on schedule' : lag > 0 ? `${lag} days ahead of normal` : `${-lag} days behind normal`}
      />
      <Tile
        label="Projected in 7 days"
        value={projection && j7 >= 0 ? show(projection.p50[j7]) : '—'}
        sub={projection && j7 >= 0 ? `spread ${show(projection.p10[j7])} – ${show(projection.p90[j7])}` : stale ? 'no recent reading' : 'loading ensembles…'}
      />
    </div>
  );
}

function SeasonChart({ clim, season, kToday, projection, showPrev, showScenarios, fmt, v, zoom }: {
  clim: Climatology; season: number; kToday: number | null; projection: Projection | null; showPrev: boolean; showScenarios: boolean; fmt: Fmt; v: Variable; zoom: boolean;
}) {
  const conv = useCallback((x: number | null | undefined) => (v === 'depthCm' ? fmt.snowVal(x) : fmt.waterVal(x)), [fmt, v]);
  const unit = v === 'depthCm' ? fmt.snowUnit : fmt.waterUnit;
  const option = useCallback(
    (p: ChartPalette): EChartsCoreOption => {
      const base = baseOption(p) as Record<string, unknown>;
      const ks = Array.from({ length: SEASON_DAYS }, (_, k) => k);
      // Reference series stop at the visible right edge so their direct labels sit inside the plot.
      const kEnd = zoom && kToday != null ? Math.min(SEASON_DAYS - 1, kToday + 30) : SEASON_DAYS - 1;
      const vis = ks.filter((k) => k <= kEnd);
      const ser = (arr: (number | null)[]) => vis.map((k) => [k, conv(arr[k])]);
      const edgeLabel = (text: string, color: string, weight = 400) => ({
        show: true, formatter: text, color, fontSize: 10, fontWeight: weight, distance: 6,
      });
      const bandPair = (name: string, lo: (number | null)[], hi: (number | null)[], color: string, label?: string) => [
        { type: 'line', name: `${name}-lo`, stack: name, symbol: 'none', lineStyle: { opacity: 0 }, data: ser(lo), silent: true },
        { type: 'line', name, stack: name, symbol: 'none', lineStyle: { opacity: 0 }, areaStyle: { color }, silent: true,
          endLabel: label ? edgeLabel(label, p.ink3) : undefined, labelLayout: { moveOverlap: 'shiftY' },
          data: vis.map((k) => [k, lo[k] == null || hi[k] == null ? null : conv(hi[k]! - lo[k]!)]) },
      ];
      const cur = clim.bySeason.get(season) ?? [];
      const prev = clim.bySeason.get(season - 1) ?? [];
      const curPts = ks.filter((k) => kToday == null || k <= kToday).map((k) => [k, conv(cur[k])]);
      const lastCur = [...curPts].reverse().find((pt) => pt[1] != null) ?? null;
      const proj = projection;
      // Anchor the projection on the reading it starts from, so it connects to this season's line.
      const initK = proj ? seasonIndex(proj.initDate)?.k ?? null : null;
      const initV = initK != null ? cur[initK] : null;
      const anchor = (pts: (number | null)[][], v0: number | null) => (initK != null && v0 != null ? [[initK, v0], ...pts] : pts);
      const projPts = (arr: (number | null)[]) => anchor(proj ? proj.ks.map((k, i) => [k, conv(arr[i])]).filter(([k]) => (k as number) >= 0) : [], conv(initV));
      const projDiff = anchor(proj ? proj.ks.map((k, i) => [k, proj.p10[i] == null || proj.p90[i] == null ? null : conv(proj.p90[i]! - proj.p10[i]!)]).filter(([k]) => (k as number) >= 0) : [], 0);
      const thin = clim.seasons.length < 10;
      // "Season so far": Oct 1 → 30 days past today, y fitted to what is shown.
      const xMax = zoom && kToday != null ? Math.min(SEASON_DAYS - 1, kToday + 30) : SEASON_DAYS - 1;
      const inView = (arr: (number | null)[]) => arr.slice(0, xMax + 1).filter((x): x is number => x != null);
      const yMax = zoom
        ? Math.max(5, ...inView(thin ? clim.p50 : clim.p90).map((x) => conv(x)!), ...inView(cur).map((x) => conv(x)!), ...(proj ? proj.p90.filter((x): x is number => x != null).map((x) => conv(x)!) : [])) * 1.2
        : undefined;
      const ticks = MONTH_STARTS.filter((m) => m <= xMax);
      const f = (x: number | null | undefined) => (x == null ? '—' : `${x.toFixed(fmt.units === 'imperial' ? 1 : 0)} ${unit}`);
      const lowConfFrom = kToday != null ? kToday + 10 : null;
      return {
        ...base,
        grid: { left: 56, right: 104, top: 20, bottom: 28 },
        xAxis: {
          ...(base.xAxis as object), type: 'value', min: 0, max: xMax,
          axisLabel: { color: p.ink3, fontSize: 11, customValues: ticks, formatter: (x: number) => MONTH_NAMES[MONTH_STARTS.indexOf(x)] ?? '' },
          axisTick: { show: true, customValues: ticks, lineStyle: { color: p.axis } },
          splitLine: { show: false },
        },
        yAxis: { ...(base.yAxis as object), type: 'value', min: 0, max: yMax == null ? undefined : Math.ceil(yMax / 5) * 5, name: unit, nameTextStyle: { color: p.ink3 } },
        tooltip: {
          ...(base.tooltip as object),
          formatter: (params: { axisValue: number }[]) => {
            const k = Math.round(params[0]?.axisValue ?? 0);
            const pj = proj ? proj.ks.indexOf(k) : -1;
            // Keys mirror the marks: same colours and names as the legend above the chart.
            const rows = [
              cur[k] != null && (kToday == null || k <= kToday) ? tipRow(p.ink1, 'This season', f(conv(cur[k])), p) : '',
              pj >= 0 && proj!.p50[pj] != null ? tipRow(p.proj.line, 'Projection (median)', f(conv(proj!.p50[pj])), p) + tipRow(p.proj.outer, 'Projection 10–90%', `${f(conv(proj!.p10[pj]))} – ${f(conv(proj!.p90[pj]))}`, p, 'band') : '',
              showPrev && prev[k] != null ? tipRow(p.lastSeason, 'Last season', f(conv(prev[k])), p) : '',
              tipRow(p.ink3, 'Median', f(conv(clim.p50[k])), p, 'dashed'),
              thin ? '' : tipRow(alpha(p.ink3, 0.55), 'Middle half (25–75%)', `${f(conv(clim.p25[k]))} – ${f(conv(clim.p75[k]))}`, p, 'band'),
              thin ? '' : tipRow(alpha(p.ink3, 0.35), '10–90%', `${f(conv(clim.p10[k]))} – ${f(conv(clim.p90[k]))}`, p, 'band'),
              tipRow(alpha(p.ink3, 0.18), 'Record low–high', `${f(conv(clim.min[k]))} – ${f(conv(clim.max[k]))}`, p, 'band'),
            ];
            return tipHeader(shortDate(seasonDate(season, k)), p) + rows.join('');
          },
        },
        series: [
          ...bandPair('range', clim.min, clim.max, alpha(p.ink3, 0.1), 'record high'),
          ...(thin ? [] : [...bandPair('p10-90', clim.p10, clim.p90, alpha(p.ink3, 0.16), '90%'), ...bandPair('p25-75', clim.p25, clim.p75, alpha(p.ink3, 0.22), '75%')]),
          {
            type: 'line', name: 'Median', symbol: 'none', lineStyle: { width: 1.5, color: p.ink2, type: 'dashed' }, data: ser(clim.p50), silent: true,
            endLabel: edgeLabel('Median', p.ink2, 600), labelLayout: { moveOverlap: 'shiftY' },
          },
          ...(showPrev
            ? [{
                type: 'line', name: 'Last season', symbol: 'none', lineStyle: { width: 2, color: p.lastSeason }, data: ser(prev), silent: true,
                endLabel: edgeLabel('Last season', p.lastSeason, 600), labelLayout: { moveOverlap: 'shiftY' },
              }]
            : []),
          ...(proj
            ? [
                { type: 'line', name: 'proj-lo', stack: 'proj', symbol: 'none', lineStyle: { opacity: 0 }, data: projPts(proj.p10), silent: true },
                { type: 'line', name: 'Projection 10–90%', stack: 'proj', symbol: 'none', lineStyle: { opacity: 0 }, areaStyle: { color: p.proj.outer }, data: projDiff, silent: true },
                {
                  type: 'line', name: 'Projection', symbol: 'none', lineStyle: { width: 2.5, color: p.proj.line }, data: projPts(proj.p50), z: 6, silent: true,
                  endLabel: { show: true, color: p.ink1, fontSize: 11, fontWeight: 600, formatter: (x: { value: [number, number | null] }) => {
                    const last = proj.ks.length - 1;
                    if (x.value[1] == null || last < 0) return '';
                    const lo = conv(proj.p10[last]);
                    const hi = conv(proj.p90[last]);
                    return `≈${Math.round(x.value[1])} ${unit} by ${shortDate(seasonDate(season, proj.ks[last]))}${lo != null && hi != null ? ` (${Math.round(lo)}–${Math.round(hi)})` : ''}`;
                  } },
                },
                ...(showScenarios
                  ? proj.scenarios.map((s) => ({
                      type: 'line', name: MODELS[s.modelId].label, symbol: 'none', silent: true,
                      lineStyle: { width: 1.5, color: slotColor(p, MODELS[s.modelId].slot) },
                      data: proj.ks.map((k, i) => [k, conv(s.values[i])]).filter(([k]) => (k as number) >= 0),
                      endLabel: { show: true, formatter: MODELS[s.modelId].label, color: p.ink2, fontSize: 10 },
                    }))
                  : []),
              ]
            : []),
          {
            type: 'line', name: 'This season', symbol: 'none', z: 7, lineStyle: { width: 3, color: p.ink1 }, data: curPts,
            endLabel: proj ? undefined : { show: true, color: p.ink1, fontSize: 11, fontWeight: 600, formatter: 'This season' },
            markPoint: proj && lastCur ? {
              silent: true, symbol: 'circle', symbolSize: 7, itemStyle: { color: p.ink1, borderColor: p.surface, borderWidth: 1.5 },
              label: { show: true, position: 'top', distance: 8, color: p.ink1, fontSize: 11, fontWeight: 600, formatter: 'This season' },
              data: [{ coord: lastCur }],
            } : undefined,
            markLine: kToday != null ? {
              silent: true, symbol: 'none', lineStyle: { color: p.ink3, type: 'solid', width: 1 },
              label: { formatter: 'today', color: p.ink2, fontSize: 11 }, data: [{ xAxis: kToday }],
            } : undefined,
            markArea: lowConfFrom != null && proj ? {
              silent: true, itemStyle: { color: alpha(p.ink3, 0.06) },
              label: { show: true, position: 'insideTop', color: p.ink3, fontSize: 10, formatter: 'low confidence' },
              data: [[{ xAxis: lowConfFrom }, { xAxis: Math.min(SEASON_DAYS - 1, lowConfFrom + 6) }]],
            } : undefined,
          },
        ],
      };
    },
    [clim, season, kToday, projection, showPrev, showScenarios, conv, fmt, unit, zoom],
  );
  return (
    <>
      <SeasonLegend showPrev={showPrev} showProjection={!!projection} showScenarios={showScenarios} season={season} thin={clim.seasons.length < 10} />
      <Chart option={option} height={380} ariaLabel="Seasonal snowpack versus history with projection" />
    </>
  );
}

/** Legend that mirrors each mark: line keys for lines, filled keys for bands. */
function SeasonLegend({ showPrev, showProjection, showScenarios, season, thin }: { showPrev: boolean; showProjection: boolean; showScenarios: boolean; season: number; thin: boolean }) {
  const line = (color: string, width: number) => <span aria-hidden style={{ width: 18, height: width, background: color, display: 'inline-block', borderRadius: 1 }} />;
  const band = (opacity: number) => <span aria-hidden style={{ width: 14, height: 10, background: 'var(--ink-3)', opacity, display: 'inline-block', borderRadius: 2 }} />;
  const item = (key: ReactNode, label: string) => (
    <span className="flex items-center gap-1.5">{key}{label}</span>
  );
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-2 mb-2" aria-label="Chart legend">
      {item(line('var(--ink-1)', 3), `This season (${season}–${String(season + 1).slice(2)})`)}
      {showProjection && item(<span aria-hidden className="flex items-center">{line('var(--proj-line)', 3)}<span style={{ width: 10, height: 10, marginLeft: 2, background: 'var(--proj-band-outer)', borderRadius: 2 }} /></span>, 'Projection: median and 10–90% of members')}
      {showPrev && item(line('var(--last-season)', 2), `Last season (${season - 1}–${String(season).slice(2)})`)}
      {item(<span aria-hidden style={{ width: 18, height: 0, borderTop: '2px dashed var(--ink-3)', display: 'inline-block' }} />, 'Median')}
      {thin ? <span className="text-ink-3">Short record: percentile bands hidden</span> : <>{item(band(0.5), 'Middle half of seasons (25–75%)')}{item(band(0.3), '10–90%')}</>}
      {item(band(0.15), 'Record low–high')}
      {showScenarios && <span className="text-ink-3">Thin coloured lines: single-model scenarios (labelled)</span>}
    </div>
  );
}
