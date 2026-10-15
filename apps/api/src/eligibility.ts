import type { PoolClient } from 'pg';

export type Booked = { role_name: string; event_name: string; starts_at: string; ends_at: string };
export type Elig = { user_id: string; missing_certs: string[]; time_off: boolean; outside_availability: boolean; booked: Booked | null };

/**
 * For one shift, report for each active crew member (or just `userId`):
 *  - missing_certs: required certificates the person does not hold, or holds but expired on the shift date
 *  - time_off: approved time off overlaps the shift
 *  - outside_availability: they set weekly availability and this shift falls outside it
 *  - booked: another shift they are on (not declined) on the same day, if any
 * Times are evaluated in the company's time zone. A person with no availability rows counts as always available.
 */
export async function evaluateShift(c: PoolClient, shiftId: string, userId?: string): Promise<Elig[]> {
  const s = (await c.query('SELECT starts_at, ends_at, required_certs FROM shifts WHERE id = $1', [shiftId])).rows[0];
  if (!s) return [];
  return evaluateWindow(c, s.starts_at, s.ends_at, s.required_certs ?? [], { shiftId, userId });
}

/** The same check for a time window that is not a shift yet (the add-shift form). */
export async function evaluateWindow(c: PoolClient, startsAt: string | Date, endsAt: string | Date, certs: string[], opts: { shiftId?: string; userId?: string } = {}): Promise<Elig[]> {
  const r = await c.query(
    `WITH t AS (SELECT timezone AS tz FROM tenants LIMIT 1),
     x AS (SELECT $3::text[] AS required_certs, ($1::timestamptz AT TIME ZONE t.tz) AS ls, ($2::timestamptz AT TIME ZONE t.tz) AS le, t.tz FROM t)
     SELECT u.id AS user_id,
       ARRAY(SELECT r FROM unnest(x.required_certs) r WHERE NOT EXISTS (
         SELECT 1 FROM user_certs uc WHERE uc.user_id = u.id AND lower(uc.name) = lower(r)
           AND uc.verified AND (uc.expires_on IS NULL OR uc.expires_on >= x.ls::date))) AS missing_certs,
       EXISTS (SELECT 1 FROM time_off o WHERE o.user_id = u.id AND o.starts_on <= x.le::date AND o.ends_on >= x.ls::date) AS time_off,
       (EXISTS (SELECT 1 FROM availability a WHERE a.user_id = u.id)
        AND NOT EXISTS (SELECT 1 FROM availability a WHERE a.user_id = u.id
          AND a.weekday = EXTRACT(dow FROM x.ls)::int AND a.start_time <= x.ls::time
          AND (CASE WHEN x.le::date = x.ls::date THEN a.end_time >= x.le::time ELSE a.end_time >= time '23:59' END))) AS outside_availability,
       (SELECT json_build_object('role_name', s2.role_name, 'event_name', e2.name, 'starts_at', s2.starts_at, 'ends_at', s2.ends_at)
          FROM shift_assignments a2 JOIN shifts s2 ON s2.id = a2.shift_id JOIN events e2 ON e2.id = s2.event_id
         WHERE a2.user_id = u.id AND a2.status <> 'declined' AND s2.id IS DISTINCT FROM $4::uuid
           AND (s2.starts_at AT TIME ZONE x.tz)::date <= x.le::date AND (s2.ends_at AT TIME ZONE x.tz)::date >= x.ls::date
         ORDER BY s2.starts_at LIMIT 1) AS booked
     FROM users u, x WHERE u.role = 'crew' AND u.active AND ($5::uuid IS NULL OR u.id = $5)
     ORDER BY u.name`,
    [startsAt, endsAt, certs, opts.shiftId ?? null, opts.userId ?? null],
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
