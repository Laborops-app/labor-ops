'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import Shell from '@/components/Shell';
import { Banner, Empty, Pill } from '@/components/ui';
import { api, ApiError, fmtDateTime, fmtTime, getPosition, money } from '@/lib/api';
import { onPunchesChanged, pendingPunches, punch, type Punch } from '@/lib/punchQueue';
import IosInstallHint from '@/components/IosInstallHint';

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
  const [entries, setEntries] = useState<Entry[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  const [offline, setOffline] = useState(false);
  const [notice, setNotice] = useState('');
  const [queued, setQueued] = useState<Punch[]>([]);
  const load = async () => {
    try {
      const [s, t] = await Promise.all([api<{ shifts: MyShift[] }>('/api/my/shifts'), api<{ entries: Entry[] }>('/api/my/time')]);
      setShifts(s.shifts);
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
      {!shifts ? (
        <div className="muted">Loading…</div>
      ) : shifts.length === 0 ? (
        <Empty>No shifts yet. When a labor coordinator assigns you one, it will show up here.</Empty>
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
              <Pill status={isIn(s) ? 'clocked in' : s.status} />
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
              {s.status === 'accepted' && !isIn(s) && s.clock_mode !== 'coordinator' && canClock(s) && (
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
              {isIn(s) && (
                <button className="btn danger-solid big" disabled={!!busy} onClick={() => doPunch(s, 'out')}>
                  Clock out
                </button>
              )}
            </div>
          </section>
        ))
      )}
      {entries.length > 0 && (
        <section className="card">
          <h2>My recent time</h2>
          <div className="table-wrap">
            <table>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id}>
                    <td className="small">
                      {e.role_name}
                      <div className="muted">{e.event_name}</div>
                    </td>
                    <td className="small">{fmtDateTime(e.clock_in)}</td>
                    <td>{e.clock_out ? `${e.hours.toFixed(2)} h` : '—'}</td>
                    <td>
                      <Pill status={e.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}

export default function Page() {
  return <Shell roles={['crew', 'manager', 'admin']}>{() => <Body />}</Shell>;
}
