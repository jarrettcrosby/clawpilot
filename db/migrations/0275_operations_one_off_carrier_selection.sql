-- Exact small-parcel carrier account and package-code selection for one-off
-- quotes.
--
-- Existing one-off quote, evidence, and offer rows remain valid with the new
-- columns NULL. A writer that adopts this contract must retain one complete,
-- canonical selection tuple for each requested small-parcel source. The snapshot
-- is immutable evidence for both the initial quote and a later packed rerate;
-- this migration performs no provider write and does not infer package codes.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION operations_one_off_carrier_selection_key(
  input_provider text,
  input_integration_global_id text,
  input_carrier_global_id text,
  input_credential_version integer
)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT input_provider || ':' || input_integration_global_id || ':'
    || COALESCE(input_carrier_global_id, 'none') || ':v'
    || input_credential_version::text
$$;

COMMENT ON FUNCTION operations_one_off_carrier_selection_key(
  text, text, text, integer
) IS
  'Builds the stable exact identity of one small-parcel provider, integration account, optional direct carrier account, and credential version selection.';

ALTER TABLE operations_one_off_shipment_quotes
  ADD COLUMN IF NOT EXISTS required_carrier_selections jsonb,
  ADD COLUMN IF NOT EXISTS carrier_selection_results_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS carrier_selection_schema_version smallint;

-- Existing rows keep NULL. The INSERT trigger below installs v1 only for a new
-- exact small-parcel quote, so existing LTL and mixed-mode writers remain out
-- of this additive contract.
ALTER TABLE operations_one_off_shipment_quotes
  ALTER COLUMN carrier_selection_schema_version DROP DEFAULT;

ALTER TABLE operations_carrier_rate_requests
  ADD COLUMN IF NOT EXISTS carrier_selection_key text;

ALTER TABLE operations_one_off_shipment_quote_offers
  ADD COLUMN IF NOT EXISTS carrier_selection_key text;

CREATE OR REPLACE FUNCTION operations_one_off_package_code_matches_catalog(
  input_catalog_version text,
  input_catalog_entry_id text,
  input_provider text,
  input_provider_package_code text
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
STRICT
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM (VALUES
      -- Canonical customer-supplied package forms intentionally use each
      -- adapter's customer-packaging code.
      ('operations.package_catalog.v1', 'box', 'ups_rest', '02'),
      ('operations.package_catalog.v1', 'box', 'fedex_rest', 'YOUR_PACKAGING'),
      ('operations.package_catalog.v1', 'box', 'wwex_speedship', '02'),
      ('operations.package_catalog.v1', 'envelope', 'ups_rest', '02'),
      ('operations.package_catalog.v1', 'envelope', 'fedex_rest', 'YOUR_PACKAGING'),
      ('operations.package_catalog.v1', 'envelope', 'wwex_speedship', '02'),
      ('operations.package_catalog.v1', 'tube', 'ups_rest', '02'),
      ('operations.package_catalog.v1', 'tube', 'fedex_rest', 'YOUR_PACKAGING'),
      ('operations.package_catalog.v1', 'tube', 'wwex_speedship', '02'),
      ('operations.package_catalog.v1', 'crate', 'ups_rest', '02'),
      ('operations.package_catalog.v1', 'crate', 'fedex_rest', 'YOUR_PACKAGING'),
      ('operations.package_catalog.v1', 'crate', 'wwex_speedship', '02'),
      ('operations.package_catalog.v1', 'custom', 'ups_rest', '02'),
      ('operations.package_catalog.v1', 'custom', 'fedex_rest', 'YOUR_PACKAGING'),
      ('operations.package_catalog.v1', 'custom', 'wwex_speedship', '02'),

      ('operations.package_catalog.v1', 'ups_letter_01', 'ups_rest', '01'),
      ('operations.package_catalog.v1', 'ups_customer_supplied_02', 'ups_rest', '02'),
      ('operations.package_catalog.v1', 'ups_tube_03', 'ups_rest', '03'),
      ('operations.package_catalog.v1', 'ups_pak_04', 'ups_rest', '04'),
      ('operations.package_catalog.v1', 'ups_express_box_21', 'ups_rest', '21'),
      ('operations.package_catalog.v1', 'ups_25kg_box_24', 'ups_rest', '24'),
      ('operations.package_catalog.v1', 'ups_10kg_box_25', 'ups_rest', '25'),
      ('operations.package_catalog.v1', 'ups_express_box_small_2a', 'ups_rest', '2a'),
      ('operations.package_catalog.v1', 'ups_express_box_medium_2b', 'ups_rest', '2b'),
      ('operations.package_catalog.v1', 'ups_express_box_large_2c', 'ups_rest', '2c'),

      ('operations.package_catalog.v1', 'fedex_your_packaging', 'fedex_rest', 'YOUR_PACKAGING'),
      ('operations.package_catalog.v1', 'fedex_envelope', 'fedex_rest', 'FEDEX_ENVELOPE'),
      ('operations.package_catalog.v1', 'fedex_box', 'fedex_rest', 'FEDEX_BOX'),
      ('operations.package_catalog.v1', 'fedex_extra_small_box', 'fedex_rest', 'FEDEX_EXTRA_SMALL_BOX'),
      ('operations.package_catalog.v1', 'fedex_small_box', 'fedex_rest', 'FEDEX_SMALL_BOX'),
      ('operations.package_catalog.v1', 'fedex_medium_box', 'fedex_rest', 'FEDEX_MEDIUM_BOX'),
      ('operations.package_catalog.v1', 'fedex_large_box', 'fedex_rest', 'FEDEX_LARGE_BOX'),
      ('operations.package_catalog.v1', 'fedex_extra_large_box', 'fedex_rest', 'FEDEX_EXTRA_LARGE_BOX'),
      ('operations.package_catalog.v1', 'fedex_10kg_box', 'fedex_rest', 'FEDEX_10KG_BOX'),
      ('operations.package_catalog.v1', 'fedex_25kg_box', 'fedex_rest', 'FEDEX_25KG_BOX'),
      ('operations.package_catalog.v1', 'fedex_pak', 'fedex_rest', 'FEDEX_PAK'),
      ('operations.package_catalog.v1', 'fedex_tube', 'fedex_rest', 'FEDEX_TUBE'),

      ('operations.package_catalog.v1', 'wwex_ups_express_envelope_01', 'wwex_speedship', '01'),
      ('operations.package_catalog.v1', 'wwex_custom_02', 'wwex_speedship', '02'),
      ('operations.package_catalog.v1', 'wwex_ups_express_tube_03', 'wwex_speedship', '03'),
      ('operations.package_catalog.v1', 'wwex_ups_express_pak_04', 'wwex_speedship', '04'),
      ('operations.package_catalog.v1', 'wwex_ups_express_box_21', 'wwex_speedship', '21'),
      ('operations.package_catalog.v1', 'wwex_ups_25kg_box_24', 'wwex_speedship', '24'),
      ('operations.package_catalog.v1', 'wwex_ups_10kg_box_25', 'wwex_speedship', '25'),
      ('operations.package_catalog.v1', 'wwex_ups_express_box_small_2a', 'wwex_speedship', '2a'),
      ('operations.package_catalog.v1', 'wwex_ups_express_box_medium_2b', 'wwex_speedship', '2b'),
      ('operations.package_catalog.v1', 'wwex_ups_express_box_large_2c', 'wwex_speedship', '2c')
    ) mapping(
      catalog_version,
      catalog_entry_id,
      provider,
      provider_package_code
    )
    WHERE mapping.catalog_version = input_catalog_version
      AND mapping.catalog_entry_id = input_catalog_entry_id
      AND mapping.provider = input_provider
      AND mapping.provider_package_code = input_provider_package_code
  )
