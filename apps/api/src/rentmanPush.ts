import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool, withTenant } from './db';
import { getToken, refId, RentmanError, send } from './rentman';
import { loadOptions } from './rentmanOptions';

/**
 * LaborOps → Rentman, both optional (Integrations › Rentman):
 *  - approved hours on Rentman events go to Rentman as time registrations for the linked crew member;
 *  - time off goes to Rentman as the crew member's "not available" periods.
 * Rentman's API can't attach a time registration to a project or approve it, so each one names the event and role in
 * its remark and arrives in Rentman as pending. A change in LaborOps updates it; unapproving or deleting removes it.
 */
const RETRY_MIN = 30;
const hash = (...v: unknown[]) => crypto.createHash('sha1').update(JSON.stringify(v)).digest('hex');
const why = (e: unknown) => (e instanceof RentmanError ? e.message : (e as Error)?.message ?? 'Unknown error').slice(0, 400);

// ---------- hours ----------

export async function pushHours(c: PoolClient, tid: string, token: string) {
  const out = { sent: 0, updated: 0, removed: 0, failed: 0, waiting: 0 };
  // Approved entries on Rentman-linked events, for crew linked to Rentman.
  const { rows } = await c.query(
    `SELECT te.id, te.clock_in, te.clock_out, e.name AS event, s.role_name, rc.id AS crew_id,
            tr.id AS reg_row, tr.rentman_id, tr.hash, tr.error, tr.updated_at
       FROM time_entries te
       JOIN shift_assignments a ON a.id = te.assignment_id
       JOIN shifts s ON s.id = a.shift_id
       JOIN events e ON e.id = s.event_id
       LEFT JOIN rentman_crew rc ON rc.user_id = te.user_id
       LEFT JOIN rentman_time_regs tr ON tr.entry_id = te.id
      WHERE te.status = 'approved' AND te.clock_out IS NOT NULL AND e.rentman_project_id IS NOT NULL`,
  );
  for (const r of rows) {
    if (!r.crew_id) { out.waiting++; continue; }
    const remark = `LaborOps · ${r.event} · ${r.role_name}`;
    const h = hash(r.crew_id, r.clock_in, r.clock_out, remark);
    if (r.rentman_id && r.hash === h) continue;
    if (r.error && r.hash === h && Date.now() - +new Date(r.updated_at) < RETRY_MIN * 60_000) { out.failed++; continue; }
    const body = { crewmember: `/crew/${r.crew_id}`, start: new Date(r.clock_in).toISOString(), end: new Date(r.clock_out).toISOString(), remark, distance: 0, is_lunch_included: false };
    try {
      if (r.rentman_id) {
        await send(token, 'PUT', `/timeregistration/${r.rentman_id}`, body, 'the time registration');
        out.updated++;
        await c.query('UPDATE rentman_time_regs SET hash = $2, sent_at = now(), error = NULL, updated_at = now() WHERE id = $1', [r.reg_row, h]);
      } else {
        const res = await send(token, 'POST', '/timeregistration', body, 'the time registration');
        const rid = refId(res?.data?.id ?? res?.id ?? res?.data?.ref);
        await c.query(
          `INSERT INTO rentman_time_regs (tenant_id, entry_id, rentman_id, hash, sent_at, error, updated_at) VALUES ($1,$2,$3,$4, now(), NULL, now())
           ON CONFLICT (entry_id) DO UPDATE SET rentman_id = $3, hash = $4, sent_at = now(), error = NULL, updated_at = now()`,
          [tid, r.id, rid, h],
        );
        out.sent++;
      }
    } catch (e) {
      out.failed++;
      await c.query(
        `INSERT INTO rentman_time_regs (tenant_id, entry_id, hash, error, updated_at) VALUES ($1,$2,$3,$4, now())
         ON CONFLICT (entry_id) DO UPDATE SET hash = $3, error = $4, updated_at = now()`,
        [tid, r.id, h, why(e)],
      );
    }
  }
  // Sent before but no longer approved (or the entry was deleted): take it back out of Rentman.
  const gone = (await c.query(
    `SELECT tr.id, tr.rentman_id FROM rentman_time_regs tr LEFT JOIN time_entries te ON te.id = tr.entry_id
      WHERE tr.rentman_id IS NOT NULL AND (te.id IS NULL OR te.status <> 'approved')`,
  )).rows;
  for (const g of gone) {
    try {
      await send(token, 'DELETE', `/timeregistration/${g.rentman_id}`, null, 'the time registration');
      await c.query('DELETE FROM rentman_time_regs WHERE id = $1', [g.id]);
      out.removed++;
    } catch (e) {
      await c.query('UPDATE rentman_time_regs SET error = $2, updated_at = now() WHERE id = $1', [g.id, why(e)]);
    }
  }
  await c.query('DELETE FROM rentman_time_regs WHERE rentman_id IS NULL AND (entry_id IS NULL OR entry_id NOT IN (SELECT id FROM time_entries WHERE status = \'approved\'))');
  return out;
}

// ---------- time off ----------

/** A day range in the company's time zone as Rentman's start and end: midnight of the first day to midnight after the last. */
async function dayRange(c: PoolClient, from: string, to: string) {
  const r = (await c.query(
    `SELECT ($1::date)::timestamp AT TIME ZONE t.timezone AS s, ($2::date + 1)::timestamp AT TIME ZONE t.timezone AS e
       FROM tenants t WHERE t.id = app_tenant_id()`,
    [from, to],
  )).rows[0];
  return { start: new Date(r.s).toISOString(), end: new Date(r.e).toISOString() };
}

