-- Crew profile details, certificate review and uploaded certificate files.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS address         text,
  ADD COLUMN IF NOT EXISTS emergency_name  text,
  ADD COLUMN IF NOT EXISTS emergency_phone text,
  ADD COLUMN IF NOT EXISTS bio             text;

-- Certificates added by a manager are verified. Ones a crew member adds themselves need a manager's review
-- before the scheduler counts them.
ALTER TABLE user_certs ADD COLUMN IF NOT EXISTS verified boolean NOT NULL DEFAULT true;

CREATE TABLE cert_files (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  cert_id       uuid NOT NULL UNIQUE REFERENCES user_certs(id) ON DELETE CASCADE,
  filename      text NOT NULL,
  content_type  text NOT NULL,
  size          integer NOT NULL,
  data          bytea NOT NULL,
  uploaded_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE cert_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE cert_files FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cert_files USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON cert_files TO laborops_app;
