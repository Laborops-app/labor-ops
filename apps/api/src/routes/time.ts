import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTenant, audit } from '../db';
import { authenticate, guard } from '../auth';

const uuid = z.string().uuid();
const mgr = guard('admin', 'manager');

// Spreadsheet apps run text starting with these characters as formulas.
const csvCell = (v: unknown) => {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const ENTRY_SQL = `
  SELECT t.id, t.status, t.clock_in, t.clock_out, t.approved_at,
    ROUND(EXTRACT(EPOCH FROM (COALESCE(t.clock_out, now()) - t.clock_in)) / 3600.0, 2)::float AS hours,
    u.id AS user_id, u.name AS user_name, u.email AS user_email,
    s.role_name, e.name AS event_name, ap.name AS approved_by_name
  FROM time_entries t
  JOIN users u ON u.id = t.user_id
  JOIN shift_assignments a ON a.id = t.assignment_id
  JOIN shifts s ON s.id = a.shift_id
  JOIN events e ON e.id = s.event_id
  LEFT JOIN users ap ON ap.id = t.approved_by`;

export async function timeRoutes(app: FastifyInstance) {
  // ----- crew: my shifts -----
  app.get('/api/my/shifts', { preHandler: authenticate }, async (req) =>
    withTenant(req.user.tid, async (c) => ({
      shifts: (
        await c.query(
          `SELECT a.id AS assignment_id, a.status, s.role_name, s.starts_at, s.ends_at,
             e.name AS event_name, e.venue,
             (SELECT w.status FROM shift_swaps w WHERE w.assignment_id = a.id AND w.status IN ('open','pending') LIMIT 1) AS swap_status,
             (SELECT w.id FROM shift_swaps w WHERE w.assignment_id = a.id AND w.status IN ('open','pending') LIMIT 1) AS swap_id,
             (a.status = 'accepted' AND s.starts_at > now() AND NOT EXISTS (SELECT 1 FROM time_entries t WHERE t.assignment_id = a.id)) AS can_offer_swap,
             EXISTS (SELECT 1 FROM time_entries t WHERE t.assignment_id = a.id AND t.clock_out IS NULL) AS clocked_in,
             (a.status = 'accepted' AND now() BETWEEN s.starts_at - interval '1 hour' AND s.ends_at + interval '2 hours') AS can_clock_in
           FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id JOIN events e ON e.id = s.event_id
           WHERE a.user_id = $1 AND (s.ends_at > now() - interval '12 hours')
           ORDER BY s.starts_at`,
          [req.user.sub],
        )
      ).rows,
    })),
  );

  app.get('/api/my/calendar', { preHandler: authenticate }, async (req, reply) => {
    const q = z.object({ from: z.string().datetime({ offset: true }), to: z.string().datetime({ offset: true }) }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'from and to are required (ISO date-times)' });
    if (new Date(q.data.to).getTime() - new Date(q.data.from).getTime() > 62 * 86400000) return reply.code(400).send({ error: 'Range too large' });
    return withTenant(req.user.tid, async (c) => ({
      shifts: (
        await c.query(
          `SELECT a.id AS assignment_id, a.status, s.role_name, s.starts_at, s.ends_at, e.name AS event_name, e.venue
           FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id JOIN events e ON e.id = s.event_id
           WHERE a.user_id = $1 AND a.status <> 'declined' AND s.starts_at >= $2 AND s.starts_at < $3
           ORDER BY s.starts_at`,
          [req.user.sub, q.data.from, q.data.to],
        )
      ).rows,
    }));
  });

  app.get('/api/my/assignments/:id', { preHandler: authenticate }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const out = await withTenant(req.user.tid, async (c) => {
      const me = (
        await c.query(
          `SELECT a.id AS assignment_id, a.status, s.id AS shift_id, s.role_name, s.starts_at, s.ends_at, s.required_certs,
                  e.id AS event_id, e.name AS event_name, e.venue, e.address, e.notes, e.start_date, e.end_date
           FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id JOIN events e ON e.id = s.event_id
           WHERE a.id = $1 AND a.user_id = $2`,
          [id, req.user.sub],
        )
      ).rows[0];
      if (!me) return null;
      const coworkers = (
        await c.query(
          `SELECT u.id AS user_id, u.name, u.phone, s.id AS shift_id, s.role_name, s.starts_at, s.ends_at, a.status
           FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id JOIN users u ON u.id = a.user_id
           WHERE s.event_id = $1 AND a.user_id <> $2 AND a.status IN ('accepted','offered')
           ORDER BY s.starts_at, u.name`,
          [me.event_id, req.user.sub],
        )
      ).rows;
      return { shift: me, coworkers };
    });
    if (!out) return reply.code(404).send({ error: 'Shift not found' });
    return out;
  });

  app.post('/api/assignments/:id/respond', { preHandler: authenticate }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { response } = z.object({ response: z.enum(['accepted', 'declined']) }).parse(req.body);
    const row = await withTenant(req.user.tid, async (c) => {
      const r = await c.query(
        `UPDATE shift_assignments SET status = $3
         WHERE id = $1 AND user_id = $2
           AND NOT EXISTS (SELECT 1 FROM time_entries t WHERE t.assignment_id = $1)
         RETURNING id, status`,
        [id, req.user.sub, response],
      );
      if (r.rows[0]) await audit(c, req.user.tid, req.user.sub, `assignment.${response}`, 'assignment', id);
      return r.rows[0];
    });
    if (!row) return reply.code(404).send({ error: 'Shift not found, or already worked' });
    return { assignment: row };
  });

  // ----- crew: clock in / out -----
  app.post('/api/time/clock-in', { preHandler: authenticate }, async (req, reply) => {
    const { assignmentId } = z.object({ assignmentId: uuid }).parse(req.body);
    const result = await withTenant(req.user.tid, async (c) => {
      const a = (
        await c.query(
          `SELECT a.id, (now() BETWEEN s.starts_at - interval '1 hour' AND s.ends_at + interval '2 hours') AS in_window
           FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id
           WHERE a.id = $1 AND a.user_id = $2 AND a.status = 'accepted'`,
          [assignmentId, req.user.sub],
        )
      ).rows[0];
      if (!a) return { code: 404, error: 'Accept the shift before clocking in' };
      if (!a.in_window) return { code: 409, error: 'Clock-in opens 1 hour before the shift starts' };
      if ((await c.query('SELECT 1 FROM time_entries WHERE user_id = $1 AND clock_out IS NULL', [req.user.sub])).rowCount)
        return { code: 409, error: 'You are already clocked in' };
      const t = (
        await c.query('INSERT INTO time_entries (tenant_id, assignment_id, user_id) VALUES ($1,$2,$3) RETURNING id, clock_in', [
          req.user.tid,
          assignmentId,
          req.user.sub,
        ])
      ).rows[0];
      await audit(c, req.user.tid, req.user.sub, 'time.clock_in', 'time_entry', t.id);
      return { code: 201, entry: t };
    });
    const { code, ...body } = result as { code: number; [k: string]: unknown };
    return reply.code(code).send(body);
  });

  app.post('/api/time/clock-out', { preHandler: authenticate }, async (req, reply) => {
    const row = await withTenant(req.user.tid, async (c) => {
      const r = await c.query(
        "UPDATE time_entries SET clock_out = now(), status = 'submitted' WHERE user_id = $1 AND clock_out IS NULL RETURNING id, clock_in, clock_out",
        [req.user.sub],
      );
      if (r.rows[0]) await audit(c, req.user.tid, req.user.sub, 'time.clock_out', 'time_entry', r.rows[0].id);
      return r.rows[0];
    });
    if (!row) return reply.code(409).send({ error: 'You are not clocked in' });
    return { entry: row };
  });

  app.get('/api/my/time', { preHandler: authenticate }, async (req) =>
    withTenant(req.user.tid, async (c) => ({
      entries: (await c.query(`${ENTRY_SQL} WHERE t.user_id = $1 ORDER BY t.clock_in DESC LIMIT 30`, [req.user.sub])).rows,
    })),
  );

  // ----- managers: timesheets -----
  app.get('/api/timesheets', { preHandler: mgr }, async (req) => {
    const { status } = z.object({ status: z.enum(['open', 'submitted', 'approved']).optional() }).parse(req.query);
    return withTenant(req.user.tid, async (c) => ({
      entries: (
        await c.query(`${ENTRY_SQL} ${status ? 'WHERE t.status = $1' : ''} ORDER BY t.clock_in DESC LIMIT 200`, status ? [status] : [])
      ).rows,
    }));
  });

  app.post('/api/timesheets/:id/approve', { preHandler: mgr }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const row = await withTenant(req.user.tid, async (c) => {
      const r = await c.query(
        "UPDATE time_entries SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1 AND status = 'submitted' RETURNING id",
        [id, req.user.sub],
      );
      if (r.rows[0]) await audit(c, req.user.tid, req.user.sub, 'time.approve', 'time_entry', id);
      return r.rows[0];
    });
    if (!row) return reply.code(404).send({ error: 'No submitted entry with that id' });
    return { ok: true };
  });

  app.get('/api/timesheets/export.csv', { preHandler: mgr }, async (req, reply) => {
    const rows = await withTenant(req.user.tid, async (c) => {
      const r = (await c.query(`${ENTRY_SQL} WHERE t.status = 'approved' ORDER BY t.clock_in`)).rows;
      await audit(c, req.user.tid, req.user.sub, 'export.timesheets', 'time_entry', null, { rows: r.length });
      return r;
    });
    // Pay columns are for admins only. The rate comes from the Roles & rates list, matching the shift role
    // name (ignoring a trailing "(Show)" style note).
    const isAdmin = req.user.role === 'admin';
    const rates = isAdmin
      ? new Map<string, number>(
          (await withTenant(req.user.tid, (c) => c.query('SELECT lower(name) AS n, pay_rate FROM skills'))).rows.map((r: any) => [r.n as string, Number(r.pay_rate)]),
        )
      : new Map<string, number>();
    const rateFor = (role: string) => rates.get(role.replace(/\s*\(.*\)\s*$/, '').trim().toLowerCase());
    const head = ['Employee', 'Email', 'Event', 'Role', 'Clock in (UTC)', 'Clock out (UTC)', 'Hours', 'Approved by', ...(isAdmin ? ['Hourly rate', 'Pay'] : [])];
    const lines = [head.join(',')].concat(
      rows.map((r) =>
        [
          r.user_name,
          r.user_email,
          r.event_name,
          r.role_name,
          r.clock_in.toISOString(),
          r.clock_out?.toISOString(),
          r.hours,
          r.approved_by_name,
          ...(isAdmin ? [rateFor(r.role_name) ?? '', rateFor(r.role_name) === undefined ? '' : (Math.round(Number(r.hours) * rateFor(r.role_name)! * 100) / 100).toFixed(2)] : []),
        ]
          .map(csvCell)
          .join(','),
      ),
    );
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', 'attachment; filename="laborops-timesheets.csv"');
    return lines.join('\r\n') + '\r\n';
  });
}
