import type { PoolClient } from 'pg';
import { getAll, refId, RentmanError } from './rentman';
import { roleKeyOf } from './pay';
import { audit } from './db';
import { loadOptions } from './rentmanOptions';

/**
 * Days, groups and shifts built from a Rentman project's crew and transport functions.
 * - One phase per day, named after that day's Rentman function groups; each Rentman group is a group inside the day,
 *   and transport functions go in a "Transport" group as "Driver (vehicle)" shifts.
 * - Times are the functions' planning period (when the crew works). A function running over several days becomes one
 *   shift per day at the same clock times.
 * - Role names: a name mapped under Integrations → Rentman, else a LaborOps role with the same name, else Rentman's
 *   name (listed so it can be mapped once).
 * - Later changes in Rentman are applied to shifts nobody has changed or staffed; the rest are listed for a coordinator.
 */
export type Want = { key: string; role: string; start: string; end: string; headcount: number; date: string; group: string | null; groupSort: number; hash: string; billRate: number | null };
export type Conflict = { key: string; kind: 'changed' | 'removed'; shiftId: string; role: string; current: { role: string; start: string; end: string; headcount: number }; rentman: Want | null; why: string };

const iso = (v: unknown) => new Date(String(v)).toISOString();
export const hashOf = (role: string, start: unknown, end: unknown, headcount: number) => `${role.trim()}|${iso(start)}|${iso(end)}|${headcount}`;
const txt = (...v: unknown[]) => v.map((x) => String(x ?? '').trim()).find(Boolean) ?? null;
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** The role to use for a Rentman name, and whether it matched. */
async function roleResolver(c: PoolClient, tid: string) {
  const skills = (await c.query('SELECT name FROM skills WHERE active')).rows.map((r) => r.name as string);
  const byKey = new Map(skills.map((n) => [roleKeyOf(n), n]));
  const map = new Map((await c.query('SELECT rentman_name, role_name FROM rentman_role_map')).rows.map((r) => [r.rentman_name as string, r.role_name as string | null]));
  const unmatched = new Set<string>();
  const resolve = (name: string) => {
    const mapped = map.get(norm(name));
    if (mapped) return mapped;
    const hit = byKey.get(roleKeyOf(name));
    if (hit) return hit;
    unmatched.add(name.trim());
    return name.trim();
  };
  const driver = skills.find((n) => /driver/i.test(n)) ?? map.get('driver') ?? 'Driver';
  // Remember names nobody has mapped yet, so the Integrations page can list them.
  const remember = async () => {
    for (const n of unmatched) await c.query('INSERT INTO rentman_role_map (tenant_id, rentman_name) VALUES ($1,$2) ON CONFLICT DO NOTHING', [tid, norm(n)]);
  };
  return { resolve, driver, unmatched, remember };
}

