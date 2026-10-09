import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTenant, audit } from '../db';
import { guard, authenticate } from '../auth';
import { evaluateShift, findClash, filledCount, certMessage } from '../eligibility';

const uuid = z.string().uuid();
const idParam = z.object({ id: uuid });
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const certList = z.array(z.string().trim().min(1).max(60)).max(10);

const mgr = guard('admin', 'manager');

type Out = { code: number; [k: string]: unknown };
const send = (reply: any, r: Out) => {
  const { code, ...body } = r;
  return reply.code(code).send(body);
};

export const shiftInput = z.object({
  roleName: z.string().trim().min(1).max(100),
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }),
  headcount: z.number().int().min(1).max(500).default(1),
  isOpen: z.boolean().default(false),
  requiredCerts: certList.default([]),
});

export async function schedulingRoutes(app: FastifyInstance) {
  // ---------- manager: bulk-create shifts (repeat / templates) ----------
  app.post('/api/events/:id/shifts/bulk', { preHandler: mgr }, async (req, reply) => {
    const { id: eventId } = idParam.parse(req.params);
    const { shifts } = z.object({ shifts: z.array(shiftInput).min(1).max(120) }).parse(req.body);
    for (const s of shifts) if (new Date(s.endsAt) <= new Date(s.startsAt)) return reply.code(400).send({ error: 'Every shift must end after it starts' });
    const created = await withTenant(req.user.tid, async (c) => {
      if (!(await c.query('SELECT 1 FROM events WHERE id = $1', [eventId])).rowCount) return null;
      const ids: string[] = [];
      for (const s of shifts) {
        const r = await c.query(
          `INSERT INTO shifts (tenant_id, event_id, role_name, starts_at, ends_at, headcount, is_open, required_certs)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [req.user.tid, eventId, s.roleName, s.startsAt, s.endsAt, s.headcount, s.isOpen, s.requiredCerts],
        );
        ids.push(r.rows[0].id);
      }
      await audit(c, req.user.tid, req.user.sub, 'shift.bulk_create', 'event', eventId, { count: ids.length });
      return ids;
    });
    if (!created) return reply.code(404).send({ error: 'Event not found' });
    return reply.code(201).send({ created: created.length });
  });

  app.patch('/api/shifts/:id', { preHandler: mgr }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const b = z
      .object({ isOpen: z.boolean().optional(), requiredCerts: certList.optional(), headcount: z.number().int().min(1).max(500).optional() })
      .parse(req.body);
    const row = await withTenant(req.user.tid, async (c) => {
      if (b.headcount !== undefined) {
        const filled = await filledCount(c, id);
        if (b.headcount < filled) return { error: `${filled} people are already on this shift` };
      }
      const r = await c.query(
        `UPDATE shifts SET is_open = COALESCE($2, is_open), required_certs = COALESCE($3, required_certs), headcount = COALESCE($4, headcount)
         WHERE id = $1 RETURNING *`,
        [id, b.isOpen ?? null, b.requiredCerts ?? null, b.headcount ?? null],
      );
      if (r.rows[0]) await audit(c, req.user.tid, req.user.sub, 'shift.update', 'shift', id, b);
      return { shift: r.rows[0] };
    });
    if ('error' in row) return reply.code(409).send(row);
    if (!row.shift) return reply.code(404).send({ error: 'Shift not found' });
    return row;
  });

  // ---------- manager: requests (claims + swaps) ----------
  app.get('/api/requests', { preHandler: mgr }, async (req) =>
    withTenant(req.user.tid, async (c) => ({
      claims: (
        await c.query(
          `SELECT a.id, a.created_at, u.name AS user_name, s.role_name, s.starts_at, s.ends_at, e.id AS event_id, e.name AS event_name, e.venue
           FROM shift_assignments a JOIN users u ON u.id = a.user_id JOIN shifts s ON s.id = a.shift_id JOIN events e ON e.id = s.event_id
           WHERE a.status = 'pending' ORDER BY a.created_at`,
        )
      ).rows,
      swaps: (
        await c.query(
          `SELECT w.id, w.created_at, ob.name AS offered_by_name, tk.name AS taken_by_name, s.role_name, s.starts_at, s.ends_at,
                  e.id AS event_id, e.name AS event_name, e.venue
           FROM shift_swaps w JOIN shift_assignments a ON a.id = w.assignment_id JOIN shifts s ON s.id = a.shift_id
           JOIN events e ON e.id = s.event_id JOIN users ob ON ob.id = w.offered_by JOIN users tk ON tk.id = w.taken_by
           WHERE w.status = 'pending' ORDER BY w.created_at`,
        )
      ).rows,
    })),
  );

  app.post('/api/assignments/:id/approve', { preHandler: mgr }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const r = await withTenant(req.user.tid, async (c): Promise<Out> => {
      const a = (
        await c.query(
          `SELECT a.id, a.user_id, a.shift_id, s.starts_at, s.ends_at, u.name FROM shift_assignments a
           JOIN shifts s ON s.id = a.shift_id JOIN users u ON u.id = a.user_id WHERE a.id = $1 AND a.status = 'pending' FOR UPDATE OF a`,
          [id],
        )
      ).rows[0];
      if (!a) return { code: 404, error: 'Request not found (it may already be handled)' };
      const clash = await findClash(c, a.user_id, a.shift_id, a.starts_at, a.ends_at);
      if (clash) return { code: 409, error: `${a.name} is now booked for ${clash.role_name} at ${clash.event_name} at that time` };
      const [el] = await evaluateShift(c, a.shift_id, a.user_id);
      if (el?.missing_certs.length) return { code: 409, error: certMessage(a.name, el.missing_certs) };
      await c.query("UPDATE shift_assignments SET status = 'accepted' WHERE id = $1", [id]);
      await audit(c, req.user.tid, req.user.sub, 'claim.approve', 'assignment', id);
      return { code: 200, ok: true };
    });
    return send(reply, r);
  });

  app.post('/api/assignments/:id/reject', { preHandler: mgr }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const n = await withTenant(req.user.tid, async (c) => {
      const r = await c.query("DELETE FROM shift_assignments WHERE id = $1 AND status = 'pending'", [id]);
      if (r.rowCount) await audit(c, req.user.tid, req.user.sub, 'claim.reject', 'assignment', id);
      return r.rowCount;
    });
    return n ? { ok: true } : reply.code(404).send({ error: 'Request not found (it may already be handled)' });
  });

  app.post('/api/swaps/:id/approve', { preHandler: mgr }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const r = await withTenant(req.user.tid, async (c): Promise<Out> => {
      const w = (
        await c.query(
          `SELECT w.id, w.assignment_id, w.taken_by, a.shift_id, s.starts_at, s.ends_at, u.name
           FROM shift_swaps w JOIN shift_assignments a ON a.id = w.assignment_id JOIN shifts s ON s.id = a.shift_id
           JOIN users u ON u.id = w.taken_by WHERE w.id = $1 AND w.status = 'pending' FOR UPDATE OF w`,
          [id],
        )
      ).rows[0];
      if (!w) return { code: 404, error: 'Request not found (it may already be handled)' };
      if ((await c.query('SELECT 1 FROM time_entries WHERE assignment_id = $1', [w.assignment_id])).rowCount)
        return { code: 409, error: 'That shift has already been worked and cannot be swapped' };
      if ((await c.query('SELECT 1 FROM shift_assignments WHERE shift_id = $1 AND user_id = $2', [w.shift_id, w.taken_by])).rowCount)
        return { code: 409, error: `${w.name} is already on this shift` };
      const clash = await findClash(c, w.taken_by, w.shift_id, w.starts_at, w.ends_at);
      if (clash) return { code: 409, error: `${w.name} is now booked for ${clash.role_name} at ${clash.event_name} at that time` };
      const [el] = await evaluateShift(c, w.shift_id, w.taken_by);
      if (el?.missing_certs.length) return { code: 409, error: certMessage(w.name, el.missing_certs) };
      await c.query("UPDATE shift_assignments SET user_id = $2, status = 'accepted' WHERE id = $1", [w.assignment_id, w.taken_by]);
      await c.query("UPDATE shift_swaps SET status = 'approved', resolved_at = now() WHERE id = $1", [id]);
      await audit(c, req.user.tid, req.user.sub, 'swap.approve', 'swap', id);
      return { code: 200, ok: true };
    });
    return send(reply, r);
  });

  app.post('/api/swaps/:id/reject', { preHandler: mgr }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const n = await withTenant(req.user.tid, async (c) => {
      // Rejecting a taker puts the shift back on the swap board so someone else can take it.
      const r = await c.query("UPDATE shift_swaps SET status = 'open', taken_by = NULL WHERE id = $1 AND status = 'pending'", [id]);
      if (r.rowCount) await audit(c, req.user.tid, req.user.sub, 'swap.reject', 'swap', id);
      return r.rowCount;
    });
    return n ? { ok: true } : reply.code(404).send({ error: 'Request not found (it may already be handled)' });
  });

  // ---------- manager: certificates ----------
  app.post('/api/crew/:id/certs', { preHandler: mgr }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const b = z
      .object({ name: z.string().trim().min(1).max(60), expiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional() })
      .parse(req.body);
    const row = await withTenant(req.user.tid, async (c) => {
      if (!(await c.query("SELECT 1 FROM users WHERE id = $1 AND role = 'crew'", [id])).rowCount) return null;
      const r = await c.query(
        `INSERT INTO user_certs (tenant_id, user_id, name, expires_on) VALUES ($1,$2,$3,$4)
         ON CONFLICT (user_id, lower(name)) DO UPDATE SET name = EXCLUDED.name, expires_on = EXCLUDED.expires_on RETURNING id, name, expires_on`,
        [req.user.tid, id, b.name, b.expiresOn ?? null],
      );
      await audit(c, req.user.tid, req.user.sub, 'cert.set', 'user', id, { name: b.name, expiresOn: b.expiresOn ?? null });
      return r.rows[0];
    });
    if (!row) return reply.code(404).send({ error: 'Crew member not found' });
    return reply.code(201).send({ cert: row });
  });

  app.delete('/api/certs/:id', { preHandler: mgr }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const n = await withTenant(req.user.tid, async (c) => {
      const r = await c.query('DELETE FROM user_certs WHERE id = $1', [id]);
      if (r.rowCount) await audit(c, req.user.tid, req.user.sub, 'cert.delete', 'cert', id);
      return r.rowCount;
    });
    return n ? { ok: true } : reply.code(404).send({ error: 'Certificate not found' });
  });

  // ---------- manager: shift templates ----------
  const tplItems = z
    .array(
      z.object({
        role: z.string().trim().min(1).max(100),
        dayOffset: z.number().int().min(0).max(60),
        start: hhmm,
        end: hhmm,
        headcount: z.number().int().min(1).max(500),
        isOpen: z.boolean().default(false),
        requiredCerts: certList.default([]),
      }),
    )
    .min(1)
    .max(60);
  app.get('/api/templates', { preHandler: mgr }, async (req) =>
    withTenant(req.user.tid, async (c) => ({ templates: (await c.query('SELECT id, name, items FROM shift_templates ORDER BY name')).rows })),
  );
  app.post('/api/templates', { preHandler: mgr }, async (req, reply) => {
    const b = z.object({ name: z.string().trim().min(1).max(100), items: tplItems }).parse(req.body);
    const row = await withTenant(req.user.tid, async (c) => {
      const r = await c.query('INSERT INTO shift_templates (tenant_id, name, items) VALUES ($1,$2,$3) RETURNING id, name, items', [
        req.user.tid, b.name, JSON.stringify(b.items),
      ]);
      await audit(c, req.user.tid, req.user.sub, 'template.create', 'template', r.rows[0].id);
      return r.rows[0];
    });
    return reply.code(201).send({ template: row });
  });
  app.delete('/api/templates/:id', { preHandler: mgr }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const n = await withTenant(req.user.tid, async (c) => (await c.query('DELETE FROM shift_templates WHERE id = $1', [id])).rowCount);
    return n ? { ok: true } : reply.code(404).send({ error: 'Template not found' });
  });

  // ---------- crew: my availability, time off, certificates ----------
  app.get('/api/my/availability', { preHandler: authenticate }, async (req) =>
    withTenant(req.user.tid, async (c) => ({
      timezone: (await c.query('SELECT timezone FROM tenants LIMIT 1')).rows[0]?.timezone,
      windows: (
        await c.query(
          "SELECT weekday, to_char(start_time, 'HH24:MI') AS start_time, to_char(end_time, 'HH24:MI') AS end_time FROM availability WHERE user_id = $1 ORDER BY weekday",
          [req.user.sub],
        )
      ).rows,
      timeOff: (
        await c.query(
          "SELECT id, starts_on::text, ends_on::text, note FROM time_off WHERE user_id = $1 AND ends_on >= current_date - 1 ORDER BY starts_on",
          [req.user.sub],
        )
      ).rows,
      certs: (await c.query('SELECT id, name, expires_on::text FROM user_certs WHERE user_id = $1 ORDER BY name', [req.user.sub])).rows,
    })),
  );

  app.put('/api/my/availability', { preHandler: authenticate }, async (req, reply) => {
    const { windows } = z
      .object({ windows: z.array(z.object({ weekday: z.number().int().min(0).max(6), startTime: hhmm, endTime: hhmm })).max(7) })
      .parse(req.body);
    if (new Set(windows.map((w) => w.weekday)).size !== windows.length) return reply.code(400).send({ error: 'One window per day' });
    if (windows.some((w) => w.endTime <= w.startTime)) return reply.code(400).send({ error: 'Each window must end after it starts' });
    await withTenant(req.user.tid, async (c) => {
      await c.query('DELETE FROM availability WHERE user_id = $1', [req.user.sub]);
      for (const w of windows)
        await c.query('INSERT INTO availability (tenant_id, user_id, weekday, start_time, end_time) VALUES ($1,$2,$3,$4,$5)', [
          req.user.tid, req.user.sub, w.weekday, w.startTime, w.endTime,
        ]);
      await audit(c, req.user.tid, req.user.sub, 'availability.set', 'user', req.user.sub, { days: windows.length });
    });
    return { ok: true };
  });

  app.post('/api/my/time-off', { preHandler: authenticate }, async (req, reply) => {
    const b = z
      .object({
        startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        endsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        note: z.string().trim().max(200).optional().nullable(),
      })
      .parse(req.body);
    if (b.endsOn < b.startsOn) return reply.code(400).send({ error: 'End date is before the start date' });
    const row = await withTenant(req.user.tid, async (c) =>
      (
        await c.query('INSERT INTO time_off (tenant_id, user_id, starts_on, ends_on, note) VALUES ($1,$2,$3,$4,$5) RETURNING id', [
          req.user.tid, req.user.sub, b.startsOn, b.endsOn, b.note ?? null,
        ])
      ).rows[0],
    );
    return reply.code(201).send({ id: row.id });
  });

  app.delete('/api/my/time-off/:id', { preHandler: authenticate }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const n = await withTenant(req.user.tid, async (c) => (await c.query('DELETE FROM time_off WHERE id = $1 AND user_id = $2', [id, req.user.sub])).rowCount);
    return n ? { ok: true } : reply.code(404).send({ error: 'Not found' });
  });

  // ---------- crew: open shifts ----------
  app.get('/api/open-shifts', { preHandler: authenticate }, async (req) =>
    withTenant(req.user.tid, async (c) => {
      const rows = (
        await c.query(
          `SELECT s.id, s.role_name, s.starts_at, s.ends_at, s.headcount, s.required_certs, e.name AS event_name, e.venue,
             (SELECT count(*)::int FROM shift_assignments a WHERE a.shift_id = s.id AND a.status <> 'declined') AS filled
           FROM shifts s JOIN events e ON e.id = s.event_id
           WHERE s.is_open AND s.ends_at > now()
             AND NOT EXISTS (SELECT 1 FROM shift_assignments a WHERE a.shift_id = s.id AND a.user_id = $1)
           ORDER BY s.starts_at`,
          [req.user.sub],
        )
      ).rows.filter((s) => s.filled < s.headcount);
      const out = [];
      for (const s of rows) {
        const [el] = await evaluateShift(c, s.id, req.user.sub);
        const clash = await findClash(c, req.user.sub, s.id, s.starts_at, s.ends_at);
        const reason = el?.missing_certs.length
          ? `Needs a valid ${el.missing_certs.join(', ')} certificate`
          : clash
            ? `Overlaps ${clash.role_name} at ${clash.event_name}`
            : null;
        out.push({ ...s, can_claim: !reason, reason, outside_availability: !!(el?.outside_availability || el?.time_off) });
      }
      return { shifts: out };
    }),
  );

  app.post('/api/shifts/:id/claim', { preHandler: authenticate }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const r = await withTenant(req.user.tid, async (c): Promise<Out> => {
      const s = (await c.query('SELECT * FROM shifts WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!s || !s.is_open || new Date(s.ends_at) <= new Date()) return { code: 404, error: 'This shift is not open for claiming' };
      if ((await filledCount(c, id)) >= s.headcount) return { code: 409, error: 'Someone else just took the last spot' };
      if ((await c.query('SELECT 1 FROM shift_assignments WHERE shift_id = $1 AND user_id = $2', [id, req.user.sub])).rowCount)
        return { code: 409, error: 'You are already on this shift' };
      const clash = await findClash(c, req.user.sub, id, s.starts_at, s.ends_at);
      if (clash) return { code: 409, error: `You are already booked for ${clash.role_name} at ${clash.event_name} at that time` };
      const [el] = await evaluateShift(c, id, req.user.sub);
      if (el?.missing_certs.length) return { code: 409, error: `You need a valid ${el.missing_certs.join(', ')} certificate for this shift` };
      const a = (
        await c.query("INSERT INTO shift_assignments (tenant_id, shift_id, user_id, status) VALUES ($1,$2,$3,'pending') RETURNING id", [
          req.user.tid, id, req.user.sub,
        ])
      ).rows[0];
      await audit(c, req.user.tid, req.user.sub, 'claim.create', 'assignment', a.id, { shiftId: id });
      return { code: 201, assignmentId: a.id };
    });
    return send(reply, r);
  });

  // ---------- crew: shift swaps ----------
  app.post('/api/assignments/:id/offer-swap', { preHandler: authenticate }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const r = await withTenant(req.user.tid, async (c): Promise<Out> => {
      const a = (
        await c.query(
          `SELECT a.id FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id
           WHERE a.id = $1 AND a.user_id = $2 AND a.status = 'accepted' AND s.starts_at > now()
             AND NOT EXISTS (SELECT 1 FROM time_entries t WHERE t.assignment_id = a.id)`,
          [id, req.user.sub],
        )
      ).rows[0];
      if (!a) return { code: 404, error: 'You can only offer an accepted shift that has not started' };
      const w = (
        await c.query('INSERT INTO shift_swaps (tenant_id, assignment_id, offered_by) VALUES ($1,$2,$3) RETURNING id', [
          req.user.tid, id, req.user.sub,
        ])
      ).rows[0];
      await audit(c, req.user.tid, req.user.sub, 'swap.offer', 'swap', w.id);
      return { code: 201, swapId: w.id };
    });
    return send(reply, r);
  });

  app.post('/api/swaps/:id/cancel', { preHandler: authenticate }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const n = await withTenant(req.user.tid, async (c) => {
      const r = await c.query(
        "UPDATE shift_swaps SET status = 'cancelled', resolved_at = now() WHERE id = $1 AND offered_by = $2 AND status IN ('open','pending')",
        [id, req.user.sub],
      );
      if (r.rowCount) await audit(c, req.user.tid, req.user.sub, 'swap.cancel', 'swap', id);
      return r.rowCount;
    });
    return n ? { ok: true } : reply.code(404).send({ error: 'Swap not found' });
  });

  app.get('/api/swaps/board', { preHandler: authenticate }, async (req) =>
    withTenant(req.user.tid, async (c) => {
      const rows = (
        await c.query(
          `SELECT w.id, s.id AS shift_id, s.role_name, s.starts_at, s.ends_at, e.name AS event_name, e.venue, ob.name AS offered_by_name
           FROM shift_swaps w JOIN shift_assignments a ON a.id = w.assignment_id JOIN shifts s ON s.id = a.shift_id
           JOIN events e ON e.id = s.event_id JOIN users ob ON ob.id = w.offered_by
           WHERE w.status = 'open' AND w.offered_by <> $1 AND s.starts_at > now()
             AND NOT EXISTS (SELECT 1 FROM shift_assignments x WHERE x.shift_id = s.id AND x.user_id = $1)
           ORDER BY s.starts_at`,
          [req.user.sub],
        )
      ).rows;
      const out = [];
      for (const w of rows) {
        const [el] = await evaluateShift(c, w.shift_id, req.user.sub);
        const clash = await findClash(c, req.user.sub, w.shift_id, w.starts_at, w.ends_at);
        const reason = el?.missing_certs.length
          ? `Needs a valid ${el.missing_certs.join(', ')} certificate`
          : clash
            ? `Overlaps ${clash.role_name} at ${clash.event_name}`
            : null;
        out.push({ ...w, can_take: !reason, reason });
      }
      return { swaps: out };
    }),
  );

  app.post('/api/swaps/:id/take', { preHandler: authenticate }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const r = await withTenant(req.user.tid, async (c): Promise<Out> => {
      const w = (
        await c.query(
          `SELECT w.id, w.offered_by, a.shift_id, s.starts_at, s.ends_at FROM shift_swaps w
           JOIN shift_assignments a ON a.id = w.assignment_id JOIN shifts s ON s.id = a.shift_id
           WHERE w.id = $1 AND w.status = 'open' AND s.starts_at > now() FOR UPDATE OF w`,
          [id],
        )
      ).rows[0];
      if (!w) return { code: 404, error: 'That swap is no longer available' };
      if (w.offered_by === req.user.sub) return { code: 409, error: 'You offered this shift yourself' };
      if ((await c.query('SELECT 1 FROM shift_assignments WHERE shift_id = $1 AND user_id = $2', [w.shift_id, req.user.sub])).rowCount)
        return { code: 409, error: 'You are already on this shift' };
      const clash = await findClash(c, req.user.sub, w.shift_id, w.starts_at, w.ends_at);
      if (clash) return { code: 409, error: `You are already booked for ${clash.role_name} at ${clash.event_name} at that time` };
      const [el] = await evaluateShift(c, w.shift_id, req.user.sub);
      if (el?.missing_certs.length) return { code: 409, error: `You need a valid ${el.missing_certs.join(', ')} certificate for this shift` };
      await c.query("UPDATE shift_swaps SET status = 'pending', taken_by = $2 WHERE id = $1", [id, req.user.sub]);
      await audit(c, req.user.tid, req.user.sub, 'swap.take', 'swap', id);
      return { code: 200, ok: true };
    });
    return send(reply, r);
  });
}
