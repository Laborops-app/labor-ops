import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { withTenant, audit } from '../db';
import { onQuote } from '../pipeline';
import { guard } from '../auth';
import { config } from '../config';
import { canAdjustRates } from '../rates';
import { CUSTOMER_SQL, advanceStage } from '../crm';
import { hoursBetween } from '../pay';
import { notifyStaff } from '../notify';
import { DEFAULT_LAYOUT, layoutSchema, renderQuotePdf, type Layout, type QuoteData } from '../quotePdf';
import { absUrl, renderEmail } from '../notify/templates';

const uuid = z.string().uuid();
const mgr = guard('admin', 'manager');
const TTL_DAYS = 90;
const mac = (p: string) => createHmac('sha256', config.jwtSecret + ':quote').update(p).digest('base64url');
const r2 = (n: number) => Math.round(n * 100) / 100;

function quoteToken(tid: string, qid: string): string {
  const payload = `${tid}.${qid}.${Math.floor(Date.now() / 1000) + TTL_DAYS * 86400}`;
  return Buffer.from(payload).toString('base64url') + '.' + mac(payload);
}
function readQuoteToken(t: string): { tid: string; qid: string } | null {
  const [p, sig] = String(t).split('.');
  if (!p || !sig) return null;
  let payload: string;
  try { payload = Buffer.from(p, 'base64url').toString(); } catch { return null; }
  const want = Buffer.from(mac(payload));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  const [tid, qid, exp] = payload.split('.');
  if (!tid || !qid || Number(exp) < Date.now() / 1000) return null;
  return { tid, qid };
}

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const line = z.object({
  section: z.string().trim().max(80).nullable().optional(),
  description: z.string().trim().min(1).max(300),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  startTime: hhmm.nullable().optional(),
  endTime: hhmm.nullable().optional(),
  qty: z.number().min(0).max(100000),
  hours: z.number().min(0).max(100000),
  rate: z.number().min(0).max(100000),
});
/** Hours between two clock times; an end at or before the start means the shift runs past midnight. */
const spanHours = (a: string, b: string) => {
  const m = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  let d = m(b) - m(a);
  if (d <= 0) d += 1440;
  return Math.round((d / 60) * 100) / 100;
};
const fields = z.object({
  title: z.string().trim().min(1).max(200),
  customerId: uuid.nullable().optional(),
  eventId: uuid.nullable().optional(),
  validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  intro: z.string().trim().max(5000).nullable().optional(),
  terms: z.string().trim().max(10000).nullable().optional(),
  taxPct: z.number().min(0).max(100).optional(),
  discount: z.number().min(0).max(10000000).optional(),
  layoutId: uuid.nullable().optional(),
  lines: z.array(line).max(300).optional(),
});

export function totals(lines: { qty: unknown; hours: unknown; rate: unknown }[], discount: unknown, taxPct: unknown) {
  const subtotal = r2(lines.reduce((a, l) => a + Number(l.qty) * Number(l.hours) * Number(l.rate), 0));
  const disc = Math.min(Number(discount) || 0, subtotal);
  const taxable = r2(subtotal - disc);
  const tax = r2(taxable * (Number(taxPct) || 0) / 100);
  return { subtotal, discount: r2(disc), tax, total: r2(taxable + tax) };
}

async function load(c: PoolClient, id: string) {
  const q = (await c.query(
    `SELECT q.*, cu.name AS customer_name, cu.email AS customer_email, cu.contact_name, ev.name AS event_name
       FROM quotes q LEFT JOIN (${CUSTOMER_SQL}) cu ON cu.id = q.customer_id LEFT JOIN events ev ON ev.id = q.event_id WHERE q.id = $1`, [id])).rows[0];
  if (!q) return null;
  const lines = (await c.query("SELECT id, section, description, to_char(day,'YYYY-MM-DD') AS day, start_time, end_time, qty, hours, rate FROM quote_lines WHERE quote_id = $1 ORDER BY sort", [id])).rows
    .map((l) => ({ id: l.id, section: l.section, description: l.description, day: l.day, startTime: l.start_time, endTime: l.end_time, qty: Number(l.qty), hours: Number(l.hours), rate: Number(l.rate), amount: r2(Number(l.qty) * Number(l.hours) * Number(l.rate)) }));
  return { quote: { ...q, tax_pct: Number(q.tax_pct), discount: Number(q.discount) }, lines, totals: totals(lines, q.discount, q.tax_pct) };
}

