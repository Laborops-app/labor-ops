import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PoolClient } from 'pg';
import { config } from '../config';
import { audit } from '../db';
import { describeShift, notifyStaff } from './index';
import { absUrl } from './templates';

const TTL_DAYS = 21;
const mac = (payload: string) => createHmac('sha256', config.jwtSecret + ':shift-respond').update(payload).digest('base64url');

/** A signed, expiring token that lets one person answer one shift offer without signing in. */
export function respondToken(tenantId: string, assignmentId: string, userId: string): string {
  const exp = Math.floor(Date.now() / 1000) + TTL_DAYS * 86400;
  const payload = `${tenantId}.${assignmentId}.${userId}.${exp}`;
  return Buffer.from(payload).toString('base64url') + '.' + mac(payload);
}

export function readRespondToken(t: string): { tid: string; aid: string; uid: string } | null {
  const [p, sig] = String(t).split('.');
  if (!p || !sig) return null;
  let payload: string;
  try {
    payload = Buffer.from(p, 'base64url').toString();
  } catch {
    return null;
  }
  const want = Buffer.from(mac(payload));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  const parts = payload.split('.');
  if (parts.length !== 4) return null;
  const [tid, aid, uid, exp] = parts;
  if (!tid || !aid || !uid || Number(exp) < Date.now() / 1000) return null;
  return { tid, aid, uid };
}

/** Same idea for an open shift offered to a group: the link lets one person claim (or pass on) one shift. */
export function claimToken(tenantId: string, shiftId: string, userId: string): string {
  const exp = Math.floor(Date.now() / 1000) + TTL_DAYS * 86400;
  const payload = `claim.${tenantId}.${shiftId}.${userId}.${exp}`;
  return Buffer.from(payload).toString('base64url') + '.' + mac(payload);
}

export function readClaimToken(t: string): { tid: string; sid: string; uid: string } | null {
  const [p, sig] = String(t).split('.');
  if (!p || !sig) return null;
  let payload: string;
  try {
    payload = Buffer.from(p, 'base64url').toString();
  } catch {
    return null;
  }
  const want = Buffer.from(mac(payload));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  const parts = payload.split('.');
  if (parts.length !== 5 || parts[0] !== 'claim') return null;
  const [, tid, sid, uid, exp] = parts;
  if (!tid || !sid || !uid || Number(exp) < Date.now() / 1000) return null;
  return { tid, sid, uid };
}

export function claimLinks(tenantId: string, shiftId: string, userId: string) {
  const t = claimToken(tenantId, shiftId, userId);
  return { accept: absUrl(`/respond?t=${t}&a=accept`), decline: absUrl(`/respond?t=${t}&a=decline`), bare: absUrl(`/respond?t=${t}`) };
}

export function respondLinks(tenantId: string, assignmentId: string, userId: string) {
  const t = respondToken(tenantId, assignmentId, userId);
  return {
    accept: absUrl(`/respond?t=${t}&a=accept`),
    decline: absUrl(`/respond?t=${t}&a=decline`),
  };
}

/** Accept or decline an offered shift. Shared by the signed-in app and the email / chat links. */
export async function respondToAssignment(
  c: PoolClient, tenantId: string, user: { id: string; name: string }, assignmentId: string, response: 'accepted' | 'declined', opts: { notStarted?: boolean } = {},
) {
  const r = await c.query(
    `UPDATE shift_assignments a SET status = $3
      WHERE a.id = $1 AND a.user_id = $2
        AND NOT EXISTS (SELECT 1 FROM time_entries t WHERE t.assignment_id = $1)
        AND ($4::boolean = false OR EXISTS (SELECT 1 FROM shifts s WHERE s.id = a.shift_id AND s.ends_at > now()))
      RETURNING id, status, shift_id`,
    [assignmentId, user.id, response, !!opts.notStarted],
  );
  const row = r.rows[0];
  if (!row) return null;
  await audit(c, tenantId, user.id, `assignment.${response}`, 'assignment', assignmentId);
  if (response === 'declined') {
    const d = await describeShift(c, tenantId, row.shift_id, row.user_id);
    // An offer wave on this shift hands the seat to the next person now, not on the next background sweep.
    const plan = (await c.query("SELECT id FROM shift_wave_plans WHERE shift_id = $1 AND status = 'active'", [row.shift_id])).rows[0];
    if (plan) {
      const { advancePlan } = await import('../waves');
      await c.query('SAVEPOINT waves');
      try { await advancePlan(c, tenantId, plan.id); await c.query('RELEASE SAVEPOINT waves'); }
      catch (e) { await c.query('ROLLBACK TO SAVEPOINT waves'); console.error('offer waves after a decline', e); }
    }
    if (d) await notifyStaff(c, tenantId, { category: 'approval_request', title: `${user.name} declined ${d.role}`, body: `${user.name} declined a shift and may need replacing.\n\n${d.line}`, link: `/events` });
  }
  return { id: row.id as string, status: row.status as string };
}
