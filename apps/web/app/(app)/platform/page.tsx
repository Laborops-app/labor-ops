'use client';
import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Shell from '@/components/Shell';
import { Banner } from '@/components/ui';
import { api, Me } from '@/lib/api';
import { avClass, initialsOf } from '@/components/TopbarAction';
import { Backups, mb, StorageSettings, useStorage } from '@/components/PlatformStorage';

/* The platform side of LaborOps: every company on it, storage and backups, and who runs it. Only platform admins see this. */

type Overview = {
  counts: { companies: number; suspended: number; people: number; active_week: number; upcoming_events: number; new_companies: number };
  files: { bytes: number; count: number };
  storage: { source: string; enabled: boolean };
  lastBackup: { status: string; started_at: string; size: number | null; error: string | null } | null;
  services: { email: boolean; sms: boolean; demo: boolean };
};
type Company = { id: string; name: string; plan: string; created_at: string; suspended_at: string | null; suspended_reason: string | null; people: number; crew: number; admins: string | null; last_active: string | null; events: number; file_bytes: number };
type Admin = { user_id: string; name: string; email: string; company: string; created_at: string; added_by_name: string | null };

const ago = (iso: string | null) => {
  if (!iso) return 'Never';
  const m = (Date.now() - new Date(iso).getTime()) / 60000;
  return m < 60 ? `${Math.max(1, Math.round(m))} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

function Stat({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: 'good' | 'warn' | 'bad' }) {
  return (
    <div className={`pf-stat ${tone ?? ''}`}>
      <span className="muted small">{label}</span>
      <b>{value}</b>
      {sub && <span className="small">{sub}</span>}
    </div>
  );
}

function OverviewTab({ go }: { go: (t: string) => void }) {
  const [o, setO] = useState<Overview | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    api<Overview>('/api/platform/overview').then(setO).catch((e) => setErr(e.message));
  }, []);
  if (!o) return err ? <Banner>{err}</Banner> : <div className="muted">Loading…</div>;
  const backupOld = o.lastBackup ? Date.now() - new Date(o.lastBackup.started_at).getTime() > 36 * 3600_000 : true;
  return (
    <>
      <div className="pf-stats">
        <Stat label="Companies" value={o.counts.companies} sub={`${o.counts.new_companies} new in 30 days${o.counts.suspended ? ` · ${o.counts.suspended} suspended` : ''}`} />
        <Stat label="People" value={o.counts.people} sub={`${o.counts.active_week} active this week`} />
        <Stat label="Upcoming events" value={o.counts.upcoming_events} />
        <Stat label="Uploaded files" value={mb(o.files.bytes)} sub={`${o.files.count} files`} />
      </div>
      <section className="card pf-card">
        <h2>Health</h2>
        <ul className="pf-health">
          <li className={o.storage.enabled ? 'ok' : 'warn'}>
            <b>File storage</b>
            <span>{o.storage.enabled ? (o.storage.source === 'local' ? 'Built-in RustFS' : 'Your S3 server') : 'Off: files are kept in the database'}</span>
            <button className="btn ghost small" onClick={() => go('storage')}>Settings</button>
          </li>
          <li className={o.lastBackup?.status === 'done' && !backupOld ? 'ok' : 'bad'}>
            <b>Backups</b>
            <span>{o.lastBackup ? `${o.lastBackup.status === 'done' ? 'Last backup' : 'Last backup failed'} ${ago(o.lastBackup.started_at)}${o.lastBackup.size ? ` · ${mb(o.lastBackup.size)}` : ''}` : 'No backup yet'}</span>
            <button className="btn ghost small" onClick={() => go('backups')}>Backups</button>
          </li>
          <li className={o.services.email ? 'ok' : 'warn'}>
            <b>Email</b>
            <span>{o.services.email ? 'Sending through Amazon SES' : 'Log-only (no email is sent). Set SES SMTP on the server.'}</span>
          </li>
          <li className={o.services.sms ? 'ok' : 'warn'}>
            <b>Text messages</b>
            <span>{o.services.sms ? 'Connected' : 'Log-only (no texts are sent)'}</span>
          </li>
          {o.services.demo && (
            <li className="warn">
              <b>Demo mode</b>
              <span>The sign-in page shows demo quick-logins (SEED_DEMO=true). Turn this off for real customers.</span>
            </li>
          )}
        </ul>
      </section>
    </>
  );
}

function CompaniesTab({ me }: { me: Me }) {
  const [list, setList] = useState<Company[] | null>(null);
  const [q, setQ] = useState('');
  const [shown, setShown] = useState(100);
  const [err, setErr] = useState('');
  const load = () => api<{ companies: Company[] }>('/api/platform/companies').then((r) => setList(r.companies)).catch((e) => setErr(e.message));
  useEffect(() => {
    load();
  }, []);
  const suspend = async (c: Company, on: boolean) => {
    const reason = on ? prompt(`Suspend ${c.name}? Its people will be signed out of LaborOps until you lift it.\n\nReason (optional):`) : null;
    if (on && reason === null) return;
    try {
      await api(`/api/platform/companies/${c.id}/suspend`, { body: { suspended: on, reason: reason || undefined } });
      load();
    } catch (e: any) {
      setErr(e.message);
    }
  };
  const needle = q.trim().toLowerCase();
  const rows = (list ?? []).filter((c) => !needle || `${c.name} ${c.admins ?? ''}`.toLowerCase().includes(needle));
  return (
    <section className="card pf-card">
      <div className="pf-card-head">
        <h2>Companies {list && <span className="muted">({list.length})</span>}</h2>
        <input className="pf-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or admin email" aria-label="Search companies" />
      </div>
      {err && <Banner onClose={() => setErr('')}>{err}</Banner>}
      {!list ? (
        <div className="muted">Loading…</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Company</th><th>Admins</th><th>People</th><th>Events</th><th>Files</th><th>Last active</th><th /></tr></thead>
            <tbody>
              {rows.slice(0, shown).map((c) => (
                <tr key={c.id} className={c.suspended_at ? 'inactive' : ''}>
                  <td>
                    <span className="pf-co">
                      <span className={avClass(c.name)} aria-hidden="true" style={{ width: 34, height: 34, fontSize: 12 }}>{initialsOf(c.name)}</span>
                      <span>
                        <b>{c.name}</b>
                        <span className="muted small">Since {new Date(c.created_at).toLocaleDateString()} · {c.plan}</span>
                        {c.suspended_at && <span className="chip bad" title={c.suspended_reason ?? ''}>Suspended{c.suspended_reason ? `: ${c.suspended_reason}` : ''}</span>}
                      </span>
                    </span>
                  </td>
                  <td className="small" style={{ maxWidth: 240, overflowWrap: 'anywhere' }}>{c.admins ?? '—'}</td>
                  <td>{c.people}<span className="muted small"> ({c.crew} crew)</span></td>
                  <td>{c.events}</td>
                  <td>{mb(c.file_bytes)}</td>
                  <td className="small">{ago(c.last_active)}</td>
                  <td>
                    {c.suspended_at ? (
                      <button className="btn small" onClick={() => suspend(c, false)}>Lift suspension</button>
                    ) : (
                      <button className="btn ghost small danger" onClick={() => suspend(c, true)}>Suspend</button>
                    )}
                  </td>
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={7} className="muted small">No companies match.</td></tr>}
            </tbody>
          </table>
          {rows.length > shown && <button className="btn small" style={{ margin: '10px auto', display: 'block' }} onClick={() => setShown(shown + 100)}>Show more ({rows.length - shown} left)</button>}
        </div>
      )}
    </section>
  );
}

function AdminsTab({ me }: { me: Me }) {
  const [d, setD] = useState<{ admins: Admin[]; fromEnv: string[] } | null>(null);
  const [email, setEmail] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const load = () => api<{ admins: Admin[]; fromEnv: string[] }>('/api/platform/admins').then(setD).catch((e) => setMsg({ kind: 'error', text: e.message }));
  useEffect(() => {
    load();
  }, []);
  return (
    <section className="card pf-card">
      <h2>Platform admins</h2>
      <p className="muted small">They can see every company, suspend accounts, and change storage and backups. They must already be an admin of a company on LaborOps.</p>
      {msg && <Banner kind={msg.kind} onClose={() => setMsg(null)}>{msg.text}</Banner>}
      <form className="row" onSubmit={async (e) => {
        e.preventDefault();
        try {
          await api('/api/platform/admins', { body: { email } });
          setMsg({ kind: 'ok', text: `${email} is now a platform admin.` });
          setEmail('');
          load();
        } catch (x: any) {
          setMsg({ kind: 'error', text: x.message });
        }
      }}>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Their email address" required style={{ flex: 1, minWidth: 220 }} />
        <button className="btn primary">Add platform admin</button>
      </form>
      <ul className="pf-admins">
        {d?.admins.map((a) => (
          <li key={a.user_id}>
            <span className={avClass(a.name)} aria-hidden="true" style={{ width: 38, height: 38, fontSize: 13 }}>{initialsOf(a.name)}</span>
            <span className="pf-admin-main">
              <b>{a.name}{a.user_id === me.id && <span className="muted"> (you)</span>}</b>
              <span className="muted small">{a.email} · {a.company} · added {new Date(a.created_at).toLocaleDateString()}{a.added_by_name ? ` by ${a.added_by_name}` : ''}</span>
            </span>
            {a.user_id !== me.id && (
              <button className="btn ghost small" onClick={() => confirm(`Remove ${a.name} as a platform admin?`) && api(`/api/platform/admins/${a.user_id}`, { method: 'DELETE' }).then(load).catch((x) => setMsg({ kind: 'error', text: x.message }))}>Remove</button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

const TABS = [['overview', 'Overview'], ['companies', 'Companies'], ['storage', 'Storage'], ['backups', 'Backups'], ['admins', 'Admins']] as const;

function Body({ me }: { me: Me }) {
  const router = useRouter();
  const params = useSearchParams();
  const tab = (params.get('tab') as (typeof TABS)[number][0]) || 'overview';
  const go = (t: string) => router.replace(`/platform?tab=${t}`);
  const storage = useStorage();
  if (!me.platformAdmin) return <Banner>Only platform admins can open this page.</Banner>;
  return (
    <div className="pf">
      <h1>Platform</h1>
      <p className="muted" style={{ marginTop: -6 }}>Everything about running LaborOps itself. Company admins do not see this.</p>
      <div className="phase-tabs pf-tabs" role="tablist" aria-label="Platform">
        {TABS.map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'tab on' : 'tab'} onClick={() => go(k)}>{l}</button>
        ))}
      </div>
      {tab === 'overview' && <OverviewTab go={go} />}
      {tab === 'companies' && <CompaniesTab me={me} />}
      {(tab === 'storage' || tab === 'backups') && (storage.d ? (tab === 'storage' ? <StorageSettings key={JSON.stringify(storage.d.settings)} d={storage.d} reload={storage.load} /> : <Backups key={JSON.stringify(storage.d.settings.backups)} d={storage.d} reload={storage.load} />) : storage.err ? <Banner>{storage.err}</Banner> : <div className="muted">Loading…</div>)}
      {tab === 'admins' && <AdminsTab me={me} />}
    </div>
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
