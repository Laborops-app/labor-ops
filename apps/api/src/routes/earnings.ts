import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth';
import { withTenant } from '../db';
import { payrollSummary } from '../payroll';
import { estimateShift, loadRates, loadRules } from '../pay';
import { currentPeriods, loadPayPeriod, periodFor } from '../payPeriods';
import { localDate } from '../accounting';

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * A crew member's earnings for one pay period:
 *  - payroll: approved time, priced exactly as the payroll export (overtime, day rates, minimum calls)
 *  - pending: time worked but not approved yet, at the expected rate
 *  - scheduled: accepted shifts still to come in the period, estimated
 *  - estimated: all three together
 */
export async function earningsRoutes(app: FastifyInstance) {
  app.get('/api/pay-periods', { preHandler: authenticate }, async (req) => withTenant(req.user.tid, (c) => currentPeriods(c)));

  app.get('/api/my/earnings', { preHandler: authenticate }, async (req) => {
    const { offset } = z.object({ offset: z.coerce.number().int().min(-26).max(4).default(0) }).parse(req.query);
    return withTenant(req.user.tid, async (c) => {
      const pp = await loadPayPeriod(c);
      const today = localDate(pp.tz, new Date());
      const period = periodFor(pp, today, offset);
      const rules = await loadRules(c);
      const rates = await loadRates(c);
      const me = (await payrollSummary(c, period.from, period.to)).people.find((p) => p.userId === req.user.sub);
      const payroll = {
        hours: r2(me?.hours ?? 0), regular: r2(me?.regular ?? 0), overtime: r2(me?.overtime ?? 0), double: r2(me?.double ?? 0),
        gross: r2(me?.gross ?? 0), missingRate: !!me?.missingRate,
        entries: (me?.entries ?? []).filter((e) => e.date >= period.from && e.date <= period.to)
          .map((e) => ({ id: e.id, date: e.date, event: e.event, role: e.role, hours: e.hours, pay: e.pay, ot: e.ot, dt: e.dt, minCall: e.minCall ?? 0 })),
      };
      const range = [period.from, period.to, rules.tz];
      const inPeriod = (col: string) => `${col} >= $2::date::timestamp AT TIME ZONE $4 AND ${col} < ($3::date + 1)::timestamp AT TIME ZONE $4`;
      // Worked but waiting for approval
      const open = (
        await c.query(
          `SELECT t.id, t.clock_in, t.clock_out, t.status, s.id AS shift_id, s.role_name, e.name AS event_name
             FROM time_entries t JOIN shift_assignments a ON a.id = t.assignment_id JOIN shifts s ON s.id = a.shift_id JOIN events e ON e.id = s.event_id
            WHERE t.user_id = $1 AND t.status <> 'approved' AND ${inPeriod('t.clock_in')} ORDER BY t.clock_in`,
          [req.user.sub, ...range],
        )
      ).rows;
      const pending = [];
      for (const t of open) {
        const p = await estimateShift(c, rules, rates, t.role_name, t.clock_in, t.clock_out ?? new Date(), req.user.sub, t.shift_id);
        pending.push({ id: t.id, date: localDate(rules.tz, t.clock_in), event: t.event_name, role: t.role_name, hours: p.hours, pay: p.estimate, status: t.clock_out ? t.status : 'clocked in' });
      }
      // Accepted shifts still to come
      const ahead = (
        await c.query(
          `SELECT a.id, s.id AS shift_id, s.role_name, s.starts_at, s.ends_at, e.name AS event_name
             FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id JOIN events e ON e.id = s.event_id
            WHERE a.user_id = $1 AND a.status = 'accepted' AND s.ends_at > now() AND ${inPeriod('s.starts_at')}
              AND NOT EXISTS (SELECT 1 FROM time_entries t WHERE t.assignment_id = a.id) ORDER BY s.starts_at`,
          [req.user.sub, ...range],
        )
      ).rows;
      const scheduled = [];
      for (const s of ahead) {
        const p = await estimateShift(c, rules, rates, s.role_name, s.starts_at, s.ends_at, req.user.sub, s.shift_id);
        scheduled.push({ id: s.id, date: localDate(rules.tz, s.starts_at), starts_at: s.starts_at, event: s.event_name, role: s.role_name, hours: p.hours, pay: p.estimate });
      }
      const sum = (l: { pay: number | null }[]) => r2(l.reduce((n, x) => n + (x.pay ?? 0), 0));
      const sumH = (l: { hours: number }[]) => r2(l.reduce((n, x) => n + x.hours, 0));
      return {
        period: { ...period, offset, kind: pp.kind, current: offset === 0, past: period.to < today },
        payroll,
        pending: { hours: sumH(pending), pay: sum(pending), entries: pending },
        scheduled: { hours: sumH(scheduled), pay: sum(scheduled), shifts: scheduled },
        estimated: { hours: r2(payroll.hours + sumH(pending) + sumH(scheduled)), pay: r2(payroll.gross + sum(pending) + sum(scheduled)) },
        unpriced: [...pending, ...scheduled].some((x) => x.pay === null) || payroll.missingRate,
      };
    });
  });
}
