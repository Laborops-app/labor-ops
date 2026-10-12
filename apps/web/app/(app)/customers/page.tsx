'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import Shell from '@/components/Shell';
import { Banner, Empty } from '@/components/ui';
import { api, fmtDate } from '@/lib/api';

type Cust = { id: string; name: string; contact_name: string | null; email: string | null; phone: string | null; event_count: number; quote_count: number; last_event: string | null };

function Body() {
  const [list, setList] = useState<Cust[] | null>(null);
  const [q, setQ] = useState('');
  const [f, setF] = useState({ name: '', contactName: '', email: '', phone: '' });
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const load = () => api<{ customers: Cust[] }>('/api/customers').then((r) => setList(r.customers)).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await api('/api/customers', { body: { name: f.name, contactName: f.contactName || null, email: f.email || null, phone: f.phone || null } });
      setF({ name: '', contactName: '', email: '', phone: '' });
      load();
    } catch (x) { setError((x as Error).message); }
  };
  const imp = async () => {
    setError('');
    try {
      const r = await api<{ created: number; linked: number }>('/api/customers/import-from-events', { body: {} });
      setNote(r.created ? `Added ${r.created} customer${r.created === 1 ? '' : 's'} from your events and linked ${r.linked} event${r.linked === 1 ? '' : 's'}.` : 'Nothing new to import. Every client name on your events is already a customer.');
      load();
    } catch (x) { setError((x as Error).message); }
  };
  const shown = (list ?? []).filter((c) => !q || `${c.name} ${c.contact_name ?? ''} ${c.email ?? ''}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <div className="row space">
        <h1>Customers</h1>
        <button className="btn small" onClick={imp}>Import from event client names</button>
      </div>
      <p className="muted">Everyone you do events for. Open a customer to see their past events, copy one into a new event, and manage their quotes.</p>
      {error && <Banner onClose={() => setError('')}>{error}</Banner>}
      {note && <Banner kind="ok" onClose={() => setNote('')}>{note}</Banner>}
      <form className="card" onSubmit={add}>
        <h2>Add a customer</h2>
        <div className="grid-form">
          <label>Company or customer name<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={150} /></label>
          <label>Contact person<input value={f.contactName} onChange={(e) => setF({ ...f, contactName: e.target.value })} maxLength={150} /></label>
          <label>Email<input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} maxLength={200} /></label>
          <label>Phone<input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} maxLength={50} /></label>
        </div>
        <button className="btn primary">Add customer</button>
      </form>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search customers" aria-label="Search customers" style={{ maxWidth: '22rem', margin: '1rem 0' }} />
      {!list ? <div className="muted">Loading…</div> : shown.length === 0 ? <Empty>{list.length ? 'No match.' : 'No customers yet. Add one above, or import the client names already on your events.'}</Empty> : (
        <div className="cards">
          {shown.map((c) => (
            <Link key={c.id} href={`/customers/${c.id}`} className="sc">
              <div className="sc-top"><b>{c.name}</b></div>
              <div className="sub">
                {c.contact_name && <span>{c.contact_name}</span>}
                {c.email && <span>{c.email}</span>}
                {c.phone && <span>{c.phone}</span>}
              </div>
              <div className="meta"><span>{c.event_count} event{c.event_count === 1 ? '' : 's'} · {c.quote_count} quote{c.quote_count === 1 ? '' : 's'}{c.last_event ? ` · last ${fmtDate(String(c.last_event).slice(0, 10))}` : ''}</span></div>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}

export default function Page() {
  return <Shell roles={['admin', 'manager']}>{() => <Body />}</Shell>;
}
