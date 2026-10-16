'use client';
import { useEffect, useState } from 'react';
import { api, fmtDateTime } from '@/lib/api';
import { Banner } from '@/components/ui';

type Key = { id: string; name: string; created_at: string; last_used_at: string | null };

/** Profile card: sign in with Face ID / fingerprint / the phone's screen lock instead of a password. */
export default function Passkeys() {
  const [items, setItems] = useState<Key[] | null>(null);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState(false);
  const [supported, setSupported] = useState(true);
  const load = () => api<{ items: Key[] }>('/api/passkeys').then((r) => setItems(r.items)).catch((e) => setError(e.message));
  useEffect(() => {
    setSupported('PublicKeyCredential' in window);
    load();
  }, []);
  const add = async () => {
    setBusy(true);
    setError('');
    setOk('');
    try {
      const { startRegistration } = await import('@simplewebauthn/browser');
      const optionsJSON = await api('/api/passkeys/options', { body: {} });
      const response = await startRegistration({ optionsJSON });
      await api('/api/passkeys', { body: { response } });
      setOk('Passkey saved. Next time, tap "Sign in with a passkey" on the sign-in page.');
      await load();
    } catch (e) {
      const m = (e as Error).name + ' ' + (e as Error).message;
      if (!/NotAllowed|cancel|abort/i.test(m)) setError(/InvalidState/.test(m) ? 'This device already has a passkey for your account.' : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (k: Key) => {
    if (!confirm(`Remove the passkey "${k.name}"? You can add it again later.`)) return;
    await api(`/api/passkeys/${encodeURIComponent(k.id)}`, { method: 'DELETE' }).catch((e) => setError(e.message));
    load();
  };
  return (
    <section className="card">
      <h2>Passkeys</h2>
      <p className="muted small">Sign in with Face ID, your fingerprint or your phone's screen lock: no password to remember or type.</p>
      {error && <Banner onClose={() => setError('')}>{error}</Banner>}
      {ok && <Banner kind="ok" onClose={() => setOk('')}>{ok}</Banner>}
      {items && items.length > 0 && (
        <ul className="plain-list">
          {items.map((k) => (
            <li key={k.id} className="row space">
              <span>
                <b>{k.name}</b>
                <span className="muted small"> · added {fmtDateTime(k.created_at)}{k.last_used_at ? ` · last used ${fmtDateTime(k.last_used_at)}` : ''}</span>
              </span>
              <button className="btn ghost small" onClick={() => remove(k)}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      {supported ? (
        <button className="btn primary small" disabled={busy} onClick={add}>{busy ? 'Waiting for your device…' : 'Add a passkey on this device'}</button>
      ) : (
        <p className="muted small">This browser does not support passkeys.</p>
      )}
    </section>
  );
}
