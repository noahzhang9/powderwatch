import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { RESORTS, resortById, type Resort } from '../config/resorts';
import { stationsFor } from '../config/stations';
import { RequestError } from '../components/ui';
import { useBandForecast, useDashboardEnsembles, type BandForecast, type EnsembleSet } from '../hooks/data';
import { useAsync, type AsyncState } from '../hooks/useAsync';
import { href } from '../hooks/useRoute';
import { NOT_IN_SNAPSHOT, SNAPSHOT_MAX_AGE_S, isNotInSnapshot } from '../lib/cache';
import { windowQuantiles, windowTotals } from '../lib/ensemble';
import { buildClimatology, percentileRank, seasonIndex } from '../lib/climatology';
import { dailyCentres, dailyPhase, drivenDays, lastValidTime, windowSum, type DailyRow, type DrivenDay } from '../lib/forecast';
import { latest, loadStation } from '../lib/obs';
import { useFmt, type Fmt } from '../lib/prefs';
import { isNum } from '../lib/stats';
import { snowClass } from '../lib/palette';
import { useSinceLastVisit, type VisitDelta } from '../lib/visits';
import { storageGet, storageSet } from '../lib/storage';
import { useNarrow } from '../hooks/useNarrow';
import { midBand } from '../lib/requests';
import { Delta } from './storm/Panels';
import { LOW_CENTRES } from './storm/Daily';
import { addDays, dayLabel, daysBetween, localMidnightUnix, nowUnix, shortDate, todayIn, weekday } from '../lib/time';

export function Dashboard() {
  const trips = useTrips();
  const hasTrips = trips.upcoming.length > 0;
  // A first trip saved below the cards appears above them: scroll there.
  const [moved, setMoved] = useState(false);
  return (
    <div className="pt-5">
      <h1 className="text-2xl font-semibold tracking-tight">Conditions & outlook</h1>
      <p className="text-sm text-ink-2 mt-1 max-w-3xl">
        Forecasts are a family-balanced blend of up to eight models at each resort's mid-mountain elevation, with their spread shown;
        7-day totals lead with the ensemble median. Snow depths come from nearby measurement stations and are compared against those stations' own history.
      </p>
      <WhereWhen />
      {hasTrips && <Trips state={trips} reveal={moved} />}
      <div className="grid lg:grid-cols-3 gap-4 mt-4">
        {RESORTS.map((r) => <ResortCard key={r.id} resort={r} />)}
      </div>
      {!hasTrips && <Trips state={trips} compact onAdded={() => setMoved(true)} />}
    </div>
  );
}

function usePrimaryStation(resort: Resort) {
  return useAsync(async () => {
    const today = todayIn(resort.tz);
    const stations = stationsFor(resort.id);
    const files = await Promise.all(stations.map((s) => loadStation(s.id)));
    // First station (in preference order) that reported in the last 3 days.
    let idx = files.findIndex((f) => f?.lastDepthDate && daysBetween(f.lastDepthDate, today) <= 3);
    if (idx < 0) idx = 0;
    const file = files[idx];
    if (!file) return null;
    const last = latest(file, 'depthCm');
    const clim = buildClimatology(file, 'depthCm', today);
    const k = last ? seasonIndex(last.date)?.k ?? null : null;
    return {
      station: stations[idx],
      file,
      last,
      clim,
      median: clim && k != null ? clim.p50[k] : null,
      pct: clim && k != null && last ? percentileRank(clim, k, last.value) : null,
    };
  }, [resort.id]);
}

function windowStats(data: BandForecast, from: number, hours: number) {
  const to = from + hours * 3600;
  const total = windowSum(data.blend.time, data.blend.snowCm, from, to);
  const per = data.models
    .filter((m) => (lastValidTime(m.time, m.precip) ?? 0) >= to - 3600)
    .map((m) => windowSum(m.time, m.snowCm, from, to))
    .filter(isNum);
  return { total, min: per.length > 1 ? Math.min(...per) : null, max: per.length > 1 ? Math.max(...per) : null };
}

