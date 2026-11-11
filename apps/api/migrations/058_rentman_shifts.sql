-- Days, groups and shifts built from a Rentman project's crew and transport functions.

-- Which Rentman function (and day of it) a shift came from, and the values last taken from Rentman,
-- so a later change in Rentman is applied only to a shift nobody has changed or staffed since.
ALTER TABLE shifts ADD COLUMN rentman_key text, ADD COLUMN rentman_hash text;
CREATE UNIQUE INDEX shifts_rentman_key ON shifts (event_id, rentman_key) WHERE rentman_key IS NOT NULL;

-- Keep this event's days and shifts in step with Rentman (set by the first build; new pipeline events start with it on),
-- and the conflicts a coordinator was last told about.
ALTER TABLE events ADD COLUMN rentman_build boolean NOT NULL DEFAULT false, ADD COLUMN rentman_build_seen text;

-- Build days and shifts for events that come in from Rentman.
ALTER TABLE rentman_settings ADD COLUMN build_shifts boolean NOT NULL DEFAULT true;

-- Rentman function names that don't match a LaborOps role by name, mapped once to the role to use.
CREATE TABLE rentman_role_map (
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  rentman_name text NOT NULL,          -- lower-cased, trimmed
  role_name    text,                   -- null = seen but not mapped yet (keeps Rentman's name)
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, rentman_name)
);
ALTER TABLE rentman_role_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE rentman_role_map FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON rentman_role_map USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON rentman_role_map TO laborops_app;
