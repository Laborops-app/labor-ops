import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTenant, audit } from '../db';
import { guard } from '../auth';
import { checkEventRequest, checkOpenRequests, clearToken, getToken, pullCustomers, pushCustomer, pushEventRequest, RentmanError, saveToken, syncEquipment, syncProjects, testToken } from '../rentman';

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
        const customers = await pullCustomers(c, req.user.tid, token);
        const linked = await checkOpenRequests(c, req.user.tid, token);
        await audit(c, req.user.tid, req.user.sub, 'rentman.sync', 'integration', null, { projects: n, customers, linked });
        return { n, customers, linked };
      });
      return { synced: n.n, customers: n.customers, requestsLinked: n.linked };
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
          `SELECT p.id, p.number, p.name, p.customer, p.location, p.planperiod_start, p.planperiod_end, lc.address AS location_address,
                  (SELECT cu.id FROM customers cu WHERE cu.rentman_contact_id = p.customer_id OR lower(cu.name) = lower(p.customer) ORDER BY (cu.rentman_contact_id = p.customer_id) DESC NULLS LAST LIMIT 1) AS customer_local_id
             FROM rentman_projects p LEFT JOIN rentman_contacts lc ON lc.id = p.location_id
            WHERE $1::text IS NULL OR p.name ILIKE '%' || $1 || '%' OR p.customer ILIKE '%' || $1 || '%' OR p.number::text = $1
            ORDER BY p.planperiod_start DESC NULLS LAST, p.id DESC LIMIT 300`,
          [q || null],
        )
      ).rows,
    }));
  });

  // Send customers that are not in Rentman yet (matching names are linked, not duplicated).
  app.post('/api/rentman/push-customers', { preHandler: mgr }, async (req, reply) => {
    try {
      const out = await withTenant(req.user.tid, async (c) => {
        const token = await getToken(c);
        if (!token) throw new RentmanError('Connect Rentman first (Integrations page).', 409);
        let sent = 0;
        let failed = 0;
        for (const cu of (await c.query('SELECT id FROM customers WHERE rentman_contact_id IS NULL ORDER BY lower(name)')).rows) {
          await c.query('SAVEPOINT one');
          try { await pushCustomer(c, token, cu.id); sent++; await c.query('RELEASE SAVEPOINT one'); }
          catch (e) { await c.query('ROLLBACK TO SAVEPOINT one'); failed++; if (e instanceof RentmanError && (e.status === 400 || e.status === 403)) throw e; }
        }
        await audit(c, req.user.tid, req.user.sub, 'rentman.push_customers', 'integration', null, { sent, failed });
        return { sent, failed };
      });
      return out;
    } catch (e) {
      return fail(reply, e);
    }
  });

  // Create or update one customer in Rentman.
  app.post('/api/customers/:id/rentman', { preHandler: mgr }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    try {
      return await withTenant(req.user.tid, async (c) => {
        const token = await getToken(c);
        if (!token) throw new RentmanError('Connect Rentman first (Integrations page).', 409);
        const rid = await pushCustomer(c, token, id);
        await audit(c, req.user.tid, req.user.sub, 'rentman.push_customer', 'customer', id, { rid });
        return { rentmanContactId: rid };
      });
    } catch (e) {
      return fail(reply, e);
    }
  });

  // The Rentman project and equipment linked to an event.
  const view = async (c: any, eventId: string, isAdmin: boolean) => {
    const ev = (await c.query('SELECT rentman_project_id, rentman_request_id, rentman_request_status, rentman_pushed_at FROM events WHERE id = $1', [eventId])).rows[0];
    if (!ev) return undefined;
    const request = ev.rentman_request_id ? { id: ev.rentman_request_id, status: ev.rentman_request_status ?? 'open', pushedAt: ev.rentman_pushed_at } : null;
    if (!ev.rentman_project_id) return { linked: false, connected: !!(await getToken(c)), request };
    const project = (await c.query('SELECT * FROM rentman_projects WHERE id = $1', [ev.rentman_project_id])).rows[0] ?? null;
    const equipment = (await c.query('SELECT item_id, name, quantity, unit_price, is_option, period_start, period_end, remark, group_id, group_name, group_sort, parent_id FROM rentman_equipment WHERE project_id = $1 ORDER BY sort', [ev.rentman_project_id])).rows
      .map((r: any) => (isAdmin ? r : { ...r, unit_price: undefined }));
    return { linked: true, connected: !!(await getToken(c)), project, equipment, request };
  };

  app.get('/api/events/:id/rentman', { preHandler: mgr }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const out = await withTenant(req.user.tid, async (c) => {
      // An open project request is checked at most every two minutes; once accepted in Rentman, the project links itself.
      const ev = (await c.query(
        "SELECT 1 FROM events WHERE id = $1 AND rentman_request_id IS NOT NULL AND rentman_project_id IS NULL AND COALESCE(rentman_request_status, 'open') = 'open' AND (rentman_checked_at IS NULL OR rentman_checked_at < now() - interval '2 minutes')",
        [id])).rowCount;
      const token = ev ? await getToken(c) : null;
      if (token) await checkEventRequest(c, req.user.tid, token, id).catch(() => undefined);
      return view(c, id, req.user.role === 'admin');
    });
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

  // Send the event to Rentman as a project request, with its customer (created in Rentman if needed), contact, venue and dates.
  app.post('/api/events/:id/rentman/push', { preHandler: mgr }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    try {
      const out = await withTenant(req.user.tid, async (c) => {
        if (!(await c.query('SELECT 1 FROM events WHERE id = $1', [id])).rowCount) return undefined;
        const token = await getToken(c);
        if (!token) throw new RentmanError('Connect Rentman first (Integrations page).', 409);
        const r = await pushEventRequest(c, req.user.tid, token, id);
        await audit(c, req.user.tid, req.user.sub, 'rentman.push_event', 'event', id, r);
        return view(c, id, req.user.role === 'admin');
      });
      return out === undefined ? reply.code(404).send({ error: 'Event not found' }) : out;
    } catch (e) {
      return fail(reply, e);
    }
  });

  // Ask Rentman now whether the request was accepted (and link the project if so).
  app.post('/api/events/:id/rentman/check', { preHandler: mgr }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    try {
      const out = await withTenant(req.user.tid, async (c) => {
        if (!(await c.query('SELECT 1 FROM events WHERE id = $1', [id])).rowCount) return undefined;
        const token = await getToken(c);
        if (!token) throw new RentmanError('Connect Rentman first (Integrations page).', 409);
        await checkEventRequest(c, req.user.tid, token, id);
        return view(c, id, req.user.role === 'admin');
      });
      return out === undefined ? reply.code(404).send({ error: 'Event not found' }) : out;
    } catch (e) {
      return fail(reply, e);
    }
  });
}
