-- Where each customer is in the relationship, for the Customers board (Kanban).
--   lead      no work yet
--   pending   a quote is out, no event yet
--   active    has upcoming or recent work (within a year)
--   inactive  had work, nothing in the last year
ALTER TABLE customers
  ADD COLUMN stage text NOT NULL DEFAULT 'lead' CHECK (stage IN ('lead', 'pending', 'active', 'inactive')),
  ADD COLUMN board_position double precision NOT NULL DEFAULT 0;

UPDATE customers u SET stage = CASE
  WHEN EXISTS (SELECT 1 FROM events e WHERE e.customer_id = u.id AND e.end_date >= current_date - 365) THEN 'active'
  WHEN EXISTS (SELECT 1 FROM events e WHERE e.customer_id = u.id) THEN 'inactive'
  WHEN EXISTS (SELECT 1 FROM quotes q WHERE q.customer_id = u.id) THEN 'pending'
  ELSE 'lead' END;
UPDATE customers u SET board_position = r.n FROM (SELECT id, row_number() OVER (PARTITION BY tenant_id, stage ORDER BY lower(name)) AS n FROM customers) r WHERE r.id = u.id;