/** What the event should have, from the project's functions now. */
export async function wantedShifts(c: PoolClient, tid: string, token: string, projectId: number) {
  const tz = (await c.query('SELECT timezone FROM tenants LIMIT 1')).rows[0]?.timezone ?? 'UTC';
  const [fns, groups] = await Promise.all([
    getAll(token, `/projects/${projectId}/projectfunctions`),
    getAll(token, `/projects/${projectId}/projectfunctiongroups`).catch(() => [] as any[]),
  ]);
  const gname = new Map<number, { name: string; sort: number }>();
  groups.forEach((g: any, i: number) => gname.set(Number(g.id), { name: String(g.displayname || g.name || 'Crew'), sort: Number.isFinite(Number(g.order)) ? Number(g.order) : i }));
  const roles = await roleResolver(c, tid);
  const out: Want[] = [];
  let unscheduled = 0;
  for (const f of fns) {
    const type = f.type ?? 'crew_function';
    if (type !== 'crew_function' && type !== 'transport_function') continue;
    const name = txt(f.name_external, f.name, f.displayname) ?? 'Crew';
    const s = txt(f.planperiod_start, f.usageperiod_start);
    const e = txt(f.planperiod_end, f.usageperiod_end);
    if (!s || !e || +new Date(e) <= +new Date(s)) { unscheduled++; continue; }
    const transport = type === 'transport_function';
    const role = transport ? `${roles.driver} (${name})` : roles.resolve(name);
    const g = transport ? { name: 'Transport', sort: 9999 } : gname.get(refId(f.group) ?? -1) ?? null;
    const headcount = Math.min(500, Math.max(1, Math.round(Number(f.amount) || 1)));
    const span = (+new Date(e) - +new Date(s)) / 3600_000;
    const days =
      span <= 24
        ? (await c.query("SELECT to_char(($1::timestamptz AT TIME ZONE $3)::date, 'YYYY-MM-DD') AS d, $1::timestamptz AS s, $2::timestamptz AS e", [s, e, tz])).rows
        : // Several days: one shift a day at the same clock times (ending the next morning when the end time is earlier).
          (
            await c.query(
              `WITH x AS (SELECT ($1::timestamptz AT TIME ZONE $3) AS ls, ($2::timestamptz AT TIME ZONE $3) AS le)
               SELECT to_char(g::date, 'YYYY-MM-DD') AS d, ((g::date + x.ls::time) AT TIME ZONE $3) AS s,
                      ((g::date + x.le::time + CASE WHEN x.le::time <= x.ls::time THEN interval '1 day' ELSE interval '0' END) AT TIME ZONE $3) AS e
                 FROM x, generate_series(x.ls::date, x.le::date, interval '1 day') g
                WHERE ((g::date + x.ls::time) AT TIME ZONE $3) < $2::timestamptz
                LIMIT 31`,
              [s, e, tz],
            )
          ).rows;
    // The hourly price quoted in Rentman: its time-based price over all the people-hours (crew only; transport is priced by distance).
    const peopleHours = days.reduce((n: number, d: any) => n + ((+new Date(d.e) - +new Date(d.s)) / 3600_000) * headcount, 0);
    const variable = Number(f.price_variable) || Math.max(0, (Number(f.price_total) || 0) - (Number(f.price_fixed) || 0));
    const billRate = !transport && variable > 0 && peopleHours > 0 ? Math.round((variable / peopleHours) * 100) / 100 : null;
    days.forEach((d: any, i: number) =>
      out.push({
        key: days.length > 1 ? `${f.id}:${i}` : String(f.id), role, start: iso(d.s), end: iso(d.e), headcount, date: d.d,
        group: g?.name ?? null, groupSort: g?.sort ?? 0, hash: hashOf(role, d.s, d.e, headcount), billRate,
      }),
    );
  }
  await roles.remember();
  return { want: out.sort((a, b) => a.start.localeCompare(b.start) || a.groupSort - b.groupSort || a.role.localeCompare(b.role)), unscheduled, unmatched: [...roles.unmatched] };
}

