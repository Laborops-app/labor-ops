import type { PoolClient } from 'pg';
import { payrollSummary } from './payroll';
import { byRoleKey, hoursBetween, roleKeyOf } from './pay';

const r2 = (n: number) => Math.round(n * 100) / 100;
const iso = (d: any) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const dayShift = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const LATE_MIN = 10;

/**
 * One event in depth for the Reports page: money, hours and overtime, staffing and reliability, and each person.
 * Labor cost is approved time priced exactly like payroll; worked hours count every completed punch.
 */
export async function eventReport(c: PoolClient, eventId: string) {
  const e = (
    await c.query(
      `SELECT e.id, e.name, e.venue, e.start_date, e.end_date, e.labor_budget, e.pipeline_status, e.rentman_project_id, cu.name AS customer, t.timezone
         FROM events e LEFT JOIN customers cu ON cu.id = e.customer_id CROSS JOIN tenants t WHERE e.id = $1 AND t.id = e.tenant_id`,
      [eventId],
    )
  ).rows[0];
  if (!e) return null;
  const tz: string = e.timezone || 'UTC';
  const start = iso(e.start_date), end = iso(e.end_date);
  const localDay = (ts: any) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts));

  const skills = (await c.query('SELECT name, bill_rate, group_id, (SELECT name FROM skill_groups g WHERE g.id = skills.group_id) AS grp FROM skills')).rows;
  const bill = byRoleKey(skills, (r) => Number(r.bill_rate), (v) => v > 0);
  const groupOf = new Map(skills.map((s) => [roleKeyOf(s.name), (s.grp as string | null) ?? null]));
  const billOf = (role: string) => bill.get(roleKeyOf(role)) ?? 0;

  const shifts = (await c.query('SELECT id, role_name, starts_at, ends_at, headcount, bill_rate_override FROM shifts WHERE event_id = $1 ORDER BY starts_at', [eventId])).rows;
  const asg = (
    await c.query(
      `SELECT a.id, a.user_id, a.shift_id, a.status, a.created_at, a.no_show_at, a.is_lead, u.name, s.role_name, s.starts_at, s.ends_at
         FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id JOIN users u ON u.id = a.user_id WHERE s.event_id = $1`,
      [eventId],
    )
  ).rows;
  const entries = (
    await c.query(
      `SELECT t.id, t.user_id, t.clock_in, t.clock_out, t.status, t.auto_clocked_out, s.role_name, s.starts_at, s.ends_at, a.shift_id
         FROM time_entries t JOIN shift_assignments a ON a.id = t.assignment_id JOIN shifts s ON s.id = a.shift_id
        WHERE s.event_id = $1 AND t.clock_out IS NOT NULL`,
      [eventId],
    )
  ).rows;
  const breaks = (
    await c.query(
      `SELECT b.kind, b.started_at, b.ended_at FROM time_breaks b JOIN shift_assignments a ON a.id = b.assignment_id JOIN shifts s ON s.id = a.shift_id
        WHERE s.event_id = $1 AND b.ended_at IS NOT NULL`,
      [eventId],
    )
  ).rows;
  // Answers to offers, from the audit trail (when each one was offered and answered).
  const answers = (
    await c.query(
      `SELECT l.entity_id, l.action, l.created_at FROM audit_logs l
        WHERE l.entity = 'assignment' AND l.action IN ('assignment.accepted', 'assignment.declined', 'assignment.delete')
          AND l.entity_id = ANY($1::text[])`,
      [asg.map((a) => a.id)],
    )
  ).rows;
  // People taken off a shift after being offered or booked (the offers that had to be replaced).
  const removed = (
    await c.query(
      `SELECT count(*)::int AS n FROM audit_logs d
        WHERE d.action = 'assignment.delete'
          AND EXISTS (SELECT 1 FROM audit_logs c2 WHERE c2.action = 'assignment.create' AND c2.entity_id = d.entity_id AND (c2.detail->>'shiftId') = ANY($1::text[]))`,
      [shifts.map((s) => s.id)],
    )
  ).rows[0]?.n ?? 0;
  const reviews = (
    await c.query('SELECT r.user_id, avg(r.stars)::float AS stars, count(*)::int AS n FROM crew_reviews r WHERE r.shift_id = ANY($1::uuid[]) GROUP BY r.user_id', [shifts.map((s) => s.id)])
  ).rows;
  const quote = (
    await c.query(
      `SELECT q.id, q.number, q.source, sum(coalesce(l.amount, l.qty * l.hours * l.rate)) * (1 + q.tax_pct / 100) - q.discount AS total
         FROM quotes q JOIN quote_lines l ON l.quote_id = q.id WHERE q.event_id = $1 AND q.status = 'accepted'
        GROUP BY q.id ORDER BY q.created_at DESC LIMIT 1`,
      [eventId],
    )
  ).rows[0];
  const invoiced = (await c.query('SELECT coalesce(sum(total), 0)::float AS t, count(*)::int AS n FROM event_invoices WHERE event_id = $1', [eventId]).catch(() => ({ rows: [{ t: 0, n: 0 }] }))).rows[0];

  // Payroll pricing for approved time (a day either side for overnight shifts and time zones).
  const pay = await payrollSummary(c, dayShift(start, -1), dayShift(end, 1));
  const pe = pay.people.flatMap((p) => p.entries.map((x) => ({ ...x, userId: p.userId, name: p.name }))).filter((x) => x.eventId === eventId);

  // ---------- money ----------
  const laborCost = r2(pe.reduce((n, p) => n + (p.pay ?? 0), 0));
  const billed = r2(entries.reduce((n, t) => {
    const s = shifts.find((x) => x.id === t.shift_id);
    const rate = Number(s?.bill_rate_override) > 0 ? Number(s.bill_rate_override) : billOf(t.role_name);
    return n + hoursBetween(t.clock_in, t.clock_out) * rate;
  }, 0));
  const quoted = quote ? r2(Number(quote.total)) : null;
  const revenue = quoted ?? billed;
  const budget = e.labor_budget === null ? null : Number(e.labor_budget);
  const costByRoleMap = new Map<string, { role: string; group: string | null; cost: number; hours: number; ot: number; billed: number }>();
  for (const p of pe) {
    const k = p.role || 'Other';
    const cur = costByRoleMap.get(k) ?? { role: k, group: groupOf.get(roleKeyOf(k)) ?? null, cost: 0, hours: 0, ot: 0, billed: 0 };
    cur.cost += p.pay ?? 0; cur.hours += p.hours; cur.ot += p.ot + p.dt;
    costByRoleMap.set(k, cur);
  }
  for (const t of entries) {
    const k = t.role_name || 'Other';
    const cur = costByRoleMap.get(k) ?? { role: k, group: groupOf.get(roleKeyOf(k)) ?? null, cost: 0, hours: 0, ot: 0, billed: 0 };
    cur.billed += hoursBetween(t.clock_in, t.clock_out) * billOf(t.role_name);
    costByRoleMap.set(k, cur);
  }
  const costByRole = [...costByRoleMap.values()].map((x) => ({ ...x, cost: r2(x.cost), hours: r2(x.hours), ot: r2(x.ot), billed: r2(x.billed) })).sort((a, b) => b.cost - a.cost);

  // ---------- hours ----------
  const days: string[] = [];
  for (let d = start; d <= end && days.length < 62; d = dayShift(d, 1)) days.push(d);
  const byDay = new Map(days.map((d) => [d, { date: d, scheduled: 0, worked: 0, overtime: 0, cost: 0 }]));
  const at = (d: string) => byDay.get(d) ?? (byDay.set(d, { date: d, scheduled: 0, worked: 0, overtime: 0, cost: 0 }), byDay.get(d)!);
  for (const a of asg) if (a.status === 'accepted') at(localDay(a.starts_at)).scheduled += hoursBetween(a.starts_at, a.ends_at);
  for (const t of entries) at(localDay(t.clock_in)).worked += hoursBetween(t.clock_in, t.clock_out);
  for (const p of pe) { const d = at(p.date); d.overtime += p.ot + p.dt; d.cost += p.pay ?? 0; }
  const hoursByDay = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)).map((d) => ({ date: d.date, scheduled: r2(d.scheduled), worked: r2(d.worked), overtime: r2(d.overtime), cost: r2(d.cost) }));
  const roleHours = new Map<string, { role: string; scheduled: number; worked: number }>();
  for (const a of asg) if (a.status === 'accepted') { const r = roleHours.get(a.role_name) ?? { role: a.role_name, scheduled: 0, worked: 0 }; r.scheduled += hoursBetween(a.starts_at, a.ends_at); roleHours.set(a.role_name, r); }
  for (const t of entries) { const r = roleHours.get(t.role_name) ?? { role: t.role_name, scheduled: 0, worked: 0 }; r.worked += hoursBetween(t.clock_in, t.clock_out); roleHours.set(t.role_name, r); }
  const lunches = breaks.filter((b) => b.kind === 'lunch');
  const rests = breaks.filter((b) => b.kind === 'break');
  const mins = (l: any[]) => Math.round(l.reduce((n, b) => n + (+new Date(b.ended_at) - +new Date(b.started_at)) / 60_000, 0));

  // ---------- staffing ----------
  const slots = shifts.reduce((n, s) => n + Number(s.headcount), 0);
  const filled = shifts.reduce((n, s) => n + Math.min(Number(s.headcount), asg.filter((a) => a.shift_id === s.id && a.status === 'accepted').length), 0);
  const ansBy = new Map<string, { action: string; at: Date }>();
  for (const x of answers) if (x.action !== 'assignment.delete' && !ansBy.has(x.entity_id)) ansBy.set(x.entity_id, { action: x.action, at: new Date(x.created_at) });
  const responseHours = asg
    .map((a) => { const r = ansBy.get(a.id); return r ? (+r.at - +new Date(a.created_at)) / 3600_000 : null; })
    .filter((h): h is number => h !== null && h >= 0);
  responseHours.sort((a, b) => a - b);
  const median = responseHours.length ? responseHours[Math.floor(responseHours.length / 2)] : null;
  // How the event filled: confirmed seats by the day each one was confirmed.
  const confirms = asg.filter((a) => a.status === 'accepted').map((a) => localDay(ansBy.get(a.id)?.at ?? a.created_at)).sort();
  const fillTimeline: { date: string; confirmed: number }[] = [];
  confirms.forEach((d, i) => { const last = fillTimeline[fillTimeline.length - 1]; if (last && last.date === d) last.confirmed = i + 1; else fillTimeline.push({ date: d, confirmed: i + 1 }); });
  const late = entries.filter((t) => +new Date(t.clock_in) - +new Date(t.starts_at) > LATE_MIN * 60_000);
  const firstPunch = new Map<string, any>(); // one punch per person per shift for lateness
  for (const t of entries) { const k = `${t.user_id}:${t.shift_id}`; const f = firstPunch.get(k); if (!f || +new Date(t.clock_in) < +new Date(f.clock_in)) firstPunch.set(k, t); }
  const lateFirst = [...firstPunch.values()].filter((t) => +new Date(t.clock_in) - +new Date(t.starts_at) > LATE_MIN * 60_000);

  // ---------- crew ----------
  const people = new Map<string, any>();
  const person = (id: string, name: string) => people.get(id) ?? (people.set(id, { userId: id, name, roles: new Set<string>(), lead: false, scheduled: 0, worked: 0, ot: 0, pay: 0, late: 0, lateMinutes: 0, noShows: 0, stars: null as number | null }), people.get(id));
  for (const a of asg) {
    if (a.status === 'declined') continue;
    const p = person(a.user_id, a.name);
    p.roles.add(a.role_name);
    if (a.is_lead) p.lead = true;
    if (a.status === 'accepted') p.scheduled += hoursBetween(a.starts_at, a.ends_at);
    if (a.no_show_at) p.noShows++;
  }
  for (const t of entries) { const p = person(t.user_id, asg.find((a) => a.user_id === t.user_id)?.name ?? 'Crew'); p.worked += hoursBetween(t.clock_in, t.clock_out); }
  for (const t of lateFirst) { const p = people.get(t.user_id); if (p) { p.late++; p.lateMinutes += Math.round((+new Date(t.clock_in) - +new Date(t.starts_at)) / 60_000); } }
  for (const x of pe) { const p = people.get(x.userId) ?? person(x.userId, x.name); p.pay += x.pay ?? 0; p.ot += x.ot + x.dt; }
  for (const r of reviews) { const p = people.get(r.user_id); if (p) p.stars = r2(r.stars); }
  const crew = [...people.values()]
    .map((p) => ({ ...p, roles: [...p.roles], scheduled: r2(p.scheduled), worked: r2(p.worked), ot: r2(p.ot), pay: r2(p.pay) }))
    .sort((a, b) => b.worked - a.worked || a.name.localeCompare(b.name));

  const regular = r2(pe.reduce((n, p) => n + p.reg, 0)), overtime = r2(pe.reduce((n, p) => n + p.ot, 0)), double = r2(pe.reduce((n, p) => n + p.dt, 0));
  return {
    event: { id: e.id, name: e.name, customer: e.customer, venue: e.venue, start, end, status: e.pipeline_status, rentman: e.rentman_project_id },
    money: {
      laborCost, billed, quoted, quoteNumber: quote?.number ?? null, quoteSource: quote?.source ?? null, invoiced: r2(invoiced.t), invoices: invoiced.n,
      revenue: revenue > 0 ? r2(revenue) : null, margin: revenue > 0 ? r2(revenue - laborCost) : null, marginPct: revenue > 0 ? r2((revenue - laborCost) / revenue) : null,
      budget, budgetLeft: budget === null ? null : r2(budget - laborCost), costPerHour: pe.length ? r2(laborCost / Math.max(1, pe.reduce((n, p) => n + p.hours, 0))) : null,
      costByRole,
    },
    hours: {
      scheduled: r2(asg.filter((a) => a.status === 'accepted').reduce((n, a) => n + hoursBetween(a.starts_at, a.ends_at), 0)),
      worked: r2(entries.reduce((n, t) => n + hoursBetween(t.clock_in, t.clock_out), 0)),
      approved: r2(pe.reduce((n, p) => n + p.hours, 0)), unapproved: entries.filter((t) => t.status !== 'approved').length,
      regular, overtime, double, byDay: hoursByDay,
      byRole: [...roleHours.values()].map((r) => ({ ...r, scheduled: r2(r.scheduled), worked: r2(r.worked) })).sort((a, b) => b.worked - a.worked || b.scheduled - a.scheduled),
      lunches: lunches.length, lunchMinutes: mins(lunches), breaks: rests.length, breakMinutes: mins(rests), autoClockOuts: entries.filter((t) => t.auto_clocked_out).length,
    },
    staffing: {
      slots, filled, fillRate: slots ? r2(filled / slots) : null,
      offers: asg.length, accepted: asg.filter((a) => a.status === 'accepted').length, declined: asg.filter((a) => a.status === 'declined').length,
      waiting: asg.filter((a) => a.status === 'offered' || a.status === 'pending').length, removed,
      medianResponseHours: median === null ? null : r2(median),
      noShows: asg.filter((a) => a.no_show_at).length, late: lateFirst.length, latePunches: late.length,
      leads: asg.filter((a) => a.is_lead && a.status === 'accepted').length, fillTimeline,
    },
    crew,
  };
}
