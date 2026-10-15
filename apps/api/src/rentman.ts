import type { PoolClient } from 'pg';
import { addContact, addLocation, norm } from './crm';
import { decrypt, encrypt } from './crypto';

const BASE = 'https://api.rentman.net';

export class RentmanError extends Error {
  constructor(message: string, public status = 502) {
    super(message);
  }
}

// ---------- stored token (encrypted per company, like the other integrations) ----------
export async function getToken(c: PoolClient): Promise<string | null> {
  const r = (await c.query("SELECT config_enc FROM integration_settings WHERE provider = 'rentman'")).rows[0];
  if (!r) return null;
  try {
    return (JSON.parse(decrypt(r.config_enc)).token as string) || null;
  } catch {
    return null;
  }
}
export async function saveToken(c: PoolClient, tid: string, userId: string, token: string) {
  await c.query(
    `INSERT INTO integration_settings (tenant_id, provider, config_enc, updated_by) VALUES ($1,'rentman',$2,$3)
     ON CONFLICT (tenant_id, provider) DO UPDATE SET config_enc = EXCLUDED.config_enc, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [tid, encrypt(JSON.stringify({ token })), userId],
  );
}
export const clearToken = (c: PoolClient) => c.query("DELETE FROM integration_settings WHERE provider = 'rentman'");

// ---------- API client ----------
async function get(token: string, path: string, params: Record<string, string | number> = {}): Promise<any> {
  const url = path.startsWith('http') ? path : `${BASE}${path}?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  } catch {
    throw new RentmanError('Could not reach Rentman. Try again in a moment.');
  }
  if (res.status === 401) throw new RentmanError('Rentman rejected the API token. Check it and save again.', 400);
  if (res.status === 403) throw new RentmanError('Rentman refused the request (permission or rate limit). Wait a minute and try again.', 429);
  if (res.status === 404) throw new RentmanError('Not found in Rentman.', 404);
  if (!res.ok) throw new RentmanError(`Rentman returned an error (${res.status}).`);
  return res.json();
}

/** Every row of a collection, following Rentman's cursor links (or offsets when there is no cursor). */
async function getAll(token: string, path: string, params: Record<string, string | number> = {}, max = 40): Promise<any[]> {
  const limit = 1000;
  const out: any[] = [];
  let next: string | null = null;
  for (let page = 0; page < max; page++) {
    const j: any = await get(token, next ?? path, next ? {} : { ...params, limit, offset: out.length });
    const rows = Array.isArray(j?.data) ? j.data : [];
    out.push(...rows);
    next = j?.next_page_url ?? null;
    if (!next && rows.length < limit) break;
    if (!rows.length) break;
  }
  return out;
}

export const testToken = async (token: string) => { await get(token, '/projects', { limit: 1 }); };

const refId = (v: unknown): number | null => {
  const m = /(\d+)\/?$/.exec(String(v ?? ''));
  return m ? Number(m[1]) : null;
};
const ts = (v: unknown) => (v ? String(v) : null);

const text = (...v: unknown[]) => v.map((x) => String(x ?? '').trim()).find(Boolean) ?? null;

/** Rentman spreads an address over several fields; join the ones present into one line. */
function addressOf(x: any): string | null {
  const line = (pre: string) => {
    const street = [x[`${pre}_street`], x[`${pre}_number`]].map((v) => String(v ?? '').trim()).filter(Boolean).join(' ');
    const city = [x[`${pre}_postalcode`], x[`${pre}_city`]].map((v) => String(v ?? '').trim()).filter(Boolean).join(' ');
    return [street, city, text(x[`${pre}_country`])].filter(Boolean).join(', ');
  };
  return line('visit') || line('mailing') || text(x.address) || null;
}
const contactRow = (x: any) => ({
  id: Number(x.id),
  name: String(text(x.displayname, x.name, [x.firstname, x.infix, x.surname].filter(Boolean).join(' ')) ?? `Contact ${x.id}`),
  email: text(x.email_1, x.email),
  phone: text(x.phone_1, x.phone, x.mobile),
  address: addressOf(x),
});

