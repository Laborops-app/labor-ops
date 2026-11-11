-- Rentman project requests (not yet accepted) that became pipeline events, so a deleted one isn't made again.
CREATE TABLE rentman_request_imports (
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  request_id int NOT NULL,
  event_id   uuid REFERENCES events(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, request_id)
);
ALTER TABLE rentman_request_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE rentman_request_imports FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON rentman_request_imports USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON rentman_request_imports TO laborops_app;
