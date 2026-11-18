import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { withTenant, audit } from '../db';
import { guard } from '../auth';
import { rulesForEvents } from '../workRules';

/**
 * Time & attendance: every scheduled shift in a date range with what actually happened: clock-in and out, breaks,
 * paid hours after the minimum call, and conditions that need a look (late start, early end, outside the geofence…).
 * Coordinators correct times, change the minimum for one person, and approve one at a time or a whole event at once.
 */
const uuid = z.string().uuid();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const mgr = guard('admin', 'manager');
const viewers = guard('admin', 'manager', 'hr');
const H = 3600_000;
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Conditions. Red ones are flags someone should check before approving; grey ones are for information. */
export const CONDITIONS = {
  NS: { label: 'No-show', flag: true, why: 'Never clocked in for this shift' },
  NCI: { label: 'Not clocked in', flag: false, why: 'The shift has started and they have not clocked in yet' },
  LS: { label: 'Late start', flag: true, why: 'Clocked in after the late limit in Labor rules' },
  EE: { label: 'Early end', flag: true, why: 'Clocked out more than 15 minutes before the shift ended' },
  NCO: { label: 'No clock-out', flag: true, why: 'Still clocked in more than an hour after the shift ended' },
  ACO: { label: 'Auto clock-out', flag: true, why: 'Never clocked out; closed automatically at the end of the shift' },
  GEO: { label: 'Outside geofence', flag: true, why: 'Clocked in or out outside the venue area' },
  UMH: { label: 'Under minimum hours', flag: false, why: 'Worked less than the minimum, so the minimum is paid' },
  NWB: { label: 'No break', flag: false, why: 'No break or lunch recorded on a shift of 5 hours or more' },
  ED: { label: 'Edited', flag: false, why: 'Times were changed by a coordinator' },
  OFF: { label: 'Offline', flag: false, why: 'Clocked while the phone was offline; times were sent later' },
} as const;
export type Cond = keyof typeof CONDITIONS;
const STATUSES = ['none', 'in', 'out', 'approved'] as const;

type Row = Record<string, any>;

