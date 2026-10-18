import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { z } from 'zod';
import { guard, forgetUser } from '../auth';
import { pool, withTenant, audit } from '../db';
import { notifyStaff } from '../notify';
import { issueToken } from '../notify/tokens';
import { enqueueAccountEmail } from '../notify';
import { config } from '../config';

const portalOff = () => !config.clientPortal;

/**
 * Client portal. A client account belongs to one customer and sees only that customer's events (and its
 * divisions'): the schedule, who is coming, who is on site, the approved timesheets and the invoices. They can sign
 * off on (or dispute) an event's timesheets and ask for crew. No pay rates, phone numbers or crew notes.
 */
const uuid = z.string().uuid();

/** The customer and its divisions this client may see. */
async function scopeOf(c: PoolClient, customerId: string): Promise<string[]> {
  return (await c.query('SELECT id FROM customers WHERE id = $1 OR parent_id = $1', [customerId])).rows.map((r) => r.id);
}

/** A fingerprint of the approved time on an event: an approval only counts while the time is unchanged. */
export async function timeFingerprint(c: PoolClient, eventId: string): Promise<{ fp: string; hours: number; entries: number }> {
  const r = (
    await c.query(
      `SELECT COALESCE(md5(string_agg(t.id::text || '|' || t.clock_in::text || '|' || COALESCE(t.clock_out::text, ''), ',' ORDER BY t.id)), 'none') AS fp,
              COALESCE(round(sum(EXTRACT(EPOCH FROM (t.clock_out - t.clock_in)) / 3600)::numeric, 2), 0)::float AS hours, count(*)::int AS entries
         FROM time_entries t JOIN shift_assignments a ON a.id = t.assignment_id JOIN shifts s ON s.id = a.shift_id
        WHERE s.event_id = $1 AND t.status = 'approved' AND t.clock_out IS NOT NULL`,
      [eventId],
    )
  ).rows[0];
  return { fp: r.fp, hours: Number(r.hours), entries: r.entries };
}

/** Where the client's sign-off stands for an event. */
export async function clientApprovalState(c: PoolClient, eventId: string) {
  const ev = (await c.query('SELECT cu.require_client_approval AS required, cu.name AS customer FROM events e LEFT JOIN customers cu ON cu.id = e.customer_id WHERE e.id = $1', [eventId])).rows[0];
  const now = await timeFingerprint(c, eventId);
  const last = (await c.query(
    `SELECT x.status, x.note, x.fingerprint, x.hours::float AS hours, x.created_at, u.name AS by_name
       FROM client_approvals x LEFT JOIN users u ON u.id = x.user_id WHERE x.event_id = $1 ORDER BY x.created_at DESC LIMIT 1`, [eventId])).rows[0] ?? null;
  const approved = !!last && last.status === 'approved' && last.fingerprint === now.fp;
  return {
    // With the portal switched off nobody can sign off, so it is never required.
    required: !!ev?.required && config.clientPortal,
    customer: ev?.customer ?? null,
    approved,
    // Signed off earlier, but time changed since.
    stale: !!last && last.status === 'approved' && last.fingerprint !== now.fp,
    disputed: !!last && last.status === 'disputed',
    last,
    hours: now.hours,
    entries: now.entries,
  };
}

/** Error to show when invoicing must wait for the client's sign-off, else null. */
export async function invoiceBlockedByClient(c: PoolClient, eventId: string): Promise<string | null> {
  if (portalOff()) return null;
  const s = await clientApprovalState(c, eventId);
  if (!s.required || s.approved) return null;
  if (s.disputed) return `${s.customer ?? 'The client'} disputed these timesheets: “${s.last?.note ?? ''}”. Sort it out and ask them to approve again before invoicing.`;
  if (s.stale) return `Time changed after ${s.customer ?? 'the client'} approved it. They need to approve the timesheets again before you invoice.`;
  return `${s.customer ?? 'This client'} approves timesheets before invoicing. They haven’t approved this event yet.`;
}

