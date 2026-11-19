'use client';
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { api } from '@/lib/api';
import { show, askConfirm } from '@/components/Toasts';

/*
 * Standing pay and bill rates per person per skill. Used on every event; a rate set on one event (event › Crew pay)
 * still wins there. A change starts on a date, so earlier shifts keep the rate they were worked at.
 */

type PayType = 'hourly' | 'day';
type Rate = { id: string; payType: PayType; rate: number | null; billRate?: number | null; startsOn: string; note: string | null; setBy?: string | null; setAt?: string };
type RoleRates = { payRate: number | null; dayRate: number | null; billRate: number | null; dayBillRate: number | null };
type SkillRates = { skillId: string; name: string; hasSkill: boolean; role: RoleRates; current: Rate | null; upcoming: Rate[]; history: Rate[] };

const money = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD' }));
const per = (t: PayType) => (t === 'day' ? '/day' : '/hr');
const fmtDay = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const std = (r: RoleRates, t: PayType, side: 'pay' | 'bill') => (side === 'pay' ? (t === 'day' ? r.dayRate : r.payRate) : (t === 'day' ? r.dayBillRate : r.billRate));

/** The little form used by the profile and the grid. */
function RateForm({ userId, skillId, role, current, today, onSaved, onCancel, compact }: {
  userId: string; skillId: string; role: RoleRates; current: Rate | null; today: string; onSaved: () => void; onCancel: () => void; compact?: boolean;
}) {
  const [payType, setPayType] = useState<PayType>(current?.payType ?? 'hourly');
  const [rate, setRate] = useState(current?.rate != null ? String(current.rate) : '');
  const [bill, setBill] = useState(current?.billRate != null ? String(current.billRate) : '');
  const [startsOn, setStartsOn] = useState(today);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const num = (v: string) => (v.trim() === '' ? null : Math.round(Number(v) * 100) / 100);
  const save = async () => {
    const r = num(rate), b = num(bill);
    if ((r !== null && !(r > 0)) || (b !== null && !(b > 0))) { setErr('Rates must be more than $0, or left empty for the standard rate.'); return; }
    setBusy(true); setErr('');
    try {
      await api(`/api/crew/${userId}/rates`, { method: 'PUT', body: { skillId, payType, rate: r, billRate: b, startsOn, note: note.trim() || null } });
      show(startsOn > today ? `Saved. It starts ${fmtDay(startsOn)}.` : 'Rate saved.');
      onSaved();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className={`cr-form${compact ? ' compact' : ''}`}>
      <div className="cr-form-row">
        <label>Paid
          <select value={payType} onChange={(e) => setPayType(e.target.value as PayType)}><option value="hourly">Hourly</option><option value="day">Day rate</option></select>
        </label>
        <label>Their pay
          <span className="cr-money"><i>$</i><input inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value.replace(/[^\d.]/g, ''))} placeholder={std(role, payType, 'pay') != null ? String(std(role, payType, 'pay')) : 'Standard'} aria-label="Their pay rate" /><em>{per(payType)}</em></span>
        </label>
        <label>Bill client
          <span className="cr-money"><i>$</i><input inputMode="decimal" value={bill} onChange={(e) => setBill(e.target.value.replace(/[^\d.]/g, ''))} placeholder={std(role, payType, 'bill') != null ? String(std(role, payType, 'bill')) : 'Standard'} aria-label="Their bill rate" /><em>{per(payType)}</em></span>
        </label>
        <label>Starts
          <input type="date" value={startsOn} onChange={(e) => e.target.value && setStartsOn(e.target.value)} aria-label="Starts on" />
        </label>
      </div>
      {!compact && <input className="cr-note" value={note} onChange={(e) => setNote(e.target.value.slice(0, 200))} placeholder="Note (optional), e.g. raise after review" aria-label="Note" />}
      <p className="muted small">Leave a box empty to use the standard rate for this role. Shifts before the start date keep the rate they were worked at.</p>
      {err && <p className="cr-err" role="alert">{err}</p>}
      <div className="cr-form-acts">
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
        <button type="button" className="btn primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save rate'}</button>
      </div>
    </div>
  );
}

