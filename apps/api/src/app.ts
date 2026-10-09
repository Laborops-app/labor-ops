import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { config } from './config';
import { COOKIE } from './auth';
import { pool } from './db';
import { authRoutes } from './routes/auth';
import { crewRoutes } from './routes/crew';
import { eventRoutes } from './routes/events';
import { timeRoutes } from './routes/time';
import { skillRoutes } from './routes/skills';
import { profileRoutes } from './routes/profile';
import { schedulingRoutes } from './routes/scheduling';

export async function buildApp() {
  const app = Fastify({ logger: config.isProd || process.env.LOG === 'true', trustProxy: true });

  await app.register(cookie);
  await app.register(jwt, { secret: config.jwtSecret, cookie: { cookieName: COOKIE, signed: false } });
  await app.register(rateLimit, { global: false });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof ZodError) {
      const first = err.issues[0];
      return reply.code(400).send({ error: `${first.path.join('.') || 'request'}: ${first.message}` });
    }
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    if (err.code === '23505') return reply.code(409).send({ error: 'That already exists' });
    req.log.error(err);
    return reply.code(500).send({ error: 'Something went wrong' });
  });

  app.get('/api/health', async () => {
    await pool.query('SELECT 1');
    return { ok: true };
  });

  // Public hint used by the login page when this server is running as a demo.
  app.get('/api/demo', async () =>
    config.seedDemo
      ? {
          enabled: true,
          password: config.demoPassword,
          accounts: [
            { label: 'Labor Coordinator', email: 'manager@demo.laborops.app' },
            { label: 'Crew member', email: 'crew1@demo.laborops.app' },
          ],
        }
      : { enabled: false },
  );

  await app.register(authRoutes);
  await app.register(crewRoutes);
  await app.register(eventRoutes);
  await app.register(timeRoutes);
  await app.register(schedulingRoutes);
  await app.register(profileRoutes);
  await app.register(skillRoutes);
  return app;
}
