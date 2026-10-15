import { adminPool } from './storage';
import { withTenant } from './db';
import type { FastifyReply, FastifyRequest } from 'fastify';

export type Role = 'admin' | 'manager' | 'crew';
export type SessionUser = { sub: string; tid: string; role: Role; name: string };

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
  if (req.user?.tid && req.user?.sub) touchSeen(req.user.tid, req.user.sub);
  if (req.user?.tid && (await isSuspended(req.user.tid))) return reply.code(403).send({ error: 'This company account is suspended. Contact LaborOps support.', reason: 'suspended' });
}

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
