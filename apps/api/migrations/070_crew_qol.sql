-- Crew quality of life: a private calendar feed per person, and "running late" on a shift.
ALTER TABLE users ADD COLUMN IF NOT EXISTS cal_token text;
CREATE UNIQUE INDEX IF NOT EXISTS users_cal_token_idx ON users (cal_token) WHERE cal_token IS NOT NULL;
ALTER TABLE shift_assignments ADD COLUMN IF NOT EXISTS late_eta timestamptz, ADD COLUMN IF NOT EXISTS late_note text, ADD COLUMN IF NOT EXISTS late_at timestamptz;

-- The calendar feed is read by calendar apps with no sign-in: find whose feed a token is, and nothing else.
CREATE OR REPLACE FUNCTION calendar_owner(tok text)
RETURNS TABLE (id uuid, tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT u.id, u.tenant_id FROM users u WHERE u.cal_token = tok AND u.active AND length(tok) >= 20 $$;
REVOKE ALL ON FUNCTION calendar_owner(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION calendar_owner(text) TO laborops_app;
