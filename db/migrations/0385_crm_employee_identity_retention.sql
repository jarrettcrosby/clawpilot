-- Employee eligibility is not a native-user deletion or a CRM module grant.
-- Preserve issued gu identities and native mappings when assignment eligibility
-- is switched off. No historical identity is inferred, revived or remapped.
LOCK TABLE app_users IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE app_users
  DROP CONSTRAINT app_users_crm_employee_identity_complete,
  ADD CONSTRAINT app_users_crm_employee_identity_complete CHECK (
    (reference_code IS NOT NULL AND global_reference_code_is_valid(reference_code, 'gu'))
    OR (
      NOT crm_user_enabled AND reference_code IS NULL
      AND suitecrm_user_id IS NULL AND suitecrm_username IS NULL
    )
  ),
  DROP CONSTRAINT app_users_suitecrm_identity_canonical,
  ADD CONSTRAINT app_users_suitecrm_identity_canonical CHECK (
    (suitecrm_user_id IS NULL AND suitecrm_username IS NULL)
    OR (
      suitecrm_user_id IS NOT NULL AND suitecrm_username IS NOT NULL
      AND reference_code IS NOT NULL AND suitecrm_username = reference_code
    )
  );

CREATE FUNCTION clawpilot_keep_issued_employee_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF OLD.reference_code IS NOT NULL
    AND NEW.reference_code IS DISTINCT FROM OLD.reference_code THEN
    RAISE EXCEPTION 'An issued CRM employee Global ID is permanent'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER app_users_keep_issued_employee_identity
  BEFORE UPDATE OF reference_code ON app_users FOR EACH ROW
  EXECUTE FUNCTION clawpilot_keep_issued_employee_identity();
