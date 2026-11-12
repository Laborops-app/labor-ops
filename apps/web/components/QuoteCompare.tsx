'use client';
import { useState } from 'react';
import Link from 'next/link';
import { api, money, fmtDate } from '@/lib/api';
import { Empty } from '@/components/ui';

export type QuoteChoice = { id: string; number: number; title: string; status: string; source: string; rentman_number: string | null; rentman_version: number | null; updated_at: string };
type Row = { role: string; fee?: boolean; quotedHours: number; quotedAmount: number; invoicedHours: number; invoicedDays: number; invoicedAmount: number; diff: number; pct: number | null; status: 'match' | 'over' | 'under' | 'not_quoted' | 'not_invoiced' };
export type Comparison = {
  quote: { id: string; number: number; title: string; status: string; source: string; rentman: { number: string; version: number; total: number; crew: number; transport: number; importedAt: string } | null };
  rows: Row[]; quotedLines: number; discount: number; quoted: number; invoiced: number; diff: number; pct: number | null; status: 'match' | 'over' | 'under' | 'not_quoted';
};
type RmQuote = { id: number; number: string; version: number; subject: string | null; date: string | null; expires: string | null; price: number; crew: number; transport: number; imported: { id: string; version: number; status: string; at: string } | null };

const STATUS: Record<Row['status'], string> = { match: 'Matches', over: 'Over', under: 'Under', not_quoted: 'Not on the quote', not_invoiced: 'Not on the invoice' };
const signed = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${money(Math.abs(n))}`;
const hrs = (h: number) => `${Math.round(h * 100) / 100} h`;
const ppl = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`;
const quoteLabel = (q: QuoteChoice) =>
  `#${q.number} ${q.title}${q.source === 'rentman' ? ` · Rentman ${q.rentman_number ?? ''}${q.rentman_version ? ` v${q.rentman_version}` : ''}` : ''} · ${q.status}`;

/**
 * Quoted vs invoiced, position by position, for the quote this event was sold on (a LaborOps quote or one pulled
 * in from Rentman). Pulling Rentman quotes happens here too.
 */
