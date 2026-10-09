import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { z } from 'zod';
import { withTenant, audit, pool } from '../db';
import { guard } from '../auth';

const createBody = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().email().max(200),
  phone: z.string().trim().max(40).optional().nullable(),
  skills: z.array(z.string().trim().min(1).max(40)).max(30).default([]),
  role: z.enum(['crew', 'manager']).default('crew'),
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

const COLS = 'id, name, email, role, phone, skills, active, created_at, address, emergency_name, emergency_phone, bio, coordinator_notes';

export async function crewRoutes(app: FastifyInstance) {
  app.get('/api/crew', { preHandler: guard('admin', 'manager') }, async (req) => {
    return withTenant(req.user.tid, async (c) => ({
      crew: (
        await c.query(
          `SELECT ${COLS},
             COALESCE((SELECT json_agg(json_build_object('id', k.id, 'name', k.name, 'expires_on', k.expires_on::text, 'verified', k.verified, 'has_file', EXISTS (SELECT 1 FROM cert_files f WHERE f.cert_id = k.id)) ORDER BY k.name)
                       FROM user_certs k WHERE k.user_id = users.id), '[]'::json) AS certs,
             EXISTS (SELECT 1 FROM availability a WHERE a.user_id = users.id) AS has_availability
           FROM users ORDER BY role, name`,
        )
      ).rows,
    }));
  });

  app.post('/api/crew', { preHandler: guard('admin', 'manager') }, async (req, reply) => {
    const body = createBody.parse(req.body);
    if (body.role === 'manager' && req.user.role !== 'admin')
      return reply.code(403).send({ error: 'Only an admin can add managers' });
    if ((await pool.query('SELECT 1 FROM auth_find_user($1)', [body.email])).rowCount)
      return reply.code(409).send({ error: 'That email is already registered' });
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
    return { member: row };
  });
}
