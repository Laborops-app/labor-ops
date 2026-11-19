import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { withTenant, audit } from '../db';
import { authenticate, guard } from '../auth';
import { loadAcct, saveAcct, localDate } from '../accounting';
import { csvCell } from '../payroll';

/**
 * Full-time staff time clock (like Connecteam): staff clock in and out on their own page, with breaks, a note and the
 * phone's location. The office sees who's on the clock and a weekly timecard per person, and can add, fix and approve
 * time. Hours a staff member works on an event (crew time entries) are shown on the same timecard and counted once
 * where they overlap a staff punch.
 */

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const loc = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), acc: z.number().min(0).max(100000).optional() }).partial();
const office = guard('admin', 'manager', 'hr');

type Iv = [number, number];
export type CardItem = {
  kind: 'punch' | 'event'; id: string; in: string; out: string | null; breakMin: number; minutes: number;
  note?: string | null; status: string; source?: string; edited?: boolean; inLoc?: { lat: number; lng: number; acc: number | null } | null;
  outLoc?: { lat: number; lng: number; acc: number | null } | null; event?: string; eventId?: string; role?: string;
};
export type CardDay = { date: string; minutes: number; items: CardItem[] };

const tzOf = async (c: PoolClient) => ((await c.query('SELECT timezone FROM tenants LIMIT 1')).rows[0]?.timezone as string) || 'America/Denver';
const weeklyOtOf = async (c: PoolClient) => Number((await c.query('SELECT weekly_ot_after FROM labor_rules LIMIT 1')).rows[0]?.weekly_ot_after ?? 40) || 40;

