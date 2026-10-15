-- The QuickBooks time entry each worked entry was sent as, so it is never sent twice.
ALTER TABLE time_entries ADD COLUMN qbo_time_activity_id text;