$$;

COMMENT ON FUNCTION operations_one_off_package_code_matches_catalog(
  text, text, text, text
) IS
  'Exact immutable package-catalog-v1 small-parcel entry/provider/code authority; prevents an allowed adapter code from being substituted for a different catalog entry.';

CREATE OR REPLACE FUNCTION operations_one_off_rate_codes_match_selection(
  input_provider text,
  input_selection jsonb,
  input_packages jsonb,
  input_redacted_request jsonb
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
STRICT
AS $$
DECLARE
  evidence_packages jsonb;
BEGIN
  IF jsonb_typeof(input_selection) IS DISTINCT FROM 'object'
     OR jsonb_typeof(input_selection->'packageCodes')
       IS DISTINCT FROM 'array'
     OR jsonb_typeof(input_packages) IS DISTINCT FROM 'array'
     OR jsonb_typeof(input_redacted_request) IS DISTINCT FROM 'object'
  THEN
    RETURN false;
  END IF;

  IF input_provider IN ('ups_rest', 'fedex_rest') THEN
    evidence_packages := input_redacted_request #> '{shipment,parcels}';
    IF jsonb_typeof(evidence_packages) IS DISTINCT FROM 'array'
       OR jsonb_array_length(evidence_packages)
         IS DISTINCT FROM jsonb_array_length(input_packages)
    THEN
      RETURN false;
    END IF;

    RETURN NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(input_packages) WITH ORDINALITY
        package_row(value, ordinality)
      LEFT JOIN jsonb_array_elements(input_selection->'packageCodes')
        selected_code
        ON selected_code->>'packageKey' = package_row.value->>'packageKey'
      WHERE jsonb_typeof(
              evidence_packages->((package_row.ordinality - 1)::integer)
            ) IS DISTINCT FROM 'object'
         OR evidence_packages
              ->((package_row.ordinality - 1)::integer)
              ->>'packageCode'
            IS DISTINCT FROM selected_code->>'providerPackageCode'
    );
  ELSIF input_provider = 'wwex_speedship' THEN
    evidence_packages := input_redacted_request->'handlingUnits';
    IF jsonb_typeof(evidence_packages) IS DISTINCT FROM 'array'
       OR jsonb_array_length(evidence_packages)
         IS DISTINCT FROM jsonb_array_length(input_packages)
       OR input_redacted_request->>'handlingUnitCount'
         IS DISTINCT FROM jsonb_array_length(input_packages)::text
       OR jsonb_array_length(evidence_packages) IS DISTINCT FROM (
         SELECT count(DISTINCT evidence_package->>'packageKey')::integer
         FROM jsonb_array_elements(evidence_packages) evidence_package
       )
    THEN
      RETURN false;
    END IF;

    RETURN NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(input_packages) WITH ORDINALITY
        package_row(value, ordinality)
      LEFT JOIN jsonb_array_elements(input_selection->'packageCodes')
        selected_code
        ON selected_code->>'packageKey' = package_row.value->>'packageKey'
      WHERE jsonb_typeof(
              evidence_packages->((package_row.ordinality - 1)::integer)
            ) IS DISTINCT FROM 'object'
         OR evidence_packages
              ->((package_row.ordinality - 1)::integer)
              ->>'packageKey'
            IS DISTINCT FROM package_row.value->>'packageKey'
         OR evidence_packages
              ->((package_row.ordinality - 1)::integer)
              ->>'packagingType'
            IS DISTINCT FROM selected_code->>'providerPackageCode'
    );
  END IF;

  RETURN false;
END;
$$;

COMMENT ON FUNCTION operations_one_off_rate_codes_match_selection(
  text, jsonb, jsonb, jsonb
) IS
  'Proves that retained direct or WWEX provider-read evidence used every exact package code from its immutable quote selection without substitution.';

