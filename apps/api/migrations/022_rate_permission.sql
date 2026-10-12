-- Admins always may change pay / bill rates; a Labor Coordinator only when an admin has allowed it.
ALTER TABLE users ADD COLUMN can_adjust_rates boolean NOT NULL DEFAULT false;
