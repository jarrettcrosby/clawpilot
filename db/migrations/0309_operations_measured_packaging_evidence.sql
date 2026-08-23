-- A retained exact measurement is itself the inner- or rated-outer-dimension
-- evidence. The application stamps the confirming actor and time when it saves
-- a measured row; an operator-authored free-form reference is not required.
-- Provider and customer-confirmed facts still require their external evidence
-- reference. Legacy evidence never becomes factual carrier/rating authority.

ALTER TABLE operations_packaging_materials
  DROP CONSTRAINT IF EXISTS
    operations_packaging_materials_dimension_evidence_valid;

ALTER TABLE operations_packaging_materials
  ADD CONSTRAINT operations_packaging_materials_dimension_evidence_valid
  CHECK (
    dimension_evidence_type IN (
      'unknown', 'customer_confirmed', 'measured', 'provider', 'legacy'
    )
    AND (
      dimension_evidence_reference IS NULL
      OR length(btrim(dimension_evidence_reference)) BETWEEN 1 AND 500
    )
    AND (
      dimension_evidence_type <> 'measured'
      OR (
        inner_length_mm IS NOT NULL
        AND inner_length_mm > 0
        AND inner_width_mm IS NOT NULL
        AND inner_width_mm > 0
        AND inner_height_mm IS NOT NULL
        AND inner_height_mm > 0
        AND dimension_confirmed_at IS NOT NULL
      )
    )
    AND (
      dimension_evidence_type NOT IN ('customer_confirmed', 'provider')
      OR (
        dimension_confirmed_at IS NOT NULL
        AND dimension_evidence_reference IS NOT NULL
        AND length(btrim(dimension_evidence_reference)) BETWEEN 1 AND 500
      )
    )
  ) NOT VALID;

COMMENT ON CONSTRAINT
  operations_packaging_materials_dimension_evidence_valid
  ON operations_packaging_materials IS
  'Measured evidence requires exact positive dimensions and a retained confirmation timestamp; provider and customer-confirmed evidence additionally require a nonblank reference. Existing rows are not fabricated or backfilled.';

ALTER TABLE operations_packaging_materials
  DROP CONSTRAINT IF EXISTS
    operations_packaging_materials_rated_outer_evidence_valid;

ALTER TABLE operations_packaging_materials
  ADD CONSTRAINT operations_packaging_materials_rated_outer_evidence_valid
  CHECK (
    (
      rated_outer_length_mm IS NULL
      AND rated_outer_width_mm IS NULL
      AND rated_outer_height_mm IS NULL
      AND rated_outer_dimension_evidence_type IS NULL
      AND rated_outer_dimension_evidence_reference IS NULL
      AND rated_outer_dimension_confirmed_at IS NULL
      AND rated_outer_dimension_confirmed_by IS NULL
    )
    OR (
      rated_outer_length_mm IS NOT NULL
      AND rated_outer_length_mm > 0
      AND rated_outer_width_mm IS NOT NULL
      AND rated_outer_width_mm > 0
      AND rated_outer_height_mm IS NOT NULL
      AND rated_outer_height_mm > 0
      AND rated_outer_dimension_evidence_type IN (
        'customer_confirmed', 'measured', 'provider', 'legacy'
      )
      AND (
        rated_outer_dimension_evidence_reference IS NULL
        OR length(btrim(rated_outer_dimension_evidence_reference))
          BETWEEN 1 AND 500
      )
      AND (
        rated_outer_dimension_evidence_type = 'measured'
        OR (
          rated_outer_dimension_evidence_reference IS NOT NULL
          AND length(btrim(rated_outer_dimension_evidence_reference))
            BETWEEN 1 AND 500
        )
      )
      AND rated_outer_dimension_confirmed_at IS NOT NULL
    )
  ) NOT VALID;

COMMENT ON CONSTRAINT
  operations_packaging_materials_rated_outer_evidence_valid
  ON operations_packaging_materials IS
  'Rated outside dimensions are all absent or exact, positive, and timestamped. Measured rows may omit a redundant note; provider, customer-confirmed, and legacy rows require a nonblank reference. Existing rows are not fabricated or backfilled.';

CREATE OR REPLACE FUNCTION public.validate_operations_approved_pack_recipe()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  input_level text;
  output_level text;
  input_rank integer;
  output_rank integer;
  input_base_each_quantity integer;
  output_base_each_quantity integer;
  input_version_state text;
  output_version_state text;
  input_version_current boolean;
  output_version_current boolean;
  input_profile_status text;
  output_profile_status text;
