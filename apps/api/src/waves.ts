import type { PoolClient } from 'pg';
import { z } from 'zod';
import { pool, withTenant, audit } from './db';
import { evaluateShift, findClash } from './eligibility';
import { describeShift, notify } from './notify';
import { claimLinks } from './notify/respond';
import { checkRules, hoursBetween, loadRules, priorWeekHours, roleKeyOf } from './pay';
import { reviewFlags } from './reviews';
import { assignCrew } from './routes/events';
import { nudgeOne } from './routes/staffing';

/**
 * Offer waves. A coordinator approves a plan once for a shift, then LaborOps works through it:
 *   wave 1: the best-rated people for the position (top N), wave 2: everyone else who qualifies, wave 3: an open shift.
 * Offers only ever go out for seats that are still open. Inside a wave a "no" hands the seat to the next person in
 * that wave. When a wave's wait time is up, offers nobody answered are withdrawn and the next wave starts. Nothing is
 * offered after the answer-by time; what is still open then becomes an open shift (if wave 3 is on).
 */
export const waveConfig = z.object({
  topN: z.number().int().min(1).max(200).default(10),
  wait1Min: z.number().int().min(15).max(7 * 24 * 60).default(120),
  wave2: z.boolean().default(true),
  wait2Min: z.number().int().min(15).max(7 * 24 * 60).default(120),
  wave3: z.boolean().default(true),
  /** Hours before the shift starts by which people must have answered. */
  answerByHours: z.number().min(0).max(24 * 14).default(24),
  /** Minutes after an offer before one reminder; 0 = no reminder. */
  remindAfterMin: z.number().int().min(0).max(24 * 60).default(60),
  /** A "no" offers the next person in the wave straight away. */
  rollOnDecline: z.boolean().default(true),
});
export type WaveConfig = z.infer<typeof waveConfig>;
export const DEFAULT_WAVES: WaveConfig = waveConfig.parse({});

type Ranked = { user_id: string; name: string; stars: number; week_hours: number; overtime: boolean; lists: boolean };

/**
 * Everyone who could take this shift, best first: star rating for the position, then people who would stay out of
 * overtime, then fewest hours that week. Left out: people on the shift, booked then, on time off, outside their
 * availability, missing a certificate, breaking the rest rules, or tagged "do not rehire". When some crew list the
 * role among their skills only they qualify; when nobody lists it, everyone does.
 */
export async function rankForShift(c: PoolClient, shiftId: string): Promise<Ranked[]> {
  const shift = (await c.query('SELECT id, role_name, starts_at, ends_at FROM shifts WHERE id = $1', [shiftId])).rows[0];
  if (!shift) return [];
  const people = (
    await c.query(
      `SELECT u.id, u.name, u.skills, COALESCE(r.avg_stars, r.stars, 0)::float8 AS stars
         FROM users u LEFT JOIN crew_ratings r ON r.user_id = u.id AND r.role_key = lower(trim(regexp_replace($1, '\\s*\\(.*\\)\\s*$', '')))
        WHERE u.role = 'crew' AND u.active ORDER BY u.name`,
      [shift.role_name],
    )
  ).rows as { id: string; name: string; skills: string[] | null; stars: number }[];
  const key = roleKeyOf(shift.role_name);
  const lists = (p: { skills: string[] | null }) => (p.skills ?? []).some((k) => roleKeyOf(k) === key);
  const anyLists = people.some(lists);
  const onShift = new Set((await c.query('SELECT user_id FROM shift_assignments WHERE shift_id = $1', [shiftId])).rows.map((r) => r.user_id));
  const elig = new Map((await evaluateShift(c, shiftId)).map((e) => [e.user_id, e]));
  const rules = await loadRules(c);
  const flags = await reviewFlags(c, people.map((p) => p.id));
  const out: Ranked[] = [];
  for (const p of people) {
    if (onShift.has(p.id) || (anyLists && !lists(p))) continue;
    const e = elig.get(p.id);
    if (e?.missing_certs.length || e?.time_off || e?.outside_availability || e?.booked) continue;
    if (flags.get(p.id)?.no_rehire) continue;
    if (await findClash(c, p.id, shiftId, shift.starts_at, shift.ends_at)) continue;
    if ((await checkRules(c, rules, p.id, shiftId, shift.starts_at, shift.ends_at, p.name)).blocks.length) continue;
    const prior = await priorWeekHours(c, rules, p.id, shiftId, shift.starts_at);
    out.push({ user_id: p.id, name: p.name, stars: Number(p.stars), week_hours: Math.round(prior * 10) / 10, overtime: rules.weeklyOt > 0 && prior + hoursBetween(shift.starts_at, shift.ends_at) > rules.weeklyOt, lists: lists(p) });
  }
  out.sort((a, b) => b.stars - a.stars || Number(a.overtime) - Number(b.overtime) || a.week_hours - b.week_hours || a.name.localeCompare(b.name));
  return out;
}

