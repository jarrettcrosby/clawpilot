-- Align exact Shopify checkout mappings with the CarrierService readiness
-- boundary introduced by 0159. A verified commerce account may remain
-- generic-status disabled while signed receipts are held; error remains
-- ineligible. Every channel, profile, recipe, configuration, stock, carrier,
-- credential, and Shadow revision fence remains unchanged.

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
  version_is_current boolean;
  version_lifecycle_state text;
  version_gross_weight_grams integer;
  version_base_each_quantity integer;
  version_ships_as_own_package boolean;
  profile_package_level text;
  profile_status text;
BEGIN
  -- Historical mappings must remain retireable even if a provider row was
  -- removed after the evidence was captured. Exact-current checks apply only
  -- to the live projection consumed by checkout.
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
    account.status
  INTO
    account_provider,
    account_type,
    account_environment,
    account_status
  FROM operations_integration_accounts account
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
     OR NEW.source_revision IS DISTINCT FROM channel_state.source_revision
     OR NEW.source_hash IS DISTINCT FROM channel_state.source_hash
     OR NEW.provider_updated_at
          IS DISTINCT FROM channel_state.provider_updated_at
     OR NEW.observed_at IS DISTINCT FROM channel_state.observed_at THEN
    RAISE EXCEPTION
      'Current variant-pack mapping evidence must exactly match channel state';
  END IF;

  IF NEW.mapping_purpose = 'shopify_checkout' THEN
    IF NEW.provider <> 'shopify'
       OR account_environment <> 'sandbox'
       OR account_status NOT IN ('active', 'disabled')
       OR channel_state.normalized_status <> 'active'
       OR channel_state.provider_active IS DISTINCT FROM true
       OR channel_state.requires_shipping IS DISTINCT FROM true
       OR channel_state.weight_grams IS NULL
       OR channel_state.weight_grams < 1
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
