'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import Shell from '@/components/Shell';
import { Banner, Empty } from '@/components/ui';
import { api, fmtDateTime } from '@/lib/api';

type Dash = {
  crewCount: number;
  upcomingShifts: number;
  openSlots: number;
  pendingApprovals: number;
  clockedIn: { name: string; clock_in: string; role_name: string; event_name: string }[];
};

function Body({ name }: { name: string }) {
  const [d, setD] = useState<Dash | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const load = () => api<Dash>('/api/dashboard').then(setD).catch((e) => setError(e.message));
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);
  return (
    <>
      <h1>Welcome, {name.split(' ')[0]}</h1>
      {error && <Banner>{error}</Banner>}
      {d && (
        <>
          <div className="stats">
            <Link href="/crew" className="stat">
              <b>{d.crewCount}</b>
              <span>Active crew</span>
            </Link>
            <Link href="/events" className="stat">
              <b>{d.upcomingShifts}</b>
              <span>Upcoming shifts</span>
            </Link>
            <Link href="/events" className={`stat ${d.openSlots ? 'warn' : ''}`}>
              <b>{d.openSlots}</b>
              <span>Open slots to fill</span>
            </Link>
            <Link href="/timesheets" className={`stat ${d.pendingApprovals ? 'warn' : ''}`}>
              <b>{d.pendingApprovals}</b>
              <span>Timesheets to approve</span>
            </Link>
          </div>
          <section className="card">
            <h2>On the clock now</h2>
            {d.clockedIn.length === 0 ? (
              <Empty>Nobody is clocked in right now.</Empty>
            ) : (
              <table>
                <tbody>
                  {d.clockedIn.map((c, i) => (
                    <tr key={i}>
                      <td>
                        <b>{c.name}</b>
                      </td>
                      <td>
                        {c.role_name} · {c.event_name}
                      </td>
                      <td className="muted">since {fmtDateTime(c.clock_in)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </>
  );
}

export default function Page() {
  return <Shell roles={['admin', 'manager']}>{(me) => <Body name={me.name} />}</Shell>;
}
