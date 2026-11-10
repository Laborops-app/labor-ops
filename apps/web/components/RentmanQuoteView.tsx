'use client';
import Link from 'next/link';
import { useState } from 'react';
import { api, money, fmtDate } from '@/lib/api';
import { Banner } from '@/components/ui';

type D = {
  quote: {
    id: string; number: number; title: string; status: string; customer_name: string | null; event_id: string | null; event_name: string | null; valid_until: string | null; intro: string | null;
    sent_at: string | null; rentman_number?: string | null; rentman_version?: number | null; rentman_total?: string | null; rentman_crew_total?: string | null; rentman_transport_total?: string | null; imported_at?: string | null;
  };
  lines: { section: string | null; description: string; day: string | null; startTime: string | null; endTime: string | null; qty: number; hours: number; rate: number; amount?: number }[];
  totals: { subtotal: number; discount: number; tax: number; total: number };
};

/** A quote pulled in from Rentman: read-only here. Its answer from the client is recorded by hand. */
export default function RentmanQuoteView<T extends D>({ d, onChange }: { d: T; onChange: (r: T) => void }) {
  const q = d.quote;
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const setStatus = async (status: 'sent' | 'accepted' | 'declined') => {
    setBusy(true);
    setError('');
    try {
      onChange(await api<T>(`/api/quotes/${q.id}/status`, { body: { status } }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const n = (v: string | null | undefined) => Number(v ?? 0);
  return (
    <>
      {error && <Banner onClose={() => setError('')}>{error}</Banner>}
      <section className="card">
        <div className="row space" style={{ flexWrap: 'wrap', gap: 8 }}>
          <div>
            <h2 style={{ margin: 0 }}>#{q.number} · {q.title}</h2>
            <p className="muted small" style={{ margin: '4px 0 0' }}>
              <span className="pill rentman-pill">Rentman {q.rentman_number}{q.rentman_version ? ` · version ${q.rentman_version}` : ''}</span>{' '}
              {q.customer_name ?? 'No customer'}
              {q.event_id && <> · <Link href={`/events/${q.event_id}`}>{q.event_name}</Link></>}
              {q.sent_at && ` · dated ${fmtDate(String(q.sent_at).slice(0, 10))}`}
              {q.valid_until && ` · valid until ${fmtDate(String(q.valid_until).slice(0, 10))}`}
            </p>
          </div>
          <div className="row" style={{ gap: 6 }}>
            <span className={`pill ${q.status}`}>{q.status}</span>
            {(['accepted', 'declined', 'sent'] as const).filter((s) => s !== q.status).map((s) => (
              <button key={s} type="button" className="btn small" disabled={busy} onClick={() => setStatus(s)}>
                {s === 'accepted' ? 'Mark accepted' : s === 'declined' ? 'Mark declined' : 'Mark waiting'}
              </button>
            ))}
          </div>
        </div>
        <Banner kind="info">
          Pulled in from Rentman{q.imported_at ? ` on ${new Date(q.imported_at).toLocaleString()}` : ''}. It is read-only here: change it in Rentman, then pull it again from the event’s Invoice tab. It is what the event’s invoice is checked against.
        </Banner>
        <div className="qc-sum" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
          <div className="card" style={{ margin: 0 }}><span className="muted small">Crew (here)</span><br /><b>{money(d.totals.subtotal)}</b></div>
          <div className="card" style={{ margin: 0 }}><span className="muted small">Crew in Rentman</span><br /><b>{money(n(q.rentman_crew_total))}</b></div>
          <div className="card" style={{ margin: 0 }}><span className="muted small">Transport (stays in Rentman)</span><br /><b>{money(n(q.rentman_transport_total))}</b></div>
          <div className="card" style={{ margin: 0 }}><span className="muted small">Whole Rentman quote</span><br /><b>{money(n(q.rentman_total))}</b></div>
        </div>
      </section>
      <section className="card">
        <h2>Crew lines</h2>
        {d.lines.length === 0 ? (
          <p className="muted">No crew functions on the financial documents of this Rentman project.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Section</th><th>Position</th><th>Day</th><th>Time</th><th>People</th><th>Hours</th><th style={{ textAlign: 'right' }}>Amount</th></tr></thead>
              <tbody>
                {d.lines.map((l, i) => (
                  <tr key={i}>
                    <td>{l.section ?? <span className="muted">—</span>}</td>
                    <td>{l.description}</td>
                    <td>{l.day ? fmtDate(l.day) : <span className="muted">—</span>}</td>
                    <td>{l.startTime && l.endTime ? `${l.startTime}–${l.endTime}` : <span className="muted">—</span>}</td>
                    <td>{l.qty}</td>
                    <td>{l.hours}</td>
                    <td style={{ textAlign: 'right' }}>{money(l.amount ?? l.qty * l.hours * l.rate)}</td>
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
