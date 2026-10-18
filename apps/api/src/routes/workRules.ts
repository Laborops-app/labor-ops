import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { guard } from '../auth';
import { withTenant, audit } from '../db';
import { parseRules, rulesForEvents, workRulesSchema } from '../workRules';

/** Starting points an admin can copy and adjust. Not legal advice: every local's agreement differs. */
const PRESETS = [
  {
    name: 'Union stagehands (starter)',
    description: 'A typical stagehand agreement shape: 4-hour minimum call, OT after 8 and double time after 12 a day, meal penalty after 5 hours, 10-hour turnaround at time and a half, 24-hour cancellation notice. Check every number against your local’s agreement.',
    config: {
      otAfter: 8, dtAfter: 12, otMult: 1.5, dtMult: 2,
      premiums: { nightPct: null, saturdayPct: null, sundayPct: 50, holidayPct: 100 },
      minCallH: 4, rounding: { minutes: 15, mode: 'worker' },
      meal: { afterH: 5, breakMin: 30, stepMin: 30, amounts: [10, 12.5, 15] },
      turnaround: { restH: 10, mult: 1.5 },
      cancellation: { noticeH: 24, payH: 4 },
    },
  },
  {
    name: 'Non-union (starter)',
    description: 'State overtime only, a 4-hour minimum call and 15-minute rounding to the nearest quarter hour.',
    config: { minCallH: 4, rounding: { minutes: 15, mode: 'nearest' } },
  },
];