/** Monday of the week holding this local date. */
export function weekOf(date: string) {
  const d = new Date(`${date}T12:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7;
  const mon = new Date(d.getTime() - back * 86400000);
  const sun = new Date(mon.getTime() + 6 * 86400000);
  return { from: mon.toISOString().slice(0, 10), to: sun.toISOString().slice(0, 10) };
}

/** Total of a set of intervals with overlaps counted once. */
function union(list: Iv[]): Iv[] {
  const s = list.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out: Iv[] = [];
  for (const iv of s) {
    const last = out[out.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else out.push([iv[0], iv[1]]);
  }
  return out;
}
const len = (l: Iv[]) => l.reduce((s, [a, b]) => s + (b - a), 0);
/** Worked minutes: time on the clock (punches and event time, overlaps once) minus breaks taken inside it. */
function worked(work: Iv[], breaks: Iv[]) {
  const w = union(work);
  const b = union(breaks);
  let cut = 0;
  for (const [ba, bb] of b) for (const [wa, wb] of w) cut += Math.max(0, Math.min(bb, wb) - Math.max(ba, wa));
  return Math.max(0, Math.round((len(w) - cut) / 60000));
}

/** Staff punches and event time for these people between two local dates, grouped by person and day. */
export async function timecards(c: PoolClient, userIds: string[], from: string, to: string, tz: string) {
  const now = Date.now();
  const punches = (await c.query(
    `SELECT p.*, COALESCE((SELECT json_agg(json_build_object('s', b.starts_at, 'e', b.ends_at)) FROM staff_breaks b WHERE b.punch_id = p.id), '[]'::json) AS breaks
       FROM staff_punches p
      WHERE p.user_id = ANY($1::uuid[]) AND p.clock_in >= $2::date::timestamp AT TIME ZONE $4 AND p.clock_in < ($3::date + 1)::timestamp AT TIME ZONE $4
      ORDER BY p.clock_in`, [userIds, from, to, tz])).rows;
  const entries = (await c.query(
    `SELECT t.id, t.user_id, t.clock_in, t.clock_out, t.status, e.name AS event, e.id AS event_id, s.role_name,
            COALESCE((SELECT json_agg(json_build_object('s', b.started_at, 'e', b.ended_at)) FROM time_breaks b WHERE b.entry_id = t.id), '[]'::json) AS breaks
       FROM time_entries t JOIN shift_assignments a ON a.id = t.assignment_id JOIN shifts s ON s.id = a.shift_id JOIN events e ON e.id = s.event_id
      WHERE t.user_id = ANY($1::uuid[]) AND t.clock_in >= $2::date::timestamp AT TIME ZONE $4 AND t.clock_in < ($3::date + 1)::timestamp AT TIME ZONE $4
      ORDER BY t.clock_in`, [userIds, from, to, tz])).rows;
  const ms = (v: unknown) => (v ? new Date(String(v)).getTime() : now);
  const brk = (list: { s: string; e: string | null }[]): Iv[] => (list ?? []).map((b) => [ms(b.s), ms(b.e)] as Iv);
  const byUser = new Map<string, { days: Map<string, { items: CardItem[]; work: Iv[]; breaks: Iv[] }>; work: Iv[]; breaks: Iv[] }>();
  const slot = (uid: string, date: string) => {
    let u = byUser.get(uid);
    if (!u) byUser.set(uid, (u = { days: new Map(), work: [], breaks: [] }));
    let d = u.days.get(date);
    if (!d) u.days.set(date, (d = { items: [], work: [], breaks: [] }));
    return { u, d };
  };
  const ll = (lat: unknown, lng: unknown, acc: unknown) => (lat == null || lng == null ? null : { lat: Number(lat), lng: Number(lng), acc: acc == null ? null : Number(acc) });
  for (const p of punches) {
    const { u, d } = slot(p.user_id, localDate(tz, p.clock_in));
    const iv: Iv = [ms(p.clock_in), ms(p.clock_out)];
    const b = brk(p.breaks);
    const minutes = worked([iv], b);
    d.items.push({ kind: 'punch', id: p.id, in: new Date(p.clock_in).toISOString(), out: p.clock_out ? new Date(p.clock_out).toISOString() : null, breakMin: Math.round(len(union(b)) / 60000), minutes,
      note: p.note, status: p.status, source: p.source, edited: !!p.edited_at, inLoc: ll(p.in_lat, p.in_lng, p.in_acc), outLoc: ll(p.out_lat, p.out_lng, p.out_acc) });
    d.work.push(iv); d.breaks.push(...b); u.work.push(iv); u.breaks.push(...b);
  }
  for (const t of entries) {
    const { u, d } = slot(t.user_id, localDate(tz, t.clock_in));
    const iv: Iv = [ms(t.clock_in), ms(t.clock_out)];
    const b = brk(t.breaks);
    d.items.push({ kind: 'event', id: t.id, in: new Date(t.clock_in).toISOString(), out: t.clock_out ? new Date(t.clock_out).toISOString() : null, breakMin: Math.round(len(union(b)) / 60000),
      minutes: worked([iv], b), status: t.status, event: t.event, eventId: t.event_id, role: t.role_name });
    d.work.push(iv); d.breaks.push(...b); u.work.push(iv); u.breaks.push(...b);
  }
  const out = new Map<string, { minutes: number; days: CardDay[] }>();
  for (const uid of userIds) {
    const u = byUser.get(uid);
    if (!u) { out.set(uid, { minutes: 0, days: [] }); continue; }
    const days = [...u.days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, d]) => ({ date, minutes: worked(d.work, d.breaks), items: d.items.sort((a, b) => a.in.localeCompare(b.in)) }));
    out.set(uid, { minutes: worked(u.work, u.breaks), days });
  }
  return out;
}

async function openPunch(c: PoolClient, uid: string) {
  return (await c.query(
    `SELECT p.id, p.clock_in, p.note, (SELECT b.starts_at FROM staff_breaks b WHERE b.punch_id = p.id AND b.ends_at IS NULL) AS break_since
       FROM staff_punches p WHERE p.user_id = $1 AND p.clock_out IS NULL`, [uid])).rows[0] ?? null;
}

const isStaff = async (c: PoolClient, uid: string) => (await c.query("SELECT 1 FROM users WHERE id = $1 AND employment = 'fulltime' AND active", [uid])).rowCount === 1;
const fmt = (tz: string, iso: string | null) => (iso ? new Date(iso).toLocaleString('en-US', { timeZone: tz, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'still on');

export async function staffClockRoutes(app: FastifyInstance) {
  // ---------- staff: their own clock ----------
  app.get('/api/staff-clock/me', { preHandler: authenticate }, async (req, reply) => {
    const out = await withTenant(req.user.tid, async (c) => {
      if (!(await isStaff(c, req.user.sub))) return null;
      const tz = await tzOf(c);
      const today = localDate(tz, new Date());
      const wk = weekOf(today);
      const card = (await timecards(c, [req.user.sub], wk.from, wk.to, tz)).get(req.user.sub)!;
      const open = await openPunch(c, req.user.sub);
      const upcoming = (await c.query(
        `SELECT a.id, a.status, s.role_name, s.starts_at, s.ends_at, e.name AS event, e.venue
           FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id JOIN events e ON e.id = s.event_id
          WHERE a.user_id = $1 AND a.status IN ('offered', 'accepted') AND s.ends_at > now() - interval '12 hours' AND s.starts_at < now() + interval '21 days'
            AND e.archived_at IS NULL ORDER BY s.starts_at LIMIT 10`, [req.user.sub])).rows;
      return { tz, today, week: wk, weeklyOt: await weeklyOtOf(c), open, todayMin: card.days.find((d) => d.date === today)?.minutes ?? 0, weekMin: card.minutes, days: card.days, upcoming };
    });
    if (!out) return reply.code(403).send({ error: 'Your account isn’t set up for the staff time clock. Ask your manager.', reason: 'not_staff' });
    return out;
  });

  const punchBody = loc.extend({ note: z.string().trim().max(500).optional().nullable() });
  app.post('/api/staff-clock/in', { preHandler: authenticate }, async (req, reply) => {
    const b = punchBody.parse(req.body ?? {});
    const out = await withTenant(req.user.tid, async (c) => {
      if (!(await isStaff(c, req.user.sub))) return { code: 403, error: 'Your account isn’t set up for the staff time clock.' };
      if (await openPunch(c, req.user.sub)) return { code: 409, error: 'You’re already clocked in.' };
      const p = (await c.query(
        `INSERT INTO staff_punches (tenant_id, user_id, in_lat, in_lng, in_acc, note) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, clock_in`,
        [req.user.tid, req.user.sub, b.lat ?? null, b.lng ?? null, b.acc ?? null, b.note || null])).rows[0];
      await audit(c, req.user.tid, req.user.sub, 'staff.clock_in', 'staff_punch', p.id, { userId: req.user.sub, located: b.lat != null });
      return { code: 201, punch: p };
    });
    return reply.code(out.code).send(out);
  });

  app.post('/api/staff-clock/out', { preHandler: authenticate }, async (req, reply) => {
    const b = punchBody.parse(req.body ?? {});
    const out = await withTenant(req.user.tid, async (c) => {
      const open = await openPunch(c, req.user.sub);
      if (!open) return { code: 409, error: 'You’re not clocked in.' };
      await c.query('UPDATE staff_breaks SET ends_at = now() WHERE punch_id = $1 AND ends_at IS NULL', [open.id]);
      await c.query(
        `UPDATE staff_punches SET clock_out = now(), out_lat = $2, out_lng = $3, out_acc = $4, note = COALESCE($5, note) WHERE id = $1`,
        [open.id, b.lat ?? null, b.lng ?? null, b.acc ?? null, b.note || null]);
      await audit(c, req.user.tid, req.user.sub, 'staff.clock_out', 'staff_punch', open.id, { userId: req.user.sub, located: b.lat != null });
      return { code: 200, ok: true };
    });
    return reply.code(out.code).send(out);
  });

  app.post('/api/staff-clock/break', { preHandler: authenticate }, async (req, reply) => {
    const b = z.object({ action: z.enum(['start', 'end']) }).parse(req.body);
    const out = await withTenant(req.user.tid, async (c) => {
      const open = await openPunch(c, req.user.sub);
      if (!open) return { code: 409, error: 'Clock in first.' };
      if (b.action === 'start') {
        if (open.break_since) return { code: 409, error: 'You’re already on a break.' };
        await c.query('INSERT INTO staff_breaks (tenant_id, punch_id, user_id) VALUES ($1,$2,$3)', [req.user.tid, open.id, req.user.sub]);
      } else {
        if (!open.break_since) return { code: 409, error: 'You’re not on a break.' };
        await c.query('UPDATE staff_breaks SET ends_at = now() WHERE punch_id = $1 AND ends_at IS NULL', [open.id]);
      }
      await audit(c, req.user.tid, req.user.sub, `staff.break_${b.action}`, 'staff_punch', open.id, { userId: req.user.sub });
      return { code: 200, ok: true };
    });
    return reply.code(out.code).send(out);
  });

  // ---------- office ----------
  app.get('/api/staff', { preHandler: office }, async (req) => {
    const q = z.object({ week: ymd.optional(), all: z.enum(['0', '1']).optional() }).parse(req.query);
    return withTenant(req.user.tid, async (c) => {
      const tz = await tzOf(c);
      const wk = weekOf(q.week ?? localDate(tz, new Date()));
      const people = (await c.query(
        `SELECT u.id, u.name, u.email, u.phone, u.role, u.skills, u.active,
                (SELECT json_build_object('id', p.id, 'since', p.clock_in, 'onBreak', EXISTS (SELECT 1 FROM staff_breaks b WHERE b.punch_id = p.id AND b.ends_at IS NULL))
                   FROM staff_punches p WHERE p.user_id = u.id AND p.clock_out IS NULL) AS open
           FROM users u WHERE u.employment = 'fulltime' AND ($1 OR u.active) ORDER BY u.active DESC, u.name`, [q.all === '1'])).rows;
      const cards = await timecards(c, people.map((p) => p.id), wk.from, wk.to, tz);
      const ot = await weeklyOtOf(c);
      const s = await loadAcct(c);
      return {
        tz, week: wk, weeklyOt: ot, includeInPayroll: !!s.payroll.includeFulltime,
        people: people.map((p) => {
          const card = cards.get(p.id)!;
          const items = card.days.flatMap((d) => d.items);
          return { ...p, weekMin: card.minutes, overtimeMin: Math.max(0, card.minutes - ot * 60), unapproved: items.filter((i) => i.kind === 'punch' && i.status !== 'approved' && i.out).length, days: card.days };
        }),
      };
    });
  });

  /** A punch must not overlap another of the same person's punches. */
  const overlap = async (c: PoolClient, uid: string, from: string, to: string | null, except?: string) =>
    (await c.query(
      `SELECT clock_in, clock_out FROM staff_punches WHERE user_id = $1 AND id IS DISTINCT FROM $4::uuid
         AND tstzrange(clock_in, COALESCE(clock_out, 'infinity')) && tstzrange($2::timestamptz, COALESCE($3::timestamptz, 'infinity')) LIMIT 1`,
      [uid, from, to, except ?? null])).rows[0];

  const addBody = z.object({ userId: z.string().uuid(), in: z.string().datetime({ offset: true }), out: z.string().datetime({ offset: true }).nullable().optional(), note: z.string().trim().max(500).nullable().optional(), reason: z.string().trim().max(200).optional() });
  app.post('/api/staff/punches', { preHandler: office }, async (req, reply) => {
    const b = addBody.parse(req.body);
    const out = await withTenant(req.user.tid, async (c) => {
      if (!(await isStaff(c, b.userId))) return { code: 404, error: 'Not a full-time staff member' };
      if (b.out && new Date(b.out) < new Date(b.in)) return { code: 400, error: 'Clock out is before clock in.' };
      if (new Date(b.in).getTime() > Date.now() + 5 * 60000) return { code: 400, error: 'That clock-in is in the future.' };
      if (!b.out && (await openPunch(c, b.userId))) return { code: 409, error: 'They’re already clocked in.' };
      const clash = await overlap(c, b.userId, b.in, b.out ?? null);
      if (clash) return { code: 409, error: 'That overlaps time they already have on the clock.' };
      const tz = await tzOf(c);
      const p = (await c.query(
        `INSERT INTO staff_punches (tenant_id, user_id, clock_in, clock_out, note, source, edited_by, edited_at) VALUES ($1,$2,$3,$4,$5,'office',$6, now()) RETURNING id`,
        [req.user.tid, b.userId, b.in, b.out ?? null, b.note || null, req.user.sub])).rows[0];
      await audit(c, req.user.tid, req.user.sub, 'staff.add', 'staff_punch', p.id, { userId: b.userId, in: b.in, out: b.out ?? null, reason: b.reason, inText: fmt(tz, b.in) });
      return { code: 201, id: p.id };
    });
    return reply.code(out.code).send(out);
  });

  const editBody = z.object({ in: z.string().datetime({ offset: true }).optional(), out: z.string().datetime({ offset: true }).nullable().optional(), note: z.string().trim().max(500).nullable().optional(), reason: z.string().trim().max(200).optional() });
  app.patch('/api/staff/punches/:id', { preHandler: office }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = editBody.parse(req.body);
    const out = await withTenant(req.user.tid, async (c) => {
      const p = (await c.query('SELECT * FROM staff_punches WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!p) return { code: 404, error: 'Not found' };
      const nin = b.in ?? new Date(p.clock_in).toISOString();
      const nout = b.out === undefined ? (p.clock_out ? new Date(p.clock_out).toISOString() : null) : b.out;
      if (nout && new Date(nout) < new Date(nin)) return { code: 400, error: 'Clock out is before clock in.' };
      if (await overlap(c, p.user_id, nin, nout, id)) return { code: 409, error: 'That overlaps other time they have on the clock.' };
      await c.query(
        `UPDATE staff_punches SET clock_in = $2, clock_out = $3, note = CASE WHEN $5 THEN $4 ELSE note END, edited_by = $6, edited_at = now(), status = 'open', approved_by = NULL, approved_at = NULL WHERE id = $1`,
        [id, nin, nout, b.note ?? null, b.note !== undefined, req.user.sub]);
      if (nout) {
        await c.query('DELETE FROM staff_breaks WHERE punch_id = $1 AND starts_at >= $2::timestamptz', [id, nout]);
        await c.query('UPDATE staff_breaks SET ends_at = $2 WHERE punch_id = $1 AND (ends_at IS NULL OR ends_at > $2::timestamptz)', [id, nout]);
      }
      await audit(c, req.user.tid, req.user.sub, 'staff.edit', 'staff_punch', id, {
        userId: p.user_id, from: { in: p.clock_in, out: p.clock_out }, to: { in: nin, out: nout }, reason: b.reason,
      });
      return { code: 200, ok: true };
    });
    return reply.code(out.code).send(out);
  });

  app.delete('/api/staff/punches/:id', { preHandler: office }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const reason = z.object({ reason: z.string().trim().max(200).optional() }).parse(req.query ?? {}).reason;
    const out = await withTenant(req.user.tid, async (c) => {
      const p = (await c.query('DELETE FROM staff_punches WHERE id = $1 RETURNING user_id, clock_in, clock_out', [id])).rows[0];
      if (!p) return { code: 404, error: 'Not found' };
      await audit(c, req.user.tid, req.user.sub, 'staff.delete', 'staff_punch', id, { userId: p.user_id, in: p.clock_in, out: p.clock_out, reason });
      return { code: 200, ok: true };
    });
    return reply.code(out.code).send(out);
  });

  // Clock someone out from the office (they forgot).
  app.post('/api/staff/:id/clock-out', { preHandler: office }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ at: z.string().datetime({ offset: true }).optional() }).parse(req.body ?? {});
    const out = await withTenant(req.user.tid, async (c) => {
      const open = await openPunch(c, id);
      if (!open) return { code: 409, error: 'They’re not clocked in.' };
      const at = b.at ?? new Date().toISOString();
      if (new Date(at) < new Date(open.clock_in)) return { code: 400, error: 'That’s before they clocked in.' };
      await c.query('DELETE FROM staff_breaks WHERE punch_id = $1 AND starts_at >= $2::timestamptz', [open.id, at]);
      await c.query('UPDATE staff_breaks SET ends_at = $2 WHERE punch_id = $1 AND (ends_at IS NULL OR ends_at > $2::timestamptz)', [open.id, at]);
      await c.query('UPDATE staff_punches SET clock_out = $2, edited_by = $3, edited_at = now() WHERE id = $1', [open.id, at, req.user.sub]);
      await audit(c, req.user.tid, req.user.sub, 'staff.clock_out', 'staff_punch', open.id, { userId: id });
      return { code: 200, ok: true };
    });
    return reply.code(out.code).send(out);
  });

  app.post('/api/staff/approve', { preHandler: office }, async (req, reply) => {
    const b = z.object({ userId: z.string().uuid(), from: ymd, to: ymd, undo: z.boolean().optional() }).parse(req.body);
    const out = await withTenant(req.user.tid, async (c) => {
      const tz = await tzOf(c);
      const r = await c.query(
        b.undo
          ? `UPDATE staff_punches SET status = 'open', approved_by = NULL, approved_at = NULL WHERE user_id = $1 AND status = 'approved' AND exported_at IS NULL
               AND clock_in >= $2::date::timestamp AT TIME ZONE $4 AND clock_in < ($3::date + 1)::timestamp AT TIME ZONE $4 RETURNING id`
          : `UPDATE staff_punches SET status = 'approved', approved_by = $5, approved_at = now() WHERE user_id = $1 AND status = 'open' AND clock_out IS NOT NULL
               AND clock_in >= $2::date::timestamp AT TIME ZONE $4 AND clock_in < ($3::date + 1)::timestamp AT TIME ZONE $4 RETURNING id`,
        b.undo ? [b.userId, b.from, b.to, tz] : [b.userId, b.from, b.to, tz, req.user.sub]);
      if (r.rowCount) await audit(c, req.user.tid, req.user.sub, b.undo ? 'staff.unapprove' : 'staff.approve', 'user', b.userId, { userId: b.userId, count: r.rowCount, from: b.from, to: b.to });
      return { code: 200, count: r.rowCount };
    });
    return reply.code(out.code).send(out);
  });

  // Staff timecards as a CSV for whoever runs full-time payroll: one row per punch or event entry, then each person's total.
  app.get('/api/staff/export', { preHandler: office }, async (req, reply) => {
    const q = z.object({ from: ymd, to: ymd, approved: z.enum(['0', '1']).default('0') }).parse(req.query);
    if (q.from > q.to || (Date.parse(q.to) - Date.parse(q.from)) / 86400000 > 62) return reply.code(400).send({ error: 'Choose a period of two months or less' });
    const csv = await withTenant(req.user.tid, async (c) => {
      const tz = await tzOf(c);
      const people = (await c.query("SELECT id, name, email FROM users WHERE employment = 'fulltime' ORDER BY name")).rows;
      const cards = await timecards(c, people.map((p) => p.id), q.from, q.to, tz);
      const t = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }) : '');
      const h = (m: number) => (m / 60).toFixed(2);
      const rows = [['Name', 'Email', 'Date', 'Type', 'Event', 'Position', 'In', 'Out', 'Break (min)', 'Hours', 'Status', 'Note']];
      for (const p of people) {
        const card = cards.get(p.id)!;
        if (!card.days.length) continue;
        for (const d of card.days)
          for (const i of d.items) {
            if (q.approved === '1' && i.status !== 'approved') continue;
            rows.push([p.name, p.email, d.date, i.kind === 'punch' ? 'Staff clock' : 'Event', i.event ?? '', i.role ?? '', t(i.in), t(i.out), String(i.breakMin), h(i.minutes), i.status, i.note ?? '']);
          }
        rows.push([p.name, p.email, `${q.from} to ${q.to}`, 'Total (overlaps counted once)', '', '', '', '', '', h(card.minutes), '', '']);
      }
      if (rows.length > 1) {
        const ids = [...cards.values()].flatMap((cd) => cd.days.flatMap((d) => d.items.filter((i) => i.kind === 'punch' && i.status === 'approved').map((i) => i.id)));
        if (ids.length) await c.query('UPDATE staff_punches SET exported_at = now() WHERE id = ANY($1::uuid[]) AND exported_at IS NULL', [ids]);
      }
      return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
    });
    return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="staff-timecards-${q.from}-to-${q.to}.csv"`).send(csv);
  });

  // Crew ↔ full-time staff.
  app.put('/api/crew/:id/employment', { preHandler: guard('admin', 'manager') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ employment: z.enum(['crew', 'fulltime']) }).parse(req.body);
    const out = await withTenant(req.user.tid, async (c) => {
      const u = (await c.query("SELECT id, employment FROM users WHERE id = $1 AND role <> 'client'", [id])).rows[0];
      if (!u) return { code: 404, error: 'Not found' };
      if (u.employment === b.employment) return { code: 200, employment: b.employment };
      if (b.employment === 'crew') await c.query('UPDATE staff_punches SET clock_out = now() WHERE user_id = $1 AND clock_out IS NULL', [id]);
      await c.query('UPDATE users SET employment = $2 WHERE id = $1', [id, b.employment]);
      await audit(c, req.user.tid, req.user.sub, 'staff.employment', 'user', id, { userId: id, employment: b.employment });
      return { code: 200, employment: b.employment };
    });
    return reply.code(out.code).send(out);
  });

  // Payroll exports leave full-time staff out unless this is on.
  app.put('/api/payroll/include-fulltime', { preHandler: guard('admin') }, async (req) => {
    const b = z.object({ include: z.boolean() }).parse(req.body);
    return withTenant(req.user.tid, async (c) => {
      const s = await loadAcct(c);
      s.payroll.includeFulltime = b.include;
      await saveAcct(c, req.user.tid, s);
      await audit(c, req.user.tid, req.user.sub, 'payroll.include_fulltime', 'tenant', req.user.tid, { include: b.include });
      return { includeFulltime: b.include };
    });
  });
}

