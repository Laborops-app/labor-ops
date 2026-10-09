'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Banner } from '@/components/ui';

type Prefs = { email: boolean; sms: boolean; phone: string | null; phoneValid: boolean; consentAt: string | null };

export default function NotificationSettings({ phone }: { phone?: string | null }) {
  const [p, setP] = useState<Prefs | null>(null);
  const [email, setEmail] = useState(true);
  const [sms, setSms] = useState(false);
  const [agree, setAgree] = useState(false);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () =>
    api<Prefs>('/api/my/notification-prefs')
      .then((r) => {
        setP(r);
        setEmail(r.email);
        setSms(r.sms);
        setAgree(!!r.consentAt);
      })
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
    // reload when the phone number on the profile changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phone]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setOk('');
    setBusy(true);
    try {
      await api('/api/my/notification-prefs', { method: 'PUT', body: { email, sms, smsConsent: agree } });
      setOk('Notification settings saved.');
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!p) return null;
  return (
    <form className="card" onSubmit={save}>
      <h2>Notifications</h2>
      <p className="muted small">New shifts, changes, approvals and reminders always show in the bell at the top. Choose where else we reach you.</p>
      {error && <Banner onClose={() => setError('')}>{error}</Banner>}
      {ok && (
        <Banner kind="ok" onClose={() => setOk('')}>
          {ok}
        </Banner>
      )}
      <div className="grid-form" style={{ gridTemplateColumns: "1fr" }}>
        <label className="toggle-row">
          <input type="checkbox" checked={email} onChange={(e) => setEmail(e.target.checked)} />
          <span>
            Email me
            <span className="muted small" style={{ display: 'block' }}>Shift offers, changes, approvals and reminders.</span>
          </span>
        </label>
        <label className="toggle-row">
          <input type="checkbox" checked={sms} onChange={(e) => setSms(e.target.checked)} disabled={!p.phoneValid && !sms} />
          <span>
            Text me
            <span className="muted small" style={{ display: 'block' }}>
              {p.phoneValid ? <>Texts go to {p.phone}. Only urgent shift updates and reminders.</> : <>Add a mobile number in “About you” above and save it first.</>}
            </span>
          </span>
        </label>
        {sms && (
          <label className="toggle-row">
            <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
            <span className="small">
              I agree to receive text messages from LaborOps about my shifts at this number. Message frequency varies. Message and data rates may apply. Reply STOP to cancel at any time.
            </span>
          </label>
        )}
        <div className="form-actions">
          <button className="btn primary" disabled={busy || (sms && !agree)}>
            Save notification settings
          </button>
        </div>
      </div>
    </form>
  );
}