export async function workRuleRoutes(app: FastifyInstance) {
  const admin = guard('admin');
  const staff = guard('admin', 'manager', 'hr');
  const mgr = guard('admin', 'manager');
  const idParam = z.object({ id: z.string().uuid() });
  const setBody = z.object({ name: z.string().trim().min(1).max(80), isDefault: z.boolean().default(false), config: workRulesSchema });

  app.get('/api/work-rule-sets', { preHandler: staff }, async (req) =>
    withTenant(req.user.tid, async (c) => ({
      sets: (
        await c.query(
          `SELECT w.id, w.name, w.is_default, w.config, w.updated_at,
                  (SELECT count(*)::int FROM customers cu WHERE cu.rule_set_id = w.id) AS customers,
                  (SELECT count(*)::int FROM events e WHERE e.rule_set_id = w.id) AS events
             FROM work_rule_sets w ORDER BY w.is_default DESC, lower(w.name)`,
        )
      ).rows.map((r) => ({ ...r, config: (() => { try { return parseRules(r.config); } catch { return parseRules({}); } })() })),
      presets: PRESETS.map((p) => ({ ...p, config: parseRules(p.config) })),
    })),
  );

  const save = async (tid: string, sub: string, id: string | null, b: z.infer<typeof setBody>) =>
    withTenant(tid, async (c) => {
      if (b.isDefault) await c.query('UPDATE work_rule_sets SET is_default = false WHERE is_default AND ($1::uuid IS NULL OR id <> $1)', [id]);
      const r = id
        ? (await c.query('UPDATE work_rule_sets SET name = $2, is_default = $3, config = $4, updated_at = now() WHERE id = $1 RETURNING id, name, is_default, config', [id, b.name, b.isDefault, JSON.stringify(b.config)])).rows[0]
        : (await c.query('INSERT INTO work_rule_sets (tenant_id, name, is_default, config) VALUES ($1,$2,$3,$4) RETURNING id, name, is_default, config', [tid, b.name, b.isDefault, JSON.stringify(b.config)])).rows[0];
      if (r) await audit(c, tid, sub, id ? 'work_rules.update' : 'work_rules.create', 'work_rule_set', r.id, { name: b.name, isDefault: b.isDefault });
      return r;
    });

  app.post('/api/work-rule-sets', { preHandler: admin }, async (req, reply) => {
    const b = setBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: b.error.issues[0]?.message ?? 'Check the rules' });
    try {
      return reply.code(201).send({ set: await save(req.user.tid, req.user.sub, null, b.data) });
    } catch (e: any) {
      if (e?.code === '23505') return reply.code(409).send({ error: 'A rule set with that name already exists' });
      throw e;
    }
  });

  app.put('/api/work-rule-sets/:id', { preHandler: admin }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const b = setBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: b.error.issues[0]?.message ?? 'Check the rules' });
    try {
      const r = await save(req.user.tid, req.user.sub, id, b.data);
      return r ? { set: r } : reply.code(404).send({ error: 'Rule set not found' });
    } catch (e: any) {
      if (e?.code === '23505') return reply.code(409).send({ error: 'A rule set with that name already exists' });
      throw e;
    }
  });

  app.delete('/api/work-rule-sets/:id', { preHandler: admin }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const n = await withTenant(req.user.tid, async (c) => {
      const r = await c.query('DELETE FROM work_rule_sets WHERE id = $1 RETURNING name', [id]);
      if (r.rowCount) await audit(c, req.user.tid, req.user.sub, 'work_rules.delete', 'work_rule_set', id, { name: r.rows[0].name });
      return r.rowCount;
    });
    return n ? { ok: true } : reply.code(404).send({ error: 'Rule set not found' });
  });

  // Which rules a customer / an event uses (null = fall back: event → customer → company default).
  const pick = z.object({ ruleSetId: z.string().uuid().nullable() });
  app.put('/api/customers/:id/rule-set', { preHandler: mgr }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const { ruleSetId } = pick.parse(req.body);
    const r = await withTenant(req.user.tid, async (c) => {
      if (ruleSetId && !(await c.query('SELECT 1 FROM work_rule_sets WHERE id = $1', [ruleSetId])).rowCount) return 'bad';
      const u = await c.query('UPDATE customers SET rule_set_id = $2 WHERE id = $1', [id, ruleSetId]);
      if (u.rowCount) await audit(c, req.user.tid, req.user.sub, 'customer.rule_set', 'customer', id, { ruleSetId });
      return u.rowCount;
    });
    if (r === 'bad') return reply.code(400).send({ error: 'Rule set not found' });
    return r ? { ok: true } : reply.code(404).send({ error: 'Customer not found' });
  });
  app.put('/api/events/:id/rule-set', { preHandler: mgr }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const { ruleSetId } = pick.parse(req.body);
    const r = await withTenant(req.user.tid, async (c) => {
      if (ruleSetId && !(await c.query('SELECT 1 FROM work_rule_sets WHERE id = $1', [ruleSetId])).rowCount) return 'bad';
      const u = await c.query('UPDATE events SET rule_set_id = $2 WHERE id = $1', [id, ruleSetId]);
      if (!u.rowCount) return null;
      await audit(c, req.user.tid, req.user.sub, 'event.rule_set', 'event', id, { ruleSetId });
      return (await rulesForEvents(c, [id])).get(id) ?? null;
    });
    if (r === 'bad') return reply.code(400).send({ error: 'Rule set not found' });
    return r === null ? { effective: null } : r === undefined ? reply.code(404).send({ error: 'Event not found' }) : { effective: { id: r.id, name: r.name } };
  });
  // The rules an event ends up with, and where they come from.
  app.get('/api/events/:id/rule-set', { preHandler: staff }, async (req) => {
    const { id } = idParam.parse(req.params);
    return withTenant(req.user.tid, async (c) => {
      const e = (await c.query('SELECT e.rule_set_id, cu.rule_set_id AS customer_set, cu.name AS customer FROM events e LEFT JOIN customers cu ON cu.id = e.customer_id WHERE e.id = $1', [id])).rows[0];
      const eff = (await rulesForEvents(c, [id])).get(id) ?? null;
      return {
        own: e?.rule_set_id ?? null,
        effective: eff ? { id: eff.id, name: eff.name, rules: eff.rules } : null,
        source: !eff ? 'none' : e?.rule_set_id ? 'event' : e?.customer_set ? 'customer' : 'default',
        customer: e?.customer ?? null,
      };
    });
  });

  // ---------- pay that isn't worked time ----------
  const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
  app.get('/api/pay-adjustments', { preHandler: staff }, async (req) => {
    const q = z.object({ from: ymd, to: ymd }).parse(req.query);
    return withTenant(req.user.tid, async (c) => ({
      adjustments: (
        await c.query(
          `SELECT a.id, a.kind, to_char(a.work_date, 'YYYY-MM-DD') AS date, a.hours::float AS hours, a.amount::float AS amount, a.note, a.event_name, a.role_name,
                  a.voided_at, a.exported_at, u.name AS user_name, b.name AS created_by_name
             FROM pay_adjustments a JOIN users u ON u.id = a.user_id LEFT JOIN users b ON b.id = a.created_by
            WHERE a.work_date BETWEEN $1::date AND $2::date ORDER BY a.work_date DESC, u.name`,
          [q.from, q.to],
        )
      ).rows,
    }));
  });
  app.post('/api/pay-adjustments', { preHandler: guard('admin', 'hr') }, async (req, reply) => {
    const b = z
      .object({
        userId: z.string().uuid(), date: ymd, eventId: z.string().uuid().nullable().optional(), roleName: z.string().trim().max(100).nullable().optional(),
        hours: z.number().min(0).max(24).default(0), amount: z.number().min(-100000).max(100000).nullable().optional(), note: z.string().trim().min(1, 'Add a note').max(300),
      })
      .refine((x) => x.hours > 0 || (x.amount ?? 0) !== 0, 'Enter hours or an amount')
      .safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: b.error.issues[0]?.message ?? 'Check the adjustment' });
    const a = b.data;
    const row = await withTenant(req.user.tid, async (c) => {
      const ev = a.eventId ? (await c.query('SELECT name FROM events WHERE id = $1', [a.eventId])).rows[0] : null;
      const r = (await c.query(
        `INSERT INTO pay_adjustments (tenant_id, user_id, event_id, event_name, role_name, kind, work_date, hours, amount, note, created_by)
         VALUES ($1,$2,$3,$4,$5,'manual',$6,$7,$8,$9,$10) RETURNING id`,
        [req.user.tid, a.userId, ev ? a.eventId : null, ev?.name ?? null, a.roleName || null, a.date, a.hours, a.amount ?? null, a.note, req.user.sub],
      )).rows[0];
      await audit(c, req.user.tid, req.user.sub, 'pay_adjustment.create', 'pay_adjustment', r.id, a);
      return r;
    });
    return reply.code(201).send({ adjustment: row });
  });
  app.post('/api/pay-adjustments/:id/void', { preHandler: guard('admin', 'hr') }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const n = await withTenant(req.user.tid, async (c) => {
      const r = await c.query('UPDATE pay_adjustments SET voided_at = now() WHERE id = $1 AND voided_at IS NULL AND exported_at IS NULL', [id]);
      if (r.rowCount) await audit(c, req.user.tid, req.user.sub, 'pay_adjustment.void', 'pay_adjustment', id);
      return r.rowCount;
    });
    return n ? { ok: true } : reply.code(409).send({ error: 'Already voided or already exported to payroll' });
  });
}
