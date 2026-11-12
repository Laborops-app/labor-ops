import type { PoolClient } from 'pg';
import { roleKeyOf } from './pay';
import { baseRole, type BillLine } from './accounting';
import { functionLabor, projectCrewFunctions, rentmanQuote, RentmanError } from './rentman';
import { roleResolver } from './rentmanBuild';
import { onQuote } from './pipeline';
import { audit } from './db';

const r2 = (n: number) => Math.round(n * 100) / 100;
/** How a fixed-fee line is named, on quotes and invoices alike. */
export const FEE = ' · fixed fee';

// ---------- pulling a Rentman quote in ----------

/** "2026-11-14T08:00:00+01:00" → the date and clock time in the company's time zone. */
function local(tz: string, iso: string) {
  const d = new Date(iso);
  const f = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', ...o }).format(d);
  return { day: f({ year: 'numeric', month: '2-digit', day: '2-digit' }), time: f({ hour: '2-digit', minute: '2-digit' }) };
}

/**
 * Copy a Rentman quote onto an event as a read-only quote: its totals, plus one line per crew function on the
 * project's financial documents (people × hours, with Rentman's amount to the cent; fixed costs such as travel on a line
 * of their own). Pulling the same quote again replaces the copy.
 */
export async function importRentmanQuote(c: PoolClient, tid: string, by: string, eventId: string, token: string, rentmanQuoteId: number, accepted: boolean) {
  const ev = (await c.query('SELECT e.id, e.name, e.customer_id, e.rentman_project_id, t.timezone FROM events e JOIN tenants t ON t.id = e.tenant_id WHERE e.id = $1', [eventId])).rows[0];
  if (!ev) throw new RentmanError('Event not found', 404);
  if (!ev.rentman_project_id) throw new RentmanError('Link this event to a Rentman project first.', 409);
  const q = await rentmanQuote(token, rentmanQuoteId);
  if (q.project !== null && q.project !== Number(ev.rentman_project_id)) throw new RentmanError('That quote belongs to another Rentman project.', 400);
  const fns = await projectCrewFunctions(token, Number(ev.rentman_project_id));
  // Lines take this company's role names ("Audio A1" in Rentman is "A1" here), so they line up with the invoice.
  const roles = await roleResolver(c, tid);

  type L = { section: string | null; description: string; day: string | null; start: string | null; end: string | null; qty: number; hours: number; rate: number; amount: number };
  const lines: L[] = [];
  for (const f of fns) {
    const s = f.start ? new Date(f.start) : null;
    const e = f.end ? new Date(f.end) : null;
    const span = s && e ? Math.max(0, (+e - +s) / 3600_000) : 0;
    const hours = span > 0 ? r2(span) : 1;
    const lab = functionLabor(f, hours, f.people);
    const role = roles.resolve(f.name);
    const a = s ? local(ev.timezone, f.start!) : null;
    const b = e ? local(ev.timezone, f.end!) : null;
    // Clock times only for a call inside one day; a function running for days keeps just its first day.
    const timed = a && b && span > 0 && span < 24;
    if (lab.amount > 0 || !lab.fixed)
      lines.push({
        section: f.group, description: role, day: a?.day ?? null, start: timed ? a!.time : null, end: timed ? b!.time : null,
        qty: f.people, hours, rate: r2(lab.hourly), amount: r2(lab.amount),
      });
    // Rentman's fixed fee is per person on the function.
    if (lab.fixed > 0)
      lines.push({ section: f.group, description: `${role}${FEE}`, day: a?.day ?? null, start: null, end: null, qty: f.people, hours: 1, rate: r2(lab.fixed), amount: r2(lab.fixedAmount) });
  }
  const linesTotal = r2(lines.reduce((n, l) => n + l.amount, 0));
  const warnings: string[] = [];
  if (Math.abs(linesTotal - q.crew) > 1)
    warnings.push(`The crew lines add up to $${linesTotal.toFixed(2)} but Rentman’s quote has $${q.crew.toFixed(2)} for crew. The project’s crew may have changed since the quote was made; pull the quote again after Rentman makes a new version.`);
  if (!lines.length) warnings.push('This Rentman project has no crew functions on its financial documents, so the quote has no labor lines.');

  const status = accepted ? 'accepted' : 'sent';
  const title = q.subject && q.subject !== q.number ? q.subject : `Rentman quote ${q.number} · ${ev.name}`;
  const intro = `Imported from Rentman quote ${q.number}, version ${q.version}. Crew only: equipment and transport stay in Rentman.`;
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['quote:' + tid]);
  const existing = (await c.query('SELECT id FROM quotes WHERE rentman_quote_id = $1', [q.id])).rows[0];
  let id: string;
  if (existing) {
    id = existing.id;
    await c.query(
      `UPDATE quotes SET title=$2, customer_id=COALESCE(customer_id, $3), event_id=$4, valid_until=$5, intro=$6, status=$7, sent_at=COALESCE($8::timestamptz, sent_at),
              rentman_number=$9, rentman_version=$10, rentman_total=$11, rentman_crew_total=$12, rentman_transport_total=$13, imported_at=now(), updated_at=now() WHERE id=$1`,
      [id, title, ev.customer_id, eventId, q.expires?.slice(0, 10) ?? null, intro, status, q.date, q.number, q.version, q.price, q.crew, q.transport],
    );
  } else {
    const n = (await c.query('SELECT COALESCE(max(number), 1000) + 1 AS n FROM quotes')).rows[0].n;
    id = (
      await c.query(
        `INSERT INTO quotes (tenant_id, number, customer_id, event_id, title, valid_until, intro, status, sent_at, created_by, source,
                             rentman_quote_id, rentman_number, rentman_version, rentman_total, rentman_crew_total, rentman_transport_total, imported_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'rentman',$11,$12,$13,$14,$15,$16, now()) RETURNING id`,
        [tid, n, ev.customer_id, eventId, title, q.expires?.slice(0, 10) ?? null, intro, status, q.date, by, q.id, q.number, q.version, q.price, q.crew, q.transport],
      )
    ).rows[0].id;
  }
  await c.query('DELETE FROM quote_lines WHERE quote_id = $1', [id]);
  for (const [i, l] of lines.entries())
    await c.query(
      'INSERT INTO quote_lines (tenant_id, quote_id, sort, section, description, day, start_time, end_time, qty, hours, rate, amount) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
      [tid, id, i, l.section, l.description, l.day, l.start, l.end, l.qty, l.hours, l.rate, l.amount],
    );
  await audit(c, tid, by, existing ? 'quote.rentman_refresh' : 'quote.rentman_import', 'quote', id, { rentmanQuote: q.id, version: q.version, lines: lines.length, crew: linesTotal });
  await onQuote(c, tid, eventId, status, by);
  return { id, updated: !!existing, lines: lines.length, crewTotal: linesTotal, warnings };
}

