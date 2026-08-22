-- Validate zero-write CarrierService simulation against the saved checkout
-- rating lane rather than the legacy organization-wide activation mode.
-- Registered provider state retains the exact pre-existing callback-readiness
-- and provider-finalization fences.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, public, pg_temp;

CREATE OR REPLACE FUNCTION
  public.validate_operations_shopify_carrier_service_config_ready()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  exact_finalization_link_exists boolean := false;
  exact_name_finalization_exists boolean := false;
  local_policy_only_update boolean := false;
  name_finalization_only_update boolean := false;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    local_policy_only_update :=
      (pg_catalog.to_jsonb(NEW) - ARRAY[
        'row_version', 'policy_snapshot', 'policy_hash', 'policy_revision',
        'updated_by', 'updated_at'
      ]::text[])
      IS NOT DISTINCT FROM
      (pg_catalog.to_jsonb(OLD) - ARRAY[
        'row_version', 'policy_snapshot', 'policy_hash', 'policy_revision',
        'updated_by', 'updated_at'
      ]::text[]);
    name_finalization_only_update :=
      NEW.registered_service_name IS DISTINCT FROM
        OLD.registered_service_name
      AND (
        pg_catalog.to_jsonb(NEW) - ARRAY[
          'row_version', 'registered_service_name', 'updated_by', 'updated_at'
        ]::text[]
      ) IS NOT DISTINCT FROM (
        pg_catalog.to_jsonb(OLD) - ARRAY[
          'row_version', 'registered_service_name', 'updated_by', 'updated_at'
        ]::text[]
      );
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.registration_state IN ('registered', 'disabled')
     AND NEW.registration_state IS DISTINCT FROM OLD.registration_state THEN
    exact_finalization_link_exists :=
      public.operations_shopify_cs_config_has_exact_finalization_link(
        NEW.organization_id,
        NEW.id,
        NEW.integration_account_id,
        OLD.row_version,
        NEW.row_version,
        OLD.registration_state,
        NEW.registration_state,
        OLD.service_gid,
        NEW.service_gid,
        OLD.activation_revision,
        NEW.activation_revision,
        NEW.credential_generation
      );
  END IF;

  IF TG_OP = 'UPDATE'
     AND name_finalization_only_update
     AND OLD.registration_state = 'registered'
     AND NEW.registration_state = 'registered'
     AND NEW.service_gid IS NOT DISTINCT FROM OLD.service_gid
     AND NEW.registered_service_name IS DISTINCT FROM
       OLD.registered_service_name THEN
    exact_name_finalization_exists :=
      public.operations_shopify_cs_name_has_exact_finalization_evidence(
        NEW.organization_id,
        NEW.id,
        NEW.integration_account_id,
        OLD.row_version,
        NEW.row_version,
        NEW.service_gid,
        NEW.registered_service_name,
        NEW.credential_generation
      );
  END IF;

  IF NOT local_policy_only_update
     AND NEW.registration_state = 'shadow_simulated'
     AND NOT public.operations_shopify_carrier_service_rating_environment_is_ready(
       NEW.organization_id,
       NEW.id,
       NEW.policy_snapshot #>> '{checkoutRateControl,rateSource}'
     ) THEN
    RAISE EXCEPTION
      'Shopify carrier service configuration is not rating-environment-ready';
  END IF;

  IF NOT local_policy_only_update
     AND NEW.registration_state = 'registered'
     AND NOT public.operations_shopify_carrier_service_config_is_ready(
       NEW.organization_id,
       NEW.id
     )
     AND NOT exact_finalization_link_exists
     AND NOT exact_name_finalization_exists THEN
    RAISE EXCEPTION
      'Shopify carrier service configuration is not callback-ready';
  END IF;
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION
  public.validate_operations_shopify_carrier_service_config_ready() IS
  'Validates zero-write shadow_simulated state against the saved checkoutRateControl TEST/LIVE rating environment independently of global activation; registered provider state retains exact callback readiness and finalization evidence requirements.';
