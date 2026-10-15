import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { Pool } from 'pg';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { config } from './config';
import { decrypt, encrypt } from './crypto';

/**
 * S3-compatible object storage (RustFS by default). Each kind of file has its own bucket:
 *   chat       – photos and files sent in chat
 *   documents  – certificate scans and academy certificate PDFs
 *   backups    – nightly database backups (may live on another S3 server, see BACKUP_S3_*)
 * Objects are private; the API checks who may see a file and streams it, so no bucket is ever public.
 * When storage is not configured, files stay in Postgres as before.
 */
export type BucketKind = 'chat' | 'documents' | 'backups';
export type S3Target = { endpoint: string; region: string; accessKey: string; secretKey: string; forcePathStyle: boolean };
export type Buckets = { chat: string; documents: string; backups: string };
export type BackupPolicy = { enabled: boolean; hourUtc: number; keepDaily: number; keepWeekly: number; keepMonthly: number };
/** What is saved on the Platform page (secrets encrypted in platform_settings). */
export type SavedStorage = {
  mode: 'auto' | 'local' | 'custom' | 'off';
  custom?: S3Target | null;
  buckets?: Partial<Buckets>;
  backupMode?: 'same' | 'custom';
  backupCustom?: S3Target | null;
  backups?: Partial<BackupPolicy>;
};
export type Effective = { source: 'off' | 'local' | 'custom' | 'env'; target: S3Target | null; buckets: Buckets; backupTarget: S3Target | null; backups: BackupPolicy };

const S = config.storage;
const LOCAL_KEYS = process.env.LOCAL_S3_KEYS_DIR ?? '/run/rustfs-keys';
const LOCAL_ENDPOINT = process.env.LOCAL_S3_ENDPOINT ?? 'http://rustfs:9000';

/** The RustFS that runs next to the app writes its generated keys to a shared volume; read them if present. */
export function localTarget(): S3Target | null {
  try {
    const accessKey = fs.readFileSync(path.join(LOCAL_KEYS, 'access'), 'utf8').trim();
    const secretKey = fs.readFileSync(path.join(LOCAL_KEYS, 'secret'), 'utf8').trim();
    return accessKey && secretKey ? { endpoint: LOCAL_ENDPOINT, region: 'us-east-1', accessKey, secretKey, forcePathStyle: true } : null;
  } catch {
    return null;
  }
}
const envTarget = (): S3Target | null =>
  S.endpoint && S.accessKey && S.secretKey ? { endpoint: S.endpoint, region: S.region, accessKey: S.accessKey, secretKey: S.secretKey, forcePathStyle: S.forcePathStyle } : null;
const envBackupTarget = (base: S3Target | null): S3Target | null =>
  S.backupEndpoint ? { endpoint: S.backupEndpoint, region: S.backupRegion || S.region, accessKey: S.backupAccessKey || S.accessKey, secretKey: S.backupSecretKey || S.secretKey, forcePathStyle: S.forcePathStyle } : base && null;

/** Saved settings win; otherwise S3_* from the environment; otherwise the local RustFS when its keys are there. */
export function resolve(saved: SavedStorage | null): Effective {
  const policy: BackupPolicy = {
    enabled: config.backups.enabled, hourUtc: config.backups.hourUtc, keepDaily: config.backups.keepDaily, keepWeekly: config.backups.keepWeekly, keepMonthly: config.backups.keepMonthly,
    ...(saved?.backups ?? {}),
  };
  const buckets: Buckets = { ...S.buckets, ...Object.fromEntries(Object.entries(saved?.buckets ?? {}).filter(([, v]) => v)) } as Buckets;
  const mode = saved?.mode ?? 'auto';
  let source: Effective['source'] = 'off';
  let target: S3Target | null = null;
  if (mode === 'custom' && saved?.custom) [source, target] = ['custom', saved.custom];
  else if (mode === 'local') [source, target] = ['local', localTarget()];
  else if (mode === 'auto') {
    const env = envTarget();
    if (env) [source, target] = ['env', env];
    else {
      const loc = localTarget();
      if (loc) [source, target] = ['local', loc];
    }
  }
  if (!target) source = 'off';
  const backupTarget = saved?.backupMode === 'custom' && saved.backupCustom ? saved.backupCustom : saved?.backupMode === 'same' ? null : source === 'env' ? envBackupTarget(target) : null;
  return { source, target, buckets, backupTarget, backups: policy };
}

let eff: Effective = resolve(null);
let saved: SavedStorage | null = null;
let main: S3Client | null = null;
let backup: S3Client | null = null;

