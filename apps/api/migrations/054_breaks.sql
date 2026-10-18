-- Breaks while clocked in. A rest break is paid: the time entry stays open. A lunch is unpaid: it clocks the person
-- out, and "back from lunch" clocks them in again on the same shift. Lunches still out after a set time get a reminder.
CREATE TABLE time_breaks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assignment_id uuid NOT NULL REFERENCES shift_assignments(id) ON DELETE CASCADE,
  entry_id      uuid REFERENCES time_entries(id) ON DELETE SET NULL,
  kind          text NOT NULL CHECK (kind IN ('break', 'lunch')),
  started_at    timestamptz NOT NULL DEFAULT now(),
  ended_at      timestamptz,
  reminded_at   timestamptz,
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);
-- One break or lunch open per person at a time.
CREATE UNIQUE INDEX time_breaks_one_open ON time_breaks (user_id) WHERE ended_at IS NULL;
CREATE INDEX time_breaks_entry_idx ON time_breaks (entry_id);
CREATE INDEX time_breaks_assignment_idx ON time_breaks (assignment_id);
ALTER TABLE time_breaks ENABLE ROW LEVEL SECURITY;
ALTER TABLE time_breaks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON time_breaks USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON time_breaks TO laborops_app;

-- Minutes into a lunch before the "clock back in" reminder (0 = off).
ALTER TABLE labor_rules ADD COLUMN lunch_reminder_min int NOT NULL DEFAULT 45;
