import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth';
import { pool, withTenant, audit } from '../db';
import { notify } from '../notify';
import { config } from '../config';
import { fmtTimeOnly } from '../notify/templates';

/**
 * Crew tools on their phone:
 *  - A private calendar feed (.ics) of their confirmed shifts, to subscribe to in Apple, Google or Outlook calendar.
 *  - "Running late": tell the lead and coordinators an arrival time; late and no-show alerts wait until then.
 */
const esc = (t: string) => String(t ?? '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');
const stamp = (d: Date) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
// Lines longer than 75 octets are folded (RFC 5545).
const fold = (line: string) => { const out: string[] = []; let l = line; while (l.length > 74) { out.push(l.slice(0, 74)); l = ' ' + l.slice(74); } out.push(l); return out.join('\r\n'); };

export async function crewToolRoutes(app: FastifyInstance) {
  const feedUrl = (token: string) => `${config.appUrl}/api/calendar/${token}.ics`;

  // My calendar link (made the first time it's asked for); reset makes a new one and stops the old.
  app.get('/api/my/calendar-link', { preHandler: authenticate }, async (req) =>
    withTenant(req.user.tid, async (c) => {
      let t = (await c.query('SELECT cal_token FROM users WHERE id = $1', [req.user.sub])).rows[0]?.cal_token as string | null;
      if (!t) {
        t = crypto.randomBytes(24).toString('base64url');
        await c.query('UPDATE users SET cal_token = $2 WHERE id = $1', [req.user.sub, t]);
      }
      return { url: feedUrl(t) };
    }),
  );
  app.post('/api/my/calendar-link/reset', { preHandler: authenticate }, async (req) =>
    withTenant(req.user.tid, async (c) => {
      const t = crypto.randomBytes(24).toString('base64url');
      await c.query('UPDATE users SET cal_token = $2 WHERE id = $1', [req.user.sub, t]);
      await audit(c, req.user.tid, req.user.sub, 'calendar.reset', 'user', req.user.sub);
      return { url: feedUrl(t) };
    }),
  );

  // The feed itself: no sign-in (calendar apps can't), found by the secret token only.
  app.get('/api/calendar/:token', async (req, reply) => {
    const token = String((req.params as { token: string }).token).replace(/\.ics$/, '');
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return reply.code(404).send('Not found');
    // Find the person across companies (the token is unique), then read their shifts inside their company.
    const who = (await pool.query('SELECT id, tenant_id FROM calendar_owner($1)', [token])).rows[0];
    if (!who) return reply.code(404).send('Not found');
    const rows = await withTenant(who.tenant_id, async (c) => (await c.query(
      `SELECT a.id, a.status, s.role_name, s.starts_at, s.ends_at, e.name AS event_name, e.venue, e.address, t.name AS company
         FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id JOIN events e ON e.id = s.event_id JOIN tenants t ON t.id = e.tenant_id
        WHERE a.user_id = $1 AND a.status = 'accepted' AND s.ends_at > now() - interval '60 days' AND e.pipeline_status <> 'canceled'
        ORDER BY s.starts_at LIMIT 500`, [who.id])).rows);
    const now = stamp(new Date());
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//LaborOps//Shifts//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      `X-WR-CALNAME:${esc(`LaborOps shifts`)}`, 'X-PUBLISHED-TTL:PT1H', 'REFRESH-INTERVAL;VALUE=DURATION:PT1H'];
    for (const r of rows) {
      lines.push('BEGIN:VEVENT', `UID:${r.id}@laborops`, `DTSTAMP:${now}`, `DTSTART:${stamp(r.starts_at)}`, `DTEND:${stamp(r.ends_at)}`,
        `SUMMARY:${esc(`${r.role_name} · ${r.event_name}`)}`,
        ...(r.venue || r.address ? [`LOCATION:${esc([r.venue, r.address].filter(Boolean).join(', '))}`] : []),
        `DESCRIPTION:${esc(`${r.role_name} for ${r.company}. Details, clock-in and changes: ${config.appUrl}/my-shifts/${r.id}`)}`,
        `URL:${config.appUrl}/my-shifts/${r.id}`, 'STATUS:CONFIRMED', 'TRANSP:OPAQUE', 'END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    reply.header('Content-Type', 'text/calendar; charset=utf-8').header('Cache-Control', 'private, max-age=900')
      .header('Content-Disposition', 'inline; filename="laborops-shifts.ics"');
    return lines.map(fold).join('\r\n') + '\r\n';
  });

  // Running late: an arrival time (minutes from now) and an optional note.
  app.post('/api/my/assignments/:id/late', { preHandler: authenticate }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ minutes: z.number().int().min(5).max(240), note: z.string().trim().max(200).optional() }).parse(req.body);
    const out = await withTenant(req.user.tid, async (c) => {
      const a = (await c.query(
        `SELECT a.id, a.user_id, s.event_id, s.role_name, s.starts_at, e.name AS event_name, u.name, coalesce(t.timezone, 'America/Denver') AS tz
           FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id JOIN events e ON e.id = s.event_id JOIN users u ON u.id = a.user_id JOIN tenants t ON t.id = e.tenant_id
          WHERE a.id = $1 AND a.user_id = $2 AND a.status = 'accepted' AND now() BETWEEN s.starts_at - interval '2 hours' AND s.ends_at
            AND NOT EXISTS (SELECT 1 FROM time_entries te WHERE te.assignment_id = a.id)`, [id, req.user.sub])).rows[0];
      if (!a) return null;
      // Late is counted from the call time (or from now, once the shift has started).
      const etaAt = new Date(Math.max(Date.now(), +new Date(a.starts_at)) + b.minutes * 60_000);
      await c.query('UPDATE shift_assignments SET late_eta = $2, late_note = $3, late_at = now() WHERE id = $1', [id, etaAt, b.note || null]);
      // Tell the event's leads, on-site coordinators and the office (same people as the late alert).
      const to = (await c.query(
        `SELECT id FROM users WHERE active AND role IN ('admin','manager')
         UNION SELECT x.user_id FROM shift_assignments x JOIN shifts s ON s.id = x.shift_id JOIN users u ON u.id = x.user_id
          WHERE s.event_id = $1 AND x.status = 'accepted' AND u.active AND (x.is_lead OR 'onsite_coordinator' = ANY(u.field_roles))`, [a.event_id])).rows
        .map((r) => r.id as string).filter((u) => u !== req.user.sub);
      const at = fmtTimeOnly(etaAt, a.tz);
      if (to.length)
        await notify(c, req.user.tid, to.map((userId) => ({
          userId, category: 'shift_change' as const, title: `${a.name} is running late · ${a.event_name}`,
          body: `${a.name} (${a.role_name}) expects to arrive around ${at}.${b.note ? `\n“${b.note}”` : ''}`, link: `/events/${a.event_id}`,
        })));
      await audit(c, req.user.tid, req.user.sub, 'assignment.running_late', 'assignment', id, { minutes: b.minutes });
      return { eta: etaAt.toISOString(), told: to.length };
    });
    return out ? out : reply.code(409).send({ error: 'You can only say you’re running late on a confirmed shift that’s about to start and you haven’t clocked in to.' });
  });
}
