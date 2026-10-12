-- Rentman equipment is organised into groups inside a project; kit items hang under a parent item.
ALTER TABLE rentman_equipment ADD COLUMN group_id int, ADD COLUMN group_name text, ADD COLUMN group_sort int, ADD COLUMN parent_id int;
