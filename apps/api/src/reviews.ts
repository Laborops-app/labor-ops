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
