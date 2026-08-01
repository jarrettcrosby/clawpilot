-- Separate physical pack readiness from the provider's full catalog revision.
-- Inventory quantities, timestamps, media, merchandising copy, prices,
-- taxonomy, SKU, and barcode remain in source_hash for audit/reconciliation,
-- but cannot invalidate an unchanged physical pack mapping.

CREATE OR REPLACE FUNCTION operations_pack_evidence_segment(value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN value IS NULL THEN '-1:'
    ELSE octet_length(value)::text || ':' || value
  END
$$;

CREATE OR REPLACE FUNCTION operations_commerce_pack_evidence_hash(
  integration_account_id uuid,
  provider text,
  external_product_id text,
  external_variant_id text,
  external_inventory_item_id text,
  normalized_status text,
  provider_active boolean,
  requires_shipping boolean,
  weight_grams integer
)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT encode(
    digest(
      convert_to(
        operations_pack_evidence_segment(
          'clawpilot-pack-evidence-v1'
        )
        || operations_pack_evidence_segment(
          integration_account_id::text
        )
        || operations_pack_evidence_segment(provider)
        || operations_pack_evidence_segment(external_product_id)
        || operations_pack_evidence_segment(external_variant_id)
        || operations_pack_evidence_segment(external_inventory_item_id)
        || operations_pack_evidence_segment(normalized_status)
        || operations_pack_evidence_segment(
          CASE
            WHEN provider_active IS NULL THEN NULL
            WHEN provider_active THEN '1'
            ELSE '0'
          END
        )
        || operations_pack_evidence_segment(
          CASE
            WHEN requires_shipping IS NULL THEN NULL
            WHEN requires_shipping THEN '1'
            ELSE '0'
          END
        )
        || operations_pack_evidence_segment(
          weight_grams::text
        ),
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  )
$$;

ALTER TABLE operations_product_channel_states
  ADD COLUMN IF NOT EXISTS pack_evidence_hash text;

CREATE OR REPLACE FUNCTION
  set_operations_product_channel_pack_evidence_hash()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.pack_evidence_hash := operations_commerce_pack_evidence_hash(
    NEW.integration_account_id,
    NEW.provider,
    NEW.external_product_id,
    NEW.external_variant_id,
    NEW.external_inventory_item_id,
    NEW.normalized_status,
    NEW.provider_active,
    NEW.requires_shipping,
    NEW.weight_grams
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_operations_product_channel_pack_evidence_hash
  ON operations_product_channel_states;
CREATE TRIGGER set_operations_product_channel_pack_evidence_hash
BEFORE INSERT OR UPDATE OF
  integration_account_id,
  provider,
  external_product_id,
  external_variant_id,
  external_inventory_item_id,
  normalized_status,
  provider_active,
  requires_shipping,
  weight_grams,
  pack_evidence_hash
ON operations_product_channel_states
FOR EACH ROW EXECUTE FUNCTION
  set_operations_product_channel_pack_evidence_hash();

UPDATE operations_product_channel_states state
SET pack_evidence_hash = operations_commerce_pack_evidence_hash(
  state.integration_account_id,
  state.provider,
  state.external_product_id,
  state.external_variant_id,
  state.external_inventory_item_id,
  state.normalized_status,
  state.provider_active,
  state.requires_shipping,
  state.weight_grams
)
WHERE state.pack_evidence_hash IS NULL;

ALTER TABLE operations_product_channel_states
  ALTER COLUMN pack_evidence_hash SET NOT NULL,
  DROP CONSTRAINT IF EXISTS
    operations_product_channel_states_pack_evidence_hash_valid,
  ADD CONSTRAINT operations_product_channel_states_pack_evidence_hash_valid
    CHECK (pack_evidence_hash ~ '^[a-f0-9]{64}$');

ALTER TABLE operations_commerce_variant_pack_mappings
  ADD COLUMN IF NOT EXISTS pack_evidence_hash text;

-- Establish the migration-time current provider state as the explicit pack
-- baseline. Later pack-relevant drift changes only the state hash and therefore
-- fails closed until an administrator saves a new mapping.
UPDATE operations_commerce_variant_pack_mappings mapping
SET pack_evidence_hash = state.pack_evidence_hash
FROM operations_product_channel_states state
WHERE mapping.organization_id = state.organization_id
  AND mapping.integration_account_id = state.integration_account_id
  AND mapping.pipeline_id = state.pipeline_id
  AND mapping.product_id = state.product_id
  AND mapping.provider = state.provider
  AND mapping.external_product_id = state.external_product_id
  AND mapping.external_variant_id = state.external_variant_id
  AND mapping.is_current = true
  AND mapping.projection_state = 'current'
  AND mapping.provider_lifecycle_state = state.normalized_status
  AND mapping.source_revision IS NOT DISTINCT FROM state.source_revision
  AND mapping.source_hash IS NOT DISTINCT FROM state.source_hash
  AND mapping.provider_updated_at
        IS NOT DISTINCT FROM state.provider_updated_at
  AND mapping.observed_at IS NOT DISTINCT FROM state.observed_at
  AND mapping.pack_evidence_hash IS NULL;

-- Never certify a legacy live mapping when its retained full evidence already
-- disagrees with the current channel row. Retire it so checkout fails closed
-- until an administrator explicitly saves a replacement mapping.
UPDATE operations_commerce_variant_pack_mappings mapping
SET projection_state = 'stale',
    is_current = false,
    effective_to = GREATEST(
      now(),
      mapping.effective_from + interval '1 microsecond'
    ),
    row_version = mapping.row_version + 1,
    updated_at = now()
WHERE mapping.is_current = true
  AND mapping.projection_state = 'current'
  AND mapping.pack_evidence_hash IS NULL;

ALTER TABLE operations_commerce_variant_pack_mappings
  DROP CONSTRAINT IF EXISTS
    operations_commerce_variant_pack_mappings_pack_evidence_hash_valid,
  ADD CONSTRAINT
    operations_commerce_variant_pack_mappings_pack_evidence_hash_valid
  CHECK (
    (
      pack_evidence_hash IS NULL
      AND NOT (is_current AND projection_state = 'current')
    )
    OR pack_evidence_hash ~ '^[a-f0-9]{64}$'
  );

CREATE OR REPLACE FUNCTION
  protect_operations_commerce_variant_pack_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.is_current
     AND OLD.projection_state = 'current'
     AND NEW.is_current
     AND NEW.projection_state = 'current'
     AND NEW.pack_evidence_hash IS DISTINCT FROM OLD.pack_evidence_hash THEN
    RAISE EXCEPTION
      'Current pack evidence is immutable; retire and create a new mapping';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_operations_commerce_variant_pack_evidence
  ON operations_commerce_variant_pack_mappings;
CREATE TRIGGER protect_operations_commerce_variant_pack_evidence
BEFORE UPDATE ON operations_commerce_variant_pack_mappings
FOR EACH ROW EXECUTE FUNCTION
  protect_operations_commerce_variant_pack_evidence();

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
     OR NEW.pack_evidence_hash
          IS DISTINCT FROM channel_state.pack_evidence_hash THEN
    RAISE EXCEPTION
      'Current variant-pack mapping must match pack-relevant channel evidence';
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

-- The receipt child guard was introduced in 0151 and intentionally remains a
-- single shared trigger function for lines, packages, allocations, attempts,
-- and offers. Replace only its legacy self-package freshness predicate. Fail
-- the migration if that known predicate is absent so a future upstream change
-- cannot silently weaken the guard.
DO $migration$
DECLARE
  current_definition text;
  revised_definition text;
BEGIN
  SELECT pg_get_functiondef(
    'protect_operations_shopify_checkout_rate_receipt_child()'::regprocedure
  ) INTO current_definition;

  revised_definition := replace(
    current_definition,
    'AND mapping.source_revision = state.source_revision
          AND mapping.source_hash = state.source_hash',
    'AND mapping.pack_evidence_hash = state.pack_evidence_hash'
  );

  IF revised_definition = current_definition THEN
    RAISE EXCEPTION
      'Expected checkout receipt child pack freshness predicate was not found';
  END IF;

  EXECUTE revised_definition;
END;
$migration$;

COMMENT ON COLUMN operations_product_channel_states.pack_evidence_hash IS
  'Physical pack readiness fingerprint: account/provider/product/variant/inventory-item identity, lifecycle, requires-shipping, and weight only.';

COMMENT ON COLUMN
  operations_commerce_variant_pack_mappings.pack_evidence_hash IS
  'Administrator-approved pack fingerprint. Full source_revision/source_hash remain catalog audit evidence and are not checkout pack readiness guards.';
