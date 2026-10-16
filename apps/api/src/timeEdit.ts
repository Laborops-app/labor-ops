import type { PoolClient } from 'pg';
import { audit } from './db';
import { autoApprove } from './autoApprove';

/**
 * Correcting time (forgot to clock out, clocked in late on the phone…) and adding time for someone who never clocked in.
 *  - Coordinators and admins ("staff"): any entry. An entry already exported to payroll needs `force`.
 *  - Crew leads and on-site labor coordinators ("field"): only from 2 hours before the shift starts until 2 hours
 *    after it ends, with times inside that window, and not once a coordinator approved it or it went to payroll.
 * After a change the entry is checked again for auto-approval (a coordinator's approval stays).
 */
export type Who = { tid: string; userId: string; field: boolean };
type Times = { clockIn: string; clockOut: string | null; force?: boolean; reason?: string | null };
type Out = { code: number; error?: string; reason?: string; entry?: unknown };

const H = 3600_000;

async function shiftOf(c: PoolClient, assignmentId: string) {
  return (await c.query(
    `SELECT a.id, a.user_id, a.status, s.starts_at, s.ends_at, now() AS now FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id WHERE a.id = $1`, [assignmentId])).rows[0] as
    { id: string; user_id: string; status: string; starts_at: Date; ends_at: Date; now: Date } | undefined;
}

function check(who: Who, sh: { starts_at: Date; ends_at: Date; now: Date }, t: Times): Out | null {
  const inT = new Date(t.clockIn), outT = t.clockOut ? new Date(t.clockOut) : null;
  if (isNaN(+inT) || (outT && isNaN(+outT))) return { code: 400, error: 'Enter a valid date and time' };
  if (outT && +outT <= +inT) return { code: 400, error: 'Clock-out must be after clock-in' };
  if (outT && +outT - +inT > 24 * H) return { code: 400, error: 'One time entry can be at most 24 hours' };
  if (+inT > +sh.now + 5 * 60_000 || (outT && +outT > +sh.now + 5 * 60_000)) return { code: 400, error: 'Times cannot be in the future' };
  if (who.field) {
    const from = +sh.starts_at - 2 * H, to = +sh.ends_at + 2 * H;
    if (+sh.now < from || +sh.now > to) return { code: 403, error: 'Leads can change time from 2 hours before the shift until 2 hours after it ends. Ask a labor coordinator.' };
    if (+inT < from || (outT && +outT > to)) return { code: 400, error: 'Times must be within 2 hours of the shift' };
  }
  return null;
}

async function overlaps(c: PoolClient, userId: string, exceptId: string | null, clockIn: string, clockOut: string | null) {
  return !!(await c.query(
    `SELECT 1 FROM time_entries WHERE user_id = $1 AND ($2::uuid IS NULL OR id <> $2)
        AND tstzrange(clock_in, COALESCE(clock_out, 'infinity')) && tstzrange($3::timestamptz, COALESCE($4::timestamptz, 'infinity')) LIMIT 1`,
    [userId, exceptId, clockIn, clockOut])).rowCount;
}

