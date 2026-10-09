'use client';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import Shell from '@/components/Shell';
import { Banner, Empty, Pill } from '@/components/ui';
import { api, fmtDate, fmtDateTime, fmtTime } from '@/lib/api';

type Assignment = { id: string; user_id: string; user_name: string; status: string };
type Shift = { id: string; role_name: string; starts_at: string; ends_at: string; headcount: number; assignments: Assignment[] };
type Detail = { event: { id: string; name: string; venue: string | null; start_date: string; end_date: string }; shifts: Shift[] };
type Member = { id: string; name: string; role: string; skills: string[]; active: boolean };

const localInput = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

function Body() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [d, setD] = useState<Detail | null>(null);
  const [crew, setCrew] = useState<Member[]>([]);
  const [error, setError] = useState('');
  const [pick, setPick] = useState<Record<string, string>>({});
  const [f, setF] = useState(() => {
    const s = new Date();
    s.setMinutes(0, 0, 0);
    s.setHours(s.getHours() + 24);
    return { roleName: '', startsAt: localInput(s), endsAt: localInput(new Date(s.getTime() + 8 * 3600_000)), headcount: 1 };
  });

  const load = () =>
    api<Detail>(`/api/events/${id}`)
      .then(setD)
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
    api<{ crew: Member[] }>('/api/crew').then((r) => setCrew(r.crew.filter((m) => m.role === 'crew' && m.active)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const run = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const addShift = (e: React.FormEvent) => {
    e.preventDefault();
    run(() =>
      api(`/api/events/${id}/shifts`, {
        body: {
          roleName: f.roleName,
          startsAt: new Date(f.startsAt).toISOString(),
          endsAt: new Date(f.endsAt).toISOString(),
          headcount: Number(f.headcount),
        },
      }),
    ).then(() => setF((x) => ({ ...x, roleName: '' })));
  };

  const assign = (shiftId: string) => {
    const userId = pick[shiftId];
    if (!userId) return;
    run(() => api(`/api/shifts/${shiftId}/assign`, { body: { userId } })).then(() => setPick((p) => ({ ...p, [shiftId]: '' })));
  };

  if (!d) return error ? <Banner>{error}</Banner> : <div className="muted">Loading…</div>;
  const ev = d.event;

  return (
    <>
      <p className="small">
        <Link href="/events">← Events</Link>
      </p>
      <div className="row space">
        <div>
          <h1>{ev.name}</h1>
          <div className="muted">
            {ev.venue ? `${ev.venue} · ` : ''}
            {fmtDate(ev.start_date.slice(0, 10))}
            {ev.end_date.slice(0, 10) !== ev.start_date.slice(0, 10) && <> – {fmtDate(ev.end_date.slice(0, 10))}</>}
          </div>
        </div>
        <button
          className="btn ghost small danger"
          onClick={() => {
            if (confirm(`Delete "${ev.name}" and all its shifts?`)) api(`/api/events/${id}`, { method: 'DELETE' }).then(() => router.replace('/events'));
          }}
        >
          Delete event
        </button>
      </div>
      {error && <Banner onClose={() => setError('')}>{error}</Banner>}

      <section className="card">
        <h2>Add a shift</h2>
        <form className="grid-form" onSubmit={addShift}>
          <label>
            Role
            <input value={f.roleName} onChange={(e) => setF({ ...f, roleName: e.target.value })} placeholder="Audio Tech" required />
          </label>
          <label>
            Starts
            <input type="datetime-local" value={f.startsAt} onChange={(e) => setF({ ...f, startsAt: e.target.value })} required />
          </label>
          <label>
            Ends
            <input type="datetime-local" value={f.endsAt} min={f.startsAt} onChange={(e) => setF({ ...f, endsAt: e.target.value })} required />
          </label>
          <label>
            People needed
            <input type="number" min={1} max={500} value={f.headcount} onChange={(e) => setF({ ...f, headcount: Number(e.target.value) })} required />
          </label>
          <div className="form-actions">
            <button className="btn primary">Add shift</button>
          </div>
        </form>
      </section>

      {d.shifts.length === 0 ? (
        <Empty>No shifts yet. Add the first one above.</Empty>
      ) : (
        d.shifts.map((s) => {
          const active = s.assignments.filter((a) => a.status !== 'declined');
          const assignedIds = new Set(s.assignments.map((a) => a.user_id));
          const full = active.length >= s.headcount;
          return (
            <section className="card" key={s.id}>
              <div className="row space">
                <div>
                  <h2>{s.role_name}</h2>
                  <div className="muted small">
                    {fmtDateTime(s.starts_at)} – {fmtTime(s.ends_at)}
                  </div>
                </div>
                <div className="row">
                  <span className={`pill ${full ? 'accepted' : 'offered'}`}>
                    {active.length} / {s.headcount} assigned
                  </span>
                  <button className="btn ghost small danger" onClick={() => confirm('Delete this shift?') && run(() => api(`/api/shifts/${s.id}`, { method: 'DELETE' }))}>
                    Delete
                  </button>
                </div>
              </div>
              {s.assignments.length > 0 && (
                <ul className="plain">
                  {s.assignments.map((a) => (
                    <li key={a.id} className="row space">
                      <span>
                        {a.user_name} <Pill status={a.status} />
                      </span>
                      <button className="btn ghost small" onClick={() => run(() => api(`/api/assignments/${a.id}`, { method: 'DELETE' }))}>
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {!full && (
                <div className="row">
                  <select value={pick[s.id] ?? ''} onChange={(e) => setPick({ ...pick, [s.id]: e.target.value })} aria-label={`Choose crew for ${s.role_name}`}>
                    <option value="">Choose crew…</option>
                    {crew
                      .filter((m) => !assignedIds.has(m.id))
                      .map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                          {m.skills.length ? ` — ${m.skills.join(', ')}` : ''}
                        </option>
                      ))}
                  </select>
                  <button className="btn small" disabled={!pick[s.id]} onClick={() => assign(s.id)}>
                    Assign
                  </button>
                </div>
              )}
            </section>
          );
        })
      )}
    </>
  );
}

export default function Page() {
  return <Shell roles={['admin', 'manager']}>{() => <Body />}</Shell>;
}