CREATE OR REPLACE FUNCTION operations_one_off_carrier_selections_are_valid(
  input_selections jsonb,
  input_results jsonb,
  input_packages jsonb,
  input_providers text[],
  input_transport_sources text[]
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  selection jsonb;
  result_row jsonb;
  selection_provider text;
  selection_key text;
  integration_global_id text;
  carrier_global_id text;
  credential_version_text text;
  provider_rank integer;
  prior_provider_rank integer := 0;
  selection_keys text[] := ARRAY[]::text[];
  projected_providers text[] := ARRAY[]::text[];
  package_codes jsonb;
  expected_package_count integer;
  result_offer_count_text text;
BEGIN
  IF jsonb_typeof(input_selections) IS DISTINCT FROM 'array'
     OR jsonb_array_length(input_selections) NOT BETWEEN 1 AND 3
     OR jsonb_typeof(input_results) IS DISTINCT FROM 'object'
     OR jsonb_typeof(input_packages) IS DISTINCT FROM 'array'
     OR jsonb_array_length(input_packages) NOT BETWEEN 1 AND 50
     OR input_providers IS NULL
  THEN
    RETURN false;
  END IF;

  expected_package_count := jsonb_array_length(input_packages);

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(input_packages) package_row
    WHERE jsonb_typeof(package_row) IS DISTINCT FROM 'object'
      OR jsonb_typeof(package_row->'packageKey') IS DISTINCT FROM 'string'
      OR length(btrim(package_row->>'packageKey')) NOT BETWEEN 1 AND 80
      OR package_row->>'packageKey'
        !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'
      OR jsonb_typeof(package_row->'packageProfile')
        IS DISTINCT FROM 'object'
      OR jsonb_typeof(package_row->'packageProfile'->'catalogEntryId')
        IS DISTINCT FROM 'string'
      OR length(btrim(
        package_row->'packageProfile'->>'catalogEntryId'
      )) NOT BETWEEN 1 AND 120
      OR jsonb_typeof(package_row->'packageProfile'->'contractVersion')
        IS DISTINCT FROM 'string'
      OR length(btrim(
        package_row->'packageProfile'->>'contractVersion'
      )) NOT BETWEEN 1 AND 120
  ) OR (
    SELECT count(*)
    FROM jsonb_array_elements(input_packages)
  ) IS DISTINCT FROM (
    SELECT count(DISTINCT package_row->>'packageKey')
    FROM jsonb_array_elements(input_packages) package_row
  ) THEN
    RETURN false;
  END IF;

  FOR selection IN
    SELECT value
    FROM jsonb_array_elements(input_selections) WITH ORDINALITY
      selection_row(value, ordinality)
    ORDER BY ordinality
  LOOP
    IF jsonb_typeof(selection) IS DISTINCT FROM 'object'
       OR (
         SELECT array_agg(selection_field ORDER BY selection_field)
         FROM jsonb_object_keys(selection) selection_field
       ) IS DISTINCT FROM ARRAY[
         'carrierAccountGlobalId',
         'credentialVersion',
         'integrationAccountGlobalId',
         'packageCodes',
         'provider',
         'selectionKey'
       ]::text[]
       OR jsonb_typeof(selection->'provider') IS DISTINCT FROM 'string'
       OR jsonb_typeof(selection->'selectionKey') IS DISTINCT FROM 'string'
       OR jsonb_typeof(selection->'integrationAccountGlobalId')
         IS DISTINCT FROM 'string'
       OR jsonb_typeof(selection->'credentialVersion')
         IS DISTINCT FROM 'number'
       OR jsonb_typeof(selection->'packageCodes') IS DISTINCT FROM 'array'
    THEN
      RETURN false;
    END IF;

    selection_provider := selection->>'provider';
    selection_key := selection->>'selectionKey';
    integration_global_id := selection->>'integrationAccountGlobalId';
    carrier_global_id := selection->>'carrierAccountGlobalId';
    credential_version_text := selection->>'credentialVersion';
    package_codes := selection->'packageCodes';

    provider_rank := CASE selection_provider
      WHEN 'ups_rest' THEN 1
      WHEN 'fedex_rest' THEN 2
      WHEN 'wwex_speedship' THEN 3
      ELSE NULL
    END;
    IF provider_rank IS NULL
       OR provider_rank <= prior_provider_rank
       OR integration_global_id
         !~ '^gia(?:[0-9]{7}|[0-9a-v]{12})$'
       OR (
         selection_provider IN ('ups_rest', 'fedex_rest')
         AND (
           jsonb_typeof(selection->'carrierAccountGlobalId')
             IS DISTINCT FROM 'string'
           OR carrier_global_id
             !~ '^gac(?:[0-9]{7}|[0-9a-v]{12})$'
         )
       )
       OR (
         selection_provider = 'wwex_speedship'
         AND selection->'carrierAccountGlobalId' <> 'null'::jsonb
       )
       OR credential_version_text !~ '^[1-9][0-9]{0,9}$'
       OR credential_version_text::numeric > 2147483647
       OR length(selection_key) NOT BETWEEN 1 AND 255
       OR selection_key ~ '[[:cntrl:]]'
       OR selection_key IS DISTINCT FROM
          operations_one_off_carrier_selection_key(
            selection_provider,
            integration_global_id,
            carrier_global_id,
            credential_version_text::integer
          )
       OR jsonb_array_length(package_codes) IS DISTINCT FROM
          expected_package_count
       OR package_codes IS DISTINCT FROM (
         SELECT COALESCE(
           jsonb_agg(code_row ORDER BY code_row->>'packageKey' COLLATE "C"),
           '[]'::jsonb
         )
         FROM jsonb_array_elements(package_codes) code_row
       )
    THEN
      RETURN false;
    END IF;
    prior_provider_rank := provider_rank;

    IF EXISTS (
      SELECT 1
      FROM jsonb_array_elements(package_codes) code_row
      WHERE jsonb_typeof(code_row) IS DISTINCT FROM 'object'
        OR (
          SELECT array_agg(code_field ORDER BY code_field)
          FROM jsonb_object_keys(code_row) code_field
        ) IS DISTINCT FROM ARRAY[
          'catalogEntryId',
          'catalogVersion',
          'packageKey',
          'providerPackageCode'
        ]::text[]
        OR jsonb_typeof(code_row->'packageKey') IS DISTINCT FROM 'string'
        OR jsonb_typeof(code_row->'catalogEntryId')
          IS DISTINCT FROM 'string'
        OR jsonb_typeof(code_row->'catalogVersion')
          IS DISTINCT FROM 'string'
        OR jsonb_typeof(code_row->'providerPackageCode')
          IS DISTINCT FROM 'string'
        OR length(btrim(code_row->>'packageKey')) NOT BETWEEN 1 AND 80
        OR code_row->>'packageKey'
          !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'
        OR length(btrim(code_row->>'catalogEntryId')) NOT BETWEEN 1 AND 120
        OR length(btrim(code_row->>'catalogVersion')) NOT BETWEEN 1 AND 120
        OR length(btrim(code_row->>'providerPackageCode'))
          NOT BETWEEN 1 AND 128
        OR code_row->>'providerPackageCode' ~ '[[:cntrl:]]'
        OR code_row->>'catalogVersion'
          <> 'operations.package_catalog.v1'
        OR NOT operations_one_off_package_code_matches_catalog(
          code_row->>'catalogVersion',
          code_row->>'catalogEntryId',
          selection_provider,
          code_row->>'providerPackageCode'
        )
        OR (
          selection_provider = 'ups_rest'
          AND code_row->>'providerPackageCode' NOT IN (
            '01', '02', '03', '04', '21', '24', '25',
            '2a', '2b', '2c'
          )
        )
        OR (
          selection_provider = 'fedex_rest'
          AND code_row->>'providerPackageCode' NOT IN (
            'YOUR_PACKAGING',
            'FEDEX_ENVELOPE',
            'FEDEX_BOX',
            'FEDEX_EXTRA_SMALL_BOX',
            'FEDEX_SMALL_BOX',
            'FEDEX_MEDIUM_BOX',
            'FEDEX_LARGE_BOX',
            'FEDEX_EXTRA_LARGE_BOX',
            'FEDEX_10KG_BOX',
            'FEDEX_25KG_BOX',
            'FEDEX_PAK',
            'FEDEX_TUBE'
          )
        )
        OR (
          selection_provider = 'wwex_speedship'
          AND code_row->>'providerPackageCode' NOT IN (
            '01', '02', '03', '04', '21', '24', '25',
            '2a', '2b', '2c'
          )
        )
    ) OR (
      SELECT count(*)
      FROM jsonb_array_elements(package_codes)
    ) IS DISTINCT FROM (
      SELECT count(DISTINCT code_row->>'packageKey')
      FROM jsonb_array_elements(package_codes) code_row
    ) OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(input_packages) package_row
      WHERE NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(package_codes) code_row
        WHERE code_row->>'packageKey' = package_row->>'packageKey'
          AND code_row->>'catalogEntryId'
            = package_row->'packageProfile'->>'catalogEntryId'
          AND code_row->>'catalogVersion'
            = package_row->'packageProfile'->>'contractVersion'
      )
    ) OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(package_codes) code_row
      WHERE NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(input_packages) package_row
        WHERE package_row->>'packageKey' = code_row->>'packageKey'
      )
    ) THEN
      RETURN false;
    END IF;

    result_row := input_results->selection_key;
    IF jsonb_typeof(result_row) IS DISTINCT FROM 'object'
       OR (
         SELECT array_agg(result_field ORDER BY result_field)
         FROM jsonb_object_keys(result_row) result_field
       ) IS DISTINCT FROM ARRAY[
         'eligibleOfferCount',
         'errorCode',
         'status'
       ]::text[]
       OR jsonb_typeof(result_row->'status') IS DISTINCT FROM 'string'
       OR result_row->>'status' NOT IN ('succeeded', 'failed')
       OR jsonb_typeof(result_row->'eligibleOfferCount')
         IS DISTINCT FROM 'number'
       OR jsonb_typeof(result_row->'errorCode')
         NOT IN ('null', 'string')
    THEN
      RETURN false;
    END IF;
    result_offer_count_text := result_row->>'eligibleOfferCount';
    IF result_offer_count_text !~ '^(0|[1-9][0-9]{0,8})$'
       OR (
         result_row->>'status' = 'succeeded'
         AND result_offer_count_text::integer < 1
       )
       OR (
         result_row->>'status' = 'failed'
         AND result_offer_count_text::integer <> 0
       )
       OR (
         result_row->>'status' = 'succeeded'
         AND result_row->'errorCode' <> 'null'::jsonb
       )
       OR (
         result_row->>'status' = 'failed'
         AND (
           jsonb_typeof(result_row->'errorCode') <> 'string'
           OR length(btrim(result_row->>'errorCode')) NOT BETWEEN 1 AND 160
           OR result_row->>'errorCode' ~ '[[:cntrl:]]'
         )
       )
    THEN
      RETURN false;
    END IF;

    projected_providers := array_append(
      projected_providers,
      selection_provider
    );
    selection_keys := array_append(selection_keys, selection_key);
  END LOOP;

  IF projected_providers IS DISTINCT FROM input_providers
     OR input_transport_sources IS NULL
     OR input_transport_sources IS DISTINCT FROM ARRAY(
       SELECT provider || ':small_parcel'
       FROM unnest(projected_providers) provider
     )
     OR cardinality(selection_keys) IS DISTINCT FROM (
       SELECT count(DISTINCT value)::integer
       FROM unnest(selection_keys) value
     )
     OR (
       SELECT count(*)::integer
       FROM jsonb_object_keys(input_results)
     ) IS DISTINCT FROM cardinality(selection_keys)
     OR EXISTS (
       SELECT 1
       FROM jsonb_object_keys(input_results) result_key
       WHERE NOT result_key = ANY(selection_keys)
     )
  THEN
    RETURN false;
  END IF;

  RETURN true;
