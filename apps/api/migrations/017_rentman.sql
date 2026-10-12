-- Rentman integration: cached projects, equipment per linked event, and the event link.
ALTER TABLE integration_settings DROP CONSTRAINT IF EXISTS integration_settings_provider_check;
ALTER TABLE integration_settings ADD CONSTRAINT integration_settings_provider_check CHECK (provider IN ('ses', 'twilio', 'sns', 'podium', 'rentman'));

CREATE TABLE rentman_projects (
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id                   int NOT NULL,
  number               int,
  name                 text NOT NULL,
  customer             text,
  location             text,
  reference            text,
  project_type         text,
  tags                 text,
  planperiod_start     timestamptz,
  planperiod_end       timestamptz,
  usageperiod_start    timestamptz,
  usageperiod_end      timestamptz,
  equipment_period_from timestamptz,
  equipment_period_to  timestamptz,
  synced_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE TABLE rentman_equipment (
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id    int NOT NULL,
  item_id       int NOT NULL,
  name          text NOT NULL,
  quantity      numeric,
  unit_price    numeric,
  is_option     boolean NOT NULL DEFAULT false,
  period_start  timestamptz,
  period_end    timestamptz,
  remark        text,
  sort          int NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, project_id, item_id)
);
ALTER TABLE events ADD COLUMN rentman_project_id int;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['rentman_projects','rentman_equipment'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO laborops_app', t);
  END LOOP;
END $$;
