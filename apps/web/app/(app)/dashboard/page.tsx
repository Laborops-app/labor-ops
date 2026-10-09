'use client';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import Shell, { initials } from '@/components/Shell';
import { Banner, Empty } from '@/components/ui';
import { api, fmtDate, fmtDateTime, fmtTime } from '@/lib/api';

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
  crew: string[];
};
type Dash = {
  crewCount: number;
  upcomingShifts: number;
  openSlots: number;
  pendingApprovals: number;
  hoursScheduled: number;
  upcoming: Up[];
  clockedIn: { name: string; clock_in: string; role_name: string; event_name: string }[];
};
type Ev = { id: string; name: string; venue: string | null; start_date: string; end_date: string; shift_count: number; slots: number; accepted: number };

const PIN = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 0 1 16 0Z" />
    <circle cx="12" cy="10" r="3" />
  </svg>
);
const CLOCK = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="10" />
    <path d="M12 6v6l4 2" />
  </svg>
);
const sectionIcon = (d: React.ReactNode) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {d}
  </svg>
);

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
const hrs = (a: string, b: string) => (new Date(b).getTime() - new Date(a).getTime()) / 3600000;
const fmtHM = (h: number) => `${Math.floor(h)}h ${String(Math.round((h % 1) * 60)).padStart(2, '0')}m`;

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
  const totalSlots = d ? d.upcoming.reduce((n, s) => n + s.headcount, 0) : 0;
  const filledSlots = d ? d.upcoming.reduce((n, s) => n + Math.min(s.filled, s.headcount), 0) : 0;
  const pct = totalSlots ? Math.round((filledSlots / totalSlots) * 100) : 100;

  const dayShifts = d ? d.upcoming.filter((s) => sameDay(new Date(s.starts_at), day)) : [];
  const evHours = dayShifts.map((s) => new Date(s.starts_at).getHours());
  const hFrom = Math.max(0, Math.min(8, ...evHours.map((h) => h - 1)));
  const hTo = Math.min(23, Math.max(17, ...evHours.map((h) => h + 1)));
  const hours = Array.from({ length: hTo - hFrom + 1 }, (_, i) => i + hFrom);
  const label = (h: number) => `${((h + 11) % 12) + 1} ${h < 12 ? 'AM' : 'PM'}`;
  const tone = (s: Up) => shiftBadge(s).tone;

  return (
    <>
      {error && <Banner>{error}</Banner>}
      {!d ? (
        <div className="muted">Loading…</div>
      ) : (
        <div className="dash">
          <div className="dash-main">
            <section className="hero">
              <div>
                <h1>Welcome back, {first}</h1>
                <p>
                  {todayCount ? `You have ${todayCount} shift${todayCount === 1 ? '' : 's'} starting today` : 'No shifts start today'}
                  {d.openSlots ? ` and ${d.openSlots} open slot${d.openSlots === 1 ? '' : 's'} to fill.` : ' and everything upcoming is staffed.'}
                </p>
                <ul>
                  {d.pendingApprovals > 0 && (
                    <li>
                      <Link href="/timesheets">
                        {d.pendingApprovals} timesheet{d.pendingApprovals === 1 ? ' is' : 's are'} waiting for approval
                      </Link>
                    </li>
                  )}
                  {d.openSlots > 0 && (
                    <li>
                      <Link href="/events">Assign crew to open slots</Link>
                    </li>
                  )}
                  {d.clockedIn.length > 0 && <li>{d.clockedIn.length} crew on the clock right now</li>}
                </ul>
              </div>
              <div className="ring-tile">
                <div>
                  <b>{pct}%</b>
                  <span>Upcoming slots staffed</span>
                </div>
                <div className="ring" style={{ ['--pct' as any]: pct }} role="img" aria-label={`${pct}% staffed`} />
              </div>
            </section>

            <div className="sec-h">
              <h2>{sectionIcon(<><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /></>)} Overview</h2>
            </div>
            <div className="stats">
              <Link href="/events" className="stat">
                <b>{fmtHM(d.hoursScheduled)}</b>
                <span>Scheduled next 7 days</span>
                <div className="bars" aria-hidden="true">
                  {d.upcoming.slice(0, 12).map((s) => (
                    <i key={s.id} style={{ height: `${Math.max(12, Math.min(100, hrs(s.starts_at, s.ends_at) * 9))}%` }} />
                  ))}
                </div>
              </Link>
              <Link href="/events" className="stat">
                <b>{d.upcomingShifts}</b>
                <span>Upcoming shifts</span>
                <div className="bars" aria-hidden="true">
                  {d.upcoming.slice(0, 12).map((s) => (
                    <i key={s.id} style={{ height: `${Math.max(12, (Math.min(s.filled, s.headcount) / s.headcount) * 100)}%` }} />
                  ))}
                </div>
              </Link>
              <Link href="/crew" className="stat">
                <b>{d.crewCount}</b>
                <span>Active crew</span>
              </Link>
              <Link href="/timesheets" className={`stat ${d.pendingApprovals ? 'warn' : ''}`}>
                <b>{d.pendingApprovals}</b>
                <span>Timesheets to approve</span>
              </Link>
            </div>

            <div className="sec-h">
              <h2>{sectionIcon(<><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></>)} Upcoming shifts</h2>
              <Link href="/events" className="btn outline sm">
                + Schedule shift
              </Link>
            </div>
            {d.upcoming.length === 0 ? (
              <Empty>No upcoming shifts. Create an event to get started.</Empty>
            ) : (
              <div className="cards3">
                {d.upcoming.slice(0, 3).map((s) => {
                  const b = shiftBadge(s);
                  return (
                    <Link key={s.id} href={`/events/${s.event_id}`} className="sc">
                      <div className="sc-top">
                        <b>{s.role_name}</b>
                        <span className={`badge ${b.tone}`}>{b.label}</span>
                      </div>
                      <div className="sub">
                        <span>{s.event_name}</span>
                        <span>
                          {fmtDateTime(s.starts_at)} – {fmtTime(s.ends_at)}
                        </span>
                      </div>
                      <div className="sc-foot">
                        <div className="meta">
                          {s.venue && (
                            <span>
                              {PIN} {s.venue}
                            </span>
                          )}
                          <span>
                            {CLOCK} {s.filled} of {s.headcount} filled · {fmtHM(hrs(s.starts_at, s.ends_at))}
                          </span>
                        </div>
                        <Avatars names={s.crew} extra={Math.max(0, s.filled - Math.min(3, s.crew.length))} />
                      </div>
                    </Link>
                  );
                })}
              </div>
            )}

            <div className="sec-h">
              <h2>{sectionIcon(<><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></>)} Events</h2>
              <Link href="/events" className="btn outline sm">
                + New event
              </Link>
            </div>
            {events.length === 0 ? (
              <Empty>No events yet.</Empty>
            ) : (
              <div className="cards3">
                {events.slice(0, 3).map((e) => {
                  const full = e.slots > 0 && e.accepted >= e.slots;
                  return (
                    <Link key={e.id} href={`/events/${e.id}`} className="sc">
                      <div className="sc-top">
                        <b>{e.name}</b>
                        <span className={`badge ${full ? 'good' : e.slots ? 'warn' : ''}`}>{full ? 'Full' : e.slots ? 'Needs crew' : 'No shifts'}</span>
                      </div>
                      <div className="sub">
                        <span>
                          {fmtDate(e.start_date)}
                          {e.end_date !== e.start_date ? ` – ${fmtDate(e.end_date)}` : ''}
                        </span>
                      </div>
                      <div className="meta">
                        {e.venue && (
                          <span>
                            {PIN} {e.venue}
                          </span>
                        )}
                        <span>
                          {CLOCK} {e.shift_count} shift{e.shift_count === 1 ? '' : 's'} · {e.accepted} / {e.slots} accepted
                        </span>
                      </div>
                    </Link>
                  );
                })}
              </div>
            )}

            <section className="card" style={{ margin: 0 }}>
              <h2>On the clock now</h2>
              {d.clockedIn.length === 0 ? (
                <Empty>Nobody is clocked in right now.</Empty>
              ) : (
                <table>
                  <tbody>
                    {d.clockedIn.map((c, i) => (
                      <tr key={i}>
                        <td>
                          <b>{c.name}</b>
                        </td>
                        <td>
                          {c.role_name} · {c.event_name}
                        </td>
                        <td className="muted">since {fmtDateTime(c.clock_in)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </div>

          <aside aria-label="Calendar">
            <div className="sec-h" style={{ marginBottom: '0.6rem' }}>
              <h2>{sectionIcon(<><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></>)} Calendar</h2>
            </div>
            <div className="cal">
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
      )}
    </>
  );
}

export default function Page() {
  return <Shell roles={['admin', 'manager']}>{(me) => <Body name={me.name} />}</Shell>;
}
