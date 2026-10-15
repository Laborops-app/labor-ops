'use client';
import { useEffect, useState } from 'react';
import { Banner } from '@/components/ui';
import { api } from '@/lib/api';

type Target = { endpoint: string; region: string; accessKey: string; forcePathStyle: boolean; hasSecret: boolean } | null;
type Counts = { inStorage: number; inDatabase: number; bytes: number };
export type StorageData = {
  storage: {
    enabled: boolean; source: 'off' | 'local' | 'custom' | 'env'; endpoint: string | null; backupEndpoint: string | null; separateBackups: boolean;
    reachable?: boolean; error?: string; backupReachable?: boolean; backupError?: string;
    buckets: { chat: string; documents: string; backups: string }; cert_files: Counts; chat_attachments: Counts;
  };
  settings: { mode: 'auto' | 'local' | 'custom' | 'off'; custom: Target; buckets: { chat: string; documents: string; backups: string }; backupMode: 'same' | 'custom'; backupCustom: Target; backups: Policy };
  localAvailable: boolean;
  backups: { id: string; key: string | null; size: number | null; kind: string; status: string; error: string | null; started_at: string; finished_at: string | null }[];
  schedule: Policy;
  running: boolean;
  lastRun: { at: string; result: any } | null;
  job: { state: 'running' | 'done' | 'failed'; copied: number; total: number; missing: number; error?: string } | null;
};
type Policy = { enabled: boolean; hourUtc: number; keepDaily: number; keepWeekly: number; keepMonthly: number };

