import type { PoolClient } from 'pg';
import { get, getAll, refId } from './rentman';
import { loadOptions } from './rentmanOptions';

/**
 * Optional Rentman details on events (each switched on under Integrations › Rentman):
 * invoices, project files, site contacts, vehicles on driver shifts, and the equipment list for leads.
 */

const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));
const day = (v: unknown) => (v ? String(v).slice(0, 10) : null);

// ---------- invoices (kept locally so pipeline cards can show them) ----------

export async function syncInvoices(c: PoolClient, tid: string, token: string, projectId: number) {
  const rows = await getAll(token, '/invoices', { project: `/projects/${projectId}` });
  const ids: number[] = [];
  for (const r of rows) {
    // Rentman's filter is a hint on some accounts; keep only this project's invoices.
    if (r.project && refId(r.project) !== projectId) continue;
    ids.push(Number(r.id));
    await c.query(
      `INSERT INTO rentman_invoices (tenant_id, id, project_id, number, subject, invoice_date, due_date, price, price_invat, paid, outstanding, is_paid, finalized, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
       ON CONFLICT (tenant_id, id) DO UPDATE SET project_id = $3, number = $4, subject = $5, invoice_date = $6, due_date = $7, price = $8, price_invat = $9,
         paid = $10, outstanding = $11, is_paid = $12, finalized = $13, synced_at = now()`,
      [tid, Number(r.id), projectId, r.number != null ? String(r.number) : null, r.subject ?? r.displayname ?? null, day(r.date), day(r.expiration),
       num(r.price), num(r.price_invat), num(r.total_paid), num(r.outstanding_balance), !!r.is_paid, !!r.finalized],
    );
  }
  await c.query('DELETE FROM rentman_invoices WHERE project_id = $1 AND NOT (id = ANY($2::int[]))', [projectId, ids]);
  return ids.length;
}

/** Every Rentman-linked event that is still coming up or recent (used by the background run). */
export async function syncAllInvoices(c: PoolClient, tid: string, token: string) {
  const { rows } = await c.query(
    "SELECT DISTINCT rentman_project_id AS p FROM events WHERE rentman_project_id IS NOT NULL AND end_date >= current_date - 120",
  );
  let n = 0;
  for (const r of rows) n += await syncInvoices(c, tid, token, Number(r.p)).catch(() => 0);
  return n;
}

export const invoicesFor = async (c: PoolClient, projectId: number) =>
  (await c.query(
    `SELECT id, number, subject, invoice_date AS date, due_date AS due, price::float, price_invat::float AS "priceInVat", paid::float, outstanding::float,
            is_paid AS "isPaid", finalized FROM rentman_invoices WHERE project_id = $1 ORDER BY invoice_date NULLS LAST, id`,
    [projectId],
  )).rows;

// ---------- live details, cached a few minutes per project ----------

const cache = new Map<string, { at: number; v: any }>();
const TTL = 5 * 60_000;
async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.v;
  const v = await fn();
  cache.set(key, { at: Date.now(), v });
  if (cache.size > 500) cache.delete(cache.keys().next().value as string);
  return v;
}
export const clearExtrasCache = () => cache.clear();

export async function projectFiles(tid: string, token: string, projectId: number, folder: string | null) {
  return cached(`${tid}:files:${projectId}:${folder ?? ''}`, async () => {
    const [files, folders] = await Promise.all([
      getAll(token, `/projects/${projectId}/files`),
      getAll(token, `/projects/${projectId}/file_folders`).catch(() => [] as any[]),
    ]);
    const names = new Map(folders.map((f: any) => [Number(f.id), String(f.name ?? f.displayname ?? '')]));
    const want = folder?.trim().toLowerCase() || null;
    return files
      .filter((f: any) => !f.classified)
      .map((f: any) => ({ id: Number(f.id), name: String(f.readable_name || f.name || f.displayname || 'File'), size: num(f.size), type: f.type ?? null, folder: names.get(refId(f.folder) ?? -1) ?? null }))
      .filter((f: any) => !want || (f.folder ?? '').toLowerCase() === want);
  });
}

/** A file's download address from Rentman (fetched fresh: Rentman's links expire). Only unclassified files of the project. */
export async function fileUrl(token: string, projectId: number, fileId: number): Promise<{ url: string; name: string } | null> {
  const f = (await get(token, `/files/${fileId}`))?.data;
  if (!f || f.classified) return null;
  // The file must belong to this project (its "item" points at the project).
  const owner = String(f.item ?? f.project ?? '');
  if (owner && !owner.endsWith(`/projects/${projectId}`)) return null;
  const url = f.url || f.proxy_url;
  return url ? { url: String(url), name: String(f.readable_name || f.name || 'file') } : null;
}

const personName = (p: any) => [p.firstname, p.middle_name, p.lastname].filter(Boolean).join(' ').trim() || p.displayname || 'Contact';
export async function siteContacts(tid: string, token: string, projectId: number) {
  return cached(`${tid}:contacts:${projectId}`, async () => {
    const p = (await get(token, `/projects/${projectId}`))?.data ?? {};
    const out: { kind: 'customer' | 'location'; name: string; function: string | null; phone: string | null; email: string | null }[] = [];
    for (const [kind, ref] of [['customer', p.cust_contact], ['location', p.loc_contact]] as const) {
      const id = refId(ref);
      if (id === null) continue;
      const cp = (await get(token, `/contactpersons/${id}`).catch(() => null))?.data;
      if (!cp) continue;
      out.push({ kind, name: personName(cp), function: cp.function || null, phone: cp.mobilephone || cp.phone || null, email: cp.email || null });
    }
    return out;
  });
}

