-- Upstage Academy certificate sync: a shared secret per company, and a log of certificates received.
ALTER TABLE integration_settings DROP CONSTRAINT IF EXISTS integration_settings_provider_check;
ALTER TABLE integration_settings
  ADD CONSTRAINT integration_settings_provider_check CHECK (provider IN ('ses', 'twilio', 'sns', 'podium', 'academy'));

-- Certificates that came from the academy are verified and carry the academy certificate code.
ALTER TABLE user_certs
  ADD COLUMN IF NOT EXISTS external_ref text,
  ADD COLUMN IF NOT EXISTS source       text;

CREATE TABLE academy_certs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code        text NOT NULL,
  email       text NOT NULL,
  username    text,
  title       text NOT NULL,
  kind        text NOT NULL DEFAULT 'course' CHECK (kind IN ('course', 'group')),
  issued_at   timestamptz NOT NULL,
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  applied_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);
CREATE INDEX academy_certs_pending_idx ON academy_certs (tenant_id) WHERE applied_at IS NULL;

ALTER TABLE academy_certs ENABLE ROW LEVEL SECURITY;
ALTER TABLE academy_certs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON academy_certs USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON academy_certs TO laborops_app;
