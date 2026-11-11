-- Rentman names a coordinator removed from the role-name list stay hidden (and aren't added back on the next sync).
ALTER TABLE rentman_role_map ADD COLUMN ignored boolean NOT NULL DEFAULT false;
-- Unnamed Rentman rates ("0-∞ € 0.40/h + € 5 fixed") were listed as role names; they aren't crew functions.
DELETE FROM rentman_role_map WHERE role_name IS NULL AND rentman_name ~ '^[0-9].*(/h|fixed)';
