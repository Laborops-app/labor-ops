-- Notifications: in-app inbox, email/SMS delivery queue (outbox), per-user preferences, reset/invite tokens.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS notify_email   boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS notify_sms     boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS sms_consent_at timestamptz;

CREATE TABLE notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category    text NOT NULL,
  title       text NOT NULL,
  body        text NOT NULL,
  link        text,
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);

CREATE TABLE deliveries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id          uuid REFERENCES users(id) ON DELETE SET NULL,
  notification_id  uuid REFERENCES notifications(id) ON DELETE SET NULL,
  channel          text NOT NULL CHECK (channel IN ('email', 'sms')),
  category         text NOT NULL DEFAULT 'general',
  to_addr          text NOT NULL,
  subject          text,
  body             text NOT NULL,
  html             text,
  status           text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'skipped')),
  attempts         integer NOT NULL DEFAULT 0,
  last_error       text,
  provider_id      text,
  send_after       timestamptz NOT NULL DEFAULT now(),
  claimed_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  sent_at          timestamptz
);
CREATE INDEX deliveries_queue_idx ON deliveries (status, send_after) WHERE status IN ('queued', 'sending');
CREATE INDEX deliveries_tenant_idx ON deliveries (tenant_id, created_at DESC);

-- De-duplication for sweeps (24h reminders, certificate expiry notices).
CREATE TABLE notify_marks (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key         text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);

-- Single-use tokens for password reset and invitations. Only a SHA-256 hash of the token is stored.
CREATE TABLE auth_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('reset', 'invite')),
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['notifications','deliveries','notify_marks','auth_tokens'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO laborops_app', t);
  END LOOP;
END $$;

-- Cross-tenant helpers (SECURITY DEFINER, owned by the migration user). Each exposes only what it needs.

-- The delivery worker claims queued messages across all tenants. Messages stuck in 'sending' for 5 minutes are retried.
CREATE FUNCTION notify_claim(p_limit integer)
RETURNS SETOF deliveries
LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$
  UPDATE deliveries d SET status = 'sending', attempts = d.attempts + 1, claimed_at = now()
  WHERE d.id IN (
    SELECT id FROM deliveries
    WHERE (status = 'queued' AND send_after <= now()) OR (status = 'sending' AND claimed_at < now() - interval '5 minutes')
    ORDER BY send_after
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED)
  RETURNING d.*
$$;

CREATE FUNCTION notify_finish(p_id uuid, p_status text, p_error text, p_provider_id text, p_retry_in_seconds integer)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$
  UPDATE deliveries SET
    status = p_status,
    last_error = p_error,
    provider_id = COALESCE(p_provider_id, provider_id),
    sent_at = CASE WHEN p_status = 'sent' THEN now() ELSE sent_at END,
    send_after = CASE WHEN p_status = 'queued' THEN now() + make_interval(secs => p_retry_in_seconds) ELSE send_after END
  WHERE id = p_id
$$;

CREATE FUNCTION notify_tenants()
RETURNS TABLE (id uuid, timezone text)
LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$ SELECT id, timezone FROM tenants $$;

-- Consume a reset/invite token and set the new password in one step.
CREATE FUNCTION auth_use_token(p_hash text, p_kind text, p_password_hash text)
RETURNS TABLE (user_id uuid, tenant_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$
  WITH t AS (
    UPDATE auth_tokens SET used_at = now()
    WHERE token_hash = p_hash AND kind = p_kind AND used_at IS NULL AND expires_at > now()
    RETURNING auth_tokens.user_id, auth_tokens.tenant_id
  ), u AS (
    UPDATE users SET password_hash = p_password_hash
    WHERE id IN (SELECT t.user_id FROM t) AND active
    RETURNING id
  )
  SELECT t.user_id, t.tenant_id FROM t WHERE EXISTS (SELECT 1 FROM u)
$$;

-- Twilio STOP keyword: switch SMS off for every account using that phone number (last 10 digits).
CREATE FUNCTION notify_sms_stop(p_digits text)
RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$
  WITH x AS (
    UPDATE users SET notify_sms = false
    WHERE notify_sms AND right(regexp_replace(coalesce(phone, ''), '\D', '', 'g'), 10) = p_digits
    RETURNING 1)
  SELECT count(*)::integer FROM x
$$;

REVOKE ALL ON FUNCTION notify_claim(integer), notify_finish(uuid, text, text, text, integer), notify_tenants(),
  auth_use_token(text, text, text), notify_sms_stop(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION notify_claim(integer), notify_finish(uuid, text, text, text, integer), notify_tenants(),
  auth_use_token(text, text, text), notify_sms_stop(text) TO laborops_app;
