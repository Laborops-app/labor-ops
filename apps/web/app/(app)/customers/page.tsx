'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import Shell from '@/components/Shell';
import Modal from '@/components/Modal';
import TopbarAction, { PlusIcon, EditIcon, SearchIcon, avClass, initialsOf } from '@/components/TopbarAction';
import { Banner, Empty } from '@/components/ui';
import { api, fmtDate } from '@/lib/api';
import { cityOf } from '@/lib/crm';
import { GridIcon, ListIcon, PinIcon } from '@/components/crm/icons';

type Cust = {
  id: string; name: string; parent_id?: string | null; parent_name?: string | null; division_count?: number;
  contact_name: string | null; email: string | null; phone: string | null; address: string | null; event_count: number; quote_count: number; last_event: string | null; created_at: string;
};
type Sort = 'name' | 'created' | 'recent' | 'events';
type View = 'grid' | 'list';
const PAGE = 25;
const VIEW_KEY = 'lo_customers_view';

const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } },
};

function Body() {
  const router = useRouter();
  const [list, setList] = useState<Cust[] | null>(null);
  const [q, setQ] = useState('');
  const [view, setView] = useState<View>('grid');
  const [sort, setSort] = useState<Sort>('name');
  const [shown, setShown] = useState(PAGE);
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ name: '', contactName: '', email: '', phone: '' });
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  const load = () => api<{ customers: Cust[] }>('/api/customers').then((r) => setList(r.customers)).catch((e) => setError(e.message));
  useEffect(() => {
    load();
    const v = store.get(VIEW_KEY);
    if (v === 'list' || v === 'grid') setView(v);
  }, []);
  const pickView = (v: View) => {
    setView(v);
    store.set(VIEW_KEY, v);
  };

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      const r = await api<{ customer: { id: string } }>('/api/customers', { body: { name: f.name, contactName: f.contactName || null, email: f.email || null, phone: f.phone || null } });
      setF({ name: '', contactName: '', email: '', phone: '' });
      setAdding(false);
      router.push(`/customers/${r.customer.id}`);
    } catch (x) {
      setError((x as Error).message);
    }
  };
  const imp = async () => {
    setError('');
    try {
      const r = await api<{ created: number; linked: number }>('/api/customers/import-from-events', { body: {} });
      setNote(r.created ? `Added ${r.created} customer${r.created === 1 ? '' : 's'} from your events and linked ${r.linked} event${r.linked === 1 ? '' : 's'}.` : 'Nothing new to import. Every client name on your events is already a customer.');
      load();
    } catch (x) {
      setError((x as Error).message);
    }
  };

  const needle = q.trim().toLowerCase();
  const rows = useMemo(
    () =>
      (list ?? [])
        .filter((c) => !needle || `${c.name} ${c.contact_name ?? ''} ${c.email ?? ''} ${c.phone ?? ''} ${c.address ?? ''}`.toLowerCase().includes(needle))
        .sort((a, b) =>
          sort === 'created' ? +new Date(b.created_at) - +new Date(a.created_at)
          : sort === 'recent' ? String(b.last_event ?? '').localeCompare(String(a.last_event ?? ''))
          : sort === 'events' ? b.event_count - a.event_count
          : a.name.localeCompare(b.name),
        ),
    [list, needle, sort],
  );

  const card = (c: Cust) => (
    <Link key={c.id} href={`/customers/${c.id}`} className="co-card">
      <span className={`${avClass(c.name)} co-logo`} aria-hidden="true">{initialsOf(c.name)}</span>
      <b className="co-name">{c.name}</b>
      <span className="co-sub">{c.parent_name ? `Division of ${c.parent_name}` : c.contact_name ?? (c.division_count ? `${c.division_count} division${c.division_count === 1 ? '' : 's'}` : 'No contact yet')}</span>
      <span className="co-loc"><PinIcon size={18} />{cityOf(c.address) ?? <span className="muted">No address</span>}</span>
      {(c.event_count > 0 || c.quote_count > 0) && (
        <span className="co-meta">
          {c.event_count} event{c.event_count === 1 ? '' : 's'}{c.quote_count ? ` · ${c.quote_count} quote${c.quote_count === 1 ? '' : 's'}` : ''}
          {c.last_event ? ` · last ${fmtDate(String(c.last_event).slice(0, 10))}` : ''}
        </span>
      )}
    </Link>
  );

  return (
    <>
      <TopbarAction>
        <button className="btn primary" onClick={() => setAdding(true)}>
          Add New Customer
          <PlusIcon />
        </button>
      </TopbarAction>
      <div className="co-head">
        <h1>Customers</h1>
        <div className="co-views" role="tablist" aria-label="View">
          <button role="tab" aria-selected={view === 'list'} className={view === 'list' ? 'on' : ''} onClick={() => pickView('list')}><ListIcon /> List</button>
          <button role="tab" aria-selected={view === 'grid'} className={view === 'grid' ? 'on' : ''} onClick={() => pickView('grid')}><GridIcon /> Grid</button>
        </div>
        <span className="spacer" />
        <span className="pill-input">
          <SearchIcon />
          <input value={q} onChange={(e) => { setQ(e.target.value); setShown(PAGE); }} placeholder="Search name, contact, email" aria-label="Search customers" />
        </span>
        <span className="pill-input">
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort customers">
            <option value="name">Sort by: Name</option>
            <option value="created">Sort by: Date added</option>
            <option value="recent">Sort by: Latest event</option>
            <option value="events">Sort by: Most events</option>
          </select>
        </span>
        <button className="btn" onClick={imp} title="Create customers from the client names typed on your events">Import from events</button>
      </div>
      {error && <Banner onClose={() => setError('')}>{error}</Banner>}
      {note && <Banner kind="ok" onClose={() => setNote('')}>{note}</Banner>}

      {!list ? (
        <div className="muted">Loading…</div>
      ) : list.length === 0 ? (
        <Empty>No customers yet. Add one, or import the client names already on your events.</Empty>
      ) : rows.length === 0 ? (
        <Empty>No customers match that search.</Empty>
      ) : view === 'grid' ? (
        <>
          <div className="co-grid">{rows.slice(0, shown).map(card)}</div>
          {rows.length > shown && (
            <div className="load-more">
              <button className="btn" onClick={() => setShown(shown + PAGE)}>Load More</button>
            </div>
          )}
        </>
      ) : rows.length === 0 ? (
        <Empty>No customers match that search.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="dlist">
            <thead>
              <tr>
                <th className="av-col" aria-label="Avatar" />
                <th>Name</th>
                <th>Main contact</th>
                <th className="hide-sm">Email</th>
                <th className="hide-sm">Phone</th>
                <th className="hide-sm">Address</th>
                <th>Events</th>
                <th className="edit-col">Edit</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, shown).map((c) => (
                <tr key={c.id} onClick={() => router.push(`/customers/${c.id}`)}>
                  <td className="av-col"><span className={avClass(c.name)} aria-hidden="true">{initialsOf(c.name)}</span></td>
                  <td>
                    <Link href={`/customers/${c.id}`} className="rowlink" onClick={(e) => e.stopPropagation()}>{c.name}</Link>
                    {c.parent_name && <span className="sub">Division of {c.parent_name}</span>}
                    {!!c.division_count && <span className="sub">{c.division_count} division{c.division_count === 1 ? '' : 's'}</span>}
                    {c.last_event && <span className="sub">Last event {fmtDate(String(c.last_event).slice(0, 10))}</span>}
                  </td>
                  <td>{c.contact_name ?? <span className="muted">—</span>}</td>
                  <td className="hide-sm">{c.email ?? <span className="muted">—</span>}</td>
                  <td className="hide-sm">{c.phone ?? <span className="muted">—</span>}</td>
                  <td className="hide-sm">{c.address ?? <span className="muted">—</span>}</td>
                  <td>
                    {c.event_count}
                    {c.quote_count > 0 && <span className="sub">{c.quote_count} quote{c.quote_count === 1 ? '' : 's'}</span>}
                  </td>
                  <td className="edit-col">
                    <Link href={`/customers/${c.id}`} className="btn-round sm" aria-label={`Edit ${c.name}`} onClick={(e) => e.stopPropagation()} style={{ border: 0, background: 'transparent' }}>
                      <EditIcon />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > shown && (
            <div className="load-more">
              <button className="btn" onClick={() => setShown(shown + PAGE)}>Load More</button>
            </div>
          )}
        </div>
      )}

      {adding && (
        <Modal title="Add New Customer" onClose={() => setAdding(false)}>
          <form onSubmit={add}>
            <label>
              Company or customer name
              <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={150} autoFocus />
            </label>
            <div className="two">
              <label>
                Contact person
                <input value={f.contactName} onChange={(e) => setF({ ...f, contactName: e.target.value })} maxLength={150} />
              </label>
              <label>
                Phone
                <input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} maxLength={50} />
              </label>
            </div>
            <label>
              Email
              <input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} maxLength={200} />
            </label>
            <div className="acts">
              <button type="button" className="btn" onClick={() => setAdding(false)}>Cancel</button>
              <button className="btn primary">Save Customer</button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}

export default function Page() {
  return <Shell roles={['admin', 'manager']}>{() => <Body />}</Shell>;
}
