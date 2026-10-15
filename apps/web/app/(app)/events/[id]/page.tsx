'use client';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Shell from '@/components/Shell';
import { Banner, Empty, Pill } from '@/components/ui';
import { roleKey } from '@/components/Stars';
import { EventRatings } from '@/components/Rating';
import FillFromGroup from '@/components/FillFromGroup';
import CrewPick, { PickOption } from '@/components/CrewPick';
import InvoicePanel from '@/components/InvoicePanel';
import TopbarAction, { PlusIcon, TrashIcon, avClass, initialsOf } from '@/components/TopbarAction';
import CopyEvent from '@/components/CopyEvent';
import { api, ApiError, Me, fmtDate, fmtDateTime, fmtTime, money } from '@/lib/api';
import { EventDetails, Phases, Clocking, RentmanCard, EventFull, Phase, RmView } from '@/components/EventInfo';
import { useSkillNames, useSkillSections } from '@/components/SkillPicker';

type Assignment = { id: string; user_id: string; user_name: string; status: string; clocked_in_at?: string | null; last_clock_out?: string | null; pay_type?: 'hourly' | 'day'; rate?: number | null; estimated_pay?: number | null };
type CrewRate = { user_id: string; user_name: string; pay_type: 'hourly' | 'day'; rate: number; note: string | null };
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
  role_rate?: number | null;
  pay_rate_override?: string | null;
  estimated_cost?: number | null;
  unpriced_seats?: number;
  pay_type?: 'hourly' | 'day';
  ot_hours?: number;
  dt_hours?: number;
};
type Overtime = { otAfter: number | null; state: string | null; effectiveState: string | null; stateFromAddress: boolean; companyDailyOt: number; otMult: number; dtAfter: number | null; dtMult: number };
type Detail = { event: EventFull; shifts: Shift[]; phases: Phase[]; overtime?: Overtime; crewRates?: CrewRate[] };
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
  const [adding, setAdding] = useState<string | null>(null); // shift id whose crew picker is open ('new' = the add-shift form)
  const [busyAdd, setBusyAdd] = useState(false);
  const [payEdit, setPayEdit] = useState<{ id: string; value: string } | null>(null);
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
      payType: 'hourly' as 'hourly' | 'day',
      crew: [] as string[],
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
  // Event settings panel: clock-in, overtime and shift templates live here to keep the page short.
  const [settings, setSettings] = useState<null | 'clock' | 'ot' | 'tpl' | 'pay' | 'rentman' | 'invoice' | 'rate'>(null);
  const [rateInfo, setRateInfo] = useState<{ rated: number; total: number; due: number } | null>(null);
  const loadRateInfo = () =>
    api<{ workers: { ended: boolean; review_id: string | null }[]; rated: number; total: number }>(`/api/events/${id}/reviews`)
      .then((r) => setRateInfo({ rated: r.rated, total: r.total, due: r.workers.filter((w) => w.ended && !w.review_id).length }))
      .catch(() => undefined);
  useEffect(() => {
    loadRateInfo();
    if (new URLSearchParams(window.location.search).get('rate')) setSettings('rate');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  // Rentman lives in the same side panel, opened from its own button next to Event settings.
  const [rm, setRm] = useState<RmView | null>(null);
  // The customer's main contact, shown in the strip at the top (like the design's Deal Details).
  const [custInfo, setCustInfo] = useState<{ id: string; name: string; contact: string | null; email: string | null; phone: string | null } | null>(null);
  const custId = d?.event.customer_id ?? null;
  useEffect(() => {
    if (!custId) return setCustInfo(null);
    api<{ customer: { id: string; name: string }; contacts: { name: string; email: string | null; phone: string | null; is_primary: boolean }[] }>(`/api/customers/${custId}`)
      .then((r) => {
        const m = r.contacts.find((x) => x.is_primary) ?? r.contacts[0];
        setCustInfo({ id: r.customer.id, name: r.customer.name, contact: m?.name ?? null, email: m?.email ?? null, phone: m?.phone ?? null });
      })
      .catch(() => setCustInfo(null));
  }, [custId]);
  useEffect(() => {
    api<RmView>(`/api/events/${id}/rentman`).then(setRm).catch(() => setRm(null));
  }, [id]);
  useEffect(() => {
    if (!settings) return;
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setSettings(null);
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [settings]);
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
    const base = { roleName: f.roleName, headcount: Number(f.headcount), isOpen: f.isOpen, requiredCerts: certs(f.certs), phaseId: f.phaseId || null, payType: f.payType };
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
      // Crew picked in the form go straight onto the new shift (one more spot is added for each extra person).
      const picked = f.crew;
      let shiftId = '';
      ok = await run(async () => {
        shiftId = (await api<{ shift: { id: string } }>(`/api/events/${id}/shifts`, { body: { ...base, headcount: Math.max(base.headcount, picked.length), startsAt: start.toISOString(), endsAt: end.toISOString() } })).shift.id;
      });
      if (ok && picked.length) {
        const failed: string[] = [];
        for (const uid of picked) {
          const err = await assignUser(shiftId, uid);
          if (err) failed.push(`${crew.find((m) => m.id === uid)?.name ?? 'Someone'}: ${err}`);
        }
        await load();
        if (failed.length) setError(`Shift added, but not everyone could be put on it. ${failed.join(' ')}`);
        else setNote(`Shift added with ${picked.length} crew.`);
      }
    }
    if (ok) setF((x) => ({ ...x, roleName: '', crew: [] }));
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

  /** Put one person on a shift. Returns an error message, or null when they were added. Rule breaks ask before overriding when `ask` is set. */
  const assignUser = async (shiftId: string, userId: string, override = false, ask = true): Promise<string | null> => {
    try {
      const r = await api<{ warnings?: string[] }>(`/api/shifts/${shiftId}/assign`, { body: { userId, override: override || undefined, confirmed: autoConfirm || undefined } });
      if (r.warnings?.length) setNote(r.warnings.join(' '));
      return null;
    } catch (err) {
      if (ask && err instanceof ApiError && err.reason === 'rules' && !override && confirm(`${err.message}\n\nAssign anyway?`)) return assignUser(shiftId, userId, true, false);
      return (err as Error).message;
    }
  };

  /** "+" on a shift: adds the person, and when every spot is taken adds a spot first. */
  const addCrew = async (s: Shift, userId: string, override: boolean, full: boolean) => {
    setError('');
    setNote('');
    setBusyAdd(true);
    try {
      if (full) await api(`/api/shifts/${s.id}`, { method: 'PATCH', body: { headcount: s.headcount + 1 } });
      const err = await assignUser(s.id, userId, override);
      if (err) {
        if (full) await api(`/api/shifts/${s.id}`, { method: 'PATCH', body: { headcount: s.headcount } }).catch(() => undefined);
        setError(err);
      }
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyAdd(false);
    }
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
                        {money(s.hourly_rate)}{s.pay_type === 'day' ? ' day rate' : '/hr'}
                      </>
                    )}
                    {s.estimated_cost != null && ` · est. cost ${money(s.estimated_cost)} for ${s.headcount - (s.unpriced_seats ?? 0)}${s.unpriced_seats ? ` of ${s.headcount}` : ''}`}
                    {s.hourly_rate != null && !!s.ot_hours && ` · ${s.ot_hours} h overtime`}
                    {s.hourly_rate != null && !!s.dt_hours && ` · ${s.dt_hours} h double time`}
                  </div>
                  {s.role_rate !== undefined && s.hourly_rate == null && (
                    <div className="small" style={{ marginTop: '.3rem', color: 'var(--staff-warn)' }}>
                      No {s.pay_type === 'day' ? 'day rate' : 'pay rate'} set for {s.role_name}
                      {s.unpriced_seats ? `, so ${s.unpriced_seats} seat${s.unpriced_seats === 1 ? ' is' : 's are'} not in the cost` : ''}.{' '}
                      <Link href="/skills">Set it in Roles &amp; rates</Link> or change this shift&apos;s pay rate.
                    </div>
                  )}
                  {s.role_rate !== undefined && (
                    <div className="small" style={{ marginTop: '.3rem' }}>
                      {payEdit?.id === s.id ? (
                        <span className="row" style={{ gap: '.4rem', flexWrap: 'wrap' }}>
                          <span aria-hidden="true">$</span>
                          <input type="number" min={0.01} step="0.01" autoFocus value={payEdit.value} onChange={(e) => setPayEdit({ id: s.id, value: e.target.value })} aria-label="Pay rate for this shift" style={{ width: '6.5rem' }} />
                          <span className="muted">{s.pay_type === 'day' ? ' per day' : '/hr'} for this shift only{s.role_rate ? ` (role rate ${money(s.role_rate)})` : ''}</span>
                          <button className="btn small primary" disabled={!(Number(payEdit.value) > 0)} onClick={() => run(() => api(`/api/shifts/${s.id}`, { method: 'PATCH', body: { payRate: Math.round(Number(payEdit.value) * 100) / 100 } }), 'Pay rate updated. Anyone on the shift has been told.').then(() => setPayEdit(null))}>Save</button>
                          {s.pay_rate_override && <button className="btn small" onClick={() => run(() => api(`/api/shifts/${s.id}`, { method: 'PATCH', body: { payRate: null } }), 'Back to the role pay rate.').then(() => setPayEdit(null))}>Use role rate</button>}
                          <button className="btn ghost small" onClick={() => setPayEdit(null)}>Cancel</button>
                        </span>
                      ) : (
                        <>
                          <span className="chip">{s.pay_type === 'day' ? 'Day rate' : 'Hourly'}</span>{' '}
                          {s.pay_rate_override && <span className="chip">Custom pay rate</span>}{' '}
                          <button className="btn ghost small" onClick={() => run(() => api(`/api/shifts/${s.id}`, { method: 'PATCH', body: { payType: s.pay_type === 'day' ? 'hourly' : 'day' } }), s.pay_type === 'day' ? 'Now paid hourly.' : 'Now paid a flat day rate.')}>{s.pay_type === 'day' ? 'Pay hourly' : 'Pay day rate'}</button>{' '}
                          <button className="btn ghost small" onClick={() => setPayEdit({ id: s.id, value: String(s.hourly_rate ?? s.role_rate ?? '') })}>Change pay rate</button>
                        </>
                      )}
                    </div>
                  )}
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
                        {a.rate != null && a.status !== 'declined' && (
                          <button type="button" className="chip" style={{ border: 0, cursor: 'pointer', marginLeft: 4 }} title="This person's own rate on this event" onClick={() => setSettings('pay')}>
                            {money(a.rate)}{a.pay_type === 'day' ? '/day' : '/hr'}
                          </button>
                        )}
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
                        <button className="btn ghost small" aria-label={`Remove ${a.user_name} from this shift`} title="Remove from this shift" onClick={() => run(() => api(`/api/assignments/${a.id}`, { method: 'DELETE' }), `${a.user_name} removed.`)}>
                          ✕ Remove
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
              <div className="crew-slots crew-pick-anchor">
                {Array.from({ length: Math.min(Math.max(0, s.headcount - active.length), 6) }).map((_, n) => (
                  <button key={n} type="button" className="slot-add" onClick={() => setAdding(adding === s.id ? null : s.id)} aria-label={`Add crew to ${s.role_name}`}>
                    + Add crew
                  </button>
                ))}
                {s.headcount - active.length > 6 && <span className="muted small">{s.headcount - active.length - 6} more open spots</span>}
                {full && (
                  <button type="button" className="slot-add" onClick={() => setAdding(adding === s.id ? null : s.id)} title="Adds one more spot to this shift and puts the person in it">
                    + Add another person
                  </button>
                )}
                <label className="row small" style={{ gap: '.35rem', alignItems: 'center', marginLeft: 'auto' }}>
                  <input type="checkbox" style={{ width: 'auto' }} checked={autoConfirm} onChange={(e) => setAutoConfirm(e.target.checked)} />
                  Confirm automatically
                </label>
                {adding === s.id && (
                  <CrewPick
                    title={full ? `Add a spot on ${s.role_name}` : `Add crew to ${s.role_name} (${s.headcount - active.length} open)`}
                    busy={busyAdd}
                    onClose={() => setAdding(null)}
                    options={[
                      ...ok.map(({ m }) => ({ id: m.id, name: m.name, sub: m.skills.join(', '), stars: stars(m), kind: 'ok' as const })),
                      ...soft.map(({ m, e }) => ({ id: m.id, name: m.name, kind: 'soft' as const, note: e?.time_off ? 'time off' : 'not available then' })),
                      ...blocked.map(({ m, e }) => ({ id: m.id, name: m.name, kind: 'blocked' as const, note: `needs ${e?.missing_certs.join(', ')}` })),
                    ]}
                    onPick={(o) => {
                      if (active.length + 1 >= s.headcount && !full) setAdding(null);
                      addCrew(s, o.id, o.kind === 'soft', full);
                    }}
                  />
                )}
              </div>
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
    setSettings('tpl');
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
    <div className="split">
      <div className="split-main">
      <TopbarAction>
        <button className="btn primary" onClick={() => { shiftForm.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); setTimeout(() => (shiftForm.current?.querySelector('select, input') as HTMLElement | null)?.focus(), 350); }}>
          Add Shift
          <PlusIcon />
        </button>
      </TopbarAction>
      <p className="small" style={{ margin: '0 0 16px' }}>
        <Link href="/events">← All events</Link>
      </p>
      {custInfo && (
        <dl className="strip">
          <div className="who">
            <span className={avClass(custInfo.name)} aria-hidden="true">{initialsOf(custInfo.name)}</span>
            <div>
              <dt>Customer</dt>
              <dd><Link href={`/customers/${custInfo.id}`} style={{ color: 'inherit', textDecoration: 'none' }}>{custInfo.name}</Link></dd>
            </div>
          </div>
          {custInfo.contact && <div><dt>Contact</dt><dd>{custInfo.contact}</dd></div>}
          {custInfo.email && <div><dt>Email</dt><dd><a href={`mailto:${custInfo.email}`} style={{ color: 'inherit', textDecoration: 'none' }}>{custInfo.email}</a></dd></div>}
          {custInfo.phone && <div><dt>Phone</dt><dd><a href={`tel:${custInfo.phone}`} style={{ color: 'inherit', textDecoration: 'none' }}>{custInfo.phone}</a></dd></div>}
        </dl>
      )}
      <div className="title-row">
        <div style={{ minWidth: 0 }}>
          <h1>{ev.name}</h1>
          <div className="sub">
            {[ev.client, ev.venue].filter(Boolean).join(' · ')}
            {(ev.client || ev.venue) && ' · '}
            {fmtDate(ev.start_date.slice(0, 10))}
            {ev.end_date.slice(0, 10) !== ev.start_date.slice(0, 10) && <> – {fmtDate(ev.end_date.slice(0, 10))}</>}
          </div>
          <div className="row small" style={{ gap: '.35rem', marginTop: '.35rem', flexWrap: 'wrap' }}>
            {(() => {
              const slots = d.shifts.reduce((n, s) => n + s.headcount, 0);
              const filled = d.shifts.reduce((n, s) => n + Math.min(s.headcount, s.assignments.filter((a) => a.status !== 'declined').length), 0);
              if (!slots) return <span className="pill">No shifts yet</span>;
              const cls = filled >= slots ? 'staff-good' : filled > 0 ? 'staff-warn' : 'staff-bad';
              return <span className={`pill ${cls}`} title="Seats with crew on them (offered, pending or accepted)">{filled >= slots ? 'Fully staffed' : filled > 0 ? 'Partly staffed' : 'No crew yet'} · {filled}/{slots}</span>;
            })()}
            <button type="button" className="chip" style={{ border: 0, cursor: 'pointer' }} onClick={() => setSettings('clock')}>
              {ev.clock_mode === 'coordinator' ? 'Coordinator clocks crew in' : 'Crew clock themselves in'}
              {ev.geofence_m ? ` · within ${ev.geofence_m} m` : ''}
            </button>
            {d.overtime && (
              <button type="button" className="chip" style={{ border: 0, cursor: 'pointer' }} onClick={() => setSettings('ot')}>
                {d.overtime.otAfter ? `OT after ${d.overtime.otAfter} h` : 'Company overtime'}
                {d.overtime.effectiveState ? ` · ${d.overtime.effectiveState}` : ''}
              </button>
            )}
          </div>
                </div>
          <div className="acts">
            <button className={rateInfo?.due ? 'btn small rt-due-btn' : 'btn small'} onClick={() => setSettings('rate')} aria-haspopup="dialog" title="Rate the crew who worked this event">
              ★ Rate crew{rateInfo?.due ? ` · ${rateInfo.due}` : rateInfo?.total ? ` · ${rateInfo.rated}/${rateInfo.total}` : ''}
            </button>
            <button className="btn small" onClick={() => setSettings('clock')} aria-haspopup="dialog">⚙ Settings</button>
            {rm && (rm.connected || rm.linked) && (
              <button className="btn small" onClick={() => setSettings('rentman')} aria-haspopup="dialog" title={rm.project ? rm.project.name : 'Link a Rentman project'}>
                Rentman{rm.linked && rm.project ? ` · ${rm.project.number ? `#${rm.project.number}` : rm.project.name}` : ''}
              </button>
            )}
            {(me.role === 'admin' || me.canAdjustRates) && (
              <>
                <button className="btn small" onClick={() => setSettings('pay')} aria-haspopup="dialog">Crew pay</button>
                <button className="btn small" onClick={() => setSettings('invoice')} aria-haspopup="dialog">Invoice</button>
              </>
            )}
            <CopyEvent eventId={id} name={ev.name} customerId={ev.customer_id ?? null} onError={setError} label="Copy" />
            <button className="btn-round" title="Event chat" aria-label="Event chat" onClick={() => api<{ id: string }>('/api/chat/channels', { body: { eventId: id } }).then((r) => router.push(`/chat?c=${r.id}`)).catch((e) => setError(e.message))}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z" /></svg>
            </button>
            <button className="btn-round" title="Create a quote" aria-label="Create a quote" onClick={() => api<{ quote: { id: string } }>('/api/quotes', { body: { eventId: id } }).then((r) => router.push(`/quotes/${r.quote.id}`)).catch((e) => setError(e.message))}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h4" /></svg>
            </button>
            <button className="btn-round danger" title="Delete event" aria-label="Delete event" onClick={() => { if (confirm(`Delete "${ev.name}" and all its shifts?`)) api(`/api/events/${id}`, { method: 'DELETE' }).then(() => router.replace('/events')); }}>
              <TrashIcon />
            </button>
          </div>
      </div>
      {!!rateInfo?.due && settings !== 'rate' && (
        <div className="rt-prompt" role="status">
          <span className="rt-prompt-ico" aria-hidden="true">★</span>
          <span><b>How did the crew do?</b> <span className="muted">{rateInfo.due} {rateInfo.due === 1 ? 'person has' : 'people have'} finished a shift here without a rating. It takes a few seconds and helps you pick the best people next time.</span></span>
          <button className="btn primary small" onClick={() => setSettings('rate')}>Rate crew</button>
        </div>
      )}
      {error && <Banner onClose={() => setError('')}>{error}</Banner>}
      {note && (
        <Banner kind="ok" onClose={() => setNote('')}>
          {note}
        </Banner>
      )}

      <EventDetails ev={ev} hasPhases={d.phases.length > 0} onSaved={load} onError={setError} />
      {(
        <>{groups.map((g) => groupSection(g))}</>      )}
      </div>
      <aside className="split-aside">
      <section className="card aside-form" ref={shiftForm}>
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
          <div role="group" aria-label="How this shift is paid" style={{ gridColumn: '1 / -1' }}>
            <div className="small muted" style={{ marginBottom: 4 }}>Paid</div>
            <div className="phase-tabs">
              {([['hourly', 'Hourly'], ['day', 'Day rate']] as const).map(([k, label]) => (
                <button key={k} type="button" aria-pressed={f.payType === k} className={f.payType === k ? 'tab on' : 'tab'} onClick={() => setF({ ...f, payType: k })}>
                  {label}
                </button>
              ))}
            </div>
            {f.payType === 'day' && <div className="small muted">One flat amount for the day (the role&apos;s day rate), no overtime.</div>}
          </div>
          {!f.repeat && (
            <div style={{ gridColumn: '1 / -1' }}>
              <div className="small muted" style={{ marginBottom: 4 }}>Crew (optional)</div>
              <div className="crew-slots crew-pick-anchor">
                {f.crew.map((uid) => (
                  <span key={uid} className="crew-chip">
                    {crew.find((m) => m.id === uid)?.name ?? 'Crew'}
                    <button type="button" className="chip-x" aria-label={`Take ${crew.find((m) => m.id === uid)?.name ?? 'them'} off`} onClick={() => setF((x) => ({ ...x, crew: x.crew.filter((y) => y !== uid) }))}>✕</button>
                  </span>
                ))}
                <button type="button" className="slot-add" onClick={() => setAdding(adding === 'new' ? null : 'new')}>
                  + Add crew
                </button>
                {f.crew.length > Number(f.headcount) && <span className="muted small">People needed will be raised to {f.crew.length}.</span>}
                {adding === 'new' && (
                  <CrewPick
                    title="Add crew to the new shift"
                    onClose={() => setAdding(null)}
                    options={crew
                      .filter((m) => !f.crew.includes(m.id))
                      .map((m) => ({ m, fit: !!f.roleName && m.skills.some((k) => roleKey(k) === roleKey(f.roleName)) }))
                      .sort((a, b) => Number(b.fit) - Number(a.fit) || a.m.name.localeCompare(b.m.name))
                      .map(({ m, fit }) => ({ id: m.id, name: m.name, sub: fit ? `${m.skills.join(', ')} · matches role` : m.skills.join(', ') }))}
                    onPick={(o) => setF((x) => ({ ...x, crew: [...x.crew, o.id] }))}
                  />
                )}
              </div>
              <div className="muted small">They are checked against certificates, availability and labor rules when the shift is saved.</div>
            </div>
          )}
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
      <Phases eventId={id} phases={d.phases} onChanged={load} onError={setError} />
      </aside>


      {settings && typeof document !== 'undefined' && createPortal(
        <div className="drawer-backdrop" onMouseDown={() => setSettings(null)}>
          <aside className={settings === 'rentman' || settings === 'invoice' || settings === 'rate' ? 'drawer wide' : 'drawer'} role="dialog" aria-modal="true" aria-label={settings === 'rentman' ? 'Rentman' : settings === 'invoice' ? 'Invoice' : settings === 'rate' ? 'Rate crew' : 'Event settings'} onMouseDown={(e) => e.stopPropagation()}>
            <div className="row space">
              <h2 style={{ margin: 0 }}>{settings === 'rentman' ? 'Rentman' : settings === 'invoice' ? `Invoice · ${ev.name}` : settings === 'rate' ? `Rate crew · ${ev.name}` : 'Event settings'}</h2>
              <button className="btn ghost small" aria-label="Close" onClick={() => setSettings(null)}>✕</button>
            </div>
            {settings === 'rentman' && <div style={{ marginTop: 12 }}><RentmanCard eventId={id} isAdmin={me.role === 'admin'} onError={setError} onView={setRm} /></div>}
            {settings === 'invoice' && <InvoicePanel eventId={id} isAdmin={me.role === 'admin'} />}
            {settings === 'rate' && <div style={{ marginTop: 12 }}><EventRatings me={me} eventId={id} onProgress={() => loadRateInfo()} /></div>}
            {settings !== 'rentman' && settings !== 'invoice' && settings !== 'rate' && <div className="phase-tabs" role="tablist" aria-label="Settings section" style={{ margin: '12px 0' }}>
              {([['clock', 'Clock-in'], ['ot', 'Overtime'], ['tpl', 'Shift templates'], ...((me.role === 'admin' || me.canAdjustRates) ? [['pay', 'Crew pay']] as const : [])] as const).map(([k, label]) => (
                <button key={k} type="button" role="tab" aria-selected={settings === k} className={settings === k ? 'tab on' : 'tab'} onClick={() => setSettings(k)}>
                  {label}
                </button>
              ))}
            </div>}
            {settings === 'clock' && <Clocking ev={ev} onSaved={load} onError={setError} />}
            {settings === 'ot' && d.overtime && <OvertimeCard eventId={id} ot={d.overtime} onSaved={load} onError={setError} />}
            {settings === 'pay' && <CrewPay eventId={id} shifts={d.shifts} rates={d.crewRates ?? []} onSaved={load} />}
            {settings === 'tpl' && (
              <section className="card">
                <h2>Shift templates</h2>
                <p className="muted small">Create a whole day or week of shifts in one step, or save this event&apos;s shifts for next time.</p>
        <div>
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
              </section>
            )}
            {error && <Banner onClose={() => setError('')}>{error}</Banner>}
            {note && <Banner kind="ok" onClose={() => setNote('')}>{note}</Banner>}
          </aside>
        </div>,
        document.body,
      )}
    </div>
  );
}

