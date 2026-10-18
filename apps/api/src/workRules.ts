import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Rules } from './pay';

/**
 * Work-rule sets: the pay rules of a union local or a client contract, on top of the company rules.
 * Blank (null) fields fall back to the company rules / the event's state; everything else replaces them.
 */
const pct = z.number().min(0).max(300).nullable().default(null);
export const workRulesSchema = z.object({
  // Overtime: after this many hours worked on the job in a day (and double time after dtAfter), at these multipliers.
  otAfter: z.number().min(1).max(24).nullable().default(null),
  dtAfter: z.number().min(1).max(24).nullable().default(null),
  otMult: z.number().min(1).max(4).nullable().default(null),
  dtMult: z.number().min(1).max(4).nullable().default(null),
  // Premium % for hours in these windows (the highest applies; overtime and premium don't stack).
  premiums: z.object({ nightPct: pct, saturdayPct: pct, sundayPct: pct, holidayPct: pct }).default({ nightPct: null, saturdayPct: null, sundayPct: null, holidayPct: null }),
  // Paid at least this many hours a call when the shift has no minimum call of its own.
  minCallH: z.number().min(0.5).max(12).nullable().default(null),
  // Punch rounding: to the nearest N minutes, or in the worker's favor (in rounds down, out rounds up).
  rounding: z.object({ minutes: z.union([z.literal(0), z.literal(5), z.literal(6), z.literal(10), z.literal(15), z.literal(30)]), mode: z.enum(['nearest', 'worker']) }).default({ minutes: 0, mode: 'nearest' }),
  // Meal penalty: worked `afterH` hours without a break of at least `breakMin` minutes; one penalty per `stepMin`
  // after that until the break. Amounts in dollars per penalty, the last one repeating (e.g. 10, 12.50, 15).
  meal: z.object({
    afterH: z.number().min(1).max(12),
    breakMin: z.number().int().min(10).max(120),
    stepMin: z.number().int().min(15).max(120),
    amounts: z.array(z.number().min(0).max(1000)).min(1).max(10),
  }).nullable().default(null),
  // Turnaround: fewer than `restH` hours off between calls; the hours worked inside the rest period are paid at `mult`.
  turnaround: z.object({ restH: z.number().min(4).max(24), mult: z.number().min(1).max(4) }).nullable().default(null),
  // Cancellation: a confirmed call cut with less than `noticeH` hours' notice is paid `payH` hours (or a day rate).
  cancellation: z.object({ noticeH: z.number().min(1).max(168), payH: z.number().min(0.5).max(12) }).nullable().default(null),
});
export type WorkRules = z.infer<typeof workRulesSchema>;
export const parseRules = (v: unknown): WorkRules => workRulesSchema.parse(v ?? {});

/** A gap of at least this long between two punches is a rest between calls, not a meal break. */
export const REST_GAP_H = 3;

/** The rule set each event uses: the event's own, else its customer's, else the company default (or none). */
export async function rulesForEvents(c: PoolClient, eventIds: string[]): Promise<Map<string, { id: string; name: string; rules: WorkRules } | null>> {
  const out = new Map<string, { id: string; name: string; rules: WorkRules } | null>();
  if (!eventIds.length) return out;
  const rows = (
    await c.query(
      `SELECT e.id AS event_id, w.id, w.name, w.config
         FROM events e LEFT JOIN customers cu ON cu.id = e.customer_id
         LEFT JOIN LATERAL (
           SELECT w.* FROM work_rule_sets w
            WHERE w.id = COALESCE(e.rule_set_id, cu.rule_set_id) OR (e.rule_set_id IS NULL AND cu.rule_set_id IS NULL AND w.is_default)
            ORDER BY (w.id = e.rule_set_id) DESC, (w.id = cu.rule_set_id) DESC LIMIT 1
         ) w ON true
        WHERE e.id = ANY($1::uuid[])`,
      [eventIds],
    )
  ).rows;
  for (const r of rows) {
    let rules: WorkRules | null = null;
    try { rules = r.id ? parseRules(r.config) : null; } catch { rules = null; }
    out.set(r.event_id, r.id && rules ? { id: r.id, name: r.name, rules } : null);
  }
  return out;
}

/** The company rules with this set's premiums laid over them. */
export function withPremiums(rules: Rules, w: WorkRules | null | undefined): Rules {
  if (!w) return rules;
  const p = w.premiums;
  return {
    ...rules,
    nightPct: p.nightPct ?? rules.nightPct,
    saturdayPct: p.saturdayPct ?? rules.saturdayPct,
    sundayPct: p.sundayPct ?? rules.sundayPct,
    holidayPct: p.holidayPct ?? rules.holidayPct,
  };
}