type Plan = { id: string; shift_id: string; config: WaveConfig; status: string; wave: number; wave_started_at: Date; pool: string[]; started_by: string | null };

const seats = async (c: PoolClient, shiftId: string) =>
  (
    await c.query(
      `SELECT s.headcount::int AS headcount, s.starts_at, s.is_open, e.staffing_draft, e.id AS event_id,
              (SELECT count(*)::int FROM shift_assignments a WHERE a.shift_id = s.id AND a.status <> 'declined') AS taken,
              (SELECT count(*)::int FROM shift_assignments a WHERE a.shift_id = s.id AND a.status = 'accepted') AS confirmed
         FROM shifts s JOIN events e ON e.id = s.event_id WHERE s.id = $1`,
      [shiftId],
    )
  ).rows[0] as { headcount: number; starts_at: Date; is_open: boolean; staffing_draft: boolean; event_id: string; taken: number; confirmed: number } | undefined;

/** Take back offers this plan made that nobody answered, and tell those people. */
async function withdrawPending(c: PoolClient, tid: string, plan: Plan, why: string) {
  const rows = (
    await c.query(
      `SELECT o.id, o.user_id, a.id AS aid FROM shift_wave_offers o
         JOIN shift_assignments a ON a.shift_id = $2 AND a.user_id = o.user_id AND a.status = 'offered'
        WHERE o.plan_id = $1 AND o.outcome IS NULL`,
      [plan.id, plan.shift_id],
    )
  ).rows;
  if (!rows.length) return 0;
  const d = await describeShift(c, tid, plan.shift_id);
  for (const r of rows) {
    await c.query('DELETE FROM shift_assignments WHERE id = $1', [r.aid]);
    await c.query("UPDATE shift_wave_offers SET outcome = 'expired', note = $2 WHERE id = $1", [r.id, why]);
    if (d) await notify(c, tid, { userId: r.user_id, category: 'shift_change', title: `Offer expired: ${d.role}`, body: `${d.line}\n\nThis offer wasn't answered in time, so the spot went to someone else. You don't need to do anything.`, link: '/my-shifts' });
  }
  return rows.length;
}

async function finish(c: PoolClient, tid: string, plan: Plan, reason: string) {
  await c.query("UPDATE shift_wave_plans SET status = 'done', finished_reason = $2, updated_at = now() WHERE id = $1", [plan.id, reason]);
  plan.status = 'done';
  const d = await describeShift(c, tid, plan.shift_id);
  const s = await seats(c, plan.shift_id);
  if (plan.started_by && d && s)
    await notify(c, tid, { userId: plan.started_by, category: 'approval_result', title: `Offer waves finished: ${d.role}`, body: `${d.line}\n\n${reason} ${s.confirmed} of ${s.headcount} confirmed.`, link: `/events/${s.event_id}` });
}

/** Make the shift open for anyone qualified to claim, and tell them. */
async function openShift(c: PoolClient, tid: string, shiftId: string) {
  const r = await c.query('UPDATE shifts SET is_open = true WHERE id = $1 AND NOT is_open RETURNING id', [shiftId]);
  if (!r.rowCount) return;
  const d = await describeShift(c, tid, shiftId);
  const elig = await evaluateShift(c, shiftId);
  const on = new Set((await c.query('SELECT user_id FROM shift_assignments WHERE shift_id = $1', [shiftId])).rows.map((x) => x.user_id));
  const who = elig.filter((e) => !e.missing_certs.length && !e.time_off && !on.has(e.user_id));
  if (d && who.length)
    await notify(c, tid, who.map((e) => {
      const l = claimLinks(tid, shiftId, e.user_id);
      return {
        userId: e.user_id, category: 'open_shift' as const, title: `Open shift: ${d.role}`, body: `${d.line}\n\nThis shift is open. Claim it if you are available.`, link: '/open-shifts', smsLink: l.bare,
        actions: [{ label: 'Claim this shift', url: l.accept, kind: 'accept' as const }, { label: 'No thanks', url: l.decline, kind: 'decline' as const }],
      };
    }));
}

