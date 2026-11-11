import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTenant, audit } from '../db';
import { guard } from '../auth';
import { checkEventRequest, checkOpenRequests, clearToken, getToken, projectQuotes, pushCustomer, pushEventRequest, RentmanError, saveToken, syncEquipment, testToken } from '../rentman';
import { importRentmanQuote } from '../quoteCompare';
import { loadPipelineSettings, pullRentman, savePipelineSettings } from '../rentmanPipeline';
import { buildFromRentman, keepConflict } from '../rentmanBuild';

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
      return { connected: !!(await getToken(c)), projects: s.n, lastSync: s.last, pipeline: await loadPipelineSettings(c) };
    }),
  );

  // New Rentman projects become events in the pipeline (every 30 minutes and on each sync), from a date on.
  app.put('/api/rentman/pipeline', { preHandler: adm }, async (req) => {
    const b = z
      .object({ autoEvents: z.boolean(), fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(), skipCanceled: z.boolean().default(true), buildShifts: z.boolean().default(true) })
      .parse(req.body);
    return withTenant(req.user.tid, async (c) => {
      // Turning it on starts from today unless a date is given, so years of old projects don't flood the pipeline.
      const fromDate = b.fromDate ?? (b.autoEvents ? (await c.query("SELECT to_char((now() AT TIME ZONE timezone)::date, 'YYYY-MM-DD') AS d FROM tenants LIMIT 1")).rows[0].d : null);
      await savePipelineSettings(c, req.user.tid, req.user.sub, { autoEvents: b.autoEvents, fromDate, skipCanceled: b.skipCanceled, buildShifts: b.buildShifts });
      await audit(c, req.user.tid, req.user.sub, 'rentman.pipeline', 'integration', null, { ...b, fromDate });
      return { pipeline: await loadPipelineSettings(c) };
    });
  });

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
        const r = await pullRentman(c, req.user.tid, token);
        await audit(c, req.user.tid, req.user.sub, 'rentman.sync', 'integration', null, { projects: r.projects, customers: r.customers, linked: r.linked, pipeline: r.pipeline });
        return r;
      });
      return { synced: n.projects, customers: n.customers, requestsLinked: n.linked, pipeline: n.pipeline };
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
        await audit(c, req.user.tid, req.user.sub, 'rentman.push_event', 'event', id, { requestId: r.requestId, contactId: r.contactId });
        const v = await view(c, id, req.user.role === 'admin');
        return r.contactWarning ? { ...v, warning: `The project request was sent, but the customer could not be saved as a Rentman contact: ${r.contactWarning}` } : v;
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

  // ---------- quotes ----------
  // The Rentman quotes of the project this event is linked to, and which of them are already pulled in.
  app.get('/api/events/:id/rentman/quotes', { preHandler: mgr }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    try {
      return await withTenant(req.user.tid, async (c) => {
        const ev = (await c.query('SELECT rentman_project_id FROM events WHERE id = $1', [id])).rows[0];
        if (!ev) throw new RentmanError('Event not found', 404);
        if (!ev.rentman_project_id) throw new RentmanError('Link this event to a Rentman project first (Rentman, on the event page).', 409);
        const token = await getToken(c);
        if (!token) throw new RentmanError('Connect Rentman first (Integrations page).', 409);
        const list = await projectQuotes(token, Number(ev.rentman_project_id));
        const have = new Map(
          (await c.query('SELECT id, rentman_quote_id, rentman_version, status, imported_at FROM quotes WHERE rentman_quote_id = ANY($1::int[])', [list.map((q) => q.id)])).rows.map((r) => [r.rentman_quote_id as number, r]),
        );
        return {
          project: Number(ev.rentman_project_id),
          quotes: list.map((q) => {
            const h = have.get(q.id);
            return { ...q, imported: h ? { id: h.id, version: h.rentman_version, status: h.status, at: h.imported_at } : null };
          }),
        };
      });
    } catch (e) {
      return fail(reply, e);
    }
  });

  // Pull one in (again): a read-only copy on the event, used to check the invoice against.
  app.post('/api/events/:id/rentman/quotes/:quoteId/import', { preHandler: mgr }, async (req, reply) => {
    const p = z.object({ id: uuid, quoteId: z.coerce.number().int().positive() }).parse(req.params);
    const b = z.object({ accepted: z.boolean().default(true) }).parse(req.body ?? {});
    try {
      const out = await withTenant(req.user.tid, async (c) => {
        const token = await getToken(c);
        if (!token) throw new RentmanError('Connect Rentman first (Integrations page).', 409);
        return importRentmanQuote(c, req.user.tid, req.user.sub, p.id, token, p.quoteId, b.accepted);
      });
      return reply.code(out.updated ? 200 : 201).send(out);
    } catch (e) {
      return fail(reply, e);
    }
  });

  // ---------- days and shifts from Rentman's crew and transport ----------
  const buildOut = async (c: any, tid: string, by: string, id: string, apply: boolean) => {
    const token = await getToken(c);
    if (!token) throw new RentmanError('Connect Rentman first (Integrations page).', 409);
    const r = await buildFromRentman(c, tid, by, id, token, { apply });
    const built = (await c.query('SELECT rentman_build FROM events WHERE id = $1', [id])).rows[0]?.rentman_build ?? false;
    return {
      built,
      result: r.result,
      unmatched: r.unmatched,
      unscheduled: r.unscheduled,
      adds: r.plan.adds.map((w) => ({ key: w.key, role: w.role, start: w.start, end: w.end, headcount: w.headcount, group: w.group })),
      updates: r.plan.updates.map((u) => ({ shiftId: u.shiftId, role: u.want.role, start: u.want.start, end: u.want.end, headcount: u.want.headcount, headcountOnly: u.headcountOnly })),
      removes: r.plan.removes,
      conflicts: r.plan.conflicts,
      unchanged: r.plan.unchanged,
    };
  };
  // What building (or re-syncing) would do, without changing anything.
  app.get('/api/events/:id/rentman/build', { preHandler: mgr }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    try {
      return await withTenant(req.user.tid, (c) => buildOut(c, req.user.tid, req.user.sub, id, false));
    } catch (e) {
      return fail(reply, e);
    }
  });
  // Build: days, groups and shifts from Rentman; kept in step from now on (safe changes only).
  app.post('/api/events/:id/rentman/build', { preHandler: mgr }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    try {
      return await withTenant(req.user.tid, (c) => buildOut(c, req.user.tid, req.user.sub, id, true));
    } catch (e) {
      return fail(reply, e);
    }
  });
  // Stop keeping this event in step with Rentman (its shifts stay).
  app.delete('/api/events/:id/rentman/build', { preHandler: mgr }, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    return withTenant(req.user.tid, async (c) => {
      await c.query('UPDATE events SET rentman_build = false WHERE id = $1', [id]);
      await audit(c, req.user.tid, req.user.sub, 'event.rentman_build_off', 'event', id);
      return { ok: true };
    });
  });
  // A change a coordinator handled: keep the shift as it is here (for a removed one: keep it as an ordinary shift).
  app.post('/api/events/:id/rentman/build/keep', { preHandler: mgr }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ key: z.string().min(1).max(40), hash: z.string().max(400).nullable() }).parse(req.body);
    const n = await withTenant(req.user.tid, async (c) => {
      const n = await keepConflict(c, id, b.key, b.hash);
      if (n) await audit(c, req.user.tid, req.user.sub, 'event.rentman_keep', 'event', id, b);
      return n;
    });
    return n ? { ok: true } : reply.code(404).send({ error: 'Shift not found' });
  });

  // Rentman function names and the LaborOps role each one becomes.
  app.get('/api/rentman/role-map', { preHandler: mgr }, async (req) =>
    withTenant(req.user.tid, async (c) => ({
      map: (await c.query('SELECT rentman_name, role_name FROM rentman_role_map ORDER BY role_name IS NOT NULL, rentman_name')).rows,
      roles: (await c.query('SELECT name FROM skills WHERE active ORDER BY lower(name)')).rows.map((r) => r.name),
    })),
  );
  app.put('/api/rentman/role-map', { preHandler: mgr }, async (req) => {
    const b = z.object({ rentmanName: z.string().trim().min(1).max(200), roleName: z.string().trim().min(1).max(100).nullable() }).parse(req.body);
    return withTenant(req.user.tid, async (c) => {
      await c.query(
        `INSERT INTO rentman_role_map (tenant_id, rentman_name, role_name) VALUES ($1, lower(regexp_replace(trim($2), '\\s+', ' ', 'g')), $3)
         ON CONFLICT (tenant_id, rentman_name) DO UPDATE SET role_name = $3, updated_at = now()`,
        [req.user.tid, b.rentmanName, b.roleName],
      );
      await audit(c, req.user.tid, req.user.sub, 'rentman.role_map', 'integration', null, b);
      return { ok: true };
    });
  });
}
