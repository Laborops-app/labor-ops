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
  phone: z.string().trim().max(40).nullable().optional(),
  skills: z.array(z.string().trim().min(1).max(40)).max(30).optional(),
  active: z.boolean().optional(),
});

const COLS = 'id, name, email, role, phone, skills, active, created_at, address, emergency_name, emergency_phone, bio';

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

  app.patch('/api/crew/:id', { preHandler: guard('admin', 'manager') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = patchBody.parse(req.body);
    const row = await withTenant(req.user.tid, async (c) => {
      const r = await c.query(
        `UPDATE users SET name = COALESCE($2, name), phone = CASE WHEN $3::boolean THEN $4 ELSE phone END,
           skills = COALESCE($5, skills), active = COALESCE($6, active)
         WHERE id = $1 AND (role = 'crew' OR $7 = 'admin') RETURNING ${COLS}`,
        [id, b.name ?? null, b.phone !== undefined, b.phone ?? null, b.skills ?? null, b.active ?? null, req.user.role],
      );
      if (r.rows[0]) await audit(c, req.user.tid, req.user.sub, 'user.update', 'user', id, b);
      return r.rows[0];
    });
    if (!row) return reply.code(404).send({ error: 'Not found' });
    return { member: row };
  });
}
