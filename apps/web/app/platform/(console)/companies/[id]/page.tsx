'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { Banner } from '@/components/ui';
import Modal from '@/components/Modal';
import { mb } from '@/components/PlatformStorage';
import { ago, CoAvatar, num, papi, planLabel } from '@/components/platform/Console';
import { TimeChart } from '@/components/platform/Charts';
import { feedText } from '@/components/platform/feed';
import { roleLabel } from '@/lib/api';

type Detail = {
  company: { id: string; name: string; slug: string; plan: string; created_at: string; suspended_at: string | null; suspended_reason: string | null; platform_notes: string | null };
  stats: Record<string, any>;
  staff: { id: string; name: string; email: string; phone: string | null; role: string; active: boolean; last_seen_at: string | null }[];
  integrations: { provider: string; updated_at: string }[];
  activity: { at: string; logins: number }[];
  recent: { action: string; entity: string; created_at: string; actor: string | null }[];
  history: { action: string; detail: any; created_at: string; actor: string | null }[];
  plans: string[];
};
const PROVIDER: Record<string, string> = { ses: 'Amazon SES email', twilio: 'Twilio texts', sns: 'Amazon SNS texts', podium: 'Podium', rentman: 'Rentman', quickbooks: 'QuickBooks' };
const human = (a: string) => a.replace(/[._]/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

export default function CompanyPage() {
  const { id } = useParams<{ id: string }>();
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [notes, setNotes] = useState('');
  const [suspending, setSuspending] = useState(false);
  const [reason, setReason] = useState('');
  const load = () => papi<Detail>(`/api/platform/companies/${id}`).then((r) => { setD(r); setNotes(r.company.platform_notes ?? ''); }).catch((e) => setErr(e.message));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  const save = async (body: object, ok: string) => {
    setErr('');
    try {
      await papi(`/api/platform/companies/${id}`, { method: 'PATCH', body });
      setMsg(ok);
      load();
    } catch (e: any) {
      setErr(e.message);
    }
  };
  const suspend = async (on: boolean) => {
    try {
      await papi(`/api/platform/companies/${id}/suspend`, { body: { suspended: on, reason: on ? reason || undefined : undefined } });
      setSuspending(false);
      setReason('');
      setMsg(on ? 'Company suspended. Its people are signed out.' : 'Suspension lifted.');
      load();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  if (!d) return err ? <Banner>{err}</Banner> : <div className="muted">Loading…</div>;
  const c = d.company, s = d.stats;
  return (
    <>
      <Link href="/platform/companies" className="cs-back small">← Companies</Link>
      <div className="cs-co-head">
        <CoAvatar name={c.name} size={56} />
        <div>
          <h1>{c.name}</h1>
          <p className="muted">
            Joined {new Date(c.created_at).toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' })} · last active {ago(s.last_active).toLowerCase()}
          </p>
        </div>
        <span className="spacer" />
        <label className="cs-inline">
          <span className="muted small">Plan</span>
          <select value={c.plan} onChange={(e) => save({ plan: e.target.value }, `Plan changed to ${planLabel(e.target.value)}.`)} aria-label="Plan">
            {(d.plans.includes(c.plan) ? d.plans : [c.plan, ...d.plans]).map((p) => <option key={p} value={p}>{planLabel(p)}</option>)}
          </select>
        </label>
        {c.suspended_at ? (
          <button className="btn primary" onClick={() => suspend(false)}>Lift suspension</button>
        ) : (
          <button className="btn danger" onClick={() => setSuspending(true)}>Suspend</button>
        )}
      </div>
      {c.suspended_at && <Banner>Suspended {ago(c.suspended_at).toLowerCase()}{c.suspended_reason ? `: ${c.suspended_reason}` : ''}. Nobody at this company can sign in.</Banner>}
      {msg && <Banner kind="ok" onClose={() => setMsg('')}>{msg}</Banner>}
      {err && <Banner onClose={() => setErr('')}>{err}</Banner>}

      <div className="cs-minis">
        <div><span className="muted small">People</span><b>{num(s.people)}</b><span className="muted small">{num(s.crew)} crew · {num(s.active_week)} active this week</span></div>
        <div><span className="muted small">Events</span><b>{num(s.events)}</b><span className="muted small">{num(s.upcoming)} upcoming</span></div>
        <div><span className="muted small">Hours clocked</span><b>{num(s.hours_30d)}</b><span className="muted small">last 30 days</span></div>
        <div><span className="muted small">Customers · quotes</span><b>{num(s.customers)} · {num(s.quotes)}</b><span className="muted small">{mb(s.file_bytes)} files · {num(s.messages_30d)} messages</span></div>
      </div>

      <div className="cs-grid-main">
        <div className="cs-stack">
          <section className="card cs-card">
            <h2>Sign-ins, last 30 days</h2>
            <TimeChart label="Sign-ins" data={d.activity.map((a) => ({ at: a.at, value: a.logins }))} unit="day" height={170} />
          </section>
          <section className="card cs-card">
            <h2>Admins and labor coordinators</h2>
            <div className="table-wrap">
              <table className="cs-table">
                <thead><tr><th>Name</th><th>Role</th><th>Email</th><th>Phone</th><th>Last active</th></tr></thead>
                <tbody>
                  {d.staff.map((u) => (
                    <tr key={u.id} className={u.active ? '' : 'inactive'}>
                      <td><span className="cs-co"><CoAvatar name={u.name} size={28} /><b>{u.name}</b></span></td>
                      <td>{roleLabel(u.role)}{!u.active && <span className="muted small"> (inactive)</span>}</td>
                      <td><a href={`mailto:${u.email}`}>{u.email}</a></td>
                      <td>{u.phone ? <a href={`tel:${u.phone}`}>{u.phone}</a> : <span className="muted">—</span>}</td>
                      <td className="small">{ago(u.last_seen_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <section className="card cs-card">
            <h2>Recent activity in the company</h2>
            <ul className="cs-feed">
              {d.recent.map((r, i) => (
                <li key={i}>
                  <span className="cs-feed-dot" aria-hidden="true" />
                  <span className="cs-feed-main"><span>{human(r.action)}</span><span className="muted small">{ago(r.created_at)}{r.actor ? ` · ${r.actor}` : ''}</span></span>
                </li>
              ))}
              {!d.recent.length && <li className="muted small">Nothing yet.</li>}
            </ul>
          </section>
        </div>
        <div className="cs-stack">
          <section className="card cs-card">
            <h2>Internal notes</h2>
            <p className="muted small" style={{ marginTop: -4 }}>Only platform admins see these.</p>
            <textarea rows={5} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Billing terms, contacts, onboarding status…" aria-label="Internal notes" />
            <button className="btn small" disabled={notes === (c.platform_notes ?? '')} onClick={() => save({ notes }, 'Notes saved.')}>Save notes</button>
          </section>
          <section className="card cs-card">
            <h2>Connected services</h2>
            <ul className="cs-list">
              {d.integrations.map((i) => <li key={i.provider}><b>{PROVIDER[i.provider] ?? i.provider}</b><span className="muted small"> · set up {ago(i.updated_at).toLowerCase()}</span></li>)}
              {!d.integrations.length && <li className="muted small">None connected.</li>}
            </ul>
          </section>
          <section className="card cs-card">
            <h2>Platform history</h2>
            <ul className="cs-feed">
              {d.history.map((h, i) => (
                <li key={i}>
                  <span className={`cs-feed-dot ${h.action === 'company.suspend' ? 'bad' : ''}`} aria-hidden="true" />
                  <span className="cs-feed-main"><span>{feedText(h)}</span><span className="muted small">{ago(h.created_at)}{h.actor ? ` · by ${h.actor}` : ''}</span></span>
                </li>
              ))}
              {!d.history.length && <li className="muted small">No changes from the platform yet.</li>}
            </ul>
            <p className="muted small" style={{ margin: 0 }}>Account ID <code>{c.id}</code></p>
          </section>
        </div>
      </div>

      {suspending && (
        <Modal title={`Suspend ${c.name}?`} onClose={() => setSuspending(false)}>
          <p className="muted">Everyone at this company is signed out and can&apos;t sign in until you lift the suspension. Nothing is deleted.</p>
          <label>
            Reason <span className="muted small">(optional, shown on this page)</span>
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Unpaid invoice" autoFocus />
          </label>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn ghost" onClick={() => setSuspending(false)}>Cancel</button>
            <button className="btn danger-solid" onClick={() => suspend(true)}>Suspend company</button>
          </div>
        </Modal>
      )}
    </>
  );
}
