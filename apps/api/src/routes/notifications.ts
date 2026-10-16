import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { pool, withTenant, audit } from '../db';
import { authenticate } from '../auth';
import { toE164 } from '../notify/providers';
import { hashToken, sendReset } from '../notify/tokens';

const uuid = z.string().uuid();

export async function notificationRoutes(app: FastifyInstance) {
  const authLimit = { config: { rateLimit: { max: Number(process.env.AUTH_RATE_MAX ?? 10), timeWindow: '1 minute' } } };

  // ---------- inbox ----------
  app.get('/api/notifications', { preHandler: authenticate }, async (req) =>
    withTenant(req.user.tid, async (c) => ({
      items: (
        await c.query(
          'SELECT id, category, title, body, link, read_at, created_at FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
          [req.user.sub],
        )
      ).rows,
      unread: (await c.query('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [req.user.sub])).rows[0].n,
    })),
  );

  app.get('/api/notifications/count', { preHandler: authenticate }, async (req) =>
    withTenant(req.user.tid, async (c) => ({
      unread: (await c.query('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [req.user.sub])).rows[0].n,
    })),
  );

  app.post('/api/notifications/read', { preHandler: authenticate }, async (req) => {
    const b = z.object({ ids: z.array(uuid).max(100).optional() }).parse(req.body ?? {});
    await withTenant(req.user.tid, (c) =>
      c.query(
        'UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[]))',
        [req.user.sub, b.ids ?? null],
      ),
    );
    return { ok: true };
  });

  // Tapped on the phone (the service worker reports it): counts as read, and cancels a text waiting behind the push.
  app.post('/api/notifications/:id/ack', { preHandler: authenticate }, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    await withTenant(req.user.tid, (c) => c.query('UPDATE notifications SET acked_at = COALESCE(acked_at, now()), read_at = COALESCE(read_at, now()) WHERE id = $1 AND user_id = $2', [id, req.user.sub]));
    return { ok: true };
  });

  // Delete one notification from my inbox.
  app.delete('/api/notifications/:id', { preHandler: authenticate }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const n = await withTenant(req.user.tid, async (c) => (await c.query('DELETE FROM notifications WHERE id = $1 AND user_id = $2', [id, req.user.sub])).rowCount);
    return n ? { ok: true } : reply.code(404).send({ error: 'Notification not found' });
  });
  // Clear several: picked ones, everything already read, or everything.
  app.post('/api/notifications/delete', { preHandler: authenticate }, async (req, reply) => {
    const b = z.object({ ids: z.array(uuid).max(200).optional(), scope: z.enum(['read', 'all']).optional() }).parse(req.body ?? {});
    if (!b.ids?.length && !b.scope) return reply.code(400).send({ error: 'Say which notifications to delete' });
    const n = await withTenant(req.user.tid, async (c) =>
      (
        await c.query(
          `DELETE FROM notifications WHERE user_id = $1
             AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[]))
             AND ($3::text IS NULL OR $3 = 'all' OR read_at IS NOT NULL)`,
          [req.user.sub, b.ids?.length ? b.ids : null, b.scope ?? null],
        )
      ).rowCount,
    );
    return { deleted: n };
  });

  // ---------- my notification settings ----------
  const prefs = (c: import('pg').PoolClient, id: string) =>
    c.query('SELECT phone, notify_email AS email, notify_sms AS sms, sms_consent_at FROM users WHERE id = $1', [id]).then((r) => r.rows[0]);

  app.get('/api/my/notification-prefs', { preHandler: authenticate }, async (req) =>
    withTenant(req.user.tid, async (c) => {
      const p = await prefs(c, req.user.sub);
      return { email: p.email, sms: p.sms, phone: p.phone, phoneValid: !!toE164(p.phone), consentAt: p.sms_consent_at, smsAvailable: true };
    }),
  );

  app.put('/api/my/notification-prefs', { preHandler: authenticate }, async (req, reply) => {
    const b = z.object({ email: z.boolean(), sms: z.boolean(), smsConsent: z.boolean().optional() }).parse(req.body);
    const out = await withTenant(req.user.tid, async (c) => {
      const p = await prefs(c, req.user.sub);
      if (b.sms) {
        if (!toE164(p.phone)) return { code: 400, error: 'Add a valid mobile number to your profile before turning on text messages' };
        if (!p.sms_consent_at && !b.smsConsent) return { code: 400, error: 'Please confirm you agree to receive text messages' };
      }
      await c.query(
        `UPDATE users SET notify_email = $2, notify_sms = $3,
           sms_consent_at = CASE WHEN $3 AND sms_consent_at IS NULL THEN now() WHEN NOT $3 THEN NULL ELSE sms_consent_at END
         WHERE id = $1`,
        [req.user.sub, b.email, b.sms],
      );
      await audit(c, req.user.tid, req.user.sub, 'notify.prefs', 'user', req.user.sub, { email: b.email, sms: b.sms });
      return { code: 200, ok: true };
    });
    const { code, ...body } = out as { code: number; [k: string]: unknown };
    return reply.code(code).send(body);
  });

  // ---------- forgot / reset password (public) ----------
  app.post('/api/auth/forgot', authLimit, async (req) => {
    const { email } = z.object({ email: z.string().trim().email().max(200) }).parse(req.body);
    const { rows } = await pool.query('SELECT * FROM auth_find_user($1)', [email]);
    const u = rows[0];
    if (u?.active) await withTenant(u.tenant_id, (c) => sendReset(c, u.tenant_id, u));
    // Same answer whether or not the account exists.
    return { ok: true };
  });

  app.post('/api/auth/reset', authLimit, async (req, reply) => {
    const b = z.object({ token: z.string().min(20).max(200), password: z.string().min(8).max(200) }).parse(req.body);
    const hash = await bcrypt.hash(b.password, 10);
    const tokenHash = hashToken(b.token);
    for (const kind of ['reset', 'invite']) {
      const { rows } = await pool.query('SELECT * FROM auth_use_token($1,$2,$3)', [tokenHash, kind, hash]);
      if (rows[0]) {
        await withTenant(rows[0].tenant_id, (c) => audit(c, rows[0].tenant_id, rows[0].user_id, `auth.${kind}_complete`, 'user', rows[0].user_id));
        return { ok: true };
      }
    }
    return reply.code(400).send({ error: 'This link has expired or was already used. Request a new one.' });
  });
}