export const mb = (n: number | null | undefined) => (n == null || n === 0 ? '—' : n >= 1073741824 ? `${(n / 1073741824).toFixed(2)} GB` : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const hourLabel = (h: number) => {
  const d = new Date();
  d.setUTCHours(h, 0, 0, 0);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
};
const SOURCE: Record<string, string> = { local: 'Built-in RustFS on this server', custom: 'Your S3 server', env: 'S3 server from the server settings (.env)', off: 'Off: files are kept in the database' };

export function useStorage() {
  const [d, setD] = useState<StorageData | null>(null);
  const [err, setErr] = useState('');
  const load = () => api<StorageData>('/api/platform/storage').then(setD).catch((e) => setErr(e.message));
  useEffect(() => {
    load();
  }, []);
  useEffect(() => {
    if (!d?.running && d?.job?.state !== 'running') return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [d?.running, d?.job?.state]);
  return { d, err, setErr, load };
}

/* ---------- where files are stored ---------- */
type TargetForm = { endpoint: string; region: string; accessKey: string; secretKey: string; forcePathStyle: boolean };
const blankTarget = (t: Target): TargetForm => ({ endpoint: t?.endpoint ?? '', region: t?.region ?? 'us-east-1', accessKey: t?.accessKey ?? '', secretKey: '', forcePathStyle: t?.forcePathStyle ?? true });

function TargetFields({ v, onChange, saved, label }: { v: TargetForm; onChange: (v: TargetForm) => void; saved: boolean; label: string }) {
  return (
    <div className="pf-target" role="group" aria-label={label}>
      <label className="pf-wide">
        Endpoint URL
        <input value={v.endpoint} onChange={(e) => onChange({ ...v, endpoint: e.target.value })} placeholder="https://s3.us-west-2.amazonaws.com or http://10.0.0.5:9000" required />
      </label>
      <label>
        Region
        <input value={v.region} onChange={(e) => onChange({ ...v, region: e.target.value })} placeholder="us-east-1" />
      </label>
      <label>
        Access key
        <input value={v.accessKey} onChange={(e) => onChange({ ...v, accessKey: e.target.value })} autoComplete="off" required />
      </label>
      <label>
        Secret key
        <input type="password" value={v.secretKey} onChange={(e) => onChange({ ...v, secretKey: e.target.value })} autoComplete="new-password" placeholder={saved ? '•••••••• (saved, leave blank to keep)' : ''} required={!saved} />
      </label>
      <label className="check pf-wide">
        <input type="checkbox" checked={v.forcePathStyle} onChange={(e) => onChange({ ...v, forcePathStyle: e.target.checked })} /> Path-style addresses (on for RustFS and MinIO, off for AWS S3)
      </label>
    </div>
  );
}

export function StorageSettings({ d, reload }: { d: StorageData; reload: () => void }) {
  const s = d.settings;
  const [mode, setMode] = useState(s.mode);
  const [custom, setCustom] = useState(blankTarget(s.custom));
  const [buckets, setBuckets] = useState(s.buckets);
  const [backupMode, setBackupMode] = useState(s.backupMode);
  const [backupCustom, setBackupCustom] = useState(blankTarget(s.backupCustom));
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error' | 'info'; text: string } | null>(null);
  const [busy, setBusy] = useState('');
  const body = () => ({
    mode, custom: mode === 'custom' ? custom : null, buckets, backupMode, backupCustom: backupMode === 'custom' ? backupCustom : null,
  });
  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setMsg(null);
    try {
      await fn();
    } catch (e: any) {
      setMsg({ kind: 'error', text: e.message });
    } finally {
      setBusy('');
    }
  };
  const st = d.storage;
  return (
    <section className="card pf-card">
      <div className="pf-card-head">
        <div>
          <h2>Where files are stored</h2>
          <p className="muted small">Chat files, certificates and documents, and backups each get their own private bucket. Nobody can open a file without signing in to LaborOps.</p>
        </div>
        <span className={`chip ${st.enabled && st.reachable ? 'open' : st.enabled ? 'bad' : ''}`}>{st.enabled ? (st.reachable ? 'Connected' : 'Not reachable') : 'Off'}</span>
      </div>
      <p className="small"><b>Now using:</b> {SOURCE[st.source]}{st.endpoint && st.source !== 'local' ? ` · ${st.endpoint}` : ''}</p>
      {st.enabled && !st.reachable && <Banner>Cannot reach the storage server: {st.error}</Banner>}
      {d.job?.state === 'running' && <Banner kind="info">Copying files to the new storage: {d.job.copied} of {d.job.total}. The switch happens when this finishes.</Banner>}
      {d.job?.state === 'failed' && <Banner>Copying files failed, nothing was switched: {d.job.error}</Banner>}
      {d.job?.state === 'done' && d.job.missing > 0 && <Banner kind="info">Switched. {d.job.missing} file{d.job.missing === 1 ? ' was' : 's were'} already missing on the old storage and could not be copied.</Banner>}
      {msg && <Banner kind={msg.kind} onClose={() => setMsg(null)}>{msg.text}</Banner>}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          run('save', async () => {
            const r = await api<{ copying?: boolean; total?: number }>('/api/platform/storage', { method: 'PUT', body: body() });
            setMsg({ kind: 'ok', text: r.copying ? `Saved. Copying ${r.total} files to the new storage first; it switches over when done.` : 'Storage settings saved.' });
            reload();
          });
        }}
      >
        <div className="pf-options" role="radiogroup" aria-label="Storage">
          {([
            ['auto', 'Automatic', d.localAvailable ? 'Uses the RustFS that runs next to LaborOps. Nothing to set up.' : 'Uses the S3 settings from the server, if any.'],
            ['custom', 'My own S3 server', 'RustFS on another machine, MinIO, AWS S3, Backblaze B2, Wasabi…'],
            ['off', 'Off', 'Keep files in the database (not recommended once you have many files).'],
          ] as const).map(([k, t, sub]) => (
            <label key={k} className={`pf-option ${mode === k ? 'on' : ''}`}>
              <input type="radio" name="mode" checked={mode === k} onChange={() => setMode(k)} />
              <span><b>{t}</b><span className="muted small">{sub}</span></span>
            </label>
          ))}
        </div>
        {mode === 'custom' && <TargetFields v={custom} onChange={setCustom} saved={!!s.custom?.hasSecret} label="Storage server" />}

        {mode !== 'off' && (
          <>
            <h3>Bucket names</h3>
            <div className="pf-target">
              {(['chat', 'documents', 'backups'] as const).map((k) => (
                <label key={k}>
                  {k === 'chat' ? 'Chat files' : k === 'documents' ? 'Certificates & documents' : 'Backups'}
                  <input value={buckets[k]} onChange={(e) => setBuckets({ ...buckets, [k]: e.target.value.toLowerCase() })} pattern="[a-z0-9][a-z0-9.\-]{1,61}[a-z0-9]" title="3-63 lowercase letters, numbers, dots and dashes" required />
                </label>
              ))}
            </div>

            <h3>Backup location</h3>
            <div className="pf-options" role="radiogroup" aria-label="Backup location">
              <label className={`pf-option ${backupMode === 'same' ? 'on' : ''}`}>
                <input type="radio" name="bmode" checked={backupMode === 'same'} onChange={() => setBackupMode('same')} />
                <span><b>Same storage</b><span className="muted small">Simple, but backups are lost too if this server is lost.</span></span>
              </label>
              <label className={`pf-option ${backupMode === 'custom' ? 'on' : ''}`}>
                <input type="radio" name="bmode" checked={backupMode === 'custom'} onChange={() => setBackupMode('custom')} />
                <span><b>A separate S3 server</b><span className="muted small">Recommended: keeps backups safe somewhere else.</span></span>
              </label>
            </div>
            {backupMode === 'custom' && <TargetFields v={backupCustom} onChange={setBackupCustom} saved={!!s.backupCustom?.hasSecret} label="Backup server" />}
          </>
        )}

        <div className="row" style={{ marginTop: 14 }}>
          <button type="button" className="btn" disabled={!!busy} onClick={() => run('test', async () => {
            const r = await api<{ ok: boolean; storage?: string; backups?: string }>('/api/platform/storage/test', { body: body() });
            setMsg(r.ok ? { kind: 'ok', text: 'Connection works and the buckets are ready.' } : { kind: 'error', text: [r.storage !== 'ok' && r.storage ? `Storage: ${r.storage}` : '', r.backups && r.backups !== 'ok' ? `Backups: ${r.backups}` : ''].filter(Boolean).join(' · ') });
          })}>{busy === 'test' ? 'Testing…' : 'Test connection'}</button>
          <button className="btn primary" disabled={!!busy || d.job?.state === 'running'}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
        </div>
        <p className="muted small" style={{ marginTop: 8 }}>Switching to another server or other bucket names copies every file over first, then switches; nothing is deleted from the old storage.</p>
      </form>

      {st.enabled && (
        <div className="table-wrap" style={{ marginTop: 16 }}>
          <table>
            <thead><tr><th>Files</th><th>Bucket</th><th>In storage</th><th>Still in database</th><th>Size</th></tr></thead>
            <tbody>
              <tr><td>Chat photos and files</td><td><code>{st.buckets.chat}</code></td><td>{st.chat_attachments.inStorage}</td><td>{st.chat_attachments.inDatabase}</td><td>{mb(st.chat_attachments.bytes)}</td></tr>
              <tr><td>Certificates and documents</td><td><code>{st.buckets.documents}</code></td><td>{st.cert_files.inStorage}</td><td>{st.cert_files.inDatabase}</td><td>{mb(st.cert_files.bytes)}</td></tr>
            </tbody>
          </table>
        </div>
      )}
      {st.enabled && st.cert_files.inDatabase + st.chat_attachments.inDatabase > 0 && (
        <div className="row" style={{ marginTop: 8 }}>
          <span className="small">Some older files are still in the database (they move automatically each night).</span>
          <button className="btn small" disabled={!!busy} onClick={() => run('move', async () => {
            const r = await api<{ moved: number }>('/api/platform/storage/move', { body: {} });
            setMsg({ kind: 'ok', text: `Moved ${r.moved} files.` });
            reload();
          })}>Move now</button>
        </div>
      )}
    </section>
  );
}

