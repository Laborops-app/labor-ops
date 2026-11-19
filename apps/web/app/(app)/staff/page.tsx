'use client';
import Link from 'next/link';
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import Shell from '@/components/Shell';
import Modal from '@/components/Modal';
import { Banner } from '@/components/ui';
import { askConfirm, show } from '@/components/Toasts';
import { api, fmtDate, fmtTime, Me } from '@/lib/api';
import { CardLine, hm, type CardDay, type CardItem } from '@/components/Timecard';

type Person = {
  id: string; name: string; email: string; phone: string | null; role: string; active: boolean;
  open: { id: string; since: string; onBreak: boolean } | null; weekMin: number; overtimeMin: number; unapproved: number; days: CardDay[];
};
type Data = { tz: string; week: { from: string; to: string }; weeklyOt: number; includeInPayroll: boolean; people: Person[] };
type CrewRow = { id: string; name: string; email: string; role: string; employment?: string; active: boolean };

const addDays = (d: string, n: number) => new Date(new Date(`${d}T12:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);
const toLocalInput = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : null);

/** Add or fix one stretch of staff time. */
function PunchForm({ person, item, onClose, onDone }: { person: Person; item: CardItem | null; onClose: () => void; onDone: () => void }) {
  const [tin, setTin] = useState(toLocalInput(item?.in ?? null) || toLocalInput(new Date(new Date().setHours(9, 0, 0, 0)).toISOString()));
  const [tout, setTout] = useState(item ? toLocalInput(item.out) : toLocalInput(new Date(new Date().setHours(17, 0, 0, 0)).toISOString()));
  const [note, setNote] = useState(item?.note ?? '');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setErr('');
    try {
      const body = { in: fromLocalInput(tin), out: fromLocalInput(tout), note: note.trim() || null, reason: reason.trim() || undefined };
      if (item) await api(`/api/staff/punches/${item.id}`, { method: 'PATCH', body });
      else await api('/api/staff/punches', { body: { ...body, userId: person.id } });
      show(item ? 'Time updated' : 'Time added');
      onDone(); onClose();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal title={`${item ? 'Fix' : 'Add'} time · ${person.name}`} onClose={onClose}>
      <div className="stack staff-form">
        <label className="small">Clock in<input type="datetime-local" value={tin} onChange={(e) => setTin(e.target.value)} /></label>
        <label className="small"><span>Clock out <span className="muted">(leave empty if they’re still on)</span></span><input type="datetime-local" value={tout} onChange={(e) => setTout(e.target.value)} /></label>
        <label className="small">Note<input value={note} onChange={(e) => setNote(e.target.value.slice(0, 500))} placeholder="Shown on their timecard" /></label>
        <label className="small"><span>Reason for the change <span className="muted">(goes in the Activity log)</span></span><input value={reason} onChange={(e) => setReason(e.target.value.slice(0, 200))} placeholder="e.g. Forgot to clock out" /></label>
        {err && <p className="cr-err" role="alert">{err}</p>}
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !tin} onClick={save}>{busy ? 'Saving…' : item ? 'Save' : 'Add time'}</button>
        </div>
      </div>
    </Modal>
  );
}

/** Add a new full-time staff member, or move someone from crew. */
function AddStaff({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [mode, setMode] = useState<'new' | 'move'>('new');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [crew, setCrew] = useState<CrewRow[]>([]);
  const [pick, setPick] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [temp, setTemp] = useState('');
  useEffect(() => { api<{ crew: CrewRow[] }>('/api/crew').then((r) => setCrew(r.crew.filter((m) => m.role === 'crew' && m.active && m.employment !== 'fulltime'))).catch(() => {}); }, []);
  const save = async () => {
    setBusy(true); setErr('');
    try {
      if (mode === 'new') {
        const r = await api<{ tempPassword?: string }>('/api/crew', { body: { name: name.trim(), email: email.trim(), phone: phone.trim() || null, role: 'crew', employment: 'fulltime' } });
        onDone();
        if (r.tempPassword) { setTemp(r.tempPassword); return; }
        show(`${name.trim()} added. They’ll get an email to set their password.`);
      } else {
        await api(`/api/crew/${pick}/employment`, { method: 'PUT', body: { employment: 'fulltime' } });
        show(`${crew.find((c) => c.id === pick)?.name} is now full-time staff`);
        onDone();
      }
      onClose();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  if (temp)
    return (
      <Modal title="Staff member added" onClose={onClose}>
        <p>They can sign in with their email and this temporary password, and they’ll land on the Time clock. They also get an email to set their own.</p>
        <p className="staff-temp"><code>{temp}</code></p>
        <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn primary" onClick={onClose}>Done</button></div>
      </Modal>
    );
  return (
    <Modal title="Add full-time staff" onClose={onClose}>
      <div className="stack staff-form">
        <div className="seg" role="tablist" aria-label="How to add">
          <button role="tab" aria-selected={mode === 'new'} className={mode === 'new' ? 'active' : ''} onClick={() => setMode('new')}>New person</button>
          <button role="tab" aria-selected={mode === 'move'} className={mode === 'move' ? 'active' : ''} onClick={() => setMode('move')}>Move from crew</button>
        </div>
        {mode === 'new' ? (
          <>
            <label className="small">Name<input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></label>
            <label className="small"><span>Email <span className="muted">(their login)</span></span><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
            <label className="small">Phone<input value={phone} onChange={(e) => setPhone(e.target.value)} /></label>
          </>
        ) : (
          <label className="small">Crew member
            <select value={pick} onChange={(e) => setPick(e.target.value)}>
              <option value="">Choose…</option>
              {crew.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
        )}
        <p className="muted small">Full-time staff sign in to their own Time clock. They don’t get crew offers or show in crew lists, and they’re left out of crew payroll exports unless you turn that on.</p>
        {err && <p className="cr-err" role="alert">{err}</p>}
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || (mode === 'new' ? !name.trim() || !email.trim() : !pick)} onClick={save}>{busy ? 'Saving…' : 'Add'}</button>
        </div>
      </div>
    </Modal>
  );
}

function Body({ me }: { me: Me }) {
  const [week, setWeek] = useState<string | null>(null);
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [edit, setEdit] = useState<{ person: Person; item: CardItem | null } | null>(null);
  const [adding, setAdding] = useState(false);
  const load = useCallback(() => api<Data>(`/api/staff${week ? `?week=${week}` : ''}`).then((r) => { setD(r); setErr(''); }).catch((e) => setErr((e as Error).message)), [week]);
  useEffect(() => { load(); const t = setInterval(() => document.visibilityState === 'visible' && load(), 30000); return () => clearInterval(t); }, [load]);

  const dates = useMemo(() => (d ? Array.from({ length: 7 }, (_, i) => addDays(d.week.from, i)) : []), [d]);
  const onNow = d?.people.filter((p) => p.open) ?? [];
  const run = async (fn: () => Promise<unknown>, msg: string) => { try { await fn(); show(msg); await load(); } catch (e) { show((e as Error).message, { error: true }); } };

  if (err && !d) return <Banner>{err}</Banner>;
  if (!d) return <div className="muted">Loading…</div>;
  const thisWeek = !week;
  return (
    <div className="staff-page">
      <div className="staff-top">
        <div className="row staff-week" style={{ gap: 6 }}>
          <button className="btn small" aria-label="Previous week" onClick={() => setWeek(addDays(d.week.from, -7))}>‹</button>
          <b>{fmtDate(d.week.from)} – {fmtDate(d.week.to)}</b>
          <button className="btn small" aria-label="Next week" onClick={() => setWeek(addDays(d.week.from, 7))}>›</button>
          {!thisWeek && <button className="btn-link small" onClick={() => setWeek(null)}>This week</button>}
        </div>
        <span className="spacer" />
        <a className="btn" href={`/api/staff/export?from=${d.week.from}&to=${d.week.to}`}>Export timecards (CSV)</a>
        <button className="btn primary" onClick={() => setAdding(true)}>+ Add staff</button>
      </div>

      <Banner kind="info">
        {d.includeInPayroll
          ? <>Full-time staff <b>are included</b> in crew payroll exports. </>
          : <>Full-time staff are <b>left out</b> of crew payroll exports. Use “Export timecards” for their hours. </>}
        {me.role === 'admin'
          ? <button className="btn-link" onClick={() => run(() => api('/api/payroll/include-fulltime', { method: 'PUT', body: { include: !d.includeInPayroll } }), d.includeInPayroll ? 'Full-time staff will be left out of payroll exports' : 'Full-time staff will be included in payroll exports')}>{d.includeInPayroll ? 'Leave them out' : 'Include them'}</button>
          : <span className="muted">An admin can change this.</span>}
      </Banner>

      <section className="card staff-now">
        <h2>On the clock now <span className="muted small">{onNow.length} of {d.people.length}</span></h2>
        {!onNow.length ? <p className="muted">Nobody is clocked in.</p> : (
          <ul className="staff-now-list">
            {onNow.map((p) => (
              <li key={p.id} className={p.open!.onBreak ? 'break' : ''}>
                <span className="dot" aria-hidden="true" />
                <b>{p.name}</b>
                <span className="muted small">{p.open!.onBreak ? 'on break' : 'since'} {fmtTime(p.open!.since)}</span>
                <button className="btn small" onClick={async () => { if (await askConfirm(`Clock ${p.name} out now?`, { ok: 'Clock out' })) run(() => api(`/api/staff/${p.id}/clock-out`, { body: {} }), `${p.name} clocked out`); }}>Clock out</button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card staff-grid-card">
        {!d.people.length ? (
          <div className="staff-empty">
            <p><b>No full-time staff yet.</b></p>
            <p className="muted">Add the people on regular payroll. They get their own login and Time clock, and stay out of crew lists, offers and crew payroll.</p>
            <button className="btn primary" onClick={() => setAdding(true)}>+ Add staff</button>
          </div>
        ) : (
          <div className="staff-scroll">
            <table className="staff-grid">
              <thead>
                <tr>
                  <th scope="col">Staff</th>
                  {dates.map((x) => <th key={x} scope="col">{fmtDate(x).replace(/,.*/, '')}<span>{x.slice(8)}</span></th>)}
                  <th scope="col">Week</th>
                  <th scope="col"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {d.people.map((p) => {
                  const byDate = new Map(p.days.map((x) => [x.date, x]));
                  const isOpen = open === p.id;
                  return (
                    <Fragment key={p.id}>
                      <tr className={isOpen ? 'open' : ''}>
                        <th scope="row">
                          <button className="staff-name" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : p.id)}>
                            <span className={`dot${p.open ? (p.open.onBreak ? ' break' : ' on') : ''}`} aria-label={p.open ? (p.open.onBreak ? 'On break' : 'On the clock') : 'Off the clock'} />
                            {p.name}
                          </button>
                          {!p.active && <span className="muted small"> · inactive</span>}
                        </th>
                        {dates.map((x) => {
                          const day = byDate.get(x);
                          return <td key={x} className={day ? '' : 'none'}>{day ? hm(day.minutes) : '–'}</td>;
                        })}
                        <td className="wk">
                          <b>{hm(p.weekMin)}</b>
                          {p.overtimeMin > 0 && <span className="tc-warn small"> {hm(p.overtimeMin)} OT</span>}
                        </td>
                        <td className="acts">
                          {p.unapproved > 0
                            ? <button className="btn small primary" onClick={() => run(() => api('/api/staff/approve', { body: { userId: p.id, from: d.week.from, to: d.week.to } }), `Approved ${p.name}’s week`)}>Approve {p.unapproved}</button>
                            : p.days.length ? <span className="tc-ok small">✓ Approved</span> : null}
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="staff-card-row">
                          <td colSpan={dates.length + 3}>
                            <div className="staff-card">
                              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                                <span className="muted small">{p.email}{p.phone ? ` · ${p.phone}` : ''}</span>
                                <span className="spacer" />
                                <Link className="btn small" href={`/crew/${p.id}`}>Profile</Link>
                                <button className="btn small" onClick={() => setEdit({ person: p, item: null })}>+ Add time</button>
                                {p.days.some((x) => x.items.some((i) => i.status === 'approved'))
                                  && <button className="btn small" onClick={() => run(() => api('/api/staff/approve', { body: { userId: p.id, from: d.week.from, to: d.week.to, undo: true } }), 'Unapproved')}>Unapprove week</button>}
                              </div>
                              {!p.days.length && <p className="muted">No time this week.</p>}
                              {p.days.map((day) => (
                                <div key={day.date} className="tc-day">
                                  <div className="tc-dayhead"><b>{fmtDate(day.date)}</b><span>{hm(day.minutes)}</span></div>
                                  <ul className="tc-lines">
                                    {day.items.map((i) => (
                                      <CardLine key={i.id} i={i}>
                                        {i.kind === 'punch' ? (
                                          <span className="tc-acts">
                                            <button className="btn-link small" onClick={() => setEdit({ person: p, item: i })}>Edit</button>
                                            <button className="btn-link small danger" onClick={async () => { if (await askConfirm(`Delete this time (${fmtTime(i.in)} – ${i.out ? fmtTime(i.out) : 'now'})?`, { danger: true, ok: 'Delete' })) run(() => api(`/api/staff/punches/${i.id}`, { method: 'DELETE' }), 'Time deleted'); }}>Delete</button>
                                          </span>
                                        ) : <span className="tc-acts"><Link className="btn-link small" href={`/events/${i.eventId}`}>Event</Link></span>}
                                      </CardLine>
                                    ))}
                                  </ul>
                                </div>
                              ))}
                              {p.days.some((x) => x.items.some((i) => i.kind === 'event')) && <p className="muted small">Event time is fixed on the event’s timesheet. Where it overlaps their time clock, the hours count once.</p>}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {edit && <PunchForm person={edit.person} item={edit.item} onClose={() => setEdit(null)} onDone={load} />}
      {adding && <AddStaff onClose={() => setAdding(false)} onDone={load} />}
    </div>
  );
}

export default function Page() {
  return <Shell roles={['admin', 'manager', 'hr']}>{(me) => <Body me={me} />}</Shell>;
}
