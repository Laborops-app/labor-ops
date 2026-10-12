-- A pay rate for one shift that replaces the role's rate (null = use the role's rate).
ALTER TABLE shifts ADD COLUMN pay_rate_override numeric(10,2) CHECK (pay_rate_override IS NULL OR pay_rate_override > 0);