/** Vehicles on the project, keyed by the transport function they're planned on (the same key the driver shifts carry). */
export async function projectVehicles(tid: string, token: string, projectId: number) {
  return cached(`${tid}:vehicles:${projectId}`, async () => {
    const rows = await getAll(token, `/projects/${projectId}/projectvehicles`);
    const out: { functionId: number | null; name: string; plate: string | null; seats: number | null; start: string | null; end: string | null; remark: string | null }[] = [];
    const seen = new Map<number, any>();
    for (const r of rows) {
      const vid = refId(r.vehicle);
      let v: any = vid !== null ? seen.get(vid) : null;
      if (vid !== null && !v) { v = (await get(token, `/vehicles/${vid}`).catch(() => null))?.data ?? {}; seen.set(vid, v); }
      out.push({ functionId: refId(r.function), name: String(v?.name || v?.displayname || r.displayname || 'Vehicle'), plate: v?.licenseplate || null, seats: num(v?.seats), start: r.planningperiod_start ?? null, end: r.planningperiod_end ?? null, remark: r.remark || null });
    }
    return out;
  });
}

/** The function id a shift came from ("fn:123", "fn:123:2", "123" → 123). */
export const functionOfKey = (key: string | null) => {
  const m = /(\d+)/.exec(key ?? '');
  return m ? Number(m[1]) : null;
};

// ---------- what one person may see on one event ----------

export type Viewer = { sub: string; role: string };

export async function eventExtras(c: PoolClient, tid: string, token: string, eventId: string, me: Viewer) {
  const o = await loadOptions(c);
  const ev = (await c.query('SELECT id, rentman_project_id FROM events WHERE id = $1', [eventId])).rows[0];
  if (!ev?.rentman_project_id) return null;
  const pid = Number(ev.rentman_project_id);
  const staff = ['admin', 'manager', 'hr'].includes(me.role);
  // Crew see extras only for events they're on; leads and on-site coordinators see the lead details.
  const mine = staff ? [] : (await c.query(
    `SELECT s.id, s.rentman_key, s.role_name, a.is_lead FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id
      WHERE s.event_id = $1 AND a.user_id = $2 AND a.status = 'accepted'`,
    [eventId, me.sub],
  )).rows;
  if (!staff && !mine.length) return { forbidden: true as const };
  const coordinator = !staff && ((await c.query("SELECT 'onsite_coordinator' = ANY(field_roles) AS x FROM users WHERE id = $1", [me.sub])).rows[0]?.x ?? false);
  const lead = staff || coordinator || mine.some((m) => m.is_lead);
  const warn: string[] = [];
  const safe = async <T>(what: string, fn: () => Promise<T>, empty: T): Promise<T> => {
    try { return await fn(); } catch { warn.push(`Couldn't load ${what} from Rentman just now.`); return empty; }
  };
  const out: Record<string, unknown> = { project: pid, options: { invoices: o.show_invoices && staff, files: o.show_files, contacts: o.show_contacts && lead, vehicles: o.show_vehicles, equipment: o.show_equipment_leads && lead } };

  if (o.show_invoices && staff) out.invoices = await invoicesFor(c, pid);
  if (o.show_files) out.files = await safe('the files', () => projectFiles(tid, token, pid, o.filesFolder), []);
  if (o.show_contacts && lead) out.contacts = await safe('the site contacts', () => siteContacts(tid, token, pid), []);
  if (o.show_vehicles) {
    const all = await safe('the vehicles', () => projectVehicles(tid, token, pid), []);
    const shifts = (await c.query('SELECT id, rentman_key, role_name FROM shifts WHERE event_id = $1 AND rentman_key IS NOT NULL', [eventId])).rows;
    // Staff see every driver shift's vehicle; crew only the ones on their own shifts.
    const pool = staff ? shifts : mine;
    out.vehicles = pool
      .map((s: any) => ({ shiftId: s.id, role: s.role_name, vehicles: all.filter((v) => v.functionId !== null && v.functionId === functionOfKey(s.rentman_key)) }))
      .filter((s: any) => s.vehicles.length);
  }
  if (o.show_equipment_leads && lead) {
    // Leads see the groups that match their role ("Audio lead" → the Audio group); staff, coordinators and unmatched leads see all.
    const rows = (await c.query(
      'SELECT name, quantity::float AS qty, group_name AS "group", remark, is_option AS "isOption" FROM rentman_equipment WHERE project_id = $1 AND NOT is_option ORDER BY group_sort NULLS LAST, sort',
      [pid],
    )).rows;
    let list = rows;
    if (!staff && !coordinator) {
      const words = mine.filter((m) => m.is_lead).flatMap((m) => String(m.role_name).toLowerCase().split(/[^a-z0-9]+/)).filter((w) => w.length > 2 && !['lead', 'crew', 'chief', 'head'].includes(w));
      const hit = rows.filter((r) => words.some((w) => String(r.group ?? '').toLowerCase().includes(w)));
      if (hit.length) list = hit;
    }
    out.equipment = list;
  }
  if (warn.length) out.warnings = warn;
  return out;
}