/** The Where & when grid's days for a resort: today and the days after it, `nDays` in all. */
const gridDays = (data: BandForecast, today: string, nDays: number) => data.blendDaily.filter((d) => d.date >= today).slice(0, nDays);

/** The grid's ★ needs at least this much snow, cm. */
export const BEST_DAY_MIN_CM = 2.5;

/**
 * Index of the ★ best day among the grid's days, shared by the grid and the cards: the snowiest day that reaches
 * BEST_DAY_MIN_CM and whose total doesn't rest on one model (drivenDays, the Storm tracker's "outlier" flag).
 */
function bestDayIndex(days: DailyRow[], driven: Map<string, DrivenDay>): number | null {
  let best: number | null = null;
  for (let k = 0; k < days.length; k++) {
    const snow = days[k].snowCm ?? 0;
    if (snow < BEST_DAY_MIN_CM || driven.has(days[k].date)) continue;
    if (best == null || snow > (days[best].snowCm ?? 0)) best = k;
  }
  return best;
}

/** The days whose blend rests on one model, from the models and (when the snapshot has them) the ensembles. */
function useDrivenDays(resort: Resort, data: BandForecast | undefined, ens: EnsembleSet | undefined): Map<string, DrivenDay> {
  return useMemo(() => (data ? drivenDays(data, resort.tz, ens) : new Map<string, DrivenDay>()), [data, resort.tz, ens]);
}

function ResortCard({ resort }: { resort: Resort }) {
  const fmt = useFmt();
  const narrow = useNarrow();
  const fc = useBandForecast(resort, midBand(resort));
  const ens = useDashboardEnsembles(resort);
  const obs = usePrimaryStation(resort);
  const now = nowUnix();
  const data = fc.data;
  const today = todayIn(resort.tz);
  const nDays = narrow ? NARROW_GRID_DAYS : GRID_DAYS;
  const days = data ? gridDays(data, today, nDays) : [];
  const driven = useDrivenDays(resort, data, ens.data);
  const bi = bestDayIndex(days, driven);
  const best = bi == null ? null : days[bi];
  const o = obs.data;
  const thin = o?.clim && o.clim.seasons.length < 10;
  const gap = o ? midBand(resort).elevation - o.station.elevation : 0;
  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2">
        <h2 className="text-lg font-semibold"><a href={href('resort', resort.id)} className="hover:underline">{resort.name}</a></h2>
        <span className="text-xs text-ink-3 whitespace-nowrap">{resort.region}</span>
      </div>

      <div className="mt-3">
        <div className="text-[11px] uppercase tracking-wide text-ink-3">Snow depth (station)</div>
        {o?.last ? (
          <>
            <div className="flex items-baseline gap-3 flex-wrap">
              <span className="text-3xl font-semibold">{fmt.snow(o.last.value)}</span>
              <span className="text-sm text-ink-2">
                {o.median != null && o.median >= 1 ? `${Math.round((100 * o.last.value) / o.median)}% of median` : 'median ~0'}
                {thin ? ` · short record (${o.clim!.seasons.length} seasons)` : o.pct != null ? ` · ${Math.round(o.pct)}th pct` : ''}
              </span>
            </div>
            <div className="text-xs text-ink-2">
              {o.station.name}, {fmt.elev(o.station.elevation)}{Math.abs(gap) > 300 && <> · {fmt.elev(Math.abs(gap))} {gap > 0 ? 'below' : 'above'} mid-mountain</>} · {shortDate(o.last.date)}
            </div>
          </>
        ) : (
          <div className="text-sm text-ink-3" aria-live="polite">{obs.loading ? 'Loading…' : 'No recent station data'}</div>
        )}
      </div>

      <div className="mt-4" aria-live="polite">
        <div className="text-[11px] uppercase tracking-wide text-ink-3">Forecast snowfall, mid-mountain ({fmt.elev(midBand(resort).elevation)})</div>
        {fc.error ? (
          <RequestError what="Forecast" error={fc.error} retry={fc.retry} />
        ) : !data ? (
          <div className="text-sm text-ink-3 py-3">Loading models…</div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 mt-1">
              <BlendTotal resort={resort} data={data} now={now} hours={72} fmt={fmt} />
              <WeekTotal resort={resort} data={data} ens={ens} now={now} fmt={fmt} />
            </div>
            <div className="text-xs text-ink-2 mt-2">
              {best
                ? <>★ Best day: <b className="text-ink">{best.date === today ? 'today' : dayLabel(best.date)}</b>, {fmt.snow(best.snowCm)}</>
                : `No day with ${fmt.snow(BEST_DAY_MIN_CM, 1)} or more in the next ${nDays} days`}
            </div>
            <a href={href('resort', resort.id)} className="text-xs underline text-ink-2 mt-2 inline-block">Storm tracker →</a>
          </>
        )}
      </div>
    </div>
  );
}