BEGIN
  SELECT
    profile.package_level,
    version.base_each_quantity,
    version.lifecycle_state,
    version.is_current,
    profile.status
  INTO
    input_level,
    input_base_each_quantity,
    input_version_state,
    input_version_current,
    input_profile_status
  FROM public.operations_product_pack_profile_versions AS version
  JOIN public.operations_product_pack_profiles AS profile
    ON profile.id = version.profile_id
   AND profile.organization_id = version.organization_id
  WHERE version.organization_id = NEW.organization_id
    AND version.pipeline_id = NEW.pipeline_id
    AND version.product_id = NEW.product_id
    AND version.id = NEW.input_pack_profile_version_id;

  SELECT
    profile.package_level,
    version.base_each_quantity,
    version.lifecycle_state,
    version.is_current,
    profile.status
  INTO
    output_level,
    output_base_each_quantity,
    output_version_state,
    output_version_current,
    output_profile_status
  FROM public.operations_product_pack_profile_versions AS version
  JOIN public.operations_product_pack_profiles AS profile
    ON profile.id = version.profile_id
   AND profile.organization_id = version.organization_id
  WHERE version.organization_id = NEW.organization_id
    AND version.pipeline_id = NEW.pipeline_id
    AND version.product_id = NEW.product_id
    AND version.id = NEW.output_pack_profile_version_id;

  input_rank := CASE input_level
    WHEN 'each' THEN 1
    WHEN 'inner_pack' THEN 2
    WHEN 'case' THEN 3
    WHEN 'pallet' THEN 4
    ELSE 0
  END;
  output_rank := CASE output_level
    WHEN 'each' THEN 1
    WHEN 'inner_pack' THEN 2
    WHEN 'case' THEN 3
    WHEN 'pallet' THEN 4
    ELSE 0
  END;

  IF output_rank <= input_rank THEN
    RAISE EXCEPTION
      'Approved pack recipe output must be a higher packaging level than input';
  END IF;
  IF NEW.lifecycle_state = 'retired' AND NEW.is_current THEN
    RAISE EXCEPTION 'Retired pack recipes cannot be current';
  END IF;

  IF NEW.recipe_type = 'exact_case'
     AND (
       input_base_each_quantity * NEW.input_quantity
       <> output_base_each_quantity * NEW.output_quantity
     ) THEN
    RAISE EXCEPTION
      'Exact-case recipe quantities must conserve base eaches';
  END IF;

  IF NEW.lifecycle_state = 'active' THEN
    IF NEW.is_current <> true
       OR input_version_current IS DISTINCT FROM true
       OR output_version_current IS DISTINCT FROM true
       OR input_version_state <> 'active'
       OR output_version_state <> 'active'
       OR input_profile_status <> 'active'
       OR output_profile_status <> 'active' THEN
      RAISE EXCEPTION
        'Active pack recipes require exact current active input and output packs';
    END IF;

    IF NEW.fit_evidence_type = 'unknown'
       OR NEW.fit_evidence_reference IS NULL
       OR length(btrim(NEW.fit_evidence_reference)) NOT BETWEEN 1 AND 500
       OR NEW.confirmed_at IS NULL THEN
      RAISE EXCEPTION
        'Active pack recipes require confirmed fit evidence';
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM public.operations_packaging_materials AS material
      WHERE material.organization_id = NEW.organization_id
        AND material.id = NEW.packaging_material_id
        AND material.status = 'active'
        AND material.dimension_basis = 'inner'
        AND material.dimension_evidence_type <> 'unknown'
        AND (
          material.dimension_evidence_type = 'measured'
          OR length(btrim(material.dimension_evidence_reference))
            BETWEEN 1 AND 500
        )
        AND material.dimension_confirmed_at IS NOT NULL
        AND material.inner_length_mm > 0
        AND material.inner_width_mm > 0
        AND material.inner_height_mm > 0
        AND material.rated_outer_length_mm > 0
        AND material.rated_outer_width_mm > 0
        AND material.rated_outer_height_mm > 0
        AND material.rated_outer_dimension_evidence_type IN (
          'customer_confirmed', 'measured', 'provider'
        )
        AND (
          material.rated_outer_dimension_evidence_type = 'measured'
          OR length(
            btrim(material.rated_outer_dimension_evidence_reference)
          ) BETWEEN 1 AND 500
        )
        AND material.rated_outer_dimension_confirmed_at IS NOT NULL
        AND material.tare_weight_grams > 0
        AND material.max_weight_grams > material.tare_weight_grams
        AND material.unit_cost_minor > 0
        AND material.currency ~ '^[A-Z]{3}$'
    ) THEN
      RAISE EXCEPTION
        'Active pack recipes require an optimizer-ready active packaging material';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.validate_operations_approved_pack_recipe() IS
  'Retains pack-level and fit-evidence boundaries while allowing timestamped exact measured inner and rated outer material dimensions to omit a redundant free-form reference. Legacy rated-outer evidence remains fail-closed.';

