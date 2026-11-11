-- Rentman projects pulled into the pipeline as events.

-- Per company: whether new Rentman projects become events, from which date, and the last run.
CREATE TABLE rentman_settings (
  tenant_id     uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  auto_events   boolean NOT NULL DEFAULT false,
  from_date     date,
  skip_canceled boolean NOT NULL DEFAULT true,
  last_run_at   timestamptz,
  last_result   jsonb,
  updated_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- The project's status in Rentman (from its subprojects) and what it means for the pipeline.
ALTER TABLE rentman_projects
  ADD COLUMN status_name text,
  ADD COLUMN status_kind text CHECK (status_kind IN ('pending', 'quote', 'confirmed', 'canceled'));

-- Projects already turned into an event (kept when the event is deleted, so it isn't made again).
CREATE TABLE rentman_imports (
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id int NOT NULL,
  event_id   uuid REFERENCES events(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, project_id)
);

-- The Rentman dates (and status) a coordinator was last told about for a linked event, so each change is told once.
ALTER TABLE events ADD COLUMN rentman_seen text;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['rentman_settings', 'rentman_imports'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO laborops_app', t);
  END LOOP;
END $$;