export async function pushTimeOff(c: PoolClient, tid: string, token: string) {
  const out = { sent: 0, updated: 0, removed: 0, failed: 0 };
  const { rows } = await c.query(
    `SELECT o.id, o.starts_on::text AS s, o.ends_on::text AS e, o.note, rc.id AS crew_id, l.id AS row_id, l.rentman_id, l.hash, l.error, l.updated_at
       FROM time_off o JOIN rentman_crew rc ON rc.user_id = o.user_id
       LEFT JOIN rentman_leave l ON l.time_off_id = o.id
      WHERE o.ends_on >= current_date - 1`,
  );
  for (const r of rows) {
    const remark = `LaborOps time off${r.note ? ` · ${String(r.note).slice(0, 200)}` : ''}`;
    const h = hash(r.crew_id, r.s, r.e, remark);
    if (r.rentman_id && r.hash === h) continue;
    if (r.error && r.hash === h && Date.now() - +new Date(r.updated_at) < RETRY_MIN * 60_000) { out.failed++; continue; }
    const { start, end } = await dayRange(c, r.s, r.e);
    const body = { start, end, status: 'N', remark };
    try {
      if (r.rentman_id) {
        await send(token, 'PUT', `/crewavailability/${r.rentman_id}`, body, 'the availability');
        await c.query('UPDATE rentman_leave SET hash = $2, sent_at = now(), error = NULL, updated_at = now() WHERE id = $1', [r.row_id, h]);
        out.updated++;
      } else {
        const res = await send(token, 'POST', `/crew/${r.crew_id}/crewavailability`, body, 'the availability');
        const rid = refId(res?.data?.id ?? res?.id);
        await c.query(
          `INSERT INTO rentman_leave (tenant_id, time_off_id, rentman_id, hash, sent_at, error) VALUES ($1,$2,$3,$4, now(), NULL)
           ON CONFLICT (time_off_id) DO UPDATE SET rentman_id = $3, hash = $4, sent_at = now(), error = NULL`,
          [tid, r.id, rid, h],
        );
        out.sent++;
      }
    } catch (e) {
      out.failed++;
      await c.query(
        `INSERT INTO rentman_leave (tenant_id, time_off_id, hash, error, updated_at) VALUES ($1,$2,$3,$4, now())
         ON CONFLICT (time_off_id) DO UPDATE SET hash = $3, error = $4, updated_at = now()`,
        [tid, r.id, h, why(e)],
      );
    }
  }
  const gone = (await c.query('SELECT id, rentman_id FROM rentman_leave WHERE time_off_id IS NULL')).rows;
  for (const g of gone) {
    try {
      if (g.rentman_id) await send(token, 'DELETE', `/crewavailability/${g.rentman_id}`, null, 'the availability');
      await c.query('DELETE FROM rentman_leave WHERE id = $1', [g.id]);
      out.removed++;
    } catch (e) {
      await c.query('UPDATE rentman_leave SET error = $2, updated_at = now() WHERE id = $1', [g.id, why(e)]);
    }
  }
  return out;
}

/** What the Integrations page shows under "Back to Rentman". */
export async function pushStatus(c: PoolClient) {
  const h = (await c.query(
    `SELECT count(*) FILTER (WHERE tr.rentman_id IS NOT NULL AND tr.error IS NULL)::int AS sent,
            count(*) FILTER (WHERE tr.error IS NOT NULL)::int AS failed,
            (SELECT error FROM rentman_time_regs WHERE error IS NOT NULL ORDER BY updated_at DESC LIMIT 1) AS last_error
       FROM rentman_time_regs tr`,
  )).rows[0];
  const missing = (await c.query(
    `SELECT DISTINCT u.id, u.name FROM time_entries te
       JOIN shift_assignments a ON a.id = te.assignment_id JOIN shifts s ON s.id = a.shift_id JOIN events e ON e.id = s.event_id
       JOIN users u ON u.id = te.user_id
      WHERE te.status = 'approved' AND e.rentman_project_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM rentman_crew rc WHERE rc.user_id = te.user_id)
      ORDER BY u.name LIMIT 50`,
  )).rows;
  const waiting = (await c.query(
    `SELECT count(*)::int AS n FROM time_entries te
       JOIN shift_assignments a ON a.id = te.assignment_id JOIN shifts s ON s.id = a.shift_id JOIN events e ON e.id = s.event_id
      WHERE te.status = 'approved' AND e.rentman_project_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM rentman_crew rc WHERE rc.user_id = te.user_id)`,
  )).rows[0].n;
  const t = (await c.query(
    `SELECT count(*) FILTER (WHERE rentman_id IS NOT NULL AND error IS NULL)::int AS sent, count(*) FILTER (WHERE error IS NOT NULL)::int AS failed,
            (SELECT error FROM rentman_leave WHERE error IS NOT NULL ORDER BY updated_at DESC LIMIT 1) AS last_error FROM rentman_leave`,
  )).rows[0];
  return {
    hours: { sent: h.sent, waiting, failed: h.failed, missingCrew: missing, lastError: h.last_error },
    timeOff: { sent: t.sent, failed: t.failed, lastError: t.last_error },
  };
}

/** Every couple of minutes: each company with hours or time off going to Rentman. */
export async function runRentmanPush() {
  const { rows } = await pool.query('SELECT id FROM notify_tenants()');
  for (const t of rows) {
    await withTenant(t.id, async (c) => {
      const o = await loadOptions(c);
      if (!o.push_hours && !o.push_time_off) return;
      const token = await getToken(c);
      if (!token) return;
      if (o.push_hours) await pushHours(c, t.id, token);
      if (o.push_time_off) await pushTimeOff(c, t.id, token);
    }).catch((e) => console.error('rentman push', t.id, e?.message ?? e));
  }
}
