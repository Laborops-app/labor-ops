-- A pay rate for one crew member on one event: hourly at a set rate, or a flat day rate.
-- It replaces the role's rate and any rate set on the shift, for that person's shifts on that event.
CREATE TABLE event_crew_rates (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_id    uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pay_type    text NOT NULL CHECK (pay_type IN ('hourly', 'day')),
  rate        numeric(10,2) NOT NULL CHECK (rate > 0 AND rate <= 100000),
  note        text,
  updated_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, user_id)
);
CREATE INDEX event_crew_rates_user_idx ON event_crew_rates (user_id);
ALTER TABLE event_crew_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_crew_rates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON event_crew_rates USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON event_crew_rates TO laborops_app;
