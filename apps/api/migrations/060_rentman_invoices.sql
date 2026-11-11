-- Rentman's invoices for a project, kept so events and pipeline cards can show what Rentman has billed.
CREATE TABLE rentman_invoices (
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id            int NOT NULL,
  project_id    int NOT NULL,
  number        text,
  subject       text,
  invoice_date  date,
  due_date      date,
  price         numeric(12,2),
  price_invat   numeric(12,2),
  paid          numeric(12,2),
  outstanding   numeric(12,2),
  is_paid       boolean NOT NULL DEFAULT false,
  finalized     boolean NOT NULL DEFAULT false,
  synced_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX rentman_invoices_project_idx ON rentman_invoices (tenant_id, project_id);
ALTER TABLE rentman_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE rentman_invoices FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON rentman_invoices USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON rentman_invoices TO laborops_app;

