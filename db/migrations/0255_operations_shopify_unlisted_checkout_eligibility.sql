-- Shopify UNLISTED products are sellable through an exact Online Store direct
-- URL, while remaining hidden from Shopify discovery surfaces. Preserve that
-- lifecycle truth and permit it only inside the existing sandbox checkout
-- boundary. This migration does not publish, activate, or rewrite a provider
-- product and does not make production mappings eligible.

-- BEGIN SHOPIFY CHECKOUT CHANNEL ELIGIBILITY FUNCTION
CREATE OR REPLACE FUNCTION
  operations_shopify_checkout_channel_is_eligible(
    requested_provider text,
    requested_environment text,
    requested_provider_status_raw text,
    requested_normalized_status text,
    requested_provider_active boolean,
    requested_requires_shipping boolean,
    requested_weight_grams integer
  )
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT COALESCE(
    lower(btrim(requested_provider)) = 'shopify'
    AND lower(btrim(requested_environment)) = 'sandbox'
    AND (
      (
        lower(btrim(requested_normalized_status)) = 'active'
        AND lower(btrim(requested_provider_status_raw)) = 'active'
        AND requested_provider_active IS TRUE
      )
      OR (
        lower(btrim(requested_normalized_status)) = 'unlisted'
        AND lower(btrim(requested_provider_status_raw)) = 'unlisted'
        AND requested_provider_active IS FALSE
      )
    )
    AND requested_requires_shipping IS TRUE
    AND requested_weight_grams >= 1,
    false
  )
$$;
-- END SHOPIFY CHECKOUT CHANNEL ELIGIBILITY FUNCTION

CREATE OR REPLACE FUNCTION
  validate_operations_commerce_variant_pack_mapping()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  channel_state operations_product_channel_states%ROWTYPE;
  account_provider text;
  account_type text;
  account_environment text;
  account_status text;
  credential_verification_status text;
  version_is_current boolean;
  version_lifecycle_state text;
  version_gross_weight_grams integer;
  version_base_each_quantity integer;
  version_ships_as_own_package boolean;
  profile_package_level text;
  profile_status text;
BEGIN
  IF NOT (NEW.is_current AND NEW.projection_state = 'current') THEN
    RETURN NEW;
  END IF;

  SELECT state.*
  INTO channel_state
  FROM operations_product_channel_states state
  WHERE state.organization_id = NEW.organization_id
    AND state.integration_account_id = NEW.integration_account_id
    AND state.pipeline_id = NEW.pipeline_id
    AND state.external_product_id = NEW.external_product_id
    AND state.external_variant_id = NEW.external_variant_id;

  IF channel_state.id IS NULL THEN
    RAISE EXCEPTION
      'Variant-pack mappings require an exact retained channel-state row';
  END IF;

  SELECT
    account.provider,
    account.integration_type,
    account.environment,
    account.status,
    credential.verification_status
  INTO
    account_provider,
    account_type,
    account_environment,
    account_status,
    credential_verification_status
  FROM operations_integration_accounts account
  LEFT JOIN operations_commerce_credentials credential
    ON credential.organization_id = account.organization_id
   AND credential.integration_account_id = account.id
  WHERE account.organization_id = NEW.organization_id
    AND account.id = NEW.integration_account_id;

  IF account_type <> 'commerce'
     OR account_provider <> NEW.provider
     OR channel_state.provider <> NEW.provider
     OR channel_state.product_id IS DISTINCT FROM NEW.product_id THEN
    RAISE EXCEPTION
      'Variant-pack mapping scope does not match its commerce channel state';
  END IF;

  SELECT
    version.is_current,
    version.lifecycle_state,
    version.gross_weight_grams,
    version.base_each_quantity,
    version.ships_as_own_package,
    profile.package_level,
    profile.status
  INTO
    version_is_current,
    version_lifecycle_state,
    version_gross_weight_grams,
    version_base_each_quantity,
    version_ships_as_own_package,
    profile_package_level,
    profile_status
  FROM operations_product_pack_profile_versions version
  JOIN operations_product_pack_profiles profile
    ON profile.organization_id = version.organization_id
   AND profile.pipeline_id = version.pipeline_id
   AND profile.product_id = version.product_id
   AND profile.id = version.profile_id
  WHERE version.organization_id = NEW.organization_id
    AND version.pipeline_id = NEW.pipeline_id
    AND version.product_id = NEW.product_id
    AND version.id = NEW.default_pack_profile_version_id;

  IF version_is_current IS DISTINCT FROM true THEN
    RAISE EXCEPTION
      'A current variant-pack mapping requires the current pack version';
  END IF;

  IF NEW.provider_lifecycle_state <> channel_state.normalized_status
     OR NEW.pack_evidence_hash
          IS DISTINCT FROM channel_state.pack_evidence_hash THEN
    RAISE EXCEPTION
      'Current variant-pack mapping must match pack-relevant channel evidence';
  END IF;

  IF NEW.mapping_purpose = 'shopify_checkout' THEN
    IF account_status NOT IN ('active', 'disabled')
       OR credential_verification_status IS DISTINCT FROM 'verified'
       OR NOT operations_shopify_checkout_channel_is_eligible(
         NEW.provider,
         account_environment,
         channel_state.provider_status_raw,
         channel_state.normalized_status,
         channel_state.provider_active,
         channel_state.requires_shipping,
         channel_state.weight_grams
       )
       OR version_lifecycle_state <> 'active'
       OR profile_status <> 'active'
       OR version_gross_weight_grams
            IS DISTINCT FROM channel_state.weight_grams THEN
      RAISE EXCEPTION
        'Shopify checkout mapping requires exact eligible sandbox shipping and pack evidence';
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM operations_shopify_carrier_service_configs config
      WHERE config.organization_id = NEW.organization_id
        AND config.integration_account_id = NEW.integration_account_id
        AND config.registration_state = 'registered'
        AND operations_shopify_carrier_service_config_is_ready(
          config.organization_id,
          config.id
        )
    ) THEN
      RAISE EXCEPTION
        'Shopify checkout mapping requires a registered ready CarrierService';
    END IF;

    IF NOT (
      profile_package_level = 'case'
      AND version_base_each_quantity > 1
      AND version_ships_as_own_package = true
    ) AND NOT EXISTS (
      SELECT 1
      FROM operations_shopify_carrier_service_configs config
      JOIN operations_approved_pack_recipes recipe
        ON recipe.organization_id = config.organization_id
       AND recipe.input_pack_profile_version_id
            = NEW.default_pack_profile_version_id
       AND recipe.lifecycle_state = 'active'
       AND recipe.is_current = true
      JOIN operations_shopify_carrier_service_config_materials selected
        ON selected.organization_id = config.organization_id
       AND selected.config_id = config.id
       AND selected.packaging_material_id = recipe.packaging_material_id
      WHERE config.organization_id = NEW.organization_id
        AND config.integration_account_id = NEW.integration_account_id
        AND config.registration_state = 'registered'
        AND operations_shopify_carrier_service_config_is_ready(
          config.organization_id,
          config.id
        )
    ) THEN
      RAISE EXCEPTION
        'Shopify checkout mapping requires either an active self-packaged case or a selected active recipe';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION operations_shopify_checkout_channel_is_eligible(
  text, text, text, text, boolean, boolean, integer
) IS
  'Exact Shopify sandbox checkout lifecycle predicate. ACTIVE/true and UNLISTED/false may qualify; production and every other lifecycle remain ineligible.';
