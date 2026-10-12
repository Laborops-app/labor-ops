'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import CustomerSelect from '@/components/CustomerSelect';

/** Start a new event from an old one: same details, phases and shifts, moved to a new date. Crew are not copied. */
export default function CopyEvent({ eventId, name, customerId = null, onError, label = 'Copy into new event' }: { eventId: string; name: string; customerId?: string | null; onError?: (m: string) => void; label?: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: '', startDate: '', includePhases: true, includeShifts: true, customerId: customerId as string | null });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const show = () => { setF({ name: `${name} (copy)`, startDate: '', includePhases: true, includeShifts: true, customerId }); setErr(''); setOpen(true); };
  const go = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      const r = await api<{ event: { id: string } }>(`/api/events/${eventId}/copy`, { body: { name: f.name, startDate: f.startDate, includePhases: f.includePhases, includeShifts: f.includeShifts, customerId: f.customerId || undefined } });
      router.push(`/events/${r.event.id}`);
    } catch (x) {
      setErr((x as Error).message);
      onError?.((x as Error).message);
      setBusy(false);
    }
  };
  if (!open) return <button className="btn small" onClick={show}>{label}</button>;
  return (
    <form className="card" onSubmit={go} style={{ marginTop: '.5rem', textAlign: 'left', flexBasis: '100%' }}>
      <h2>Copy "{name}" into a new event</h2>
      <p className="muted small">Details, phases and shifts come across, moved so the first day lands on the date you pick. Crew assignments are not copied. You can change anything afterwards.</p>
      {err && <div className="banner error" role="alert">{err}</div>}
      <div className="grid-form">
        <label>New event name<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={150} /></label>
        <label>First day of the new event<input type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} required /></label>
        <CustomerSelect value={f.customerId} onPick={(c) => setF({ ...f, customerId: c?.id ?? null })} />
      </div>
      <label className="row" style={{ gap: '.4rem' }}><input type="checkbox" style={{ width: 'auto' }} checked={f.includePhases} onChange={(e) => setF({ ...f, includePhases: e.target.checked })} /> Copy phases (load-in, show, strike)</label>
      <label className="row" style={{ gap: '.4rem' }}><input type="checkbox" style={{ width: 'auto' }} checked={f.includeShifts} onChange={(e) => setF({ ...f, includeShifts: e.target.checked })} /> Copy shifts (roles, times, headcount)</label>
      <div className="row" style={{ marginTop: '.6rem' }}>
        <button className="btn primary" disabled={busy}>{busy ? 'Copying…' : 'Create the copy'}</button>
        <button type="button" className="btn ghost" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </form>
  );
}
