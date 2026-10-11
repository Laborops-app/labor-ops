import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTenant } from '../db';
import { authenticate } from '../auth';
import { vapid } from '../notify/push';

export async function pushRoutes(app: FastifyInstance) {
  app.get('/api/push/key', { preHandler: authenticate }, async () => ({ publicKey: (await vapid()).publicKey }));

  app.get('/api/push/status', { preHandler: authenticate }, async (req) =>
    withTenant(req.user.tid, async (c) => ({
      devices: (await c.query('SELECT id, user_agent, created_at FROM push_subscriptions WHERE user_id = $1 ORDER BY created_at DESC', [req.user.sub])).rows,
    })),
  );

  app.post('/api/push/subscribe', { preHandler: authenticate }, async (req) => {
    const b = z.object({
      endpoint: z.string().url().max(1000),
      keys: z.object({ p256dh: z.string().min(10).max(300), auth: z.string().min(10).max(100) }),
    }).parse(req.body);
    await withTenant(req.user.tid, async (c) => {
      // An endpoint belongs to one browser; if it was registered for someone else on this device, it moves to this user.
      await c.query('DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id <> $2', [b.endpoint, req.user.sub]);
      await c.query(
        `INSERT INTO push_subscriptions (tenant_id, user_id, endpoint, p256dh, auth, user_agent) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (endpoint) DO UPDATE SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, user_agent = EXCLUDED.user_agent`,
        [req.user.tid, req.user.sub, b.endpoint, b.keys.p256dh, b.keys.auth, String(req.headers['user-agent'] ?? '').slice(0, 200)],
      );
    });
    return { ok: true };
  });

  app.post('/api/push/unsubscribe', { preHandler: authenticate }, async (req) => {
    const b = z.object({ endpoint: z.string().url().max(1000).optional() }).parse(req.body ?? {});
    await withTenant(req.user.tid, (c) =>
      c.query('DELETE FROM push_subscriptions WHERE user_id = $1 AND ($2::text IS NULL OR endpoint = $2)', [req.user.sub, b.endpoint ?? null]),
    );
    return { ok: true };
  });
}
