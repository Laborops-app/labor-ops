import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { guard, authenticate } from '../auth';
import { withTenant, audit } from '../db';
import { notify } from '../notify';
import { fmtWhen, fmtTimeOnly } from '../notify/templates';

/**
 * Event updates: an admin or labor coordinator writes one message (a time change, parking, call time …) and sends it
 * to the crew scheduled on the event, all of them or only some phases, groups, positions or people. Each person gets
 * it in the app (push), by email and, when asked, by text, with their own shifts on the event listed underneath.
 */
const uuid = z.string().uuid();
const audience = z.object({
  /** confirmed: accepted only; all: also people offered the shift who haven't answered yet. */
  include: z.enum(['confirmed', 'all']).default('confirmed'),
  /** Only shifts that haven't ended yet. */
  upcoming: z.boolean().default(true),
  phases: z.array(uuid).max(100).default([]),
  groups: z.array(uuid).max(100).default([]),
  roles: z.array(z.string().trim().min(1).max(100)).max(100).default([]),
  people: z.array(uuid).max(1000).default([]),
});
type Audience = z.infer<typeof audience>;

type Row = { user_id: string; name: string; shift_id: string; role_name: string; starts_at: Date; ends_at: Date; status: string; phase: string | null; group_label: string | null };

/** Everyone the audience reaches, with each person's matching shifts on the event. */
async function recipients(c: PoolClient, eventId: string, a: Audience) {
  const rows = (
    await c.query(
      `SELECT a.user_id, u.name, s.id AS shift_id, s.role_name, s.starts_at, s.ends_at, a.status, p.label AS phase, g.label AS group_label
         FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id JOIN users u ON u.id = a.user_id AND u.active
         LEFT JOIN event_phases p ON p.id = s.phase_id LEFT JOIN phase_groups g ON g.id = s.group_id
        WHERE s.event_id = $1
          AND a.status = ANY($2::text[])
          AND (NOT $3::boolean OR s.ends_at > now())
          AND (cardinality($4::uuid[]) = 0 OR s.phase_id = ANY($4::uuid[]))
          AND (cardinality($5::uuid[]) = 0 OR s.group_id = ANY($5::uuid[]))
          AND (cardinality($6::text[]) = 0 OR lower(trim(s.role_name)) = ANY($6::text[]))
          AND (cardinality($7::uuid[]) = 0 OR a.user_id = ANY($7::uuid[]))
        ORDER BY u.name, s.starts_at`,
      [eventId, a.include === 'all' ? ['accepted', 'offered'] : ['accepted'], a.upcoming, a.phases, a.groups, a.roles.map((r) => r.toLowerCase()), a.people],
    )
  ).rows as Row[];
  const people = new Map<string, { userId: string; name: string; shifts: Row[] }>();
  for (const r of rows) {
    const p = people.get(r.user_id) ?? { userId: r.user_id, name: r.name, shifts: [] };
    p.shifts.push(r);
    people.set(r.user_id, p);
  }
  return [...people.values()];
}

