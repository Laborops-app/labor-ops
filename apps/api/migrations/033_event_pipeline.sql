-- Event pipeline: where each event is in the process (Pending → Quote → Confirmed → In progress → Completed, or Canceled).
ALTER TABLE events
  ADD COLUMN pipeline_status text NOT NULL DEFAULT 'pending'
    CHECK (pipeline_status IN ('pending', 'quote', 'confirmed', 'in_progress', 'completed', 'canceled')),
  ADD COLUMN priority text NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high')),
  ADD COLUMN status_changed_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN board_position double precision;

-- Put existing events in the column that fits what has happened so far.
UPDATE events e SET pipeline_status = CASE
    WHEN e.end_date < current_date THEN 'completed'
    WHEN e.start_date <= current_date THEN 'in_progress'
    WHEN EXISTS (SELECT 1 FROM quotes q WHERE q.event_id = e.id AND q.status = 'accepted') THEN 'confirmed'
    WHEN EXISTS (SELECT 1 FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id WHERE s.event_id = e.id) THEN 'confirmed'
    WHEN EXISTS (SELECT 1 FROM quotes q WHERE q.event_id = e.id) THEN 'quote'
    ELSE 'pending' END;
CREATE INDEX events_pipeline_idx ON events (tenant_id, pipeline_status, board_position);

CREATE TABLE event_status_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_id    uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  from_status text,
  to_status   text NOT NULL,
  reason      text,
  changed_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX event_status_log_event_idx ON event_status_log (event_id, created_at DESC);
ALTER TABLE event_status_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_status_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON event_status_log USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON event_status_log TO laborops_app;
