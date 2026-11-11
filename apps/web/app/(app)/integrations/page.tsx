'use client';
import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Shell from '@/components/Shell';
import Panel from '@/components/Panel';
import AccountingPanels from '@/components/AccountingPanels';
import type { Me } from '@/lib/api';
import { Banner } from '@/components/ui';
import { api } from '@/lib/api';

type RunResult = { created: number; moved: number; datesUpdated: number; flagged: number; skipped: number; errors?: string };
type St = {
  connected: boolean; projects: number; lastSync: string | null;
  pipeline?: { autoEvents: boolean; fromDate: string | null; skipCanceled: boolean; lastRunAt: string | null; lastResult: RunResult | null };
};
const runText = (r: RunResult) =>
  r.errors ? `Failed: ${r.errors}` : [`${r.created} new event${r.created === 1 ? '' : 's'}`, `${r.moved} moved`, r.datesUpdated ? `${r.datesUpdated} re-dated` : '', r.flagged ? `${r.flagged} sent to a coordinator to check` : ''].filter(Boolean).join(', ');

/** Rentman projects into the pipeline: on/off, from which date, skip canceled projects. */
function RentmanPipeline({ s, busy, act }: { s: St; busy: string; act: (key: string, msg: string, fn: () => Promise<unknown>) => Promise<boolean> }) {
  const p = s.pipeline ?? { autoEvents: false, fromDate: null, skipCanceled: true, lastRunAt: null, lastResult: null };
  const [from, setFrom] = useState(p.fromDate ?? '');
  const [skip, setSkip] = useState(p.skipCanceled);
  const save = (autoEvents: boolean) =>
    act('pipe', autoEvents ? 'Rentman projects now come into the pipeline. Syncing…' : 'Rentman projects no longer come into the pipeline on their own.', async () => {
      await api('/api/rentman/pipeline', { method: 'PUT', body: { autoEvents, fromDate: from || null, skipCanceled: skip } });
      if (autoEvents) await api('/api/rentman/sync', { body: {} });
    });
  return (
    <>
      <h3>Pipeline</h3>
      <label className="check">
        <input type="checkbox" checked={p.autoEvents} disabled={!!busy} onChange={(e) => save(e.target.checked)} />
        <span>Add new Rentman projects to the pipeline as events</span>
      </label>
      <p className="muted small">
        Checked every 30 minutes and on each sync. Each project becomes an event with its customer, venue and dates, in the column its Rentman status
        matches (concept or inquiry → New, option → Quote, confirmed → Confirmed). Linked events move forward when Rentman’s status does. A project canceled in
        Rentman cancels its event only if nobody is booked; otherwise you’re told. New dates are copied while an event has no days or shifts; otherwise you’re told.
      </p>
      <div className="row" style={{ flexWrap: 'wrap', gap: 12, alignItems: 'end' }}>
        <label style={{ maxWidth: 220 }}>
          Projects ending on or after
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="check">
          <input type="checkbox" checked={skip} onChange={(e) => setSkip(e.target.checked)} /> Skip projects already canceled
        </label>
        {(from !== (p.fromDate ?? '') || skip !== p.skipCanceled) && (
          <button type="button" className="btn small" disabled={!!busy} onClick={() => save(p.autoEvents)}>Save</button>
        )}
      </div>
      {p.lastRunAt && p.lastResult && (
        <p className="small">Last run {new Date(p.lastRunAt).toLocaleString()}: {runText(p.lastResult)}.</p>
      )}
    </>
  );
}

type Ac = {
  url: string;
  siteUrl: string;
  secretSet: boolean;
  stats: { total: number; applied: number };
  recent: { code: string; email: string; title: string; kind: string; issued_at: string; applied_at: string | null; user_name: string | null }[];
};

function Academy() {
  const [a, setA] = useState<Ac | null>(null);
  const [secret, setSecret] = useState('');
  const [site, setSite] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const load = () => api<Ac>('/api/integrations/academy').then(setA).catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);
  if (!a) return error ? <Banner>{error}</Banner> : null;
  return (
    <Panel
      id="academy"
      title="Upstage Academy"
      summary="Add certificates students earn to their profiles"
      status={a.secretSet ? <span className="chip open">Set up · {a.stats.applied}/{a.stats.total} added</span> : <span className="chip">Not set up</span>}
    >
      <p className="muted small">
        Certificates students earn in the academy are added to their profile automatically. A student is matched by the email in their LaborOps account, which must be the same as their academy username. In the academy go to Academy → LaborOps, paste the webhook URL below, and paste the secret you generate here.
      </p>
      {error && <Banner onClose={() => setError('')}>{error}</Banner>}
      {msg && <Banner kind="ok" onClose={() => setMsg('')}>{msg}</Banner>}
      <form
        className="row"
        style={{ alignItems: 'flex-end', gap: 8, marginBottom: 12 }}
        onSubmit={async (e) => {
          e.preventDefault();
          setError('');
          try {
            await api('/api/integrations/academy/site', { method: 'PUT', body: { url: site ?? a.siteUrl } });
            setSite(null);
            setMsg('Academy address saved. Course groups can now be synced on the Trainings page.');
            await load();
          } catch (x) {
            setError((x as Error).message);
          }
        }}
      >
        <label style={{ flex: 1, margin: 0 }}>
          Academy web address <span className="muted small">(filled in automatically after the academy&apos;s first test ping)</span>
          <input type="url" value={site ?? a.siteUrl} onChange={(e) => setSite(e.target.value)} placeholder="https://academy.example.com" />
        </label>
        <button className="btn" disabled={site === null || site === a.siteUrl}>Save address</button>
      </form>
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
    </Panel>
  );
}

function Body({ me }: { me: Me }) {
  const params = useSearchParams();
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
      <p className="muted">Click an integration to open its settings.</p>
      <h2 className="panel-group-title">Apps</h2>
      {error && <Banner onClose={() => setError('')}>{error}</Banner>}
      {ok && <Banner kind="ok" onClose={() => setOk('')}>{ok}</Banner>}
      <Panel
        id="rentman"
        title="Rentman"
        summary="Link events to Rentman projects and sync customers"
        status={s.connected ? <span className="chip open">Connected · {s.projects} project{s.projects === 1 ? '' : 's'}</span> : <span className="chip">Not connected</span>}
      >
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
            <button className="btn" disabled={!!busy} onClick={() => act('sync', 'Projects and customers synced.', async () => {
              const r = await api<{ pipeline?: RunResult }>('/api/rentman/sync', { body: {} });
              if (r.pipeline && s.pipeline?.autoEvents) setTimeout(() => setOk(`Projects and customers synced. Pipeline: ${runText(r.pipeline!)}.`), 0);
            })}>
              {busy === 'sync' ? 'Syncing…' : 'Sync projects & customers now'}
            </button>
            <button className="btn" disabled={!!busy} onClick={() => act('push', 'Customers sent to Rentman.', () => api('/api/rentman/push-customers', { body: {} }))}>
              {busy === 'push' ? 'Sending…' : 'Send new customers to Rentman'}
            </button>
            </div>
            <RentmanPipeline s={s} busy={busy} act={act} />
          </>
        )}
      </Panel>
      <Academy />
      <AccountingPanels qbo={params.get('qbo')} />

    </>
  );
}

export default function Page() {
  return (
    <Shell roles={['admin']}>
      {(me) => (
        <Suspense fallback={<div className="muted">Loading…</div>}>
          <Body me={me} />
        </Suspense>
      )}
    </Shell>
  );
}
