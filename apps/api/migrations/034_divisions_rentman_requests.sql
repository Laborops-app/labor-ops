-- A customer can be a division of another customer (University of Utah → University of Utah – Athletics).
ALTER TABLE customers ADD COLUMN parent_id uuid REFERENCES customers(id) ON DELETE SET NULL;
ALTER TABLE customers ADD CONSTRAINT customers_not_own_parent CHECK (parent_id IS NULL OR parent_id <> id);
CREATE INDEX customers_parent_idx ON customers (parent_id) WHERE parent_id IS NOT NULL;

-- Events sent to Rentman go in as project requests; once accepted there, the new project is linked back automatically.
ALTER TABLE events
  ADD COLUMN rentman_request_id int,
  ADD COLUMN rentman_request_status text CHECK (rentman_request_status IN ('open', 'accepted', 'declined')),
  ADD COLUMN rentman_pushed_at timestamptz,
  ADD COLUMN rentman_checked_at timestamptz;
