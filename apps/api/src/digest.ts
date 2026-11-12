import type { PoolClient } from 'pg';
import { pool, withTenant } from './db';
import { notify } from './notify';
import { fmtTimeOnly } from './notify/templates';

/**
 * Morning summary for admins and labor coordinators (each can turn it off in their notification settings): one push and
 * email at 7am company time with today's calls, open seats coming up, offers nobody answered, timesheets and requests.
 * Sent once a day per person; nothing is sent on a day with nothing to say.
 */
export async function runDigests(now = new Date()): Promise<number> {
  const { rows } = await pool.query('SELECT id, timezone FROM notify_tenants()');
  let n = 0;
  for (const t of rows) n += await withTenant(t.id, (c) => digestFor(c, t.id, t.timezone, now)).catch((e) => { console.error('digest', e); return 0; });
  return n;
}

export async function digestFor(c: PoolClient, tenantId: string, tz: string, now = new Date(), force = false): Promise<number> {
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(now));
  if (!force && hour !== 7) return 0;
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now); // YYYY-MM-DD
  const people = (await c.query("SELECT id FROM users WHERE active AND role IN ('admin','manager') AND digest_on")).rows as { id: string }[];
  if (!people.length) return 0;
  const today = (await c.query(
    `SELECT count(*)::int AS shifts, count(DISTINCT s.event_id)::int AS events, min(s.starts_at) AS first
       FROM shifts s JOIN events e ON e.id = s.event_id
      WHERE e.pipeline_status <> 'canceled' AND (s.starts_at AT TIME ZONE $1)::date = $2::date`, [tz, day])).rows[0];
  const open = (await c.query(
    `SELECT COALESCE(sum(GREATEST(0, s.headcount - (SELECT count(*) FROM shift_assignments a WHERE a.shift_id = s.id AND a.status = 'accepted'))), 0)::int AS n,
            count(DISTINCT s.event_id) FILTER (WHERE s.headcount > (SELECT count(*) FROM shift_assignments a WHERE a.shift_id = s.id AND a.status = 'accepted'))::int AS events
       FROM shifts s JOIN events e ON e.id = s.event_id
      WHERE e.pipeline_status <> 'canceled' AND s.starts_at > now() AND s.starts_at < now() + interval '3 days'`)).rows[0];
  const waiting = Number((await c.query("SELECT count(*)::int AS n FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id WHERE a.status = 'offered' AND s.starts_at > now() AND a.created_at < now() - interval '12 hours'")).rows[0].n);
  const sheets = Number((await c.query("SELECT count(*)::int AS n FROM time_entries WHERE status = 'submitted'")).rows[0].n);
  const requests = Number((await c.query("SELECT ((SELECT count(*) FROM shift_assignments WHERE status = 'pending') + (SELECT count(*) FROM shift_swaps WHERE status = 'pending'))::int AS n")).rows[0].n);
  const lines = [
    today.shifts ? `Today: ${today.shifts} shift${today.shifts === 1 ? '' : 's'} at ${today.events} event${today.events === 1 ? '' : 's'}, first call ${fmtTimeOnly(today.first, tz)}.` : 'No shifts today.',
    open.n ? `Open seats in the next 3 days: ${open.n} across ${open.events} event${open.events === 1 ? '' : 's'}.` : 'Everything in the next 3 days is confirmed.',
    waiting ? `${waiting} offer${waiting === 1 ? '' : 's'} not answered for 12+ hours.` : '',
    sheets ? `${sheets} timesheet${sheets === 1 ? '' : 's'} to approve.` : '',
    requests ? `${requests} request${requests === 1 ? '' : 's'} to answer.` : '',
  ].filter(Boolean);
  if (!today.shifts && !open.n && !waiting && !sheets && !requests) return 0;
  let sent = 0;
  for (const p of people) {
    const fresh = (await c.query('INSERT INTO notify_marks (tenant_id, key) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING key', [tenantId, `digest:${day}:${p.id}`])).rowCount;
    if (!fresh && !force) continue;
    await notify(c, tenantId, { userId: p.id, category: 'digest', title: `Your morning summary · ${today.shifts ? `${today.shifts} shifts today` : 'no shifts today'}${open.n ? ` · ${open.n} open seats` : ''}`, body: lines.join('\n'), link: '/dashboard', linkLabel: 'Open the dashboard' });
    sent++;
  }
  return sent;
}