async function upsertProject(c: PoolClient, tid: string, p: any, nm: (v: unknown) => string | null) {
  await c.query(
    `INSERT INTO rentman_projects (tenant_id, id, number, name, customer, location, reference, project_type, tags, planperiod_start, planperiod_end,
       usageperiod_start, usageperiod_end, equipment_period_from, equipment_period_to, customer_id, location_id, synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, now())
     ON CONFLICT (tenant_id, id) DO UPDATE SET number=$3, name=$4, customer=$5, location=$6, reference=$7, project_type=$8, tags=$9, planperiod_start=$10,
       planperiod_end=$11, usageperiod_start=$12, usageperiod_end=$13, equipment_period_from=$14, equipment_period_to=$15, customer_id=$16, location_id=$17, synced_at=now()`,
    [tid, p.id, p.number ?? null, String(p.displayname || p.name || `Project ${p.id}`), nm(p.customer), nm(p.location), p.reference || null, p.project_type || null, p.tags || null,
     ts(p.planperiod_start), ts(p.planperiod_end), ts(p.usageperiod_start), ts(p.usageperiod_end), ts(p.equipment_period_from), ts(p.equipment_period_to), refId(p.customer), refId(p.location)],
  );
}

/** Pull every project (and the contacts they point at) into the local cache. */
export async function syncProjects(c: PoolClient, tid: string, token: string) {
  const [projects, contacts] = await Promise.all([
    getAll(token, '/projects'),
    getAll(token, '/contacts').catch(() => [] as any[]),
  ]);
  const rows = contacts.filter((x: any) => x?.id != null).map(contactRow);
  if (rows.length)
    await c.query(
      `INSERT INTO rentman_contacts (tenant_id, id, name, email, phone, address)
       SELECT $1, * FROM unnest($2::int[], $3::text[], $4::text[], $5::text[], $6::text[])
       ON CONFLICT (tenant_id, id) DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email, phone = EXCLUDED.phone, address = EXCLUDED.address`,
      [tid, rows.map((r) => r.id), rows.map((r) => r.name), rows.map((r) => r.email), rows.map((r) => r.phone), rows.map((r) => r.address)],
    );
  const names = new Map<number, string>(rows.map((r) => [r.id, r.name]));
  const nm = (v: unknown) => names.get(refId(v) ?? -1) ?? null;
  for (const p of projects) await upsertProject(c, tid, p, nm);
  return projects.length;
}

/**
 * Bring Rentman's customers (the contacts used as a project customer) into the CRM. Matches by earlier link, then by name.
 * Never overwrites what is already filled in here; it only adds what is missing (contact people, addresses).
 */
export async function pullCustomers(c: PoolClient, tid: string, token: string) {
  const ids = (await c.query('SELECT DISTINCT customer_id FROM rentman_projects WHERE customer_id IS NOT NULL')).rows.map((r) => r.customer_id as number);
  const out = { created: 0, linked: 0, contacts: 0, locations: 0 };
  if (!ids.length) return out;
  const cached = new Map<number, any>((await c.query('SELECT * FROM rentman_contacts WHERE id = ANY($1)', [ids])).rows.map((r) => [r.id, r]));
  const persons = await getAll(token, '/contactpersons').catch(() => [] as any[]);
  for (const rid of ids) {
    const rc = cached.get(rid);
    if (!rc) continue;
    let cu = (await c.query('SELECT id FROM customers WHERE rentman_contact_id = $1', [rid])).rows[0];
    if (!cu) {
      const byName = (await c.query('SELECT id FROM customers WHERE lower(name) = lower($1) AND rentman_contact_id IS NULL', [rc.name])).rows[0];
      if (byName) { cu = byName; out.linked++; }
      else {
        cu = (await c.query('INSERT INTO customers (tenant_id, name) VALUES ($1,$2) RETURNING id', [tid, rc.name])).rows[0];
        out.created++;
      }
    }
    await c.query('UPDATE customers SET rentman_contact_id = $2, rentman_synced_at = now() WHERE id = $1', [cu.id, rid]);
    const have = (await c.query('SELECT name, email FROM customer_contacts WHERE customer_id = $1', [cu.id])).rows;
    const known = (email: string | null, name: string) => have.some((h) => (email && h.email && h.email.toLowerCase() === email.toLowerCase()) || (!email && norm(h.name) === norm(name)));
    const people = [
      ...(rc.email || rc.phone ? [{ name: rc.name, title: 'Main', email: rc.email, phone: rc.phone }] : []),
      ...persons.filter((p: any) => refId(p.contact) === rid).map((p: any) => ({
        name: String(text(p.displayname, p.name, [p.firstname, p.infix, p.surname].filter(Boolean).join(' ')) ?? ''), title: text(p.function, p.title), email: text(p.email_1, p.email), phone: text(p.phone_1, p.phone, p.mobile),
      })),
    ];
    for (const pe of people) {
      if (!pe.name || known(pe.email, pe.name)) continue;
      await addContact(c, tid, cu.id, pe);
      have.push({ name: pe.name, email: pe.email });
      out.contacts++;
    }
    if (rc.address) {
      const locs = (await c.query('SELECT address FROM customer_locations WHERE customer_id = $1', [cu.id])).rows;
      if (!locs.some((l) => norm(l.address) === norm(rc.address))) {
        await addLocation(c, tid, cu.id, { label: locs.length ? 'Rentman address' : 'Main', address: rc.address });
        out.locations++;
      }
    }
  }
  return out;
}

