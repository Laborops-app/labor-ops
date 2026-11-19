'use client';
import { useCallback, useEffect, useState } from 'react';
import Shell from '@/components/Shell';
import { LogFeed } from '@/components/EventExtras';

/** Company-wide change log: who did what across every event (crew added/removed/declined, clock-ins, time edits, pay). */
function Body() {
  const [q, setQ] = useState('');
  const [qq, setQq] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  useEffect(() => { const t = setTimeout(() => setQq(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  const url = useCallback((p: URLSearchParams) => {
    if (qq) p.set('q', qq);
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    return `/api/activity?${p}`;
  }, [qq, from, to]);
  return (
    <div className="activity">
      <p className="muted">Every change people make in LaborOps, newest first: crew added, removed or declined, who clocked people in and out, time edits, shifts and pay.</p>
      <div className="row" style={{ gap: 10, flexWrap: 'wrap', margin: '10px 0 16px' }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Event or person" aria-label="Filter by event or person" style={{ flex: '1 1 220px', maxWidth: 320 }} />
        <label className="row small" style={{ gap: 6 }}>From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="row small" style={{ gap: 6 }}>To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      <section className="card"><LogFeed url={url} showEvent /></section>
    </div>
  );
}

export default function Page() {
  return <Shell roles={['admin', 'manager']}>{() => <Body />}</Shell>;
}
