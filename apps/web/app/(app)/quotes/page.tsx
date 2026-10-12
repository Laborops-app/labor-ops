'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import Shell from '@/components/Shell';
import { Banner, Empty, Pill } from '@/components/ui';
import { api, fmtDate, money } from '@/lib/api';

type Q = { id: string; number: number; title: string; status: string; customer_name: string | null; total: number; valid_until: string | null; sent_at: string | null };

function Body() {
  const router = useRouter();
  const [list, setList] = useState<Q[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { api<{ quotes: Q[] }>('/api/quotes').then((r) => setList(r.quotes)).catch((e) => setError(e.message)); }, []);
  return (
    <>
      <div className="row space">
        <h1>Quotes</h1>
        <button className="btn primary" onClick={() => api<{ quote: { id: string } }>('/api/quotes', { body: { title: 'Labor quote' } }).then((r) => router.push(`/quotes/${r.quote.id}`)).catch((e) => setError(e.message))}>New quote</button>
      </div>
      <p className="muted">Labor quotes for customers. Build one from an event's shifts (open an event and choose Create quote) or start blank. The customer gets a link to accept or decline.</p>
      {error && <Banner onClose={() => setError('')}>{error}</Banner>}
      {!list ? <div className="muted">Loading…</div> : list.length === 0 ? <Empty>No quotes yet.</Empty> : (
        <table className="table">
          <thead><tr><th>#</th><th>Quote</th><th>Customer</th><th>Total</th><th>Status</th><th>Sent</th></tr></thead>
          <tbody>
            {list.map((q) => (
              <tr key={q.id}>
                <td>{q.number}</td>
                <td><Link href={`/quotes/${q.id}`}>{q.title}</Link></td>
                <td>{q.customer_name ?? <span className="muted">None</span>}</td>
                <td>{money(q.total)}</td>
                <td><Pill status={q.status} /></td>
                <td>{q.sent_at ? fmtDate(q.sent_at.slice(0, 10)) : <span className="muted">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

export default function Page() {
  return <Shell roles={['admin', 'manager']}>{() => <Body />}</Shell>;
}
