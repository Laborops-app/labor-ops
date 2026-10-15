import { audit } from './db';
import type { PoolClient } from 'pg';

/** A customer row with its main contact and default location folded in (what lists, quotes and the old fields expect). */
export const CUSTOMER_SQL = `
  SELECT cu.*, pc.name AS contact_name, pc.email, pc.phone, dl.address,
         (SELECT p.name FROM customers p WHERE p.id = cu.parent_id) AS parent_name,
         (SELECT count(*)::int FROM customers d WHERE d.parent_id = cu.id) AS division_count,
         (SELECT count(*)::int FROM customer_contacts x WHERE x.customer_id = cu.id) AS contact_count,
         (SELECT count(*)::int FROM customer_locations x WHERE x.customer_id = cu.id) AS location_count
    FROM customers cu
    LEFT JOIN LATERAL (SELECT name, email, phone FROM customer_contacts WHERE customer_id = cu.id ORDER BY is_primary DESC, created_at LIMIT 1) pc ON true
    LEFT JOIN LATERAL (SELECT address FROM customer_locations WHERE customer_id = cu.id ORDER BY is_default DESC, created_at LIMIT 1) dl ON true`;

export const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export async function addContact(c: PoolClient, tid: string, customerId: string, x: { name: string; title?: string | null; email?: string | null; phone?: string | null; notes?: string | null; primary?: boolean }) {
  const has = (await c.query('SELECT count(*)::int AS n FROM customer_contacts WHERE customer_id = $1', [customerId])).rows[0].n;
  const primary = x.primary ?? has === 0;
  if (primary) await c.query('UPDATE customer_contacts SET is_primary = false WHERE customer_id = $1', [customerId]);
  return (await c.query(
    'INSERT INTO customer_contacts (tenant_id, customer_id, name, title, email, phone, notes, is_primary) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
    [tid, customerId, x.name, x.title || null, x.email || null, x.phone || null, x.notes || null, primary],
  )).rows[0];
}

export async function addLocation(c: PoolClient, tid: string, customerId: string, x: { label: string; venue?: string | null; address?: string | null; notes?: string | null; isDefault?: boolean }) {
  const has = (await c.query('SELECT count(*)::int AS n FROM customer_locations WHERE customer_id = $1', [customerId])).rows[0].n;
  const def = x.isDefault ?? has === 0;
  if (def) await c.query('UPDATE customer_locations SET is_default = false WHERE customer_id = $1', [customerId]);
  return (await c.query(
    'INSERT INTO customer_locations (tenant_id, customer_id, label, venue, address, notes, is_default) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
    [tid, customerId, x.label, x.venue || null, x.address || null, x.notes || null, def],
  )).rows[0];
}

/** Set the main contact's name / email / phone, creating the contact if the customer has none. */
export async function setMainContact(c: PoolClient, tid: string, customerId: string, p: { contactName?: string | null; email?: string | null; phone?: string | null }, customerName: string) {
  if (p.contactName === undefined && p.email === undefined && p.phone === undefined) return;
  const cur = (await c.query('SELECT * FROM customer_contacts WHERE customer_id = $1 ORDER BY is_primary DESC, created_at LIMIT 1', [customerId])).rows[0];
  const pick = (v: string | null | undefined, old: string | null) => (v === undefined ? old : v || null);
  if (!cur) {
    if (p.contactName || p.email || p.phone) await addContact(c, tid, customerId, { name: p.contactName || customerName, email: p.email, phone: p.phone, primary: true });
    return;
  }
  await c.query('UPDATE customer_contacts SET name = $2, email = $3, phone = $4 WHERE id = $1', [cur.id, p.contactName === undefined ? cur.name : p.contactName || customerName, pick(p.email, cur.email), pick(p.phone, cur.phone)]);
}

export async function setMainAddress(c: PoolClient, tid: string, customerId: string, address: string | null | undefined) {
  if (address === undefined) return;
  const cur = (await c.query('SELECT * FROM customer_locations WHERE customer_id = $1 ORDER BY is_default DESC, created_at LIMIT 1', [customerId])).rows[0];
  if (cur) await c.query('UPDATE customer_locations SET address = $2 WHERE id = $1', [cur.id, address || null]);
  else if (address) await addLocation(c, tid, customerId, { label: 'Main', address, isDefault: true });
}

export type NewCustomer = {
  name: string; parentId?: string | null; contactName?: string | null; email?: string | null; phone?: string | null; address?: string | null; notes?: string | null;
};
export class CustomerError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}
/**
 * Create a customer, or a division of an existing one. A division is stored under its full name ("University of Utah – Athletics")
 * so it reads right everywhere (quotes, invoices, Rentman), and borrows the parent's main contact and address when none are given.
 */
export async function createCustomer(c: PoolClient, tid: string, by: string | null, x: NewCustomer) {
  let name = x.name.trim();
  let parent: { id: string; name: string } | null = null;
  if (x.parentId) {
    parent = (await c.query('SELECT id, name FROM customers WHERE id = $1', [x.parentId])).rows[0] ?? null;
    if (!parent) throw new CustomerError('The parent customer was not found', 404);
    if (!norm(name).startsWith(norm(parent.name))) name = `${parent.name} – ${name}`;
  }
  if ((await c.query('SELECT 1 FROM customers WHERE lower(name) = lower($1)', [name])).rowCount) throw new CustomerError(`A customer named "${name}" already exists`, 409);
  const row = (await c.query('INSERT INTO customers (tenant_id, name, notes, parent_id) VALUES ($1,$2,$3,$4) RETURNING id', [tid, name, x.notes || null, parent?.id ?? null])).rows[0];
  let contact = { contactName: x.contactName, email: x.email, phone: x.phone };
  let address = x.address;
  if (parent) {
    const pc = (await c.query('SELECT name, email, phone FROM customer_contacts WHERE customer_id = $1 ORDER BY is_primary DESC, created_at LIMIT 1', [parent.id])).rows[0];
    if (!contact.contactName && !contact.email && !contact.phone && pc) contact = { contactName: pc.name, email: pc.email, phone: pc.phone };
    if (!address) address = (await c.query('SELECT address FROM customer_locations WHERE customer_id = $1 ORDER BY is_default DESC, created_at LIMIT 1', [parent.id])).rows[0]?.address ?? null;
  }
  await setMainContact(c, tid, row.id, contact, name);
  await setMainAddress(c, tid, row.id, address);
  await audit(c, tid, by, 'customer.create', 'customer', row.id, { name, parentId: parent?.id ?? null });
  return { id: row.id as string, name };
}
