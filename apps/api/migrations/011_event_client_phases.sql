-- Client name on events, and dated phases (load-in, show days, strike ...).
ALTER TABLE events ADD COLUMN client text;

CREATE TABLE event_phases (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_id    uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  label       text NOT NULL,
  starts_on   date NOT NULL,
  ends_on     date NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on >= starts_on)
);
CREATE INDEX event_phases_event_idx ON event_phases (event_id, starts_on);
ALTER TABLE event_phases ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_phases FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON event_phases USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON event_phases TO laborops_app;
