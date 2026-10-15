'use client';
import { useEffect, useState } from 'react';
import Panel from '@/components/Panel';
import { Banner } from '@/components/ui';
import { api } from '@/lib/api';

type Counts = { inStorage: number; inDatabase: number; bytes: number };
type Status = {
  storage: { enabled: boolean; endpoint: string | null; backupEndpoint: string | null; reachable?: boolean; error?: string; buckets: { chat: string; documents: string; backups: string }; cert_files: Counts; chat_attachments: Counts };
  backups: { id: string; key: string | null; size: number | null; kind: string; status: string; error: string | null; started_at: string; finished_at: string | null }[];
  schedule: { enabled: boolean; hourUtc: number; keepDaily: number; keepWeekly: number; keepMonthly: number };
  running: boolean;
  lastRun: { at: string; result: any } | null;
};
const mb = (n: number | null) => (n == null ? '—' : n >= 1073741824 ? `${(n / 1073741824).toFixed(2)} GB` : `${(n / 1048576).toFixed(1)} MB`);
const localHour = (h: number) => {
  const d = new Date();
  d.setUTCHours(h, 0, 0, 0);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
};

/** Platform operators only: where uploads live, whether the S3 server answers, and the nightly backups. */
export default function StoragePanel() {
  const [s, setS] = useState<Status | null>(null);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const load = () => api<Status>('/api/platform/storage').then(setS).catch((e) => setErr(e.message));
  useEffect(() => {
    load();
  }, []);
  useEffect(() => {
    if (!s?.running) return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [s?.running]);
  if (!s) return err ? <Banner>{err}</Banner> : null;
  const st = s.storage;
  const lastGood = s.backups.find((b) => b.status === 'done');
  const unmoved = st.cert_files.inDatabase + st.chat_attachments.inDatabase;
  const status = !st.enabled ? <span className="chip">Not set up</span> : st.reachable ? <span className="chip open">Connected{lastGood ? ` · backed up ${new Date(lastGood.started_at).toLocaleDateString()}` : ''}</span> : <span className="chip bad">Not reachable</span>;
  return (
    <Panel id="storage" title="Storage & backups" summary="Uploads in RustFS (S3) buckets and nightly backups" status={status}>
      {err && <Banner onClose={() => setErr('')}>{err}</Banner>}
      {ok && <Banner kind="ok" onClose={() => setOk('')}>{ok}</Banner>}
      {!st.enabled ? (
        <p className="muted small">
          Object storage is not set up on the server, so uploads are kept in the database and there are no automatic backups. Set <code>COMPOSE_PROFILES=storage</code>, <code>S3_ACCESS_KEY</code> and <code>S3_SECRET_KEY</code> in the server's <code>.env</code> and redeploy.
        </p>
      ) : (
        <>
          {!st.reachable && <Banner>Cannot reach the storage server: {st.error}</Banner>}
          <div className="table-wrap">
            <table>
              <thead><tr><th>What</th><th>Bucket</th><th>Files in storage</th><th>Still in database</th><th>Size</th></tr></thead>
              <tbody>
                <tr><td>Chat photos and files</td><td><code>{st.buckets.chat}</code></td><td>{st.chat_attachments.inStorage}</td><td>{st.chat_attachments.inDatabase}</td><td>{mb(st.chat_attachments.bytes)}</td></tr>
                <tr><td>Certificates and documents</td><td><code>{st.buckets.documents}</code></td><td>{st.cert_files.inStorage}</td><td>{st.cert_files.inDatabase}</td><td>{mb(st.cert_files.bytes)}</td></tr>
                <tr><td>Database backups and file copies</td><td><code>{st.buckets.backups}</code></td><td colSpan={3} className="muted small">{st.backupEndpoint !== st.endpoint ? `On a separate server: ${st.backupEndpoint}` : 'On the same storage server'}</td></tr>
              </tbody>
            </table>
          </div>
          {unmoved > 0 && (
            <div className="row" style={{ marginTop: 8 }}>
              <span className="small">{unmoved} older file{unmoved === 1 ? ' is' : 's are'} still in the database (moved automatically at night).</span>
              <button className="btn small" onClick={() => api<{ moved: number }>('/api/platform/storage/move', { body: {} }).then((r) => { setOk(`Moved ${r.moved} files.`); load(); }).catch((e) => setErr(e.message))}>Move now</button>
            </div>
          )}

          <h3 style={{ marginTop: 18 }}>Backups</h3>
          <p className="muted small">
            {s.schedule.enabled ? `Every night after ${localHour(s.schedule.hourUtc)}: ` : 'Nightly backups are turned off. '}a full database backup, plus a copy of every uploaded file. Kept: every night for {s.schedule.keepDaily} days, then one a week for {s.schedule.keepWeekly} weeks, then one a month for {s.schedule.keepMonthly} months.
          </p>
          <div className="row">
            <button className="btn primary" disabled={s.running} onClick={() => api('/api/platform/backups', { body: {} }).then(() => { setOk('Backup started. This page updates when it finishes.'); load(); }).catch((e) => setErr(e.message))}>
              {s.running ? 'Backing up…' : 'Back up now'}
            </button>
            {s.lastRun?.result?.database?.error && <span className="small" style={{ color: 'var(--bad)' }}>Last run failed: {s.lastRun.result.database.error}</span>}
          </div>
          <div className="table-wrap" style={{ marginTop: 10 }}>
            <table>
              <thead><tr><th>Started</th><th>Type</th><th>Status</th><th>Size</th><th /></tr></thead>
              <tbody>
                {s.backups.filter((b) => b.status !== 'deleted').slice(0, 20).map((b) => (
                  <tr key={b.id}>
                    <td>{new Date(b.started_at).toLocaleString()}</td>
                    <td className="small">{b.kind === 'manual' ? 'Manual' : 'Nightly'}</td>
                    <td>{b.status === 'done' ? <span className="chip open">Done</span> : b.status === 'running' ? <span className="chip">Running</span> : <span className="chip bad" title={b.error ?? ''}>Failed</span>}{b.error && <div className="muted small">{b.error.slice(0, 160)}</div>}</td>
                    <td>{mb(b.size)}</td>
                    <td>{b.status === 'done' && <a className="btn ghost small" href={`/api/platform/backups/${b.id}/download`}>Download</a>}</td>
                  </tr>
                ))}
                {!s.backups.length && <tr><td colSpan={5} className="muted small">No backups yet.</td></tr>}
              </tbody>
            </table>
          </div>
          <p className="muted small" style={{ marginTop: 8 }}>
            To restore, on the server: <code>docker compose exec api node dist/restore.js list</code>, then <code>… restore.js database latest</code> and <code>… restore.js files</code>.
          </p>
        </>
      )}
    </Panel>
  );
}
