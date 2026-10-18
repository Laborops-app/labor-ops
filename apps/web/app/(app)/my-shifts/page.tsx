'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import Shell from '@/components/Shell';
import { Banner, Empty, Pill } from '@/components/ui';
import { api, ApiError, fmtDate, fmtDateTime, fmtTime, getPosition, money } from '@/lib/api';
import { onPunchesChanged, pendingPunches, punch, type Punch } from '@/lib/punchQueue';
import IosInstallHint from '@/components/IosInstallHint';
import MyEarnings from '@/components/MyEarnings';
import PastShifts from '@/components/PastShifts';

/** Offline, the server can't say whether clock-in is open, so the window is worked out on the phone (1 h before start to 2 h after end). */
const canClock = (s: { can_clock_in: boolean; starts_at: string; ends_at: string }) =>
  typeof navigator !== 'undefined' && navigator.onLine === false
    ? Date.now() >= +new Date(s.starts_at) - 3600_000 && Date.now() <= +new Date(s.ends_at) + 2 * 3600_000
    : s.can_clock_in;

type MyShift = {
  assignment_id: string;
  status: string;
  is_lead?: boolean;
  event_id: string;
  role_name: string;
  starts_at: string;
  ends_at: string;
  event_name: string;
  venue: string | null;
  clocked_in: boolean;
  can_clock_in: boolean;
  on_break?: { kind: 'break' | 'lunch'; started_at: string; remind_min?: number } | null;
  clock_mode: 'self' | 'coordinator';
  needs_location: boolean;
  geofence_m: number | null;
  swap_status: string | null;
  swap_id: string | null;
  can_offer_swap: boolean;
  hourly_rate: number | null;
  pay_type?: 'hourly' | 'day';
  estimated_pay: number | null;
  hours: number;
};
type Entry = { id: string; status: string; clock_in: string; clock_out: string | null; hours: number; event_name: string; role_name: string };

