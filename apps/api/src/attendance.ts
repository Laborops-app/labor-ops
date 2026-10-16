import type { PoolClient } from 'pg';
import { pool, withTenant, audit } from './db';
import { notify, type NotifyInput } from './notify';
import { fmtTimeOnly } from './notify/templates';

/**
 * Attendance checks, every couple of minutes:
 *  - late: an accepted shift started a few minutes ago (Labor rules → "late after") and the person has not clocked in.
 *    They get a nudge (when they clock themselves in) and the event's coordinators and leads get one message per event.
 *  - no-show: still nothing after "no-show after" minutes. The assignment is flagged; clocking in later clears it.
 *  - forgotten clock-out: still clocked in some hours after the shift ended. Closed at the shift end, flagged for a
 *    manager to check, and never auto-approved.
 * Only shifts that started in the last 12 hours are looked at, so turning this on never floods anyone about old shifts.
 */
export async function runAttendance(): Promise<{ late: number; noShows: number; clockedOut: number }> {
  const { rows: tenants } = await pool.query('SELECT id, timezone FROM notify_tenants()');
  const total = { late: 0, noShows: 0, clockedOut: 0 };
  for (const t of tenants) {
    const r = await withTenant(t.id, (c) => attendanceFor(c, t.id, t.timezone)).catch((e) => {
      console.error('attendance sweep error', t.id, e);
      return null;
    });
    if (r) {
      total.late += r.late;
      total.noShows += r.noShows;
      total.clockedOut += r.clockedOut;
    }
  }
  return total;
}

type Row = { id: string; user_id: string; name: string; role_name: string; starts_at: Date; ends_at: Date; event_id: string; event_name: string; clock_mode: string };

/** Admins, labor coordinators, on-site coordinators working the event and the event's leads. */
async function watchersOf(c: PoolClient, eventId: string, except: Set<string>): Promise<string[]> {
  const { rows } = await c.query(
    `SELECT id FROM users WHERE active AND role IN ('admin','manager')
     UNION
     SELECT a.user_id FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id JOIN users u ON u.id = a.user_id
      WHERE s.event_id = $1 AND a.status = 'accepted' AND u.active AND (a.is_lead OR 'onsite_coordinator' = ANY(u.field_roles))`,
    [eventId],
  );
  return rows.map((r) => r.id).filter((id) => !except.has(id));
}

async function mark(c: PoolClient, tenantId: string, key: string) {
  return !!(await c.query('INSERT INTO notify_marks (tenant_id, key) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING key', [tenantId, key])).rowCount;
}

