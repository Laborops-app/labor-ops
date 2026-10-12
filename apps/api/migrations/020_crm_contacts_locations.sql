-- A customer can have several contacts and several locations; customers can be linked to Rentman contacts.
CREATE TABLE customer_contacts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  name        text NOT NULL,
  title       text,
  email       text,
  phone       text,
  notes       text,
  is_primary  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customer_contacts_customer_idx ON customer_contacts (customer_id);
CREATE UNIQUE INDEX customer_contacts_one_primary ON customer_contacts (customer_id) WHERE is_primary;

CREATE TABLE customer_locations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  label       text NOT NULL,
  venue       text,
  address     text,
  notes       text,
  is_default  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customer_locations_customer_idx ON customer_locations (customer_id);
CREATE UNIQUE INDEX customer_locations_one_default ON customer_locations (customer_id) WHERE is_default;

-- Carry over what was stored on the customer itself.
INSERT INTO customer_contacts (tenant_id, customer_id, name, email, phone, is_primary)
  SELECT tenant_id, id, COALESCE(NULLIF(contact_name, ''), name), email, phone, true FROM customers
   WHERE coalesce(contact_name, email, phone) IS NOT NULL;
INSERT INTO customer_locations (tenant_id, customer_id, label, address, is_default)
  SELECT tenant_id, id, 'Main', address, true FROM customers WHERE coalesce(address, '') <> '';
ALTER TABLE customers DROP COLUMN contact_name, DROP COLUMN email, DROP COLUMN phone, DROP COLUMN address;

ALTER TABLE customers ADD COLUMN rentman_contact_id int, ADD COLUMN rentman_synced_at timestamptz;
CREATE UNIQUE INDEX customers_rentman_unique ON customers (tenant_id, rentman_contact_id) WHERE rentman_contact_id IS NOT NULL;

-- Rentman contacts (customers and venues) cached on sync, so projects can show addresses and customers can be pulled.
CREATE TABLE rentman_contacts (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id          int NOT NULL,
  name        text NOT NULL,
  email       text,
  phone       text,
  address     text,
  PRIMARY KEY (tenant_id, id)
);
ALTER TABLE rentman_projects ADD COLUMN customer_id int, ADD COLUMN location_id int;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['customer_contacts','customer_locations','rentman_contacts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO laborops_app', t);
  END LOOP;
END $$;
