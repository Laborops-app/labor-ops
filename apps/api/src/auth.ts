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
}

/** preHandler list: must be signed in and hold one of the roles. */
export function guard(...roles: Role[]) {
  return [
    authenticate,
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!roles.includes(req.user.role)) return reply.code(403).send({ error: 'Not allowed for your role' });
    },
  ];
}
