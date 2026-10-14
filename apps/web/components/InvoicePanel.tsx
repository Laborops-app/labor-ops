'use client';
import { useEffect, useState } from 'react';
import { api, ApiError, money, fmtDate } from '@/lib/api';
import { Banner, Empty } from '@/components/ui';

type Line = { role: string; date: string; kind: 'regular' | 'overtime' | 'double' | 'day'; qty: number; unit: 'hour' | 'day'; rate: number; amount: number; description: string; qboItemId: string | null };
type Billing = {
  lines: Line[]; total: number; warnings: string[]; canBill: boolean; unmapped: string[];
  customer: { name: string; qbo_customer_id: string | null } | null;
  quickbooks: { connected: boolean; environment: string };
  overtime: { otAfter: number | null; otMult: number; dtAfter: number | null; dtMult: number };
  invoices: { id: string; provider: 'qbo' | 'iif'; source: string; doc_number: string | null; total: string; created_at: string; created_by: string | null; url: string | null }[];
};
const KIND: Record<Line['kind'], string> = { regular: 'Regular', overtime: 'Overtime', double: 'Double time', day: 'Day rate' };

/** Bill an event: lines at bill rates from approved time (or the schedule), sent to QuickBooks Online or downloaded for QuickBooks Desktop. */
export default function InvoicePanel({ eventId, isAdmin }: { eventId: string; isAdmin: boolean }) {
  const [source, setSource] = useState<'time' | 'schedule'>('time');
  const [b, setB] = useState<Billing | null>(null);
  const [doc, setDoc] = useState('');
  const [error, setError] = useState('');
  const [ok, setOk] = useState<{ text: string; url?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => api<Billing>(`/api/events/${eventId}/billing?source=${source}`).then(setB).catch((e) => setError(e.message));
  useEffect(() => {
    setB(null);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId, source]);

  const toQbo = async (again = false) => {
    setBusy(true);
    setError('');
    setOk(null);
    try {
      const r = await api<{ invoice: { id: string; docNumber: string | null; url: string } }>(`/api/events/${eventId}/billing/quickbooks`, { body: { source, again: again || undefined } });
      setOk({ text: `Invoice ${r.invoice.docNumber ? `#${r.invoice.docNumber} ` : ''}created in QuickBooks. Review and send it from there.`, url: r.invoice.url });
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.reason === 'duplicate' && confirm(`${e.message}\n\nCreate another invoice?`)) return toQbo(true);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="phase-tabs" role="tablist" aria-label="Bill from" style={{ margin: '12px 0' }}>
        {([['time', 'Approved time'], ['schedule', 'Scheduled shifts']] as const).map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={source === k} className={source === k ? 'tab on' : 'tab'} onClick={() => setSource(k)}>
            {label}
          </button>
        ))}
      </div>
      {error && <Banner onClose={() => setError('')}>{error}</Banner>}
      {ok && (
        <Banner kind="ok" onClose={() => setOk(null)}>
          {ok.text} {ok.url && <a href={ok.url} target="_blank" rel="noreferrer">Open in QuickBooks</a>}
        </Banner>
      )}
      {!b ? (
        <div className="muted">Loading…</div>
      ) : (
        <>
          {b.warnings.map((w) => <Banner key={w} kind="info">{w}</Banner>)}
          <section className="card">
            <div className="row space">
              <h2 style={{ margin: 0 }}>{b.customer ? b.customer.name : 'No customer'}</h2>
              <b style={{ fontSize: '1.15rem' }}>{money(b.total)}</b>
            </div>
            <p className="muted small">
              Bill rates from Roles &amp; pay rates.{' '}
              {b.overtime.otAfter ? `Overtime after ${b.overtime.otAfter} h a day at ${b.overtime.otMult}×` : 'No daily overtime on this job'}
              {b.overtime.otAfter && b.overtime.dtAfter ? `, double time after ${b.overtime.dtAfter} h at ${b.overtime.dtMult}×` : ''}.
            </p>
            {b.lines.length === 0 ? (
              <Empty>Nothing to bill yet.</Empty>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Date</th><th>Position</th><th>Type</th><th>Qty</th><th>Rate</th><th style={{ textAlign: 'right' }}>Amount</th></tr></thead>
                  <tbody>
                    {b.lines.map((l, i) => (
                      <tr key={i}>
                        <td>{fmtDate(l.date)}</td>
                        <td>{l.role}</td>
                        <td>{KIND[l.kind]}</td>
                        <td>{l.qty} {l.unit === 'day' ? (l.qty === 1 ? 'day' : 'days') : 'h'}</td>
                        <td>{l.rate ? money(l.rate) : <span style={{ color: 'var(--bad)' }}>not set</span>}</td>
                        <td style={{ textAlign: 'right' }}>{money(l.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {b.canBill && b.lines.length > 0 && (
            <section className="card">
              <h2>Send to QuickBooks</h2>
              {b.quickbooks.connected ? (
                <>
                  {b.unmapped.length > 0 && <p className="small" style={{ color: 'var(--warn)' }}>Choose a QuickBooks item for {b.unmapped.join(', ')} under Integrations first.</p>}
                  <button className="btn primary" disabled={busy || !b.customer || b.unmapped.length > 0} onClick={() => toQbo()}>
                    Create invoice in QuickBooks Online
                  </button>
                  <p className="muted small">It is created in QuickBooks{b.quickbooks.environment === 'sandbox' ? ' (sandbox company)' : ''} but not emailed; review and send it from QuickBooks.{b.customer && !b.customer.qbo_customer_id ? ` “${b.customer.name}” is matched by name, or added to QuickBooks.` : ''}</p>
                </>
              ) : (
                <p className="muted small">QuickBooks Online is not connected.{isAdmin ? ' Connect it under Integrations.' : ' Ask an admin to connect it under Integrations.'}</p>
              )}
              <h3 style={{ marginTop: 14 }}>QuickBooks Desktop</h3>
              <div className="row">
                <input value={doc} onChange={(e) => setDoc(e.target.value.replace(/[^\w-]/g, '').slice(0, 21))} placeholder="Invoice number (optional)" aria-label="Invoice number" style={{ maxWidth: 220 }} />
                <a className="btn" href={`/api/events/${eventId}/billing/iif?source=${source}${doc ? `&docNumber=${encodeURIComponent(doc)}` : ''}`} onClick={() => setTimeout(load, 1500)}>
                  Download .IIF file
                </a>
              </div>
              <p className="muted small">Import it in QuickBooks Desktop with File › Utilities › Import › IIF Files.</p>
            </section>
          )}

          {b.invoices.length > 0 && (
            <section className="card">
              <h2>Billed before</h2>
              <ul className="plain">
                {b.invoices.map((i) => (
                  <li key={i.id} className="row space">
                    <span>
                      {i.provider === 'qbo' ? 'QuickBooks Online' : 'Desktop file'}
                      {i.doc_number ? ` #${i.doc_number}` : ''} · {money(Number(i.total))} · from {i.source === 'time' ? 'approved time' : 'schedule'}
                      <span className="muted small"> · {new Date(i.created_at).toLocaleString()}{i.created_by ? ` · ${i.created_by}` : ''}</span>
                    </span>
                    {i.url && <a href={i.url} target="_blank" rel="noreferrer" className="small">Open</a>}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
