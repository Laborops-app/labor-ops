import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withTenant } from '../db';
import { authenticate } from '../auth';
import { config } from '../config';
import { adminPool, getObject, moveFilesToStorage, storageEnabled, storageStatus } from '../storage';
import { nightly } from '../backup';

/** Is this signed-in person one of the platform operators (PLATFORM_ADMINS)? Company admins are not, unless listed. */
export async function isPlatformAdmin(tid: string, uid: string) {
  if (!config.platformAdmins.length) return false;
  const email = (await withTenant(tid, (c) => c.query("SELECT email FROM users WHERE id = $1 AND role = 'admin'", [uid]))).rows[0]?.email;
  return !!email && config.platformAdmins.includes(String(email).toLowerCase());
}

const platform = async (req: FastifyRequest, reply: FastifyReply) => {
  await authenticate(req, reply);
  if (reply.sent) return;
  if (!(await isPlatformAdmin(req.user.tid, req.user.sub))) return reply.code(403).send({ error: 'Only the platform operators can see storage and backups' });
};

let running: Promise<unknown> | null = null;
let lastRun: { at: string; result: unknown } | null = null;

export async function platformRoutes(app: FastifyInstance) {
  app.get('/api/platform/storage', { preHandler: platform }, async () => {
    const backups = (await adminPool().query('SELECT id, bucket, key, size, kind, status, error, started_at, finished_at FROM platform_backups ORDER BY started_at DESC LIMIT 60')).rows;
    return {
      storage: await storageStatus(),
      backups,
      schedule: { enabled: config.backups.enabled && storageEnabled(), hourUtc: config.backups.hourUtc, keepDaily: config.backups.keepDaily, keepWeekly: config.backups.keepWeekly, keepMonthly: config.backups.keepMonthly },
      running: !!running,
      lastRun,
    };
  });

  // Run the nightly job now (database backup, copy of uploads, pruning). It keeps running after the response.
  app.post('/api/platform/backups', { preHandler: platform }, async (_req, reply) => {
    if (!storageEnabled()) return reply.code(409).send({ error: 'Object storage is not configured on the server' });
    if (running) return reply.code(409).send({ error: 'A backup is already running' });
    running = nightly('manual')
      .then((r) => (lastRun = { at: new Date().toISOString(), result: r }))
      .catch((e) => (lastRun = { at: new Date().toISOString(), result: { error: String(e?.message ?? e) } }))
      .finally(() => (running = null));
    return reply.code(202).send({ started: true });
  });

  app.post('/api/platform/storage/move', { preHandler: platform }, async (_req, reply) => {
    if (!storageEnabled()) return reply.code(409).send({ error: 'Object storage is not configured on the server' });
    return { moved: await moveFilesToStorage() };
  });

  // Download one database backup (for restoring somewhere else).
  app.get('/api/platform/backups/:id/download', { preHandler: platform }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = (await adminPool().query("SELECT key FROM platform_backups WHERE id = $1 AND status = 'done'", [id])).rows[0];
    if (!b) return reply.code(404).send({ error: 'Backup not found' });
    reply.header('content-type', 'application/octet-stream');
    reply.header('content-disposition', `attachment; filename="${b.key.split('/').pop()}"`);
    reply.header('cache-control', 'no-store');
    return reply.send(await getObject('backups', b.key));
  });
}
