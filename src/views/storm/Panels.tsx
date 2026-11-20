/** Storm-tracker panels: headline totals, chances, run-to-run change and run times. */
import { Fragment } from 'react';
import { MODELS } from '../../config/models';
import type { Band, Resort } from '../../config/resorts';
import { bandInText } from '../../config/resorts';
import { Loading, Notice, RequestError, Section, Tile } from '../../components/ui';
import { loadRunChange, type BandForecast, type EnsembleSet } from '../../hooks/data';
import { useAsync } from '../../hooks/useAsync';
import { CHANCE_HORIZONS_H, CHANCE_THRESHOLDS_CM, probabilityAtLeast, probabilityFzlAbove, windowQuantiles, windowTotals } from '../../lib/ensemble';
import { lastValidTime, windowSum, type DerivedHourly } from '../../lib/forecast';
import type { RunMeta } from '../../lib/openmeteo';
import type { Fmt } from '../../lib/prefs';
import { NOT_IN_SNAPSHOT, isNotInSnapshot } from '../../lib/cache';
import { RUN_CHANGE_OFFSET_S, runChangeModels } from '../../lib/requests';
import { isNum } from '../../lib/stats';
import { ago, localHourLabel, nowUnix, runLabel } from '../../lib/time';
import { WPC_ATTRIBUTION, WPC_CATEGORY_LABEL, WPC_PAGE, WPC_THRESHOLDS_IN, type WpcCategory, type WpcFile, type WpcPeriod } from '../../lib/wpc';
import { midBand } from '../../lib/requests';
import { useSinceLastVisit } from '../../lib/visits';

function modelWindow(m: DerivedHourly, from: number, hours: number, key: 'snowCm' | 'omSnowCm' = 'snowCm') {
  const to = from + hours * 3600;
  const end = lastValidTime(m.time, m.precip);
  if (end == null || end < to - 3600) return null;
  return windowSum(m.time, m[key], from, to);
}

export function Delta({ d, fmt }: { d: { delta: number; sinceS: number } | null; fmt: Fmt }) {
  if (!d || Math.abs(d.delta) < 0.5) return d ? <span className="text-ink-3">unchanged since your last visit</span> : null;
  const h = d.sinceS / 3600;
  const when = h < 36 ? `${Math.round(h)} h` : `${Math.round(h / 24)} d`;
  return (
    <span className="text-ink-1">
      {d.delta > 0 ? '▲' : '▼'} {d.delta > 0 ? '+' : '−'}{fmt.snow(Math.abs(d.delta))} <span className="text-ink-3">since your visit {when} ago</span>
    </span>
  );
}

/** Keeps a figure and its unit on one line when a tile's sub-line wraps. */
const nw = (text: string) => <span className="whitespace-nowrap">{text}</span>;

const WINDOWS = [
  { label: 'Next 24 h', hours: 24, ensemble: false },
  { label: 'Next 3 days', hours: 72, ensemble: false },
  { label: 'Next 7 days', hours: 168, ensemble: true },
  { label: 'Next 14 days', hours: 336, ensemble: true },
];

/**
 * Headline totals. Short windows lead with the multi-model blend; 7+ day
 * windows lead with the ensemble median because the blend's membership
 * thins out with lead time and can leave the range of the models that remain.
 * When one model alone covers a window, the blend's late days are that model,
 * so the tile names it and gives its own total instead of a blend.
 */
