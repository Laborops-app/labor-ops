-- Rentman crew functions carry a fixed fee per person (call fee, travel) on top of the hourly rate.
-- With "Bill Rentman shifts at the quoted rate" on, it is billed once per person on the shift.
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS fixed_fee_override numeric(10,2);

-- Billing at Rentman's quoted prices is the normal way now: on for every company (it can still be switched off).
ALTER TABLE rentman_settings ALTER COLUMN quoted_bill_rates SET DEFAULT true;
UPDATE rentman_settings SET quoted_bill_rates = true WHERE NOT quoted_bill_rates;
