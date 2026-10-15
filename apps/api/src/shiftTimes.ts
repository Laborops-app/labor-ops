import type { PoolClient } from 'pg';
import { notify, describeShift } from './notify';
import { findClash } from './eligibility';

/** Tell everyone on a shift that its date or time changed. */
export async function tellTimeChange(c: PoolClient, tid: string, shiftId: string) {
  const who = (await c.query("SELECT user_id FROM shift_assignments WHERE shift_id = $1 AND status <> 'declined'", [shiftId])).rows;
  for (const w of who) {
    const d = await describeShift(c, tid, shiftId, w.user_id);
    if (d)
      await notify(c, tid, {
        userId: w.user_id, category: 'shift_change', title: `Time changed: ${d.role}`,
        body: `${d.line}\n\nThe date or time of this shift changed. If you can't make the new time, let your coordinator know.`,
        link: '/my-shifts', sms: `Time changed: ${d.role}, ${d.event}, now ${d.when}.`,
      });
  }
}

/** People on the shift who would be double-booked at the new time ("Name (Role at Event)"). */
export async function timeClashes(c: PoolClient, shiftId: string, startsAt: string | Date, endsAt: string | Date) {
  const who = (await c.query("SELECT a.user_id, u.name FROM shift_assignments a JOIN users u ON u.id = a.user_id WHERE a.shift_id = $1 AND a.status <> 'declined'", [shiftId])).rows;
  const out: string[] = [];
  for (const w of who) {
    const k = await findClash(c, w.user_id, shiftId, startsAt, endsAt);
    if (k) out.push(`${w.name} (${k.role_name} at ${k.event_name})`);
  }
  return out;
}
