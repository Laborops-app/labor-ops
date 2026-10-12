'use client';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import Shell from '@/components/Shell';
import { Banner, Empty, Pill } from '@/components/ui';
import { roleKey } from '@/components/Stars';
import FillFromGroup from '@/components/FillFromGroup';
import CopyEvent from '@/components/CopyEvent';
import { api, ApiError, Me, fmtDate, fmtDateTime, fmtTime, money } from '@/lib/api';
import { EventDetails, Phases, Clocking, RentmanCard, EventFull, Phase } from '@/components/EventInfo';
import { useSkillNames, useSkillSections } from '@/components/SkillPicker';

type Assignment = { id: string; user_id: string; user_name: string; status: string; clocked_in_at?: string | null; last_clock_out?: string | null };
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
  phase_id: string | null;
  hourly_rate?: number | null;
  estimated_cost?: number | null;
};
type Detail = { event: EventFull; shifts: Shift[]; phases: Phase[] };
type Member = { id: string; name: string; role: string; skills: string[]; active: boolean; ratings?: Record<string, number> };
type TplItem = { role: string; section?: string; dayOffset: number; start: string; end: string; headcount: number; isOpen: boolean; requiredCerts: string[] };
type Template = { id: string; name: string; items: TplItem[]; customer_id?: string | null };

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