/** Without permission to adjust rates, lines for a known role always carry that role's billing rate; other lines (travel, per diem) are free. */
async function lockRates<T extends { description: string; rate: number }>(c: PoolClient, lines: T[]): Promise<T[]> {
  const rows = (await c.query('SELECT lower(name) AS k, bill_rate FROM skills')).rows;
  const by = new Map<string, number>(rows.map((r) => [r.k, Number(r.bill_rate)]));
  return lines.map((l) => (by.has(l.description.trim().toLowerCase()) ? { ...l, rate: by.get(l.description.trim().toLowerCase())! } : l));
}

async function writeLines(c: PoolClient, tid: string, qid: string, lines: z.infer<typeof line>[]) {
  await c.query('DELETE FROM quote_lines WHERE quote_id = $1', [qid]);
  for (const [i, l] of lines.entries()) {
    const timed = l.startTime && l.endTime;
    await c.query(
      'INSERT INTO quote_lines (tenant_id, quote_id, sort, section, description, day, start_time, end_time, qty, hours, rate) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [tid, qid, i, l.section || null, l.description, l.day || null, l.startTime || null, l.endTime || null, l.qty, timed ? spanHours(l.startTime!, l.endTime!) : l.hours, l.rate],
    );
  }
}

/** One line per shift, grouped by the event's phases (load-in, show, strike): people x hours x the role's billing rate. */
async function linesFromEvent(c: PoolClient, eventId: string) {
  const rows = (await c.query(
    `SELECT s.role_name, s.headcount, s.starts_at, s.ends_at, coalesce(k.bill_rate,0) AS bill_rate, tn.timezone, p.label AS phase, p.starts_on AS phase_start
       FROM shifts s JOIN tenants tn ON tn.id = s.tenant_id LEFT JOIN skills k ON lower(k.name) = lower(s.role_name) LEFT JOIN event_phases p ON p.id = s.phase_id
      WHERE s.event_id = $1 ORDER BY p.starts_on NULLS LAST, s.starts_at, s.role_name`, [eventId])).rows;
  const local = (tz: string, d: Date, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', ...o }).format(d);
  return rows.map((s) => {
    const a = new Date(s.starts_at);
    const e = new Date(s.ends_at);
    return {
      section: s.phase ?? null, description: s.role_name,
      day: local(s.timezone, a, { year: 'numeric', month: '2-digit', day: '2-digit' }),
      startTime: local(s.timezone, a, { hour: '2-digit', minute: '2-digit' }), endTime: local(s.timezone, e, { hour: '2-digit', minute: '2-digit' }),
      qty: Number(s.headcount), hours: hoursBetween(s.starts_at, s.ends_at), rate: Number(s.bill_rate),
    };
  });
}

async function layoutFor(c: PoolClient, layoutId: string | null): Promise<Layout> {
  const row = layoutId
    ? (await c.query('SELECT config FROM quote_layouts WHERE id = $1', [layoutId])).rows[0]
    : null;
  const def = row ?? (await c.query('SELECT config FROM quote_layouts WHERE is_default')).rows[0];
  const parsed = def ? layoutSchema.safeParse(def.config) : null;
  return parsed?.success ? parsed.data : DEFAULT_LAYOUT;
}

async function pdfFor(c: PoolClient, tid: string, id: string, layoutId?: string | null): Promise<{ pdf: Buffer; number: number } | null> {
  const d = await load(c, id);
  if (!d) return null;
  const q = d.quote;
  const company = (await c.query('SELECT name FROM tenants WHERE id = $1', [tid])).rows[0]?.name ?? 'LaborOps';
  const layout = await layoutFor(c, layoutId ?? q.layout_id);
  const data: QuoteData = {
    company, number: q.number, title: q.title, status: q.status, customer: q.customer_name, contact: q.contact_name, event: q.event_name, createdAt: new Date(q.created_at).toISOString(),
    validUntil: q.valid_until ? String(q.valid_until).slice(0, 10) : null, intro: q.intro, terms: q.terms, taxPct: q.tax_pct,
    lines: d.lines.map((l) => ({ section: l.section, description: l.description, day: l.day, start: l.startTime, end: l.endTime, qty: l.qty, hours: l.hours, rate: l.rate, amount: l.amount })),
    totals: d.totals,
  };
  return { pdf: await renderQuotePdf(layout, data), number: q.number };
}

const SAMPLE: QuoteData = {
  company: 'Your Company', number: 1042, title: 'Spring Gala labor', status: 'draft', customer: 'Acme Events', contact: 'Pat Morgan', event: 'Spring Gala', createdAt: new Date().toISOString(), validUntil: null,
  intro: 'Thank you for the opportunity. Here is our labor estimate for your event.', terms: 'Payment due within 30 days. Cancellations inside 72 hours are billed at 50%.', taxPct: 8,
  lines: [
    { section: 'Load in', description: 'Stage Hand', day: '2030-05-09', start: '08:00', end: '16:00', qty: 4, hours: 8, rate: 45, amount: 1440 },
    { section: 'Load in', description: 'Audio A1', day: '2030-05-09', start: '10:00', end: '18:00', qty: 1, hours: 8, rate: 85, amount: 680 },
    { section: 'Show', description: 'Audio A1', day: '2030-05-10', start: '12:00', end: '23:00', qty: 1, hours: 11, rate: 85, amount: 935 },
    { section: 'Show', description: 'Lighting Operator', day: '2030-05-10', start: '12:00', end: '23:00', qty: 2, hours: 11, rate: 70, amount: 1540 },
    { section: 'Strike', description: 'Stage Hand', day: '2030-05-11', start: '00:00', end: '06:00', qty: 4, hours: 6, rate: 45, amount: 1080 },
  ],
  totals: { subtotal: 5675, discount: 0, tax: 454, total: 6129 },
};

export async function quoteRoutes(app: FastifyInstance) {
  const limit = { rateLimit: { max: 30, timeWindow: '1 minute' } };

  app.get('/api/quotes', { preHandler: mgr }, async (req) =>
    withTenant(req.user.tid, async (c) => ({
      quotes: (await c.query(
        `SELECT q.id, q.number, q.title, q.status, q.valid_until, q.sent_at, q.created_at, cu.name AS customer_name,
                (SELECT coalesce(sum(l.qty*l.hours*l.rate),0) FROM quote_lines l WHERE l.quote_id = q.id) AS subtotal, q.discount, q.tax_pct
           FROM quotes q LEFT JOIN customers cu ON cu.id = q.customer_id ORDER BY q.number DESC`)).rows
        .map((q) => ({ ...q, total: totals([{ qty: 1, hours: 1, rate: q.subtotal }], q.discount, q.tax_pct).total })),
    })),
  );

  app.post('/api/quotes', { preHandler: mgr }, async (req, reply) => {
    const b = fields.partial({ title: true }).extend({ fromEvent: z.boolean().optional() }).parse(req.body);
    const out = await withTenant(req.user.tid, async (c) => {
      let title = b.title;
      let customerId = b.customerId ?? null;
      if (b.eventId) {
        const ev = (await c.query('SELECT name, customer_id FROM events WHERE id = $1', [b.eventId])).rows[0];
        if (!ev) return { code: 404, error: 'Event not found' };
        title ??= `Labor quote — ${ev.name}`;
        customerId ??= ev.customer_id;
      }
      if (customerId && !(await c.query('SELECT 1 FROM customers WHERE id = $1', [customerId])).rowCount) return { code: 404, error: 'Customer not found' };
      if (!title) return { code: 400, error: 'Give the quote a title' };
      const allowed = await canAdjustRates(c, req.user);
      let lines = b.lines ?? (b.eventId && b.fromEvent !== false ? await linesFromEvent(c, b.eventId) : []);
      if (!allowed) lines = await lockRates(c, lines);
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['quote:' + req.user.tid]);
      const num = (await c.query('SELECT COALESCE(max(number), 1000) + 1 AS n FROM quotes')).rows[0].n;
      const q = (await c.query(
        `INSERT INTO quotes (tenant_id, number, customer_id, event_id, title, valid_until, intro, terms, tax_pct, discount, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [req.user.tid, num, customerId, b.eventId ?? null, title, b.validUntil ?? null, b.intro ?? null, b.terms ?? null, b.taxPct ?? 0, allowed ? b.discount ?? 0 : 0, req.user.sub])).rows[0];
      await writeLines(c, req.user.tid, q.id, lines);
      await audit(c, req.user.tid, req.user.sub, 'quote.create', 'quote', q.id, { number: num });
      await advanceStage(c, customerId, 'pending');
      await onQuote(c, req.user.tid, b.eventId ?? null, 'draft', req.user.sub);
      return { code: 201, ...(await load(c, q.id)) };
    });
    const { code, ...rest } = out as { code: number; [k: string]: unknown };
    return reply.code(code).send(rest);
  });

  app.get('/api/quotes/:id', { preHandler: mgr }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const out = await withTenant(req.user.tid, async (c) => {
      const d = await load(c, id);
      if (!d) return null;
      const allowed = await canAdjustRates(c, req.user);
      // For people who may adjust rates: each role's pay and bill rate, so the quote can show margin.
      const roleRates = allowed
        ? (await c.query('SELECT name, pay_rate, bill_rate FROM skills WHERE active ORDER BY lower(name)')).rows.map((r) => ({ name: r.name, payRate: Number(r.pay_rate), billRate: Number(r.bill_rate) }))
        : [];
      return { ...d, canAdjustRates: allowed, roleRates };
    });
    if (!out) return reply.code(404).send({ error: 'Quote not found' });
    return { ...out, link: absUrl(`/quote?t=${quoteToken(req.user.tid, id)}`) };
  });

  app.put('/api/quotes/:id', { preHandler: mgr }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = fields.partial().parse(req.body);
    const out = await withTenant(req.user.tid, async (c) => {
      const cur = (await c.query('SELECT * FROM quotes WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!cur) return { code: 404, error: 'Quote not found' };
      if (b.customerId && !(await c.query('SELECT 1 FROM customers WHERE id = $1', [b.customerId])).rowCount) return { code: 404, error: 'Customer not found' };
      if (b.eventId && !(await c.query('SELECT 1 FROM events WHERE id = $1', [b.eventId])).rowCount) return { code: 404, error: 'Event not found' };
      const allowed = await canAdjustRates(c, req.user);
      if (!allowed) {
        if (b.lines) b.lines = await lockRates(c, b.lines);
        b.discount = undefined; // changing the price is a rate adjustment
      }
      if (b.layoutId && !(await c.query('SELECT 1 FROM quote_layouts WHERE id = $1', [b.layoutId])).rowCount) return { code: 404, error: 'Quote layout not found' };
      const has = (k: keyof typeof b) => b[k] !== undefined;
      // Anything the customer has already answered is a record; changing the content makes it a new revision, so it goes back to draft.
      const reopen = cur.status !== 'draft' && (has('lines') || has('taxPct') || has('discount') || has('title') || has('intro') || has('terms'));
      await c.query(
        `UPDATE quotes SET title=$2, customer_id=$3, event_id=$4, valid_until=$5, intro=$6, terms=$7, tax_pct=$8, discount=$9,
                status = CASE WHEN $10 THEN 'draft' ELSE status END, responded_at = CASE WHEN $10 THEN NULL ELSE responded_at END,
                response_note = CASE WHEN $10 THEN NULL ELSE response_note END, layout_id = $11, updated_at = now() WHERE id=$1`,
        [id, b.title ?? cur.title, has('customerId') ? b.customerId : cur.customer_id, has('eventId') ? b.eventId : cur.event_id, has('validUntil') ? b.validUntil : cur.valid_until,
         has('intro') ? b.intro || null : cur.intro, has('terms') ? b.terms || null : cur.terms, b.taxPct ?? cur.tax_pct, b.discount ?? cur.discount, reopen, has('layoutId') ? b.layoutId : cur.layout_id]);
      if (b.lines) await writeLines(c, req.user.tid, id, b.lines);
      await audit(c, req.user.tid, req.user.sub, 'quote.update', 'quote', id, { reopen });
      if (has('eventId') && b.eventId && b.eventId !== cur.event_id) await onQuote(c, req.user.tid, b.eventId, 'draft', req.user.sub);
      return { code: 200, ...(await load(c, id)) };
    });
    const { code, ...rest } = out as { code: number; [k: string]: unknown };
    return reply.code(code).send(rest);
  });

  // Rebuild the lines from the event's current shifts.
  app.post('/api/quotes/:id/refresh-lines', { preHandler: mgr }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const out = await withTenant(req.user.tid, async (c) => {
      const q = (await c.query('SELECT event_id FROM quotes WHERE id = $1', [id])).rows[0];
      if (!q) return { code: 404, error: 'Quote not found' };
      if (!q.event_id) return { code: 400, error: 'This quote is not linked to an event' };
      await writeLines(c, req.user.tid, id, await linesFromEvent(c, q.event_id));
      await c.query("UPDATE quotes SET updated_at = now(), status = 'draft', responded_at = NULL WHERE id = $1", [id]);
      return { code: 200, ...(await load(c, id)) };
    });
    const { code, ...rest } = out as { code: number; [k: string]: unknown };
    return reply.code(code).send(rest);
  });

  app.delete('/api/quotes/:id', { preHandler: mgr }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const n = await withTenant(req.user.tid, async (c) => {
      const r = await c.query('DELETE FROM quotes WHERE id = $1', [id]);
      if (r.rowCount) await audit(c, req.user.tid, req.user.sub, 'quote.delete', 'quote', id);
      return r.rowCount;
    });
    return n ? { ok: true } : reply.code(404).send({ error: 'Quote not found' });
  });

  app.post('/api/quotes/:id/send', { preHandler: mgr }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ to: z.string().trim().email().max(200).optional(), message: z.string().trim().max(3000).optional() }).parse(req.body ?? {});
    const out = await withTenant(req.user.tid, async (c) => {
      const d = await load(c, id);
      if (!d) return { code: 404, error: 'Quote not found' };
      const to = b.to ?? d.quote.customer_email;
      if (!to) return { code: 400, error: 'Add an email address for the customer, or type one in' };
      if (!d.lines.length) return { code: 400, error: 'Add at least one line before sending' };
      if (d.quote.valid_until && String(d.quote.valid_until).slice(0, 10) < new Date().toISOString().slice(0, 10)) return { code: 400, error: 'The "valid until" date has passed. Change it first.' };
      const company = (await c.query('SELECT name FROM tenants WHERE id = $1', [req.user.tid])).rows[0]?.name ?? 'LaborOps';
      const t = quoteToken(req.user.tid, id);
      const view = absUrl(`/quote?t=${t}`);
      const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      const subject = `${company} — Quote #${d.quote.number}: ${d.quote.title}`;
      const body = [
        d.quote.contact_name ? `Hi ${d.quote.contact_name},` : 'Hello,',
        b.message ?? `Here is our labor quote for ${d.quote.title}.`,
        `Total: ${money(d.totals.total)}${d.quote.valid_until ? ` (valid until ${String(d.quote.valid_until).slice(0, 10)})` : ''}`,
        'Open the quote to see the line items and accept or decline it.',
        `Download a PDF copy: ${absUrl(`/api/quote/pdf?t=${t}`)}`,
      ].join('\n\n');
      const m = renderEmail({
        title: subject, body, link: `/quote?t=${t}`, linkLabel: 'View the full quote',
        actions: [{ label: 'View & accept', url: view, kind: 'accept' }],
        footer: `You received this because ${company} sent you a quote.`,
      });
      await c.query(
        `INSERT INTO deliveries (tenant_id, user_id, channel, category, to_addr, subject, body, html) VALUES ($1,$2,'email','account',$3,$4,$5,$6)`,
        [req.user.tid, req.user.sub, to, subject, m.text, m.html]);
      await c.query("UPDATE quotes SET status='sent', sent_at=now(), sent_to=$2, responded_at=NULL, response_note=NULL, updated_at=now() WHERE id=$1", [id, to]);
      await audit(c, req.user.tid, req.user.sub, 'quote.send', 'quote', id, { to });
      await onQuote(c, req.user.tid, (await c.query('SELECT event_id FROM quotes WHERE id = $1', [id])).rows[0]?.event_id ?? null, 'sent', req.user.sub);
      return { code: 200, sentTo: to, link: view };
    });
    const { code, ...rest } = out as { code: number; [k: string]: unknown };
    return reply.code(code).send(rest);
  });

  // ---- PDF ----
  app.get('/api/quotes/:id/pdf', { preHandler: mgr }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { layoutId } = z.object({ layoutId: uuid.optional() }).parse(req.query);
    const out = await withTenant(req.user.tid, (c) => pdfFor(c, req.user.tid, id, layoutId));
    if (!out) return reply.code(404).send({ error: 'Quote not found' });
    return reply.header('content-type', 'application/pdf').header('content-disposition', `inline; filename="Quote-${out.number}.pdf"`).header('cache-control', 'no-store').send(out.pdf);
  });
  app.get('/api/quote/pdf', { config: limit }, async (req, reply) => {
    const { t } = z.object({ t: z.string().max(600) }).parse(req.query);
    const tok = readQuoteToken(t);
    if (!tok) return reply.code(400).send({ error: 'This link is invalid or has expired. Ask for a new quote.' });
    const out = await withTenant(tok.tid, async (c) => {
      const st = (await c.query('SELECT status FROM quotes WHERE id = $1', [tok.qid])).rows[0];
      return !st || st.status === 'draft' ? null : pdfFor(c, tok.tid, tok.qid);
    });
    if (!out) return reply.code(404).send({ error: 'This quote is no longer available.' });
    return reply.header('content-type', 'application/pdf').header('content-disposition', `inline; filename="Quote-${out.number}.pdf"`).header('cache-control', 'no-store').send(out.pdf);
  });

  // ---- layouts (the look of the PDF): admins design them, coordinators pick one per quote ----
  const adminOnly = guard('admin');
  app.get('/api/quote-layouts', { preHandler: mgr }, async (req) =>
    withTenant(req.user.tid, async (c) => ({ layouts: (await c.query('SELECT id, name, is_default FROM quote_layouts ORDER BY is_default DESC, lower(name)')).rows, builtIn: DEFAULT_LAYOUT })),
  );
  app.get('/api/quote-layouts/:id', { preHandler: adminOnly }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const row = await withTenant(req.user.tid, async (c) => (await c.query('SELECT id, name, is_default, config FROM quote_layouts WHERE id = $1', [id])).rows[0]);
    return row ? { layout: row } : reply.code(404).send({ error: 'Layout not found' });
  });
  const layoutBody = z.object({ name: z.string().trim().min(1).max(80), config: layoutSchema });
  app.post('/api/quote-layouts', { preHandler: adminOnly }, async (req, reply) => {
    const b = layoutBody.parse(req.body);
    const row = await withTenant(req.user.tid, async (c) => {
      if ((await c.query('SELECT 1 FROM quote_layouts WHERE lower(name) = lower($1)', [b.name])).rowCount) return null;
      const first = !(await c.query('SELECT 1 FROM quote_layouts')).rowCount;
      const r = (await c.query('INSERT INTO quote_layouts (tenant_id, name, config, is_default) VALUES ($1,$2,$3,$4) RETURNING id, name, is_default', [req.user.tid, b.name, JSON.stringify(b.config), first])).rows[0];
      await audit(c, req.user.tid, req.user.sub, 'quote_layout.create', 'quote_layout', r.id);
      return r;
    });
    return row ? reply.code(201).send({ layout: row }) : reply.code(409).send({ error: 'A layout with that name already exists' });
  });
  app.put('/api/quote-layouts/:id', { preHandler: adminOnly }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = layoutBody.parse(req.body);
    const r = await withTenant(req.user.tid, async (c) => {
      if ((await c.query('SELECT 1 FROM quote_layouts WHERE lower(name) = lower($1) AND id <> $2', [b.name, id])).rowCount) return { code: 409, error: 'A layout with that name already exists' };
      const row = (await c.query('UPDATE quote_layouts SET name=$2, config=$3, updated_at=now() WHERE id=$1 RETURNING id, name, is_default', [id, b.name, JSON.stringify(b.config)])).rows[0];
      if (row) await audit(c, req.user.tid, req.user.sub, 'quote_layout.update', 'quote_layout', id);
      return row ? { code: 200, layout: row } : { code: 404, error: 'Layout not found' };
    });
    const { code, ...rest } = r as { code: number; [k: string]: unknown };
    return reply.code(code).send(rest);
  });
  app.post('/api/quote-layouts/:id/default', { preHandler: adminOnly }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const ok = await withTenant(req.user.tid, async (c) => {
      if (!(await c.query('SELECT 1 FROM quote_layouts WHERE id = $1', [id])).rowCount) return false;
      await c.query('UPDATE quote_layouts SET is_default = false WHERE is_default');
      await c.query('UPDATE quote_layouts SET is_default = true WHERE id = $1', [id]);
      return true;
    });
    return ok ? { ok: true } : reply.code(404).send({ error: 'Layout not found' });
  });
  app.delete('/api/quote-layouts/:id', { preHandler: adminOnly }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const n = await withTenant(req.user.tid, async (c) => {
      const r = await c.query('DELETE FROM quote_layouts WHERE id = $1 RETURNING is_default', [id]);
      if (r.rows[0]?.is_default) await c.query('UPDATE quote_layouts SET is_default = true WHERE id = (SELECT id FROM quote_layouts ORDER BY created_at LIMIT 1)');
      return r.rowCount;
    });
    return n ? { ok: true } : reply.code(404).send({ error: 'Layout not found' });
  });
  // Render a layout that has not been saved yet, with a real quote's data or a sample, for the designer's live preview.
  app.post('/api/quote-layouts/preview', { preHandler: adminOnly }, async (req, reply) => {
    const b = z.object({ config: layoutSchema, quoteId: uuid.optional() }).parse(req.body);
    const pdf = await withTenant(req.user.tid, async (c) => {
      if (!b.quoteId) return renderQuotePdf(b.config, { ...SAMPLE, company: (await c.query('SELECT name FROM tenants WHERE id = $1', [req.user.tid])).rows[0]?.name ?? SAMPLE.company });
      const d = await load(c, b.quoteId);
      if (!d) return null;
      const q = d.quote;
      return renderQuotePdf(b.config, {
        company: (await c.query('SELECT name FROM tenants WHERE id = $1', [req.user.tid])).rows[0]?.name ?? '', number: q.number, title: q.title, status: q.status, customer: q.customer_name, contact: q.contact_name, event: q.event_name,
        createdAt: new Date(q.created_at).toISOString(), validUntil: q.valid_until ? String(q.valid_until).slice(0, 10) : null, intro: q.intro, terms: q.terms, taxPct: q.tax_pct,
        lines: d.lines.map((l) => ({ section: l.section, description: l.description, day: l.day, start: l.startTime, end: l.endTime, qty: l.qty, hours: l.hours, rate: l.rate, amount: l.amount })), totals: d.totals,
      });
    });
    if (!pdf) return reply.code(404).send({ error: 'Quote not found' });
    return reply.header('content-type', 'application/pdf').header('cache-control', 'no-store').send(pdf);
  });

  // ---- save a quote's shifts as a template that only appears for this quote's customer ----
  app.post('/api/quotes/:id/save-template', { preHandler: mgr }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ name: z.string().trim().min(1).max(100) }).parse(req.body);
    const out = await withTenant(req.user.tid, async (c) => {
      const d = await load(c, id);
      if (!d) return { code: 404, error: 'Quote not found' };
      if (!d.quote.customer_id) return { code: 400, error: 'Pick a customer on the quote first. The template is kept for that customer.' };
      const timed = d.lines.filter((l) => l.day && l.startTime && l.endTime);
      if (!timed.length) return { code: 400, error: 'Only lines with a date and start / end time can become shifts. Add times to at least one line.' };
      const first = timed.map((l) => l.day!).sort()[0];
      const items = timed.slice(0, 60).map((l) => ({
        role: l.description, section: l.section ?? undefined, dayOffset: Math.max(0, Math.round((Date.parse(l.day! + 'T00:00:00Z') - Date.parse(first + 'T00:00:00Z')) / 86_400_000)),
        start: l.startTime!, end: l.endTime!, headcount: Math.max(1, Math.round(l.qty)), isOpen: false, requiredCerts: [] as string[],
      }));
      if ((await c.query('SELECT 1 FROM shift_templates WHERE lower(name) = lower($1) AND customer_id = $2', [b.name, d.quote.customer_id])).rowCount) return { code: 409, error: 'This customer already has a template with that name' };
      const r = (await c.query('INSERT INTO shift_templates (tenant_id, name, items, customer_id) VALUES ($1,$2,$3,$4) RETURNING id, name', [req.user.tid, b.name, JSON.stringify(items), d.quote.customer_id])).rows[0];
      await audit(c, req.user.tid, req.user.sub, 'template.from_quote', 'template', r.id, { quote: id });
      return { code: 201, template: r, shifts: items.length, skipped: d.lines.length - timed.length };
    });
    const { code, ...rest } = out as { code: number; [k: string]: unknown };
    return reply.code(code).send(rest);
  });

  // ---- public: the customer's page. The signed token is the credential. ----
  app.get('/api/quote/view', { config: limit }, async (req, reply) => {
    const { t } = z.object({ t: z.string().max(600) }).parse(req.query);
    const tok = readQuoteToken(t);
    if (!tok) return reply.code(400).send({ error: 'This link is invalid or has expired. Ask for a new quote.' });
    const out = await withTenant(tok.tid, async (c) => {
      const d = await load(c, tok.qid);
      if (!d || d.quote.status === 'draft') return null;
      const tn = (await c.query('SELECT name FROM tenants WHERE id = $1', [tok.tid])).rows[0];
      const expired = !!d.quote.valid_until && String(d.quote.valid_until).slice(0, 10) < new Date().toISOString().slice(0, 10);
      const q = d.quote;
      return {
        company: tn?.name, number: q.number, title: q.title, customer: q.customer_name, status: q.status, validUntil: q.valid_until ? String(q.valid_until).slice(0, 10) : null,
        intro: q.intro, terms: q.terms, taxPct: q.tax_pct, lines: d.lines, pdfUrl: `/api/quote/pdf?t=${encodeURIComponent(t)}`, totals: d.totals, respondedAt: q.responded_at, responseNote: q.response_note,
        canRespond: q.status === 'sent' && !expired, reason: q.status !== 'sent' ? null : expired ? 'This quote has expired.' : null,
      };
    });
    return out ? { quote: out } : reply.code(404).send({ error: 'This quote is no longer available.' });
  });

  app.post('/api/quote/respond', { config: limit }, async (req, reply) => {
    const b = z.object({ t: z.string().max(600), response: z.enum(['accepted', 'declined']), note: z.string().trim().max(2000).optional() }).parse(req.body);
    const tok = readQuoteToken(b.t);
    if (!tok) return reply.code(400).send({ error: 'This link is invalid or has expired. Ask for a new quote.' });
    const out = await withTenant(tok.tid, async (c) => {
      const q = (await c.query('SELECT id, number, title, status, valid_until, created_by FROM quotes WHERE id = $1 FOR UPDATE', [tok.qid])).rows[0];
      if (!q || q.status === 'draft') return { code: 404, error: 'This quote is no longer available.' };
      if (q.status !== 'sent') return { code: 409, error: `This quote was already ${q.status}.` };
      if (q.valid_until && String(q.valid_until).slice(0, 10) < new Date().toISOString().slice(0, 10)) return { code: 409, error: 'This quote has expired.' };
      await c.query('UPDATE quotes SET status=$2, responded_at=now(), response_note=$3, updated_at=now() WHERE id=$1', [q.id, b.response, b.note || null]);
      await notifyStaff(c, tok.tid, {
        category: 'approval_result', title: `Quote #${q.number} ${b.response}`,
        body: `${q.title} was ${b.response} by the customer.${b.note ? ` They wrote: "${b.note}"` : ''}`, link: `/quotes/${q.id}`,
      });
      await audit(c, tok.tid, null, 'quote.respond', 'quote', q.id, { response: b.response });
      await onQuote(c, tok.tid, (await c.query('SELECT event_id FROM quotes WHERE id = $1', [q.id])).rows[0]?.event_id ?? null, b.response, null);
      return { code: 200, status: b.response };
    });
    const { code, ...rest } = out as { code: number; [k: string]: unknown };
    return reply.code(code).send(rest);
  });
}