/** Compare what Rentman wants with the event's Rentman-built shifts. */
export async function planBuild(c: PoolClient, eventId: string, want: Want[]) {
  const have = (
    await c.query(
      `SELECT s.id, s.rentman_key, s.rentman_hash, s.role_name, s.starts_at, s.ends_at, s.headcount,
              ((SELECT count(*) FROM shift_assignments a WHERE a.shift_id = s.id AND a.status <> 'declined') + (SELECT count(*) FROM planned_picks p WHERE p.shift_id = s.id))::int AS crew
         FROM shifts s WHERE s.event_id = $1 AND s.rentman_key IS NOT NULL`,
      [eventId],
    )
  ).rows;
  const byKey = new Map(have.map((h) => [h.rentman_key as string, h]));
  const adds: Want[] = [], updates: { shiftId: string; want: Want; headcountOnly: boolean }[] = [], removes: { shiftId: string; role: string; start: string }[] = [], conflicts: Conflict[] = [];
  let unchanged = 0;
  const cur = (h: any) => ({ role: h.role_name, start: iso(h.starts_at), end: iso(h.ends_at), headcount: Number(h.headcount) });
  for (const w of want) {
    const h = byKey.get(w.key);
    if (!h) { adds.push(w); continue; }
    if (h.rentman_hash === w.hash) { unchanged++; continue; } // Rentman unchanged: keep any edits made here
    const touched = hashOf(h.role_name, h.starts_at, h.ends_at, Number(h.headcount)) !== h.rentman_hash;
    const sameTimes = h.role_name === w.role && iso(h.starts_at) === w.start && iso(h.ends_at) === w.end;
    if (!touched && !h.crew) updates.push({ shiftId: h.id, want: w, headcountOnly: false });
    else if (!touched && sameTimes && w.headcount >= h.crew) updates.push({ shiftId: h.id, want: w, headcountOnly: true }); // more (or fewer, still enough) seats
    else conflicts.push({ key: w.key, kind: 'changed', shiftId: h.id, role: h.role_name, current: cur(h), rentman: w, why: touched ? 'changed here since it came from Rentman' : `${h.crew} ${h.crew === 1 ? 'person is' : 'people are'} on it` });
  }
  const wanted = new Set(want.map((w) => w.key));
  for (const h of have) {
    if (wanted.has(h.rentman_key)) continue;
    const touched = hashOf(h.role_name, h.starts_at, h.ends_at, Number(h.headcount)) !== h.rentman_hash;
    if (!h.crew && !touched) removes.push({ shiftId: h.id, role: h.role_name, start: iso(h.starts_at) });
    else conflicts.push({ key: h.rentman_key, kind: 'removed', shiftId: h.id, role: h.role_name, current: cur(h), rentman: null, why: h.crew ? `${h.crew} ${h.crew === 1 ? 'person is' : 'people are'} on it` : 'changed here since it came from Rentman' });
  }
  return { adds, updates, removes, conflicts, unchanged };
}
export type Plan = Awaited<ReturnType<typeof planBuild>>;

