'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import Shell from '@/components/Shell';
import CopyEvent from '@/components/CopyEvent';
import { Banner, Empty } from '@/components/ui';
import { api, fmtDate, money, type Me } from '@/lib/api';

type Ev = {
  id: string; name: string; venue: string | null; start_date: string; end_date: string; status: string; customer_id: string | null; customer_name: string | null;
  archived_at: string; archive_reason: 'invoiced' | 'canceled' | 'manual'; archived_by_name: string | null; delete_on: string; invoiced: number | null; shift_count: number;
};
const REASON: Record<Ev['archive_reason'], { label: string; tone: string }> = {
  invoiced: { label: 'Invoiced', tone: 'open' }, canceled: { label: 'Canceled', tone: 'warn' }, manual: { label: 'Archived', tone: '' },
};
/** Same date next year (YYYY-MM-DD). */
const nextYear = (d: string) => { const [y, m, day] = d.slice(0, 10).split('-').map(Number); return `${y + 1}-${String(m).padStart(2, '0')}-${String(Math.min(day, 28 + (m === 2 ? 0 : 3))).padStart(2, '0')}`; };
const nextYearName = (n: string) => (/\b20\d\d\b/.test(n) ? n.replace(/\b(20\d\d)\b/, (y) => String(Number(y) + 1)) : n);

function Body({ me }: { me: Me }) {
  const [list, setList] = useState<Ev[] | null>(null);
  const [keep, setKeep] = useState(2);
  const [q, setQ] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const load = () => api<{ events: Ev[]; keepYears: number }>(`/api/archive${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`).then((r) => { setList(r.events); setKeep(r.keepYears); }).catch((e) => setError(e.message));
  useEffect(() => {
    const t = setTimeout(load, q ? 250 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);
  const restore = (e: Ev) => api(`/api/events/${e.id}/restore`, { body: {} }).then(() => { setNote(`${e.name} is back on the pipeline.`); load(); }).catch((x) => setError(x.message));
  const remove = (e: Ev) => {
    if (!confirm(`Delete ${e.name} for good? Its shifts, crew and time records are deleted too. This cannot be undone.`)) return;
    api(`/api/archive/${e.id}`, { method: 'DELETE' }).then(() => { setNote(`${e.name} was deleted.`); load(); }).catch((x) => setError(x.message));
  };
  const staff = me.role !== 'hr';
  return (
    <>
      <div className="row space">
        <h1>Archive</h1>
        <Link href="/pipeline" className="btn small ghost">Pipeline</Link>
      </div>
      <p className="muted">
        Events leave the pipeline once they are invoiced, or when they are canceled. They stay here for {keep} years so you can book them again next year, then are removed
        automatically{me.role === 'admin' ? ' (you can delete one sooner)' : ''}.
      </p>
      {error && <Banner onClose={() => setError('')}>{error}</Banner>}
      {note && <Banner kind="ok" onClose={() => setNote('')}>{note}</Banner>}
      <input className="archive-search" type="search" placeholder="Search events or customers…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search the archive" />
      {!list ? (
        <div className="muted">Loading…</div>
      ) : list.length === 0 ? (
        <Empty>{q ? `Nothing in the archive matches “${q}”.` : 'Nothing archived yet.'}</Empty>
      ) : (
        <section className="card">
          <ul className="past-list archive-list">
            {list.map((e) => (
              <li key={e.id}>
                <div className="past-main">
                  <Link href={`/events/${e.id}`} className="shift-link"><b>{e.name}</b></Link>{' '}
                  <span className={`chip ${REASON[e.archive_reason].tone}`}>{REASON[e.archive_reason].label}</span>
                  <div className="small">
                    {e.start_date === e.end_date ? fmtDate(e.start_date) : `${fmtDate(e.start_date)} – ${fmtDate(e.end_date)}`}
                    {e.customer_name ? ` · ${e.customer_name}` : ''}{e.venue ? ` · ${e.venue}` : ''}
                  </div>
                  <div className="muted small">
                    {e.invoiced ? `Invoiced ${money(e.invoiced)} · ` : ''}Archived {fmtDate(e.archived_at)}{e.archived_by_name ? ` by ${e.archived_by_name}` : ''} · removed {new Date(`${e.delete_on}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}
                  </div>
                </div>
                <div className="archive-acts">
                  {staff && (
                    <CopyEvent eventId={e.id} name={e.name} customerId={e.customer_id} onError={setError} label="Book next year" defaultName={nextYearName(e.name)} defaultStart={nextYear(e.start_date)} />
                  )}
                  <button className="btn small ghost" onClick={() => restore(e)}>Restore</button>
                  {me.role === 'admin' && <button className="btn small ghost danger" onClick={() => remove(e)}>Delete</button>}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

export default function Page() {
  return <Shell roles={['admin', 'manager', 'hr']}>{(me) => <Body me={me} />}</Shell>;
}
