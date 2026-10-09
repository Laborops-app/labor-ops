import { pool, withTenant } from '../db';
import { notify } from './index';
import { fmtWhen } from './templates';

/** Periodic jobs: 24-hour shift reminders and certificate expiry notices. Safe to run repeatedly (de-duplicated). */
export async function runSweeps(): Promise<{ reminders: number; certs: number }> {
  const { rows: tenants } = await pool.query('SELECT id, timezone FROM notify_tenants()');
  let reminders = 0;
  let certs = 0;
  for (const t of tenants) {
    await withTenant(t.id, async (c) => {
      const shifts = await c.query(
        `SELECT a.id, a.user_id, s.role_name, s.starts_at, e.name AS event_name, e.venue
           FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id JOIN events e ON e.id = s.event_id
          WHERE a.status = 'accepted' AND s.starts_at > now() + interval '90 minutes' AND s.starts_at <= now() + interval '24 hours'`,
      );
      for (const r of shifts.rows) {
        const mark = await c.query("INSERT INTO notify_marks (tenant_id, key) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING key", [t.id, `rem24:${r.id}`]);
        if (!mark.rowCount) continue;
        const when = fmtWhen(r.starts_at, t.timezone);
        await notify(c, t.id, {
          userId: r.user_id, category: 'reminder',
          title: `Reminder: ${r.role_name} tomorrow`,
          body: `${r.event_name}\n${r.role_name} · ${when}${r.venue ? '\n' + r.venue : ''}`,
          link: `/my-shifts/${r.id}`,
          sms: `Reminder: ${r.role_name} - ${r.event_name}, ${when}.`,
        });
        reminders++;
      }
      const cs = await c.query(
        `SELECT id, user_id, name, expires_on, (expires_on - current_date) AS days FROM user_certs
          WHERE expires_on IS NOT NULL AND expires_on BETWEEN current_date AND current_date + 30`,
      );
      for (const r of cs.rows) {
        const step = r.days <= 7 ? 7 : 30;
        const mark = await c.query("INSERT INTO notify_marks (tenant_id, key) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING key", [t.id, `cert:${r.id}:${r.expires_on.toISOString?.().slice(0, 10) ?? r.expires_on}:${step}`]);
        if (!mark.rowCount) continue;
        await notify(c, t.id, {
          userId: r.user_id, category: 'cert',
          title: `Your ${r.name} certificate expires soon`,
          body: `Your ${r.name} certificate expires in ${r.days} day${r.days === 1 ? '' : 's'}. Upload the renewed certificate on your profile so you stay eligible for shifts that require it.`,
          link: '/profile',
        });
        certs++;
      }
    });
  }
  return { reminders, certs };
}
