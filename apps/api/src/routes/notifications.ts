import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { z } from 'zod';
import { pool, withTenant, audit } from '../db';
import { authenticate, guard } from '../auth';
import { config } from '../config';
import { emailConfigured, smsConfigured, smsSender, sendEmail, sendSms, toE164 } from '../notify/providers';
import { renderEmail } from '../notify/templates';
import { hashToken, sendReset } from '../notify/tokens';
import { runSweeps } from '../notify/sweeps';

const uuid = z.string().uuid();
const STOP_WORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT']);

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

  // ---------- admin: messaging status, test send, delivery log ----------
  const adm = guard('admin');
  app.get('/api/messaging', { preHandler: adm }, async (req) =>
    withTenant(req.user.tid, async (c) => ({
      email: { live: emailConfigured(), from: config.email.from, host: config.email.host || null },
      sms: { live: smsConfigured(), provider: config.sms.provider, from: smsSender() },
      appUrl: config.appUrl,
      stats: (
        await c.query(
          `SELECT channel, status, count(*)::int AS n FROM deliveries WHERE created_at > now() - interval '30 days' GROUP BY channel, status`,
        )
      ).rows,
      deliveries: (
        await c.query(
          `SELECT d.id, d.channel, d.category, d.to_addr, d.subject, d.status, d.attempts, d.last_error, d.created_at, d.sent_at, u.name AS user_name
             FROM deliveries d LEFT JOIN users u ON u.id = d.user_id ORDER BY d.created_at DESC LIMIT 50`,
        )
      ).rows,
    })),
  );

  app.post('/api/messaging/test', { preHandler: adm, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = z.object({ channel: z.enum(['email', 'sms']), to: z.string().trim().min(5).max(200) }).parse(req.body);
    let to = b.to;
    if (b.channel === 'email') {
      if (!z.string().email().safeParse(to).success) return reply.code(400).send({ error: 'Enter a valid email address' });
    } else {
      const e = toE164(to);
      if (!e) return reply.code(400).send({ error: 'Enter a valid mobile number, e.g. +1 801 555 0123' });
      to = e;
    }
    const m = renderEmail({ title: 'LaborOps test message', body: 'If you are reading this, email sending from LaborOps works.', link: '/dashboard' });
    const smsBody = 'LaborOps: test message. Texting is working. Reply STOP to opt out.';
    const r = b.channel === 'email'
      ? await sendEmail({ to, subject: 'LaborOps test message', text: m.text, html: m.html })
      : await sendSms({ to, body: smsBody });
    await withTenant(req.user.tid, async (c) => {
      await c.query(
        `INSERT INTO deliveries (tenant_id, user_id, channel, category, to_addr, subject, body, status, attempts, last_error, provider_id, sent_at)
         VALUES ($1,$2,$3,'test',$4,$5,$6,$7,1,$8,$9, CASE WHEN $7 = 'sent' THEN now() END)`,
        [req.user.tid, req.user.sub, b.channel, to, b.channel === 'email' ? 'LaborOps test message' : null, b.channel === 'email' ? m.text : smsBody,
          r.ok ? 'sent' : 'failed', r.ok ? (r.logged ? 'log-only mode: not delivered' : null) : r.error, r.ok ? r.id : null],
      );
      await audit(c, req.user.tid, req.user.sub, 'messaging.test', 'delivery', null, { channel: b.channel, ok: r.ok });
    });
    if (!r.ok) return reply.code(502).send({ error: r.error });
    return { ok: true, logged: !!r.logged };
  });

  app.post('/api/messaging/sweep', { preHandler: adm }, async () => runSweeps());

  // ---------- Twilio inbound SMS webhook (STOP handling) ----------
  app.register(async (inst) => {
    inst.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
      try {
        done(null, Object.fromEntries(new URLSearchParams(body as string)));
      } catch (e) {
        done(e as Error);
      }
    });
    inst.post('/api/sms/twilio/inbound', async (req, reply) => {
      if (!config.sms.token) return reply.code(503).send({ error: 'SMS is not configured' });
      const params = (req.body ?? {}) as Record<string, string>;
      const url = `${config.appUrl}/api/sms/twilio/inbound`;
      const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
      const expect = crypto.createHmac('sha1', config.sms.token).update(data).digest('base64');
      const got = String(req.headers['x-twilio-signature'] ?? '');
      const a = Buffer.from(expect);
      const b = Buffer.from(got);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return reply.code(403).send({ error: 'Bad signature' });
      const word = String(params.Body ?? '').trim().toUpperCase();
      if (STOP_WORDS.has(word)) {
        const digits = String(params.From ?? '').replace(/\D/g, '').slice(-10);
        if (digits.length === 10) await pool.query('SELECT notify_sms_stop($1)', [digits]);
      }
      // Twilio sends the standard STOP / HELP replies itself; an empty TwiML response adds nothing.
      return reply.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    });
  });
}
