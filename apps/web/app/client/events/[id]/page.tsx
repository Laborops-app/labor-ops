'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import ClientFrame from '@/components/ClientFrame';
import { Banner, Empty } from '@/components/ui';
import { api, fmtDate, fmtDateTime, fmtTime, money } from '@/lib/api';

type Data = {
  event: { id: string; name: string; customer: string; venue: string | null; address: string | null; start_date: string; end_date: string; status: string; notes: string | null };
  shifts: { id: string; role_name: string; starts_at: string; ends_at: string; headcount: number; phase: string | null; group_label: string | null; confirmed: number }[];
  roster: { id: string; name: string; role_name: string; starts_at: string; ends_at: string; is_lead: boolean; on_site_since: string | null; last_out: string | null }[];
  timesheet: { id: string; name: string; role_name: string; date: string; clock_in: string; clock_out: string; hours: number }[];
  pendingTime: number;
  history: { status: 'approved' | 'disputed'; note: string | null; hours: number; created_at: string; by_name: string | null }[];
  invoices: { doc_number: string | null; total: number; created_at: string }[];
  approval: { required: boolean; approved: boolean; stale: boolean; disputed: boolean; hours: number; entries: number };
};
const day = (iso: string) => new Date(iso).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });

function Body() {
  const { id } = useParams<{ id: string }>();
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const [tab, setTab] = useState<'crew' | 'schedule' | 'time' | 'invoices'>('crew');
  const [dispute, setDispute] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => api<Data>(`/api/client/events/${id}`).then(setD).catch((e) => setErr(e.message));
  useEffect(() => {
    load();
    const t = setInterval(load, 30_000); // who's on site stays current
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  if (!d) return err ? <Banner>{err}</Banner> : <div className="muted">Loading…</div>;
  const e = d.event, a = d.approval;
  const onSite = d.roster.filter((r) => r.on_site_since);
  const signoff = async (kind: 'approve' | 'dispute') => {
    setErr(''); setOk(''); setBusy(true);
    try {
      await api(`/api/client/events/${id}/${kind}`, { body: { note: (kind === 'dispute' ? dispute : note) || undefined } });
      setOk(kind === 'approve' ? 'Thanks: the timesheets are signed off.' : 'Sent. The team will look at it and get back to you.');
      setDispute(null); setNote('');
      await load();
    } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  };
  const total = d.timesheet.reduce((n, t) => n + t.hours, 0);
  return (
    <>
      <p className="small"><Link href="/client">← Your events</Link></p>
      <div className="row space" style={{ alignItems: 'flex-start' }}>
        <div>
          <h1 style={{ marginBottom: 4 }}>{e.name}</h1>
          <div className="muted">{e.start_date === e.end_date ? fmtDate(e.start_date) : `${fmtDate(e.start_date)} – ${fmtDate(e.end_date)}`}{e.venue ? ` · ${e.venue}` : ''}{e.address ? ` · ${e.address}` : ''}</div>
        </div>
        {onSite.length > 0 && <span className="pill clocked">{onSite.length} on site now</span>}
      </div>
      {err && <Banner onClose={() => setErr('')}>{err}</Banner>}
      {ok && <Banner kind="ok" onClose={() => setOk('')}>{ok}</Banner>}

      {a.entries > 0 && !a.approved && (
        <section className="card cp-signoff">
          <h2 style={{ marginTop: 0 }}>{a.stale ? 'The timesheets changed since you signed off' : a.disputed ? 'You questioned these timesheets' : 'Ready for your sign-off'}</h2>
          <p className="small">{a.hours} hours from {a.entries} time entr{a.entries === 1 ? 'y' : 'ies'}.{a.required ? ' Your invoice is prepared once you approve.' : ''} <button type="button" className="rt-link" onClick={() => setTab('time')}>Review the timesheet</button></p>
          {dispute === null ? (
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <input value={note} onChange={(x) => setNote(x.target.value)} placeholder="Optional note" maxLength={1000} style={{ flex: '1 1 220px' }} aria-label="Note with your approval" />
              <button type="button" className="btn primary" disabled={busy} onClick={() => signoff('approve')}>Approve timesheets</button>
              <button type="button" className="btn" disabled={busy} onClick={() => setDispute('')}>Something’s wrong</button>
            </div>
          ) : (
            <div className="grid-form" style={{ gridTemplateColumns: '1fr' }}>
              <label>What looks wrong?<textarea rows={3} value={dispute} onChange={(x) => setDispute(x.target.value)} maxLength={1000} placeholder="e.g. Two stagehands left at 8 PM, not 10 PM" autoFocus /></label>
              <div className="row"><button type="button" className="btn primary" disabled={busy || !dispute.trim()} onClick={() => signoff('dispute')}>Send to the team</button><button type="button" className="btn ghost" onClick={() => setDispute(null)}>Cancel</button></div>
            </div>
          )}
        </section>
      )}
      {a.approved && <Banner kind="ok">Timesheets signed off ({a.hours} hours).</Banner>}

      <div className="phase-tabs" role="tablist" style={{ margin: '16px 0' }}>
        {([['crew', `Crew (${d.roster.length})`], ['schedule', 'Schedule'], ['time', `Timesheet${d.timesheet.length ? ` (${d.timesheet.length})` : ''}`], ['invoices', `Invoices${d.invoices.length ? ` (${d.invoices.length})` : ''}`]] as const).map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'tab on' : 'tab'} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>

      {tab === 'crew' && (d.roster.length === 0 ? <Empty>No crew confirmed yet.</Empty> : (
        <section className="card">
          <ul className="cp-roster">
            {d.roster.map((r) => (
              <li key={r.id}>
                <span><b>{r.name}</b>{r.is_lead && <span className="pill" style={{ marginLeft: 6 }}>Lead</span>}<div className="muted small">{r.role_name} · {day(r.starts_at)} {fmtTime(r.starts_at)}–{fmtTime(r.ends_at)}</div></span>
                <span className={r.on_site_since ? 'pill clocked' : r.last_out ? 'pill' : 'muted small'}>{r.on_site_since ? `On site since ${fmtTime(r.on_site_since)}` : r.last_out ? `Done ${fmtTime(r.last_out)}` : 'Not arrived'}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}

      {tab === 'schedule' && (d.shifts.length === 0 ? <Empty>No shifts yet.</Empty> : (
        <section className="card">
          <table className="table small">
            <thead><tr><th>When</th><th>Position</th><th>Crew</th></tr></thead>
            <tbody>
              {d.shifts.map((s) => (
                <tr key={s.id}>
                  <td>{day(s.starts_at)} {fmtTime(s.starts_at)}–{fmtTime(s.ends_at)}{s.phase && <div className="muted">{s.phase}{s.group_label ? ` › ${s.group_label}` : ''}</div>}</td>
                  <td>{s.role_name}</td>
                  <td><span className={`pill ${s.confirmed >= s.headcount ? 'accepted' : 'offered'}`}>{s.confirmed}/{s.headcount}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          {e.notes && <p className="muted small" style={{ whiteSpace: 'pre-wrap' }}>{e.notes}</p>}
        </section>
      ))}

      {tab === 'time' && (
        <section className="card">
          {d.timesheet.length === 0 ? <Empty>No approved time yet.</Empty> : (
            <div className="table-wrap">
              <table className="table small">
                <thead><tr><th>Date</th><th>Name</th><th>Position</th><th>In</th><th>Out</th><th>Hours</th></tr></thead>
                <tbody>
                  {d.timesheet.map((t) => (
                    <tr key={t.id}><td>{fmtDate(t.date)}</td><td>{t.name}</td><td>{t.role_name}</td><td>{fmtTime(t.clock_in)}</td><td>{fmtTime(t.clock_out)}</td><td>{t.hours.toFixed(2)}</td></tr>
                  ))}
                  <tr><td colSpan={5}><b>Total</b></td><td><b>{total.toFixed(2)}</b></td></tr>
                </tbody>
              </table>
            </div>
          )}
          {d.pendingTime > 0 && <p className="muted small">{d.pendingTime} more time entr{d.pendingTime === 1 ? 'y is' : 'ies are'} still being reviewed by the team.</p>}
          {d.history.length > 0 && (
            <>
              <h3>Sign-off history</h3>
              <ul className="small">{d.history.map((h, i) => <li key={i}>{h.status === 'approved' ? 'Approved' : 'Questioned'} {h.hours} h · {fmtDateTime(h.created_at)}{h.by_name ? ` · ${h.by_name}` : ''}{h.note ? ` · “${h.note}”` : ''}</li>)}</ul>
            </>
          )}
        </section>
      )}

      {tab === 'invoices' && (d.invoices.length === 0 ? <Empty>No invoices for this event yet.</Empty> : (
        <section className="card">
          <table className="table small">
            <thead><tr><th>Invoice</th><th>Date</th><th>Total</th></tr></thead>
            <tbody>{d.invoices.map((i, k) => <tr key={k}><td>{i.doc_number ? `#${i.doc_number}` : 'Invoice'}</td><td>{fmtDate(i.created_at)}</td><td>{money(i.total)}</td></tr>)}</tbody>
          </table>
          <p className="muted small">The invoice itself comes from {e.customer ? 'the team’s' : 'their'} accounting system by email.</p>
        </section>
      ))}
    </>
  );
}

export default function Page() {
  return <ClientFrame>{() => <Body />}</ClientFrame>;
}
