-- LaborOps initial schema: multi-tenant (shared schema + tenant_id + Row-Level Security)
-- Run as the database owner/superuser. The API connects as laborops_app, which has NO bypass.

DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'laborops_app') THEN
    CREATE ROLE laborops_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;

CREATE FUNCTION app_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE TABLE tenants (
  id          uuid PRIMARY KEY,
  name        text NOT NULL,
  slug        text NOT NULL UNIQUE,
  plan        text NOT NULL DEFAULT 'trial',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email          text NOT NULL,
  name           text NOT NULL,
  role           text NOT NULL CHECK (role IN ('admin', 'manager', 'crew')),
  password_hash  text NOT NULL,
  phone          text,
  skills         text[] NOT NULL DEFAULT '{}',
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_unique ON users (lower(email));
CREATE INDEX users_tenant_idx ON users (tenant_id, role);

CREATE TABLE events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  venue       text,
  start_date  date NOT NULL,
  end_date    date NOT NULL,
  notes       text,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date)
);
CREATE INDEX events_tenant_idx ON events (tenant_id, start_date);

CREATE TABLE shifts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_id    uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  role_name   text NOT NULL,
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL,
  headcount   integer NOT NULL DEFAULT 1 CHECK (headcount BETWEEN 1 AND 500),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX shifts_tenant_idx ON shifts (tenant_id, starts_at);
CREATE INDEX shifts_event_idx ON shifts (event_id);

CREATE TABLE shift_assignments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  shift_id    uuid NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status      text NOT NULL DEFAULT 'offered' CHECK (status IN ('offered', 'accepted', 'declined')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shift_id, user_id)
);
CREATE INDEX assignments_user_idx ON shift_assignments (tenant_id, user_id);

CREATE TABLE time_entries (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  assignment_id  uuid NOT NULL REFERENCES shift_assignments(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  clock_in       timestamptz NOT NULL DEFAULT now(),
  clock_out      timestamptz,
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'submitted', 'approved')),
  approved_by    uuid REFERENCES users(id),
  approved_at    timestamptz,
  CHECK (clock_out IS NULL OR clock_out >= clock_in)
);
CREATE UNIQUE INDEX one_open_entry_per_user ON time_entries (user_id) WHERE clock_out IS NULL;
CREATE INDEX time_entries_tenant_idx ON time_entries (tenant_id, status, clock_in);

CREATE TABLE audit_logs (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_id    uuid,
  action      text NOT NULL,
  entity      text NOT NULL,
  entity_id   text,
  detail      jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_tenant_idx ON audit_logs (tenant_id, created_at DESC);

-- Row-Level Security: every tenant-owned table, forced even for the table owner.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['users','events','shifts','shift_assignments','time_entries','audit_logs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
  END LOOP;
END $$;

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_select ON tenants FOR SELECT USING (id = app_tenant_id());
CREATE POLICY tenant_update ON tenants FOR UPDATE USING (id = app_tenant_id()) WITH CHECK (id = app_tenant_id());
-- A new tenant row is created by signup before the session has a tenant context for it.
CREATE POLICY tenant_insert ON tenants FOR INSERT WITH CHECK (id = app_tenant_id());

-- Login must find a user by email before the tenant is known. This one function bypasses RLS
-- (SECURITY DEFINER, owned by the migration user) and exposes only what login needs.
CREATE FUNCTION auth_find_user(p_email text)
RETURNS TABLE (id uuid, tenant_id uuid, email text, name text, role text, password_hash text, active boolean)
LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$ SELECT id, tenant_id, email, name, role, password_hash, active FROM users WHERE lower(email) = lower(p_email) $$;
REVOKE ALL ON FUNCTION auth_find_user(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_find_user(text) TO laborops_app;

GRANT USAGE ON SCHEMA public TO laborops_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON tenants, users, events, shifts, shift_assignments, time_entries TO laborops_app;
-- Audit log is append-only for the application.
GRANT SELECT, INSERT ON audit_logs TO laborops_app;
GRANT USAGE ON SEQUENCE audit_logs_id_seq TO laborops_app;