export async function eventUpdateRoutes(app: FastifyInstance) {
  const mgr = guard('admin', 'manager');
  const idParam = z.object({ id: uuid });

  // Who would get it (shown live in the send window).
  app.post('/api/events/:id/updates/preview', { preHandler: mgr }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const a = audience.parse(req.body ?? {});
    const out = await withTenant(req.user.tid, async (c) => {
      if (!(await c.query('SELECT 1 FROM events WHERE id = $1', [id])).rowCount) return null;
      const list = await recipients(c, id, a);
      return { count: list.length, people: list.map((p) => ({ userId: p.userId, name: p.name, shifts: p.shifts.length, offered: p.shifts.every((s) => s.status === 'offered') })) };
    });
    return out ?? reply.code(404).send({ error: 'Event not found' });
  });

  app.post('/api/events/:id/updates', { preHandler: mgr }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const b = z
      .object({
        title: z.string().trim().min(1, 'Give the update a subject').max(120),
        body: z.string().trim().min(1, 'Write the update').max(4000),
        audience: audience.default({ include: 'confirmed', upcoming: true, phases: [], groups: [], roles: [], people: [] }),
        includeShifts: z.boolean().default(true),
        text: z.boolean().default(false),
      })
      .safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: b.error.issues[0]?.message ?? 'Check the update' });
    const u = b.data;
    const out = await withTenant(req.user.tid, async (c) => {
      const ev = (await c.query('SELECT e.id, e.name, e.venue, e.address, t.timezone FROM events e JOIN tenants t ON t.id = e.tenant_id WHERE e.id = $1', [id])).rows[0];
      if (!ev) return { code: 404, error: 'Event not found' };
      const list = await recipients(c, id, u.audience);
      if (!list.length) return { code: 409, error: 'No one on this event matches who you picked.' };
      const up = (
        await c.query(
          'INSERT INTO event_updates (tenant_id, event_id, sent_by, title, body, audience, include_shifts, texted) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, created_at',
          [req.user.tid, id, req.user.sub, u.title, u.body, JSON.stringify(u.audience), u.includeShifts, u.text],
        )
      ).rows[0];
      const line = (s: Row) => `• ${s.role_name}${s.phase ? ` (${s.phase}${s.group_label ? ` › ${s.group_label}` : ''})` : ''}: ${fmtWhen(s.starts_at, ev.timezone)} – ${fmtTimeOnly(s.ends_at, ev.timezone)}${s.status === 'offered' ? ' · offered, not confirmed yet' : ''}`;
      const sent = await notify(
        c,
        req.user.tid,
        list.map((p) => ({
          userId: p.userId,
          category: 'event_update' as const,
          title: `${ev.name}: ${u.title}`,
          body: u.includeShifts
            ? `${u.body}\n\nYour ${p.shifts.length === 1 ? 'shift' : 'shifts'} on ${ev.name}:\n${p.shifts.map(line).join('\n')}${ev.venue ? `\n${ev.venue}` : ''}`
            : u.body,
          sms: `${ev.name}: ${u.title}. ${u.body}`.slice(0, 300),
          link: '/my-shifts',
          linkLabel: 'Open your shifts in LaborOps',
          allowSms: u.text,
        })),
      );
      const nid = new Map(sent.map((x) => [x.userId, x.id]));
      for (const p of list)
        await c.query('INSERT INTO event_update_recipients (update_id, tenant_id, user_id, notification_id) VALUES ($1,$2,$3,$4)', [up.id, req.user.tid, p.userId, nid.get(p.userId) ?? null]);
      await audit(c, req.user.tid, req.user.sub, 'event.update_sent', 'event', id, { updateId: up.id, title: u.title, recipients: list.length, text: u.text });
      return { code: 201, update: { id: up.id, created_at: up.created_at, recipients: list.length } };
    });
    const { code, ...rest } = out as { code: number; [k: string]: unknown };
    return reply.code(code).send(rest);
  });

  // Updates sent on this event, newest first, with who got each one and who has opened it.
  app.get('/api/events/:id/updates', { preHandler: mgr }, async (req) => {
    const { id } = idParam.parse(req.params);
    return withTenant(req.user.tid, async (c) => {
      const ups = (
        await c.query(
          `SELECT x.id, x.title, x.body, x.include_shifts, x.texted, x.audience, x.created_at, s.name AS sent_by_name
             FROM event_updates x LEFT JOIN users s ON s.id = x.sent_by WHERE x.event_id = $1 ORDER BY x.created_at DESC LIMIT 100`,
          [id],
        )
      ).rows;
      const rec = ups.length
        ? (
            await c.query(
              `SELECT r.update_id, r.user_id, u.name, COALESCE(n.acked_at, n.read_at) AS opened_at
                 FROM event_update_recipients r JOIN users u ON u.id = r.user_id LEFT JOIN notifications n ON n.id = r.notification_id
                WHERE r.update_id = ANY($1::uuid[]) ORDER BY u.name`,
              [ups.map((x) => x.id)],
            )
          ).rows
        : [];
      return {
        updates: ups.map((x) => {
          const people = rec.filter((r) => r.update_id === x.id).map(({ update_id, ...r }) => r);
          return { ...x, recipients: people, opened: people.filter((p) => p.opened_at).length };
        }),
      };
    });
  });

  // Crew: the updates they were sent about an event (shown on their shift page).
  app.get('/api/my/events/:id/updates', { preHandler: authenticate }, async (req) => {
    const { id } = idParam.parse(req.params);
    return withTenant(req.user.tid, async (c) => ({
      updates: (
        await c.query(
          `SELECT x.id, x.title, x.body, x.created_at, s.name AS sent_by_name, r.notification_id
             FROM event_update_recipients r JOIN event_updates x ON x.id = r.update_id LEFT JOIN users s ON s.id = x.sent_by
            WHERE r.user_id = $1 AND x.event_id = $2 ORDER BY x.created_at DESC LIMIT 50`,
          [req.user.sub, id],
        )
      ).rows,
    }));
  });
}