/** The CRM customer for a Rentman contact: the linked one, one with the same name (then linked), or a new one built from the cached contact. */
export async function customerForRentman(c: PoolClient, tid: string, rentmanContactId: number): Promise<{ id: string; name: string } | null> {
  const linked = (await c.query('SELECT id, name FROM customers WHERE rentman_contact_id = $1', [rentmanContactId])).rows[0];
  if (linked) return linked;
  const rc = (await c.query('SELECT * FROM rentman_contacts WHERE id = $1', [rentmanContactId])).rows[0];
  if (!rc) return null;
  let cu = (await c.query('SELECT id, name FROM customers WHERE lower(name) = lower($1) AND rentman_contact_id IS NULL', [rc.name])).rows[0];
  if (!cu) {
    cu = (await c.query('INSERT INTO customers (tenant_id, name) VALUES ($1,$2) RETURNING id, name', [tid, rc.name])).rows[0];
    if (rc.email || rc.phone) await addContact(c, tid, cu.id, { name: rc.name, title: 'Main', email: rc.email, phone: rc.phone });
    if (rc.address) await addLocation(c, tid, cu.id, { label: 'Main', address: rc.address });
  }
  await c.query('UPDATE customers SET rentman_contact_id = $2, rentman_synced_at = now() WHERE id = $1', [cu.id, rentmanContactId]);
  return cu;
}

async function send(token: string, method: 'POST' | 'PUT', path: string, body: unknown, what = 'the customer'): Promise<any> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  } catch {
    throw new RentmanError('Could not reach Rentman. Try again in a moment.');
  }
  if (res.status === 401) throw new RentmanError('Rentman rejected the API token. Check it and save again.', 400);
  if (res.status === 403) throw new RentmanError('Rentman would not allow that. The API token may be read-only, or you hit the rate limit.', 403);
  if (!res.ok) {
    const detail = await res.json().then((j: any) => j?.message || j?.error || j?.errors?.[0]?.message).catch(() => null);
    throw new RentmanError(`Rentman could not save ${what} (${res.status})${detail ? `: ${String(detail).slice(0, 200)}` : ''}.`);
  }
  return res.json();
}

/** Create the customer in Rentman (or update the linked one). Name, email and phone of the main contact go across. */
export async function pushCustomer(c: PoolClient, token: string, customerId: string): Promise<number> {
  const cu = (await c.query(
    `SELECT cu.*, pc.email, pc.phone FROM customers cu LEFT JOIN LATERAL (SELECT email, phone FROM customer_contacts WHERE customer_id = cu.id ORDER BY is_primary DESC, created_at LIMIT 1) pc ON true WHERE cu.id = $1`, [customerId])).rows[0];
  if (!cu) throw new RentmanError('Customer not found', 404);
  const payload: Record<string, unknown> = { displayname: cu.name, name: cu.name };
  if (cu.email) payload.email_1 = cu.email;
  if (cu.phone) payload.phone_1 = cu.phone;
  let rid: number | null = cu.rentman_contact_id;
  // Already in Rentman under the same name: link to it instead of creating a duplicate.
  if (!rid) rid = (await c.query('SELECT id FROM rentman_contacts WHERE lower(name) = lower($1) ORDER BY id LIMIT 1', [cu.name])).rows[0]?.id ?? null;
  if (rid && !cu.rentman_contact_id) {
    await c.query('UPDATE customers SET rentman_contact_id = $2, rentman_synced_at = now() WHERE id = $1', [customerId, rid]);
    return rid;
  }
  if (rid) await send(token, 'PUT', `/contacts/${rid}`, payload);
  else {
    const j = await send(token, 'POST', '/contacts', payload);
    rid = Number(j?.data?.id);
    if (!rid) throw new RentmanError('Rentman did not return the new contact.');
  }
  await c.query('UPDATE customers SET rentman_contact_id = $2, rentman_synced_at = now() WHERE id = $1', [customerId, rid]);
  await c.query(
    `INSERT INTO rentman_contacts (tenant_id, id, name, email, phone) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (tenant_id, id) DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email, phone = EXCLUDED.phone`, [cu.tenant_id, rid, cu.name, cu.email, cu.phone]);
  return rid;
}

