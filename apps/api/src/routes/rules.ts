import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTenant, audit } from '../db';
import { guard } from '../auth';
import { US_STATES, stateDefault } from '../pay';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const body = z.object({
  minRestHours: z.number().min(0).max(48),
  maxDailyHours: z.number().min(0).max(24),
  dailyOtAfter: z.number().min(0).max(24),
  weeklyOtAfter: z.number().min(0).max(168),
  otMultiplier: z.number().min(1).max(4),
  nightStart: hhmm,
  nightEnd: hhmm,
  nightPremiumPct: z.number().min(0).max(300),
  sundayPremiumPct: z.number().min(0).max(300),
  holidayPremiumPct: z.number().min(0).max(300),
  holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(100),
  defaultState: z.string().refine((x) => US_STATES.includes(x)).nullable().optional(),
});
const stateCode = z.string().trim().toUpperCase().refine((x) => US_STATES.includes(x));
const stateBody = z.object({ otMult: z.number().min(1).max(4), dtAfter: z.number().min(1).max(24).nullable(), dtMult: z.number().min(1).max(4) });

const view = (r: any) => ({
  minRestHours: Number(r.min_rest_hours), maxDailyHours: Number(r.max_daily_hours), dailyOtAfter: Number(r.daily_ot_after),
  weeklyOtAfter: Number(r.weekly_ot_after), otMultiplier: Number(r.ot_multiplier),
  nightStart: String(r.night_start).slice(0, 5), nightEnd: String(r.night_end).slice(0, 5),
  nightPremiumPct: Number(r.night_premium_pct), sundayPremiumPct: Number(r.sunday_premium_pct), holidayPremiumPct: Number(r.holiday_premium_pct),
  holidays: r.holidays as string[],
  defaultState: (r.default_state as string | null) ?? null,
});

const SEL = `SELECT min_rest_hours, max_daily_hours, daily_ot_after, weekly_ot_after, ot_multiplier, night_start::text, night_end::text,
  night_premium_pct, sunday_premium_pct, holiday_premium_pct, ARRAY(SELECT to_char(d,'YYYY-MM-DD') FROM unnest(holidays) d ORDER BY d) AS holidays, default_state FROM labor_rules`;

export async function rulesRoutes(app: FastifyInstance) {
  app.get('/api/labor-rules', { preHandler: guard('admin', 'manager') }, async (req) =>
    withTenant(req.user.tid, async (c) => {
      const r = (await c.query(SEL)).rows[0];
      return view(r ?? { min_rest_hours: 8, max_daily_hours: 14, daily_ot_after: 0, weekly_ot_after: 40, ot_multiplier: 1.5, night_start: '22:00', night_end: '06:00', night_premium_pct: 0, sunday_premium_pct: 0, holiday_premium_pct: 0, holidays: [] });
    }),
  );

  app.put('/api/labor-rules', { preHandler: guard('admin') }, async (req) => {
    const b = body.parse(req.body);
    return withTenant(req.user.tid, async (c) => {
      await c.query(
        `INSERT INTO labor_rules (tenant_id, min_rest_hours, max_daily_hours, daily_ot_after, weekly_ot_after, ot_multiplier, night_start, night_end,
           night_premium_pct, sunday_premium_pct, holiday_premium_pct, holidays, default_state)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::date[],$13)
         ON CONFLICT (tenant_id) DO UPDATE SET min_rest_hours=$2, max_daily_hours=$3, daily_ot_after=$4, weekly_ot_after=$5, ot_multiplier=$6,
           night_start=$7, night_end=$8, night_premium_pct=$9, sunday_premium_pct=$10, holiday_premium_pct=$11, holidays=$12::date[], default_state=$13, updated_at=now()`,
        [req.user.tid, b.minRestHours, b.maxDailyHours, b.dailyOtAfter, b.weeklyOtAfter, b.otMultiplier, b.nightStart, b.nightEnd, b.nightPremiumPct, b.sundayPremiumPct, b.holidayPremiumPct, b.holidays, b.defaultState ?? null],
      );
      await audit(c, req.user.tid, req.user.sub, 'labor_rules.update', 'tenant', req.user.tid, b);
      return view((await c.query(SEL)).rows[0]);
    });
  });

  // State overtime: what multiplier applies in each state, and where double time starts. Shows the starting defaults until an admin changes a state.
  app.get('/api/state-ot-rules', { preHandler: guard('admin', 'manager') }, async (req) =>
    withTenant(req.user.tid, async (c) => {
      const base = Number((await c.query('SELECT ot_multiplier FROM labor_rules')).rows[0]?.ot_multiplier ?? 1.5);
      const custom = new Map((await c.query('SELECT state, ot_mult, dt_after, dt_mult FROM state_ot_rules')).rows.map((r) => [r.state as string, r]));
      return {
        states: US_STATES.map((s) => {
          const r = custom.get(s);
          const d = stateDefault(s, base);
          return r
            ? { state: s, otMult: Number(r.ot_mult), dtAfter: r.dt_after === null ? null : Number(r.dt_after), dtMult: Number(r.dt_mult), custom: true }
            : { state: s, ...d, custom: false };
        }),
      };
    }),
  );

  app.put('/api/state-ot-rules/:state', { preHandler: guard('admin') }, async (req) => {
    const state = stateCode.parse((req.params as any).state);
    const b = stateBody.parse(req.body);
    await withTenant(req.user.tid, async (c) => {
      await c.query(
        `INSERT INTO state_ot_rules (tenant_id, state, ot_mult, dt_after, dt_mult) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (tenant_id, state) DO UPDATE SET ot_mult=$3, dt_after=$4, dt_mult=$5, updated_at=now()`,
        [req.user.tid, state, b.otMult, b.dtAfter, b.dtMult],
      );
      await audit(c, req.user.tid, req.user.sub, 'state_ot.update', 'tenant', req.user.tid, { state, ...b });
    });
    return { ok: true };
  });

  app.delete('/api/state-ot-rules/:state', { preHandler: guard('admin') }, async (req) => {
    const state = stateCode.parse((req.params as any).state);
    await withTenant(req.user.tid, async (c) => {
      await c.query('DELETE FROM state_ot_rules WHERE state = $1', [state]);
      await audit(c, req.user.tid, req.user.sub, 'state_ot.reset', 'tenant', req.user.tid, { state });
    });
    return { ok: true };
  });
}
