import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTenant, audit } from '../db';
import { guard } from '../auth';
import { config } from '../config';
import { canAdjustRates } from '../rates';
import { acctSchema, loadAcct, saveAcct, eventBilling, invoiceIif, PAYROLL_PROVIDERS, baseRole, localDate } from '../accounting';
import { payrollSummary, payrollFile } from '../payroll';
import { loadQbo, saveQbo, qboConnected, authorizeUrl, exchangeCode, Qbo, qboSession, appLink, QboError, QBO_REVOKE } from '../quickbooks';

const adm = guard('admin');
const mgr = guard('admin', 'manager');
const uuid = z.string().uuid();
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// OAuth "state" is signed with its own key so it can never stand in for a session token.
const stateKey = () => crypto.createHash('sha256').update('quickbooks-state:' + config.jwtSecret).digest();
const signState = (tid: string, sub: string) => {
  const body = Buffer.from(JSON.stringify({ tid, sub, exp: Date.now() + 15 * 60_000, n: crypto.randomBytes(8).toString('hex') })).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', stateKey()).update(body).digest('base64url')}`;
};
const readState = (st: string): { tid: string; sub: string } | null => {
  const [body, sig] = st.split('.');
  if (!body || !sig) return null;
  const want = crypto.createHmac('sha256', stateKey()).update(body).digest('base64url');
  if (want.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return null;
  try {
    const j = JSON.parse(Buffer.from(body, 'base64url').toString());
    return j.exp > Date.now() ? j : null;
  } catch {
    return null;
  }
};

const redirectUri = () => `${config.appUrl}/api/quickbooks/callback`;
const fail = (reply: any, e: unknown) => {
  if (e instanceof QboError) return reply.code(e.status).send({ error: e.message });
  throw e;
};
const download = (reply: any, name: string, type: string, body: string) => {
  reply.header('content-type', `${type}; charset=utf-8`);
  reply.header('content-disposition', `attachment; filename="${name}"`);
  return body;
};
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'event';

export async function accountingRoutes(app: FastifyInstance) {
  // ---------- settings ----------
  app.get('/api/accounting', { preHandler: adm }, async (req) =>
    withTenant(req.user.tid, async (c) => {
      const q = await loadQbo(c);
      const roles = (await c.query('SELECT id, name, bill_rate, day_bill_rate, qbo_item_id FROM skills WHERE active ORDER BY lower(name)')).rows;
      return {
        settings: await loadAcct(c),
        quickbooks: {
          clientId: q?.clientId ?? '',
          clientSecretSet: !!q?.clientSecret,
          environment: q?.environment ?? 'sandbox',
          connected: qboConnected(q),
          companyName: q?.companyName ?? null,
          connectedAt: q?.connectedAt ?? null,
          expired: !!(q?.refreshExpiresAt && q.refreshExpiresAt < Date.now()),
          redirectUri: redirectUri(),
        },
        roles: roles.map((r) => ({ id: r.id, name: r.name, billRate: Number(r.bill_rate), dayBillRate: Number(r.day_bill_rate), qboItemId: r.qbo_item_id })),
      };
    }),
  );

  app.put('/api/accounting/settings', { preHandler: adm }, async (req) => {
    const b = acctSchema.parse(req.body);
    return withTenant(req.user.tid, async (c) => {
      const s = await saveAcct(c, req.user.tid, b);
      await audit(c, req.user.tid, req.user.sub, 'accounting.settings', 'tenant', req.user.tid, { payroll: s.payroll.enabled });
      return { settings: s };
    });
  });

  // Which QuickBooks service item each position is billed as (null = the default item).
  app.put('/api/accounting/role-items', { preHandler: adm }, async (req) => {
    const { items } = z.object({ items: z.record(uuid, z.string().max(40).nullable()) }).parse(req.body);
    await withTenant(req.user.tid, async (c) => {
      for (const [id, item] of Object.entries(items)) await c.query('UPDATE skills SET qbo_item_id = $2 WHERE id = $1', [id, item || null]);
      await audit(c, req.user.tid, req.user.sub, 'accounting.role_items', 'tenant', req.user.tid, { count: Object.keys(items).length });
    });
    return { ok: true };
  });

  // ---------- QuickBooks Online connection ----------
  app.put('/api/accounting/quickbooks', { preHandler: adm }, async (req) => {
    const b = z.object({ clientId: z.string().trim().min(5).max(200), clientSecret: z.string().trim().min(5).max(300).optional(), environment: z.enum(['sandbox', 'production']) }).parse(req.body);
    await withTenant(req.user.tid, async (c) => {
      const cur = await loadQbo(c);
      // Switching app keys or sandbox/production drops the old connection.
      const reset = cur && (cur.clientId !== b.clientId || cur.environment !== b.environment) ? { realmId: '', accessToken: '', refreshToken: '', expiresAt: 0, connectedAt: '', companyName: '' } : {};
      await saveQbo(c, req.user.tid, req.user.sub, { clientId: b.clientId, environment: b.environment, ...(b.clientSecret ? { clientSecret: b.clientSecret } : {}), ...reset });
      await audit(c, req.user.tid, req.user.sub, 'accounting.quickbooks.keys', 'integration', null, { environment: b.environment });
    });
    return { ok: true };
  });

  app.get('/api/quickbooks/connect', { preHandler: adm }, async (req, reply) => {
    const q = await withTenant(req.user.tid, (c) => loadQbo(c));
    if (!q?.clientId || !q.clientSecret) return reply.code(400).send({ error: 'Save your QuickBooks client ID and client secret first' });
    return { url: authorizeUrl(q, redirectUri(), signState(req.user.tid, req.user.sub)) };
  });

  app.get('/api/quickbooks/callback', { preHandler: adm }, async (req, reply) => {
    const q = z.object({ code: z.string().min(5).max(2000).optional(), state: z.string().min(10).max(4000), realmId: z.string().regex(/^\d{1,30}$/).optional(), error: z.string().optional() }).parse(req.query);
    const st = readState(q.state);
    if (!st || st.sub !== req.user.sub || st.tid !== req.user.tid) return reply.redirect('/integrations?qbo=invalid');
    if (q.error || !q.code || !q.realmId) return reply.redirect('/integrations?qbo=denied');
    try {
      await withTenant(req.user.tid, async (c) => {
        const cfg = await loadQbo(c);
        if (!cfg) throw new QboError('Save your QuickBooks keys first', 400);
        const t = await exchangeCode(cfg, q.code!, redirectUri());
        const saved = await saveQbo(c, req.user.tid, req.user.sub, { ...t, realmId: q.realmId!, connectedAt: new Date().toISOString() });
        const name = await new Qbo({ ...saved, realmId: q.realmId! }, async (p) => void (await saveQbo(c, req.user.tid, null, p))).companyName().catch(() => undefined);
        if (name) await saveQbo(c, req.user.tid, null, { companyName: name });
        await audit(c, req.user.tid, req.user.sub, 'accounting.quickbooks.connect', 'integration', null, { realmId: q.realmId });
      });
      return reply.redirect('/integrations?qbo=connected');
    } catch (e) {
      req.log.error(e);
      return reply.redirect('/integrations?qbo=failed');
    }
  });

  app.post('/api/quickbooks/disconnect', { preHandler: adm }, async (req) => {
    await withTenant(req.user.tid, async (c) => {
      const q = await loadQbo(c);
      if (q?.refreshToken) {
        // Best effort: tell Intuit to drop the tokens too.
        await fetch(QBO_REVOKE, {
          method: 'POST',
          headers: { authorization: 'Basic ' + Buffer.from(`${q.clientId}:${q.clientSecret}`).toString('base64'), 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ token: q.refreshToken }),
          signal: AbortSignal.timeout(10_000),
        }).catch(() => undefined);
      }
      await saveQbo(c, req.user.tid, req.user.sub, { realmId: '', accessToken: '', refreshToken: '', expiresAt: 0, refreshExpiresAt: 0, connectedAt: '', companyName: '' });
      await audit(c, req.user.tid, req.user.sub, 'accounting.quickbooks.disconnect', 'integration', null);
    });
    return { ok: true };
  });

  // Items, income accounts and employees from QuickBooks, for the mapping drop-downs.
  app.get('/api/quickbooks/lookups', { preHandler: adm }, async (req, reply) => {
    try {
      return await withTenant(req.user.tid, async (c) => {
        const qb = await qboSession(c, req.user.tid);
        const [items, accounts, employees] = await Promise.all([qb.items(), qb.incomeAccounts(), qb.employees()]);
        return {
          items: items.filter((i) => i.Active !== false).map((i) => ({ id: i.Id, name: i.Name })),
          accounts: accounts.map((a) => ({ id: a.Id, name: a.Name })),
          employees: employees.map((e) => ({ id: e.Id, name: e.DisplayName, email: e.PrimaryEmailAddr?.Address ?? null })),
        };
      });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/api/quickbooks/items', { preHandler: adm }, async (req, reply) => {
    const b = z.object({ name: z.string().trim().min(1).max(100), incomeAccountId: z.string().min(1).max(40) }).parse(req.body);
    try {
      return await withTenant(req.user.tid, async (c) => ({ id: await (await qboSession(c, req.user.tid)).createItem(b.name, b.incomeAccountId), name: b.name }));
    } catch (e) {
      return fail(reply, e);
    }
  });

  // ---------- billing an event ----------
  const sourceQ = z.object({ source: z.enum(['time', 'schedule']).default('time') });

  app.get('/api/events/:id/billing', { preHandler: mgr }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { source } = sourceQ.parse(req.query);
    const out = await withTenant(req.user.tid, async (c) => {
      const b = await eventBilling(c, id, source);
      if (!b) return null;
      const q = await loadQbo(c);
      const canBill = await canAdjustRates(c, req.user);
      return {
        ...b,
        canBill,
        quickbooks: { connected: qboConnected(q), environment: q?.environment ?? 'sandbox' },
        invoices: b.invoices.map((i: any) => ({ ...i, url: i.provider === 'qbo' && i.external_id && q ? appLink(q.environment, 'invoice', i.external_id) : null })),
        unmapped: b.lines.filter((l) => !l.qboItemId).map((l) => l.role).filter((v, i, a) => a.indexOf(v) === i),
      };
    });
    return out ?? reply.code(404).send({ error: 'Event not found' });
  });

  app.post('/api/events/:id/billing/quickbooks', { preHandler: mgr }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ source: z.enum(['time', 'schedule']), again: z.boolean().optional() }).parse(req.body);
    try {
      const out = await withTenant(req.user.tid, async (c) => {
        if (!(await canAdjustRates(c, req.user))) return { code: 403, error: 'Only admins and coordinators allowed to adjust rates can create invoices.' };
        const bill = await eventBilling(c, id, b.source);
        if (!bill) return { code: 404, error: 'Event not found' };
        if (!bill.customer) return { code: 400, error: 'Pick a customer for this event first (Event details).' };
        if (!bill.lines.length || bill.total <= 0) return { code: 400, error: 'Nothing to bill yet.' };
        if (!b.again && bill.invoices.some((i: any) => i.provider === 'qbo')) return { code: 409, error: 'This event already has a QuickBooks invoice. Create another one only if that is intended.', reason: 'duplicate' };
        const missing = bill.lines.filter((l) => !l.qboItemId);
        if (missing.length) return { code: 400, error: `Choose a QuickBooks item for ${[...new Set(missing.map((l) => l.role))].join(', ')} (or a default item) under Integrations.` };
        const qb = await qboSession(c, req.user.tid);
        let customerId = bill.customer.qbo_customer_id as string | null;
        if (!customerId) {
          customerId = await qb.ensureCustomer({ name: bill.customer.name, email: bill.customer.email, phone: bill.customer.phone });
          await c.query('UPDATE customers SET qbo_customer_id = $2 WHERE id = $1', [bill.customer.id, customerId]);
        }
        const firstDate = bill.lines[0].date;
        const inv = await qb.createInvoice({
          customerId,
          txnDate: localDate(bill.event.timezone, new Date()),
          memo: `${bill.event.name} (${firstDate}${bill.lines[bill.lines.length - 1].date !== firstDate ? ` to ${bill.lines[bill.lines.length - 1].date}` : ''})`,
          note: `Created by LaborOps from ${b.source === 'time' ? 'approved time' : 'the schedule'}.`,
          lines: bill.lines.map((l) => ({ itemId: l.qboItemId!, description: l.description, qty: l.qty, rate: l.rate, amount: l.amount, date: l.date })),
        });
        await c.query(
          'INSERT INTO event_invoices (tenant_id, event_id, provider, source, external_id, doc_number, total, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          [req.user.tid, id, 'qbo', b.source, inv.id, inv.docNumber, inv.total || bill.total, req.user.sub],
        );
        await audit(c, req.user.tid, req.user.sub, 'billing.quickbooks', 'event', id, { invoice: inv.id, total: inv.total || bill.total });
        return { code: 201, invoice: { ...inv, url: appLink(qb.env, 'invoice', inv.id) } };
      });
      const { code, ...body } = out as any;
      return reply.code(code).send(body);
    } catch (e) {
      return fail(reply, e);
    }
  });

  // QuickBooks Desktop: the same invoice as an .IIF file to import (File > Utilities > Import > IIF Files).
  app.get('/api/events/:id/billing/iif', { preHandler: mgr }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const q = sourceQ.extend({ docNumber: z.string().trim().max(21).regex(/^[\w-]*$/).optional() }).parse(req.query);
    const out = await withTenant(req.user.tid, async (c) => {
      if (!(await canAdjustRates(c, req.user))) return { code: 403 as const };
      const bill = await eventBilling(c, id, q.source);
      if (!bill) return { code: 404 as const };
      if (!bill.lines.length) return { code: 400 as const };
      const s = await loadAcct(c);
      const body = invoiceIif(s.desktop, {
        customer: bill.customer?.name ?? bill.event.client ?? bill.event.name,
        date: localDate(bill.event.timezone, new Date()),
        docNumber: q.docNumber || undefined,
        memo: bill.event.name,
        lines: bill.lines,
      });
      await c.query('INSERT INTO event_invoices (tenant_id, event_id, provider, source, doc_number, total, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)', [req.user.tid, id, 'iif', q.source, q.docNumber || null, bill.total, req.user.sub]);
      await audit(c, req.user.tid, req.user.sub, 'billing.iif', 'event', id, { total: bill.total });
      return { code: 200 as const, body, name: `${slug(bill.event.name)}-invoice.iif` };
    });
    if (out.code === 403) return reply.code(403).send({ error: 'Only admins and coordinators allowed to adjust rates can export invoices.' });
    if (out.code === 404) return reply.code(404).send({ error: 'Event not found' });
    if (out.code === 400) return reply.code(400).send({ error: 'Nothing to bill yet.' });
    return download(reply, out.name, 'text/plain', out.body);
  });

  // ---------- payroll ----------
  const period = z.object({ from: ymd, to: ymd }).refine((p) => p.from <= p.to, 'The period ends before it starts').refine((p) => (+new Date(p.to) - +new Date(p.from)) / 86400000 <= 62, 'Choose a period of two months or less');

  app.get('/api/payroll', { preHandler: adm }, async (req) => {
    const p = period.parse(req.query);
    return withTenant(req.user.tid, async (c) => {
      const sum = await payrollSummary(c, p.from, p.to);
      const s = await loadAcct(c);
      const history = (await c.query(`SELECT x.id, x.provider, x.period_start::text, x.period_end::text, x.people, x.entries, x.gross, x.created_at, u.name AS created_by FROM payroll_exports x LEFT JOIN users u ON u.id = x.created_by ORDER BY x.created_at DESC LIMIT 20`)).rows;
      const missingIds = Object.fromEntries(s.payroll.enabled.map((prov) => [prov, sum.people.filter((x) => !x.payrollIds[prov]).map((x) => x.name)]));
      return { ...sum, payroll: s.payroll, history, missingIds, quickbooksConnected: qboConnected(await loadQbo(c)) };
    });
  });

  const markExported = async (c: any, tid: string, sub: string, provider: string, p: { from: string; to: string }, people: Awaited<ReturnType<typeof payrollSummary>>['people']) => {
    const ids = people.flatMap((x) => x.entries.map((e) => e.id));
    if (ids.length) await c.query('UPDATE time_entries SET payroll_exported_at = now() WHERE id = ANY($1::uuid[])', [ids]);
    await c.query('INSERT INTO payroll_exports (tenant_id, provider, period_start, period_end, people, entries, gross, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [
      tid, provider, p.from, p.to, people.length, ids.length, Math.round(people.reduce((s, x) => s + (x.gross ?? 0), 0) * 100) / 100, sub,
    ]);
    await audit(c, tid, sub, 'payroll.export', 'tenant', tid, { provider, ...p, entries: ids.length });
  };

  app.get('/api/payroll/export', { preHandler: adm }, async (req, reply) => {
    const q = z.object({ provider: z.enum([...PAYROLL_PROVIDERS, 'csv']), mark: z.enum(['0', '1']).default('1') }).and(period).parse(req.query);
    const out = await withTenant(req.user.tid, async (c) => {
      const s = await loadAcct(c);
      if (q.provider !== 'csv' && !s.payroll.enabled.includes(q.provider)) return null;
      const sum = await payrollSummary(c, q.from, q.to);
      const f = payrollFile(q.provider, s, sum.people);
      if (q.mark === '1' && q.provider !== 'csv') await markExported(c, req.user.tid, req.user.sub, q.provider, q, sum.people);
      return f;
    });
    if (!out) return reply.code(400).send({ error: 'Turn that payroll provider on under Integrations first.' });
    return download(reply, `${out.name}-${q.from}-to-${q.to}.csv`, 'text/csv', out.body);
  });

  // What a worked entry is called in QuickBooks. The hours split at the end is extra detail, not part of what identifies it.
  const qbBase = (e: { event: string; role: string; day: boolean }) => `${e.event} · ${baseRole(e.role)}${e.day ? ' · day rate' : ''}`;
  // The detail in brackets at the end: hours, the hourly rate (a day rate divided by the hours) and the overtime split.
  const qbNote = (e: { event: string; role: string; day: boolean; hours: number; reg: number; ot: number; dt: number; rate: number | null; pay: number | null }) => {
    const h = (n: number) => String(Math.round(n * 100) / 100);
    const $ = (n: number) => `$${(Math.round(n * 100) / 100).toFixed(2).replace(/\.00$/, '')}`;
    const at = e.rate ? ` @ ${$(e.rate)}/h` : '';
    const detail = e.day
      ? `${h(e.hours)} h${at}${e.pay ? ` = ${$(e.pay)} day rate` : ''}`
      : `${h(e.hours)} h${at}${e.ot || e.dt ? `: ${h(e.reg)} reg + ${h(e.ot)} OT${e.dt ? ` + ${h(e.dt)} DT` : ''}` : ''}`;
    return `${qbBase(e)} (${detail})`;
  };
  const qbKey = (emp: string | null, date: string, hours: number, desc: string) => `${emp}|${date}|${hours.toFixed(2)}|${desc.replace(/ \([\d.]+ h\b[^)]*\)$/, '')}`;

  // QuickBooks Payroll: send each worked entry as a time activity on the employee. QuickBooks Payroll works out
  // overtime itself from the week's hours; the split LaborOps calculated is written in the note.
  app.post('/api/payroll/quickbooks', { preHandler: adm }, async (req, reply) => {
    const p = { ...period.parse(req.body), ...z.object({ addMissing: z.boolean().default(true), includeExported: z.boolean().default(false) }).parse(req.body ?? {}) };
    try {
      const out = await withTenant(req.user.tid, async (c) => {
        const s = await loadAcct(c);
        if (!s.payroll.enabled.includes('quickbooks')) return { code: 400, error: 'Turn QuickBooks payroll on under Integrations first.' };
        const qb = await qboSession(c, req.user.tid);
        const sum = await payrollSummary(c, p.from, p.to);
        const emps = await qb.employees();
        const byName = new Map(emps.map((e) => [e.DisplayName.trim().toLowerCase(), e.Id]));
        const byEmail = new Map(emps.filter((e) => e.PrimaryEmailAddr?.Address).map((e) => [e.PrimaryEmailAddr!.Address.toLowerCase(), e.Id]));
        const skipped: string[] = [];
        const created: string[] = [];
        const linked: string[] = [];
        const sent: typeof sum.people = [];
        let activities = 0;
        let alreadyExported = 0;
        let alreadyInQbo = 0;
        let updated = 0;
        const peopleSent = new Set<string>();
        // What is already in QuickBooks for this period: an identical entry is linked, not sent again.
        const inQbo = new Map<string, string[]>();
        const qbById = new Map<string, Awaited<ReturnType<typeof qb.timeActivities>>[number]>();
        for (const a of await qb.timeActivities(p.from, p.to)) {
          qbById.set(a.id, a);
          const k = qbKey(a.employeeId, a.date, a.hours, a.description);
          inQbo.set(k, [...(inQbo.get(k) ?? []), a.id]);
        }
        const sentIds = new Map<string, string | null>(
          (await c.query('SELECT id, qbo_time_activity_id FROM time_entries WHERE id = ANY($1::uuid[])', [sum.people.flatMap((x) => x.entries.map((e) => e.id))])).rows.map((r) => [r.id, r.qbo_time_activity_id]),
        );
        const used = new Set([...sentIds.values()].filter(Boolean) as string[]);
        const valid = new Set(emps.map((e) => String(e.Id)));
        for (const person of sum.people) {
          // Saved ID first (if it still exists in QuickBooks), then email, then name; otherwise add them as an employee.
          let empId = person.payrollIds.quickbooks && valid.has(person.payrollIds.quickbooks) ? person.payrollIds.quickbooks : byEmail.get(person.email.toLowerCase()) || byName.get(person.name.trim().toLowerCase());
          if (!empId && p.addMissing) {
            try {
              const phone = (await c.query('SELECT phone FROM users WHERE id = $1', [person.userId])).rows[0]?.phone ?? null;
              const made = await qb.createEmployee({ name: person.name, email: person.email, phone });
              empId = made.id;
              (made.created ? created : linked).push(person.name);
            } catch (e) {
              skipped.push(`${person.name} (${String((e as Error).message).replace(/^QuickBooks: /, '').slice(0, 120)})`);
              continue;
            }
          } else if (empId && empId !== person.payrollIds.quickbooks) linked.push(person.name);
          if (!empId) {
            skipped.push(person.name);
            continue;
          }
          // Remember the QuickBooks employee, so the next run (and the crew profile) uses it directly.
          if (empId !== person.payrollIds.quickbooks) {
            await c.query(`UPDATE users SET payroll_ids = payroll_ids || jsonb_build_object('quickbooks', $2::text) WHERE id = $1`, [person.userId, empId]);
            person.payrollIds.quickbooks = empId;
          }
          for (const e of person.entries) {
            const want = { employeeId: empId, date: e.date, hours: e.hours, description: qbNote(e), costRate: e.rate };
            // Already in QuickBooks: bring its hours, rate and note up to date (for example entries sent before rates were included).
            const refresh = async (taId: string) => {
              const cur = qbById.get(taId);
              if (!cur) return;
              if (cur.description === want.description && cur.costRate === (e.rate ? Math.round(e.rate * 100) / 100 : null) && cur.hours === Math.round(e.hours * 100) / 100 && cur.employeeId === empId) return;
              await qb.updateTimeActivity(cur.id, cur.syncToken, want);
              updated++;
            };
            const saved = sentIds.get(e.id);
            if (saved) {
              await refresh(saved);
              alreadyInQbo++;
              continue;
            }
            const twin = (inQbo.get(qbKey(empId, e.date, e.hours, qbBase(e))) ?? []).find((id) => !used.has(id));
            if (twin) {
              // Sent before this was tracked: remember it instead of sending a copy.
              used.add(twin);
              await c.query('UPDATE time_entries SET qbo_time_activity_id = $2 WHERE id = $1', [e.id, twin]);
              await refresh(twin);
              alreadyInQbo++;
              continue;
            }
            if (e.exported && !p.includeExported) {
              alreadyExported++;
              continue;
            }
            const taId = await qb.createTimeActivity(want);
            await c.query('UPDATE time_entries SET qbo_time_activity_id = $2 WHERE id = $1', [e.id, taId]);
            activities++;
            peopleSent.add(person.userId);
          }
          sent.push(person);
        }
        if (sent.length) await markExported(c, req.user.tid, req.user.sub, 'quickbooks', p, sent);
        if (created.length || linked.length) await audit(c, req.user.tid, req.user.sub, 'payroll.quickbooks_employees', 'tenant', req.user.tid, { created, linked });
        return { code: 200, people: peopleSent.size, activities, updated, alreadyExported, alreadyInQbo, skipped, created, linked };
      });
      const { code, ...body } = out as any;
      return reply.code(code).send(body);
    } catch (e) {
      return fail(reply, e);
    }
  });

  // Remove extra copies of the same worked entry that LaborOps sent to QuickBooks more than once in a period.
  app.post('/api/payroll/quickbooks/dedupe', { preHandler: adm }, async (req, reply) => {
    const p = period.parse(req.body);
    try {
      const out = await withTenant(req.user.tid, async (c) => {
        const qb = await qboSession(c, req.user.tid);
        const linked = new Set((await c.query('SELECT qbo_time_activity_id AS id FROM time_entries WHERE qbo_time_activity_id IS NOT NULL')).rows.map((r) => r.id as string));
        const groups = new Map<string, Awaited<ReturnType<typeof qb.timeActivities>>>();
        for (const a of await qb.timeActivities(p.from, p.to)) {
          if (!a.employeeId || !a.description.includes(' · ')) continue; // only what LaborOps sent
          const k = qbKey(a.employeeId, a.date, a.hours, a.description);
          groups.set(k, [...(groups.get(k) ?? []), a]);
        }
        // How many of each entry LaborOps really has (two identical shifts on one day are not duplicates).
        const expected = new Map<string, number>();
        for (const person of (await payrollSummary(c, p.from, p.to)).people) {
          const emp = person.payrollIds.quickbooks;
          if (!emp) continue;
          for (const e of person.entries) {
            const k = qbKey(emp, e.date, e.hours, qbBase(e));
            expected.set(k, (expected.get(k) ?? 0) + 1);
          }
        }
        let removed = 0;
        for (const [k, list] of groups) {
          const keepCount = Math.max(1, expected.get(k) ?? 1);
          if (list.length <= keepCount) continue;
          // Keep the ones LaborOps has on record first.
          const ordered = [...list.filter((a) => linked.has(a.id)), ...list.filter((a) => !linked.has(a.id))];
          for (const a of ordered.slice(keepCount)) {
            await qb.deleteTimeActivity(a.id, a.syncToken);
            removed++;
          }
        }
        if (removed) await audit(c, req.user.tid, req.user.sub, 'payroll.quickbooks_dedupe', 'tenant', req.user.tid, { ...p, removed });
        return { removed };
      });
      return out;
    } catch (e) {
      return fail(reply, e);
    }
  });

  // Each person's ID in the payroll systems (ADP File #, Gusto employee ID, QuickBooks employee).
  app.put('/api/crew/:id/payroll-ids', { preHandler: adm }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const v = z.string().trim().max(40).regex(/^[\w .@-]*$/, 'Use letters, numbers, dots, dashes or @').optional();
    const b = z.object({ adp: v, gusto: v, quickbooks: v }).strict().parse(req.body);
    const row = await withTenant(req.user.tid, async (c) => {
      const cur = (await c.query('SELECT payroll_ids FROM users WHERE id = $1', [id])).rows[0];
      if (!cur) return null;
      const next: Record<string, string> = { ...(cur.payroll_ids ?? {}) };
      for (const [k, val] of Object.entries(b)) {
        if (val === undefined) continue;
        if (val) next[k] = val;
        else delete next[k];
      }
      await c.query('UPDATE users SET payroll_ids = $2 WHERE id = $1', [id, JSON.stringify(next)]);
      await audit(c, req.user.tid, req.user.sub, 'user.payroll_ids', 'user', id, { providers: Object.keys(next) });
      return next;
    });
    return row ? { payrollIds: row } : reply.code(404).send({ error: 'Person not found' });
  });
}
