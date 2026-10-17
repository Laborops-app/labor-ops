'use client';
import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Shell from '@/components/Shell';
import Fold from '@/components/Fold';
import { Banner, Empty, Pill } from '@/components/ui';
import { api, fmtDateTime } from '@/lib/api';

type Row = { id: string; channel: 'email' | 'sms' | 'push'; category: string; to_addr: string; subject: string | null; status: string; attempts: number; last_error: string | null; created_at: string; user_name: string | null };
type Reply = { id: string; from_addr: string; contact_name: string | null; body: string; received_at: string; user_name: string | null };
type Data = {
  email: { live: boolean; from: string; host: string | null; source: 'company' | 'server' };
  sms: { live: boolean; provider: 'none' | 'zernio' | 'podium'; from: string | null };
  settings: {
    ses: { host: string; port: number; user: string; passSet: boolean; from: string; source: string };
    zernio: { apiKeySet: boolean; from: string; source: string };
    podium: { clientId: string; locationUid: string; clientSecretSet: boolean; connected: boolean; connectedAt: string | null; webhookSecretSet: boolean; webhookRegistered: boolean };
  };
  urls: { appUrl: string; podiumRedirect: string; podiumWebhook: string };
  stats: { channel: string; status: string; n: number }[];
  deliveries: Row[];
  replies: Reply[];
};

