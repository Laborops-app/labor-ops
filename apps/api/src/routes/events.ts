import type { PoolClient } from 'pg';
import { notify, describeShift } from '../notify';
import { syncEventChannel, sendDirectMessage } from './chat';
import { loadRates, loadRules, estimateShift, priceShift, checkRules, rateFor, eventState, loadStateOt, US_STATES } from '../pay';
import { canAdjustRates } from '../rates';
import { respondLinks } from '../notify/respond';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTenant, audit } from '../db';
import { STATUSES } from '../pipeline';
import { flagText, reviewFlags } from '../reviews';
import { guard } from '../auth';
import { evaluateShift } from '../eligibility';
import { customerForRentman } from '../rentman';

const id = z.object({ id: z.string().uuid() });
const eventBody = z.object({
  name: z.string().trim().min(1).max(150),
  client: z.string().trim().max(200).optional().nullable(),
  venue: z.string().trim().max(200).optional().nullable(),
  address: z.string().trim().max(300).optional().nullable(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  notes: z.string().max(5000).optional().nullable(),
  rentmanProjectId: z.number().int().optional().nullable(),
  customerId: z.string().uuid().optional().nullable(),
  // Pipeline column and priority for a new event (the board's "+" buttons); changed later with PATCH /api/events/:id/pipeline.
  status: z.enum(STATUSES).optional(),
  priority: z.enum(['low', 'medium', 'high']).optional(),
});
const shiftBody = z.object({
  roleName: z.string().trim().min(1).max(100),
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }),
  headcount: z.number().int().min(1).max(500).default(1),
  isOpen: z.boolean().default(false),
  requiredCerts: z.array(z.string().trim().min(1).max(60)).max(10).default([]),
  phaseId: z.string().uuid().nullable().optional(),
  payType: z.enum(['hourly', 'day']).default('hourly'),
});

const mgr = guard('admin', 'manager');

/** Offer a shift to one crew member: checks, assignment, notification and chat message. Shared by the assign and fill-from-group routes. */
export async function assignCrew(c: PoolClient, tid: string, actorId: string, shiftId: string, userId: string, override?: boolean, confirmed?: boolean, acceptFlags?: boolean): Promise<{ code: number; [k: string]: unknown }> {
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

  const chk = await checkRules(c, await loadRules(c), userId, shiftId, shift.starts_at, shift.ends_at, user.name);
  if (chk.blocks.length && !override)
    return { code: 409, error: chk.blocks.join('. ') + '.', reason: 'rules' };

  // Past reviews tagged No-show or Do not rehire: ask the coordinator before booking them again.
  const flags = (await reviewFlags(c, [userId])).get(userId);
  if (flags && !acceptFlags) return { code: 409, error: flagText(user.name, flags), reason: 'flagged', flags };

  const a = (
    await c.query(
      'INSERT INTO shift_assignments (tenant_id, shift_id, user_id, status) VALUES ($1,$2,$3,$4) RETURNING *',
      [tid, shiftId, userId, confirmed ? 'accepted' : 'offered'],
    )
  ).rows[0];
  await audit(c, tid, actorId, 'assignment.create', 'assignment', a.id, { shiftId, userId });
  await syncEventChannel(c, tid, shift.event_id, userId, true);
  const d = await describeShift(c, tid, shiftId, userId);
  if (d) {
    const links = respondLinks(tid, a.id, userId);
    if (confirmed) {
      // Scheduled by a coordinator: already confirmed, so no answer is needed. They can still back out.
      await notify(c, tid, {
        userId, category: 'assignment', title: `You're scheduled: ${d.role}`,
        body: `${d.line}${d.payLine ? '\n' + d.payLine : ''}\n\nYou're confirmed for this shift. If you can't make it, let your coordinator know.`,
        link: `/my-shifts/${a.id}`, sms: `You're scheduled: ${d.role}, ${d.event}, ${d.when}.`,
        actions: [{ label: "Can't make it", url: links.decline, kind: 'decline' }],
      });
      await sendDirectMessage(c, tid, actorId, userId, `You're scheduled\n\n${d.line}${d.payLine ? '\n' + d.payLine : ''}\n\nCan't make it? ${links.decline}`);
    } else {
      await notify(c, tid, {
        userId, category: 'assignment', title: `New shift offered: ${d.role}`,
        body: `${d.line}${d.payLine ? '\n' + d.payLine : ''}\n\nPlease accept or decline this shift.`,
        link: `/my-shifts/${a.id}`, sms: `New shift offered: ${d.role}, ${d.event}, ${d.when}. Accept or decline:`, smsLink: links.accept.replace('&a=accept', ''),
        actions: [{ label: 'Accept shift', url: links.accept, kind: 'accept' }, { label: 'Decline', url: links.decline, kind: 'decline' }],
      });
      // The same offer lands in the crew member's chat, from the coordinator who sent it.
      await sendDirectMessage(c, tid, actorId, userId, `New shift offered\n\n${d.line}${d.payLine ? '\n' + d.payLine : ''}\n\nAccept: ${links.accept}\nDecline: ${links.decline}`);
    }
  }
  return { code: 201, assignment: a, warnings: chk.warns };
}

