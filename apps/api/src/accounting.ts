import type { PoolClient } from 'pg';
import { z } from 'zod';
import { loadRules, priceShift, eventState, loadStateOt, hoursBetween, type Rules } from './pay';

// ---------- settings (non-secret; QuickBooks keys are stored encrypted elsewhere) ----------
export const PAYROLL_PROVIDERS = ['adp', 'gusto', 'quickbooks'] as const;
export type PayrollProvider = (typeof PAYROLL_PROVIDERS)[number];

export const acctSchema = z.object({
  qbo: z.object({ defaultItemId: z.string().max(40).nullable().default(null) }).prefault({}),
  desktop: z
    .object({
      arAccount: z.string().trim().min(1).max(100).default('Accounts Receivable'),
      incomeAccount: z.string().trim().min(1).max(100).default('Labor Income'),
      itemMode: z.enum(['single', 'role']).default('role'),
      itemName: z.string().trim().min(1).max(100).default('Labor'),
    })
    .prefault({}),
  payroll: z
    .object({
      enabled: z.array(z.enum(PAYROLL_PROVIDERS)).min(1).default(['adp']),
      primary: z.enum(PAYROLL_PROVIDERS).default('adp'),
      adp: z
        .object({
          companyCode: z.string().trim().max(10).default(''),
          batchId: z.string().trim().max(20).default('LABOROPS'),
          dtCode: z.string().trim().max(10).default('D'),
          dayCode: z.string().trim().max(10).default('DAY'),
        })
        .prefault({}),
    })
    .prefault({}),
});
export type AcctSettings = z.infer<typeof acctSchema>;

export async function loadAcct(c: PoolClient): Promise<AcctSettings> {
  const r = (await c.query('SELECT config FROM accounting_settings LIMIT 1')).rows[0];
  const parsed = acctSchema.safeParse(r?.config ?? {});
  return parsed.success ? parsed.data : acctSchema.parse({});
}

export async function saveAcct(c: PoolClient, tid: string, next: AcctSettings) {
  if (!next.payroll.enabled.includes(next.payroll.primary)) next.payroll.primary = next.payroll.enabled[0];
  await c.query(
    `INSERT INTO accounting_settings (tenant_id, config) VALUES ($1, $2) ON CONFLICT (tenant_id) DO UPDATE SET config = EXCLUDED.config, updated_at = now()`,
    [tid, JSON.stringify(next)],
  );
  return next;
}

// ---------- shared helpers ----------
const dayFmt = new Map<string, Intl.DateTimeFormat>();
/** YYYY-MM-DD of an instant in the company time zone. */
export function localDate(tz: string, d: Date | string): string {
  let f = dayFmt.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    dayFmt.set(tz, f);
  }
  return f.format(new Date(d));
}
export const baseRole = (role: string) => role.replace(/\s*\(.*\)\s*$/, '').trim();
const r2 = (n: number) => Math.round(n * 100) / 100;
const fmtDay = (ymd: string) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

/** Split worked time into regular / overtime / double time using the job's daily overtime rule. Premiums do not apply to billing. */
function splitHours(rules: Rules, rate: number, start: Date | string, end: Date | string, opts: Parameters<typeof priceShift>[5], weekly: boolean, priorWeek = 0) {
  const r: Rules = { ...rules, nightPct: 0, sundayPct: 0, holidayPct: 0, weeklyOt: weekly ? rules.weeklyOt : 0 };
  const p = priceShift(r, rate || 1, start, end, priorWeek, opts);
  const reg = r2(p.hours - p.otHours - p.dtHours);
  return { hours: p.hours, reg, ot: p.otHours, dt: p.dtHours };
}

// ---------- event billing ----------
export type BillKind = 'regular' | 'overtime' | 'double' | 'day';
export type BillLine = { role: string; date: string; kind: BillKind; qty: number; unit: 'hour' | 'day'; rate: number; amount: number; description: string; qboItemId: string | null };
export type BillSource = 'time' | 'schedule';

