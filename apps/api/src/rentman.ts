import type { PoolClient } from 'pg';
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

/** Pull every project into the local cache. Customer / venue names are resolved from Rentman contacts. */
export async function syncProjects(c: PoolClient, tid: string, token: string) {
  const [projects, contacts] = await Promise.all([
    getAll(token, '/projects'),
    getAll(token, '/contacts', { fields: 'id,displayname' }).catch(() => [] as any[]),
  ]);
  const names = new Map<number, string>(contacts.map((x: any) => [Number(x.id), String(x.displayname ?? '')]));
  const nm = (v: unknown) => names.get(refId(v) ?? -1) ?? null;
  for (const p of projects) {
    await c.query(
      `INSERT INTO rentman_projects (tenant_id, id, number, name, customer, location, reference, project_type, tags, planperiod_start, planperiod_end,
         usageperiod_start, usageperiod_end, equipment_period_from, equipment_period_to, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, now())
       ON CONFLICT (tenant_id, id) DO UPDATE SET number=$3, name=$4, customer=$5, location=$6, reference=$7, project_type=$8, tags=$9, planperiod_start=$10,
         planperiod_end=$11, usageperiod_start=$12, usageperiod_end=$13, equipment_period_from=$14, equipment_period_to=$15, synced_at=now()`,
      [tid, p.id, p.number ?? null, String(p.displayname || p.name || `Project ${p.id}`), nm(p.customer), nm(p.location), p.reference || null, p.project_type || null, p.tags || null,
       ts(p.planperiod_start), ts(p.planperiod_end), ts(p.usageperiod_start), ts(p.usageperiod_end), ts(p.equipment_period_from), ts(p.equipment_period_to)],
    );
  }
  return projects.length;
}

/** Replace the cached equipment list of one project with what Rentman has now. */
export async function syncEquipment(c: PoolClient, tid: string, token: string, projectId: number) {
  const rows = await getAll(token, `/projects/${projectId}/projectequipment`);
  await c.query('DELETE FROM rentman_equipment WHERE project_id = $1', [projectId]);
  let n = 0;
  for (const r of rows) {
    await c.query(
      `INSERT INTO rentman_equipment (tenant_id, project_id, item_id, name, quantity, unit_price, is_option, period_start, period_end, remark, sort)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
      [tid, projectId, r.id, String(r.displayname || r.name || 'Equipment'), r.quantity_total ?? r.quantity ?? null, r.unit_price ?? null, !!r.is_option,
       ts(r.planperiod_start), ts(r.planperiod_end), r.external_remark || null, n++],
    );
  }
  return rows.length;
}
