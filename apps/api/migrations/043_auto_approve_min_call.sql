-- Time that stays within the scheduled shift (plus a few minutes either side) is approved automatically.
ALTER TABLE labor_rules
  ADD COLUMN auto_approve boolean NOT NULL DEFAULT true,
  ADD COLUMN auto_approve_grace_min int NOT NULL DEFAULT 10 CHECK (auto_approve_grace_min BETWEEN 0 AND 120);
ALTER TABLE time_entries ADD COLUMN auto_approved boolean NOT NULL DEFAULT false;

-- Minimum call: crew on the shift are paid at least this many hours, even if released earlier (e.g. 4 or 5).
ALTER TABLE shifts ADD COLUMN min_hours numeric(4,2) CHECK (min_hours IS NULL OR (min_hours > 0 AND min_hours <= 12));
