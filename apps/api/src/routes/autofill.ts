import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { guard } from '../auth';
import { withTenant, audit } from '../db';
import { proposeEvent } from '../autofill';
import { assignCrew } from './events';

export async function autofillRoutes(app: FastifyInstance) {
  const mgr = guard('admin', 'manager');
  const idParam = z.object({ id: z.string().uuid() });

  // Proposed crew for the open seats on an event (or some of its shifts). Nothing is sent.
  app.post('/api/events/:id/autofill/preview', { preHandler: mgr }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const b = z.object({ shiftIds: z.array(z.string().uuid()).max(500).optional(), groupId: z.string().uuid().nullable().optional() }).parse(req.body ?? {});
    const out = await withTenant(req.user.tid, (c) => proposeEvent(c, id, b));
    return out ?? reply.code(404).send({ error: 'Event not found' });
  });

  // Send the offers the coordinator kept (or confirm them straight away).
  app.post('/api/events/:id/autofill/send', { preHandler: mgr }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const b = z.object({ offers: z.array(z.object({ shiftId: z.string().uuid(), userId: z.string().uuid() })).min(1).max(500), confirmed: z.boolean().default(false) }).parse(req.body);
    const out = await withTenant(req.user.tid, async (c) => {
      const mine = new Set((await c.query('SELECT id FROM shifts WHERE event_id = $1', [id])).rows.map((r) => r.id));
      const results: { shiftId: string; userId: string; ok: boolean; error?: string }[] = [];
      for (const o of b.offers) {
        if (!mine.has(o.shiftId)) { results.push({ ...o, ok: false, error: 'Shift is not on this event' }); continue; }
        // Each offer in its own savepoint: one that fails (filled meanwhile, a clash) doesn't undo the others.
        await c.query('SAVEPOINT af');
        try {
          const r = await assignCrew(c, req.user.tid, req.user.sub, o.shiftId, o.userId, false, b.confirmed, true);
          if (r.code >= 300) { await c.query('ROLLBACK TO SAVEPOINT af'); results.push({ ...o, ok: false, error: String(r.error ?? 'Could not add') }); }
          else { await c.query('RELEASE SAVEPOINT af'); results.push({ ...o, ok: true }); }
        } catch (e) {
          await c.query('ROLLBACK TO SAVEPOINT af');
          results.push({ ...o, ok: false, error: (e as Error).message });
        }
      }
      await audit(c, req.user.tid, req.user.sub, 'event.autofill', 'event', id, { sent: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, confirmed: b.confirmed });
      return results;
    });
    const sent = out.filter((r) => r.ok).length;
    return reply.send({ sent, failed: out.filter((r) => !r.ok), results: out });
  });
}
