'use client';
import { useEffect, useState } from 'react';
import { Banner, Empty } from '@/components/ui';
import { api, money } from '@/lib/api';
import { askConfirm } from '@/components/Toasts';

type Adj = { id: string; kind: 'cancellation' | 'manual'; date: string; hours: number; amount: number | null; note: string | null; event_name: string | null; role_name: string | null; voided_at: string | null; exported_at: string | null; user_name: string; created_by_name: string | null };
type Person = { id: string; name: string; role: string };

/** Cancellation pay and manual adjustments in a pay period: list, void, add. */
export default function PayAdjustments({ from, to, onChanged, known = [] }: { from: string; to: string; onChanged: () => void; known?: { id: string; name: string }[] }) {
  const [list, setList] = useState<Adj[] | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [f, setF] = useState<{ userId: string; date: string; hours: string; amount: string; note: string } | null>(null);
  const [err, setErr] = useState('');
  const load = () => api<{ adjustments: Adj[] }>(`/api/pay-adjustments?from=${from}&to=${to}`).then((r) => setList(r.adjustments)).catch((e) => setErr(e.message));
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [from, to]);
  const startAdd = async () => {
    if (!people.length) {
      try { setPeople((await api<{ crew: Person[] }>('/api/crew')).crew.filter((p) => p.role === 'crew')); } catch { setPeople(known.map((k) => ({ ...k, role: 'crew' }))); }
    }
    setF({ userId: '', date: to, hours: '', amount: '', note: '' });
  };
  return (
    <section className="card">
      <div className="row space">
        <h2 style={{ margin: 0 }}>Cancellation pay and adjustments</h2>
        {!f && <button type="button" className="btn small" onClick={startAdd}>+ Add adjustment</button>}
      </div>
      <p className="muted small">Calls cut at short notice are paid here automatically under the event’s work rules. Add anything else by hand (a bonus, a reimbursement, a correction). They’re included in this period’s totals and export files.</p>
      {err && <Banner onClose={() => setErr('')}>{err}</Banner>}
      {f && (
        <form className="grid4" style={{ marginBottom: 12 }} onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api('/api/pay-adjustments', { body: { userId: f.userId, date: f.date, hours: f.hours ? Number(f.hours) : 0, amount: f.amount ? Number(f.amount) : null, note: f.note } });
            setF(null); load(); onChanged();
          } catch (x) { setErr((x as Error).message); }
        }}>
          <label>Crew member
            <select value={f.userId} onChange={(e) => setF({ ...f, userId: e.target.value })} required>
              <option value="">Choose…</option>
              {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label>Date<input type="date" value={f.date} min={from} max={to} onChange={(e) => setF({ ...f, date: e.target.value })} required /></label>
          <label>Hours<input type="number" step="0.25" min={0} max={24} value={f.hours} onChange={(e) => setF({ ...f, hours: e.target.value })} placeholder="or an amount" /></label>
          <label>Amount ($)<input type="number" step="0.01" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} placeholder="e.g. 25 or -10" /></label>
          <label style={{ gridColumn: '1 / -1' }}>Note<input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} required maxLength={300} placeholder="Parking reimbursement" /></label>
          <div className="row"><button className="btn primary small">Add</button><button type="button" className="btn ghost small" onClick={() => setF(null)}>Cancel</button></div>
        </form>
      )}
      {!list ? <div className="muted small">Loading…</div> : list.length === 0 ? <Empty>None in this period.</Empty> : (
        <div className="table-wrap">
          <table className="table small">
            <thead><tr><th>Date</th><th>Crew</th><th>What</th><th>Hours / amount</th><th></th></tr></thead>
            <tbody>
              {list.map((a) => (
                <tr key={a.id} className={a.voided_at ? 'muted' : ''}>
                  <td>{a.date}</td>
                  <td>{a.user_name}</td>
                  <td>
                    <span className={`chip ${a.kind === 'cancellation' ? 'warn' : ''}`}>{a.kind === 'cancellation' ? 'Cancellation' : 'Adjustment'}</span>{' '}
                    {[a.event_name, a.role_name].filter(Boolean).join(' · ')}
                    {a.note && <div className="muted">{a.note}</div>}
                  </td>
                  <td>{a.amount !== null ? money(a.amount) : `${a.hours} h`}</td>
                  <td>
                    {a.voided_at ? 'voided' : a.exported_at ? <span className="chip warn">exported</span> : (
                      <button type="button" className="btn ghost small" onClick={async () => {
                        if (!(await askConfirm('Void this? It won’t be paid.'))) return;
                        try { await api(`/api/pay-adjustments/${a.id}/void`, { body: {} }); load(); onChanged(); } catch (x) { setErr((x as Error).message); }
                      }}>Void</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
