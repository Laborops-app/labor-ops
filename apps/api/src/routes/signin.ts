import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticatorTransportFuture,
} from '@simplewebauthn/server';
import { pool, withTenant, audit } from '../db';
import { authenticate, COOKIE, type SessionUser } from '../auth';
import { config } from '../config';
import { adminPool } from '../storage';
import { hashToken, issueToken } from '../notify/tokens';
import { enqueueAccountEmail } from '../notify';
import { toE164 } from '../notify/providers';

/**
 * Password-free sign-in for crew: a one-time link sent by email (and text, for people who agreed to texts),
 * and passkeys (Face ID / fingerprint / phone screen lock) once they are signed in on a device.
 */
const PK_COOKIE = 'lo_pk';
const rpID = () => new URL(config.appUrl).hostname;
const origin = () => config.appUrl;

export async function signinRoutes(app: FastifyInstance) {
  const limit = { config: { rateLimit: { max: Number(process.env.AUTH_RATE_MAX ?? 10), timeWindow: '1 minute' } } };
  const setSession = (reply: FastifyReply, user: SessionUser) =>
    reply.setCookie(COOKIE, app.jwt.sign(user, { expiresIn: '12h' }), { path: '/', httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, maxAge: 12 * 3600 });
  const suspended = async (tenantId: string) => !!(await adminPool().query('SELECT 1 FROM tenants WHERE id = $1 AND suspended_at IS NOT NULL', [tenantId])).rowCount;
  // The challenge travels in a short-lived signed cookie, so any API instance can check the answer.
  const putChallenge = (reply: FastifyReply, kind: 'reg' | 'auth', challenge: string, sub?: string) =>
    reply.setCookie(PK_COOKIE, app.jwt.sign({ kind, ch: challenge, sub } as any, { expiresIn: '5m' }), { path: '/api', httpOnly: true, sameSite: 'strict', secure: config.cookieSecure, maxAge: 300 });
  const takeChallenge = (req: any, reply: FastifyReply, kind: 'reg' | 'auth', sub?: string): string | null => {
    const raw = req.cookies?.[PK_COOKIE];
    reply.clearCookie(PK_COOKIE, { path: '/api' });
    if (!raw) return null;
    try {
      const p = app.jwt.verify<{ kind: string; ch: string; sub?: string }>(raw);
      return p.kind === kind && (!sub || p.sub === sub) ? p.ch : null;
    } catch {
      return null;
    }
  };

  // ---------- sign-in link ----------
  app.post('/api/auth/magic', limit, async (req) => {
    const { email } = z.object({ email: z.string().trim().email().max(200) }).parse(req.body);
    const u = (await pool.query('SELECT * FROM auth_find_user($1)', [email])).rows[0];
    if (u?.active && !(await suspended(u.tenant_id))) {
      await withTenant(u.tenant_id, async (c) => {
        const raw = await issueToken(c, u.tenant_id, u.id, 'magic', 0.25);
        const link = `${config.appUrl}/magic?token=${raw}`;
        await enqueueAccountEmail(c, u.tenant_id, {
          userId: u.id, to: u.email, subject: 'Your LaborOps sign-in link',
          body: `Hi ${u.name.split(' ')[0]},\n\nUse the button below to sign in to LaborOps. The link works once, for 15 minutes.\n\nIf you didn't ask for this, you can ignore this email.`,
          link, linkLabel: 'Sign in',
        });
        // Crew often read texts before email: send it there too when they agreed to texts.
        const p = (await c.query('SELECT phone, sms_consent_at, notify_sms FROM users WHERE id = $1', [u.id])).rows[0];
        const phone = toE164(p?.phone);
        if (phone && p.sms_consent_at && p.notify_sms)
          await c.query(
            "INSERT INTO deliveries (tenant_id, user_id, channel, category, to_addr, body) VALUES ($1,$2,'sms','account',$3,$4)",
            [u.tenant_id, u.id, phone, `LaborOps sign-in link (works once, 15 min): ${link}`],
          );
        await audit(c, u.tenant_id, u.id, 'auth.magic_sent', 'user', u.id);
      });
    }
    // Same answer whether or not the account exists.
    return { ok: true };
  });

  app.post('/api/auth/magic/verify', limit, async (req, reply) => {
    const { token } = z.object({ token: z.string().min(20).max(200) }).parse(req.body);
    const u = (await pool.query('SELECT * FROM auth_use_magic($1)', [hashToken(token)])).rows[0];
    if (!u) return reply.code(400).send({ error: 'This sign-in link has expired or was already used. Ask for a new one.' });
    if (await suspended(u.tenant_id)) return reply.code(403).send({ error: 'This company account is suspended. Contact LaborOps support.', reason: 'suspended' });
    await withTenant(u.tenant_id, (c) => audit(c, u.tenant_id, u.user_id, 'auth.login_link', 'user', u.user_id));
    setSession(reply, { sub: u.user_id, tid: u.tenant_id, role: u.role, name: u.name });
    return { user: { id: u.user_id, name: u.name, role: u.role } };
  });

  // ---------- passkeys: add one (signed in) ----------
  app.get('/api/passkeys', { preHandler: authenticate }, async (req) =>
    withTenant(req.user.tid, async (c) => ({
      items: (await c.query('SELECT id, name, created_at, last_used_at FROM passkeys WHERE user_id = $1 ORDER BY created_at', [req.user.sub])).rows,
    })),
  );

  app.post('/api/passkeys/options', { preHandler: authenticate }, async (req, reply) => {
    const { me, existing } = await withTenant(req.user.tid, async (c) => ({
      me: (await c.query('SELECT email, name FROM users WHERE id = $1', [req.user.sub])).rows[0],
      existing: (await c.query('SELECT id, transports FROM passkeys WHERE user_id = $1', [req.user.sub])).rows,
    }));
    const opts = await generateRegistrationOptions({
      rpName: 'LaborOps', rpID: rpID(), userName: me.email, userDisplayName: me.name,
      userID: new TextEncoder().encode(req.user.sub),
      attestationType: 'none',
      excludeCredentials: existing.map((k: any) => ({ id: k.id, transports: k.transports as AuthenticatorTransportFuture[] })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    });
    putChallenge(reply, 'reg', opts.challenge, req.user.sub);
    return opts;
  });

  app.post('/api/passkeys', { preHandler: authenticate }, async (req, reply) => {
    const b = z.object({ response: z.any(), name: z.string().trim().max(60).optional() }).parse(req.body);
    const expectedChallenge = takeChallenge(req, reply, 'reg', req.user.sub);
    if (!expectedChallenge) return reply.code(400).send({ error: 'That took too long. Try adding the passkey again.' });
    const v = await verifyRegistrationResponse({ response: b.response, expectedChallenge, expectedOrigin: origin(), expectedRPID: rpID() }).catch((e) => ({ verified: false, error: String(e?.message ?? e) }) as any);
    if (!v.verified || !v.registrationInfo) return reply.code(400).send({ error: 'The passkey could not be checked. Try again.' });
    const cred = v.registrationInfo.credential;
    const name = b.name || guessDevice(String(req.headers['user-agent'] ?? ''));
    const row = await withTenant(req.user.tid, async (c) => {
      const r = await c.query(
        'INSERT INTO passkeys (id, tenant_id, user_id, public_key, counter, transports, name) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING RETURNING id, name, created_at',
        [cred.id, req.user.tid, req.user.sub, Buffer.from(cred.publicKey), cred.counter, cred.transports ?? [], name],
      );
      if (r.rows[0]) await audit(c, req.user.tid, req.user.sub, 'auth.passkey_add', 'user', req.user.sub);
      return r.rows[0];
    });
    if (!row) return reply.code(409).send({ error: 'This passkey is already saved' });
    return reply.code(201).send({ passkey: row });
  });

  app.delete('/api/passkeys/:id', { preHandler: authenticate }, async (req, reply) => {
    const { id } = z.object({ id: z.string().min(1).max(400) }).parse(req.params);
    const n = await withTenant(req.user.tid, async (c) => {
      const r = await c.query('DELETE FROM passkeys WHERE id = $1 AND user_id = $2', [id, req.user.sub]);
      if (r.rowCount) await audit(c, req.user.tid, req.user.sub, 'auth.passkey_remove', 'user', req.user.sub);
      return r.rowCount;
    });
    return n ? { ok: true } : reply.code(404).send({ error: 'Passkey not found' });
  });

  // ---------- passkeys: sign in ----------
  app.post('/api/auth/passkey/options', limit, async (_req, reply) => {
    const opts = await generateAuthenticationOptions({ rpID: rpID(), userVerification: 'preferred' });
    putChallenge(reply, 'auth', opts.challenge);
    return opts;
  });

  app.post('/api/auth/passkey', limit, async (req, reply) => {
    const { response } = z.object({ response: z.object({ id: z.string().min(1).max(400) }).passthrough() }).parse(req.body);
    const expectedChallenge = takeChallenge(req, reply, 'auth');
    if (!expectedChallenge) return reply.code(400).send({ error: 'That took too long. Try again.' });
    const k = (await pool.query('SELECT * FROM auth_find_passkey($1)', [response.id])).rows[0];
    const fail = () => reply.code(401).send({ error: 'This passkey is not linked to an active LaborOps account. Sign in another way and add it again.' });
    if (!k || !k.active) return fail();
    const v = await verifyAuthenticationResponse({
      response: response as any, expectedChallenge, expectedOrigin: origin(), expectedRPID: rpID(),
      credential: { id: k.id, publicKey: new Uint8Array(k.public_key), counter: Number(k.counter), transports: k.transports },
    }).catch(() => null);
    if (!v?.verified) return fail();
    if (await suspended(k.tenant_id)) return reply.code(403).send({ error: 'This company account is suspended. Contact LaborOps support.', reason: 'suspended' });
    await pool.query('SELECT auth_passkey_used($1,$2)', [k.id, v.authenticationInfo.newCounter]);
    await withTenant(k.tenant_id, (c) => audit(c, k.tenant_id, k.user_id, 'auth.login_passkey', 'user', k.user_id));
    setSession(reply, { sub: k.user_id, tid: k.tenant_id, role: k.role, name: k.name });
    return { user: { id: k.user_id, name: k.name, role: k.role } };
  });
}

function guessDevice(ua: string) {
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android phone';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  return 'Passkey';
}
