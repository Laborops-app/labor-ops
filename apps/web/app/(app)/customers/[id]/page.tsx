'use client';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import Shell from '@/components/Shell';
import Modal from '@/components/Modal';
import { Banner, Pill } from '@/components/ui';
import CopyEvent from '@/components/CopyEvent';
import TopbarAction, { PlusIcon, TrashIcon, avClass, initialsOf } from '@/components/TopbarAction';
import { api, fmtDate, money } from '@/lib/api';
import { ContactDetails, ContactGrid, type Contact } from '@/components/crm/ContactCards';

type Cust = { id: string; name: string; notes: string | null; rentman_contact_id: number | null; parent_id?: string | null; parent_name?: string | null };
type Loc = { id: string; label: string; venue: string | null; address: string | null; notes: string | null; is_default: boolean };
type Ev = { id: string; name: string; venue: string | null; start_date: string; end_date: string; shift_count: number; slots: number };
type Qt = { id: string; number: number; title: string; status: string; total: number; created_at: string };
type Data = { customer: Cust; contacts: Contact[]; locations: Loc[]; events: Ev[]; quotes: Qt[]; divisions?: { id: string; name: string; event_count: number }[] };

const day = (s: string) => new Date(`${s.slice(0, 10)}T12:00:00`);
function DateBadge({ date }: { date: string }) {
  const d = day(date);
  return (
    <span className="av c1" aria-hidden="true" style={{ display: 'grid', lineHeight: 1.05, fontSize: 11, textTransform: 'uppercase' }}>
      <span>{d.toLocaleDateString('en-US', { month: 'short' })}</span>
      <b style={{ fontSize: 15 }}>{d.getDate()}</b>
    </span>
  );
}