/** Put the safe part of a plan on the event: add, update and remove shifts, making days and groups as needed. */
export async function applyBuild(c: PoolClient, tid: string, by: string | null, eventId: string, plan: Plan, want: Want[]) {
  const phases = new Map<string, string>(); // date -> phase id
  const groups = new Map<string, string>(); // phase|label -> group id
  // A new day is named after its Rentman groups ("Load in", "Show / Strike"), else "Show day".
  const dayLabel = (date: string) => {
    const names = [...new Set(want.filter((w) => w.date === date && w.group).sort((a, b) => a.groupSort - b.groupSort).map((w) => w.group!))];
    const crew = names.filter((n) => n !== 'Transport');
    return (crew.length ? crew.join(' / ') : names.length ? names[0] : 'Show day').slice(0, 80);
  };
  const phaseFor = async (date: string) => {
    if (phases.has(date)) return phases.get(date)!;
    const p = (await c.query('SELECT id FROM event_phases WHERE event_id = $1 AND starts_on = $2::date ORDER BY created_at LIMIT 1', [eventId, date])).rows[0]?.id
      ?? (await c.query('INSERT INTO event_phases (tenant_id, event_id, label, starts_on, ends_on) VALUES ($1,$2,$3,$4,$4) RETURNING id', [tid, eventId, dayLabel(date), date])).rows[0].id;
    phases.set(date, p);
    return p as string;
  };
  const groupFor = async (phaseId: string, label: string | null, sort: number) => {
    if (!label) return null;
    const k = `${phaseId}|${label.toLowerCase()}`;
    if (groups.has(k)) return groups.get(k)!;
    const g = (await c.query('SELECT id FROM phase_groups WHERE phase_id = $1 AND lower(label) = lower($2) LIMIT 1', [phaseId, label])).rows[0]?.id
      ?? (await c.query('INSERT INTO phase_groups (tenant_id, event_id, phase_id, label, sort) VALUES ($1,$2,$3,$4,$5) RETURNING id', [tid, eventId, phaseId, label.slice(0, 80), sort])).rows[0].id;
    groups.set(k, g);
    return g as string;
  };
  for (const w of plan.adds) {
    const ph = await phaseFor(w.date);
    const g = await groupFor(ph, w.group, w.groupSort);
    await c.query(
      `INSERT INTO shifts (tenant_id, event_id, role_name, starts_at, ends_at, headcount, phase_id, group_id, rentman_key, rentman_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
      [tid, eventId, w.role, w.start, w.end, w.headcount, ph, g, w.key, w.hash],
    );
  }
  for (const u of plan.updates) {
    if (u.headcountOnly) {
      await c.query('UPDATE shifts SET headcount = $2, rentman_hash = $3 WHERE id = $1', [u.shiftId, u.want.headcount, u.want.hash]);
      continue;
    }
    const ph = await phaseFor(u.want.date);
    const g = await groupFor(ph, u.want.group, u.want.groupSort);
    await c.query('UPDATE shifts SET role_name = $2, starts_at = $3, ends_at = $4, headcount = $5, phase_id = $6, group_id = $7, rentman_hash = $8 WHERE id = $1',
      [u.shiftId, u.want.role, u.want.start, u.want.end, u.want.headcount, ph, g, u.want.hash]);
  }
  for (const r of plan.removes) await c.query('DELETE FROM shifts WHERE id = $1', [r.shiftId]);
  // Billing at the rate quoted in Rentman (an option): every Rentman-built shift takes its function's quoted rate.
  if ((await loadOptions(c)).quoted_bill_rates)
    for (const w of want) await c.query('UPDATE shifts SET bill_rate_override = $3 WHERE event_id = $1 AND rentman_key = $2 AND bill_rate_override IS DISTINCT FROM $3', [eventId, w.key, w.billRate]);
  // The event's dates stretch to cover its days.
  await c.query(
    `UPDATE events SET rentman_build = true,
            start_date = LEAST(start_date, COALESCE((SELECT min(starts_on) FROM event_phases WHERE event_id = $1), start_date)),
            end_date = GREATEST(end_date, COALESCE((SELECT max(ends_on) FROM event_phases WHERE event_id = $1), end_date)) WHERE id = $1`,
    [eventId],
  );
  const result = { added: plan.adds.length, updated: plan.updates.length, removed: plan.removes.length, unchanged: plan.unchanged, conflicts: plan.conflicts.length };
  if (result.added || result.updated || result.removed) await audit(c, tid, by, 'event.rentman_build', 'event', eventId, result);
  return result;
}

/** Plan and apply for one event (used by the button, new pipeline events and the 30-minute run). */
export async function buildFromRentman(c: PoolClient, tid: string, by: string | null, eventId: string, token: string, opts: { apply: boolean }) {
  const ev = (await c.query('SELECT rentman_project_id FROM events WHERE id = $1', [eventId])).rows[0];
  if (!ev) throw new RentmanError('Event not found', 404);
  if (!ev.rentman_project_id) throw new RentmanError('Link this event to a Rentman project first.', 409);
  const w = await wantedShifts(c, tid, token, Number(ev.rentman_project_id));
  const plan = await planBuild(c, eventId, w.want);
  const result = opts.apply ? await applyBuild(c, tid, by, eventId, plan, w.want) : null;
  return { plan, result, unscheduled: w.unscheduled, unmatched: w.unmatched };
}

/** A conflict handled by a coordinator: keep the shift as it is here (and stop flagging this Rentman version). */
export async function keepConflict(c: PoolClient, eventId: string, key: string, wantHash: string | null) {
  if (wantHash) return (await c.query('UPDATE shifts SET rentman_hash = $3 WHERE event_id = $1 AND rentman_key = $2', [eventId, key, wantHash])).rowCount;
  // Gone from Rentman: the shift stays as an ordinary shift of this event.
  return (await c.query('UPDATE shifts SET rentman_key = NULL, rentman_hash = NULL WHERE event_id = $1 AND rentman_key = $2', [eventId, key])).rowCount;
}
