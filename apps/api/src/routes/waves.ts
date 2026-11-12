import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { guard } from '../auth';
import { withTenant, audit } from '../db';
import { DEFAULT_WAVES, advancePlan, rankForShift, startWaves, waveConfig } from '../waves';

const uuid = z.string().uuid();
export async function waveRoutes(app: FastifyInstance) {
  const mgr = guard('admin', 'manager');
  const idParam = z.object({ id: uuid });

  // Everything the window shows: the plan and its live progress, or the defaults and who would be asked.
  app.get('/api/shifts/:id/waves', { preHandler: mgr }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const out = await withTenant(req.user.tid, async (c) => {
      const shift = (await c.query(
        `SELECT s.id, s.role_name, s.starts_at, s.ends_at, s.headcount::int AS headcount, s.is_open, e.staffing_draft,
                (SELECT count(*)::int FROM shift_assignments a WHERE a.shift_id = s.id AND a.status <> 'declined') AS taken,
                (SELECT count(*)::int FROM shift_assignments a WHERE a.shift_id = s.id AND a.status = 'accepted') AS confirmed
           FROM shifts s JOIN events e ON e.id = s.event_id WHERE s.id = $1`, [id])).rows[0];
      if (!shift) return null;
      const plan = (await c.query('SELECT id, config, status, wave, wave_started_at, finished_reason, created_at FROM shift_wave_plans WHERE shift_id = $1', [id])).rows[0] ?? null;
      const defaults = waveConfig.parse((await c.query('SELECT wave_defaults FROM staffing_settings')).rows[0]?.wave_defaults ?? {});
      const offers = plan
        ? (await c.query(
            `SELECT o.user_id, u.name, o.wave, o.offered_at, o.reminded_at, o.note,
                    COALESCE(o.outcome, CASE WHEN a.status = 'accepted' THEN 'accepted' WHEN a.status = 'declined' THEN 'declined' ELSE 'waiting' END) AS state,
                    a.id AS assignment_id
               FROM shift_wave_offers o JOIN users u ON u.id = o.user_id
               LEFT JOIN shift_assignments a ON a.shift_id = $2 AND a.user_id = o.user_id
              WHERE o.plan_id = $1 ORDER BY o.offered_at, u.name`, [plan.id, id])).rows
        : [];
      const ranked = plan && plan.status !== 'done' ? [] : await rankForShift(c, id);
      const cfg = plan ? waveConfig.parse(plan.config) : defaults;
      const nextAt = plan && plan.status === 'active' ? new Date(new Date(plan.wave_started_at).getTime() + (plan.wave === 1 ? cfg.wait1Min : cfg.wait2Min) * 60_000).toISOString() : null;
      return { shift, plan: plan ? { ...plan, config: cfg, next_at: nextAt, answer_by: new Date(new Date(shift.starts_at).getTime() - cfg.answerByHours * 3600_000).toISOString() } : null, defaults, offers,
        preview: { qualified: ranked.length, top: ranked.slice(0, 12).map((r) => ({ name: r.name, stars: r.stars, week_hours: r.week_hours, overtime: r.overtime })) } };
    });
    return out ?? reply.code(404).send({ error: 'Shift not found' });
  });

  app.post('/api/shifts/:id/waves', { preHandler: mgr }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const b = z.object({ config: waveConfig, saveDefault: z.boolean().default(false) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: b.error.issues[0]?.message ?? 'Check the wave settings' });
    const out = await withTenant(req.user.tid, async (c) => {
      if (b.data.saveDefault)
        await c.query(`INSERT INTO staffing_settings (tenant_id, wave_defaults) VALUES ($1, $2) ON CONFLICT (tenant_id) DO UPDATE SET wave_defaults = $2, updated_at = now()`, [req.user.tid, JSON.stringify(b.data.config)]);
      return startWaves(c, req.user.tid, req.user.sub, id, b.data.config);
    });
    const { code, ...rest } = out;
    return reply.code(code).send(rest);
  });

  // Pause, carry on, or stop. Stopping leaves offers already out as they are.
  app.post('/api/shifts/:id/waves/:action', { preHandler: mgr }, async (req, reply) => {
    const { id, action } = z.object({ id: uuid, action: z.enum(['pause', 'resume', 'stop']) }).parse(req.params);
    const out = await withTenant(req.user.tid, async (c) => {
      const plan = (await c.query('SELECT id, status FROM shift_wave_plans WHERE shift_id = $1', [id])).rows[0];
      if (!plan) return { code: 404, error: 'No waves on this shift' };
      if (plan.status === 'done') return { code: 409, error: 'These waves have already finished.' };
      if (action === 'pause') await c.query("UPDATE shift_wave_plans SET status = 'paused', updated_at = now() WHERE id = $1", [plan.id]);
      if (action === 'stop') await c.query("UPDATE shift_wave_plans SET status = 'done', finished_reason = 'Stopped by a coordinator.', updated_at = now() WHERE id = $1", [plan.id]);
      if (action === 'resume') {
        // The wave's clock starts again from now, so nobody loses answering time to the pause.
        await c.query("UPDATE shift_wave_plans SET status = 'active', wave_started_at = now(), updated_at = now() WHERE id = $1", [plan.id]);
        await advancePlan(c, req.user.tid, plan.id);
      }
      await audit(c, req.user.tid, req.user.sub, `shift.waves_${action}`, 'shift', id);
      return { code: 200, ok: true };
    });
    const { code, ...rest } = out as { code: number; [k: string]: unknown };
    return reply.code(code).send(rest);
  });

  // Which shifts on an event have waves, for the chips on the event page.
  app.get('/api/events/:id/waves', { preHandler: mgr }, async (req) => {
    const { id } = idParam.parse(req.params);
    return withTenant(req.user.tid, async (c) => ({
      plans: (await c.query('SELECT p.shift_id, p.status, p.wave, p.finished_reason FROM shift_wave_plans p JOIN shifts s ON s.id = p.shift_id WHERE s.event_id = $1', [id])).rows,
    }));
  });
}
export { DEFAULT_WAVES };
