-- Early random-reference deployments evaluated app_users defaults before
-- ON CONFLICT resolution. Preserve those consumed values, but mark every
-- unreferenced allocation retired so active means attached to a live identity.
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
UPDATE crm_reference_registry registry
SET status = 'retired', retired_at = COALESCE(retired_at, now())
WHERE registry.status = 'active'
  AND registry.reference_code = registry.canonical_code
  AND NOT EXISTS (
    SELECT 1 FROM current_codes current
    WHERE current.reference_code = registry.reference_code
  );

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
    FROM crm_reference_registry registry
    WHERE registry.status = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM current_codes current
        WHERE current.reference_code = registry.reference_code
      )
  ) THEN
    RAISE EXCEPTION 'Unreferenced active CRM allocations remain after cleanup';
  END IF;
END;
$$;
