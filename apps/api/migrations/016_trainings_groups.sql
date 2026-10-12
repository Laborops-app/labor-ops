-- Crew groups (pools used to fill shifts) and trainings crew can apply for.
CREATE TABLE crew_groups (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  description text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX crew_groups_name_unique ON crew_groups (tenant_id, lower(name));
CREATE TABLE crew_group_members (
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  group_id   uuid NOT NULL REFERENCES crew_groups(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX crew_group_members_user_idx ON crew_group_members (user_id);

-- A shift can be offered to one group only: just its members see and can claim it.
ALTER TABLE shifts ADD COLUMN offer_group_id uuid REFERENCES crew_groups(id) ON DELETE SET NULL;

CREATE TABLE trainings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title            text NOT NULL,
  description      text,
  location         text,
  starts_at        timestamptz NOT NULL,
  ends_at          timestamptz NOT NULL CHECK (ends_at > starts_at),
  capacity         int NOT NULL CHECK (capacity BETWEEN 1 AND 1000),
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'cancelled')),
  grants_cert      text,
  cert_valid_months int CHECK (cert_valid_months IS NULL OR cert_valid_months BETWEEN 1 AND 120),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE training_applications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  training_id  uuid NOT NULL REFERENCES trainings(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       text NOT NULL DEFAULT 'applied' CHECK (status IN ('applied', 'approved', 'waitlisted', 'declined', 'completed')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (training_id, user_id)
);
CREATE INDEX training_apps_user_idx ON training_applications (user_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['crew_groups','crew_group_members','trainings','training_applications'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO laborops_app', t);
  END LOOP;
END $$;
