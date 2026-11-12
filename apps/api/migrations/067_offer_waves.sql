-- Offer waves: fill a shift in rounds (best rated, then everyone qualified, then an open shift), with a time to
-- answer per round, reminders, and the next person offered when someone says no.
CREATE TABLE shift_wave_plans (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  shift_id        uuid NOT NULL UNIQUE REFERENCES shifts(id) ON DELETE CASCADE,
  config          jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'done')),
  wave            int NOT NULL DEFAULT 1,
  wave_started_at timestamptz NOT NULL DEFAULT now(),
  pool            uuid[] NOT NULL DEFAULT '{}',   -- this wave's people, best first
  started_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  finished_reason text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX shift_wave_plans_active ON shift_wave_plans (tenant_id) WHERE status = 'active';
ALTER TABLE shift_wave_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_wave_plans FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON shift_wave_plans USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON shift_wave_plans TO laborops_app;

CREATE TABLE shift_wave_offers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  plan_id     uuid NOT NULL REFERENCES shift_wave_plans(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wave        int NOT NULL,
  offered_at  timestamptz NOT NULL DEFAULT now(),
  reminded_at timestamptz,
  outcome     text CHECK (outcome IN ('accepted', 'declined', 'expired', 'removed', 'skipped')),
  note        text,
  UNIQUE (plan_id, user_id)
);
ALTER TABLE shift_wave_offers ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_wave_offers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON shift_wave_offers USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON shift_wave_offers TO laborops_app;

-- The company's usual wave settings, used to pre-fill the window.
ALTER TABLE staffing_settings ADD COLUMN wave_defaults jsonb;
