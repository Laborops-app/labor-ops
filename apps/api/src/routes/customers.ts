import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTenant, audit } from '../db';
import { guard } from '../auth';
import { CUSTOMER_SQL, CustomerError, STAGES, addContact, addLocation, createCustomer, setMainContact, setMainAddress } from '../crm';

const uuid = z.string().uuid();
const mgr = guard('admin', 'manager');
const opt = (n: number) => z.string().trim().max(n).optional().nullable();
const email = z.string().trim().email().max(200).optional().nullable().or(z.literal(''));
const body = z.object({
  name: z.string().trim().min(1).max(150),
  contactName: opt(150), email, phone: opt(50), address: opt(300), notes: z.string().trim().max(5000).optional().nullable(),
  stage: z.enum(STAGES).optional(),
});
const contactBody = z.object({ name: z.string().trim().min(1).max(150), title: opt(100), email, phone: opt(50), notes: opt(2000), primary: z.boolean().optional() });
const locationBody = z.object({ label: z.string().trim().min(1).max(100), venue: opt(200), address: opt(300), notes: opt(2000), isDefault: z.boolean().optional() });

export async function customerRoutes(app: FastifyInstance) {
  app.get('/api/customers', { preHandler: mgr }, async (req) =>
    withTenant(req.user.tid, async (c) => ({
      customers: (
        await c.query(
          `SELECT u.*, (SELECT count(*)::int FROM events e WHERE e.customer_id = u.id) AS event_count,
                  (SELECT count(*)::int FROM quotes q WHERE q.customer_id = u.id) AS quote_count,
                  (SELECT max(e.start_date) FROM events e WHERE e.customer_id = u.id) AS last_event
             FROM (${CUSTOMER_SQL}) u ORDER BY u.board_position, lower(u.name)`,
        )
      ).rows,
    })),
  );

  app.post('/api/customers', { preHandler: mgr }, async (req, reply) => {
    const b = body.extend({ parentId: uuid.nullable().optional() }).parse(req.body);
    try {
      const r = await withTenant(req.user.tid, async (c) => {
        const made = await createCustomer(c, req.user.tid, req.user.sub, b);
        return (await c.query(`SELECT * FROM (${CUSTOMER_SQL}) u WHERE u.id = $1`, [made.id])).rows[0];
      });
      return reply.code(201).send({ customer: r });
    } catch (e) {
      if (e instanceof CustomerError) return reply.code(e.status).send({ error: e.message });
      throw e;
    }
  });

  // Turn the free-text "client" names already on events into customers and link those events.
  app.post('/api/customers/import-from-events', { preHandler: mgr }, async (req) =>
    withTenant(req.user.tid, async (c) => {
      const names = (await c.query("SELECT DISTINCT ON (lower(trim(client))) trim(client) AS name FROM events WHERE customer_id IS NULL AND coalesce(trim(client), '') <> '' ORDER BY lower(trim(client)), trim(client)")).rows;
      let created = 0;
      for (const n of names) {
        const r = await c.query('INSERT INTO customers (tenant_id, name) VALUES ($1,$2) ON CONFLICT (tenant_id, lower(name)) DO NOTHING RETURNING id', [req.user.tid, n.name]);
        if (r.rowCount) created++;
      }
      const linked = (await c.query("UPDATE events e SET customer_id = u.id FROM customers u WHERE e.customer_id IS NULL AND lower(trim(e.client)) = lower(u.name)")).rowCount;
      await audit(c, req.user.tid, req.user.sub, 'customer.import', 'customer', null, { created, linked });
      return { created, linked };
    }),
  );

  app.get('/api/customers/:id', { preHandler: mgr }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const out = await withTenant(req.user.tid, async (c) => {
      const customer = (await c.query(`SELECT * FROM (${CUSTOMER_SQL}) u WHERE u.id = $1`, [id])).rows[0];
      if (!customer) return null;
      const contacts = (await c.query('SELECT * FROM customer_contacts WHERE customer_id = $1 ORDER BY is_primary DESC, lower(name)', [id])).rows;
      const locations = (await c.query('SELECT * FROM customer_locations WHERE customer_id = $1 ORDER BY is_default DESC, lower(label)', [id])).rows;
      const events = (await c.query(
        `SELECT e.id, e.name, e.venue, e.start_date, e.end_date,
                (SELECT count(*)::int FROM shifts s WHERE s.event_id = e.id) AS shift_count,
                (SELECT coalesce(sum(s.headcount),0)::int FROM shifts s WHERE s.event_id = e.id) AS slots
           FROM events e WHERE e.customer_id = $1 ORDER BY e.start_date DESC`, [id])).rows;
      const quotes = (await c.query(
        `SELECT q.id, q.number, q.title, q.status, q.created_at,
                (SELECT coalesce(sum(l.qty*l.hours*l.rate),0) FROM quote_lines l WHERE l.quote_id = q.id) AS subtotal, q.discount, q.tax_pct
           FROM quotes q WHERE q.customer_id = $1 ORDER BY q.number DESC`, [id])).rows
        .map((q) => ({ ...q, total: Math.round(((Number(q.subtotal) - Number(q.discount)) * (1 + Number(q.tax_pct) / 100)) * 100) / 100 }));
      const divisions = (await c.query(`SELECT id, name, (SELECT count(*)::int FROM events e WHERE e.customer_id = d.id) AS event_count FROM customers d WHERE d.parent_id = $1 ORDER BY lower(name)`, [id])).rows;
      return { customer, contacts, locations, events, quotes, divisions };
    });
    return out ?? reply.code(404).send({ error: 'Customer not found' });
  });

  app.patch('/api/customers/:id', { preHandler: mgr }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = body.partial().extend({ parentId: uuid.nullable().optional(), position: z.number().finite().optional() }).parse(req.body);
    const r = await withTenant(req.user.tid, async (c) => {
      const cur = (await c.query('SELECT * FROM customers WHERE id = $1', [id])).rows[0];
      if (!cur) return { code: 404, error: 'Customer not found' };
      // Moving a card on the Customers board: a new stage and/or a spot in the column.
      if (b.stage !== undefined || b.position !== undefined) {
        const stage = b.stage ?? cur.stage;
        const pos = b.position ?? (stage === cur.stage ? cur.board_position : (await c.query('SELECT COALESCE(min(board_position), 1) - 1 AS p FROM customers WHERE stage = $1', [stage])).rows[0].p);
        await c.query('UPDATE customers SET stage = $2, board_position = $3 WHERE id = $1', [id, stage, pos]);
        if (stage !== cur.stage) await audit(c, req.user.tid, req.user.sub, 'customer.stage', 'customer', id, { from: cur.stage, to: stage });
      }
      if (b.parentId !== undefined) {
        // A customer cannot sit under itself or under one of its own divisions.
        const loop = b.parentId && (await c.query(
          `WITH RECURSIVE up AS (SELECT id, parent_id FROM customers WHERE id = $1 UNION ALL SELECT p.id, p.parent_id FROM customers p JOIN up ON p.id = up.parent_id) SELECT 1 FROM up WHERE id = $2`,
          [b.parentId, id])).rowCount;
        if (loop) return { code: 400, error: 'A customer cannot be a division of itself or of one of its own divisions' };
        if (b.parentId && !(await c.query('SELECT 1 FROM customers WHERE id = $1', [b.parentId])).rowCount) return { code: 404, error: 'Parent customer not found' };
        await c.query('UPDATE customers SET parent_id = $2 WHERE id = $1', [id, b.parentId]);
      }
      if (b.name && (await c.query('SELECT 1 FROM customers WHERE lower(name) = lower($1) AND id <> $2', [b.name, id])).rowCount) return { code: 409, error: 'A customer with that name already exists' };
      const name = b.name ?? cur.name;
      const onlyBoard = Object.keys(b).every((k) => k === 'stage' || k === 'position');
      if (!onlyBoard) {
        await c.query('UPDATE customers SET name = $2, notes = $3 WHERE id = $1', [id, name, b.notes === undefined ? cur.notes : b.notes || null]);
        await setMainContact(c, req.user.tid, id, b, name);
        await setMainAddress(c, req.user.tid, id, b.address);
        if (b.name && b.name !== cur.name) await c.query('UPDATE events SET client = $2 WHERE customer_id = $1', [id, b.name]);
        await audit(c, req.user.tid, req.user.sub, 'customer.update', 'customer', id, b);
      }
      return { code: 200, customer: (await c.query(`SELECT * FROM (${CUSTOMER_SQL}) u WHERE u.id = $1`, [id])).rows[0] };
    });
    const { code, ...rest } = r as { code: number; [k: string]: unknown };
    return reply.code(code).send(rest);
  });

  // ---- several contacts per customer ----
  app.post('/api/customers/:id/contacts', { preHandler: mgr }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = contactBody.parse(req.body);
    const row = await withTenant(req.user.tid, async (c) => {
      if (!(await c.query('SELECT 1 FROM customers WHERE id = $1', [id])).rowCount) return null;
      return addContact(c, req.user.tid, id, b);
    });
    return row ? reply.code(201).send({ contact: row }) : reply.code(404).send({ error: 'Customer not found' });
  });
  app.patch('/api/customer-contacts/:id', { preHandler: mgr }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = contactBody.partial().parse(req.body);
    const row = await withTenant(req.user.tid, async (c) => {
      const cur = (await c.query('SELECT * FROM customer_contacts WHERE id = $1', [id])).rows[0];
      if (!cur) return null;
      if (b.primary) await c.query('UPDATE customer_contacts SET is_primary = false WHERE customer_id = $1', [cur.customer_id]);
      const pick = (v: string | null | undefined, old: string | null) => (v === undefined ? old : v || null);
      return (await c.query(
        'UPDATE customer_contacts SET name=$2, title=$3, email=$4, phone=$5, notes=$6, is_primary=$7 WHERE id=$1 RETURNING *',
        [id, b.name ?? cur.name, pick(b.title, cur.title), pick(b.email, cur.email), pick(b.phone, cur.phone), pick(b.notes, cur.notes), b.primary ?? cur.is_primary],
      )).rows[0];
    });
    return row ? { contact: row } : reply.code(404).send({ error: 'Contact not found' });
  });
  app.delete('/api/customer-contacts/:id', { preHandler: mgr }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const n = await withTenant(req.user.tid, async (c) => {
      const r = await c.query('DELETE FROM customer_contacts WHERE id = $1 RETURNING customer_id, is_primary', [id]);
      // Keep a main contact: promote the oldest remaining one.
      if (r.rows[0]?.is_primary) await c.query('UPDATE customer_contacts SET is_primary = true WHERE id = (SELECT id FROM customer_contacts WHERE customer_id = $1 ORDER BY created_at LIMIT 1)', [r.rows[0].customer_id]);
      return r.rowCount;
    });
    return n ? { ok: true } : reply.code(404).send({ error: 'Contact not found' });
  });

  // ---- several locations per customer (offices, venues they use) ----
  app.post('/api/customers/:id/locations', { preHandler: mgr }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = locationBody.parse(req.body);
    const row = await withTenant(req.user.tid, async (c) => {
      if (!(await c.query('SELECT 1 FROM customers WHERE id = $1', [id])).rowCount) return null;
      return addLocation(c, req.user.tid, id, b);
    });
    return row ? reply.code(201).send({ location: row }) : reply.code(404).send({ error: 'Customer not found' });
  });
  app.patch('/api/customer-locations/:id', { preHandler: mgr }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = locationBody.partial().parse(req.body);
    const row = await withTenant(req.user.tid, async (c) => {
      const cur = (await c.query('SELECT * FROM customer_locations WHERE id = $1', [id])).rows[0];
      if (!cur) return null;
      if (b.isDefault) await c.query('UPDATE customer_locations SET is_default = false WHERE customer_id = $1', [cur.customer_id]);
      const pick = (v: string | null | undefined, old: string | null) => (v === undefined ? old : v || null);
      return (await c.query(
        'UPDATE customer_locations SET label=$2, venue=$3, address=$4, notes=$5, is_default=$6 WHERE id=$1 RETURNING *',
        [id, b.label ?? cur.label, pick(b.venue, cur.venue), pick(b.address, cur.address), pick(b.notes, cur.notes), b.isDefault ?? cur.is_default],
      )).rows[0];
    });
    return row ? { location: row } : reply.code(404).send({ error: 'Location not found' });
  });
  app.delete('/api/customer-locations/:id', { preHandler: mgr }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const n = await withTenant(req.user.tid, async (c) => {
      const r = await c.query('DELETE FROM customer_locations WHERE id = $1 RETURNING customer_id, is_default', [id]);
      if (r.rows[0]?.is_default) await c.query('UPDATE customer_locations SET is_default = true WHERE id = (SELECT id FROM customer_locations WHERE customer_id = $1 ORDER BY created_at LIMIT 1)', [r.rows[0].customer_id]);
      return r.rowCount;
    });
    return n ? { ok: true } : reply.code(404).send({ error: 'Location not found' });
  });

  app.delete('/api/customers/:id', { preHandler: mgr }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const n = await withTenant(req.user.tid, async (c) => {
      const r = await c.query('DELETE FROM customers WHERE id = $1', [id]);
      if (r.rowCount) await audit(c, req.user.tid, req.user.sub, 'customer.delete', 'customer', id);
      return r.rowCount;
    });
    return n ? { ok: true } : reply.code(404).send({ error: 'Customer not found' });
  });

  // Copy a past event into a new one, moved to a new start date. Shifts, phases and clock-in settings come along (crew do not).
  app.post('/api/events/:id/copy', { preHandler: mgr }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({
      name: z.string().trim().min(1).max(150), startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      includePhases: z.boolean().default(true), includeShifts: z.boolean().default(true), customerId: uuid.nullable().optional(),
    }).parse(req.body);
    const out = await withTenant(req.user.tid, async (c) => {
      const old = (await c.query("SELECT *, to_char(start_date,'YYYY-MM-DD') AS sd FROM events WHERE id = $1", [id])).rows[0];
      if (!old) return null;
      const off = Math.round((Date.UTC(+b.startDate.slice(0, 4), +b.startDate.slice(5, 7) - 1, +b.startDate.slice(8, 10)) - Date.UTC(+old.sd.slice(0, 4), +old.sd.slice(5, 7) - 1, +old.sd.slice(8, 10))) / 86400000);
      const customerId = b.customerId === undefined ? old.customer_id : b.customerId;
      const cust = customerId ? (await c.query('SELECT name FROM customers WHERE id = $1', [customerId])).rows[0] : null;
      const ev = (await c.query(
        `INSERT INTO events (tenant_id, name, client, customer_id, venue, address, start_date, end_date, notes, created_by, clock_mode, geo_lat, geo_lng, geofence_m, ot_after, state)
         VALUES ($1,$2,$3,$4,$5,$6, $7::date, ($8::date + ($9::int)), $10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
        [req.user.tid, b.name, cust?.name ?? old.client, cust ? customerId : old.customer_id, old.venue, old.address, b.startDate, old.end_date, off, old.notes, req.user.sub, old.clock_mode, old.geo_lat, old.geo_lng, old.geofence_m, old.ot_after, old.state],
      )).rows[0];
      const tz = (await c.query('SELECT timezone FROM tenants LIMIT 1')).rows[0].timezone;
      const phaseMap = new Map<string, string>();
      let phases = 0, shifts = 0;
      if (b.includePhases) {
        for (const p of (await c.query('SELECT * FROM event_phases WHERE event_id = $1 ORDER BY starts_on, created_at', [id])).rows) {
          const np = (await c.query('INSERT INTO event_phases (tenant_id, event_id, label, starts_on, ends_on) VALUES ($1,$2,$3, $4::date + $6::int, $5::date + $6::int) RETURNING id',
            [req.user.tid, ev.id, p.label, p.starts_on, p.ends_on, off])).rows[0];
          phaseMap.set(p.id, np.id);
          phases++;
        }
      }
      if (b.includeShifts) {
        const shiftMap = new Map<string, string>();
        const leadLinks: [string, string][] = [];
        for (const s of (await c.query('SELECT * FROM shifts WHERE event_id = $1 ORDER BY starts_at', [id])).rows) {
          // shift by calendar days in the company time zone so the wall-clock times survive daylight saving changes
          const ns = await c.query(
            `INSERT INTO shifts (tenant_id, event_id, role_name, starts_at, ends_at, headcount, is_open, required_certs, phase_id, pay_type)
             VALUES ($1,$2,$3, (($4::timestamptz AT TIME ZONE $9) + make_interval(days => $10)) AT TIME ZONE $9, (($5::timestamptz AT TIME ZONE $9) + make_interval(days => $10)) AT TIME ZONE $9, $6,$7,$8, $11, $12) RETURNING id`,
            [req.user.tid, ev.id, s.role_name, s.starts_at, s.ends_at, s.headcount, false, s.required_certs, tz, off, s.phase_id ? phaseMap.get(s.phase_id) ?? null : null, s.pay_type],
          );
          shiftMap.set(s.id, ns.rows[0].id);
          if (s.lead_shift_id) leadLinks.push([s.id, s.lead_shift_id]);
          shifts++;
        }
        // Keep which crew shifts each lead shift leads.
        for (const [crewShift, leadShift] of leadLinks)
          if (shiftMap.get(leadShift)) await c.query('UPDATE shifts SET lead_shift_id = $2 WHERE id = $1', [shiftMap.get(crewShift), shiftMap.get(leadShift)]);
      }
      if (phases) {
        // the event's dates follow its phases
        await c.query('UPDATE events SET start_date = (SELECT min(starts_on) FROM event_phases WHERE event_id = $1), end_date = (SELECT max(ends_on) FROM event_phases WHERE event_id = $1) WHERE id = $1', [ev.id]);
      }
      await audit(c, req.user.tid, req.user.sub, 'event.copy', 'event', ev.id, { from: id, phases, shifts, offsetDays: off });
      return { event: ev, phases, shifts, offsetDays: off };
    });
    return out ? reply.code(201).send(out) : reply.code(404).send({ error: 'Event not found' });
  });
}
