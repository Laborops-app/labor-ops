-- 1) Worker instructions and uniforms -------------------------------------------------------------------------
-- Company-wide uniform presets ("All black", "Show blacks + hi-vis"), picked per event; each event can add a note.
CREATE TABLE uniforms (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  description text CHECK (description IS NULL OR length(description) <= 600),
  sort        int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uniforms_name_idx ON uniforms (tenant_id, lower(name));
ALTER TABLE uniforms ENABLE ROW LEVEL SECURITY;
ALTER TABLE uniforms FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON uniforms USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON uniforms TO laborops_app;

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS instructions text CHECK (instructions IS NULL OR length(instructions) <= 4000),
  ADD COLUMN IF NOT EXISTS uniform_id uuid REFERENCES uniforms(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS uniform_note text CHECK (uniform_note IS NULL OR length(uniform_note) <= 300);

-- 2) Change log: every log line knows its event and the crew member it is about ---------------------------------
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS event_id uuid, ADD COLUMN IF NOT EXISTS subject_id uuid;
CREATE INDEX IF NOT EXISTS audit_event_idx ON audit_logs (tenant_id, event_id, created_at DESC) WHERE event_id IS NOT NULL;

CREATE OR REPLACE FUNCTION audit_link() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE eid uuid; d_ev uuid; d_who uuid; f_ev uuid; f_who uuid;
BEGIN
  BEGIN eid := NEW.entity_id::uuid; EXCEPTION WHEN others THEN eid := NULL; END;
  IF NEW.detail IS NOT NULL AND jsonb_typeof(NEW.detail) = 'object' THEN
    BEGIN d_ev := NULLIF(NEW.detail->>'eventId', '')::uuid; EXCEPTION WHEN others THEN d_ev := NULL; END;
    BEGIN d_who := NULLIF(NEW.detail->>'userId', '')::uuid; EXCEPTION WHEN others THEN d_who := NULL; END;
  END IF;
  IF eid IS NOT NULL THEN
    IF NEW.entity = 'event' THEN f_ev := eid;
    ELSIF NEW.entity = 'shift' THEN SELECT s.event_id INTO f_ev FROM shifts s WHERE s.id = eid;
    ELSIF NEW.entity = 'assignment' THEN
      SELECT s.event_id, a.user_id INTO f_ev, f_who FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id WHERE a.id = eid;
    ELSIF NEW.entity = 'planned_pick' THEN SELECT p.event_id, p.user_id INTO f_ev, f_who FROM planned_picks p WHERE p.id = eid;
    ELSIF NEW.entity = 'time_entry' THEN
      SELECT s.event_id, t.user_id INTO f_ev, f_who FROM time_entries t JOIN shift_assignments a ON a.id = t.assignment_id JOIN shifts s ON s.id = a.shift_id WHERE t.id = eid;
    ELSIF NEW.entity = 'time_break' THEN
      SELECT s.event_id, b.user_id INTO f_ev, f_who FROM time_breaks b JOIN shift_assignments a ON a.id = b.assignment_id JOIN shifts s ON s.id = a.shift_id WHERE b.id = eid;
    ELSIF NEW.entity = 'event_phase' THEN SELECT p.event_id INTO f_ev FROM event_phases p WHERE p.id = eid;
    ELSIF NEW.entity = 'user' THEN f_who := eid;
    END IF;
  END IF;
  NEW.event_id := COALESCE(NEW.event_id, f_ev, d_ev);
  NEW.subject_id := COALESCE(NEW.subject_id, f_who, d_who);
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS audit_link_trg ON audit_logs;
CREATE TRIGGER audit_link_trg BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION audit_link();

-- Link what's already logged.
UPDATE audit_logs l SET event_id = l.entity_id::uuid WHERE l.entity = 'event' AND l.event_id IS NULL AND l.entity_id ~ '^[0-9a-f-]{36}$';
UPDATE audit_logs l SET event_id = s.event_id FROM shifts s WHERE l.entity = 'shift' AND l.event_id IS NULL AND l.entity_id = s.id::text;
UPDATE audit_logs l SET event_id = s.event_id, subject_id = a.user_id FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id
 WHERE l.entity = 'assignment' AND l.event_id IS NULL AND l.entity_id = a.id::text;
UPDATE audit_logs l SET event_id = s.event_id, subject_id = t.user_id FROM time_entries t JOIN shift_assignments a ON a.id = t.assignment_id JOIN shifts s ON s.id = a.shift_id
 WHERE l.entity = 'time_entry' AND l.event_id IS NULL AND l.entity_id = t.id::text;
UPDATE audit_logs l SET event_id = p.event_id FROM event_phases p WHERE l.entity = 'event_phase' AND l.event_id IS NULL AND l.entity_id = p.id::text;
UPDATE audit_logs l SET subject_id = l.entity_id::uuid WHERE l.entity = 'user' AND l.subject_id IS NULL AND l.entity_id ~ '^[0-9a-f-]{36}$';

-- 3) Declined for a crew member by a coordinator -------------------------------------------------------------
ALTER TABLE shift_assignments
  ADD COLUMN IF NOT EXISTS declined_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS decline_reason text CHECK (decline_reason IS NULL OR length(decline_reason) <= 200),
  ADD COLUMN IF NOT EXISTS declined_at timestamptz;

-- 4) Pay per position on one event ----------------------------------------------------------------------------
-- Order for a shift: person's rate on this event > their standing rate > the shift's own rate > this table > role.
CREATE TABLE event_position_rates (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_id    uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  role_key    text NOT NULL,
  role_name   text NOT NULL,
  pay_type    text NOT NULL DEFAULT 'hourly' CHECK (pay_type IN ('hourly', 'day')),
  rate        numeric(10,2) NOT NULL CHECK (rate > 0 AND rate <= 100000),
  updated_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, role_key)
);
ALTER TABLE event_position_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_position_rates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON event_position_rates USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON event_position_rates TO laborops_app;

CREATE OR REPLACE FUNCTION event_position_rate(p_shift uuid)
RETURNS TABLE (pay_type text, rate numeric) LANGUAGE sql STABLE AS $$
  SELECT r.pay_type, r.rate FROM shifts s JOIN event_position_rates r ON r.event_id = s.event_id AND r.role_key = role_key(s.role_name)
   WHERE s.id = p_shift
$$;
GRANT EXECUTE ON FUNCTION event_position_rate(uuid) TO laborops_app;
GRANT EXECUTE ON FUNCTION audit_link() TO laborops_app;