EXCEPTION
  WHEN data_exception OR numeric_value_out_of_range THEN
    RETURN false;
END;
$$;

COMMENT ON FUNCTION operations_one_off_carrier_selections_are_valid(
  jsonb, jsonb, jsonb, text[], text[]
) IS
  'Validates canonical UPS/FedEx/WWEX small-parcel selection/result key sets and exact per-package public adapter-code coverage.';

ALTER TABLE operations_one_off_shipment_quotes
  DROP CONSTRAINT IF EXISTS operations_one_off_quote_selection_complete,
  ADD CONSTRAINT operations_one_off_quote_selection_complete CHECK (
    (
      carrier_selection_schema_version IS NULL
      AND required_carrier_selections IS NULL
      AND carrier_selection_results_snapshot IS NULL
    ) OR (
      carrier_selection_schema_version = 1
      AND required_carrier_selections IS NOT NULL
      AND carrier_selection_results_snapshot IS NOT NULL
      AND operations_one_off_carrier_selections_are_valid(
        required_carrier_selections,
        carrier_selection_results_snapshot,
        packages_snapshot,
        required_carrier_providers,
        required_transport_sources
      )
    )
  ) NOT VALID;

ALTER TABLE operations_one_off_shipment_quotes
  VALIDATE CONSTRAINT operations_one_off_quote_selection_complete;

