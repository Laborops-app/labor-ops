'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, money } from '@/lib/api';

/** The event's labor budget: compared with the approved labor cost on the Reports page. */
export default function LaborBudget({ eventId, budget, onError }: { eventId: string; budget: number | string | null | undefined; onError: (m: string) => void }) {
  const saved = budget === null || budget === undefined ? '' : String(Number(budget));
  const [v, setV] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState(false);
  useEffect(() => setV(saved), [saved]);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setOk(false);
    try {
      await api(`/api/events/${eventId}/budget`, { method: 'PUT', body: { budget: v.trim() === '' ? null : Number(v) } });
      setOk(true);
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card aside-form">
      <h2>Labor budget</h2>
      <form onSubmit={save} className="row" style={{ gap: '.5rem', alignItems: 'flex-end' }}>
        <label style={{ flex: 1, margin: 0 }}>
          <span className="sr-only">Labor budget in dollars</span>
          <input type="number" min={0} step="0.01" inputMode="decimal" placeholder="No budget" value={v} onChange={(e) => { setV(e.target.value); setOk(false); }} />
        </label>
        <button className="btn small" disabled={busy || v === saved}>{busy ? 'Saving…' : 'Save'}</button>
      </form>
      <p className="muted small" style={{ marginBottom: 0 }}>
        {ok && v ? `Saved: ${money(Number(v))}. ` : ''}Compare it with what the crew actually cost under <Link href="/reports">Reports</Link>.
      </p>
    </section>
  );
}