/** One of a card's totals: value, what it is, its spread and the change since the last visit. */
function Total({ value, label, spread, delta, fmt, title }: {
  value: number | null; label: string; spread?: string | null; delta?: VisitDelta | null; fmt: Fmt; title?: string;
}) {
  return (
    <div title={title}>
      <div className="text-xl font-semibold">{fmt.snow(value)}</div>
      <div className="text-[11px] text-ink-3">{label}</div>
      {spread && <div className="text-[11px] text-ink-2 tnum">{spread}</div>}
      {delta && <div className="text-[11px]"><Delta d={delta} fmt={fmt} /></div>}
    </div>
  );
}

/** The blend's total over the next `hours`, with the range of the models that cover the window. */
function BlendTotal({ resort, data, now, hours, fmt, title }: { resort: Resort; data: BandForecast; now: number; hours: number; fmt: Fmt; title?: string }) {
  const s = windowStats(data, now, hours);
  const key = `${resort.id}:mid:${hours}`; // the Storm tracker's key for its blend total at mid
  const delta = useSinceLastVisit({ [key]: s.total })[key];
  return (
    <Total
      value={s.total}
      label={`${hours / 24} days · blend`}
      spread={s.min != null ? `models ${fmt.snowRange(s.min, s.max)}` : null}
      delta={delta}
      fmt={fmt}
      title={title}
    />
  );
}

/**
 * The next 7 days lead with the ensemble median and its 10–90% range, the Storm tracker's figure at mid.
 * The ensembles come from the snapshot alone (loadDashboardEnsembles); without a fresh copy the card shows
 * the blend, labelled as such.
 */
function WeekTotal({ resort, data, ens, now, fmt }: {
  resort: Resort; data: BandForecast; ens: AsyncState<EnsembleSet>; now: number; fmt: Fmt;
}) {
  const ws = ens.data?.members.length ? windowTotals(ens.data.time, ens.data.members, now, now + 168 * 3600) : null;
  const [p10, p50, p90] = ws ? windowQuantiles(ws, [0.1, 0.5, 0.9]) : [null, null, null];
  const key = `${resort.id}:mid:168:median`;
  const delta = useSinceLastVisit({ [key]: p50 })[key];
  if (!ens.data && !ens.error) return <Total value={null} label="7 days" spread="loading ensembles…" fmt={fmt} />;
  if (p50 == null) {
    const why = isNotInSnapshot(ens.error)
      ? `${NOT_IN_SNAPSHOT}: this is the multi-model blend.`
      : `The ensembles are read from the forecast snapshot only, and it has none under ${SNAPSHOT_MAX_AGE_S / 3600} hours old: this is the multi-model blend.`;
    return <BlendTotal resort={resort} data={data} now={now} hours={168} fmt={fmt} title={why} />;
  }
  return (
    <Total
      value={p50}
      label="7 days · ensemble median"
      spread={`10–90%: ${fmt.snowRange(p10, p90)}`}
      delta={delta}
      fmt={fmt}
    />
  );
}

/** Days the Where & when grid shows, on desktop and on phones. */
export const GRID_DAYS = 10;
export const NARROW_GRID_DAYS = 6;
/** Below this a grid cell shows "–" (none to speak of), cm. */
const TRACE_CM = 0.5;

