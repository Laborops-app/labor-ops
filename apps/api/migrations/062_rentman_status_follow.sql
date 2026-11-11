-- Linked events follow each change of the Rentman project's status (either direction), not just forward moves.
-- The status last applied is kept so a move made in LaborOps isn't undone until Rentman's status changes again.
ALTER TABLE events ADD COLUMN rentman_status_seen text;
UPDATE events e SET rentman_status_seen = p.status_name FROM rentman_projects p WHERE p.id = e.rentman_project_id AND p.tenant_id = e.tenant_id;
-- The Rentman account (yourcompany.rentmanapp.com), for "open in Rentman" links. Learned from webhooks or typed in.
ALTER TABLE rentman_settings ADD COLUMN account_name text;
