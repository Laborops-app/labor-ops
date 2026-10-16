import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { guard } from '../auth';
import { withTenant } from '../db';
import { payrollSummary, csvCell } from '../payroll';
import { byRoleKey, hoursBetween, roleKeyOf } from '../pay';
import type { PoolClient } from 'pg';

const r2 = (n: number) => Math.round(n * 100) / 100;
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export type EventReport = {
  id: string; name: string; customer: string | null; start: string; end: string;
  slots: number; filled: number; fillRate: number | null;
  scheduledHours: number; actualHours: number; approvedHours: number; unapproved: number;
  regular: number; overtime: number; double: number;
  laborCost: number; billed: number; quoted: number | null;
  /** Null when nothing is billed (no quote and no billing rates for its roles), so there is no margin to show. */
  margin: number | null; marginPct: number | null;
  budget: number | null; budgetLeft: number | null; noShows: number; late: number; autoClockOuts: number; offlinePunches: number;
};

/**
 * Reports v1: per event in the period — fill rate, scheduled vs worked hours, overtime, labor cost (approved time, the
 * same numbers as payroll), what it bills at the roles' billing rates, margin, and the labor budget.
 */
export async function buildReport(c: PoolClient, from: string, to: string) {
  const events = (
    await c.query(
      `SELECT e.id, e.name, e.start_date, e.end_date, e.labor_budget, cu.name AS customer
         FROM events e LEFT JOIN customers cu ON cu.id = e.customer_id
        WHERE e.start_date <= $2::date AND e.end_date >= $1::date ORDER BY e.start_date, lower(e.name)`,
      [from, to],
    )
  ).rows;
  const ids = events.map((e) => e.id);
  if (!ids.length) return { from, to, events: [] as EventReport[], totals: totalsOf([]) };

  const bill = byRoleKey((await c.query('SELECT name, bill_rate FROM skills')).rows, (r) => Number(r.bill_rate), (v) => v > 0);
  const billOf = (role: string) => bill.get(roleKeyOf(role)) ?? 0;

  // Slots and who filled them.
  const shifts = (
    await c.query(
      `SELECT s.event_id, s.headcount, s.starts_at, s.ends_at,
              (SELECT count(*)::int FROM shift_assignments a WHERE a.shift_id = s.id AND a.status = 'accepted') AS filled,
              (SELECT count(*)::int FROM shift_assignments a WHERE a.shift_id = s.id AND a.no_show_at IS NOT NULL) AS no_shows
         FROM shifts s WHERE s.event_id = ANY($1::uuid[])`,
      [ids],
    )
  ).rows;
  // Everything clocked (approved or not), for worked hours and billing.
  const entries = (
    await c.query(
      `SELECT s.event_id, s.role_name, s.starts_at, t.clock_in, t.clock_out, t.status, t.auto_clocked_out, (t.offline_in OR t.offline_out) AS offline
         FROM time_entries t JOIN shift_assignments a ON a.id = t.assignment_id JOIN shifts s ON s.id = a.shift_id
        WHERE s.event_id = ANY($1::uuid[]) AND t.clock_out IS NOT NULL`,
      [ids],
    )
  ).rows;
  const quotes = (
    await c.query(
      `SELECT q.event_id, sum(l.qty * l.hours * l.rate) * (1 + q.tax_pct / 100) - q.discount AS total
         FROM quotes q JOIN quote_lines l ON l.quote_id = q.id
        WHERE q.event_id = ANY($1::uuid[]) AND q.status = 'accepted' GROUP BY q.id`,
      [ids],
    )
  ).rows;
  // Labor cost from approved time, priced exactly like payroll (overtime, day rates, minimum calls).
  const minStart = events.reduce((m, e) => (e.start_date < m ? e.start_date : m), events[0].start_date);
  const maxEnd = events.reduce((m, e) => (e.end_date > m ? e.end_date : m), events[0].end_date);
  const iso = (d: any) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d));
  // A day either side: overnight shifts, and the company's time zone versus the calendar dates.
  const shift = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
  const pay = await payrollSummary(c, shift(iso(minStart) < from ? iso(minStart) : from, -1), shift(iso(maxEnd) > to ? iso(maxEnd) : to, 1));
  const payEntries = pay.people.flatMap((p) => p.entries);

  const out: EventReport[] = events.map((e) => {
    const sh = shifts.filter((s) => s.event_id === e.id);
    const slots = sh.reduce((n, s) => n + Number(s.headcount), 0);
    const filled = sh.reduce((n, s) => n + Math.min(Number(s.filled), Number(s.headcount)), 0);
    const scheduledHours = sh.reduce((n, s) => n + Number(s.filled) * hoursBetween(s.starts_at, s.ends_at), 0);
    const en = entries.filter((t) => t.event_id === e.id);
    const actualHours = en.reduce((n, t) => n + hoursBetween(t.clock_in, t.clock_out), 0);
    const billed = en.reduce((n, t) => n + hoursBetween(t.clock_in, t.clock_out) * billOf(t.role_name), 0);
    const pe = payEntries.filter((p) => p.eventId === e.id);
    const laborCost = pe.reduce((n, p) => n + (p.pay ?? 0), 0);
    const q = quotes.filter((x) => x.event_id === e.id);
    const quoted = q.length ? q.reduce((n, x) => n + Number(x.total), 0) : null;
    const revenue = quoted ?? billed;
    const budget = e.labor_budget === null ? null : Number(e.labor_budget);
    return {
      id: e.id, name: e.name, customer: e.customer, start: iso(e.start_date), end: iso(e.end_date),
      slots, filled, fillRate: slots ? r2(filled / slots) : null,
      scheduledHours: r2(scheduledHours), actualHours: r2(actualHours), approvedHours: r2(pe.reduce((n, p) => n + p.hours, 0)),
      unapproved: en.filter((t) => t.status !== 'approved').length,
      regular: r2(pe.reduce((n, p) => n + p.reg, 0)), overtime: r2(pe.reduce((n, p) => n + p.ot, 0)), double: r2(pe.reduce((n, p) => n + p.dt, 0)),
      laborCost: r2(laborCost), billed: r2(billed), quoted: quoted === null ? null : r2(quoted),
      margin: revenue > 0 ? r2(revenue - laborCost) : null, marginPct: revenue > 0 ? r2((revenue - laborCost) / revenue) : null,
      budget, budgetLeft: budget === null ? null : r2(budget - laborCost),
      noShows: sh.reduce((n, s) => n + Number(s.no_shows), 0),
      late: en.filter((t) => +new Date(t.clock_in) - +new Date(t.starts_at) > 10 * 60_000).length,
      autoClockOuts: en.filter((t) => t.auto_clocked_out).length,
      offlinePunches: en.filter((t) => t.offline).length,
    };
  });
  return { from, to, events: out, totals: totalsOf(out) };
}

