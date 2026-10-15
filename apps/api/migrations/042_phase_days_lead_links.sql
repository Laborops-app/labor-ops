-- A crew shift can be linked to the lead shift that leads it (e.g. Pusher and Loader shifts → Stage Hand Lead).
ALTER TABLE shifts ADD COLUMN lead_shift_id uuid REFERENCES shifts(id) ON DELETE SET NULL;
CREATE INDEX shifts_lead_shift_idx ON shifts (lead_shift_id);

-- Phases are one day each: split every longer phase into one phase per day (same name), and put each of its
-- shifts in the phase for the day it starts on (in the company's time zone).
DO $$
DECLARE
  p record;
  d date;
  np uuid;
BEGIN
  FOR p IN SELECT ph.id, ph.tenant_id, ph.event_id, ph.label, ph.starts_on, ph.ends_on, ph.created_at, t.timezone AS tz
             FROM event_phases ph JOIN tenants t ON t.id = ph.tenant_id WHERE ph.ends_on > ph.starts_on LOOP
    FOR d IN SELECT g::date FROM generate_series(p.starts_on + 1, p.ends_on, interval '1 day') g LOOP
      INSERT INTO event_phases (tenant_id, event_id, label, starts_on, ends_on, created_at)
      VALUES (p.tenant_id, p.event_id, p.label, d, d, p.created_at) RETURNING id INTO np;
      UPDATE shifts SET phase_id = np WHERE phase_id = p.id AND (starts_at AT TIME ZONE p.tz)::date = d;
    END LOOP;
    UPDATE event_phases SET ends_on = starts_on WHERE id = p.id;
  END LOOP;
END $$;