ALTER TABLE operations_carrier_rate_requests
  DROP CONSTRAINT IF EXISTS operations_carrier_rate_selection_key_valid,
  ADD CONSTRAINT operations_carrier_rate_selection_key_valid CHECK (
    carrier_selection_key IS NULL
    OR (
      length(carrier_selection_key) BETWEEN 1 AND 255
      AND carrier_selection_key !~ '[[:cntrl:]]'
    )
  ) NOT VALID;

ALTER TABLE operations_carrier_rate_requests
  VALIDATE CONSTRAINT operations_carrier_rate_selection_key_valid;

ALTER TABLE operations_one_off_shipment_quote_offers
  DROP CONSTRAINT IF EXISTS operations_one_off_offer_selection_key_valid,
  ADD CONSTRAINT operations_one_off_offer_selection_key_valid CHECK (
    carrier_selection_key IS NULL
    OR (
      length(carrier_selection_key) BETWEEN 1 AND 255
      AND carrier_selection_key !~ '[[:cntrl:]]'
    )
  ) NOT VALID;

ALTER TABLE operations_one_off_shipment_quote_offers
  VALIDATE CONSTRAINT operations_one_off_offer_selection_key_valid;

CREATE OR REPLACE FUNCTION validate_one_off_quote_carrier_selections()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  selection jsonb;
  exact_small_parcel boolean;
BEGIN
  exact_small_parcel := NEW.required_carrier_providers <@ ARRAY[
      'ups_rest', 'fedex_rest', 'wwex_speedship'
    ]::text[]
    AND (
      NEW.required_transport_sources IS NULL
      OR NEW.required_transport_sources <@ ARRAY[
        'ups_rest:small_parcel',
        'fedex_rest:small_parcel',
        'wwex_speedship:small_parcel'
      ]::text[]
    );

  IF TG_OP = 'INSERT' AND exact_small_parcel THEN
    NEW.carrier_selection_schema_version := 1;
    IF NEW.required_carrier_selections IS NULL
       OR NEW.carrier_selection_results_snapshot IS NULL
    THEN
      RAISE EXCEPTION
        'New small-parcel one-off quotes require exact carrier-selection schema v1';
    END IF;
  ELSIF TG_OP = 'INSERT' AND (
       NEW.carrier_selection_schema_version IS NOT NULL
       OR NEW.required_carrier_selections IS NOT NULL
       OR NEW.carrier_selection_results_snapshot IS NOT NULL
     )
  THEN
    RAISE EXCEPTION
      'Carrier-selection schema v1 is limited to exact small-parcel quotes';
  ELSIF TG_OP = 'UPDATE' AND (
       NEW.carrier_selection_schema_version IS DISTINCT FROM 1
       OR NEW.required_carrier_selections IS NULL
       OR NEW.carrier_selection_results_snapshot IS NULL
     )
     AND exact_small_parcel
  THEN
    RAISE EXCEPTION
      'Small-parcel one-off quotes require exact carrier-selection schema v1';
  END IF;

  IF NEW.required_carrier_selections IS NULL THEN
    RETURN NEW;
  END IF;

  FOR selection IN
    SELECT value
    FROM jsonb_array_elements(NEW.required_carrier_selections)
  LOOP
    IF selection->>'provider' IN ('ups_rest', 'fedex_rest') THEN
      PERFORM 1
        FROM operations_integration_accounts integration
        JOIN operations_carrier_accounts carrier_account
          ON carrier_account.organization_id = integration.organization_id
         AND carrier_account.integration_account_id = integration.id
        JOIN operations_carrier_credentials credential
          ON credential.organization_id = integration.organization_id
         AND credential.integration_account_id = integration.id
        WHERE integration.organization_id = NEW.organization_id
          AND integration.global_id
            = selection->>'integrationAccountGlobalId'
          AND integration.integration_type = 'carrier'
          AND integration.provider = selection->>'provider'
          AND integration.environment = NEW.rate_environment
          AND integration.status = 'active'
          AND carrier_account.global_id
            = selection->>'carrierAccountGlobalId'
          AND carrier_account.status = 'active'
          AND credential.credential_version::text
            = selection->>'credentialVersion'
          AND credential.verification_status = 'verified'
          AND operations_one_off_carrier_selection_key(
            integration.provider,
            integration.global_id,
            carrier_account.global_id,
            credential.credential_version
          ) = selection->>'selectionKey'
        FOR SHARE OF integration, carrier_account, credential;
    ELSIF selection->>'provider' = 'wwex_speedship' THEN
      PERFORM 1
        FROM operations_integration_accounts integration
        JOIN operations_carrier_credentials credential
          ON credential.organization_id = integration.organization_id
         AND credential.integration_account_id = integration.id
        WHERE integration.organization_id = NEW.organization_id
          AND integration.global_id
            = selection->>'integrationAccountGlobalId'
          AND integration.integration_type = 'carrier'
          AND integration.provider = 'wwex_speedship'
          AND integration.environment = NEW.rate_environment
          AND integration.status = 'active'
          AND integration.configuration->>'activationStatus' = 'active'
          AND integration.configuration->'allowedCapabilities'
            ? 'small_parcel_rate'
          AND integration.configuration
            #>> '{transportActivation,small_parcel,ratingEnabled}' = 'true'
          AND jsonb_array_length(
            integration.configuration->'activationBlockers'
          ) = 0
          AND selection->'carrierAccountGlobalId' = 'null'::jsonb
          AND credential.credential_version::text
            = selection->>'credentialVersion'
          AND credential.verification_status = 'verified'
          AND operations_one_off_carrier_selection_key(
            integration.provider,
            integration.global_id,
            NULL,
            credential.credential_version
          ) = selection->>'selectionKey'
        FOR SHARE OF integration, credential;
    ELSE
      RAISE EXCEPTION 'Unsupported one-off carrier selection provider';
    END IF;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'One-off carrier selection must bind exact active small-parcel account and current verified credential authority';
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_one_off_quote_carrier_selections_write
  ON operations_one_off_shipment_quotes;
