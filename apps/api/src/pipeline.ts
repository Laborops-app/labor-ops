import type { PoolClient } from 'pg';
import { notify } from './notify';

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
  if (to === 'completed') await invoiceAlert(c, tid, eventId, by);
  await maybeArchive(c, eventId, by);
  return true;
}

/** Admins and HR are told once when an event is completed and still has no invoice. */
export async function invoiceAlert(c: PoolClient, tid: string, eventId: string, by: string | null) {
  const e = (
    await c.query(
      `UPDATE events e SET invoice_alert_at = now()
        WHERE e.id = $1 AND e.invoice_alert_at IS NULL AND NOT EXISTS (SELECT 1 FROM event_invoices i WHERE i.event_id = e.id)
        RETURNING e.name, e.start_date::text, e.end_date::text, (SELECT name FROM customers WHERE id = e.customer_id) AS customer,
          (SELECT count(*)::int FROM time_entries t JOIN shift_assignments a ON a.id = t.assignment_id JOIN shifts s ON s.id = a.shift_id
            WHERE s.event_id = e.id AND t.status <> 'approved') AS unapproved`,
      [eventId],
    )
  ).rows[0];
  if (!e) return;
  const to = (await c.query("SELECT id FROM users WHERE active AND role IN ('admin', 'hr') AND id <> COALESCE($1::uuid, '00000000-0000-0000-0000-000000000000')", [by])).rows;
  const dates = e.start_date === e.end_date ? e.start_date : `${e.start_date} to ${e.end_date}`;
  await notify(c, tid, to.map((u) => ({
    userId: u.id, category: 'billing' as const,
    title: `Ready to invoice: ${e.name}`,
    body: `${e.name}${e.customer ? ` for ${e.customer}` : ''} (${dates}) is completed and ready to be invoiced.` +
      (e.unapproved ? `\n\n${e.unapproved} timesheet${e.unapproved === 1 ? ' is' : 's are'} not approved yet; approve them first so the invoice has every hour.` : '') +
      '\n\nOnce the invoice is sent, the event leaves the pipeline and is archived for next year.',
    link: `/events/${eventId}#invoice`, linkLabel: 'Open the invoice',
  })));
}

/**
 * Take an event off the pipeline: a completed event once it has an invoice, or a canceled one. It is kept in the
 * archive for two years so it can be booked again next year.
 */
export async function maybeArchive(c: PoolClient, eventId: string, by: string | null) {
  await c.query(
    `UPDATE events e SET archived_at = now(), archived_by = $2,
            archive_reason = CASE WHEN e.pipeline_status = 'canceled' THEN 'canceled' ELSE 'invoiced' END
      WHERE e.id = $1 AND e.archived_at IS NULL
        AND (e.pipeline_status = 'canceled' OR (e.pipeline_status = 'completed' AND EXISTS (SELECT 1 FROM event_invoices i WHERE i.event_id = e.id)))`,
    [eventId, by],
  );
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

/**
 * What stops an event from being Completed: every worked shift needs its time submitted.
 *  - open: someone is still clocked in
 *  - missing: an accepted shift is over but the person has no time (and isn't marked a no-show)
 *  - upcoming: accepted shifts that haven't ended yet
 */
export async function timesheetGaps(c: PoolClient, eventId: string) {
  const r = (
    await c.query(
      `SELECT
         (SELECT count(*)::int FROM time_entries t JOIN shift_assignments a ON a.id = t.assignment_id JOIN shifts s ON s.id = a.shift_id
           WHERE s.event_id = $1 AND t.clock_out IS NULL) AS open,
         (SELECT count(*)::int FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id
           WHERE s.event_id = $1 AND a.status = 'accepted' AND s.ends_at <= now() AND a.no_show_at IS NULL
             AND NOT EXISTS (SELECT 1 FROM time_entries t WHERE t.assignment_id = a.id)) AS missing,
         (SELECT count(*)::int FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id
           WHERE s.event_id = $1 AND a.status = 'accepted' AND s.ends_at > now()) AS upcoming`,
      [eventId],
    )
  ).rows[0] as { open: number; missing: number; upcoming: number };
  const parts: string[] = [];
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  if (r.upcoming) parts.push(`${n(r.upcoming, 'shift hasn\'t', 'shifts haven\'t')} finished yet`);
  if (r.open) parts.push(`${n(r.open, 'person is', 'people are')} still clocked in`);
  if (r.missing) parts.push(`${n(r.missing, 'worked shift has', 'worked shifts have')} no time submitted (add the time, or mark a no-show)`);
  return { ...r, ok: !parts.length, message: parts.length ? `Not ready to complete: ${parts.join('; ')}.` : '' };
}
