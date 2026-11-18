import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { withTenant, audit } from '../db';
import { authenticate, guard } from '../auth';
import { canAdjustRates, canBill } from '../rates';
import { roleKeyOf } from '../pay';
import { notify } from '../notify';

/**
 * Standing pay and bill rates per person per skill, used on every event (a rate set for one event still wins).
 * A change starts on a date; the old rate keeps pricing earlier shifts. Admins, and coordinators allowed to adjust
 * rates, change them; HR can see them; crew see only their own pay rates.
 */
const uuid = z.string().uuid();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const office = guard('admin', 'manager', 'hr');
const money = z.number().positive().max(100000).nullable();
const r2 = (n: number) => Math.round(n * 100) / 100;

type RateRow = { id: string; user_id: string; skill_id: string; pay_type: 'hourly' | 'day'; rate: number | null; bill_rate: number | null; starts_on: string; note: string | null; created_at: string; created_by_name: string | null };
const shape = (r: RateRow, withBill: boolean) => ({
  id: r.id, payType: r.pay_type, rate: r.rate, ...(withBill ? { billRate: r.bill_rate } : {}), startsOn: r.starts_on, note: r.note,
  ...(withBill ? { setBy: r.created_by_name, setAt: r.created_at } : {}),
});

async function today(c: PoolClient) {
  return (await c.query("SELECT to_char(now() AT TIME ZONE COALESCE(timezone, 'UTC'), 'YYYY-MM-DD') AS d FROM tenants LIMIT 1")).rows[0]?.d as string;
}
async function rows(c: PoolClient, userIds: string[] | null) {
  return (await c.query(
    `SELECT r.id, r.user_id, r.skill_id, r.pay_type, r.rate::float AS rate, r.bill_rate::float AS bill_rate, to_char(r.starts_on, 'YYYY-MM-DD') AS starts_on,
            r.note, r.created_at, u.name AS created_by_name
       FROM crew_rates r LEFT JOIN users u ON u.id = r.created_by
      WHERE ($1::uuid[] IS NULL OR r.user_id = ANY($1::uuid[]))
      ORDER BY r.starts_on DESC, r.created_at DESC`, [userIds])).rows as RateRow[];
}
/** For one person and skill: the rate in force today, one starting later (if any), and the history. */
function split(list: RateRow[], on: string) {
  const current = list.find((r) => r.starts_on <= on) ?? null;
  const upcoming = list.filter((r) => r.starts_on > on).sort((a, b) => a.starts_on.localeCompare(b.starts_on));
  return { current, upcoming, history: list };
}
async function skillsList(c: PoolClient) {
  return (await c.query('SELECT id, name, pay_rate::float AS pay_rate, day_rate::float AS day_rate, bill_rate::float AS bill_rate, day_bill_rate::float AS day_bill_rate FROM skills WHERE active ORDER BY name')).rows as
    { id: string; name: string; pay_rate: number | null; day_rate: number | null; bill_rate: number | null; day_bill_rate: number | null }[];
}
const roleRates = (k: Awaited<ReturnType<typeof skillsList>>[number]) => ({ payRate: k.pay_rate || null, dayRate: k.day_rate || null, billRate: k.bill_rate || null, dayBillRate: k.day_bill_rate || null });

const body = z.object({
  skillId: uuid.optional(),
  role: z.string().trim().min(1).max(100).optional(), // a position name; matched to a skill like everywhere else
  payType: z.enum(['hourly', 'day']).default('hourly'),
  rate: money.optional(),
  billRate: money.optional(),
  startsOn: day.optional(),
  note: z.string().trim().max(200).nullable().optional(),
}).refine((b) => b.skillId || b.role, { message: 'Pick a skill' });

