'use client';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import Shell from '@/components/Shell';
import { Banner, Pill } from '@/components/ui';
import CustomerSelect from '@/components/CustomerSelect';
import { api, money } from '@/lib/api';

type Line = { section: string; description: string; day: string; start: string; end: string; qty: string; hours: string; rate: string };
type Skill = { id: string; name: string; active: boolean; groupId: string | null; billRate?: number };
const span = (a: string, b: string) => { const m = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3)); let d = m(b) - m(a); if (d <= 0) d += 1440; return Math.round((d / 60) * 100) / 100; };
type Totals = { subtotal: number; discount: number; tax: number; total: number };
type Detail = {
  quote: { id: string; number: number; title: string; status: string; customer_id: string | null; customer_email: string | null; customer_name: string | null; event_id: string | null; event_name: string | null; valid_until: string | null; intro: string | null; terms: string | null; tax_pct: number; discount: number; sent_at: string | null; sent_to: string | null; responded_at: string | null; response_note: string | null; layout_id: string | null };
  lines: { section: string | null; description: string; day: string | null; startTime: string | null; endTime: string | null; qty: number; hours: number; rate: number }[];
  totals: Totals;
  link: string;
  canAdjustRates?: boolean;
  roleRates?: { name: string; payRate: number; billRate: number }[];
};

const hrsOf = (l: { start: string; end: string; hours: string }) => (l.start && l.end ? span(l.start, l.end) : Number(l.hours) || 0);
const n = (s: string) => (Number.isFinite(Number(s)) ? Number(s) : 0);
const r2 = (x: number) => Math.round(x * 100) / 100;