/**
 * Where & when: every resort × the next 10 days on one shared scale, so the
 * best day and the best resort can be read off one grid.
 */
function WhereWhen() {
  const fmt = useFmt();
  const narrow = useNarrow();
  const nDays = narrow ? NARROW_GRID_DAYS : GRID_DAYS;
  return (
    <section className="card p-4 mt-4" aria-labelledby="ww-title">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="ww-title" className="text-base font-semibold">Where & when</h2>
        <span className="text-xs text-ink-2">
          {/* Items stay whole when the legend wraps on phones. */}
          {['Blended snowfall at mid-mountain', `–: under ${fmt.snow(TRACE_CM, 1)}`, '★ best day', `outlined: fewer than ${LOW_CENTRES} forecast centres`, 'R/M: rain or mixed at the summit']
            .map((item, i) => <Fragment key={item}>{i > 0 && ' · '}<span className="whitespace-nowrap">{item}</span></Fragment>)}
        </span>
      </div>
      <div className="overflow-x-auto mt-2">
        <table className="w-full text-[12px] border-separate" style={{ borderSpacing: 3 }}>
          <tbody>
            {RESORTS.map((r) => <WhereWhenRow key={r.id} resort={r} nDays={nDays} fmt={fmt} narrow={narrow} />)}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function WhereWhenRow({ resort, nDays, fmt, narrow }: { resort: Resort; nDays: number; fmt: Fmt; narrow: boolean }) {
  const summit = resort.bands.find((b) => b.key === 'summit')!;
  const fc = useBandForecast(resort, midBand(resort));
  const ens = useDashboardEnsembles(resort); // the card's request: read once, from the snapshot only
  const today = todayIn(resort.tz);
  const data = fc.data;
  const days = data ? gridDays(data, today, nDays) : [];
  const centres = data ? dailyCentres(data.models, resort.tz) : new Map<string, number>();
  const phases = data ? dailyPhase(data.blend, resort.tz, [summit.elevation]) : new Map();
  const driven = useDrivenDays(resort, data, ens.data);
  const best = bestDayIndex(days, driven);
  return (
    <tr>
      <th scope="row" className="text-left font-semibold pr-2 whitespace-nowrap">
        <a href={href('resort', resort.id)} className="hover:underline">{resort.short}</a>
      </th>
      {!data ? (
        <td colSpan={nDays} className="text-ink-3">{fc.error ? isNotInSnapshot(fc.error) ? NOT_IN_SNAPSHOT : <>Failed · <button type="button" className="underline" onClick={fc.retry}>retry</button></> : 'Loading…'}</td>
      ) : (
        days.map((d, i) => {
          const snow = d.snowCm ?? 0;
          const step = snowClass(snow) + 1;
          const low = (centres.get(d.date) ?? 0) < LOW_CENTRES;
          const ph = phases.get(d.date)?.[0];
          const filled = snow >= TRACE_CM && !low;
          return (
            <td
              key={d.date}
              title={`${resort.short} ${d.date}: ${fmt.snow(snow)}${ph && ph !== 'snow' && ph !== 'dry' ? ` (${ph} at summit)` : ''}${low ? ` — fewer than ${LOW_CENTRES} forecast centres` : ''}${driven.has(d.date) ? ' — outlier: this total rests on one model (see the Storm tracker)' : ''}`}
              className="text-center rounded-md tnum align-middle"
              style={{
                minWidth: narrow ? 36 : 56, height: 40,
                background: filled ? `var(--snow-${step})` : 'var(--surface-2)',
                color: filled ? `var(--snow-ink-${step})` : 'var(--ink-2)',
                border: low && snow >= TRACE_CM ? `1.5px solid var(--snow-${step})` : '1.5px solid transparent',
              }}
            >
              <div className="text-[10px] opacity-80">{i === 0 ? 'Today' : narrow ? weekday(d.date).slice(0, 2) : dayLabel(d.date)}</div>
              <div className="font-semibold">
                {snow >= TRACE_CM ? fmt.snow(snow).replace(/ (cm|in)$/, '') : '–'}
                {i === best && <span aria-label="best day"> ★</span>}
                {(ph === 'rain' || ph === 'mixed') && <span className="text-[10px]" aria-label={ph}> {ph === 'rain' ? 'R' : 'M'}</span>}
              </div>
            </td>
          );
        })
      )}
    </tr>
  );
}

// ---------------------------------------------------------------- trips

interface Trip {
  id: string;
  resortId: string;
  name: string;
  start: string;
  end: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Saved trips come from storage another page could have written: keep only well-formed entries. */
function isTrip(t: unknown): t is Trip {
  if (!t || typeof t !== 'object') return false;
  const x = t as Record<string, unknown>;
  return (
    typeof x.id === 'string' && x.id.length <= 64 &&
    typeof x.resortId === 'string' && resortById(x.resortId) != null &&
    typeof x.name === 'string' && x.name.length <= 60 &&
    typeof x.start === 'string' && ISO_DATE.test(x.start) &&
    typeof x.end === 'string' && ISO_DATE.test(x.end) && x.end >= x.start
  );
}

function loadTrips(): Trip[] {
  try {
    const parsed: unknown = JSON.parse(storageGet('pw-trips') ?? '[]');
    return Array.isArray(parsed) ? parsed.filter(isTrip).slice(0, 50) : [];
  } catch {
    return [];
  }
}

function useTrips() {
  const [trips, setTrips] = useState<Trip[]>(loadTrips);
  const save = (t: Trip[]) => {
    storageSet('pw-trips', JSON.stringify(t));
    setTrips(t);
  };
  const upcoming = trips.filter((t) => t.end >= todayIn(resortById(t.resortId)?.tz ?? 'UTC')).sort((a, b) => a.start.localeCompare(b.start));
  return { trips, upcoming, save };
}

type TripsState = ReturnType<typeof useTrips>;

/**
 * Upcoming trips, above the cards. With none, only a compact "+ Add trip" below them; the first trip saved
 * there moves the section up, so `reveal` scrolls to it and focuses its heading.
 */
function Trips({ state, compact = false, reveal = false, onAdded }: { state: TripsState; compact?: boolean; reveal?: boolean; onAdded?: () => void }) {
  const { trips, upcoming, save } = state;
  const [adding, setAdding] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!reveal || !heading.current) return;
    heading.current.scrollIntoView({ block: 'center' });
    heading.current.focus({ preventScroll: true });
  }, [reveal]);
  const add = (t: Trip) => {
    save([...trips, t]);
    setAdding(false);
    onAdded?.();
  };
  const toggle = <button type="button" className="chip" aria-expanded={adding} onClick={() => setAdding((a) => !a)}>{adding ? 'Cancel' : '+ Add trip'}</button>;
  if (compact) {
    return (
      <section className="mt-4" aria-label="Trips">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {toggle}
          {!adding && <span className="text-xs text-ink-3">Trips stay in this browser only.</span>}
        </div>
        {adding && <TripForm onAdd={add} />}
      </section>
    );
  }
  return (
    <section className="mt-4">
      <div className="flex items-center gap-3">
        <h2 ref={heading} tabIndex={-1} className="text-base font-semibold outline-none">Upcoming trips</h2>
        {toggle}
      </div>
      {adding && <TripForm onAdd={add} />}
      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-3 mt-2">
        {upcoming.map((t) => <TripCard key={t.id} trip={t} onRemove={() => save(trips.filter((x) => x.id !== t.id))} />)}
      </div>
    </section>
  );
}

