'use client';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import Shell from '@/components/Shell';
import { Banner, Empty, Pill } from '@/components/ui';
import CopyEvent from '@/components/CopyEvent';
import { api, fmtDate, money } from '@/lib/api';

type Cust = { id: string; name: string; notes: string | null; rentman_contact_id: number | null };
type Contact = { id: string; name: string; title: string | null; email: string | null; phone: string | null; notes: string | null; is_primary: boolean };
type Loc = { id: string; label: string; venue: string | null; address: string | null; notes: string | null; is_default: boolean };
type Ev = { id: string; name: string; venue: string | null; start_date: string; end_date: string; shift_count: number; slots: number };
type Qt = { id: string; number: number; title: string; status: string; total: number; created_at: string };

function Body() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [d, setD] = useState<{ customer: Cust; contacts: Contact[]; locations: Loc[]; events: Ev[]; quotes: Qt[] } | null>(null);
  const [f, setF] = useState({ name: '', notes: '' });
  const [cf, setCf] = useState<{ id: string | null; name: string; title: string; email: string; phone: string } | null>(null);
  const [lf, setLf] = useState<{ id: string | null; label: string; venue: string; address: string } | null>(null);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const load = () => api<{ customer: Cust; contacts: Contact[]; locations: Loc[]; events: Ev[]; quotes: Qt[] }>(`/api/customers/${id}`).then((r) => {
    setD(r);
    const c = r.customer;
    setF({ name: c.name, notes: c.notes ?? '' });
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
          </div>
          <label>Notes<textarea rows={4} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} maxLength={5000} placeholder="Billing preferences, who approves quotes, things to remember" /></label>
          <div className="row"><button className="btn primary">Save</button><button type="button" className="btn ghost" onClick={() => setEditing(false)}>Cancel</button></div>
        </form>
      ) : (
        <section className="card">
          <div className="row space"><h2>Details</h2><button className="btn ghost small" onClick={() => setEditing(true)}>Edit</button></div>
          {c.notes ? <p style={{ whiteSpace: 'pre-wrap' }}>{c.notes}</p> : <p className="muted">No notes.</p>}
          <p className="small muted">
            {c.rentman_contact_id ? <>Linked to Rentman contact #{c.rentman_contact_id}. </> : <>Not in Rentman. </>}
            <button className="btn ghost small" onClick={() => api(`/api/customers/${id}/rentman`, { body: {} }).then(() => { setNote(c.rentman_contact_id ? 'Updated in Rentman.' : 'Sent to Rentman.'); load(); }).catch((x) => setError(x.message))}>{c.rentman_contact_id ? 'Update name, email and phone in Rentman' : 'Add to Rentman'}</button>
          </p>
        </section>
      )}
      <section className="card">
        <div className="row space"><h2>Contacts</h2><button className="btn small" onClick={() => setCf({ id: null, name: '', title: '', email: '', phone: '' })}>Add a contact</button></div>
        {cf && (
          <form className="grid-form" onSubmit={async (e) => {
            e.preventDefault();
            setError('');
            try {
              const body = { name: cf.name, title: cf.title || null, email: cf.email || null, phone: cf.phone || null };
              await (cf.id ? api(`/api/customer-contacts/${cf.id}`, { method: 'PATCH', body }) : api(`/api/customers/${id}/contacts`, { body }));
              setCf(null);
              load();
            } catch (x) { setError((x as Error).message); }
          }}>
            <label>Name<input value={cf.name} onChange={(e) => setCf({ ...cf, name: e.target.value })} required maxLength={150} /></label>
            <label>Role / title<input value={cf.title} onChange={(e) => setCf({ ...cf, title: e.target.value })} maxLength={100} placeholder="Producer, accounts payable…" /></label>
            <label>Email<input type="email" value={cf.email} onChange={(e) => setCf({ ...cf, email: e.target.value })} /></label>
            <label>Phone<input value={cf.phone} onChange={(e) => setCf({ ...cf, phone: e.target.value })} /></label>
            <div className="row"><button className="btn primary">{cf.id ? 'Save contact' : 'Add contact'}</button><button type="button" className="btn ghost" onClick={() => setCf(null)}>Cancel</button></div>
          </form>
        )}
        {d.contacts.length === 0 ? <Empty>No contacts yet.</Empty> : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {d.contacts.map((p) => (
              <li key={p.id} className="row space" style={{ padding: '.5rem 0', borderTop: '1px solid var(--border)', flexWrap: 'wrap' }}>
                <div>
                  <b>{p.name}</b> {p.is_primary && <span className="chip open">Main contact</span>}
                  <div className="muted small">{[p.title, p.email, p.phone].filter(Boolean).join(' · ') || 'No details'}</div>
                </div>
                <span className="row">
                  {!p.is_primary && <button className="btn ghost small" onClick={() => api(`/api/customer-contacts/${p.id}`, { method: 'PATCH', body: { primary: true } }).then(load).catch((x) => setError(x.message))}>Make main</button>}
                  <button className="btn ghost small" onClick={() => setCf({ id: p.id, name: p.name, title: p.title ?? '', email: p.email ?? '', phone: p.phone ?? '' })}>Edit</button>
                  <button className="btn ghost small danger" onClick={() => confirm(`Remove ${p.name}?`) && api(`/api/customer-contacts/${p.id}`, { method: 'DELETE' }).then(load).catch((x) => setError(x.message))}>Remove</button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="card">
        <div className="row space"><h2>Locations</h2><button className="btn small" onClick={() => setLf({ id: null, label: '', venue: '', address: '' })}>Add a location</button></div>
        <p className="muted small">Offices, warehouses, or venues this customer uses. When you create an event for them you can fill the venue and address from one of these.</p>
        {lf && (
          <form className="grid-form" onSubmit={async (e) => {
            e.preventDefault();
            setError('');
            try {
              const body = { label: lf.label, venue: lf.venue || null, address: lf.address || null };
              await (lf.id ? api(`/api/customer-locations/${lf.id}`, { method: 'PATCH', body }) : api(`/api/customers/${id}/locations`, { body }));
              setLf(null);
              load();
            } catch (x) { setError((x as Error).message); }
          }}>
            <label>Name<input value={lf.label} onChange={(e) => setLf({ ...lf, label: e.target.value })} required maxLength={100} placeholder="Head office, Warehouse, Arena…" /></label>
            <label>Venue name<input value={lf.venue} onChange={(e) => setLf({ ...lf, venue: e.target.value })} maxLength={200} /></label>
            <label>Street address<input value={lf.address} onChange={(e) => setLf({ ...lf, address: e.target.value })} maxLength={300} /></label>
            <div className="row"><button className="btn primary">{lf.id ? 'Save location' : 'Add location'}</button><button type="button" className="btn ghost" onClick={() => setLf(null)}>Cancel</button></div>
          </form>
        )}
        {d.locations.length === 0 ? <Empty>No locations yet.</Empty> : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {d.locations.map((l) => (
              <li key={l.id} className="row space" style={{ padding: '.5rem 0', borderTop: '1px solid var(--border)', flexWrap: 'wrap' }}>
                <div>
                  <b>{l.label}</b> {l.is_default && <span className="chip open">Main location</span>}
                  <div className="muted small">{[l.venue, l.address].filter(Boolean).join(' · ') || 'No address'}</div>
                </div>
                <span className="row">
                  {!l.is_default && <button className="btn ghost small" onClick={() => api(`/api/customer-locations/${l.id}`, { method: 'PATCH', body: { isDefault: true } }).then(load).catch((x) => setError(x.message))}>Make main</button>}
                  <button className="btn ghost small" onClick={() => setLf({ id: l.id, label: l.label, venue: l.venue ?? '', address: l.address ?? '' })}>Edit</button>
                  <button className="btn ghost small danger" onClick={() => confirm(`Remove ${l.label}?`) && api(`/api/customer-locations/${l.id}`, { method: 'DELETE' }).then(load).catch((x) => setError(x.message))}>Remove</button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
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
