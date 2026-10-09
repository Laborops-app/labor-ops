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

export async function authenticate(req: FastifyRequest, reply: FastifyReply) {
  try {
    await req.jwtVerify();
  } catch {
    return reply.code(401).send({ error: 'Not signed in' });
  }
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