async function load(c: PoolClient, from: string, to: string) {
  const lr = (await c.query('SELECT late_alert_min, no_show_min FROM labor_rules')).rows[0] ?? {};
  const lateMin = Number(lr.late_alert_min ?? 10) || 10;
  const noShowMin = Number(lr.no_show_min ?? 60) || 60;
  const rows: Row[] = (await c.query(
    `SELECT a.id AS assignment_id, a.created_at AS assigned_at, a.no_show_at, u.id AS user_id, u.name AS user_name,
            s.id AS shift_id, s.role_name, s.starts_at, s.ends_at, s.min_hours::float AS shift_min,
            e.id AS event_id, e.name AS event_name, e.rentman_project_id, e.geofence_m, COALESCE(cu.name, e.client) AS client,
            COALESCE(e.timezone, t.timezone, 'UTC') AS tz,
            to_char(s.starts_at AT TIME ZONE COALESCE(e.timezone, t.timezone, 'UTC'), 'YYYY-MM-DD') AS date,
            te.id AS entry_id, te.status, te.clock_in, te.clock_out, te.in_distance_m, te.out_distance_m, te.in_lat, te.out_lat,
            te.in_by, ib.name AS in_by_name, te.out_by, ob.name AS out_by_name, ap.name AS approved_by_name, te.approved_at,
            te.edited_at, ed.name AS edited_by_name, te.payroll_exported_at, te.auto_clocked_out, te.offline_in, te.offline_out,
            te.min_hours_override::float AS min_override, te.min_off, te.entries,
            COALESCE((SELECT array_agg(m.group_id) FROM crew_group_members m WHERE m.user_id = u.id), '{}') AS groups,
            now() AS now
       FROM shift_assignments a
       JOIN shifts s ON s.id = a.shift_id
       JOIN events e ON e.id = s.event_id
       JOIN tenants t ON t.id = e.tenant_id
       JOIN users u ON u.id = a.user_id
       LEFT JOIN customers cu ON cu.id = e.customer_id
       LEFT JOIN LATERAL (
         SELECT x.*, count(*) OVER () AS entries FROM time_entries x WHERE x.assignment_id = a.id ORDER BY x.clock_in LIMIT 1
       ) te ON true
       LEFT JOIN users ib ON ib.id = te.in_by
       LEFT JOIN users ob ON ob.id = te.out_by
       LEFT JOIN users ap ON ap.id = te.approved_by
       LEFT JOIN users ed ON ed.id = te.edited_by
      WHERE a.status = 'accepted' AND e.archived_at IS NULL
        AND (s.starts_at AT TIME ZONE COALESCE(e.timezone, t.timezone, 'UTC'))::date BETWEEN $1::date AND $2::date
      ORDER BY s.starts_at, e.name, u.name`,
    [from, to],
  )).rows;
  const ids = rows.map((r) => r.assignment_id);
  const breaks = ids.length
    ? (await c.query('SELECT assignment_id, kind, started_at, ended_at FROM time_breaks WHERE assignment_id = ANY($1::uuid[]) ORDER BY started_at', [ids])).rows
    : [];
  const rules = await rulesForEvents(c, [...new Set(rows.map((r) => r.event_id as string))]);

  return rows.map((r) => {
    const now = +r.now, start = +r.starts_at, end = +r.ends_at;
    const sched = r2((end - start) / H);
    const inAt = r.clock_in ? +r.clock_in : null, outAt = r.clock_out ? +r.clock_out : null;
    const status: (typeof STATUSES)[number] = !inAt ? 'none' : !outAt ? 'in' : r.status === 'approved' ? 'approved' : 'out';
    const worked = inAt ? r2(((outAt ?? now) - inAt) / H) : 0;
    // Minimum paid hours: switched off for this person, their own figure, the shift's, then the event's work rules.
    const ruleMin = rules.get(r.event_id)?.rules.minCallH ?? 0;
    const minHours = r.min_off ? 0 : Number(r.min_override) || Number(r.shift_min) || Number(ruleMin) || 0;
    const minSource = r.min_off ? 'off' : r.min_override ? 'person' : r.shift_min ? 'shift' : ruleMin ? 'rules' : null;
    const paid = outAt ? r2(Math.max(worked, minHours)) : null;
    const adjust = paid !== null && paid > worked ? r2(paid - worked) : 0;
    const br = breaks.filter((b) => b.assignment_id === r.assignment_id).map((b) => ({
      kind: b.kind as string, start: b.started_at as Date, end: (b.ended_at as Date | null) ?? null,
      hours: b.ended_at ? r2((+b.ended_at - +b.started_at) / H) : null,
    }));

    const cond: Cond[] = [];
    if (!inAt) {
      if (r.no_show_at || now > start + noShowMin * 60_000) cond.push('NS');
      else if (now > start) cond.push('NCI');
    } else {
      if (inAt > start + lateMin * 60_000) cond.push('LS');
      if (r.auto_clocked_out) cond.push('ACO');
      else if (outAt && outAt < end - 15 * 60_000) cond.push('EE');
      if (!outAt && now > end + H) cond.push('NCO');
      const fence = Number(r.geofence_m) || 0;
      if (fence && ((r.in_distance_m ?? 0) > fence || (r.out_distance_m ?? 0) > fence)) cond.push('GEO');
      if (adjust > 0) cond.push('UMH');
      if (!br.length && Math.max(sched, worked) >= 5) cond.push('NWB');
      if (r.edited_at) cond.push('ED');
      if (r.offline_in || r.offline_out) cond.push('OFF');
    }
    const flagged = status !== 'approved' && cond.some((k) => CONDITIONS[k].flag);
    const self = (by: string | null) => !by || by === r.user_id;
    return {
      assignmentId: r.assignment_id, entryId: r.entry_id ?? null, status, flagged, date: r.date, tz: r.tz,
      user: { id: r.user_id, name: r.user_name, groups: r.groups as string[] },
      role: r.role_name,
      event: { id: r.event_id, name: r.event_name, number: r.rentman_project_id ? String(r.rentman_project_id) : null, client: r.client ?? null },
      scheduled: { start: r.starts_at, end: r.ends_at, hours: sched },
      actual: { in: r.clock_in ?? null, out: r.clock_out ?? null, hours: inAt ? worked : null },
      paidHours: paid, minHours, minSource, adjust, breaks: br,
      clockIn: inAt ? { by: self(r.in_by) ? r.user_name : r.in_by_name, self: self(r.in_by), distanceM: r.in_distance_m, located: r.in_lat !== null } : null,
      clockOut: outAt ? { by: self(r.out_by) ? r.user_name : r.out_by_name, self: self(r.out_by), distanceM: r.out_distance_m, located: r.out_lat !== null } : null,
      approvedBy: r.approved_by_name ?? null, approvedAt: r.approved_at ?? null,
      editedBy: r.edited_by_name ?? null, exported: !!r.payroll_exported_at, moreEntries: Number(r.entries ?? 0) > 1,
      // Worked, but only added after the shift started: someone who turned up and was put on the schedule on site.
      unscheduled: !!inAt && +r.assigned_at > start,
      conditions: cond.map((k) => ({ code: k, ...CONDITIONS[k] })),
    };
  });
}
export type AttendanceRow = Awaited<ReturnType<typeof load>>[number];

