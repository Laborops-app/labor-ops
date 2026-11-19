'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import Shell from '@/components/Shell';
import { Banner } from '@/components/ui';
import { show } from '@/components/Toasts';
import { api, ApiError, fmtDate, fmtTime, getPosition, Me } from '@/lib/api';
import { CardLine, clockFace, hm, type CardDay } from '@/components/Timecard';

type Mine = {
  tz: string; today: string; week: { from: string; to: string }; weeklyOt: number; todayMin: number; weekMin: number; days: CardDay[];
  open: { id: string; clock_in: string; note: string | null; break_since: string | null } | null;
  upcoming: { id: string; status: string; role_name: string; starts_at: string; ends_at: string; event: string; venue: string | null }[];
};

function Body({ me }: { me: Me }) {
  const [d, setD] = useState<Mine | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');
  const [noteOpen, setNoteOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [loadedAt, setLoadedAt] = useState(() => Date.now());
  const load = useCallback(() => api<Mine>('/api/staff-clock/me').then((r) => { setD(r); setLoadedAt(Date.now()); setErr(''); }).catch((e) => setErr(e instanceof ApiError && e.reason === 'not_staff' ? e.message : (e as Error).message)), []);
  useEffect(() => { load(); const t = setInterval(() => document.visibilityState === 'visible' && load(), 30000); return () => clearInterval(t); }, [load]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

  const punch = async (what: 'in' | 'out') => {
    setBusy(what);
    try {
      // The phone's location goes with the punch when it shares it; the punch still counts without it.
      const pos = await getPosition(6000).catch(() => null);
      await api(`/api/staff-clock/${what}`, { body: { ...(pos ? { lat: pos.lat, lng: pos.lng, acc: Math.round(pos.accuracy) } : {}), note: note.trim() || null } });
      setNote(''); setNoteOpen(false);
      show(what === 'in' ? `Clocked in${pos ? '' : ' (location not shared)'}` : 'Clocked out. Have a good one!');
      await load();
    } catch (e) { show((e as Error).message, { error: true }); } finally { setBusy(''); }
  };
  const brk = async (action: 'start' | 'end') => {
    setBusy(action);
    try { await api('/api/staff-clock/break', { body: { action } }); await load(); } catch (e) { show((e as Error).message, { error: true }); } finally { setBusy(''); }
  };

  if (err && !d) return <Banner kind="info">{err}</Banner>;
  if (!d) return <div className="muted">Loading…</div>;
  const on = !!d.open;
  const onBreak = !!d.open?.break_since;
  // Totals come from the server; while on the clock (not on break), add the minutes since they were read.
  const live = on && !onBreak ? Math.max(0, Math.floor((now - loadedAt) / 60000)) : 0;
  const todayMin = d.todayMin + live, weekMin = d.weekMin + live;
  const sinceMs = d.open ? now - new Date(d.open.clock_in).getTime() : 0;
  const otMin = d.weeklyOt * 60;
  const pct = Math.min(100, Math.round((weekMin / otMin) * 100));
  const nearOt = weekMin >= otMin - 120;
  const days = [...d.days].reverse();
  const first = me.name.split(' ')[0];

  return (
    <div className="clock-page">
      <section className={`clock-hero${on ? (onBreak ? ' break' : ' on') : ''}`} aria-live="polite">
        <p className="clock-hi">Hi {first}</p>
        <p className="clock-state">{!on ? 'You’re off the clock' : onBreak ? `On break since ${fmtTime(d.open!.break_since!)}` : `On the clock since ${fmtTime(d.open!.clock_in)}`}</p>
        <p className="clock-face" aria-label="Time on the clock">{on ? clockFace(sinceMs) : new Date(now).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</p>
        <div className="clock-acts">
          {!on && <button className="clock-btn in" disabled={!!busy} onClick={() => punch('in')}>{busy === 'in' ? 'Clocking in…' : 'Clock in'}</button>}
          {on && !onBreak && <button className="clock-btn brk" disabled={!!busy} onClick={() => brk('start')}>{busy === 'start' ? 'Starting…' : 'Start break'}</button>}
          {on && onBreak && <button className="clock-btn brk" disabled={!!busy} onClick={() => brk('end')}>{busy === 'end' ? 'Ending…' : 'End break'}</button>}
          {on && <button className="clock-btn out" disabled={!!busy} onClick={() => punch('out')}>{busy === 'out' ? 'Clocking out…' : 'Clock out'}</button>}
        </div>
        {noteOpen ? (
          <label className="clock-note">Note for your manager (optional)
            <input value={note} onChange={(e) => setNote(e.target.value.slice(0, 500))} placeholder={on ? 'e.g. Left early for an appointment' : 'e.g. Started at the warehouse'} autoFocus />
          </label>
        ) : (
          <button className="btn-link small clock-addnote" onClick={() => setNoteOpen(true)}>Add a note</button>
        )}
        {on && d.open?.note && <p className="small clock-mynote">Note: “{d.open.note}”</p>}
      </section>

      <div className="clock-stats">
        <div className="clock-stat"><span className="muted small">Today</span><b>{hm(todayMin)}</b></div>
        <div className="clock-stat"><span className="muted small">This week</span><b>{hm(weekMin)}</b></div>
        <div className={`clock-stat ot${nearOt ? ' warn' : ''}`}>
          <span className="muted small">Overtime after {d.weeklyOt} h</span>
          <div className="clock-bar" role="meter" aria-valuemin={0} aria-valuemax={otMin} aria-valuenow={weekMin} aria-label="Hours this week toward overtime"><span style={{ width: `${pct}%` }} /></div>
          <span className="small">{weekMin >= otMin ? <b className="tc-warn">⚠ {hm(weekMin - otMin)} overtime this week</b> : nearOt ? <b className="tc-warn">⚠ {hm(otMin - weekMin)} until overtime</b> : `${hm(otMin - weekMin)} until overtime`}</span>
        </div>
      </div>

      {d.upcoming.length > 0 && (
        <section className="card clock-sec">
          <h2>Booked on events</h2>
          <ul className="clock-events">
            {d.upcoming.map((u) => (
              <li key={u.id}>
                <Link href={`/my-shifts/${u.id}`}>
                  <b>{u.role_name}</b> · {u.event}
                  <span className="muted small"> · {fmtDate(u.starts_at)}, {fmtTime(u.starts_at)} – {fmtTime(u.ends_at)}{u.venue ? ` · ${u.venue}` : ''}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card clock-sec">
        <h2>This week <span className="muted small">{fmtDate(d.week.from)} – {fmtDate(d.week.to)}</span></h2>
        {!days.length && <p className="muted">No time yet this week.</p>}
        {days.map((day) => (
          <div key={day.date} className="tc-day">
            <div className="tc-dayhead"><b>{fmtDate(day.date)}</b><span>{hm(day.minutes)}</span></div>
            <ul className="tc-lines">{day.items.map((i) => <CardLine key={i.id} i={i} />)}</ul>
          </div>
        ))}
        <p className="muted small">Wrong time? Add a note when you clock, or ask your manager to fix it.</p>
      </section>
    </div>
  );
}

export default function Page() {
  return <Shell roles={['admin', 'manager', 'hr', 'crew']}>{(me) => <Body me={me} />}</Shell>;
}
