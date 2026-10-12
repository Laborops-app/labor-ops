'use client';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import Shell from '@/components/Shell';
import { Banner, Empty, Pill } from '@/components/ui';
import CopyEvent from '@/components/CopyEvent';
import { api, fmtDate, money } from '@/lib/api';

type Cust = { id: string; name: string; contact_name: string | null; email: string | null; phone: string | null; address: string | null; notes: string | null };
type Ev = { id: string; name: string; venue: string | null; start_date: string; end_date: string; shift_count: number; slots: number };
type Qt = { id: string; number: number; title: string; status: string; total: number; created_at: string };

function Body() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [d, setD] = useState<{ customer: Cust; events: Ev[]; quotes: Qt[] } | null>(null);
  const [f, setF] = useState({ name: '', contactName: '', email: '', phone: '', address: '', notes: '' });
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const load = () => api<{ customer: Cust; events: Ev[]; quotes: Qt[] }>(`/api/customers/${id}`).then((r) => {
    setD(r);
    const c = r.customer;
    setF({ name: c.name, contactName: c.contact_name ?? '', email: c.email ?? '', phone: c.phone ?? '', address: c.address ?? '', notes: c.notes ?? '' });
  }).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [id]);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try { await api(`/api/customers/${id}`, { method: 'PATCH', body: f }); setEditing(false); setNote('Saved.'); load(); } catch (x) { setError((x as Error).message); }
  };
  if (!d) return error ? <Banner>{error}</Banner> : <div className="muted">Loading…</div>;
  const c = d.customer;
  const today = new Date().toISOString().slice(0, 10);
  const past = d.events.filter((e) => e.end_date.slice(0, 10) < today);
  const upcoming = d.events.filter((e) => e.end_date.slice(0, 10) >= today);
  const evRow = (e: Ev) => (
    <li key={e.id} className="row space" style={{ padding: '.5rem 0', borderTop: '1px solid var(--line, #ddd)', flexWrap: 'wrap' }}>
      <div>
        <Link href={`/events/${e.id}`}><b>{e.name}</b></Link>
        <div className="muted small">{fmtDate(e.start_date.slice(0, 10))}{e.end_date.slice(0, 10) !== e.start_date.slice(0, 10) && <> – {fmtDate(e.end_date.slice(0, 10))}</>}{e.venue ? ` · ${e.venue}` : ''} · {e.shift_count} shift{e.shift_count === 1 ? '' : 's'}</div>
      </div>
      <span className="row"><button className="btn small" onClick={() => api<{ quote: { id: string } }>('/api/quotes', { body: { eventId: e.id } }).then((r) => router.push(`/quotes/${r.quote.id}`)).catch((x) => setError(x.message))}>Quote</button><CopyEvent eventId={e.id} name={e.name} customerId={c.id} onError={setError} /></span>
    </li>
  );
  return (
    <>
      <p className="small"><Link href="/customers">← Customers</Link></p>
      <div className="row space">
        <h1>{c.name}</h1>
        <span className="row">
          <button className="btn small" onClick={() => api<{ quote: { id: string } }>('/api/quotes', { body: { customerId: c.id, title: `Labor quote for ${c.name}` } }).then((r) => router.push(`/quotes/${r.quote.id}`)).catch((x) => setError(x.message))}>New quote</button>
          <button className="btn ghost small danger" onClick={() => confirm(`Delete ${c.name}? Their events and quotes are kept, just no longer linked.`) && api(`/api/customers/${id}`, { method: 'DELETE' }).then(() => router.replace('/customers')).catch((x) => setError(x.message))}>Delete</button>
        </span>
      </div>
      {error && <Banner onClose={() => setError('')}>{error}</Banner>}
      {note && <Banner kind="ok" onClose={() => setNote('')}>{note}</Banner>}
      {editing ? (
        <form className="card" onSubmit={save}>
          <h2>Edit customer</h2>
          <div className="grid-form">
            <label>Name<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={150} /></label>
            <label>Contact person<input value={f.contactName} onChange={(e) => setF({ ...f, contactName: e.target.value })} /></label>
            <label>Email<input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
            <label>Phone<input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></label>
            <label>Address<input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></label>
          </div>
          <label>Notes<textarea rows={4} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} maxLength={5000} placeholder="Billing preferences, who approves quotes, things to remember" /></label>
          <div className="row"><button className="btn primary">Save</button><button type="button" className="btn ghost" onClick={() => setEditing(false)}>Cancel</button></div>
        </form>
      ) : (
        <section className="card">
          <div className="row space"><h2>Details</h2><button className="btn ghost small" onClick={() => setEditing(true)}>Edit</button></div>
          <dl className="info-grid">
            <div><dt>Contact</dt><dd>{c.contact_name || <span className="muted">Not set</span>}</dd></div>
            <div><dt>Email</dt><dd>{c.email ? <a href={`mailto:${c.email}`}>{c.email}</a> : <span className="muted">Not set</span>}</dd></div>
            <div><dt>Phone</dt><dd>{c.phone || <span className="muted">Not set</span>}</dd></div>
            <div><dt>Address</dt><dd>{c.address || <span className="muted">Not set</span>}</dd></div>
            {c.notes && <div style={{ gridColumn: '1 / -1' }}><dt>Notes</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{c.notes}</dd></div>}
          </dl>
        </section>
      )}
      <section className="card">
        <h2>Events</h2>
        {d.events.length === 0 ? <Empty>No events yet. Pick this customer when you create an event, or use "Import from event client names" on the Customers page.</Empty> : (
          <>
            {upcoming.length > 0 && <><h3 className="small muted">Upcoming</h3><ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>{upcoming.map(evRow)}</ul></>}
            {past.length > 0 && <><h3 className="small muted" style={{ marginTop: '1rem' }}>Past events: copy one to start a new event the same way</h3><ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>{past.map(evRow)}</ul></>}
          </>
        )}
      </section>
      <section className="card">
        <h2>Quotes</h2>
        {d.quotes.length === 0 ? <Empty>No quotes yet.</Empty> : (
          <table className="table">
            <thead><tr><th>#</th><th>Title</th><th>Total</th><th>Status</th></tr></thead>
            <tbody>{d.quotes.map((q) => <tr key={q.id}><td>{q.number}</td><td><Link href={`/quotes/${q.id}`}>{q.title}</Link></td><td>{money(q.total)}</td><td><Pill status={q.status} /></td></tr>)}</tbody>
          </table>
        )}
      </section>
    </>
  );
}

export default function Page() {
  return <Shell roles={['admin', 'manager']}>{() => <Body />}</Shell>;
}
