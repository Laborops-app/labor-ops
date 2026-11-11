-- One event per Rentman project. Two Rentman pulls running at once could each add the same project; clean up any
-- duplicates (keeping the one with crew, invoices or quotes, else the oldest), then make it impossible.
WITH ranked AS (
  SELECT e.id, e.tenant_id, e.rentman_project_id,
         row_number() OVER (
           PARTITION BY e.tenant_id, e.rentman_project_id
           ORDER BY (EXISTS (SELECT 1 FROM shifts s JOIN shift_assignments a ON a.shift_id = s.id WHERE s.event_id = e.id)
                  OR EXISTS (SELECT 1 FROM planned_picks p WHERE p.event_id = e.id)
                  OR EXISTS (SELECT 1 FROM event_invoices i WHERE i.event_id = e.id)
                  OR EXISTS (SELECT 1 FROM quotes q WHERE q.event_id = e.id)) DESC,
                    e.archived_at IS NULL DESC, e.created_at, e.id
         ) AS n
    FROM events e WHERE e.rentman_project_id IS NOT NULL
), extra AS (
  SELECT r.id, r.tenant_id, r.rentman_project_id,
         (EXISTS (SELECT 1 FROM shifts s JOIN shift_assignments a ON a.shift_id = s.id WHERE s.event_id = r.id)
          OR EXISTS (SELECT 1 FROM planned_picks p WHERE p.event_id = r.id)
          OR EXISTS (SELECT 1 FROM event_invoices i WHERE i.event_id = r.id)
          OR EXISTS (SELECT 1 FROM quotes q WHERE q.event_id = r.id)) AS used
    FROM ranked r WHERE r.n > 1
), unlinked AS (
  -- Duplicates someone already worked on stay, but no longer claim the project.
  UPDATE events e SET rentman_project_id = NULL, rentman_build = false,
         notes = concat_ws(E'\n', e.notes, 'Was a duplicate of another event for the same Rentman project; unlinked from Rentman.')
    FROM extra x WHERE x.id = e.id AND x.used RETURNING e.id
)
DELETE FROM events e USING extra x WHERE x.id = e.id AND NOT x.used;

CREATE UNIQUE INDEX events_one_per_rentman_project ON events (tenant_id, rentman_project_id) WHERE rentman_project_id IS NOT NULL;