export async function eventBilling(c: PoolClient, eventId: string, source: BillSource) {
  const ev = (await c.query('SELECT e.*, t.timezone FROM events e JOIN tenants t ON t.id = e.tenant_id WHERE e.id = $1', [eventId])).rows[0];
  if (!ev) return null;
  const rules = await loadRules(c);
  const fallback = (await c.query('SELECT default_state FROM labor_rules LIMIT 1')).rows[0]?.default_state ?? null;
  const st = await loadStateOt(c, eventState(ev, fallback), rules);
  const otOpts = { otAfter: ev.ot_after === null ? null : Number(ev.ot_after), otMult: st.otMult, dtAfter: st.dtAfter, dtMult: st.dtMult };
  const settings = await loadAcct(c);
  const skills = new Map<string, any>((await c.query('SELECT lower(name) AS k, name, bill_rate, day_bill_rate, qbo_item_id FROM skills')).rows.map((r) => [r.k, r]));
  const warnings: string[] = [];
  const missingRate = new Set<string>();
  const acc = new Map<string, BillLine>();
  const add = (role: string, date: string, kind: BillKind, qty: number, unit: 'hour' | 'day', rate: number) => {
    if (qty <= 0) return;
    const sk = skills.get(baseRole(role).toLowerCase());
    const key = `${baseRole(role)}|${date}|${kind}|${rate}`;
    const cur = acc.get(key);
    if (cur) {
      cur.qty = r2(cur.qty + qty);
      cur.amount = r2(cur.qty * cur.rate);
      return;
    }
    const label = kind === 'regular' ? 'hours' : kind === 'overtime' ? 'overtime hours' : kind === 'double' ? 'double-time hours' : 'day rate';
    acc.set(key, { role: baseRole(role), date, kind, qty: r2(qty), unit, rate, amount: r2(qty * rate), description: `${baseRole(role)} ${label} · ${fmtDay(date)} · ${ev.name}`, qboItemId: sk?.qbo_item_id ?? settings.qbo.defaultItemId ?? null });
  };
  const rates = (role: string) => {
    const sk = skills.get(baseRole(role).toLowerCase());
    return { hourly: Number(sk?.bill_rate ?? 0), day: Number(sk?.day_bill_rate ?? 0) };
  };

  if (source === 'time') {
    const rows = (
      await c.query(
        `SELECT t.user_id, t.assignment_id, t.clock_in, t.clock_out, t.status, s.role_name, s.pay_type
           FROM time_entries t JOIN shift_assignments a ON a.id = t.assignment_id JOIN shifts s ON s.id = a.shift_id
          WHERE s.event_id = $1 ORDER BY t.user_id, t.clock_in`,
        [eventId],
      )
    ).rows;
    const notApproved = rows.filter((r) => r.status !== 'approved').length;
    if (notApproved) warnings.push(`${notApproved} time entr${notApproved === 1 ? 'y is' : 'ies are'} not approved yet and ${notApproved === 1 ? 'is' : 'are'} left out.`);
    const approved = rows.filter((r) => r.status === 'approved' && r.clock_out);
    if (!approved.length) warnings.push('No approved time on this event yet. Approve timesheets, or bill from the schedule instead.');
    const dayWorked = new Map<string, number>(); // user|date -> hours already billed that day on this job
    const daysBilled = new Set<string>(); // assignment|date for day-rate shifts
    for (const r of approved) {
      const date = localDate(ev.timezone, r.clock_in);
      const rt = rates(r.role_name);
      if (r.pay_type === 'day') {
        const k = `${r.assignment_id}|${date}`;
        if (daysBilled.has(k)) continue;
        daysBilled.add(k);
        if (rt.day > 0) add(r.role_name, date, 'day', 1, 'day', rt.day);
        else {
          missingRate.add(`${baseRole(r.role_name)} (day bill rate)`);
          add(r.role_name, date, 'day', 1, 'day', 0);
        }
        continue;
      }
      if (!(rt.hourly > 0)) missingRate.add(baseRole(r.role_name));
      const dk = `${r.user_id}|${date}`;
      const h = splitHours(rules, rt.hourly, r.clock_in, r.clock_out, { ...otOpts, priorDay: dayWorked.get(dk) ?? 0 }, false);
      dayWorked.set(dk, (dayWorked.get(dk) ?? 0) + h.hours);
      add(r.role_name, date, 'regular', h.reg, 'hour', rt.hourly);
      add(r.role_name, date, 'overtime', h.ot, 'hour', r2(rt.hourly * st.otMult));
      add(r.role_name, date, 'double', h.dt, 'hour', r2(rt.hourly * st.dtMult));
    }
  } else {
    const shifts = (await c.query('SELECT role_name, starts_at, ends_at, headcount, pay_type FROM shifts WHERE event_id = $1 ORDER BY starts_at', [eventId])).rows;
    if (!shifts.length) warnings.push('This event has no shifts.');
    for (const s of shifts) {
      const date = localDate(ev.timezone, s.starts_at);
      const rt = rates(s.role_name);
      if (s.pay_type === 'day') {
        if (!(rt.day > 0)) missingRate.add(`${baseRole(s.role_name)} (day bill rate)`);
        add(s.role_name, date, 'day', s.headcount, 'day', rt.day);
        continue;
      }
      if (!(rt.hourly > 0)) missingRate.add(baseRole(s.role_name));
      const h = splitHours(rules, rt.hourly, s.starts_at, s.ends_at, otOpts, false);
      add(s.role_name, date, 'regular', h.reg * s.headcount, 'hour', rt.hourly);
      add(s.role_name, date, 'overtime', h.ot * s.headcount, 'hour', r2(rt.hourly * st.otMult));
      add(s.role_name, date, 'double', h.dt * s.headcount, 'hour', r2(rt.hourly * st.dtMult));
    }
  }
  if (missingRate.size) warnings.push(`No bill rate set for ${[...missingRate].join(', ')}. Set it under Roles & pay rates.`);
  const order: Record<BillKind, number> = { regular: 0, overtime: 1, double: 2, day: 3 };
  const lines = [...acc.values()].sort((a, b) => a.date.localeCompare(b.date) || a.role.localeCompare(b.role) || order[a.kind] - order[b.kind]);
  const total = r2(lines.reduce((s, l) => s + l.amount, 0));
  const customer = ev.customer_id
    ? (await c.query('SELECT cu.id, cu.name, cu.qbo_customer_id, pc.email, pc.phone FROM customers cu LEFT JOIN LATERAL (SELECT email, phone FROM customer_contacts WHERE customer_id = cu.id ORDER BY is_primary DESC LIMIT 1) pc ON true WHERE cu.id = $1', [ev.customer_id])).rows[0] ?? null
    : null;
  if (!customer) warnings.push(ev.client ? `Link this event to a customer in the CRM ("${ev.client}" is only typed in) so the invoice goes to the right QuickBooks customer.` : 'This event has no customer. Pick one in Event details.');
  const invoices = (await c.query(`SELECT i.id, i.provider, i.source, i.external_id, i.doc_number, i.total, i.created_at, u.name AS created_by FROM event_invoices i LEFT JOIN users u ON u.id = i.created_by WHERE i.event_id = $1 ORDER BY i.created_at DESC`, [eventId])).rows;
  return {
    event: { id: ev.id, name: ev.name, start_date: ev.start_date, end_date: ev.end_date, timezone: ev.timezone as string, client: ev.client },
    customer,
    source,
    lines,
    total,
    warnings,
    invoices,
    overtime: { otAfter: otOpts.otAfter, otMult: st.otMult, dtAfter: st.dtAfter, dtMult: st.dtMult },
  };
}

