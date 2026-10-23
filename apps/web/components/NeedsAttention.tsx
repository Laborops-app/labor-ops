'use client';
import { useState } from 'react';
import { api, fmtTime } from '@/lib/api';

type A = { id: string; user_id: string; user_name: string; status: string; created_at?: string; nudged_at?: string | null; planned?: boolean };
type S = { id: string; role_name: string; starts_at: string; ends_at: string; headcount: number; assignments: A[] };

const ago = (iso: string) => {
  const h = (Date.now() - +new Date(iso)) / 3600_000;
  return h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} days`;
};
const when = (iso: string) => `${new Date(iso).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} ${fmtTime(iso)}`;

/**
 * What needs the coordinator on this event: offers nobody has answered, declines to replace, and open seats
 * close to the start. Works from the phone: nudge, replace and fill are one tap each.
 */
export default function NeedsAttention({
  eventId, shifts, onReplace, onFill, onDone, onError,
}: {
  eventId: string;
  shifts: S[];
  onReplace: (shiftId: string, assignmentId: string) => void;
  onFill: (shiftId: string) => void;
  onDone: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const [busy, setBusy] = useState('');
  const [open, setOpen] = useState(true);
  const [all, setAll] = useState(false);
  const CAP = 6;
  const now = Date.now();
  const live = shifts.filter((s) => +new Date(s.ends_at) > now);
  const waiting = live.flatMap((s) => s.assignments.filter((a) => a.status === 'offered').map((a) => ({ s, a }))).sort((x, y) => (x.a.created_at ?? '').localeCompare(y.a.created_at ?? ''));
  const seated = (s: S) => s.assignments.filter((a) => a.status !== 'declined').length;
  const declined = live.flatMap((s) => (seated(s) < s.headcount ? s.assignments.filter((a) => a.status === 'declined').map((a) => ({ s, a })) : []));
  const soon = live.filter((s) => seated(s) < s.headcount && +new Date(s.starts_at) - now < 72 * 3600_000 && !declined.some((d) => d.s.id === s.id));
  const total = waiting.length + declined.length + soon.length;
  if (!total) return null;

  const nudge = async (key: string, fn: () => Promise<string>) => {
    setBusy(key);
    try {
      onDone(await fn());
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy('');
    }
  };
  const recent = (a: A) => !!a.nudged_at && now - +new Date(a.nudged_at) < 3600_000;

  return (
    <section className="card attention" aria-label="Needs attention">
      <button type="button" className="phase-toggle att-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <svg className="chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
        <span>
          <h2>Needs attention <span className="att-count">{total}</span></h2>
          <span className="muted small">
            {[waiting.length && `${waiting.length} not answered`, declined.length && `${declined.length} declined`, soon.length && `${soon.length} open close to start`].filter(Boolean).join(' · ')}
          </span>
        </span>
      </button>
      {open && (
        <div className="att-body">
          {waiting.length > 0 && (
            <div className="att-group">
              <div className="row space att-title">
                <b className="small">Haven&apos;t answered</b>
                {waiting.length > 1 && (
                  <button type="button" className="btn small" disabled={!!busy} onClick={() => nudge('all', async () => {
                    const r = await api<{ sent: number; skipped: number }>(`/api/events/${eventId}/nudge`, { body: {} });
                    return r.sent ? `Reminded ${r.sent} ${r.sent === 1 ? 'person' : 'people'} to answer.${r.skipped ? ` ${r.skipped} were reminded in the last hour.` : ''}` : 'Everyone waiting was reminded in the last hour.';
                  })}>
                    🔔 Remind all {waiting.length}
                  </button>
                )}
              </div>
              <ul className="plain att-list">
                {(all ? waiting : waiting.slice(0, CAP)).map(({ s, a }) => (
                  <li key={a.id} className="row space">
                    <span>
                      <b>{a.user_name}</b> <span className="muted small">{s.role_name} · {when(s.starts_at)}</span>
                      <span className={`small att-age${a.created_at && now - +new Date(a.created_at) > 24 * 3600_000 ? ' old' : ''}`}>{a.created_at ? ` · offered ${ago(a.created_at)} ago` : ''}{a.nudged_at ? ` · reminded ${ago(a.nudged_at)} ago` : ''}</span>
                    </span>
                    <span className="row" style={{ gap: 4 }}>
                      <button type="button" className="btn small" disabled={!!busy || recent(a)} title={recent(a) ? 'Reminded in the last hour' : 'Send a reminder to answer (push and text)'} onClick={() => nudge(a.id, async () => { await api(`/api/assignments/${a.id}/nudge`, { body: {} }); return `Reminded ${a.user_name}.`; })}>
                        🔔 Remind
                      </button>
                      <button type="button" className="btn ghost small" disabled={!!busy} title="Take them off and pick someone else" onClick={() => onReplace(s.id, a.id)}>Replace</button>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {declined.length > 0 && (
            <div className="att-group">
              <b className="small att-title">Declined: pick someone else</b>
              <ul className="plain att-list">
                {(all ? declined : declined.slice(0, CAP)).map(({ s, a }) => (
                  <li key={a.id} className="row space">
                    <span><b>{a.user_name}</b> <span className="muted small">declined {s.role_name} · {when(s.starts_at)}</span></span>
                    <button type="button" className="btn small primary" disabled={!!busy} onClick={() => onReplace(s.id, a.id)}>Replace</button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {soon.length > 0 && (
            <div className="att-group">
              <b className="small att-title">Open seats starting within 3 days</b>
              <ul className="plain att-list">
                {(all ? soon : soon.slice(0, CAP)).map((s) => (
                  <li key={s.id} className="row space">
                    <span><b>{s.role_name}</b> <span className="muted small">{when(s.starts_at)} · {s.headcount - seated(s)} open</span></span>
                    <button type="button" className="btn small primary" disabled={!!busy} onClick={() => onFill(s.id)}>Fill</button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {!all && (waiting.length > CAP || declined.length > CAP || soon.length > CAP) && (
            <button type="button" className="btn ghost small" style={{ marginTop: 8 }} onClick={() => setAll(true)}>Show all {total}</button>
          )}
        </div>
      )}
    </section>
  );
}
