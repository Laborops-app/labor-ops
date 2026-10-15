import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { withTenant, audit } from '../db';
import { authenticate } from '../auth';
import { loadDepartments } from '../leads';
import { REVIEW_TAGS, refreshRating, reviewRoleKey } from '../reviews';

/**
 * On-site pages for crew members, on events they are working (an accepted shift):
 *  - On-site Labor Coordinator (a permission on the person): every crew member at the event.
 *  - Lead (chosen per event, on the assignment): only their team, the crew in the same department as their
 *    lead shift (Audio, Lighting, Stage Hand…) on shifts that overlap their lead shift's times.
 * Both can check those crew in and out and rate them. They never see anyone's average rating or other people's reviews.
 */
const uuid = z.string().uuid();
const tags = z.array(z.enum(REVIEW_TAGS)).max(12).default([]).transform((t) => [...new Set(t)]);
const note = z.string().trim().max(1000).nullable().optional().transform((s) => (s ? s : null));
/** How long after an event the on-site pages stay open (for rating). */
const DAYS_AFTER = 14;

type MyShift = { shift_id: string; role_name: string; starts_at: Date; ends_at: Date; is_lead: boolean };
type ShiftRow = { id: string; role_name: string; starts_at: Date; ends_at: Date };
type Scope = { kind: 'coordinator' | 'lead'; mine: MyShift[]; teams: string[]; covers: (s: ShiftRow) => boolean };

/** Field permissions of an active crew member (null for staff or inactive people). */
async function fieldRolesOf(c: PoolClient, uid: string): Promise<string[] | null> {
  const r = (await c.query("SELECT field_roles FROM users WHERE id = $1 AND role = 'crew' AND active", [uid])).rows[0];
  return r ? (r.field_roles ?? []) : null;
}

/** What this person may do at this event, or null when they have no on-site access to it. */
async function scopeFor(c: PoolClient, uid: string, eventId: string): Promise<Scope | null> {
  const roles = await fieldRolesOf(c, uid);
  if (!roles) return null;
  const mine = (
    await c.query(
      `SELECT s.id AS shift_id, s.role_name, s.starts_at, s.ends_at, a.is_lead FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id JOIN events e ON e.id = s.event_id
        WHERE a.user_id = $1 AND a.status = 'accepted' AND s.event_id = $2 AND e.end_date >= current_date - $3::int`,
      [uid, eventId, DAYS_AFTER],
    )
  ).rows as MyShift[];
  if (!mine.length) return null;
  if (roles.includes('onsite_coordinator')) return { kind: 'coordinator', mine, teams: [], covers: () => true };
  const leads = mine.filter((m) => m.is_lead);
  if (!leads.length) return null;
  const dept = await loadDepartments(c);
  return {
    kind: 'lead',
    mine,
    teams: [...new Set(leads.map((m) => dept.nameOf(m.role_name)))],
    covers: (s) => leads.some((m) => dept.of(m.role_name) === dept.of(s.role_name) && +s.starts_at < +m.ends_at && +s.ends_at > +m.starts_at),
  };
}

/** The assignment with its shift, if the caller covers it. */
async function coveredAssignment(c: PoolClient, uid: string, assignmentId: string) {
  const a = (
    await c.query(
      `SELECT a.id, a.user_id, a.status, s.id AS shift_id, s.role_name, s.starts_at, s.ends_at, s.event_id,
              (now() BETWEEN s.starts_at - interval '2 hours' AND s.ends_at + interval '4 hours') AS in_window
         FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id WHERE a.id = $1`,
      [assignmentId],
    )
  ).rows[0];
  if (!a) return null;
  const scope = await scopeFor(c, uid, a.event_id);
  if (!scope || !scope.covers({ id: a.shift_id, role_name: a.role_name, starts_at: a.starts_at, ends_at: a.ends_at })) return null;
  return a;
}

