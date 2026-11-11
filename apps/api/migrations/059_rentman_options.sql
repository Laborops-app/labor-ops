-- Optional Rentman features, each switched on under Integrations › Rentman.

ALTER TABLE rentman_settings
  ADD COLUMN webhooks          boolean NOT NULL DEFAULT false, -- Rentman tells us about changes the moment they happen
  ADD COLUMN webhook_key       text UNIQUE,                    -- random part of this company's webhook address
  ADD COLUMN webhook_token_enc text,                           -- Rentman's signing token, encrypted
  ADD COLUMN webhook_last_at   timestamptz,
  ADD COLUMN crew_link         boolean NOT NULL DEFAULT false, -- match Rentman crew to LaborOps crew
  ADD COLUMN rates_source      boolean NOT NULL DEFAULT false, -- Rentman sets the roles' pay and bill rates
  ADD COLUMN quoted_bill_rates boolean NOT NULL DEFAULT false, -- shifts built from Rentman bill at the quoted rate
  ADD COLUMN push_hours        boolean NOT NULL DEFAULT false, -- approved hours become Rentman time registrations
  ADD COLUMN push_time_off     boolean NOT NULL DEFAULT false, -- LaborOps time off shows in Rentman's planner
  ADD COLUMN show_invoices     boolean NOT NULL DEFAULT false,
  ADD COLUMN show_files        boolean NOT NULL DEFAULT false,
  ADD COLUMN files_folder      text,                           -- only files in this Rentman folder (blank = all)
  ADD COLUMN show_contacts     boolean NOT NULL DEFAULT false,
  ADD COLUMN show_vehicles     boolean NOT NULL DEFAULT false,
  ADD COLUMN show_equipment_leads boolean NOT NULL DEFAULT false,
  ADD COLUMN rates_last_at     timestamptz,
  ADD COLUMN rates_last_result jsonb;

-- Rentman's crew list and the LaborOps person each one is.
CREATE TABLE rentman_crew (
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id         int NOT NULL,
  name       text NOT NULL,
  email      text,
  phone      text,
  active     boolean NOT NULL DEFAULT true,
  user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  linked_by  text CHECK (linked_by IN ('email', 'phone', 'name', 'manual')),
  synced_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE UNIQUE INDEX rentman_crew_user ON rentman_crew (tenant_id, user_id) WHERE user_id IS NOT NULL;

-- Approved time sent to Rentman, so an edit updates the same registration.
CREATE TABLE rentman_time_regs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entry_id    uuid UNIQUE REFERENCES time_entries(id) ON DELETE SET NULL,
  rentman_id  int,
  activity_id int,
  hash        text,
  sent_at     timestamptz,
  error       text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Time off sent to Rentman.
CREATE TABLE rentman_leave (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  time_off_id uuid UNIQUE REFERENCES time_off(id) ON DELETE SET NULL,
  rentman_id  int,
  hash        text,
  sent_at     timestamptz,
  error       text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Roles whose rates come from Rentman (locked here while that option is on).
ALTER TABLE skills ADD COLUMN rentman_price_rate text, ADD COLUMN rentman_cost_rate text, ADD COLUMN rates_from_rentman boolean NOT NULL DEFAULT false;
-- A shift's own billing rate (the rate quoted in Rentman), over the role's.
ALTER TABLE shifts ADD COLUMN bill_rate_override numeric(10,2) CHECK (bill_rate_override IS NULL OR bill_rate_override >= 0);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['rentman_crew', 'rentman_time_regs', 'rentman_leave'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO laborops_app', t);
  END LOOP;
END $$;

-- The webhook arrives without a login: find the company by the random key in its address (exposes nothing else).
CREATE FUNCTION rentman_webhook_tenant(p_key text)
RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$ SELECT tenant_id FROM rentman_settings WHERE webhook_key = p_key AND webhooks AND length(p_key) >= 24 $$;
REVOKE ALL ON FUNCTION rentman_webhook_tenant(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rentman_webhook_tenant(text) TO laborops_app;
