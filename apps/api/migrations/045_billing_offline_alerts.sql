-- ===== Billing (Stripe) =====
-- The company's subscription. Only the API's owner connection writes these (from Stripe webhooks and checkout).
ALTER TABLE tenants
  ADD COLUMN stripe_customer_id     text,
  ADD COLUMN stripe_subscription_id text,
  ADD COLUMN billing_status         text,         -- trialing / active / past_due / canceled / unpaid (as Stripe reports it)
  ADD COLUMN billing_period_end     timestamptz,
  ADD COLUMN trial_ends_at          timestamptz,
  ADD COLUMN sms_credits            integer NOT NULL DEFAULT 0 CHECK (sms_credits >= 0);

-- Companies that exist before billing are kept free of limits (set their plan on the Platform page when ready).
UPDATE tenants SET plan = 'internal' WHERE plan = 'trial';

-- Stripe events already handled (webhooks can arrive more than once).
CREATE TABLE billing_events (
  id          text PRIMARY KEY,
  type        text NOT NULL,
  tenant_id   uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON billing_events FROM laborops_app;

-- ===== Offline clock-in =====
-- A punch made without signal is sent later with the phone's own time and a random id, so sending it twice is harmless.
ALTER TABLE time_entries
  ADD COLUMN client_in_id   uuid,
  ADD COLUMN client_out_id  uuid,
  ADD COLUMN in_accuracy_m  integer,
  ADD COLUMN out_accuracy_m integer,
  ADD COLUMN offline_in     boolean NOT NULL DEFAULT false,
  ADD COLUMN offline_out    boolean NOT NULL DEFAULT false,
  -- Never clocked out: closed automatically at the shift end and left for a manager to check.
  ADD COLUMN auto_clocked_out boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX time_entries_client_in_idx ON time_entries (tenant_id, client_in_id) WHERE client_in_id IS NOT NULL;
CREATE UNIQUE INDEX time_entries_client_out_idx ON time_entries (tenant_id, client_out_id) WHERE client_out_id IS NOT NULL;

-- ===== Notifications: acknowledgements and text escalation =====
ALTER TABLE notifications ADD COLUMN acked_at timestamptz;
-- A text that only goes out if the push was not opened in time.
ALTER TABLE deliveries ADD COLUMN escalation boolean NOT NULL DEFAULT false;

-- Claim also skips escalation texts whose notification was opened in the meantime.
CREATE OR REPLACE FUNCTION notify_skip_acked()
RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$
  WITH x AS (
    UPDATE deliveries d SET status = 'skipped', last_error = 'opened on the phone, no text needed'
      FROM notifications n
     WHERE d.escalation AND d.status = 'queued' AND n.id = d.notification_id AND (n.acked_at IS NOT NULL OR n.read_at IS NOT NULL)
    RETURNING 1)
  SELECT count(*)::integer FROM x
$$;
REVOKE ALL ON FUNCTION notify_skip_acked() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION notify_skip_acked() TO laborops_app;

-- ===== Sign-in links and passkeys =====
ALTER TABLE auth_tokens DROP CONSTRAINT IF EXISTS auth_tokens_kind_check;
ALTER TABLE auth_tokens ADD CONSTRAINT auth_tokens_kind_check CHECK (kind IN ('reset', 'invite', 'magic'));

-- Use a sign-in link: one time, not expired, active account.
CREATE FUNCTION auth_use_magic(p_hash text)
RETURNS TABLE (user_id uuid, tenant_id uuid, role text, name text)
LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$
  WITH t AS (
    UPDATE auth_tokens SET used_at = now()
    WHERE token_hash = p_hash AND kind = 'magic' AND used_at IS NULL AND expires_at > now()
    RETURNING auth_tokens.user_id, auth_tokens.tenant_id
  )
  SELECT u.id, u.tenant_id, u.role, u.name FROM t JOIN users u ON u.id = t.user_id WHERE u.active
$$;

CREATE TABLE passkeys (
  id            text PRIMARY KEY,                -- credential id (base64url)
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key    bytea NOT NULL,
  counter       bigint NOT NULL DEFAULT 0,
  transports    text[] NOT NULL DEFAULT '{}',
  name          text NOT NULL DEFAULT 'Passkey',
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz
);
CREATE INDEX passkeys_user_idx ON passkeys (user_id);
ALTER TABLE passkeys ENABLE ROW LEVEL SECURITY;
ALTER TABLE passkeys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON passkeys USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON passkeys TO laborops_app;

-- Sign-in with a passkey happens before we know the company, so the lookup goes through this function.
CREATE FUNCTION auth_find_passkey(p_id text)
RETURNS TABLE (id text, tenant_id uuid, user_id uuid, public_key bytea, counter bigint, transports text[], role text, name text, active boolean)
LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$ SELECT p.id, p.tenant_id, p.user_id, p.public_key, p.counter, p.transports, u.role, u.name, u.active
        FROM passkeys p JOIN users u ON u.id = p.user_id WHERE p.id = p_id $$;
CREATE FUNCTION auth_passkey_used(p_id text, p_counter bigint)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$ UPDATE passkeys SET counter = GREATEST(counter, p_counter), last_used_at = now() WHERE id = p_id $$;
REVOKE ALL ON FUNCTION auth_use_magic(text), auth_find_passkey(text), auth_passkey_used(text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_use_magic(text), auth_find_passkey(text), auth_passkey_used(text, bigint) TO laborops_app;

-- ===== Reports =====
ALTER TABLE events ADD COLUMN labor_budget numeric(12,2) CHECK (labor_budget IS NULL OR labor_budget >= 0);

-- ===== Late / no-show alerts and forgotten clock-outs =====
ALTER TABLE labor_rules
  ADD COLUMN late_alert_min    integer NOT NULL DEFAULT 10 CHECK (late_alert_min BETWEEN 0 AND 240),   -- 0 = off
  ADD COLUMN no_show_min       integer NOT NULL DEFAULT 60 CHECK (no_show_min BETWEEN 0 AND 720),      -- 0 = off
  ADD COLUMN auto_clockout_h   numeric(4,1) NOT NULL DEFAULT 3 CHECK (auto_clockout_h BETWEEN 0 AND 24); -- 0 = off
ALTER TABLE shift_assignments ADD COLUMN no_show_at timestamptz;

-- Clocking in (or being checked in / having time added) clears a no-show flag.
CREATE FUNCTION clear_no_show() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE shift_assignments SET no_show_at = NULL WHERE id = NEW.assignment_id AND no_show_at IS NOT NULL;
  RETURN NEW;
END $$;
CREATE TRIGGER time_entries_clear_no_show AFTER INSERT ON time_entries FOR EACH ROW EXECUTE FUNCTION clear_no_show();
