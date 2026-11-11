import type { PoolClient } from 'pg';
import { getAll, refId } from './rentman';
import { roleKeyOf } from './pay';
import { audit } from './db';

const txt = (...v: unknown[]) => v.map((x) => String(x ?? '').trim()).find(Boolean) ?? null;
const digits = (s: string | null) => (s ?? '').replace(/\D/g, '').slice(-10);
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

// ---------- crew: Rentman's crew list matched to LaborOps people ----------

/**
 * Bring Rentman's crew list in and link each person to a LaborOps account: by email, else phone, else an exact,
 * unique name. Links made by hand are never changed. LaborOps stays the master for profiles.
 */
export async function syncCrew(c: PoolClient, tid: string, token: string) {
  const rows = await getAll(token, '/crew');
  const out = { crew: rows.length, linked: 0, unlinked: 0 };
  for (const r of rows) {
    const name = txt(r.displayname, [r.firstname, r.middle_name, r.lastname ?? r.surname].filter(Boolean).join(' '), r.name) ?? `Crew ${r.id}`;
    await c.query(
      `INSERT INTO rentman_crew (tenant_id, id, name, email, phone, active, synced_at) VALUES ($1,$2,$3,$4,$5,$6, now())
       ON CONFLICT (tenant_id, id) DO UPDATE SET name = $3, email = $4, phone = $5, active = $6, synced_at = now()`,
      [tid, Number(r.id), name, txt(r.email, r.email_1, r.email_2), txt(r.mobile, r.phone, r.phone_1, r.phone_2), r.active !== false && r.archived !== true],
    );
  }
  // Auto-link anyone not linked yet.
  const users = (await c.query("SELECT id, name, lower(email) AS email, phone FROM users WHERE active AND role IN ('crew', 'manager', 'admin', 'hr')")).rows;
  const taken = new Set((await c.query('SELECT user_id FROM rentman_crew WHERE user_id IS NOT NULL')).rows.map((r) => r.user_id as string));
  const free = (await c.query('SELECT id, name, lower(email) AS email, phone FROM rentman_crew WHERE user_id IS NULL')).rows;
  for (const r of free) {
    const pool = users.filter((u) => !taken.has(u.id));
    let hit = r.email ? pool.find((u) => u.email && u.email === r.email) : undefined;
    let by = 'email';
    if (!hit && digits(r.phone).length === 10) { hit = pool.find((u) => digits(u.phone) === digits(r.phone)); by = 'phone'; }
    if (!hit) {
      const same = pool.filter((u) => norm(u.name) === norm(r.name));
      if (same.length === 1) { hit = same[0]; by = 'name'; }
    }
    if (hit) {
      await c.query('UPDATE rentman_crew SET user_id = $2, linked_by = $3 WHERE id = $1', [r.id, hit.id, by]);
      taken.add(hit.id);
      out.linked++;
    }
  }
  out.unlinked = (await c.query('SELECT count(*)::int AS n FROM rentman_crew WHERE user_id IS NULL AND active')).rows[0].n;
  return out;
}

// ---------- rates: Rentman as the source of the roles' pay and bill rates ----------

type Factor = { from: number | null; to: number | null; variable: number; fixed: number };
/** A Rentman rate's tiers as LaborOps rates: the hourly amount, and a day rate when it starts with a flat amount. */
export function readRate(factors: Factor[]) {
  const sorted = [...factors].sort((a, b) => (a.from ?? 0) - (b.from ?? 0));
  const first = sorted[0];
  if (!first) return { hourly: 0, day: 0 };
  // "Flat for the first N hours, then hourly": the flat amount is a day rate and the next tier is the hourly.
  if (first.fixed > 0 && !first.variable) return { day: first.fixed, hourly: sorted[1]?.variable ?? 0 };
  return { hourly: first.variable || 0, day: first.fixed || 0 };
}

/**
 * Copy Rentman's crew rates onto LaborOps roles (price rates → bill rates, cost rates → pay rates), matched by name
 * (or the role names mapped under Integrations › Rentman). Those roles show "from Rentman" and their rates are locked
 * here while the option is on. Overtime stays under LaborOps' labor rules.
 */
export async function syncRates(c: PoolClient, tid: string, token: string) {
  const [rates, factors] = await Promise.all([getAll(token, '/rates'), getAll(token, '/ratefactors')]);
  const byRate = new Map<number, Factor[]>();
  for (const f of factors) {
    const rid = refId(f.rate_id ?? f.rate);
    if (rid === null) continue;
    const list = byRate.get(rid) ?? [];
    list.push({ from: f.from ?? null, to: f.to ?? null, variable: Number(f.variable) || 0, fixed: Number(f.fixed) || 0 });
    byRate.set(rid, list);
  }
  const skills = (await c.query('SELECT id, name FROM skills WHERE active')).rows as { id: string; name: string }[];
  const byKey = new Map(skills.map((s) => [roleKeyOf(s.name), s]));
  const map = new Map((await c.query('SELECT rentman_name, role_name FROM rentman_role_map WHERE role_name IS NOT NULL')).rows.map((r) => [r.rentman_name as string, r.role_name as string]));
  const out = { rates: 0, roles: 0, unmatched: [] as string[] };
  const touched = new Set<string>();
  for (const r of rates) {
    if (r.archived) continue;
    const name = String(r.name ?? r.displayname ?? '').trim();
    if (!name) continue;
    out.rates++;
    // "Stagehand rate", "Stagehand – price" → Stagehand
    const clean = name.replace(/\b(rate|price|cost|pay|hourly|day)\b/gi, '').replace(/[-–—:|]+/g, ' ').trim() || name;
    const mapped = map.get(norm(name)) ?? map.get(norm(clean));
    const skill = (mapped && skills.find((s) => s.name.toLowerCase() === mapped.toLowerCase())) || byKey.get(roleKeyOf(clean)) || byKey.get(roleKeyOf(name));
    if (!skill) {
      out.unmatched.push(name);
      await c.query('INSERT INTO rentman_role_map (tenant_id, rentman_name) VALUES ($1,$2) ON CONFLICT DO NOTHING', [tid, norm(name)]);
      continue;
    }
    const v = readRate(byRate.get(Number(r.id)) ?? []);
    const cost = String(r.type ?? '').toLowerCase() === 'cost';
    await c.query(
      cost
        ? 'UPDATE skills SET pay_rate = $2, day_rate = $3, rentman_cost_rate = $4, rates_from_rentman = true WHERE id = $1'
        : 'UPDATE skills SET bill_rate = $2, day_bill_rate = $3, rentman_price_rate = $4, rates_from_rentman = true WHERE id = $1',
      [skill.id, Math.round(v.hourly * 100) / 100, Math.round(v.day * 100) / 100, name],
    );
    touched.add(skill.id);
  }
  out.roles = touched.size;
  await c.query('UPDATE rentman_settings SET rates_last_at = now(), rates_last_result = $1', [JSON.stringify(out)]);
  if (touched.size) await audit(c, tid, null, 'rentman.rates', 'integration', null, out);
  return out;
}

/** Turning "Rentman sets the rates" off unlocks the roles (their last rates stay). */
export const unlockRates = (c: PoolClient) => c.query('UPDATE skills SET rates_from_rentman = false WHERE rates_from_rentman');
