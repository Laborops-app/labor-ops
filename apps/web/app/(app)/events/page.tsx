'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import Shell from '@/components/Shell';
import Modal from '@/components/Modal';
import TopbarAction, { PlusIcon, EditIcon, SearchIcon } from '@/components/TopbarAction';
import { Banner, Empty } from '@/components/ui';
import { api, fmtDate } from '@/lib/api';
import RentmanPicker from '@/components/RentmanPicker';
import CustomerSelect from '@/components/CustomerSelect';
import LocationPick from '@/components/LocationPick';

type Ev = { id: string; name: string; client: string | null; venue: string | null; start_date: string; end_date: string; shift_count: number; slots: number; accepted: number; filled?: number };
type View = 'upcoming' | 'past' | 'all';
const today = () => new Date().toISOString().slice(0, 10);
const PAGE = 25;

function DateBadge({ date }: { date: string }) {
  const d = new Date(`${date}T12:00:00`);
  return (
    <span className="av c1" aria-hidden="true" style={{ display: 'grid', lineHeight: 1.05, fontSize: 11, textTransform: 'uppercase' }}>
      <span>{d.toLocaleDateString('en-US', { month: 'short' })}</span>
      <b style={{ fontSize: 15 }}>{d.getDate()}</b>
    </span>
  );
}

/** Where the event stands: green when every seat has crew, yellow when some do, red when none do. */
function status(ev: Ev) {
  const t = today(), s = ev.start_date.slice(0, 10), e = ev.end_date.slice(0, 10);
  if (e < t) return { label: 'Done', cls: 'done' };
  if (!ev.slots) return { label: 'No shifts', cls: 'past' };
  const filled = ev.filled ?? ev.accepted;
  const live = s <= t ? 'In progress · ' : '';
  if (filled >= ev.slots) return { label: `${live}Fully staffed`, cls: 'staff-good' };
  if (filled > 0) return { label: `${live}Partly staffed`, cls: 'staff-warn' };
  return { label: `${live}No crew yet`, cls: 'staff-bad' };
}

