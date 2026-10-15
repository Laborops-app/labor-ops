import { spawn } from 'node:child_process';
import { Upload } from '@aws-sdk/lib-storage';
import { CopyObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { config } from './config';
import {
  adminPool, bucketOf, client, deleteObject, ensureBuckets, getObject, listObjects, moveFilesToStorage, storageEnabled, sweepOrphans,
  type BucketKind,
} from './storage';

/**
 * Database and file backups into the backups bucket:
 *   postgres/YYYY/MM/laborops-<time>.dump   pg_dump (custom format, compressed) of the whole database, every night
 *   files/chat/..., files/documents/...      a copy of every uploaded file (added nightly, kept 30 days after the original is gone)
 * Old database backups are thinned out: every night for BACKUP_KEEP_DAILY days, then one a week, then one a month.
 */
const B = config.backups;
const LOCK = 727274002;

const stamp = (d = new Date()) => d.toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z');

export async function runBackup(kind: 'scheduled' | 'manual' = 'scheduled') {
  if (!storageEnabled()) throw new Error('Object storage is not configured (S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY).');
  const db = adminPool();
  const now = new Date();
  const key = `postgres/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/laborops-${stamp(now)}.dump`;
  const row = (await db.query('INSERT INTO platform_backups (bucket, key, kind) VALUES ($1,$2,$3) RETURNING id', [bucketOf('backups'), key, kind])).rows[0];
  try {
    const size = await dumpTo(key);
    await db.query("UPDATE platform_backups SET status = 'done', size = $2, finished_at = now() WHERE id = $1", [row.id, size]);
    console.log(`backup: saved ${key} (${size} bytes)`);
    return { id: row.id as string, key, size };
  } catch (e: any) {
    await db.query("UPDATE platform_backups SET status = 'failed', error = $2, finished_at = now() WHERE id = $1", [row.id, String(e?.message ?? e).slice(0, 2000)]);
    await deleteObject('backups', key);
    throw e;
  }
}

/** Stream pg_dump straight into the bucket (multipart, nothing written to the container's disk). */
function dumpTo(key: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const p = spawn(B.pgDump, ['--format=custom', '--compress=6', '--no-owner', `--dbname=${config.adminDatabaseUrl}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    let size = 0;
    let exited: number | null = null;
    let uploaded = false;
    const finish = () => {
      if (exited === null || !uploaded) return;
      if (exited !== 0) reject(new Error(`pg_dump failed (${exited}): ${err.trim().slice(0, 1500)}`));
      else if (!size) reject(new Error('pg_dump produced no output'));
      else resolve(size);
    };
    p.stderr.on('data', (d) => (err += d));
    p.stdout.on('data', (d: Buffer) => (size += d.length));
    p.on('error', (e) => reject(new Error(`Could not run ${B.pgDump}: ${e.message}`)));
    p.on('close', (code) => {
      exited = code ?? 1;
      finish();
    });
    new Upload({ client: client('backups'), params: { Bucket: bucketOf('backups'), Key: key, Body: p.stdout, ContentType: 'application/octet-stream' }, queueSize: 2, partSize: 8 * 1024 * 1024 })
      .done()
      .then(() => {
        uploaded = true;
        finish();
      })
      .catch((e) => {
        p.kill();
        reject(e);
      });
  });
}

/** Which finished backups to keep: the last N days, then one per week, then one per month. */
export function backupsToDelete(rows: { id: string; started_at: Date }[], now = new Date(), keep = { daily: B.keepDaily, weekly: B.keepWeekly, monthly: B.keepMonthly }) {
  const keepIds = new Set<string>();
  const sorted = [...rows].sort((a, b) => b.started_at.getTime() - a.started_at.getTime());
  const day = 86400000;
  const seenWeek = new Set<string>(), seenMonth = new Set<string>();
  for (const r of sorted) {
    const age = (now.getTime() - r.started_at.getTime()) / day;
    const d = r.started_at;
    const week = `${d.getUTCFullYear()}-${Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / day + 3) / 7)}`;
    const month = `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
    if (age < keep.daily) keepIds.add(r.id);
    else if (age < keep.weekly * 7 && !seenWeek.has(week)) keepIds.add(r.id);
    else if (age < keep.monthly * 31 && !seenMonth.has(month)) keepIds.add(r.id);
    seenWeek.add(week);
    seenMonth.add(month);
  }
  // Never delete the newest good backup, whatever the settings say.
  if (sorted[0]) keepIds.add(sorted[0].id);
  return sorted.filter((r) => !keepIds.has(r.id));
}