/** Crew profile: this person's rate for each skill they have. Admins, HR and coordinators allowed to adjust rates. */
export function CrewPayRates({ userId }: { userId: string }) {
  const [d, setD] = useState<{ today: string; skills: SkillRates[]; canEdit: boolean; otherSkills: { id: string; name: string }[] } | null>(null);
  const [hidden, setHidden] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [add, setAdd] = useState('');
  const load = useCallback(() => api<NonNullable<typeof d>>(`/api/crew/${userId}/rates`).then(setD).catch(() => setHidden(true)), [userId]);
  useEffect(() => { load(); }, [load]);
  if (hidden || !d) return null;
  const extra = add ? d.otherSkills.find((k) => k.id === add) : null;
  const rows: SkillRates[] = extra ? [...d.skills, { skillId: extra.id, name: extra.name, hasSkill: false, role: { payRate: null, dayRate: null, billRate: null, dayBillRate: null }, current: null, upcoming: [], history: [] }] : d.skills;
  const remove = async (r: Rate, skill: string) => {
    if (!(await askConfirm(`Remove the ${skill} rate starting ${fmtDay(r.startsOn)}? The rate before it applies again.`))) return;
    try { await api(`/api/crew/${userId}/rates/${r.id}`, { method: 'DELETE' }); show('Rate removed.'); load(); } catch (e) { show((e as Error).message, { error: true }); }
  };
  return (
    <section className="card" id="pay">
      <h2>Pay rates</h2>
      <p className="muted small">Their own pay and bill rate for each position, used on every event. A rate set on one event (event › Crew pay) still wins there. They see their own pay rates, never the bill rate.</p>
      {rows.length === 0 ? <p className="muted">No skills on this profile yet.</p> : (
        <div className="table-wrap">
          <table className="table cr-table">
            <thead><tr><th>Position</th><th>Standard pay</th><th>Their pay</th><th>Standard bill</th><th>Their bill</th><th>Since</th>{d.canEdit && <th aria-label="Actions" />}</tr></thead>
            <tbody>
              {rows.map((s) => {
                const c = s.current;
                const t = c?.payType ?? 'hourly';
                return (
                  <Fragment key={s.skillId}>
                    <tr>
                      <td><b>{s.name}</b>{!s.hasSkill && <span className="muted small"> (not one of their positions)</span>}</td>
                      <td className="muted">{money(std(s.role, t, 'pay'))}{std(s.role, t, 'pay') != null ? per(t) : ''}</td>
                      <td>{c?.rate != null ? <span className="cr-own">{money(c.rate)}{per(c.payType)}</span> : <span className="muted">Standard</span>}</td>
                      <td className="muted">{money(std(s.role, t, 'bill'))}{std(s.role, t, 'bill') != null ? per(t) : ''}</td>
                      <td>{c?.billRate != null ? <span className="cr-own">{money(c.billRate)}{per(c.payType)}</span> : <span className="muted">Standard</span>}</td>
                      <td className="small">{c ? fmtDay(c.startsOn) : '—'}
                        {s.upcoming.map((u) => <div key={u.id} className="cr-next">From {fmtDay(u.startsOn)}: {u.rate != null ? `${money(u.rate)}${per(u.payType)}` : 'standard pay'}{u.billRate != null ? ` · bill ${money(u.billRate)}` : ''}</div>)}
                      </td>
                      {d.canEdit && (
                        <td className="cr-acts">
                          <button type="button" className="btn small" onClick={() => { setEditing(editing === s.skillId ? null : s.skillId); setOpen(null); }}>{c || s.upcoming.length ? 'Change' : 'Set rate'}</button>
                          {s.history.length > 0 && <button type="button" className="cr-link" aria-expanded={open === s.skillId} onClick={() => { setOpen(open === s.skillId ? null : s.skillId); setEditing(null); }}>History</button>}
                        </td>
                      )}
                    </tr>
                    {editing === s.skillId && (
                      <tr className="cr-sub"><td colSpan={7}>
                        <RateForm userId={userId} skillId={s.skillId} role={s.role} current={c} today={d.today} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); setAdd(''); load(); }} />
                      </td></tr>
                    )}
                    {open === s.skillId && (
                      <tr className="cr-sub"><td colSpan={7}>
                        <ul className="cr-hist">
                          {s.history.map((h) => (
                            <li key={h.id}>
                              <b>{fmtDay(h.startsOn)}</b>: pay {h.rate != null ? `${money(h.rate)}${per(h.payType)}` : 'standard'}, bill {h.billRate != null ? `${money(h.billRate)}${per(h.payType)}` : 'standard'}
                              {h.note && <> · “{h.note}”</>}
                              {h.setBy && <span className="muted"> · set by {h.setBy}</span>}
                              {d.canEdit && <button type="button" className="cr-link danger" onClick={() => remove(h, s.name)}>Remove</button>}
                            </li>
                          ))}
                        </ul>
                      </td></tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {d.canEdit && d.otherSkills.length > 0 && !extra && (
        <div className="row" style={{ marginTop: 10 }}>
          <select value={add} onChange={(e) => { setAdd(e.target.value); setEditing(e.target.value); }} aria-label="Set a rate for another position" style={{ maxWidth: 260 }}>
            <option value="">Set a rate for another position…</option>
            {d.otherSkills.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
          </select>
        </div>
      )}
    </section>
  );
}

type Cell = { hasSkill: boolean; current: Rate | null; upcoming: Rate | null };
type Grid = {
  today: string; groups: { id: string; name: string }[]; canEdit: boolean;
  skills: ({ id: string; name: string } & RoleRates)[]; people: { id: string; name: string }[]; cells: Record<string, Record<string, Cell>>;
};

/** Positions & pay rates › Crew rates: people down the side, positions across the top. Click a cell to set that person's rate. */
export function CrewRatesGrid() {
  const [g, setG] = useState<Grid | null>(null);
  const [err, setErr] = useState('');
  const [group, setGroup] = useState('');
  const [skill, setSkill] = useState('');
  const [q, setQ] = useState('');
  const [qq, setQq] = useState('');
  const [onlyOwn, setOnlyOwn] = useState(false);
  const [edit, setEdit] = useState<{ userId: string; name: string; skillId: string; rect: DOMRect } | null>(null);
  const pop = useRef<HTMLDivElement>(null);
  useEffect(() => { const t = setTimeout(() => setQq(q.trim()), 250); return () => clearTimeout(t); }, [q]);
  const load = useCallback(() => {
    const p = new URLSearchParams();
    if (group) p.set('group', group);
    if (skill) p.set('skill', skill);
    if (qq) p.set('q', qq);
    if (onlyOwn) p.set('onlyOwn', '1');
    api<Grid>(`/api/rates/grid?${p}`).then((x) => { setG(x); setErr(''); }).catch((e) => setErr(e.message));
  }, [group, skill, qq, onlyOwn]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!edit) return;
    const off = (e: MouseEvent) => { if (!pop.current?.contains(e.target as Node)) setEdit(null); };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setEdit(null);
    const t = setTimeout(() => document.addEventListener('mousedown', off), 0);
    document.addEventListener('keydown', esc);
    return () => { clearTimeout(t); document.removeEventListener('mousedown', off); document.removeEventListener('keydown', esc); };
  }, [edit]);

  const allSkills = g?.skills ?? [];
  const cols = allSkills;
  const sk = edit ? allSkills.find((k) => k.id === edit.skillId) : null;
  const cell = edit && g ? g.cells[edit.userId]?.[edit.skillId] ?? null : null;
  return (
    <section className="card" id="crew-rates">
      <h2>Crew rates</h2>
      <p className="muted small">Each person&apos;s own pay and bill rate per position, used on every event. Empty cells use the standard rate (shown in grey). Click a cell to change it; a change can start on a later date. Rates set for one event (event › Crew pay) still win on that event.</p>
      <div className="cr-filters">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a person" aria-label="Find a person" />
        <select value={group} onChange={(e) => setGroup(e.target.value)} aria-label="Group">
          <option value="">All groups</option>
          {g?.groups.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
        <select value={skill} onChange={(e) => setSkill(e.target.value)} aria-label="Position">
          <option value="">All positions</option>
          {(g && !skill ? g.skills : allSkills).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
        <label className="check"><input type="checkbox" checked={onlyOwn} onChange={(e) => setOnlyOwn(e.target.checked)} /> Only people with their own rates</label>
      </div>
      {err && <p className="cr-err" role="alert">{err}</p>}
      {!g ? <p className="muted">Loading…</p> : g.people.length === 0 ? <p className="muted">Nobody matches.</p> : (
        <div className="cr-grid-wrap">
          <table className="cr-grid">
            <thead>
              <tr>
                <th className="cr-name">Person</th>
                {cols.map((k) => (
                  <th key={k.id}><span>{k.name}</span><small>{k.payRate != null ? `${money(k.payRate)}/hr` : k.dayRate != null ? `${money(k.dayRate)}/day` : 'no rate'}</small></th>
                ))}
              </tr>
            </thead>
            <tbody>
              {g.people.map((p) => (
                <tr key={p.id}>
                  <th className="cr-name" scope="row"><Link href={`/crew/${p.id}#pay`}>{p.name}</Link></th>
                  {cols.map((k) => {
                    const c = g.cells[p.id]?.[k.id];
                    const own = c?.current;
                    const hasOwn = own && (own.rate != null || own.billRate != null);
                    const label = hasOwn ? `${own!.rate != null ? `${money(own!.rate)}${per(own!.payType)}` : 'std pay'}` : c ? 'Standard' : '';
                    return (
                      <td key={k.id} className={`${hasOwn ? 'own' : c ? 'std' : 'none'}`}>
                        <button type="button" disabled={!g.canEdit} title={c?.upcoming ? `From ${fmtDay(c.upcoming.startsOn)}: ${c.upcoming.rate != null ? money(c.upcoming.rate) + per(c.upcoming.payType) : 'standard pay'}` : undefined}
                          aria-label={`${p.name}, ${k.name}: ${label || 'not set'}`}
                          onClick={(e) => setEdit({ userId: p.id, name: p.name, skillId: k.id, rect: e.currentTarget.getBoundingClientRect() })}>
                          {label || <span aria-hidden="true">·</span>}
                          {hasOwn && own!.billRate != null && <small>bill {money(own!.billRate)}</small>}
                          {c?.upcoming && <i className="cr-dot" aria-hidden="true" />}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {edit && sk && g && typeof document !== 'undefined' && createPortal(
        <div ref={pop} className="cr-pop" role="dialog" aria-label={`${edit.name}, ${sk.name}`}
          style={{ top: edit.rect.bottom + 6 + window.scrollY, left: Math.max(8, Math.min(edit.rect.left, window.innerWidth - 560)) }}>
          <h3>{edit.name} · {sk.name}</h3>
          <RateForm compact userId={edit.userId} skillId={sk.id} role={sk} current={cell?.current ?? null} today={g.today} onCancel={() => setEdit(null)} onSaved={() => { setEdit(null); load(); }} />
        </div>,
        document.body,
      )}
    </section>
  );
}

/** Crew: their own pay rates on their profile. */
export function MyRates() {
  const [r, setR] = useState<{ skill: string; own: { payType: PayType; rate: number; since: string } | null; standard: { hourly: number | null; day: number | null }; upcoming: { payType: PayType; rate: number; startsOn: string } | null }[] | null>(null);
  useEffect(() => { api<{ rates: NonNullable<typeof r> }>('/api/my/rates').then((x) => setR(x.rates)).catch(() => setR([])); }, []);
  if (!r || !r.length) return null;
  return (
    <section className="card" id="my-rates">
      <h2>My pay rates</h2>
      <ul className="cr-mine">
        {r.map((x) => (
          <li key={x.skill}>
            <b>{x.skill}</b>
            <span>
              {x.own ? <>{money(x.own.rate)}{per(x.own.payType)} <span className="cr-own small">Your rate</span></>
                : x.standard.hourly != null ? <>{money(x.standard.hourly)}/hr</> : x.standard.day != null ? <>{money(x.standard.day)}/day</> : <span className="muted">Set per job</span>}
            </span>
            {x.upcoming && <small className="muted">From {fmtDay(x.upcoming.startsOn)}: {money(x.upcoming.rate)}{per(x.upcoming.payType)}</small>}
          </li>
        ))}
      </ul>
      <p className="muted small">A job can pay a different rate; your shift offers show the pay for that job. Overtime rules apply to hourly pay.</p>
    </section>
  );
}
