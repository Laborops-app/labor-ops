'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Banner } from '@/components/ui';
import { Head, papi, planLabel } from '@/components/platform/Console';

type Plan = { name: string; crewLimit: number | null; smsIncluded: number | null; priceLabel: string; priceId: string };
type Settings = {
  secretKey: string; webhookSecret: string; trialDays: number; hasSecretKey: boolean; hasWebhookSecret: boolean; secretKeyMode: 'live' | 'test' | null;
  smsPack: { size: number; priceId: string; priceLabel: string };
  plans: Record<'starter' | 'pro' | 'enterprise', Plan>;
};
type Company = { id: string; name: string; plan: string; billing_status: string | null; billing_period_end: string | null; trial_ends_at: string | null; sms_credits: number; active_crew: number };
type Data = { settings: Settings; webhookUrl: string; companies: Company[] };
const KEYS = ['starter', 'pro', 'enterprise'] as const;
const intOrNull = (v: string) => (v.trim() === '' ? null : Math.max(0, Math.round(Number(v))));

/**
 * Stripe keys, plans and prices. Keys are typed here (saved encrypted on the server, never shown again) — never put in the
 * code, the server environment, or a chat.
 */
export default function BillingSettingsPage() {
  const [d, setD] = useState<Data | null>(null);
  const [s, setS] = useState<Settings | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error' | 'info'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => papi<Data>('/api/platform/billing').then((r) => { setD(r); setS(r.settings); }).catch((e) => setMsg({ kind: 'error', text: e.message }));
  useEffect(() => { load(); }, []);
  if (!d || !s) return <>{msg ? <Banner>{msg.text}</Banner> : <div className="muted">Loading…</div>}</>;
  const plan = (k: (typeof KEYS)[number], patch: Partial<Plan>) => setS({ ...s, plans: { ...s.plans, [k]: { ...s.plans[k], ...patch } } });
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const { hasSecretKey, hasWebhookSecret, secretKeyMode, ...body } = s;
      void hasSecretKey; void hasWebhookSecret; void secretKeyMode;
      const r = await papi<{ settings: Settings }>('/api/platform/billing', { method: 'PUT', body });
      setS(r.settings);
      setMsg({ kind: 'ok', text: 'Billing settings saved.' });
      load();
    } catch (err) {
      setMsg({ kind: 'error', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const removeKeys = async () => {
    if (!confirm('Remove the Stripe keys? Billing switches off: no limits apply and companies cannot pay online until keys are added again.')) return;
    await papi('/api/platform/billing/keys', { method: 'DELETE' });
    load();
  };
  const st = d.settings;
  return (
    <>
      <Head title="Billing" sub="Stripe subscriptions: plans by active crew, text allowances and text packs." />
      {msg && <Banner kind={msg.kind} onClose={() => setMsg(null)}>{msg.text}</Banner>}
      <form onSubmit={save}>
        <section className="card pf-card">
          <div className="pf-card-head">
            <div>
              <h2>Stripe connection</h2>
              <p className="muted small">Paste the keys from the Stripe dashboard (Developers → API keys, and Webhooks). They are encrypted and never shown again; leave a box empty to keep the saved one.</p>
            </div>
            <span className={`chip ${st.hasSecretKey ? 'open' : ''}`}>{st.hasSecretKey ? (st.secretKeyMode === 'live' ? 'Live' : 'Test mode') : 'Off'}</span>
          </div>
          <div className="pf-target">
            <label>Secret key<input type="password" autoComplete="off" placeholder={st.hasSecretKey ? 'Saved (leave empty to keep)' : 'sk_live_… or rk_live_…'} value={s.secretKey} onChange={(e) => setS({ ...s, secretKey: e.target.value })} /></label>
            <label>Webhook signing secret<input type="password" autoComplete="off" placeholder={st.hasWebhookSecret ? 'Saved (leave empty to keep)' : 'whsec_…'} value={s.webhookSecret} onChange={(e) => setS({ ...s, webhookSecret: e.target.value })} /></label>
            <label className="pf-wide">Webhook endpoint (add this in Stripe)<input readOnly value={d.webhookUrl} onFocus={(e) => e.currentTarget.select()} /></label>
          </div>
          <p className="muted small">Events to send: <code>checkout.session.completed</code>, <code>customer.subscription.created</code>, <code>customer.subscription.updated</code>, <code>customer.subscription.deleted</code>, <code>invoice.payment_failed</code>. A restricted key (rk_) needs write access to Checkout Sessions, Customer portal and read access to Subscriptions.</p>
          {st.hasSecretKey && <button type="button" className="btn ghost small" onClick={removeKeys}>Remove keys (switch billing off)</button>}
        </section>

        <section className="card pf-card">
          <h2>Plans</h2>
          <p className="muted small">Create one recurring Price per plan in Stripe and paste its id (price_…). Leave the limit empty for unlimited. New companies get a free trial (limits: 25 crew, 100 texts).</p>
          <label style={{ maxWidth: 220 }}>Free trial (days)<input type="number" min={0} max={90} value={s.trialDays} onChange={(e) => setS({ ...s, trialDays: Number(e.target.value) })} /></label>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Plan</th><th>Name</th><th>Active crew</th><th>Texts / month</th><th>Price shown</th><th>Stripe price id</th></tr></thead>
              <tbody>
                {KEYS.map((k) => (
                  <tr key={k}>
                    <td className="small muted">{planLabel(k)}</td>
                    <td><input value={s.plans[k].name} onChange={(e) => plan(k, { name: e.target.value })} required /></td>
                    <td><input type="number" min={1} placeholder="Unlimited" value={s.plans[k].crewLimit ?? ''} onChange={(e) => plan(k, { crewLimit: intOrNull(e.target.value) })} /></td>
                    <td><input type="number" min={0} placeholder="Unlimited" value={s.plans[k].smsIncluded ?? ''} onChange={(e) => plan(k, { smsIncluded: intOrNull(e.target.value) })} /></td>
                    <td><input value={s.plans[k].priceLabel} placeholder="$149 / month" onChange={(e) => plan(k, { priceLabel: e.target.value })} /></td>
                    <td><input value={s.plans[k].priceId} placeholder="price_…" pattern="(price_[A-Za-z0-9]+)?" onChange={(e) => plan(k, { priceId: e.target.value.trim() })} /></td>
                  </tr>
                ))}
                <tr>
                  <td className="small muted">Text pack</td>
                  <td className="small">One-off payment</td>
                  <td />
                  <td><input type="number" min={1} value={s.smsPack.size} onChange={(e) => setS({ ...s, smsPack: { ...s.smsPack, size: Number(e.target.value) } })} aria-label="Texts per pack" /></td>
                  <td><input value={s.smsPack.priceLabel} placeholder="$15" onChange={(e) => setS({ ...s, smsPack: { ...s.smsPack, priceLabel: e.target.value } })} /></td>
                  <td><input value={s.smsPack.priceId} placeholder="price_…" pattern="(price_[A-Za-z0-9]+)?" onChange={(e) => setS({ ...s, smsPack: { ...s.smsPack, priceId: e.target.value.trim() } })} /></td>
                </tr>
              </tbody>
            </table>
          </div>
          <button className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </section>
      </form>

      <section className="card pf-card">
        <h2>Companies</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Company</th><th>Plan</th><th>Status</th><th>Active crew</th><th>Extra texts</th><th>Renews / trial ends</th></tr></thead>
            <tbody>
              {d.companies.map((c) => (
                <tr key={c.id}>
                  <td><Link href={`/platform/companies/${c.id}`}>{c.name}</Link></td>
                  <td>{planLabel(c.plan)}</td>
                  <td className="small">{c.billing_status ?? '—'}</td>
                  <td>{c.active_crew}</td>
                  <td>{c.sms_credits || '—'}</td>
                  <td className="small">{c.billing_period_end ? `Renews ${new Date(c.billing_period_end).toLocaleDateString()}` : c.trial_ends_at ? `Trial ${new Date(c.trial_ends_at) > new Date() ? 'ends' : 'ended'} ${new Date(c.trial_ends_at).toLocaleDateString()}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
