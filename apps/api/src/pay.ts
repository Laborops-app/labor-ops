import type { PoolClient } from 'pg';

/** Hourly rates from the Roles & pay rates list, keyed by lower-case role name. */
export async function loadRates(c: PoolClient): Promise<Map<string, number>> {
  const { rows } = await c.query('SELECT lower(name) AS n, pay_rate FROM skills');
  return new Map(rows.map((r: any) => [r.n as string, Number(r.pay_rate)]));
}

/** A shift's role may carry a suffix such as "Audio (Lead)"; the rate is looked up by the base name. A rate of 0 means "not set". */
export function rateFor(rates: Map<string, number>, role: string): number | undefined {
  const r = rates.get(role.replace(/\s*\(.*\)\s*$/, '').trim().toLowerCase());
  return r && r > 0 ? r : undefined;
}

export const hoursBetween = (a: Date | string, b: Date | string) => Math.max(0, Math.round(((+new Date(b) - +new Date(a)) / 3600_000) * 100) / 100);
export const money = (n: number) => `$${n.toFixed(2)}`;

/** Scheduled hours x hourly rate. It is an estimate: actual pay follows approved time. */
export function estimate(rate: number | undefined, startsAt: Date | string, endsAt: Date | string) {
  const hours = hoursBetween(startsAt, endsAt);
  return { hours, rate: rate ?? null, estimate: rate ? Math.round(hours * rate * 100) / 100 : null };
}

// ---------- labor rules: rest, overtime, premiums ----------
export type Rules = {
  tz: string; minRest: number; maxDaily: number; dailyOt: number; weeklyOt: number; otMult: number;
  nightStart: number; nightEnd: number; nightPct: number; sundayPct: number; holidayPct: number; holidays: string[];
};
const mins = (t: string) => { const [h, m] = String(t).split(':'); return Number(h) * 60 + Number(m || 0); };

export async function loadRules(c: PoolClient): Promise<Rules> {
  const t = (await c.query(
    `SELECT t.timezone, r.min_rest_hours, r.max_daily_hours, r.daily_ot_after, r.weekly_ot_after, r.ot_multiplier,
            r.night_start::text, r.night_end::text, r.night_premium_pct, r.sunday_premium_pct, r.holiday_premium_pct,
            ARRAY(SELECT to_char(d,'YYYY-MM-DD') FROM unnest(COALESCE(r.holidays,'{}'::date[])) d ORDER BY d) AS holidays
       FROM tenants t LEFT JOIN labor_rules r ON r.tenant_id = t.id LIMIT 1`)).rows[0];
  const n = (v: any, d: number) => (v === null || v === undefined ? d : Number(v));
  return {
    tz: t.timezone, minRest: n(t.min_rest_hours, 8), maxDaily: n(t.max_daily_hours, 14), dailyOt: n(t.daily_ot_after, 0),
    weeklyOt: n(t.weekly_ot_after, 40), otMult: n(t.ot_multiplier, 1.5),
    nightStart: mins(t.night_start ?? '22:00'), nightEnd: mins(t.night_end ?? '06:00'),
    nightPct: n(t.night_premium_pct, 0), sundayPct: n(t.sunday_premium_pct, 0), holidayPct: n(t.holiday_premium_pct, 0),
    holidays: t.holidays ?? [],
  };
}