function Body({ me }: { me: Me }) {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [d, setD] = useState<Detail | null>(null);
  const [crew, setCrew] = useState<Member[]>([]);
  const [crewGroups, setCrewGroups] = useState<{ id: string; name: string }[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [pick, setPick] = useState<Record<string, string>>({});
  // "Confirm automatically": crew are put straight on the shift instead of being asked to accept. Remembered on this device.
  const [autoConfirm, setAutoConfirmState] = useState(false);
  useEffect(() => {
    try {
      setAutoConfirmState(localStorage.getItem('lo_auto_confirm') === '1');
    } catch {
      /* storage unavailable */
    }
  }, []);
  const setAutoConfirm = (v: boolean) => {
    setAutoConfirmState(v);
    try {
      localStorage.setItem('lo_auto_confirm', v ? '1' : '0');
    } catch {
      /* ignore */
    }
  };
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
      phaseId: '',
      repeat: false,
      days: [] as number[],
      until: '',
    };
  });
  const skillNames = useSkillNames();
  const skillSections = useSkillSections();
  const [otherRole, setOtherRole] = useState(false);
  const [tplId, setTplId] = useState('');
  const [tplPhase, setTplPhase] = useState('');
  const [tplOpen, setTplOpen] = useState(false);
  const tplBox = useRef<HTMLDetailsElement>(null);
  const shiftForm = useRef<HTMLElement>(null);
  const [tplStart, setTplStart] = useState('');
  const [tplName, setTplName] = useState('');

  const load = () =>
    api<Detail>(`/api/events/${id}`)
      .then((r) => {
        setD(r);
        setTplStart((v) => v || r.event.start_date.slice(0, 10));
      })
      .catch((e) => setError(e.message));
  const customerId = d?.event.customer_id ?? null;
  const loadTemplates = () => api<{ templates: Template[] }>(`/api/templates${customerId ? `?customerId=${customerId}` : ''}`).then((r) => setTemplates(r.templates));
  const [tplForCustomer, setTplForCustomer] = useState(false);
  useEffect(() => {
    load();
    api<{ crew: Member[] }>('/api/crew').then((r) => setCrew(r.crew.filter((m) => m.role === 'crew' && m.active)));
    api<{ groups: { id: string; name: string }[] }>('/api/crew-groups').then((r) => setCrewGroups(r.groups)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  useEffect(() => {
    if (d) loadTemplates();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, customerId, !!d]);

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
    const base = { roleName: f.roleName, headcount: Number(f.headcount), isOpen: f.isOpen, requiredCerts: certs(f.certs), phaseId: f.phaseId || null };
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
      return { roleName: it.role, startsAt: s.toISOString(), endsAt: e.toISOString(), headcount: it.headcount, isOpen: it.isOpen, requiredCerts: it.requiredCerts, phaseId: tplPhase || d?.phases.find((p) => it.section && p.label.toLowerCase() === it.section.toLowerCase())?.id || null };
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
    if (await run(() => api('/api/templates', { body: { name: tplName.trim(), items, customerId: tplForCustomer && customerId ? customerId : undefined } }), `Saved template “${tplName.trim()}”.`)) {
      setTplName('');
      loadTemplates();
    }
  };

  const assign = (shiftId: string) => {
    const raw = pick[shiftId];
    if (!raw) return;
    const override = raw.startsWith('o:');
    const userId = override ? raw.slice(2) : raw;
    const send = async (ov: boolean) => {
      setError('');
      setNote('');
      try {
        const r = await api<{ warnings?: string[] }>(`/api/shifts/${shiftId}/assign`, { body: { userId, override: ov || undefined, confirmed: autoConfirm || undefined } });
        setPick((p) => ({ ...p, [shiftId]: '' }));
        if (r.warnings?.length) setNote(r.warnings.join(' '));
        await load();
      } catch (err) {
        if (err instanceof ApiError && err.reason === 'rules' && !ov && confirm(`${err.message}\n\nAssign anyway?`)) return send(true);
        setError((err as Error).message);
      }
    };
    send(override);
  };

  if (!d) return error ? <Banner>{error}</Banner> : <div className="muted">Loading…</div>;
  const ev = d.event;

  const renderShifts = (list: Shift[]) =>
    list.map((s) => {
          const active = s.assignments.filter((a) => a.status !== 'declined');
          const pending = s.assignments.filter((a) => a.status === 'pending');
          const assignedIds = new Set(s.assignments.map((a) => a.user_id));
          const full = active.length >= s.headcount;
          const st = new Map(s.crew_status.map((x) => [x.user_id, x]));
          const candidates = crew.filter((m) => !assignedIds.has(m.id)).map((m) => ({ m, e: st.get(m.id) }));
          const rk = roleKey(s.role_name);
          const stars = (m: Member) => m.ratings?.[rk] ?? 0;
          const best = (a: { m: Member }, b: { m: Member }) => stars(b.m) - stars(a.m) || a.m.name.localeCompare(b.m.name);
          const ok = candidates.filter((c) => !c.e?.missing_certs.length && !c.e?.time_off && !c.e?.outside_availability).sort(best);
          const blocked = candidates.filter((c) => c.e?.missing_certs.length);
          const soft = candidates.filter((c) => !c.e?.missing_certs.length && (c.e?.time_off || c.e?.outside_availability));
          return (
            <section className="card" key={s.id}>
              <div className="row space">
                <div>
                  <h2>{s.role_name}</h2>
                  <div className="muted small">
                    {fmtDateTime(s.starts_at)} – {fmtTime(s.ends_at)}
                    {s.hourly_rate != null && (
                      <>
                        {' · '}
                        {money(s.hourly_rate)}/hr
                        {s.estimated_cost != null && ` · est. cost ${money(s.estimated_cost)} for ${s.headcount}`}
                      </>
                    )}
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
                  {d.phases.length > 0 && (
                    <select
                      className="move-phase"
                      value={s.phase_id ?? ''}
                      aria-label="Move shift to a phase"
                      onChange={(e) => run(() => api(`/api/shifts/${s.id}`, { method: 'PATCH', body: { phaseId: e.target.value || null } }), 'Shift moved.')}
                    >
                      <option value="">No phase</option>
                      {d.phases.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                  )}
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
                      <span className="row">
                        {(a.status === 'offered' || a.status === 'pending') && (
                          <button className="btn small primary" onClick={() => run(() => api(`/api/assignments/${a.id}/confirm`, { body: {} }), `Confirmed ${a.user_name}.`)}>
                            Confirm
                          </button>
                        )}
                        {a.status === 'accepted' && !a.clocked_in_at && (
                          <button className="btn small" onClick={() => run(() => api(`/api/assignments/${a.id}/check-in`, { body: {} }))}>
                            Check in
                          </button>
                        )}
                        {a.clocked_in_at && (
                          <>
                            <span className="muted small">on site since {fmtTime(a.clocked_in_at)}</span>
                            <button className="btn small" onClick={() => run(() => api(`/api/assignments/${a.id}/check-out`, { body: {} }))}>
                              Check out
                            </button>
                          </>
                        )}
                        <button className="btn ghost small" onClick={() => run(() => api(`/api/assignments/${a.id}`, { method: 'DELETE' }))}>
                          Remove
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {pending.length + s.assignments.filter((a) => a.status === 'offered').length > 1 && (
                <div className="row">
                  <button
                    className="btn small"
                    onClick={() =>
                      run(async () => {
                        for (const a of s.assignments.filter((x) => x.status === 'offered' || x.status === 'pending')) await api(`/api/assignments/${a.id}/confirm`, { body: {} });
                      }, 'Confirmed everyone on this shift.')
                    }
                  >
                    Confirm everyone
                  </button>
                </div>
              )}
              {!full && (
                <div className="row">
                  <select value={pick[s.id] ?? ''} onChange={(e) => setPick({ ...pick, [s.id]: e.target.value })} aria-label={`Choose crew for ${s.role_name}`}>
                    <option value="">Choose crew…</option>
                    {ok.map(({ m }) => (
                      <option key={m.id} value={m.id}>
                        {stars(m) ? `${'★'.repeat(stars(m))}${'☆'.repeat(5 - stars(m))} ` : ''}
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
                    {autoConfirm ? 'Assign & confirm' : 'Assign'}
                  </button>
                  <label className="row small" style={{ gap: '.35rem', alignItems: 'center' }}>
                    <input type="checkbox" style={{ width: 'auto' }} checked={autoConfirm} onChange={(e) => setAutoConfirm(e.target.checked)} />
                    Confirm automatically
                  </label>
                </div>
              )}
              {!full && crewGroups.length > 0 && (
                <FillFromGroup shiftId={s.id} groups={crewGroups} confirmed={autoConfirm} onError={setError} onDone={(m) => { setNote(m); load(); }} />
              )}
            </section>
          );
    });

  const groups: { key: string; phase: Phase | null; shifts: Shift[] }[] = [
    ...d.phases.map((p) => ({ key: p.id, phase: p as Phase | null, shifts: d.shifts.filter((s) => s.phase_id === p.id) })),
    ...(d.phases.length === 0 || d.shifts.some((s) => !s.phase_id || !d.phases.some((p) => p.id === s.phase_id))
      ? [{ key: 'none', phase: null as Phase | null, shifts: d.shifts.filter((s) => !s.phase_id || !d.phases.some((p) => p.id === s.phase_id)) }]
      : []),
  ];
  // Pick a phase for the new shift: it goes into that phase and the dates start on the phase's first day (times are kept).
  const addToPhase = (p: Phase, scroll = true) => {
    const day = p.starts_on.slice(0, 10);
    const swap = (v: string) => `${day}T${v.slice(11)}`;
    setF((x) => ({ ...x, phaseId: p.id, startsAt: swap(x.startsAt), endsAt: swap(x.endsAt) }));
    if (scroll) shiftForm.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  const templateForPhase = (p: Phase) => {
    setTplPhase(p.id);
    setTplStart(p.starts_on.slice(0, 10));
    setTplOpen(true);
    setTimeout(() => tplBox.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
  };
  const groupSection = (g: { key: string; phase: Phase | null; shifts: Shift[] }) => (
    <div key={g.key} className="phase-group">
      {(g.phase || d.phases.length > 0) && (
        <div className="phase-head">
          <div>
            <h2>{g.phase ? g.phase.label : 'Not in a phase'}</h2>
            {g.phase && (
              <span className="muted small">
                {g.phase.starts_on.slice(0, 10) === g.phase.ends_on.slice(0, 10) ? fmtDate(g.phase.starts_on.slice(0, 10)) : `${fmtDate(g.phase.starts_on.slice(0, 10))} – ${fmtDate(g.phase.ends_on.slice(0, 10))}`} · {g.shifts.length} shift{g.shifts.length === 1 ? '' : 's'}
              </span>
            )}
          </div>
          {g.phase && (
            <div className="row" style={{ gap: 6 }}>
              <button className="btn small primary" onClick={() => addToPhase(g.phase!)}>
                + Add shift
              </button>
              <button className="btn small" onClick={() => templateForPhase(g.phase!)}>
                Use template
              </button>
            </div>
          )}
        </div>
      )}
      {g.shifts.length === 0 ? <Empty>{g.phase ? `No shifts in ${g.phase.label} yet.` : 'No shifts yet. Add the first one above.'}</Empty> : renderShifts(g.shifts)}
    </div>
  );

  return (
    <>
      <p className="small">
        <Link href="/events">← Events</Link>
      </p>
      <div className="row space">
        <div>
          <h1>{ev.name}</h1>
          <div className="muted">
            {[ev.client, ev.venue].filter(Boolean).join(' · ')}
            {(ev.client || ev.venue) && ' · '}
            {fmtDate(ev.start_date.slice(0, 10))}
            {ev.end_date.slice(0, 10) !== ev.start_date.slice(0, 10) && <> – {fmtDate(ev.end_date.slice(0, 10))}</>}
          </div>
        </div>
        <div className="row" style={{ gap: '0.4rem' }}>
        <button
          className="btn small"
          onClick={() =>
            api<{ id: string }>('/api/chat/channels', { body: { eventId: id } })
              .then((r) => router.push(`/chat?c=${r.id}`))
              .catch((e) => setError(e.message))
          }
        >
          Event chat
        </button>
        <button
          className="btn small"
          onClick={() => api<{ quote: { id: string } }>('/api/quotes', { body: { eventId: id } }).then((r) => router.push(`/quotes/${r.quote.id}`)).catch((e) => setError(e.message))}
        >
          Create quote
        </button>
        <CopyEvent eventId={id} name={ev.name} customerId={ev.customer_id ?? null} onError={setError} label="Copy event" />
        <button
          className="btn ghost small danger"
          onClick={() => {
            if (confirm(`Delete "${ev.name}" and all its shifts?`)) api(`/api/events/${id}`, { method: 'DELETE' }).then(() => router.replace('/events'));
          }}
        >
          Delete event
        </button>
        </div>
      </div>
      {error && <Banner onClose={() => setError('')}>{error}</Banner>}
      {note && (
        <Banner kind="ok" onClose={() => setNote('')}>
          {note}
        </Banner>
      )}

      <EventDetails ev={ev} hasPhases={d.phases.length > 0} onSaved={load} onError={setError} />
      <Phases eventId={id} phases={d.phases} onChanged={load} onError={setError} />
      <RentmanCard eventId={id} isAdmin={me.role === 'admin'} onError={setError} />
      <Clocking ev={ev} onSaved={load} onError={setError} />

      <section className="card" ref={shiftForm}>
        <h2>Add a shift</h2>
        {d.phases.length > 0 && (
          <div className="phase-tabs" role="tablist" aria-label="Phase for the new shift">
            {d.phases.map((p) => (
              <button key={p.id} type="button" role="tab" aria-selected={f.phaseId === p.id} className={f.phaseId === p.id ? 'tab on' : 'tab'} onClick={() => addToPhase(p, false)}>
                {p.label}
                <span className="muted small"> {fmtDate(p.starts_on.slice(0, 10))}</span>
              </button>
            ))}
            <button type="button" role="tab" aria-selected={f.phaseId === ''} className={f.phaseId === '' ? 'tab on' : 'tab'} onClick={() => setF((x) => ({ ...x, phaseId: '' }))}>
              No phase
            </button>
          </div>
        )}
        <form className="grid-form" onSubmit={addShift}>
          <label>
            Role
            {skillNames.length > 0 && !otherRole ? (
              <select
                value={f.roleName}
                required
                onChange={(e) => {
                  if (e.target.value === '__other') {
                    setOtherRole(true);
                    setF({ ...f, roleName: '' });
                  } else setF({ ...f, roleName: e.target.value });
                }}
              >
                <option value="">Choose a role…</option>
                {skillSections.map((g) => (
                  <optgroup key={g.label} label={g.label}>
                    {g.roles.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </optgroup>
                ))}
                <option value="__other">Other (type a name)…</option>
              </select>
            ) : (
              <input value={f.roleName} onChange={(e) => setF({ ...f, roleName: e.target.value })} placeholder="Audio Tech" required />
            )}
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

      <details className="card" ref={tplBox} open={tplOpen} onToggle={(e) => setTplOpen((e.target as HTMLDetailsElement).open)}>
        <summary>
          <b>Shift templates</b> <span className="muted small">Create a whole day or week of shifts in one step</span>
        </summary>
        <div className="adv">
          <div className="row">
            <select value={tplId} onChange={(e) => setTplId(e.target.value)} aria-label="Template">
              <option value="">Choose a template…</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.customer_id ? `★ ${t.name}` : t.name} ({t.items.length} shifts)
                </option>
              ))}
            </select>
            {d.phases.length > 0 && (
              <select
                value={tplPhase}
                onChange={(e) => {
                  setTplPhase(e.target.value);
                  const p = d.phases.find((x) => x.id === e.target.value);
                  if (p) setTplStart(p.starts_on.slice(0, 10));
                }}
                aria-label="Add the shifts to a phase"
              >
                <option value="">No phase</option>
                {d.phases.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label} ({fmtDate(p.starts_on.slice(0, 10))})
                  </option>
                ))}
              </select>
            )}
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
            {customerId && <label className="check"><input type="checkbox" checked={tplForCustomer} onChange={(e) => setTplForCustomer(e.target.checked)} /> Only for {d.event.client}</label>}
          </div>
        </div>
      </details>

      {(
        <>{groups.map((g) => groupSection(g))}</>      )}
    </>
  );
}

export default function Page() {
  return <Shell roles={['admin', 'manager']}>{(me) => <Body me={me} />}</Shell>;
}