function Body() {
  const [shifts, setShifts] = useState<MyShift[] | null>(null);
  const [period, setPeriod] = useState<{ from: string; to: string; later: number } | null>(null);
  const [view, setView] = useState<'current' | 'past'>('current');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  const [offline, setOffline] = useState(false);
  const [notice, setNotice] = useState('');
  const [queued, setQueued] = useState<Punch[]>([]);
  const [askBreak, setAskBreak] = useState('');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);
  const load = async () => {
    try {
      const [s, t] = await Promise.all([api<{ shifts: MyShift[]; period?: { from: string; to: string }; later?: number }>('/api/my/shifts'), api<{ entries: Entry[] }>('/api/my/time')]);
      setShifts(s.shifts);
      setPeriod(s.period ? { ...s.period, later: s.later ?? 0 } : null);
      setEntries(t.entries);
      setOffline(false);
      try { localStorage.setItem('lo_my_shifts', JSON.stringify({ at: Date.now(), shifts: s.shifts, entries: t.entries })); } catch { /* storage blocked */ }
    } catch (e) {
      // No signal: show the shifts from the last time they loaded.
      const cached = (() => { try { return JSON.parse(localStorage.getItem('lo_my_shifts') || 'null'); } catch { return null; } })();
      if (!(e instanceof ApiError) && cached) {
        setShifts(cached.shifts);
        setEntries(cached.entries);
        setOffline(true);
      } else setError((e as Error).message);
    }
  };
  useEffect(() => {
    load();
    const refresh = () =>
      pendingPunches().then((l) => {
        const left = l.filter((p) => !p.error);
        setQueued(left);
        if (!left.length) setNotice((n) => (n.startsWith('No signal') ? '' : n));
      });
    refresh();
    const off = onPunchesChanged(() => {
      refresh();
      if (navigator.onLine) load();
    });
    return off;
  }, []);
  // A punch saved offline counts on screen straight away.
  const queuedIn = (id: string) => queued.some((p) => p.kind === 'in' && p.body.assignmentId === id);
  const queuedOut = queued.some((p) => p.kind === 'out');
  const doPunch = (s: MyShift, kind: 'in' | 'out') =>
    act(s.assignment_id, async () => {
      setNotice('');
      // Location: required where the event checks it (waits up to 10 s), otherwise a quick best effort.
      const pos = kind === 'in' && s.needs_location ? await getPosition() : await getPosition(4000).catch(() => null);
      const how = await punch(kind, { ...(kind === 'in' ? { assignmentId: s.assignment_id } : {}), ...(pos ?? {}) }, `${s.role_name}, ${s.event_name}`);
      if (how === 'queued') setNotice(`No signal: your ${kind === 'in' ? 'clock-in' : 'clock-out'} is saved on this phone with the time you tapped, and will send by itself.`);
    });

  // Breaks need a signal: they change what the office sees right away.
  const breakCall = (s: MyShift, path: string, body: Record<string, unknown>, needsPos = false) =>
    act(s.assignment_id, async () => {
      setAskBreak('');
      setNotice('');
      if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new Error('No signal: breaks need a connection. Try again when you have signal.');
      const pos = needsPos && s.needs_location ? await getPosition() : await getPosition(4000).catch(() => null);
      await api(path, { body: { ...body, ...(pos ?? {}) } });
    });
  const since = (iso: string) => {
    const m = Math.max(0, Math.floor((now - +new Date(iso)) / 60_000));
    return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
  };

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setError('');
    setBusy(key);
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  const isIn = (s: MyShift) => (s.clocked_in || queuedIn(s.assignment_id)) && !(queuedOut && (s.clocked_in || queuedIn(s.assignment_id)));
  const clockedIn = shifts?.some(isIn);

  return (
    <>
      <h1>My shifts</h1>
      <IosInstallHint />
      {error && <Banner onClose={() => setError('')}>{error}</Banner>}
      {notice && <Banner kind="info" onClose={() => setNotice('')}>{notice}</Banner>}
      {offline && <p className="muted small">Offline: showing your shifts as of the last time they loaded.</p>}
      {!offline && <MyEarnings />}
      <div className="row space my-view">
        <div className="seg" role="tablist" aria-label="Which shifts">
          <button role="tab" aria-selected={view === 'current'} className={view === 'current' ? 'active' : ''} onClick={() => setView('current')}>This pay period</button>
          <button role="tab" aria-selected={view === 'past'} className={view === 'past' ? 'active' : ''} onClick={() => setView('past')} disabled={offline}>Past shifts</button>
        </div>
        {view === 'current' && period && <span className="muted small">{fmtDate(period.from)} – {fmtDate(period.to)}</span>}
      </div>
      {view === 'past' ? (
        <PastShifts />
      ) : !shifts ? (
        <div className="muted">Loading…</div>
      ) : shifts.length === 0 ? (
        <Empty>No shifts left in this pay period. When a labor coordinator assigns you one, it will show up here.</Empty>
      ) : (
        shifts.map((s) => (
          <section className="card shift-card" key={s.assignment_id}>
            <div className="row space">
              <div>
                <h2>
                  <Link href={`/my-shifts/${s.assignment_id}`} className="shift-link">
                    {s.role_name}
                  </Link>
                </h2>
                <div>{s.event_name}{s.is_lead && s.status === 'accepted' && <span className="chip lead-chip">★ Lead</span>}</div>
                <div className="muted small">
                  {fmtDateTime(s.starts_at)} – {fmtTime(s.ends_at)}
                  {s.venue ? ` · ${s.venue}` : ''}
                </div>
                {s.hourly_rate != null && s.estimated_pay != null && (
                  <div className="small pay-line">
                    {money(s.hourly_rate)}{s.pay_type === 'day' ? ' day rate' : '/hr'} · est. <b>{money(s.estimated_pay)}</b>
                  </div>
                )}
              </div>
              <Pill status={s.on_break?.kind === 'lunch' ? 'at lunch' : s.on_break ? 'on break' : isIn(s) ? 'clocked in' : s.status} />
            </div>
            <div className="row">
              <Link className="btn ghost small" href={`/my-shifts/${s.assignment_id}`}>
                Details &amp; map
              </Link>
              {s.is_lead && s.status === 'accepted' && (
                <Link className="btn small" href={`/onsite/${s.event_id}`}>
                  My team
                </Link>
              )}
              {s.status === 'offered' && (
                <>
                  <button className="btn primary" disabled={!!busy} onClick={() => act(s.assignment_id, () => api(`/api/assignments/${s.assignment_id}/respond`, { body: { response: 'accepted' } }))}>
                    Confirm
                  </button>
                  <button className="btn" disabled={!!busy} onClick={() => act(s.assignment_id, () => api(`/api/assignments/${s.assignment_id}/respond`, { body: { response: 'declined' } }))}>
                    Decline
                  </button>
                </>
              )}
              {s.status === 'accepted' && !isIn(s) && s.clock_mode === 'coordinator' && (
                <span className="muted small">Your labor coordinator will check you in when you arrive.</span>
              )}
              {s.status === 'accepted' && !isIn(s) && s.clock_mode !== 'coordinator' && !canClock(s) && (
                <span className="muted small">Clock-in opens 1 hour before the shift starts.</span>
              )}
              {s.on_break?.kind === 'lunch' && !isIn(s) && (
                <div className="break-box">
                  <div className="small">
                    🍽 <b>At lunch</b> since {fmtTime(s.on_break.started_at)} · {since(s.on_break.started_at)}
                    {(s.on_break.remind_min ?? 45) > 0 && now - +new Date(s.on_break.started_at) >= (s.on_break.remind_min ?? 45) * 60_000 && <span className="break-over"> · time to clock back in</span>}
                  </div>
                  <div className="row">
                    <button className="btn primary big" disabled={!!busy} onClick={() => breakCall(s, '/api/time/break/end', {}, true)}>
                      Back from lunch
                    </button>
                    <button className="btn ghost small" disabled={!!busy} onClick={() => breakCall(s, '/api/time/break/end', { done: true })}>
                      Done for the day
                    </button>
                  </div>
                </div>
              )}
              {s.status === 'accepted' && !isIn(s) && !s.on_break && s.clock_mode !== 'coordinator' && canClock(s) && (
                <>
                  <button
                    className="btn primary big"
                    disabled={!!busy || !!clockedIn}
                    onClick={() => doPunch(s, 'in')}
                  >
                    Clock in
                  </button>
                  {s.needs_location && <span className="muted small">Your location is checked: be within {s.geofence_m} m of the venue.</span>}
                </>
              )}
              {s.status === 'pending' && <span className="muted small">Waiting for approval.</span>}
              {s.swap_status && s.swap_id && (
                <>
                  <span className="muted small">{s.swap_status === 'pending' ? 'Swap awaiting approval.' : 'Offered for swap.'}</span>
                  <button className="btn ghost small" disabled={!!busy} onClick={() => act(s.assignment_id, () => api(`/api/swaps/${s.swap_id}/cancel`, { body: {} }))}>
                    Cancel swap
                  </button>
                </>
              )}
              {!s.swap_status && s.can_offer_swap && !isIn(s) && (
                <button className="btn ghost small" disabled={!!busy} onClick={() => act(s.assignment_id, () => api(`/api/assignments/${s.assignment_id}/offer-swap`, { body: {} }))}>
                  Offer for swap
                </button>
              )}
              {isIn(s) && s.on_break?.kind === 'break' && (
                <div className="break-box">
                  <div className="small">☕ <b>On break</b> since {fmtTime(s.on_break.started_at)} · {since(s.on_break.started_at)} (still clocked in)</div>
                  <div className="row">
                    <button className="btn primary big" disabled={!!busy} onClick={() => breakCall(s, '/api/time/break/end', {})}>
                      End break
                    </button>
                  </div>
                </div>
              )}
              {isIn(s) && !s.on_break && s.clock_mode !== 'coordinator' && !queuedIn(s.assignment_id) && askBreak !== s.assignment_id && (
                <button className="btn big" disabled={!!busy} onClick={() => setAskBreak(s.assignment_id)}>
                  Break
                </button>
              )}
              {isIn(s) && (
                <button className="btn danger-solid big" disabled={!!busy} onClick={() => doPunch(s, 'out')}>
                  Clock out
                </button>
              )}
              {isIn(s) && !s.on_break && askBreak === s.assignment_id && (
                <div className="break-box" role="group" aria-label="Break or lunch?">
                  <div className="small"><b>Break or lunch?</b></div>
                  <div className="row">
                    <button className="btn big" disabled={!!busy} onClick={() => breakCall(s, '/api/time/break', { kind: 'break' })}>
                      ☕ Break
                    </button>
                    <button className="btn big" disabled={!!busy} onClick={() => breakCall(s, '/api/time/break', { kind: 'lunch' })}>
                      🍽 Lunch
                    </button>
                    <button className="btn ghost small" onClick={() => setAskBreak('')}>Cancel</button>
                  </div>
                  <div className="muted small">A break keeps you clocked in. Lunch clocks you out until you tap “Back from lunch”, and you get a reminder when lunch is over.</div>
                </div>
              )}
            </div>
          </section>
        ))
      )}
      {view === 'current' && period && period.later > 0 && (
        <p className="muted small center-text">
          {period.later} more shift{period.later === 1 ? '' : 's'} after this pay period: see <Link href="/my-calendar">Calendar</Link>.
        </p>
      )}
    </>
  );
}

export default function Page() {
  return <Shell roles={['crew', 'manager', 'admin']}>{() => <Body />}</Shell>;
}
