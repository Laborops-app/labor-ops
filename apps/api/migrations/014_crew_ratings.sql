-- Coordinator star ratings (1-5) per crew member and position (role name).
CREATE TABLE crew_ratings (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_key    text NOT NULL,
  stars       smallint NOT NULL CHECK (stars BETWEEN 1 AND 5),
  rated_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_key)
);
CREATE INDEX crew_ratings_tenant_idx ON crew_ratings (tenant_id);
ALTER TABLE crew_ratings ENABLE ROW LEVEL SECURITY;
ALTER TABLE crew_ratings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON crew_ratings USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON crew_ratings TO laborops_app;
