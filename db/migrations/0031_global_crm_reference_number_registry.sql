-- The numeric part of a CRM reference is globally unique across every module.
-- Keep it forever so a deleted record can never release the number to another
-- prefix or a later record.
CREATE TABLE IF NOT EXISTS crm_reference_number_registry (
  number_value text PRIMARY KEY,
  allocated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_reference_number_registry_valid CHECK (number_value ~ '^[0-9]{7}$')
);

INSERT INTO crm_reference_number_registry (number_value, allocated_at)
SELECT number_value, min(allocated_at)
FROM (
  SELECT right(reference_code, 7) AS number_value, allocated_at
  FROM crm_reference_registry
  UNION ALL
  SELECT right(slug, 7), created_at
  FROM short_links
  WHERE slug ~ '^g[aciklmo][0-9]{7}$'
) consumed
GROUP BY number_value
ON CONFLICT (number_value) DO NOTHING;

DO $$
BEGIN
  IF EXISTS (
    WITH current_codes AS (
      SELECT reference_code FROM workspace_organizations
      UNION SELECT reference_code FROM app_users
      UNION SELECT reference_code FROM crm_organizations
      UNION SELECT reference_code FROM crm_contacts
      UNION SELECT reference_code FROM crm_leads
      UNION SELECT reference_code FROM crm_opportunities
      UNION SELECT reference_code FROM crm_meetings
      UNION SELECT reference_code FROM crm_interactions
      UNION SELECT reference_code FROM crm_campaigns
    )
    SELECT 1
    FROM current_codes
    GROUP BY right(reference_code, 7)
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Current CRM records contain duplicate numeric reference values';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION protect_crm_reference_number_registry()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'CRM reference number allocations are immutable';
END;
$$;

CREATE TRIGGER protect_crm_reference_number_registry_delete
BEFORE DELETE ON crm_reference_number_registry
FOR EACH ROW EXECUTE FUNCTION protect_crm_reference_number_registry();

CREATE TRIGGER protect_crm_reference_number_registry_update
BEFORE UPDATE ON crm_reference_number_registry
FOR EACH ROW EXECUTE FUNCTION protect_crm_reference_number_registry();

CREATE OR REPLACE FUNCTION enforce_crm_reference_number_exclusive()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM crm_reference_number_registry
    WHERE number_value = right(NEW.reference_code, 7)
  ) THEN
    RAISE EXCEPTION 'CRM reference number was not reserved';
  END IF;

  IF EXISTS (
    SELECT 1 FROM crm_reference_registry
    WHERE right(reference_code, 7) = right(NEW.reference_code, 7)
      AND reference_code <> NEW.reference_code
  ) THEN
    RAISE EXCEPTION 'CRM reference number is already allocated';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER enforce_crm_reference_number_exclusive_insert
BEFORE INSERT ON crm_reference_registry
FOR EACH ROW EXECUTE FUNCTION enforce_crm_reference_number_exclusive();

CREATE OR REPLACE FUNCTION allocate_crm_reference(requested_prefix text)
RETURNS text
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  candidate_number text;
  candidate text;
  reserved_number text;
BEGIN
  IF requested_prefix NOT IN ('ga', 'gc', 'gl', 'go', 'gm', 'gi', 'gk') THEN
    RAISE EXCEPTION 'Unsupported CRM reference prefix: %', requested_prefix;
  END IF;

  FOR attempt IN 1..1000 LOOP
    candidate_number := (1000000 + floor(random() * 9000000)::bigint)::text;
    candidate := requested_prefix || candidate_number;
    reserved_number := NULL;

    INSERT INTO crm_reference_number_registry (number_value, allocated_at)
    VALUES (candidate_number, now())
    ON CONFLICT (number_value) DO NOTHING
    RETURNING number_value INTO reserved_number;

    IF reserved_number IS NULL THEN
      CONTINUE;
    END IF;

    INSERT INTO crm_reference_registry (
      reference_code, prefix, canonical_code, status, allocated_at
    )
    VALUES (candidate, requested_prefix, candidate, 'active', now());

    RETURN candidate;
  END LOOP;

  RAISE EXCEPTION 'Unable to allocate a unique CRM reference for prefix %', requested_prefix;
END;
$$;