/** Work one plan forward. Safe to call any time; it only acts on what is due. */
export async function advancePlan(c: PoolClient, tid: string, planId: string) {
  const plan = (await c.query('SELECT * FROM shift_wave_plans WHERE id = $1 FOR UPDATE', [planId])).rows[0] as Plan | undefined;
  if (!plan || plan.status !== 'active') return;
  const cfg = waveConfig.parse(plan.config);
  let s = await seats(c, plan.shift_id);
  if (!s) return;
  if (s.staffing_draft) return; // waits until the event is published
  const now = Date.now();
  if (new Date(s.starts_at).getTime() <= now) return finish(c, tid, plan, 'The shift has started.');

  // What happened to the offers made so far.
  await c.query(
    `UPDATE shift_wave_offers o SET outcome = CASE WHEN a.status = 'accepted' THEN 'accepted' WHEN a.status = 'declined' THEN 'declined' ELSE 'removed' END
       FROM shift_wave_offers o2 LEFT JOIN shift_assignments a ON a.shift_id = $2 AND a.user_id = o2.user_id
      WHERE o.id = o2.id AND o.plan_id = $1 AND o.outcome IS NULL AND (a.id IS NULL OR a.status IN ('accepted', 'declined'))`,
    [plan.id, plan.shift_id],
  );

  const lastCall = async (reason: string) => {
    await withdrawPending(c, tid, plan, 'not answered in time');
    const left = await seats(c, plan.shift_id);
    if (left && left.taken < left.headcount && cfg.wave3) { await openShift(c, tid, plan.shift_id); return finish(c, tid, plan, `${reason} The spots still open are now an open shift.`); }
    return finish(c, tid, plan, left && left.taken >= left.headcount ? 'Every spot is taken.' : `${reason} Some spots are still open.`);
  };
  // Answer-by time: nothing more is offered.
  if (now >= new Date(s.starts_at).getTime() - cfg.answerByHours * 3600_000) return lastCall('The answer-by time has passed.');

  // One reminder per offer.
  if (cfg.remindAfterMin > 0) {
    const due = (
      await c.query(
        `SELECT o.id, a.id AS aid, a.user_id FROM shift_wave_offers o JOIN shift_assignments a ON a.shift_id = $2 AND a.user_id = o.user_id AND a.status = 'offered'
          WHERE o.plan_id = $1 AND o.outcome IS NULL AND o.reminded_at IS NULL AND o.offered_at < now() - make_interval(mins => $3)`,
        [plan.id, plan.shift_id, cfg.remindAfterMin],
      )
    ).rows;
    for (const r of due) {
      await nudgeOne(c, tid, { id: r.aid, user_id: r.user_id, shift_id: plan.shift_id });
      await c.query('UPDATE shift_wave_offers SET reminded_at = now() WHERE id = $1', [r.id]);
    }
  }

  for (let guard = 0; guard < 4; guard++) {
    s = (await seats(c, plan.shift_id))!;
    const pending = (await c.query('SELECT count(*)::int AS n FROM shift_wave_offers WHERE plan_id = $1 AND outcome IS NULL', [plan.id])).rows[0].n as number;
    if (s.taken >= s.headcount && !pending) return finish(c, tid, plan, 'Every spot is taken.');
    const offered = new Set((await c.query('SELECT user_id FROM shift_wave_offers WHERE plan_id = $1', [plan.id])).rows.map((r) => r.user_id as string));
    const waveOffers = (await c.query('SELECT count(*)::int AS n FROM shift_wave_offers WHERE plan_id = $1 AND wave = $2', [plan.id, plan.wave])).rows[0].n as number;
    let left = plan.pool.filter((u) => !offered.has(u));
    // Offer open seats to the next people in this wave (first batch always; after that only when "next person on a no" is on).
    let open = s.headcount - s.taken;
    if (open > 0 && left.length && (waveOffers === 0 || cfg.rollOnDecline)) {
      for (const uid of left) {
        if (open <= 0) break;
        const r = await assignCrew(c, tid, plan.started_by ?? uid, plan.shift_id, uid);
        const ok = r.code === 201 && !(r as { planned?: boolean }).planned;
        await c.query('INSERT INTO shift_wave_offers (tenant_id, plan_id, user_id, wave, outcome, note) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING', [
          tid, plan.id, uid, plan.wave, ok ? null : 'skipped', ok ? null : String((r as { error?: string }).error ?? 'could not be offered').slice(0, 200),
        ]);
        offered.add(uid);
        if (ok) open--;
      }
      left = plan.pool.filter((u) => !offered.has(u));
    }
    const stillPending = (await c.query('SELECT count(*)::int AS n FROM shift_wave_offers WHERE plan_id = $1 AND outcome IS NULL', [plan.id])).rows[0].n as number;
    const waitMin = plan.wave === 1 ? cfg.wait1Min : cfg.wait2Min;
    const timeUp = now >= new Date(plan.wave_started_at).getTime() + waitMin * 60_000;
    const exhausted = open > 0 && !left.length && !stillPending;
    if (!timeUp && !exhausted) return; // this wave is still running
    if (open <= 0 && !timeUp) return;
    // Move on: unanswered offers are withdrawn, then the next wave.
    await withdrawPending(c, tid, plan, 'not answered before the next wave');
    if (plan.wave === 1 && cfg.wave2) {
      const next = (await rankForShift(c, plan.shift_id)).map((r) => r.user_id).filter((u) => !offered.has(u));
      plan.wave = 2; plan.pool = next; plan.wave_started_at = new Date();
      await c.query('UPDATE shift_wave_plans SET wave = 2, pool = $2, wave_started_at = now(), updated_at = now() WHERE id = $1', [plan.id, next]);
      continue;
    }
    return lastCall(plan.wave === 1 ? 'Wave 1 is over.' : 'Both waves are over.');
  }
}

