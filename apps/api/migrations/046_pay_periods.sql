-- How often the company runs payroll, and the first day of any one pay period (the others follow from it).
ALTER TABLE labor_rules
  ADD COLUMN pay_period text NOT NULL DEFAULT 'biweekly' CHECK (pay_period IN ('weekly', 'biweekly')),
  ADD COLUMN pay_period_start date NOT NULL DEFAULT '2026-01-05'; -- a Monday
