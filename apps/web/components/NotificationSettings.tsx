'use client';
import { useLoadEffect } from '@/lib/tabs';
import { useState } from 'react';
import { api } from '@/lib/api';
import { Banner } from '@/components/ui';
import BrowserPush from '@/components/BrowserPush';

type Grp = { key: string; label: string; canText: boolean; push: boolean; email: boolean; text: boolean };
type Prefs = { email: boolean; sms: boolean; phone: string | null; phoneValid: boolean; consentAt: string | null; groups?: Grp[]; quietStart?: string | null; quietEnd?: string | null; digest?: boolean | null };

export default function NotificationSettings({ phone }: { phone?: string | null }) {
  const [p, setP] = useState<Prefs | null>(null);
  const [email, setEmail] = useState(true);
  const [sms, setSms] = useState(false);
  const [agree, setAgree] = useState(false);
  const [groups, setGroups] = useState<Grp[]>([]);
  const [quiet, setQuiet] = useState(false);
  const [qs, setQs] = useState('22:00');
  const [qe, setQe] = useState('07:00');
  const [digest, setDigest] = useState<boolean | null>(null);
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
        setGroups(r.groups ?? []);
        setQuiet(!!(r.quietStart && r.quietEnd));
        if (r.quietStart) setQs(r.quietStart);
        if (r.quietEnd) setQe(r.quietEnd);
        setDigest(r.digest ?? null);
      })
      .catch((e) => setError(e.message));
  // reload when the phone number on the profile changes (not when its tab is shown again)
  useLoadEffect(load, [phone]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setOk('');
    setBusy(true);
    try {
      await api('/api/my/notification-prefs', { method: 'PUT', body: {
        email, sms, smsConsent: agree,
        groups: Object.fromEntries(groups.map((g) => [g.key, { push: g.push, email: g.email, ...(g.canText ? { text: g.text } : {}) }])),
        quietStart: quiet ? qs : null, quietEnd: quiet ? qe : null,
        ...(digest === null ? {} : { digest }),
      } });
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
      <BrowserPush />
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
        {groups.length > 0 && (
          <div className="np-wrap">
            <h3 className="np-h">What you get, and where</h3>
            <table className="np-table">
              <thead><tr><th scope="col"><span className="sr-only">Kind of alert</span></th><th scope="col">App</th><th scope="col">Email</th><th scope="col">Text</th></tr></thead>
              <tbody>
                {groups.map((g, i) => (
                  <tr key={g.key}>
                    <th scope="row">{g.label}</th>
                    {(['push', 'email', 'text'] as const).map((ch) => {
                      const off = (ch === 'email' && !email) || (ch === 'text' && (!sms || !g.canText));
                      return (
                        <td key={ch}>
                          {ch === 'text' && !g.canText ? <span className="muted small" aria-label="Not sent by text">–</span> : (
                            <input type="checkbox" aria-label={`${g.label}: ${ch === 'push' ? 'app' : ch}`} checked={g[ch] && !off} disabled={off}
                              onChange={(e) => setGroups(groups.map((x, k) => (k === i ? { ...x, [ch]: e.target.checked } : x)))} />
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted small" style={{ margin: '6px 0 0' }}>Everything still shows in the bell. Email and Text follow the two switches above.</p>
          </div>
        )}
        <label className="toggle-row">
          <input type="checkbox" checked={quiet} onChange={(e) => setQuiet(e.target.checked)} />
          <span>
            Quiet hours
            <span className="muted small" style={{ display: 'block' }}>No app alerts or texts in this window, except shift offers, changes, reminders and attendance. They arrive when it ends.</span>
          </span>
        </label>
        {quiet && (
          <div className="np-quiet">
            <label>From <input type="time" value={qs} onChange={(e) => setQs(e.target.value)} required /></label>
            <label>to <input type="time" value={qe} onChange={(e) => setQe(e.target.value)} required /></label>
          </div>
        )}
        {digest !== null && (
          <label className="toggle-row">
            <input type="checkbox" checked={digest} onChange={(e) => setDigest(e.target.checked)} />
            <span>
              Morning summary
              <span className="muted small" style={{ display: 'block' }}>At 7am: today’s calls, open seats in the next 3 days, unanswered offers, timesheets and requests. Skipped on days with nothing to say.</span>
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
