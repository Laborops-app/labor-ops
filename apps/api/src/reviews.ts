import type { PoolClient } from 'pg';

/** Quick tags a coordinator can add to a review. Negative ones count as flags on the crew list. */
export const REVIEW_TAGS = ['on_time', 'hard_worker', 'skilled', 'team_player', 'safe', 'rehire', 'late', 'left_early', 'no_show', 'needs_supervision', 'safety', 'no_rehire'] as const;
export const FLAG_TAGS = ['late', 'left_early', 'no_show', 'needs_supervision', 'safety', 'no_rehire'];

/** "Audio (Lead)" → "audio": ratings are kept per base position. */
export const reviewRoleKey = (role: string) => role.replace(/\s*\(.*\)\s*$/, '').trim().toLowerCase();

/** Recompute one person's summary for one position from their reviews. */
export async function refreshRating(c: PoolClient, tid: string, userId: string, roleKey: string) {
  const r = (await c.query('SELECT count(*)::int AS n, avg(stars)::float8 AS avg FROM crew_reviews WHERE user_id = $1 AND role_key = $2', [userId, roleKey])).rows[0];
  if (!r.n) {
    await c.query('DELETE FROM crew_ratings WHERE user_id = $1 AND role_key = $2', [userId, roleKey]);
    return;
  }
  const avg = Math.round(r.avg * 100) / 100;
  await c.query(
    `INSERT INTO crew_ratings (tenant_id, user_id, role_key, stars, avg_stars, reviews, updated_at) VALUES ($1,$2,$3,$4,$5,$6, now())
     ON CONFLICT (user_id, role_key) DO UPDATE SET stars = EXCLUDED.stars, avg_stars = EXCLUDED.avg_stars, reviews = EXCLUDED.reviews, updated_at = now()`,
    [tid, userId, roleKey, Math.min(5, Math.max(1, Math.round(avg))), avg, r.n],
  );
}

/** Position → average stars (e.g. { audio: 4.5 }). */
export async function ratingsOf(c: PoolClient, userId: string): Promise<Record<string, number>> {
  const rows = (await c.query('SELECT role_key, COALESCE(avg_stars, stars)::float8 AS v FROM crew_ratings WHERE user_id = $1', [userId])).rows;
  return Object.fromEntries(rows.map((r) => [r.role_key, r.v]));
}

/** Tags that make the app stop and ask before someone is put on a shift. */
export const WARN_TAGS = ['no_show', 'no_rehire'] as const;
export type ReviewFlags = { no_show: number; no_rehire: number; last_event: string | null; last_at: string | null; last_by: string | null };

/** How often each person was tagged No-show / Do not rehire, and the most recent time. */
export async function reviewFlags(c: PoolClient, userIds: string[]): Promise<Map<string, ReviewFlags>> {
  const out = new Map<string, ReviewFlags>();
  if (!userIds.length) return out;
  const rows = (
    await c.query(
      `SELECT r.user_id,
              count(*) FILTER (WHERE 'no_show' = ANY(r.tags))::int AS no_show,
              count(*) FILTER (WHERE 'no_rehire' = ANY(r.tags))::int AS no_rehire,
              (array_agg(e.name ORDER BY r.created_at DESC))[1] AS last_event,
              max(r.created_at) AS last_at,
              (array_agg(b.name ORDER BY r.created_at DESC))[1] AS last_by
         FROM crew_reviews r LEFT JOIN events e ON e.id = r.event_id LEFT JOIN users b ON b.id = r.rated_by
        WHERE r.user_id = ANY($1::uuid[]) AND r.tags && $2::text[]
        GROUP BY r.user_id`,
      [userIds, WARN_TAGS],
    )
  ).rows;
  for (const r of rows) out.set(r.user_id, { no_show: r.no_show, no_rehire: r.no_rehire, last_event: r.last_event, last_at: r.last_at?.toISOString?.() ?? r.last_at, last_by: r.last_by });
  return out;
}

const times = (n: number) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);
/** "Jordan Lee was tagged Do not rehire once and No-show twice (most recently at U of U Game Day, Oct 13, by Cade Hardy)." */
export function flagText(name: string, f: ReviewFlags) {
  const parts = [f.no_rehire ? `Do not rehire ${times(f.no_rehire)}` : '', f.no_show ? `No-show ${times(f.no_show)}` : ''].filter(Boolean);
  const when = f.last_at ? new Date(f.last_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  const ctx = [f.last_event ? `at ${f.last_event}` : '', when, f.last_by ? `by ${f.last_by}` : ''].filter(Boolean).join(', ');
  return `${name} was tagged ${parts.join(' and ')} in past reviews${ctx ? ` (most recently ${ctx})` : ''}.`;
}