const mask = (r: Row) => (r.channel === 'sms' ? r.to_addr.replace(/\d(?=\d{4})/g, '•') : r.to_addr);
const CH = { email: 'Email', sms: 'Text', push: 'Push' } as const;
const PROVIDERS = { none: 'Off (log only)', zernio: 'Zernio', podium: 'Podium' } as const;

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label>
      {label}
      {hint && <span className="muted small"> {hint}</span>}
      {children}
    </label>
  );
}

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="copy-row">
      <code className="mono">{text}</code>
      <button
        type="button"
        className="btn ghost small"
        onClick={() => {
          navigator.clipboard?.writeText(text).then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          });
        }}
      >
        {done ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

function Body() {
  const params = useSearchParams();
  const [d, setD] = useState<Data | null>(null);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState('');
  const [to, setTo] = useState({ email: '', sms: '' });
  const [ses, setSes] = useState({ host: '', port: '587', user: '', pass: '', from: '' });
  const [zernio, setZernio] = useState({ apiKey: '', from: '' });
  const [podium, setPodium] = useState({ clientId: '', clientSecret: '', locationUid: '' });
  const [locs, setLocs] = useState<{ uid: string; name: string }[] | null>(null);
  const [hook, setHook] = useState<{ url: string; secret: string } | null>(null);

  const load = () =>
    api<Data>('/api/messaging')
      .then((r) => {
        setD(r);
        const s = r.settings;
        setSes({ host: s.ses.host, port: String(s.ses.port || 587), user: s.ses.user, pass: '', from: s.ses.from });
        setZernio({ apiKey: '', from: s.zernio.from });
        setPodium({ clientId: s.podium.clientId, clientSecret: '', locationUid: s.podium.locationUid });
      })
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
    const p = params.get('podium');
    if (p === 'connected') setOk('Podium is connected.');
    else if (p) setError(p === 'denied' ? 'Podium access was not approved.' : 'Could not connect Podium. Check the client ID, secret and redirect address, then try again.');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = async (key: string, fn: () => Promise<string | void>) => {
    setError('');
    setOk('');
    setBusy(key);
    try {
      const msg = await fn();
      if (msg) setOk(msg);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  const save = (p: 'ses' | 'zernio' | 'podium', body: object, label: string) =>
    run(`save-${p}`, async () => {
      await api(`/api/messaging/settings/${p}`, { method: 'PUT', body });
      return `${label} settings saved.`;
    });
  const test = (channel: 'email' | 'sms') =>
    run(`test-${channel}`, async () => {
      const r = await api<{ logged: boolean }>('/api/messaging/test', { body: { channel, to: to[channel] } });
      return r.logged ? 'Recorded in log-only mode. Nothing was delivered because this channel is not connected yet.' : 'Test message sent.';
    });

  const count = (channel: string, status: string) => d?.stats.find((s) => s.channel === channel && s.status === status)?.n ?? 0;
  const stat = (ch: string) => `Last 30 days: ${count(ch, 'sent')} sent · ${count(ch, 'failed')} failed · ${count(ch, 'queued') + count(ch, 'sending')} waiting`;
  const dot = (live: boolean) => <span className={`status-dot ${live ? 'live' : 'log'}`} />;

  if (!d) return <><h1>Messaging</h1>{error && <Banner onClose={() => setError('')}>{error}</Banner>}<div className="muted">Loading…</div></>;
  const s = d.settings;

  return (
    <>
      <h1>Messaging</h1>
      {error && <Banner onClose={() => setError('')}>{error}</Banner>}
      {ok && (
        <Banner kind="ok" onClose={() => setOk('')}>
          {ok}
        </Banner>
      )}

      <div className="cols-3">
        <section className="card">
          <div className="row space">
            <h2>Email</h2>
            <span className="small">{dot(d.email.live)}{d.email.live ? 'Connected' : 'Not connected'}</span>
          </div>
          <p className="muted small">{d.email.live ? `Amazon SES, sending from ${d.email.from}.` : 'Add your Amazon SES details below.'}</p>
          <p className="small">{stat('email')}</p>
        </section>
        <section className="card">
          <div className="row space">
            <h2>Text messages</h2>
            <span className="small">{dot(d.sms.live)}{d.sms.live ? 'Connected' : 'Not connected'}</span>
          </div>
          <p className="muted small">{d.sms.live ? `Through ${PROVIDERS[d.sms.provider]}${d.sms.from ? ` · ${d.sms.from}` : ''}.` : 'Choose a texting service below.'}</p>
          <p className="small">{stat('sms')}</p>
        </section>
        <section className="card">
          <div className="row space">
            <h2>Browser push</h2>
            <span className="small">{dot(true)}Built in</span>
          </div>
          <p className="muted small">Notifications in the web app and the installed phone app. Crew turn them on from their profile page. No setup needed.</p>
          <p className="small">{stat('push')}</p>
        </section>
      </div>

      <Fold id="msg-email" title="Email · Amazon SES" sub={d.email.live ? `Sending from ${d.email.from}` : 'Not set up'} status={<>{dot(d.email.live)}{d.email.live ? 'Connected' : 'Not connected'}</>}>
        <p className="muted small" style={{ marginTop: 0 }}>
          In the SES console, verify your sending domain, then create SMTP credentials. The SMTP user and password are not the same as your AWS login.
          {s.ses.source === 'server' && s.ses.host && ' Currently using the server’s default settings; saving here overrides them for your company.'}
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save('ses', { host: ses.host, port: Number(ses.port) || 587, user: ses.user, pass: ses.pass, from: ses.from }, 'Email');
          }}
        >
          <div className="settings-grid">
            <Field label="SMTP server" hint="e.g. email-smtp.us-west-2.amazonaws.com">
              <input value={ses.host} onChange={(e) => setSes({ ...ses, host: e.target.value })} placeholder="email-smtp.us-west-2.amazonaws.com" required />
            </Field>
            <Field label="Port">
              <input type="number" value={ses.port} onChange={(e) => setSes({ ...ses, port: e.target.value })} />
            </Field>
            <Field label="SMTP username">
              <input value={ses.user} onChange={(e) => setSes({ ...ses, user: e.target.value })} autoComplete="off" required />
            </Field>
            <Field label="SMTP password" hint={s.ses.passSet ? '(saved — leave blank to keep)' : ''}>
              <input type="password" value={ses.pass} onChange={(e) => setSes({ ...ses, pass: e.target.value })} autoComplete="new-password" placeholder={s.ses.passSet ? '••••••••' : ''} required={!s.ses.passSet} />
            </Field>
            <Field label="From address" hint="must use a verified domain">
              <input value={ses.from} onChange={(e) => setSes({ ...ses, from: e.target.value })} placeholder="LaborOps <no-reply@yourdomain.com>" required />
            </Field>
            <div className="form-actions">
              <button className="btn primary" disabled={!!busy}>Save email settings</button>
              {s.ses.source === 'company' && (
                <button type="button" className="btn ghost" disabled={!!busy} onClick={() => run('clear-ses', async () => { await api('/api/messaging/settings/ses', { method: 'DELETE' }); return 'Email settings cleared.'; })}>
                  Clear
                </button>
              )}
            </div>
          </div>
        </form>
        <form className="row test-row" onSubmit={(e) => { e.preventDefault(); test('email'); }}>
          <input style={{ flex: 1, minWidth: 180 }} type="email" placeholder="you@example.com" value={to.email} onChange={(e) => setTo({ ...to, email: e.target.value })} required aria-label="Send a test email to" />
          <button className="btn" disabled={!!busy}>{busy === 'test-email' ? 'Sending…' : 'Send test email'}</button>
        </form>
      </Fold>

      <Fold id="msg-sms" title="Text messages · service" sub={`Using ${PROVIDERS[d.sms.provider]}`} status={<>{dot(d.sms.live)}{d.sms.live ? 'Connected' : 'Not connected'}</>} defaultOpen={!d.sms.live}>
        <p className="muted small" style={{ marginTop: 0 }}>Pick which service sends texts. People only receive texts after they turn them on and agree on their own profile.</p>
        <div className="seg" role="radiogroup" aria-label="Texting service">
          {(Object.keys(PROVIDERS) as (keyof typeof PROVIDERS)[]).map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={d.sms.provider === k}
              className={`seg-btn ${d.sms.provider === k ? 'on' : ''}`}
              disabled={!!busy}
              onClick={() => run('provider', async () => { await api('/api/messaging/sms-provider', { method: 'PUT', body: { provider: k } }); })}
            >
              {PROVIDERS[k]}
            </button>
          ))}
        </div>
        <form className="row test-row" onSubmit={(e) => { e.preventDefault(); test('sms'); }}>
          <input style={{ flex: 1, minWidth: 180 }} type="tel" placeholder="+1 801 555 0123" value={to.sms} onChange={(e) => setTo({ ...to, sms: e.target.value })} required aria-label="Send a test text to" />
          <button className="btn" disabled={!!busy}>{busy === 'test-sms' ? 'Sending…' : 'Send test text'}</button>
        </form>
        <p className="muted small">In-app notifications and phone/browser push work without any of these.</p>
      </Fold>

      <Fold
        id="msg-zernio"
        title="Zernio"
        sub={s.zernio.apiKeySet && s.zernio.from ? `Sending from ${s.zernio.from}` : 'Add your API key and sending number'}
        status={<>{dot(d.sms.provider === 'zernio' && d.sms.live)}{s.zernio.apiKeySet && s.zernio.from ? (d.sms.provider === 'zernio' ? 'In use' : 'Saved') : 'Not set up'}</>}
      >
        <p className="muted small" style={{ marginTop: 0 }}>
          Texting through Zernio (zernio.com). In your Zernio dashboard, create an API key and get an SMS-enabled number (US numbers need their carrier
          registration approved before they can send). People who reply STOP are switched off automatically.
          {s.zernio.source === 'server' && s.zernio.apiKeySet && ' Currently using the server’s default key; saving here overrides it for your company.'}
        </p>
        <form onSubmit={(e) => { e.preventDefault(); save('zernio', zernio, 'Zernio'); }}>
          <div className="settings-grid">
            <Field label="API key" hint={s.zernio.apiKeySet ? '(saved — leave blank to keep)' : ''}>
              <input type="password" value={zernio.apiKey} onChange={(e) => setZernio({ ...zernio, apiKey: e.target.value })} autoComplete="new-password" placeholder={s.zernio.apiKeySet ? '••••••••' : ''} required={!s.zernio.apiKeySet} />
            </Field>
            <Field label="Send from" hint="your Zernio number">
              <input value={zernio.from} onChange={(e) => setZernio({ ...zernio, from: e.target.value })} placeholder="+18015550100" required />
            </Field>
            <div className="form-actions">
              <button className="btn primary" disabled={!!busy}>Save Zernio settings</button>
              {d.sms.provider !== 'zernio' && s.zernio.apiKeySet && (
                <button type="button" className="btn" disabled={!!busy} onClick={() => run('use-zernio', async () => { await api('/api/messaging/sms-provider', { method: 'PUT', body: { provider: 'zernio' } }); return 'Texts now go through Zernio.'; })}>Use Zernio for texts</button>
              )}
              {s.zernio.source === 'company' && (
                <button type="button" className="btn ghost" disabled={!!busy} onClick={() => run('clear-zernio', async () => { await api('/api/messaging/settings/zernio', { method: 'DELETE' }); return 'Zernio settings cleared.'; })}>Clear</button>
              )}
            </div>
          </div>
        </form>
      </Fold>

      <Fold id="msg-podium" title="Podium" sub="Texts through your Podium inbox, with replies" status={<>{dot(s.podium.connected)}{s.podium.connected ? 'Connected' : 'Not connected'}</>}>
        <p className="muted small" style={{ marginTop: 0 }}>Texts go out through your Podium inbox, and customer replies show up in both places. You need a Podium developer app (client ID and secret).</p>
        <p className="small">Add this as the redirect address in your Podium app:</p>
        <Copy text={d.urls.podiumRedirect} />
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save('podium', podium, 'Podium');
          }}
        >
          <div className="settings-grid">
            <Field label="Client ID">
              <input value={podium.clientId} onChange={(e) => setPodium({ ...podium, clientId: e.target.value })} autoComplete="off" required />
            </Field>
            <Field label="Client secret" hint={s.podium.clientSecretSet ? '(saved — leave blank to keep)' : ''}>
              <input type="password" value={podium.clientSecret} onChange={(e) => setPodium({ ...podium, clientSecret: e.target.value })} autoComplete="new-password" placeholder={s.podium.clientSecretSet ? '••••••••' : ''} required={!s.podium.clientSecretSet} />
            </Field>
            <Field label="Location ID" hint="Podium location UID">
              <input value={podium.locationUid} onChange={(e) => setPodium({ ...podium, locationUid: e.target.value })} required />
              {s.podium.connected && (
                <div style={{ marginTop: 6 }}>
                  <button type="button" className="btn ghost" disabled={!!busy} onClick={() => run('locs', async () => { const r = await api<{ locations: { uid: string; name: string }[] }>('/api/podium/locations'); setLocs(r.locations); if (!r.locations.length) return 'Podium returned no locations.'; })}>
                    Find my locations
                  </button>
                  {locs?.map((l) => (
                    <div key={l.uid} className="small">
                      <button type="button" className="btn ghost" onClick={() => setPodium({ ...podium, locationUid: l.uid })}>Use</button> {l.name} <span className="muted">{l.uid}</span>
                    </div>
                  ))}
                </div>
              )}
            </Field>
            <div className="form-actions">
              <button className="btn primary" disabled={!!busy}>Save Podium settings</button>
              <button
                type="button"
                className="btn"
                disabled={!!busy || !s.podium.clientSecretSet || !s.podium.clientId}
                onClick={() => run('connect', async () => { const r = await api<{ url: string }>('/api/podium/connect'); window.location.href = r.url; })}
              >
                {s.podium.connected ? 'Reconnect' : 'Connect to Podium'}
              </button>
              {s.podium.connected && (
                <button type="button" className="btn ghost" disabled={!!busy} onClick={() => run('disc', async () => { await api('/api/podium/disconnect', { body: {} }); return 'Podium disconnected.'; })}>
                  Disconnect
                </button>
              )}
            </div>
          </div>
        </form>
        {s.podium.connected && (
          <>
            <h3 style={{ marginTop: 18 }}>Replies from customers</h3>
            <p className="muted small">Podium sends replies and delivery failures to LaborOps through a webhook.</p>
            <div className="row">
              <button className="btn" disabled={!!busy} onClick={() => run('hook', async () => { await api('/api/podium/webhook/register', { body: {} }); return 'Webhook registered with Podium.'; })}>
                {s.podium.webhookRegistered ? 'Register again' : 'Register webhook with Podium'}
              </button>
              <button className="btn ghost" disabled={!!busy} onClick={() => run('hooksecret', async () => { setHook(await api('/api/podium/webhook-secret')); })}>
                Show URL and secret to add by hand
              </button>
            </div>
            {hook && (
              <div style={{ marginTop: 10 }}>
                <div className="small muted">Webhook URL</div>
                <Copy text={hook.url} />
                <div className="small muted">Signing secret</div>
                <Copy text={hook.secret} />
              </div>
            )}
          </>
        )}
      </Fold>

      {d.replies.length > 0 && (
        <Fold id="msg-replies" title="Text replies" sub={`${d.replies.length} recent`}>
          <div className="table-wrap">
            <table>
              <tbody>
                {d.replies.map((r) => (
                  <tr key={r.id}>
                    <td className="small">{fmtDateTime(r.received_at)}</td>
                    <td className="small">
                      {r.user_name ?? r.contact_name ?? '—'}
                      <div className="muted mono">{r.from_addr.replace(/\d(?=\d{4})/g, '•')}</div>
                    </td>
                    <td>{r.body}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Fold>
      )}

      <Fold id="msg-recent" title="Recent messages" sub="The last 50 emails, texts and push notifications" defaultOpen>
        {d.deliveries.length === 0 ? (
          <Empty>Nothing has been sent yet.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>To</th>
                  <th>Message</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {d.deliveries.map((r) => (
                  <tr key={r.id}>
                    <td className="small">{fmtDateTime(r.created_at)}</td>
                    <td className="small">
                      {r.user_name ?? '—'}
                      <div className="muted mono">{mask(r)}</div>
                    </td>
                    <td className="small">
                      {CH[r.channel]} · {r.category.replace('_', ' ')}
                      {r.subject && <div className="muted">{r.subject}</div>}
                    </td>
                    <td>
                      <Pill status={r.status} />
                      {r.last_error && <div className="muted small">{r.last_error}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Fold>
    </>
  );
}

export default function Page() {
  return (
    <Shell roles={['admin']}>
      {() => (
        <Suspense fallback={<div className="muted">Loading…</div>}>
          <Body />
        </Suspense>
      )}
    </Shell>
  );
}