export async function editEntry(c: PoolClient, who: Who, entryId: string, t: Times, allowed?: (assignmentId: string) => Promise<boolean>): Promise<Out> {
  const e = (await c.query('SELECT id, assignment_id, user_id, status, approved_by, auto_approved, payroll_exported_at, clock_in, clock_out FROM time_entries WHERE id = $1', [entryId])).rows[0];
  if (!e) return { code: 404, error: 'Time entry not found' };
  if (allowed && !(await allowed(e.assignment_id))) return { code: 404, error: 'This person is not on your crew' };
  const sh = await shiftOf(c, e.assignment_id);
  if (!sh) return { code: 404, error: 'Shift not found' };
  const bad = check(who, sh, t);
  if (bad) return bad;
  if (who.field && e.status === 'approved' && !e.auto_approved) return { code: 403, error: 'A labor coordinator already approved this time. Ask them to change it.' };
  if (e.payroll_exported_at && (who.field || !t.force))
    return who.field ? { code: 403, error: 'This time was already sent to payroll. Ask a labor coordinator.' } : { code: 409, reason: 'exported', error: 'This time was already exported to payroll. Change it anyway? Correct it in your payroll system too.' };
  if (await overlaps(c, e.user_id, e.id, t.clockIn, t.clockOut)) return { code: 409, error: 'That overlaps another time entry for this person' };
  // A coordinator's approval stays; anything else goes back to "submitted" (or "open" when still clocked in) and is checked again.
  const keepApproved = !who.field && e.status === 'approved' && !e.auto_approved && t.clockOut;
  const status = !t.clockOut ? 'open' : keepApproved ? 'approved' : 'submitted';
  const r = (await c.query(
    `UPDATE time_entries SET clock_in = $2, clock_out = $3, status = $4,
            approved_at = CASE WHEN $4 = 'approved' THEN approved_at ELSE NULL END,
            approved_by = CASE WHEN $4 = 'approved' THEN approved_by ELSE NULL END,
            auto_approved = CASE WHEN $4 = 'approved' THEN auto_approved ELSE false END,
            original_clock_in = CASE WHEN edited_at IS NULL THEN clock_in ELSE original_clock_in END,
            original_clock_out = CASE WHEN edited_at IS NULL THEN clock_out ELSE original_clock_out END,
            edited_by = $5, edited_at = now()
      WHERE id = $1 RETURNING id, clock_in, clock_out, status`,
    [e.id, t.clockIn, t.clockOut, status, who.userId])).rows[0];
  const auto = status === 'submitted' ? await autoApprove(c, e.id) : false;
  await audit(c, who.tid, who.userId, 'time.edit', 'time_entry', e.id, { from: { in: e.clock_in, out: e.clock_out }, to: { in: t.clockIn, out: t.clockOut }, reason: t.reason ?? null, by: who.field ? 'lead' : 'coordinator' });
  return { code: 200, entry: { ...r, status: auto ? 'approved' : r.status, auto_approved: auto } };
}

/** Time for someone who never clocked in (or a second stretch on the same shift). */
export async function addEntry(c: PoolClient, who: Who, assignmentId: string, t: Times, allowed?: (assignmentId: string) => Promise<boolean>): Promise<Out> {
  if (allowed && !(await allowed(assignmentId))) return { code: 404, error: 'This person is not on your crew' };
  const sh = await shiftOf(c, assignmentId);
  if (!sh) return { code: 404, error: 'Shift not found' };
  if (sh.status !== 'accepted') return { code: 409, error: 'Only confirmed crew can have time' };
  const bad = check(who, sh, t);
  if (bad) return bad;
  if (!t.clockOut && (await c.query('SELECT 1 FROM time_entries WHERE user_id = $1 AND clock_out IS NULL', [sh.user_id])).rowCount) return { code: 409, error: 'This person is already clocked in' };
  if (await overlaps(c, sh.user_id, null, t.clockIn, t.clockOut)) return { code: 409, error: 'That overlaps another time entry for this person' };
  const r = (await c.query(
    `INSERT INTO time_entries (tenant_id, assignment_id, user_id, clock_in, clock_out, status, in_by, out_by, edited_by, edited_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$7, now()) RETURNING id, clock_in, clock_out, status`,
    [who.tid, assignmentId, sh.user_id, t.clockIn, t.clockOut, t.clockOut ? 'submitted' : 'open', who.userId, t.clockOut ? who.userId : null])).rows[0];
  const auto = t.clockOut ? await autoApprove(c, r.id) : false;
  await audit(c, who.tid, who.userId, 'time.add', 'time_entry', r.id, { assignmentId, in: t.clockIn, out: t.clockOut, reason: t.reason ?? null, by: who.field ? 'lead' : 'coordinator' });
  return { code: 201, entry: { ...r, status: auto ? 'approved' : r.status, auto_approved: auto } };
}
