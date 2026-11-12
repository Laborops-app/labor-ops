'use client';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import Shell, { initials } from '@/components/Shell';
import { Banner, Empty } from '@/components/ui';
import SeatBar, { SeatLegend } from '@/components/SeatBar';
import { api, fmtDate, fmtTime } from '@/lib/api';

type Up = {
  id: string;
  role_name: string;
  starts_at: string;
  ends_at: string;
  headcount: number;
  event_id: string;
  event_name: string;
  venue: string | null;
  filled: number;
  confirmed?: number;
  crew: string[];
};
type Dash = {
  crewCount: number;
  upcomingShifts: number;
  openSlots: number;
  pendingApprovals: number;
  pendingRequests: number;
  hoursScheduled: number;
  staffing?: { slots: number; confirmed: number; waiting: number; planned: number; open: number };
  upcoming: Up[];
  clockedIn: { name: string; clock_in: string; role_name: string; event_name: string }[];
};
type Ev = { id: string; name: string; venue: string | null; start_date: string; end_date: string; shift_count: number; slots: number; accepted: number; confirmed?: number; waiting?: number; planned?: number; open?: number };

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

function shiftBadge(s: Up): { label: string; tone: string } {
  const now = Date.now();
  const st = new Date(s.starts_at).getTime();
  const en = new Date(s.ends_at).getTime();
  if (st <= now && en > now) return { label: 'Live', tone: 'good' };
  const open = s.headcount - s.filled;
  if (open > 0) return { label: `${open} open`, tone: 'bad' };
  const h = (st - now) / 3600000;
  if (h < 24) return { label: `In ${Math.max(1, Math.round(h))}h`, tone: 'warn' };
  return { label: 'Filled', tone: 'good' };
}

function Avatars({ names, extra }: { names: string[]; extra: number }) {
  return (
    <div className="avatars" aria-label={names.join(', ')}>
      {names.slice(0, 3).map((n, i) => (
        <span key={n} className={`avatar t${i % 4}`} title={n}>
          {initials(n)}
        </span>
      ))}
      {extra > 0 && <span className="avatar">+{extra}</span>}
    </div>
  );
}

