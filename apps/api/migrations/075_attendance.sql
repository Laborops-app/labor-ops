-- Time & attendance: a coordinator can change the minimum paid hours for one person's shift, or switch it off.
ALTER TABLE time_entries
  ADD COLUMN IF NOT EXISTS min_hours_override numeric(4,2) CHECK (min_hours_override IS NULL OR (min_hours_override > 0 AND min_hours_override <= 24)),
  ADD COLUMN IF NOT EXISTS min_off boolean NOT NULL DEFAULT false;