/** Start (or restart) waves on a shift. */
export async function startWaves(c: PoolClient, tid: string, by: string, shiftId: string, cfg: WaveConfig): Promise<{ code: number; error?: string; planId?: string }> {
  const s = await seats(c, shiftId);
  if (!s) return { code: 404, error: 'Shift not found' };
  if (s.staffing_draft) return { code: 409, error: 'This event is being built quietly. Publish the crew first, then start waves.' };
  if (new Date(s.starts_at).getTime() <= Date.now()) return { code: 409, error: 'This shift has already started.' };
  if (s.taken >= s.headcount) return { code: 409, error: 'Every spot on this shift is already taken.' };
  if (Date.now() >= new Date(s.starts_at).getTime() - cfg.answerByHours * 3600_000) return { code: 409, error: 'The answer-by time is already in the past. Pick a shorter one.' };
  const ranked = await rankForShift(c, shiftId);
  if (!ranked.length) return { code: 409, error: 'Nobody qualified is free for this shift.' };
  await c.query('DELETE FROM shift_wave_plans WHERE shift_id = $1', [shiftId]);
  const id = (
    await c.query('INSERT INTO shift_wave_plans (tenant_id, shift_id, config, pool, started_by) VALUES ($1,$2,$3,$4,$5) RETURNING id', [tid, shiftId, JSON.stringify(cfg), ranked.slice(0, cfg.topN).map((r) => r.user_id), by])
  ).rows[0].id as string;
  await audit(c, tid, by, 'shift.waves_start', 'shift', shiftId, cfg);
  await advancePlan(c, tid, id);
  return { code: 201, planId: id };
}

/** Background sweep: every active plan in every company. */
export async function runWaves(): Promise<number> {
  const { rows: tenants } = await pool.query('SELECT id FROM notify_tenants()');
  let n = 0;
  for (const t of tenants) {
    const ids = await withTenant(t.id, async (c) => (await c.query("SELECT id FROM shift_wave_plans WHERE status = 'active'")).rows.map((r) => r.id as string)).catch(() => [] as string[]);
    for (const id of ids) {
      await withTenant(t.id, (c) => advancePlan(c, t.id, id)).catch((e) => console.error('wave plan error', id, e?.message ?? e));
      n++;
    }
  }
  return n;
}