export async function eventRoutes(app: FastifyInstance) {
  app.get('/api/events', { preHandler: mgr }, async (req) =>
    withTenant(req.user.tid, async (c) => ({
      events: (
        await c.query(`
          SELECT e.id, e.name, e.client, e.venue, e.start_date, e.end_date,
            (SELECT count(*)::int FROM shifts s WHERE s.event_id = e.id) AS shift_count,
            (SELECT COALESCE(sum(s.headcount),0)::int FROM shifts s WHERE s.event_id = e.id) AS slots,
            (SELECT count(*)::int FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id
               WHERE s.event_id = e.id AND a.status = 'accepted') AS accepted,
            -- Seats with someone on them (offered, pending or accepted), counted per shift up to its headcount.
            (SELECT COALESCE(sum(LEAST(s.headcount, (SELECT count(*) FROM shift_assignments a WHERE a.shift_id = s.id AND a.status <> 'declined'))), 0)::int
               FROM shifts s WHERE s.event_id = e.id) AS filled,
            -- People who worked a finished shift and have no review for it yet.
            (SELECT count(*)::int FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id
               WHERE s.event_id = e.id AND a.status = 'accepted' AND s.ends_at < now()
                 AND NOT EXISTS (SELECT 1 FROM crew_reviews r WHERE r.user_id = a.user_id AND r.shift_id = s.id)) AS to_rate
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
    const out = await withTenant(req.user.tid, async (c) => {
      const tz = (await c.query('SELECT timezone FROM tenants LIMIT 1')).rows[0]?.timezone ?? 'America/Denver';
      const rows = (
        await c.query(
          `SELECT s.id, s.role_name, s.starts_at, s.ends_at, s.headcount, e.id AS event_id, e.name AS event_name, e.venue,
              ph.id AS phase_id, ph.label AS phase_label,
              (SELECT count(*)::int FROM shift_assignments a WHERE a.shift_id = s.id AND a.status <> 'declined') AS filled,
              (SELECT count(*)::int FROM shift_assignments a WHERE a.shift_id = s.id AND a.status = 'accepted') AS confirmed,
              COALESCE((SELECT json_agg(json_build_object('user_id', u.id, 'name', u.name, 'status', a.status) ORDER BY a.created_at)
                 FROM shift_assignments a JOIN users u ON u.id = a.user_id
                 WHERE a.shift_id = s.id AND a.status <> 'declined'), '[]'::json) AS assignees
           FROM shifts s JOIN events e ON e.id = s.event_id
           -- The shift's own phase, or else the event phase whose dates cover the day it starts.
           LEFT JOIN LATERAL (
             SELECT p.id, p.label FROM event_phases p
             WHERE p.event_id = e.id AND (p.id = s.phase_id OR (s.phase_id IS NULL AND (s.starts_at AT TIME ZONE $3)::date BETWEEN p.starts_on AND p.ends_on))
             ORDER BY (p.id = s.phase_id) DESC, p.starts_on, p.created_at LIMIT 1
           ) ph ON true
           WHERE s.starts_at >= $1 AND s.starts_at < $2 ORDER BY s.starts_at, e.name`,
          [from, to, tz],
        )
      ).rows;
      // Event phases (load in, show days, load out ...) that overlap the range, drawn as all-day bars.
      const phases = (
        await c.query(
          `SELECT p.id, p.event_id, e.name AS event_name, p.label, to_char(p.starts_on, 'YYYY-MM-DD') AS starts_on, to_char(p.ends_on, 'YYYY-MM-DD') AS ends_on,
              st.slots, st.filled
           FROM event_phases p JOIN events e ON e.id = p.event_id
           -- Staffing of the phase: its own shifts, plus shifts with no phase that start on one of its days.
           CROSS JOIN LATERAL (
             SELECT COALESCE(sum(s.headcount), 0)::int AS slots,
                    COALESCE(sum(LEAST(s.headcount, (SELECT count(*) FROM shift_assignments a WHERE a.shift_id = s.id AND a.status <> 'declined'))), 0)::int AS filled
             FROM shifts s
             WHERE s.event_id = p.event_id AND (s.phase_id = p.id OR (s.phase_id IS NULL AND (s.starts_at AT TIME ZONE $3)::date BETWEEN p.starts_on AND p.ends_on))
           ) st
           WHERE p.ends_on >= ($1::timestamptz AT TIME ZONE $3)::date AND p.starts_on <= ($2::timestamptz AT TIME ZONE $3)::date
           ORDER BY p.starts_on, e.name, p.created_at`,
          [from, to, tz],
        )
      ).rows;
      // Approved time off overlapping the range, shown as "Approved leave" in the staff view.
      const timeOff = (
        await c.query(
          `SELECT t.user_id, u.name, t.starts_on, t.ends_on, t.note
           FROM time_off t JOIN users u ON u.id = t.user_id
           WHERE t.ends_on >= $1::timestamptz::date AND t.starts_on <= $2::timestamptz::date ORDER BY t.starts_on`,
          [from, to],
        )
      ).rows;
      // Pay is shown to admins and to coordinators allowed to adjust rates; other coordinators get no cost figures.
      const seePay = await canAdjustRates(c, req.user);
      if (seePay) {
        const rates = await loadRates(c);
        const rules = await loadRules(c);
        for (const s of rows) {
          const p = priceShift(rules, rateFor(rates, s.role_name), s.starts_at, s.ends_at);
          s.hours = p.hours;
          s.unit_cost = p.estimate != null ? Math.round(p.estimate * 100) / 100 : null;
        }
      }
      return { shifts: rows, phases, time_off: timeOff, can_see_pay: seePay };
    });
    return out;
  });

  app.post('/api/events', { preHandler: mgr }, async (req, reply) => {
    const b = eventBody.parse(req.body);
    if (b.endDate < b.startDate) return reply.code(400).send({ error: 'End date is before the start date' });
    const row = await withTenant(req.user.tid, async (c) => {
      const cust = b.customerId ? (await c.query('SELECT id, name FROM customers WHERE id = $1', [b.customerId])).rows[0] : null;
      if (b.customerId && !cust) return null;
      const rmp = b.rentmanProjectId ? (await c.query('SELECT p.id, p.customer_id, lc.name AS loc_name, lc.address AS loc_address FROM rentman_projects p LEFT JOIN rentman_contacts lc ON lc.id = p.location_id WHERE p.id = $1', [b.rentmanProjectId])).rows[0] : null;
      const rentmanId: number | null = rmp ? rmp.id : null;
      // A linked Rentman project fills in the customer (created in the CRM if new), venue and address when they were left empty.
      let custRow = cust;
      if (!custRow && rmp?.customer_id) custRow = await customerForRentman(c, req.user.tid, rmp.customer_id);
      const custId = custRow?.id ?? null;
      const clientName = custRow?.name ?? b.client;
      b.venue = b.venue || rmp?.loc_name || undefined;
      b.address = b.address || rmp?.loc_address || undefined;
      const r = await c.query(
        `INSERT INTO events (tenant_id, name, client, venue, address, start_date, end_date, notes, created_by, rentman_project_id, customer_id, pipeline_status, priority, board_position)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, (SELECT COALESCE(min(board_position), 1) - 1 FROM events WHERE pipeline_status = $12)) RETURNING *`,
        [req.user.tid, b.name, clientName || null, b.venue || null, b.address || null, b.startDate, b.endDate, b.notes ?? null, req.user.sub, rentmanId, custId, b.status ?? 'pending', b.priority ?? 'medium'],
      );
      if (rentmanId) {
        // Pull the equipment list now (best effort; the project must already be synced).
        const { getToken, syncEquipment } = await import('../rentman');
        const token = await getToken(c);
        if (token) await syncEquipment(c, req.user.tid, token, rentmanId).catch(() => {});
      }
      await audit(c, req.user.tid, req.user.sub, 'event.create', 'event', r.rows[0].id);
      return r.rows[0];
    });
    return row ? reply.code(201).send({ event: row }) : reply.code(404).send({ error: 'Customer not found' });
  });

  app.get('/api/events/:id', { preHandler: mgr }, async (req, reply) => {
    const { id: eventId } = id.parse(req.params);
    const out = await withTenant(req.user.tid, async (c) => {
      const ev = (await c.query('SELECT * FROM events WHERE id = $1', [eventId])).rows[0];
      if (!ev) return null;
      const shifts = (await c.query('SELECT * FROM shifts WHERE event_id = $1 ORDER BY starts_at, role_name', [eventId])).rows;
      const assigns = (
        await c.query(
          `SELECT a.id, a.shift_id, a.user_id, a.status, u.name AS user_name,
             (SELECT t.clock_in FROM time_entries t WHERE t.assignment_id = a.id AND t.clock_out IS NULL LIMIT 1) AS clocked_in_at,
             (SELECT max(t.clock_out) FROM time_entries t WHERE t.assignment_id = a.id) AS last_clock_out
           FROM shift_assignments a JOIN users u ON u.id = a.user_id
           JOIN shifts s ON s.id = a.shift_id WHERE s.event_id = $1 ORDER BY u.name`,
          [eventId],
        )
      ).rows;
      const out = [];
      // Pay is shown to admins and to coordinators allowed to adjust rates (other coordinators see names, not rates).
      const seePay = await canAdjustRates(c, req.user);
      const rates = seePay ? await loadRates(c) : null;
      const rules = rates ? await loadRules(c) : null;
      // Personal rates for this event (admins and rate-allowed coordinators only).
      const crewRates = seePay
        ? (await c.query('SELECT r.user_id, u.name AS user_name, r.pay_type, r.rate::float AS rate, r.note, r.updated_at FROM event_crew_rates r JOIN users u ON u.id = r.user_id WHERE r.event_id = $1 ORDER BY u.name', [eventId])).rows
        : [];
      const personal = new Set(crewRates.map((r) => r.user_id));
      for (const s of shifts) {
        const pay = rates && rules ? await estimateShift(c, rules, rates, s.role_name, s.starts_at, s.ends_at, null, s.id) : null;
        const mine = assigns.filter((a) => a.shift_id === s.id);
        // Priced seat by seat: people with their own rate at that rate, every other seat at the shift's / role's rate.
        let cost = 0;
        let priced = 0;
        if (pay && rates && rules) {
          for (const a of mine.filter((x) => x.status !== 'declined' && personal.has(x.user_id))) {
            const own = await estimateShift(c, rules, rates, s.role_name, s.starts_at, s.ends_at, a.user_id, s.id, { noPrior: true });
            a.pay_type = own.payType;
            a.rate = own.rate;
            a.estimated_pay = own.estimate;
            if (own.estimate !== null && priced < s.headcount) {
              cost += own.estimate;
              priced++;
            }
          }
          const rest = Math.max(0, s.headcount - priced);
          if (pay.estimate !== null) {
            cost += pay.estimate * rest;
            priced += rest;
          }
        }
        const unpriced = pay ? s.headcount - priced : 0;
        out.push({
          ...s,
          ...(pay
            ? {
                hours: pay.hours, hourly_rate: pay.rate, pay_type: pay.payType, ot_hours: pay.otHours, dt_hours: pay.dtHours,
                role_rate: rateFor(rates!, s.role_name) ?? null,
                estimated_cost: priced > 0 ? Math.round(cost * 100) / 100 : null,
                // Seats with no rate to price them (the role has no pay rate / day rate and no one there has their own).
                unpriced_seats: unpriced,
              }
            : {}),
          assignments: mine,
          crew_status: await evaluateShift(c, s.id),
        });
      }
      const phases = (await c.query('SELECT id, label, starts_on, ends_on FROM event_phases WHERE event_id = $1 ORDER BY starts_on, ends_on, created_at', [eventId])).rows;
      const rl = await loadRules(c);
      const fallback = (await c.query('SELECT default_state FROM labor_rules LIMIT 1')).rows[0]?.default_state ?? null;
      const st = eventState(ev, fallback);
      const so = await loadStateOt(c, st, rl);
      const overtime = { otAfter: ev.ot_after === null ? null : Number(ev.ot_after), state: ev.state ?? null, effectiveState: st, stateFromAddress: !ev.state && !!st && st !== fallback, companyDailyOt: rl.dailyOt, otMult: so.otMult, dtAfter: so.dtAfter, dtMult: so.dtMult };
      return { event: ev, shifts: out, phases, overtime, ...(seePay ? { crewRates } : {}) };
    });
    if (!out) return reply.code(404).send({ error: 'Event not found' });
    return out;
  });

  // Overtime for this job: after 8, 10 or 15 hours a day (or null for the company default), and the state whose rates apply.
  app.put('/api/events/:id/overtime', { preHandler: mgr }, async (req, reply) => {
    const { id: eventId } = id.parse(req.params);
    const b = z.object({ otAfter: z.union([z.literal(8), z.literal(10), z.literal(15)]).nullable(), state: z.string().trim().toUpperCase().refine((x) => US_STATES.includes(x)).nullable().optional() }).parse(req.body);
    const row = await withTenant(req.user.tid, async (c) => {
      const r = await c.query('UPDATE events SET ot_after = $2, state = CASE WHEN $3::boolean THEN $4 ELSE state END WHERE id = $1 RETURNING ot_after, state', [eventId, b.otAfter, b.state !== undefined, b.state ?? null]);
      if (r.rows[0]) await audit(c, req.user.tid, req.user.sub, 'event.overtime', 'event', eventId, b);
      return r.rows[0];
    });
    return row ? { ok: true, otAfter: row.ot_after === null ? null : Number(row.ot_after), state: row.state } : reply.code(404).send({ error: 'Event not found' });
  });

  // Edit the event's details. While phases exist the overall dates follow them.
  app.patch('/api/events/:id', { preHandler: mgr }, async (req, reply) => {
    const { id: eventId } = id.parse(req.params);
    const b = eventBody.partial().parse(req.body);
    const row = await withTenant(req.user.tid, async (c) => {
      const cur = (await c.query("SELECT *, to_char(start_date,'YYYY-MM-DD') AS sd, to_char(end_date,'YYYY-MM-DD') AS ed FROM events WHERE id = $1", [eventId])).rows[0];
      if (!cur) return null;
      const hasPhases = !!(await c.query('SELECT 1 FROM event_phases WHERE event_id = $1', [eventId])).rowCount;
      const startDate: string = hasPhases ? cur.sd : b.startDate ?? cur.sd;
      const endDate: string = hasPhases ? cur.ed : b.endDate ?? cur.ed;
      if (endDate < startDate) return { error: 'End date is before the start date' };
      const pick = <T>(v: T | undefined, old: T) => (v === undefined ? old : v);
      const cust = b.customerId === undefined ? undefined : b.customerId ? (await c.query('SELECT id, name FROM customers WHERE id = $1', [b.customerId])).rows[0] ?? null : null;
      if (b.customerId && !cust) return { error: 'Customer not found' };
      const r = await c.query(
        `UPDATE events SET name = $2, client = $3, venue = $4, address = $5, start_date = $6, end_date = $7, notes = $8, customer_id = $9 WHERE id = $1 RETURNING *`,
        [eventId, b.name ?? cur.name, (cust ? cust.name : pick(b.client, cur.client)) || null, pick(b.venue, cur.venue) || null, pick(b.address, cur.address) || null, startDate, endDate, pick(b.notes, cur.notes), cust === undefined ? cur.customer_id : cust?.id ?? null],
      );
      await audit(c, req.user.tid, req.user.sub, 'event.update', 'event', eventId, b);
      return r.rows[0];
    });
    if (!row) return reply.code(404).send({ error: 'Event not found' });
    if ((row as any).error) return reply.code(400).send(row);
    return { event: row };
  });

  // ---------- personal pay per crew member per event ----------
  // Hourly at a set rate, or a flat day rate, for one person's shifts on this event. Admins, and coordinators allowed to adjust rates.
  app.put('/api/events/:id/crew-rates/:userId', { preHandler: mgr }, async (req, reply) => {
    const { id: eventId, userId } = z.object({ id: z.string().uuid(), userId: z.string().uuid() }).parse(req.params);
    const b = z.object({ payType: z.enum(['hourly', 'day']), rate: z.number().positive().max(100000), note: z.string().trim().max(200).optional().nullable() }).parse(req.body);
    const r = await withTenant(req.user.tid, async (c) => {
      if (!(await canAdjustRates(c, req.user))) return { code: 403, error: 'Only admins, and coordinators allowed to adjust rates, can set pay.' };
      const ev = (await c.query('SELECT id, name FROM events WHERE id = $1', [eventId])).rows[0];
      if (!ev) return { code: 404, error: 'Event not found' };
      const u = (await c.query('SELECT id, name FROM users WHERE id = $1 AND active', [userId])).rows[0];
      if (!u) return { code: 404, error: 'Crew member not found' };
      const rate = Math.round(b.rate * 100) / 100;
      const prev = (await c.query('SELECT pay_type, rate::float AS rate FROM event_crew_rates WHERE event_id = $1 AND user_id = $2', [eventId, userId])).rows[0];
      await c.query(
        `INSERT INTO event_crew_rates (tenant_id, event_id, user_id, pay_type, rate, note, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (event_id, user_id) DO UPDATE SET pay_type = EXCLUDED.pay_type, rate = EXCLUDED.rate, note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [req.user.tid, eventId, userId, b.payType, rate, b.note || null, req.user.sub],
      );
      await audit(c, req.user.tid, req.user.sub, 'event.crew_rate', 'event', eventId, { userId, payType: b.payType, rate, before: prev ?? null });
      // Tell the person when their pay for a job they are on changes.
      const onIt = (await c.query("SELECT 1 FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id WHERE s.event_id = $1 AND a.user_id = $2 AND a.status <> 'declined' LIMIT 1", [eventId, userId])).rowCount;
      if (onIt && (!prev || prev.pay_type !== b.payType || prev.rate !== rate))
        await notify(c, req.user.tid, { userId, category: 'shift_change', title: `Pay updated: ${ev.name}`, body: b.payType === 'day' ? `You'll be paid a day rate of $${rate.toFixed(2)} per shift day on this event.` : `Your rate on this event is $${rate.toFixed(2)}/hr (overtime rules still apply).`, link: '/my-shifts' });
      return { code: 200, rate: { user_id: userId, user_name: u.name, pay_type: b.payType, rate, note: b.note || null } };
    });
    const { code, ...rest } = r as { code: number; [k: string]: unknown };
    return reply.code(code).send(rest);
  });

  app.delete('/api/events/:id/crew-rates/:userId', { preHandler: mgr }, async (req, reply) => {
    const { id: eventId, userId } = z.object({ id: z.string().uuid(), userId: z.string().uuid() }).parse(req.params);
    const r = await withTenant(req.user.tid, async (c) => {
      if (!(await canAdjustRates(c, req.user))) return { code: 403, error: 'Only admins, and coordinators allowed to adjust rates, can set pay.' };
      const d = await c.query('DELETE FROM event_crew_rates WHERE event_id = $1 AND user_id = $2 RETURNING pay_type, rate::float AS rate', [eventId, userId]);
      if (!d.rowCount) return { code: 404, error: 'No personal rate to remove' };
      await audit(c, req.user.tid, req.user.sub, 'event.crew_rate_removed', 'event', eventId, { userId, before: d.rows[0] });
      return { code: 200, ok: true };
    });
    const { code, ...rest } = r as { code: number; [k: string]: unknown };
    return reply.code(code).send(rest);
  });

  // ---------- phases: several dated stretches per event (load-in, show days, strike ...) ----------
  const phaseBody = z.object({
    label: z.string().trim().min(1).max(80),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  });
  const syncRange = async (c: import('pg').PoolClient, eventId: string) => {
    await c.query(
      `UPDATE events e SET start_date = p.s, end_date = p.e
         FROM (SELECT min(starts_on) AS s, max(ends_on) AS e FROM event_phases WHERE event_id = $1) p
        WHERE e.id = $1 AND p.s IS NOT NULL`,
      [eventId],
    );
  };
  app.post('/api/events/:id/phases', { preHandler: mgr }, async (req, reply) => {
    const { id: eventId } = id.parse(req.params);
    const b = phaseBody.parse(req.body);
    if (b.endDate < b.startDate) return reply.code(400).send({ error: 'End date is before the start date' });
    const row = await withTenant(req.user.tid, async (c) => {
      if (!(await c.query('SELECT 1 FROM events WHERE id = $1', [eventId])).rowCount) return null;
      const r = await c.query('INSERT INTO event_phases (tenant_id, event_id, label, starts_on, ends_on) VALUES ($1,$2,$3,$4,$5) RETURNING id, label, starts_on, ends_on', [req.user.tid, eventId, b.label, b.startDate, b.endDate]);
      await syncRange(c, eventId);
      await audit(c, req.user.tid, req.user.sub, 'event.phase_add', 'event', eventId, b);
      return r.rows[0];
    });
    return row ? reply.code(201).send({ phase: row }) : reply.code(404).send({ error: 'Event not found' });
  });
  app.patch('/api/event-phases/:id', { preHandler: mgr }, async (req, reply) => {
    const { id: phaseId } = id.parse(req.params);
    const b = phaseBody.parse(req.body);
    if (b.endDate < b.startDate) return reply.code(400).send({ error: 'End date is before the start date' });
    const row = await withTenant(req.user.tid, async (c) => {
      const r = await c.query('UPDATE event_phases SET label = $2, starts_on = $3, ends_on = $4 WHERE id = $1 RETURNING id, event_id, label, starts_on, ends_on', [phaseId, b.label, b.startDate, b.endDate]);
      if (r.rows[0]) await syncRange(c, r.rows[0].event_id);
      return r.rows[0];
    });
    return row ? { phase: row } : reply.code(404).send({ error: 'Phase not found' });
  });
  app.delete('/api/event-phases/:id', { preHandler: mgr }, async (req, reply) => {
    const { id: phaseId } = id.parse(req.params);
    const n = await withTenant(req.user.tid, async (c) => {
      const r = await c.query('DELETE FROM event_phases WHERE id = $1 RETURNING event_id', [phaseId]);
      if (r.rows[0]) await syncRange(c, r.rows[0].event_id);
      return r.rowCount;
    });
    return n ? { ok: true } : reply.code(404).send({ error: 'Phase not found' });
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
      if (b.phaseId && !(await c.query('SELECT 1 FROM event_phases WHERE id = $1 AND event_id = $2', [b.phaseId, eventId])).rowCount) return { error: 'That phase belongs to a different event' };
      const r = await c.query(
        `INSERT INTO shifts (tenant_id, event_id, role_name, starts_at, ends_at, headcount, is_open, required_certs, phase_id, pay_type)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [req.user.tid, eventId, b.roleName, b.startsAt, b.endsAt, b.headcount, b.isOpen, b.requiredCerts, b.phaseId ?? null, b.payType],
      );
      await audit(c, req.user.tid, req.user.sub, 'shift.create', 'shift', r.rows[0].id);
      return r.rows[0];
    });
    if (!row) return reply.code(404).send({ error: 'Event not found' });
    if ((row as any).error) return reply.code(400).send(row);
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
    const { userId, override, confirmed, acceptFlags } = z.object({ userId: z.string().uuid(), override: z.boolean().optional(), confirmed: z.boolean().optional(), acceptFlags: z.boolean().optional() }).parse(req.body);
    const result = await withTenant(req.user.tid, (c) => assignCrew(c, req.user.tid, req.user.sub, shiftId, userId, override, confirmed, acceptFlags));
    const { code, ...body } = result as { code: number; [k: string]: unknown };
    return reply.code(code).send(body);
  });

  // Confirm someone on their behalf after the offer went out (they said yes by phone, in person, ...).
  app.post('/api/assignments/:id/confirm', { preHandler: mgr }, async (req, reply) => {
    const { id: aId } = id.parse(req.params);
    const r = await withTenant(req.user.tid, async (c) => {
      const a = (await c.query("UPDATE shift_assignments SET status = 'accepted' WHERE id = $1 AND status IN ('offered','pending') RETURNING id, user_id, shift_id", [aId])).rows[0];
      if (!a) return null;
      await audit(c, req.user.tid, req.user.sub, 'assignment.confirm', 'assignment', aId);
      const d = await describeShift(c, req.user.tid, a.shift_id, a.user_id);
      if (d)
        await notify(c, req.user.tid, {
          userId: a.user_id, category: 'assignment', title: `You're confirmed: ${d.role}`,
          body: `${d.line}${d.payLine ? '\n' + d.payLine : ''}\n\nYour coordinator confirmed you for this shift.`, link: `/my-shifts/${a.id}`,
          sms: `Confirmed: ${d.role}, ${d.event}, ${d.when}.`,
        });
      return a;
    });
    return r ? { ok: true } : reply.code(404).send({ error: 'Nothing to confirm: the shift is already confirmed or declined' });
  });

  app.delete('/api/assignments/:id', { preHandler: mgr }, async (req, reply) => {
    const { id: aId } = id.parse(req.params);
    const n = await withTenant(req.user.tid, async (c) => {
      const prev = (await c.query('SELECT a.user_id, a.shift_id, s.event_id FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id WHERE a.id = $1', [aId])).rows[0];
      const r = await c.query('DELETE FROM shift_assignments WHERE id = $1', [aId]);
      if (r.rowCount && prev) await syncEventChannel(c, req.user.tid, prev.event_id, prev.user_id, false);
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