export default function Page() {
  return <Shell roles={['admin', 'manager']}>{(me) => <Body me={me} />}</Shell>;
}

const US_STATES = 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' ');

/** Daily overtime for this job: after 8, 10 or 15 hours, using the multipliers of the state the job works in. */
function OvertimeCard({ eventId, ot, onSaved, onError }: { eventId: string; ot: Overtime; onSaved: () => void; onError: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  const save = async (body: { otAfter: number | null; state?: string | null }) => {
    setBusy(true);
    try {
      await api(`/api/events/${eventId}/overtime`, { method: 'PUT', body });
      onSaved();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const opts: [number | null, string][] = [[null, ot.companyDailyOt > 0 ? `Company default (after ${ot.companyDailyOt} h)` : 'Company default'], [8, 'After 8 hours'], [10, 'After 10 hours'], [15, 'After 15 hours']];
  return (
    <section className="card">
      <h2>Overtime for this job</h2>
      <div className="phase-tabs" role="group" aria-label="Daily overtime starts">
        {opts.map(([v, label]) => (
          <button key={String(v)} type="button" disabled={busy} aria-pressed={ot.otAfter === v} className={ot.otAfter === v ? 'tab on' : 'tab'} onClick={() => save({ otAfter: v })}>
            {label}
          </button>
        ))}
      </div>
      <label style={{ display: 'block', marginTop: 10, maxWidth: 320 }}>
        State the job works in
        <select value={ot.state ?? ''} disabled={busy} onChange={(e) => save({ otAfter: ot.otAfter, state: e.target.value || null })}>
          <option value="">{ot.effectiveState ? `Automatic (${ot.effectiveState}${ot.stateFromAddress ? ', from the address' : ''})` : 'Automatic (not found in the address)'}</option>
          {US_STATES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      <p className="muted small" style={{ marginTop: 8 }}>
        {ot.otAfter ?? (ot.companyDailyOt || 0) ? (
          <>
            Each person&apos;s hours on this job are counted per day. Past {ot.otAfter ?? ot.companyDailyOt} h they earn {ot.otMult}× their position&apos;s rate
            {ot.dtAfter ? `, and ${ot.dtMult}× after ${ot.dtAfter} h` : ''}
            {ot.effectiveState ? ` (${ot.effectiveState} rules)` : ''}.
          </>
        ) : (
          'No daily overtime on this job. Weekly overtime from the company rules still applies.'
        )}{' '}
        State rates are set under Labor rules. Day-rate shifts never earn overtime.
      </p>
    </section>
  );
}

/** Pay for each crew member on this event: their role's rate by default, or their own hourly or day rate. */
function CrewPay({ eventId, shifts, rates, onSaved }: { eventId: string; shifts: Shift[]; rates: CrewRate[]; onSaved: () => void }) {
  type Row = { id: string; name: string; roles: string[]; defaults: string[] };
  const people = new Map<string, Row>();
  for (const s of shifts)
    for (const a of s.assignments.filter((x) => x.status !== 'declined')) {
      const p = people.get(a.user_id) ?? { id: a.user_id, name: a.user_name, roles: [], defaults: [] };
      if (!p.roles.includes(s.role_name)) {
        p.roles.push(s.role_name);
        p.defaults.push(s.pay_type === 'day' ? (s.hourly_rate ? `${money(s.hourly_rate)}/day` : 'day rate not set') : s.hourly_rate ? `${money(s.hourly_rate)}/hr` : 'no rate set');
      }
      people.set(a.user_id, p);
    }
  // People who have a rate but are no longer on a shift still show, so the rate can be removed.
  for (const r of rates) if (!people.has(r.user_id)) people.set(r.user_id, { id: r.user_id, name: r.user_name, roles: [], defaults: [] });
  const list = [...people.values()].sort((a, b) => a.name.localeCompare(b.name));
  const byUser = new Map(rates.map((r) => [r.user_id, r]));
  const [edit, setEdit] = useState<Record<string, { type: 'default' | 'hourly' | 'day'; rate: string }>>({});
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const cur = (id: string) => edit[id] ?? (byUser.get(id) ? { type: byUser.get(id)!.pay_type, rate: String(byUser.get(id)!.rate) } : { type: 'default' as const, rate: '' });
  const save = async (p: Row) => {
    const e = cur(p.id);
    setErr(''); setMsg(''); setBusy(p.id);
    try {
      if (e.type === 'default') {
        if (byUser.has(p.id)) await api(`/api/events/${eventId}/crew-rates/${p.id}`, { method: 'DELETE' });
        setMsg(`${p.name} is back on the role's rate.`);
      } else {
        const n = Math.round(Number(e.rate) * 100) / 100;
        if (!(n > 0)) throw new Error('Enter a rate above 0.');
        await api(`/api/events/${eventId}/crew-rates/${p.id}`, { method: 'PUT', body: { payType: e.type, rate: n } });
        setMsg(`${p.name}: ${money(n)}${e.type === 'day' ? ' per day' : '/hr'} on this event.`);
      }
      setEdit((x) => { const { [p.id]: _, ...rest } = x; return rest; });
      onSaved();
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy('');
    }
  };
  return (
    <div>
      <p className="muted small">
        Set a different pay for one person on this event: an hourly rate (overtime still applies) or a flat day rate. It replaces the role&apos;s rate and any rate on the shift, for this event only. They are told when their pay changes, and payroll uses it.
      </p>
      {err && <Banner onClose={() => setErr('')}>{err}</Banner>}
      {msg && <Banner kind="ok" onClose={() => setMsg('')}>{msg}</Banner>}
      {list.length === 0 ? (
        <Empty>No one is on this event yet. Add crew to a shift first.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Crew member</th><th>Default</th><th>Pay on this event</th><th></th></tr></thead>
            <tbody>
              {list.map((p) => {
                const e = cur(p.id);
                const saved = byUser.get(p.id);
                const dirty = !!edit[p.id];
                return (
                  <tr key={p.id}>
                    <td>{p.name}<div className="muted small">{p.roles.join(', ') || 'Not on a shift now'}</div></td>
                    <td className="small">{p.defaults.join(', ') || <span className="muted">—</span>}</td>
                    <td>
                      <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                        <select value={e.type} aria-label={`Pay type for ${p.name}`} onChange={(x) => setEdit({ ...edit, [p.id]: { type: x.target.value as 'default' | 'hourly' | 'day', rate: e.rate } })} style={{ width: 'auto' }}>
                          <option value="default">Role&apos;s rate</option>
                          <option value="hourly">Hourly</option>
                          <option value="day">Day rate</option>
                        </select>
                        {e.type !== 'default' && (
                          <span className="money-input">
                            <span aria-hidden="true">$</span>
                            <input type="number" min={0.01} max={100000} step="0.01" inputMode="decimal" value={e.rate} aria-label={`Rate for ${p.name}`} placeholder={e.type === 'day' ? '300.00' : '35.00'}
                              onChange={(x) => setEdit({ ...edit, [p.id]: { type: e.type, rate: x.target.value } })} style={{ width: '6.5rem' }} />
                            <span className="muted small">{e.type === 'day' ? '/day' : '/hr'}</span>
                          </span>
                        )}
                      </div>
                      {saved && !dirty && <div className="small" style={{ marginTop: 4 }}><span className="chip open">Own rate · {money(saved.rate)}{saved.pay_type === 'day' ? '/day' : '/hr'}</span></div>}
                    </td>
                    <td>
                      {dirty && (
                        <button className="btn small primary" disabled={busy === p.id} onClick={() => save(p)}>{busy === p.id ? 'Saving…' : 'Save'}</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
