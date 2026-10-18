'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import ClientFrame from '@/components/ClientFrame';
import { Banner, Empty } from '@/components/ui';
import { api, fmtDate } from '@/lib/api';

type Ev = {
  id: string; name: string; venue: string | null; start_date: string; end_date: string; pipeline_status: string; customer: string; needs_approval: boolean; requested: boolean;
  slots: number; confirmed: number; on_site: number; approved_entries: number; signoff: 'approved' | 'disputed' | 'changed' | 'waiting' | null; invoices: number;
};
const STATUS: Record<string, string> = { pending: 'Requested', quote: 'Quoted', confirmed: 'Confirmed', in_progress: 'In progress', completed: 'Completed', canceled: 'Canceled' };
const SIGN: Record<string, [string, string]> = { approved: ['Signed off', 'accepted'], disputed: ['Questioned', 'declined'], changed: ['Changed since sign-off', 'offered'], waiting: ['Ready for your sign-off', 'offered'] };
const today = () => new Date().toISOString().slice(0, 10);

function Card({ e }: { e: Ev }) {
  const dates = e.start_date === e.end_date ? fmtDate(e.start_date) : `${fmtDate(e.start_date)} – ${fmtDate(e.end_date)}`;
  return (
    <Link href={`/client/events/${e.id}`} className="card cp-card">
      <div className="row space" style={{ alignItems: 'flex-start' }}>
        <div>
          <b>{e.name}</b>
          <div className="muted small">{dates}{e.venue ? ` · ${e.venue}` : ''}{e.customer ? ` · ${e.customer}` : ''}</div>
        </div>
        <span className="pill">{STATUS[e.pipeline_status] ?? e.pipeline_status}</span>
      </div>
      <div className="cp-stats small">
        {e.slots > 0 && <span><b>{e.confirmed}</b>/{e.slots} crew confirmed</span>}
        {e.on_site > 0 && <span className="good-text"><b>{e.on_site}</b> on site now</span>}
        {e.signoff && <span className={`pill ${SIGN[e.signoff][1]}`}>{SIGN[e.signoff][0]}</span>}
        {e.invoices > 0 && <span>{e.invoices} invoice{e.invoices === 1 ? '' : 's'}</span>}
      </div>
    </Link>
  );
}

function Body() {
  const [d, setD] = useState<{ events: Ev[] } | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    const load = () => api<{ events: Ev[] }>('/api/client/overview').then(setD).catch((e) => setErr(e.message));
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);
  if (!d) return err ? <Banner>{err}</Banner> : <div className="muted">Loading…</div>;
  const t = today();
  const sign = d.events.filter((e) => e.signoff === 'waiting' || e.signoff === 'changed');
  const live = d.events.filter((e) => e.start_date <= t && e.end_date >= t && !sign.includes(e));
  const upcoming = d.events.filter((e) => e.start_date > t).sort((a, b) => a.start_date.localeCompare(b.start_date));
  const past = d.events.filter((e) => e.end_date < t && !sign.includes(e));
  const group = (title: string, list: Ev[], empty?: string) => (list.length || empty) ? (
    <section className="cp-group">
      <h2>{title}</h2>
      {list.length ? <div className="cp-cards">{list.map((e) => <Card key={e.id} e={e} />)}</div> : <Empty>{empty}</Empty>}
    </section>
  ) : null;
  return (
    <>
      <div className="row space">
        <h1 style={{ margin: 0 }}>Your events</h1>
        <Link className="btn primary" href="/client/request">+ Request crew</Link>
      </div>
      {group('Waiting for your sign-off', sign)}
      {group('Happening now', live)}
      {group('Coming up', upcoming, 'Nothing scheduled yet.')}
      {group('Recent', past)}
    </>
  );
}

export default function Page() {
  return <ClientFrame>{() => <Body />}</ClientFrame>;
}
