import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTenant, audit } from '../db';
import { authenticate, guard } from '../auth';
import { STARTER_GROUPS, STARTER_TEMPLATES } from '../starter';

const admin = guard('admin');
const idParam = z.object({ id: z.string().uuid() });
const rate = z.number().min(0).max(10000).multipleOf(0.01);
const name = z.string().trim().min(1).max(60);

export async function skillRoutes(app: FastifyInstance) {
  // Everyone signed in can read the names and groups (they fill the drop-downs). Only admins see pay rates.
  app.get('/api/skills', { preHandler: authenticate }, async (req) => {
    const isAdmin = req.user.role === 'admin';
    return withTenant(req.user.tid, async (c) => {
      const rows = (
        await c.query(
          `SELECT s.id, s.name, s.pay_rate, s.bill_rate, s.active, s.group_id FROM skills s ${isAdmin ? '' : 'WHERE s.active'} ORDER BY lower(s.name)`,
        )
      ).rows;
      const groups = (await c.query('SELECT id, name FROM skill_groups ORDER BY sort, lower(name)')).rows;
      return {
        groups,
        skills: rows.map((r) => ({ id: r.id, name: r.name, active: r.active, groupId: r.group_id, ...(isAdmin ? { payRate: Number(r.pay_rate) } : {}), ...(req.user.role !== 'crew' ? { billRate: Number(r.bill_rate) } : {}) })),
      };
    });
  });

  // ---- groups (Audio, Lighting, Stage Hand ...) ----
  const groupName = z.string().trim().min(1).max(60);
  app.post('/api/skill-groups', { preHandler: admin }, async (req, reply) => {
    const b = z.object({ name: groupName }).parse(req.body);
    const out = await withTenant(req.user.tid, async (c) => {
      if ((await c.query('SELECT 1 FROM skill_groups WHERE lower(name) = lower($1)', [b.name])).rowCount) return null;
      const r = await c.query('INSERT INTO skill_groups (tenant_id, name, sort) VALUES ($1,$2,(SELECT COALESCE(max(sort),0)+1 FROM skill_groups)) RETURNING id, name', [req.user.tid, b.name]);
      await audit(c, req.user.tid, req.user.sub, 'skill_group.create', 'skill_group', r.rows[0].id, { name: b.name });
      return r.rows[0];
    });
    return out ? reply.code(201).send({ group: out }) : reply.code(409).send({ error: 'A group with that name already exists' });
  });
  app.patch('/api/skill-groups/:id', { preHandler: admin }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const b = z.object({ name: groupName }).parse(req.body);
    const out = await withTenant(req.user.tid, async (c) => {
      if ((await c.query('SELECT 1 FROM skill_groups WHERE lower(name) = lower($1) AND id <> $2', [b.name, id])).rowCount) return 'dup';
      const r = await c.query('UPDATE skill_groups SET name = $2 WHERE id = $1 RETURNING id, name', [id, b.name]);
      return r.rows[0] ?? null;
    });
    if (out === 'dup') return reply.code(409).send({ error: 'A group with that name already exists' });
    return out ? { group: out } : reply.code(404).send({ error: 'Not found' });
  });
  app.delete('/api/skill-groups/:id', { preHandler: admin }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    // Roles in the group are kept; they just become ungrouped.
    const n = await withTenant(req.user.tid, async (c) => (await c.query('DELETE FROM skill_groups WHERE id = $1', [id])).rowCount);
    return n ? { ok: true } : reply.code(404).send({ error: 'Not found' });
  });

  // ---- starter set: groups, roles and shift templates for a production company. Safe to run again; adds only what is missing. ----
  app.post('/api/skills/starter', { preHandler: admin }, async (req) =>
    withTenant(req.user.tid, async (c) => {
      const added = { groups: 0, roles: 0, templates: 0 };
      for (const g of STARTER_GROUPS) {
        let gr = (await c.query('SELECT id FROM skill_groups WHERE lower(name) = lower($1)', [g.name])).rows[0];
        if (!gr) {
          gr = (await c.query('INSERT INTO skill_groups (tenant_id, name, sort) VALUES ($1,$2,(SELECT COALESCE(max(sort),0)+1 FROM skill_groups)) RETURNING id', [req.user.tid, g.name])).rows[0];
          added.groups++;
        }
        for (const role of g.roles) {
          const have = (await c.query('SELECT id, group_id FROM skills WHERE lower(name) = lower($1)', [role])).rows[0];
          if (!have) {
            await c.query('INSERT INTO skills (tenant_id, name, group_id) VALUES ($1,$2,$3)', [req.user.tid, role, gr.id]);
            added.roles++;
          } else if (!have.group_id) await c.query('UPDATE skills SET group_id = $2 WHERE id = $1', [have.id, gr.id]);
        }
      }
      for (const t of STARTER_TEMPLATES) {
        if ((await c.query('SELECT 1 FROM shift_templates WHERE lower(name) = lower($1)', [t.name])).rowCount) continue;
        await c.query('INSERT INTO shift_templates (tenant_id, name, items) VALUES ($1,$2,$3)', [
          req.user.tid, t.name, JSON.stringify(t.items.map((i) => ({ ...i, isOpen: false, requiredCerts: [] }))),
        ]);
        added.templates++;
      }
      await audit(c, req.user.tid, req.user.sub, 'skill.starter', 'skill', null, added);
      return { added };
    }),
  );

  app.post('/api/skills', { preHandler: admin }, async (req, reply) => {
    const b = z.object({ name, payRate: rate.default(0), billRate: rate.default(0), groupId: z.string().uuid().nullable().optional() }).parse(req.body);
    const row = await withTenant(req.user.tid, async (c) => {
      const r = await c.query('INSERT INTO skills (tenant_id, name, pay_rate, bill_rate, group_id) VALUES ($1,$2,$3,$4,$5) RETURNING id, name, pay_rate, bill_rate, active, group_id', [req.user.tid, b.name, b.payRate, b.billRate, b.groupId ?? null]);
      await audit(c, req.user.tid, req.user.sub, 'skill.create', 'skill', r.rows[0].id, { name: b.name, payRate: b.payRate });
      return r.rows[0];
    });
    return reply.code(201).send({ skill: { id: row.id, name: row.name, active: row.active, groupId: row.group_id, payRate: Number(row.pay_rate), billRate: Number(row.bill_rate) } });
  });

  app.patch('/api/skills/:id', { preHandler: admin }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const b = z.object({ name: name.optional(), payRate: rate.optional(), billRate: rate.optional(), active: z.boolean().optional(), groupId: z.string().uuid().nullable().optional() }).parse(req.body);
    const row = await withTenant(req.user.tid, async (c) => {
      const old = (await c.query('SELECT name FROM skills WHERE id = $1', [id])).rows[0];
      if (!old) return null;
      const r = await c.query(
        'UPDATE skills SET name = COALESCE($2, name), pay_rate = COALESCE($3, pay_rate), active = COALESCE($4, active), group_id = CASE WHEN $5::boolean THEN $6::uuid ELSE group_id END, bill_rate = COALESCE($7, bill_rate) WHERE id = $1 RETURNING id, name, pay_rate, bill_rate, active, group_id',
        [id, b.name ?? null, b.payRate ?? null, b.active ?? null, b.groupId !== undefined, b.groupId ?? null, b.billRate ?? null],
      );
      // A rename carries over to the people who have the skill.
      if (b.name && b.name !== old.name) await c.query('UPDATE users SET skills = array_replace(skills, $1, $2)', [old.name, b.name]);
      await audit(c, req.user.tid, req.user.sub, 'skill.update', 'skill', id, b);
      return r.rows[0];
    });
    if (!row) return reply.code(404).send({ error: 'Not found' });
    return { skill: { id: row.id, name: row.name, active: row.active, groupId: row.group_id, payRate: Number(row.pay_rate), billRate: Number(row.bill_rate) } };
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
