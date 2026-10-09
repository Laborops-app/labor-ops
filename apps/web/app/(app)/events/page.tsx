'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import Shell from '@/components/Shell';
import { Banner, Empty } from '@/components/ui';
import { api, fmtDate } from '@/lib/api';

type Ev = { id: string; name: string; venue: string | null; start_date: string; end_date: string; shift_count: number; slots: number; accepted: number };
const today = () => new Date().toISOString().slice(0, 10);

function Body() {
  const [list, setList] = useState<Ev[] | null>(null);
  const [error, setError] = useState('');
  const [f, setF] = useState({ name: '', venue: '', startDate: today(), endDate: today() });

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
      await api('/api/events', { body: { ...f, venue: f.venue || null } });
      setF({ name: '', venue: '', startDate: today(), endDate: today() });
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
          <label>
            Name
            <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
          </label>
          <label>
            Venue
            <input value={f.venue} onChange={(e) => setF({ ...f, venue: e.target.value })} />
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
      <section className="card">
        {!list ? (
          <div className="muted">Loading…</div>
        ) : list.length === 0 ? (
          <Empty>No events yet. Create one above, then add shifts to it.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Event</th>
                  <th>Dates</th>
                  <th>Shifts</th>
                  <th>Filled</th>
                </tr>
              </thead>
              <tbody>
                {list.map((ev) => (
                  <tr key={ev.id}>
                    <td>
                      <Link href={`/events/${ev.id}`}>
                        <b>{ev.name}</b>
                      </Link>
                      {ev.venue && <div className="muted small">{ev.venue}</div>}
                    </td>
                    <td className="small">
                      {fmtDate(ev.start_date.slice(0, 10))}
                      {ev.end_date.slice(0, 10) !== ev.start_date.slice(0, 10) && <> – {fmtDate(ev.end_date.slice(0, 10))}</>}
                    </td>
                    <td>{ev.shift_count}</td>
                    <td>
                      {ev.slots === 0 ? (
                        <span className="muted">–</span>
                      ) : (
                        <span className={ev.accepted >= ev.slots ? 'good' : ''}>
                          {ev.accepted} / {ev.slots} confirmed
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

export default function Page() {
  return <Shell roles={['admin', 'manager']}>{() => <Body />}</Shell>;
}
