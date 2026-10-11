-- A shift can belong to one dated phase of its event (load in, show days, strike ...).
ALTER TABLE shifts ADD COLUMN phase_id uuid REFERENCES event_phases(id) ON DELETE SET NULL;
CREATE INDEX shifts_phase_idx ON shifts (phase_id);
