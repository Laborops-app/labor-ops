-- Per-company messaging integrations (stored encrypted), Podium conversations, browser push subscriptions.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS sms_provider text CHECK (sms_provider IN ('none', 'twilio', 'sns', 'podium'));

CREATE TABLE integration_settings (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider    text NOT NULL CHECK (provider IN ('ses', 'twilio', 'sns', 'podium')),
  config_enc  text NOT NULL,
  updated_by  uuid,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, provider)
);

-- Server-wide secrets (e.g. the browser push signing keys). Always stored encrypted.
CREATE TABLE app_secrets (
  key         text PRIMARY KEY,
  value_enc   text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON app_secrets TO laborops_app;

CREATE TABLE inbound_messages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  provider      text NOT NULL,
  provider_uid  text NOT NULL,
  channel       text NOT NULL,
  from_addr     text NOT NULL,
  contact_name  text,
  body          text NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider, provider_uid)
);
CREATE INDEX inbound_tenant_idx ON inbound_messages (tenant_id, received_at DESC);

CREATE TABLE push_subscriptions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint    text NOT NULL UNIQUE,
  p256dh      text NOT NULL,
  auth        text NOT NULL,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX push_user_idx ON push_subscriptions (user_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['integration_settings','inbound_messages','push_subscriptions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO laborops_app', t);
  END LOOP;
END $$;

ALTER TABLE deliveries DROP CONSTRAINT IF EXISTS deliveries_channel_check;
ALTER TABLE deliveries ADD CONSTRAINT deliveries_channel_check CHECK (channel IN ('email', 'sms', 'push'));

-- Look up a push subscription from the worker (cross-tenant, by delivery).
CREATE FUNCTION notify_push_sub(p_id uuid)
RETURNS TABLE (id uuid, endpoint text, p256dh text, auth text)
LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$ SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE id = p_id $$;
CREATE FUNCTION notify_push_drop(p_id uuid)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$ DELETE FROM push_subscriptions WHERE id = p_id $$;
REVOKE ALL ON FUNCTION notify_push_sub(uuid), notify_push_drop(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION notify_push_sub(uuid), notify_push_drop(uuid) TO laborops_app;
