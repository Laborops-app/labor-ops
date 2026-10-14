'use client';
import { useEffect, useState } from 'react';
import Shell from '@/components/Shell';
import { Banner } from '@/components/ui';
import { api } from '@/lib/api';

type St = { connected: boolean; projects: number; lastSync: string | null };

type Ac = {
  url: string;
  secretSet: boolean;
  stats: { total: number; applied: number };
  recent: { code: string; email: string; title: string; kind: string; issued_at: string; applied_at: string | null; user_name: string | null }[];
};

function Academy() {
  const [a, setA] = useState<Ac | null>(null);
  const [secret, setSecret] = useState('');
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const load = () => api<Ac>('/api/integrations/academy').then(setA).catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);
  if (!a) return error ? <Banner>{error}</Banner> : null;
  return (
    <section className="card">
      <div className="row space">
        <h2>Upstage Academy</h2>
        <span className="small">{a.secretSet ? '● Secret set' : '○ Not set up'}</span>
      </div>
      <p className="muted small">
        Certificates students earn in the academy are added to their profile automatically. A student is matched by the email in their LaborOps account, which must be the same as their academy username. In the academy go to Academy → LaborOps, paste the webhook URL below, and paste the secret you generate here.
      </p>
      {error && <Banner onClose={() => setError('')}>{error}</Banner>}
      {msg && <Banner kind="ok" onClose={() => setMsg('')}>{msg}</Banner>}
      <label>
        Webhook URL
        <input readOnly value={a.url} onFocus={(e) => e.currentTarget.select()} />
      </label>
      {secret && (
        <label>
          New secret <span className="muted small">(shown once. Copy it into the academy now)</span>
          <input readOnly value={secret} onFocus={(e) => e.currentTarget.select()} />
        </label>
      )}
      <div className="row">
        <button
          className="btn primary"
          onClick={async () => {
            if (a.secretSet && !confirm('Create a new secret? The academy stops syncing until you paste the new one there.')) return;
            setError('');
            try {
              const r = await api<{ secret: string }>('/api/integrations/academy/secret', { body: {} });
              setSecret(r.secret);
              await load();
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          {a.secretSet ? 'Create a new secret' : 'Create secret'}
        </button>
        <button
          className="btn ghost"
          onClick={async () => {
            setError('');
            try {
              const r = await api<{ checked: number; matched: number }>('/api/integrations/academy/apply', { body: {} });
              setMsg(`${r.matched} of ${r.checked} waiting certificates matched a user.`);
              await load();
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          Match waiting certificates
        </button>
      </div>
      <p className="muted small">
        {a.stats.applied} of {a.stats.total} received certificates are on a profile.
      </p>
      {a.recent.length > 0 && (
        <table>
          <thead>
            <tr><th>Certificate</th><th>Email</th><th>Result</th></tr>
          </thead>
          <tbody>
            {a.recent.map((r) => (
              <tr key={r.code}>
                <td>{r.title}{r.kind === 'group' ? ' (group)' : ''}</td>
                <td>{r.email}</td>
                <td>{r.applied_at ? `Added to ${r.user_name ?? 'profile'}` : 'No matching user yet'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function Body() {
  const [s, setS] = useState<St | null>(null);
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState('');
  const load = () => api<St>('/api/rentman/settings').then(setS).catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);
  const act = async (key: string, msg: string, fn: () => Promise<unknown>) => {
    setError('');
    setOk('');
    setBusy(key);
    try {
      await fn();
      setOk(msg);
      await load();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy('');
    }
  };
  if (!s) return error ? <Banner>{error}</Banner> : <div className="muted">Loading…</div>;
  return (
    <>
      <h1>Integrations</h1>
      {error && <Banner onClose={() => setError('')}>{error}</Banner>}
      {ok && <Banner kind="ok" onClose={() => setOk('')}>{ok}</Banner>}
      <section className="card">
        <div className="row space">
          <h2>Rentman</h2>
          <span className="small">{s.connected ? '● Connected' : '○ Not connected'}</span>
        </div>
        <p className="muted small">
          Link events to Rentman projects and see the project details and equipment rentals on the event page. In Rentman, open Settings → Extensions → API, create an API token and paste it here. The token is stored encrypted and is never shown again.
        </p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (await act('save', 'Rentman is connected. Syncing projects…', () => api('/api/rentman/settings', { method: 'PUT', body: { token } }))) {
              setToken('');
              await act('sync', 'Rentman is connected and projects are synced.', () => api('/api/rentman/sync', { body: {} }));
            }
          }}
        >
          <label>
            API token {s.connected && <span className="muted small">(saved, paste a new one to replace it)</span>}
            <input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="new-password" placeholder={s.connected ? '••••••••••••' : ''} required minLength={10} />
          </label>
          <div className="row">
            <button className="btn primary" disabled={!!busy}>{s.connected ? 'Replace token' : 'Connect Rentman'}</button>
            {s.connected && (
              <button type="button" className="btn ghost" disabled={!!busy} onClick={() => confirm('Disconnect Rentman? Linked events keep their last synced details.') && act('off', 'Rentman is disconnected.', () => api('/api/rentman/settings', { method: 'DELETE' }))}>
                Disconnect
              </button>
            )}
          </div>
        </form>
        {s.connected && (
          <>
            <h3>Projects</h3>
            <p className="small">
              {s.projects} project{s.projects === 1 ? '' : 's'} synced{s.lastSync ? `, last at ${new Date(s.lastSync).toLocaleString()}` : ''}.
            </p>
            <p className="muted small">Syncing also brings Rentman's customers into Customers (contact people and addresses are added, nothing you already entered is overwritten). Customers you create here can be sent the other way; one with the same name in Rentman is linked, not duplicated.</p>
            <div className="row">
            <button className="btn" disabled={!!busy} onClick={() => act('sync', 'Projects and customers synced.', () => api('/api/rentman/sync', { body: {} }))}>
              {busy === 'sync' ? 'Syncing…' : 'Sync projects & customers now'}
            </button>
            <button className="btn" disabled={!!busy} onClick={() => act('push', 'Customers sent to Rentman.', () => api('/api/rentman/push-customers', { body: {} }))}>
              {busy === 'push' ? 'Sending…' : 'Send new customers to Rentman'}
            </button>
            </div>
          </>
        )}
      </section>
      <Academy />
    </>
  );
}

export default function Page() {
  return <Shell roles={['admin']}>{() => <Body />}</Shell>;
}