function Body() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [d, setD] = useState<Detail | null>(null);
  const [f, setF] = useState({ title: '', customerId: null as string | null, validUntil: '', intro: '', terms: '', taxPct: '0', discount: '0' });
  const [lines, setLines] = useState<Line[]>([]);
  const [to, setTo] = useState('');
  const [people, setPeople] = useState<{ id: string; name: string; email: string | null; is_primary: boolean }[]>([]);
  const [msg, setMsg] = useState('');
  const [dirty, setDirty] = useState(false);
  const [layoutId, setLayoutId] = useState('');
  const [canAdj, setCanAdj] = useState(false);
  const [roleRates, setRoleRates] = useState<{ name: string; payRate: number; billRate: number }[]>([]);
  const [qr, setQr] = useState<Record<string, { pay: string; bill: string }>>({});
  const [layouts, setLayouts] = useState<{ id: string; name: string; is_default: boolean }[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [groups, setGroups] = useState<{ id: string; name: string }[]>([]);
  const [tab, setTab] = useState('');
  const [extra, setExtra] = useState<string[]>([]);
  const [newSec, setNewSec] = useState('');
  const [nl, setNl] = useState({ role: '', other: false, day: '', start: '08:00', end: '16:00', qty: '1', rate: '0' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  const apply = (r: Detail) => {
    if (r.canAdjustRates !== undefined) { setCanAdj(r.canAdjustRates); setRoleRates(r.roleRates ?? []); }
    setD((p) => ({ ...r, link: r.link ?? p?.link ?? '' }));
    const q = r.quote;
    setF({ title: q.title, customerId: q.customer_id, validUntil: q.valid_until ? String(q.valid_until).slice(0, 10) : '', intro: q.intro ?? '', terms: q.terms ?? '', taxPct: String(q.tax_pct), discount: String(q.discount) });
    setLines(r.lines.map((l) => ({ section: l.section ?? '', description: l.description, day: l.day ?? '', start: l.startTime ?? '', end: l.endTime ?? '', qty: String(l.qty), hours: String(l.hours), rate: String(l.rate) })));
    setLayoutId(q.layout_id ?? '');
    setDirty(false);
  };
  const load = () => api<Detail>(`/api/quotes/${id}`).then(apply).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [id]);
  useEffect(() => {
    api<{ layouts: typeof layouts }>('/api/quote-layouts').then((r) => setLayouts(r.layouts)).catch(() => {});
    api<{ skills: Skill[]; groups: typeof groups }>('/api/skills').then((r) => { setSkills(r.skills.filter((x) => x.active)); setGroups(r.groups); }).catch(() => {});
  }, []);
  const cid = d?.quote.customer_id;
  useEffect(() => {
    setPeople([]);
    if (cid) api<{ contacts: typeof people }>(`/api/customers/${cid}`).then((r) => setPeople(r.contacts.filter((p) => p.email))).catch(() => {});
  }, [cid]);

  const edit = <T,>(fn: (v: T) => void) => (v: T) => { fn(v); setDirty(true); };
  const setLine = (i: number, patch: Partial<Line>) => { setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l))); setDirty(true); };

  const skillIds = Object.fromEntries(skills.map((x) => [x.name.toLowerCase(), x.id]));
  const isRole = (name: string) => skills.some((x) => x.name.toLowerCase() === name.trim().toLowerCase());
  const sections = [...new Set([...lines.map((l) => l.section.trim()).filter(Boolean), ...extra])];
  const shown = lines.map((l, i) => ({ l, i })).filter(({ l }) => !tab || l.section.trim() === tab);
  const roleGroups = (() => {
    const out = groups.map((g) => ({ label: g.name, roles: skills.filter((x) => x.groupId === g.id) })).filter((g) => g.roles.length);
    const loose = skills.filter((x) => !x.groupId || !groups.some((g) => g.id === x.groupId));
    if (loose.length) out.push({ label: out.length ? 'Other roles' : 'Roles', roles: loose });
    return out;
  })();
  const addSection = () => {
    const name = newSec.trim();
    if (!name) return;
    if (!sections.includes(name)) setExtra([...extra, name]);
    setTab(name);
    setNewSec('');
  };
  const addLine = (e: React.FormEvent) => {
    e.preventDefault();
    const day = nl.day || [...lines].reverse().find((l) => l.day)?.day || '';
    setLines([...lines, { section: tab, description: nl.role.trim(), day, start: nl.start, end: nl.end, qty: nl.qty || '1', hours: '0', rate: nl.rate || '0' }]);
    setNl({ ...nl, role: '', other: nl.other, day });
    setDirty(true);
  };

  const live = (() => {
    const subtotal = r2(lines.reduce((a, l) => a + n(l.qty) * hrsOf(l) * n(l.rate), 0));
    const disc = Math.min(n(f.discount), subtotal);
    const tax = r2((subtotal - disc) * n(f.taxPct) / 100);
    return { subtotal, discount: r2(disc), tax, total: r2(subtotal - disc + tax) };
  })();

  const save = async (): Promise<boolean> => {
    setError('');
    setBusy(true);
    try {
      const r = await api<Detail>(`/api/quotes/${id}`, {
        method: 'PUT',
        body: {
          title: f.title, customerId: f.customerId, validUntil: f.validUntil || null, intro: f.intro || null, terms: f.terms || null, taxPct: n(f.taxPct), discount: n(f.discount),
          layoutId: layoutId || null,
          lines: lines.filter((l) => l.description.trim()).map((l) => ({ section: l.section.trim() || null, description: l.description.trim(), day: l.day || null, startTime: l.day && l.start && l.end ? l.start : l.start && l.end ? l.start : null, endTime: l.start && l.end ? l.end : null, qty: n(l.qty), hours: l.start && l.end ? span(l.start, l.end) : n(l.hours), rate: n(l.rate) })),
        },
      });
      apply(r);
      return true;
    } catch (e) { setError((e as Error).message); return false; } finally { setBusy(false); }
  };

  if (!d) return error ? <Banner>{error}</Banner> : <div className="muted">Loading…</div>;
  const q = d.quote;
  const email = to || q.customer_email || '';
  const send = async () => {
    if (dirty && !(await save())) return;
    setBusy(true);
    try {
      const r = await api<{ sentTo: string }>(`/api/quotes/${id}/send`, { body: { to: to || undefined, message: msg || undefined } });
      setNote(`Sent to ${r.sentTo}.`);
      await load();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <>
      <p className="small"><Link href="/quotes">← Quotes</Link></p>
      <div className="row space">
        <h1>Quote #{q.number} <Pill status={q.status} /></h1>
        <button className="btn ghost small danger" onClick={() => confirm('Delete this quote?') && api(`/api/quotes/${id}`, { method: 'DELETE' }).then(() => router.replace('/quotes')).catch((e) => setError(e.message))}>Delete</button>
      </div>
      {q.status === 'accepted' && <Banner kind="ok">Accepted by the customer{q.responded_at ? ` on ${new Date(q.responded_at).toLocaleDateString()}` : ''}.{q.response_note ? ` They wrote: "${q.response_note}"` : ''}</Banner>}
      {q.status === 'declined' && <Banner>Declined by the customer.{q.response_note ? ` They wrote: "${q.response_note}"` : ''}</Banner>}
      {q.status === 'sent' && <Banner kind="info">Sent to {q.sent_to}. Waiting for the customer. Changing the quote puts it back to draft so you can send the new version.</Banner>}
      {error && <Banner onClose={() => setError('')}>{error}</Banner>}
      {note && <Banner kind="ok" onClose={() => setNote('')}>{note}</Banner>}

      <section className="card">
        <div className="grid-form">
          <label>Title<input value={f.title} onChange={(e) => edit(setF)({ ...f, title: e.target.value })} maxLength={200} required /></label>
          <CustomerSelect value={f.customerId} onPick={(c) => edit(setF)({ ...f, customerId: c?.id ?? null })} />
          <label>Valid until<input type="date" value={f.validUntil} onChange={(e) => edit(setF)({ ...f, validUntil: e.target.value })} /></label>
        </div>
        {q.event_id && <p className="small muted">Built from <Link href={`/events/${q.event_id}`}>{q.event_name}</Link>. <button className="btn ghost small" onClick={() => confirm('Replace the lines with the event\'s current shifts?') && api<Detail>(`/api/quotes/${id}/refresh-lines`, { body: {} }).then(apply).catch((e) => setError(e.message))}>Rebuild lines from its shifts</button></p>}
        <label>Message at the top<textarea rows={3} value={f.intro} onChange={(e) => edit(setF)({ ...f, intro: e.target.value })} maxLength={5000} placeholder="Thanks for the opportunity. Here is our labor estimate for …" /></label>
      </section>

      <section className="card">
        <h2>Shifts and line items</h2>
        <p className="muted small">Laid out like an event: one tab per phase, with a role, date, start and end time and the number of people on each line. Rates come from each role's billing rate.</p>
        <div className="phase-tabs" role="tablist" aria-label="Quote sections">
          <button type="button" role="tab" aria-selected={tab === ''} className={tab === '' ? 'tab on' : 'tab'} onClick={() => setTab('')}>All</button>
          {sections.map((sec) => (
            <button key={sec} type="button" role="tab" aria-selected={tab === sec} className={tab === sec ? 'tab on' : 'tab'} onClick={() => setTab(sec)}>{sec}</button>
          ))}
          <span className="row" style={{ gap: '.3rem' }}>
            <input value={newSec} onChange={(e) => setNewSec(e.target.value)} placeholder="+ New section" aria-label="New section name" style={{ width: '9rem' }} maxLength={80}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addSection(); } }} />
            {newSec.trim() && <button className="btn small" onClick={addSection}>Add</button>}
          </span>
        </div>
        <form className="grid-form" style={{ marginTop: '.75rem' }} onSubmit={addLine}>
          <label>Role
            {skills.length > 0 && !nl.other ? (
              <select value={nl.role} required onChange={(e) => {
                if (e.target.value === '__other') return setNl({ ...nl, other: true, role: '' });
                const sk = skills.find((x) => x.name === e.target.value);
                setNl({ ...nl, role: e.target.value, rate: String(sk?.billRate ?? 0) });
              }}>
                <option value="">Choose a role…</option>
                {roleGroups.map((g) => <optgroup key={g.label} label={g.label}>{g.roles.map((r) => <option key={r.name} value={r.name}>{r.name}</option>)}</optgroup>)}
                <option value="__other">Other (type a name)…</option>
              </select>
            ) : <input value={nl.role} onChange={(e) => setNl({ ...nl, role: e.target.value })} placeholder="Travel, per diem, equipment…" required />}
          </label>
          <label>Date<input type="date" value={nl.day} onChange={(e) => setNl({ ...nl, day: e.target.value })} /></label>
          <label>Starts<input type="time" value={nl.start} onChange={(e) => setNl({ ...nl, start: e.target.value })} /></label>
          <label>Ends<input type="time" value={nl.end} onChange={(e) => setNl({ ...nl, end: e.target.value })} /></label>
          <label>People<input type="number" min={0} step="1" value={nl.qty} onChange={(e) => setNl({ ...nl, qty: e.target.value })} /></label>
          <label>Rate / hr<input type="number" min={0} step="0.01" value={nl.rate} disabled={!canAdj && isRole(nl.role)} onChange={(e) => setNl({ ...nl, rate: e.target.value })} /></label>
          <div className="form-actions"><button className="btn primary">Add to {tab || 'quote'}</button></div>
        </form>
        {shown.length > 0 && (
          <div style={{ overflowX: 'auto', marginTop: '.75rem' }}>
            <table className="table">
              <thead><tr>{!tab && <th>Section</th>}<th>Role / item</th><th>Date</th><th>Start</th><th>End</th><th>People</th><th>Hours</th><th>Rate/hr</th><th style={{ textAlign: 'right' }}>Amount</th><th></th></tr></thead>
              <tbody>
                {shown.map(({ l, i }) => (
                  <tr key={i}>
                    {!tab && <td><input value={l.section} onChange={(e) => setLine(i, { section: e.target.value })} aria-label="Section" style={{ width: '7rem' }} /></td>}
                    <td><input value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} aria-label="Role or item" maxLength={300} style={{ minWidth: '10rem' }} /></td>
                    <td><input type="date" value={l.day} onChange={(e) => setLine(i, { day: e.target.value })} aria-label="Date" /></td>
                    <td><input type="time" value={l.start} onChange={(e) => setLine(i, { start: e.target.value })} aria-label="Start" /></td>
                    <td><input type="time" value={l.end} onChange={(e) => setLine(i, { end: e.target.value })} aria-label="End" /></td>
                    <td><input type="number" min={0} step="1" value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} aria-label="People" style={{ width: '4.5rem' }} /></td>
                    <td><input type="number" min={0} step="0.25" value={l.start && l.end ? String(span(l.start, l.end)) : l.hours} disabled={!!(l.start && l.end)} onChange={(e) => setLine(i, { hours: e.target.value })} aria-label="Hours" style={{ width: '5rem' }} /></td>
                    <td><input type="number" min={0} step="0.01" value={l.rate} onChange={(e) => setLine(i, { rate: e.target.value })} aria-label="Rate per hour" disabled={!canAdj && isRole(l.description)} title={!canAdj && isRole(l.description) ? 'Rates are set by an admin' : ''} style={{ width: '5.5rem' }} /></td>
                    <td style={{ textAlign: 'right' }}>{money(r2(n(l.qty) * hrsOf(l) * n(l.rate)))}</td>
                    <td><button className="btn ghost small danger" aria-label="Remove line" onClick={() => { setLines(lines.filter((_, j) => j !== i)); setDirty(true); }}>✕</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="grid-form" style={{ marginTop: '1rem', maxWidth: '28rem' }}>
          <label>Discount ($)<input type="number" min={0} step="0.01" disabled={!canAdj} value={f.discount} onChange={(e) => edit(setF)({ ...f, discount: e.target.value })} /></label>
          <label>Tax (%)<input type="number" min={0} max={100} step="0.01" value={f.taxPct} onChange={(e) => edit(setF)({ ...f, taxPct: e.target.value })} /></label>
        </div>
        <dl className="info-grid" style={{ marginTop: '.5rem' }}>
          <div><dt>Subtotal</dt><dd>{money(live.subtotal)}</dd></div>
          {live.discount > 0 && <div><dt>Discount</dt><dd>−{money(live.discount)}</dd></div>}
          {live.tax > 0 && <div><dt>Tax</dt><dd>{money(live.tax)}</dd></div>}
          <div><dt>Total</dt><dd><b>{money(live.total)}</b></dd></div>
        </dl>
      </section>

      {canAdj && (() => {
        const used = roleRates.filter((r) => lines.some((l) => l.description.trim().toLowerCase() === r.name.toLowerCase()));
        if (!used.length) return null;
        return (
          <section className="card">
            <h2>Quick rates</h2>
            <p className="muted small">Each role has a pay rate (what crew are paid) and a bill rate (what the customer is quoted). Change a bill rate for just this quote, or save both as the role's new defaults. Saved pay rates apply to every shift of that role from now on.</p>
            <div style={{ overflowX: 'auto' }}>
              <table className="table">
                <thead><tr><th>Role</th><th>Pay /hr</th><th>Bill /hr</th><th>Margin</th><th></th></tr></thead>
                <tbody>
                  {used.map((r) => {
                    const e = qr[r.name];
                    const pay = e ? n(e.pay) : r.payRate;
                    const bill = e ? n(e.bill) : r.billRate;
                    const set = (patch: Partial<{ pay: string; bill: string }>) => setQr({ ...qr, [r.name]: { pay: e?.pay ?? String(r.payRate), bill: e?.bill ?? String(r.billRate), ...patch } });
                    return (
                      <tr key={r.name}>
                        <td>{r.name}</td>
                        <td><input type="number" min={0} step="0.01" value={e?.pay ?? r.payRate.toFixed(2)} onChange={(ev) => set({ pay: ev.target.value })} aria-label={`Pay rate for ${r.name}`} style={{ width: '6.5rem' }} /></td>
                        <td><input type="number" min={0} step="0.01" value={e?.bill ?? r.billRate.toFixed(2)} onChange={(ev) => set({ bill: ev.target.value })} aria-label={`Bill rate for ${r.name}`} style={{ width: '6.5rem' }} /></td>
                        <td className="small">{bill > 0 ? `${Math.round(((bill - pay) / bill) * 100)}%` : '—'}</td>
                        <td>
                          {e && (
                            <span className="row" style={{ gap: '.3rem' }}>
                              <button className="btn small" onClick={() => { setLines(lines.map((l) => (l.description.trim().toLowerCase() === r.name.toLowerCase() ? { ...l, rate: String(bill) } : l))); setDirty(true); }}>Use bill rate on this quote</button>
                              <button className="btn small primary" onClick={async () => {
                                if (pay !== r.payRate && !confirm(`Change ${r.name} pay to ${money(pay)}/hr for everyone, from now on?`)) return;
                                const sk = skillIds[r.name.toLowerCase()];
                                try {
                                  await api(`/api/skills/${sk}`, { method: 'PATCH', body: { payRate: pay, billRate: bill } });
                                  setNote(`Saved ${r.name}: pay ${money(pay)}, bill ${money(bill)}.`);
                                  setQr(({ [r.name]: _x, ...rest }) => rest);
                                  load();
                                } catch (x) { setError((x as Error).message); }
                              }}>Save as role default</button>
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        );
      })()}

      <section className="card">
        <label>Terms and conditions<textarea rows={4} value={f.terms} onChange={(e) => edit(setF)({ ...f, terms: e.target.value })} maxLength={10000} placeholder="Payment terms, cancellation policy, overtime rules…" /></label>
      </section>

      <section className="card">
        <h2>PDF and sending</h2>
        <div className="grid-form">
          <label>PDF layout
            <select value={layoutId} onChange={(e) => { setLayoutId(e.target.value); setDirty(true); }}>
              <option value="">{layouts.find((x) => x.is_default)?.name ? `Company default (${layouts.find((x) => x.is_default)!.name})` : 'Standard layout'}</option>
              {layouts.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
          </label>
          <div className="form-actions row">
            <button className="btn" disabled={busy} onClick={async () => { if (dirty && !(await save())) return; window.open(`/api/quotes/${id}/pdf${layoutId ? `?layoutId=${layoutId}` : ''}`, '_blank', 'noopener'); }}>Preview PDF</button>
          </div>
        </div>
        <div className="grid-form">
          {people.length > 1 && (
            <label>Send to
              <select value={people.some((p) => p.email === to) ? to : ''} onChange={(e) => setTo(e.target.value)}>
                <option value="">Main contact{q.customer_email ? ` (${q.customer_email})` : ''}</option>
                {people.map((p) => <option key={p.id} value={p.email!}>{p.name} — {p.email}</option>)}
              </select>
            </label>
          )}
          <label>{people.length > 1 ? 'Or type another email' : 'Email to'}<input type="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder={q.customer_email ?? 'customer@example.com'} /></label>
        </div>
        <label>Note in the email (optional)<textarea rows={2} value={msg} onChange={(e) => setMsg(e.target.value)} maxLength={3000} /></label>
        <div className="row">
          <button className="btn" disabled={busy || !dirty} onClick={save}>Save changes</button>
          <button className="btn primary" disabled={busy || !email || lines.length === 0} onClick={send}>{q.status === 'draft' ? 'Save & send quote' : 'Send again'}</button>
          {q.status !== 'draft' && <button className="btn ghost" onClick={() => navigator.clipboard?.writeText(d.link).then(() => setNote('Customer link copied.'))}>Copy customer link</button>}
          <button className="btn ghost" disabled={busy || !q.customer_id} title={q.customer_id ? '' : 'Pick a customer first'} onClick={async () => {
            const name = prompt('Name this template (it will only be offered for this customer):', q.title);
            if (!name) return;
            if (dirty && !(await save())) return;
            try {
              const r = await api<{ shifts: number; skipped: number }>(`/api/quotes/${id}/save-template`, { body: { name } });
              setNote(`Saved template “${name}” with ${r.shifts} shift${r.shifts === 1 ? '' : 's'}${r.skipped ? ` (${r.skipped} line${r.skipped === 1 ? '' : 's'} without times skipped)` : ''}. It shows up when you build an event for ${q.customer_name}.`);
            } catch (e) { setError((e as Error).message); }
          }}>Save as customer template</button>
          {q.status !== 'draft' && <a className="btn ghost" href={d.link} target="_blank" rel="noopener noreferrer">Preview as customer</a>}
        </div>
        {!email && <p className="muted small">Add an email address for the customer (on their page) or type one above.</p>}
      </section>
    </>
  );
}

export default function Page() {
  return <Shell roles={['admin', 'manager']}>{() => <Body />}</Shell>;
}