function Body() {
  const router = useRouter();
  const [list, setList] = useState<Ev[] | null>(null);
  const [error, setError] = useState('');
  const [view, setView] = useState<View>('upcoming');
  const [q, setQ] = useState('');
  const [shown, setShown] = useState(PAGE);
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ name: '', client: '', venue: '', address: '', startDate: today(), endDate: today() });
  const [rm, setRm] = useState<number | null>(null);
  const [cust, setCust] = useState<string | null>(null);

  useEffect(() => {
    api<{ events: Ev[] }>('/api/events')
      .then((r) => setList(r.events))
      .catch((e) => setError(e.message));
  }, []);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      const r = await api<{ event: { id: string } }>('/api/events', { body: { ...f, client: f.client || null, venue: f.venue || null, address: f.address || null, rentmanProjectId: rm, customerId: cust || undefined } });
      router.push(`/events/${r.event.id}`);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const t = today();
  const needle = q.trim().toLowerCase();
  const rows = (list ?? [])
    .filter((ev) => (view === 'all' ? true : view === 'past' ? ev.end_date.slice(0, 10) < t : ev.end_date.slice(0, 10) >= t))
    .filter((ev) => !needle || `${ev.name} ${ev.client ?? ''} ${ev.venue ?? ''}`.toLowerCase().includes(needle))
    // upcoming soonest first; past most recent first
    .sort((a, b) => (view === 'upcoming' ? a.start_date.localeCompare(b.start_date) : b.start_date.localeCompare(a.start_date)));
  const counts = { upcoming: (list ?? []).filter((e) => e.end_date.slice(0, 10) >= t).length, past: (list ?? []).filter((e) => e.end_date.slice(0, 10) < t).length, all: (list ?? []).length };

  return (
    <>
      <h1>Events</h1>
      <TopbarAction>
        <button className="btn primary" onClick={() => setAdding(true)}>
          Add New Event
          <PlusIcon />
        </button>
      </TopbarAction>
      {error && <Banner onClose={() => setError('')}>{error}</Banner>}

      <div className="list-head">
        <div className="row" style={{ gap: 16 }}>
          <div className="total">Total: {list ? rows.length : '…'} event{rows.length === 1 ? '' : 's'}</div>
          <div className="phase-tabs" role="tablist" aria-label="Which events" style={{ margin: 0 }}>
            {(['upcoming', 'past', 'all'] as View[]).map((v) => (
              <button key={v} type="button" role="tab" aria-selected={view === v} className={view === v ? 'tab on' : 'tab'} onClick={() => { setView(v); setShown(PAGE); }}>
                {v[0].toUpperCase() + v.slice(1)} ({counts[v]})
              </button>
            ))}
          </div>
        </div>
        <div className="controls">
          <span className="pill-input">
            <SearchIcon />
            <input value={q} onChange={(e) => { setQ(e.target.value); setShown(PAGE); }} placeholder="Search event, client, venue" aria-label="Search events" />
          </span>
        </div>
      </div>

      {!list ? (
        <div className="muted">Loading…</div>
      ) : rows.length === 0 ? (
        <Empty>{list.length ? 'No events here.' : 'No events yet. Add one, then add shifts to it.'}</Empty>
      ) : (
        <div className="table-wrap">
          <table className="dlist">
            <thead>
              <tr>
                <th className="av-col" aria-label="Date" />
                <th>Name</th>
                <th className="hide-sm">Venue</th>
                <th>Dates</th>
                <th>Crew</th>
                <th>Status</th>
                <th className="edit-col">Edit</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, shown).map((ev) => {
                const s0 = ev.start_date.slice(0, 10), e0 = ev.end_date.slice(0, 10);
                const st = status(ev);
                const filled = ev.filled ?? ev.accepted;
                const pct = ev.slots ? Math.min(100, Math.round((filled / ev.slots) * 100)) : 0;
                return (
                  <tr key={ev.id} onClick={() => router.push(`/events/${ev.id}`)}>
                    <td className="av-col"><DateBadge date={s0} /></td>
                    <td>
                      <Link href={`/events/${ev.id}`} className="rowlink" onClick={(e) => e.stopPropagation()}>{ev.name}</Link>
                      {ev.client && <span className="sub">{ev.client}</span>}
                    </td>
                    <td className="hide-sm">{ev.venue ?? <span className="muted">—</span>}</td>
                    <td>
                      {fmtDate(s0)}
                      {e0 !== s0 && <span className="sub">to {fmtDate(e0)}</span>}
                    </td>
                    <td>
                      {filled} / {ev.slots}
                      <span className={`mini-bar ${st.cls}`} aria-hidden="true"><i style={{ width: `${pct}%` }} /></span>
                    </td>
                    <td><span className={`pill ${st.cls}`}>{st.label}</span></td>
                    <td className="edit-col">
                      <Link href={`/events/${ev.id}`} className="btn-round sm" aria-label={`Open ${ev.name}`} onClick={(e) => e.stopPropagation()} style={{ border: 0, background: 'transparent' }}>
                        <EditIcon />
                      </Link>
                    </td>
                  </tr>
                );
              })}
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
        <Modal title="Add New Event" onClose={() => setAdding(false)}>
          <form onSubmit={add}>
            <RentmanPicker
              value={rm}
              onPick={(p) => {
                setRm(p ? p.id : null);
                if (p) {
                  // Picking a project fills in everything it knows: name, customer, client, venue, street address and dates.
                  setCust(p.customer_local_id ?? null);
                  setF((x) => ({
                    ...x,
                    name: p.name || x.name,
                    client: p.customer || x.client,
                    venue: p.location || x.venue,
                    address: p.location_address || x.address,
                    startDate: p.planperiod_start ? p.planperiod_start.slice(0, 10) : x.startDate,
                    endDate: p.planperiod_end ? p.planperiod_end.slice(0, 10) : p.planperiod_start ? p.planperiod_start.slice(0, 10) : x.endDate,
                  }));
                }
              }}
              label="Rentman project (optional, fills in the details below)"
            />
            <label>
              Event name
              <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required autoFocus />
            </label>
            <div className="two">
              <CustomerSelect value={cust} onPick={(c) => { setCust(c?.id ?? null); if (c) setF({ ...f, client: c.name }); }} />
              <label>
                Client name
                <input value={f.client} onChange={(e) => { setCust(null); setF({ ...f, client: e.target.value }); }} />
              </label>
            </div>
            <LocationPick customerId={cust} onPick={(l) => setF((x) => ({ ...x, venue: l.venue, address: l.address }))} />
            <div className="two">
              <label>
                Venue
                <input value={f.venue} onChange={(e) => setF({ ...f, venue: e.target.value })} />
              </label>
              <label>
                Street address
                <input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} placeholder="123 Main St, Denver, CO" />
              </label>
              <label>
                Starts
                <input type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value, endDate: e.target.value > f.endDate ? e.target.value : f.endDate })} required />
              </label>
              <label>
                Ends
                <input type="date" value={f.endDate} min={f.startDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} required />
              </label>
            </div>
            <div className="acts">
              <button type="button" className="btn" onClick={() => setAdding(false)}>Cancel</button>
              <button className="btn primary">Create Event</button>
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
