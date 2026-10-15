'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import Shell from '@/components/Shell';
import { usePageActive } from '@/components/KeepAlive';
import { avClass, initialsOf } from '@/components/TopbarAction';
import { Banner } from '@/components/ui';
import { api, fmtDate, fmtTime } from '@/lib/api';
import { useTabTitle } from '@/lib/tabs';

type Person = { assignment_id: string; user_id: string; name: string; phone: string | null; clocked_in_at: string | null; last_clock_out: string | null; is_me: boolean };
type Shift = { id: string; role_name: string; starts_at: string; ends_at: string; can_check_in: boolean; crew: Person[] };
type Data = {
  event: { id: string; name: string; venue: string | null; address: string | null; start_date: string; end_date: string; clock_mode: 'self' | 'coordinator' };
  kind: 'coordinator' | 'lead';
  myShifts: { role_name: string }[];
  shifts: Shift[];
};

const when = (s: Shift) => `${new Date(s.starts_at).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}, ${fmtTime(s.starts_at)} – ${fmtTime(s.ends_at)}`;

function Body() {
  const { id } = useParams<{ id: string }>();
  const active = usePageActive();
  const [d, setD] = useState<Data | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [q, setQ] = useState('');
  useTabTitle(d?.event.name ? `On site · ${d.event.name}` : null);

  const load = () => api<Data>(`/api/onsite/events/${id}`).then(setD).catch((e) => setError(e.message));
  useEffect(() => {
    if (!active) return;
    load();
    // Keep the board current while it is open (others may check people in too).
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, active]);

  const act = async (p: Person, what: 'check-in' | 'check-out') => {
    setError('');
    setBusy(p.assignment_id);
    try {
      await api(`/api/onsite/assignments/${p.assignment_id}/${what}`, { body: {} });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  if (!d) return error ? <Banner>{error}</Banner> : <div className="muted">Loading…</div>;
  const everyone = d.shifts.flatMap((s) => s.crew);
  const onSite = everyone.filter((p) => p.clocked_in_at).length;
  const done = everyone.filter((p) => !p.clocked_in_at && p.last_clock_out).length;
  const match = (p: Person) => !q || p.name.toLowerCase().includes(q.toLowerCase());
  const teams = [...new Set(d.myShifts.map((s) => s.role_name.replace(/\s*\(.*\)\s*$/, '')))].join(', ');

  return (
    <>
      <div className="row space" style={{ alignItems: 'flex-start' }}>
        <div>
          <h1 style={{ marginBottom: 4 }}>{d.event.name}</h1>
          <div className="muted small">
            {fmtDate(d.event.start_date)}{d.event.end_date !== d.event.start_date ? ` – ${fmtDate(d.event.end_date)}` : ''}{d.event.venue ? ` · ${d.event.venue}` : ''}
          </div>
          <div style={{ marginTop: 8 }}>
            <span className="chip">{d.kind === 'coordinator' ? 'On-site Labor Coordinator · all crew' : `Crew Lead · your ${teams} team`}</span>
          </div>
        </div>
        <Link className="btn ghost" href={`/onsite/${id}/rate`}>★ Rate crew</Link>
      </div>
      {error && <Banner onClose={() => setError('')}>{error}</Banner>}
      <div className="os-stats">
        <div><b>{onSite}</b><span>on site</span></div>
        <div><b>{everyone.length - onSite - done}</b><span>not checked in</span></div>
        <div><b>{done}</b><span>checked out</span></div>
      </div>
      {everyone.length > 8 && <input className="os-search" type="search" placeholder="Find someone" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find someone" />}
      {d.shifts.length === 0 && <div className="muted">No crew to show.</div>}
      {d.shifts.map((s) => {
        const crew = s.crew.filter(match);
        if (q && !crew.length) return null;
        return (
          <section className="card os-shift" key={s.id}>
            <div className="os-shift-head">
              <b>{s.role_name}</b>
              <span className="muted small">{when(s)} · {s.crew.filter((p) => p.clocked_in_at).length}/{s.crew.length} on site</span>
            </div>
            {s.crew.length === 0 && <div className="muted small">Nobody confirmed on this shift yet.</div>}
            <ul className="os-crew">
              {crew.map((p) => (
                <li key={p.assignment_id} className={p.clocked_in_at ? 'on' : p.last_clock_out ? 'done' : ''}>
                  <span className={avClass(p.name)} aria-hidden="true" style={{ width: 38, height: 38, fontSize: 13 }}>{initialsOf(p.name)}</span>
                  <span className="os-who">
                    <b>{p.name}{p.is_me && <span className="muted"> (you)</span>}</b>
                    <span className="muted small">
                      {p.clocked_in_at ? `On site since ${fmtTime(p.clocked_in_at)}` : p.last_clock_out ? `Checked out ${fmtTime(p.last_clock_out)}` : 'Not checked in'}
                      {p.phone && !p.is_me && <> · <a href={`tel:${p.phone}`}>{p.phone}</a></>}
                    </span>
                  </span>
                  {p.clocked_in_at ? (
                    <button className="btn danger-solid" disabled={!!busy} onClick={() => act(p, 'check-out')}>{busy === p.assignment_id ? '…' : 'Check out'}</button>
                  ) : (
                    <button className="btn primary" disabled={!!busy || !s.can_check_in} title={s.can_check_in ? undefined : 'Check-in opens 2 hours before the shift starts'} onClick={() => act(p, 'check-in')}>
                      {busy === p.assignment_id ? '…' : p.last_clock_out ? 'Check in again' : 'Check in'}
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {!s.can_check_in && s.crew.length > 0 && <div className="muted small">Check-in opens 2 hours before this shift starts.</div>}
          </section>
        );
      })}
    </>
  );
}

export default function Page() {
  return <Shell roles={['crew']}>{() => <Body />}</Shell>;
}
