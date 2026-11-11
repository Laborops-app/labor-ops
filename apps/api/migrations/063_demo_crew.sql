-- Sample crew added for trying the app out (Crew › Demo crew), so they can be removed in one go.
ALTER TABLE users ADD COLUMN is_demo boolean NOT NULL DEFAULT false;
CREATE INDEX users_demo_idx ON users (tenant_id) WHERE is_demo;
