import { signinRoutes } from './routes/signin';
import { billingRoutes } from './routes/billing';
import { reportRoutes } from './routes/reports';
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
import { reviewRoutes } from './routes/reviews';
import { pipelineRoutes } from './routes/pipeline';
import { platformRoutes } from './routes/platform';
import { eventRoutes } from './routes/events';
import { timeRoutes } from './routes/time';
import { onsiteRoutes } from './routes/onsite';
import { skillRoutes } from './routes/skills';
import { profileRoutes } from './routes/profile';
import { notificationRoutes } from './routes/notifications';
import { messagingRoutes } from './routes/messaging';
import { academyRoutes } from './routes/academy';
import { pushRoutes } from './routes/push';
import { respondRoutes } from './routes/respond';
import { rulesRoutes } from './routes/rules';
import { groupRoutes } from './routes/groups';
import { rentmanRoutes } from './routes/rentman';
import { accountingRoutes } from './routes/accounting';
import { customerRoutes } from './routes/customers';
import { quoteRoutes } from './routes/quotes';
import { trainingRoutes } from './routes/trainings';
import { chatRoutes } from './routes/chat';
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
    if (process.env.DEBUG_ERRORS) console.error(err);
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
  await app.register(reviewRoutes);
  await app.register(pipelineRoutes);
  await app.register(platformRoutes);
  await app.register(eventRoutes);
  await app.register(timeRoutes);
  await app.register(onsiteRoutes);
  await app.register(schedulingRoutes);
  await app.register(profileRoutes);
  await app.register(skillRoutes);
  await app.register(notificationRoutes);
  await app.register(messagingRoutes);
  await app.register(academyRoutes);
  await app.register(pushRoutes);
  await app.register(chatRoutes);
  await app.register(respondRoutes);
  await app.register(rulesRoutes);
  await app.register(groupRoutes);
  await app.register(rentmanRoutes);
  await app.register(accountingRoutes);
  await app.register(customerRoutes);
  await app.register(quoteRoutes);
  await app.register(trainingRoutes);
  await app.register(billingRoutes);
  await app.register(signinRoutes);
  await app.register(reportRoutes);
  return app;
}
