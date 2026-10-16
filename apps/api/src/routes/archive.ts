import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { guard } from '../auth';
import { withTenant, audit } from '../db';

export const KEEP_YEARS = 2;

/**
 * Events taken off the pipeline: invoiced after completion, canceled, or archived by hand. Kept two years so they can be
 * booked again next year (copy), then removed automatically; an admin can delete one sooner.
 */
export async function archiveRoutes(app: FastifyInstance) {
  const viewers = guard('admin', 'manager', 'hr');
  const admin = guard('admin');
  const uuid = z.object({ id: z.string().uuid() });

  app.get('/api/archive', { preHandler: viewers }, async (req) => {
    const { q } = z.object({ q: z.string().trim().max(100).optional() }).parse(req.query);
    return withTenant(req.user.tid, async (c) => ({
      keepYears: KEEP_YEARS,
      events: (
        await c.query(
          `SELECT e.id, e.name, e.venue, e.start_date::text, e.end_date::text, e.pipeline_status AS status, e.customer_id, cu.name AS customer_name,
                  e.archived_at, e.archive_reason, u.name AS archived_by_name,
                  (e.archived_at + make_interval(years => $2))::date::text AS delete_on,
                  (SELECT sum(i.total) FROM event_invoices i WHERE i.event_id = e.id)::float AS invoiced,
                  (SELECT count(*)::int FROM shifts s WHERE s.event_id = e.id) AS shift_count
             FROM events e LEFT JOIN customers cu ON cu.id = e.customer_id LEFT JOIN users u ON u.id = e.archived_by
            WHERE e.archived_at IS NOT NULL AND ($1::text IS NULL OR e.name ILIKE '%' || $1 || '%' OR cu.name ILIKE '%' || $1 || '%')
            ORDER BY e.start_date DESC, e.name LIMIT 500`,
          [q || null, KEEP_YEARS],
        )
      ).rows,
    }));
  });

  // Take an event off the pipeline by hand (for example, invoiced outside LaborOps).
  app.post('/api/events/:id/archive', { preHandler: viewers }, async (req, reply) => {
    const { id } = uuid.parse(req.params);
    const r = await withTenant(req.user.tid, async (c) => {
      const x = await c.query("UPDATE events SET archived_at = now(), archived_by = $2, archive_reason = CASE WHEN pipeline_status = 'canceled' THEN 'canceled' ELSE 'manual' END WHERE id = $1 AND archived_at IS NULL RETURNING id", [id, req.user.sub]);
      if (x.rowCount) await audit(c, req.user.tid, req.user.sub, 'event.archive', 'event', id);
      return x.rowCount;
    });
    return r ? { ok: true } : reply.code(404).send({ error: 'Event not found, or already archived' });
  });

  // Back onto the pipeline.
  app.post('/api/events/:id/restore', { preHandler: viewers }, async (req, reply) => {
    const { id } = uuid.parse(req.params);
    const r = await withTenant(req.user.tid, async (c) => {
      const x = await c.query('UPDATE events SET archived_at = NULL, archived_by = NULL, archive_reason = NULL WHERE id = $1 AND archived_at IS NOT NULL RETURNING id', [id]);
      if (x.rowCount) await audit(c, req.user.tid, req.user.sub, 'event.restore', 'event', id);
      return x.rowCount;
    });
    return r ? { ok: true } : reply.code(404).send({ error: 'Archived event not found' });
  });

  // Delete for good (admins only), before the two years are up.
  app.delete('/api/archive/:id', { preHandler: admin }, async (req, reply) => {
    const { id } = uuid.parse(req.params);
    const r = await withTenant(req.user.tid, async (c) => {
      const ev = (await c.query('SELECT name FROM events WHERE id = $1 AND archived_at IS NOT NULL', [id])).rows[0];
      if (!ev) return 0;
      await c.query('DELETE FROM events WHERE id = $1', [id]);
      await audit(c, req.user.tid, req.user.sub, 'event.delete_archived', 'event', id, { name: ev.name });
      return 1;
    });
    return r ? { ok: true } : reply.code(404).send({ error: 'Only archived events can be deleted here' });
  });
}

/** Remove archived events older than two years (daily sweep). */
export async function purgeArchive(c: import('pg').PoolClient, tenantId: string) {
  const r = await c.query(`DELETE FROM events WHERE archived_at < now() - make_interval(years => $1) RETURNING id, name`, [KEEP_YEARS]);
  for (const e of r.rows) await audit(c, tenantId, null, 'event.purge_archived', 'event', e.id, { name: e.name });
  return r.rowCount ?? 0;
}