// ---------- quoted vs invoiced ----------

export type QuoteChoice = { id: string; number: number; title: string; status: string; source: string; rentman_number: string | null; rentman_version: number | null; updated_at: string };

/** The event's quotes, and the one to compare with: the one asked for, else the accepted one, else the newest sent, else the newest. */
export async function quotesForEvent(c: PoolClient, eventId: string, wanted?: string | null) {
  const list = (
    await c.query(
      `SELECT id, number, title, status, source, rentman_number, rentman_version, updated_at FROM quotes WHERE event_id = $1
        ORDER BY (status = 'accepted') DESC, (status = 'sent') DESC, updated_at DESC`,
      [eventId],
    )
  ).rows as QuoteChoice[];
  const chosen = (wanted && list.find((q) => q.id === wanted)) || list.find((q) => q.status !== 'declined') || null;
  return { list, chosen };
}

export type CompareRow = {
  role: string; fee: boolean; quotedHours: number; quotedAmount: number; invoicedHours: number; invoicedDays: number; invoicedAmount: number;
  diff: number; pct: number | null; status: 'match' | 'over' | 'under' | 'not_quoted' | 'not_invoiced';
};
/** Close enough to call it the same: within $1, or 2% of what was quoted. */
const near = (quoted: number, invoiced: number) => Math.abs(invoiced - quoted) <= Math.max(1, Math.abs(quoted) * 0.02);

/**
 * Compare a quote with what is about to be invoiced, position by position (roles matched loosely: case, plural,
 * "Op"/"Operator"). Quote lines that aren't a position on the invoice (travel, per diem) show as quoted but not invoiced.
 */
