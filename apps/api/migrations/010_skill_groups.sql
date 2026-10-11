-- Groups for roles / skills (Audio, Lighting, Stage Hand, Equipment Ops ...).
CREATE TABLE skill_groups (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  sort        int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX skill_groups_name_unique ON skill_groups (tenant_id, lower(name));
ALTER TABLE skill_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE skill_groups FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON skill_groups USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON skill_groups TO laborops_app;

ALTER TABLE skills ADD COLUMN group_id uuid REFERENCES skill_groups(id) ON DELETE SET NULL;
CREATE INDEX skills_group_idx ON skills (group_id);
