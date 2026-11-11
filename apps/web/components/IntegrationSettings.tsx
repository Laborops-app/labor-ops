'use client';
import { ActIcon } from '@/components/ActionMenu';
import { useEffect, useState } from 'react';
import Panel from '@/components/Panel';
import { Banner } from '@/components/ui';
import { api } from '@/lib/api';
import RentmanOptions from '@/components/RentmanOptions';

type RunResult = { created: number; moved: number; datesUpdated: number; flagged: number; skipped: number; built?: number; shiftChanges?: number; errors?: string };
type St = {
  connected: boolean; projects: number; lastSync: string | null;
  pipeline?: { autoEvents: boolean; fromDate: string | null; skipCanceled: boolean; buildShifts?: boolean; lastRunAt: string | null; lastResult: RunResult | null };
};
const runText = (r: RunResult) =>
  r.errors ? `Failed: ${r.errors}` : [`${r.created} new event${r.created === 1 ? '' : 's'}`, `${r.moved} moved`, r.datesUpdated ? `${r.datesUpdated} re-dated` : '', r.shiftChanges ? `${r.shiftChanges} shift change${r.shiftChanges === 1 ? '' : 's'} from Rentman` : '', r.flagged ? `${r.flagged} sent to a coordinator to check` : ''].filter(Boolean).join(', ');

type Found = {
  projects: { id: number; number: number | null; name: string; status: string | null; start: string | null; end: string | null; event: { id: string; name: string } | null; reason: string; canAdd: boolean }[];
  requests: { id: number; name: string; status: string; start: string | null; event: { id: string; name: string } | null; reason: string }[];
};
/** "Why isn't my Rentman project on the pipeline?": search by project number or name and see what LaborOps did with it. */
function FindRentman() {
  const [q, setQ] = useState('');
  const [r, setR] = useState<Found | null>(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const find = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!q.trim()) return;
    setBusy('find'); setErr(''); setMsg('');
    try { setR(await api<Found>(`/api/rentman/find?q=${encodeURIComponent(q.trim())}`)); } catch (x) { setErr((x as Error).message); } finally { setBusy(''); }
  };
  return (
    <div className="rm-find">
      <h4>Missing a project?</h4>
      <form className="row" style={{ gap: 8, flexWrap: 'wrap' }} onSubmit={find}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rentman project number or name" style={{ maxWidth: 300 }} aria-label="Rentman project number or name" />
        <button className="btn small" disabled={!!busy || !q.trim()}>{busy === 'find' ? 'Checking Rentman…' : 'Find'}</button>
      </form>
      {err && <p className="error small">{err}</p>}
      {msg && <p className="small" style={{ color: 'var(--good)' }}>{msg}</p>}
      {r && (
        r.projects.length + r.requests.length === 0 ? <p className="muted small">Nothing in Rentman matches “{q}”. Check the number, or that the API token’s Rentman user can see that project.</p> : (
          <ul className="plain small">
            {r.projects.map((p) => (
              <li key={`p${p.id}`}>
                <b>{p.number ? `#${p.number} ` : ''}{p.name}</b> <span className="muted">· project{p.status ? ` · ${p.status}` : ''}{p.start ? ` · ${p.start}${p.end && p.end !== p.start ? ` to ${p.end}` : ''}` : ''}</span>
                <div>{p.reason}</div>
                <div className="row" style={{ gap: 8, marginTop: 4 }}>
                  {p.event && <a className="btn ghost small" href={`/events/${p.event.id}`}>Open event</a>}
                  {!p.event && p.canAdd && (
                    <button type="button" className="btn small primary" disabled={!!busy} onClick={async () => {
                      setBusy(`add${p.id}`); setErr('');
                      try { const x = await api<{ eventId: string }>(`/api/rentman/projects/${p.id}/add`, { body: {} }); setMsg(`${p.name} added to the pipeline.`); await find(); window.open(`/events/${x.eventId}`, '_self'); }
                      catch (x) { setErr((x as Error).message); } finally { setBusy(''); }
                    }}>{busy === `add${p.id}` ? 'Adding…' : 'Add to pipeline now'}</button>
                  )}
                </div>
              </li>
            ))}
            {r.requests.map((x) => (
              <li key={`r${x.id}`}>
                <b>{x.name}</b> <span className="muted">· project request {x.id} · {x.status}{x.start ? ` · ${x.start}` : ''}</span>
                <div>{x.reason}</div>
                {x.event && <a className="btn ghost small" href={`/events/${x.event.id}`}>Open event</a>}
              </li>
            ))}
          </ul>
        )
      )}
    </div>
  );
}

