-- Documents to sign and forms to fill in. Two uses share the same tables:
--   onboarding: a packet new crew complete once (uploaded PDFs with sign-here fields, or forms built in the app)
--   shift:      checklists and forms tied to shifts (a load-in safety check, an incident report)
-- Every completed one is kept as a signed PDF.
CREATE TABLE doc_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('pdf', 'form')),
  purpose     text NOT NULL CHECK (purpose IN ('onboarding', 'shift')),
  data        bytea,               -- the uploaded PDF
  file_name   text,
  size        int,
  page_count  int,
  fields      jsonb NOT NULL DEFAULT '[]',   -- pdf: fields placed on pages; form: the questions
  settings    jsonb NOT NULL DEFAULT '{}',
  sort        int NOT NULL DEFAULT 0,
  active      boolean NOT NULL DEFAULT true,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX doc_templates_tenant ON doc_templates (tenant_id, purpose, sort);
ALTER TABLE doc_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE doc_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON doc_templates USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON doc_templates TO laborops_app;

CREATE TABLE doc_submissions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  template_id   uuid REFERENCES doc_templates(id) ON DELETE SET NULL,
  template_name text NOT NULL,
  purpose       text NOT NULL,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,   -- who filled it in and signed
  shift_id      uuid REFERENCES shifts(id) ON DELETE SET NULL,
  event_id      uuid REFERENCES events(id) ON DELETE SET NULL,
  answers       jsonb NOT NULL DEFAULT '{}',
  flagged       boolean NOT NULL DEFAULT false,   -- a "No" answer that should be looked at
  signed_name   text,
  signed_at     timestamptz NOT NULL DEFAULT now(),
  ip            text,
  user_agent    text,
  data          bytea,              -- the finished PDF
  size          int
);
CREATE INDEX doc_submissions_user ON doc_submissions (tenant_id, user_id, signed_at DESC);
CREATE INDEX doc_submissions_event ON doc_submissions (event_id) WHERE event_id IS NOT NULL;
CREATE INDEX doc_submissions_template ON doc_submissions (template_id, user_id);
ALTER TABLE doc_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE doc_submissions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON doc_submissions USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON doc_submissions TO laborops_app;

-- Both are optional and off until a company turns them on.
ALTER TABLE staffing_settings
  ADD COLUMN onboarding_on boolean NOT NULL DEFAULT false,
  ADD COLUMN onboarding_block boolean NOT NULL DEFAULT false,
  ADD COLUMN onboarding_remind boolean NOT NULL DEFAULT true,
  ADD COLUMN forms_on boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN onboarding_reminded_at timestamptz;
