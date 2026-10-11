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
  const [tid, aid, uid, exp] = payload.split('.');
  if (!tid || !aid || !uid || Number(exp) < Date.now() / 1000) return null;
  return { tid, aid, uid };
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
    if (d) await notifyStaff(c, tenantId, { category: 'approval_request', title: `${user.name} declined ${d.role}`, body: `${user.name} declined a shift and may need replacing.\n\n${d.line}`, link: `/events` });
  }
  return { id: row.id as string, status: row.status as string };
}
