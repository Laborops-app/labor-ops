import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTenant, audit } from '../db';
import { guard } from '../auth';
import { clearToken, getToken, RentmanError, saveToken, syncEquipment, syncProjects, testToken } from '../rentman';

const uuid = z.string().uuid();
const adm = guard('admin');
const mgr = guard('admin', 'manager');

const fail = (reply: any, e: unknown) => {
  if (e instanceof RentmanError) return reply.code(e.status).send({ error: e.message });
  throw e;
};

export async function rentmanRoutes(app: FastifyInstance) {
  app.get('/api/rentman/settings', { preHandler: mgr }, async (req) =>
    withTenant(req.user.tid, async (c) => {
      const s = (await c.query('SELECT count(*)::int AS n, max(synced_at) AS last FROM rentman_projects')).rows[0];
      return { connected: !!(await getToken(c)), projects: s.n, lastSync: s.last };
    }),
  );

  app.put('/api/rentman/settings', { preHandler: adm }, async (req, reply) => {
    const { token } = z.object({ token: z.string().trim().min(10).max(4000) }).parse(req.body);
    try {
      await testToken(token);
    } catch (e) {
      return fail(reply, e);
    }
    await withTenant(req.user.tid, async (c) => {
      await saveToken(c, req.user.tid, req.user.sub, token);
      await audit(c, req.user.tid, req.user.sub, 'rentman.connect', 'integration', null);
    });
    return { connected: true };
  });

  app.delete('/api/rentman/settings', { preHandler: adm }, async (req) => {
    await withTenant(req.user.tid, async (c) => {
      await clearToken(c);
      await audit(c, req.user.tid, req.user.sub, 'rentman.disconnect', 'integration', null);
    });
    return { connected: false };
  });

  // Sync every Rentman project into the app.
  app.post('/api/rentman/sync', { preHandler: mgr }, async (req, reply) => {
    try {
      const n = await withTenant(req.user.tid, async (c) => {
        const token = await getToken(c);
        if (!token) throw new RentmanError('Connect Rentman first (Integrations page).', 409);
        const n = await syncProjects(c, req.user.tid, token);
        await audit(c, req.user.tid, req.user.sub, 'rentman.sync', 'integration', null, { projects: n });
        return n;
      });
      return { synced: n };
    } catch (e) {
      return fail(reply, e);
    }
  });

  // Project picker: recent and upcoming first.
  app.get('/api/rentman/projects', { preHandler: mgr }, async (req) => {
    const { q } = z.object({ q: z.string().trim().max(100).optional() }).parse(req.query);
    return withTenant(req.user.tid, async (c) => ({
      projects: (
        await c.query(
          `SELECT id, number, name, customer, location, planperiod_start, planperiod_end FROM rentman_projects
            WHERE $1::text IS NULL OR name ILIKE '%' || $1 || '%' OR customer ILIKE '%' || $1 || '%' OR number::text = $1
            ORDER BY planperiod_start DESC NULLS LAST, id DESC LIMIT 300`,
          [q || null],
        )
      ).rows,
    }));
  });

  // The Rentman project and equipment linked to an event.
  const view = async (c: any, eventId: string, isAdmin: boolean) => {
    const ev = (await c.query('SELECT rentman_project_id FROM events WHERE id = $1', [eventId])).rows[0];
    if (!ev) return undefined;
    if (!ev.rentman_project_id) return { linked: false, connected: !!(await getToken(c)) };
    const project = (await c.query('SELECT * FROM rentman_projects WHERE id = $1', [ev.rentman_project_id])).rows[0] ?? null;
    const equipment = (await c.query('SELECT item_id, name, quantity, unit_price, is_option, period_start, period_end, remark, group_id, group_name, group_sort, parent_id FROM rentman_equipment WHERE project_id = $1 ORDER BY sort', [ev.rentman_project_id])).rows
      .map((r: any) => (isAdmin ? r : { ...r, unit_price: undefined }));
    return { linked: true, connected: !!(await getToken(c)), project, equipment };
  };

  app.get('/api/events/:id/rentman', { preHandler: mgr }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const out = await withTenant(req.user.tid, (c) => view(c, id, req.user.role === 'admin'));
    return out === undefined ? reply.code(404).send({ error: 'Event not found' }) : out;
  });

  // Link (or unlink, with null) a Rentman project; equipment is pulled straight away.
  app.put('/api/events/:id/rentman', { preHandler: mgr }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { projectId } = z.object({ projectId: z.number().int().nullable() }).parse(req.body);
    try {
      const out = await withTenant(req.user.tid, async (c) => {
        if (!(await c.query('SELECT 1 FROM events WHERE id = $1', [id])).rowCount) return undefined;
        if (projectId !== null && !(await c.query('SELECT 1 FROM rentman_projects WHERE id = $1', [projectId])).rowCount)
          throw new RentmanError('That Rentman project is not synced yet. Sync projects first.', 409);
        await c.query('UPDATE events SET rentman_project_id = $2 WHERE id = $1', [id, projectId]);
        await audit(c, req.user.tid, req.user.sub, 'event.rentman', 'event', id, { projectId });
        let warning: string | undefined;
        if (projectId !== null) {
          const token = await getToken(c);
          if (token) await syncEquipment(c, req.user.tid, token, projectId).catch((e) => { warning = e instanceof RentmanError ? e.message : 'Could not load the equipment list.'; });
        }
        return { ...(await view(c, id, req.user.role === 'admin')), warning };
      });
      return out === undefined ? reply.code(404).send({ error: 'Event not found' }) : out;
    } catch (e) {
      return fail(reply, e);
    }
  });

  // Re-read the linked project and its equipment from Rentman.
  app.post('/api/events/:id/rentman/refresh', { preHandler: mgr }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    try {
      const out = await withTenant(req.user.tid, async (c) => {
        const ev = (await c.query('SELECT rentman_project_id FROM events WHERE id = $1', [id])).rows[0];
        if (!ev) return undefined;
        if (!ev.rentman_project_id) throw new RentmanError('This event is not linked to a Rentman project.', 409);
        const token = await getToken(c);
        if (!token) throw new RentmanError('Connect Rentman first (Integrations page).', 409);
        await syncEquipment(c, req.user.tid, token, ev.rentman_project_id);
        return view(c, id, req.user.role === 'admin');
      });
      return out === undefined ? reply.code(404).send({ error: 'Event not found' }) : out;
    } catch (e) {
      return fail(reply, e);
    }
  });
}