function TripForm({ onAdd }: { onAdd: (t: Trip) => void }) {
  const [resortId, setResortId] = useState(RESORTS[0].id);
  const [name, setName] = useState('');
  const [start, setStart] = useState(addDays(todayIn('UTC'), 7));
  const [end, setEnd] = useState(addDays(todayIn('UTC'), 9));
  return (
    <form
      className="card p-3 mt-2 flex flex-wrap items-end gap-3 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        if (end < start) return;
        onAdd({ id: crypto.randomUUID(), resortId, name: name.trim() || `${resortById(resortId)!.short} trip`, start, end });
      }}
    >
      <label className="flex flex-col gap-1 text-ink-2">Resort
        <select className="field" value={resortId} onChange={(e) => setResortId(e.target.value)}>
          {RESORTS.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-ink-2">Name
        <input className="field" value={name} placeholder="e.g. Verbier ski camp" onChange={(e) => setName(e.target.value)} maxLength={60} />
      </label>
      <label className="flex flex-col gap-1 text-ink-2">From
        <input type="date" className="field" value={start} onChange={(e) => setStart(e.target.value)} required />
      </label>
      <label className="flex flex-col gap-1 text-ink-2">To
        <input type="date" className="field" value={end} min={start} onChange={(e) => setEnd(e.target.value)} required />
      </label>
      <button type="submit" className="chip" aria-pressed="true">Save trip</button>
    </form>
  );
}

