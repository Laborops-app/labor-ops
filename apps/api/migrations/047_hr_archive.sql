-- HR / billing accounts: invoicing, payroll, reports and timesheets; no scheduling.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'manager', 'crew', 'hr'));

-- Archived events leave the pipeline (invoiced after completion, or canceled). Kept two years for next year's booking,
-- then removed, unless an admin deletes them sooner.
ALTER TABLE events
  ADD COLUMN archived_at      timestamptz,
  ADD COLUMN archive_reason   text CHECK (archive_reason IN ('invoiced', 'canceled', 'manual')),
  ADD COLUMN archived_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN invoice_alert_at timestamptz;
CREATE INDEX events_archived_idx ON events (tenant_id, archived_at);