CREATE TRIGGER validate_one_off_quote_carrier_selections_write
BEFORE INSERT OR UPDATE ON operations_one_off_shipment_quotes
FOR EACH ROW EXECUTE FUNCTION validate_one_off_quote_carrier_selections();

CREATE OR REPLACE FUNCTION validate_one_off_rate_selection_key()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.carrier_selection_key IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.provider IN ('ups_rest', 'fedex_rest')
     AND NEW.carrier_account_id IS NOT NULL
  THEN
    PERFORM 1
      FROM operations_integration_accounts integration
      JOIN operations_carrier_accounts carrier_account
        ON carrier_account.organization_id = integration.organization_id
       AND carrier_account.integration_account_id = integration.id
      JOIN operations_carrier_credentials credential
        ON credential.organization_id = integration.organization_id
       AND credential.integration_account_id = integration.id
      WHERE integration.organization_id = NEW.organization_id
        AND integration.id = NEW.integration_account_id
        AND integration.integration_type = 'carrier'
        AND integration.provider = NEW.provider
        AND integration.environment = NEW.environment
        AND integration.status = 'active'
        AND carrier_account.id = NEW.carrier_account_id
        AND carrier_account.status = 'active'
        AND credential.credential_version = NEW.credential_version
        AND credential.verification_status = 'verified'
        AND operations_one_off_carrier_selection_key(
          NEW.provider,
          integration.global_id,
          carrier_account.global_id,
          NEW.credential_version
        ) = NEW.carrier_selection_key
      FOR SHARE OF integration, carrier_account, credential;
  ELSIF NEW.provider = 'wwex_speedship'
        AND NEW.carrier_account_id IS NULL
  THEN
    PERFORM 1
      FROM operations_integration_accounts integration
      JOIN operations_carrier_credentials credential
        ON credential.organization_id = integration.organization_id
       AND credential.integration_account_id = integration.id
      WHERE integration.organization_id = NEW.organization_id
        AND integration.id = NEW.integration_account_id
        AND integration.integration_type = 'carrier'
        AND integration.provider = 'wwex_speedship'
        AND integration.environment = NEW.environment
        AND integration.status = 'active'
        AND integration.configuration->>'activationStatus' = 'active'
        AND integration.configuration->'allowedCapabilities'
          ? 'small_parcel_rate'
        AND integration.configuration
          #>> '{transportActivation,small_parcel,ratingEnabled}' = 'true'
        AND jsonb_array_length(
          integration.configuration->'activationBlockers'
        ) = 0
        AND credential.credential_version = NEW.credential_version
        AND credential.verification_status = 'verified'
        AND operations_one_off_carrier_selection_key(
          NEW.provider,
          integration.global_id,
          NULL,
          NEW.credential_version
        ) = NEW.carrier_selection_key
      FOR SHARE OF integration, credential;
  ELSE
    RAISE EXCEPTION
      'Carrier-rate selection key requires an exact supported small-parcel account';
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Carrier-rate selection key must bind exact active small-parcel account and current verified credential authority';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_one_off_rate_selection_key_write
  ON operations_carrier_rate_requests;
CREATE TRIGGER validate_one_off_rate_selection_key_write
BEFORE INSERT OR UPDATE ON operations_carrier_rate_requests
FOR EACH ROW EXECUTE FUNCTION validate_one_off_rate_selection_key();

CREATE OR REPLACE FUNCTION validate_one_off_offer_carrier_selection()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  quote_selections jsonb;
  quote_packages jsonb;
  selection_results jsonb;
  selected_result jsonb;
  expected_offer_count integer;
  retained_offer_count integer;
