import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { withTenant, audit } from '../db';
import { guard } from '../auth';
import { notify, describeShift } from '../notify';
import { syncEventChannel } from './chat';
import { canAdjustRates } from '../rates';
import { roleKeyOf } from '../pay';

/*
 * Worker instructions and uniforms, pay per position on an event, declining for a crew member, and the change log
 * (an event's History tab and the company-wide Activity page).
 */
const uuid = z.string().uuid();
const mgr = guard('admin', 'manager');
const office = guard('admin', 'manager', 'hr');

// ---------- the change log ----------

type LogRow = { id: string; action: string; entity: string; detail: any; created_at: string; actor: string | null; subject: string | null; event_id: string | null; event_name: string | null };
const KINDS = { crew: 'Crew', time: 'Clock & time', shift: 'Shifts', event: 'Event', pay: 'Pay', other: 'Other' } as const;
type Kind = keyof typeof KINDS;

const kindOf = (a: string): Kind =>
  a.startsWith('assignment.') || a.startsWith('claim.') || a.startsWith('swap.') || a === 'attendance.no_show' || a === 'event.autofill' || a === 'shift.fill_group' || a === 'shift.offer_group' || a === 'shift.waves_start' ? 'crew'
    : a.startsWith('time.') || (a.startsWith('staff.') && a !== 'staff.employment') ? 'time'
    : a.startsWith('shift.') ? 'shift'
    : a.includes('rate') || a.startsWith('billing.') || a === 'event.overtime' ? 'pay'
    : a.startsWith('event.') || a.startsWith('phase.') ? 'event'
    : 'other';

