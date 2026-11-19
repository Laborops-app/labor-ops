-- Full-time staff: kept apart from crew (no offers, waves or crew lists), with their own time clock.
ALTER TABLE users ADD COLUMN IF NOT EXISTS employment text NOT NULL DEFAULT 'crew' CHECK (employment IN ('crew', 'fulltime'));
CREATE INDEX IF NOT EXISTS users_employment_idx ON users (tenant_id, employment) WHERE employment = 'fulltime';

-- One punch = one stretch on the clock. Location is kept only when the phone shares it.
CREATE TABLE staff_punches (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  clock_in     timestamptz NOT NULL DEFAULT now(),
  clock_out    timestamptz,
  in_lat       double precision, in_lng double precision, in_acc real,
  out_lat      double precision, out_lng double precision, out_acc real,
  note         text CHECK (note IS NULL OR length(note) <= 500),
  source       text NOT NULL DEFAULT 'app' CHECK (source IN ('app', 'office')),
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'approved')),
  approved_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at  timestamptz,
  edited_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  edited_at    timestamptz,
  exported_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (clock_out IS NULL OR clock_out >= clock_in)
);
CREATE UNIQUE INDEX staff_one_open_punch ON staff_punches (user_id) WHERE clock_out IS NULL;
CREATE INDEX staff_punches_idx ON staff_punches (tenant_id, user_id, clock_in DESC);
ALTER TABLE staff_punches ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_punches FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON staff_punches USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON staff_punches TO laborops_app;

CREATE TABLE staff_breaks (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  punch_id   uuid NOT NULL REFERENCES staff_punches(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  starts_at  timestamptz NOT NULL DEFAULT now(),
  ends_at    timestamptz,
  CHECK (ends_at IS NULL OR ends_at >= starts_at)
);
CREATE UNIQUE INDEX staff_one_open_break ON staff_breaks (punch_id) WHERE ends_at IS NULL;
ALTER TABLE staff_breaks ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_breaks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON staff_breaks USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON staff_breaks TO laborops_app;

-- The change log links staff punches to the person.
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
    ELSIF NEW.entity = 'staff_punch' THEN SELECT p.user_id INTO f_who FROM staff_punches p WHERE p.id = eid;
    ELSIF NEW.entity = 'user' THEN f_who := eid;
    END IF;
  END IF;
  NEW.event_id := COALESCE(NEW.event_id, f_ev, d_ev);
  NEW.subject_id := COALESCE(NEW.subject_id, f_who, d_who);
  RETURN NEW;
END $$;