BEGIN
  SELECT quote.required_carrier_selections,
         quote.packages_snapshot,
         quote.carrier_selection_results_snapshot
  INTO quote_selections, quote_packages, selection_results
  FROM operations_one_off_shipment_quotes quote
  WHERE quote.organization_id = NEW.organization_id
    AND quote.id = NEW.quote_id;

  IF quote_selections IS NULL THEN
    IF NEW.carrier_selection_key IS NOT NULL THEN
      RAISE EXCEPTION
        'Legacy one-off quotes cannot accept exact carrier-selection offers';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.carrier_selection_key IS NULL OR NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(quote_selections) selection
    JOIN operations_integration_accounts integration
      ON integration.organization_id = NEW.organization_id
     AND integration.id = NEW.integration_account_id
     AND integration.global_id
       = selection->>'integrationAccountGlobalId'
    LEFT JOIN operations_carrier_accounts carrier_account
      ON carrier_account.organization_id = NEW.organization_id
     AND carrier_account.integration_account_id = integration.id
     AND carrier_account.id = NEW.carrier_account_id
     AND carrier_account.global_id
       = selection->>'carrierAccountGlobalId'
    JOIN operations_carrier_rate_requests evidence
      ON evidence.organization_id = NEW.organization_id
     AND evidence.global_id = NEW.rate_evidence_global_id
     AND evidence.carrier_selection_key = NEW.carrier_selection_key
     AND evidence.provider = NEW.provider
     AND evidence.integration_account_id = NEW.integration_account_id
     AND evidence.carrier_account_id
       IS NOT DISTINCT FROM NEW.carrier_account_id
     AND evidence.credential_version = NEW.credential_version
     AND evidence.environment = NEW.environment
     AND evidence.status = 'succeeded'
    WHERE selection->>'selectionKey' = NEW.carrier_selection_key
      AND selection->>'provider' = NEW.provider
      AND selection->>'credentialVersion'
        = NEW.credential_version::text
      AND operations_one_off_rate_codes_match_selection(
        NEW.provider,
        selection,
        quote_packages,
        evidence.redacted_request
      )
      AND (
        (
          NEW.provider IN ('ups_rest', 'fedex_rest')
          AND NEW.carrier_account_id IS NOT NULL
          AND carrier_account.id IS NOT NULL
        )
        OR (
          NEW.provider = 'wwex_speedship'
          AND NEW.carrier_account_id IS NULL
          AND selection->'carrierAccountGlobalId' = 'null'::jsonb
          AND carrier_account.id IS NULL
          AND NEW.transport_mode = 'small_parcel'
          AND NEW.handling_unit_mode = 'loose_packages'
          AND NEW.handling_unit_plan_id IS NOT NULL
          AND NULLIF(btrim(NEW.provider_offer_id), '') IS NOT NULL
          AND NULLIF(btrim(NEW.provider_product_id), '') IS NOT NULL
          AND NULLIF(btrim(NEW.provider_transaction_id), '') IS NOT NULL
          AND NEW.credential_fingerprint IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM operations_carrier_credentials credential
            WHERE credential.organization_id = NEW.organization_id
              AND credential.integration_account_id
                = NEW.integration_account_id
              AND credential.credential_version = NEW.credential_version
              AND credential.credential_fingerprint
                = NEW.credential_fingerprint
              AND credential.verification_status = 'verified'
          )
          AND EXISTS (
            SELECT 1
            FROM operations_outbound_handling_unit_plans handling_plan
            WHERE handling_plan.organization_id = NEW.organization_id
              AND handling_plan.id = NEW.handling_unit_plan_id
              AND handling_plan.one_off_quote_id = NEW.quote_id
              AND handling_plan.transport_mode = 'small_parcel'
              AND handling_plan.handling_unit_mode = 'loose_packages'
              AND handling_plan.package_count
                = jsonb_array_length(quote_packages)
              AND (
                SELECT count(*)::integer
                FROM operations_outbound_handling_unit_memberships membership
                WHERE membership.organization_id = NEW.organization_id
                  AND membership.handling_unit_plan_id = handling_plan.id
              ) = jsonb_array_length(quote_packages)
              AND NOT EXISTS (
                SELECT 1
                FROM jsonb_array_elements(quote_packages) WITH ORDINALITY
                  quote_package(value, ordinality)
                WHERE NOT EXISTS (
                  SELECT 1
                  FROM operations_outbound_handling_unit_memberships
                    membership
                  WHERE membership.organization_id = NEW.organization_id
                    AND membership.handling_unit_plan_id = handling_plan.id
                    AND membership.package_sequence
                      = quote_package.ordinality
                    AND membership.quote_package_key
                      = quote_package.value->>'packageKey'
                    AND membership.package_snapshot_hash
                      = operations_transport_json_sha256(
                          quote_package.value
                        )
                )
              )
          )
        )
      )
  ) THEN
    RAISE EXCEPTION
      'One-off offer and rate evidence must match one exact selected carrier account';
  END IF;

  selected_result := selection_results->NEW.carrier_selection_key;
  expected_offer_count :=
    (selected_result->>'eligibleOfferCount')::integer;
  SELECT count(*)::integer
  INTO retained_offer_count
  FROM operations_one_off_shipment_quote_offers offer
  WHERE offer.organization_id = NEW.organization_id
    AND offer.quote_id = NEW.quote_id
    AND offer.carrier_selection_key = NEW.carrier_selection_key
    AND offer.id IS DISTINCT FROM NEW.id;

  IF selected_result->>'status' <> 'succeeded'
     OR retained_offer_count >= expected_offer_count
  THEN
    RAISE EXCEPTION
      'One-off carrier-selection offer count exceeds its immutable result snapshot';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_one_off_offer_carrier_selection_write
  ON operations_one_off_shipment_quote_offers;
CREATE TRIGGER validate_one_off_offer_carrier_selection_write
BEFORE INSERT OR UPDATE ON operations_one_off_shipment_quote_offers
FOR EACH ROW EXECUTE FUNCTION validate_one_off_offer_carrier_selection();

CREATE OR REPLACE FUNCTION seal_one_off_quote_carrier_selections()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_selection jsonb;
  selection_key text;
  result_row jsonb;
  expected_offer_count integer;
  retained_offer_count integer;
  successful_selection_count integer := 0;
  selected_count integer;
