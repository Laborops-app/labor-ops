import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import crypto from 'node:crypto';
import { z } from 'zod';
import { withTenant, audit } from '../db';
import { guard } from '../auth';
import { config } from '../config';
import { decrypt, encrypt } from '../crypto';
import { notify } from '../notify';

/**
 * Upstage Academy certificate sync.
 * The academy site sends a signed webhook whenever a student earns a certificate (course or course group).
 * The student is matched to a LaborOps user by email (the academy username is the email) and the certificate
 * is added to their profile as verified. Certificates with no matching user are kept and applied later.
 */

const adm = guard('admin');
const webhookUrl = (tid: string) => `${config.appUrl}/api/academy/webhook/${tid}`;

async function readSecret(c: PoolClient): Promise<string> {
  const { rows } = await c.query("SELECT config_enc FROM integration_settings WHERE provider = 'academy'");
  if (!rows[0]) return '';
  try {
    return String(JSON.parse(decrypt(rows[0].config_enc)).secret ?? '');
  } catch {
    return '';
  }
}

function verify(secret: string, ts: string, raw: string, header: string): boolean {
  if (!secret || !ts || !header.startsWith('sha256=')) return false;
  const age = Math.abs(Date.now() / 1000 - Number(ts));
  if (!Number.isFinite(age) || age > 600) return false;
  const want = crypto.createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex');
  const got = header.slice(7);
  return want.length === got.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(got));
}

/** Adds one received certificate to the matching user's profile. Returns true when a user was matched. */
async function applyCert(c: PoolClient, tid: string, row: { id: string; code: string; email: string; username: string | null; title: string }): Promise<boolean> {
  const u = (
    await c.query(
      'SELECT id, name FROM users WHERE active AND (lower(email) = lower($1) OR lower(email) = lower($2)) ORDER BY (lower(email) = lower($1)) DESC LIMIT 1',
      [row.email, row.username ?? ''],
    )
  ).rows[0];
  if (!u) return false;
  // One certificate per name per person: an existing one with the same name becomes verified.
  const r = await c.query(
    `INSERT INTO user_certs (tenant_id, user_id, name, expires_on, verified, external_ref, source)
     VALUES ($1,$2,$3,NULL,true,$4,'academy')
     ON CONFLICT (user_id, lower(name)) DO UPDATE SET verified = true, external_ref = EXCLUDED.external_ref, source = 'academy'
     RETURNING id`,
    [tid, u.id, row.title.slice(0, 60), row.code],
  );
  await c.query('UPDATE academy_certs SET user_id = $2, applied_at = now() WHERE id = $1', [row.id, u.id]);
  await audit(c, tid, null, 'cert.academy_import', 'cert', r.rows[0].id, { code: row.code, title: row.title });
  await notify(c, tid, {
    userId: u.id,
    category: 'cert',
    title: `Academy certificate added: ${row.title}`,
    body: 'Your certificate from Upstage Academy was added to your profile.',
    link: '/profile',
  });
  return true;
}

const payload = z.object({
  event: z.string(),
  certificate: z.object({
    code: z.string().trim().min(3).max(64),
    type: z.enum(['course', 'group']).default('course'),
    title: z.string().trim().min(1).max(200),
    issued_at: z.string().datetime({ offset: true }),
  }).partial({ type: true }).optional(),
  user: z.object({ email: z.string().trim().max(254).default(''), username: z.string().trim().max(254).default('') }).optional(),
});

export async function academyRoutes(app: FastifyInstance) {
  // Admin: status, recent certificates, a new shared secret, and a retry for unmatched ones.
  app.get('/api/integrations/academy', { preHandler: adm }, async (req) =>
    withTenant(req.user.tid, async (c) => ({
      url: webhookUrl(req.user.tid),
      secretSet: !!(await readSecret(c)),
      stats: (await c.query('SELECT count(*)::int AS total, count(applied_at)::int AS applied FROM academy_certs')).rows[0],
      recent: (
        await c.query(
          `SELECT a.code, a.email, a.title, a.kind, a.issued_at, a.applied_at, u.name AS user_name
           FROM academy_certs a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.created_at DESC LIMIT 15`,
        )
      ).rows,
    })),
  );

  // Creates (or replaces) the shared secret. It is returned once, to paste into the academy settings.
  app.post('/api/integrations/academy/secret', { preHandler: adm }, async (req) =>
    withTenant(req.user.tid, async (c) => {
      const secret = crypto.randomBytes(24).toString('hex');
      await c.query(
        `INSERT INTO integration_settings (tenant_id, provider, config_enc, updated_by) VALUES ($1,'academy',$2,$3)
         ON CONFLICT (tenant_id, provider) DO UPDATE SET config_enc = EXCLUDED.config_enc, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [req.user.tid, encrypt(JSON.stringify({ secret })), req.user.sub],
      );
      await audit(c, req.user.tid, req.user.sub, 'academy.secret_rotated', 'integration', null, {});
      return { url: webhookUrl(req.user.tid), secret };
    }),
  );

  app.post('/api/integrations/academy/apply', { preHandler: adm }, async (req) =>
    withTenant(req.user.tid, async (c) => {
      const pending = (await c.query('SELECT id, code, email, username, title FROM academy_certs WHERE applied_at IS NULL ORDER BY issued_at')).rows;
      let matched = 0;
      for (const p of pending) if (await applyCert(c, req.user.tid, p)) matched++;
      return { checked: pending.length, matched };
    }),
  );

  // Public webhook. Own plugin scope because the signature is checked against the raw request body.
  app.register(async (inst) => {
    inst.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
      (req as any).rawBody = body;
      try {
        done(null, body ? JSON.parse(body as string) : {});
      } catch (e) {
        done(e as Error);
      }
    });

    inst.post('/api/academy/webhook/:tenantId', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
      const { tenantId } = z.object({ tenantId: z.string().uuid() }).parse(req.params);
      const raw = String((req as any).rawBody ?? '');
      const secret = await withTenant(tenantId, (c) => readSecret(c));
      if (!verify(secret, String(req.headers['x-academy-timestamp'] ?? ''), raw, String(req.headers['x-academy-signature'] ?? ''))) {
        return reply.code(401).send({ error: 'Bad signature' });
      }
      const p = payload.safeParse(req.body);
      if (!p.success) return reply.code(400).send({ error: 'Bad payload' });
      if (p.data.event === 'ping') return { ok: true, pong: true };
      if (p.data.event !== 'certificate.issued' || !p.data.certificate || !p.data.user) return { ok: true, ignored: true };
      const cert = p.data.certificate;
      const email = p.data.user.email || p.data.user.username;
      if (!email) return reply.code(400).send({ error: 'No email' });
      const matched = await withTenant(tenantId, async (c) => {
        const ins = await c.query(
          `INSERT INTO academy_certs (tenant_id, code, email, username, title, kind, issued_at) VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (tenant_id, code) DO UPDATE SET email = EXCLUDED.email
           RETURNING id, code, email, username, title, applied_at`,
          [tenantId, cert.code, email.toLowerCase(), p.data.user!.username || null, cert.title, cert.type ?? 'course', cert.issued_at],
        );
        if (ins.rows[0].applied_at) return true; // already imported: a repeat delivery
        return applyCert(c, tenantId, ins.rows[0]);
      });
      return { ok: true, matched };
    });
  });
}
