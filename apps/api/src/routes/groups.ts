import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTenant, audit } from '../db';
import { guard } from '../auth';
import { groupCandidates } from '../groups';
import { assignCrew } from './events';
import { notify, describeShift } from '../notify';
import { filledCount } from '../eligibility';

const uuid = z.string().uuid();
const mgr = guard('admin', 'manager');

export async function groupRoutes(app: FastifyInstance) {
  app.get('/api/crew-groups', { preHandler: mgr }, async (req) =>
    withTenant(req.user.tid, async (c) => ({
      groups: (
        await c.query(
          `SELECT g.id, g.name, g.description,
             COALESCE((SELECT json_agg(json_build_object('id', u.id, 'name', u.name, 'active', u.active) ORDER BY u.name)
                         FROM crew_group_members m JOIN users u ON u.id = m.user_id WHERE m.group_id = g.id), '[]'::json) AS members
           FROM crew_groups g ORDER BY lower(g.name)`,
        )
      ).rows,
    })),
  );

  app.post('/api/crew-groups', { preHandler: mgr }, async (req, reply) => {
    const b = z.object({ name: z.string().trim().min(1).max(80), description: z.string().trim().max(300).optional() }).parse(req.body);
    const r = await withTenant(req.user.tid, async (c) => {
      if ((await c.query('SELECT 1 FROM crew_groups WHERE lower(name) = lower($1)', [b.name])).rowCount) return null;
      const g = (await c.query('INSERT INTO crew_groups (tenant_id, name, description) VALUES ($1,$2,$3) RETURNING id, name, description', [req.user.tid, b.name, b.description || null])).rows[0];
      await audit(c, req.user.tid, req.user.sub, 'crew_group.create', 'crew_group', g.id, b);
      return g;
    });
    return r ? reply.code(201).send({ group: r }) : reply.code(409).send({ error: 'A group with that name already exists' });
  });

  app.patch('/api/crew-groups/:id', { preHandler: mgr }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ name: z.string().trim().min(1).max(80).optional(), description: z.string().trim().max(300).nullable().optional() }).parse(req.body);
    const r = await withTenant(req.user.tid, async (c) => {
      if (b.name && (await c.query('SELECT 1 FROM crew_groups WHERE lower(name) = lower($1) AND id <> $2', [b.name, id])).rowCount) return { error: 'A group with that name already exists' };
      const g = (await c.query('UPDATE crew_groups SET name = COALESCE($2, name), description = CASE WHEN $3::boolean THEN $4 ELSE description END WHERE id = $1 RETURNING id, name, description', [id, b.name ?? null, b.description !== undefined, b.description ?? null])).rows[0];
      return g ? { group: g } : null;
    });
    if (!r) return reply.code(404).send({ error: 'Group not found' });
    return 'error' in r ? reply.code(409).send(r) : r;
  });

  app.delete('/api/crew-groups/:id', { preHandler: mgr }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const n = await withTenant(req.user.tid, async (c) => {
      const r = await c.query('DELETE FROM crew_groups WHERE id = $1', [id]);
      if (r.rowCount) await audit(c, req.user.tid, req.user.sub, 'crew_group.delete', 'crew_group', id);
      return r.rowCount;
    });
    return n ? { ok: true } : reply.code(404).send({ error: 'Group not found' });
  });

  // Replace a group's members.
  app.put('/api/crew-groups/:id/members', { preHandler: mgr }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { userIds } = z.object({ userIds: z.array(uuid).max(1000) }).parse(req.body);
    const ok = await withTenant(req.user.tid, async (c) => {
      if (!(await c.query('SELECT 1 FROM crew_groups WHERE id = $1', [id])).rowCount) return false;
      await c.query('DELETE FROM crew_group_members WHERE group_id = $1', [id]);
      if (userIds.length)
        await c.query(
          `INSERT INTO crew_group_members (tenant_id, group_id, user_id) SELECT $1, $2, u.id FROM users u WHERE u.id = ANY($3::uuid[]) AND u.role = 'crew' ON CONFLICT DO NOTHING`,
          [req.user.tid, id, userIds],
        );
      await audit(c, req.user.tid, req.user.sub, 'crew_group.members', 'crew_group', id, { count: userIds.length });
      return true;
    });
    return ok ? { ok: true } : reply.code(404).send({ error: 'Group not found' });
  });

  // Who from this group can take the shift, best first (already scheduled people are left out).
  app.get('/api/shifts/:id/group-candidates', { preHandler: mgr }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { groupId } = z.object({ groupId: uuid }).parse(req.query);
    const r = await withTenant(req.user.tid, async (c) => {
      if (!(await c.query('SELECT 1 FROM crew_groups WHERE id = $1', [groupId])).rowCount) return null;
      const out = await groupCandidates(c, id, groupId);
      return out && { candidates: out.candidates, skipped: out.skipped, spots: Math.max(0, (await c.query('SELECT headcount FROM shifts WHERE id = $1', [id])).rows[0].headcount - (await filledCount(c, id))) };
    });
    return r ?? reply.code(404).send({ error: 'Shift or group not found' });
  });

  // Fill a shift from a group: 'auto' offers it to the top-rated available people; 'offer' makes it a first-come open shift for the group.
  app.post('/api/shifts/:id/fill-from-group', { preHandler: mgr }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ groupId: uuid, mode: z.enum(['auto', 'offer']), count: z.number().int().min(1).max(500).optional() }).parse(req.body);
    const r = await withTenant(req.user.tid, async (c) => {
      const lock = (await c.query('SELECT headcount FROM shifts WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!lock) return { code: 404, error: 'Shift not found' };
      const group = (await c.query('SELECT name FROM crew_groups WHERE id = $1', [b.groupId])).rows[0];
      if (!group) return { code: 404, error: 'Group not found' };
      const spots = lock.headcount - (await filledCount(c, id));
      if (spots <= 0) return { code: 409, error: 'This shift is already full' };
      const cand = (await groupCandidates(c, id, b.groupId))!;
      if (!cand.candidates.length) return { code: 409, error: `Nobody in ${group.name} is free for this shift`, skipped: cand.skipped };

      if (b.mode === 'auto') {
        const picked = [];
        for (const p of cand.candidates) {
          if (picked.length >= Math.min(b.count ?? spots, spots)) break;
          const res = await assignCrew(c, req.user.tid, req.user.sub, id, p.user_id);
          if (res.code === 201) picked.push({ user_id: p.user_id, name: p.name, stars: p.stars });
        }
        await audit(c, req.user.tid, req.user.sub, 'shift.fill_group', 'shift', id, { groupId: b.groupId, picked: picked.map((x) => x.user_id) });
        return { code: 200, offered: picked, skipped: cand.skipped };
      }

      await c.query('UPDATE shifts SET is_open = true, offer_group_id = $2 WHERE id = $1', [id, b.groupId]);
      const d = await describeShift(c, req.user.tid, id);
      if (d)
        await notify(c, req.user.tid, cand.candidates.map((p) => ({
          userId: p.user_id, category: 'open_shift' as const, title: `Open shift for ${group.name}: ${d.role}`,
          body: `${d.line}${d.payLine ? '\n' + d.payLine : ''}\n\nThis shift is offered to your group first-come, first-served. Claim it if you are available.`, link: '/open-shifts',
        })));
      await audit(c, req.user.tid, req.user.sub, 'shift.offer_group', 'shift', id, { groupId: b.groupId, notified: cand.candidates.length });
      return { code: 200, notified: cand.candidates.length, skipped: cand.skipped };
    });
    const { code, ...body } = r as { code: number; [k: string]: unknown };
    return reply.code(code).send(body);
  });
}