export async function pruneBackups() {
  const db = adminPool();
  const rows = (await db.query("SELECT id, key, started_at FROM platform_backups WHERE status = 'done' ORDER BY started_at DESC")).rows;
  const drop = backupsToDelete(rows);
  for (const r of drop as any[]) {
    await deleteObject('backups', r.key);
    await db.query("UPDATE platform_backups SET status = 'deleted' WHERE id = $1", [r.id]);
  }
  await db.query("DELETE FROM platform_backups WHERE status IN ('failed', 'deleted') AND started_at < now() - interval '180 days'");
  return drop.length;
}

/** Copy uploaded files into the backups bucket (only new ones), and drop copies whose original has been gone 30 days. */
export async function mirrorUploads() {
  let copied = 0, removed = 0;
  for (const kind of ['chat', 'documents'] as BucketKind[]) {
    const prefix = `files/${kind}/`;
    const have = new Map<string, Date>();
    for await (const o of listObjects('backups', prefix)) have.set(o.key.slice(prefix.length), o.modified);
    const live = new Set<string>();
    for await (const o of listObjects(kind)) {
      live.add(o.key);
      if (have.has(o.key)) continue;
      const sameServer = !config.storage.backupEndpoint;
      if (sameServer) {
        await client('backups').send(new CopyObjectCommand({ Bucket: bucketOf('backups'), Key: prefix + o.key, CopySource: `${bucketOf(kind)}/${encodeURIComponent(o.key).replace(/%2F/g, '/')}` }));
      } else {
        const head = await client(kind).send(new HeadObjectCommand({ Bucket: bucketOf(kind), Key: o.key }));
        await new Upload({ client: client('backups'), params: { Bucket: bucketOf('backups'), Key: prefix + o.key, Body: await getObject(kind, o.key), ContentType: head.ContentType } }).done();
      }
      copied++;
    }
    for (const [k, modified] of have) {
      if (!live.has(k) && Date.now() - modified.getTime() > 30 * 86400000) {
        await deleteObject('backups', prefix + k);
        removed++;
      }
    }
  }
  return { copied, removed };
}

/** Everything the nightly job does, in order. Each step is independent so one failure does not stop the others. */
export async function nightly(kind: 'scheduled' | 'manual' = 'scheduled') {
  const out: Record<string, unknown> = {};
  const step = async (name: string, fn: () => Promise<unknown>) => {
    try {
      out[name] = await fn();
    } catch (e: any) {
      out[name] = { error: String(e?.message ?? e) };
      console.error(`backup: ${name} failed:`, e?.message ?? e);
    }
  };
  await step('moved', () => moveFilesToStorage());
  await step('database', () => runBackup(kind));
  await step('files', () => mirrorUploads());
  await step('pruned', () => pruneBackups());
  await step('orphans', () => sweepOrphans());
  return out;
}

/** One server at a time runs the job (advisory lock), once a day after BACKUP_HOUR_UTC. */
export async function maybeRunNightly(now = new Date()) {
  if (!B.enabled || !storageEnabled() || now.getUTCHours() < B.hourUtc) return null;
  const db = adminPool();
  const c = await db.connect();
  try {
    if (!(await c.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK])).rows[0].ok) return null;
    try {
      const today = (await c.query(
        "SELECT 1 FROM platform_backups WHERE kind = 'scheduled' AND status IN ('done', 'running') AND started_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AND (status = 'done' OR started_at > now() - interval '2 hours')",
      )).rowCount;
      if (today) return null;
      return await nightly('scheduled');
    } finally {
      await c.query('SELECT pg_advisory_unlock($1)', [LOCK]);
    }
  } finally {
    c.release();
  }
}

export function startStorageJobs() {
  if (!storageEnabled()) {
    console.log('storage: S3 not configured, files stay in Postgres and backups are off');
    return;
  }
  // RustFS may still be starting: keep trying to create the buckets (up to ~10 minutes), then move old files over.
  const setup = async (attempt = 1): Promise<void> => {
    try {
      await ensureBuckets();
      const n = await moveFilesToStorage();
      console.log(`storage: buckets ready${n ? `, moved ${n} files from Postgres` : ''}`);
    } catch (e: any) {
      if (attempt >= 60) return console.error('storage: could not reach object storage:', e?.message ?? e);
      setTimeout(() => setup(attempt + 1), 10_000).unref();
    }
  };
  setup();
  const tick = () => maybeRunNightly().catch((e) => console.error('backup: nightly job failed:', e?.message ?? e));
  setTimeout(tick, 60_000).unref();
  setInterval(tick, 15 * 60_000).unref();
}

