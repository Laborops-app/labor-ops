import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate, forgetSuspension } from '../auth';
import { config } from '../config';
import {
  adminPool, effective, ensureBuckets, getObject, localTarget, makeClient, moveFilesToStorage, resolve, saveStorage, savedStorage,
  storageEnabled, storageStatus, type BucketKind, type Effective, type S3Target, type SavedStorage,
} from '../storage';
import { nightly } from '../backup';
import { HeadBucketCommand, CreateBucketCommand, GetObjectCommand, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';

/**
 * The platform (operator) side: every company, object storage and backups, and who may see this.
 * Platform admins are kept in platform_admins. The very first one comes from PLATFORM_ADMINS (an email of an existing company admin);
 * after that they are added and removed on the Platform page.
 */
const cache = new Map<string, { ok: boolean; at: number }>();
let running: Promise<unknown> | null = null;
let lastRun: { at: string; result: unknown } | null = null;
export async function isPlatformAdmin(_tid: string, uid: string) {
  const hit = cache.get(uid);
  if (hit && Date.now() - hit.at < 30_000) return hit.ok;
  const db = adminPool();
  let ok = !!(await db.query('SELECT 1 FROM platform_admins WHERE user_id = $1', [uid])).rowCount;
  if (!ok && config.platformAdmins.length) {
    const u = (await db.query("SELECT email FROM users WHERE id = $1 AND role = 'admin' AND active", [uid])).rows[0];
    if (u && config.platformAdmins.includes(String(u.email).toLowerCase())) {
      await db.query('INSERT INTO platform_admins (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [uid]);
      ok = true;
    }
  }
  cache.set(uid, { ok, at: Date.now() });
  return ok;
}

const platform = async (req: FastifyRequest, reply: FastifyReply) => {
  await authenticate(req, reply);
  if (reply.sent) return;
  if (!(await isPlatformAdmin(req.user.tid, req.user.sub))) return reply.code(403).send({ error: 'Only platform admins can open this' });
};

// ---------- storage settings ----------
const target = z.object({
  endpoint: z.string().trim().url().max(300),
  region: z.string().trim().max(60).default('us-east-1'),
  accessKey: z.string().trim().max(200).default(''),
  secretKey: z.string().max(400).default(''), // blank = keep the saved one
  forcePathStyle: z.boolean().default(true),
});
const bucketName = z.string().trim().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'Bucket names use 3-63 lowercase letters, numbers, dots and dashes');
const settingsBody = z.object({
  mode: z.enum(['auto', 'local', 'custom', 'off']),
  custom: target.nullable().optional(),
  buckets: z.object({ chat: bucketName, documents: bucketName, backups: bucketName }).partial().optional(),
  backupMode: z.enum(['same', 'custom']).default('same'),
  backupCustom: target.nullable().optional(),
  backups: z.object({
    enabled: z.boolean(), hourUtc: z.number().int().min(0).max(23),
    keepDaily: z.number().int().min(1).max(90), keepWeekly: z.number().int().min(0).max(52), keepMonthly: z.number().int().min(0).max(60),
  }).partial().optional(),
});

/** Fill blank secrets from what is saved (the page never receives secrets back). */
function withSecrets(b: z.infer<typeof settingsBody>): SavedStorage {
  const cur = savedStorage();
  const fill = (t: z.infer<typeof target> | null | undefined, old: S3Target | null | undefined): S3Target | null => {
    if (!t) return null;
    const same = old && old.endpoint === t.endpoint;
    return { ...t, accessKey: t.accessKey || (same ? old!.accessKey : ''), secretKey: t.secretKey || (same ? old!.secretKey : '') };
  };
  return { mode: b.mode, custom: fill(b.custom, cur?.custom), buckets: b.buckets, backupMode: b.backupMode, backupCustom: fill(b.backupCustom, cur?.backupCustom), backups: b.backups };
}
const mask = (t: S3Target | null | undefined) => (t ? { endpoint: t.endpoint, region: t.region, accessKey: t.accessKey, forcePathStyle: t.forcePathStyle, hasSecret: !!t.secretKey } : null);

/** Try a set of settings: reach the server, and create the buckets if they are missing. */
async function testSettings(e: Effective) {
  const out: { storage?: string; backups?: string; ok: boolean } = { ok: true };
  if (!e.target) return { ok: true };
  const check = async (t: S3Target, buckets: string[]) => {
    const c = makeClient(t);
    try {
      for (const Bucket of buckets) {
        try {
          await c.send(new HeadBucketCommand({ Bucket }));
        } catch {
          await c.send(new CreateBucketCommand({ Bucket })).catch((err) => {
            if (!/BucketAlready(OwnedByYou|Exists)/.test(String(err?.name ?? err))) throw err;
          });
        }
      }
      return 'ok';
    } catch (err: any) {
      out.ok = false;
      return String(err?.name === 'InvalidAccessKeyId' || err?.name === 'SignatureDoesNotMatch' ? 'The access key or secret key is wrong' : err?.message ?? err).slice(0, 300);
    } finally {
      c.destroy();
    }
  };
  out.storage = await check(e.target, e.backupTarget ? [e.buckets.chat, e.buckets.documents] : [e.buckets.chat, e.buckets.documents, e.buckets.backups]);
  if (e.backupTarget) out.backups = await check(e.backupTarget, [e.buckets.backups]);
  return out;
}

// Copying files to a new storage server (or new bucket names) before switching over.
type Job = { state: 'running' | 'done' | 'failed'; copied: number; total: number; missing: number; error?: string; startedAt: string };
let job: Job | null = null;
async function copyAll(from: Effective, to: Effective) {
  const src = makeClient(from.target!), dst = makeClient(to.target!);
  const db = adminPool();
  const rows = [
    ...(await db.query('SELECT storage_key AS key FROM chat_attachments WHERE storage_key IS NOT NULL')).rows.map((r) => ({ kind: 'chat' as BucketKind, key: r.key })),
    ...(await db.query('SELECT storage_key AS key FROM cert_files WHERE storage_key IS NOT NULL')).rows.map((r) => ({ kind: 'documents' as BucketKind, key: r.key })),
  ];
  job!.total = rows.length;
  for (const r of rows) {
    const Bucket = to.buckets[r.kind];
    const there = await dst.send(new HeadObjectCommand({ Bucket, Key: r.key })).then(() => true, () => false);
    if (!there) {
      // A file already missing on the old server cannot be copied; count it and carry on with the rest.
      const o = await src.send(new GetObjectCommand({ Bucket: from.buckets[r.kind], Key: r.key })).catch((e) => {
        if (/NoSuchKey|NoSuchBucket|NotFound/.test(String(e?.name ?? e))) return null;
        throw e;
      });
      if (!o) {
        job!.missing++;
        continue;
      }
      const body = Buffer.from(await o.Body!.transformToByteArray());
      await dst.send(new PutObjectCommand({ Bucket, Key: r.key, Body: body, ContentType: o.ContentType }));
    }
    job!.copied++;
  }
  src.destroy();
  dst.destroy();
}

export async function platformRoutes(app: FastifyInstance) {
  // ---------- overview and companies ----------
  app.get('/api/platform/overview', { preHandler: platform }, async () => {
    const db = adminPool();
    const one = async (sql: string) => (await db.query(sql)).rows[0];
    const [counts, files, lastBackup] = await Promise.all([
      one(`SELECT (SELECT count(*)::int FROM tenants) AS companies, (SELECT count(*)::int FROM tenants WHERE suspended_at IS NOT NULL) AS suspended,
                  (SELECT count(*)::int FROM users WHERE active) AS people, (SELECT count(*)::int FROM users WHERE last_seen_at > now() - interval '7 days') AS active_week,
                  (SELECT count(*)::int FROM events WHERE end_date >= current_date) AS upcoming_events,
                  (SELECT count(*)::int FROM tenants WHERE created_at > now() - interval '30 days') AS new_companies`),
      one(`SELECT (SELECT COALESCE(sum(size), 0) FROM cert_files)::bigint + (SELECT COALESCE(sum(size), 0) FROM chat_attachments)::bigint AS bytes,
                  (SELECT count(*)::int FROM cert_files) + (SELECT count(*)::int FROM chat_attachments) AS count`),
      one("SELECT status, started_at, size, error FROM platform_backups WHERE status IN ('done', 'failed') ORDER BY started_at DESC LIMIT 1"),
    ]);
    return {
      counts,
      files: { bytes: Number(files.bytes), count: files.count },
      storage: { source: effective().source, enabled: storageEnabled() },
      lastBackup: lastBackup ?? null,
      services: {
        email: !!(config.email.host && config.email.user),
        sms: config.sms.provider === 'sns' ? !!config.sms.sns.accessKeyId : !!config.sms.sid,
        demo: config.seedDemo,
      },
    };
  });

  app.get('/api/platform/companies', { preHandler: platform }, async () => ({
    companies: (
      await adminPool().query(
        `SELECT t.id, t.name, t.plan, t.created_at, t.suspended_at, t.suspended_reason,
                (SELECT count(*)::int FROM users u WHERE u.tenant_id = t.id AND u.active) AS people,
                (SELECT count(*)::int FROM users u WHERE u.tenant_id = t.id AND u.role = 'crew' AND u.active) AS crew,
                (SELECT string_agg(u.email, ', ' ORDER BY u.created_at) FROM users u WHERE u.tenant_id = t.id AND u.role = 'admin') AS admins,
                (SELECT max(u.last_seen_at) FROM users u WHERE u.tenant_id = t.id) AS last_active,
                (SELECT count(*)::int FROM events e WHERE e.tenant_id = t.id) AS events,
                ((SELECT COALESCE(sum(size), 0) FROM cert_files f WHERE f.tenant_id = t.id) + (SELECT COALESCE(sum(size), 0) FROM chat_attachments f WHERE f.tenant_id = t.id))::bigint AS file_bytes
           FROM tenants t ORDER BY t.created_at DESC`,
      )
    ).rows.map((r) => ({ ...r, file_bytes: Number(r.file_bytes) })),
  }));

  app.post('/api/platform/companies/:id/suspend', { preHandler: platform }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ suspended: z.boolean(), reason: z.string().trim().max(500).optional() }).parse(req.body);
    if (b.suspended && id === req.user.tid) return reply.code(400).send({ error: 'You cannot suspend your own company' });
    const r = await adminPool().query('UPDATE tenants SET suspended_at = CASE WHEN $2 THEN now() ELSE NULL END, suspended_reason = CASE WHEN $2 THEN $3 ELSE NULL END WHERE id = $1 RETURNING id, suspended_at', [id, b.suspended, b.reason || null]);
    if (!r.rowCount) return reply.code(404).send({ error: 'Company not found' });
    forgetSuspension(id);
    await adminPool().query("INSERT INTO audit_logs (tenant_id, actor_id, action, entity, entity_id, detail) VALUES ($1, NULL, $2, 'tenant', $4, $3)", [id, b.suspended ? 'platform.suspend' : 'platform.unsuspend', JSON.stringify({ by: req.user.sub, reason: b.reason ?? null }), id]);
    return r.rows[0];
  });

  // ---------- platform admins ----------
  app.get('/api/platform/admins', { preHandler: platform }, async () => ({
    admins: (await adminPool().query(
      `SELECT p.user_id, u.name, u.email, t.name AS company, p.created_at, a.name AS added_by_name FROM platform_admins p JOIN users u ON u.id = p.user_id
         JOIN tenants t ON t.id = u.tenant_id LEFT JOIN users a ON a.id = p.added_by ORDER BY p.created_at`)).rows,
    fromEnv: config.platformAdmins,
  }));
  app.post('/api/platform/admins', { preHandler: platform }, async (req, reply) => {
    const { email } = z.object({ email: z.string().trim().email() }).parse(req.body);
    const u = (await adminPool().query("SELECT id, role, active FROM users WHERE lower(email) = lower($1)", [email])).rows[0];
    if (!u) return reply.code(404).send({ error: 'No one has an account with that email yet. They need to sign up first.' });
    if (u.role !== 'admin' || !u.active) return reply.code(400).send({ error: 'Only an active company admin can be a platform admin' });
    await adminPool().query('INSERT INTO platform_admins (user_id, added_by) VALUES ($1,$2) ON CONFLICT DO NOTHING', [u.id, req.user.sub]);
    cache.delete(u.id);
    return reply.code(201).send({ ok: true });
  });
  app.delete('/api/platform/admins/:id', { preHandler: platform }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    if (id === req.user.sub) return reply.code(400).send({ error: 'Ask another platform admin to remove you' });
    const left = (await adminPool().query('SELECT count(*)::int AS n FROM platform_admins WHERE user_id <> $1', [id])).rows[0].n;
    if (!left) return reply.code(400).send({ error: 'There must be at least one platform admin' });
    await adminPool().query('DELETE FROM platform_admins WHERE user_id = $1', [id]);
    cache.delete(id);
    return { ok: true };
  });

  // ---------- storage and backups ----------
  app.get('/api/platform/storage', { preHandler: platform }, async () => {
    const backups = (await adminPool().query('SELECT id, bucket, key, size, kind, status, error, started_at, finished_at FROM platform_backups ORDER BY started_at DESC LIMIT 60')).rows;
    const s = savedStorage();
    return {
      storage: await storageStatus(),
      settings: {
        mode: s?.mode ?? 'auto', custom: mask(s?.custom), buckets: effective().buckets, backupMode: s?.backupMode ?? (effective().backupTarget ? 'custom' : 'same'),
        backupCustom: mask(s?.backupCustom ?? effective().backupTarget), backups: effective().backups,
      },
      localAvailable: !!localTarget(),
      backups,
      schedule: { ...effective().backups, enabled: effective().backups.enabled && storageEnabled() },
      running: !!running,
      lastRun,
      job,
    };
  });

  app.post('/api/platform/storage/test', { preHandler: platform }, async (req) => testSettings(resolve(withSecrets(settingsBody.parse(req.body)))));

  // Save the storage settings. Moving to another server (or other bucket names) copies the existing files first.
  app.put('/api/platform/storage', { preHandler: platform }, async (req, reply) => {
    const next = withSecrets(settingsBody.parse(req.body));
    if (next.mode === 'custom' && (!next.custom?.accessKey || !next.custom?.secretKey)) return reply.code(400).send({ error: 'Enter the access key and secret key for the storage server' });
    if (next.backupMode === 'custom' && (!next.backupCustom?.accessKey || !next.backupCustom?.secretKey)) return reply.code(400).send({ error: 'Enter the access key and secret key for the backup server' });
    if (next.mode === 'local' && !localTarget()) return reply.code(400).send({ error: 'The built-in RustFS is not running on this server' });
    if (job?.state === 'running') return reply.code(409).send({ error: 'Files are still being copied to the new storage. Wait for that to finish.' });
    const from = effective(), to = resolve(next);
    const test = await testSettings(to);
    if (!test.ok) return reply.code(400).send({ error: `Could not use those settings: ${[test.storage, test.backups].filter((x) => x && x !== 'ok').join('; ')}`, test });
    const moved = !!from.target && !!to.target && (from.target.endpoint !== to.target.endpoint || from.target.accessKey !== to.target.accessKey || from.buckets.chat !== to.buckets.chat || from.buckets.documents !== to.buckets.documents);
    if (moved) {
      const stored = Number((await adminPool().query('SELECT (SELECT count(*) FROM chat_attachments WHERE storage_key IS NOT NULL) + (SELECT count(*) FROM cert_files WHERE storage_key IS NOT NULL) AS n')).rows[0].n);
      if (stored) {
        job = { state: 'running', copied: 0, total: stored, missing: 0, startedAt: new Date().toISOString() };
        copyAll(from, to)
          .then(async () => {
            await saveStorage(next, req.user.sub);
            job!.state = 'done';
          })
          .catch((e) => Object.assign(job!, { state: 'failed', error: String(e?.message ?? e).slice(0, 500) }));
        return reply.code(202).send({ copying: true, total: stored });
      }
    }
    await saveStorage(next, req.user.sub);
    if (storageEnabled()) {
      await ensureBuckets().catch(() => undefined);
      moveFilesToStorage().catch(() => undefined);
    }
    return { saved: true, source: effective().source };
  });

  // Run the nightly job now (database backup, copy of uploads, pruning). It keeps running after the response.
  app.post('/api/platform/backups', { preHandler: platform }, async (_req, reply) => {
    if (!storageEnabled()) return reply.code(409).send({ error: 'Object storage is not set up' });
    if (running) return reply.code(409).send({ error: 'A backup is already running' });
    running = nightly('manual')
      .then((r) => (lastRun = { at: new Date().toISOString(), result: r }))
      .catch((e) => (lastRun = { at: new Date().toISOString(), result: { error: String(e?.message ?? e) } }))
      .finally(() => (running = null));
    return reply.code(202).send({ started: true });
  });

  app.post('/api/platform/storage/move', { preHandler: platform }, async (_req, reply) => {
    if (!storageEnabled()) return reply.code(409).send({ error: 'Object storage is not set up' });
    return { moved: await moveFilesToStorage() };
  });

  app.get('/api/platform/backups/:id/download', { preHandler: platform }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = (await adminPool().query("SELECT key FROM platform_backups WHERE id = $1 AND status = 'done'", [id])).rows[0];
    if (!b) return reply.code(404).send({ error: 'Backup not found' });
    reply.header('content-type', 'application/octet-stream');
    reply.header('content-disposition', `attachment; filename="${b.key.split('/').pop()}"`);
    reply.header('cache-control', 'no-store');
    return reply.send(await getObject('backups', b.key));
  });
}