-- Keep the final environment-aware CarrierService predicate from 0285, with
-- only the measured rated-outer reference rule relaxed. All exact account,
-- credential, activation-revision, warehouse, stock, carrier-origin, and
-- TEST/LIVE capability checks remain unchanged.
CREATE OR REPLACE FUNCTION
  public.operations_shopify_carrier_service_config_environment_is_ready(
    requested_organization_id uuid,
    requested_config_id uuid,
    requested_environment text
  )
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.operations_shopify_carrier_service_configs config
    JOIN public.operations_integration_accounts account
      ON account.organization_id = config.organization_id
     AND account.id = config.integration_account_id
    JOIN public.operations_commerce_credentials credential
      ON credential.organization_id = account.organization_id
     AND credential.integration_account_id = account.id
    JOIN public.operations_activation_scopes activation
      ON activation.organization_id = config.organization_id
    JOIN public.operations_warehouses warehouse
      ON warehouse.organization_id = config.organization_id
     AND warehouse.id = config.warehouse_id
    WHERE config.organization_id = requested_organization_id
      AND config.id = requested_config_id
      AND requested_environment IN ('sandbox', 'production')
      AND config.registration_state IN (
        'shadow_simulated', 'registered'
      )
      AND account.integration_type = 'commerce'
      AND account.provider = 'shopify'
      AND account.environment = 'sandbox'
      AND account.status = 'active'
      AND length(
        btrim(account.configuration ->> 'accountName')
      ) BETWEEN 1 AND 255
      AND btrim(account.configuration ->> 'accountName')
        !~ '[[:cntrl:]]'
      AND account.commerce_credential_generation
        = config.credential_generation
      AND credential.credential_version = config.credential_generation
      AND credential.verification_status = 'verified'
      AND activation.revision = config.activation_revision
      AND warehouse.status = 'active'
      AND (
        SELECT count(*)
        FROM public.operations_shopify_carrier_service_config_materials selected
        JOIN public.operations_packaging_materials material
          ON material.organization_id = selected.organization_id
         AND material.id = selected.packaging_material_id
        JOIN public.operations_packaging_material_stock stock
          ON stock.organization_id = material.organization_id
         AND stock.packaging_material_id = material.id
         AND stock.warehouse_id = config.warehouse_id
        WHERE selected.organization_id = config.organization_id
          AND selected.config_id = config.id
          AND material.status = 'active'
          AND material.row_version
            = selected.packaging_material_row_version
          AND material.rated_outer_length_mm > 0
          AND material.rated_outer_width_mm > 0
          AND material.rated_outer_height_mm > 0
          AND material.rated_outer_dimension_evidence_type IN (
            'customer_confirmed', 'measured', 'provider'
          )
          AND (
            material.rated_outer_dimension_evidence_type = 'measured'
            OR length(
              btrim(material.rated_outer_dimension_evidence_reference)
            ) BETWEEN 1 AND 500
          )
          AND material.rated_outer_dimension_confirmed_at IS NOT NULL
          AND stock.is_available = true
          AND stock.on_hand_quantity > 0
      ) = (
        SELECT count(*)
        FROM public.operations_shopify_carrier_service_config_materials selected
        WHERE selected.organization_id = config.organization_id
          AND selected.config_id = config.id
      )
      AND (
        SELECT count(*)
        FROM public.operations_shopify_carrier_service_config_materials selected
        WHERE selected.organization_id = config.organization_id
          AND selected.config_id = config.id
      ) BETWEEN 1 AND 8
      AND (
        SELECT count(*)
        FROM public.operations_shopify_carrier_service_config_carriers selected
        JOIN public.operations_carrier_accounts carrier_account
          ON carrier_account.organization_id = selected.organization_id
         AND carrier_account.id = selected.carrier_account_id
        JOIN public.operations_integration_accounts carrier_integration
          ON carrier_integration.organization_id
            = carrier_account.organization_id
         AND carrier_integration.id
            = carrier_account.integration_account_id
        JOIN public.operations_carrier_credentials carrier_credential
          ON carrier_credential.organization_id
            = carrier_integration.organization_id
         AND carrier_credential.integration_account_id
            = carrier_integration.id
        WHERE selected.organization_id = config.organization_id
          AND selected.config_id = config.id
          AND carrier_account.status = 'active'
          AND lower(regexp_replace(
            btrim(carrier_account.registered_address ->> 'line1'),
            '[[:space:]]+', ' ', 'g'
          )) = lower(regexp_replace(
            btrim(COALESCE(
              warehouse.address ->> 'line1',
              warehouse.address ->> 'address1'
            )),
            '[[:space:]]+', ' ', 'g'
          ))
          AND lower(regexp_replace(
            btrim(COALESCE(
              carrier_account.registered_address ->> 'line2', ''
            )),
            '[[:space:]]+', ' ', 'g'
          )) = lower(regexp_replace(
            btrim(COALESCE(
              warehouse.address ->> 'line2',
              warehouse.address ->> 'address2',
              ''
            )),
            '[[:space:]]+', ' ', 'g'
          ))
          AND lower(regexp_replace(
            btrim(carrier_account.registered_address ->> 'city'),
            '[[:space:]]+', ' ', 'g'
          )) = lower(regexp_replace(
            btrim(warehouse.address ->> 'city'),
            '[[:space:]]+', ' ', 'g'
          ))
          AND lower(regexp_replace(
            btrim(carrier_account.registered_address ->> 'region'),
            '[[:space:]]+', ' ', 'g'
          )) = lower(regexp_replace(
            btrim(COALESCE(
              warehouse.address ->> 'regionCode',
              warehouse.address ->> 'region',
              warehouse.address ->> 'state'
            )),
            '[[:space:]]+', ' ', 'g'
          ))
          AND lower(regexp_replace(
            btrim(carrier_account.registered_address ->> 'postalCode'),
            '[[:space:]-]', '', 'g'
          )) = lower(regexp_replace(
            btrim(COALESCE(
              warehouse.address ->> 'postalCode',
              warehouse.address ->> 'zip'
            )),
            '[[:space:]-]', '', 'g'
          ))
          AND upper(btrim(
            carrier_account.registered_address ->> 'countryCode'
          )) = upper(btrim(COALESCE(
            warehouse.address ->> 'countryCode',
            warehouse.address ->> 'country'
          )))
          AND carrier_account.allow_sender_billing = true
          AND carrier_integration.status = 'active'
          AND carrier_integration.integration_type = 'carrier'
          AND carrier_integration.provider = selected.carrier_provider
          AND carrier_integration.provider IN ('ups_rest', 'fedex_rest')
          AND carrier_integration.environment = requested_environment
          AND public.operations_shopify_carrier_configuration_allows_rating(
            carrier_integration.configuration,
            requested_environment
          )
          AND carrier_credential.verification_status = 'verified'
      ) = (
        SELECT count(*)
        FROM public.operations_shopify_carrier_service_config_carriers selected
        JOIN public.operations_carrier_accounts carrier_account
          ON carrier_account.organization_id = selected.organization_id
         AND carrier_account.id = selected.carrier_account_id
        JOIN public.operations_integration_accounts carrier_integration
          ON carrier_integration.organization_id
            = carrier_account.organization_id
         AND carrier_integration.id
            = carrier_account.integration_account_id
        WHERE selected.organization_id = config.organization_id
          AND selected.config_id = config.id
          AND carrier_integration.environment = requested_environment
      )
      AND (
        SELECT count(*)
        FROM public.operations_shopify_carrier_service_config_carriers selected
        JOIN public.operations_carrier_accounts carrier_account
          ON carrier_account.organization_id = selected.organization_id
         AND carrier_account.id = selected.carrier_account_id
        JOIN public.operations_integration_accounts carrier_integration
          ON carrier_integration.organization_id
            = carrier_account.organization_id
         AND carrier_integration.id
            = carrier_account.integration_account_id
        WHERE selected.organization_id = config.organization_id
          AND selected.config_id = config.id
          AND carrier_integration.environment = requested_environment
      ) BETWEEN 1 AND 8
      AND (
        SELECT count(*)
        FROM public.operations_shopify_carrier_service_config_carriers selected
        WHERE selected.organization_id = config.organization_id
          AND selected.config_id = config.id
      ) BETWEEN 1 AND 16
  )
