-- The platform console has its own accounts: people who run LaborOps are not members of any company.
CREATE TABLE platform_users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email              text NOT NULL,
  name               text NOT NULL DEFAULT '',
  password_hash      text,                       -- empty until they open their setup link
  active             boolean NOT NULL DEFAULT true,
  setup_hash         text,                       -- sha256 of the one-time setup / reset link
  setup_expires_at   timestamptz,
  invited_by         uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  last_login_at      timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX platform_users_email ON platform_users (lower(email));
REVOKE ALL ON platform_users FROM laborops_app;

-- Anyone who was a platform admin through their company account keeps access with the same email and password.
INSERT INTO platform_users (email, name, password_hash)
SELECT u.email, u.name, u.password_hash FROM platform_admins p JOIN users u ON u.id = p.user_id
ON CONFLICT DO NOTHING;
DROP TABLE platform_admins;

-- What platform admins did (suspend, plan changes, storage, admins).
CREATE TABLE platform_audit (
  id          bigserial PRIMARY KEY,
  actor_id    uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  action      text NOT NULL,
  tenant_id   uuid REFERENCES tenants(id) ON DELETE SET NULL,
  detail      jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX platform_audit_time ON platform_audit (created_at DESC);
REVOKE ALL ON platform_audit FROM laborops_app;
REVOKE ALL ON SEQUENCE platform_audit_id_seq FROM laborops_app;

-- Internal notes about a company, only seen in the platform console.
ALTER TABLE tenants ADD COLUMN platform_notes text;

-- Daily sign-in counts per company are read from audit_logs; this keeps that fast.
CREATE INDEX IF NOT EXISTS audit_action_time ON audit_logs (action, created_at);