/** Rentman projects into the pipeline: on/off, from which date, skip canceled projects. */
function RentmanPipeline({ s, busy, act }: { s: St; busy: string; act: (key: string, msg: string, fn: () => Promise<unknown>) => Promise<boolean> }) {
  const p = s.pipeline ?? { autoEvents: false, fromDate: null, skipCanceled: true, buildShifts: true, lastRunAt: null, lastResult: null };
  const [from, setFrom] = useState(p.fromDate ?? '');
  const [skip, setSkip] = useState(p.skipCanceled);
  const [build, setBuild] = useState(p.buildShifts ?? true);
  const save = (autoEvents: boolean) =>
    act('pipe', autoEvents ? 'Rentman projects now come into the pipeline. Syncing…' : 'Rentman projects no longer come into the pipeline on their own.', async () => {
      await api('/api/rentman/pipeline', { method: 'PUT', body: { autoEvents, fromDate: from || null, skipCanceled: skip, buildShifts: build } });
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
        matches (concept or inquiry → New, option → Quote, confirmed → Confirmed). Open Rentman project requests (not accepted yet) come in as New events too,
        and link to the project once Rentman accepts them. Linked events follow Rentman’s status. A project canceled in
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
        <label className="check">
          <input type="checkbox" checked={build} onChange={(e) => setBuild(e.target.checked)} /> Build days and shifts from Rentman’s crew and transport
        </label>
        {(from !== (p.fromDate ?? '') || skip !== p.skipCanceled || build !== (p.buildShifts ?? true)) && (
          <button type="button" className="btn small" disabled={!!busy} onClick={() => save(p.autoEvents)}>Save</button>
        )}
      </div>
      {p.lastRunAt && p.lastResult && (
        <p className="small">Last run {new Date(p.lastRunAt).toLocaleString()}: {runText(p.lastResult)}.</p>
      )}
      <FindRentman />
    </>
  );
}

/** Rentman function names that aren't a LaborOps role by name: pick the role once. */
function RoleMap({ standalone }: { standalone?: boolean }) {
  const [d, setD] = useState<{ map: { rentman_name: string; role_name: string | null; suggested?: string | null }[]; roles: string[] } | null>(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => api<NonNullable<typeof d>>('/api/rentman/role-map').then(setD).catch(() => {});
  useEffect(() => { load(); }, []);
  if (!d) return null;
  const set = async (rentmanName: string, roleName: string) => {
    setErr('');
    const r = await api<{ renamed?: number }>('/api/rentman/role-map', { method: 'PUT', body: { rentmanName, roleName: roleName || null } });
    setMsg(roleName
      ? `“${rentmanName}” becomes ${roleName}.${r.renamed ? ` ${r.renamed} shift${r.renamed === 1 ? '' : 's'} renamed to ${roleName}, so its rates apply.` : ''}`
      : `“${rentmanName}” keeps its Rentman name.`);
    load();
  };
  const remove = async (rentmanName: string) => {
    setErr('');
    try {
      await api(`/api/rentman/role-map?name=${encodeURIComponent(rentmanName)}`, { method: 'DELETE' });
      setMsg(`“${rentmanName}” removed from the list. It won’t come back on the next sync.`);
      load();
    } catch (e) { setErr((e as Error).message); }
  };
  const resync = async () => {
    setBusy(true); setErr(''); setMsg('');
    try {
      const r = await api<{ events: number; matched: { rentman: string; role: string }[]; unmatched: string[]; shiftsUpdated: number; conflicts: number }>('/api/rentman/role-map/resync', { body: {} });
      setMsg(`Checked ${r.events} linked event${r.events === 1 ? '' : 's'}. ${r.matched.length ? `Matched ${r.matched.map((m) => `“${m.rentman}” → ${m.role}`).join(', ')}. ` : 'No new matches. '}${r.shiftsUpdated} shift${r.shiftsUpdated === 1 ? '' : 's'} updated${r.conflicts ? `, ${r.conflicts} to decide on their events` : ''}.${r.unmatched.length ? ` Still to pick: ${r.unmatched.length}.` : ''}`);
      load();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const open = d.map.filter((m) => !m.role_name).length;
  return (
    <>
      {!standalone && <h3>Role names</h3>}
      <div className="row space" style={{ flexWrap: 'wrap', gap: 8 }}>
        <p className="muted small" style={{ margin: 0, flex: 1, minWidth: 260 }}>
          Rentman crew functions whose names aren’t exactly a LaborOps role. Pick the role each one becomes. <b>Re-sync role names</b> reads Rentman’s names on every linked
          event again, matches the clear ones (like “Rigger IATSE” → Rigger), and updates shifts that follow Rentman.
        </p>
        <button type="button" className="btn primary small" disabled={busy} onClick={resync}>{busy ? 'Re-syncing…' : 'Re-sync role names'}</button>
      </div>
      {err && <p className="error small">{err}</p>}
      {msg && <p className="small" style={{ color: 'var(--good)' }}>{msg}</p>}
      {d.map.length === 0 ? <p className="muted small">Every Rentman name matches a LaborOps role.</p> : (
        <>
          {open > 0 && <p className="small">{open} name{open === 1 ? '' : 's'} not matched yet.</p>}
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Rentman function</th><th>LaborOps role</th><th><span className="sr-only">Remove</span></th></tr></thead>
              <tbody>
                {d.map.map((m) => (
                  <tr key={m.rentman_name}>
                    <td>{m.rentman_name}</td>
                    <td>
                      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                        <select value={m.role_name ?? ''} onChange={(e) => set(m.rentman_name, e.target.value)} aria-label={`Role for ${m.rentman_name}`}>
                          <option value="">Keep Rentman’s name</option>
                          {d.roles.map((r) => <option key={r} value={r}>{r}</option>)}
                        </select>
                        {!m.role_name && m.suggested && <button type="button" className="btn ghost small" onClick={() => set(m.rentman_name, m.suggested!)}>Use {m.suggested}</button>}
                      </div>
                    </td>
                    <td style={{ width: 1, textAlign: 'right' }}>
                      <button type="button" className="btn ghost small danger" title="Remove from this list (it stays hidden even if Rentman sends it again)" aria-label={`Remove ${m.rentman_name} from the list`} onClick={() => remove(m.rentman_name)}>
                        <ActIcon n="trash" /> Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
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

export function AcademySettings() {
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
      flat
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

export type RentmanTab = 'connection' | 'pipeline' | 'roles' | 'crew' | 'back' | 'events';
export const RENTMAN_TABS: [RentmanTab, string][] = [['connection', 'Connection'], ['pipeline', 'Projects & pipeline'], ['roles', 'Role names'], ['crew', 'Crew & rates'], ['back', 'Back to Rentman'], ['events', 'On events']];

/** Integrations › Rentman: one topic per tab. */
export function RentmanSettings({ tab, setTab }: { tab: RentmanTab; setTab: (t: RentmanTab) => void }) {
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
  const tabs = s.connected ? RENTMAN_TABS : RENTMAN_TABS.slice(0, 1);
  const cur = s.connected ? tab : 'connection';
  return (
    <>
      <div className="int-head">
        <div>
          <h2 style={{ margin: 0 }}>Rentman</h2>
          <p className="muted small" style={{ margin: '4px 0 0' }}>Projects, crew needs, quotes and invoices from Rentman; hours and time off back to it.</p>
        </div>
        {s.connected ? <span className="chip open">Connected · {s.projects} project{s.projects === 1 ? '' : 's'}</span> : <span className="chip">Not connected</span>}
      </div>
      <div className="phase-tabs int-tabs" role="tablist" aria-label="Rentman settings">
        {tabs.map(([k2, label]) => (
          <button key={k2} type="button" role="tab" aria-selected={cur === k2} className={cur === k2 ? 'tab on' : 'tab'} onClick={() => setTab(k2)}>{label}</button>
        ))}
      </div>
      {error && <Banner onClose={() => setError('')}>{error}</Banner>}
      {ok && <Banner kind="ok" onClose={() => setOk('')}>{ok}</Banner>}
      <section className="card int-body">
        {cur === 'connection' && (
          <>
            <p className="muted small">
              In Rentman, open Settings → Extensions → API, create an API token with an admin user, and paste it here. LaborOps reads projects, crew needs, quotes and
              invoices with it, and sends back only what you turn on.
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
                  <button type="button" className="btn ghost" disabled={!!busy} onClick={() => confirm('Disconnect Rentman? Linked events keep their last synced details.') && act('clear', 'Rentman disconnected.', () => api('/api/rentman/settings', { method: 'DELETE' }))}>
                    Disconnect
                  </button>
                )}
              </div>
            </form>
            {s.connected && <RentmanOptions section="updates" />}
          </>
        )}
        {cur === 'pipeline' && (
          <>
            <h3>Projects</h3>
            <p className="small">{s.projects} project{s.projects === 1 ? '' : 's'} synced{s.lastSync ? `, last at ${new Date(s.lastSync).toLocaleString()}` : ''}.</p>
            <p className="muted small">Syncing also brings Rentman&apos;s customers into Customers (contact people and addresses are added; nothing you entered is overwritten). Customers you create here can be sent the other way.</p>
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
        {cur === 'roles' && <RoleMap standalone />}
        {cur === 'crew' && <RentmanOptions section="crew" />}
        {cur === 'back' && <RentmanOptions section="back" />}
        {cur === 'events' && <RentmanOptions section="events" />}
      </section>
    </>
  );
}
