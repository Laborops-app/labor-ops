-- Platform-level settings (object storage, backups), saved encrypted. Only the database owner reads them.
CREATE TABLE platform_settings (
  key         text PRIMARY KEY,
  value_enc   text NOT NULL,
  updated_by  uuid,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON platform_settings FROM laborops_app;

-- People who run the platform. Bootstrapped from PLATFORM_ADMINS; after that managed on the Platform page.
CREATE TABLE platform_admins (
  user_id     uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  added_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON platform_admins FROM laborops_app;

-- A company can be suspended from the Platform page (its people cannot use the app until it is lifted).
ALTER TABLE tenants ADD COLUMN suspended_at timestamptz, ADD COLUMN suspended_reason text;
