import { loadRates, rateFor as roleRateFor, loadRules, estimateShift } from '../pay';
import { respondToAssignment } from '../notify/respond';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { autoApprove } from '../autoApprove';
import { editEntry, addEntry } from '../timeEdit';
import { notifyStaff, describeShift } from '../notify';
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
  SELECT t.id, t.status, t.clock_in, t.clock_out, t.approved_at, t.auto_approved, s.starts_at AS shift_starts_at, s.ends_at AS shift_ends_at, s.min_hours::float AS min_hours,
    ROUND(EXTRACT(EPOCH FROM (COALESCE(t.clock_out, now()) - t.clock_in)) / 3600.0, 2)::float AS hours,
    u.id AS user_id, u.name AS user_name, u.email AS user_email,
    s.role_name, s.pay_rate_override AS shift_rate, cr.rate AS crew_rate, cr.pay_type AS crew_pay_type, e.name AS event_name, ap.name AS approved_by_name,
    t.edited_at, ed.name AS edited_by_name, t.original_clock_in, t.original_clock_out, t.payroll_exported_at
  FROM time_entries t
  JOIN users u ON u.id = t.user_id
  JOIN shift_assignments a ON a.id = t.assignment_id
  JOIN shifts s ON s.id = a.shift_id
  JOIN events e ON e.id = s.event_id
  LEFT JOIN event_crew_rates cr ON cr.event_id = e.id AND cr.user_id = u.id
  LEFT JOIN users ap ON ap.id = t.approved_by
  LEFT JOIN users ed ON ed.id = t.edited_by`;

/** Great-circle distance in metres. */
export const distanceM = (lat1: number, lng1: number, lat2: number, lng2: number) => {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

export async function timeRoutes(app: FastifyInstance) {
  // ----- crew: my shifts -----
  app.get('/api/my/shifts', { preHandler: authenticate }, async (req) =>
    withTenant(req.user.tid, async (c) => {
      const rates = await loadRates(c);
      const rules = await loadRules(c);
      const rows = (
        await c.query(
          `SELECT a.id AS assignment_id, a.status, a.is_lead, s.id AS shift_id, s.event_id, s.role_name, s.starts_at, s.ends_at,
             e.name AS event_name, e.venue, e.clock_mode, e.geofence_m,
             (e.geo_lat IS NOT NULL AND e.geofence_m IS NOT NULL) AS needs_location,
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
      ).rows;
      const shifts = [];
      for (const r of rows) {
        const pay = await estimateShift(c, rules, rates, r.role_name, r.starts_at, r.ends_at, req.user.sub, r.shift_id);
        shifts.push({ ...r, hours: pay.hours, hourly_rate: pay.rate, estimated_pay: pay.estimate, pay_notes: pay.notes, pay_type: pay.payType });
      }
      return { shifts };
    }),
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
      const pay = await estimateShift(c, await loadRules(c), await loadRates(c), me.role_name, me.starts_at, me.ends_at, req.user.sub, me.shift_id);
      return { shift: { ...me, hours: pay.hours, hourly_rate: pay.rate, estimated_pay: pay.estimate, pay_notes: pay.notes, pay_type: pay.payType }, coworkers };
    });
    if (!out) return reply.code(404).send({ error: 'Shift not found' });
    return out;
  });

  app.post('/api/assignments/:id/respond', { preHandler: authenticate }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { response } = z.object({ response: z.enum(['accepted', 'declined']) }).parse(req.body);
    const row = await withTenant(req.user.tid, (c) => respondToAssignment(c, req.user.tid, { id: req.user.sub, name: req.user.name }, id, response));
    if (!row) return reply.code(404).send({ error: 'Shift not found, or already worked' });
    return { assignment: row };
  });

  // ----- crew: clock in / out -----
  const geoIn = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), accuracy: z.number().min(0).max(100000).optional() }).partial();

  // The event's clocking rules for one assignment, plus how far a reported position is from the venue.
  const rulesFor = async (c: any, assignmentId: string) =>
    (await c.query(
      `SELECT e.clock_mode, e.geo_lat, e.geo_lng, e.geofence_m, e.name AS event_name FROM shift_assignments a
         JOIN shifts s ON s.id = a.shift_id JOIN events e ON e.id = s.event_id WHERE a.id = $1`, [assignmentId])).rows[0] as
    { clock_mode: string; geo_lat: number | null; geo_lng: number | null; geofence_m: number | null; event_name: string } | undefined;

  // Returns an error message when the position is outside the fence, else the distance (or null when the event has no fence).
  const checkFence = (r: NonNullable<Awaited<ReturnType<typeof rulesFor>>>, pos: { lat?: number; lng?: number; accuracy?: number }) => {
    if (r.geo_lat === null || r.geo_lng === null || !r.geofence_m) return { distance: null as number | null };
    if (pos.lat === undefined || pos.lng === undefined) return { error: 'This event checks your location. Allow location access and try again.' };
    const distance = Math.round(distanceM(pos.lat, pos.lng, r.geo_lat, r.geo_lng));
    // Be fair to a poor GPS fix, but only up to 100 m of it.
    if (distance - Math.min(pos.accuracy ?? 0, 100) > r.geofence_m)
      return { error: `You are about ${distance >= 1000 ? (distance / 1000).toFixed(1) + ' km' : distance + ' m'} from ${r.event_name}. You can clock in within ${r.geofence_m} m of the venue.`, distance };
    return { distance };
  };

  app.post('/api/time/clock-in', { preHandler: authenticate }, async (req, reply) => {
    const body = z.object({ assignmentId: uuid }).merge(geoIn).parse(req.body);
    const { assignmentId } = body;
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
      const rules = await rulesFor(c, assignmentId);
      if (rules?.clock_mode === 'coordinator') return { code: 409, error: 'A labor coordinator checks crew in on site for this event. Find them when you arrive.' };
      if (!a.in_window) return { code: 409, error: 'Clock-in opens 1 hour before the shift starts' };
      if ((await c.query('SELECT 1 FROM time_entries WHERE user_id = $1 AND clock_out IS NULL', [req.user.sub])).rowCount)
        return { code: 409, error: 'You are already clocked in' };
      const fence = rules ? checkFence(rules, body) : { distance: null };
      if ('error' in fence && fence.error) return { code: 409, error: fence.error, reason: 'geofence', distance: fence.distance };
      const t = (
        await c.query('INSERT INTO time_entries (tenant_id, assignment_id, user_id, in_lat, in_lng, in_distance_m) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, clock_in', [
          req.user.tid,
          assignmentId,
          req.user.sub,
          body.lat ?? null,
          body.lng ?? null,
          fence.distance ?? null,
        ])
      ).rows[0];
      await audit(c, req.user.tid, req.user.sub, 'time.clock_in', 'time_entry', t.id);
      return { code: 201, entry: t };
    });
    const { code, ...rest } = result as { code: number; [k: string]: unknown };
    return reply.code(code).send(rest);
  });

  app.post('/api/time/clock-out', { preHandler: authenticate }, async (req, reply) => {
    const pos = geoIn.parse(req.body ?? {});
    const row = await withTenant(req.user.tid, async (c) => {
      const open = (await c.query('SELECT id, assignment_id FROM time_entries WHERE user_id = $1 AND clock_out IS NULL', [req.user.sub])).rows[0];
      if (!open) return null;
      const rules = await rulesFor(c, open.assignment_id);
      const dist = rules && rules.geo_lat !== null && rules.geo_lng !== null && pos.lat !== undefined && pos.lng !== undefined ? Math.round(distanceM(pos.lat, pos.lng, rules.geo_lat, rules.geo_lng)) : null;
      const r = await c.query(
        "UPDATE time_entries SET clock_out = now(), status = 'submitted', out_lat = $2, out_lng = $3, out_distance_m = $4 WHERE id = $1 RETURNING id, clock_in, clock_out",
        [open.id, pos.lat ?? null, pos.lng ?? null, dist],
      );
      await audit(c, req.user.tid, req.user.sub, 'time.clock_out', 'time_entry', r.rows[0].id);
      return { ...r.rows[0], auto_approved: await autoApprove(c, r.rows[0].id) };
    });
    if (!row) return reply.code(409).send({ error: 'You are not clocked in' });
    return { entry: row };
  });

  // ----- coordinator: check crew in and out on site -----
  const mgrOnly = guard('admin', 'manager');
  app.post('/api/assignments/:id/check-in', { preHandler: mgrOnly }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const r = await withTenant(req.user.tid, async (c) => {
      const a = (await c.query("SELECT user_id FROM shift_assignments WHERE id = $1 AND status = 'accepted'", [id])).rows[0];
      if (!a) return { code: 404, error: 'Only accepted shifts can be checked in' };
      if ((await c.query('SELECT 1 FROM time_entries WHERE user_id = $1 AND clock_out IS NULL', [a.user_id])).rowCount) return { code: 409, error: 'Already checked in' };
      const t = (await c.query('INSERT INTO time_entries (tenant_id, assignment_id, user_id, in_by) VALUES ($1,$2,$3,$4) RETURNING id, clock_in', [req.user.tid, id, a.user_id, req.user.sub])).rows[0];
      await audit(c, req.user.tid, req.user.sub, 'time.check_in', 'time_entry', t.id, { assignmentId: id });
      return { code: 201, entry: t };
    });
    const { code, ...rest } = r as { code: number; [k: string]: unknown };
    return reply.code(code).send(rest);
  });

  app.post('/api/assignments/:id/check-out', { preHandler: mgrOnly }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const row = await withTenant(req.user.tid, async (c) => {
      const r = await c.query("UPDATE time_entries SET clock_out = now(), status = 'submitted', out_by = $2 WHERE assignment_id = $1 AND clock_out IS NULL RETURNING id, clock_in, clock_out", [id, req.user.sub]);
      if (r.rows[0]) await audit(c, req.user.tid, req.user.sub, 'time.check_out', 'time_entry', r.rows[0].id, { assignmentId: id });
      return r.rows[0] ? { ...r.rows[0], auto_approved: await autoApprove(c, r.rows[0].id) } : undefined;
    });
    if (!row) return reply.code(409).send({ error: 'This person is not checked in' });
    return { entry: row };
  });

  // ----- event clocking settings -----
  app.put('/api/events/:id/clocking', { preHandler: mgrOnly }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({
      clockMode: z.enum(['self', 'coordinator']),
      lat: z.number().min(-90).max(90).nullable(),
      lng: z.number().min(-180).max(180).nullable(),
      geofenceM: z.number().int().min(25).max(20000).nullable(),
    }).refine((v) => (v.lat === null) === (v.lng === null), { message: 'Give both latitude and longitude' })
      .refine((v) => v.geofenceM === null || v.lat !== null, { message: 'Set the venue location to use a geofence' }).parse(req.body);
    const row = await withTenant(req.user.tid, async (c) => {
      const r = await c.query('UPDATE events SET clock_mode = $2, geo_lat = $3, geo_lng = $4, geofence_m = $5 WHERE id = $1 RETURNING id, clock_mode, geo_lat, geo_lng, geofence_m', [id, b.clockMode, b.lat, b.lng, b.lat === null ? null : b.geofenceM]);
      if (r.rows[0]) await audit(c, req.user.tid, req.user.sub, 'event.clocking', 'event', id, b);
      return r.rows[0];
    });
    return row ? { event: row } : reply.code(404).send({ error: 'Event not found' });
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

  // Coordinators and admins correct time, or add it for someone who never clocked in.
  const timesBody = z.object({ clockIn: z.string().datetime({ offset: true }), clockOut: z.string().datetime({ offset: true }).nullable(), force: z.boolean().optional(), reason: z.string().trim().max(300).nullable().optional() });
  app.put('/api/time-entries/:id', { preHandler: mgr }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = timesBody.parse(req.body);
    const { code, ...body } = await withTenant(req.user.tid, (c) => editEntry(c, { tid: req.user.tid, userId: req.user.sub, field: false }, id, b));
    return reply.code(code).send(body);
  });
  app.post('/api/assignments/:id/time', { preHandler: mgr }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = timesBody.parse(req.body);
    const { code, ...body } = await withTenant(req.user.tid, (c) => addEntry(c, { tid: req.user.tid, userId: req.user.sub, field: false }, id, b));
    return reply.code(code).send(body);
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
          await withTenant(req.user.tid, (c) => loadRates(c)),
        )
      : new Map<string, number>();
    const roleRate = (role: string) => roleRateFor(rates, role);
    // A rate set on the shift itself wins over the role's rate.
    // A person's hourly rate for this event wins, then the shift's rate, then the role's. (Day rates are paid per day, so no hourly figure.)
    const rateFor = (r: { role_name: string; shift_rate?: string | null; crew_rate?: string | null; crew_pay_type?: string | null }) =>
      r.crew_pay_type === 'day' ? undefined : r.crew_rate && Number(r.crew_rate) > 0 ? Number(r.crew_rate) : r.shift_rate && Number(r.shift_rate) > 0 ? Number(r.shift_rate) : roleRate(r.role_name);
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
          ...(isAdmin ? (r.crew_pay_type === 'day' ? [`day rate ${Number(r.crew_rate).toFixed(2)}`, ''] : [rateFor(r) ?? '', rateFor(r) === undefined ? '' : (Math.round(Number(r.hours) * rateFor(r)! * 100) / 100).toFixed(2)]) : []),
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