/** Hours this person already works in the company-time-zone week (Mon-Sun) before `startsAt`. */
export async function priorWeekHours(c: PoolClient, rules: Rules, userId: string, shiftId: string | null, startsAt: Date | string): Promise<number> {
  const r = await c.query(
    `WITH w AS (SELECT (date_trunc('week', $2::timestamptz AT TIME ZONE $3) AT TIME ZONE $3) AS ws)
     SELECT COALESCE(SUM(GREATEST(0, EXTRACT(epoch FROM (LEAST(s.ends_at, $2::timestamptz) - GREATEST(s.starts_at, w.ws))))), 0) / 3600 AS h
       FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id, w
      WHERE a.user_id = $1 AND a.status <> 'declined' AND ($4::uuid IS NULL OR s.id <> $4)
        AND s.starts_at < $2::timestamptz AND s.ends_at > w.ws`,
    [userId, startsAt, rules.tz, shiftId],
  );
  return Number(r.rows[0].h);
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function localParts(tz: string, d: Date) {
  let f = fmtCache.get(tz);
  if (!f) { f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' }); fmtCache.set(tz, f); }
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(d)) p[x.type] = x.value;
  return { ymd: `${p.year}-${p.month}-${p.day}`, min: Number(p.hour) * 60 + Number(p.minute), sunday: p.weekday === 'Sun' };
}

export type Priced = { hours: number; rate: number | null; estimate: number | null; otHours: number; premiumHours: number; notes: string[] };

/** Price one shift: scheduled hours x rate with overtime (daily/weekly) and night / Sunday / holiday premiums. Overtime and premium do not stack: the larger multiplier applies. */
export function priceShift(rules: Rules | null, rate: number | undefined, startsAt: Date | string, endsAt: Date | string, priorWeek = 0): Priced {
  const hours = hoursBetween(startsAt, endsAt);
  if (!rate) return { hours, rate: null, estimate: null, otHours: 0, premiumHours: 0, notes: [] };
  if (!rules) return { hours, rate, estimate: Math.round(hours * rate * 100) / 100, otHours: 0, premiumHours: 0, notes: [] };
  const step = 5, h = step / 60;
  let total = 0, ot = 0, prem = 0, week = Math.round(priorWeek * 60), day = 0, curDay = '';
  const dailyOtM = Math.round(rules.dailyOt * 60), weeklyOtM = Math.round(rules.weeklyOt * 60);
  const notes = new Set<string>();
  for (let t = +new Date(startsAt); t < +new Date(endsAt); t += step * 60000) {
    const p = localParts(rules.tz, new Date(t + 30000));
    if (p.ymd !== curDay) { curDay = p.ymd; day = 0; }
    const isOt = (dailyOtM > 0 && day >= dailyOtM) || (weeklyOtM > 0 && week >= weeklyOtM);
    const night = rules.nightPct > 0 && (rules.nightStart <= rules.nightEnd ? p.min >= rules.nightStart && p.min < rules.nightEnd : p.min >= rules.nightStart || p.min < rules.nightEnd);
    const hol = rules.holidayPct > 0 && rules.holidays.includes(p.ymd);
    const sun = rules.sundayPct > 0 && p.sunday;
    const pct = Math.max(night ? rules.nightPct : 0, sun ? rules.sundayPct : 0, hol ? rules.holidayPct : 0);
    const mult = Math.max(isOt ? rules.otMult : 1, 1 + pct / 100);
    if (isOt) { ot += h; notes.add('overtime'); }
    if (pct > 0) { prem += h; notes.add(hol ? 'holiday' : sun ? 'Sunday' : 'night'); }
    total += h * rate * mult; day += step; week += step;
  }
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return { hours, rate, estimate: r2(total), otHours: r2(ot), premiumHours: r2(prem), notes: [...notes] };
}

/** Estimate for a specific person (counts the hours they already work that week) or, without a user, for the shift on its own. */
export async function estimateShift(c: PoolClient, rules: Rules, rates: Map<string, number>, role: string, startsAt: Date | string, endsAt: Date | string, userId?: string | null, shiftId: string | null = null): Promise<Priced> {
  const prior = userId ? await priorWeekHours(c, rules, userId, shiftId, startsAt) : 0;
  // A rate set on this one shift replaces the role's rate.
  const override = shiftId ? Number((await c.query('SELECT pay_rate_override FROM shifts WHERE id = $1', [shiftId])).rows[0]?.pay_rate_override ?? 0) : 0;
  return priceShift(rules, override > 0 ? override : rateFor(rates, role), startsAt, endsAt, prior);
}

export const fmtH = (n: number) => `${Math.round(n * 10) / 10} h`;

/** Shifts separated by less than this are one continuous work period (split shifts, meal breaks); the rest rule applies to the break between work periods. */
export const CONTINUOUS_GAP_H = 2;

/** Rule checks for putting `userId` on a shift. `blocks` need an override; `warns` are informational. */
export async function checkRules(c: PoolClient, rules: Rules, userId: string, shiftId: string, startsAt: Date | string, endsAt: Date | string, name: string) {
  const blocks: string[] = [], warns: string[] = [];
  const near = (await c.query(
    `SELECT s.starts_at, s.ends_at, s.role_name FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id
      WHERE a.user_id = $1 AND a.status <> 'declined' AND s.id <> $2
        AND s.ends_at <= $3::timestamptz AND s.ends_at > $3::timestamptz - make_interval(hours => $5::int)
      UNION ALL
     SELECT s.starts_at, s.ends_at, s.role_name FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id
      WHERE a.user_id = $1 AND a.status <> 'declined' AND s.id <> $2
        AND s.starts_at >= $4::timestamptz AND s.starts_at < $4::timestamptz + make_interval(hours => $5::int)`,
    [userId, shiftId, startsAt, endsAt, Math.ceil(rules.minRest)],
  )).rows;
  for (const n of near) {
    const gap = +new Date(n.ends_at) <= +new Date(startsAt) ? (+new Date(startsAt) - +new Date(n.ends_at)) / 3600000 : (+new Date(n.starts_at) - +new Date(endsAt)) / 3600000;
    if (gap >= CONTINUOUS_GAP_H && gap < rules.minRest) { blocks.push(`${name} would get only ${fmtH(gap)} of rest between shifts (company minimum is ${fmtH(rules.minRest)})`); break; }
  }
  if (rules.maxDaily > 0) {
    const d = (await c.query(
      `WITH d AS (SELECT (($3::timestamptz AT TIME ZONE $4)::date) AS day)
       SELECT COALESCE(SUM(EXTRACT(epoch FROM (LEAST(s.ends_at, (d.day + 1) AT TIME ZONE $4) - GREATEST(s.starts_at, d.day AT TIME ZONE $4))) ) / 3600, 0) AS h
         FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id, d
        WHERE a.user_id = $1 AND a.status <> 'declined' AND s.id <> $2
          AND s.starts_at < (d.day + 1) AT TIME ZONE $4 AND s.ends_at > d.day AT TIME ZONE $4`,
      [userId, shiftId, startsAt, rules.tz],
    )).rows[0];
    const total = Number(d.h) + hoursBetween(startsAt, endsAt);
    if (total > rules.maxDaily) blocks.push(`${name} would work ${fmtH(total)} that day (company maximum is ${fmtH(rules.maxDaily)})`);
  }
  if (rules.weeklyOt > 0) {
    const prior = await priorWeekHours(c, rules, userId, shiftId, startsAt);
    const total = prior + hoursBetween(startsAt, endsAt);
    if (total > rules.weeklyOt) warns.push(`${name} will reach ${fmtH(total)} this week, so ${fmtH(total - Math.max(prior, rules.weeklyOt))} will be overtime`);
  }
  return { blocks, warns };
}
