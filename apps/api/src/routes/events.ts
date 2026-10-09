import { notify, describeShift } from '../notify';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTenant, audit } from '../db';
import { guard } from '../auth';
import { evaluateShift } from '../eligibility';

const id = z.object({ id: z.string().uuid() });
const eventBody = z.object({
  name: z.string().trim().min(1).max(150),
  venue: z.string().trim().max(200).optional().nullable(),
  address: z.string().trim().max(300).optional().nullable(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  notes: z.string().max(5000).optional().nullable(),
});
const shiftBody = z.object({
  roleName: z.string().trim().min(1).max(100),
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }),
  headcount: z.number().int().min(1).max(500).default(1),
  isOpen: z.boolean().default(false),
  requiredCerts: z.array(z.string().trim().min(1).max(60)).max(10).default([]),
});

const mgr = guard('admin', 'manager');

export async function eventRoutes(app: FastifyInstance) {
  app.get('/api/events', { preHandler: mgr }, async (req) =>
    withTenant(req.user.tid, async (c) => ({
      events: (
        await c.query(`
          SELECT e.id, e.name, e.venue, e.start_date, e.end_date,
            (SELECT count(*)::int FROM shifts s WHERE s.event_id = e.id) AS shift_count,
            (SELECT COALESCE(sum(s.headcount),0)::int FROM shifts s WHERE s.event_id = e.id) AS slots,
            (SELECT count(*)::int FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id
               WHERE s.event_id = e.id AND a.status = 'accepted') AS accepted
          FROM events e ORDER BY e.start_date DESC, e.name`)
      ).rows,
    })),
  );

  app.get('/api/calendar', { preHandler: mgr }, async (req, reply) => {
    const q = z
      .object({ from: z.string().datetime({ offset: true }), to: z.string().datetime({ offset: true }) })
      .safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'from and to are required (ISO date-times)' });
    const { from, to } = q.data;
    if (new Date(to).getTime() - new Date(from).getTime() > 62 * 86400000) return reply.code(400).send({ error: 'Range too large' });
    const rows = await withTenant(req.user.tid, async (c) =>
      (
        await c.query(
          `SELECT s.id, s.role_name, s.starts_at, s.ends_at, s.headcount, e.id AS event_id, e.name AS event_name, e.venue,
              (SELECT count(*)::int FROM shift_assignments a WHERE a.shift_id = s.id AND a.status <> 'declined') AS filled
           FROM shifts s JOIN events e ON e.id = s.event_id
           WHERE s.starts_at >= $1 AND s.starts_at < $2 ORDER BY s.starts_at, e.name`,
          [from, to],
        )
      ).rows,
    );
    return { shifts: rows };
  });

  app.post('/api/events', { preHandler: mgr }, async (req, reply) => {
    const b = eventBody.parse(req.body);
    if (b.endDate < b.startDate) return reply.code(400).send({ error: 'End date is before the start date' });
    const row = await withTenant(req.user.tid, async (c) => {
      const r = await c.query(
        `INSERT INTO events (tenant_id, name, venue, address, start_date, end_date, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [req.user.tid, b.name, b.venue ?? null, b.address || null, b.startDate, b.endDate, b.notes ?? null, req.user.sub],
      );
      await audit(c, req.user.tid, req.user.sub, 'event.create', 'event', r.rows[0].id);
      return r.rows[0];
    });
    return reply.code(201).send({ event: row });
  });

  app.get('/api/events/:id', { preHandler: mgr }, async (req, reply) => {
    const { id: eventId } = id.parse(req.params);
    const out = await withTenant(req.user.tid, async (c) => {
      const ev = (await c.query('SELECT * FROM events WHERE id = $1', [eventId])).rows[0];
      if (!ev) return null;
      const shifts = (await c.query('SELECT * FROM shifts WHERE event_id = $1 ORDER BY starts_at, role_name', [eventId])).rows;
      const assigns = (
        await c.query(
          `SELECT a.id, a.shift_id, a.user_id, a.status, u.name AS user_name
           FROM shift_assignments a JOIN users u ON u.id = a.user_id
           JOIN shifts s ON s.id = a.shift_id WHERE s.event_id = $1 ORDER BY u.name`,
          [eventId],
        )
      ).rows;
      const out = [];
      for (const s of shifts) {
        out.push({ ...s, assignments: assigns.filter((a) => a.shift_id === s.id), crew_status: await evaluateShift(c, s.id) });
      }
      return { event: ev, shifts: out };
    });
    if (!out) return reply.code(404).send({ error: 'Event not found' });
    return out;
  });

  app.delete('/api/events/:id', { preHandler: mgr }, async (req, reply) => {
    const { id: eventId } = id.parse(req.params);
    const n = await withTenant(req.user.tid, async (c) => {
      const r = await c.query('DELETE FROM events WHERE id = $1', [eventId]);
      if (r.rowCount) await audit(c, req.user.tid, req.user.sub, 'event.delete', 'event', eventId);
      return r.rowCount;
    });
    return n ? { ok: true } : reply.code(404).send({ error: 'Event not found' });
  });

  app.post('/api/events/:id/shifts', { preHandler: mgr }, async (req, reply) => {
    const { id: eventId } = id.parse(req.params);
    const b = shiftBody.parse(req.body);
    if (new Date(b.endsAt) <= new Date(b.startsAt)) return reply.code(400).send({ error: 'Shift must end after it starts' });
    const row = await withTenant(req.user.tid, async (c) => {
      if (!(await c.query('SELECT 1 FROM events WHERE id = $1', [eventId])).rowCount) return null;
      const r = await c.query(
        `INSERT INTO shifts (tenant_id, event_id, role_name, starts_at, ends_at, headcount, is_open, required_certs)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [req.user.tid, eventId, b.roleName, b.startsAt, b.endsAt, b.headcount, b.isOpen, b.requiredCerts],
      );
      await audit(c, req.user.tid, req.user.sub, 'shift.create', 'shift', r.rows[0].id);
      return r.rows[0];
    });
    if (!row) return reply.code(404).send({ error: 'Event not found' });
    return reply.code(201).send({ shift: row });
  });

  app.delete('/api/shifts/:id', { preHandler: mgr }, async (req, reply) => {
    const { id: shiftId } = id.parse(req.params);
    const n = await withTenant(req.user.tid, async (c) => {
      const d = await describeShift(c, req.user.tid, shiftId);
      const crew = d ? (await c.query("SELECT user_id FROM shift_assignments WHERE shift_id = $1 AND status <> 'declined'", [shiftId])).rows : [];
      const r = await c.query('DELETE FROM shifts WHERE id = $1', [shiftId]);
      if (r.rowCount && d)
        await notify(c, req.user.tid, crew.map((x) => ({
          userId: x.user_id, category: 'shift_change' as const, title: `Shift cancelled: ${d.role}`,
          body: `${d.line}\n\nThis shift was cancelled.`, link: '/my-shifts', sms: `Shift cancelled: ${d.role}, ${d.event}, ${d.when}.`,
        })));
      if (r.rowCount) await audit(c, req.user.tid, req.user.sub, 'shift.delete', 'shift', shiftId);
      return r.rowCount;
    });
    return n ? { ok: true } : reply.code(404).send({ error: 'Shift not found' });
  });

  // Assign crew to a shift. Blocks double-booking and over-filling.
  app.post('/api/shifts/:id/assign', { preHandler: mgr }, async (req, reply) => {
    const { id: shiftId } = id.parse(req.params);
    const { userId, override } = z.object({ userId: z.string().uuid(), override: z.boolean().optional() }).parse(req.body);
    const result = await withTenant(req.user.tid, async (c) => {
      const shift = (await c.query('SELECT * FROM shifts WHERE id = $1 FOR UPDATE', [shiftId])).rows[0];
      if (!shift) return { code: 404, error: 'Shift not found' };
      const user = (await c.query("SELECT id, name, active FROM users WHERE id = $1 AND role = 'crew'", [userId])).rows[0];
      if (!user || !user.active) return { code: 404, error: 'Crew member not found or inactive' };

      const filled = (
        await c.query("SELECT count(*)::int AS n FROM shift_assignments WHERE shift_id = $1 AND status <> 'declined'", [shiftId])
      ).rows[0].n;
      if (filled >= shift.headcount) return { code: 409, error: 'This shift is already full' };

      const clash = (
        await c.query(
          `SELECT e.name AS event_name, s.role_name, s.starts_at, s.ends_at
           FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id JOIN events e ON e.id = s.event_id
           WHERE a.user_id = $1 AND a.status <> 'declined' AND s.id <> $2
             AND tstzrange(s.starts_at, s.ends_at) && tstzrange($3::timestamptz, $4::timestamptz)
           LIMIT 1`,
          [userId, shiftId, shift.starts_at, shift.ends_at],
        )
      ).rows[0];
      if (clash)
        return {
          code: 409,
          error: `${user.name} is already booked for ${clash.role_name} at ${clash.event_name} during that time`,
          conflict: clash,
        };

      const dup = await c.query('SELECT 1 FROM shift_assignments WHERE shift_id = $1 AND user_id = $2', [shiftId, userId]);
      if (dup.rowCount) return { code: 409, error: `${user.name} is already on this shift` };

      const [el] = await evaluateShift(c, shiftId, userId);
      if (el?.missing_certs.length)
        return { code: 409, error: `${user.name} does not have a valid ${el.missing_certs.join(', ')} certificate for that shift`, reason: 'missing_cert' };
      if ((el?.time_off || el?.outside_availability) && !override)
        return {
          code: 409,
          error: `${user.name} is ${el.time_off ? 'on time off' : 'outside their weekly availability'} for that shift.`,
          reason: 'unavailable',
        };

      const a = (
        await c.query(
          'INSERT INTO shift_assignments (tenant_id, shift_id, user_id) VALUES ($1,$2,$3) RETURNING *',
          [req.user.tid, shiftId, userId],
        )
      ).rows[0];
      await audit(c, req.user.tid, req.user.sub, 'assignment.create', 'assignment', a.id, { shiftId, userId });
      const d = await describeShift(c, req.user.tid, shiftId);
      if (d)
        await notify(c, req.user.tid, {
          userId, category: 'assignment', title: `New shift offered: ${d.role}`,
          body: `${d.line}\n\nOpen the shift to accept or decline.`,
          link: `/my-shifts/${a.id}`, sms: `New shift offered: ${d.role}, ${d.event}, ${d.when}. Open the app to accept.`,
        });
      return { code: 201, assignment: a };
    });
    const { code, ...body } = result as { code: number; [k: string]: unknown };
    return reply.code(code).send(body);
  });

  app.delete('/api/assignments/:id', { preHandler: mgr }, async (req, reply) => {
    const { id: aId } = id.parse(req.params);
    const n = await withTenant(req.user.tid, async (c) => {
      const prev = (await c.query('SELECT user_id, shift_id FROM shift_assignments WHERE id = $1', [aId])).rows[0];
      const r = await c.query('DELETE FROM shift_assignments WHERE id = $1', [aId]);
      if (r.rowCount && prev) {
        const d = await describeShift(c, req.user.tid, prev.shift_id);
        if (d)
          await notify(c, req.user.tid, {
            userId: prev.user_id, category: 'shift_change', title: `Removed from shift: ${d.role}`,
            body: `${d.line}\n\nYou were removed from this shift.`, link: '/my-shifts', sms: `You were removed from ${d.role}, ${d.event}, ${d.when}.`,
          });
      }
      if (r.rowCount) await audit(c, req.user.tid, req.user.sub, 'assignment.delete', 'assignment', aId);
      return r.rowCount;
    });
    return n ? { ok: true } : reply.code(404).send({ error: 'Assignment not found' });
  });

  app.get('/api/dashboard', { preHandler: mgr }, async (req) =>
    withTenant(req.user.tid, async (c) => {
      const one = async (sql: string) => (await c.query(sql)).rows[0].n as number;
      return {
        crewCount: await one("SELECT count(*)::int AS n FROM users WHERE role = 'crew' AND active"),
        upcomingShifts: await one('SELECT count(*)::int AS n FROM shifts WHERE ends_at > now()'),
        openSlots: await one(`SELECT COALESCE(sum(GREATEST(s.headcount - (
            SELECT count(*) FROM shift_assignments a WHERE a.shift_id = s.id AND a.status <> 'declined'), 0)),0)::int AS n
          FROM shifts s WHERE s.ends_at > now()`),
        pendingApprovals: await one("SELECT count(*)::int AS n FROM time_entries WHERE status = 'submitted'"),
        pendingRequests: await one(
          "SELECT ((SELECT count(*) FROM shift_assignments WHERE status = 'pending') + (SELECT count(*) FROM shift_swaps WHERE status = 'pending'))::int AS n",
        ),
        hoursScheduled: Math.round(
          Number(
            (
              await c.query(`SELECT COALESCE(sum(EXTRACT(EPOCH FROM (s.ends_at - s.starts_at)) / 3600),0)::float AS n
                FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id
                WHERE a.status <> 'declined' AND s.ends_at > now() AND s.starts_at < now() + interval '7 days'`)
            ).rows[0].n,
          ),
        ),
        upcoming: (
          await c.query(`SELECT s.id, s.role_name, s.starts_at, s.ends_at, s.headcount, e.id AS event_id, e.name AS event_name, e.venue,
              (SELECT count(*)::int FROM shift_assignments a WHERE a.shift_id = s.id AND a.status <> 'declined') AS filled,
              COALESCE((SELECT json_agg(x.name) FROM (SELECT u.name FROM shift_assignments a JOIN users u ON u.id = a.user_id
                WHERE a.shift_id = s.id AND a.status <> 'declined' ORDER BY u.name LIMIT 4) x), '[]'::json) AS crew
            FROM shifts s JOIN events e ON e.id = s.event_id
            WHERE s.ends_at > now() ORDER BY s.starts_at LIMIT 12`)
        ).rows,
        clockedIn: (
          await c.query(`SELECT u.name, t.clock_in, s.role_name, e.name AS event_name
            FROM time_entries t JOIN users u ON u.id = t.user_id
            JOIN shift_assignments a ON a.id = t.assignment_id JOIN shifts s ON s.id = a.shift_id
            JOIN events e ON e.id = s.event_id WHERE t.clock_out IS NULL ORDER BY t.clock_in`)
        ).rows,
      };
    }),
  );
}