$$;

COMMENT ON FUNCTION
  public.operations_shopify_carrier_service_config_environment_is_ready(
    uuid, uuid, text
  ) IS
  'Returns true only when the sandbox Shopify store, exact activation revision, warehouse, current packaging stock, factual rated exterior evidence, and one through eight selected unique verified direct UPS/FedEx accounts with matching warehouse origins and the requested TEST or LIVE rating capability are ready. Exact timestamped measured exteriors do not require a redundant note; legacy evidence remains ineligible.';

-- Migration 0299 cloned the configuration predicate for checkout-rating
-- runtime isolation. Refresh that clone from the exact 0309 definition so a
-- measured exterior without a note behaves identically during callback
-- readiness. Preserve 0299's deliberate store-environment and activation-
-- revision decoupling; no carrier, stock, current-row, or capability fence is
-- changed here.
DO $$
DECLARE
  definition text;
  prior text;
  needle text;
  occurrence_count integer;
BEGIN
  SELECT pg_catalog.pg_get_functiondef(
    'public.operations_shopify_carrier_service_config_environment_is_ready(uuid,uuid,text)'::pg_catalog.regprocedure
  ) INTO definition;

  needle := 'operations_shopify_carrier_service_config_environment_is_ready';
  occurrence_count := (
    pg_catalog.length(definition)
      - pg_catalog.length(pg_catalog.replace(definition, needle, ''))
  ) / pg_catalog.length(needle);
  IF occurrence_count <> 1 THEN
    RAISE EXCEPTION
      'Expected one Shopify config environment readiness symbol, found %',
      occurrence_count;
  END IF;
  prior := definition;
  definition := pg_catalog.replace(
    definition,
    needle,
    'operations_shopify_carrier_service_rating_environment_is_ready'
  );
  IF definition = prior THEN
    RAISE EXCEPTION
      'Unable to refresh Shopify rating environment readiness';
  END IF;

  needle := 'AND account.environment = ''sandbox''';
  occurrence_count := (
    pg_catalog.length(definition)
      - pg_catalog.length(pg_catalog.replace(definition, needle, ''))
  ) / pg_catalog.length(needle);
  IF occurrence_count <> 1 THEN
    RAISE EXCEPTION
      'Expected one Shopify account environment fence, found %',
      occurrence_count;
  END IF;
  prior := definition;
  definition := pg_catalog.replace(
    definition,
    needle,
    'AND account.environment IN (''sandbox'', ''production'')'
  );
  IF definition = prior THEN
    RAISE EXCEPTION
      'Unable to preserve Shopify rating store-environment behavior';
  END IF;

  needle := 'AND activation.revision = config.activation_revision';
  occurrence_count := (
    pg_catalog.length(definition)
      - pg_catalog.length(pg_catalog.replace(definition, needle, ''))
  ) / pg_catalog.length(needle);
  IF occurrence_count <> 1 THEN
    RAISE EXCEPTION
      'Expected one activation revision fence, found %',
      occurrence_count;
  END IF;
  prior := definition;
  definition := pg_catalog.replace(
    definition,
    needle,
    'AND activation.state IN (''disabled'', ''shadow'', ''read_only'', ''active'', ''frozen'')'
  );
  IF definition = prior THEN
    RAISE EXCEPTION
      'Unable to preserve Shopify rating activation behavior';
  END IF;

  EXECUTE definition;
END;
$$;

COMMENT ON FUNCTION
  public.operations_shopify_carrier_service_rating_environment_is_ready(
    uuid, uuid, text
  ) IS
  'Preserves the account-level checkout rating lane from 0299 while accepting exact timestamped measured exterior dimensions without a redundant note. Current material rows, positive stock, verified carriers, matching origins, and TEST/LIVE capabilities remain mandatory; legacy exterior evidence remains ineligible.';
