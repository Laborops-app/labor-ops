-- Uploaded files can live in S3-compatible storage (RustFS). The row then keeps the object key instead of the bytes.
ALTER TABLE cert_files ALTER COLUMN data DROP NOT NULL, ADD COLUMN storage_key text;
ALTER TABLE cert_files ADD CONSTRAINT cert_files_has_content CHECK (data IS NOT NULL OR storage_key IS NOT NULL);
ALTER TABLE chat_attachments ALTER COLUMN data DROP NOT NULL, ADD COLUMN storage_key text;
ALTER TABLE chat_attachments ADD CONSTRAINT chat_attachments_has_content CHECK (data IS NOT NULL OR storage_key IS NOT NULL);
CREATE INDEX cert_files_unmoved_idx ON cert_files (uploaded_at) WHERE storage_key IS NULL;
CREATE INDEX chat_attachments_unmoved_idx ON chat_attachments (created_at) WHERE storage_key IS NULL;

-- Whole-database backups (platform level, not per company).
CREATE TABLE platform_backups (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket      text NOT NULL,
  key         text,
  size        bigint,
  kind        text NOT NULL DEFAULT 'scheduled' CHECK (kind IN ('scheduled', 'manual')),
  status      text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed', 'deleted')),
  error       text,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX platform_backups_started_idx ON platform_backups (started_at DESC);
REVOKE ALL ON platform_backups FROM laborops_app;
