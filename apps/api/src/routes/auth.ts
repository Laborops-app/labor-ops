import { canAdjustRates } from '../rates';
import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { z } from 'zod';
import { pool, withTenant, audit } from '../db';
import { adminPool } from '../storage';
import { authenticate, COOKIE, SessionUser } from '../auth';
import { config } from '../config';
import { billingSettings } from '../billing';

const registerBody = z.object({
  company: z.string().trim().min(2).max(100),
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().email().max(200),
  password: z.string().min(8).max(200),
});
const loginBody = z.object({ email: z.string().trim().email(), password: z.string().min(1).max(200) });

const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);
const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'company';

export async function authRoutes(app: FastifyInstance) {
  const setSession = (reply: import('fastify').FastifyReply, user: SessionUser) => {
    const token = app.jwt.sign(user, { expiresIn: '12h' });
    reply.setCookie(COOKIE, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: config.cookieSecure,
      maxAge: 12 * 3600,
    });
  };
  const limit = { config: { rateLimit: { max: Number(process.env.AUTH_RATE_MAX ?? 10), timeWindow: '1 minute' } } };

  app.post('/api/auth/register', limit, async (req, reply) => {
    const body = registerBody.parse(req.body);
    const existing = await pool.query('SELECT 1 FROM auth_find_user($1)', [body.email]);
    if (existing.rowCount) return reply.code(409).send({ error: 'That email is already registered' });

    const tenantId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const hash = await bcrypt.hash(body.password, 10);
    const slug = `${slugify(body.company)}-${crypto.randomBytes(3).toString('hex')}`;
    await withTenant(tenantId, async (c) => {
      // New companies start on a free trial (its length is set on the Platform page).
      const trialDays = (await billingSettings()).trialDays;
      await c.query("INSERT INTO tenants (id, name, slug, plan, trial_ends_at) VALUES ($1,$2,$3,'trial', now() + make_interval(days => $4))", [tenantId, body.company, slug, trialDays]);
      await c.query(
        "INSERT INTO users (id, tenant_id, email, name, role, password_hash) VALUES ($1,$2,$3,$4,'admin',$5)",
        [userId, tenantId, body.email, body.name, hash],
      );
      await audit(c, tenantId, userId, 'tenant.create', 'tenant', tenantId, { slug });
    });
    const user: SessionUser = { sub: userId, tid: tenantId, role: 'admin', name: body.name };
    setSession(reply, user);
    return { user: { id: userId, name: body.name, role: 'admin', company: body.company } };
  });

  app.post('/api/auth/login', limit, async (req, reply) => {
    const body = loginBody.parse(req.body);
    const { rows } = await pool.query('SELECT * FROM auth_find_user($1)', [body.email]);
    const u = rows[0];
    // Compare against a dummy hash when the user is unknown so timing does not reveal accounts.
    const hash = u?.password_hash ?? DUMMY_HASH;
    const ok = await bcrypt.compare(body.password, hash);
    if (!u || !ok || !u.active) return reply.code(401).send({ error: 'Incorrect email or password' });
    if ((await adminPool().query('SELECT 1 FROM tenants WHERE id = $1 AND suspended_at IS NOT NULL', [u.tenant_id])).rowCount)
      return reply.code(403).send({ error: 'This company account is suspended. Contact LaborOps support.', reason: 'suspended' });
    await withTenant(u.tenant_id, (c) => audit(c, u.tenant_id, u.id, 'auth.login', 'user', u.id));
    setSession(reply, { sub: u.id, tid: u.tenant_id, role: u.role, name: u.name });
    return { user: { id: u.id, name: u.name, role: u.role } };
  });

  app.post('/api/auth/logout', async (_req, reply) => {
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', { preHandler: authenticate }, async (req) => {
    const u = req.user;
    const { company, name, rates, fieldRoles, leads } = await withTenant(u.tid, async (c) => ({
      rates: await canAdjustRates(c, u),
      company: (await c.query('SELECT name FROM tenants')).rows[0]?.name as string | undefined,
      ...(await c.query('SELECT name, field_roles FROM users WHERE id = $1', [u.sub]).then((r) => ({ name: (r.rows[0]?.name as string | undefined) ?? u.name, fieldRoles: (r.rows[0]?.field_roles ?? []) as string[] }))),
      // Lead on an event now or recently (shows the On site page).
      leads: u.role === 'crew' && !!(await c.query(
        `SELECT 1 FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id JOIN events e ON e.id = s.event_id
          WHERE a.user_id = $1 AND a.is_lead AND a.status = 'accepted' AND e.end_date >= current_date - 14 LIMIT 1`, [u.sub])).rowCount,
    }));
    return { user: { id: u.sub, name, role: u.role, company, canAdjustRates: rates, fieldRoles: u.role === 'crew' ? fieldRoles : [], leads } };
  });
}
