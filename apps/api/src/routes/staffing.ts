import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { authenticate, guard } from '../auth';
import { withTenant, audit } from '../db';
import { config } from '../config';
import { describeShift, notify, type NotifyInput } from '../notify';
import { respondLinks } from '../notify/respond';
import { buildTemplate, templateData } from '../eventTemplates';
import { assignCrew } from './events';

/**
 * Faster set-up and staffing: event templates, duplicating positions and whole days, role defaults,
 * building the crew quietly then publishing, nudging people who haven't answered, and "Are you free?" checks.
 */
const uuid = z.string().uuid();
const idParam = z.object({ id: uuid });
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const mgr = guard('admin', 'manager');
const NUDGE_GAP_MIN = 60;

const tzOf = async (c: PoolClient) => (await c.query('SELECT timezone FROM tenants LIMIT 1')).rows[0]?.timezone ?? 'UTC';
const fmtDay = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
/** Short list of days: "Fri Nov 14, Sat Nov 15 and Sun Nov 16". */
export const dayList = (dates: string[]) => {
  const l = [...dates].sort().map(fmtDay);
  return l.length <= 1 ? l.join('') : `${l.slice(0, -1).join(', ')} and ${l[l.length - 1]}`;
};

/** Remind one person to answer an offer. Returns false when they were nudged too recently. */
export async function nudgeOne(c: PoolClient, tid: string, a: { id: string; user_id: string; shift_id: string }) {
  const r = await c.query(
    `UPDATE shift_assignments SET nudged_at = now() WHERE id = $1 AND status = 'offered' AND (nudged_at IS NULL OR nudged_at < now() - make_interval(mins => $2)) RETURNING id`,
    [a.id, NUDGE_GAP_MIN],
  );
  if (!r.rowCount) return false;
  const d = await describeShift(c, tid, a.shift_id, a.user_id);
  if (!d) return false;
  const links = respondLinks(tid, a.id, a.user_id);
  await notify(c, tid, {
    userId: a.user_id, category: 'assignment', title: `Reminder: please answer · ${d.role}`,
    body: `${d.line}${d.payLine ? '\n' + d.payLine : ''}\n\nYou were offered this shift and haven't answered yet. Please accept or decline so the crew can be finalized.`,
    link: `/my-shifts/${a.id}`, sms: `Reminder: please accept or decline ${d.role}, ${d.event}, ${d.when}:`, smsLink: links.accept.replace('&a=accept', ''),
    actions: [{ label: 'Accept shift', url: links.accept, kind: 'accept' }, { label: 'Decline', url: links.decline, kind: 'decline' }],
  });
  return true;
}