/** Save a standing rate (used by the profile, the rates grid and the event Crew pay window). */
export async function saveStandingRate(c: PoolClient, me: { tid: string; sub: string }, userId: string, b: z.infer<typeof body>) {
  const u = (await c.query('SELECT id, name FROM users WHERE id = $1', [userId])).rows[0];
  if (!u) return { code: 404, error: 'Crew member not found' } as const;
  const skills = await skillsList(c);
  const sk = b.skillId ? skills.find((k) => k.id === b.skillId) : skills.find((k) => roleKeyOf(k.name) === roleKeyOf(b.role!));
  if (!sk) return { code: 404, error: b.role ? `There's no skill called “${b.role}” in Roles & pay rates.` : 'Skill not found' } as const;
  const on = b.startsOn ?? (await today(c));
  const mine = (await rows(c, [userId])).filter((r) => r.skill_id === sk.id);
  const before = split(mine, on).current;
  // Leaving one side out keeps what was there; null clears it (back to the role's rate).
  const rate = b.rate === undefined ? before?.rate ?? null : b.rate === null ? null : r2(b.rate);
  const bill = b.billRate === undefined ? before?.bill_rate ?? null : b.billRate === null ? null : r2(b.billRate);
  const saved = (await c.query(
    `INSERT INTO crew_rates (tenant_id, user_id, skill_id, pay_type, rate, bill_rate, starts_on, note, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (user_id, skill_id, starts_on) DO UPDATE SET pay_type = EXCLUDED.pay_type, rate = EXCLUDED.rate, bill_rate = EXCLUDED.bill_rate,
       note = EXCLUDED.note, created_by = EXCLUDED.created_by, created_at = now()
     RETURNING id`,
    [me.tid, userId, sk.id, b.payType, rate, bill, on, b.note || null, me.sub])).rows[0];
  await audit(c, me.tid, me.sub, 'crew.rate', 'user', userId, {
    skill: sk.name, startsOn: on, payType: b.payType, rate, billRate: bill,
    before: before ? { payType: before.pay_type, rate: before.rate, billRate: before.bill_rate, startsOn: before.starts_on } : null,
  });
  // Tell them when their own pay changes (never the bill rate).
  const payChanged = !before || before.rate !== rate || (rate !== null && before.pay_type !== b.payType);
  if (payChanged) {
    const when = on > (await today(c)) ? ` from ${new Date(`${on}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}` : '';
    const text = rate === null
      ? `Your ${sk.name} pay is back to the standard rate${when}.`
      : `Your ${sk.name} rate is now $${rate.toFixed(2)}${b.payType === 'day' ? ' per day' : '/hr'}${when}${b.payType === 'day' ? '' : ' (overtime rules still apply)'}.`;
    await notify(c, me.tid, { userId, category: 'account', title: 'Pay rate updated', body: text, link: '/profile' });
  }
  return { code: 200, id: saved.id as string, skill: { id: sk.id, name: sk.name } } as const;
}

export async function crewRateRoutes(app: FastifyInstance) {
  // One person's skills with the role rates and their own (today's, upcoming, history).
  app.get('/api/crew/:id/rates', { preHandler: office }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const out = await withTenant(req.user.tid, async (c) => {
      if (!(await canBill(c, req.user))) return { code: 403 as const };
      const u = (await c.query('SELECT id, name, skills FROM users WHERE id = $1', [id])).rows[0];
      if (!u) return { code: 404 as const };
      const on = await today(c);
      const all = await rows(c, [id]);
      const has = new Set((u.skills as string[] ?? []).map(roleKeyOf));
      const skills = (await skillsList(c))
        .filter((k) => has.has(roleKeyOf(k.name)) || all.some((r) => r.skill_id === k.id))
        .map((k) => {
          const s = split(all.filter((r) => r.skill_id === k.id), on);
          return {
            skillId: k.id, name: k.name, hasSkill: has.has(roleKeyOf(k.name)), role: roleRates(k),
            current: s.current ? shape(s.current, true) : null, upcoming: s.upcoming.map((r) => shape(r, true)), history: s.history.map((r) => shape(r, true)),
          };
        });
      return { code: 200 as const, user: { id: u.id, name: u.name }, today: on, skills, canEdit: await canAdjustRates(c, req.user), otherSkills: (await skillsList(c)).filter((k) => !skills.some((s) => s.skillId === k.id)).map((k) => ({ id: k.id, name: k.name })) };
    });
    if (out.code === 403) return reply.code(403).send({ error: 'Only admins, HR and coordinators allowed to adjust rates can see pay rates.' });
    if (out.code === 404) return reply.code(404).send({ error: 'Crew member not found' });
    const { code, ...rest } = out;
    return rest;
  });

  app.put('/api/crew/:id/rates', { preHandler: guard('admin', 'manager') }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = body.parse(req.body);
    const out = await withTenant(req.user.tid, async (c) => {
      if (!(await canAdjustRates(c, req.user))) return { code: 403, error: 'Only admins, and coordinators allowed to adjust rates, can set pay.' };
      return saveStandingRate(c, req.user, id, b);
    });
    const { code, ...rest } = out as { code: number; [k: string]: unknown };
    return reply.code(code).send(rest);
  });

  // Take back one rate row (a mistake, or a raise that shouldn't happen). The row before it applies again.
  app.delete('/api/crew/:id/rates/:rateId', { preHandler: guard('admin', 'manager') }, async (req, reply) => {
    const { id, rateId } = z.object({ id: uuid, rateId: uuid }).parse(req.params);
    const out = await withTenant(req.user.tid, async (c) => {
      if (!(await canAdjustRates(c, req.user))) return { code: 403, error: 'Only admins, and coordinators allowed to adjust rates, can set pay.' };
      const d = (await c.query(
        `DELETE FROM crew_rates r USING skills k WHERE r.id = $1 AND r.user_id = $2 AND k.id = r.skill_id
         RETURNING k.name AS skill, r.pay_type, r.rate::float AS rate, r.bill_rate::float AS bill_rate, to_char(r.starts_on, 'YYYY-MM-DD') AS starts_on`, [rateId, id])).rows[0];
      if (!d) return { code: 404, error: 'Rate not found' };
      await audit(c, req.user.tid, req.user.sub, 'crew.rate_removed', 'user', id, d);
      return { code: 200, ok: true };
    });
    const { code, ...rest } = out as { code: number; [k: string]: unknown };
    return reply.code(code).send(rest);
  });

  // The rates grid: people down the side, skills across the top, today's own rates in the cells.
  app.get('/api/rates/grid', { preHandler: office }, async (req, reply) => {
    const q = z.object({ group: uuid.optional(), skill: uuid.optional(), q: z.string().trim().max(100).optional(), onlyOwn: z.enum(['1', 'true']).optional() }).parse(req.query);
    const out = await withTenant(req.user.tid, async (c) => {
      if (!(await canBill(c, req.user))) return { code: 403 as const };
      const on = await today(c);
      const skills = (await skillsList(c)).filter((k) => !q.skill || k.id === q.skill);
      const people = (await c.query(
        `SELECT u.id, u.name, u.skills FROM users u
          WHERE u.active AND u.role IN ('crew', 'manager') AND NOT u.is_demo
            AND ($1::uuid IS NULL OR EXISTS (SELECT 1 FROM crew_group_members m WHERE m.user_id = u.id AND m.group_id = $1))
            AND ($2::text IS NULL OR u.name ILIKE '%' || $2 || '%')
          ORDER BY u.name LIMIT 500`, [q.group ?? null, q.q || null])).rows;
      const all = await rows(c, people.map((p) => p.id));
      const cells: Record<string, Record<string, unknown>> = {};
      for (const p of people) {
        const has = new Set((p.skills as string[] ?? []).map(roleKeyOf));
        cells[p.id] = {};
        for (const k of skills) {
          const s = split(all.filter((r) => r.user_id === p.id && r.skill_id === k.id), on);
          if (!s.current && !s.upcoming.length && !has.has(roleKeyOf(k.name))) continue;
          cells[p.id]![k.id] = { hasSkill: has.has(roleKeyOf(k.name)), current: s.current ? shape(s.current, true) : null, upcoming: s.upcoming[0] ? shape(s.upcoming[0], true) : null };
        }
      }
      const withOwn = (id: string) => Object.values(cells[id] ?? {}).some((x: any) => x.current?.rate || x.current?.billRate || x.upcoming);
      const groups = (await c.query('SELECT id, name FROM crew_groups ORDER BY name')).rows;
      return {
        code: 200 as const, today: on, groups,
        skills: skills.map((k) => ({ id: k.id, name: k.name, ...roleRates(k) })),
        people: people.filter((p) => !q.onlyOwn || withOwn(p.id)).map((p) => ({ id: p.id, name: p.name })),
        cells, canEdit: await canAdjustRates(c, req.user),
      };
    });
    if (out.code === 403) return reply.code(403).send({ error: 'Only admins, HR and coordinators allowed to adjust rates can see pay rates.' });
    const { code, ...rest } = out;
    return rest;
  });

  // Crew: their own pay rates (today's and any starting later). Never bill rates, never anyone else's.
  app.get('/api/my/rates', { preHandler: authenticate }, async (req) =>
    withTenant(req.user.tid, async (c) => {
      const on = await today(c);
      const u = (await c.query('SELECT skills FROM users WHERE id = $1', [req.user.sub])).rows[0];
      const all = await rows(c, [req.user.sub]);
      const has = new Set((u?.skills as string[] ?? []).map(roleKeyOf));
      return {
        rates: (await skillsList(c))
          .filter((k) => has.has(roleKeyOf(k.name)) || all.some((r) => r.skill_id === k.id))
          .map((k) => {
            const s = split(all.filter((r) => r.skill_id === k.id && r.rate !== null), on);
            const std = s.current?.pay_type === 'day' ? k.day_rate : k.pay_rate;
            return {
              skill: k.name,
              own: s.current ? { payType: s.current.pay_type, rate: s.current.rate, since: s.current.starts_on } : null,
              standard: { hourly: k.pay_rate || null, day: k.day_rate || null },
              upcoming: s.upcoming[0] ? { payType: s.upcoming[0].pay_type, rate: s.upcoming[0].rate, startsOn: s.upcoming[0].starts_on } : null,
              _std: std,
            };
          })
          .map(({ _std, ...x }) => x),
      };
    }));
}
