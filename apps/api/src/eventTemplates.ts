import type { PoolClient } from 'pg';
import { z } from 'zod';

/**
 * Event templates: a whole event's set-up (phases by day, named groups inside them, positions with their times,
 * people needed and pay settings), stored relative to the event's first day so it can start a new event on any date.
 * Times are wall-clock times in the company time zone.
 */
const hhmm = z.string().regex(/^\d{2}:\d{2}$/);
export const templateData = z.object({
  v: z.literal(1),
  days: z.number().int().min(1).max(62),
  phases: z.array(z.object({ day: z.number().int().min(0).max(61), label: z.string().min(1).max(80) })).max(62),
  groups: z.array(z.object({ phase: z.number().int().min(0), label: z.string().min(1).max(80), sort: z.number().int() })).max(300),
  shifts: z
    .array(
      z.object({
        day: z.number().int().min(0).max(61), start: hhmm, mins: z.number().int().min(1).max(24 * 60),
        role: z.string().min(1).max(100), headcount: z.number().int().min(1).max(500), isOpen: z.boolean(), certs: z.array(z.string()).max(10),
        phase: z.number().int().min(0).nullable(), group: z.number().int().min(0).nullable(),
        payType: z.enum(['hourly', 'day']), minHours: z.number().nullable(), payRate: z.number().nullable(), lead: z.number().int().min(0).nullable(),
      }),
    )
    .max(300),
});
export type TemplateData = z.infer<typeof templateData>;

const tzOf = async (c: PoolClient) => (await c.query('SELECT timezone FROM tenants LIMIT 1')).rows[0]?.timezone ?? 'UTC';

/** The template of an existing event. */
export async function buildTemplate(c: PoolClient, eventId: string): Promise<TemplateData | null> {
  const ev = (await c.query("SELECT id, to_char(start_date, 'YYYY-MM-DD') AS sd, to_char(end_date, 'YYYY-MM-DD') AS ed FROM events WHERE id = $1", [eventId])).rows[0];
  if (!ev) return null;
  const tz = await tzOf(c);
  const phases = (await c.query('SELECT id, label, (starts_on - $2::date) AS day FROM event_phases WHERE event_id = $1 ORDER BY starts_on, created_at', [eventId, ev.sd])).rows;
  const pIdx = new Map(phases.map((p, i) => [p.id as string, i]));
  const groups = (await c.query('SELECT id, phase_id, label, sort FROM phase_groups WHERE event_id = $1 ORDER BY sort, created_at', [eventId])).rows.filter((g) => pIdx.has(g.phase_id));
  const gIdx = new Map(groups.map((g, i) => [g.id as string, i]));
  const shifts = (
    await c.query(
      `SELECT id, role_name, ((starts_at AT TIME ZONE $3)::date - $2::date) AS day, to_char(starts_at AT TIME ZONE $3, 'HH24:MI') AS start,
              GREATEST(1, round(extract(epoch FROM ends_at - starts_at) / 60))::int AS mins, headcount, is_open, required_certs, phase_id, group_id,
              pay_type, min_hours::float AS min_hours, pay_rate_override::float AS pay_rate, lead_shift_id
         FROM shifts WHERE event_id = $1 ORDER BY starts_at, role_name LIMIT 300`,
      [eventId, ev.sd, tz],
    )
  ).rows.filter((s) => s.day >= 0 && s.day <= 61);
  const sIdx = new Map(shifts.map((s, i) => [s.id as string, i]));
  const span = Math.round((Date.parse(ev.ed) - Date.parse(ev.sd)) / 86400_000) + 1;
  const days = Math.min(62, Math.max(span, ...phases.map((p) => p.day + 1), ...shifts.map((s) => s.day + 1), 1));
  return templateData.parse({
    v: 1,
    days,
    phases: phases.filter((p) => p.day >= 0 && p.day <= 61).map((p) => ({ day: p.day, label: p.label })),
    groups: groups.map((g) => ({ phase: pIdx.get(g.phase_id)!, label: g.label, sort: g.sort })),
    shifts: shifts.map((s) => ({
      day: s.day, start: s.start, mins: Math.min(s.mins, 24 * 60), role: s.role_name, headcount: s.headcount, isOpen: s.is_open, certs: s.required_certs ?? [],
      phase: s.phase_id && pIdx.has(s.phase_id) ? pIdx.get(s.phase_id)! : null,
      group: s.group_id && gIdx.has(s.group_id) ? gIdx.get(s.group_id)! : null,
      payType: s.pay_type, minHours: s.min_hours, payRate: s.pay_rate, lead: s.lead_shift_id && sIdx.has(s.lead_shift_id) ? sIdx.get(s.lead_shift_id)! : null,
    })),
  });
}

/** Put a template's phases, groups and positions on an event, starting on its first day. The event's end date grows to fit. */
export async function applyTemplate(c: PoolClient, tid: string, eventId: string, data: TemplateData) {
  const ev = (await c.query("SELECT to_char(start_date, 'YYYY-MM-DD') AS sd FROM events WHERE id = $1", [eventId])).rows[0];
  if (!ev) return { phases: 0, shifts: 0 };
  const tz = await tzOf(c);
  const phaseIds: string[] = [];
  for (const p of data.phases)
    phaseIds.push((await c.query('INSERT INTO event_phases (tenant_id, event_id, label, starts_on, ends_on) VALUES ($1,$2,$3, $4::date + $5::int, $4::date + $5::int) RETURNING id', [tid, eventId, p.label, ev.sd, p.day])).rows[0].id);
  const groupIds: (string | null)[] = [];
  for (const g of data.groups)
    groupIds.push(phaseIds[g.phase] ? (await c.query('INSERT INTO phase_groups (tenant_id, event_id, phase_id, label, sort) VALUES ($1,$2,$3,$4,$5) RETURNING id', [tid, eventId, phaseIds[g.phase], g.label, g.sort])).rows[0].id : null);
  const shiftIds: string[] = [];
  for (const s of data.shifts) {
    const r = await c.query(
      `INSERT INTO shifts (tenant_id, event_id, role_name, starts_at, ends_at, headcount, is_open, required_certs, phase_id, group_id, pay_type, min_hours, pay_rate_override)
       VALUES ($1,$2,$3, (($4::date + $5::int) + $6::time) AT TIME ZONE $7, ((($4::date + $5::int) + $6::time) AT TIME ZONE $7) + make_interval(mins => $8),
               $9, false, $10, $11, $12, $13, $14, $15) RETURNING id`,
      [tid, eventId, s.role, ev.sd, s.day, s.start, tz, s.mins, s.headcount, s.certs, s.phase === null ? null : phaseIds[s.phase] ?? null, s.group === null ? null : groupIds[s.group] ?? null, s.payType, s.minHours, s.payRate],
    );
    shiftIds.push(r.rows[0].id);
  }
  for (let i = 0; i < data.shifts.length; i++) {
    const l = data.shifts[i].lead;
    if (l !== null && shiftIds[l] && l !== i) await c.query('UPDATE shifts SET lead_shift_id = $2 WHERE id = $1', [shiftIds[i], shiftIds[l]]);
  }
  await c.query("UPDATE events SET end_date = GREATEST(end_date, start_date + $2::int) WHERE id = $1", [eventId, data.days - 1]);
  return { phases: phaseIds.length, shifts: shiftIds.length };
}
