-- Open shifts + claims + swaps, crew availability & certifications, shift templates.

ALTER TABLE tenants ADD COLUMN timezone text NOT NULL DEFAULT 'America/Denver';

-- 'pending' = a crew member claimed an open shift and a manager has not approved it yet (it still holds a slot).
ALTER TABLE shift_assignments DROP CONSTRAINT shift_assignments_status_check;
ALTER TABLE shift_assignments ADD CONSTRAINT shift_assignments_status_check
  CHECK (status IN ('offered', 'accepted', 'declined', 'pending'));

ALTER TABLE shifts
  ADD COLUMN is_open boolean NOT NULL DEFAULT false,
  ADD COLUMN required_certs text[] NOT NULL DEFAULT '{}';

CREATE TABLE user_certs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        text NOT NULL,
  expires_on  date,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX user_certs_unique ON user_certs (user_id, lower(name));

-- One weekly window per weekday (0 = Sunday). A user with no rows is treated as always available.
CREATE TABLE availability (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  weekday     smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time  time NOT NULL,
  end_time    time NOT NULL,
  UNIQUE (user_id, weekday),
  CHECK (end_time > start_time)
);

CREATE TABLE time_off (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  starts_on   date NOT NULL,
  ends_on     date NOT NULL,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on >= starts_on)
);
CREATE INDEX time_off_user_idx ON time_off (user_id, starts_on);

CREATE TABLE shift_swaps (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  assignment_id  uuid NOT NULL REFERENCES shift_assignments(id) ON DELETE CASCADE,
  offered_by     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  taken_by       uuid REFERENCES users(id) ON DELETE CASCADE,
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'pending', 'approved', 'rejected', 'cancelled')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  resolved_at    timestamptz
);
CREATE UNIQUE INDEX one_active_swap_per_assignment ON shift_swaps (assignment_id) WHERE status IN ('open', 'pending');
CREATE INDEX shift_swaps_tenant_idx ON shift_swaps (tenant_id, status);

CREATE TABLE shift_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  items       jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['user_certs','availability','time_off','shift_swaps','shift_templates'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO laborops_app', t);
  END LOOP;
END $$;