export const effective = () => eff;
export const savedStorage = () => saved;
export const storageEnabled = () => !!eff.target;
export const bucketOf = (k: BucketKind) => eff.buckets[k];

export const makeClient = (t: S3Target) =>
  new S3Client({ endpoint: t.endpoint, region: t.region || 'us-east-1', forcePathStyle: t.forcePathStyle, credentials: { accessKeyId: t.accessKey, secretAccessKey: t.secretKey }, maxAttempts: 3 });

export function client(kind: BucketKind): S3Client {
  if (!eff.target) throw new Error('Object storage is not set up');
  if (kind === 'backups' && eff.backupTarget) return (backup ??= makeClient(eff.backupTarget));
  return (main ??= makeClient(eff.target));
}

/** Load the saved settings (Platform page) and switch to them. */
export async function reloadStorage() {
  const row = (await adminPool().query("SELECT value_enc FROM platform_settings WHERE key = 'storage'")).rows[0];
  let next: SavedStorage | null = null;
  if (row) {
    try {
      next = JSON.parse(decrypt(row.value_enc));
    } catch {
      console.error('storage: saved settings could not be read (encryption key changed?), using defaults');
    }
  }
  apply(next);
  return eff;
}
export function apply(next: SavedStorage | null) {
  const before = JSON.stringify(eff);
  saved = next;
  eff = resolve(next);
  if (JSON.stringify(eff) !== before) {
    main?.destroy();
    backup?.destroy();
    main = backup = null;
  }
}
export async function saveStorage(next: SavedStorage, by: string | null) {
  await adminPool().query(
    `INSERT INTO platform_settings (key, value_enc, updated_by) VALUES ('storage', $1, $2)
     ON CONFLICT (key) DO UPDATE SET value_enc = EXCLUDED.value_enc, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [encrypt(JSON.stringify(next)), by],
  );
  apply(next);
}

/** Create any bucket that does not exist yet. */
export async function ensureBuckets() {
  for (const kind of ['chat', 'documents', 'backups'] as BucketKind[]) {
    const Bucket = bucketOf(kind);
    try {
      await client(kind).send(new HeadBucketCommand({ Bucket }));
    } catch {
      await client(kind).send(new CreateBucketCommand({ Bucket })).catch((e) => {
        if (!/BucketAlready(OwnedByYou|Exists)/.test(String(e?.name ?? e))) throw e;
      });
    }
  }
}

/** "{company}/{yyyy}/{mm}/{random}-{name}": grouped by company, never guessable, keeps the original name readable. */
export function objectKey(tenantId: string, filename: string) {
  const d = new Date();
  const safe = filename.normalize('NFKD').replace(/[^\w.\-]+/g, '_').replace(/_+/g, '_').slice(-80) || 'file';
  return `${tenantId}/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${crypto.randomUUID()}-${safe}`;
}

export async function putObject(kind: BucketKind, key: string, body: Buffer | Readable, contentType: string) {
  await client(kind).send(new PutObjectCommand({ Bucket: bucketOf(kind), Key: key, Body: body, ContentType: contentType }));
}

export async function getObject(kind: BucketKind, key: string): Promise<Readable> {
  const r = await client(kind).send(new GetObjectCommand({ Bucket: bucketOf(kind), Key: key }));
  return r.Body as Readable;
}

export async function getBuffer(kind: BucketKind, key: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const ch of await getObject(kind, key)) chunks.push(Buffer.from(ch));
  return Buffer.concat(chunks);
}

/** Best effort: a missing object is fine, other failures are logged and left for the orphan sweep. */
export async function deleteObject(kind: BucketKind, key: string | null | undefined) {
  if (!key || !storageEnabled()) return;
  await client(kind).send(new DeleteObjectCommand({ Bucket: bucketOf(kind), Key: key })).catch((e) => console.warn(`storage: could not delete ${kind}/${key}: ${e?.message ?? e}`));
}

export async function* listObjects(kind: BucketKind, prefix?: string) {
  let token: string | undefined;
  do {
    const r = await client(kind).send(new ListObjectsV2Command({ Bucket: bucketOf(kind), Prefix: prefix, ContinuationToken: token }));
    for (const o of r.Contents ?? []) if (o.Key) yield { key: o.Key, size: Number(o.Size ?? 0), modified: o.LastModified ?? new Date(0) };
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
}

/**
 * Store an uploaded file. With object storage on, the bytes go to the bucket and only the key is kept in the row;
 * otherwise the bytes are kept in the row. Upload happens before the database write, so a failed upload saves nothing.
 */
export async function storeFile(kind: BucketKind, tenantId: string, filename: string, contentType: string, data: Buffer): Promise<{ data: Buffer | null; key: string | null }> {
  if (!storageEnabled()) return { data, key: null };
  const key = objectKey(tenantId, filename);
  await putObject(kind, key, data, contentType);
  return { data: null, key };
}

/** The bytes of a stored file row (a stream when it is in object storage). */
export async function fileBody(kind: BucketKind, row: { data: Buffer | null; storage_key: string | null }): Promise<Buffer | Readable> {
  if (row.storage_key) return getObject(kind, row.storage_key);
  return row.data ?? Buffer.alloc(0);
}

// ---------- maintenance (runs with the database owner, across companies) ----------

let admin: Pool | null = null;
export const adminPool = () => (admin ??= new Pool({ connectionString: config.adminDatabaseUrl, max: 3 }));
export async function closeAdminPool() {
  const a = admin;
  admin = null;
  await a?.end();
}

const TABLES = [
  { table: 'cert_files', kind: 'documents' as BucketKind, time: 'uploaded_at' },
  { table: 'chat_attachments', kind: 'chat' as BucketKind, time: 'created_at' },
];

/** Move files still kept in Postgres into their buckets, a batch at a time. Returns how many were moved. */
export async function moveFilesToStorage(batch = 50): Promise<number> {
  if (!storageEnabled()) return 0;
  const db = adminPool();
  let moved = 0;
  for (const t of TABLES) {
    for (;;) {
      const rows = (await db.query(`SELECT id, tenant_id, filename, content_type, data FROM ${t.table} WHERE storage_key IS NULL AND data IS NOT NULL ORDER BY ${t.time} LIMIT $1`, [batch])).rows;
      if (!rows.length) break;
      for (const r of rows) {
        const key = objectKey(r.tenant_id, r.filename);
        await putObject(t.kind, key, r.data, r.content_type);
        // Only clear the bytes if the row was not changed meanwhile (a replaced file keeps its new content).
        const done = await db.query(`UPDATE ${t.table} SET storage_key = $2, data = NULL WHERE id = $1 AND storage_key IS NULL AND md5(data) = $3`, [r.id, key, crypto.createHash('md5').update(r.data).digest('hex')]);
        if (done.rowCount) moved++;
        else await deleteObject(t.kind, key);
      }
      if (rows.length < batch) break;
    }
  }
  return moved;
}

/** Delete objects no row points at any more (deleted messages, replaced scans, removed people), older than a day. */
export async function sweepOrphans(): Promise<number> {
  if (!storageEnabled()) return 0;
  const db = adminPool();
  let removed = 0;
  const cutoff = Date.now() - 24 * 3600_000;
  for (const t of TABLES) {
    const keys = new Set((await db.query(`SELECT storage_key FROM ${t.table} WHERE storage_key IS NOT NULL`)).rows.map((r) => r.storage_key as string));
    for await (const o of listObjects(t.kind)) {
      if (!keys.has(o.key) && o.modified.getTime() < cutoff) {
        await deleteObject(t.kind, o.key);
        removed++;
      }
    }
  }
  return removed;
}

/** Counts for the status page. */
export async function storageStatus() {
  const db = adminPool();
  const out: Record<string, unknown> = {
    enabled: storageEnabled(), source: eff.source, endpoint: eff.target?.endpoint ?? null, buckets: eff.buckets,
    backupEndpoint: eff.backupTarget?.endpoint ?? eff.target?.endpoint ?? null, separateBackups: !!eff.backupTarget,
  };
  for (const t of TABLES) {
    const r = (await db.query(`SELECT count(*) FILTER (WHERE storage_key IS NOT NULL)::int AS in_storage, count(*) FILTER (WHERE storage_key IS NULL)::int AS in_db,
                                      COALESCE(sum(size), 0)::bigint AS bytes FROM ${t.table}`)).rows[0];
    out[t.table] = { inStorage: r.in_storage, inDatabase: r.in_db, bytes: Number(r.bytes) };
  }
  if (storageEnabled()) {
    for (const kind of ['chat', 'backups'] as BucketKind[]) {
      try {
        await client(kind).send(new HeadBucketCommand({ Bucket: bucketOf(kind) }));
        out[kind === 'chat' ? 'reachable' : 'backupReachable'] = true;
      } catch (e: any) {
        out[kind === 'chat' ? 'reachable' : 'backupReachable'] = false;
        out[kind === 'chat' ? 'error' : 'backupError'] = String(e?.name === 'NotFound' ? 'bucket not created yet' : e?.message ?? e).slice(0, 300);
      }
    }
  }
  return out;
}
