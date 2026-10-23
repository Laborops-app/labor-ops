import type { PoolClient } from 'pg';
import { evaluateShift, findClash } from './eligibility';
import { checkRules, loadRules, priorWeekHours, hoursBetween, roleKeyOf, type Rules } from './pay';
import { flagText, reviewFlags } from './reviews';

export type Pick = { userId: string; name: string; stars: number; weekHours: number; reasons: string[]; warnings: string[] };
export type ShiftProposal = {
  id: string; role: string; starts_at: string; ends_at: string; phase: string | null; group: string | null;
  open: number; picks: Pick[]; short: number; skipped: Record<string, number>;
};

/**
 * Auto-fill: for each shift with open seats, the best people who can actually work it, with the reasons.
 * Nothing is sent: a coordinator reviews the proposal and sends the offers. Same checks as the crew picker
 * (certificates on the date, time off, availability, double-booking, rest / daily-hours rules, Do-not-rehire),
 * ranked by: lists the position, stars for the position, has worked for this customer, no overtime, fewer hours.
 * One person is never proposed for two overlapping shifts in the same proposal.
 */
export async function proposeEvent(c: PoolClient, eventId: string, o: { shiftIds?: string[]; groupId?: string | null; availCheckId?: string | null } = {}) {
  const ev = (await c.query('SELECT id, name, customer_id FROM events WHERE id = $1', [eventId])).rows[0];
  if (!ev) return null;
  const shifts = (
    await c.query(
      `SELECT s.id, s.role_name, s.starts_at, s.ends_at, s.headcount, p.label AS phase, g.label AS group_label,
              to_char(s.starts_at AT TIME ZONE (SELECT timezone FROM tenants LIMIT 1), 'YYYY-MM-DD') AS day,
              ((SELECT count(*) FROM shift_assignments a WHERE a.shift_id = s.id AND a.status <> 'declined')
               + (SELECT count(*) FROM planned_picks pp WHERE pp.shift_id = s.id))::int AS taken
         FROM shifts s LEFT JOIN event_phases p ON p.id = s.phase_id LEFT JOIN phase_groups g ON g.id = s.group_id
        WHERE s.event_id = $1 AND s.ends_at > now() AND ($2::uuid[] IS NULL OR s.id = ANY($2::uuid[]))
        ORDER BY s.starts_at, s.role_name`,
      [eventId, o.shiftIds?.length ? o.shiftIds : null],
    )
  ).rows.filter((s) => s.headcount > s.taken);
  const rules = await loadRules(c);
  const pool = (
    await c.query(
      `SELECT u.id, u.name, u.skills,
              COALESCE((SELECT json_object_agg(r.role_key, COALESCE(r.avg_stars, r.stars)::float8) FROM crew_ratings r WHERE r.user_id = u.id), '{}'::json) AS ratings,
              (SELECT count(DISTINCT s.event_id)::int FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id JOIN events e ON e.id = s.event_id
                WHERE a.user_id = u.id AND a.status = 'accepted' AND $2::uuid IS NOT NULL AND e.customer_id = $2 AND s.ends_at < now()) AS customer_events
         FROM users u
        WHERE u.role = 'crew' AND u.active AND ($1::uuid IS NULL OR EXISTS (SELECT 1 FROM crew_group_members m WHERE m.group_id = $1 AND m.user_id = u.id))
        ORDER BY u.name`,
      [o.groupId ?? null, ev.customer_id ?? null],
    )
  ).rows as { id: string; name: string; skills: string[] | null; ratings: Record<string, number>; customer_events: number }[];
  // Only people who answered an "Are you free?" check, on the days they said.
  const free = o.availCheckId
    ? new Map(
        (await c.query("SELECT user_id, ARRAY(SELECT to_char(d, 'YYYY-MM-DD') FROM unnest(free_dates) d) AS days FROM avail_answers WHERE check_id = $1 AND answered_at IS NOT NULL AND cardinality(free_dates) > 0", [o.availCheckId])).rows.map(
          (r) => [r.user_id as string, new Set(r.days as string[])],
        ),
      )
    : null;
  const flags = await reviewFlags(c, pool.map((p) => p.id));
  const planned = new Map<string, { s: number; e: number }[]>(); // people proposed in this run
  const out: ShiftProposal[] = [];
  for (const s of shifts) {
    const open = s.headcount - s.taken;
    const key = roleKeyOf(s.role_name);
    const lead = key.replace(/lead$/, '');
    const onShift = new Set((await c.query('SELECT user_id FROM shift_assignments WHERE shift_id = $1 UNION SELECT user_id FROM planned_picks WHERE shift_id = $1', [s.id])).rows.map((r) => r.user_id));
    const elig = new Map((await evaluateShift(c, s.id)).map((e) => [e.user_id, e]));
    const skipped: Record<string, number> = {};
    const skip = (why: string) => { skipped[why] = (skipped[why] ?? 0) + 1; };
    const ss = +new Date(s.starts_at), se = +new Date(s.ends_at);
    // Cheap checks first, then rank, then the expensive rule checks only as far down the list as needed.
    const ranked = [];
    for (const p of pool) {
      if (onShift.has(p.id)) continue;
      if (free && !free.has(p.id)) continue;
      if (free && !free.get(p.id)!.has(s.day)) { skip("didn't say they're free that day"); continue; }
      const e = elig.get(p.id);
      if (e?.missing_certs.length) { skip('missing a certificate'); continue; }
      if (e?.time_off) { skip('time off'); continue; }
      if (e?.outside_availability) { skip('not available then'); continue; }
      if ((planned.get(p.id) ?? []).some((x) => x.s < se && x.e > ss)) { skip('already proposed for another shift then'); continue; }
      const f = flags.get(p.id);
      if (f?.no_rehire) { skip('Do not rehire'); continue; }
      const lists = (p.skills ?? []).some((k) => { const r = roleKeyOf(k); return r === key || r === lead; });
      const stars = Number(p.ratings[key] ?? p.ratings[lead] ?? 0);
      ranked.push({ p, e, f, lists, stars });
    }
    ranked.sort((a, b) =>
      Number(b.lists) - Number(a.lists) || Number(!!a.f) - Number(!!b.f) || b.stars - a.stars || b.p.customer_events - a.p.customer_events || a.p.name.localeCompare(b.p.name));
    const picks: Pick[] = [];
    for (const r of ranked) {
      if (picks.length >= open) break;
      if (r.e?.booked) {
        const clash = await findClash(c, r.p.id, s.id, s.starts_at, s.ends_at);
        if (clash) { skip('already scheduled then'); continue; }
      }
      const chk = await checkRules(c, rules as Rules, r.p.id, s.id, s.starts_at, s.ends_at, r.p.name);
      if (chk.blocks.length) { skip('rest / daily-hours rules'); continue; }
      const prior = await priorWeekHours(c, rules, r.p.id, s.id, s.starts_at);
      const ot = rules.weeklyOt > 0 && prior + hoursBetween(s.starts_at, s.ends_at) > rules.weeklyOt;
      const reasons: string[] = [];
      if (r.lists) reasons.push(`lists ${s.role_name}`);
      if (r.stars) reasons.push(`★ ${r.stars.toFixed(1)} as ${s.role_name.replace(/\s*lead$/i, '')}`);
      if (r.p.customer_events) reasons.push(`worked ${r.p.customer_events} event${r.p.customer_events === 1 ? '' : 's'} for this customer`);
      reasons.push(`${Math.round(prior * 10) / 10} h this week`);
      const warnings: string[] = [];
      if (!r.lists) warnings.push(`doesn’t list ${s.role_name}`);
      if (r.e?.booked) warnings.push(`also on ${r.e.booked.role_name} that day`);
      for (const w of chk.warns) warnings.push(String(w));
      if (ot && !chk.warns.some((w) => /overtime/i.test(w))) warnings.push('goes into overtime');
      if (r.f) warnings.push(flagText(r.p.name, r.f));
      picks.push({ userId: r.p.id, name: r.p.name, stars: r.stars, weekHours: Math.round(prior * 10) / 10, reasons, warnings });
      planned.set(r.p.id, [...(planned.get(r.p.id) ?? []), { s: ss, e: se }]);
    }
    out.push({ id: s.id, role: s.role_name, starts_at: s.starts_at, ends_at: s.ends_at, phase: s.phase, group: s.group_label, open, picks, short: open - picks.length, skipped });
  }
  return { event: { id: ev.id, name: ev.name }, shifts: out };
}
