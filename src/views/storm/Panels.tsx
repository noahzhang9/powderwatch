/** Storm-tracker panels: headline totals, chances, run-to-run change and run times. */
import { MODELS } from '../../config/models';
import type { Band, Resort } from '../../config/resorts';
import { bandInText } from '../../config/resorts';
import { Notice, Section, Tile } from '../../components/ui';
import { loadRunChange, type BandForecast, type EnsembleSet } from '../../hooks/data';
import { useAsync } from '../../hooks/useAsync';
import { probabilityAtLeast, probabilityFzlAbove, windowQuantiles, windowTotals } from '../../lib/ensemble';
import { lastValidTime, windowSum, type DerivedHourly } from '../../lib/forecast';
import type { RunMeta } from '../../lib/openmeteo';
import type { Fmt } from '../../lib/prefs';
import { runChangeModels } from '../../lib/requests';
import { isNum } from '../../lib/stats';
import { ago, runLabel } from '../../lib/time';
import { sinceLastVisit } from '../../lib/visits';

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
 */
export function Totals({ data, now, ens, fmt, rawSnow, resort, band }: {
  data: BandForecast; now: number; ens?: EnsembleSet; fmt: Fmt; rawSnow: boolean; resort: Resort; band: Band;
}) {
  const key = rawSnow ? 'omSnowCm' : 'snowCm';
  const wet = data.blend.time
    .map((t, i) => (t > now && t <= now + 72 * 3600 && (data.blend.precip[i] ?? 0) >= 0.3 ? data.blend.snowLevel[i] : null))
    .filter(isNum);
  const rain7 = windowSum(data.blend.time, data.blend.rainMm, now, now + 168 * 3600);
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 mt-4">
      {WINDOWS.map((w) => {
        const blendTotal = windowSum(data.blend.time, data.blend[key], now, now + w.hours * 3600);
        const per = data.models.map((m) => modelWindow(m, now, w.hours, key)).filter(isNum);
        const lo = per.length >= 2 ? Math.min(...per) : null;
        const hi = per.length >= 2 ? Math.max(...per) : null;
        const range = lo == null ? 'one model reaches this far' : lo < 0.5 && hi! < 0.5 ? `all ${per.length} models: none` : `${per.length} models: ${fmt.snowRange(lo, hi)}`;
        const ws = ens && !rawSnow ? windowTotals(ens.time, ens.members, now, now + w.hours * 3600) : null;
        const [p10, p50, p90] = ws ? windowQuantiles(ws, [0.1, 0.5, 0.9]) : [null, null, null];
        const useEns = w.ensemble && p50 != null;
        const outside = blendTotal != null && lo != null && hi != null && (blendTotal < lo - 0.5 || blendTotal > hi + 0.5);
        const delta = w.hours === 72 || w.hours === 168 ? sinceLastVisit(`${resort.id}:${band.key}:${w.hours}`, blendTotal) : null;
        return (
          <Tile
            key={w.label}
            label={useEns ? `${w.label} · ensemble median` : w.label}
            value={fmt.snow(useEns ? p50 : blendTotal)}
            sub={
              <>
                {useEns ? <>10–90%: {fmt.snowRange(p10, p90)} · blend {fmt.snow(blendTotal)}</> : range}
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

/** Ensemble chances as a compact, shaded table (shade = probability). */
export function Chances({ ens, now, resort, fmt }: { ens?: EnsembleSet; now: number; resort: Resort; fmt: Fmt }) {
  if (!ens) return null;
  const thresholdsCm = fmt.units === 'imperial' ? [1, 4, 8, 12, 20].map((x) => x * 2.54) : [2.5, 10, 20, 30, 50];
  const horizons = [72, 168, 240];
  return (
    <Section
      title="Chance of snow totals"
      subtitle={`Share of ${ens.members.length} ensemble members (each forecast centre weighted equally) reaching each total from now. Model spread, not a verified probability.`}
    >
      <div className="overflow-x-auto">
        <table className="data [&_td:first-child]:whitespace-normal">
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
                <td>Freezing level above {bandInText(b)} ({fmt.elev(b.elevation)})</td>
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

/**
 * How the latest run of each global model differs from its run 12 h earlier,
 * for the next 3 and 7 days at this band.
 */
export function RunChange({ data, meta, band, resort, now, fmt }: {
  data: BandForecast; meta?: Record<string, RunMeta | null>; band: Band; resort: Resort; now: number; fmt: Fmt;
}) {
  const ids = runChangeModels(data.models.map((m) => m.model.id));
  const prev = useAsync(() => loadRunChange(resort, band, ids, meta), [band.key, resort.id, meta != null, ids.join(',')], meta != null);
  const rows = ids.map((id) => {
    const cur = data.models.find((m) => m.model.id === id)!;
    const old = prev.data?.[id] ?? null;
    const w = (m: DerivedHourly | null, h: number) => (m ? modelWindow(m, now, h) : null);
    return { id, init: meta?.[id]?.initUnix, c3: w(cur, 72), c7: w(cur, 168), p3: w(old, 72), p7: w(old, 168) };
  });
  const delta = (a: number | null, b: number | null) => {
    if (a == null || b == null) return <span className="text-ink-3">—</span>;
    const d = a - b;
    if (Math.abs(d) < 0.5) return <span className="text-ink-3">no change</span>;
    return <b>{d > 0 ? '▲ +' : '▼ −'}{fmt.snow(Math.abs(d))}</b>;
  };
  return (
    <Section
      title="Change since the previous run"
      subtitle="Each global model's latest run against its run 12 hours earlier, for the same window from now. Big swings mean low confidence; the Run history tab shows the full sequence."
    >
      {prev.error && <Notice tone="error">{prev.error.message}</Notice>}
      <div className="overflow-x-auto">
        <table className="data">
          <thead>
            <tr><th>Model</th><th>Latest run</th><th>Next 3 days</th><th>Δ 3 days</th><th>Next 7 days</th><th>Δ 7 days</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{MODELS[r.id].label}</td>
                <td>{r.init ? runLabel(r.init) : '—'}</td>
                <td>{fmt.snow(r.c3)}</td>
                <td>{prev.loading && !prev.data ? '…' : delta(r.c3, r.p3)}</td>
                <td>{fmt.snow(r.c7)}</td>
                <td>{prev.loading && !prev.data ? '…' : delta(r.c7, r.p7)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

/** Visible model run times; runs initialised more than 18 h ago are flagged. */
export function RunsRow({ ids, meta }: { ids: string[]; meta?: Record<string, RunMeta | null> }) {
  if (!meta) return null;
  const now = Date.now() / 1000;
  return (
    <div className="text-[12px] text-ink-2 mt-2 flex flex-wrap gap-x-3 gap-y-1" aria-label="Model run times">
      <span className="text-ink-3">Runs:</span>
      {ids.map((id) => {
        const m = meta[id];
        if (!m) return null;
        const stale = now - m.initUnix > 18 * 3600;
        return (
          <span key={id} title={`published ${ago(m.availableUnix)}`}>
            {MODELS[id]?.label ?? id} {runLabel(m.initUnix).split(' ').at(-1)}
            <span className="text-ink-3"> ({ago(m.initUnix).replace(' ago', '')})</span>
            {stale && <b> ⚠ stale</b>}
          </span>
        );
      })}
    </div>
  );
}