// ---------- QuickBooks Desktop import file (IIF) ----------
const iifCell = (v: unknown) => String(v ?? '').replace(/[\t\r\n"]/g, ' ').trim();
const mdy = (ymd: string) => `${ymd.slice(5, 7)}/${ymd.slice(8, 10)}/${ymd.slice(0, 4)}`;

/** One invoice in Intuit Interchange Format: a TRNS header, one SPL per line (income is negative), ENDTRNS. */
export function invoiceIif(d: AcctSettings['desktop'], inv: { customer: string; date: string; docNumber?: string; memo: string; lines: BillLine[] }) {
  const total = r2(inv.lines.reduce((s, l) => s + l.amount, 0));
  const rows = [
    ['!TRNS', 'TRNSID', 'TRNSTYPE', 'DATE', 'ACCNT', 'NAME', 'AMOUNT', 'DOCNUM', 'MEMO', 'TOPRINT'],
    ['!SPL', 'SPLID', 'TRNSTYPE', 'DATE', 'ACCNT', 'NAME', 'AMOUNT', 'DOCNUM', 'MEMO', 'QNTY', 'PRICE', 'INVITEM'],
    ['!ENDTRNS'],
    ['TRNS', '', 'INVOICE', mdy(inv.date), d.arAccount, inv.customer, total.toFixed(2), inv.docNumber ?? '', inv.memo, 'N'],
    ...inv.lines.map((l) => ['SPL', '', 'INVOICE', mdy(l.date), d.incomeAccount, '', (-l.amount).toFixed(2), inv.docNumber ?? '', l.description, String(-l.qty), l.rate.toFixed(2), d.itemMode === 'role' ? l.role : d.itemName]),
    ['ENDTRNS'],
  ];
  return rows.map((r) => r.map(iifCell).join('\t')).join('\r\n') + '\r\n';
}

export { hoursBetween };
