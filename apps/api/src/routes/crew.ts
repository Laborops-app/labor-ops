import { crewRoomFor } from '../billing';
import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { z } from 'zod';
import { withTenant, audit, pool } from '../db';
import { guard, forgetUser } from '../auth';
import { sendInvite } from '../notify/tokens';
import { FLAG_TAGS, ratingsOf, refreshRating, reviewRoleKey } from '../reviews';

const createBody = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().email().max(200),
  phone: z.string().trim().max(40).optional().nullable(),
  skills: z.array(z.string().trim().min(1).max(40)).max(30).default([]),
  role: z.enum(['crew', 'manager', 'admin']).default('crew'),
  password: z.string().min(8).max(200).optional(),
});
const patchBody = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  email: z.string().trim().email().max(200).optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  address: z.string().trim().max(300).nullable().optional(),
  emergencyName: z.string().trim().max(100).nullable().optional(),
  emergencyPhone: z.string().trim().max(40).nullable().optional(),
  bio: z.string().trim().max(1000).nullable().optional(),
  coordinatorNotes: z.string().trim().max(2000).nullable().optional(),
  skills: z.array(z.string().trim().min(1).max(40)).max(30).optional(),
  active: z.boolean().optional(),
});

const COLS = 'id, name, email, role, phone, skills, field_roles, active, created_at, address, emergency_name, emergency_phone, bio, coordinator_notes, can_adjust_rates';
/** Leads are chosen per event (on the assignment), so the only permission kept on the person is this one. */
export const FIELD_ROLES = ['onsite_coordinator'] as const;

