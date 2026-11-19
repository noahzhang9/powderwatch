import { useMemo, useState } from 'react';
import { RESORTS, resortById, type Resort } from '../config/resorts';
import { stationsFor } from '../config/stations';
import { Notice } from '../components/ui';
import { useBandForecast, type BandForecast } from '../hooks/data';
import { useAsync } from '../hooks/useAsync';
import { href } from '../hooks/useRoute';
import { buildClimatology, percentileRank, seasonIndex } from '../lib/climatology';
import { lastValidTime, windowSum } from '../lib/forecast';
import { latest, loadStation } from '../lib/obs';
import { measuresNewSnow, recentReports, sumOrNull } from '../lib/recent';
import { useFmt, type Fmt } from '../lib/prefs';
import { isNum } from '../lib/stats';
import { snowClass } from '../lib/palette';
import { dailyCentres, dailyPhase } from '../lib/forecast';
import { sinceLastVisit } from '../lib/visits';
import { useNarrow } from '../hooks/useNarrow';
import { midBand } from '../lib/requests';
import { Delta } from './storm/Panels';
import { LOW_CENTRES } from './storm/Daily';
import { addDays, dayLabel, daysBetween, localMidnightUnix, nowUnix, shortDate, todayIn, weekday } from '../lib/time';

export function Dashboard() {
  return (
    <div className="pt-5">
      <h1 className="text-2xl font-semibold tracking-tight">Conditions & outlook</h1>
      <p className="text-sm text-ink-2 mt-1 max-w-3xl">
        Forecasts are a family-balanced blend of up to eight models at each resort's mid-mountain elevation, with their spread shown.
        Snow depths come from nearby measurement stations and are compared against those stations' own history.
      </p>
      <WhereWhen />
      <Trips />
      <div className="grid lg:grid-cols-3 gap-4 mt-4">
        {RESORTS.map((r) => <ResortCard key={r.id} resort={r} />)}
      </div>
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
    const recent = recentReports(stations[idx], file, today, 7);
    const newSnow = measuresNewSnow(stations[idx], file);
    return {
      station: stations[idx],
      file,
      last,
      week: {
        newSnow,
        snowCm: sumOrNull(recent.map((d) => (newSnow ? d.newSnowCm : d.depthChangeCm))),
        sweMm: sumOrNull(recent.map((d) => d.sweChangeMm)),
      },
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

function agreement(total: number | null, min: number | null, max: number | null): string {
  if (total == null || min == null || max == null) return '';
  if (max < 5) return 'models agree: little snow';
  const r = (max - min) / Math.max(total, 5);
  return r < 0.6 ? 'models broadly agree' : r < 1.2 ? 'models disagree somewhat' : 'models disagree strongly';
}

function ResortCard({ resort }: { resort: Resort }) {
  const fmt = useFmt();
  const summit = resort.bands.find((b) => b.key === 'summit')!;
  const fc = useBandForecast(resort, midBand(resort));
  const obs = usePrimaryStation(resort);
  const now = nowUnix();
  const data = fc.data;
  const today = todayIn(resort.tz);

  const nextStorm = useMemo(() => {
    if (!data) return null;
    const th = fmt.units === 'imperial' ? 4 * 2.54 : 10;
    return data.blendDaily.find((d) => d.date >= today && (d.snowCm ?? 0) >= th) ?? null;
  }, [data, today, fmt.units]);

  const sl = useMemo(() => {
    if (!data) return null;
    const vals = data.blend.time
      .map((t, i) => (t > now && t <= now + 72 * 3600 && (data.blend.precip[i] ?? 0) >= 0.3 ? data.blend.snowLevel[i] : null))
      .filter(isNum);
    return vals.length ? [Math.min(...vals), Math.max(...vals)] : null;
  }, [data, now]);

  const w7 = data ? windowStats(data, now, 168) : null;
  const o = obs.data;
  const thin = o?.clim && o.clim.seasons.length < 10;
  const gap = o ? midBand(resort).elevation - o.station.elevation : 0;
  return (
    <div className="card p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold"><a href={href('resort', resort.id)} className="hover:underline">{resort.name}</a></h2>
        <span className="text-xs text-ink-3">{resort.region}</span>
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
            {o.week.snowCm != null && (
              <div className="text-xs text-ink-2 mt-1">
                Last 7 days:{' '}
                {o.week.newSnow
                  ? <><b>{fmt.snow(o.week.snowCm)}</b> new snow measured</>
                  : <>depth {o.week.snowCm >= 0 ? '+' : '−'}{fmt.snow(Math.abs(o.week.snowCm))}{o.week.sweMm != null && <>, water {o.week.sweMm >= 0 ? '+' : '−'}{fmt.water(Math.abs(o.week.sweMm))}</>}</>}
              </div>
            )}
          </>
        ) : (
          <div className="text-sm text-ink-3" aria-live="polite">{obs.loading ? 'Loading…' : 'No recent station data'}</div>
        )}
      </div>

      <div className="mt-4" aria-live="polite">
        <div className="text-[11px] uppercase tracking-wide text-ink-3">Forecast snowfall, mid-mountain ({fmt.elev(midBand(resort).elevation)})</div>
        {fc.error ? (
          <Notice tone="error">
            {fc.error.message} <button type="button" className="btn ml-2" onClick={fc.retry}>Retry</button>
          </Notice>
        ) : !data ? (
          <div className="text-sm text-ink-3 py-3">Loading models…</div>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2 mt-1">
              {[72, 168, 240].map((h) => {
                const s = windowStats(data, now, h);
                const d = h <= 168 ? sinceLastVisit(`${resort.id}:mid:${h}`, s.total) : null;
                return (
                  <div key={h}>
                    <div className="text-xl font-semibold">{fmt.snow(s.total)}</div>
                    <div className="text-[11px] text-ink-3">{h / 24} days</div>
                    {s.min != null && <div className="text-[11px] text-ink-2 tnum">models {fmt.snowRange(s.min, s.max)}</div>}
                    {d && <div className="text-[11px]"><Delta d={d} fmt={fmt} /></div>}
                  </div>
                );
              })}
            </div>
            <WeekBars data={data} tz={resort.tz} fmt={fmt} />
            <div className="text-xs text-ink-2 mt-2">
              {w7 && `7-day: ${agreement(w7.total, w7.min, w7.max)}`}
              {nextStorm ? ` · next big day: ${nextStorm.date === today ? 'today' : dayLabel(nextStorm.date)} (${fmt.snow(nextStorm.snowCm)})` : ''}
            </div>
            <div className="text-xs text-ink-2 mt-1">
              {sl ? <>Snow level next 72 h: {fmt.elevRange(sl[0], sl[1])}</> : 'Snow level: dry next 72 h'}
              {sl && sl[1] > summit.elevation - 100 && <span> · <b>⚠ rain risk up high</b></span>}
            </div>
            <a href={href('resort', resort.id)} className="text-xs underline text-ink-2 mt-2 inline-block">Storm tracker →</a>
          </>
        )}
      </div>
    </div>
  );
}

/** Fixed scale shared by every card so bar heights compare across resorts. */
const WEEK_SCALE_CM = 30;

/** Compact 7-day blend: bar height and shade by snow amount, value underneath, rain flagged. */
function WeekBars({ data, tz, fmt }: { data: BandForecast; tz: string; fmt: Fmt }) {
  const today = todayIn(tz);
  const days = data.blendDaily.filter((d) => d.date >= today).slice(0, 7);
  const centres = dailyCentres(data.models, tz);
  return (
    <div className="grid grid-cols-7 gap-1 mt-3" role="list" aria-label="Next 7 days, blended snowfall">
      {days.map((d) => {
        const snow = d.snowCm ?? 0;
        const rain = d.rainMm ?? 0;
        const step = snowClass(snow) + 1;
        const low = (centres.get(d.date) ?? 0) < LOW_CENTRES;
        return (
          <div key={d.date} role="listitem" className="flex flex-col items-center" title={`${d.date}: ${fmt.snow(snow)} snow${rain >= 1 ? `, ${fmt.water(rain)} rain` : ''}${low ? ' (fewer than 3 forecast centres)' : ''}`}>
            <div className="h-12 w-full flex items-end justify-center">
              <div
                style={{
                  height: `${Math.min(100, Math.max(snow >= 0.5 ? 6 : 0, (snow / WEEK_SCALE_CM) * 100))}%`,
                  background: low ? 'transparent' : `var(--snow-${step})`,
                  border: low ? `1.5px solid var(--snow-${step})` : undefined,
                }}
                className="w-3/5 rounded-t"
              />
            </div>
            <div className={`text-[11px] tnum mt-0.5 ${snow >= 0.5 ? 'font-semibold text-ink' : 'text-ink-3'}`}>{snow >= 0.5 ? fmt.snow(snow).replace(/ (cm|in)$/, '') : '–'}</div>
            <div className="text-[11px] text-ink-3">{d.date === today ? 'Today' : weekday(d.date)}</div>
            {rain >= 1 && (
              <div className="text-[10px] text-ink-2 flex items-center gap-0.5">
                <span aria-hidden style={{ width: 6, height: 6, borderRadius: 3, background: 'var(--rain)' }} />
                {fmt.water(rain).replace(/ (mm|in)$/, '')}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Where & when: every resort × the next 10 days on one shared scale, so the
 * best day and the best resort can be read off one grid.
 */
function WhereWhen() {
  const fmt = useFmt();
  const narrow = useNarrow();
  const nDays = narrow ? 6 : 10;
  return (
    <section className="card p-4 mt-4" aria-labelledby="ww-title">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="ww-title" className="text-base font-semibold">Where & when</h2>
        <span className="text-xs text-ink-2">Blended snowfall at mid-mountain · ★ best day · outlined: fewer than 3 forecast centres · R/M: rain or mixed at the summit</span>
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
  const today = todayIn(resort.tz);
  const data = fc.data;
  const days = data ? data.blendDaily.filter((d) => d.date >= today).slice(0, nDays) : [];
  const centres = data ? dailyCentres(data.models, resort.tz) : new Map<string, number>();
  const phases = data ? dailyPhase(data.blend, resort.tz, [summit.elevation]) : new Map();
  const best = days.reduce((bi, d, i) => ((d.snowCm ?? 0) > (days[bi]?.snowCm ?? 0) ? i : bi), 0);
  return (
    <tr>
      <th scope="row" className="text-left font-semibold pr-2 whitespace-nowrap">
        <a href={href('resort', resort.id)} className="hover:underline">{resort.short}</a>
      </th>
      {!data ? (
        <td colSpan={nDays} className="text-ink-3">{fc.error ? <>Failed · <button type="button" className="underline" onClick={fc.retry}>retry</button></> : 'Loading…'}</td>
      ) : (
        days.map((d, i) => {
          const snow = d.snowCm ?? 0;
          const step = snowClass(snow) + 1;
          const low = (centres.get(d.date) ?? 0) < LOW_CENTRES;
          const ph = phases.get(d.date)?.[0];
          const filled = snow >= 0.5 && !low;
          return (
            <td
              key={d.date}
              title={`${resort.short} ${d.date}: ${fmt.snow(snow)}${ph && ph !== 'snow' && ph !== 'dry' ? ` (${ph} at summit)` : ''}${low ? ' — fewer than 3 forecast centres' : ''}`}
              className="text-center rounded-md tnum align-middle"
              style={{
                minWidth: narrow ? 36 : 56, height: 40,
                background: filled ? `var(--snow-${step})` : 'var(--surface-2)',
                color: filled ? `var(--snow-ink-${step})` : 'var(--ink-2)',
                border: low && snow >= 0.5 ? `1.5px solid var(--snow-${step})` : '1.5px solid transparent',
              }}
            >
              <div className="text-[10px] opacity-80">{i === 0 ? 'Today' : narrow ? weekday(d.date).slice(0, 2) : dayLabel(d.date)}</div>
              <div className="font-semibold">
                {snow >= 0.5 ? fmt.snow(snow).replace(/ (cm|in)$/, '') : '–'}
                {i === best && snow >= 2.5 && <span aria-label="best day"> ★</span>}
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
    const parsed: unknown = JSON.parse(localStorage.getItem('pw-trips') ?? '[]');
    return Array.isArray(parsed) ? parsed.filter(isTrip).slice(0, 50) : [];
  } catch {
    return [];
  }
}

function Trips() {
  const [trips, setTrips] = useState<Trip[]>(loadTrips);
  const [adding, setAdding] = useState(false);
  const save = (t: Trip[]) => {
    localStorage.setItem('pw-trips', JSON.stringify(t));
    setTrips(t);
  };
  const upcoming = trips.filter((t) => t.end >= todayIn(resortById(t.resortId)?.tz ?? 'UTC')).sort((a, b) => a.start.localeCompare(b.start));
  return (
    <section className="mt-4">
      <div className="flex items-center gap-3">
        <h2 className="text-base font-semibold">Upcoming trips</h2>
        <button type="button" className="chip" onClick={() => setAdding((a) => !a)}>{adding ? 'Cancel' : '+ Add trip'}</button>
      </div>
      {adding && <TripForm onAdd={(t) => { save([...trips, t]); setAdding(false); }} />}
      {upcoming.length === 0 && !adding && <div className="text-sm text-ink-3 mt-2">No trips saved. Trips stay in this browser only.</div>}
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
