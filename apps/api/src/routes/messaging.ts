import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { z } from 'zod';
import { withTenant, audit } from '../db';
import { guard } from '../auth';
import { config } from '../config';
import { sendEmail, sendSms, toE164 } from '../notify/providers';
import { renderEmail } from '../notify/templates';
import { runSweeps } from '../notify/sweeps';
import { invalidateSettings } from '../notify/worker';
import { notifyStaff } from '../notify';
import {
  clearIntegration, emailLive, loadSettings, podiumConnected, publicView, saveIntegration, smsLive, smsSender, type Provider,
} from '../notify/settings';
import { authorizeUrl, exchangeCode, listPodiumLocations, registerWebhook, verifyPodiumSignature } from '../notify/podium';

const STOP_WORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT']);
const adm = guard('admin');

// OAuth "state" is signed separately from session tokens, so it can never be used as a login token.
const stateKey = () => crypto.createHash('sha256').update('podium-state:' + config.jwtSecret).digest();
const signState = (tid: string, sub: string) => {
  const body = Buffer.from(JSON.stringify({ tid, sub, exp: Date.now() + 15 * 60_000, n: crypto.randomBytes(8).toString('hex') })).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', stateKey()).update(body).digest('base64url')}`;
};
const readState = (st: string): { tid: string; sub: string } | null => {
  const [body, sig] = st.split('.');
  if (!body || !sig) return null;
  const want = crypto.createHmac('sha256', stateKey()).update(body).digest('base64url');
  if (want.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return null;
  try {
    const j = JSON.parse(Buffer.from(body, 'base64url').toString());
    return j.exp > Date.now() ? j : null;
  } catch {
    return null;
  }
};
const str = (max = 300) => z.string().trim().max(max);

const schemas: Record<Provider, z.ZodTypeAny> = {
  ses: z.object({ host: str(200), port: z.coerce.number().int().min(1).max(65535).optional(), user: str(200), pass: str(300).optional(), from: str(200) }).strict(),
  zernio: z.object({ apiKey: str(300).optional(), from: str(30) }).strict(),
  podium: z.object({ clientId: str(200), clientSecret: str(300).optional(), locationUid: str(100) }).strict(),
};

const persistPodium = (tid: string): ((t: { accessToken: string; refreshToken: string; expiresAt: number }) => Promise<void>) => async (t) => {
  await withTenant(tid, (c) => saveIntegration(c, tid, null, 'podium', t, { raw: true }));
  invalidateSettings(tid);
};

export async function messagingRoutes(app: FastifyInstance) {
  const redirectUri = () => `${config.appUrl}/api/podium/callback`;
  const webhookUrl = (tid: string) => `${config.appUrl}/api/podium/webhook/${tid}`;

  // ---------- admin: settings, status, delivery log ----------
  app.get('/api/messaging', { preHandler: adm }, async (req) =>
    withTenant(req.user.tid, async (c) => {
      const r = await loadSettings(c, req.user.tid);
      const view = publicView(r);
      return {
        email: { live: emailLive(r), from: r.ses.from, host: r.ses.host || null, source: r.ses.source },
        sms: { live: smsLive(r), provider: r.smsProvider, from: smsSender(r) },
        settings: view,
        urls: { appUrl: config.appUrl, podiumRedirect: redirectUri(), podiumWebhook: webhookUrl(req.user.tid) },
        stats: (
          await c.query(`SELECT channel, status, count(*)::int AS n FROM deliveries WHERE created_at > now() - interval '30 days' GROUP BY channel, status`)
        ).rows,
        deliveries: (
          await c.query(
            `SELECT d.id, d.channel, d.category, d.to_addr, d.subject, d.status, d.attempts, d.last_error, d.created_at, d.sent_at, u.name AS user_name
               FROM deliveries d LEFT JOIN users u ON u.id = d.user_id ORDER BY d.created_at DESC LIMIT 50`,
          )
        ).rows.map((d) => (d.channel === 'push' ? { ...d, to_addr: 'browser' } : d)),
        replies: (
          await c.query(
            `SELECT m.id, m.from_addr, m.contact_name, m.body, m.received_at, u.name AS user_name
               FROM inbound_messages m LEFT JOIN users u ON u.id = m.user_id ORDER BY m.received_at DESC LIMIT 30`,
          )
        ).rows,
      };
    }),
  );

  app.put('/api/messaging/settings/:provider', { preHandler: adm }, async (req, reply) => {
    const { provider } = z.object({ provider: z.enum(['ses', 'zernio', 'podium']) }).parse(req.params);
    const body = schemas[provider].parse(req.body ?? {}) as Record<string, any>;
    await withTenant(req.user.tid, async (c) => {
      await saveIntegration(c, req.user.tid, req.user.sub, provider, body);
      await audit(c, req.user.tid, req.user.sub, 'messaging.settings', 'integration', null, { provider, fields: Object.keys(body) });
    });
    invalidateSettings(req.user.tid);
    return reply.send({ ok: true });
  });

  app.delete('/api/messaging/settings/:provider', { preHandler: adm }, async (req) => {
    const { provider } = z.object({ provider: z.enum(['ses', 'zernio', 'podium']) }).parse(req.params);
    await withTenant(req.user.tid, async (c) => {
      await clearIntegration(c, provider);
      await audit(c, req.user.tid, req.user.sub, 'messaging.settings.clear', 'integration', null, { provider });
    });
    invalidateSettings(req.user.tid);
    return { ok: true };
  });

  app.put('/api/messaging/sms-provider', { preHandler: adm }, async (req) => {
    const { provider } = z.object({ provider: z.enum(['none', 'zernio', 'podium']) }).parse(req.body);
    await withTenant(req.user.tid, async (c) => {
      await c.query('UPDATE tenants SET sms_provider = $1 WHERE id = $2', [provider, req.user.tid]);
      await audit(c, req.user.tid, req.user.sub, 'messaging.sms_provider', 'tenant', req.user.tid, { provider });
    });
    invalidateSettings(req.user.tid);
    return { ok: true };
  });

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
    const cfg = await withTenant(req.user.tid, (c) => loadSettings(c, req.user.tid));
    const m = renderEmail({ title: 'LaborOps test message', body: 'If you are reading this, email sending from LaborOps works.', link: '/dashboard' });
    const smsBody = 'LaborOps: test message. Texting is working. Reply STOP to opt out.';
    const r = b.channel === 'email'
      ? await sendEmail(cfg, { to, subject: 'LaborOps test message', text: m.text, html: m.html })
      : await sendSms(cfg, { to, body: smsBody }, { persistPodium: persistPodium(req.user.tid), contactName: req.user.name });
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

  // ---------- Podium: connect (OAuth), webhook ----------
  app.get('/api/podium/connect', { preHandler: adm }, async (req, reply) => {
    const cfg = await withTenant(req.user.tid, (c) => loadSettings(c, req.user.tid));
    if (!cfg.podium.clientId || !cfg.podium.clientSecret) return reply.code(400).send({ error: 'Save your Podium client ID and client secret first' });
    const state = signState(req.user.tid, req.user.sub);
    return { url: authorizeUrl(cfg.podium, redirectUri(), state) };
  });

  app.get('/api/podium/callback', { preHandler: adm }, async (req, reply) => {
    const q = z.object({ code: z.string().min(5).max(2000).optional(), state: z.string().min(10).max(4000), error: z.string().optional() }).parse(req.query);
    const st = readState(q.state);
    if (!st || st.sub !== req.user.sub || st.tid !== req.user.tid) return reply.redirect('/messaging?podium=invalid');
    if (q.error || !q.code) return reply.redirect('/messaging?podium=denied');
    try {
      const cfg = await withTenant(req.user.tid, (c) => loadSettings(c, req.user.tid));
      const t = await exchangeCode(cfg.podium, q.code, redirectUri());
      await withTenant(req.user.tid, async (c) => {
        await saveIntegration(c, req.user.tid, req.user.sub, 'podium', { ...t, connectedAt: new Date().toISOString() }, { raw: true });
        await audit(c, req.user.tid, req.user.sub, 'messaging.podium.connect', 'integration', null);
      });
      invalidateSettings(req.user.tid);
      return reply.redirect('/messaging?podium=connected');
    } catch (e) {
      req.log.error(e);
      return reply.redirect('/messaging?podium=failed');
    }
  });

  app.post('/api/podium/disconnect', { preHandler: adm }, async (req) => {
    await withTenant(req.user.tid, async (c) => {
      await saveIntegration(c, req.user.tid, req.user.sub, 'podium', { accessToken: '', refreshToken: '', expiresAt: 0, connectedAt: '', webhookUid: '' }, { raw: true });
      await audit(c, req.user.tid, req.user.sub, 'messaging.podium.disconnect', 'integration', null);
    });
    invalidateSettings(req.user.tid);
    return { ok: true };
  });

  // Create the webhook at Podium (best effort: the manual URL + secret on the page work too).
  app.post('/api/podium/webhook/register', { preHandler: adm }, async (req, reply) => {
    const cfg = await withTenant(req.user.tid, (c) => loadSettings(c, req.user.tid));
    if (!podiumConnected(cfg.podium)) return reply.code(400).send({ error: 'Connect Podium first' });
    const secret = cfg.podium.webhookSecret || crypto.randomBytes(24).toString('hex');
    await withTenant(req.user.tid, (c) => saveIntegration(c, req.user.tid, req.user.sub, 'podium', { webhookSecret: secret }, { raw: true }));
    invalidateSettings(req.user.tid);
    try {
      const uid = await registerWebhook({ ...cfg.podium, webhookSecret: secret }, webhookUrl(req.user.tid), secret, persistPodium(req.user.tid));
      await withTenant(req.user.tid, (c) => saveIntegration(c, req.user.tid, req.user.sub, 'podium', { webhookUid: uid }, { raw: true }));
      invalidateSettings(req.user.tid);
      return { ok: true };
    } catch (e: any) {
      return reply.code(502).send({ error: `${e.message}. You can still add the webhook URL and secret shown below in Podium by hand.` });
    }
  });

  app.get('/api/podium/locations', { preHandler: adm }, async (req, reply) => {
    const cfg = await withTenant(req.user.tid, (c) => loadSettings(c, req.user.tid));
    if (!podiumConnected(cfg.podium)) return reply.code(400).send({ error: 'Connect Podium first' });
    try {
      return { locations: await listPodiumLocations(cfg.podium, persistPodium(req.user.tid)) };
    } catch (e: any) {
      return reply.code(502).send({ error: e.message });
    }
  });

  app.get('/api/podium/webhook-secret', { preHandler: adm }, async (req) => {
    const cfg = await withTenant(req.user.tid, async (c) => {
      const r = await loadSettings(c, req.user.tid);
      if (!r.podium.webhookSecret) {
        const secret = crypto.randomBytes(24).toString('hex');
        await saveIntegration(c, req.user.tid, req.user.sub, 'podium', { webhookSecret: secret }, { raw: true });
        r.podium.webhookSecret = secret;
      }
      return r;
    });
    invalidateSettings(req.user.tid);
    return { url: webhookUrl(req.user.tid), secret: cfg.podium.webhookSecret };
  });

  // Public endpoints below need the raw body (signature checks), so they live in their own plugin scope.
  app.register(async (inst) => {
    inst.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
      (req as any).rawBody = body;
      try {
        done(null, body ? JSON.parse(body as string) : {});
      } catch (e) {
        done(e as Error);
      }
    });
    inst.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
      try {
        done(null, Object.fromEntries(new URLSearchParams(body as string)));
      } catch (e) {
        done(e as Error);
      }
    });

    inst.post('/api/podium/webhook/:tenantId', async (req, reply) => {
      const { tenantId } = z.object({ tenantId: z.string().uuid() }).parse(req.params);
      const cfg = await withTenant(tenantId, (c) => loadSettings(c, tenantId));
      const raw = String((req as any).rawBody ?? '');
      const ok = verifyPodiumSignature(cfg.podium.webhookSecret, String(req.headers['podium-timestamp'] ?? ''), raw, String(req.headers['podium-signature'] ?? ''));
      if (!ok) return reply.code(401).send({ error: 'Bad signature' });
      const ev: any = req.body ?? {};
      const type = String(ev?.metadata?.eventType ?? ev?.metadata?.event_type ?? '');
      const d = ev?.data ?? {};
      const identifier = String(d?.conversation?.channel?.identifier ?? '');
      const digits = identifier.replace(/\D/g, '').slice(-10);
      if (type === 'message.received' && d.uid) {
        await withTenant(tenantId, async (c) => {
          const u = digits.length === 10
            ? (await c.query("SELECT id, name FROM users WHERE right(regexp_replace(coalesce(phone,''),'\\D','','g'),10) = $1 AND active LIMIT 1", [digits])).rows[0]
            : null;
          const ins = await c.query(
            `INSERT INTO inbound_messages (tenant_id, user_id, provider, provider_uid, channel, from_addr, contact_name, body)
             VALUES ($1,$2,'podium',$3,'sms',$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id`,
            [tenantId, u?.id ?? null, String(d.uid), identifier, d?.contact?.name ?? null, String(d.body ?? '').slice(0, 4000)],
          );
          if (!ins.rowCount) return; // duplicate delivery
          // A STOP reply also switches texting off in LaborOps, whatever Podium does on its side.
          if (u && STOP_WORDS.has(String(d.body ?? '').trim().toUpperCase())) {
            await c.query('UPDATE users SET notify_sms = false, sms_consent_at = NULL WHERE id = $1', [u.id]);
          }
          await notifyStaff(c, tenantId, {
            category: 'approval_request',
            title: `Text reply from ${u?.name ?? d?.contact?.name ?? identifier}`,
            body: String(d.body ?? '').slice(0, 300),
            link: '/messaging',
          });
        });
      } else if (type === 'message.failed' && d.uid) {
        await withTenant(tenantId, (c) =>
          c.query("UPDATE deliveries SET status = 'failed', last_error = $2 WHERE provider_id = $1", [String(d.uid), `Podium: ${d.failureReason ?? 'delivery failed'}`.slice(0, 250)]),
        );
      }
      return { ok: true };
    });

  });
}
