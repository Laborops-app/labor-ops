-- Crew reviews: one coordinator rating of one person in one position, optionally tied to the shift they worked.
-- crew_ratings keeps the per-position summary (rounded stars for ranking, plus the exact average and review count).
CREATE TABLE crew_reviews (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_key    text NOT NULL CHECK (length(role_key) BETWEEN 1 AND 100),
  stars       smallint NOT NULL CHECK (stars BETWEEN 1 AND 5),
  tags        text[] NOT NULL DEFAULT '{}',
  note        text CHECK (note IS NULL OR length(note) <= 1000),
  shift_id    uuid REFERENCES shifts(id) ON DELETE SET NULL,
  event_id    uuid REFERENCES events(id) ON DELETE SET NULL,
  rated_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX crew_reviews_shift_uq ON crew_reviews (user_id, shift_id) WHERE shift_id IS NOT NULL;
CREATE INDEX crew_reviews_user_idx ON crew_reviews (tenant_id, user_id, role_key);
CREATE INDEX crew_reviews_event_idx ON crew_reviews (event_id) WHERE event_id IS NOT NULL;
ALTER TABLE crew_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE crew_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON crew_reviews USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON crew_reviews TO laborops_app;

ALTER TABLE crew_ratings ADD COLUMN avg_stars numeric(3,2), ADD COLUMN reviews int NOT NULL DEFAULT 0;

-- Keep every existing star rating as a general review, so nothing is lost.
INSERT INTO crew_reviews (tenant_id, user_id, role_key, stars, rated_by, created_at, updated_at)
  SELECT tenant_id, user_id, role_key, stars, rated_by, updated_at, updated_at FROM crew_ratings;
UPDATE crew_ratings SET avg_stars = stars, reviews = 1;
