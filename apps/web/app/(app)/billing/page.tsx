'use client';
import { useEffect, useState } from 'react';
import Shell from '@/components/Shell';
import { Banner } from '@/components/ui';
import { api, fmtDate } from '@/lib/api';

type PlanInfo = { key: string; name: string; crewLimit: number | null; smsIncluded: number | null; priceLabel: string; buyable?: boolean };
type Data = {
  enabled: boolean;
  billing: { plan: string; status: string | null; trialEndsAt: string | null; periodEnd: string | null; customerId: string | null; subscriptionId: string | null; smsCredits: number; activeCrew: number; smsThisMonth: number };
  plan: PlanInfo;
  plans: PlanInfo[];
  smsPack: { size: number; priceLabel: string; buyable: boolean };
};
const STATUS: Record<string, string> = { active: 'Active', trialing: 'Trial', past_due: 'Payment failed', unpaid: 'Unpaid', canceled: 'Cancelled', incomplete: 'Waiting for payment' };
const n = (v: number | null) => (v === null ? 'Unlimited' : v.toLocaleString());

function Meter({ used, limit }: { used: number; limit: number | null }) {
  if (limit === null) return null;
  const p = Math.min(100, limit ? (used / limit) * 100 : 100);
  return <div className={`meter ${used > limit ? 'over' : ''}`} role="meter" aria-valuenow={used} aria-valuemin={0} aria-valuemax={limit}><span style={{ width: `${p}%` }} /></div>;
}

function Body() {
  const [d, setD] = useState<Data | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [packs, setPacks] = useState(1);
  const done = typeof window !== 'undefined' ? new URLSearchParams(location.search).get('done') : null;
  const load = () => api<Data>('/api/billing').then(setD).catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);
  const go = async (key: string, path: string, body: object = {}) => {
    setBusy(key);
    setError('');
    try {
      const { url } = await api<{ url: string }>(path, { body });
      window.location.href = url;
    } catch (e) {
      setError((e as Error).message);
      setBusy('');
    }
  };
  if (!d) return <>{error ? <Banner>{error}</Banner> : <div className="muted">Loading…</div>}</>;
  const b = d.billing;
  const trialLeft = b.trialEndsAt ? Math.ceil((+new Date(b.trialEndsAt) - Date.now()) / 86400_000) : null;
  const subscribed = !!b.subscriptionId && b.status !== 'canceled';

  return (
    <>
      <h1>Billing</h1>
      {done === 'plan' && <Banner kind="ok">Thank you! Your subscription is being set up. It can take a few seconds to show here.</Banner>}
      {done === 'sms' && <Banner kind="ok">Thank you! Your texts are being added.</Banner>}
      {error && <Banner onClose={() => setError('')}>{error}</Banner>}
      {!d.enabled && <Banner kind="info">Online billing isn't switched on for LaborOps yet, so there are no limits on your account. Nothing to do here for now.</Banner>}
      {b.status === 'past_due' && <Banner>Your last payment failed. Update your card under "Manage billing" to keep your plan.</Banner>}

      <section className="card">
        <div className="row space">
          <div>
            <div className="muted small">Your plan</div>
            <h2 style={{ margin: '0.1rem 0' }}>{d.plan.name}</h2>
            <div className="small">
              {b.status ? STATUS[b.status] ?? b.status : b.plan === 'trial' ? '' : 'Active'}
              {b.plan === 'trial' && trialLeft !== null && (trialLeft > 0 ? `${trialLeft} day${trialLeft === 1 ? '' : 's'} left (ends ${fmtDate(b.trialEndsAt!.slice(0, 10))})` : 'Ended: choose a plan to keep adding crew')}
              {subscribed && b.periodEnd && ` · renews ${fmtDate(b.periodEnd.slice(0, 10))}`}
            </div>
          </div>
          {d.enabled && b.customerId && (
            <button className="btn" disabled={!!busy} onClick={() => go('portal', '/api/billing/portal')}>{busy === 'portal' ? 'Opening…' : 'Manage billing'}</button>
          )}
        </div>
        <div className="kpis" style={{ marginTop: '1rem' }}>
          <div className="kpi">
            <div className="kpi-label">Active crew</div>
            <div className="kpi-value">{b.activeCrew}{d.plan.crewLimit !== null && <span className="muted small"> / {d.plan.crewLimit}</span>}</div>
            <Meter used={b.activeCrew} limit={d.plan.crewLimit} />
            <div className="muted small">Labor coordinators and admins are free.</div>
          </div>
          <div className="kpi">
            <div className="kpi-label">Texts this month</div>
            <div className="kpi-value">{b.smsThisMonth}{d.plan.smsIncluded !== null && <span className="muted small"> / {d.plan.smsIncluded}</span>}</div>
            <Meter used={b.smsThisMonth} limit={d.plan.smsIncluded} />
            <div className="muted small">{b.smsCredits ? `${b.smsCredits.toLocaleString()} extra texts in reserve` : 'Push notifications and email are unlimited.'}</div>
          </div>
        </div>
      </section>

      {d.enabled && (
        <section className="card">
          <h2>Plans</h2>
          <p className="muted small">Priced by active crew. Every plan has every feature. {subscribed ? 'Change plan under "Manage billing".' : ''}</p>
          <div className="plans">
            {d.plans.map((p) => (
              <div key={p.key} className={`plan ${p.key === b.plan ? 'current' : ''}`}>
                <b>{p.name}</b>
                <div className="plan-price">{p.priceLabel || '—'}</div>
                <ul>
                  <li>Up to {n(p.crewLimit)} active crew</li>
                  <li>{n(p.smsIncluded)} texts a month</li>
                </ul>
                {p.key === b.plan && subscribed ? (
                  <span className="chip">Your plan</span>
                ) : subscribed ? (
                  <button className="btn small" disabled={!!busy} onClick={() => go('portal', '/api/billing/portal')}>Switch in billing</button>
                ) : p.buyable ? (
                  <button className="btn primary small" disabled={!!busy} onClick={() => go(p.key, '/api/billing/checkout', { plan: p.key })}>{busy === p.key ? 'Opening…' : `Choose ${p.name}`}</button>
                ) : (
                  <span className="muted small">Contact us</span>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {d.enabled && d.smsPack.buyable && (
        <section className="card">
          <h2>More texts</h2>
          <p className="muted small">Texts over your monthly allowance use these. They don't expire. Without any, texts past the allowance are skipped (push and email still go out).</p>
          <div className="billing-note">
            <select value={packs} onChange={(e) => setPacks(Number(e.target.value))} aria-label="How many packs">
              {[1, 2, 4, 10].map((k) => <option key={k} value={k}>{(k * d.smsPack.size).toLocaleString()} texts</option>)}
            </select>
            <span className="muted small">{d.smsPack.priceLabel ? `${d.smsPack.priceLabel} per ${d.smsPack.size.toLocaleString()}` : ''}</span>
            <button className="btn primary small" disabled={!!busy} onClick={() => go('sms', '/api/billing/sms-pack', { packs })}>{busy === 'sms' ? 'Opening…' : 'Buy'}</button>
          </div>
        </section>
      )}
    </>
  );
}

export default function Page() {
  return <Shell roles={['admin']}>{() => <Body />}</Shell>;
}