function Body() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [d, setD] = useState<Data | null>(null);
  const [f, setF] = useState({ name: '', notes: '' });
  const [cf, setCf] = useState<{ id: string | null; name: string; title: string; email: string; phone: string; notes: string } | null>(null);
  const [open, setOpen] = useState<Contact | null>(null);
  const [lf, setLf] = useState<{ id: string | null; label: string; venue: string; address: string } | null>(null);
  const [tab, setTab] = useState<'upcoming' | 'past'>('upcoming');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const load = () =>
    api<Data>(`/api/customers/${id}`)
      .then((r) => {
        setD(r);
        setF({ name: r.customer.name, notes: r.customer.notes ?? '' });
      })
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  const run = (p: Promise<unknown>, ok = '') => p.then(() => { if (ok) setNote(ok); return load(); }).catch((x) => setError((x as Error).message));

  if (!d) return error ? <Banner>{error}</Banner> : <div className="muted">Loading…</div>;
  const c = d.customer;
  const dirty = f.name !== c.name || f.notes !== (c.notes ?? '');
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = d.events.filter((e) => e.end_date.slice(0, 10) >= today);
  const past = d.events.filter((e) => e.end_date.slice(0, 10) < today).reverse();
  const evs = tab === 'upcoming' ? upcoming : past;
  const editContact = (p: Contact) => setCf({ id: p.id, name: p.name, title: p.title ?? '', email: p.email ?? '', phone: p.phone ?? '', notes: p.notes ?? '' });
  const mainAddress = d.locations.find((l) => l.is_default)?.address ?? d.locations[0]?.address ?? null;
  const newQuote = (body: object) => api<{ quote: { id: string } }>('/api/quotes', { body }).then((r) => router.push(`/quotes/${r.quote.id}`)).catch((x) => setError(x.message));

  return (
    <div className="split">
      <div className="split-main">
        <TopbarAction>
          <button className="btn primary" onClick={() => newQuote({ customerId: c.id, title: `Labor quote for ${c.name}` })}>
            New Quote
            <PlusIcon />
          </button>
        </TopbarAction>
        <p className="small" style={{ margin: '0 0 16px' }}>
          <Link href="/customers">← All customers</Link>
        </p>
        {error && <Banner onClose={() => setError('')}>{error}</Banner>}
        {note && <Banner kind="ok" onClose={() => setNote('')}>{note}</Banner>}

        <div className="hero">
          <span className={`${avClass(c.name)} lg`} aria-hidden="true">{initialsOf(c.name)}</span>
          <div className="hero-actions">
            <button
              className="btn-round danger"
              aria-label={`Delete ${c.name}`}
              title="Delete customer"
              onClick={() => confirm(`Delete ${c.name}? Their events and quotes are kept, just no longer linked.`) && api(`/api/customers/${id}`, { method: 'DELETE' }).then(() => router.replace('/customers')).catch((x) => setError(x.message))}
            >
              <TrashIcon />
            </button>
          </div>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            run(api(`/api/customers/${id}`, { method: 'PATCH', body: f }), 'Customer saved.');
          }}
        >
          <label>
            Customer name
            <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={150} />
          </label>
          <label>
            Notes
            <textarea rows={3} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} maxLength={5000} placeholder="Billing preferences, who approves quotes, things to remember" />
          </label>
          {c.parent_id && (
            <p className="small">Division of <Link href={`/customers/${c.parent_id}`}>{c.parent_name}</Link></p>
          )}
          {dirty && (
            <div className="row">
              <button className="btn primary">Save changes</button>
              <button type="button" className="btn" onClick={() => setF({ name: c.name, notes: c.notes ?? '' })}>Discard</button>
            </div>
          )}
        </form>

        <section style={{ marginTop: 32 }}>
          <div className="row space">
            <h2 style={{ margin: 0 }}>Divisions</h2>
          </div>
          {(d.divisions ?? []).length > 0 ? (
            <ul className="plain">
              {d.divisions!.map((dv) => (
                <li key={dv.id} style={{ padding: "6px 0" }}><Link href={`/customers/${dv.id}`}>{dv.name}</Link> <span className="muted small">· {dv.event_count} event{dv.event_count === 1 ? "" : "s"}</span></li>
              ))}
            </ul>
          ) : (
            <p className="muted small">No divisions. Add one with “+ New division” when you create an event, or below.</p>
          )}
          <form className="row" style={{ gap: 8, marginTop: 8 }} onSubmit={(e) => { e.preventDefault(); const el = (e.currentTarget.elements.namedItem('division') as HTMLInputElement); const name = el.value.trim(); if (!name) return; run(api('/api/customers', { body: { name, parentId: id } }).then(() => { el.value = ''; }), `Added the ${name} division.`); }}>
            <input name="division" placeholder="New division name, e.g. Athletics" maxLength={120} style={{ flex: 1, minWidth: 200 }} />
            <button className="btn small">Add division</button>
          </form>
        </section>

        <section style={{ marginTop: 32 }}>
          <div className="row space" style={{ marginBottom: 8 }}>
            <h2 style={{ margin: 0 }}>Contacts</h2>
            <button className="btn-round sm primary" aria-label="Add a contact" title="Add a contact" onClick={() => setCf({ id: null, name: '', title: '', email: '', phone: '', notes: '' })}>
              <PlusIcon />
            </button>
          </div>
          {d.contacts.length === 0 ? (
            <p className="muted">No contacts yet.</p>
          ) : (
            <ContactGrid
              contacts={d.contacts}
              onOpen={setOpen}
              onEdit={editContact}
              onMain={(p) => run(api(`/api/customer-contacts/${p.id}`, { method: 'PATCH', body: { primary: true } }), `${p.name} is now the main contact.`)}
              onRemove={(p) => confirm(`Remove ${p.name}?`) && run(api(`/api/customer-contacts/${p.id}`, { method: 'DELETE' }))}
            />
          )}
        </section>

        <section style={{ marginTop: 32 }}>
          <div className="row space" style={{ marginBottom: 8 }}>
            <h2 style={{ margin: 0 }}>Locations</h2>
            <button className="btn-round sm primary" aria-label="Add a location" title="Add a location" onClick={() => setLf({ id: null, label: '', venue: '', address: '' })}>
              <PlusIcon />
            </button>
          </div>
          <p className="muted small">Offices, warehouses or venues this customer uses. New events for them can fill the venue and address from these.</p>
          {d.locations.length === 0 ? (
            <p className="muted">No locations yet.</p>
          ) : (
            <table className="dlist">
              <tbody>
                {d.locations.map((l) => (
                  <tr key={l.id} onClick={() => setLf({ id: l.id, label: l.label, venue: l.venue ?? '', address: l.address ?? '' })}>
                    <td className="av-col"><span className="av c5" aria-hidden="true">📍</span></td>
                    <td>
                      <b>{l.label}</b> {l.is_default && <span className="chip">Main</span>}
                      {l.venue && <span className="sub">{l.venue}</span>}
                    </td>
                    <td className="wrap">{l.address ?? <span className="muted">No address</span>}</td>
                    <td className="edit-col" onClick={(e) => e.stopPropagation()}>
                      {!l.is_default && (
                        <button className="btn ghost small" onClick={() => run(api(`/api/customer-locations/${l.id}`, { method: 'PATCH', body: { isDefault: true } }))}>Make main</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <p className="small muted" style={{ marginTop: 32 }}>
          {c.rentman_contact_id ? <>Linked to Rentman contact #{c.rentman_contact_id}. </> : <>Not in Rentman yet. </>}
          <button className="btn ghost small" onClick={() => run(api(`/api/customers/${id}/rentman`, { body: {} }), c.rentman_contact_id ? 'Updated in Rentman.' : 'Sent to Rentman.')}>
            {c.rentman_contact_id ? 'Update in Rentman' : 'Add to Rentman'}
          </button>
        </p>
      </div>

      <aside className="split-aside">
        <div className="aside-head">
          <h2>Events</h2>
          <Link href="/events" className="btn-round sm primary" aria-label="New event" title="New event">
            <PlusIcon />
          </Link>
        </div>
        <div className="phase-tabs" role="tablist" aria-label="Which events">
          <button type="button" role="tab" aria-selected={tab === 'upcoming'} className={tab === 'upcoming' ? 'tab on' : 'tab'} onClick={() => setTab('upcoming')}>Upcoming ({upcoming.length})</button>
          <button type="button" role="tab" aria-selected={tab === 'past'} className={tab === 'past' ? 'tab on' : 'tab'} onClick={() => setTab('past')}>Past ({past.length})</button>
        </div>
        {evs.length === 0 ? (
          <p className="muted small">{tab === 'upcoming' ? 'No upcoming events. Pick this customer when you create one.' : 'No past events.'}</p>
        ) : (
          <div className="mini-list">
            {evs.map((e) => (
              <div key={e.id} className="mini">
                <DateBadge date={e.start_date} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <Link href={`/events/${e.id}`} style={{ color: 'inherit', textDecoration: 'none' }}><b>{e.name}</b></Link>
                  <div className="meta">
                    {fmtDate(e.start_date.slice(0, 10))}
                    {e.end_date.slice(0, 10) !== e.start_date.slice(0, 10) && <> – {fmtDate(e.end_date.slice(0, 10))}</>}
                    {e.venue ? ` · ${e.venue}` : ''} · {e.shift_count} shift{e.shift_count === 1 ? '' : 's'}
                  </div>
                  <div className="row" style={{ gap: 6, marginTop: 4 }}>
                    <button className="btn ghost small" onClick={() => newQuote({ eventId: e.id })}>Quote</button>
                    <CopyEvent eventId={e.id} name={e.name} customerId={c.id} onError={setError} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="aside-head" style={{ marginTop: 28 }}>
          <h2>Quotes</h2>
          <button className="btn-round sm primary" aria-label="New quote" title="New quote" onClick={() => newQuote({ customerId: c.id, title: `Labor quote for ${c.name}` })}>
            <PlusIcon />
          </button>
        </div>
        {d.quotes.length === 0 ? (
          <p className="muted small">No quotes yet.</p>
        ) : (
          <div className="mini-list">
            {d.quotes.map((q) => (
              <Link key={q.id} href={`/quotes/${q.id}`} className="mini">
                <span className="av c2" aria-hidden="true" style={{ fontSize: 12 }}>#{q.number}</span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <b>{q.title}</b>
                  <div className="meta">{money(q.total)} · {fmtDate(String(q.created_at).slice(0, 10))}</div>
                </div>
                <Pill status={q.status} />
              </Link>
            ))}
          </div>
        )}
      </aside>

      {open && (
        <ContactDetails
          c={d.contacts.find((x) => x.id === open.id) ?? open}
          company={c.name}
          address={mainAddress}
          onClose={() => setOpen(null)}
          onEdit={() => { const p = d.contacts.find((x) => x.id === open.id) ?? open; setOpen(null); editContact(p); }}
        />
      )}
      {cf && (
        <Modal title={cf.id ? 'Edit contact' : 'Add a contact'} onClose={() => setCf(null)}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const body = { name: cf.name, title: cf.title || null, email: cf.email || null, phone: cf.phone || null, notes: cf.notes || null };
              await run(cf.id ? api(`/api/customer-contacts/${cf.id}`, { method: 'PATCH', body }) : api(`/api/customers/${id}/contacts`, { body }));
              setCf(null);
            }}
          >
            <div className="two">
              <label>Name<input value={cf.name} onChange={(e) => setCf({ ...cf, name: e.target.value })} required maxLength={150} autoFocus /></label>
              <label>Role / title<input value={cf.title} onChange={(e) => setCf({ ...cf, title: e.target.value })} maxLength={100} placeholder="Producer, accounts payable…" /></label>
              <label>Email<input type="email" value={cf.email} onChange={(e) => setCf({ ...cf, email: e.target.value })} /></label>
              <label>Phone<input value={cf.phone} onChange={(e) => setCf({ ...cf, phone: e.target.value })} /></label>
            </div>
            <label>Notes<textarea rows={3} value={cf.notes} onChange={(e) => setCf({ ...cf, notes: e.target.value })} maxLength={2000} placeholder="Best time to call, who they report to…" /></label>
            <div className="acts">
              {cf.id && (
                <button type="button" className="btn ghost danger" style={{ marginRight: 'auto' }} onClick={() => confirm(`Remove ${cf.name}?`) && run(api(`/api/customer-contacts/${cf.id}`, { method: 'DELETE' })).then(() => setCf(null))}>
                  Remove
                </button>
              )}
              <button type="button" className="btn" onClick={() => setCf(null)}>Cancel</button>
              <button className="btn primary">{cf.id ? 'Save contact' : 'Add contact'}</button>
            </div>
          </form>
        </Modal>
      )}
      {lf && (
        <Modal title={lf.id ? 'Edit location' : 'Add a location'} onClose={() => setLf(null)}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const body = { label: lf.label, venue: lf.venue || null, address: lf.address || null };
              await run(lf.id ? api(`/api/customer-locations/${lf.id}`, { method: 'PATCH', body }) : api(`/api/customers/${id}/locations`, { body }));
              setLf(null);
            }}
          >
            <div className="two">
              <label>Name<input value={lf.label} onChange={(e) => setLf({ ...lf, label: e.target.value })} required maxLength={100} placeholder="Head office, Warehouse, Arena…" autoFocus /></label>
              <label>Venue name<input value={lf.venue} onChange={(e) => setLf({ ...lf, venue: e.target.value })} maxLength={200} /></label>
            </div>
            <label>Street address<input value={lf.address} onChange={(e) => setLf({ ...lf, address: e.target.value })} maxLength={300} /></label>
            <div className="acts">
              {lf.id && (
                <button type="button" className="btn ghost danger" style={{ marginRight: 'auto' }} onClick={() => confirm(`Remove ${lf.label}?`) && run(api(`/api/customer-locations/${lf.id}`, { method: 'DELETE' })).then(() => setLf(null))}>
                  Remove
                </button>
              )}
              <button type="button" className="btn" onClick={() => setLf(null)}>Cancel</button>
              <button className="btn primary">{lf.id ? 'Save location' : 'Add location'}</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

export default function Page() {
  return <Shell roles={['admin', 'manager']}>{() => <Body />}</Shell>;
}