/* ---------- backups ---------- */
export function Backups({ d, reload }: { d: StorageData; reload: () => void }) {
  const [p, setP] = useState(d.settings.backups);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const st = d.storage;
  const lastGood = d.backups.find((b) => b.status === 'done');
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const s = d.settings;
      await api('/api/platform/storage', {
        method: 'PUT',
        body: { mode: s.mode, custom: s.mode === 'custom' && s.custom ? { ...s.custom, secretKey: '' } : null, buckets: s.buckets, backupMode: s.backupMode, backupCustom: s.backupMode === 'custom' && s.backupCustom ? { ...s.backupCustom, secretKey: '' } : null, backups: p },
      });
      setMsg({ kind: 'ok', text: 'Backup schedule saved.' });
      reload();
    } catch (x: any) {
      setMsg({ kind: 'error', text: x.message });
    }
  };
  return (
    <>
      <section className="card pf-card">
        <div className="pf-card-head">
          <div>
            <h2>Backups</h2>
            <p className="muted small">A full database backup plus a copy of every uploaded file, into the <code>{st.buckets.backups}</code> bucket{st.separateBackups ? ` on ${st.backupEndpoint}` : ''}.</p>
          </div>
          <span className={`chip ${lastGood ? 'open' : ''}`}>{lastGood ? `Last backup ${new Date(lastGood.started_at).toLocaleDateString()}` : 'No backup yet'}</span>
        </div>
        {!st.enabled && <Banner kind="info">Turn on storage above to get automatic backups.</Banner>}
        {st.enabled && st.backupReachable === false && <Banner>Cannot reach the backup storage: {st.backupError}</Banner>}
        {msg && <Banner kind={msg.kind} onClose={() => setMsg(null)}>{msg.text}</Banner>}
        <form onSubmit={save} className="pf-target">
          <label className="check pf-wide">
            <input type="checkbox" checked={p.enabled} onChange={(e) => setP({ ...p, enabled: e.target.checked })} /> Back up every night
          </label>
          <label>
            Time
            <select value={p.hourUtc} onChange={(e) => setP({ ...p, hourUtc: Number(e.target.value) })}>
              {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
            </select>
          </label>
          <label>Keep every night for (days)<input type="number" min={1} max={90} value={p.keepDaily} onChange={(e) => setP({ ...p, keepDaily: Number(e.target.value) })} /></label>
          <label>Then one a week for (weeks)<input type="number" min={0} max={52} value={p.keepWeekly} onChange={(e) => setP({ ...p, keepWeekly: Number(e.target.value) })} /></label>
          <label>Then one a month for (months)<input type="number" min={0} max={60} value={p.keepMonthly} onChange={(e) => setP({ ...p, keepMonthly: Number(e.target.value) })} /></label>
          <div className="row pf-wide">
            <button className="btn">Save schedule</button>
            <button type="button" className="btn primary" disabled={d.running || !st.enabled} onClick={() => api('/api/platform/backups', { body: {} }).then(() => { setMsg({ kind: 'ok', text: 'Backup started. This list updates when it finishes.' }); reload(); }).catch((x) => setMsg({ kind: 'error', text: x.message }))}>
              {d.running ? 'Backing up…' : 'Back up now'}
            </button>
          </div>
        </form>
        <div className="table-wrap" style={{ marginTop: 12 }}>
          <table>
            <thead><tr><th>Started</th><th>Type</th><th>Status</th><th>Size</th><th /></tr></thead>
            <tbody>
              {d.backups.filter((b) => b.status !== 'deleted').slice(0, 30).map((b) => (
                <tr key={b.id}>
                  <td>{new Date(b.started_at).toLocaleString()}</td>
                  <td className="small">{b.kind === 'manual' ? 'Manual' : 'Nightly'}</td>
                  <td>{b.status === 'done' ? <span className="chip open">Done</span> : b.status === 'running' ? <span className="chip">Running</span> : <span className="chip bad">Failed</span>}{b.error && <div className="muted small">{b.error.slice(0, 160)}</div>}</td>
                  <td>{mb(b.size)}</td>
                  <td>{b.status === 'done' && <a className="btn ghost small" href={`/api/platform/backups/${b.id}/download`}>Download</a>}</td>
                </tr>
              ))}
              {!d.backups.length && <tr><td colSpan={5} className="muted small">No backups yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card pf-card">
        <h2>Restoring</h2>
        <p className="small">Restoring replaces live data, so it is done on the server rather than from this page:</p>
        <pre className="pf-pre">{`docker compose exec api node dist/restore.js list
docker compose exec api node dist/restore.js database latest
docker compose exec api node dist/restore.js files
docker compose restart api`}</pre>
      </section>
    </>
  );
}
