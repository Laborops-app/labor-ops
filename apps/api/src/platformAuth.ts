import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config';
import { adminPool } from './storage';

/**
 * Platform console accounts. These people run LaborOps itself; they do not belong to any company.
 * They sign in at /platform/login with their own session cookie, separate from the company app's.
 */
export const PCOOKIE = 'lo_platform';
export const SESSION_HOURS = 8;
export type PlatformUser = { id: string; email: string; name: string };

declare module 'fastify' {
  interface FastifyRequest {
    platformUser?: PlatformUser;
  }
}

const sha = (t: string) => crypto.createHash('sha256').update(t).digest('hex');
export const setupLink = (raw: string) => `${config.platformUrl}/platform/setup?token=${raw}`;

/**
 * Create (or reopen) a platform account and return a one-time link where its owner sets their name and password.
 * The same link resets a forgotten password. Valid for 72 hours; issuing a new one voids the old one.
 */
export async function issueSetup(email: string, name = '', invitedBy: string | null = null) {
  const raw = crypto.randomBytes(32).toString('base64url');
  const r = await adminPool().query(
    `INSERT INTO platform_users (email, name, invited_by, setup_hash, setup_expires_at) VALUES (lower($1), $2, $3, $4, now() + interval '72 hours')
     ON CONFLICT (lower(email)) DO UPDATE SET setup_hash = EXCLUDED.setup_hash, setup_expires_at = EXCLUDED.setup_expires_at, active = true,
       name = CASE WHEN platform_users.name = '' THEN EXCLUDED.name ELSE platform_users.name END
     RETURNING id, email, name, password_hash IS NOT NULL AS has_password`,
    [email.trim(), name.trim(), invitedBy, sha(raw)],
  );
  forgetPlatformUser(r.rows[0].id);
  return { user: r.rows[0] as { id: string; email: string; name: string; has_password: boolean }, link: setupLink(raw) };
}

export async function findSetup(raw: string) {
  return (
    await adminPool().query('SELECT id, email, name, password_hash IS NOT NULL AS has_password FROM platform_users WHERE setup_hash = $1 AND setup_expires_at > now() AND active', [sha(raw)])
  ).rows[0] as { id: string; email: string; name: string; has_password: boolean } | undefined;
}

export async function audit(actorId: string | null, action: string, tenantId: string | null = null, detail: unknown = null) {
  await adminPool().query('INSERT INTO platform_audit (actor_id, action, tenant_id, detail) VALUES ($1,$2,$3,$4)', [actorId, action, tenantId, detail == null ? null : JSON.stringify(detail)]);
}

// Who a session belongs to, re-checked at most every 30 seconds so removing someone takes effect quickly.
const cache = new Map<string, { u: PlatformUser | null; at: number }>();
export const forgetPlatformUser = (id: string) => cache.delete(id);
async function loadUser(id: string) {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < 30_000) return hit.u;
  const u = (await adminPool().query('SELECT id, email, name FROM platform_users WHERE id = $1 AND active AND password_hash IS NOT NULL', [id])).rows[0] ?? null;
  cache.set(id, { u, at: Date.now() });
  return u as PlatformUser | null;
}

/** preHandler for every /api/platform route except sign-in: a valid platform session cookie. */
export async function platformGuard(req: FastifyRequest, reply: FastifyReply) {
  const token = req.cookies?.[PCOOKIE];
  if (!token) return reply.code(401).send({ error: 'Not signed in to the platform console' });
  let p: any;
  try {
    p = req.server.jwt.verify(token);
  } catch {
    return reply.code(401).send({ error: 'Your platform session has ended. Sign in again.' });
  }
  if (p?.kind !== 'platform' || !p.sub) return reply.code(401).send({ error: 'Not signed in to the platform console' });
  const u = await loadUser(p.sub);
  if (!u) return reply.code(401).send({ error: 'This platform account is no longer active' });
  req.platformUser = u;
}