export default function QuoteCompare({
  eventId, quotes, comparison, rentmanProject, quoteId, onPick, onChanged, onError,
}: {
  eventId: string;
  quotes: QuoteChoice[];
  comparison: Comparison | null;
  rentmanProject: number | null;
  quoteId: string;
  onPick: (id: string) => void;
  onChanged: (msg: string, quoteId?: string) => void;
  onError: (msg: string) => void;
}) {
  const [rm, setRm] = useState<RmQuote[] | null>(null);
  const [rmOpen, setRmOpen] = useState(false);
  const [accepted, setAccepted] = useState(true);
  const [busy, setBusy] = useState<number | 'list' | null>(null);
  const c = comparison;

  const openRentman = async () => {
    setRmOpen(true);
    setBusy('list');
    try {
      setRm((await api<{ quotes: RmQuote[] }>(`/api/events/${eventId}/rentman/quotes`)).quotes);
    } catch (e) {
      setRmOpen(false);
      onError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const pull = async (q: RmQuote) => {
    setBusy(q.id);
    try {
      const r = await api<{ id: string; updated: boolean; lines: number; crewTotal: number; warnings: string[] }>(`/api/events/${eventId}/rentman/quotes/${q.id}/import`, { body: { accepted } });
      setRmOpen(false);
      setRm(null);
      onChanged(
        `${r.updated ? 'Updated' : 'Pulled in'} Rentman quote ${q.number} (version ${q.version}): ${r.lines} crew line${r.lines === 1 ? '' : 's'}, ${money(r.crewTotal)}.${r.warnings.length ? ` ${r.warnings.join(' ')}` : ''}`,
        r.id,
      );
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="card quote-compare">
      <div className="row space" style={{ flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ margin: 0 }}>Quoted vs invoiced</h2>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {quotes.length > 1 && (
            <select value={quoteId} onChange={(e) => onPick(e.target.value)} aria-label="Quote to compare with" style={{ maxWidth: 360 }}>
              {quotes.map((q) => <option key={q.id} value={q.id}>{quoteLabel(q)}</option>)}
            </select>
          )}
          {rentmanProject && (
            <button type="button" className="btn small" disabled={busy === 'list'} onClick={() => (rmOpen ? setRmOpen(false) : openRentman())}>
              {busy === 'list' ? 'Loading…' : '⇣ Pull quote from Rentman'}
            </button>
          )}
        </div>
      </div>

      {rmOpen && rm && (
        <div className="rm-quotes">
          {rm.length === 0 ? (
            <p className="muted small" style={{ margin: 0 }}>The linked Rentman project has no quotes yet.</p>
          ) : (
            <>
              <ul className="plain">
                {rm.map((q) => (
                  <li key={q.id} className="row space">
                    <span>
                      <b>{q.number}</b> · version {q.version}{q.subject && q.subject !== q.number ? ` · ${q.subject}` : ''}
                      <span className="muted small">
                        {' '}· crew {money(q.crew)} of {money(q.price)}{q.date ? ` · ${fmtDate(q.date.slice(0, 10))}` : ''}
                        {q.imported ? ` · pulled in${q.imported.version !== q.version ? ` (version ${q.imported.version})` : ''}` : ''}
                      </span>
                    </span>
                    <button type="button" className={q.imported ? 'btn small' : 'btn small primary'} disabled={busy !== null} onClick={() => pull(q)}>
                      {busy === q.id ? 'Pulling…' : q.imported ? 'Pull again' : 'Pull in'}
                    </button>
                  </li>
                ))}
              </ul>
              <label className="check small">
                <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} /> The client accepted this quote
              </label>
              <p className="muted small" style={{ margin: 0 }}>Only the crew part comes across (one line per crew function on the project); equipment and transport stay in Rentman. Pull again after Rentman makes a new version.</p>
            </>
          )}
        </div>
      )}

      {!c ? (
        <Empty>
          No quote on this event yet.{' '}
          {rentmanProject ? 'Pull one from Rentman to check the invoice against it.' : 'Make one under Quotes, or link the event to a Rentman project to pull its quote in.'}
        </Empty>
      ) : (
        <>
          <div className="qc-sum">
            <div><span className="muted small">Quoted labor</span><b>{money(c.quoted)}</b>{c.discount > 0 && <span className="muted small">after {money(c.discount)} discount</span>}</div>
            <div><span className="muted small">This invoice</span><b>{money(c.invoiced)}</b></div>
            <div className={`qc-diff ${c.status}`}>
              <span className="muted small">Difference</span>
              <b>{signed(c.diff)}{c.pct !== null ? ` (${c.pct > 0 ? '+' : ''}${c.pct}%)` : ''}</b>
              <span className="small">{c.status === 'match' ? 'Matches the quote' : c.status === 'over' ? 'Over the quote' : c.status === 'under' ? 'Under the quote' : 'Nothing quoted for labor'}</span>
            </div>
          </div>
          <p className="muted small">
            <Link href={`/quotes/${c.quote.id}`}>Quote #{c.quote.number}</Link> · {c.quote.title} · {c.quote.status}
            {c.quote.rentman && (
              <> · from Rentman {c.quote.rentman.number}, version {c.quote.rentman.version} (crew {money(c.quote.rentman.crew)} of {money(c.quote.rentman.total)}; equipment and transport stay in Rentman) · pulled {new Date(c.quote.rentman.importedAt).toLocaleDateString()}</>
            )}
          </p>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Position</th><th>Quoted</th><th>Invoice</th><th style={{ textAlign: 'right' }}>Difference</th><th>Status</th></tr>
              </thead>
              <tbody>
                {c.rows.map((r) => (
                  <tr key={r.role}>
                    <td>{r.role}</td>
                    <td>{r.quotedAmount ? <>{money(r.quotedAmount)}<span className="sub">{r.fee ? ppl(r.quotedHours) : hrs(r.quotedHours)}</span></> : <span className="muted">—</span>}</td>
                    <td>
                      {r.invoicedAmount ? (
                        <>
                          {money(r.invoicedAmount)}
                          <span className="sub">{[r.invoicedHours ? (r.fee ? ppl(r.invoicedHours) : hrs(r.invoicedHours)) : '', r.invoicedDays ? `${r.invoicedDays} day${r.invoicedDays === 1 ? '' : 's'}` : ''].filter(Boolean).join(' + ')}</span>
                        </>
                      ) : <span className="muted">—</span>}
                    </td>
                    <td style={{ textAlign: 'right' }}>{signed(r.diff)}{r.pct !== null && r.status !== 'not_invoiced' ? <span className="muted small"> ({r.pct > 0 ? '+' : ''}{r.pct}%)</span> : ''}</td>
                    <td><span className={`qc-chip ${r.status}`}>{STATUS[r.status]}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
