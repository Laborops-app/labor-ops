-- Per-event clocking: who clocks crew in, and an optional geofence around the venue.
ALTER TABLE events
  ADD COLUMN clock_mode text NOT NULL DEFAULT 'self' CHECK (clock_mode IN ('self', 'coordinator')),
  ADD COLUMN geo_lat double precision,
  ADD COLUMN geo_lng double precision,
  ADD COLUMN geofence_m int CHECK (geofence_m IS NULL OR geofence_m BETWEEN 25 AND 20000);

-- Where and how each clock event happened.
ALTER TABLE time_entries
  ADD COLUMN in_lat double precision, ADD COLUMN in_lng double precision, ADD COLUMN in_distance_m int,
  ADD COLUMN out_lat double precision, ADD COLUMN out_lng double precision, ADD COLUMN out_distance_m int,
  ADD COLUMN in_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN out_by uuid REFERENCES users(id) ON DELETE SET NULL;
