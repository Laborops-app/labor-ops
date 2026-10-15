-- Leads are set per event: an assignment can be the lead of its department on that event.
ALTER TABLE shift_assignments ADD COLUMN is_lead boolean NOT NULL DEFAULT false;
-- Lead roles ("Audio Lead"): whoever is put on a shift with one of these roles leads their department there.
ALTER TABLE skills ADD COLUMN is_lead boolean NOT NULL DEFAULT false;

-- Crew Lead used to be a permanent permission on the person; it is now chosen per event.
UPDATE users SET field_roles = array_remove(field_roles, 'crew_lead') WHERE 'crew_lead' = ANY(field_roles);

-- People already on shifts named "... (Lead)" are the leads there.
UPDATE shift_assignments a SET is_lead = true FROM shifts s WHERE s.id = a.shift_id AND s.role_name ~* '\(\s*lead\s*\)\s*$';

-- Roles already called "... Lead" in a department count as lead roles.
UPDATE skills SET is_lead = true WHERE group_id IS NOT NULL AND name ~* '\mlead$';

-- A lead role in every department that has none. Rates start empty: set them under Roles & rates.
INSERT INTO skills (tenant_id, name, group_id, is_lead)
SELECT g.tenant_id, left(g.name, 55) || ' Lead', g.id, true
  FROM skill_groups g
 WHERE NOT EXISTS (SELECT 1 FROM skills x WHERE x.group_id = g.id AND x.is_lead)
   AND NOT EXISTS (SELECT 1 FROM skills x WHERE x.tenant_id = g.tenant_id AND lower(x.name) = lower(left(g.name, 55) || ' Lead'));
