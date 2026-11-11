'use client';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';

type CalEvent = { id: string; name: string; client: string | null; venue: string | null; start: string; end: string; status: string; draft: boolean };
type CalDay = { event_id: string; day: string; first: string; last: string; shifts: number; slots: number; confirmed: number; waiting: number; planned: number };

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const t = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(':00', '').replace(' ', '').toLowerCase();
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** good: every seat confirmed · warn: some crew · bad: shifts but nobody yet · plain: no shifts on that day */
function tone(d: CalDay | undefined) {
  if (!d || !d.slots) return '';
  if (d.confirmed >= d.slots) return 'good';
  if (d.confirmed + d.waiting + d.planned > 0) return 'warn';
  return 'bad';
}

/**
 * Events by day with how fully staffed each day is (Events › Calendar). The Schedule page is the shift-by-shift view;
 * this is the "what's on and are we covered" view.
 */
export default function EventCalendar({ query }: { query: string }) {
  const [range, setRange] = useState<'month' | 'week'>(() => {
    try { return (localStorage.getItem('evcal-range') as 'month' | 'week') || 'month'; } catch { return 'month'; }
  });
  const [anchor, setAnchor] = useState(() => new Date());
  const [data, setData] = useState<{ events: CalEvent[]; days: CalDay[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [openDay, setOpenDay] = useState<string | null>(null);

  // Grid: whole weeks (Sunday first) covering the month, or the anchor's week.
  const { start, count } = useMemo(() => {
    if (range === 'week') return { start: addDays(anchor, -anchor.getDay()), count: 7 };
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const s = addDays(first, -first.getDay());
    const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
    return { start: s, count: Math.ceil((last.getDate() + first.getDay()) / 7) * 7 };
  }, [anchor, range]);
  const days = useMemo(() => Array.from({ length: count }, (_, i) => addDays(start, i)), [start, count]);
  const from = ymd(days[0]), to = ymd(days[days.length - 1]);

  useEffect(() => {
    setLoading(true);
    setErr('');
    api<{ events: CalEvent[]; days: CalDay[] }>(`/api/events/calendar?from=${from}&to=${to}`)
      .then(setData)
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  }, [from, to]);
  useEffect(() => { try { localStorage.setItem('evcal-range', range); } catch { /* private mode */ } }, [range]);

  const needle = query.trim().toLowerCase();
  const events = (data?.events ?? []).filter((e) => !needle || [e.name, e.client, e.venue].some((x) => x?.toLowerCase().includes(needle)));
  const dayInfo = new Map((data?.days ?? []).map((d) => [`${d.event_id}|${d.day}`, d]));
  const todayKey = ymd(new Date());
  const step = (n: number) => setAnchor(range === 'week' ? addDays(anchor, n * 7) : new Date(anchor.getFullYear(), anchor.getMonth() + n, 1));
  const label = range === 'week'
    ? `${days[0].toLocaleDateString([], { month: 'short', day: 'numeric' })} – ${days[6].toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}`
    : anchor.toLocaleDateString([], { month: 'long', year: 'numeric' });
  const MAX = range === 'week' ? 20 : 3;

  // Totals for the visible period: the days still short of crew.
  const visible = new Set(days.map(ymd));
  const short = (data?.days ?? []).filter((d) => visible.has(d.day) && d.day >= todayKey && d.slots > d.confirmed && events.some((e) => e.id === d.event_id));

  return (
    <div className="evcal">
      <div className="cal-bar">
        <div className="seg" role="tablist" aria-label="Range">
          <button role="tab" aria-selected={range === 'month'} className={range === 'month' ? 'active' : ''} onClick={() => setRange('month')}>Month</button>
          <button role="tab" aria-selected={range === 'week'} className={range === 'week' ? 'active' : ''} onClick={() => setRange('week')}>Week</button>
        </div>
        <div className="row" style={{ gap: 6 }}>
          <button className="btn small" onClick={() => step(-1)} aria-label="Previous">‹</button>
          <b style={{ minWidth: 170, textAlign: 'center' }}>{label}</b>
          <button className="btn small" onClick={() => step(1)} aria-label="Next">›</button>
          <button className="btn ghost small" onClick={() => setAnchor(new Date())}>Today</button>
        </div>
        <span className="legend" aria-label="Staffing colours">
          <span className="d good" /> Fully confirmed <span className="d warn" /> Partly <span className="d bad" /> No crew yet
        </span>
      </div>
      {err && <p className="error small">{err}</p>}
      {short.length > 0 && (
        <p className="small muted" style={{ margin: '0 0 8px' }}>
          {short.length} event day{short.length === 1 ? '' : 's'} ahead still need crew ({short.reduce((n, d) => n + d.slots - d.confirmed, 0)} spots not confirmed).
        </p>
      )}
      <div className="cal-head">{DOW.map((d) => <span key={d}>{d}</span>)}</div>
      <div className={`cal-grid ${range === 'week' ? 'week' : ''} ${loading ? 'loading' : ''}`}>
        {days.map((d) => {
          const key = ymd(d);
          const list = events.filter((e) => e.start <= key && e.end >= key);
          const out = range === 'month' && d.getMonth() !== anchor.getMonth();
          const shown = openDay === key ? list : list.slice(0, MAX);
          return (
            <div key={key} className={`cal-cell ${key === todayKey ? 'today' : ''} ${out ? 'out' : ''} ${list.length ? '' : 'no-ev'}`}>
              <div className="cal-cell-h">
                <b>{d.getDate()}</b>
                <small className="evcal-dow">{d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</small>
              </div>
              {shown.map((e) => {
                const info = dayInfo.get(`${e.id}|${key}`);
                const tn = tone(info);
                const w = (n: number) => `${info?.slots ? Math.min(100, (n / info.slots) * 100) : 0}%`;
                return (
                  <Link key={e.id} href={`/events/${e.id}`} className={`ev-card evcal-card ${tn || 'plain'}`}
                    title={`${e.name}${e.venue ? ` · ${e.venue}` : ''}${info?.slots ? ` · ${info.confirmed}/${info.slots} confirmed${info.waiting ? `, ${info.waiting} waiting` : ''}${info.planned ? `, ${info.planned} not sent` : ''}` : ' · no shifts this day'}`}>
                    <b>{e.name}</b>
                    {info?.slots ? (
                      <>
                        <span>{t(info.first)}–{t(info.last)}{range === 'week' && e.venue ? ` · ${e.venue}` : ''}</span>
                        <span className="evcal-row">
                          <span className="stack-bar evcal-bar" aria-hidden="true"><i className="sb-conf" style={{ width: w(info.confirmed) }} /><i className="sb-wait" style={{ width: w(info.waiting) }} /><i className="sb-plan" style={{ width: w(info.planned) }} /></span>
                          <em className="evcal-count">{info.confirmed}/{info.slots}</em>
                        </span>
                        {(info.waiting > 0 || info.planned > 0 || e.draft) && (
                          <span className="evcal-sub">{[info.waiting && `${info.waiting} waiting`, info.planned && `${info.planned} not sent`, e.draft && !info.planned && 'building quietly'].filter(Boolean).join(' · ')}</span>
                        )}
                      </>
                    ) : (
                      <span>{e.venue ?? 'No shifts this day'}</span>
                    )}
                  </Link>
                );
              })}
              {list.length > MAX && openDay !== key && (
                <button type="button" className="btn ghost small evcal-more" onClick={() => setOpenDay(key)}>+{list.length - MAX} more</button>
              )}
              {openDay === key && list.length > MAX && (
                <button type="button" className="btn ghost small evcal-more" onClick={() => setOpenDay(null)}>Show less</button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