/** Replace the cached equipment list of one project with what Rentman has now. */
export async function syncEquipment(c: PoolClient, tid: string, token: string, projectId: number) {
  const rows = await getAll(token, `/projects/${projectId}/projectequipment`, { sort: 'order' });
  // The project's equipment groups (Audio, Lighting, ...). If they cannot be read the list is simply not grouped.
  const groups = new Map<number, { name: string; sort: number }>();
  (await getAll(token, `/projects/${projectId}/projectequipmentgroup`).catch(() => [] as any[])).forEach((g: any, i: number) =>
    groups.set(Number(g.id), { name: String(g.displayname || g.name || 'Group'), sort: Number.isFinite(Number(g.order)) ? Number(g.order) : i }));
  await c.query('DELETE FROM rentman_equipment WHERE project_id = $1', [projectId]);
  let n = 0;
  for (const r of rows) {
    const gid = refId(r.equipment_group);
    const g = gid !== null ? groups.get(gid) : undefined;
    await c.query(
      `INSERT INTO rentman_equipment (tenant_id, project_id, item_id, name, quantity, unit_price, is_option, period_start, period_end, remark, sort, group_id, group_name, group_sort, parent_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT DO NOTHING`,
      [tid, projectId, r.id, String(r.displayname || r.name || 'Equipment'), r.quantity_total ?? r.quantity ?? null, r.unit_price ?? null, !!r.is_option,
       ts(r.planperiod_start), ts(r.planperiod_end), r.external_remark || null, n++, gid, g?.name ?? null, g?.sort ?? null, refId(r.parent)],
    );
  }
  return rows.length;
}

// ---------- sending events to Rentman ----------