export async function staffingRoutes(app: FastifyInstance) {
  // ---------- event templates ----------
  app.get('/api/event-templates', { preHandler: mgr }, async (req) => {
    const q = z.object({ customerId: uuid.optional() }).parse(req.query);
    return withTenant(req.user.tid, async (c) => ({
      templates: (
        await c.query(
          `SELECT t.id, t.name, t.customer_id, cu.name AS customer_name, t.created_at, (t.data->>'days')::int AS days,
                  jsonb_array_length(t.data->'phases') AS phases, jsonb_array_length(t.data->'shifts') AS positions,
                  (SELECT COALESCE(sum((x->>'headcount')::int), 0) FROM jsonb_array_elements(t.data->'shifts') x)::int AS people
             FROM event_templates t LEFT JOIN customers cu ON cu.id = t.customer_id
            WHERE t.customer_id IS NULL OR $1::uuid IS NULL OR t.customer_id = $1
            ORDER BY (t.customer_id = $1) DESC NULLS LAST, lower(t.name)`,
          [q.customerId ?? null],
        )
      ).rows,
    }));
  });

  app.post('/api/events/:id/save-template', { preHandler: mgr }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const b = z.object({ name: z.string().trim().min(1).max(120), customerOnly: z.boolean().default(false) }).parse(req.body);
    const out = await withTenant(req.user.tid, async (c) => {
      const ev = (await c.query('SELECT customer_id FROM events WHERE id = $1', [id])).rows[0];
      if (!ev) return null;
      const data = await buildTemplate(c, id);
      if (!data || (!data.shifts.length && !data.phases.length)) return 'empty' as const;
      // Saving under an existing name replaces that template.
      const cust = b.customerOnly ? ev.customer_id : null;
      const old = (await c.query('SELECT id FROM event_templates WHERE lower(name) = lower($1) AND customer_id IS NOT DISTINCT FROM $2', [b.name, cust])).rows[0];
      const t = old
        ? (await c.query('UPDATE event_templates SET data = $2, created_by = $3, created_at = now() WHERE id = $1 RETURNING id, name', [old.id, JSON.stringify(data), req.user.sub])).rows[0]
        : (await c.query('INSERT INTO event_templates (tenant_id, name, customer_id, data, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id, name', [req.user.tid, b.name, cust, JSON.stringify(data), req.user.sub])).rows[0];
      await audit(c, req.user.tid, req.user.sub, 'event_template.save', 'event_template', t.id, { from: id, positions: data.shifts.length, replaced: !!old });
      return { template: { ...t, phases: data.phases.length, positions: data.shifts.length, days: data.days }, replaced: !!old };
    });
    if (!out) return reply.code(404).send({ error: 'Event not found' });
    if (out === 'empty') return reply.code(400).send({ error: 'Add phases or positions to this event first' });
    return reply.code(201).send(out);
  });

  app.delete('/api/event-templates/:id', { preHandler: mgr }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const n = await withTenant(req.user.tid, async (c) => {
      const r = await c.query('DELETE FROM event_templates WHERE id = $1 RETURNING name', [id]);
      if (r.rowCount) await audit(c, req.user.tid, req.user.sub, 'event_template.delete', 'event_template', id, { name: r.rows[0].name });
      return r.rowCount;
    });
    return n ? { ok: true } : reply.code(404).send({ error: 'Template not found' });
  });

  // What a template holds, for the preview in the new-event window.
  app.get('/api/event-templates/:id', { preHandler: mgr }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const t = await withTenant(req.user.tid, async (c) => (await c.query('SELECT id, name, customer_id, data FROM event_templates WHERE id = $1', [id])).rows[0]);
    if (!t) return reply.code(404).send({ error: 'Template not found' });
    return { template: { ...t, data: templateData.parse(t.data) } };
  });

  // ---------- quicker positions ----------
  // Same position again (same phase, group, times and pay); nobody is put on it.
  app.post('/api/shifts/:id/duplicate', { preHandler: mgr }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const row = await withTenant(req.user.tid, async (c) => {
      const r = (
        await c.query(
          `INSERT INTO shifts (tenant_id, event_id, role_name, starts_at, ends_at, headcount, is_open, required_certs, phase_id, group_id, pay_type, min_hours, pay_rate_override, lead_shift_id)
           SELECT tenant_id, event_id, role_name, starts_at, ends_at, headcount, false, required_certs, phase_id, group_id, pay_type, min_hours, pay_rate_override, lead_shift_id
             FROM shifts WHERE id = $1 RETURNING id, event_id, role_name`,
          [id],
        )
      ).rows[0];
      if (r) await audit(c, req.user.tid, req.user.sub, 'shift.duplicate', 'shift', r.id, { from: id });
      return r;
    });
    return row ? reply.code(201).send({ shift: row }) : reply.code(404).send({ error: 'Shift not found' });
  });

  // Copy a day (phase) to other days: same name, groups and positions, same times of day. Crew are not copied.
  // A day that already has a phase with the same name gets the positions added to it.
  app.post('/api/event-phases/:id/copy', { preHandler: mgr }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const b = z.object({ dates: z.array(ymd).min(1).max(31) }).parse(req.body);
    const out = await withTenant(req.user.tid, async (c) => {
      const p = (await c.query("SELECT id, event_id, label, to_char(starts_on, 'YYYY-MM-DD') AS day FROM event_phases WHERE id = $1", [id])).rows[0];
      if (!p) return null;
      const tz = await tzOf(c);
      const groups = (await c.query('SELECT id, label, sort FROM phase_groups WHERE phase_id = $1 ORDER BY sort, created_at', [id])).rows;
      const shifts = (await c.query('SELECT * FROM shifts WHERE phase_id = $1 ORDER BY starts_at', [id])).rows;
      let phases = 0, made = 0;
      for (const date of [...new Set(b.dates)].filter((x) => x !== p.day).sort()) {
        const off = Math.round((Date.parse(date) - Date.parse(p.day)) / 86400_000);
        let target = (await c.query('SELECT id FROM event_phases WHERE event_id = $1 AND starts_on = $2::date AND lower(label) = lower($3) LIMIT 1', [p.event_id, date, p.label])).rows[0]?.id as string | undefined;
        if (!target) {
          target = (await c.query('INSERT INTO event_phases (tenant_id, event_id, label, starts_on, ends_on) VALUES ($1,$2,$3,$4,$4) RETURNING id', [req.user.tid, p.event_id, p.label, date])).rows[0].id as string;
          phases++;
        }
        const gmap = new Map<string, string>();
        for (const g of groups) {
          const have = (await c.query('SELECT id FROM phase_groups WHERE phase_id = $1 AND lower(label) = lower($2) LIMIT 1', [target, g.label])).rows[0]?.id;
          gmap.set(g.id, have ?? (await c.query('INSERT INTO phase_groups (tenant_id, event_id, phase_id, label, sort) VALUES ($1,$2,$3,$4,$5) RETURNING id', [req.user.tid, p.event_id, target, g.label, g.sort])).rows[0].id);
        }
        for (const s of shifts) {
          await c.query(
            `INSERT INTO shifts (tenant_id, event_id, role_name, starts_at, ends_at, headcount, is_open, required_certs, phase_id, group_id, pay_type, min_hours, pay_rate_override)
             VALUES ($1,$2,$3, (($4::timestamptz AT TIME ZONE $6) + make_interval(days => $7)) AT TIME ZONE $6, (($5::timestamptz AT TIME ZONE $6) + make_interval(days => $7)) AT TIME ZONE $6,
                     $8, false, $9, $10, $11, $12, $13, $14)`,
            [req.user.tid, p.event_id, s.role_name, s.starts_at, s.ends_at, tz, off, s.headcount, s.required_certs, target, s.group_id ? gmap.get(s.group_id) ?? null : null, s.pay_type, s.min_hours, s.pay_rate_override],
          );
          made++;
        }
      }
      // The event's dates stretch to cover the new days.
      await c.query(
        'UPDATE events SET start_date = LEAST(start_date, (SELECT min(starts_on) FROM event_phases WHERE event_id = $1)), end_date = GREATEST(end_date, (SELECT max(ends_on) FROM event_phases WHERE event_id = $1)) WHERE id = $1',
        [p.event_id],
      );
      await audit(c, req.user.tid, req.user.sub, 'phase.copy', 'event_phase', id, { dates: b.dates, phases, shifts: made });
      return { phases, shifts: made };
    });
    return out ? reply.code(201).send(out) : reply.code(404).send({ error: 'Phase not found' });
  });

  // What a new position of this role starts with: people needed, start and end time (blank = no default).
  app.put('/api/skills/:id/defaults', { preHandler: mgr }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const t = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable();
    const b = z.object({ headcount: z.number().int().min(1).max(500).nullable(), start: t, end: t }).parse(req.body);
    const r = await withTenant(req.user.tid, async (c) => {
      const u = await c.query('UPDATE skills SET default_headcount = $2, default_start = $3::time, default_end = $4::time WHERE id = $1 RETURNING name', [id, b.headcount, b.start, b.end]);
      if (u.rowCount) await audit(c, req.user.tid, req.user.sub, 'skill.defaults', 'skill', id, b);
      return u.rowCount;
    });
    return r ? { ok: true } : reply.code(404).send({ error: 'Role not found' });
  });
  app.get('/api/role-defaults', { preHandler: mgr }, async (req) =>
    withTenant(req.user.tid, async (c) => ({
      roles: (
        await c.query(
          `SELECT id, name, default_headcount AS headcount, to_char(default_start, 'HH24:MI') AS start, to_char(default_end, 'HH24:MI') AS "end"
             FROM skills WHERE active ORDER BY lower(name)`,
        )
      ).rows,
    })),
  );

  // ---------- build quietly, then publish ----------
  // Whether new events start building quietly (on unless the company turns it off).
  app.get('/api/staffing/settings', { preHandler: mgr }, async (req) =>
    withTenant(req.user.tid, async (c) => ({ quietByDefault: (await c.query('SELECT quiet_default FROM staffing_settings LIMIT 1')).rows[0]?.quiet_default ?? true })),
  );
  app.put('/api/staffing/settings', { preHandler: guard('admin') }, async (req) => {
    const b = z.object({ quietByDefault: z.boolean() }).parse(req.body);
    return withTenant(req.user.tid, async (c) => {
      await c.query(
        'INSERT INTO staffing_settings (tenant_id, quiet_default) VALUES ($1,$2) ON CONFLICT (tenant_id) DO UPDATE SET quiet_default = $2, updated_at = now()',
        [req.user.tid, b.quietByDefault],
      );
      await audit(c, req.user.tid, req.user.sub, 'staffing.settings', 'tenant', null, b);
      return { quietByDefault: b.quietByDefault };
    });
  });

  app.put('/api/events/:id/build-quietly', { preHandler: mgr }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const { on } = z.object({ on: z.boolean() }).parse(req.body);
    const r = await withTenant(req.user.tid, async (c) => {
      if (!on && (await c.query('SELECT 1 FROM planned_picks WHERE event_id = $1 LIMIT 1', [id])).rowCount) return 'picks' as const;
      const u = await c.query('UPDATE events SET staffing_draft = $2 WHERE id = $1', [id, on]);
      if (u.rowCount) await audit(c, req.user.tid, req.user.sub, on ? 'event.build_quietly' : 'event.build_live', 'event', id);
      return u.rowCount;
    });
    if (r === 'picks') return reply.code(409).send({ error: 'Publish the planned crew (or remove them) first' });
    return r ? { ok: true, on } : reply.code(404).send({ error: 'Event not found' });
  });

  // Send everything planned: each pick becomes a real offer (or a confirmed booking) and the person is told.
  app.post('/api/events/:id/publish', { preHandler: mgr }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const out = await withTenant(req.user.tid, async (c) => {
      const ev = (await c.query('SELECT id FROM events WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!ev) return null;
      await c.query('UPDATE events SET staffing_draft = false WHERE id = $1', [id]);
      const picks = (
        await c.query(
          `SELECT p.*, u.name AS user_name, s.role_name FROM planned_picks p JOIN users u ON u.id = p.user_id JOIN shifts s ON s.id = p.shift_id
            WHERE p.event_id = $1 ORDER BY s.starts_at, p.created_at`,
          [id],
        )
      ).rows;
      await c.query('DELETE FROM planned_picks WHERE event_id = $1', [id]);
      let offered = 0, confirmed = 0;
      const failed: { name: string; role: string; error: string }[] = [];
      for (const p of picks) {
        await c.query('SAVEPOINT pick');
        try {
          // The coordinator already okayed rule and availability warnings when planning; certificates and double-booking still block.
          const r = await assignCrew(c, req.user.tid, req.user.sub, p.shift_id, p.user_id, true, p.confirmed, true, p.is_lead ?? undefined);
          if (r.code === 201) {
            await c.query('RELEASE SAVEPOINT pick');
            if (p.confirmed) confirmed++;
            else offered++;
          } else {
            await c.query('ROLLBACK TO SAVEPOINT pick');
            failed.push({ name: p.user_name, role: p.role_name, error: String(r.error ?? 'Could not be added') });
          }
        } catch (e) {
          await c.query('ROLLBACK TO SAVEPOINT pick');
          failed.push({ name: p.user_name, role: p.role_name, error: (e as Error).message });
        }
      }
      await audit(c, req.user.tid, req.user.sub, 'event.publish', 'event', id, { offered, confirmed, failed: failed.length });
      return { offered, confirmed, failed };
    });
    return out ?? reply.code(404).send({ error: 'Event not found' });
  });

  app.delete('/api/planned-picks/:id', { preHandler: mgr }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const n = await withTenant(req.user.tid, async (c) => (await c.query('DELETE FROM planned_picks WHERE id = $1', [id])).rowCount);
    return n ? { ok: true } : reply.code(404).send({ error: 'Not found' });
  });

  // ---------- nudge people who haven't answered ----------
  app.post('/api/assignments/:id/nudge', { preHandler: mgr }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const r = await withTenant(req.user.tid, async (c) => {
      const a = (await c.query("SELECT a.id, a.user_id, a.shift_id, a.status, a.nudged_at FROM shift_assignments a WHERE a.id = $1", [id])).rows[0];
      if (!a) return 'none' as const;
      if (a.status !== 'offered') return 'answered' as const;
      const ok = await nudgeOne(c, req.user.tid, a);
      if (ok) await audit(c, req.user.tid, req.user.sub, 'assignment.nudge', 'assignment', id);
      return ok ? ('ok' as const) : ('recent' as const);
    });
    if (r === 'none') return reply.code(404).send({ error: 'Not found' });
    if (r === 'answered') return reply.code(409).send({ error: 'They have already answered' });
    if (r === 'recent') return reply.code(409).send({ error: `Already reminded in the last ${NUDGE_GAP_MIN} minutes` });
    return { ok: true };
  });

  // Remind everyone on the event who hasn't answered (offered at least `olderThanHours` ago, shift not over).
  app.post('/api/events/:id/nudge', { preHandler: mgr }, async (req) => {
    const { id } = idParam.parse(req.params);
    const b = z.object({ olderThanHours: z.number().min(0).max(720).default(0) }).parse(req.body ?? {});
    return withTenant(req.user.tid, async (c) => {
      const list = (
        await c.query(
          `SELECT a.id, a.user_id, a.shift_id FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id
            WHERE s.event_id = $1 AND a.status = 'offered' AND s.ends_at > now() AND a.created_at <= now() - make_interval(secs => $2 * 3600)`,
          [id, b.olderThanHours],
        )
      ).rows;
      let sent = 0;
      for (const a of list) if (await nudgeOne(c, req.user.tid, a)) sent++;
      if (sent) await audit(c, req.user.tid, req.user.sub, 'event.nudge', 'event', id, { sent });
      return { sent, skipped: list.length - sent };
    });
  });

  // ---------- "Are you free?" before booking ----------
  app.post('/api/events/:id/avail-checks', { preHandler: mgr }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const b = z
      .object({
        dates: z.array(ymd).min(1).max(62),
        userIds: z.array(uuid).max(500).optional(), groupId: uuid.optional(), role: z.string().trim().min(1).max(100).optional(),
        message: z.string().trim().max(500).optional(),
      })
      .refine((x) => x.userIds?.length || x.groupId || x.role, 'Choose who to ask')
      .safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: b.error.issues[0]?.message ?? 'Check the request' });
    const q = b.data;
    const out = await withTenant(req.user.tid, async (c) => {
      const ev = (await c.query('SELECT id, name FROM events WHERE id = $1', [id])).rows[0];
      if (!ev) return null;
      const people = (
        await c.query(
          `SELECT u.id FROM users u WHERE u.role = 'crew' AND u.active AND (
             u.id = ANY($1::uuid[])
             OR ($2::uuid IS NOT NULL AND EXISTS (SELECT 1 FROM crew_group_members m WHERE m.group_id = $2 AND m.user_id = u.id))
             OR ($3::text IS NOT NULL AND EXISTS (SELECT 1 FROM unnest(u.skills) k WHERE lower(trim(k)) = lower(trim($3)))))
           LIMIT 500`,
          [q.userIds ?? [], q.groupId ?? null, q.role ?? null],
        )
      ).rows.map((r) => r.id as string);
      if (!people.length) return 'nobody' as const;
      const dates = [...new Set(q.dates)].sort();
      const chk = (await c.query('INSERT INTO avail_checks (tenant_id, event_id, dates, message, created_by) VALUES ($1,$2,$3::date[],$4,$5) RETURNING id', [req.user.tid, id, dates, q.message || null, req.user.sub])).rows[0];
      await c.query('INSERT INTO avail_answers (tenant_id, check_id, user_id) SELECT $1, $2, unnest($3::uuid[])', [req.user.tid, chk.id, people]);
      const days = dayList(dates);
      await notify(c, req.user.tid, people.map((userId): NotifyInput => ({
        userId, category: 'assignment', title: `Are you free? ${ev.name}`,
        body: `We're crewing ${ev.name} on ${days}.${q.message ? `\n\n${q.message}` : ''}\n\nTell us which days you can work. This isn't a booking yet: you'll get an offer if you're picked.`,
        link: '/my-shifts', sms: `Are you free for ${ev.name} on ${days}? Tell us which days:`, smsLink: `${config.appUrl}/my-shifts`,
      })));
      await audit(c, req.user.tid, req.user.sub, 'avail_check.send', 'avail_check', chk.id, { event: id, asked: people.length, dates: dates.length });
      return { check: { id: chk.id }, asked: people.length };
    });
    if (!out) return reply.code(404).send({ error: 'Event not found' });
    if (out === 'nobody') return reply.code(400).send({ error: 'Nobody matches who you chose' });
    return reply.code(201).send(out);
  });

  app.get('/api/events/:id/avail-checks', { preHandler: mgr }, async (req) => {
    const { id } = idParam.parse(req.params);
    return withTenant(req.user.tid, async (c) => ({
      checks: (
        await c.query(
          `SELECT k.id, ARRAY(SELECT to_char(d, 'YYYY-MM-DD') FROM unnest(k.dates) d ORDER BY d) AS dates, k.message, k.created_at, k.closed_at, b.name AS created_by_name,
                  COALESCE((SELECT json_agg(json_build_object('user_id', a.user_id, 'name', u.name, 'answered_at', a.answered_at,
                                    'free_dates', ARRAY(SELECT to_char(d, 'YYYY-MM-DD') FROM unnest(a.free_dates) d ORDER BY d)) ORDER BY a.answered_at IS NULL, cardinality(a.free_dates) DESC NULLS LAST, u.name)
                              FROM avail_answers a JOIN users u ON u.id = a.user_id WHERE a.check_id = k.id), '[]'::json) AS answers
             FROM avail_checks k LEFT JOIN users b ON b.id = k.created_by WHERE k.event_id = $1 ORDER BY k.created_at DESC`,
          [id],
        )
      ).rows,
    }));
  });

  app.post('/api/avail-checks/:id/close', { preHandler: mgr }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const n = await withTenant(req.user.tid, async (c) => (await c.query('UPDATE avail_checks SET closed_at = now() WHERE id = $1 AND closed_at IS NULL', [id])).rowCount);
    return n ? { ok: true } : reply.code(404).send({ error: 'Not found or already closed' });
  });

  // Crew: the checks waiting for them (and ones they answered, so they can change the answer).
  app.get('/api/my/avail-checks', { preHandler: authenticate }, async (req) =>
    withTenant(req.user.tid, async (c) => ({
      checks: (
        await c.query(
          `SELECT k.id, e.name AS event_name, e.venue, ARRAY(SELECT to_char(d, 'YYYY-MM-DD') FROM unnest(k.dates) d ORDER BY d) AS dates, k.message,
                  a.answered_at, ARRAY(SELECT to_char(d, 'YYYY-MM-DD') FROM unnest(a.free_dates) d ORDER BY d) AS free_dates
             FROM avail_answers a JOIN avail_checks k ON k.id = a.check_id JOIN events e ON e.id = k.event_id
            WHERE a.user_id = $1 AND k.closed_at IS NULL AND (SELECT max(d) FROM unnest(k.dates) d) >= current_date
            ORDER BY a.answered_at IS NOT NULL, k.created_at DESC LIMIT 20`,
          [req.user.sub],
        )
      ).rows,
    })),
  );

  app.post('/api/avail-checks/:id/answer', { preHandler: authenticate }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const b = z.object({ freeDates: z.array(ymd).max(62) }).parse(req.body);
    const r = await withTenant(req.user.tid, async (c) => {
      const k = (await c.query("SELECT k.closed_at, ARRAY(SELECT to_char(d, 'YYYY-MM-DD') FROM unnest(k.dates) d) AS dates FROM avail_checks k JOIN avail_answers a ON a.check_id = k.id AND a.user_id = $2 WHERE k.id = $1", [id, req.user.sub])).rows[0];
      if (!k) return 'none' as const;
      if (k.closed_at) return 'closed' as const;
      const free = [...new Set(b.freeDates)].filter((d) => (k.dates as string[]).includes(d));
      await c.query('UPDATE avail_answers SET free_dates = $3::date[], answered_at = now() WHERE check_id = $1 AND user_id = $2', [id, req.user.sub, free]);
      return free.length;
    });
    if (r === 'none') return reply.code(404).send({ error: 'Not found' });
    if (r === 'closed') return reply.code(409).send({ error: 'The coordinator has already finished asking' });
    return { ok: true, free: r };
  });
}
