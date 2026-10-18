import { adminPool } from './storage';
import { withTenant } from './db';
import type { FastifyReply, FastifyRequest } from 'fastify';

export type Role = 'admin' | 'manager' | 'crew' | 'hr' | 'client';
export type SessionUser = { sub: string; tid: string; role: Role; name: string; customerId?: string | null };

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: SessionUser;
    user: SessionUser;
  }
}

export const COOKIE = 'lo_token';

// "Online" in chat: when each person last used the app. Written at most once a minute per person per server.
const seen = new Map<string, number>();
function touchSeen(tid: string, uid: string) {
  const now = Date.now();
  if ((seen.get(uid) ?? 0) > now - 60_000) return;
  seen.set(uid, now);
  if (seen.size > 5000) for (const [k, t] of seen) if (t < now - 120_000) seen.delete(k);
  withTenant(tid, (c) => c.query('UPDATE users SET last_seen_at = now() WHERE id = $1', [uid])).catch(() => seen.delete(uid));
}

export async function authenticate(req: FastifyRequest, reply: FastifyReply) {
  try {
    await req.jwtVerify();
  } catch {
    return reply.code(401).send({ error: 'Not signed in' });
  }
  // A platform console session is not a company session.
  if (!req.user?.tid || (req.user as any).kind === 'platform') return reply.code(401).send({ error: 'Not signed in' });
  if (req.user?.tid && req.user?.sub) touchSeen(req.user.tid, req.user.sub);
  // The role and active flag are read from the database (cached briefly), so a role change or a deactivation
  // takes effect right away instead of when the sign-in expires.
  const cur = await currentUser(req.user.tid, req.user.sub);
  if (!cur || !cur.active) return reply.code(401).send({ error: 'Not signed in' });
  req.user.role = cur.role;
  req.user.customerId = cur.customerId;
  // Client (customer) accounts only reach the portal and their own account; every other endpoint is closed to them.
  if (cur.role === 'client' && !clientMayUse(req.routeOptions?.url ?? req.url)) return reply.code(403).send({ error: 'Not allowed for your role' });
  if (req.user?.tid && (await isSuspended(req.user.tid))) return reply.code(403).send({ error: 'This company account is suspended. Contact LaborOps support.', reason: 'suspended' });
}

const CLIENT_OK = ['/api/client/', '/api/auth/', '/api/notifications', '/api/my/notification-prefs', '/api/my/password', '/api/passkeys', '/api/push/'];
const clientMayUse = (url: string) => CLIENT_OK.some((p) => url === p.replace(/\/$/, '') || url.startsWith(p));

const users = new Map<string, { role: Role; active: boolean; customerId: string | null; at: number }>();
async function currentUser(tid: string, uid: string) {
  const hit = users.get(uid);
  if (hit && Date.now() - hit.at < 15_000) return hit;
  const r = (await adminPool().query('SELECT role, active, customer_id FROM users WHERE id = $1 AND tenant_id = $2', [uid, tid])).rows[0];
  if (!r) {
    users.delete(uid);
    return null;
  }
  const v = { role: r.role as Role, active: !!r.active, customerId: (r.customer_id as string | null) ?? null, at: Date.now() };
  users.set(uid, v);
  if (users.size > 20000) users.clear();
  return v;
}
/** Call after changing someone's role or deactivating them. */
export const forgetUser = (uid: string) => users.delete(uid);

// Suspended companies (Platform page) are locked out; checked at most every 30 seconds per company.
const suspended = new Map<string, { v: boolean; at: number }>();
async function isSuspended(tid: string) {
  const hit = suspended.get(tid);
  if (hit && Date.now() - hit.at < 30_000) return hit.v;
  const v = !!(await adminPool().query('SELECT 1 FROM tenants WHERE id = $1 AND suspended_at IS NOT NULL', [tid]).catch(() => ({ rowCount: 0 }))).rowCount;
  suspended.set(tid, { v, at: Date.now() });
  return v;
}
export const forgetSuspension = (tid: string) => suspended.delete(tid);

/** preHandler list: must be signed in and hold one of the roles. */
export function guard(...roles: Role[]) {
  return [
    authenticate,
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!roles.includes(req.user.role)) return reply.code(403).send({ error: 'Not allowed for your role' });
    },
  ];
}
