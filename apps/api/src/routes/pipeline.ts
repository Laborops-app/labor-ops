import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTenant, audit } from '../db';
import { guard } from '../auth';
import { STATUSES, autoAdvance, setStatus, timesheetGaps } from '../pipeline';

const mgr = guard('admin', 'manager', 'hr');

/**
 * The event pipeline board: every event as a card in its column (Pending, Quote, Confirmed, In progress, Completed,
 * Canceled) with where the crew is at and what is left to wrap up.
 */
export async function pipelineRoutes(app: FastifyInstance) {
  app.get('/api/pipeline', { preHandler: mgr }, async (req) => {
    const q = z
      .object({ range: z.enum(['upcoming', '30d', 'month', 'all']).default('upcoming'), customerId: z.string().uuid().optional(), mine: z.enum(['1']).optional() })
      .parse(req.query);
    return withTenant(req.user.tid, async (c) => {
      await autoAdvance(c, req.user.tid);
      // Archived events (invoiced or canceled) live on the Archive page, not the board.
      const where: string[] = ['e.archived_at IS NULL'];
      const args: unknown[] = [];
      // "Upcoming" keeps anything still open (not completed or canceled) plus what finished in the last two weeks.
      if (q.range === 'upcoming') where.push("(e.end_date >= current_date - 14 OR e.pipeline_status NOT IN ('completed', 'canceled'))");
      if (q.range === '30d') where.push('e.start_date <= current_date + 30 AND e.end_date >= current_date');
      if (q.range === 'month') where.push("e.start_date <= (date_trunc('month', current_date) + interval '1 month - 1 day')::date AND e.end_date >= date_trunc('month', current_date)::date");
      if (q.customerId) where.push(`e.customer_id = $${args.push(q.customerId)}`);
      if (q.mine) where.push(`e.created_by = $${args.push(req.user.sub)}`);
      const events = (
        await c.query(
          `SELECT e.id, e.name, e.client, e.venue, e.start_date::text, e.end_date::text, e.pipeline_status AS status, e.priority,
                  e.status_changed_at, e.board_position, e.customer_id, cu.name AS customer_name, e.created_by,
                  st.slots, st.filled, st.accepted, st.waiting, st.shift_count,
                  (SELECT count(*)::int FROM time_entries t JOIN shift_assignments a ON a.id = t.assignment_id JOIN shifts s ON s.id = a.shift_id
                    WHERE s.event_id = e.id AND t.clock_out IS NULL) AS on_clock,
                  (SELECT count(*)::int FROM time_entries t JOIN shift_assignments a ON a.id = t.assignment_id JOIN shifts s ON s.id = a.shift_id
                    WHERE s.event_id = e.id AND t.status = 'submitted') AS to_approve,
                  (SELECT count(*)::int FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id
                    WHERE s.event_id = e.id AND a.status = 'accepted' AND s.ends_at < now()
                      AND NOT EXISTS (SELECT 1 FROM crew_reviews r WHERE r.user_id = a.user_id AND r.shift_id = s.id)) AS to_rate,
                  EXISTS (SELECT 1 FROM event_invoices i WHERE i.event_id = e.id) AS invoiced,
                  (SELECT count(*)::int FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id
                    WHERE s.event_id = e.id AND a.status = 'accepted' AND s.ends_at <= now() AND a.no_show_at IS NULL
                      AND NOT EXISTS (SELECT 1 FROM time_entries t WHERE t.assignment_id = a.id)) AS missing_time,
                  (SELECT count(*)::int FROM chat_messages m JOIN chat_channels ch ON ch.id = m.channel_id WHERE ch.event_id = e.id AND ch.kind = 'event' AND m.deleted_at IS NULL) AS messages,
                  (SELECT json_build_object('id', qq.id, 'number', qq.number, 'status', qq.status)
                     FROM quotes qq WHERE qq.event_id = e.id ORDER BY (qq.status = 'accepted') DESC, qq.created_at DESC LIMIT 1) AS quote,
                  COALESCE((SELECT json_agg(x) FROM (
                     SELECT DISTINCT ON (u.id) u.id, u.name, a.status FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id JOIN users u ON u.id = a.user_id
                      WHERE s.event_id = e.id AND a.status <> 'declined' ORDER BY u.id, (a.status = 'accepted') DESC) x), '[]'::json) AS crew
             FROM events e
             LEFT JOIN customers cu ON cu.id = e.customer_id
             LEFT JOIN LATERAL (
               SELECT count(*)::int AS shift_count, COALESCE(sum(s.headcount), 0)::int AS slots,
                      COALESCE(sum(LEAST(s.headcount, (SELECT count(*) FROM shift_assignments a WHERE a.shift_id = s.id AND a.status <> 'declined'))), 0)::int AS filled,
                      (SELECT count(*)::int FROM shift_assignments a JOIN shifts s2 ON s2.id = a.shift_id WHERE s2.event_id = e.id AND a.status = 'accepted') AS accepted,
                      (SELECT count(*)::int FROM shift_assignments a JOIN shifts s2 ON s2.id = a.shift_id WHERE s2.event_id = e.id AND a.status IN ('offered', 'pending')) AS waiting
                 FROM shifts s WHERE s.event_id = e.id) st ON true
            ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
            ORDER BY e.board_position NULLS LAST, e.start_date, e.name`,
          args,
        )
      ).rows;
      const team = (await c.query("SELECT id, name, role FROM users WHERE role IN ('admin', 'manager', 'hr') AND active ORDER BY role, name")).rows;
      return { events, team };
    });
  });

  // Move a card (column and/or place in the column) or change its priority.
  app.patch('/api/events/:id/pipeline', { preHandler: mgr }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z
      .object({
        status: z.enum(STATUSES).optional(),
        priority: z.enum(['low', 'medium', 'high']).optional(),
        // The column's card ids top to bottom after the move, so the order sticks.
        order: z.array(z.string().uuid()).max(500).optional(),
      })
      .parse(req.body);
    const out = await withTenant(req.user.tid, async (c) => {
      const ev = (await c.query('SELECT id, pipeline_status, priority FROM events WHERE id = $1', [id])).rows[0];
      if (!ev) return null;
      // Completed means every timesheet is in: nobody still clocked in, no worked shift without time.
      if (b.status === 'completed' && ev.pipeline_status !== 'completed') {
        const gaps = await timesheetGaps(c, id);
        if (!gaps.ok) return { blocked: gaps } as const;
      }
      if (b.status) await setStatus(c, req.user.tid, id, b.status, req.user.sub, null);
      if (b.priority && b.priority !== ev.priority) {
        await c.query('UPDATE events SET priority = $2 WHERE id = $1', [id, b.priority]);
        await audit(c, req.user.tid, req.user.sub, 'event.priority', 'event', id, { priority: b.priority });
      }
      if (b.order?.length) {
        if (!b.order.includes(id)) return 'bad' as const;
        await c.query('UPDATE events e SET board_position = o.n FROM unnest($1::uuid[]) WITH ORDINALITY AS o(id, n) WHERE e.id = o.id', [b.order]);
      }
      return (await c.query('SELECT pipeline_status AS status, priority, status_changed_at, board_position FROM events WHERE id = $1', [id])).rows[0];
    });
    if (out === 'bad') return reply.code(400).send({ error: 'The order must include the card that moved' });
    if (out && 'blocked' in out) {
      const g = out.blocked!;
      return reply.code(409).send({ error: g.message, reason: 'timesheets_incomplete', open: g.open, missing: g.missing, upcoming: g.upcoming });
    }
    return out ?? reply.code(404).send({ error: 'Event not found' });
  });

  // History of moves for one event.
  app.get('/api/events/:id/pipeline-log', { preHandler: mgr }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return withTenant(req.user.tid, async (c) => ({
      log: (
        await c.query(
          `SELECT l.from_status, l.to_status, l.reason, l.created_at, u.name AS changed_by_name
             FROM event_status_log l LEFT JOIN users u ON u.id = l.changed_by WHERE l.event_id = $1 ORDER BY l.created_at DESC LIMIT 50`,
          [id],
        )
      ).rows,
    }));
  });
}