const t = (iso: unknown) => (iso ? new Date(String(iso)).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const money = (n: unknown) => (n == null ? '' : `$${Number(n).toFixed(2)}`);

/** A log line in words: "Sam Coordinator clocked Jordan Rivera in". */
export function describe(r: LogRow): string {
  const who = r.actor ?? 'LaborOps';
  const them = r.subject ?? 'a crew member';
  const d = r.detail ?? {};
  const self = r.actor && r.subject && r.actor === r.subject;
  switch (r.action) {
    case 'assignment.create': return `${who} added ${them}${d.role ? ` to ${d.role}` : ''}`;
    case 'assignment.plan': return `${who} added ${them} to the plan (not sent yet)`;
    case 'assignment.delete': return `${who} removed ${them}${d.role ? ` from ${d.role}` : ''}`;
    case 'assignment.move': return `${who} moved ${them} to another shift`;
    case 'assignment.confirm': return `${who} confirmed ${them} for them`;
    case 'assignment.accepted': return `${them} accepted the shift`;
    case 'assignment.declined': return `${them} declined the shift`;
    case 'assignment.declined_for': return `${who} declined for ${them}${d.reason ? `: ${d.reason}` : ''}${d.note ? ` (“${d.note}”)` : ''}`;
    case 'assignment.nudge': return `${who} reminded ${them} to answer`;
    case 'assignment.lead': return `${who} made ${them} the lead`;
    case 'assignment.unlead': return `${who} removed ${them} as lead`;
    case 'assignment.running_late': return `${them} said they’re running late${d.minutes ? ` (~${d.minutes} min)` : ''}`;
    case 'attendance.no_show': return `${them} was marked a no-show`;
    case 'claim.create': return `${them} asked for an open shift`;
    case 'claim.approve': return `${who} approved ${them}’s request for an open shift`;
    case 'claim.reject': return `${who} turned down ${them}’s request for an open shift`;
    case 'time.clock_in': return self || !r.actor ? `${them} clocked in` : `${who} clocked ${them} in`;
    case 'time.clock_out': return self || !r.actor ? `${them} clocked out` : `${who} clocked ${them} out`;
    case 'time.check_in': return `${who} checked ${them} in${d.onsite ? ' (on site)' : ''}`;
    case 'time.check_out': return `${who} checked ${them} out${d.onsite ? ' (on site)' : ''}`;
    case 'time.auto_clock_out': return `${them} was clocked out automatically`;
    case 'time.add': return `${who} added time for ${them}: ${t(d.in)} – ${d.out ? t(d.out) : 'still on'}${d.reason ? ` (${d.reason})` : ''}`;
    case 'time.edit': return `${who} changed ${them}’s time from ${t(d.from?.in)}–${t(d.from?.out)} to ${t(d.to?.in)}–${t(d.to?.out)}${d.reason ? ` (${d.reason})` : ''}`;
    case 'time.approve': return `${who} approved ${them}’s time`;
    case 'time.unapprove': return `${who} unapproved ${them}’s time`;
    case 'time.minimum': return d.on === false ? `${who} switched off the minimum pay for ${them}` : `${who} set ${them}’s minimum to ${d.hours ?? 'the usual'} h`;
    case 'time.lunch_start': case 'time.break_start': return `${them} started a ${r.action.includes('lunch') ? 'lunch' : 'break'}`;
    case 'time.lunch_done': case 'time.lunch_end': case 'time.break_end': return `${them} ended a ${r.action.includes('lunch') ? 'lunch' : 'break'}`;
    case 'staff.clock_in': return self || !r.actor ? `${them} clocked in (staff time clock)` : `${who} clocked ${them} in (staff time clock)`;
    case 'staff.clock_out': return self || !r.actor ? `${them} clocked out (staff time clock)` : `${who} clocked ${them} out (staff time clock)`;
    case 'staff.break_start': return `${them} started a break`;
    case 'staff.break_end': return `${them} ended a break`;
    case 'staff.add': return `${who} added staff time for ${them}: ${t(d.in)} – ${d.out ? t(d.out) : 'still on'}${d.reason ? ` (${d.reason})` : ''}`;
    case 'staff.edit': return `${who} changed ${them}’s staff time from ${t(d.from?.in)}–${t(d.from?.out)} to ${t(d.to?.in)}–${t(d.to?.out)}${d.reason ? ` (${d.reason})` : ''}`;
    case 'staff.delete': return `${who} deleted ${them}’s staff time ${t(d.in)} – ${t(d.out)}${d.reason ? ` (${d.reason})` : ''}`;
    case 'staff.approve': return `${who} approved ${them}’s staff time${d.count > 1 ? ` (${d.count} punches)` : ''}`;
    case 'staff.unapprove': return `${who} unapproved ${them}’s staff time`;
    case 'staff.employment': return d.employment === 'fulltime' ? `${who} made ${them} full-time staff` : `${who} moved ${them} back to crew`;
    case 'shift.create': return `${who} added a shift${d.role ? `: ${d.role}` : ''}`;
    case 'shift.bulk_create': return `${who} added ${d.count ?? 'several'} shifts`;
    case 'shift.update': return `${who} changed a shift${d.role ? `: ${d.role}` : ''}`;
    case 'shift.delete': return `${who} deleted a shift${d.role ? `: ${d.role}` : ''}`;
    case 'shift.duplicate': return `${who} duplicated a shift`;
    case 'shift.waves_start': return `${who} started offer waves`;
    case 'event.create': return `${who} created the event`;
    case 'event.update': return `${who} edited the event details`;
    case 'event.instructions': return `${who} updated the crew instructions${d.uniform ? ` (uniform: ${d.uniform})` : ''}`;
    case 'event.publish': return `${who} published the event and sent the offers`;
    case 'event.autofill': return `${who} filled open spots automatically`;
    case 'event.archive': return `${who} archived the event`;
    case 'event.restore': return `${who} restored the event`;
    case 'event.copy': return `${who} copied the event`;
    case 'event.phase_add': return `${who} added a phase${d.label ? `: ${d.label}` : ''}`;
    case 'event.phase_update': return `${who} changed a phase${d.label ? `: ${d.label}` : ''}`;
    case 'event.crew_rate': return `${who} set ${them}’s pay on this event${d.rate ? ` to ${money(d.rate)}${d.payType === 'day' ? '/day' : '/hr'}` : ''}`;
    case 'event.crew_rate_removed': return `${who} removed ${them}’s pay for this event`;
    case 'event.position_rate': return d.rate ? `${who} set ${d.role} pay on this event to ${money(d.rate)}${d.payType === 'day' ? '/day' : '/hr'}` : `${who} put ${d.role} pay back to the standard rate`;
    case 'event.update_sent': return `${who} sent an update to the crew`;
    case 'event.call_sheet_sent': return `${who} sent the call sheet`;
    case 'event.rentman_build': return `${who} built the shifts from Rentman`;
    case 'billing.pdf': return `${who} downloaded the invoice PDF`;
    case 'billing.quickbooks': return `${who} sent the invoice to QuickBooks`;
    case 'crew.rate': return `${who} changed ${them}’s ${d.skill ?? ''} pay rate${d.rate ? ` to ${money(d.rate)}` : ''}`.replace('  ', ' ');
    default: {
      const [obj, verb] = r.action.split('.');
      return `${who}: ${(verb ?? r.action).replace(/_/g, ' ')} ${obj && obj !== 'event' ? `(${obj.replace(/_/g, ' ')})` : ''}`.trim();
    }
  }
}

async function logRows(c: PoolClient, f: { eventId?: string; personId?: string; actorId?: string; kind?: Kind; q?: string; from?: string; to?: string; before?: number; limit: number }) {
  const rows = (await c.query(
    `SELECT l.id::text, l.action, l.entity, l.detail, l.created_at, a.name AS actor, s.name AS subject, l.event_id, e.name AS event_name
       FROM audit_logs l
       LEFT JOIN users a ON a.id = l.actor_id
       LEFT JOIN users s ON s.id = l.subject_id
       LEFT JOIN events e ON e.id = l.event_id
      WHERE ($1::uuid IS NULL OR l.event_id = $1)
        AND ($2::uuid IS NULL OR l.subject_id = $2 OR l.actor_id = $2)
        AND ($3::bigint IS NULL OR l.id < $3)
        AND ($4::date IS NULL OR l.created_at >= $4::date)
        AND ($5::date IS NULL OR l.created_at < $5::date + 1)
        AND ($6::text IS NULL OR e.name ILIKE '%' || $6 || '%' OR a.name ILIKE '%' || $6 || '%' OR s.name ILIKE '%' || $6 || '%')
        AND ($7::boolean OR l.event_id IS NOT NULL OR l.subject_id IS NOT NULL)
        AND l.action NOT LIKE 'tenant.%' AND l.action NOT LIKE 'auth.%'
      ORDER BY l.id DESC LIMIT $8`,
    [f.eventId ?? null, f.personId ?? null, f.before ?? null, f.from ?? null, f.to ?? null, f.q || null, !!f.eventId, f.kind ? 1000 : f.limit + 1])).rows as LogRow[];
  const shaped = rows
    .map((r) => ({ id: r.id, at: r.created_at, kind: kindOf(r.action), action: r.action, text: describe(r), actor: r.actor, subject: r.subject, event: r.event_id ? { id: r.event_id, name: r.event_name } : null }))
    .filter((r) => !f.kind || r.kind === f.kind);
  return { items: shaped.slice(0, f.limit), more: shaped.length > f.limit, next: shaped.length > f.limit ? Number(shaped[f.limit - 1]!.id) : null };
}

// ---------- notify booked crew when instructions change ----------
async function tellBooked(c: PoolClient, tid: string, eventId: string, eventName: string, what: string) {
  const people = (await c.query(
    `SELECT DISTINCT a.user_id FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id
      WHERE s.event_id = $1 AND a.status IN ('accepted', 'offered', 'pending') AND s.ends_at > now()`, [eventId])).rows;
  if (!people.length) return 0;
  await notify(c, tid, people.map((p) => ({
    userId: p.user_id, category: 'event_update' as const, title: `Updated: ${what} for ${eventName}`,
    body: `The ${what} for ${eventName} changed. Open the shift to see them.`, link: '/my-shifts',
  })));
  return people.length;
}

export async function eventExtraRoutes(app: FastifyInstance) {
  // ----- uniforms (company-wide presets) -----
  app.get('/api/uniforms', { preHandler: office }, async (req) =>
    withTenant(req.user.tid, async (c) => ({
      uniforms: (await c.query(`SELECT u.id, u.name, u.description, (SELECT count(*)::int FROM events e WHERE e.uniform_id = u.id AND e.archived_at IS NULL) AS events FROM uniforms u ORDER BY u.sort, lower(u.name)`)).rows,
    })));
  const uniformBody = z.object({ name: z.string().trim().min(1).max(60), description: z.string().trim().max(600).nullable().optional() });
  app.post('/api/uniforms', { preHandler: mgr }, async (req, reply) => {
    const b = uniformBody.parse(req.body);
    return withTenant(req.user.tid, async (c) => {
      if ((await c.query('SELECT 1 FROM uniforms WHERE lower(name) = lower($1)', [b.name])).rowCount) return reply.code(409).send({ error: `There's already a uniform called “${b.name}”.` });
      const u = (await c.query('INSERT INTO uniforms (tenant_id, name, description, sort) VALUES ($1, $2, $3, (SELECT COALESCE(max(sort), 0) + 1 FROM uniforms)) RETURNING id, name, description', [req.user.tid, b.name, b.description || null])).rows[0];
      await audit(c, req.user.tid, req.user.sub, 'uniform.create', 'uniform', u.id, { name: b.name });
      return reply.code(201).send({ uniform: u });
    });
  });
  app.patch('/api/uniforms/:id', { preHandler: mgr }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = uniformBody.partial().parse(req.body);
    return withTenant(req.user.tid, async (c) => {
      const u = (await c.query('UPDATE uniforms SET name = COALESCE($2, name), description = CASE WHEN $3::boolean THEN $4 ELSE description END WHERE id = $1 RETURNING id, name, description',
        [id, b.name ?? null, b.description !== undefined, b.description || null])).rows[0];
      if (!u) return reply.code(404).send({ error: 'Uniform not found' });
      await audit(c, req.user.tid, req.user.sub, 'uniform.update', 'uniform', id, b);
      return { uniform: u };
    });
  });
  app.delete('/api/uniforms/:id', { preHandler: mgr }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    return withTenant(req.user.tid, async (c) => {
      const r = await c.query('DELETE FROM uniforms WHERE id = $1 RETURNING name', [id]);
      if (!r.rowCount) return reply.code(404).send({ error: 'Uniform not found' });
      await audit(c, req.user.tid, req.user.sub, 'uniform.delete', 'uniform', id, { name: r.rows[0].name });
      return { ok: true };
    });
  });

  // ----- instructions + uniform on an event -----
  app.put('/api/events/:id/instructions', { preHandler: mgr }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({
      instructions: z.string().trim().max(4000).nullable().optional(),
      uniformId: uuid.nullable().optional(),
      uniformNote: z.string().trim().max(300).nullable().optional(),
      notify: z.boolean().optional(),
    }).parse(req.body);
    return withTenant(req.user.tid, async (c) => {
      const before = (await c.query('SELECT name, instructions, uniform_id, uniform_note FROM events WHERE id = $1', [id])).rows[0];
      if (!before) return reply.code(404).send({ error: 'Event not found' });
      if (b.uniformId && !(await c.query('SELECT 1 FROM uniforms WHERE id = $1', [b.uniformId])).rowCount) return reply.code(404).send({ error: 'Uniform not found' });
      const ev = (await c.query(
        `UPDATE events SET instructions = CASE WHEN $2::boolean THEN $3 ELSE instructions END,
                           uniform_id = CASE WHEN $4::boolean THEN $5::uuid ELSE uniform_id END,
                           uniform_note = CASE WHEN $6::boolean THEN $7 ELSE uniform_note END
          WHERE id = $1 RETURNING instructions, uniform_id, uniform_note`,
        [id, b.instructions !== undefined, b.instructions || null, b.uniformId !== undefined, b.uniformId ?? null, b.uniformNote !== undefined, b.uniformNote || null])).rows[0];
      const changed = before.instructions !== ev.instructions || before.uniform_id !== ev.uniform_id || before.uniform_note !== ev.uniform_note;
      const uniform = ev.uniform_id ? (await c.query('SELECT id, name, description FROM uniforms WHERE id = $1', [ev.uniform_id])).rows[0] : null;
      let told = 0;
      if (changed) {
        await audit(c, req.user.tid, req.user.sub, 'event.instructions', 'event', id, { uniform: uniform?.name ?? null });
        if (b.notify !== false) {
          const what = before.instructions !== ev.instructions && (before.uniform_id !== ev.uniform_id || before.uniform_note !== ev.uniform_note) ? 'instructions and uniform' : before.instructions !== ev.instructions ? 'instructions' : 'uniform';
          told = await tellBooked(c, req.user.tid, id, before.name, what);
        }
      }
      return { instructions: ev.instructions, uniform, uniformNote: ev.uniform_note, told };
    });
  });

  // ----- pay per position on an event -----
  app.get('/api/events/:id/position-rates', { preHandler: mgr }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    return withTenant(req.user.tid, async (c) => {
      if (!(await canAdjustRates(c, req.user))) return reply.code(403).send({ error: 'Only admins, and coordinators allowed to adjust rates, can see pay.' });
      const roles = (await c.query('SELECT DISTINCT role_name FROM shifts WHERE event_id = $1 ORDER BY role_name', [id])).rows.map((r) => r.role_name as string);
      const skills = (await c.query('SELECT name, pay_rate::float AS pay_rate, day_rate::float AS day_rate FROM skills')).rows;
      const set = (await c.query('SELECT role_key, role_name, pay_type, rate::float AS rate FROM event_position_rates WHERE event_id = $1', [id])).rows;
      const seen = new Set<string>();
      const positions = [];
      for (const name of [...roles, ...set.map((x) => x.role_name)]) {
        const k = roleKeyOf(name);
        if (seen.has(k)) continue;
        seen.add(k);
        const sk = skills.find((x) => roleKeyOf(x.name) === k);
        const own = set.find((x) => x.role_key === k);
        positions.push({ role: name, standard: { hourly: sk?.pay_rate || null, day: sk?.day_rate || null }, rate: own ? { payType: own.pay_type, rate: own.rate } : null });
      }
      return { positions };
    });
  });
  app.put('/api/events/:id/position-rates', { preHandler: mgr }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ role: z.string().trim().min(1).max(100), payType: z.enum(['hourly', 'day']).default('hourly'), rate: z.number().positive().max(100000).nullable() }).parse(req.body);
    return withTenant(req.user.tid, async (c) => {
      if (!(await canAdjustRates(c, req.user))) return reply.code(403).send({ error: 'Only admins, and coordinators allowed to adjust rates, can set pay.' });
      if (!(await c.query('SELECT 1 FROM events WHERE id = $1', [id])).rowCount) return reply.code(404).send({ error: 'Event not found' });
      const k = roleKeyOf(b.role);
      if (b.rate === null) await c.query('DELETE FROM event_position_rates WHERE event_id = $1 AND role_key = $2', [id, k]);
      else await c.query(
        `INSERT INTO event_position_rates (tenant_id, event_id, role_key, role_name, pay_type, rate, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (event_id, role_key) DO UPDATE SET role_name = EXCLUDED.role_name, pay_type = EXCLUDED.pay_type, rate = EXCLUDED.rate, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [req.user.tid, id, k, b.role, b.payType, Math.round(b.rate * 100) / 100, req.user.sub]);
      await audit(c, req.user.tid, req.user.sub, 'event.position_rate', 'event', id, { role: b.role, payType: b.payType, rate: b.rate });
      return { ok: true };
    });
  });

  // ----- decline a shift for a crew member -----
  app.post('/api/assignments/:id/decline-for', { preHandler: mgr }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ reason: z.string().trim().min(1).max(60), note: z.string().trim().max(150).nullable().optional(), notify: z.boolean().optional() }).parse(req.body);
    const out = await withTenant(req.user.tid, async (c) => {
      const a = (await c.query(
        `SELECT a.id, a.user_id, a.shift_id, a.status, s.event_id, s.role_name, u.name,
                EXISTS (SELECT 1 FROM time_entries t WHERE t.assignment_id = a.id) AS worked
           FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id JOIN users u ON u.id = a.user_id WHERE a.id = $1 FOR UPDATE OF a`, [id])).rows[0];
      if (!a) return { code: 404, error: 'Not found on this shift' };
      if (a.status === 'declined') return { code: 409, error: `${a.name} has already declined this shift.` };
      if (a.worked) return { code: 409, error: `${a.name} has clocked time on this shift. Remove or edit the time instead.` };
      const reason = b.note ? `${b.reason}: ${b.note}` : b.reason;
      await c.query("UPDATE shift_assignments SET status = 'declined', declined_by = $2, decline_reason = $3, declined_at = now(), is_lead = false WHERE id = $1", [id, req.user.sub, reason]);
      await syncEventChannel(c, req.user.tid, a.event_id, a.user_id, false);
      await audit(c, req.user.tid, req.user.sub, 'assignment.declined_for', 'assignment', id, { eventId: a.event_id, userId: a.user_id, shiftId: a.shift_id, role: a.role_name, reason: b.reason, note: b.note ?? null, was: a.status });
      if (b.notify !== false) {
        const d = await describeShift(c, req.user.tid, a.shift_id, a.user_id);
        if (d) await notify(c, req.user.tid, {
          userId: a.user_id, category: 'shift_change', title: `Declined for you: ${d.role}`,
          body: `${d.line}\n\nYour coordinator marked this shift as declined for you (${b.reason}). If that's not right, reply to them.`, link: '/my-shifts',
          sms: `Your coordinator declined ${d.role}, ${d.event}, ${d.when} for you (${b.reason}).`,
        });
      }
      return { code: 200, ok: true };
    });
    const { code, ...rest } = out as { code: number; [k: string]: unknown };
    return reply.code(code).send(rest);
  });

  // ----- old free-text skills that aren't positions yet -----
  app.get('/api/positions/leftovers', { preHandler: mgr }, async (req) =>
    withTenant(req.user.tid, async (c) => {
      const list = (await c.query('SELECT name FROM skills WHERE active')).rows.map((r) => r.name as string);
      const keys = new Set(list.map(roleKeyOf));
      const rows = (await c.query("SELECT k AS name, count(*)::int AS people FROM users u, unnest(u.skills) k WHERE u.active AND u.role = 'crew' GROUP BY k ORDER BY count(*) DESC, k")).rows;
      return { leftovers: rows.filter((r) => !keys.has(roleKeyOf(r.name))), positions: list.sort((a, b) => a.localeCompare(b)) };
    }));
  app.post('/api/positions/leftovers', { preHandler: mgr }, async (req, reply) => {
    const b = z.object({ name: z.string().min(1).max(40), action: z.enum(['map', 'make', 'remove']), to: z.string().trim().max(60).optional() }).parse(req.body);
    return withTenant(req.user.tid, async (c) => {
      let to: string | null = null;
      if (b.action === 'map') {
        to = (await c.query('SELECT name FROM skills WHERE active')).rows.map((r) => r.name as string).find((x) => x === b.to) ?? null;
        if (!to) return reply.code(400).send({ error: 'Pick a position to use instead.' });
      } else if (b.action === 'make') {
        const name = b.name.trim();
        const found = (await c.query('SELECT name FROM skills WHERE lower(name) = lower($1)', [name])).rows[0];
        if (found) { await c.query('UPDATE skills SET active = true WHERE lower(name) = lower($1)', [name]); to = found.name; }
        else { await c.query('INSERT INTO skills (tenant_id, name, pay_rate) VALUES ($1, $2, 0)', [req.user.tid, name]); to = name; }
      }
      // Swap (or drop) the old name on everyone who has it, without duplicates.
      const r = await c.query(
        `UPDATE users SET skills = ARRAY(SELECT DISTINCT x FROM unnest(array_replace(skills, $1, $2)) x WHERE x IS NOT NULL)
          WHERE $1 = ANY(skills) RETURNING id`, [b.name, to]);
      await audit(c, req.user.tid, req.user.sub, 'position.tidy', 'skill', null, { from: b.name, action: b.action, to, people: r.rowCount });
      return { people: r.rowCount ?? 0, to };
    });
  });

  // ----- the change log -----
  const logQ = z.object({
    kind: z.enum(Object.keys(KINDS) as [Kind, ...Kind[]]).optional(),
    person: uuid.optional(),
    q: z.string().trim().max(100).optional(),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    before: z.coerce.number().int().positive().optional(),
    event: uuid.optional(),
  });
  app.get('/api/events/:id/history', { preHandler: office }, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const q = logQ.parse(req.query);
    return withTenant(req.user.tid, async (c) => ({ ...(await logRows(c, { eventId: id, personId: q.person, kind: q.kind, before: q.before, limit: 60 })), kinds: KINDS }));
  });
  app.get('/api/activity', { preHandler: guard('admin', 'manager') }, async (req) => {
    const q = logQ.parse(req.query);
    return withTenant(req.user.tid, async (c) => ({ ...(await logRows(c, { eventId: q.event, personId: q.person, kind: q.kind, q: q.q, from: q.from, to: q.to, before: q.before, limit: 80 })), kinds: KINDS }));
  });
}
