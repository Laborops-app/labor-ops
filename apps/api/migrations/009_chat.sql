-- In-app chat: direct messages, group channels and per-event channels.
CREATE TABLE chat_channels (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('dm', 'group', 'event')),
  name             text,
  event_id         uuid REFERENCES events(id) ON DELETE CASCADE,
  dm_key           text,
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_message_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX chat_dm_unique ON chat_channels (tenant_id, dm_key) WHERE kind = 'dm';
CREATE UNIQUE INDEX chat_event_unique ON chat_channels (event_id) WHERE kind = 'event';

CREATE TABLE chat_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq         bigserial NOT NULL UNIQUE,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel_id  uuid NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  body        text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  created_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);
CREATE INDEX chat_messages_channel_idx ON chat_messages (channel_id, seq DESC);

CREATE TABLE chat_members (
  channel_id     uuid NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  last_read_seq  bigint NOT NULL DEFAULT 0,
  muted          boolean NOT NULL DEFAULT false,
  joined_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX chat_members_user_idx ON chat_members (user_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['chat_channels','chat_messages','chat_members'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO laborops_app', t);
  END LOOP;
END $$;
GRANT USAGE ON SEQUENCE chat_messages_seq_seq TO laborops_app;
