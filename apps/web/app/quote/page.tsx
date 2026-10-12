'use client';
import { Fragment, Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Banner } from '@/components/ui';
import ThemeToggle from '@/components/ThemeToggle';
import { api, money } from '@/lib/api';

type Q = {
  company: string; number: number; title: string; customer: string | null; status: string; validUntil: string | null; intro: string | null; terms: string | null; taxPct: number;
  pdfUrl: string;
  lines: { section: string | null; description: string; day: string | null; startTime: string | null; endTime: string | null; qty: number; hours: number; rate: number; amount: number }[];
  totals: { subtotal: number; discount: number; tax: number; total: number };
  respondedAt: string | null; responseNote: string | null; canRespond: boolean; reason: string | null;
};

const tm = (t: string) => { const [h, m] = t.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };

function View() {
  const t = useSearchParams().get('t') ?? '';
  const [q, setQ] = useState<Q | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api<{ quote: Q }>(`/api/quote/view?t=${encodeURIComponent(t)}`).then((r) => setQ(r.quote)).catch((e) => setError(e.message)); }, [t]);
  const answer = async (response: 'accepted' | 'declined') => {
    setBusy(true);
    setError('');
    try {
      await api('/api/quote/respond', { body: { t, response, note: note || undefined } });
      setQ((p) => (p ? { ...p, status: response, canRespond: false, responseNote: note || null } : p));
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="quote-public" style={{ maxWidth: '52rem', margin: '0 auto', padding: '1.25rem 1rem 3rem' }}>
      <div className="no-print" style={{ textAlign: 'right' }}><ThemeToggle /></div>
      {error && <Banner>{error}</Banner>}
      {!q && !error && <div className="muted">Loading…</div>}
      {q && (
        <>
          <div className="row space" style={{ alignItems: 'flex-start' }}>
            <div>
              <div className="muted">{q.company}</div>
              <h1 style={{ margin: '.1rem 0' }}>{q.title}</h1>
              <div className="muted small">Quote #{q.number}{q.customer ? ` · prepared for ${q.customer}` : ''}{q.validUntil ? ` · valid until ${q.validUntil}` : ''}</div>
            </div>
            <a className="btn small no-print" href={q.pdfUrl}>Download PDF</a>
          </div>
          {q.status === 'accepted' && <Banner kind="ok">You accepted this quote. Thank you! {q.company} will be in touch.</Banner>}
          {q.status === 'declined' && <Banner kind="info">You declined this quote. If that was a mistake, contact {q.company}.</Banner>}
          {q.reason && <Banner>{q.reason}</Banner>}
          {q.intro && <p style={{ whiteSpace: 'pre-wrap' }}>{q.intro}</p>}
          <div style={{ overflowX: 'auto' }}>
            <table className="table">
              <thead><tr><th>Description</th><th>When</th><th style={{ textAlign: 'right' }}>People</th><th style={{ textAlign: 'right' }}>Hours</th><th style={{ textAlign: 'right' }}>Rate</th><th style={{ textAlign: 'right' }}>Amount</th></tr></thead>
              <tbody>
                {q.lines.map((l, i) => (
                  <Fragment key={i}>
                    {l.section && l.section !== q.lines[i - 1]?.section && <tr><td colSpan={6} style={{ fontWeight: 700, paddingTop: '1rem' }}>{l.section}</td></tr>}
                  <tr><td>{l.description}</td><td className="small">{l.day ? new Date(l.day + 'T12:00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) : ''}{l.startTime && l.endTime ? ` ${tm(l.startTime)}–${tm(l.endTime)}` : ''}</td><td style={{ textAlign: 'right' }}>{l.qty}</td><td style={{ textAlign: 'right' }}>{l.hours}</td><td style={{ textAlign: 'right' }}>{money(l.rate)}</td><td style={{ textAlign: 'right' }}>{money(l.amount)}</td></tr>
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          <dl className="info-grid" style={{ maxWidth: '20rem', marginLeft: 'auto' }}>
            <div><dt>Subtotal</dt><dd>{money(q.totals.subtotal)}</dd></div>
            {q.totals.discount > 0 && <div><dt>Discount</dt><dd>−{money(q.totals.discount)}</dd></div>}
            {q.totals.tax > 0 && <div><dt>Tax ({q.taxPct}%)</dt><dd>{money(q.totals.tax)}</dd></div>}
            <div><dt>Total</dt><dd><b style={{ fontSize: '1.2rem' }}>{money(q.totals.total)}</b></dd></div>
          </dl>
          {q.terms && <><h2>Terms</h2><p className="small" style={{ whiteSpace: 'pre-wrap' }}>{q.terms}</p></>}
          {q.canRespond && (
            <section className="card no-print">
              <h2>Your answer</h2>
              <label>Add a note (optional)<textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} placeholder="PO number, questions, requested changes…" /></label>
              <div className="row" style={{ gap: '.6rem' }}>
                <button className="btn big primary" style={{ flex: 1 }} disabled={busy} onClick={() => answer('accepted')}>Accept quote</button>
                <button className="btn big" style={{ flex: 1 }} disabled={busy} onClick={() => answer('declined')}>Decline</button>
              </div>
            </section>
          )}
        </>
      )}
      <style>{'@media print{.no-print{display:none!important}}'}</style>
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={<div className="muted">Loading…</div>}><View /></Suspense>;
}
