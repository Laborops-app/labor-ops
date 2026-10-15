import type { PoolClient } from 'pg';

export const STATUSES = ['pending', 'quote', 'confirmed', 'in_progress', 'completed', 'canceled'] as const;
export type PipelineStatus = (typeof STATUSES)[number];
export const STATUS_LABEL: Record<PipelineStatus, string> = {
  pending: 'Pending', quote: 'Quote', confirmed: 'Confirmed', in_progress: 'In progress', completed: 'Completed', canceled: 'Canceled',
};

/** Move an event to another column and log it. Returns false when it was already there. */
export async function setStatus(c: PoolClient, tid: string, eventId: string, to: PipelineStatus, by: string | null, reason: string | null) {
  const cur = (await c.query('SELECT pipeline_status FROM events WHERE id = $1 FOR UPDATE', [eventId])).rows[0];
  if (!cur || cur.pipeline_status === to) return false;
  // New arrivals go to the top of the column.
  const top = (await c.query('SELECT min(board_position) AS p FROM events WHERE pipeline_status = $1', [to])).rows[0].p;
  await c.query('UPDATE events SET pipeline_status = $2, status_changed_at = now(), board_position = $3 WHERE id = $1', [eventId, to, top == null ? 0 : Number(top) - 1]);
  await c.query('INSERT INTO event_status_log (tenant_id, event_id, from_status, to_status, reason, changed_by) VALUES ($1,$2,$3,$4,$5,$6)', [tid, eventId, cur.pipeline_status, to, reason, by]);
  return true;
}

/**
 * Moves that follow from what happened elsewhere, only ever forward:
 * a quote made or sent → Quote; the customer accepts it → Confirmed.
 */
export async function onQuote(c: PoolClient, tid: string, eventId: string | null, quoteStatus: string, by: string | null) {
  if (!eventId) return;
  const cur = (await c.query('SELECT pipeline_status FROM events WHERE id = $1', [eventId])).rows[0]?.pipeline_status;
  if (!cur) return;
  if (quoteStatus === 'accepted' && (cur === 'pending' || cur === 'quote')) await setStatus(c, tid, eventId, 'confirmed', by, 'Quote accepted');
  else if ((quoteStatus === 'draft' || quoteStatus === 'sent') && cur === 'pending') await setStatus(c, tid, eventId, 'quote', by, quoteStatus === 'sent' ? 'Quote sent' : 'Quote created');
}

/** Confirmed events whose first day has come move to In progress by themselves. */
export async function autoAdvance(c: PoolClient, tid: string) {
  const due = (await c.query("SELECT id FROM events WHERE pipeline_status = 'confirmed' AND start_date <= current_date AND end_date >= current_date")).rows;
  for (const e of due) await setStatus(c, tid, e.id, 'in_progress', null, 'Event started');
}
