-- Company labor rules: rest between shifts, daily / weekly limits, overtime and premium pay.
CREATE TABLE labor_rules (
  tenant_id           uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  min_rest_hours      numeric(5,2) NOT NULL DEFAULT 8  CHECK (min_rest_hours >= 0),
  max_daily_hours     numeric(5,2) NOT NULL DEFAULT 14 CHECK (max_daily_hours >= 0),
  daily_ot_after      numeric(5,2) NOT NULL DEFAULT 0  CHECK (daily_ot_after >= 0),
  weekly_ot_after     numeric(5,2) NOT NULL DEFAULT 40 CHECK (weekly_ot_after >= 0),
  ot_multiplier       numeric(4,2) NOT NULL DEFAULT 1.5 CHECK (ot_multiplier >= 1),
  night_start         time NOT NULL DEFAULT '22:00',
  night_end           time NOT NULL DEFAULT '06:00',
  night_premium_pct   numeric(5,2) NOT NULL DEFAULT 0 CHECK (night_premium_pct >= 0),
  sunday_premium_pct  numeric(5,2) NOT NULL DEFAULT 0 CHECK (sunday_premium_pct >= 0),
  holiday_premium_pct numeric(5,2) NOT NULL DEFAULT 0 CHECK (holiday_premium_pct >= 0),
  holidays            date[] NOT NULL DEFAULT '{}',
  updated_at          timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE labor_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE labor_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON labor_rules USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON labor_rules TO laborops_app;
