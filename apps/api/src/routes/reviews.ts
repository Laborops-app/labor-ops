import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTenant, audit } from '../db';
import { guard } from '../auth';
import { REVIEW_TAGS, refreshRating, ratingsOf, reviewRoleKey } from '../reviews';

/**
 * Crew reviews. Coordinators rate a crew member 1-5 stars in a position, with optional quick tags and a private note,
 * either after a shift (tied to it, one review per person per shift) or generally from the crew list or profile.
 * Reviews are internal: crew members never see them.
 */
const tags = z.array(z.enum(REVIEW_TAGS)).max(12).default([]).transform((t) => [...new Set(t)]);
const note = z.string().trim().max(1000).nullable().optional().transform((s) => (s ? s : null));
const uuid = z.string().uuid();

const REVIEW_COLS = `r.id, r.user_id, r.role_key, r.stars, r.tags, r.note, r.shift_id, r.event_id, r.created_at, r.updated_at, r.rated_by,
  e.name AS event_name, s.starts_at AS shift_starts_at, s.role_name AS shift_role, b.name AS rated_by_name`;
const REVIEW_FROM = `crew_reviews r LEFT JOIN events e ON e.id = r.event_id LEFT JOIN shifts s ON s.id = r.shift_id LEFT JOIN users b ON b.id = r.rated_by`;

