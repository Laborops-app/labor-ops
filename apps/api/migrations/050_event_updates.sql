-- Updates a labor coordinator sends to the crew scheduled on an event (time change, parking, call time ...).
CREATE TABLE event_updates (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_id       uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  sent_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  title          text NOT NULL,
  body           text NOT NULL,
  audience       jsonb NOT NULL DEFAULT '{}',
  include_shifts boolean NOT NULL DEFAULT true,
  texted         boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX event_updates_event_idx ON event_updates (event_id, created_at DESC);
ALTER TABLE event_updates ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_updates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON event_updates USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON event_updates TO laborops_app;

CREATE TABLE event_update_recipients (
  update_id        uuid NOT NULL REFERENCES event_updates(id) ON DELETE CASCADE,
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notification_id  uuid REFERENCES notifications(id) ON DELETE SET NULL,
  PRIMARY KEY (update_id, user_id)
);
CREATE INDEX event_update_recipients_user_idx ON event_update_recipients (user_id);
ALTER TABLE event_update_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_update_recipients FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON event_update_recipients USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON event_update_recipients TO laborops_app;
