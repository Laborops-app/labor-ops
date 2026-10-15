import type { PoolClient } from 'pg';
import { evaluateShift, findClash } from './eligibility';
import { checkRules, loadRules, priorWeekHours, hoursBetween } from './pay';
import { flagText, reviewFlags } from './reviews';

export type Candidate = { user_id: string; name: string; stars: number; week_hours: number; overtime: boolean; flag: string | null };

/**
 * Who in a group can actually take this shift, best first. People who are already on it, already scheduled at that time,
 * on time off, outside their availability, missing a required certificate, or who would break the rest / daily-hours rules
 * are left out (and counted in `skipped` with the reason). Ranking: star rating for the shift's position, then people who
 * would not go into overtime, then fewer hours already this week.
 */
export async function groupCandidates(c: PoolClient, shiftId: string, groupId: string) {
  const shift = (await c.query('SELECT id, role_name, starts_at, ends_at FROM shifts WHERE id = $1', [shiftId])).rows[0];
  if (!shift) return null;
  const members = (
    await c.query(
      `SELECT u.id, u.name, COALESCE(r.avg_stars, r.stars, 0)::float8 AS stars
         FROM crew_group_members m JOIN users u ON u.id = m.user_id AND u.role = 'crew' AND u.active
         LEFT JOIN crew_ratings r ON r.user_id = u.id AND r.role_key = lower(trim(regexp_replace($2, '\\s*\\(.*\\)\\s*$', '')))
        WHERE m.group_id = $1 ORDER BY u.name`,
      [groupId, shift.role_name],
    )
  ).rows;
  const onShift = new Set((await c.query('SELECT user_id FROM shift_assignments WHERE shift_id = $1', [shiftId])).rows.map((r) => r.user_id));
  const elig = new Map((await evaluateShift(c, shiftId)).map((e) => [e.user_id, e]));
  const rules = await loadRules(c);
  const flags = await reviewFlags(c, members.map((m) => m.id));
  const candidates: Candidate[] = [];
  const skipped: { user_id: string; name: string; reason: string }[] = [];
  for (const m of members) {
    const skip = (reason: string) => skipped.push({ user_id: m.id, name: m.name, reason });
    if (onShift.has(m.id)) { skip('already on this shift'); continue; }
    const clash = await findClash(c, m.id, shiftId, shift.starts_at, shift.ends_at);
    if (clash) { skip(`already scheduled (${clash.role_name} at ${clash.event_name})`); continue; }
    const e = elig.get(m.id);
    if (e?.missing_certs.length) { skip(`needs ${e.missing_certs.join(', ')}`); continue; }
    if (e?.time_off) { skip('on time off'); continue; }
    if (e?.outside_availability) { skip('not available then'); continue; }
    const chk = await checkRules(c, rules, m.id, shiftId, shift.starts_at, shift.ends_at, m.name);
    if (chk.blocks.length) { skip('would break the rest / hours rules'); continue; }
    const f = flags.get(m.id);
    if (f?.no_rehire) { skip('tagged Do not rehire in a past review'); continue; }
    const prior = await priorWeekHours(c, rules, m.id, shiftId, shift.starts_at);
    candidates.push({ user_id: m.id, name: m.name, stars: Number(m.stars), week_hours: Math.round(prior * 10) / 10, overtime: rules.weeklyOt > 0 && prior + hoursBetween(shift.starts_at, shift.ends_at) > rules.weeklyOt, flag: f ? flagText(m.name, f) : null });
  }
  candidates.sort((a, b) => Number(!!a.flag) - Number(!!b.flag) || b.stars - a.stars || Number(a.overtime) - Number(b.overtime) || a.week_hours - b.week_hours || a.name.localeCompare(b.name));
  return { shift, candidates, skipped };
}