export async function crewRoutes(app: FastifyInstance) {
  app.get('/api/crew', { preHandler: guard('admin', 'manager') }, async (req) => {
    return withTenant(req.user.tid, async (c) => ({
      crew: (
        await c.query(
          `SELECT ${COLS},${req.user.role === 'admin' ? ' payroll_ids,' : ''}
             COALESCE((SELECT json_agg(json_build_object('id', k.id, 'name', k.name, 'expires_on', k.expires_on::text, 'verified', k.verified, 'has_file', EXISTS (SELECT 1 FROM cert_files f WHERE f.cert_id = k.id)) ORDER BY k.name)
                       FROM user_certs k WHERE k.user_id = users.id), '[]'::json) AS certs,
             EXISTS (SELECT 1 FROM availability a WHERE a.user_id = users.id) AS has_availability,
             COALESCE((SELECT json_object_agg(r.role_key, COALESCE(r.avg_stars, r.stars)::float8) FROM crew_ratings r WHERE r.user_id = users.id), '{}'::json) AS ratings,
             (SELECT avg(v.stars)::float8 FROM crew_reviews v WHERE v.user_id = users.id) AS rating_avg,
             (SELECT count(*)::int FROM crew_reviews v WHERE v.user_id = users.id) AS review_count,
             (SELECT count(*)::int FROM crew_reviews v WHERE v.user_id = users.id AND v.tags && $1::text[]) AS flag_count,
             (SELECT max(v.created_at) FROM crew_reviews v WHERE v.user_id = users.id) AS last_reviewed_at,
             (SELECT count(*)::int FROM crew_reviews v WHERE v.user_id = users.id AND 'no_show' = ANY(v.tags)) AS no_show_count,
             (SELECT count(*)::int FROM crew_reviews v WHERE v.user_id = users.id AND 'no_rehire' = ANY(v.tags)) AS no_rehire_count
           FROM users ORDER BY role, name`,
          [FLAG_TAGS],
        )
      ).rows,
    }));
  });

  // Let a Labor Coordinator change pay and bill rates (admins always can).
  app.put('/api/crew/:id/rate-permission', { preHandler: guard('admin') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { allowed } = z.object({ allowed: z.boolean() }).parse(req.body);
    const row = await withTenant(req.user.tid, async (c) => {
      const r = await c.query("UPDATE users SET can_adjust_rates = $2 WHERE id = $1 AND role = 'manager' RETURNING id, can_adjust_rates", [id, allowed]);
      if (r.rows[0]) await audit(c, req.user.tid, req.user.sub, 'user.rate_permission', 'user', id, { allowed });
      return r.rows[0];
    });
    return row ?? reply.code(404).send({ error: 'Labor coordinator not found' });
  });

  // Quick rating (1-5) for one position: this coordinator's general review for it (not tied to a shift). null removes it.
  // Ratings are internal to admins and coordinators.
  app.put('/api/crew/:id/ratings', { preHandler: guard('admin', 'manager') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ role: z.string().trim().min(1).max(100), stars: z.number().int().min(1).max(5).nullable() }).parse(req.body);
    const key = reviewRoleKey(b.role);
    const out = await withTenant(req.user.tid, async (c) => {
      const u = (await c.query("SELECT 1 FROM users WHERE id = $1 AND role = 'crew'", [id])).rowCount;
      if (!u) return null;
      const mine = (await c.query('SELECT id FROM crew_reviews WHERE user_id = $1 AND role_key = $2 AND shift_id IS NULL AND rated_by = $3 ORDER BY created_at DESC', [id, key, req.user.sub])).rows;
      if (b.stars === null) await c.query('DELETE FROM crew_reviews WHERE id = ANY($1::uuid[])', [mine.map((r) => r.id)]);
      else if (mine[0]) await c.query('UPDATE crew_reviews SET stars = $2, updated_at = now() WHERE id = $1', [mine[0].id, b.stars]);
      else await c.query('INSERT INTO crew_reviews (tenant_id, user_id, role_key, stars, rated_by) VALUES ($1,$2,$3,$4,$5)', [req.user.tid, id, key, b.stars, req.user.sub]);
      await refreshRating(c, req.user.tid, id, key);
      await audit(c, req.user.tid, req.user.sub, 'crew.rating', 'user', id, { role: key, stars: b.stars });
      return ratingsOf(c, id);
    });
    if (!out) return reply.code(404).send({ error: 'Crew member not found' });
    return { ratings: out };
  });

  app.post('/api/crew', { preHandler: guard('admin', 'manager') }, async (req, reply) => {
    const body = createBody.parse(req.body);
    if (body.role !== 'crew' && req.user.role !== 'admin')
      return reply.code(403).send({ error: body.role === 'admin' ? 'Only an admin can add admins' : 'Only an admin can add labor coordinators' });
    if ((await pool.query('SELECT 1 FROM auth_find_user($1)', [body.email])).rowCount)
      return reply.code(409).send({ error: 'That email is already registered' });
    if (body.role === 'crew') {
      const full = await crewRoomFor(req.user.tid);
      if (full) return reply.code(402).send({ error: full, reason: 'plan_limit' });
    }
    // Demo has no email invites yet, so a temporary password is shown once to whoever adds the person.
    const tempPassword = body.password ?? crypto.randomBytes(6).toString('base64url');
    const hash = await bcrypt.hash(tempPassword, 10);
    const row = await withTenant(req.user.tid, async (c) => {
      const r = await c.query(
        `INSERT INTO users (tenant_id, email, name, role, password_hash, phone, skills)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${COLS}`,
        [req.user.tid, body.email, body.name, body.role, hash, body.phone ?? null, body.skills],
      );
      await audit(c, req.user.tid, req.user.sub, 'user.create', 'user', r.rows[0].id, { role: body.role });
      await sendInvite(c, req.user.tid, r.rows[0]);
      return r.rows[0];
    });
    return reply.code(201).send({ member: row, tempPassword: body.password ? undefined : tempPassword });
  });

  app.get('/api/crew/:id', { preHandler: guard('admin', 'manager') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const out = await withTenant(req.user.tid, async (c) => {
      const member = (await c.query(`SELECT ${COLS} FROM users WHERE id = $1`, [id])).rows[0];
      if (!member) return null;
      return {
        member,
        certs: (
          await c.query(
            `SELECT k.id, k.name, k.expires_on::text, k.verified, f.filename AS file_name, f.size AS file_size
             FROM user_certs k LEFT JOIN cert_files f ON f.cert_id = k.id WHERE k.user_id = $1 ORDER BY k.name`,
            [id],
          )
        ).rows,
        windows: (
          await c.query(
            "SELECT weekday, to_char(start_time, 'HH24:MI') AS start_time, to_char(end_time, 'HH24:MI') AS end_time FROM availability WHERE user_id = $1 ORDER BY weekday",
            [id],
          )
        ).rows,
        timeOff: (await c.query('SELECT id, starts_on::text, ends_on::text, note FROM time_off WHERE user_id = $1 AND ends_on >= current_date ORDER BY starts_on', [id])).rows,
      };
    });
    return out ?? reply.code(404).send({ error: 'Not found' });
  });

  // Email someone a fresh link to choose their own password.
  app.post('/api/crew/:id/invite', { preHandler: guard('admin', 'manager') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const ok = await withTenant(req.user.tid, async (c) => {
      const u = (await c.query("SELECT id, email, name FROM users WHERE id = $1 AND active AND (role = 'crew' OR $2 = 'admin') AND id <> $3", [id, req.user.role, req.user.sub])).rows[0];
      if (!u) return false;
      await sendInvite(c, req.user.tid, u);
      await audit(c, req.user.tid, req.user.sub, 'user.invite', 'user', id);
      return true;
    });
    return ok ? { ok: true } : reply.code(404).send({ error: 'Not found' });
  });

  // Set a new temporary password for someone (they can change it on their profile).
  app.post('/api/crew/:id/password', { preHandler: guard('admin', 'manager') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ password: z.string().min(8).max(200).optional() }).parse(req.body ?? {});
    const temp = b.password ?? crypto.randomBytes(6).toString('base64url');
    const hash = await bcrypt.hash(temp, 10);
    const ok = await withTenant(req.user.tid, async (c) => {
      const r = await c.query("UPDATE users SET password_hash = $2 WHERE id = $1 AND (role = 'crew' OR $3 = 'admin') AND id <> $4", [id, hash, req.user.role, req.user.sub]);
      if (r.rowCount) await audit(c, req.user.tid, req.user.sub, 'user.password_reset', 'user', id);
      return r.rowCount;
    });
    if (!ok) return reply.code(404).send({ error: 'Not found' });
    return { tempPassword: b.password ? undefined : temp };
  });

  app.patch('/api/crew/:id', { preHandler: guard('admin', 'manager') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = patchBody.parse(req.body);
    if (b.active === false && id === req.user.sub) return reply.code(400).send({ error: 'You cannot deactivate your own account' });
    if (b.active === true) {
      // Bringing back an inactive crew member takes a seat on the plan.
      const was = (await withTenant(req.user.tid, (c) => c.query('SELECT active, role FROM users WHERE id = $1', [id]))).rows[0];
      const full = was && !was.active && was.role === 'crew' ? await crewRoomFor(req.user.tid) : null;
      if (full) return reply.code(402).send({ error: full, reason: 'plan_limit' });
    }
    if (b.email) {
      const taken = (await pool.query('SELECT id FROM auth_find_user($1)', [b.email])).rows[0];
      if (taken && taken.id !== id) return reply.code(409).send({ error: 'That email is already registered to someone else' });
    }
    const row = await withTenant(req.user.tid, async (c) => {
      const r = await c.query(
        `UPDATE users SET name = COALESCE($2, name), phone = CASE WHEN $3::boolean THEN $4 ELSE phone END,
           skills = COALESCE($5, skills), active = COALESCE($6, active), email = COALESCE($8, email),
           address = CASE WHEN $9::boolean THEN $10 ELSE address END,
           emergency_name = CASE WHEN $11::boolean THEN $12 ELSE emergency_name END,
           emergency_phone = CASE WHEN $13::boolean THEN $14 ELSE emergency_phone END,
           bio = CASE WHEN $15::boolean THEN $16 ELSE bio END,
           coordinator_notes = CASE WHEN $17::boolean THEN $18 ELSE coordinator_notes END
         WHERE id = $1 AND (role = 'crew' OR $7 = 'admin') RETURNING ${COLS}`,
        [
          id, b.name ?? null, b.phone !== undefined, b.phone || null, b.skills ?? null, b.active ?? null, req.user.role, b.email ?? null,
          b.address !== undefined, b.address || null,
          b.emergencyName !== undefined, b.emergencyName || null,
          b.emergencyPhone !== undefined, b.emergencyPhone || null,
          b.bio !== undefined, b.bio || null,
          b.coordinatorNotes !== undefined, b.coordinatorNotes || null,
        ],
      );
      if (r.rows[0]) await audit(c, req.user.tid, req.user.sub, 'user.update', 'user', id, { fields: Object.keys(b) });
      return r.rows[0];
    });
    if (!row) return reply.code(404).send({ error: 'Not found' });
    if (b.active !== undefined) forgetUser(id);
    return { member: row };
  });

  // Change someone's role. Only admins, and never your own (so a company always keeps an admin).
  app.put('/api/crew/:id/role', { preHandler: guard('admin') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { role } = z.object({ role: z.enum(['crew', 'manager', 'admin']) }).parse(req.body);
    if (id === req.user.sub) return reply.code(400).send({ error: 'You cannot change your own role. Ask another admin.' });
    const row = await withTenant(req.user.tid, async (c) => {
      const prev = (await c.query('SELECT role FROM users WHERE id = $1', [id])).rows[0];
      if (!prev) return null;
      // Field permissions are for crew; a coordinator or admin already has the full event pages.
      const r = await c.query(`UPDATE users SET role = $2, field_roles = CASE WHEN $2 = 'crew' THEN field_roles ELSE '{}' END,
                                 can_adjust_rates = CASE WHEN $2 = 'manager' THEN can_adjust_rates ELSE false END
                               WHERE id = $1 RETURNING ${COLS}`, [id, role]);
      if (prev.role !== role) await audit(c, req.user.tid, req.user.sub, 'user.role', 'user', id, { from: prev.role, to: role });
      return r.rows[0];
    });
    if (!row) return reply.code(404).send({ error: 'Not found' });
    forgetUser(id);
    return { member: row };
  });

  // Field permission for a crew member: On-site Labor Coordinator.
  app.put('/api/crew/:id/field-roles', { preHandler: guard('admin', 'manager') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { fieldRoles } = z.object({ fieldRoles: z.array(z.enum(FIELD_ROLES)).max(1) }).parse(req.body);
    const row = await withTenant(req.user.tid, async (c) => {
      const r = await c.query(`UPDATE users SET field_roles = $2 WHERE id = $1 AND role = 'crew' RETURNING ${COLS}`, [id, [...new Set(fieldRoles)]]);
      if (r.rows[0]) await audit(c, req.user.tid, req.user.sub, 'user.field_roles', 'user', id, { fieldRoles });
      return r.rows[0];
    });
    if (!row) return reply.code(404).send({ error: 'Field permissions are for crew members' });
    return { member: row };
  });
}
