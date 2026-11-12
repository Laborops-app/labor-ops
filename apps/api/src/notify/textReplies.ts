import type { PoolClient } from 'pg';
import { describeShift } from './index';
import { respondToAssignment } from './respond';

/**
 * Crew answer shift offers by text: "YES" or "NO" (also Y/N, accept/decline). With more than one offer waiting, the reply
 * lists them and "YES 2" / "NO 2" picks one; "YES ALL" / "NO ALL" answers every waiting offer.
 * Returns the text to send back, or null when the message isn't an answer (then it's treated as an ordinary reply).
 */
const YES = /^\s*(yes|y|yep|yeah|ok|okay|accept|confirm|si|sí)\b[\s.!]*(all|\d{1,2})?\s*[.!]*\s*$/i;
const NO = /^\s*(no|n|nope|decline|cant|can't|cannot|pass)\b[\s.!]*(all|\d{1,2})?\s*[.!]*\s*$/i;

export function parseAnswer(body: string): { answer: 'accepted' | 'declined'; pick: number | 'all' | null } | null {
  const m = YES.exec(body) ?? NO.exec(body);
  if (!m) return null;
  const answer = YES.test(body) ? 'accepted' : 'declined';
  const p = m[2]?.toLowerCase();
  return { answer, pick: p === 'all' ? 'all' : p ? Number(p) : null };
}

export async function handleTextAnswer(c: PoolClient, tenantId: string, user: { id: string; name: string }, body: string, appUrl: string): Promise<string | null> {
  const a = parseAnswer(body);
  if (!a) return null;
  const offers = (await c.query(
    `SELECT a.id, a.shift_id FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id
      WHERE a.user_id = $1 AND a.status = 'offered' AND s.starts_at > now() ORDER BY s.starts_at`, [user.id])).rows as { id: string; shift_id: string }[];
  if (!offers.length) return `LaborOps: you have no shift offers waiting right now. Your shifts: ${appUrl}/my-shifts`;
  const descs = await Promise.all(offers.map((o) => describeShift(c, tenantId, o.shift_id, user.id)));
  const label = (i: number) => { const d = descs[i]; return d ? `${d.role}, ${d.event}, ${d.when}` : 'a shift'; };
  if (offers.length > 1 && a.pick === null) {
    const list = offers.slice(0, 6).map((_, i) => `${i + 1}) ${label(i)}`).join('\n');
    return `LaborOps: you have ${offers.length} offers waiting. Reply YES 1 or NO 1 (and so on), or YES ALL:\n${list}`;
  }
  const chosen = a.pick === 'all' ? offers.map((_, i) => i) : [a.pick === null ? 0 : a.pick - 1];
  if (chosen.some((i) => i < 0 || i >= offers.length)) return `LaborOps: there's no offer ${a.pick}. Reply YES or NO with a number from 1 to ${offers.length}.`;
  const done: string[] = [];
  for (const i of chosen) {
    const r = await respondToAssignment(c, tenantId, user, offers[i]!.id, a.answer, { notStarted: true });
    if (r) done.push(label(i));
  }
  if (!done.length) return `LaborOps: that offer can't be answered any more. Your shifts: ${appUrl}/my-shifts`;
  return a.answer === 'accepted'
    ? `LaborOps: you're confirmed for ${done.join('; ')}. Details: ${appUrl}/my-shifts`
    : `LaborOps: got it, you declined ${done.join('; ')}. Thanks for letting us know.`;
}