export async function clientRoutes(app: FastifyInstance) {
  // Portal switched off: its management endpoints answer 404 (the portal itself is closed in authenticate).
  app.addHook('onRequest', async (req, reply) => {
    // (GET /api/customers/:id/portal stays: it also carries the customer's work rules, and says the portal is off.)
    const readSettings = req.method === 'GET' && /^\/api\/customers\/[^/]+\/portal$/.test(req.url.split('?')[0]);
    if (portalOff() && !readSettings && /^\/api\/(client\/|customers\/[^/]+\/portal)/.test(req.url)) return reply.code(404).send({ error: 'Not found' });
  });
  const client = guard('client');
  const staff = guard('admin', 'manager');
  const viewers = guard('admin', 'manager', 'hr');
  const idParam = z.object({ id: uuid });

  // ---------------- the portal (client accounts) ----------------
  app.get('/api/client/overview', { preHandler: client }, async (req) =>
    withTenant(req.user.tid, async (c) => {
      const scope = await scopeOf(c, req.user.customerId!);
      const company = (await c.query('SELECT name FROM tenants')).rows[0]?.name ?? '';
      const customer = (await c.query('SELECT id, name FROM customers WHERE id = $1', [req.user.customerId])).rows[0];
      const events = (
        await c.query(
          `SELECT e.id, e.name, e.venue, e.start_date::text, e.end_date::text, e.pipeline_status, cu.name AS customer, cu.require_client_approval AS needs_approval,
                  (e.requested_by IS NOT NULL) AS requested,
                  (SELECT COALESCE(sum(s.headcount), 0)::int FROM shifts s WHERE s.event_id = e.id) AS slots,
                  (SELECT count(*)::int FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id WHERE s.event_id = e.id AND a.status = 'accepted') AS confirmed,
                  (SELECT count(*)::int FROM time_entries t JOIN shift_assignments a ON a.id = t.assignment_id JOIN shifts s ON s.id = a.shift_id WHERE s.event_id = e.id AND t.clock_out IS NULL) AS on_site,
                  (SELECT count(*)::int FROM time_entries t JOIN shift_assignments a ON a.id = t.assignment_id JOIN shifts s ON s.id = a.shift_id WHERE s.event_id = e.id AND t.status = 'approved') AS approved_entries,
                  (SELECT x.status FROM client_approvals x WHERE x.event_id = e.id ORDER BY x.created_at DESC LIMIT 1) AS last_signoff,
                  (SELECT count(*)::int FROM event_invoices i WHERE i.event_id = e.id) AS invoices
             FROM events e JOIN customers cu ON cu.id = e.customer_id
            WHERE e.customer_id = ANY($1::uuid[]) AND e.end_date >= current_date - 120
            ORDER BY e.start_date DESC, e.name LIMIT 200`,
          [scope],
        )
      ).rows;
      // Approval state per event that has approved time (only where sign-off matters or was given).
      for (const e of events) {
        if (e.approved_entries > 0) {
          const st = await clientApprovalState(c, e.id);
          e.signoff = st.approved ? 'approved' : st.disputed ? 'disputed' : st.stale ? 'changed' : 'waiting';
        } else e.signoff = null;
      }
      return { company, customer, events };
    }),
  );

  const eventInScope = async (c: PoolClient, customerId: string, eventId: string) => {
    const scope = await scopeOf(c, customerId);
    return (await c.query('SELECT e.*, cu.name AS customer FROM events e JOIN customers cu ON cu.id = e.customer_id WHERE e.id = $1 AND e.customer_id = ANY($2::uuid[])', [eventId, scope])).rows[0] ?? null;
  };

  app.get('/api/client/events/:id', { preHandler: client }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const out = await withTenant(req.user.tid, async (c) => {
      const ev = await eventInScope(c, req.user.customerId!, id);
      if (!ev) return null;
      const tz = (await c.query('SELECT timezone FROM tenants')).rows[0].timezone;
      const shifts = (
        await c.query(
          `SELECT s.id, s.role_name, s.starts_at, s.ends_at, s.headcount, p.label AS phase, g.label AS group_label,
                  (SELECT count(*)::int FROM shift_assignments a WHERE a.shift_id = s.id AND a.status = 'accepted') AS confirmed
             FROM shifts s LEFT JOIN event_phases p ON p.id = s.phase_id LEFT JOIN phase_groups g ON g.id = s.group_id
            WHERE s.event_id = $1 ORDER BY s.starts_at, s.role_name`,
          [id],
        )
      ).rows;
      // Confirmed crew only, with who is on site now. Names and positions only.
      const roster = (
        await c.query(
          `SELECT a.id, u.name, s.role_name, s.starts_at, s.ends_at, a.is_lead,
                  (SELECT t.clock_in FROM time_entries t WHERE t.assignment_id = a.id AND t.clock_out IS NULL ORDER BY t.clock_in DESC LIMIT 1) AS on_site_since,
                  (SELECT max(t.clock_out) FROM time_entries t WHERE t.assignment_id = a.id) AS last_out
             FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id JOIN users u ON u.id = a.user_id
            WHERE s.event_id = $1 AND a.status = 'accepted' ORDER BY s.starts_at, s.role_name, u.name`,
          [id],
        )
      ).rows;
      const timesheet = (
        await c.query(
          `SELECT t.id, u.name, s.role_name, to_char(t.clock_in AT TIME ZONE $2, 'YYYY-MM-DD') AS date, t.clock_in, t.clock_out,
                  round((EXTRACT(EPOCH FROM (t.clock_out - t.clock_in)) / 3600)::numeric, 2)::float AS hours
             FROM time_entries t JOIN shift_assignments a ON a.id = t.assignment_id JOIN shifts s ON s.id = a.shift_id JOIN users u ON u.id = t.user_id
            WHERE s.event_id = $1 AND t.status = 'approved' AND t.clock_out IS NOT NULL ORDER BY t.clock_in, u.name`,
          [id, tz],
        )
      ).rows;
      const pendingTime = (await c.query(
        `SELECT count(*)::int AS n FROM time_entries t JOIN shift_assignments a ON a.id = t.assignment_id JOIN shifts s ON s.id = a.shift_id WHERE s.event_id = $1 AND t.status <> 'approved'`, [id])).rows[0].n;
      const history = (await c.query(
        `SELECT x.status, x.note, x.hours::float AS hours, x.created_at, u.name AS by_name FROM client_approvals x LEFT JOIN users u ON u.id = x.user_id WHERE x.event_id = $1 ORDER BY x.created_at DESC LIMIT 20`, [id])).rows;
      const invoices = (await c.query('SELECT doc_number, total::float AS total, created_at FROM event_invoices WHERE event_id = $1 ORDER BY created_at', [id])).rows;
      return {
        event: { id: ev.id, name: ev.name, customer: ev.customer, venue: ev.venue, address: ev.address, start_date: ev.start_date, end_date: ev.end_date, status: ev.pipeline_status, notes: ev.requested_by ? ev.notes : null },
        shifts, roster, timesheet, pendingTime, history, invoices,
        approval: await clientApprovalState(c, id),
      };
    });
    return out ?? reply.code(404).send({ error: 'Event not found' });
  });

  const signoff = (status: 'approved' | 'disputed') => async (req: any, reply: any) => {
    const { id } = idParam.parse(req.params);
    const b = z.object({ note: z.string().trim().max(1000).optional() }).parse(req.body ?? {});
    if (status === 'disputed' && !b.note) return reply.code(400).send({ error: 'Say what looks wrong so the team can fix it' });
    const out = await withTenant(req.user.tid, async (c) => {
      const ev = await eventInScope(c, req.user.customerId!, id);
      if (!ev) return { code: 404, error: 'Event not found' };
      const fp = await timeFingerprint(c, id);
      if (!fp.entries) return { code: 409, error: 'There is no approved time to sign off yet.' };
      await c.query('INSERT INTO client_approvals (tenant_id, event_id, user_id, status, note, fingerprint, hours) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [req.user.tid, id, req.user.sub, status, b.note || null, fp.fp, fp.hours]);
      await audit(c, req.user.tid, req.user.sub, status === 'approved' ? 'client.approve' : 'client.dispute', 'event', id, { hours: fp.hours, note: b.note ?? null });
      await notifyStaff(c, req.user.tid, {
        category: status === 'approved' ? 'approval_result' : 'approval_request',
        title: status === 'approved' ? `${ev.customer} approved timesheets: ${ev.name}` : `${ev.customer} disputed timesheets: ${ev.name}`,
        body: `${req.user.name} ${status === 'approved' ? 'signed off on' : 'questioned'} ${fp.hours} hours (${fp.entries} entries).${b.note ? `\n\n“${b.note}”` : ''}`,
        link: `/events/${id}`,
      });
      return { code: 200, approval: await clientApprovalState(c, id) };
    });
    const { code, ...rest } = out as { code: number; [k: string]: unknown };
    return reply.code(code).send(rest);
  };
  app.post('/api/client/events/:id/approve', { preHandler: client }, signoff('approved'));
  app.post('/api/client/events/:id/dispute', { preHandler: client }, signoff('disputed'));

  // Ask for crew: becomes a pending event on the labor company's pipeline, with the positions as open shifts.
  app.post('/api/client/requests', { preHandler: client, config: { rateLimit: { max: 20, timeWindow: '1 hour' } } }, async (req, reply) => {
    const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
    const b = z
      .object({
        name: z.string().trim().min(2, 'Name the event').max(150),
        venue: z.string().trim().max(200).optional(),
        address: z.string().trim().max(300).optional(),
        startDate: ymd, endDate: ymd,
        notes: z.string().trim().max(4000).optional(),
        positions: z.array(z.object({
          role: z.string().trim().min(1).max(100), count: z.number().int().min(1).max(200),
          startsAt: z.string().datetime({ offset: true }), endsAt: z.string().datetime({ offset: true }),
        })).max(50).default([]),
      })
      .refine((x) => x.endDate >= x.startDate, 'The end date is before the start date')
      .refine((x) => x.positions.every((p) => +new Date(p.endsAt) > +new Date(p.startsAt)), 'Each position must end after it starts')
      .safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: b.error.issues[0]?.message ?? 'Check the request' });
    const r = b.data;
    const ev = await withTenant(req.user.tid, async (c) => {
      const cust = (await c.query('SELECT id, name FROM customers WHERE id = $1', [req.user.customerId])).rows[0];
      const e = (await c.query(
        `INSERT INTO events (tenant_id, name, client, customer_id, venue, address, start_date, end_date, notes, created_by, requested_by, pipeline_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,'pending') RETURNING id, name`,
        [req.user.tid, r.name, cust.name, cust.id, r.venue || null, r.address || null, r.startDate, r.endDate,
          [`Requested by ${req.user.name} (${cust.name}) through the client portal.`, r.notes].filter(Boolean).join('\n\n'), req.user.sub],
      )).rows[0];
      for (const p of r.positions)
        await c.query('INSERT INTO shifts (tenant_id, event_id, role_name, starts_at, ends_at, headcount) VALUES ($1,$2,$3,$4,$5,$6)', [req.user.tid, e.id, p.role, p.startsAt, p.endsAt, p.count]);
      await audit(c, req.user.tid, req.user.sub, 'client.request', 'event', e.id, { positions: r.positions.length });
      await notifyStaff(c, req.user.tid, {
        category: 'approval_request',
        title: `Crew request from ${cust.name}: ${r.name}`,
        body: `${req.user.name} asked for crew, ${r.startDate}${r.endDate !== r.startDate ? ` to ${r.endDate}` : ''}${r.venue ? ` at ${r.venue}` : ''}.\n${r.positions.map((p) => `• ${p.count} × ${p.role}`).join('\n')}${r.notes ? `\n\n${r.notes}` : ''}`,
        link: `/events/${e.id}`,
      });
      return e;
    });
    return reply.code(201).send({ event: ev });
  });

  // Positions the client can ask for (names only).
  app.get('/api/client/positions', { preHandler: client }, async (req) =>
    withTenant(req.user.tid, async (c) => ({ positions: (await c.query('SELECT name FROM skills ORDER BY lower(name)')).rows.map((r) => r.name as string) })),
  );

  // ---------------- staff: managing a customer's portal ----------------
  app.get('/api/customers/:id/portal', { preHandler: viewers }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const out = await withTenant(req.user.tid, async (c) => {
      const cu = (await c.query('SELECT id, require_client_approval, rule_set_id FROM customers WHERE id = $1', [id])).rows[0];
      if (!cu) return null;
      if (portalOff()) return { enabled: false, requireApproval: false, ruleSetId: cu.rule_set_id, users: [], portalUrl: '' };
      const users = (await c.query("SELECT id, name, email, active, last_seen_at FROM users WHERE role = 'client' AND customer_id = $1 ORDER BY active DESC, name", [id])).rows;
      return { enabled: true, requireApproval: cu.require_client_approval, ruleSetId: cu.rule_set_id, users, portalUrl: `${config.appUrl}/client` };
    });
    return out ?? reply.code(404).send({ error: 'Customer not found' });
  });

  app.put('/api/customers/:id/portal', { preHandler: staff }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const { requireApproval } = z.object({ requireApproval: z.boolean() }).parse(req.body);
    const n = await withTenant(req.user.tid, async (c) => {
      const r = await c.query('UPDATE customers SET require_client_approval = $2 WHERE id = $1', [id, requireApproval]);
      if (r.rowCount) await audit(c, req.user.tid, req.user.sub, 'customer.client_approval', 'customer', id, { requireApproval });
      return r.rowCount;
    });
    return n ? { ok: true } : reply.code(404).send({ error: 'Customer not found' });
  });

  const sendPortalInvite = async (c: PoolClient, tid: string, u: { id: string; email: string; name: string }, customer: string) => {
    const company = (await c.query('SELECT name FROM tenants WHERE id = $1', [tid])).rows[0]?.name ?? 'your labor provider';
    const raw = await issueToken(c, tid, u.id, 'invite', 24 * 7);
    await enqueueAccountEmail(c, tid, {
      userId: u.id, to: u.email, subject: `${company} invited you to their client portal`,
      body: `Hi ${u.name.split(' ')[0]},\n\n${company} gave ${customer} access to its client portal on LaborOps. There you can see your upcoming events, who is coming and who is on site, approve timesheets, see invoices and request crew.\n\nUse the button below to choose your password. This link works for 7 days.`,
      link: `${config.appUrl}/reset?token=${raw}&invite=1`, linkLabel: 'Set my password',
    });
  };

  app.post('/api/customers/:id/portal-users', { preHandler: staff }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const b = z.object({ name: z.string().trim().min(1).max(120), email: z.string().trim().toLowerCase().email().max(200) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'Enter a name and a valid email' });
    if ((await pool.query('SELECT 1 FROM auth_find_user($1)', [b.data.email])).rowCount) return reply.code(409).send({ error: 'That email is already registered' });
    const hash = await bcrypt.hash(crypto.randomBytes(24).toString('base64url'), 10);
    const out = await withTenant(req.user.tid, async (c) => {
      const cu = (await c.query('SELECT id, name FROM customers WHERE id = $1', [id])).rows[0];
      if (!cu) return null;
      const u = (await c.query(
        "INSERT INTO users (tenant_id, email, name, role, password_hash, customer_id, notify_email) VALUES ($1,$2,$3,'client',$4,$5,true) RETURNING id, name, email, active",
        [req.user.tid, b.data.email, b.data.name, hash, id])).rows[0];
      await sendPortalInvite(c, req.user.tid, u, cu.name);
      await audit(c, req.user.tid, req.user.sub, 'client.user_create', 'user', u.id, { customerId: id });
      return u;
    });
    return out ? reply.code(201).send({ user: out }) : reply.code(404).send({ error: 'Customer not found' });
  });

  app.post('/api/customers/:id/portal-users/:userId/invite', { preHandler: staff }, async (req, reply) => {
    const { id, userId } = z.object({ id: uuid, userId: uuid }).parse(req.params);
    const ok = await withTenant(req.user.tid, async (c) => {
      const u = (await c.query("SELECT u.id, u.email, u.name, cu.name AS customer FROM users u JOIN customers cu ON cu.id = u.customer_id WHERE u.id = $1 AND u.customer_id = $2 AND u.role = 'client' AND u.active", [userId, id])).rows[0];
      if (!u) return false;
      await sendPortalInvite(c, req.user.tid, u, u.customer);
      return true;
    });
    return ok ? { ok: true } : reply.code(404).send({ error: 'Not found' });
  });

  app.delete('/api/customers/:id/portal-users/:userId', { preHandler: staff }, async (req, reply) => {
    const { id, userId } = z.object({ id: uuid, userId: uuid }).parse(req.params);
    const n = await withTenant(req.user.tid, async (c) => {
      const r = await c.query("UPDATE users SET active = false WHERE id = $1 AND customer_id = $2 AND role = 'client'", [userId, id]);
      if (r.rowCount) await audit(c, req.user.tid, req.user.sub, 'client.user_remove', 'user', userId);
      return r.rowCount;
    });
    forgetUser(userId);
    return n ? { ok: true } : reply.code(404).send({ error: 'Not found' });
  });

  // Staff view of an event's client sign-off (event page, invoice panel).
  app.get('/api/events/:id/client-approval', { preHandler: viewers }, async (req) => {
    const { id } = idParam.parse(req.params);
    return withTenant(req.user.tid, async (c) => ({
      ...(await clientApprovalState(c, id)),
      history: (await c.query(
        `SELECT x.status, x.note, x.hours::float AS hours, x.created_at, u.name AS by_name FROM client_approvals x LEFT JOIN users u ON u.id = x.user_id WHERE x.event_id = $1 ORDER BY x.created_at DESC LIMIT 20`, [id])).rows,
    }));
  });
}