export async function attendanceFor(c: PoolClient, tenantId: string, tz: string) {
  const lr = (await c.query('SELECT late_alert_min, no_show_min, auto_clockout_h FROM labor_rules')).rows[0] ?? {};
  const lateMin = Number(lr.late_alert_min ?? 10);
  const noShowMin = Number(lr.no_show_min ?? 60);
  const outH = Number(lr.auto_clockout_h ?? 3);
  const out = { late: 0, noShows: 0, clockedOut: 0 };
  const at = (d: Date) => fmtTimeOnly(d, tz);
  const msgs: NotifyInput[] = [];
  const byEvent = <T extends { event_id: string }>(list: T[]) => {
    const m = new Map<string, T[]>();
    for (const x of list) m.set(x.event_id, [...(m.get(x.event_id) ?? []), x]);
    return m;
  };
  const missing = `SELECT a.id, a.user_id, u.name, s.role_name, s.starts_at, s.ends_at, s.event_id, e.name AS event_name, e.clock_mode
      FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id JOIN events e ON e.id = s.event_id JOIN users u ON u.id = a.user_id
     WHERE a.status = 'accepted' AND a.no_show_at IS NULL
       AND s.starts_at >= now() - interval '12 hours' AND e.pipeline_status <> 'canceled'
       AND NOT EXISTS (SELECT 1 FROM time_entries t WHERE t.assignment_id = a.id)`;

  // ---- no-shows first (so someone who is already a no-show is not also reported late) ----
  if (noShowMin > 0) {
    const rows = (await c.query<Row>(`${missing} AND s.starts_at <= now() - make_interval(mins => $1) ORDER BY s.starts_at`, [noShowMin])).rows;
    if (rows.length) await c.query('UPDATE shift_assignments SET no_show_at = now() WHERE id = ANY($1::uuid[])', [rows.map((r) => r.id)]);
    for (const [eventId, list] of byEvent(rows)) {
      const who = list.map((r) => `${r.name} (${r.role_name}, ${at(r.starts_at)})`).join('\n');
      for (const uid of await watchersOf(c, eventId, new Set(list.map((r) => r.user_id))))
        msgs.push({
          userId: uid, category: 'attendance', allowSms: false,
          title: `${list.length === 1 ? `${list[0].name} is a no-show` : `${list.length} no-shows`} at ${list[0].event_name}`,
          body: `No clock-in ${noShowMin} minutes after the shift started:\n${who}\n\nIf they are there, check them in (or add their time) and the no-show is cleared.`,
          link: `/events/${eventId}`, sms: `${list.length} no-show${list.length === 1 ? '' : 's'} at ${list[0].event_name}`,
        });
      for (const r of list) await audit(c, tenantId, null, 'attendance.no_show', 'assignment', r.id);
    }
    out.noShows = rows.length;
  }

  // ---- late ----
  if (lateMin > 0) {
    const rows = (
      await c.query<Row>(`${missing} AND s.starts_at <= now() - make_interval(mins => $1) AND s.ends_at > now() ORDER BY s.starts_at`, [lateMin])
    ).rows;
    const fresh: Row[] = [];
    for (const r of rows) if (await mark(c, tenantId, `late:${r.id}`)) fresh.push(r);
    for (const r of fresh)
      if (r.clock_mode !== 'coordinator')
        msgs.push({
          userId: r.user_id, category: 'attendance', allowSms: true,
          title: `You're not clocked in for ${r.role_name}`,
          body: `${r.event_name} started at ${at(r.starts_at)}. Clock in when you arrive, or tell your labor coordinator if you are running late.`,
          link: '/my-shifts', sms: `You're not clocked in: ${r.role_name} at ${r.event_name} started ${at(r.starts_at)}.`,
        });
    for (const [eventId, list] of byEvent(fresh)) {
      const who = list.map((r) => `${r.name} (${r.role_name}, ${at(r.starts_at)})`).join('\n');
      for (const uid of await watchersOf(c, eventId, new Set(list.map((r) => r.user_id))))
        msgs.push({
          userId: uid, category: 'attendance', allowSms: false,
          title: `${list.length === 1 ? `${list[0].name} is late` : `${list.length} crew are late`} at ${list[0].event_name}`,
          body: `Not clocked in ${lateMin}+ minutes after the start:\n${who}`,
          link: `/events/${eventId}`,
        });
    }
    out.late = fresh.length;
  }

  // ---- forgotten clock-outs ----
  if (outH > 0) {
    const rows = (
      await c.query(
        `UPDATE time_entries t SET clock_out = GREATEST(s.ends_at, t.clock_in + interval '1 minute'), status = 'submitted', auto_clocked_out = true
           FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id JOIN events e ON e.id = s.event_id
          WHERE a.id = t.assignment_id AND t.clock_out IS NULL AND s.ends_at <= now() - make_interval(secs => $1 * 3600)
          RETURNING t.id, t.user_id, s.role_name, s.ends_at, s.event_id, e.name AS event_name,
                    (SELECT name FROM users WHERE id = t.user_id) AS name`,
        [outH],
      )
    ).rows;
    for (const r of rows) {
      await audit(c, tenantId, null, 'time.auto_clock_out', 'time_entry', r.id);
      msgs.push({
        userId: r.user_id, category: 'attendance', allowSms: false,
        title: 'You were clocked out automatically',
        body: `You didn't clock out of ${r.role_name} at ${r.event_name}, so your time was closed at the scheduled end (${at(r.ends_at)}). If you worked longer, tell your labor coordinator so they can fix it.`,
        link: '/my-shifts',
      });
    }
    for (const [eventId, list] of byEvent(rows)) {
      for (const uid of await watchersOf(c, eventId, new Set(list.map((r) => r.user_id))).then((l) => l))
        if ((await c.query("SELECT 1 FROM users WHERE id = $1 AND role IN ('admin','manager')", [uid])).rowCount)
          msgs.push({
            userId: uid, category: 'approval_request',
            title: `${list.length} timesheet${list.length === 1 ? '' : 's'} closed automatically at ${list[0].event_name}`,
            body: `Nobody clocked out, so these were closed at the shift end and need your check before they are approved:\n${list.map((r) => `${r.name} (${r.role_name})`).join('\n')}`,
            link: '/timesheets',
          });
    }
    out.clockedOut = rows.length;
  }

  if (msgs.length) await notify(c, tenantId, msgs);
  return out;
}
