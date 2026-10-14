-- QuickBooks (Online API + Desktop import file) for billing, and payroll exports (ADP, Gusto, QuickBooks).
ALTER TABLE integration_settings DROP CONSTRAINT IF EXISTS integration_settings_provider_check;
ALTER TABLE integration_settings ADD CONSTRAINT integration_settings_provider_check CHECK (provider IN ('ses', 'twilio', 'sns', 'podium', 'rentman', 'quickbooks'));

ALTER TABLE customers ADD COLUMN qbo_customer_id text;
ALTER TABLE skills ADD COLUMN qbo_item_id text;
ALTER TABLE skills ADD COLUMN day_bill_rate numeric(10,2) NOT NULL DEFAULT 0 CHECK (day_bill_rate >= 0);
-- Each person's ID in the payroll systems, e.g. {"adp": "001234", "gusto": "...", "quickbooks": "55"}.
ALTER TABLE users ADD COLUMN payroll_ids jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE time_entries ADD COLUMN payroll_exported_at timestamptz;

-- Non-secret accounting and payroll settings (QuickBooks secrets live encrypted in integration_settings).
CREATE TABLE accounting_settings (
  tenant_id  uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  config     jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Every invoice sent to QuickBooks or downloaded for QuickBooks Desktop, so an event is not billed twice by accident.
CREATE TABLE event_invoices (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_id    uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  provider    text NOT NULL CHECK (provider IN ('qbo', 'iif')),
  source      text NOT NULL CHECK (source IN ('time', 'schedule')),
  external_id text,
  doc_number  text,
  total       numeric(12,2) NOT NULL,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX event_invoices_event_idx ON event_invoices (tenant_id, event_id);

CREATE TABLE payroll_exports (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider     text NOT NULL CHECK (provider IN ('adp', 'gusto', 'quickbooks', 'csv')),
  period_start date NOT NULL,
  period_end   date NOT NULL,
  people       int NOT NULL,
  entries      int NOT NULL,
  gross        numeric(12,2),
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['accounting_settings','event_invoices','payroll_exports'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO laborops_app', t);
  END LOOP;
END $$;
