-- Chat: pinned conversations, typing indicator, online presence and file / image attachments.
ALTER TABLE chat_members ADD COLUMN IF NOT EXISTS pinned_at timestamptz;
ALTER TABLE chat_members ADD COLUMN IF NOT EXISTS typing_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;

-- A message may be only an attachment, so an empty body is allowed (still capped at 4000 characters).
ALTER TABLE chat_messages DROP CONSTRAINT IF EXISTS chat_messages_body_check;
ALTER TABLE chat_messages ADD CONSTRAINT chat_messages_body_check CHECK (length(body) <= 4000);

CREATE TABLE chat_attachments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel_id    uuid NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
  message_id    uuid NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  user_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  filename      text NOT NULL,
  content_type  text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('image', 'file')),
  size          int NOT NULL CHECK (size > 0),
  data          bytea NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_attachments_channel_idx ON chat_attachments (channel_id, created_at DESC);
CREATE INDEX chat_attachments_message_idx ON chat_attachments (message_id);
ALTER TABLE chat_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_attachments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON chat_attachments USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON chat_attachments TO laborops_app;
