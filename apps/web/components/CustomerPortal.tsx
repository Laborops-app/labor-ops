'use client';
import { useEffect, useState } from 'react';
import { Banner } from '@/components/ui';
import { api, fmtDateTime } from '@/lib/api';
import { RuleSetPicker } from '@/components/WorkRuleSets';

type PortalUser = { id: string; name: string; email: string; active: boolean; last_seen_at: string | null };
type Portal = { requireApproval: boolean; ruleSetId: string | null; users: PortalUser[]; portalUrl: string };

/** On a customer: their work rules, whether they sign off timesheets before invoicing, and their portal logins. */
export default function CustomerPortal({ customerId, customerName, canEdit }: { customerId: string; customerName: string; canEdit: boolean }) {
  const [d, setD] = useState<Portal | null>(null);
  const [f, setF] = useState<{ name: string; email: string } | null>(null);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const load = () => api<Portal>(`/api/customers/${customerId}/portal`).then(setD).catch((e) => setErr(e.message));
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [customerId]);
  const run = async (fn: () => Promise<unknown>, msg: string) => {
    setErr(''); setOk('');
    try { await fn(); setOk(msg); await load(); } catch (e) { setErr((e as Error).message); }
  };
  if (!d) return err ? <Banner>{err}</Banner> : null;
  const active = d.users.filter((u) => u.active);
  return (
    <section style={{ marginTop: 32 }}>
      <h2 style={{ margin: '0 0 8px' }}>Work rules and client portal</h2>
      {err && <Banner onClose={() => setErr('')}>{err}</Banner>}
      {ok && <Banner kind="ok" onClose={() => setOk('')}>{ok}</Banner>}
      <div className="card">
        <div className="grid2">
          <label>
            Work rules for {customerName}’s events
            <RuleSetPicker value={d.ruleSetId} disabled={!canEdit} inheritLabel="Company default" onChange={(id) => run(() => api(`/api/customers/${customerId}/rule-set`, { method: 'PUT', body: { ruleSetId: id } }), 'Work rules saved.')} />
            <span className="muted small">Overtime, premiums, meal penalties and the rest. An event can still pick its own.</span>
          </label>
          <label className="check" style={{ alignSelf: 'center' }}>
            <input type="checkbox" checked={d.requireApproval} disabled={!canEdit} onChange={(e) => run(() => api(`/api/customers/${customerId}/portal`, { method: 'PUT', body: { requireApproval: e.target.checked } }), e.target.checked ? 'Invoices now wait for their sign-off.' : 'Sign-off no longer required.')} />
            They approve timesheets before we invoice
          </label>
        </div>
        <h3 style={{ marginBottom: 4 }}>Portal logins</h3>
        <p className="muted small" style={{ marginTop: 0 }}>
          People at {customerName} see their events, who’s coming and who’s on site, approved timesheets and invoices; they can approve timesheets and request crew. They never see pay rates or phone numbers. Portal address: <code>{d.portalUrl}</code>
        </p>
        {active.length === 0 ? <p className="muted small">No one has access yet.</p> : (
          <ul className="wr-list">
            {active.map((u) => (
              <li key={u.id}>
                <div><b>{u.name}</b> <span className="muted small">{u.email}</span><div className="muted small">{u.last_seen_at ? `Last in ${fmtDateTime(u.last_seen_at)}` : 'Hasn’t signed in yet'}</div></div>
                {canEdit && (
                  <div className="row" style={{ gap: 6 }}>
                    <button type="button" className="btn small" onClick={() => run(() => api(`/api/customers/${customerId}/portal-users/${u.id}/invite`, { body: {} }), `Invite sent again to ${u.email}.`)}>Resend invite</button>
                    <button type="button" className="btn small ghost danger" onClick={() => { if (confirm(`Remove ${u.name}’s access?`)) run(() => api(`/api/customers/${customerId}/portal-users/${u.id}`, { method: 'DELETE' }), 'Access removed.'); }}>Remove</button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {canEdit && (f ? (
          <form className="row" style={{ marginTop: 8, flexWrap: 'wrap' }} onSubmit={(e) => { e.preventDefault(); run(() => api(`/api/customers/${customerId}/portal-users`, { body: f }).then(() => setF(null)), `Invite emailed to ${f.email}.`); }}>
            <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Name" required maxLength={120} aria-label="Name" />
            <input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} placeholder="email@client.com" required aria-label="Email" />
            <button className="btn primary small">Send invite</button>
            <button type="button" className="btn ghost small" onClick={() => setF(null)}>Cancel</button>
          </form>
        ) : (
          <button type="button" className="btn small" style={{ marginTop: 8 }} onClick={() => setF({ name: '', email: '' })}>+ Give someone access</button>
        ))}
      </div>
    </section>
  );
}