export async function compareQuote(c: PoolClient, quoteId: string, bill: BillLine[]) {
  const q = (await c.query('SELECT id, number, title, status, source, discount, tax_pct, rentman_number, rentman_version, rentman_total, rentman_crew_total, rentman_transport_total, imported_at FROM quotes WHERE id = $1', [quoteId])).rows[0];
  if (!q) return null;
  // Fixed fees ("Stage hand · fixed fee", older pulls "… · travel and other costs") get rows of their own, counted in people.
  const feeOf = (d: string) => { const m = /^(.*?)\s·\s(fixed fee|travel and other costs)$/.exec(d); return m ? m[1]! : null; };
  const qlines = (await c.query('SELECT description, qty, hours, rate, amount FROM quote_lines WHERE quote_id = $1 ORDER BY sort', [quoteId])).rows.map((l) => {
    const feeRole = feeOf(String(l.description));
    return {
      role: baseRole(feeRole ?? String(l.description)), fee: feeRole !== null,
      hours: feeRole !== null ? Number(l.qty) : r2(Number(l.qty) * Number(l.hours)),
      amount: l.amount === null ? r2(Number(l.qty) * Number(l.hours) * Number(l.rate)) : Number(l.amount),
    };
  });
  const rows = new Map<string, CompareRow>();
  const row = (role: string, fee: boolean) => {
    const k = roleKeyOf(role) + (fee ? '|fee' : '');
    let r = rows.get(k);
    if (!r) rows.set(k, (r = { role: fee ? `${role}${FEE}` : role, fee, quotedHours: 0, quotedAmount: 0, invoicedHours: 0, invoicedDays: 0, invoicedAmount: 0, diff: 0, pct: null, status: 'match' }));
    return r;
  };
  for (const l of qlines) {
    const r = row(l.role, l.fee);
    r.quotedHours = r2(r.quotedHours + l.hours);
    r.quotedAmount = r2(r.quotedAmount + l.amount);
  }
  for (const l of bill) {
    const fee = l.kind === 'fee';
    const r = row(l.role, fee);
    if (r.quotedAmount === 0 && r.invoicedAmount === 0) r.role = fee ? `${l.role}${FEE}` : l.role; // the invoice's spelling when the quote didn't have it
    if (l.unit === 'day') r.invoicedDays = r2(r.invoicedDays + l.qty);
    else r.invoicedHours = r2(r.invoicedHours + l.qty);
    r.invoicedAmount = r2(r.invoicedAmount + l.amount);
  }
  for (const r of rows.values()) {
    r.diff = r2(r.invoicedAmount - r.quotedAmount);
    r.pct = r.quotedAmount > 0 ? Math.round((r.diff / r.quotedAmount) * 1000) / 10 : null;
    r.status = r.quotedAmount === 0 ? 'not_quoted' : r.invoicedAmount === 0 ? 'not_invoiced' : near(r.quotedAmount, r.invoicedAmount) ? 'match' : r.diff > 0 ? 'over' : 'under';
  }
  const quotedLines = r2(qlines.reduce((n, l) => n + l.amount, 0));
  const discount = r2(Math.min(Number(q.discount) || 0, quotedLines));
  const quoted = r2(quotedLines - discount);
  const invoiced = r2(bill.reduce((n, l) => n + l.amount, 0));
  const diff = r2(invoiced - quoted);
  return {
    quote: {
      id: q.id, number: q.number, title: q.title, status: q.status, source: q.source,
      rentman: q.source === 'rentman' ? { number: q.rentman_number, version: q.rentman_version, total: Number(q.rentman_total ?? 0), crew: Number(q.rentman_crew_total ?? 0), transport: Number(q.rentman_transport_total ?? 0), importedAt: q.imported_at } : null,
    },
    rows: [...rows.values()].sort((a, b) => Math.max(b.quotedAmount, b.invoicedAmount) - Math.max(a.quotedAmount, a.invoicedAmount)),
    quotedLines, discount, quoted, invoiced, diff,
    pct: quoted > 0 ? Math.round((diff / quoted) * 1000) / 10 : null,
    status: (quoted === 0 ? 'not_quoted' : near(quoted, invoiced) ? 'match' : diff > 0 ? 'over' : 'under') as 'match' | 'over' | 'under' | 'not_quoted',
  };
}
export type Comparison = NonNullable<Awaited<ReturnType<typeof compareQuote>>>;
/** Over the quote by more than the tolerance: creating the invoice needs a second confirmation. */
export const overQuote = (cmp: Comparison | null) => !!cmp && cmp.quoted > 0 && cmp.status === 'over';
