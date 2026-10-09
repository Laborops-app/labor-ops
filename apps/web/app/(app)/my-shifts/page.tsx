'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import Shell from '@/components/Shell';
import { Banner, Empty, Pill } from '@/components/ui';
import { api, fmtDateTime, fmtTime } from '@/lib/api';

type MyShift = {
  assignment_id: string;
  status: string;
  role_name: string;
  starts_at: string;
  ends_at: string;
  event_name: string;
  venue: string | null;
  clocked_in: boolean;
  can_clock_in: boolean;
  swap_status: string | null;
  swap_id: string | null;
  can_offer_swap: boolean;
};
type Entry = { id: string; status: string; clock_in: string; clock_out: string | null; hours: number; event_name: string; role_name: string };

function Body() {
  const [shifts, setShifts] = useState<MyShift[] | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  const load = async () => {
    try {
      const [s, t] = await Promise.all([api<{ shifts: MyShift[] }>('/api/my/shifts'), api<{ entries: Entry[] }>('/api/my/time')]);
      setShifts(s.shifts);
      setEntries(t.entries);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    load();
  }, []);

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

  const clockedIn = shifts?.some((s) => s.clocked_in);

  return (
    <>
      <h1>My shifts</h1>
      {error && <Banner onClose={() => setError('')}>{error}</Banner>}
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
                <div>{s.event_name}</div>
                <div className="muted small">
                  {fmtDateTime(s.starts_at)} – {fmtTime(s.ends_at)}
                  {s.venue ? ` · ${s.venue}` : ''}
                </div>
              </div>
              <Pill status={s.clocked_in ? 'clocked in' : s.status} />
            </div>
            <div className="row">
              <Link className="btn ghost small" href={`/my-shifts/${s.assignment_id}`}>
                Details &amp; map
              </Link>
              {s.status === 'offered' && (
                <>
                  <button className="btn primary" disabled={!!busy} onClick={() => act(s.assignment_id, () => api(`/api/assignments/${s.assignment_id}/respond`, { body: { response: 'accepted' } }))}>
                    Accept
                  </button>
                  <button className="btn" disabled={!!busy} onClick={() => act(s.assignment_id, () => api(`/api/assignments/${s.assignment_id}/respond`, { body: { response: 'declined' } }))}>
                    Decline
                  </button>
                </>
              )}
              {s.status === 'accepted' && !s.clocked_in && !s.can_clock_in && (
                <span className="muted small">Clock-in opens 1 hour before the shift starts.</span>
              )}
              {s.status === 'accepted' && !s.clocked_in && s.can_clock_in && (
                <button className="btn primary big" disabled={!!busy || !!clockedIn} onClick={() => act(s.assignment_id, () => api('/api/time/clock-in', { body: { assignmentId: s.assignment_id } }))}>
                  Clock in
                </button>
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
              {!s.swap_status && s.can_offer_swap && !s.clocked_in && (
                <button className="btn ghost small" disabled={!!busy} onClick={() => act(s.assignment_id, () => api(`/api/assignments/${s.assignment_id}/offer-swap`, { body: {} }))}>
                  Offer for swap
                </button>
              )}
              {s.clocked_in && (
                <button className="btn danger-solid big" disabled={!!busy} onClick={() => act(s.assignment_id, () => api('/api/time/clock-out', { body: {} }))}>
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
