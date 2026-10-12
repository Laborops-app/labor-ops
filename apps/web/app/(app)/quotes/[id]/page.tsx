'use client';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import Shell from '@/components/Shell';
import { Banner, Pill } from '@/components/ui';
import CustomerSelect from '@/components/CustomerSelect';
import { api, money } from '@/lib/api';

type Line = { description: string; qty: string; hours: string; rate: string };
type Totals = { subtotal: number; discount: number; tax: number; total: number };
type Detail = {
  quote: { id: string; number: number; title: string; status: string; customer_id: string | null; customer_email: string | null; customer_name: string | null; event_id: string | null; event_name: string | null; valid_until: string | null; intro: string | null; terms: string | null; tax_pct: number; discount: number; sent_at: string | null; sent_to: string | null; responded_at: string | null; response_note: string | null };
  lines: { description: string; qty: number; hours: number; rate: number }[];
  totals: Totals;
  link: string;
};

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  const apply = (r: Detail) => {
    setD((p) => ({ ...r, link: r.link ?? p?.link ?? '' }));
    const q = r.quote;
    setF({ title: q.title, customerId: q.customer_id, validUntil: q.valid_until ? String(q.valid_until).slice(0, 10) : '', intro: q.intro ?? '', terms: q.terms ?? '', taxPct: String(q.tax_pct), discount: String(q.discount) });
    setLines(r.lines.map((l) => ({ description: l.description, qty: String(l.qty), hours: String(l.hours), rate: String(l.rate) })));
    setDirty(false);
  };
  const load = () => api<Detail>(`/api/quotes/${id}`).then(apply).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [id]);
  const cid = d?.quote.customer_id;
  useEffect(() => {
    setPeople([]);
    if (cid) api<{ contacts: typeof people }>(`/api/customers/${cid}`).then((r) => setPeople(r.contacts.filter((p) => p.email))).catch(() => {});
  }, [cid]);

  const edit = <T,>(fn: (v: T) => void) => (v: T) => { fn(v); setDirty(true); };
  const setLine = (i: number, patch: Partial<Line>) => { setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l))); setDirty(true); };

  const live = (() => {
    const subtotal = r2(lines.reduce((a, l) => a + n(l.qty) * n(l.hours) * n(l.rate), 0));
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
          lines: lines.filter((l) => l.description.trim()).map((l) => ({ description: l.description.trim(), qty: n(l.qty), hours: n(l.hours), rate: n(l.rate) })),
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
        <h2>Line items</h2>
        <p className="muted small">Each line is people × hours × hourly rate. Rates start from each role's billing rate on the Roles &amp; rates page.</p>
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead><tr><th>Description</th><th>People</th><th>Hours</th><th>Rate/hr</th><th style={{ textAlign: 'right' }}>Amount</th><th></th></tr></thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i}>
                  <td><input value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} aria-label="Description" maxLength={300} style={{ minWidth: '14rem' }} /></td>
                  <td><input type="number" min={0} step="1" value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} aria-label="People" style={{ width: '5rem' }} /></td>
                  <td><input type="number" min={0} step="0.25" value={l.hours} onChange={(e) => setLine(i, { hours: e.target.value })} aria-label="Hours" style={{ width: '5.5rem' }} /></td>
                  <td><input type="number" min={0} step="0.01" value={l.rate} onChange={(e) => setLine(i, { rate: e.target.value })} aria-label="Rate per hour" style={{ width: '6rem' }} /></td>
                  <td style={{ textAlign: 'right' }}>{money(r2(n(l.qty) * n(l.hours) * n(l.rate)))}</td>
                  <td><button className="btn ghost small danger" aria-label="Remove line" onClick={() => { setLines(lines.filter((_, j) => j !== i)); setDirty(true); }}>✕</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button className="btn small" onClick={() => { setLines([...lines, { description: '', qty: '1', hours: '8', rate: '0' }]); setDirty(true); }}>Add a line</button>
        <div className="grid-form" style={{ marginTop: '1rem', maxWidth: '28rem' }}>
          <label>Discount ($)<input type="number" min={0} step="0.01" value={f.discount} onChange={(e) => edit(setF)({ ...f, discount: e.target.value })} /></label>
          <label>Tax (%)<input type="number" min={0} max={100} step="0.01" value={f.taxPct} onChange={(e) => edit(setF)({ ...f, taxPct: e.target.value })} /></label>
        </div>
        <dl className="info-grid" style={{ marginTop: '.5rem' }}>
          <div><dt>Subtotal</dt><dd>{money(live.subtotal)}</dd></div>
          {live.discount > 0 && <div><dt>Discount</dt><dd>−{money(live.discount)}</dd></div>}
          {live.tax > 0 && <div><dt>Tax</dt><dd>{money(live.tax)}</dd></div>}
          <div><dt>Total</dt><dd><b>{money(live.total)}</b></dd></div>
        </dl>
      </section>

      <section className="card">
        <label>Terms and conditions<textarea rows={4} value={f.terms} onChange={(e) => edit(setF)({ ...f, terms: e.target.value })} maxLength={10000} placeholder="Payment terms, cancellation policy, overtime rules…" /></label>
      </section>

      <section className="card">
        <h2>Send to the customer</h2>
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
