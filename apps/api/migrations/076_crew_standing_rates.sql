-- Standing pay (and bill) rates per person per skill, used on every event.
-- A change is a new row with the date it starts; older rows stay as history and still price earlier shifts.
-- Order for a shift: this person's rate on this event > their standing rate for the skill > the shift's rate > the role's rate.
CREATE TABLE crew_rates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  skill_id    uuid NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  pay_type    text NOT NULL DEFAULT 'hourly' CHECK (pay_type IN ('hourly', 'day')),
  -- Either can be empty: then that side goes back to the role's rate from this date.
  rate        numeric(10,2) CHECK (rate IS NULL OR (rate > 0 AND rate <= 100000)),
  bill_rate   numeric(10,2) CHECK (bill_rate IS NULL OR (bill_rate > 0 AND bill_rate <= 100000)),
  starts_on   date NOT NULL DEFAULT current_date,
  note        text,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, skill_id, starts_on)
);
CREATE INDEX crew_rates_user_idx ON crew_rates (user_id, skill_id, starts_on DESC);
ALTER TABLE crew_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE crew_rates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON crew_rates USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON crew_rates TO laborops_app;

-- The same role matching as roleKeyOf() in the app: case, spacing, punctuation, a trailing "(Show)" note,
-- a plural "s", and "Op"/"Ops" = "Operator", "Tech" = "Technician".
CREATE OR REPLACE FUNCTION role_key(name text) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE s text;
BEGIN
  s := lower(trim(regexp_replace(coalesce(name, ''), '\s*\(.*\)\s*$', '')));
  s := regexp_replace(s, '\m(op|ops|opr)\.?$', 'operator');
  s := regexp_replace(s, '\mtechs?\.?$', 'technician');
  s := regexp_replace(s, '[^a-z0-9]', '', 'g');
  IF length(s) > 3 THEN s := regexp_replace(s, 's$', ''); END IF;
  RETURN s;
END $$;

-- The standing rate row in force for a person, a position and a day (NULL when none).
CREATE OR REPLACE FUNCTION standing_rate(p_user uuid, p_role text, p_on date)
RETURNS TABLE (id uuid, pay_type text, rate numeric, bill_rate numeric, starts_on date)
LANGUAGE sql STABLE AS $$
  SELECT r.id, r.pay_type, r.rate, r.bill_rate, r.starts_on
    FROM crew_rates r JOIN skills k ON k.id = r.skill_id
   WHERE r.user_id = p_user AND role_key(k.name) = role_key(p_role) AND r.starts_on <= p_on
   ORDER BY r.starts_on DESC, r.created_at DESC
   LIMIT 1
$$;

-- A person's own pay for one shift: their rate on this event (that position, then "all positions"),
-- else their standing rate for the skill on the shift's date. src says which.
CREATE OR REPLACE FUNCTION person_rate(p_user uuid, p_shift uuid)
RETURNS TABLE (pay_type text, rate numeric, src text)
LANGUAGE sql STABLE AS $$
  WITH s AS (
    SELECT s.event_id, s.role_name,
           (s.starts_at AT TIME ZONE COALESCE(e.timezone, t.timezone, 'UTC'))::date AS on_day
      FROM shifts s JOIN events e ON e.id = s.event_id JOIN tenants t ON t.id = s.tenant_id
     WHERE s.id = p_shift
  )
  SELECT pay_type, rate, src FROM (
    SELECT x.pay_type, x.rate, 'event'::text AS src, CASE WHEN x.role_name = '' THEN 1 ELSE 0 END AS ord
      FROM event_crew_rates x, s
     WHERE p_user IS NOT NULL AND x.event_id = s.event_id AND x.user_id = p_user
       AND (x.role_name = '' OR lower(x.role_name) = lower(trim(s.role_name)))
    UNION ALL
    SELECT r.pay_type, r.rate, 'person', 2
      FROM s, LATERAL standing_rate(p_user, s.role_name, s.on_day) r
     WHERE p_user IS NOT NULL AND r.rate IS NOT NULL
  ) q
  ORDER BY ord LIMIT 1
$$;

GRANT EXECUTE ON FUNCTION role_key(text), standing_rate(uuid, text, date), person_rate(uuid, uuid) TO laborops_app;
