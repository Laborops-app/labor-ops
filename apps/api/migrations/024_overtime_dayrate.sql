-- Per-job daily overtime threshold, the state a job works in, state overtime rules, and day-rate shifts.
ALTER TABLE events ADD COLUMN ot_after numeric(4,1) CHECK (ot_after IN (8, 10, 15));
ALTER TABLE events ADD COLUMN state text CHECK (state ~ '^[A-Z]{2}$');
ALTER TABLE labor_rules ADD COLUMN default_state text CHECK (default_state ~ '^[A-Z]{2}$');
ALTER TABLE shifts ADD COLUMN pay_type text NOT NULL DEFAULT 'hourly' CHECK (pay_type IN ('hourly', 'day'));
ALTER TABLE skills ADD COLUMN day_rate numeric(10,2) NOT NULL DEFAULT 0 CHECK (day_rate >= 0);

CREATE TABLE state_ot_rules (
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  state      text NOT NULL CHECK (state ~ '^[A-Z]{2}$'),
  ot_mult    numeric(4,2) NOT NULL DEFAULT 1.5 CHECK (ot_mult >= 1 AND ot_mult <= 4),
  dt_after   numeric(4,1) CHECK (dt_after > 0 AND dt_after <= 24),
  dt_mult    numeric(4,2) NOT NULL DEFAULT 2 CHECK (dt_mult >= 1 AND dt_mult <= 4),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, state)
);
ALTER TABLE state_ot_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE state_ot_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON state_ot_rules USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON state_ot_rules TO laborops_app;
