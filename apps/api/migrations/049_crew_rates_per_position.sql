-- A personal rate on an event can be for one position ("Audio Tech") or, with an empty role, for every position the
-- person works on that event. A position rate wins over the all-positions rate.
ALTER TABLE event_crew_rates ADD COLUMN role_name text NOT NULL DEFAULT '';
ALTER TABLE event_crew_rates DROP CONSTRAINT event_crew_rates_pkey;
CREATE UNIQUE INDEX event_crew_rates_key ON event_crew_rates (event_id, user_id, lower(role_name));
