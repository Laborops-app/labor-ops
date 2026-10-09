import type { PoolClient } from 'pg';

export type Elig = { user_id: string; missing_certs: string[]; time_off: boolean; outside_availability: boolean };

/**
 * For one shift, report for each active crew member (or just `userId`):
 *  - missing_certs: required certificates the person does not hold, or holds but expired on the shift date
 *  - time_off: approved time off overlaps the shift
 *  - outside_availability: they set weekly availability and this shift falls outside it
 * Times are evaluated in the company's time zone. A person with no availability rows counts as always available.
 */
export async function evaluateShift(c: PoolClient, shiftId: string, userId?: string): Promise<Elig[]> {
  const r = await c.query(
    `WITH x AS (
       SELECT s.id, s.required_certs,
              (s.starts_at AT TIME ZONE t.timezone) AS ls, (s.ends_at AT TIME ZONE t.timezone) AS le
       FROM shifts s, (SELECT timezone FROM tenants LIMIT 1) t WHERE s.id = $1)
     SELECT u.id AS user_id,
       ARRAY(SELECT r FROM unnest(x.required_certs) r WHERE NOT EXISTS (
         SELECT 1 FROM user_certs uc WHERE uc.user_id = u.id AND lower(uc.name) = lower(r)
           AND (uc.expires_on IS NULL OR uc.expires_on >= x.ls::date))) AS missing_certs,
       EXISTS (SELECT 1 FROM time_off o WHERE o.user_id = u.id AND o.starts_on <= x.le::date AND o.ends_on >= x.ls::date) AS time_off,
       (EXISTS (SELECT 1 FROM availability a WHERE a.user_id = u.id)
        AND NOT EXISTS (SELECT 1 FROM availability a WHERE a.user_id = u.id
          AND a.weekday = EXTRACT(dow FROM x.ls)::int AND a.start_time <= x.ls::time
          AND (CASE WHEN x.le::date = x.ls::date THEN a.end_time >= x.le::time ELSE a.end_time >= time '23:59' END))) AS outside_availability
     FROM users u, x WHERE u.role = 'crew' AND u.active AND ($2::uuid IS NULL OR u.id = $2)
     ORDER BY u.name`,
    [shiftId, userId ?? null],
  );
  return r.rows;
}

/** Another active (non-declined) assignment of this person that overlaps the time range, if any. */
export async function findClash(c: PoolClient, userId: string, excludeShiftId: string, startsAt: string | Date, endsAt: string | Date) {
  const r = await c.query(
    `SELECT e.name AS event_name, s.role_name, s.starts_at, s.ends_at
     FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id JOIN events e ON e.id = s.event_id
     WHERE a.user_id = $1 AND a.status <> 'declined' AND s.id <> $2
       AND tstzrange(s.starts_at, s.ends_at) && tstzrange($3::timestamptz, $4::timestamptz)
     LIMIT 1`,
    [userId, excludeShiftId, startsAt, endsAt],
  );
  return r.rows[0] as { event_name: string; role_name: string; starts_at: string; ends_at: string } | undefined;
}

export const filledCount = async (c: PoolClient, shiftId: string) =>
  (await c.query("SELECT count(*)::int AS n FROM shift_assignments WHERE shift_id = $1 AND status <> 'declined'", [shiftId])).rows[0]
    .n as number;

export const certMessage = (name: string, missing: string[]) =>
  `${name} does not have a valid ${missing.join(', ')} certificate for that shift`;
