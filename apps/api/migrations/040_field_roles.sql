-- Field permissions a crew member can be given by an admin or labor coordinator:
--   onsite_coordinator: on events they work, check any crew member in and out and rate them.
--   crew_lead: the same, but only for the crew in their own position on their own shift times.
ALTER TABLE users ADD COLUMN field_roles text[] NOT NULL DEFAULT '{}'
  CHECK (field_roles <@ ARRAY['onsite_coordinator', 'crew_lead']::text[]);
