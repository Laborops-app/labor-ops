'use client';
import '@/app/(app)/schedule/schedule.css';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import Ic from '@/components/schedule/Ic';
import { addDays as addD, isoWeek, weekStart } from '@/lib/schedule';

type CalEvent = { id: string; name: string; client: string | null; venue: string | null; start: string; end: string; status: string; draft: boolean };
type CalDay = { event_id: string; day: string; first: string; last: string; shifts: number; slots: number; confirmed: number; waiting: number; planned: number };

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const t = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(':00', '').replace(' ', '').toLowerCase();
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

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
    if (range === 'week') return { start: weekStart(anchor), count: 7 };
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
    const s0 = weekStart(first);
    return { start: s0, count: Math.ceil((Math.round((+last - +s0) / 86400000) + 1) / 7) * 7 };
  }, [anchor, range]);
  const days = useMemo(() => Array.from({ length: count }, (_, i) => addD(start, i)), [start, count]);
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
  const isCurrent = range === 'week' ? +weekStart(new Date()) === +start : anchor.getMonth() === new Date().getMonth() && anchor.getFullYear() === new Date().getFullYear();
  const label = range === 'week' ? (isCurrent ? 'Current Week' : `Week ${isoWeek(start)}`) : anchor.toLocaleDateString([], { month: 'long', year: 'numeric' });
  const jump = (v: string) => (v === 'now' ? setAnchor(new Date()) : step(v === 'prev' ? -1 : 1));
  const MAX = range === 'week' ? 20 : 3;

  // Totals for the visible period: the days still short of crew.
  const visible = new Set(days.map(ymd));
  const short = (data?.days ?? []).filter((d) => visible.has(d.day) && d.day >= todayKey && d.slots > d.confirmed && events.some((e) => e.id === d.event_id));

  return (
    <div className="sx evcal-sx">
      <div className="sx-card">
        <div className="sx-main">
          <div className="sx-toolbar">
            <div className="sx-ctas">
              <span className="sx-legend" aria-label="Staffing colours">
                <span><i style={{ background: 'var(--st-good)' }} />Fully confirmed</span>
                <span><i style={{ background: 'var(--st-warn)' }} />Partly</span>
                <span><i style={{ background: 'var(--st-bad)' }} />No crew yet</span>
                <span><i style={{ background: 'var(--st-none)' }} />No shifts</span>
              </span>
              {short.length > 0 && (
                <span className="sx-legend">{short.length} event day{short.length === 1 ? '' : 's'} ahead need crew · {short.reduce((n, d) => n + d.slots - d.confirmed, 0)} spots open</span>
              )}
            </div>
            <div className="sx-ctas">
              <div className="sx-seg" role="tablist" aria-label="Range">
                <button role="tab" aria-selected={range === 'week'} onClick={() => setRange('week')}>Week</button>
                <button role="tab" aria-selected={range === 'month'} onClick={() => setRange('month')}>Month</button>
              </div>
              <div className="sx-nav">
                <button className="sx-btn sq" onClick={() => step(-1)} aria-label="Previous"><Ic n="caret-down-sm" className="flip" /></button>
                <span className="sx-btn" style={{ position: 'relative' }}>
                  {label}
                  <Ic n="caret-down-sm" />
                  <select className="sx-over" value="" onChange={(e) => jump(e.target.value)} aria-label="Jump to period">
                    <option value="" disabled>{label}</option>
                    <option value="prev">Previous {range}</option>
                    <option value="now">Current {range}</option>
                    <option value="next">Next {range}</option>
                  </select>
                </span>
                <button className="sx-btn sq" onClick={() => step(1)} aria-label="Next"><Ic n="caret-down-sm" className="flip-r" /></button>
              </div>
            </div>
          </div>
          {err && <div className="sx-error banner error" role="alert">{err}</div>}
          <div className="sx-scroll" style={{ opacity: loading ? 0.6 : 1 }}>
            <div className="sx-mhead" aria-hidden="true">{DOW.map((d) => <span key={d}>{d}</span>)}</div>
            <div className={`sx-mgrid ${range === 'week' ? 'evcal-week' : ''}`}>
              {days.map((d) => {
                const k = ymd(d);
                const list = events.filter((e) => e.start <= k && e.end >= k);
                const shown = openDay === k ? list : list.slice(0, MAX);
                const dayInfos = list.map((e) => dayInfo.get(`${e.id}|${k}`)).filter(Boolean) as CalDay[];
                const filled = dayInfos.reduce((n, x) => n + Math.min(x.confirmed, x.slots), 0), total = dayInfos.reduce((n, x) => n + x.slots, 0);
                return (
                  <div key={k} className={`sx-mcell ${k === todayKey ? 'today' : ''} ${range === 'month' && d.getMonth() !== anchor.getMonth() ? 'out' : ''} ${list.length ? '' : 'evcal-empty'}`}>
                    <div className="d">
                      {d.getDate()}
                      <span className="evcal-dow">{d.toLocaleDateString([], { weekday: 'short' })}</span>
                      {total > 0 && <small>{filled}/{total} confirmed</small>}
                    </div>
                    {shown.map((e) => {
                      const info = dayInfo.get(`${e.id}|${k}`);
                      const tn = tone(info) || 'none';
                      const w = (n: number) => `${info?.slots ? Math.min(100, (n / info.slots) * 100) : 0}%`;
                      return (
                        <Link key={e.id} href={`/events/${e.id}`} className={`sx-mev ${tn}`}
                          title={`${e.name}${e.venue ? ` · ${e.venue}` : ''}${info?.slots ? ` · ${info.confirmed}/${info.slots} confirmed${info.waiting ? `, ${info.waiting} waiting` : ''}${info.planned ? `, ${info.planned} not sent` : ''}` : ' · no shifts this day'}`}>
                          <b>{e.name}</b>
                          {info?.slots ? (
                            <>
                              <span>{t(info.first)} – {t(info.last)}{range === 'week' && e.venue ? ` · ${e.venue}` : ''}</span>
                              <span className="evcal-row">
                                <span className="stack-bar evcal-bar" aria-hidden="true"><i className="sb-conf" style={{ width: w(info.confirmed) }} /><i className="sb-wait" style={{ width: w(info.waiting) }} /><i className="sb-plan" style={{ width: w(info.planned) }} /></span>
                                <em className="evcal-count">{info.confirmed}/{info.slots}</em>
                              </span>
                              {(info.waiting > 0 || info.planned > 0 || e.draft) && (
                                <span>{[info.waiting && `${info.waiting} waiting`, info.planned && `${info.planned} not sent`, e.draft && !info.planned && 'building quietly'].filter(Boolean).join(' · ')}</span>
                              )}
                            </>
                          ) : (
                            <span>{e.venue ?? 'No shifts this day'}</span>
                          )}
                        </Link>
                      );
                    })}
                    {list.length > MAX && openDay !== k && <button className="sx-more" onClick={() => setOpenDay(k)}>+{list.length - MAX} more</button>}
                    {openDay === k && list.length > MAX && <button className="sx-more" onClick={() => setOpenDay(null)}>Show less</button>}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