function totalsOf(list: EventReport[]) {
  const sum = (k: keyof EventReport) => r2(list.reduce((n, e) => n + (Number(e[k]) || 0), 0));
  const slots = sum('slots'), filled = sum('filled');
  // Margin only over events that bill something; the cost of the others is reported separately.
  const billedEvents = list.filter((e) => e.margin !== null);
  const revenue = r2(billedEvents.reduce((n, e) => n + (e.quoted ?? e.billed), 0));
  const cost = r2(billedEvents.reduce((n, e) => n + e.laborCost, 0));
  const budgeted = list.filter((e) => e.budget !== null);
  return {
    events: list.length, slots, filled, fillRate: slots ? r2(filled / slots) : null,
    scheduledHours: sum('scheduledHours'), actualHours: sum('actualHours'), overtime: sum('overtime'), double: sum('double'),
    laborCost: sum('laborCost'), revenue, margin: billedEvents.length ? r2(revenue - cost) : null, marginPct: revenue > 0 ? r2((revenue - cost) / revenue) : null,
    unbilledEvents: list.length - billedEvents.length, unbilledCost: r2(list.filter((e) => e.margin === null).reduce((n, e) => n + e.laborCost, 0)),
    budget: budgeted.length ? r2(budgeted.reduce((n, e) => n + e.budget!, 0)) : null,
    budgetCost: r2(budgeted.reduce((n, e) => n + e.laborCost, 0)),
    noShows: sum('noShows'), late: sum('late'), unapproved: sum('unapproved'),
  };
}

export async function reportRoutes(app: FastifyInstance) {
  const staff = guard('admin', 'manager');
  const viewers = guard('admin', 'manager', 'hr');
  const range = z.object({ from: ymd, to: ymd }).refine((r) => r.from <= r.to, 'The start must be before the end');

  app.get('/api/reports', { preHandler: viewers }, async (req, reply) => {
    const q = range.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: q.error.issues[0]?.message ?? 'Pick a date range' });
    return withTenant(req.user.tid, (c) => buildReport(c, q.data.from, q.data.to));
  });

  app.get('/api/reports/events.csv', { preHandler: viewers }, async (req, reply) => {
    const q = range.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'Pick a date range' });
    const r = await withTenant(req.user.tid, (c) => buildReport(c, q.data.from, q.data.to));
    const head = ['Event', 'Customer', 'Start', 'End', 'Slots', 'Filled', 'Fill rate', 'Scheduled h', 'Worked h', 'Approved h', 'Regular h', 'OT h', 'DT h',
      'Labor cost', 'Billed at rates', 'Accepted quote', 'Margin', 'Margin %', 'Labor budget', 'Budget left', 'No-shows', 'Late', 'Auto clock-outs', 'Unapproved'];
    const pct = (v: number | null) => (v === null ? '' : `${Math.round(v * 100)}%`);
    const lines = r.events.map((e) => [e.name, e.customer ?? '', e.start, e.end, e.slots, e.filled, pct(e.fillRate), e.scheduledHours, e.actualHours, e.approvedHours,
      e.regular, e.overtime, e.double, e.laborCost.toFixed(2), e.billed.toFixed(2), e.quoted?.toFixed(2) ?? '', e.margin?.toFixed(2) ?? '', pct(e.marginPct),
      e.budget?.toFixed(2) ?? '', e.budgetLeft?.toFixed(2) ?? '', e.noShows, e.late, e.autoClockOuts, e.unapproved].map(csvCell).join(','));
    reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="laborops-events-${q.data.from}-to-${q.data.to}.csv"`);
    return [head.map(csvCell).join(','), ...lines].join('\r\n') + '\r\n';
  });

  // The labor budget for one event (shown on the event page and in reports).
  app.put('/api/events/:id/budget', { preHandler: staff }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { budget } = z.object({ budget: z.number().min(0).max(100_000_000).nullable() }).parse(req.body);
    const r = await withTenant(req.user.tid, (c) => c.query('UPDATE events SET labor_budget = $2 WHERE id = $1 RETURNING labor_budget', [id, budget]));
    if (!r.rowCount) return reply.code(404).send({ error: 'Event not found' });
    return { budget: r.rows[0].labor_budget === null ? null : Number(r.rows[0].labor_budget) };
  });
}
