'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import Shell from '@/components/Shell';
import { Banner, Empty } from '@/components/ui';
import { api, fmtDate, fmtTime } from '@/lib/api';

type Ev = { id: string; name: string; venue: string | null; start_date: string; end_date: string; kind: 'coordinator' | 'lead'; my_shifts: { role_name: string; starts_at: string; ends_at: string; is_lead: boolean }[] };

/** Events where this person checks crew in and rates them: as On-site Labor Coordinator, or as a lead on that event. */
function Body() {
  const [d, setD] = useState<{ coordinator?: boolean; events: Ev[] } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ coordinator?: boolean; events: Ev[] }>('/api/onsite/events').then(setD).catch((e) => setError(e.message));
  }, []);
  return (
    <>
      <h1>On site</h1>
      <p className="muted">
        {d?.coordinator
          ? 'As On-site Labor Coordinator you check in, check out and rate all the crew on the events you work.'
          : 'On events where you are a lead, you check in, check out and rate your team.'}
      </p>
      {error && <Banner onClose={() => setError('')}>{error}</Banner>}
      {!d ? (
        <div className="muted">Loading…</div>
      ) : d.events.length === 0 ? (
        <Empty>{d.coordinator ? 'No events yet. Events you are booked on (with a confirmed shift) show up here.' : 'No events where you are a lead right now.'}</Empty>
      ) : (
        d.events.map((e) => (
          <section className="card shift-card" key={e.id}>
            <div className="row space">
              <div>
                <h2>
                  <Link href={`/onsite/${e.id}`} className="shift-link">{e.name}</Link>
                </h2>
                <div className="muted small">
                  {fmtDate(e.start_date)}{e.end_date !== e.start_date ? ` – ${fmtDate(e.end_date)}` : ''}{e.venue ? ` · ${e.venue}` : ''}
                </div>
                {e.kind === 'lead' && <span className="chip lead-chip">★ Lead</span>}
                <div className="small">
                  Your shift{e.my_shifts.length > 1 ? 's' : ''}: {e.my_shifts.map((s) => `${s.role_name}, ${new Date(s.starts_at).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} ${fmtTime(s.starts_at)}–${fmtTime(s.ends_at)}`).join(' · ')}
                </div>
              </div>
            </div>
            <div className="row">
              <Link className="btn primary" href={`/onsite/${e.id}`}>Check crew in</Link>
              <Link className="btn ghost" href={`/onsite/${e.id}/rate`}>★ Rate crew</Link>
            </div>
          </section>
        ))
      )}
    </>
  );
}

export default function Page() {
  return <Shell roles={['crew']}>{() => <Body />}</Shell>;
}
