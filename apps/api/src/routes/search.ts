import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { guard } from '../auth';
import { withTenant } from '../db';

/**
 * One search box for the office: events, crew, customers and quotes by a few letters of a name, venue, email, phone or
 * number. HR sees events, customers and quotes (no crew contact details).
 */
export async function searchRoutes(app: FastifyInstance) {
  const office = guard('admin', 'manager', 'hr');
  app.get('/api/search', { preHandler: office }, async (req) => {
    const { q } = z.object({ q: z.string().trim().max(80) }).parse(req.query);
    if (q.length < 2) return { results: [] };
    const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    const digits = q.replace(/\D/g, '');
    return withTenant(req.user.tid, async (c) => {
      const events = (await c.query(
        `SELECT id, name, venue, client, start_date, end_date, pipeline_status, archived_at IS NOT NULL AS archived
           FROM events WHERE name ILIKE $1 OR venue ILIKE $1 OR client ILIKE $1
          ORDER BY (archived_at IS NOT NULL), abs(start_date - current_date), name LIMIT 8`, [like])).rows;
      const crew = req.user.role === 'hr' ? [] : (await c.query(
        `SELECT id, name, role, email, phone, active FROM users
          WHERE role <> 'client' AND (name ILIKE $1 OR email ILIKE $1 OR ($2 <> '' AND regexp_replace(coalesce(phone, ''), '\\D', '', 'g') LIKE '%' || $2 || '%'))
          ORDER BY active DESC, name LIMIT 8`, [like, digits.length >= 3 ? digits : ''])).rows;
      const customers = (await c.query(
        `SELECT cu.id, cu.name,
                (SELECT p.name FROM customer_contacts p WHERE p.customer_id = cu.id ORDER BY p.is_primary DESC, p.created_at LIMIT 1) AS contact_name
           FROM customers cu
          WHERE cu.name ILIKE $1 OR EXISTS (SELECT 1 FROM customer_contacts p WHERE p.customer_id = cu.id AND (p.name ILIKE $1 OR p.email ILIKE $1))
          ORDER BY cu.name LIMIT 6`, [like])).rows;
      const quotes = (await c.query(
        `SELECT q.id, q.number, q.title, q.status, cu.name AS customer_name FROM quotes q LEFT JOIN customers cu ON cu.id = q.customer_id
          WHERE q.title ILIKE $1 OR cu.name ILIKE $1 OR q.number::text = $2 ORDER BY q.number DESC LIMIT 6`, [like, digits || '-'])).rows;
      return {
        results: [
          ...events.map((e) => ({ kind: 'event', id: e.id, title: e.name, sub: [String(e.start_date).slice(0, 10), e.venue, e.client].filter(Boolean).join(' · ') + (e.archived ? ' · archived' : ''), href: `/events/${e.id}` })),
          ...crew.map((u) => ({ kind: 'person', id: u.id, title: u.name, sub: [u.role === 'manager' ? 'Labor coordinator' : u.role === 'hr' ? 'HR' : u.role === 'admin' ? 'Admin' : 'Crew', u.phone, u.active ? null : 'inactive'].filter(Boolean).join(' · '), href: `/crew/${u.id}` })),
          ...customers.map((x) => ({ kind: 'customer', id: x.id, title: x.name, sub: x.contact_name ?? 'Customer', href: `/customers/${x.id}` })),
          ...quotes.map((x) => ({ kind: 'quote', id: x.id, title: `Quote #${x.number}${x.title ? ` · ${x.title}` : ''}`, sub: [x.customer_name, x.status].filter(Boolean).join(' · '), href: `/quotes/${x.id}` })),
        ],
      };
    });
  });
}
