-- Corrections to clock-in / clock-out: who changed it, when, and the times originally recorded.
ALTER TABLE time_entries
  ADD COLUMN edited_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN edited_at timestamptz,
  ADD COLUMN original_clock_in timestamptz,
  ADD COLUMN original_clock_out timestamptz;