function TripCard({ trip, onRemove }: { trip: Trip; onRemove: () => void }) {
  const fmt = useFmt();
  const resort = resortById(trip.resortId)!;
  const today = todayIn(resort.tz);
  const lead = daysBetween(today, trip.start);
  const inRange = lead <= 14;
  const fc = useBandForecast(resort, midBand(resort));
  const obs = usePrimaryStation(resort);
  return (
    <div className="card p-3">
      <div className="flex items-baseline justify-between gap-2">
        <a href={href('resort', resort.id)} className="font-semibold hover:underline">{trip.name}</a>
        <button type="button" className="text-xs text-ink-3 hover:text-ink" onClick={onRemove} aria-label={`Remove ${trip.name}`}>Remove</button>
      </div>
      <div className="text-xs text-ink-2">
        {resort.name} · {shortDate(trip.start)} – {shortDate(trip.end)} · {lead > 0 ? `in ${lead} days` : lead === 0 ? 'starts today' : 'under way'}
      </div>
      {inRange ? (
        <TripForecast trip={trip} resort={resort} data={fc.data} fmt={fmt} lead={lead} />
      ) : (
        <div className="text-xs text-ink-2 mt-2">
          Forecast detail from {shortDate(addDays(trip.start, -14))}.{' '}
          {obs.data?.clim && (() => {
            const k = seasonIndex(trip.start)?.k;
            const m = k != null ? obs.data.clim.p50[k] : null;
            return m != null ? <>Typical depth then at {obs.data.station.name}: <b>{fmt.snow(m)}</b> (median of {obs.data.clim.seasons.length} seasons).</> : null;
          })()}
        </div>
      )}
    </div>
  );
}

function TripForecast({ trip, resort, data, fmt, lead }: { trip: Trip; resort: Resort; data?: BandForecast; fmt: Fmt; lead: number }) {
  if (!data) return <div className="text-xs text-ink-3 mt-2">Loading forecast…</div>;
  // Fresh snow that matters for the trip: from 2 days before arrival to the last day.
  const from = Math.max(nowUnix(), localMidnightUnix(addDays(trip.start, -2), resort.tz));
  const to = localMidnightUnix(addDays(trip.end, 1), resort.tz);
  const total = windowSum(data.blend.time, data.blend.snowCm, from, to);
  const covered = (lastValidTime(data.blend.time, data.blend.precip) ?? 0) >= to - 3600;
  const confidence = lead <= 3 ? 'higher confidence' : lead <= 7 ? 'moderate confidence' : 'low confidence — watch trends';
  const sls = data.blend.time.map((t, i) => (t > from && t <= to && (data.blend.precip[i] ?? 0) >= 0.3 ? data.blend.snowLevel[i] : null)).filter(isNum);
  return (
    <div className="mt-2 text-sm">
      <div>
        <b className="text-lg">{fmt.snow(total)}</b>
        <span className="text-xs text-ink-2"> new snow from 2 days before arrival{covered ? '' : ' (forecast ends before the trip does)'}</span>
      </div>
      <div className="text-xs text-ink-2">
        {sls.length ? `Snow level ${fmt.elevRange(Math.min(...sls), Math.max(...sls))}` : 'Mostly dry'} · {confidence}
      </div>
    </div>
  );
}
