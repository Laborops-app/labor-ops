-- Each person's notification choices: which kinds of alert by which channel, quiet hours, and the coordinators'
-- morning summary. Plus merging bursts of changes about the same thing into one email or text.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS notify_prefs jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS quiet_start text,
  ADD COLUMN IF NOT EXISTS quiet_end text,
  ADD COLUMN IF NOT EXISTS digest_on boolean NOT NULL DEFAULT true;
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS merge_key text, ADD COLUMN IF NOT EXISTS merged jsonb;
CREATE INDEX IF NOT EXISTS deliveries_merge_idx ON deliveries (user_id, channel, merge_key) WHERE status = 'queued' AND merge_key IS NOT NULL;
