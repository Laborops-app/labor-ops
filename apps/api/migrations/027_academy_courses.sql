-- Upstage Academy course groups synced into LaborOps, and who has been asked to complete them.
CREATE TABLE academy_groups (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  academy_id   int  NOT NULL,
  name         text NOT NULL,
  slug         text NOT NULL,
  description  text,
  url          text NOT NULL,
  courses      jsonb NOT NULL DEFAULT '[]',
  active       boolean NOT NULL DEFAULT true,
  synced_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, academy_id)
);

CREATE TABLE academy_invites (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  group_id      uuid NOT NULL REFERENCES academy_groups(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invited_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_sent_at  timestamptz NOT NULL DEFAULT now(),
  send_count    int NOT NULL DEFAULT 1,
  completed_at  timestamptz,
  UNIQUE (group_id, user_id)
);
CREATE INDEX academy_invites_user_idx ON academy_invites (user_id);

-- Link to the certificate on the academy site, so crew can open it.
ALTER TABLE academy_certs ADD COLUMN IF NOT EXISTS url text;

ALTER TABLE academy_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE academy_groups FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON academy_groups USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE academy_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE academy_invites FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON academy_invites USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON academy_groups, academy_invites TO laborops_app;
