-- A venue in another time zone: the event's own zone (empty = the company's).
ALTER TABLE events ADD COLUMN IF NOT EXISTS timezone text;
