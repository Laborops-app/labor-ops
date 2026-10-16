-- Named groups of shifts inside a phase (Load In → Stage hands, Loaders, Pushers ...). A group belongs to one phase;
-- its shifts can be any position.
CREATE TABLE phase_groups (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_id    uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  phase_id    uuid NOT NULL REFERENCES event_phases(id) ON DELETE CASCADE,
  label       text NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  sort        int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX phase_groups_phase_idx ON phase_groups (phase_id, sort, created_at);
CREATE INDEX phase_groups_event_idx ON phase_groups (event_id);
ALTER TABLE phase_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE phase_groups FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON phase_groups USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON phase_groups TO laborops_app;

ALTER TABLE shifts ADD COLUMN group_id uuid REFERENCES phase_groups(id) ON DELETE SET NULL;
CREATE INDEX shifts_group_idx ON shifts (group_id);

-- A shift's group always sits in the shift's phase. When a shift moves to another phase (edited, or a multi-day phase
-- split into days), it joins the group with the same name there, which is created if needed; with no phase, no group.
CREATE OR REPLACE FUNCTION shifts_group_follows_phase() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE g record; ng uuid;
BEGIN
  IF NEW.group_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.phase_id IS NULL THEN NEW.group_id := NULL; RETURN NEW; END IF;
  SELECT phase_id, label, sort, event_id INTO g FROM phase_groups WHERE id = NEW.group_id;
  IF NOT FOUND OR g.event_id <> NEW.event_id THEN NEW.group_id := NULL; RETURN NEW; END IF;
  IF g.phase_id = NEW.phase_id THEN RETURN NEW; END IF;
  SELECT id INTO ng FROM phase_groups WHERE phase_id = NEW.phase_id AND lower(label) = lower(g.label) ORDER BY created_at LIMIT 1;
  IF ng IS NULL THEN
    INSERT INTO phase_groups (tenant_id, event_id, phase_id, label, sort) VALUES (NEW.tenant_id, NEW.event_id, NEW.phase_id, g.label, g.sort) RETURNING id INTO ng;
  END IF;
  NEW.group_id := ng;
  RETURN NEW;
END $$;
CREATE TRIGGER shifts_group_follows_phase BEFORE INSERT OR UPDATE OF phase_id, group_id ON shifts
  FOR EACH ROW EXECUTE FUNCTION shifts_group_follows_phase();
