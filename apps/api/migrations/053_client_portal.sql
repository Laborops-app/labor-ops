-- Client portal: people at a customer sign in to see their events, the roster, live attendance and timesheets,
-- approve timesheets, see invoices and request crew. A client account belongs to one customer (and its divisions).
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'manager', 'crew', 'hr', 'client'));
ALTER TABLE users ADD COLUMN customer_id uuid REFERENCES customers(id) ON DELETE CASCADE;
ALTER TABLE users ADD CONSTRAINT users_client_customer CHECK ((role = 'client') = (customer_id IS NOT NULL));

-- Per customer: their sign-off on an event's timesheets is required before it can be invoiced.
ALTER TABLE customers ADD COLUMN require_client_approval boolean NOT NULL DEFAULT false;

-- Sign-offs and disputes. The fingerprint is of the approved time at that moment: if time changes afterwards,
-- the approval no longer counts and the client is asked again.
CREATE TABLE client_approvals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_id     uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  status       text NOT NULL CHECK (status IN ('approved', 'disputed')),
  note         text,
  fingerprint  text NOT NULL,
  hours        numeric(10,2) NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX client_approvals_event_idx ON client_approvals (event_id, created_at DESC);
ALTER TABLE client_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_approvals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON client_approvals USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON client_approvals TO laborops_app;

-- Crew requests made from the portal become pending events.
ALTER TABLE events ADD COLUMN requested_by uuid REFERENCES users(id) ON DELETE SET NULL;