/** Rounded punch times. */
export function roundPunches(w: WorkRules | null | undefined, inAt: Date, outAt: Date): { in: Date; out: Date; rounded: boolean } {
  const m = w?.rounding?.minutes ?? 0;
  if (!m) return { in: inAt, out: outAt, rounded: false };
  const step = m * 60_000;
  const near = (d: Date) => new Date(Math.round(+d / step) * step);
  const i = w!.rounding.mode === 'worker' ? new Date(Math.floor(+inAt / step) * step) : near(inAt);
  let o = w!.rounding.mode === 'worker' ? new Date(Math.ceil(+outAt / step) * step) : near(outAt);
  if (+o <= +i) o = new Date(+i + step);
  return { in: i, out: o, rounded: +i !== +inAt || +o !== +outAt };
}

/**
 * Meal penalties over one person's punches on one job in one day (sorted, non-overlapping). A gap of at least
 * `breakMin` is a meal break and restarts the clock. Returns how many penalties and their total.
 */
export function mealPenalties(meal: NonNullable<WorkRules['meal']>, spans: { in: Date; out: Date }[]): { count: number; amount: number } {
  let count = 0, amount = 0, runStart: number | null = null, lastOut = 0;
  const settle = (end: number) => {
    if (runStart === null) return;
    const firstDue = runStart + meal.afterH * 3600_000;
    if (end > firstDue) {
      const n = 1 + Math.floor((end - firstDue - 1) / (meal.stepMin * 60_000));
      for (let k = 0; k < n; k++) {
        amount += meal.amounts[Math.min(count, meal.amounts.length - 1)];
        count++;
      }
    }
  };
  for (const s of spans) {
    const a = +s.in, b = +s.out;
    if (runStart === null) runStart = a;
    else if (a - lastOut >= meal.breakMin * 60_000) { settle(lastOut); runStart = a; }
    lastOut = Math.max(lastOut, b);
  }
  settle(lastOut);
  return { count, amount: Math.round(amount * 100) / 100 };
}

/** Hours of this punch that fall inside the turnaround (rest) period after the previous call ended. */
export function turnaroundHours(t: NonNullable<WorkRules['turnaround']>, prevOut: Date | null, inAt: Date, outAt: Date): number {
  if (!prevOut) return 0;
  const gap = +inAt - +prevOut;
  if (gap < REST_GAP_H * 3600_000 || gap >= t.restH * 3600_000) return 0;
  const restEnds = +prevOut + t.restH * 3600_000;
  return Math.max(0, Math.round(((Math.min(+outAt, restEnds) - +inAt) / 3600_000) * 100) / 100);
}

/**
 * A confirmed person is taken off a call (removed, shift deleted, event canceled). When the rule set pays
 * cancellations and the notice was too short, record the pay (paid with the next payroll for that date).
 */
export async function recordCancellation(c: PoolClient, tid: string, actorId: string | null, a: { userId: string; status: string; shiftId: string }): Promise<boolean> {
  if (a.status !== 'accepted') return false;
  const s = (await c.query(
    `SELECT s.id, s.event_id, s.role_name, s.starts_at, s.ends_at, s.pay_type, e.name AS event_name, t.timezone
       FROM shifts s JOIN events e ON e.id = s.event_id JOIN tenants t ON t.id = s.tenant_id WHERE s.id = $1`, [a.shiftId])).rows[0];
  if (!s) return false;
  const w = (await rulesForEvents(c, [s.event_id])).get(s.event_id);
  const cx = w?.rules.cancellation;
  if (!cx) return false;
  const now = Date.now(), start = +new Date(s.starts_at);
  if (start <= now - 60_000 || start - now >= cx.noticeH * 3600_000) return false; // already worked/started, or enough notice
  if ((await c.query('SELECT 1 FROM time_entries t JOIN shift_assignments x ON x.id = t.assignment_id WHERE x.shift_id = $1 AND x.user_id = $2 LIMIT 1', [s.id, a.userId])).rowCount) return false;
  const len = (+new Date(s.ends_at) - start) / 3600_000;
  const hours = Math.round(Math.min(cx.payH, len) * 100) / 100;
  await c.query(
    `INSERT INTO pay_adjustments (tenant_id, user_id, event_id, event_name, role_name, kind, work_date, hours, note, created_by)
     VALUES ($1,$2,$3,$4,$5,'cancellation', ($6::timestamptz AT TIME ZONE $7)::date, $8, $9, $10)`,
    [tid, a.userId, s.event_id, s.event_name, s.role_name, s.starts_at, s.timezone, hours,
      `Cancelled with ${Math.max(0, Math.round((start - now) / 360_000) / 10)} h notice (${w!.name}: under ${cx.noticeH} h pays ${cx.payH} h)`, actorId],
  );
  return true;
}
