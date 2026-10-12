-- Quote lines laid out like event shifts (section = phase, day, start / end time), customer-only shift templates,
-- and admin-designed PDF layouts for quotes.
ALTER TABLE quote_lines ADD COLUMN section text, ADD COLUMN day date, ADD COLUMN start_time text, ADD COLUMN end_time text;

ALTER TABLE shift_templates ADD COLUMN customer_id uuid REFERENCES customers(id) ON DELETE CASCADE;
CREATE INDEX shift_templates_customer_idx ON shift_templates (customer_id);

CREATE TABLE quote_layouts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name       text NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  config     jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX quote_layouts_name_unique ON quote_layouts (tenant_id, lower(name));
CREATE UNIQUE INDEX quote_layouts_one_default ON quote_layouts (tenant_id) WHERE is_default;
ALTER TABLE quotes ADD COLUMN layout_id uuid REFERENCES quote_layouts(id) ON DELETE SET NULL;

ALTER TABLE quote_layouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE quote_layouts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON quote_layouts USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON quote_layouts TO laborops_app;
