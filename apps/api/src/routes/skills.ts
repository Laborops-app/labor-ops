import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTenant, audit } from '../db';
import { authenticate, guard } from '../auth';

const admin = guard('admin');
const idParam = z.object({ id: z.string().uuid() });
const rate = z.number().min(0).max(10000).multipleOf(0.01);
const name = z.string().trim().min(1).max(60);

export async function skillRoutes(app: FastifyInstance) {
  // Everyone signed in can read the names (they fill the drop-downs). Only admins see pay rates.
  app.get('/api/skills', { preHandler: authenticate }, async (req) => {
    const isAdmin = req.user.role === 'admin';
    const rows = await withTenant(req.user.tid, async (c) =>
      (await c.query(`SELECT id, name, pay_rate, active FROM skills ${isAdmin ? '' : 'WHERE active'} ORDER BY lower(name)`)).rows,
    );
    return {
      skills: rows.map((r) => ({ id: r.id, name: r.name, active: r.active, ...(isAdmin ? { payRate: Number(r.pay_rate) } : {}) })),
    };
  });

  app.post('/api/skills', { preHandler: admin }, async (req, reply) => {
    const b = z.object({ name, payRate: rate.default(0) }).parse(req.body);
    const row = await withTenant(req.user.tid, async (c) => {
      const r = await c.query('INSERT INTO skills (tenant_id, name, pay_rate) VALUES ($1,$2,$3) RETURNING id, name, pay_rate, active', [req.user.tid, b.name, b.payRate]);
      await audit(c, req.user.tid, req.user.sub, 'skill.create', 'skill', r.rows[0].id, { name: b.name, payRate: b.payRate });
      return r.rows[0];
    });
    return reply.code(201).send({ skill: { id: row.id, name: row.name, active: row.active, payRate: Number(row.pay_rate) } });
  });

  app.patch('/api/skills/:id', { preHandler: admin }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const b = z.object({ name: name.optional(), payRate: rate.optional(), active: z.boolean().optional() }).parse(req.body);
    const row = await withTenant(req.user.tid, async (c) => {
      const old = (await c.query('SELECT name FROM skills WHERE id = $1', [id])).rows[0];
      if (!old) return null;
      const r = await c.query(
        'UPDATE skills SET name = COALESCE($2, name), pay_rate = COALESCE($3, pay_rate), active = COALESCE($4, active) WHERE id = $1 RETURNING id, name, pay_rate, active',
        [id, b.name ?? null, b.payRate ?? null, b.active ?? null],
      );
      // A rename carries over to the people who have the skill.
      if (b.name && b.name !== old.name) await c.query('UPDATE users SET skills = array_replace(skills, $1, $2)', [old.name, b.name]);
      await audit(c, req.user.tid, req.user.sub, 'skill.update', 'skill', id, b);
      return r.rows[0];
    });
    if (!row) return reply.code(404).send({ error: 'Not found' });
    return { skill: { id: row.id, name: row.name, active: row.active, payRate: Number(row.pay_rate) } };
  });

  app.delete('/api/skills/:id', { preHandler: admin }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const n = await withTenant(req.user.tid, async (c) => {
      const r = await c.query('DELETE FROM skills WHERE id = $1', [id]);
      if (r.rowCount) await audit(c, req.user.tid, req.user.sub, 'skill.delete', 'skill', id);
      return r.rowCount;
    });
    return n ? { ok: true } : reply.code(404).send({ error: 'Not found' });
  });
}
