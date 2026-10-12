-- Customers (CRM), copying events, and labor quotes.
CREATE TABLE customers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          text NOT NULL,
  contact_name  text,
  email         text,
  phone         text,
  address       text,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX customers_name_unique ON customers (tenant_id, lower(name));
ALTER TABLE events ADD COLUMN customer_id uuid REFERENCES customers(id) ON DELETE SET NULL;
CREATE INDEX events_customer_idx ON events (customer_id);

-- What the company charges the customer per hour for a role (separate from what crew are paid).
ALTER TABLE skills ADD COLUMN bill_rate numeric(10,2) NOT NULL DEFAULT 0 CHECK (bill_rate >= 0);

CREATE TABLE quotes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  number        int NOT NULL,
  customer_id   uuid REFERENCES customers(id) ON DELETE SET NULL,
  event_id      uuid REFERENCES events(id) ON DELETE SET NULL,
  title         text NOT NULL,
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'accepted', 'declined')),
  valid_until   date,
  intro         text,
  terms         text,
  tax_pct       numeric(5,2) NOT NULL DEFAULT 0 CHECK (tax_pct >= 0 AND tax_pct <= 100),
  discount      numeric(12,2) NOT NULL DEFAULT 0 CHECK (discount >= 0),
  sent_at       timestamptz,
  sent_to       text,
  responded_at  timestamptz,
  response_note text,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number)
);
CREATE TABLE quote_lines (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  quote_id    uuid NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  sort        int NOT NULL DEFAULT 0,
  description text NOT NULL,
  qty         numeric(10,2) NOT NULL DEFAULT 1 CHECK (qty >= 0),
  hours       numeric(10,2) NOT NULL DEFAULT 1 CHECK (hours >= 0),
  rate        numeric(10,2) NOT NULL DEFAULT 0 CHECK (rate >= 0)
);
CREATE INDEX quote_lines_quote_idx ON quote_lines (quote_id, sort);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['customers','quotes','quote_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO laborops_app', t);
  END LOOP;
END $$;