BEGIN
  IF NEW.required_carrier_selections IS NULL THEN
    RETURN NEW;
  END IF;

  selected_count := jsonb_array_length(NEW.required_carrier_selections);
  IF jsonb_typeof(NEW.provider_results_snapshot) IS DISTINCT FROM 'object'
     OR (
       SELECT count(*)::integer
       FROM jsonb_object_keys(NEW.provider_results_snapshot)
     ) IS DISTINCT FROM selected_count
     OR EXISTS (
       SELECT 1
       FROM jsonb_object_keys(NEW.provider_results_snapshot) provider_key
       WHERE NOT EXISTS (
         SELECT 1
         FROM jsonb_array_elements(NEW.required_carrier_selections)
           selected_provider
         WHERE selected_provider->>'provider' = provider_key
       )
     )
  THEN
    RAISE EXCEPTION
      'Carrier-selection results require an exact legacy provider result key projection';
  END IF;

  FOR current_selection IN
    SELECT value
    FROM jsonb_array_elements(NEW.required_carrier_selections)
  LOOP
    selection_key := current_selection->>'selectionKey';
    result_row := NEW.carrier_selection_results_snapshot->selection_key;
    expected_offer_count :=
      (result_row->>'eligibleOfferCount')::integer;

    IF NEW.provider_results_snapshot
         ->(current_selection->>'provider')
         IS DISTINCT FROM result_row
       OR NEW.transport_results_snapshot
         ->((current_selection->>'provider') || ':small_parcel')
         IS DISTINCT FROM result_row
    THEN
      RAISE EXCEPTION
        'Carrier-selection result must exactly match legacy provider and transport-source projections';
    END IF;

    SELECT count(*)::integer
    INTO retained_offer_count
    FROM operations_one_off_shipment_quote_offers offer
    WHERE offer.organization_id = NEW.organization_id
      AND offer.quote_id = NEW.id
      AND offer.carrier_selection_key = selection_key;

    IF retained_offer_count IS DISTINCT FROM expected_offer_count
       OR (
         result_row->>'status' = 'succeeded'
         AND retained_offer_count < 1
       )
       OR (
         result_row->>'status' = 'failed'
         AND retained_offer_count <> 0
       )
    THEN
      RAISE EXCEPTION
        'One-off carrier-selection result must exactly match retained selected-account offers';
    END IF;

    IF result_row->>'status' = 'succeeded' THEN
      successful_selection_count := successful_selection_count + 1;
    END IF;
  END LOOP;

  IF (
    NEW.status = 'succeeded'
    AND successful_selection_count = selected_count
  ) OR (
    NEW.status = 'partial'
    AND successful_selection_count > 0
    AND successful_selection_count < selected_count
  ) OR (
    NEW.status = 'failed'
    AND successful_selection_count = 0
  ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'One-off quote status must count exact carrier-account selection results';
END;
$$;

DROP TRIGGER IF EXISTS seal_one_off_quote_carrier_selections_deferred
  ON operations_one_off_shipment_quotes;
CREATE CONSTRAINT TRIGGER seal_one_off_quote_carrier_selections_deferred
AFTER INSERT OR UPDATE ON operations_one_off_shipment_quotes
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION seal_one_off_quote_carrier_selections();

-- Recreate the append-only triggers after every additive column exists. The
-- existing generic function rejects every UPDATE/DELETE, so the new snapshot
-- and selection-key columns receive the same immutability as legacy fields.
DROP TRIGGER IF EXISTS protect_operations_one_off_shipment_quotes_mutation
  ON operations_one_off_shipment_quotes;
CREATE TRIGGER protect_operations_one_off_shipment_quotes_mutation
BEFORE UPDATE OR DELETE ON operations_one_off_shipment_quotes
FOR EACH ROW EXECUTE FUNCTION protect_operations_append_only();

DROP TRIGGER IF EXISTS protect_operations_carrier_rate_requests_mutation
  ON operations_carrier_rate_requests;
CREATE TRIGGER protect_operations_carrier_rate_requests_mutation
BEFORE UPDATE OR DELETE ON operations_carrier_rate_requests
FOR EACH ROW EXECUTE FUNCTION protect_operations_append_only();

DROP TRIGGER IF EXISTS protect_operations_one_off_quote_offers_mutation
  ON operations_one_off_shipment_quote_offers;
CREATE TRIGGER protect_operations_one_off_quote_offers_mutation
BEFORE UPDATE OR DELETE ON operations_one_off_shipment_quote_offers
FOR EACH ROW EXECUTE FUNCTION protect_operations_append_only();

CREATE INDEX IF NOT EXISTS idx_one_off_offers_carrier_selection
  ON operations_one_off_shipment_quote_offers (
    organization_id, quote_id, carrier_selection_key, id
  )
  WHERE carrier_selection_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_carrier_rate_requests_selection_key
  ON operations_carrier_rate_requests (
    organization_id, carrier_selection_key, completed_at DESC, id
  )
  WHERE carrier_selection_key IS NOT NULL;

COMMENT ON COLUMN
  operations_one_off_shipment_quotes.required_carrier_selections IS
  'Canonical immutable 1-3 UPS, FedEx, or WWEX small-parcel selections. Each exact provider/integration/optional-carrier-account/credential tuple retains package-key, catalog identity/version, and internal adapter package-code coverage.';
COMMENT ON COLUMN
  operations_one_off_shipment_quotes.carrier_selection_results_snapshot IS
  'Immutable result object keyed exactly by required_carrier_selections.selectionKey; status and eligibleOfferCount seal every selected account outcome.';
COMMENT ON COLUMN
  operations_one_off_shipment_quotes.carrier_selection_schema_version IS
  'Exact one-off carrier-selection contract version. Version 1 requires complete canonical carrier, transport-source, package-code, and result projections; NULL preserves pre-0275 legacy rows.';
COMMENT ON COLUMN operations_carrier_rate_requests.carrier_selection_key IS
  'Stable small-parcel provider/account/version key used by an exact one-off selection; NULL preserves legacy and unrelated rate evidence.';
COMMENT ON COLUMN
  operations_one_off_shipment_quote_offers.carrier_selection_key IS
  'Stable small-parcel provider/account/version key proving that this immutable offer came from one exact quote selection; NULL only for legacy quotes.';
