import type { PoolClient } from 'pg';

/** A customer row with its main contact and default location folded in (what lists, quotes and the old fields expect). */
export const CUSTOMER_SQL = `
  SELECT cu.*, pc.name AS contact_name, pc.email, pc.phone, dl.address,
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
