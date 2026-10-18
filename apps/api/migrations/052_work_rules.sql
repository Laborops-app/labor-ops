-- Named work-rule sets (e.g. "IATSE Local 7", "Non-union"): overtime, premiums, meal penalties, turnaround,
-- cancellation pay, punch rounding and a default minimum call. One is the company default; a customer or an event
-- can use another. The rules themselves are JSON validated by the API.
CREATE TABLE work_rule_sets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  is_default  boolean NOT NULL DEFAULT false,
  config      jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX work_rule_sets_one_default ON work_rule_sets (tenant_id) WHERE is_default;
CREATE UNIQUE INDEX work_rule_sets_name ON work_rule_sets (tenant_id, lower(name));
ALTER TABLE work_rule_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_rule_sets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work_rule_sets USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON work_rule_sets TO laborops_app;

ALTER TABLE customers ADD COLUMN rule_set_id uuid REFERENCES work_rule_sets(id) ON DELETE SET NULL;
ALTER TABLE events ADD COLUMN rule_set_id uuid REFERENCES work_rule_sets(id) ON DELETE SET NULL;

-- Pay that isn't worked time: cancellation pay (a confirmed call cut too late), or a manual adjustment.
CREATE TABLE pay_adjustments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id      uuid REFERENCES events(id) ON DELETE SET NULL,
  event_name    text,
  role_name     text,
  kind          text NOT NULL CHECK (kind IN ('cancellation', 'manual')),
  work_date     date NOT NULL,
  hours         numeric(6,2) NOT NULL DEFAULT 0,
  amount        numeric(10,2),
  note          text,
  voided_at     timestamptz,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pay_adjustments_date_idx ON pay_adjustments (tenant_id, work_date);
ALTER TABLE pay_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE pay_adjustments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON pay_adjustments USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON pay_adjustments TO laborops_app;

-- Saturday premium joins night / Sunday / holiday on the company rules.
ALTER TABLE labor_rules ADD COLUMN saturday_premium_pct numeric(6,2) NOT NULL DEFAULT 0;
ALTER TABLE pay_adjustments ADD COLUMN exported_at timestamptz;