function Body({ name }: { name: string }) {
  const [d, setD] = useState<Dash | null>(null);
  const [events, setEvents] = useState<Ev[]>([]);
  const [error, setError] = useState('');
  const [day, setDay] = useState(() => new Date());

  useEffect(() => {
    const load = () => {
      api<Dash>('/api/dashboard').then(setD).catch((e) => setError(e.message));
      api<{ events: Ev[] }>('/api/events').then((r) => setEvents(r.events)).catch(() => {});
    };
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);

  const week = useMemo(() => {
    const t = new Date();
    t.setHours(0, 0, 0, 0);
    const start = new Date(t);
    start.setDate(t.getDate() - t.getDay());
    return Array.from({ length: 7 }, (_, i) => {
      const x = new Date(start);
      x.setDate(start.getDate() + i);
      return x;
    });
  }, []);

  const first = name.split(' ')[0];
  const todayCount = d ? d.upcoming.filter((s) => sameDay(new Date(s.starts_at), new Date())).length : 0;

  const dayShifts = d ? d.upcoming.filter((s) => sameDay(new Date(s.starts_at), day)) : [];
  const evHours = dayShifts.map((s) => new Date(s.starts_at).getHours());
  const hFrom = Math.max(0, Math.min(8, ...evHours.map((h) => h - 1)));
  const hTo = Math.min(23, Math.max(17, ...evHours.map((h) => h + 1)));
  const hours = Array.from({ length: hTo - hFrom + 1 }, (_, i) => i + hFrom);
  const label = (h: number) => `${((h + 11) % 12) + 1} ${h < 12 ? 'AM' : 'PM'}`;
  const tone = (s: Up) => shiftBadge(s).tone;

  const st = d?.staffing ?? { slots: 0, confirmed: 0, waiting: 0, planned: 0, open: 0 };
  const stPct = st.slots ? Math.round((st.confirmed / st.slots) * 100) : 100;
  const today0 = new Date(); today0.setHours(0, 0, 0, 0);
  const dayWord = (iso: string) => {
    const x = new Date(iso); x.setHours(0, 0, 0, 0);
    const n = Math.round((x.getTime() - today0.getTime()) / 86400000);
    return n <= 0 ? 'Today' : n === 1 ? 'Tomorrow' : new Date(iso).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  };
  // Events still to come, soonest first; the ones with seats to fill lead.
  const coming = events
    .filter((e) => new Date(`${e.end_date.slice(0, 10)}T23:59:59`).getTime() >= today0.getTime())
    .sort((x, y) => x.start_date.localeCompare(y.start_date))
    .slice(0, 6);

  return (
    <>
      {error && <Banner>{error}</Banner>}
      {!d ? (
        <div className="muted">Loading…</div>
      ) : (
        <div className="db">
          <header className="evh">
            <div className="evh-main">
              <div className="evh-chips">
                {d.pendingApprovals > 0 && <Link href="/timesheets" className="evh-chip todo">{d.pendingApprovals} timesheet{d.pendingApprovals === 1 ? '' : 's'} to approve</Link>}
                {d.pendingRequests > 0 && <Link href="/requests" className="evh-chip todo">{d.pendingRequests} request{d.pendingRequests === 1 ? '' : 's'} to answer</Link>}
                {d.clockedIn.length > 0 && <a href="#db-clock" className="evh-chip live">{d.clockedIn.length} on the clock</a>}
                {!d.pendingApprovals && !d.pendingRequests && !d.clockedIn.length && <span className="evh-chip quiet">Nothing is waiting on you</span>}
              </div>
              <h1>Welcome back, {first}</h1>
              <div className="sub">
                {todayCount ? `${todayCount} shift${todayCount === 1 ? '' : 's'} start today` : 'No shifts start today'}
                {st.open + st.planned > 0 ? ` · ${st.open + st.planned} seat${st.open + st.planned === 1 ? '' : 's'} still to fill` : st.slots ? ' · everything coming up is staffed' : ''}
              </div>
            </div>
            <Link href="/events" className="evh-staff db-staff" aria-label={`Staffing for everything coming up: ${st.confirmed} of ${st.slots} seats confirmed`}>
              <div className="evh-num">
                <b>{st.confirmed}</b>
                <span>/ {st.slots} confirmed</span>
                <em>{stPct}%</em>
              </div>
              <SeatBar confirmed={st.confirmed} waiting={st.waiting} planned={st.planned} open={st.open} big />
              <SeatLegend confirmed={st.confirmed} waiting={st.waiting} planned={st.planned} open={st.open} />
            </Link>
          </header>

          <div className="db-stats">
            <Link href="/schedule" className="db-stat">
              <span>Scheduled, next 7 days</span>
              <b>{Math.round(d.hoursScheduled).toLocaleString()}<small> hrs</small></b>
            </Link>
            <Link href="/events" className="db-stat">
              <span>Shifts coming up</span>
              <b>{d.upcomingShifts.toLocaleString()}</b>
            </Link>
            <Link href="/crew" className="db-stat">
              <span>Active crew</span>
              <b>{d.crewCount.toLocaleString()}</b>
            </Link>
            <Link href="/timesheets" className={`db-stat${d.pendingApprovals ? ' warn' : ''}`}>
              <span>Timesheets to approve</span>
              <b>{d.pendingApprovals.toLocaleString()}</b>
            </Link>
          </div>

          <div className="dash">
          <div className="dash-main">
            <section className="db-sec">
              <div className="db-sec-h">
                <h2>Next up</h2>
                <Link href="/schedule" className="evh-chip">Open the schedule</Link>
              </div>
              {d.upcoming.length === 0 ? (
                <Empty>No shifts coming up. Create an event to get started.</Empty>
              ) : (
                <div className="db-list">
                  {d.upcoming.slice(0, 6).map((s) => {
                    const b = shiftBadge(s);
                    const conf = Math.min(s.confirmed ?? 0, s.headcount);
                    const wait = Math.max(0, Math.min(s.filled, s.headcount) - conf);
                    const open = Math.max(0, s.headcount - conf - wait);
                    return (
                      <Link key={s.id} href={`/events/${s.event_id}`} className="db-shift">
                        <div className="db-when">
                          <small>{dayWord(s.starts_at)}</small>
                          <b>{fmtTime(s.starts_at)}</b>
                          <span>to {fmtTime(s.ends_at)}</span>
                        </div>
                        <div className="db-what">
                          <b>{s.role_name}</b>
                          <span>{s.event_name}{s.venue ? ` · ${s.venue}` : ''}</span>
                        </div>
                        <div className="db-seats">
                          <div className="db-seats-top">
                            <span><b>{conf}</b> / {s.headcount} confirmed</span>
                            <span className={`badge ${b.tone}`}>{b.label}</span>
                          </div>
                          <SeatBar confirmed={conf} waiting={wait} open={open} />
                          <div className="db-seats-sub">{[wait ? `${wait} waiting` : '', open ? `${open} open` : ''].filter(Boolean).join(' · ') || 'Fully confirmed'}</div>
                        </div>
                        <Avatars names={s.crew} extra={Math.max(0, s.filled - Math.min(3, s.crew.length))} />
                      </Link>
                    );
                  })}
                </div>
              )}
            </section>

            <section className="db-sec">
              <div className="db-sec-h">
                <h2>Events coming up</h2>
                <Link href="/events" className="evh-chip">All events</Link>
              </div>
              {coming.length === 0 ? (
                <Empty>No events coming up.</Empty>
              ) : (
                <div className="db-events">
                  {coming.map((e) => {
                    const conf = e.confirmed ?? e.accepted, wait = e.waiting ?? 0, plan = e.planned ?? 0;
                    const open = e.open ?? Math.max(0, e.slots - conf - wait - plan);
                    const done = e.slots > 0 && conf >= e.slots;
                    return (
                      <Link key={e.id} href={`/events/${e.id}`} className="db-event">
                        <div className="db-event-top">
                          <b>{e.name}</b>
                          <span className={`badge ${done ? 'good' : e.slots ? (open + plan > 0 ? 'bad' : 'warn') : ''}`}>{done ? 'Confirmed' : !e.slots ? 'No shifts' : open + plan > 0 ? `${open + plan} to fill` : `${wait} waiting`}</span>
                        </div>
                        <div className="db-event-sub">
                          {fmtDate(e.start_date)}{e.end_date !== e.start_date ? ` – ${fmtDate(e.end_date)}` : ''}{e.venue ? ` · ${e.venue}` : ''}
                        </div>
                        <SeatBar confirmed={conf} waiting={wait} planned={plan} open={open} />
                        <div className="db-seats-sub"><b>{conf}</b> / {e.slots} confirmed · {e.shift_count} shift{e.shift_count === 1 ? '' : 's'}</div>
                      </Link>
                    );
                  })}
                </div>
              )}
            </section>

            <section className="db-sec" id="db-clock">
              <div className="db-sec-h">
                <h2>On the clock now</h2>
                <Link href="/timesheets" className="evh-chip">Timesheets</Link>
              </div>
              {d.clockedIn.length === 0 ? (
                <Empty>Nobody is clocked in right now.</Empty>
              ) : (
                <div className="db-list">
                  {d.clockedIn.map((c, i) => (
                    <div key={i} className="db-clock">
                      <span className="avatar t1" aria-hidden="true">{initials(c.name)}</span>
                      <div className="db-what">
                        <b>{c.name}</b>
                        <span>{c.role_name} · {c.event_name}</span>
                      </div>
                      <span className="muted small">since {fmtTime(c.clock_in)}</span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>

          <aside aria-label="Calendar">
            <div className="cal db-cal">
              <div className="cal-h">
                <span>{day.toLocaleDateString([], { month: 'long', year: 'numeric' })}</span>
                <button className="btn outline sm" onClick={() => setDay(new Date())}>
                  Today
                </button>
              </div>
              <div className="cal-week">
                {week.map((w) => (
                  <button
                    key={w.toISOString()}
                    onClick={() => setDay(w)}
                    className={sameDay(w, new Date()) ? 'today' : ''}
                    style={{ background: 'none', border: 0, cursor: 'pointer', color: 'inherit', font: 'inherit', padding: 0, outline: sameDay(w, day) ? '2px solid var(--primary)' : 'none', borderRadius: 10 }}
                    aria-label={w.toDateString()}
                  >
                    <small>{w.toLocaleDateString([], { weekday: 'narrow' })}</small>
                    <span>{w.getDate()}</span>
                  </button>
                ))}
              </div>
              <div className="cal-day-label">
                {day.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })} · {dayShifts.length} shift{dayShifts.length === 1 ? '' : 's'}
              </div>
              <div className="cal-slots" style={{ maxHeight: 520, overflowY: 'auto' }}>
                {hours.map((h) => (
                  <div className="cal-row" key={h}>
                    <small>{label(h)}</small>
                    <div>
                      {dayShifts
                        .filter((s) => new Date(s.starts_at).getHours() === h)
                        .map((s) => (
                          <Link key={s.id} href={`/events/${s.event_id}`} className={`cal-ev ${tone(s) === 'bad' ? 'bad' : tone(s) === 'warn' ? 'warn' : tone(s) === 'good' ? 'good' : ''}`}>
                            <b>
                              {s.role_name} · {s.event_name}
                            </b>
                            <small>
                              {fmtTime(s.starts_at)} – {fmtTime(s.ends_at)}
                            </small>
                          </Link>
                        ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </aside>
          </div>
        </div>
      )}
    </>
  );
}

export default function Page() {
  return <Shell roles={['admin', 'manager']}>{(me) => <Body name={me.name} />}</Shell>;
}
