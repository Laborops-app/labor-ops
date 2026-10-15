import type { PoolClient } from 'pg';
import { loadRules, loadRates, rateFor, priceShift, eventState, loadStateOt, type StateOt, loadDayRates, roleKeyOf } from './pay';
import { localDate, baseRole, type AcctSettings, type PayrollProvider } from './accounting';

const r2 = (n: number) => Math.round(n * 100) / 100;

export type PayEntry = { id: string; date: string; event: string; eventId: string; role: string; hours: number; reg: number; ot: number; dt: number; premium: number; pay: number | null;
  /** Base hourly rate; for a day-rate shift, the day rate divided by the hours worked. */
  rate: number | null; day: boolean; exported: boolean };
export type PayPerson = {
  userId: string; name: string; email: string; payrollIds: Record<string, string>;
  regular: number; overtime: number; double: number; hours: number; days: number; dayPay: number; gross: number | null; missingRate: boolean;
  entries: PayEntry[];
};

/** Monday (YYYY-MM-DD) of the week containing a local date. */
const weekOf = (ymd: string) => {
  const d = new Date(`${ymd}T12:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
};

/**
 * Approved time for a pay period (local dates, inclusive), per person: regular / overtime / double-time hours and estimated gross.
 * Weekly overtime counts the whole Mon–Sun week (including approved time just before the period); daily overtime is per job per day,
 * with the job's threshold and its state's multipliers. Day-rate shifts pay one flat amount per day.
 */
export async function payrollSummary(c: PoolClient, from: string, to: string) {
  const rules = await loadRules(c);
  const rates = await loadRates(c);
  const dayRates = await loadDayRates(c);
  const fallbackState = (await c.query('SELECT default_state FROM labor_rules LIMIT 1')).rows[0]?.default_state ?? null;
  const rows = (
    await c.query(
      `SELECT t.id, t.user_id, t.assignment_id, t.clock_in, t.clock_out, t.payroll_exported_at,
              u.name, u.email, u.payroll_ids, s.role_name, COALESCE(cr.pay_type, s.pay_type) AS pay_type,
              COALESCE(cr.rate, s.pay_rate_override) AS pay_rate_override, s.event_id,
              e.name AS event_name, e.ot_after, e.state, e.address
         FROM time_entries t JOIN users u ON u.id = t.user_id
         JOIN shift_assignments a ON a.id = t.assignment_id JOIN shifts s ON s.id = a.shift_id JOIN events e ON e.id = s.event_id
         -- A rate set for this person on this event replaces the shift's and the role's rate.
         LEFT JOIN event_crew_rates cr ON cr.event_id = s.event_id AND cr.user_id = t.user_id
        WHERE t.status = 'approved' AND t.clock_out IS NOT NULL
          AND t.clock_in >= ($1::date - 7)::timestamp AT TIME ZONE $3 AND t.clock_in < ($2::date + 1)::timestamp AT TIME ZONE $3
        ORDER BY t.user_id, t.clock_in`,
      [from, to, rules.tz],
    )
  ).rows;
  const unapproved = Number(
    (
      await c.query(
        `SELECT count(*)::int AS n FROM time_entries WHERE status <> 'approved' AND clock_in >= $1::date::timestamp AT TIME ZONE $3 AND clock_in < ($2::date + 1)::timestamp AT TIME ZONE $3`,
        [from, to, rules.tz],
      )
    ).rows[0].n,
  );
  const stateCache = new Map<string, StateOt>();
  const people = new Map<string, PayPerson>();
  const week = new Map<string, number>(); // user|monday -> hours so far
  const jobDay = new Map<string, number>(); // user|event|date -> hours so far
  const dayPaid = new Set<string>();
  for (const r of rows) {
    const date = localDate(rules.tz, r.clock_in);
    const inPeriod = date >= from && date <= to;
    const wk = `${r.user_id}|${weekOf(date)}`;
    const jd = `${r.user_id}|${r.event_id}|${date}`;
    if (date < weekOf(from) && !inPeriod) continue;
    let p = people.get(r.user_id);
    if (!p && inPeriod) {
      p = { userId: r.user_id, name: r.name, email: r.email, payrollIds: r.payroll_ids ?? {}, regular: 0, overtime: 0, double: 0, hours: 0, days: 0, dayPay: 0, gross: 0, missingRate: false, entries: [] };
      people.set(r.user_id, p);
    }
    const override = Number(r.pay_rate_override ?? 0);
    if (r.pay_type === 'day') {
      const k = `${r.assignment_id}|${date}`;
      if (dayPaid.has(k)) continue;
      dayPaid.add(k);
      if (!inPeriod || !p) continue;
      const amt = override > 0 ? override : dayRates.get(roleKeyOf(r.role_name)) ?? 0;
      const hours = r2((+new Date(r.clock_out) - +new Date(r.clock_in)) / 3600000);
      if (!(amt > 0)) p.missingRate = true;
      p.days += 1;
      p.dayPay = r2(p.dayPay + amt);
      p.entries.push({ id: r.id, date, event: r.event_name, eventId: r.event_id, role: r.role_name, hours, reg: 0, ot: 0, dt: 0, premium: 0, pay: amt || null, rate: amt > 0 && hours > 0 ? r2(amt / hours) : null, day: true, exported: !!r.payroll_exported_at });
      continue;
    }
    const stKey = r.event_id;
    if (!stateCache.has(stKey)) stateCache.set(stKey, await loadStateOt(c, eventState(r, fallbackState), rules));
    const st = stateCache.get(stKey)!;
    const rate = override > 0 ? override : rateFor(rates, r.role_name);
    const priced = priceShift(rules, rate || 1, r.clock_in, r.clock_out, week.get(wk) ?? 0, {
      otAfter: r.ot_after === null ? null : Number(r.ot_after), otMult: st.otMult, dtAfter: st.dtAfter, dtMult: st.dtMult, priorDay: jobDay.get(jd) ?? 0,
    });
    week.set(wk, (week.get(wk) ?? 0) + priced.hours);
    jobDay.set(jd, (jobDay.get(jd) ?? 0) + priced.hours);
    if (!inPeriod || !p) continue;
    const reg = r2(priced.hours - priced.otHours - priced.dtHours);
    const pay = rate ? priced.estimate : null;
    if (!rate) p.missingRate = true;
    p.regular = r2(p.regular + reg);
    p.overtime = r2(p.overtime + priced.otHours);
    p.double = r2(p.double + priced.dtHours);
    p.hours = r2(p.hours + priced.hours);
    p.entries.push({ id: r.id, date, event: r.event_name, eventId: r.event_id, role: r.role_name, hours: priced.hours, reg, ot: priced.otHours, dt: priced.dtHours, premium: priced.premiumHours, pay, rate: rate || null, day: false, exported: !!r.payroll_exported_at });
  }
  const list = [...people.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const p of list) p.gross = p.missingRate ? null : r2(p.entries.reduce((s, e) => s + (e.pay ?? 0), 0));
  const exportedBefore = list.reduce((n, p) => n + p.entries.filter((e) => e.exported).length, 0);
  const warnings: string[] = [];
  if (unapproved) warnings.push(`${unapproved} time entr${unapproved === 1 ? 'y' : 'ies'} in this period ${unapproved === 1 ? 'is' : 'are'} not approved and left out.`);
  if (exportedBefore) warnings.push(`${exportedBefore} entr${exportedBefore === 1 ? 'y was' : 'ies were'} already exported to payroll before. Check you are not paying them twice.`);
  if (list.some((p) => p.missingRate)) warnings.push('Some roles have no pay rate (or day rate), so their gross pay is not shown.');
  return { from, to, timezone: rules.tz, people: list, warnings, totals: { people: list.length, hours: r2(list.reduce((s, p) => s + p.hours, 0)), gross: r2(list.reduce((s, p) => s + (p.gross ?? 0), 0)) } };
}

// ---------- export files ----------
export const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; // stop spreadsheet formula injection
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
const csv = (rows: unknown[][]) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
const split = (name: string) => {
  const parts = name.trim().split(/\s+/);
  return parts.length > 1 ? { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] } : { first: name.trim(), last: '' };
};
const h = (n: number) => (n ? n.toFixed(2) : '');

/** ADP Workforce Now pay data import (EPI-style CSV): one row per employee keyed by File #. Column codes are set under Integrations. */
export function adpFile(s: AcctSettings['payroll']['adp'], people: PayPerson[]) {
  return csv([
    ['Co Code', 'Batch ID', 'File #', 'Reg Hours', 'O/T Hours', 'Hours 3 Code', 'Hours 3 Amount', 'Earnings 3 Code', 'Earnings 3 Amount'],
    ...people.map((p) => [s.companyCode, s.batchId, p.payrollIds.adp ?? '', h(p.regular), h(p.overtime), p.double ? s.dtCode : '', h(p.double), p.dayPay ? s.dayCode : '', p.dayPay ? p.dayPay.toFixed(2) : '']),
  ]);
}

/**
 * RUN Powered by ADP time sheet import ("Payroll Assigned Identifier" layout): a ##GENERIC## V1.0 header row,
 * a row of column titles, then one row per employee per earnings code. ADP pays the hours at the employee's
 * rate in RUN (Rate Code BASE / RATE_2 / RATE_3); day-rate pay goes as a dollar amount.
 */
export function adpRunFile(s: AcctSettings['payroll']['adp'], people: PayPerson[], from: string, to: string) {
  const r = s.run;
  const us = (ymd: string) => `${ymd.slice(5, 7)}/${ymd.slice(8, 10)}/${ymd.slice(0, 4)}`;
  const rows: unknown[][] = [
    ['##GENERIC## V1.0'],
    ['IID', 'Pay Frequency', 'Pay Period Start', 'Pay Period End', 'Employee ID', 'Earnings Code', 'Pay Hours', 'Dollars', 'Separate Check', 'Worked In Dept', 'Rate Code'],
  ];
  for (const p of people) {
    const line = (code: string, hours: number | null, dollars: number | null) =>
      rows.push([s.companyCode, r.frequency, us(from), us(to), p.payrollIds.adp ?? '', code, hours ? hours.toFixed(2) : '', dollars ? dollars.toFixed(2) : '', 0, r.dept, r.rateCode]);
    if (p.regular) line(r.regCode, p.regular, null);
    if (p.overtime) line(r.otCode, p.overtime, null);
    if (p.double) line(r.dtCode, p.double, null);
    if (p.dayPay) line(r.dayCode, null, p.dayPay);
  }
  return csv(rows);
}

/** Gusto hours import: one row per employee. */
export function gustoFile(people: PayPerson[]) {
  return csv([
    ['Last Name', 'First Name', 'Employee ID', 'Email', 'Regular Hours', 'Overtime Hours', 'Double Overtime Hours', 'Day Rate Pay'],
    ...people.map((p) => {
      const n = split(p.name);
      return [n.last, n.first, p.payrollIds.gusto ?? '', p.email, h(p.regular), h(p.overtime), h(p.double), p.dayPay ? p.dayPay.toFixed(2) : ''];
    }),
  ]);
}

/** QuickBooks Payroll time file: one row per worked entry (QuickBooks works out overtime from the hours). */
export function quickbooksFile(people: PayPerson[]) {
  return csv([
    ['Employee', 'Employee ID', 'Date', 'Hours', 'Customer / Job', 'Service', 'Notes'],
    ...people.flatMap((p) => p.entries.map((e) => [p.name, p.payrollIds.quickbooks ?? '', e.date, e.hours.toFixed(2), e.event, baseRole(e.role), e.day ? 'Day rate shift' : ''])),
  ]);
}

/** Every entry with its split and estimated pay, for review or any other payroll system. */
export function detailFile(people: PayPerson[]) {
  return csv([
    ['Employee', 'Email', 'Date', 'Event', 'Role', 'Hours', 'Regular', 'Overtime', 'Double time', 'Day rate', 'Estimated pay'],
    ...people.flatMap((p) => p.entries.map((e) => [p.name, p.email, e.date, e.event, e.role, e.hours.toFixed(2), h(e.reg), h(e.ot), h(e.dt), e.day ? 'yes' : '', e.pay === null ? '' : e.pay.toFixed(2)])),
  ]);
}

export function payrollFile(provider: PayrollProvider | 'csv', s: AcctSettings, people: PayPerson[], from = '', to = '') {
  if (provider === 'adp' && s.payroll.adp.product === 'run') return { name: 'adp-run-timesheet', body: adpRunFile(s.payroll.adp, people, from, to) };
  if (provider === 'adp') return { name: 'adp-pay-data', body: adpFile(s.payroll.adp, people) };
  if (provider === 'gusto') return { name: 'gusto-hours', body: gustoFile(people) };
  if (provider === 'quickbooks') return { name: 'quickbooks-time', body: quickbooksFile(people) };
  return { name: 'payroll-detail', body: detailFile(people) };
}