/** "Dana Lee" → first "Dana", last "Lee"; one word goes in the last name, which Rentman always shows. */
function splitName(full: string | null) {
  const parts = String(full ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return {};
  if (parts.length === 1) return { contact_person_lastname: parts[0] };
  return { contact_person_first_name: parts[0], contact_person_lastname: parts.slice(1).join(' ') };
}

/**
 * Send an event to Rentman as a project request, with the customer (created or updated in Rentman first), its main contact,
 * the venue and the event's dates. Rentman lists it under Project requests; accepting it there makes the project, which is then
 * linked back to the event (see checkEventRequest). Sending again updates the open request.
 */
export async function pushEventRequest(c: PoolClient, tid: string, token: string, eventId: string) {
  const ev = (await c.query(
    `SELECT e.*, t.timezone,
            (SELECT min(s.starts_at) FROM shifts s WHERE s.event_id = e.id) AS first_shift,
            (SELECT max(s.ends_at) FROM shifts s WHERE s.event_id = e.id) AS last_shift,
            ((e.start_date + time '08:00') AT TIME ZONE t.timezone) AS day_start,
            ((e.end_date + time '23:00') AT TIME ZONE t.timezone) AS day_end
       FROM events e JOIN tenants t ON t.id = e.tenant_id WHERE e.id = $1`, [eventId])).rows[0];
  if (!ev) throw new RentmanError('Event not found', 404);
  if (ev.rentman_project_id) throw new RentmanError('This event is already linked to a Rentman project.', 409);
  if (ev.rentman_request_id && ev.rentman_request_status && ev.rentman_request_status !== 'open')
    throw new RentmanError(`Rentman already ${ev.rentman_request_status} the request for this event.`, 409);

  let contactId: number | null = null;
  let person: { name: string | null; email: string | null; phone: string | null } = { name: null, email: null, phone: null };
  let customerName: string | null = ev.client;
  if (ev.customer_id) {
    contactId = await pushCustomer(c, token, ev.customer_id);
    const cu = (await c.query(
      `SELECT cu.name, pc.name AS person, pc.email, pc.phone FROM customers cu
         LEFT JOIN LATERAL (SELECT name, email, phone FROM customer_contacts WHERE customer_id = cu.id ORDER BY is_primary DESC, created_at LIMIT 1) pc ON true
        WHERE cu.id = $1`, [ev.customer_id])).rows[0];
    customerName = cu?.name ?? customerName;
    person = { name: cu?.person ?? null, email: cu?.email ?? null, phone: cu?.phone ?? null };
  }
  const iso = (d: Date | string) => new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const start = iso(ev.first_shift ?? ev.day_start), end = iso(ev.last_shift ?? ev.day_end);
  const body: Record<string, unknown> = {
    name: ev.name,
    planperiod_start: start,
    planperiod_end: end,
    usageperiod_start: start,
    usageperiod_end: end,
    is_paid: false,
    remark: [ev.notes, 'Sent from LaborOps.'].filter(Boolean).join('\n\n').slice(0, 4000),
  };
  if (contactId) body.linked_contact = `/contacts/${contactId}`;
  if (customerName) body.contact_name = customerName;
  if (person.phone) body.contact_phone = person.phone;
  if (person.email) body.contact_person_email = person.email;
  if (person.name && person.name !== customerName) Object.assign(body, splitName(person.name));
  if (ev.venue) body.location_name = ev.venue;
  if (ev.address) body.location_mailing_street = ev.address;

  let rid: number | null = ev.rentman_request_id;
  if (rid) await send(token, 'PUT', `/projectrequests/${rid}`, body, 'the project request');
  else {
    const j = await send(token, 'POST', '/projectrequests', body, 'the project request');
    rid = Number(j?.data?.id);
    if (!rid) throw new RentmanError('Rentman did not return the new project request.');
  }
  await c.query(
    "UPDATE events SET rentman_request_id = $2, rentman_request_status = 'open', rentman_pushed_at = now(), rentman_checked_at = now() WHERE id = $1",
    [eventId, rid],
  );
  return { requestId: rid, contactId };
}

/**
 * Look up the event's project request. When Rentman has turned it into a project, cache that project, link it to the event and
 * pull its equipment. Returns the request status.
 */
export async function checkEventRequest(c: PoolClient, tid: string, token: string, eventId: string) {
  const ev = (await c.query('SELECT rentman_request_id, rentman_project_id FROM events WHERE id = $1', [eventId])).rows[0];
  if (!ev?.rentman_request_id) return null;
  const r = (await get(token, `/projectrequests/${ev.rentman_request_id}`))?.data ?? {};
  const status = ['open', 'accepted', 'declined'].includes(r.status) ? r.status : 'open';
  const projectId = refId(r.linked_project);
  await c.query('UPDATE events SET rentman_request_status = $2, rentman_checked_at = now() WHERE id = $1', [eventId, status]);
  if (projectId && !ev.rentman_project_id) {
    const p = (await get(token, `/projects/${projectId}`))?.data;
    if (p) {
      const names = async (v: unknown) => {
        const id = refId(v);
        return id === null ? null : (await c.query('SELECT name FROM rentman_contacts WHERE id = $1', [id])).rows[0]?.name ?? null;
      };
      const [cust, loc] = [await names(p.customer), await names(p.location)];
      await upsertProject(c, tid, p, (v) => (v === p.customer ? cust : v === p.location ? loc : null));
      await c.query('UPDATE events SET rentman_project_id = $2 WHERE id = $1', [eventId, projectId]);
      await syncEquipment(c, tid, token, projectId).catch(() => undefined);
    }
  }
  return { status, projectId };
}

/** Check every open request (used by the Rentman sync). */
export async function checkOpenRequests(c: PoolClient, tid: string, token: string) {
  const open = (await c.query("SELECT id FROM events WHERE rentman_request_id IS NOT NULL AND rentman_project_id IS NULL AND COALESCE(rentman_request_status, 'open') = 'open'")).rows;
  let linked = 0;
  for (const e of open) {
    const r = await checkEventRequest(c, tid, token, e.id).catch(() => null);
    if (r?.projectId) linked++;
  }
  return linked;
}
