'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import Shell from '@/components/Shell';
import TopbarAction, { PlusIcon, EditIcon, SearchIcon } from '@/components/TopbarAction';
import { Banner, Empty } from '@/components/ui';
import { api, fmtDate, money } from '@/lib/api';

type Q = { id: string; number: number; title: string; status: string; customer_name: string | null; total: number; valid_until: string | null; sent_at: string | null; created_at: string };
const VIEWS = ['all', 'draft', 'sent', 'accepted', 'declined'] as const;
type View = (typeof VIEWS)[number];
const PAGE = 25;

function Body() {
  const router = useRouter();
  const [list, setList] = useState<Q[] | null>(null);
  const [error, setError] = useState('');
  const [view, setView] = useState<View>('all');
  const [q, setQ] = useState('');
  const [shown, setShown] = useState(PAGE);
  useEffect(() => {
    api<{ quotes: Q[] }>('/api/quotes')
      .then((r) => setList(r.quotes))
      .catch((e) => setError(e.message));
  }, []);
  const needle = q.trim().toLowerCase();
  const rows = (list ?? []).filter((x) => (view === 'all' || x.status === view) && (!needle || `${x.number} ${x.title} ${x.customer_name ?? ''}`.toLowerCase().includes(needle)));
  const count = (v: View) => (list ?? []).filter((x) => v === 'all' || x.status === v).length;
  const open = rows.reduce((s, x) => s + (x.status === 'sent' || x.status === 'draft' ? Number(x.total) : 0), 0);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <>
      <h1>Quotes</h1>
      <TopbarAction>
        <button className="btn primary" onClick={() => api<{ quote: { id: string } }>('/api/quotes', { body: { title: 'Labor quote' } }).then((r) => router.push(`/quotes/${r.quote.id}`)).catch((e) => setError(e.message))}>
          New Quote
          <PlusIcon />
        </button>
      </TopbarAction>
      {error && <Banner onClose={() => setError('')}>{error}</Banner>}

      <div className="list-head">
        <div className="row" style={{ gap: 16 }}>
          <div className="total">
            Total: {list ? rows.length : '…'} quote{rows.length === 1 ? '' : 's'}
            {open > 0 && <span className="muted" style={{ fontWeight: 500 }}> · {money(open)} open</span>}
          </div>
          <div className="phase-tabs" role="tablist" aria-label="Quote status" style={{ margin: 0 }}>
            {VIEWS.map((v) => (
              <button key={v} type="button" role="tab" aria-selected={view === v} className={view === v ? 'tab on' : 'tab'} onClick={() => { setView(v); setShown(PAGE); }}>
                {v[0].toUpperCase() + v.slice(1)} ({count(v)})
              </button>
            ))}
          </div>
        </div>
        <div className="controls">
          <span className="pill-input">
            <SearchIcon />
            <input value={q} onChange={(e) => { setQ(e.target.value); setShown(PAGE); }} placeholder="Search number, title, customer" aria-label="Search quotes" />
          </span>
        </div>
      </div>

      {!list ? (
        <div className="muted">Loading…</div>
      ) : rows.length === 0 ? (
        <Empty>{list.length ? 'No quotes here.' : 'No quotes yet. Open an event and choose Create quote, or start a blank one.'}</Empty>
      ) : (
        <div className="table-wrap">
          <table className="dlist">
            <thead>
              <tr>
                <th className="av-col" aria-label="Number" />
                <th>Quote</th>
                <th>Customer</th>
                <th>Total</th>
                <th className="hide-sm">Valid until</th>
                <th className="hide-sm">Sent</th>
                <th>Status</th>
                <th className="edit-col">Edit</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, shown).map((x) => {
                const expired = x.status === 'sent' && x.valid_until && x.valid_until.slice(0, 10) < today;
                return (
                  <tr key={x.id} onClick={() => router.push(`/quotes/${x.id}`)}>
                    <td className="av-col"><span className="av c2" aria-hidden="true" style={{ fontSize: 12 }}>#{x.number}</span></td>
                    <td>
                      <Link href={`/quotes/${x.id}`} className="rowlink" onClick={(e) => e.stopPropagation()}>{x.title}</Link>
                      <span className="sub">Created {fmtDate(String(x.created_at).slice(0, 10))}</span>
                    </td>
                    <td>{x.customer_name ?? <span className="muted">—</span>}</td>
                    <td><b>{money(Number(x.total))}</b></td>
                    <td className="hide-sm">{x.valid_until ? <span style={expired ? { color: 'var(--bad)' } : undefined}>{fmtDate(x.valid_until.slice(0, 10))}</span> : <span className="muted">—</span>}</td>
                    <td className="hide-sm">{x.sent_at ? fmtDate(x.sent_at.slice(0, 10)) : <span className="muted">—</span>}</td>
                    <td><span className={`pill ${x.status}`}>{expired ? 'expired' : x.status}</span></td>
                    <td className="edit-col">
                      <Link href={`/quotes/${x.id}`} className="btn-round sm" aria-label={`Open quote ${x.number}`} onClick={(e) => e.stopPropagation()} style={{ border: 0, background: 'transparent' }}>
                        <EditIcon />
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length > shown && (
            <div className="load-more">
              <button className="btn" onClick={() => setShown(shown + PAGE)}>Load More</button>
            </div>
          )}
        </div>
      )}
    </>
  );
}

export default function Page() {
  return <Shell roles={['admin', 'manager']}>{() => <Body />}</Shell>;
}
