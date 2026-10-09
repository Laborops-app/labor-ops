'use client';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import Shell from '@/components/Shell';
import { Banner, Empty, Pill } from '@/components/ui';
import { api, fmtDate, fmtDateTime, fmtTime } from '@/lib/api';

type Assignment = { id: string; user_id: string; user_name: string; status: string };
type Elig = { user_id: string; missing_certs: string[]; time_off: boolean; outside_availability: boolean };
type Shift = {
  id: string;
  role_name: string;
  starts_at: string;
  ends_at: string;
  headcount: number;
  is_open: boolean;
  required_certs: string[];
  assignments: Assignment[];
  crew_status: Elig[];
};
type Detail = { event: { id: string; name: string; venue: string | null; start_date: string; end_date: string }; shifts: Shift[] };
type Member = { id: string; name: string; role: string; skills: string[]; active: boolean };
type TplItem = { role: string; dayOffset: number; start: string; end: string; headcount: number; isOpen: boolean; requiredCerts: string[] };
type Template = { id: string; name: string; items: TplItem[] };

const p2 = (n: number) => String(n).padStart(2, '0');
const localInput = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}`;
const dateOnly = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const hhmm = (d: Date) => `${p2(d.getHours())}:${p2(d.getMinutes())}`;
const parseDate = (s: string) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y!, m! - 1, d!);
};
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const at = (day: Date, time: string) => {
  const [h, m] = time.split(':').map(Number);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h!, m!, 0, 0);
};
const certs = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function Body() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [d, setD] = useState<Detail | null>(null);
  const [crew, setCrew] = useState<Member[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [pick, setPick] = useState<Record<string, string>>({});
  const [f, setF] = useState(() => {
    const s = new Date();
    s.setMinutes(0, 0, 0);
    s.setHours(s.getHours() + 24);
    return {
      roleName: '',
      startsAt: localInput(s),
      endsAt: localInput(new Date(s.getTime() + 8 * 3600_000)),
      headcount: 1,
      certs: '',
      isOpen: false,
      repeat: false,
      days: [] as number[],
      until: '',
    };
  });
  const [tplId, setTplId] = useState('');
  const [tplStart, setTplStart] = useState('');
  const [tplName, setTplName] = useState('');

  const load = () =>
    api<Detail>(`/api/events/${id}`)
      .then((r) => {
        setD(r);
        setTplStart((v) => v || r.event.start_date.slice(0, 10));
      })
      .catch((e) => setError(e.message));
  const loadTemplates = () => api<{ templates: Template[] }>('/api/templates').then((r) => setTemplates(r.templates));
  useEffect(() => {
    load();
    loadTemplates();
    api<{ crew: Member[] }>('/api/crew').then((r) => setCrew(r.crew.filter((m) => m.role === 'crew' && m.active)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const run = async (fn: () => Promise<unknown>, okMsg = '') => {
    setError('');
    setNote('');
    try {
      await fn();
      if (okMsg) setNote(okMsg);
      await load();
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    }
  };

  const addShift = async (e: React.FormEvent) => {
    e.preventDefault();
    const start = new Date(f.startsAt);
    const end = new Date(f.endsAt);
    const base = { roleName: f.roleName, headcount: Number(f.headcount), isOpen: f.isOpen, requiredCerts: certs(f.certs) };
    let ok: boolean;
    if (f.repeat) {
      if (!f.until || f.days.length === 0) return setError('Choose the days to repeat on and an end date.');
      const last = parseDate(f.until);
      const first = new Date(start.getFullYear(), start.getMonth(), start.getDate());
      const span = Math.round((end.getTime() - start.getTime()) / 1000);
      const list: unknown[] = [];
      for (let day = first; day <= last; day = addDays(day, 1)) {
        if (!f.days.includes(day.getDay())) continue;
        const s = at(day, hhmm(start));
        list.push({ ...base, startsAt: s.toISOString(), endsAt: new Date(s.getTime() + span * 1000).toISOString() });
      }
      if (list.length === 0) return setError('No dates match those days.');
      if (list.length > 120) return setError('That would create more than 120 shifts. Choose a shorter range.');
      ok = await run(() => api(`/api/events/${id}/shifts/bulk`, { body: { shifts: list } }), `Created ${list.length} shifts.`);
    } else {
      ok = await run(() => api(`/api/events/${id}/shifts`, { body: { ...base, startsAt: start.toISOString(), endsAt: end.toISOString() } }));
    }
    if (ok) setF((x) => ({ ...x, roleName: '' }));
  };

  const applyTemplate = () => {
    const t = templates.find((x) => x.id === tplId);
    if (!t || !tplStart) return;
    const base = parseDate(tplStart);
    const shifts = t.items.map((it) => {
      const day = addDays(base, it.dayOffset);
      const s = at(day, it.start);
      let e = at(day, it.end);
      if (e <= s) e = at(addDays(day, 1), it.end);
      return { roleName: it.role, startsAt: s.toISOString(), endsAt: e.toISOString(), headcount: it.headcount, isOpen: it.isOpen, requiredCerts: it.requiredCerts };
    });
    run(() => api(`/api/events/${id}/shifts/bulk`, { body: { shifts } }), `Added ${shifts.length} shifts from “${t.name}”.`);
  };

  const saveTemplate = async () => {
    if (!d || !tplName.trim() || d.shifts.length === 0) return;
    const starts = d.shifts.map((s) => new Date(s.starts_at));
    const base = new Date(Math.min(...starts.map((x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime())));
    const items: TplItem[] = d.shifts.slice(0, 60).map((s) => {
      const a = new Date(s.starts_at);
      const b = new Date(s.ends_at);
      const day = new Date(a.getFullYear(), a.getMonth(), a.getDate());
      return {
        role: s.role_name,
        dayOffset: Math.round((day.getTime() - base.getTime()) / 86_400_000),
        start: hhmm(a),
        end: hhmm(b),
        headcount: s.headcount,
        isOpen: s.is_open,
        requiredCerts: s.required_certs ?? [],
      };
    });
    if (await run(() => api('/api/templates', { body: { name: tplName.trim(), items } }), `Saved template “${tplName.trim()}”.`)) {
      setTplName('');
      loadTemplates();
    }
  };

  const assign = (shiftId: string) => {
    const raw = pick[shiftId];
    if (!raw) return;
    const override = raw.startsWith('o:');
    const userId = override ? raw.slice(2) : raw;
    run(() => api(`/api/shifts/${shiftId}/assign`, { body: { userId, override: override || undefined } })).then(() => setPick((p) => ({ ...p, [shiftId]: '' })));
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
      {note && (
        <Banner kind="ok" onClose={() => setNote('')}>
          {note}
        </Banner>
      )}

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
          <label>
            Required certificates
            <input value={f.certs} onChange={(e) => setF({ ...f, certs: e.target.value })} placeholder="Forklift, Rigging (comma separated)" />
          </label>
          <label className="check">
            <input type="checkbox" checked={f.isOpen} onChange={(e) => setF({ ...f, isOpen: e.target.checked })} />
            Open for claiming
          </label>
          <label className="check">
            <input type="checkbox" checked={f.repeat} onChange={(e) => setF({ ...f, repeat: e.target.checked })} />
            Repeat on certain days
          </label>
          {f.repeat && (
            <div className="repeat-days">
              {DAYS.map((n, i) => (
                <label key={n} className="check">
                  <input
                    type="checkbox"
                    checked={f.days.includes(i)}
                    onChange={(e) => setF({ ...f, days: e.target.checked ? [...f.days, i] : f.days.filter((x) => x !== i) })}
                  />
                  {n}
                </label>
              ))}
              <label>
                Until
                <input type="date" value={f.until} min={f.startsAt.slice(0, 10)} onChange={(e) => setF({ ...f, until: e.target.value })} required />
              </label>
            </div>
          )}
          <div className="form-actions">
            <button className="btn primary">{f.repeat ? 'Add repeating shifts' : 'Add shift'}</button>
          </div>
        </form>
      </section>

      <details className="card">
        <summary>
          <b>Shift templates</b> <span className="muted small">Create a whole day or week of shifts in one step</span>
        </summary>
        <div className="adv">
          <div className="row">
            <select value={tplId} onChange={(e) => setTplId(e.target.value)} aria-label="Template">
              <option value="">Choose a template…</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.items.length} shifts)
                </option>
              ))}
            </select>
            <input type="date" value={tplStart} onChange={(e) => setTplStart(e.target.value)} aria-label="Template start date" />
            <button className="btn small primary" disabled={!tplId || !tplStart} onClick={applyTemplate}>
              Apply
            </button>
            {tplId && (
              <button
                className="btn ghost small danger"
                onClick={() => confirm('Delete this template?') && run(() => api(`/api/templates/${tplId}`, { method: 'DELETE' })).then(() => (setTplId(''), loadTemplates()))}
              >
                Delete template
              </button>
            )}
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <input value={tplName} onChange={(e) => setTplName(e.target.value)} placeholder="Name for a new template" aria-label="New template name" />
            <button className="btn small" disabled={!tplName.trim() || d.shifts.length === 0} onClick={saveTemplate}>
              Save this event’s shifts as template
            </button>
          </div>
        </div>
      </details>

      {d.shifts.length === 0 ? (
        <Empty>No shifts yet. Add the first one above.</Empty>
      ) : (
        d.shifts.map((s) => {
          const active = s.assignments.filter((a) => a.status !== 'declined');
          const pending = s.assignments.filter((a) => a.status === 'pending');
          const assignedIds = new Set(s.assignments.map((a) => a.user_id));
          const full = active.length >= s.headcount;
          const st = new Map(s.crew_status.map((x) => [x.user_id, x]));
          const candidates = crew.filter((m) => !assignedIds.has(m.id)).map((m) => ({ m, e: st.get(m.id) }));
          const ok = candidates.filter((c) => !c.e?.missing_certs.length && !c.e?.time_off && !c.e?.outside_availability);
          const blocked = candidates.filter((c) => c.e?.missing_certs.length);
          const soft = candidates.filter((c) => !c.e?.missing_certs.length && (c.e?.time_off || c.e?.outside_availability));
          return (
            <section className="card" key={s.id}>
              <div className="row space">
                <div>
                  <h2>{s.role_name}</h2>
                  <div className="muted small">
                    {fmtDateTime(s.starts_at)} – {fmtTime(s.ends_at)}
                  </div>
                  <div className="shift-flags">
                    {s.is_open && <span className="chip open">Open for claiming</span>}
                    {s.required_certs?.map((c) => (
                      <span key={c} className="chip">
                        {c}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="row">
                  <span className={`pill ${full ? 'accepted' : 'offered'}`}>
                    {active.length} / {s.headcount} filled
                  </span>
                  <button className="btn ghost small" onClick={() => run(() => api(`/api/shifts/${s.id}`, { method: 'PATCH', body: { isOpen: !s.is_open } }))}>
                    {s.is_open ? 'Close to claims' : 'Open for claiming'}
                  </button>
                  <button className="btn ghost small danger" onClick={() => confirm('Delete this shift?') && run(() => api(`/api/shifts/${s.id}`, { method: 'DELETE' }))}>
                    Delete
                  </button>
                </div>
              </div>
              {pending.length > 0 && (
                <p className="small muted">
                  {pending.length} pending claim{pending.length > 1 ? 's' : ''} — review in <Link href="/requests">Requests</Link>.
                </p>
              )}
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
                    {ok.map(({ m }) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                        {m.skills.length ? ` — ${m.skills.join(', ')}` : ''}
                      </option>
                    ))}
                    {soft.length > 0 && (
                      <optgroup label="Outside availability (override)">
                        {soft.map(({ m, e }) => (
                          <option key={m.id} value={`o:${m.id}`}>
                            {m.name} — {e?.time_off ? 'time off' : 'not available then'}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    {blocked.length > 0 && (
                      <optgroup label="Missing certificate">
                        {blocked.map(({ m, e }) => (
                          <option key={m.id} value={m.id} disabled>
                            {m.name} — needs {e?.missing_certs.join(', ')}
                          </option>
                        ))}
                      </optgroup>
                    )}
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
