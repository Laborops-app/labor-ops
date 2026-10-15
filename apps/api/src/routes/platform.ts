import type { FastifyInstance, FastifyReply } from 'fastify';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { forgetSuspension } from '../auth';
import { config } from '../config';
import {
  adminPool, effective, ensureBuckets, getObject, localTarget, makeClient, moveFilesToStorage, resolve, saveStorage, savedStorage,
  storageEnabled, storageStatus, type BucketKind, type Effective, type S3Target, type SavedStorage,
} from '../storage';
import { nightly } from '../backup';
import { audit, findSetup, forgetPlatformUser, issueSetup, PCOOKIE, platformGuard, SESSION_HOURS } from '../platformAuth';
import { HeadBucketCommand, CreateBucketCommand, GetObjectCommand, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';

/**
 * The platform console: the people who run LaborOps manage every company, storage, backups and each other here.
 * Platform admins have their own accounts (platform_users), separate from every company.
 */
let running: Promise<unknown> | null = null;
let lastRun: { at: string; result: unknown } | null = null;
const platform = platformGuard;
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);
export const PLANS = ['trial', 'starter', 'pro', 'enterprise', 'internal'] as const;
const DAY_SQL = 'COALESCE(round(sum(extract(epoch FROM clock_out - clock_in)) / 3600), 0)::int';

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
  const limit = { config: { rateLimit: { max: Number(process.env.AUTH_RATE_MAX ?? 10), timeWindow: '1 minute' } } };
  const signIn = (reply: FastifyReply, id: string) =>
    reply.setCookie(PCOOKIE, app.jwt.sign({ sub: id, kind: 'platform' } as any, { expiresIn: `${SESSION_HOURS}h` }), {
      path: '/', httpOnly: true, sameSite: 'strict', secure: config.cookieSecure, maxAge: SESSION_HOURS * 3600,
    });
  const db = () => adminPool();
  const rows = async (sql: string, p: unknown[] = []) => (await db().query(sql, p)).rows;

  // ---------- sign-in (platform accounts only; company logins do not work here) ----------
  app.post('/api/platform/auth/login', limit, async (req, reply) => {
    const b = z.object({ email: z.string().trim().email(), password: z.string().min(1).max(200) }).parse(req.body);
    const u = (await rows('SELECT id, name, email, password_hash, active FROM platform_users WHERE lower(email) = lower($1)', [b.email]))[0];
    const ok = await bcrypt.compare(b.password, u?.password_hash ?? DUMMY_HASH);
    if (!u || !u.password_hash || !u.active || !ok) return reply.code(401).send({ error: 'Incorrect email or password' });
    await db().query('UPDATE platform_users SET last_login_at = now() WHERE id = $1', [u.id]);
    await audit(u.id, 'login');
    signIn(reply, u.id);
    return { user: { id: u.id, name: u.name, email: u.email } };
  });

  app.post('/api/platform/auth/logout', async (_req, reply) => {
    reply.clearCookie(PCOOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/platform/auth/me', { preHandler: platform }, async (req) => ({ user: req.platformUser }));

  // The one-time link from an invite (or the server command) where someone sets their name and password.
  const expired = 'This link has expired or was already used. Ask another platform admin for a new one.';
  app.get('/api/platform/auth/setup', limit, async (req, reply) => {
    const { token } = z.object({ token: z.string().min(20).max(200) }).parse(req.query);
    const u = await findSetup(token);
    if (!u) return reply.code(404).send({ error: expired });
    return { email: u.email, name: u.name, reset: u.has_password };
  });
  app.post('/api/platform/auth/setup', limit, async (req, reply) => {
    const b = z.object({ token: z.string().min(20).max(200), name: z.string().trim().min(1).max(100), password: z.string().min(10, 'Use at least 10 characters').max(200) }).parse(req.body);
    const u = await findSetup(b.token);
    if (!u) return reply.code(404).send({ error: expired });
    await db().query('UPDATE platform_users SET name = $2, password_hash = $3, setup_hash = NULL, setup_expires_at = NULL, last_login_at = now() WHERE id = $1', [u.id, b.name, await bcrypt.hash(b.password, 10)]);
    forgetPlatformUser(u.id);
    await audit(u.id, u.has_password ? 'password.reset' : 'account.setup');
    signIn(reply, u.id);
    return { user: { id: u.id, name: b.name, email: u.email } };
  });

  app.post('/api/platform/auth/password', { preHandler: platform }, async (req, reply) => {
    const b = z.object({ current: z.string().min(1).max(200), next: z.string().min(10, 'Use at least 10 characters').max(200) }).parse(req.body);
    const u = (await rows('SELECT password_hash FROM platform_users WHERE id = $1', [req.platformUser!.id]))[0];
    if (!u || !(await bcrypt.compare(b.current, u.password_hash))) return reply.code(400).send({ error: 'Your current password is not right' });
    await db().query('UPDATE platform_users SET password_hash = $2 WHERE id = $1', [req.platformUser!.id, await bcrypt.hash(b.next, 10)]);
    await audit(req.platformUser!.id, 'password.change');
    return { ok: true };
  });

  // ---------- dashboard ----------
  app.get('/api/platform/dashboard', { preHandler: platform }, async (req) => {
    const { days } = z.object({ days: z.coerce.number().int().refine((v) => [7, 30, 90, 365].includes(v)).default(30) }).parse(req.query);
    const unit = days <= 31 ? 'day' : days <= 120 ? 'week' : 'month';
    const iv = `${days} days`;
    const [[k], series, plans, top, quiet, feed, [h], lastBackup] = await Promise.all([
      rows(
        `SELECT (SELECT count(*)::int FROM tenants) AS companies,
                (SELECT count(*)::int FROM tenants WHERE suspended_at IS NOT NULL) AS suspended,
                (SELECT count(*)::int FROM tenants WHERE created_at > now() - $1::interval) AS new_companies,
                (SELECT count(*)::int FROM tenants WHERE created_at <= now() - $1::interval AND created_at > now() - 2 * $1::interval) AS new_companies_prev,
                (SELECT count(DISTINCT tenant_id)::int FROM users WHERE last_seen_at > now() - interval '7 days') AS active_companies,
                (SELECT count(*)::int FROM users WHERE active) AS people,
                (SELECT count(*)::int FROM users WHERE active AND role = 'crew') AS crew,
                (SELECT count(*)::int FROM users WHERE last_seen_at > now() - interval '1 day') AS active_today,
                (SELECT count(*)::int FROM users WHERE last_seen_at > now() - interval '7 days') AS active_week,
                (SELECT count(*)::int FROM events WHERE created_at > now() - $1::interval) AS events,
                (SELECT count(*)::int FROM events WHERE created_at <= now() - $1::interval AND created_at > now() - 2 * $1::interval) AS events_prev,
                (SELECT ${DAY_SQL} FROM time_entries WHERE clock_out IS NOT NULL AND clock_in > now() - $1::interval AND clock_in <= now()) AS hours,
                (SELECT ${DAY_SQL} FROM time_entries WHERE clock_out IS NOT NULL AND clock_in <= now() - $1::interval AND clock_in > now() - 2 * $1::interval) AS hours_prev,
                (SELECT count(*)::int FROM audit_logs WHERE action = 'auth.login' AND created_at > now() - $1::interval) AS logins,
                (SELECT count(*)::int FROM audit_logs WHERE action = 'auth.login' AND created_at <= now() - $1::interval AND created_at > now() - 2 * $1::interval) AS logins_prev,
                (SELECT count(*)::int FROM deliveries WHERE status = 'sent' AND created_at > now() - $1::interval) AS messages`,
        [iv],
      ),
      rows(
        `WITH b AS (SELECT generate_series(date_trunc($2, now() - $1::interval), date_trunc($2, now()), ('1 ' || $2)::interval) AS t)
         SELECT b.t AS at,
                (SELECT count(*)::int FROM tenants WHERE created_at >= b.t AND created_at < b.t + ('1 ' || $2)::interval) AS signups,
                (SELECT count(*)::int FROM tenants WHERE created_at < b.t + ('1 ' || $2)::interval) AS companies,
                (SELECT count(*)::int FROM audit_logs WHERE action = 'auth.login' AND created_at >= b.t AND created_at < b.t + ('1 ' || $2)::interval) AS logins,
                (SELECT ${DAY_SQL} FROM time_entries WHERE clock_out IS NOT NULL AND clock_in >= b.t AND clock_in < b.t + ('1 ' || $2)::interval) AS hours
           FROM b ORDER BY b.t`,
        [iv, unit],
      ),
      rows('SELECT plan, count(*)::int AS n FROM tenants WHERE suspended_at IS NULL GROUP BY plan ORDER BY n DESC'),
      rows(
        `SELECT t.id, t.name, t.plan, t.created_at,
                (SELECT count(*)::int FROM users u WHERE u.tenant_id = t.id AND u.active) AS people,
                (SELECT count(*)::int FROM audit_logs a WHERE a.tenant_id = t.id AND a.action = 'auth.login' AND a.created_at > now() - $1::interval) AS logins,
                (SELECT count(*)::int FROM events e WHERE e.tenant_id = t.id AND e.created_at > now() - $1::interval) AS events,
                (SELECT max(u.last_seen_at) FROM users u WHERE u.tenant_id = t.id) AS last_active
           FROM tenants t WHERE t.suspended_at IS NULL ORDER BY logins DESC, people DESC, t.created_at DESC LIMIT 6`,
        [iv],
      ),
      rows(
        `SELECT * FROM (
           SELECT t.id, t.name, t.plan, t.created_at, (SELECT max(u.last_seen_at) FROM users u WHERE u.tenant_id = t.id) AS last_active,
                  (SELECT count(*)::int FROM users u WHERE u.tenant_id = t.id AND u.active) AS people
             FROM tenants t WHERE t.suspended_at IS NULL AND t.created_at < now() - interval '14 days') q
          WHERE last_active IS NULL OR last_active < now() - interval '14 days' ORDER BY people DESC, last_active NULLS FIRST LIMIT 6`,
      ),
      rows(
        `SELECT * FROM (
           (SELECT 'signup'::text AS action, t.created_at AS at, t.id AS tenant_id, t.name AS company, NULL::text AS actor, NULL::jsonb AS detail FROM tenants t ORDER BY t.created_at DESC LIMIT 15)
           UNION ALL
           (SELECT a.action, a.created_at, a.tenant_id, t.name, p.name, a.detail FROM platform_audit a LEFT JOIN tenants t ON t.id = a.tenant_id LEFT JOIN platform_users p ON p.id = a.actor_id
             WHERE a.action <> 'login' ORDER BY a.created_at DESC LIMIT 15)
         ) f ORDER BY at DESC LIMIT 15`,
      ),
      rows(
        `SELECT pg_database_size(current_database())::bigint AS db_bytes,
                (SELECT count(*)::int FROM deliveries WHERE status = 'failed' AND created_at > now() - interval '1 day') AS failed_day,
                (SELECT count(*)::int FROM deliveries WHERE status IN ('queued', 'sending') AND created_at < now() - interval '15 minutes') AS stuck,
                (SELECT COALESCE(sum(size), 0) FROM cert_files)::bigint + (SELECT COALESCE(sum(size), 0) FROM chat_attachments)::bigint AS file_bytes,
                (SELECT count(*)::int FROM cert_files) + (SELECT count(*)::int FROM chat_attachments) AS files`,
      ),
      rows("SELECT status, started_at, size, error FROM platform_backups WHERE status IN ('done', 'failed') ORDER BY started_at DESC LIMIT 1"),
    ]);
    return {
      days, unit, kpis: k, series, plans, top, quiet, feed,
      health: {
        dbBytes: Number(h.db_bytes), fileBytes: Number(h.file_bytes), files: h.files, failedDay: h.failed_day, stuck: h.stuck,
        storage: { source: effective().source, enabled: storageEnabled() },
        lastBackup: lastBackup[0] ?? null,
        email: !!(config.email.host && config.email.user),
        sms: config.sms.provider === 'sns' ? !!config.sms.sns.accessKeyId : !!config.sms.sid,
        demo: config.seedDemo,
        uptime: Math.round(process.uptime()),
        version: process.env.APP_VERSION ?? null,
      },
    };
  });

  // ---------- companies ----------
  app.get('/api/platform/companies', { preHandler: platform }, async () => ({
    plans: PLANS,
    companies: (
      await rows(
        `SELECT t.id, t.name, t.plan, t.created_at, t.suspended_at, t.suspended_reason,
                (SELECT count(*)::int FROM users u WHERE u.tenant_id = t.id AND u.active) AS people,
                (SELECT count(*)::int FROM users u WHERE u.tenant_id = t.id AND u.role = 'crew' AND u.active) AS crew,
                (SELECT string_agg(u.email, ', ' ORDER BY u.created_at) FROM users u WHERE u.tenant_id = t.id AND u.role = 'admin' AND u.active) AS admins,
                (SELECT max(u.last_seen_at) FROM users u WHERE u.tenant_id = t.id) AS last_active,
                (SELECT count(*)::int FROM audit_logs a WHERE a.tenant_id = t.id AND a.action = 'auth.login' AND a.created_at > now() - interval '30 days') AS logins_30d,
                (SELECT count(*)::int FROM events e WHERE e.tenant_id = t.id) AS events,
                ((SELECT COALESCE(sum(size), 0) FROM cert_files f WHERE f.tenant_id = t.id) + (SELECT COALESCE(sum(size), 0) FROM chat_attachments f WHERE f.tenant_id = t.id))::bigint AS file_bytes
           FROM tenants t ORDER BY t.created_at DESC`,
      )
    ).map((r) => ({ ...r, file_bytes: Number(r.file_bytes) })),
  }));

  app.get('/api/platform/companies/:id', { preHandler: platform }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const t = (await rows('SELECT id, name, slug, plan, created_at, suspended_at, suspended_reason, platform_notes FROM tenants WHERE id = $1', [id]))[0];
    if (!t) return reply.code(404).send({ error: 'Company not found' });
    const [[s], staff, integrations, activity, recent, history] = await Promise.all([
      rows(
        `SELECT (SELECT count(*)::int FROM users WHERE tenant_id = $1 AND active) AS people,
                (SELECT count(*)::int FROM users WHERE tenant_id = $1 AND active AND role = 'crew') AS crew,
                (SELECT count(*)::int FROM users WHERE tenant_id = $1 AND last_seen_at > now() - interval '7 days') AS active_week,
                (SELECT max(last_seen_at) FROM users WHERE tenant_id = $1) AS last_active,
                (SELECT count(*)::int FROM events WHERE tenant_id = $1) AS events,
                (SELECT count(*)::int FROM events WHERE tenant_id = $1 AND end_date >= current_date) AS upcoming,
                (SELECT ${DAY_SQL} FROM time_entries WHERE tenant_id = $1 AND clock_out IS NOT NULL AND clock_in > now() - interval '30 days' AND clock_in <= now()) AS hours_30d,
                (SELECT count(*)::int FROM customers WHERE tenant_id = $1) AS customers,
                (SELECT count(*)::int FROM quotes WHERE tenant_id = $1) AS quotes,
                ((SELECT COALESCE(sum(size), 0) FROM cert_files WHERE tenant_id = $1) + (SELECT COALESCE(sum(size), 0) FROM chat_attachments WHERE tenant_id = $1))::bigint AS file_bytes,
                (SELECT count(*)::int FROM deliveries WHERE tenant_id = $1 AND status = 'sent' AND created_at > now() - interval '30 days') AS messages_30d`,
        [id],
      ),
      rows("SELECT id, name, email, phone, role, active, last_seen_at FROM users WHERE tenant_id = $1 AND role IN ('admin', 'manager') ORDER BY role, active DESC, name", [id]),
      rows('SELECT provider, updated_at FROM integration_settings WHERE tenant_id = $1 ORDER BY provider', [id]),
      rows(
        `WITH b AS (SELECT generate_series(date_trunc('day', now() - interval '29 days'), date_trunc('day', now()), interval '1 day') AS t)
         SELECT b.t AS at, (SELECT count(*)::int FROM audit_logs a WHERE a.tenant_id = $1 AND a.action = 'auth.login' AND a.created_at >= b.t AND a.created_at < b.t + interval '1 day') AS logins FROM b ORDER BY b.t`,
        [id],
      ),
      rows('SELECT a.action, a.entity, a.created_at, u.name AS actor FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id WHERE a.tenant_id = $1 ORDER BY a.created_at DESC LIMIT 15', [id]),
      rows('SELECT a.action, a.detail, a.created_at, p.name AS actor FROM platform_audit a LEFT JOIN platform_users p ON p.id = a.actor_id WHERE a.tenant_id = $1 ORDER BY a.created_at DESC LIMIT 15', [id]),
    ]);
    return { company: t, stats: { ...s, file_bytes: Number(s.file_bytes) }, staff, integrations, activity, recent, history, plans: PLANS };
  });

  app.patch('/api/platform/companies/:id', { preHandler: platform }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ name: z.string().trim().min(2).max(100).optional(), plan: z.enum(PLANS).optional(), notes: z.string().max(5000).nullable().optional() }).parse(req.body);
    const before = (await rows('SELECT name, plan FROM tenants WHERE id = $1', [id]))[0];
    if (!before) return reply.code(404).send({ error: 'Company not found' });
    await db().query(
      'UPDATE tenants SET name = COALESCE($2, name), plan = COALESCE($3, plan), platform_notes = CASE WHEN $4 THEN $5 ELSE platform_notes END WHERE id = $1',
      [id, b.name ?? null, b.plan ?? null, b.notes !== undefined, b.notes?.trim() || null],
    );
    if (b.plan && b.plan !== before.plan) await audit(req.platformUser!.id, 'company.plan', id, { from: before.plan, to: b.plan });
    if (b.name && b.name !== before.name) await audit(req.platformUser!.id, 'company.rename', id, { from: before.name, to: b.name });
    if (b.notes !== undefined) await audit(req.platformUser!.id, 'company.notes', id);
    return { ok: true };
  });

  app.post('/api/platform/companies/:id/suspend', { preHandler: platform }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ suspended: z.boolean(), reason: z.string().trim().max(500).optional() }).parse(req.body);
    const r = await db().query('UPDATE tenants SET suspended_at = CASE WHEN $2 THEN now() ELSE NULL END, suspended_reason = CASE WHEN $2 THEN $3 ELSE NULL END WHERE id = $1 RETURNING id, suspended_at', [id, b.suspended, b.reason || null]);
    if (!r.rowCount) return reply.code(404).send({ error: 'Company not found' });
    forgetSuspension(id);
    await audit(req.platformUser!.id, b.suspended ? 'company.suspend' : 'company.unsuspend', id, b.reason ? { reason: b.reason } : null);
    await db().query("INSERT INTO audit_logs (tenant_id, actor_id, action, entity, entity_id, detail) VALUES ($1, NULL, $2, 'tenant', $3, $4)", [id, b.suspended ? 'platform.suspend' : 'platform.unsuspend', id, JSON.stringify({ reason: b.reason ?? null })]);
    return r.rows[0];
  });

  // ---------- platform admins ----------
  app.get('/api/platform/admins', { preHandler: platform }, async () => ({
    admins: await rows(
      `SELECT p.id, p.email, p.name, p.password_hash IS NOT NULL AS ready, p.setup_expires_at, p.last_login_at, p.created_at, i.name AS invited_by_name
         FROM platform_users p LEFT JOIN platform_users i ON i.id = p.invited_by WHERE p.active ORDER BY p.created_at`,
    ),
  }));
  app.post('/api/platform/admins', { preHandler: platform }, async (req, reply) => {
    const b = z.object({ email: z.string().trim().email().max(200), name: z.string().trim().max(100).default('') }).parse(req.body);
    const have = (await rows('SELECT active, password_hash IS NOT NULL AS ready FROM platform_users WHERE lower(email) = lower($1)', [b.email]))[0];
    if (have?.active && have.ready) return reply.code(409).send({ error: 'They are already a platform admin' });
    const { user, link } = await issueSetup(b.email, b.name, req.platformUser!.id);
    await audit(req.platformUser!.id, 'admin.invite', null, { email: user.email });
    return reply.code(201).send({ link, expiresHours: 72 });
  });
  app.post('/api/platform/admins/:id/link', { preHandler: platform }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const u = (await rows('SELECT email FROM platform_users WHERE id = $1 AND active', [id]))[0];
    if (!u) return reply.code(404).send({ error: 'Platform admin not found' });
    const { link } = await issueSetup(u.email);
    await audit(req.platformUser!.id, 'admin.link', null, { email: u.email });
    return { link, expiresHours: 72 };
  });
  app.delete('/api/platform/admins/:id', { preHandler: platform }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    if (id === req.platformUser!.id) return reply.code(400).send({ error: 'Ask another platform admin to remove you' });
    const left = (await rows('SELECT count(*)::int AS n FROM platform_users WHERE active AND password_hash IS NOT NULL AND id <> $1', [id]))[0].n;
    if (!left) return reply.code(400).send({ error: 'There must be at least one platform admin' });
    const u = (await rows('UPDATE platform_users SET active = false, setup_hash = NULL WHERE id = $1 RETURNING email', [id]))[0];
    if (!u) return reply.code(404).send({ error: 'Platform admin not found' });
    forgetPlatformUser(id);
    await audit(req.platformUser!.id, 'admin.remove', null, { email: u.email });
    return { ok: true };
  });

  // ---------- activity log ----------
  app.get('/api/platform/audit', { preHandler: platform }, async (req) => {
    const { before } = z.object({ before: z.coerce.number().int().optional() }).parse(req.query);
    return {
      entries: await rows(
        `SELECT a.id, a.action, a.detail, a.created_at, a.tenant_id, t.name AS company, p.name AS actor, p.email AS actor_email
           FROM platform_audit a LEFT JOIN tenants t ON t.id = a.tenant_id LEFT JOIN platform_users p ON p.id = a.actor_id
          WHERE ($1::bigint IS NULL OR a.id < $1) ORDER BY a.id DESC LIMIT 100`,
        [before ?? null],
      ),
    };
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
    await audit(req.platformUser!.id, 'storage.save', null, { mode: next.mode, backupMode: next.backupMode });
    const test = await testSettings(to);
    if (!test.ok) return reply.code(400).send({ error: `Could not use those settings: ${[test.storage, test.backups].filter((x) => x && x !== 'ok').join('; ')}`, test });
    const moved = !!from.target && !!to.target && (from.target.endpoint !== to.target.endpoint || from.target.accessKey !== to.target.accessKey || from.buckets.chat !== to.buckets.chat || from.buckets.documents !== to.buckets.documents);
    if (moved) {
      const stored = Number((await adminPool().query('SELECT (SELECT count(*) FROM chat_attachments WHERE storage_key IS NOT NULL) + (SELECT count(*) FROM cert_files WHERE storage_key IS NOT NULL) AS n')).rows[0].n);
      if (stored) {
        job = { state: 'running', copied: 0, total: stored, missing: 0, startedAt: new Date().toISOString() };
        copyAll(from, to)
          .then(async () => {
            await saveStorage(next, req.platformUser!.id);
            job!.state = 'done';
          })
          .catch((e) => Object.assign(job!, { state: 'failed', error: String(e?.message ?? e).slice(0, 500) }));
        return reply.code(202).send({ copying: true, total: stored });
      }
    }
    await saveStorage(next, req.platformUser!.id);
    if (storageEnabled()) {
      await ensureBuckets().catch(() => undefined);
      moveFilesToStorage().catch(() => undefined);
    }
    return { saved: true, source: effective().source };
  });

  // Run the nightly job now (database backup, copy of uploads, pruning). It keeps running after the response.
  app.post('/api/platform/backups', { preHandler: platform }, async (req, reply) => {
    if (!storageEnabled()) return reply.code(409).send({ error: 'Object storage is not set up' });
    if (running) return reply.code(409).send({ error: 'A backup is already running' });
    await audit(req.platformUser!.id, 'backup.manual');
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

