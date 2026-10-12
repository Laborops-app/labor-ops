'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import Shell from '@/components/Shell';
import { Banner, Empty } from '@/components/ui';
import { api, fmtDate } from '@/lib/api';
import RentmanPicker from '@/components/RentmanPicker';

type Ev = { id: string; name: string; client: string | null; venue: string | null; start_date: string; end_date: string; shift_count: number; slots: number; accepted: number };
const today = () => new Date().toISOString().slice(0, 10);

function Body() {
  const [list, setList] = useState<Ev[] | null>(null);
  const [error, setError] = useState('');
  const [f, setF] = useState({ name: '', client: '', venue: '', address: '', startDate: today(), endDate: today() });
  const [rm, setRm] = useState<number | null>(null);

  const load = () =>
    api<{ events: Ev[] }>('/api/events')
      .then((r) => setList(r.events))
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await api('/api/events', { body: { ...f, client: f.client || null, venue: f.venue || null, address: f.address || null, rentmanProjectId: rm } });
      setRm(null);
      setF({ name: '', client: '', venue: '', address: '', startDate: today(), endDate: today() });
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <>
      <h1>Events</h1>
      {error && <Banner onClose={() => setError('')}>{error}</Banner>}
      <section className="card">
        <h2>New event</h2>
        <form className="grid-form" onSubmit={add}>
          <div style={{ gridColumn: '1 / -1' }}>
            <RentmanPicker
              value={rm}
              onPick={(p) => {
                setRm(p ? p.id : null);
                if (p)
                  setF((x) => ({
                    ...x,
                    name: x.name || p.name,
                    client: x.client || p.customer || '',
                    venue: x.venue || p.location || '',
                    startDate: p.planperiod_start ? p.planperiod_start.slice(0, 10) : x.startDate,
                    endDate: p.planperiod_end ? p.planperiod_end.slice(0, 10) : p.planperiod_start ? p.planperiod_start.slice(0, 10) : x.endDate,
                  }));
              }}
              label="Rentman project (optional, fills in the details below)"
            />
          </div>
          <label>
            Name
            <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
          </label>
          <label>
            Client
            <input value={f.client} onChange={(e) => setF({ ...f, client: e.target.value })} />
          </label>
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
            <input type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} required />
          </label>
          <label>
            Ends
            <input type="date" value={f.endDate} min={f.startDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} required />
          </label>
          <div className="form-actions">
            <button className="btn primary">Create event</button>
          </div>
        </form>
      </section>
      {!list ? (
        <div className="muted">Loading…</div>
      ) : list.length === 0 ? (
        <Empty>No events yet. Create one above, then add shifts to it.</Empty>
      ) : (
        <div className="cards3">
          {list.map((ev) => {
            const full = ev.slots > 0 && ev.accepted >= ev.slots;
            const s0 = ev.start_date.slice(0, 10);
            const e0 = ev.end_date.slice(0, 10);
            return (
              <Link key={ev.id} href={`/events/${ev.id}`} className="sc">
                <div className="sc-top">
                  <b>{ev.name}</b>
                  <span className={`badge ${full ? 'good' : ev.slots ? 'warn' : ''}`}>{full ? 'Full' : ev.slots ? 'Needs crew' : 'No shifts'}</span>
                </div>
                <div className="sub">
                  <span>
                    {fmtDate(s0)}
                    {e0 !== s0 && <> – {fmtDate(e0)}</>}
                  </span>
                  {ev.client && <span>{ev.client}</span>}
                  {ev.venue && <span>{ev.venue}</span>}
                </div>
                <div className="progress" aria-hidden="true">
                  <i style={{ width: `${ev.slots ? Math.min(100, (ev.accepted / ev.slots) * 100) : 0}%` }} />
                </div>
                <div className="meta">
                  <span>
                    {ev.shift_count} shift{ev.shift_count === 1 ? '' : 's'} · {ev.accepted} / {ev.slots} confirmed
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </>
  );
}

export default function Page() {
  return <Shell roles={['admin', 'manager']}>{() => <Body />}</Shell>;
}
