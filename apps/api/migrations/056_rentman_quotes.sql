-- Quotes pulled in from Rentman, and what was quoted when an event is invoiced.

-- Where a quote came from. A Rentman quote is a read-only copy: change it in Rentman and pull it again.
ALTER TABLE quotes
  ADD COLUMN source text NOT NULL DEFAULT 'laborops' CHECK (source IN ('laborops', 'rentman')),
  ADD COLUMN rentman_quote_id int,
  ADD COLUMN rentman_number text,
  ADD COLUMN rentman_version int,
  ADD COLUMN rentman_total numeric(12,2),           -- the whole Rentman quote before tax (equipment, crew, transport, ...)
  ADD COLUMN rentman_crew_total numeric(12,2),      -- its crew part, as Rentman totals it
  ADD COLUMN rentman_transport_total numeric(12,2),
  ADD COLUMN imported_at timestamptz;
CREATE UNIQUE INDEX quotes_rentman_unique ON quotes (tenant_id, rentman_quote_id) WHERE rentman_quote_id IS NOT NULL;

-- A line's exact amount when it isn't simply people × hours × rate (an imported line keeps Rentman's total to the cent).
ALTER TABLE quote_lines ADD COLUMN amount numeric(12,2) CHECK (amount IS NULL OR amount >= 0);

-- The quote an invoice was checked against, and its labor total at that moment.
ALTER TABLE event_invoices
  ADD COLUMN quote_id uuid REFERENCES quotes(id) ON DELETE SET NULL,
  ADD COLUMN quoted_total numeric(12,2);
