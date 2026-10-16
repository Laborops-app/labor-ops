'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import InvoicePanel from '@/components/InvoicePanel';
import { Banner } from '@/components/ui';
import { api, fmtDate, fmtTime } from '@/lib/api';

type Shift = { id: string; role_name: string; starts_at: string; ends_at: string; headcount: number; assignments: { id: string; user_name: string; status: string }[] };
type Detail = { event: { id: string; name: string; venue: string | null; start_date: string; end_date: string; pipeline_status?: string; archived_at?: string | null; client: string | null }; shifts: Shift[] };
const STATUS: Record<string, string> = { pending: 'Pending', quote: 'Quote', confirmed: 'Confirmed', in_progress: 'In progress', completed: 'Completed', canceled: 'Canceled' };

/** What an HR account sees of an event: the details, who worked, and the invoice. Nothing to schedule or change. */
export default function HrEventView() {
  const { id } = useParams<{ id: string }>();
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const load = () => api<Detail>(`/api/events/${id}`).then(setD).catch((e) => setError(e.message));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  if (!d) return error ? <Banner>{error}</Banner> : <div className="muted">Loading…</div>;
  const ev = d.event;
  const d10 = (s: string) => String(s).slice(0, 10);
  const archive = () =>
    api(`/api/events/${id}/archive`, { body: {} }).then(() => { setNote('Archived. Find it on the Archive page.'); load(); }).catch((e) => setError(e.message));
  return (
    <>
      <div className="row space">
        <div>
          <h1 style={{ marginBottom: 4 }}>{ev.name}</h1>
          <div className="muted small">
            {d10(ev.start_date) === d10(ev.end_date) ? fmtDate(d10(ev.start_date)) : `${fmtDate(d10(ev.start_date))} – ${fmtDate(d10(ev.end_date))}`}
            {ev.venue ? ` · ${ev.venue}` : ''}{ev.client ? ` · ${ev.client}` : ''}
          </div>
        </div>
        <div className="row" style={{ gap: '.4rem' }}>
          <span className="chip">{ev.archived_at ? 'Archived' : STATUS[ev.pipeline_status ?? ''] ?? 'Pending'}</span>
          <Link href="/pipeline" className="btn small ghost">Pipeline</Link>
          {!ev.archived_at && ev.pipeline_status === 'completed' && <button className="btn small" onClick={archive} title="Invoiced outside LaborOps? Take it off the pipeline">Archive</button>}
        </div>
      </div>
      {error && <Banner onClose={() => setError('')}>{error}</Banner>}
      {note && <Banner kind="ok" onClose={() => setNote('')}>{note}</Banner>}
      <section className="card" id="invoice">
        <h2>Invoice</h2>
        <InvoicePanel eventId={id} isAdmin={false} />
      </section>
      <section className="card">
        <h2>Crew</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Role</th><th>When</th><th>Crew</th></tr></thead>
            <tbody>
              {d.shifts.map((s) => (
                <tr key={s.id}>
                  <td>{s.role_name}<div className="muted small">{s.assignments.filter((a) => a.status === 'accepted').length}/{s.headcount}</div></td>
                  <td className="small">{fmtDate(s.starts_at)} · {fmtTime(s.starts_at)} – {fmtTime(s.ends_at)}</td>
                  <td className="small">{s.assignments.filter((a) => a.status !== 'declined').map((a) => a.user_name).join(', ') || <span className="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
