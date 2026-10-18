'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import ClientFrame from '@/components/ClientFrame';
import { Banner } from '@/components/ui';
import { api } from '@/lib/api';

type Pos = { role: string; count: string; date: string; start: string; end: string };

function Body() {
  const router = useRouter();
  const [positions, setPositions] = useState<string[]>([]);
  const [f, setF] = useState({ name: '', venue: '', address: '', startDate: '', endDate: '', notes: '' });
  const [rows, setRows] = useState<Pos[]>([{ role: '', count: '1', date: '', start: '08:00', end: '16:00' }]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api<{ positions: string[] }>('/api/client/positions').then((r) => setPositions(r.positions)).catch(() => {}); }, []);
  const setRow = (i: number, p: Partial<Pos>) => setRows(rows.map((r, k) => (k === i ? { ...r, ...p } : r)));
  const iso = (d: string, t: string, nextDay = false) => {
    const x = new Date(`${d}T${t}`);
    if (nextDay) x.setDate(x.getDate() + 1);
    return x.toISOString();
  };
  return (
    <>
      <h1>Request crew</h1>
      <p className="muted">Tell us about the event and the people you need. The team confirms the details and books the crew; you’ll see them on the event once they’re confirmed.</p>
      {err && <Banner onClose={() => setErr('')}>{err}</Banner>}
      <form className="card" onSubmit={async (e) => {
        e.preventDefault();
        setErr(''); setBusy(true);
        try {
          const positionsBody = rows.filter((r) => r.role.trim() && (r.date || f.startDate)).map((r) => ({
            role: r.role.trim(), count: Number(r.count) || 1, startsAt: iso(r.date || f.startDate, r.start), endsAt: iso(r.date || f.startDate, r.end, r.end <= r.start),
          }));
          const res = await api<{ event: { id: string } }>('/api/client/requests', { body: { ...f, endDate: f.endDate || f.startDate, positions: positionsBody } });
          router.push(`/client/events/${res.event.id}`);
        } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
      }}>
        <div className="grid2">
          <label>Event name<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={150} placeholder="Spring Expo" /></label>
          <label>Venue<input value={f.venue} onChange={(e) => setF({ ...f, venue: e.target.value })} maxLength={200} /></label>
          <label>Address<input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} maxLength={300} /></label>
          <div className="row" style={{ gap: 10 }}>
            <label style={{ flex: 1 }}>First day<input type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value, endDate: f.endDate && f.endDate >= e.target.value ? f.endDate : e.target.value })} required /></label>
            <label style={{ flex: 1 }}>Last day<input type="date" value={f.endDate} min={f.startDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} /></label>
          </div>
        </div>
        <h3>People you need</h3>
        <datalist id="cp-positions">{positions.map((p) => <option key={p} value={p} />)}</datalist>
        {rows.map((r, i) => (
          <div key={i} className="cp-pos">
            <label>Position<input list="cp-positions" value={r.role} onChange={(e) => setRow(i, { role: e.target.value })} placeholder="Stagehand" maxLength={100} /></label>
            <label>How many<input type="number" min={1} max={200} value={r.count} onChange={(e) => setRow(i, { count: e.target.value })} /></label>
            <label>Day<input type="date" value={r.date || f.startDate} min={f.startDate} max={f.endDate || undefined} onChange={(e) => setRow(i, { date: e.target.value })} onFocus={() => !r.date && f.startDate && setRow(i, { date: f.startDate })} /></label>
            <label>From<input type="time" value={r.start} onChange={(e) => setRow(i, { start: e.target.value })} /></label>
            <label>To<input type="time" value={r.end} onChange={(e) => setRow(i, { end: e.target.value })} /></label>
            {rows.length > 1 && <button type="button" className="btn ghost small" aria-label="Remove this position" onClick={() => setRows(rows.filter((_, k) => k !== i))}>×</button>}
          </div>
        ))}
        <button type="button" className="btn small" onClick={() => setRows([...rows, { ...rows[rows.length - 1], role: '', count: '1' }])}>+ Another position</button>
        <label style={{ marginTop: 12, display: 'grid' }}>Anything else we should know?<textarea rows={4} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} maxLength={4000} placeholder="Load-in door, parking, certifications needed, dress code…" /></label>
        <div className="row" style={{ marginTop: 12 }}><button className="btn primary" disabled={busy}>{busy ? 'Sending…' : 'Send request'}</button></div>
      </form>
    </>
  );
}

export default function Page() {
  return <ClientFrame>{() => <Body />}</ClientFrame>;
}
