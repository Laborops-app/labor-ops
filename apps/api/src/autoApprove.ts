import type { PoolClient } from 'pg';

/**
 * Approve a just-closed time entry automatically when it stays within its shift's scheduled hours: clocked in no
 * earlier than the start and out no later than the end, give or take the company's grace minutes (Labor rules).
 * Leaving early still counts as within the hours. Returns true when it was approved.
 */
export async function autoApprove(c: PoolClient, entryId: string): Promise<boolean> {
  const r = await c.query(
    `UPDATE time_entries t SET status = 'approved', approved_at = now(), approved_by = NULL, auto_approved = true
       FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id
       LEFT JOIN labor_rules lr ON true
      WHERE t.id = $1 AND a.id = t.assignment_id AND t.status = 'submitted' AND t.clock_out IS NOT NULL
        AND COALESCE(lr.auto_approve, true)
        -- Closed automatically because nobody clocked out: a person has to look at it first (an edit counts).
        AND (NOT t.auto_clocked_out OR t.edited_at IS NOT NULL)
        AND t.clock_in >= s.starts_at - make_interval(mins => COALESCE(lr.auto_approve_grace_min, 10))
        AND t.clock_out <= s.ends_at + make_interval(mins => COALESCE(lr.auto_approve_grace_min, 10))
      RETURNING t.id`,
    [entryId],
  );
  return !!r.rowCount;
}
