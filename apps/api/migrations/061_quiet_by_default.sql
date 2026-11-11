-- New events start "building quietly": picks stay a plan until the coordinator requests the crew.
-- A company can switch the default off (Settings); a missing row means on.
CREATE TABLE staffing_settings (
  tenant_id     uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  quiet_default boolean NOT NULL DEFAULT true,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE staffing_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE staffing_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON staffing_settings USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON staffing_settings TO laborops_app;

-- Every way an event is made (new event form, templates, Rentman pipeline, client requests) gets the default.
CREATE FUNCTION events_quiet_default() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT NEW.staffing_draft THEN
    NEW.staffing_draft := COALESCE((SELECT quiet_default FROM staffing_settings WHERE tenant_id = NEW.tenant_id), true);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER events_quiet_default BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION events_quiet_default();

-- Upcoming events nobody has been offered yet start quietly too.
UPDATE events e SET staffing_draft = true
 WHERE NOT e.staffing_draft AND e.end_date >= current_date
   AND NOT EXISTS (SELECT 1 FROM shifts s JOIN shift_assignments a ON a.shift_id = s.id WHERE s.event_id = e.id);