export async function attendanceRoutes(app: FastifyInstance) {
  app.get('/api/attendance', { preHandler: viewers }, async (req) => {
    const q = z.object({
      from: day, to: day,
      client: z.string().trim().max(120).optional(),
      group: uuid.optional(),
      status: z.enum(STATUSES).optional(),
      cond: z.string().optional(),
      q: z.string().trim().max(120).optional(),
    }).parse(req.query);
    if (q.to < q.from) q.to = q.from;
    return withTenant(req.user.tid, async (c) => {
      const all = await load(c, q.from, q.to);
      const has = (s: string | null | undefined, t: string) => !!s && s.toLowerCase().includes(t.toLowerCase());
      const conds = (q.cond ?? '').split(',').filter((k): k is Cond => k in CONDITIONS);
      const rows = all.filter((r) =>
        (!q.client || has(r.event.client, q.client)) &&
        (!q.group || r.user.groups.includes(q.group)) &&
        (!q.status || r.status === q.status) &&
        (!conds.length || r.conditions.some((x) => conds.includes(x.code))) &&
        (!q.q || has(r.user.name, q.q) || has(r.event.name, q.q) || has(r.role, q.q) || has(r.event.number, q.q)));
      const groups = (await c.query('SELECT id, name FROM crew_groups ORDER BY name')).rows;
      return {
        rows,
        stats: {
          total: rows.length,
          scheduled: rows.filter((r) => !r.unscheduled).length,
          unscheduled: rows.filter((r) => r.unscheduled).length,
          unapprovedOut: rows.filter((r) => r.status === 'out').length,
          approved: rows.filter((r) => r.status === 'approved').length,
          flagged: rows.filter((r) => r.flagged).length,
        },
        groups,
        conditions: Object.entries(CONDITIONS).map(([code, v]) => ({ code, ...v })),
        canApprove: req.user.role !== 'hr',
      };
    });
  });

  // Approve many at once (a whole event, or the ticked rows). Only finished entries can be approved.
  app.post('/api/attendance/approve', { preHandler: mgr }, async (req) => {
    const b = z.object({ entryIds: z.array(uuid).min(1).max(500) }).parse(req.body);
    return withTenant(req.user.tid, async (c) => {
      const r = await c.query(
        `UPDATE time_entries SET status = 'approved', approved_by = $2, approved_at = now(), auto_approved = false
          WHERE id = ANY($1::uuid[]) AND status = 'submitted' AND clock_out IS NOT NULL RETURNING id`,
        [b.entryIds, req.user.sub],
      );
      for (const x of r.rows) await audit(c, req.user.tid, req.user.sub, 'time.approve', 'time_entry', x.id);
      return { approved: r.rowCount ?? 0, skipped: b.entryIds.length - (r.rowCount ?? 0) };
    });
  });

  app.post('/api/time-entries/:id/unapprove', { preHandler: mgr }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const out = await withTenant(req.user.tid, async (c) => {
      const e = (await c.query('SELECT status, payroll_exported_at FROM time_entries WHERE id = $1', [id])).rows[0];
      if (!e) return { code: 404, error: 'Time entry not found' };
      if (e.payroll_exported_at) return { code: 409, error: 'This time has already gone to payroll.' };
      if (e.status !== 'approved') return { code: 409, error: 'This time is not approved.' };
      await c.query("UPDATE time_entries SET status = 'submitted', approved_by = NULL, approved_at = NULL, auto_approved = false WHERE id = $1", [id]);
      await audit(c, req.user.tid, req.user.sub, 'time.unapprove', 'time_entry', id);
      return { code: 200 };
    });
    return reply.code(out.code).send(out.code === 200 ? { ok: true } : { error: out.error });
  });

  // Minimum paid hours for this one person's shift: their own number, back to the usual one (hours null), or off.
  app.put('/api/time-entries/:id/minimum', { preHandler: mgr }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ on: z.boolean(), hours: z.number().min(0.5).max(24).nullable().optional() }).parse(req.body);
    const out = await withTenant(req.user.tid, async (c) => {
      const e = (await c.query('SELECT status, payroll_exported_at FROM time_entries WHERE id = $1', [id])).rows[0];
      if (!e) return { code: 404, error: 'Time entry not found' };
      if (e.payroll_exported_at) return { code: 409, error: 'This time has already gone to payroll.' };
      await c.query('UPDATE time_entries SET min_off = $2, min_hours_override = $3 WHERE id = $1', [id, !b.on, b.on ? b.hours ?? null : null]);
      await audit(c, req.user.tid, req.user.sub, 'time.minimum', 'time_entry', id, b);
      return { code: 200 };
    });
    return reply.code(out.code).send(out.code === 200 ? { ok: true } : { error: out.error });
  });
}