export function Totals({ data, now, ens, fmt, rawSnow, resort, band }: {
  data: BandForecast; now: number; ens?: EnsembleSet; fmt: Fmt; rawSnow: boolean; resort: Resort; band: Band;
}) {
  const key = rawSnow ? 'omSnowCm' : 'snowCm';
  // "Since your last visit" compares the physics totals the dashboard also shows, never Open-Meteo's raw 7:1 snowfall.
  const visitKey = (hours: number) => `${resort.id}:${band.key}:${hours}`;
  const deltas = useSinceLastVisit(
    rawSnow ? {} : Object.fromEntries([72, 168].map((h) => [visitKey(h), windowSum(data.blend.time, data.blend.snowCm, now, now + h * 3600)])),
  );
  const wet = data.blend.time
    .map((t, i) => (t > now && t <= now + 72 * 3600 && (data.blend.precip[i] ?? 0) >= 0.3 ? data.blend.snowLevel[i] : null))
    .filter(isNum);
  const rain7 = windowSum(data.blend.time, data.blend.rainMm, now, now + 168 * 3600);
  // "None" only when the blend and every model show as zero, so the sub-line never contradicts the value.
  const zero = fmt.snow(0);
  return (
    // Phones: compact tiles, two to a row with the snow-level tile across both, so the daily chart starts near the first screen.
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-2 sm:gap-3 mt-3 sm:mt-4">
      {WINDOWS.map((w) => {
        const blendTotal = windowSum(data.blend.time, data.blend[key], now, now + w.hours * 3600);
        // Models that cover the whole window, with their own totals.
        const cover = data.models
          .map((m) => ({ label: m.model.label, v: modelWindow(m, now, w.hours, key) }))
          .filter((x): x is { label: string; v: number } => isNum(x.v));
        const per = cover.map((x) => x.v);
        const lo = per.length >= 2 ? Math.min(...per) : null;
        const hi = per.length >= 2 ? Math.max(...per) : null;
        const only = cover.length === 1 ? cover[0] : null;
        const ws = ens && !rawSnow ? windowTotals(ens.time, ens.members, now, now + w.hours * 3600) : null;
        const [p10, p50, p90] = ws ? windowQuantiles(ws, [0.1, 0.5, 0.9]) : [null, null, null];
        const useEns = w.ensemble && p50 != null;
        const range = !cover.length
          ? 'no model reaches this far'
          : only
            ? useEns ? <>only {only.label} reaches this far: {nw(fmt.snow(only.v))}</> : 'no other model reaches this far'
            : fmt.snow(hi) === zero && fmt.snow(blendTotal ?? 0) === zero
              ? `all ${per.length} models: none`
              : `${per.length} models: ${fmt.snowRange(lo, hi)}`;
        const outside = blendTotal != null && lo != null && hi != null && (blendTotal < lo - 0.5 || blendTotal > hi + 0.5);
        const delta = deltas[visitKey(w.hours)] ?? null;
        return (
          <Tile
            key={w.label}
            compact="tile"
            label={useEns ? `${w.label} · ensemble median` : only ? `${w.label} · ${only.label}` : w.label}
            value={fmt.snow(useEns ? p50 : only ? only.v : cover.length ? blendTotal : null)}
            sub={
              <>
                {useEns ? <>10–90%: {nw(fmt.snowRange(p10, p90))}{cover.length >= 2 && <> · {nw(`blend ${fmt.snow(blendTotal)}`)}</>}</> : range}
                {useEns && <><br />{range}</>}
                {!useEns && p10 != null && w.hours >= 72 && <><br />ensemble 10–90%: {fmt.snowRange(p10, p90)}</>}
                {outside && <><br /><span className="text-ink-1">⚠ blend outside the model range (fewer centres late in the window)</span></>}
                {delta && <><br /><Delta d={delta} fmt={fmt} /></>}
              </>
            }
          />
        );
      })}
      <Tile
        compact="row"
        className="col-span-2 md:col-span-1"
        label="Snow level, next 72 h"
        value={wet.length ? (Math.max(...wet) - Math.min(...wet) < 100 ? fmt.elev(Math.min(...wet)) : fmt.elevRange(Math.min(...wet), Math.max(...wet))) : 'dry'}
        sub={<>{wet.length ? 'blend, while precipitating' : 'no precipitation expected'}<br />Rain at this elevation, 7 d: {fmt.water(rain7)}</>}
      />
    </div>
  );
}

function ProbCell({ pr, title }: { pr: number | null; title?: string }) {
  return (
    <td
      title={title}
      style={{
        background: pr == null ? undefined : `color-mix(in srgb, var(--snow-3) ${Math.round(pr * 70)}%, transparent)`,
        color: pr != null && pr > 0.55 ? 'var(--snow-ink-3)' : undefined,
      }}
    >
      {pr == null ? '—' : `${Math.round(pr * 100)}%`}
    </td>
  );
}

/** Labels that may wrap (index.css keeps table cells on one line), so every column fits a phone's width. */
const WRAP = { whiteSpace: 'normal' } as const;