export async function onsiteRoutes(app: FastifyInstance) {
  // Events where you have on-site access: every event you work as On-site Labor Coordinator, or the ones where
  // you are a lead; from today on, and two weeks back for rating.
  app.get('/api/onsite/events', { preHandler: authenticate }, async (req) =>
    withTenant(req.user.tid, async (c) => {
      const roles = await fieldRolesOf(c, req.user.sub);
      if (!roles) return { events: [] };
      const coordinator = roles.includes('onsite_coordinator');
      const rows = (
        await c.query(
          `SELECT e.id, e.name, e.venue, e.start_date::text, e.end_date::text, bool_or(a.is_lead) AS lead,
                  json_agg(json_build_object('role_name', s.role_name, 'starts_at', s.starts_at, 'ends_at', s.ends_at, 'is_lead', a.is_lead) ORDER BY s.starts_at) AS my_shifts
             FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id JOIN events e ON e.id = s.event_id
            WHERE a.user_id = $1 AND a.status = 'accepted' AND e.end_date >= current_date - $2::int
            GROUP BY e.id HAVING $3::boolean OR bool_or(a.is_lead) ORDER BY e.start_date, e.name`,
          [req.user.sub, DAYS_AFTER, coordinator],
        )
      ).rows;
      return { coordinator, events: rows.map(({ lead, ...e }) => ({ ...e, kind: coordinator ? 'coordinator' : 'lead' })) };
    }),
  );

  // The crew you cover at one event, shift by shift, with who is on site.
  app.get('/api/onsite/events/:id', { preHandler: authenticate }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const out = await withTenant(req.user.tid, async (c) => {
      const scope = await scopeFor(c, req.user.sub, id);
      if (!scope) return null;
      const ev = (await c.query('SELECT id, name, venue, address, start_date::text, end_date::text, clock_mode FROM events WHERE id = $1', [id])).rows[0];
      const shifts = (
        await c.query(
          `SELECT s.id, s.role_name, s.starts_at, s.ends_at,
                  (now() BETWEEN s.starts_at - interval '2 hours' AND s.ends_at + interval '4 hours') AS can_check_in
             FROM shifts s WHERE s.event_id = $1 ORDER BY s.starts_at, s.role_name`,
          [id],
        )
      ).rows.filter((s) => scope.covers(s));
      const crew = shifts.length
        ? (
            await c.query(
              `SELECT a.id AS assignment_id, a.shift_id, u.id AS user_id, u.name, u.phone,
                      (SELECT t.clock_in FROM time_entries t WHERE t.assignment_id = a.id AND t.clock_out IS NULL ORDER BY t.clock_in DESC LIMIT 1) AS clocked_in_at,
                      (SELECT max(t.clock_out) FROM time_entries t WHERE t.assignment_id = a.id) AS last_clock_out
                 FROM shift_assignments a JOIN users u ON u.id = a.user_id
                WHERE a.shift_id = ANY($1::uuid[]) AND a.status = 'accepted' ORDER BY u.name`,
              [shifts.map((s) => s.id)],
            )
          ).rows
        : [];
      return {
        event: ev,
        kind: scope.kind,
        teams: scope.teams,
        myShifts: scope.mine,
        shifts: shifts.map((s) => ({ ...s, crew: crew.filter((x) => x.shift_id === s.id).map((x) => ({ ...x, is_me: x.user_id === req.user.sub })) })),
      };
    });
    return out ?? reply.code(404).send({ error: 'You do not have on-site access to this event' });
  });

  app.post('/api/onsite/assignments/:id/check-in', { preHandler: authenticate }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const r = await withTenant(req.user.tid, async (c) => {
      const a = await coveredAssignment(c, req.user.sub, id);
      if (!a) return { code: 404, error: 'This person is not on your crew' };
      if (a.status !== 'accepted') return { code: 409, error: 'Only confirmed crew can be checked in' };
      if (!a.in_window) return { code: 409, error: 'Check-in opens 2 hours before the shift starts' };
      if ((await c.query('SELECT 1 FROM time_entries WHERE user_id = $1 AND clock_out IS NULL', [a.user_id])).rowCount) return { code: 409, error: 'Already checked in' };
      const t = (await c.query('INSERT INTO time_entries (tenant_id, assignment_id, user_id, in_by) VALUES ($1,$2,$3,$4) RETURNING id, clock_in', [req.user.tid, id, a.user_id, req.user.sub])).rows[0];
      await audit(c, req.user.tid, req.user.sub, 'time.check_in', 'time_entry', t.id, { assignmentId: id, onsite: true });
      return { code: 201, entry: t };
    });
    const { code, ...rest } = r as { code: number; [k: string]: unknown };
    return reply.code(code).send(rest);
  });

  app.post('/api/onsite/assignments/:id/check-out', { preHandler: authenticate }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const r = await withTenant(req.user.tid, async (c) => {
      if (!(await coveredAssignment(c, req.user.sub, id))) return { code: 404, error: 'This person is not on your crew' };
      const row = (await c.query("UPDATE time_entries SET clock_out = now(), status = 'submitted', out_by = $2 WHERE assignment_id = $1 AND clock_out IS NULL RETURNING id, clock_in, clock_out", [id, req.user.sub])).rows[0];
      if (!row) return { code: 409, error: 'This person is not checked in' };
      await audit(c, req.user.tid, req.user.sub, 'time.check_out', 'time_entry', row.id, { assignmentId: id, onsite: true });
      return { code: 200, entry: row };
    });
    const { code, ...rest } = r as { code: number; [k: string]: unknown };
    return reply.code(code).send(rest);
  });

  // Rating page: the crew you cover (not yourself), with your own review of each shift. No averages, and
  // reviews by other people only show as "already rated".
  app.get('/api/onsite/events/:id/reviews', { preHandler: authenticate }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const out = await withTenant(req.user.tid, async (c) => {
      const scope = await scopeFor(c, req.user.sub, id);
      if (!scope) return null;
      const rows = (
        await c.query(
          `SELECT s.id AS shift_id, s.role_name, s.starts_at, s.ends_at, s.starts_at <= now() AS started,
                  u.id AS user_id, u.name AS user_name,
                  EXISTS (SELECT 1 FROM time_entries t WHERE t.assignment_id = a.id) AS worked,
                  rv.rated_by, rv.stars, rv.tags, rv.note, b.name AS rated_by_name
             FROM shifts s
             JOIN shift_assignments a ON a.shift_id = s.id AND a.status = 'accepted'
             JOIN users u ON u.id = a.user_id AND u.role = 'crew'
             LEFT JOIN crew_reviews rv ON rv.user_id = u.id AND rv.shift_id = s.id
             LEFT JOIN users b ON b.id = rv.rated_by
            WHERE s.event_id = $1 AND u.id <> $2
            ORDER BY s.starts_at, s.role_name, u.name`,
          [id, req.user.sub],
        )
      ).rows.filter((r) => scope.covers({ id: r.shift_id, role_name: r.role_name, starts_at: r.starts_at, ends_at: r.ends_at }));
      const workers = rows.map(({ rated_by, stars, tags, note, rated_by_name, ...r }) =>
        !rated_by ? { ...r, mine: null, locked_by: null }
        : rated_by === req.user.sub ? { ...r, mine: { stars, tags, note }, locked_by: null }
        : { ...r, mine: null, locked_by: rated_by_name ?? 'someone else' },
      );
      const ev = (await c.query('SELECT id, name, start_date::text, end_date::text FROM events WHERE id = $1', [id])).rows[0];
      return { event: ev, kind: scope.kind, workers };
    });
    return out ?? reply.code(404).send({ error: 'You do not have on-site access to this event' });
  });

  app.put('/api/onsite/events/:id/reviews', { preHandler: authenticate }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ shiftId: uuid, userId: uuid, stars: z.number().int().min(1).max(5).nullable(), tags, note }).parse(req.body);
    if (b.userId === req.user.sub) return reply.code(400).send({ error: 'You cannot rate yourself' });
    const out = await withTenant(req.user.tid, async (c) => {
      const scope = await scopeFor(c, req.user.sub, id);
      if (!scope) return { code: 404, error: 'You do not have on-site access to this event' };
      const s = (
        await c.query(
          `SELECT s.id, s.role_name, s.starts_at, s.ends_at, s.starts_at <= now() AS started FROM shifts s
             JOIN shift_assignments a ON a.shift_id = s.id AND a.user_id = $3 AND a.status = 'accepted'
             JOIN users u ON u.id = a.user_id AND u.role = 'crew' WHERE s.id = $1 AND s.event_id = $2`,
          [b.shiftId, id, b.userId],
        )
      ).rows[0];
      if (!s || !scope.covers(s)) return { code: 404, error: 'This person is not on your crew' };
      if (!s.started) return { code: 409, error: 'You can rate crew once their shift has started' };
      const key = reviewRoleKey(s.role_name);
      const prev = (await c.query('SELECT id, rated_by FROM crew_reviews WHERE user_id = $1 AND shift_id = $2', [b.userId, b.shiftId])).rows[0];
      if (prev && prev.rated_by !== req.user.sub) return { code: 403, error: 'Someone else already rated this shift' };
      if (b.stars === null) {
        if (prev) await c.query('DELETE FROM crew_reviews WHERE id = $1', [prev.id]);
      } else {
        await c.query(
          `INSERT INTO crew_reviews (tenant_id, user_id, role_key, stars, tags, note, shift_id, event_id, rated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (user_id, shift_id) WHERE shift_id IS NOT NULL DO UPDATE SET stars = EXCLUDED.stars, tags = EXCLUDED.tags, note = EXCLUDED.note, role_key = EXCLUDED.role_key, updated_at = now()`,
          [req.user.tid, b.userId, key, b.stars, b.tags, b.note, b.shiftId, id, req.user.sub],
        );
      }
      await refreshRating(c, req.user.tid, b.userId, key);
      if (!prev || b.stars === null) await audit(c, req.user.tid, req.user.sub, b.stars === null ? 'crew.review_deleted' : 'crew.review', 'user', b.userId, { role: key, stars: b.stars, shiftId: b.shiftId, onsite: true });
      return { code: 200, ok: true };
    });
    const { code, ...rest } = out as { code: number; [k: string]: unknown };
    return reply.code(code).send(rest);
  });
}
