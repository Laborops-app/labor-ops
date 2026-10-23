-- Faster event set-up and staffing.

-- Event templates: a whole event (phases, named groups, positions) saved to start new events from.
CREATE TABLE event_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  customer_id uuid REFERENCES customers(id) ON DELETE CASCADE,
  data        jsonb NOT NULL,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX event_templates_tenant_idx ON event_templates (tenant_id, lower(name));

-- Defaults a position starts with when it is added (people needed, start and end time).
ALTER TABLE skills ADD COLUMN default_headcount int CHECK (default_headcount BETWEEN 1 AND 500),
                   ADD COLUMN default_start time,
                   ADD COLUMN default_end time;

-- Build quietly: crew picked while this is on are kept as a plan and nobody is told until the event is published.
ALTER TABLE events ADD COLUMN staffing_draft boolean NOT NULL DEFAULT false;
CREATE TABLE planned_picks (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_id   uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  shift_id   uuid NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  confirmed  boolean NOT NULL DEFAULT false,
  is_lead    boolean,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shift_id, user_id)
);
CREATE INDEX planned_picks_event_idx ON planned_picks (event_id);
CREATE INDEX planned_picks_user_idx ON planned_picks (user_id);

-- When an offer was last nudged (a reminder to answer).
ALTER TABLE shift_assignments ADD COLUMN nudged_at timestamptz;

-- "Are you free?" before booking: the days asked about, and each person's answer.
CREATE TABLE avail_checks (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_id   uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  dates      date[] NOT NULL CHECK (cardinality(dates) BETWEEN 1 AND 62),
  message    text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at  timestamptz
);
CREATE INDEX avail_checks_event_idx ON avail_checks (event_id);
CREATE TABLE avail_answers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  check_id    uuid NOT NULL REFERENCES avail_checks(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  free_dates  date[],
  answered_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (check_id, user_id)
);
CREATE INDEX avail_answers_user_idx ON avail_answers (user_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['event_templates', 'planned_picks', 'avail_checks', 'avail_answers'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO laborops_app', t);
  END LOOP;
END $$;