export async function reviewRoutes(app: FastifyInstance) {
  // Everything about one person's ratings: per-position summary and every review, newest first.
  app.get('/api/crew/:id/reviews', { preHandler: guard('admin', 'manager') }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const out = await withTenant(req.user.tid, async (c) => {
      const u = (await c.query("SELECT id, name, skills FROM users WHERE id = $1 AND role = 'crew'", [id])).rows[0];
      if (!u) return null;
      const summary = (
        await c.query(
          `SELECT role_key, COALESCE(avg_stars, stars)::float8 AS avg, reviews AS count,
                  (SELECT count(*)::int FROM crew_reviews x WHERE x.user_id = $1 AND x.role_key = crew_ratings.role_key AND x.stars = 5) AS fives
             FROM crew_ratings WHERE user_id = $1 ORDER BY reviews DESC, role_key`,
          [id],
        )
      ).rows;
      const reviews = (await c.query(`SELECT ${REVIEW_COLS} FROM ${REVIEW_FROM} WHERE r.user_id = $1 ORDER BY r.created_at DESC LIMIT 200`, [id])).rows;
      const all = (await c.query('SELECT count(*)::int AS n, avg(stars)::float8 AS avg FROM crew_reviews WHERE user_id = $1', [id])).rows[0];
      return { member: u, summary, reviews, overall: { avg: all.avg, count: all.n } };
    });
    return out ?? reply.code(404).send({ error: 'Crew member not found' });
  });

  // A general review (not tied to a shift), or one for a shift they worked.
  app.post('/api/crew/:id/reviews', { preHandler: guard('admin', 'manager') }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ role: z.string().trim().min(1).max(100), stars: z.number().int().min(1).max(5), tags, note, shiftId: uuid.nullable().optional() }).parse(req.body);
    const out = await withTenant(req.user.tid, async (c) => {
      if (!(await c.query("SELECT 1 FROM users WHERE id = $1 AND role = 'crew'", [id])).rowCount) return { code: 404, error: 'Crew member not found' };
      let eventId: string | null = null;
      if (b.shiftId) {
        const s = (await c.query('SELECT s.event_id FROM shifts s JOIN shift_assignments a ON a.shift_id = s.id AND a.user_id = $2 WHERE s.id = $1', [b.shiftId, id])).rows[0];
        if (!s) return { code: 400, error: 'They were not on that shift' };
        eventId = s.event_id;
      }
      const key = reviewRoleKey(b.role);
      const row = (
        await c.query(
          b.shiftId
            ? `INSERT INTO crew_reviews (tenant_id, user_id, role_key, stars, tags, note, shift_id, event_id, rated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
               ON CONFLICT (user_id, shift_id) WHERE shift_id IS NOT NULL DO UPDATE SET role_key = EXCLUDED.role_key, stars = EXCLUDED.stars, tags = EXCLUDED.tags, note = EXCLUDED.note, rated_by = EXCLUDED.rated_by, updated_at = now()
               RETURNING id`
            : `INSERT INTO crew_reviews (tenant_id, user_id, role_key, stars, tags, note, shift_id, event_id, rated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [req.user.tid, id, key, b.stars, b.tags, b.note, b.shiftId ?? null, eventId, req.user.sub],
        )
      ).rows[0];
      await refreshRating(c, req.user.tid, id, key);
      await audit(c, req.user.tid, req.user.sub, 'crew.review', 'user', id, { role: key, stars: b.stars, shiftId: b.shiftId ?? null });
      return { id: row.id, ratings: await ratingsOf(c, id) };
    });
    if ('error' in out) return reply.code(out.code!).send({ error: out.error });
    return reply.code(201).send(out);
  });

  // Change or remove a review. The person who wrote it, or an admin.
  const owned = async (c: any, req: any, id: string) => {
    const r = (await c.query('SELECT id, user_id, role_key, rated_by FROM crew_reviews WHERE id = $1', [id])).rows[0];
    if (!r) return { code: 404, error: 'Review not found' };
    if (req.user.role !== 'admin' && r.rated_by !== req.user.sub) return { code: 403, error: 'Only the person who wrote this review, or an admin, can change it' };
    return { r };
  };
  app.patch('/api/reviews/:id', { preHandler: guard('admin', 'manager') }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ stars: z.number().int().min(1).max(5).optional(), tags: tags.optional(), note, role: z.string().trim().min(1).max(100).optional() }).parse(req.body);
    const out = await withTenant(req.user.tid, async (c) => {
      const o = await owned(c, req, id);
      if (!o.r) return o;
      const key = b.role ? reviewRoleKey(b.role) : o.r.role_key;
      await c.query(
        `UPDATE crew_reviews SET stars = COALESCE($2, stars), tags = COALESCE($3, tags), note = CASE WHEN $5 THEN $4 ELSE note END, role_key = $6, updated_at = now() WHERE id = $1`,
        [id, b.stars ?? null, b.tags ?? null, b.note ?? null, b.note !== undefined, key],
      );
      await refreshRating(c, req.user.tid, o.r.user_id, key);
      if (key !== o.r.role_key) await refreshRating(c, req.user.tid, o.r.user_id, o.r.role_key);
      return { ok: true, ratings: await ratingsOf(c, o.r.user_id) };
    });
    if ('error' in out) return reply.code(out.code!).send({ error: out.error });
    return out;
  });
  app.delete('/api/reviews/:id', { preHandler: guard('admin', 'manager') }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const out = await withTenant(req.user.tid, async (c) => {
      const o = await owned(c, req, id);
      if (!o.r) return o;
      await c.query('DELETE FROM crew_reviews WHERE id = $1', [id]);
      await refreshRating(c, req.user.tid, o.r.user_id, o.r.role_key);
      await audit(c, req.user.tid, req.user.sub, 'crew.review_deleted', 'user', o.r.user_id, { role: o.r.role_key });
      return { ok: true, ratings: await ratingsOf(c, o.r.user_id) };
    });
    if ('error' in out) return reply.code(out.code!).send({ error: out.error });
    return out;
  });

  // Everyone who worked (or is booked on) an event, shift by shift, with the review for that shift if there is one.
  app.get('/api/events/:id/reviews', { preHandler: guard('admin', 'manager') }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const out = await withTenant(req.user.tid, async (c) => {
      if (!(await c.query('SELECT 1 FROM events WHERE id = $1', [id])).rowCount) return null;
      const rows = (
        await c.query(
          `SELECT s.id AS shift_id, s.role_name, s.starts_at, s.ends_at, s.ends_at < now() AS ended,
                  u.id AS user_id, u.name AS user_name,
                  EXISTS (SELECT 1 FROM time_entries t WHERE t.assignment_id = a.id) AS worked,
                  COALESCE(rt.avg_stars, rt.stars)::float8 AS position_avg, COALESCE(rt.reviews, 0) AS position_reviews,
                  rv.id AS review_id, rv.stars, rv.tags, rv.note, rv.rated_by, b.name AS rated_by_name, rv.updated_at AS reviewed_at
             FROM shifts s
             JOIN shift_assignments a ON a.shift_id = s.id AND a.status = 'accepted'
             JOIN users u ON u.id = a.user_id AND u.role = 'crew'
             LEFT JOIN crew_ratings rt ON rt.user_id = u.id AND rt.role_key = lower(trim(regexp_replace(s.role_name, '\\s*\\(.*\\)\\s*$', '')))
             LEFT JOIN crew_reviews rv ON rv.user_id = u.id AND rv.shift_id = s.id
             LEFT JOIN users b ON b.id = rv.rated_by
            WHERE s.event_id = $1
            ORDER BY s.starts_at, s.role_name, u.name`,
          [id],
        )
      ).rows;
      return { workers: rows, rated: rows.filter((r) => r.review_id).length, total: rows.length, ended: rows.filter((r) => r.ended).length };
    });
    return out ?? reply.code(404).send({ error: 'Event not found' });
  });

  // Save (or clear, with stars: null) the review for one person on one shift of this event. Used for autosave.
  app.put('/api/events/:id/reviews', { preHandler: guard('admin', 'manager') }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ shiftId: uuid, userId: uuid, stars: z.number().int().min(1).max(5).nullable(), tags, note }).parse(req.body);
    const out = await withTenant(req.user.tid, async (c) => {
      const s = (
        await c.query(
          `SELECT s.role_name FROM shifts s JOIN shift_assignments a ON a.shift_id = s.id AND a.user_id = $3 AND a.status = 'accepted'
             JOIN users u ON u.id = a.user_id AND u.role = 'crew' WHERE s.id = $1 AND s.event_id = $2`,
          [b.shiftId, id, b.userId],
        )
      ).rows[0];
      if (!s) return { code: 404, error: 'They are not booked on that shift' };
      const key = reviewRoleKey(s.role_name);
      const prev = (await c.query('SELECT id, rated_by FROM crew_reviews WHERE user_id = $1 AND shift_id = $2', [b.userId, b.shiftId])).rows[0];
      if (prev && prev.rated_by && prev.rated_by !== req.user.sub && req.user.role !== 'admin')
        return { code: 403, error: 'Another coordinator already rated this shift; only they or an admin can change it' };
      let reviewId: string | null = null;
      if (b.stars === null) {
        if (prev) await c.query('DELETE FROM crew_reviews WHERE id = $1', [prev.id]);
      } else {
        reviewId = (
          await c.query(
            `INSERT INTO crew_reviews (tenant_id, user_id, role_key, stars, tags, note, shift_id, event_id, rated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
             ON CONFLICT (user_id, shift_id) WHERE shift_id IS NOT NULL DO UPDATE SET stars = EXCLUDED.stars, tags = EXCLUDED.tags, note = EXCLUDED.note, role_key = EXCLUDED.role_key, updated_at = now()
             RETURNING id`,
            [req.user.tid, b.userId, key, b.stars, b.tags, b.note, b.shiftId, id, req.user.sub],
          )
        ).rows[0].id;
      }
      await refreshRating(c, req.user.tid, b.userId, key);
      if (!prev || b.stars === null) await audit(c, req.user.tid, req.user.sub, b.stars === null ? 'crew.review_deleted' : 'crew.review', 'user', b.userId, { role: key, stars: b.stars, shiftId: b.shiftId });
      const pos = (await c.query('SELECT COALESCE(avg_stars, stars)::float8 AS avg, reviews FROM crew_ratings WHERE user_id = $1 AND role_key = $2', [b.userId, key])).rows[0];
      return { reviewId, positionAvg: pos?.avg ?? null, positionReviews: pos?.reviews ?? 0 };
    });
    if ('error' in out) return reply.code(out.code!).send({ error: out.error });
    return out;
  });
}