/** Ensemble chances as a compact, shaded table (shade = probability). */
export function Chances({ ens, now, resort, fmt }: { ens?: EnsembleSet; now: number; resort: Resort; fmt: Fmt }) {
  if (!ens) return null;
  const thresholdsCm = CHANCE_THRESHOLDS_CM[fmt.units === 'imperial' ? 'imperial' : 'metric'];
  const horizons = CHANCE_HORIZONS_H;
  return (
    <Section
      title="Chance of snow totals"
      subtitle={`Share of ${ens.members.length} ensemble members (each forecast centre weighted equally) reaching each total from now. Model spread, not a verified probability.`}
    >
      <div className="overflow-x-auto">
        <table className="data">
          <thead>
            <tr><th>At least</th>{horizons.map((h) => <th key={h}>{h / 24} days</th>)}</tr>
          </thead>
          <tbody>
            {thresholdsCm.map((th) => (
              <tr key={th}>
                <td>{fmt.snow(th, 0)}</td>
                {horizons.map((h) => {
                  const ws = windowTotals(ens.time, ens.members, now, now + h * 3600);
                  return <ProbCell key={h} pr={probabilityAtLeast(ws, th)} title={`${ws.families.length} centres`} />;
                })}
              </tr>
            ))}
            {resort.bands.slice(1).map((b) => (
              <tr key={b.key}>
                <td style={WRAP}>Freezing level above {bandInText(b)} ({fmt.elev(b.elevation)})</td>
                {horizons.map((h) => {
                  const pr = probabilityFzlAbove(ens.time, ens.members, now, now + h * 3600, b.elevation);
                  return <td key={h}>{pr == null ? '—' : `${Math.round(pr * 100)}%`}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

/** Shade for a WPC category, on the same scale as the ensemble table's chances (each range's middle). */
const WPC_SHADE = [0.05, 0.25, 0.55, 0.85];
const wpcUnix = (iso: string) => Date.parse(iso.replace('Z', ':00Z')) / 1000;

function WpcCell({ c }: { c: WpcCategory | null }) {
  const pr = c == null ? null : WPC_SHADE[c];
  return (
    <td
      title={c == null ? "unknown: WPC's service didn't answer for this layer" : undefined}
      style={{
        background: pr == null || c === 0 ? undefined : `color-mix(in srgb, var(--snow-3) ${Math.round(pr * 70)}%, transparent)`,
        color: pr != null && pr > 0.55 ? 'var(--snow-ink-3)' : undefined,
      }}
    >
      {c == null ? '—' : WPC_CATEGORY_LABEL[c]}
    </td>
  );
}

/** "Thu 4 PM – Fri 4 PM" in the resort's time; wraps between the two ends on narrow screens. */
function WpcPeriodLabel({ d, tz }: { d: WpcPeriod | null; tz: string }) {
  if (!d) return <>period not published</>;
  const at = (iso: string) => localHourLabel(wpcUnix(iso), tz).replace(',', '');
  return (
    <>
      <span className="whitespace-nowrap">{at(d.start)} –</span> <span className="whitespace-nowrap">{at(d.end)}</span>
      {wpcUnix(d.end) <= nowUnix() ? ' (past)' : ''}
    </>
  );
}

/**
 * NOAA/NWS WPC's Day 1–3 chances of heavy snow at mid-mountain ("Compare with official guidance"). WPC days
 * are its own 24 h periods, labelled in local time, not the calendar days or windows of the ensemble table.
 */
export function WpcChances({ wpc, loading, error, resort, fmt }: {
  wpc: WpcFile | null | undefined; loading: boolean; error?: Error; resort: Resort; fmt: Fmt;
}) {
  const pt = wpc?.points[resort.id];
  const issued = wpc?.days.map((d) => d?.issued).filter((x): x is string => x != null).sort().at(-1);
  const issuedLabel = issued
    ? new Date(wpcUnix(issued) * 1000).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: resort.tz })
    : null;
  return (
    <Section
      title="WPC official chances"
      subtitle={
        <>
          <a className="underline" href={WPC_PAGE}>{WPC_ATTRIBUTION}</a> winter outlook at {bandInText(midBand(resort))} ({fmt.elev(midBand(resort).elevation)})
          {issuedLabel ? `, issued ${issuedLabel}` : ''}. Each WPC day is its own 24-hour period (local times below), not a calendar day,
          so it doesn't line up with the days or windows above. WPC publishes ranges, not exact chances.
        </>
      }
    >
      {error && <RequestError what="WPC" error={error} />}
      {!wpc || !pt ? (
        loading ? <Loading what="WPC chances" /> : !error && <Notice>WPC's chances aren't in this snapshot: the scheduled job couldn't reach NOAA's service, or this build has no snapshot.</Notice>
      ) : (
        <div className="overflow-x-auto">
          <table className="data">
            <thead>
              <tr>
                <th style={WRAP}>At least</th>
                {wpc.days.map((d, i) => (
                  <th key={i} style={{ whiteSpace: 'normal' }}>
                    Day {i + 1}
                    <div className="font-normal text-ink-3 text-[11px]"><WpcPeriodLabel d={d} tz={resort.tz} /></div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {WPC_THRESHOLDS_IN.map((inches, k) => (
                <tr key={inches}>
                  <td>{fmt.snow(inches * 2.54, 0)}</td>
                  {pt.cat.map((row, d) => <WpcCell key={d} c={row[k]} />)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

export interface RunChangeRow {
  id: string;
  init?: number;
  /** This run's and the earlier run's totals for the next 3 and 7 days. */
  c3: number | null;
  c7: number | null;
  p3: number | null;
  p7: number | null;
}

export interface RunChangeState {
  rows: RunChangeRow[];
  loading: boolean;
  error?: Error;
}

/**
 * How the latest run of each global model differs from its run 12 h earlier,
 * for the next 3 and 7 days at this band. Shared by the one-line summary and the table.
 */
export function useRunChange(
  data: BandForecast | undefined, meta: Record<string, RunMeta | null> | undefined, band: Band, resort: Resort, now: number,
): RunChangeState {
  const ids = data ? runChangeModels(data.models.map((m) => m.model.id)) : [];
  const prev = useAsync(() => loadRunChange(resort, band, ids, meta), [band.key, resort.id, meta != null, ids.join(',')], meta != null && data != null);
  const rows = ids.map((id) => {
    const cur = data!.models.find((m) => m.model.id === id)!;
    const old = prev.data?.[id] ?? null;
    const w = (m: DerivedHourly | null, h: number) => (m ? modelWindow(m, now, h) : null);
    return { id, init: meta?.[id]?.initUnix, c3: w(cur, 72), c7: w(cur, 168), p3: w(old, 72), p7: w(old, 168) };
  });
  return { rows, loading: !prev.data && !prev.error, error: prev.error };
}

const OFFSET_H = RUN_CHANGE_OFFSET_S / 3600;

function RunDelta({ a, b, fmt }: { a: number | null; b: number | null; fmt: Fmt }) {
  if (a == null || b == null) return <span className="text-ink-3">—</span>;
  const d = a - b;
  if (Math.abs(d) < 0.5) return <span className="text-ink-3">no change</span>;
  return <b className="text-ink">{d > 0 ? '▲ +' : '▼ −'}{fmt.snow(Math.abs(d))}</b>;
}

/** One line: each global model's 7-day change since its run 12 h earlier. */
export function RunChangeSummary({ rc, fmt, onShowTable }: { rc: RunChangeState; fmt: Fmt; onShowTable?: () => void }) {
  const rows = rc.rows.filter((r) => r.c7 != null && r.p7 != null);
  const body = rc.error ? (
    <span className="text-ink-3">{isNotInSnapshot(rc.error) ? NOT_IN_SNAPSHOT : 'previous runs unavailable'}</span>
  ) : rc.loading ? (
    <span className="text-ink-3">loading…</span>
  ) : !rows.length ? (
    <span className="text-ink-3">not available</span>
  ) : (
    <span>
      {rows.map((r, i) => (
        <Fragment key={r.id}>
          {i > 0 && ', '}
          <span className="whitespace-nowrap">{MODELS[r.id].label} <RunDelta a={r.c7} b={r.p7} fmt={fmt} /></span>
        </Fragment>
      ))}{' '}
      <span className="text-ink-3">(7 days)</span>
    </span>
  );
  return (
    <p
      className="text-sm text-ink-2 mt-3"
      title={`Each global model's latest run against its run ${OFFSET_H} hours earlier: change in its snowfall total for the next 7 days at this elevation. Big swings mean low confidence.`}
    >
      vs. runs {OFFSET_H} h earlier: {body}
      {onShowTable && rows.length > 0 && (
        <button type="button" className="ml-2 text-xs underline text-ink-2 hover:text-ink" onClick={onShowTable}>full table</button>
      )}
    </p>
  );
}

/** The full run-to-run table: latest run time, 3- and 7-day totals and their change. */
export function RunChangeTable({ rc, fmt }: { rc: RunChangeState; fmt: Fmt }) {
  const pending = rc.loading;
  return (
    <Section
      title="Change since the previous run"
      subtitle={`Each global model's latest run against its run ${OFFSET_H} hours earlier, for the same window from now. Big swings mean low confidence; the Run history tab shows the full sequence.`}
    >
      {rc.error && <RequestError what="Previous-run" error={rc.error} />}
      <div className="overflow-x-auto">
        <table className="data">
          <thead>
            <tr><th>Model</th><th>Latest run</th><th>Next 3 days</th><th>Δ 3 days</th><th>Next 7 days</th><th>Δ 7 days</th></tr>
          </thead>
          <tbody>
            {rc.rows.map((r) => (
              <tr key={r.id}>
                <td>{MODELS[r.id].label}</td>
                <td>{r.init ? runLabel(r.init) : '—'}</td>
                <td>{fmt.snow(r.c3)}</td>
                <td>{pending ? '…' : <RunDelta a={r.c3} b={r.p3} fmt={fmt} />}</td>
                <td>{fmt.snow(r.c7)}</td>
                <td>{pending ? '…' : <RunDelta a={r.c7} b={r.p7} fmt={fmt} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

/** A run that started more than this long ago is flagged stale. */
const STALE_RUN_H = 18;

/** "12Z–23Z" on one UTC day, "Nov 19 18Z – Nov 20 06Z" across two; a single run time when they all match. */
function runRange(inits: number[]): string {
  const lo = Math.min(...inits);
  const hi = Math.max(...inits);
  const hour = (u: number) => runLabel(u).split(' ').at(-1);
  if (lo === hi) return hour(lo)!;
  const day = (u: number) => new Date(u * 1000).toISOString().slice(0, 10);
  return day(lo) === day(hi) ? `${hour(lo)}–${hour(hi)}` : `${runLabel(lo)} – ${runLabel(hi)}`;
}

/** Whole hours since `unix`, as "<1" under an hour. */
const hoursOld = (now: number, unix: number) => (now - unix < 3600 ? '<1' : String(Math.round((now - unix) / 3600)));

/**
 * Model run times in one line: the range of run times, their ages and how many are stale
 * (started more than `STALE_RUN_H` ago). Each model's run sits behind the line's disclosure.
 */
export function RunsRow({ ids, meta }: { ids: string[]; meta?: Record<string, RunMeta | null> }) {
  if (!meta) return null;
  const now = Date.now() / 1000;
  const runs = ids.flatMap((id) => (meta[id] ? [{ id, m: meta[id] }] : []));
  if (!runs.length) return null;
  const inits = runs.map((r) => r.m.initUnix);
  const youngest = hoursOld(now, Math.max(...inits));
  const oldest = hoursOld(now, Math.min(...inits));
  const isStale = (m: RunMeta) => now - m.initUnix > STALE_RUN_H * 3600;
  const stale = runs.filter((r) => isStale(r.m)).length;
  return (
    <details className="group/runs text-[12px] text-ink-2 mt-2">
      <summary
        className="inline-flex flex-wrap items-baseline gap-x-1.5 rounded-sm hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        title={`Latest run of each model (start time in UTC) and how long ago it started. Runs that started more than ${STALE_RUN_H} h ago are flagged stale.`}
      >
        <span className="text-ink-3">Runs:</span>
        <span>{runRange(inits)}</span>
        <span aria-hidden className="text-ink-3">·</span>
        <span>{youngest === oldest ? youngest : `${youngest}–${oldest}`} h old</span>
        {stale > 0 && (
          <>
            <span aria-hidden className="text-ink-3">·</span>
            <b>⚠ {stale === runs.length && stale > 1 ? `all ${stale}` : stale} stale</b>
          </>
        )}
        <span aria-hidden className="text-ink-3">·</span>
        <span className="text-ink-3 underline decoration-dotted underline-offset-2">
          by model{' '}
          <span aria-hidden className="inline-block transition-transform group-open/runs:rotate-90 motion-reduce:transition-none">▸</span>
        </span>
      </summary>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1" aria-label="Model run times">
        {runs.map(({ id, m }) => (
          <span key={id} title={`published ${ago(m.availableUnix)}`}>
            {MODELS[id]?.label ?? id} {runLabel(m.initUnix).split(' ').at(-1)}
            <span className="text-ink-3"> ({ago(m.initUnix).replace(' ago', '')})</span>
            {isStale(m) && <b> ⚠ stale</b>}
          </span>
        ))}
      </div>
    </details>
  );
}
