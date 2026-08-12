-- Provider-neutral brokered transport identity and immutable outbound LTL plans.
--
-- An API provider is not necessarily the carrier that physically moves freight.
-- WWEX is retained as the provider for both SpeedShip SMALLPACK and LTL while
-- UPS or the returned LTL carrier/SCAC is retained independently as executing
-- carrier identity. R+L remains a direct provider but still records its
-- executing-carrier identity explicitly. Small parcel moves loose packages;
-- LTL moves cartons assigned to pallet handling units.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

INSERT INTO global_reference_entity_types (prefix, entity_type, display_name)
VALUES
  ('gthp', 'operations.outbound_handling_unit_plan', 'Outbound handling-unit plan'),
  ('gthu', 'operations.outbound_handling_unit', 'Outbound handling unit'),
  ('gthm', 'operations.outbound_handling_unit_membership', 'Outbound handling-unit membership'),
  ('gthc', 'operations.outbound_handling_unit_commodity', 'Outbound handling-unit commodity'),
  ('gfta', 'operations.freight_tender_attempt', 'Freight tender attempt'),
  ('gftd', 'operations.freight_tender_document', 'Freight tender document'),
  ('gtpa', 'operations.parcel_pickup_attempt', 'Parcel pickup attempt')
ON CONFLICT (prefix) DO UPDATE SET
  entity_type = EXCLUDED.entity_type,
  display_name = EXCLUDED.display_name;

-- Provider-neutral credential metadata. Encrypted bytes remain in the existing
-- authenticated ciphertext fields. Keep client_id_last_four for compatibility
-- with direct-carrier code until all writers use the neutral identifier name.
ALTER TABLE operations_carrier_credentials
  ADD COLUMN IF NOT EXISTS credential_kind text,
  ADD COLUMN IF NOT EXISTS credential_identifier_last_four text;

UPDATE operations_carrier_credentials
SET credential_kind = COALESCE(
      NULLIF(btrim(credential_kind), ''),
      'oauth_client_credentials'
    ),
    credential_identifier_last_four = COALESCE(
      NULLIF(btrim(credential_identifier_last_four), ''),
      client_id_last_four
    )
WHERE credential_kind IS NULL
   OR NULLIF(btrim(credential_kind), '') IS NULL
   OR credential_identifier_last_four IS NULL
   OR NULLIF(btrim(credential_identifier_last_four), '') IS NULL;

ALTER TABLE operations_carrier_credentials
  ALTER COLUMN credential_kind SET DEFAULT 'oauth_client_credentials',
  ALTER COLUMN credential_kind SET NOT NULL,
  ALTER COLUMN credential_identifier_last_four SET NOT NULL,
  DROP CONSTRAINT IF EXISTS operations_carrier_credentials_kind_valid,
  ADD CONSTRAINT operations_carrier_credentials_kind_valid CHECK (
    credential_kind IN ('oauth_client_credentials', 'api_key')
  ),
  DROP CONSTRAINT IF EXISTS
    operations_carrier_credentials_identifier_last_four_valid,
  ADD CONSTRAINT operations_carrier_credentials_identifier_last_four_valid
    CHECK (
      credential_identifier_last_four ~ '^[[:print:]]{1,4}$'
    );

CREATE OR REPLACE FUNCTION normalize_operations_carrier_credential_metadata()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.credential_kind := COALESCE(
    NULLIF(btrim(NEW.credential_kind), ''),
    'oauth_client_credentials'
  );
  IF TG_OP = 'UPDATE'
     AND NEW.credential_kind = 'oauth_client_credentials'
     AND NEW.client_id_last_four IS DISTINCT FROM OLD.client_id_last_four
     AND NEW.credential_identifier_last_four
       IS NOT DISTINCT FROM OLD.credential_identifier_last_four
  THEN
    -- Legacy direct-carrier rotation writers still update only this field.
    NEW.credential_identifier_last_four := NEW.client_id_last_four;
  ELSE
    NEW.credential_identifier_last_four := COALESCE(
      NULLIF(btrim(NEW.credential_identifier_last_four), ''),
      NEW.client_id_last_four
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS normalize_operations_carrier_credential_metadata_write
  ON operations_carrier_credentials;
CREATE TRIGGER normalize_operations_carrier_credential_metadata_write
BEFORE INSERT OR UPDATE ON operations_carrier_credentials
FOR EACH ROW EXECUTE FUNCTION normalize_operations_carrier_credential_metadata();

COMMENT ON COLUMN operations_carrier_credentials.credential_kind IS
  'Non-secret authentication shape. oauth_client_credentials and api_key are supported; encrypted values remain only in credential_ciphertext/iv/tag.';
COMMENT ON COLUMN
  operations_carrier_credentials.credential_identifier_last_four IS
  'Masked suffix of the provider-neutral credential identifier; never a secret or authorization flag.';

-- Capabilities and activation are deliberately searchable, non-secret
-- configuration. They never live inside credential ciphertext.
CREATE OR REPLACE FUNCTION operations_brokered_transport_configuration_is_valid(
  input_provider text,
  input_configuration jsonb
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  mode_count integer;
  capability_count integer;
  distinct_capability_count integer;
  activation jsonb;
BEGIN
  IF input_provider NOT IN ('wwex_speedship', 'rl_carriers') THEN
    RETURN true;
  END IF;
  IF jsonb_typeof(input_configuration) <> 'object'
     OR jsonb_typeof(input_configuration->'transportModes') <> 'array'
     OR jsonb_typeof(input_configuration->'allowedCapabilities') <> 'array'
     OR jsonb_typeof(input_configuration->'transportActivation') <> 'object'
     OR jsonb_typeof(input_configuration->'activationStatus') <> 'string'
     OR input_configuration->>'activationStatus' NOT IN (
       'pre_activation',
       'active'
     )
     OR jsonb_typeof(input_configuration->'activationBlockers') <> 'array'
     OR (
       input_configuration ? 'billingAccountFingerprint'
       AND (
         jsonb_typeof(input_configuration->'billingAccountFingerprint')
           <> 'string'
         OR input_configuration->>'billingAccountFingerprint'
           !~ '^[a-f0-9]{64}$'
       )
     )
     OR (
       input_provider = 'rl_carriers'
       AND input_configuration ? 'billingAccountFingerprint'
     )
     OR EXISTS (
       SELECT 1
       FROM jsonb_array_elements(
         input_configuration->'activationBlockers'
       ) blocker
       WHERE jsonb_typeof(blocker) <> 'string'
         OR NULLIF(btrim(blocker #>> '{}'), '') IS NULL
     )
  THEN
    RETURN false;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(input_configuration->'transportModes') mode
    WHERE jsonb_typeof(mode) <> 'string'
      OR mode #>> '{}' NOT IN ('small_parcel', 'ltl')
  ) THEN
    RETURN false;
  END IF;
  SELECT count(*), count(DISTINCT mode #>> '{}')
  INTO mode_count, distinct_capability_count
  FROM jsonb_array_elements(input_configuration->'transportModes') mode;
  IF mode_count <> distinct_capability_count
     OR (
       input_provider = 'wwex_speedship'
       AND input_configuration->'transportModes'
         <> '["small_parcel", "ltl"]'::jsonb
     )
     OR (
       input_provider = 'rl_carriers'
       AND input_configuration->'transportModes' <> '["ltl"]'::jsonb
     )
  THEN
    RETURN false;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(
      input_configuration->'allowedCapabilities'
    ) capability
    WHERE jsonb_typeof(capability) <> 'string'
       OR capability #>> '{}' NOT IN (
         'small_parcel_rate',
         'small_parcel_tender',
         'small_parcel_void',
         'small_parcel_tracking',
         'small_parcel_documents',
         'small_parcel_pickup',
         'ltl_rate',
         'ltl_tender',
         'ltl_cancel',
         'ltl_bol',
         'ltl_documents',
         'ltl_pickup',
         'ltl_pickup_cancel',
         'ltl_tracking'
       )
       OR (
         input_provider = 'wwex_speedship'
         AND capability #>> '{}' NOT IN (
           'small_parcel_rate',
           'small_parcel_tender',
           'small_parcel_pickup',
           'ltl_rate',
           'ltl_tender'
         )
       )
       OR (
         input_provider = 'rl_carriers'
         AND capability #>> '{}' NOT IN (
           'ltl_rate',
           'ltl_tender',
           'ltl_bol',
           'ltl_pickup'
         )
       )
  ) THEN
    RETURN false;
  END IF;
  SELECT count(*), count(DISTINCT capability #>> '{}')
  INTO capability_count, distinct_capability_count
  FROM jsonb_array_elements(
    input_configuration->'allowedCapabilities'
  ) capability;
  IF capability_count <> distinct_capability_count THEN
    RETURN false;
  END IF;

  activation := input_configuration->'transportActivation';
  IF jsonb_typeof(activation->'small_parcel') <> 'object'
     OR jsonb_typeof(activation->'ltl') <> 'object'
     OR jsonb_typeof(activation->'small_parcel'->'ratingEnabled')
       <> 'boolean'
     OR jsonb_typeof(activation->'small_parcel'->'tenderEnabled')
       <> 'boolean'
     OR jsonb_typeof(activation->'ltl'->'ratingEnabled') <> 'boolean'
     OR jsonb_typeof(activation->'ltl'->'tenderEnabled') <> 'boolean'
     OR (
       input_provider = 'rl_carriers'
       AND (
         (activation->'small_parcel'->>'ratingEnabled')::boolean
         OR (activation->'small_parcel'->>'tenderEnabled')::boolean
       )
     )
     OR (
       (activation->'small_parcel'->>'tenderEnabled')::boolean
       AND NOT (activation->'small_parcel'->>'ratingEnabled')::boolean
     )
     OR (
       (activation->'ltl'->>'tenderEnabled')::boolean
       AND NOT (activation->'ltl'->>'ratingEnabled')::boolean
     )
     OR (
       (activation->'small_parcel'->>'ratingEnabled')::boolean
       IS DISTINCT FROM (
         input_configuration->'allowedCapabilities' ? 'small_parcel_rate'
       )
     )
     OR (
       (activation->'small_parcel'->>'tenderEnabled')::boolean
       IS DISTINCT FROM (
         input_configuration->'allowedCapabilities' ? 'small_parcel_tender'
       )
     )
     OR (
       (activation->'ltl'->>'ratingEnabled')::boolean
       IS DISTINCT FROM (
         input_configuration->'allowedCapabilities' ? 'ltl_rate'
       )
     )
     OR (
       (activation->'ltl'->>'tenderEnabled')::boolean
       IS DISTINCT FROM (
         input_configuration->'allowedCapabilities' ? 'ltl_tender'
       )
     )
     OR (
       input_provider = 'wwex_speedship'
       AND (
         (activation->'small_parcel'->>'tenderEnabled')::boolean
         OR (activation->'ltl'->>'tenderEnabled')::boolean
       )
       AND NOT COALESCE(
         input_configuration->>'billingAccountFingerprint'
           ~ '^[a-f0-9]{64}$',
         false
       )
     )
     OR (
       input_configuration->>'activationStatus' = 'active'
       AND jsonb_array_length(
         input_configuration->'activationBlockers'
       ) <> 0
     )
     OR (
       input_configuration->>'activationStatus' = 'pre_activation'
       AND (
         capability_count <> 0
         OR (activation->'small_parcel'->>'ratingEnabled')::boolean
         OR (activation->'small_parcel'->>'tenderEnabled')::boolean
         OR (activation->'ltl'->>'ratingEnabled')::boolean
         OR (activation->'ltl'->>'tenderEnabled')::boolean
       )
     )
  THEN
    RETURN false;
  END IF;

  RETURN true;
END;
$$;

ALTER TABLE operations_integration_accounts
  DROP CONSTRAINT IF EXISTS
    operations_integration_accounts_transport_configuration_valid,
  ADD CONSTRAINT operations_integration_accounts_transport_configuration_valid
    CHECK (
      integration_type <> 'carrier'
      OR operations_brokered_transport_configuration_is_valid(
        provider,
        configuration
      )
    );

COMMENT ON CONSTRAINT
  operations_integration_accounts_transport_configuration_valid
  ON operations_integration_accounts IS
  'WWEX/R+L transport modes, activation flags, and allowed capabilities are non-secret integration configuration; credential ciphertext contains authentication values only.';

-- Extend provider evidence without changing the meaning of existing direct
-- provider rows. one_off_transport_rate is the provider-neutral whole-plan
-- rating purpose used by brokered parcel and LTL comparisons.
ALTER TABLE operations_carrier_rate_requests
  DROP CONSTRAINT IF EXISTS operations_carrier_rate_requests_provider_check,
  DROP CONSTRAINT IF EXISTS operations_carrier_rate_requests_provider_valid,
  ADD CONSTRAINT operations_carrier_rate_requests_provider_valid CHECK (
    provider IN (
      'ups_rest',
      'fedex_rest',
      'usps_rest',
      'wwex_speedship',
      'rl_carriers'
    )
  ),
  DROP CONSTRAINT IF EXISTS operations_carrier_rate_requests_purpose_check,
  DROP CONSTRAINT IF EXISTS operations_carrier_rate_requests_purpose_valid,
  ADD CONSTRAINT operations_carrier_rate_requests_purpose_valid CHECK (
    purpose IN (
      'sandbox_rate_test',
      'cartonization_package_rate',
      'cartonization_shipment_rate',
      'one_off_transport_rate'
    )
  ),
  DROP CONSTRAINT IF EXISTS
    operations_carrier_rate_requests_explicit_account,
  DROP CONSTRAINT IF EXISTS
    operations_carrier_rate_requests_provider_account_valid,
  ADD CONSTRAINT operations_carrier_rate_requests_provider_account_valid
    CHECK (
      (
        provider IN ('wwex_speedship', 'rl_carriers')
        AND carrier_account_id IS NULL
        AND network_id IS NULL
        AND account_authorization_id IS NULL
      )
      OR (
        provider NOT IN ('wwex_speedship', 'rl_carriers')
        AND carrier_account_id IS NOT NULL
      )
    ) NOT VALID;

CREATE OR REPLACE FUNCTION operations_one_off_transport_provider_set_is_valid(
  input_providers text[]
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT COALESCE(
    cardinality(input_providers) BETWEEN 1 AND 4
    AND input_providers <@ ARRAY[
      'ups_rest',
      'fedex_rest',
      'wwex_speedship',
      'rl_carriers'
    ]::text[]
    AND cardinality(input_providers) = (
      SELECT count(DISTINCT provider)::integer
      FROM unnest(input_providers) provider
    )
    AND input_providers = ARRAY(
      SELECT provider
      FROM unnest(input_providers) provider
      ORDER BY array_position(
        ARRAY[
          'ups_rest',
          'fedex_rest',
          'wwex_speedship',
          'rl_carriers'
        ]::text[],
        provider
      )
    ),
    false
  )
$$;

CREATE OR REPLACE FUNCTION operations_one_off_transport_source_set_is_valid(
  input_sources text[]
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT COALESCE(
    cardinality(input_sources) BETWEEN 1 AND 5
    AND input_sources <@ ARRAY[
      'ups_rest:small_parcel',
      'fedex_rest:small_parcel',
      'wwex_speedship:small_parcel',
      'wwex_speedship:ltl',
      'rl_carriers:ltl'
    ]::text[]
    AND cardinality(input_sources) = (
      SELECT count(DISTINCT source)::integer
      FROM unnest(input_sources) source
    )
    AND input_sources = ARRAY(
      SELECT source
      FROM unnest(input_sources) source
      ORDER BY array_position(
        ARRAY[
          'ups_rest:small_parcel',
          'fedex_rest:small_parcel',
          'wwex_speedship:small_parcel',
          'wwex_speedship:ltl',
          'rl_carriers:ltl'
        ]::text[],
        source
      )
    ),
    false
  )
$$;

CREATE OR REPLACE FUNCTION operations_one_off_transport_sources_match(
  input_sources text[],
  input_providers text[],
  input_results jsonb
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT COALESCE(
    operations_one_off_transport_source_set_is_valid(input_sources)
    AND operations_one_off_transport_provider_set_is_valid(input_providers)
    AND input_providers = ARRAY(
      SELECT provider
      FROM (
        SELECT DISTINCT split_part(source, ':', 1) AS provider
        FROM unnest(input_sources) source
      ) unique_providers
      ORDER BY array_position(
        ARRAY[
          'ups_rest',
          'fedex_rest',
          'wwex_speedship',
          'rl_carriers'
        ]::text[],
        provider
      )
    )
    AND jsonb_typeof(input_results) = 'object'
    AND (SELECT count(*) FROM jsonb_object_keys(input_results))
      = cardinality(input_sources)
    AND NOT EXISTS (
      SELECT 1
      FROM unnest(input_sources) source
      WHERE NOT input_results ? source
    )
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_object_keys(input_results) result_source
      WHERE NOT result_source = ANY(input_sources)
    ),
    false
  )
$$;

ALTER TABLE operations_one_off_shipment_quotes
  DROP CONSTRAINT IF EXISTS
    operations_one_off_shipment_quotes_provider_set_valid,
  ADD CONSTRAINT operations_one_off_shipment_quotes_provider_set_valid CHECK (
    operations_one_off_transport_provider_set_is_valid(
      required_carrier_providers
    )
  );

ALTER TABLE operations_one_off_shipment_quotes
  ADD COLUMN IF NOT EXISTS required_transport_sources text[],
  ADD COLUMN IF NOT EXISTS transport_results_snapshot jsonb;

DROP TRIGGER IF EXISTS protect_operations_one_off_shipment_quotes_mutation
  ON operations_one_off_shipment_quotes;

UPDATE operations_one_off_shipment_quotes quote
SET required_transport_sources = ARRAY(
      SELECT provider || ':small_parcel'
      FROM unnest(quote.required_carrier_providers) provider
    ),
    transport_results_snapshot = (
      SELECT jsonb_object_agg(
        provider || ':small_parcel',
        COALESCE(quote.provider_results_snapshot->provider, '{}'::jsonb)
      )
      FROM unnest(quote.required_carrier_providers) provider
    )
WHERE required_transport_sources IS NULL
   OR transport_results_snapshot IS NULL;

ALTER TABLE operations_one_off_shipment_quotes
  DROP CONSTRAINT IF EXISTS operations_one_off_quote_transport_sources_valid,
  ADD CONSTRAINT operations_one_off_quote_transport_sources_valid CHECK (
    (
      required_transport_sources IS NULL
      AND transport_results_snapshot IS NULL
    )
    OR operations_one_off_transport_sources_match(
      required_transport_sources,
      required_carrier_providers,
      transport_results_snapshot
    )
  );

CREATE TRIGGER protect_operations_one_off_shipment_quotes_mutation
BEFORE UPDATE OR DELETE ON operations_one_off_shipment_quotes
FOR EACH ROW EXECUTE FUNCTION protect_operations_append_only();

COMMENT ON COLUMN
  operations_one_off_shipment_quotes.required_transport_sources IS
  'Canonical provider:transport_mode sources. Nullable only for legacy direct writers until they adopt mode-aware quote snapshots.';
COMMENT ON COLUMN
  operations_one_off_shipment_quotes.transport_results_snapshot IS
  'Mode-aware result map keyed by required_transport_sources so WWEX parcel and LTL outcomes cannot overwrite each other.';

ALTER TABLE operations_one_off_shipment_rate_attempts
  ADD COLUMN IF NOT EXISTS transport_mode text NOT NULL
    DEFAULT 'small_parcel',
  ALTER COLUMN carrier_account_id DROP NOT NULL,
  DROP CONSTRAINT IF EXISTS
    operations_one_off_shipment_rate_attempts_provider_check,
  DROP CONSTRAINT IF EXISTS operations_one_off_rate_attempt_provider_valid,
  ADD CONSTRAINT operations_one_off_rate_attempt_provider_valid CHECK (
    provider IN (
      'ups_rest',
      'fedex_rest',
      'wwex_speedship',
      'rl_carriers'
    )
  ),
  DROP CONSTRAINT IF EXISTS operations_one_off_rate_attempt_transport_valid,
  ADD CONSTRAINT operations_one_off_rate_attempt_transport_valid CHECK (
    (
      provider IN ('ups_rest', 'fedex_rest')
      AND transport_mode = 'small_parcel'
      AND carrier_account_id IS NOT NULL
    )
    OR (
      provider = 'wwex_speedship'
      AND transport_mode IN ('small_parcel', 'ltl')
      AND carrier_account_id IS NULL
    )
    OR (
      provider = 'rl_carriers'
      AND transport_mode = 'ltl'
      AND carrier_account_id IS NULL
    )
  );

CREATE OR REPLACE FUNCTION protect_operations_one_off_rate_attempt()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'One-off carrier rate attempts are immutable';
  END IF;
  IF ROW(
    NEW.global_id, NEW.organization_id, NEW.quote_idempotency_key,
    NEW.provider, NEW.transport_mode,
    NEW.integration_account_id, NEW.carrier_account_id,
    NEW.environment, NEW.adapter_version, NEW.attempt_idempotency_key,
    NEW.request_hash, NEW.redacted_request, NEW.actor_email,
    NEW.requested_at, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.global_id, OLD.organization_id, OLD.quote_idempotency_key,
    OLD.provider, OLD.transport_mode,
    OLD.integration_account_id, OLD.carrier_account_id,
    OLD.environment, OLD.adapter_version, OLD.attempt_idempotency_key,
    OLD.request_hash, OLD.redacted_request, OLD.actor_email,
    OLD.requested_at, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'One-off carrier rate request evidence is immutable';
  END IF;
  IF OLD.state <> 'prepared' OR NEW.state = 'prepared'
     OR NEW.completed_at IS NULL THEN
    RAISE EXCEPTION 'One-off carrier rate attempts finalize exactly once';
  END IF;
  RETURN NEW;
END;
$$;

-- JSONB's default text form is stable inside PostgreSQL but includes object
-- formatting that is not the same byte contract as transport.ts. Rebuild the
-- normalized JSON recursively so the database can verify the application hash
-- instead of accepting an app-attested plan_hash for an unrelated snapshot.
CREATE OR REPLACE FUNCTION operations_transport_canonical_json(
  input_value jsonb
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  canonical_value text;
BEGIN
  CASE jsonb_typeof(input_value)
    WHEN 'object' THEN
      SELECT '{' || COALESCE(
        string_agg(
          to_jsonb(entry.key_name)::text || ':'
            || operations_transport_canonical_json(entry.nested_value),
          ',' ORDER BY entry.key_name COLLATE "C"
        ),
        ''
      ) || '}'
      INTO canonical_value
      FROM jsonb_each(input_value) entry(key_name, nested_value);
    WHEN 'array' THEN
      SELECT '[' || COALESCE(
        string_agg(
          operations_transport_canonical_json(entry.nested_value),
          ',' ORDER BY entry.ordinality
        ),
        ''
      ) || ']'
      INTO canonical_value
      FROM jsonb_array_elements(input_value) WITH ORDINALITY
        entry(nested_value, ordinality);
    ELSE
      canonical_value := input_value::text;
  END CASE;
  RETURN canonical_value;
END;
$$;

CREATE OR REPLACE FUNCTION operations_transport_json_sha256(
  input_value jsonb
)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT encode(
    digest(
      convert_to(operations_transport_canonical_json(input_value), 'UTF8'),
      'sha256'
    ),
    'hex'
  )
$$;

CREATE OR REPLACE FUNCTION operations_transport_request_profile_is_valid(
  input_profile jsonb
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT COALESCE(
    jsonb_typeof(input_profile) = 'object'
    AND (SELECT count(*) FROM jsonb_object_keys(input_profile)) = 4
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_object_keys(input_profile) profile_key
      WHERE profile_key NOT IN (
        'hazardousMaterials',
        'declaredValue',
        'accessorials',
        'pickupRequired'
      )
    )
    AND input_profile->'hazardousMaterials' = 'false'::jsonb
    AND input_profile->'declaredValue' = 'null'::jsonb
    AND jsonb_typeof(input_profile->'pickupRequired') = 'boolean'
    AND jsonb_typeof(input_profile->'accessorials') = 'array'
    AND jsonb_array_length(input_profile->'accessorials') <= 20
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(input_profile->'accessorials') accessorial
      WHERE jsonb_typeof(accessorial) <> 'string'
        OR accessorial #>> '{}' !~ '^[A-Z0-9][A-Z0-9._-]{1,31}$'
    )
    AND ARRAY(
      SELECT accessorial #>> '{}'
      FROM jsonb_array_elements(input_profile->'accessorials') accessorial
    ) = ARRAY(
      SELECT distinct_accessorial.accessorial_value
      FROM (
        SELECT DISTINCT accessorial #>> '{}' AS accessorial_value
        FROM jsonb_array_elements(input_profile->'accessorials') accessorial
      ) distinct_accessorial
      ORDER BY distinct_accessorial.accessorial_value COLLATE "C"
    ),
    false
  )
$$;

CREATE TABLE IF NOT EXISTS operations_outbound_handling_unit_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gthp'),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  one_off_quote_id uuid,
  fulfillment_plan_id uuid,
  contract_version text NOT NULL
    DEFAULT 'operations.transport_plan.v1',
  version_number integer NOT NULL CHECK (version_number > 0),
  transport_mode text NOT NULL
    CHECK (transport_mode IN ('small_parcel', 'ltl')),
  handling_unit_mode text NOT NULL CHECK (
    handling_unit_mode IN (
      'loose_packages',
      'palletized_handling_units'
    )
  ),
  source text NOT NULL CHECK (
    source IN (
      'operator_explicit',
      'cartonization',
      'packed_rerate',
      'provider_reconciliation'
    )
  ),
  handling_unit_count integer NOT NULL
    CHECK (handling_unit_count BETWEEN 1 AND 50),
  package_count integer NOT NULL CHECK (package_count BETWEEN 1 AND 50),
  total_gross_weight_grams bigint NOT NULL
    CHECK (total_gross_weight_grams > 0),
  request_profile jsonb NOT NULL,
  request_profile_hash text NOT NULL CHECK (
    request_profile_hash ~ '^[a-f0-9]{64}$'
  ),
  plan_hash text NOT NULL CHECK (plan_hash ~ '^[a-f0-9]{64}$'),
  plan_snapshot jsonb NOT NULL,
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  sealed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_outbound_handling_plan_global_valid CHECK (
    global_id ~ '^gthp(?:[0-9]{7}|[0-9a-v]{12})$'
  ),
  CONSTRAINT operations_outbound_handling_plan_global_unique
    UNIQUE (global_id),
  CONSTRAINT operations_outbound_handling_plan_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_outbound_handling_plan_quote_fkey
    FOREIGN KEY (organization_id, one_off_quote_id)
    REFERENCES operations_one_off_shipment_quotes(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_outbound_handling_plan_fulfillment_fkey
    FOREIGN KEY (organization_id, fulfillment_plan_id)
    REFERENCES operations_fulfillment_plans(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_outbound_handling_plan_org_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT operations_outbound_handling_plan_scope_valid CHECK (
    (one_off_quote_id IS NOT NULL OR fulfillment_plan_id IS NOT NULL)
    AND (
      one_off_quote_id IS NULL
      OR fulfillment_plan_id IS NULL
      OR source = 'packed_rerate'
    )
  ),
  CONSTRAINT operations_outbound_handling_plan_mode_valid CHECK (
    (
      transport_mode = 'small_parcel'
      AND handling_unit_mode = 'loose_packages'
      AND handling_unit_count = package_count
    )
    OR (
      transport_mode = 'ltl'
      AND handling_unit_mode = 'palletized_handling_units'
      AND handling_unit_count <= package_count
      AND handling_unit_count <= 20
    )
  ),
  CONSTRAINT operations_outbound_handling_plan_snapshot_valid CHECK (
    jsonb_typeof(plan_snapshot) = 'object'
    AND plan_snapshot->>'contractVersion' = contract_version
    AND plan_snapshot->>'planVersion' = version_number::text
    AND plan_snapshot->>'transportMode' = transport_mode
    AND plan_snapshot->>'handlingUnitMode' = handling_unit_mode
    AND plan_snapshot->'requestProfile' = request_profile
    AND operations_transport_request_profile_is_valid(request_profile)
    AND request_profile_hash
      = operations_transport_json_sha256(request_profile)
    AND plan_hash = operations_transport_json_sha256(plan_snapshot)
    AND sealed_at >= created_at
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS
  operations_outbound_handling_plan_quote_version_unique
ON operations_outbound_handling_unit_plans (
  organization_id,
  one_off_quote_id,
  transport_mode,
  version_number
)
WHERE one_off_quote_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS
  operations_outbound_handling_plan_fulfillment_version_unique
ON operations_outbound_handling_unit_plans (
  organization_id,
  fulfillment_plan_id,
  transport_mode,
  version_number
)
WHERE fulfillment_plan_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS
  operations_outbound_handling_plan_scope_hash_unique
ON operations_outbound_handling_unit_plans (
  organization_id,
  COALESCE(one_off_quote_id, '00000000-0000-0000-0000-000000000000'::uuid),
  COALESCE(fulfillment_plan_id, '00000000-0000-0000-0000-000000000000'::uuid),
  plan_hash
);

CREATE TABLE IF NOT EXISTS operations_outbound_handling_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gthu'),
  organization_id uuid NOT NULL,
  handling_unit_plan_id uuid NOT NULL,
  unit_key text NOT NULL,
  unit_sequence integer NOT NULL CHECK (unit_sequence BETWEEN 1 AND 50),
  unit_type text NOT NULL CHECK (unit_type IN ('package', 'pallet')),
  length_mm integer NOT NULL CHECK (length_mm BETWEEN 1 AND 10000),
  width_mm integer NOT NULL CHECK (width_mm BETWEEN 1 AND 10000),
  height_mm integer NOT NULL CHECK (height_mm BETWEEN 1 AND 10000),
  tare_weight_grams bigint NOT NULL
    CHECK (tare_weight_grams BETWEEN 0 AND 100000000),
  gross_weight_grams bigint NOT NULL
    CHECK (gross_weight_grams BETWEEN 1 AND 100000000),
  stackability text CHECK (
    stackability IN ('stackable', 'non_stackable')
  ),
  mixed_commodities boolean NOT NULL DEFAULT false,
  unit_snapshot_hash text NOT NULL CHECK (
    unit_snapshot_hash ~ '^[a-f0-9]{64}$'
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_outbound_handling_unit_global_valid CHECK (
    global_id ~ '^gthu(?:[0-9]{7}|[0-9a-v]{12})$'
  ),
  CONSTRAINT operations_outbound_handling_unit_global_unique
    UNIQUE (global_id),
  CONSTRAINT operations_outbound_handling_unit_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_outbound_handling_unit_plan_fkey
    FOREIGN KEY (organization_id, handling_unit_plan_id)
    REFERENCES operations_outbound_handling_unit_plans(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_outbound_handling_unit_org_plan_id_unique
    UNIQUE (organization_id, handling_unit_plan_id, id),
  CONSTRAINT operations_outbound_handling_unit_org_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT operations_outbound_handling_unit_key_unique
    UNIQUE (organization_id, handling_unit_plan_id, unit_key),
  CONSTRAINT operations_outbound_handling_unit_sequence_unique
    UNIQUE (organization_id, handling_unit_plan_id, unit_sequence),
  CONSTRAINT operations_outbound_handling_unit_text_valid CHECK (
    length(btrim(unit_key)) BETWEEN 1 AND 120
    AND unit_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
  ),
  CONSTRAINT operations_outbound_handling_unit_weight_valid CHECK (
    gross_weight_grams >= tare_weight_grams
  ),
  CONSTRAINT operations_outbound_handling_unit_shape_valid CHECK (
    (
      unit_type = 'package'
      AND tare_weight_grams = 0
      AND stackability IS NULL
      AND mixed_commodities = false
    )
    OR (
      unit_type = 'pallet'
      AND tare_weight_grams > 0
      AND stackability IS NOT NULL
    )
  )
);

CREATE TABLE IF NOT EXISTS operations_outbound_handling_unit_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gthm'),
  organization_id uuid NOT NULL,
  handling_unit_plan_id uuid NOT NULL,
  handling_unit_id uuid NOT NULL,
  membership_sequence integer NOT NULL
    CHECK (membership_sequence BETWEEN 1 AND 50),
  package_sequence integer NOT NULL CHECK (package_sequence BETWEEN 1 AND 50),
  package_form text NOT NULL CHECK (package_form IN ('carton', 'poly_bag')),
  package_id uuid,
  quote_package_key text,
  package_snapshot_hash text NOT NULL CHECK (
    package_snapshot_hash ~ '^[a-f0-9]{64}$'
  ),
  allocated_gross_weight_grams bigint NOT NULL CHECK (
    allocated_gross_weight_grams BETWEEN 1 AND 100000000
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_outbound_handling_membership_global_valid CHECK (
    global_id ~ '^gthm(?:[0-9]{7}|[0-9a-v]{12})$'
  ),
  CONSTRAINT operations_outbound_handling_membership_global_unique
    UNIQUE (global_id),
  CONSTRAINT operations_outbound_handling_membership_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_outbound_handling_membership_unit_fkey
    FOREIGN KEY (
      organization_id,
      handling_unit_plan_id,
      handling_unit_id
    ) REFERENCES operations_outbound_handling_units(
      organization_id,
      handling_unit_plan_id,
      id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_outbound_handling_membership_package_fkey
    FOREIGN KEY (organization_id, package_id)
    REFERENCES operations_packages(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_outbound_handling_membership_org_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT operations_outbound_handling_membership_reference_valid CHECK (
    (package_id IS NOT NULL AND quote_package_key IS NULL)
    OR (package_id IS NULL AND quote_package_key IS NOT NULL)
  ),
  CONSTRAINT operations_outbound_handling_membership_key_valid CHECK (
    quote_package_key IS NULL
    OR (
      length(btrim(quote_package_key)) BETWEEN 1 AND 120
      AND quote_package_key
        ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
    )
  ),
  CONSTRAINT operations_outbound_handling_membership_sequence_unique
    UNIQUE (
      organization_id,
      handling_unit_plan_id,
      handling_unit_id,
      membership_sequence
    ),
  CONSTRAINT operations_outbound_handling_membership_package_sequence_unique
    UNIQUE (organization_id, handling_unit_plan_id, package_sequence)
);

CREATE UNIQUE INDEX IF NOT EXISTS
  operations_outbound_handling_membership_package_unique
ON operations_outbound_handling_unit_memberships (
  organization_id,
  handling_unit_plan_id,
  package_id
)
WHERE package_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS
  operations_outbound_handling_membership_quote_key_unique
ON operations_outbound_handling_unit_memberships (
  organization_id,
  handling_unit_plan_id,
  quote_package_key
)
WHERE quote_package_key IS NOT NULL;

CREATE OR REPLACE FUNCTION operations_positive_integer_set_is_valid(
  input_values integer[],
  maximum_value integer
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT COALESCE(
    cardinality(input_values) BETWEEN 1 AND maximum_value
    AND input_values = ARRAY(
      SELECT DISTINCT value
      FROM unnest(input_values) value
      WHERE value BETWEEN 1 AND maximum_value
      ORDER BY value
    )
    AND cardinality(input_values) = (
      SELECT count(DISTINCT value)::integer
      FROM unnest(input_values) value
      WHERE value BETWEEN 1 AND maximum_value
    ),
    false
  )
$$;

CREATE OR REPLACE FUNCTION operations_transport_classification_evidence_is_valid(
  input_evidence jsonb,
  input_freight_class numeric,
  input_nmfc_code text
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(
    jsonb_typeof(input_evidence) = 'object'
    AND input_evidence ?& ARRAY[
      'freightClass',
      'nmfcCode',
      'source',
      'reference',
      'description',
      'capturedAt'
    ]
    AND (SELECT count(*) FROM jsonb_object_keys(input_evidence)) = 6
    AND jsonb_typeof(input_evidence->'freightClass') = 'string'
    AND CASE
      WHEN input_evidence->>'freightClass'
        ~ '^(?:50|55|60|65|70|77\.5|85|92\.5|100|110|125|150|175|200|250|300|400|500)$'
      THEN (input_evidence->>'freightClass')::numeric
        = input_freight_class
      ELSE false
    END
    AND jsonb_typeof(input_evidence->'source') = 'string'
    AND input_evidence->>'source' IN (
      'operator_attested',
      'product_profile',
      'density_calculation',
      'provider_returned'
    )
    AND jsonb_typeof(input_evidence->'reference') = 'string'
    AND NULLIF(btrim(input_evidence->>'reference'), '') IS NOT NULL
    AND jsonb_typeof(input_evidence->'description') = 'string'
    AND NULLIF(btrim(input_evidence->>'description'), '') IS NOT NULL
    AND jsonb_typeof(input_evidence->'capturedAt') = 'string'
    AND input_evidence->>'capturedAt'
      ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
    AND (
      (
        input_nmfc_code IS NULL
        AND input_evidence->'nmfcCode' = 'null'::jsonb
      )
      OR (
        input_nmfc_code IS NOT NULL
        AND jsonb_typeof(input_evidence->'nmfcCode') = 'string'
        AND input_evidence->>'nmfcCode' = input_nmfc_code
      )
    ),
    false
  )
$$;

CREATE TABLE IF NOT EXISTS operations_outbound_handling_unit_commodities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gthc'),
  organization_id uuid NOT NULL,
  handling_unit_plan_id uuid NOT NULL,
  handling_unit_id uuid NOT NULL,
  commodity_sequence integer NOT NULL
    CHECK (commodity_sequence BETWEEN 1 AND 50),
  description text NOT NULL,
  pieces integer NOT NULL CHECK (pieces BETWEEN 1 AND 1000000),
  weight_grams bigint NOT NULL CHECK (weight_grams BETWEEN 1 AND 100000000),
  freight_class numeric(4,1) NOT NULL,
  nmfc_code text,
  classification_evidence jsonb NOT NULL,
  membership_sequences integer[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_outbound_handling_commodity_global_valid CHECK (
    global_id ~ '^gthc(?:[0-9]{7}|[0-9a-v]{12})$'
  ),
  CONSTRAINT operations_outbound_handling_commodity_global_unique
    UNIQUE (global_id),
  CONSTRAINT operations_outbound_handling_commodity_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_outbound_handling_commodity_unit_fkey
    FOREIGN KEY (
      organization_id,
      handling_unit_plan_id,
      handling_unit_id
    ) REFERENCES operations_outbound_handling_units(
      organization_id,
      handling_unit_plan_id,
      id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_outbound_handling_commodity_org_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT operations_outbound_handling_commodity_sequence_unique
    UNIQUE (
      organization_id,
      handling_unit_plan_id,
      handling_unit_id,
      commodity_sequence
    ),
  CONSTRAINT operations_outbound_handling_commodity_text_valid CHECK (
    length(btrim(description)) BETWEEN 1 AND 255
    AND (nmfc_code IS NULL OR nmfc_code ~ '^[0-9]{3,6}(-[0-9]{1,2})?$')
  ),
  CONSTRAINT operations_outbound_handling_commodity_class_valid CHECK (
    freight_class IN (
      50, 55, 60, 65, 70, 77.5, 85, 92.5, 100, 110, 125,
      150, 175, 200, 250, 300, 400, 500
    )
  ),
  CONSTRAINT operations_outbound_handling_commodity_memberships_valid CHECK (
    operations_positive_integer_set_is_valid(membership_sequences, 50)
    AND pieces = cardinality(membership_sequences)
  ),
  CONSTRAINT operations_outbound_handling_commodity_evidence_valid CHECK (
    operations_transport_classification_evidence_is_valid(
      classification_evidence,
      freight_class,
      nmfc_code
    )
  )
);

CREATE OR REPLACE FUNCTION validate_operations_outbound_handling_commodity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM operations_outbound_handling_units unit
    WHERE unit.organization_id = NEW.organization_id
      AND unit.handling_unit_plan_id = NEW.handling_unit_plan_id
      AND unit.id = NEW.handling_unit_id
      AND unit.unit_type = 'pallet'
  ) THEN
    RAISE EXCEPTION
      'Outbound handling commodities require their exact pallet unit';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_operations_outbound_handling_commodity_write
  ON operations_outbound_handling_unit_commodities;
CREATE TRIGGER validate_operations_outbound_handling_commodity_write
BEFORE INSERT ON operations_outbound_handling_unit_commodities
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_outbound_handling_commodity();

CREATE OR REPLACE FUNCTION validate_operations_outbound_handling_membership()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_plan operations_outbound_handling_unit_plans%ROWTYPE;
  current_unit operations_outbound_handling_units%ROWTYPE;
  persisted_package operations_packages%ROWTYPE;
  quote_package jsonb;
BEGIN
  SELECT * INTO current_plan
  FROM operations_outbound_handling_unit_plans plan
  WHERE plan.organization_id = NEW.organization_id
    AND plan.id = NEW.handling_unit_plan_id;
  SELECT * INTO current_unit
  FROM operations_outbound_handling_units unit
  WHERE unit.organization_id = NEW.organization_id
    AND unit.handling_unit_plan_id = NEW.handling_unit_plan_id
    AND unit.id = NEW.handling_unit_id;
  IF current_plan.id IS NULL OR current_unit.id IS NULL THEN
    RAISE EXCEPTION
      'Outbound handling membership requires its exact plan and unit';
  END IF;
  IF (
    current_plan.transport_mode = 'small_parcel'
    AND current_unit.unit_type <> 'package'
  ) OR (
    current_plan.transport_mode = 'ltl'
    AND current_unit.unit_type <> 'pallet'
  ) THEN
    RAISE EXCEPTION
      'Outbound handling-unit type does not match the transport mode';
  END IF;
  IF current_plan.transport_mode = 'ltl'
     AND NEW.package_form <> 'carton'
  THEN
    RAISE EXCEPTION
      'LTL handling plans may palletize cartons only';
  END IF;

  IF current_plan.fulfillment_plan_id IS NOT NULL
     AND NEW.package_id IS NULL
  THEN
    RAISE EXCEPTION
      'Fulfillment-scoped handling plans require persisted package memberships';
  END IF;
  IF current_plan.fulfillment_plan_id IS NULL
     AND NEW.quote_package_key IS NULL
  THEN
    RAISE EXCEPTION
      'Pre-order quote handling plans require quote-package memberships';
  END IF;

  IF NEW.package_id IS NOT NULL THEN
    SELECT * INTO persisted_package
    FROM operations_packages package
    WHERE package.organization_id = NEW.organization_id
      AND package.id = NEW.package_id;
    IF persisted_package.id IS NULL
       OR current_plan.fulfillment_plan_id IS NULL
       OR persisted_package.plan_id <> current_plan.fulfillment_plan_id
       OR persisted_package.weight_grams
         <> NEW.allocated_gross_weight_grams
       OR (
         current_unit.unit_type = 'package'
         AND (
           current_unit.length_mm <> persisted_package.length_mm
           OR current_unit.width_mm <> persisted_package.width_mm
           OR current_unit.height_mm <> persisted_package.height_mm
           OR current_unit.gross_weight_grams
             <> persisted_package.weight_grams
         )
       )
    THEN
      RAISE EXCEPTION
        'Persisted package membership must match its fulfillment plan, dimensions, and gross weight';
    END IF;
  ELSE
    IF current_plan.one_off_quote_id IS NULL THEN
      RAISE EXCEPTION
        'A quote-package membership requires one-off quote scope';
    END IF;
    SELECT package_snapshot INTO quote_package
    FROM operations_one_off_shipment_quotes quote
    CROSS JOIN LATERAL jsonb_array_elements(
      quote.packages_snapshot
    ) package_snapshot
    WHERE quote.organization_id = NEW.organization_id
      AND quote.id = current_plan.one_off_quote_id
      AND package_snapshot->>'packageKey' = NEW.quote_package_key
    LIMIT 1;
    IF quote_package IS NULL
       OR (quote_package->>'grossWeightGrams')::bigint
         <> NEW.allocated_gross_weight_grams
       OR (
         current_unit.unit_type = 'package'
         AND (
           current_unit.length_mm
             <> (quote_package->'dimensionsMm'->>'length')::integer
           OR current_unit.width_mm
             <> (quote_package->'dimensionsMm'->>'width')::integer
           OR current_unit.height_mm
             <> (quote_package->'dimensionsMm'->>'height')::integer
           OR current_unit.gross_weight_grams
             <> (quote_package->>'grossWeightGrams')::bigint
         )
       )
    THEN
      RAISE EXCEPTION
        'Quote-package membership must match the exact retained package key, dimensions, and gross weight';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_operations_outbound_handling_membership_write
  ON operations_outbound_handling_unit_memberships;
CREATE TRIGGER validate_operations_outbound_handling_membership_write
BEFORE INSERT ON operations_outbound_handling_unit_memberships
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_outbound_handling_membership();

CREATE OR REPLACE FUNCTION validate_operations_outbound_handling_plan_complete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_organization_id uuid;
  target_plan_id uuid;
  current_plan operations_outbound_handling_unit_plans%ROWTYPE;
  actual_unit_count integer;
  actual_package_count integer;
  actual_total_weight bigint;
BEGIN
  target_organization_id := NEW.organization_id;
  IF TG_TABLE_NAME = 'operations_outbound_handling_unit_plans' THEN
    target_plan_id := NEW.id;
  ELSE
    target_plan_id := NEW.handling_unit_plan_id;
  END IF;
  SELECT * INTO current_plan
  FROM operations_outbound_handling_unit_plans plan
  WHERE plan.organization_id = target_organization_id
    AND plan.id = target_plan_id;
  IF current_plan.id IS NULL THEN
    RAISE EXCEPTION 'Outbound handling plan is missing at deferred validation';
  END IF;
  IF current_plan.one_off_quote_id IS NOT NULL
     AND current_plan.fulfillment_plan_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM operations_fulfillment_plans fulfillment
       JOIN operations_one_off_shipment_quotes planning_quote
         ON planning_quote.organization_id = fulfillment.organization_id
        AND planning_quote.id = fulfillment.one_off_quote_id
       JOIN operations_one_off_shipment_quotes packed_quote
         ON packed_quote.organization_id = fulfillment.organization_id
        AND packed_quote.id = current_plan.one_off_quote_id
       WHERE fulfillment.organization_id = current_plan.organization_id
         AND fulfillment.id = current_plan.fulfillment_plan_id
         AND current_plan.source = 'packed_rerate'
         AND packed_quote.id <> planning_quote.id
         AND packed_quote.packed_rerate_order_id = fulfillment.order_id
         AND packed_quote.packed_rerate_plan_id = fulfillment.id
         AND packed_quote.execution_mode = planning_quote.execution_mode
         AND packed_quote.rate_environment = planning_quote.rate_environment
         AND packed_quote.warehouse_id = planning_quote.warehouse_id
         AND packed_quote.customer_id = planning_quote.customer_id
         AND packed_quote.inventory_pool_id = planning_quote.inventory_pool_id
         AND packed_quote.receiving_location_id
           = planning_quote.receiving_location_id
         AND packed_quote.currency = planning_quote.currency
         AND packed_quote.destination_hash = planning_quote.destination_hash
     )
  THEN
    RAISE EXCEPTION
      'Outbound handling quote and fulfillment scopes must share exact one-off lineage';
  END IF;

  SELECT count(*)::integer, COALESCE(sum(unit.gross_weight_grams), 0)
  INTO actual_unit_count, actual_total_weight
  FROM operations_outbound_handling_units unit
  WHERE unit.organization_id = current_plan.organization_id
    AND unit.handling_unit_plan_id = current_plan.id;
  SELECT count(*)::integer
  INTO actual_package_count
  FROM operations_outbound_handling_unit_memberships membership
  WHERE membership.organization_id = current_plan.organization_id
    AND membership.handling_unit_plan_id = current_plan.id;
  IF actual_unit_count <> current_plan.handling_unit_count
     OR actual_package_count <> current_plan.package_count
     OR actual_total_weight <> current_plan.total_gross_weight_grams
     OR EXISTS (
       SELECT 1
       FROM generate_series(
         1,
         current_plan.handling_unit_count
       ) required_unit_sequence(value)
       WHERE NOT EXISTS (
         SELECT 1
         FROM operations_outbound_handling_units unit
         WHERE unit.organization_id = current_plan.organization_id
           AND unit.handling_unit_plan_id = current_plan.id
           AND unit.unit_sequence = required_unit_sequence.value
       )
     )
     OR EXISTS (
       SELECT 1
       FROM generate_series(
         1,
         current_plan.package_count
       ) required_package_sequence(value)
       WHERE NOT EXISTS (
         SELECT 1
         FROM operations_outbound_handling_unit_memberships membership
         WHERE membership.organization_id = current_plan.organization_id
           AND membership.handling_unit_plan_id = current_plan.id
           AND membership.package_sequence = required_package_sequence.value
       )
     )
     OR EXISTS (
       SELECT 1
       FROM operations_outbound_handling_units unit
       LEFT JOIN operations_outbound_handling_unit_memberships membership
         ON membership.organization_id = unit.organization_id
        AND membership.handling_unit_plan_id = unit.handling_unit_plan_id
        AND membership.handling_unit_id = unit.id
       WHERE unit.organization_id = current_plan.organization_id
         AND unit.handling_unit_plan_id = current_plan.id
       GROUP BY unit.id, unit.unit_type, unit.tare_weight_grams,
                unit.gross_weight_grams
       HAVING (
         unit.unit_type = 'package'
         AND (
           count(membership.id) <> 1
           OR unit.gross_weight_grams
             <> COALESCE(sum(membership.allocated_gross_weight_grams), 0)
         )
       ) OR (
         unit.unit_type = 'pallet'
         AND (
           count(membership.id) < 1
           OR unit.gross_weight_grams
             <> unit.tare_weight_grams
               + COALESCE(sum(membership.allocated_gross_weight_grams), 0)
         )
       )
     )
     OR EXISTS (
       SELECT 1
       FROM operations_outbound_handling_units unit
       CROSS JOIN LATERAL (
         SELECT count(*)::integer AS commodity_count,
                COALESCE(sum(commodity.weight_grams), 0)::bigint
                  AS commodity_weight_grams
         FROM operations_outbound_handling_unit_commodities commodity
         WHERE commodity.organization_id = unit.organization_id
           AND commodity.handling_unit_plan_id = unit.handling_unit_plan_id
           AND commodity.handling_unit_id = unit.id
       ) commodity_stats
       CROSS JOIN LATERAL (
         SELECT count(*)::integer AS membership_count,
                COALESCE(
                  sum(membership.allocated_gross_weight_grams),
                  0
                )::bigint AS membership_weight_grams
         FROM operations_outbound_handling_unit_memberships membership
         WHERE membership.organization_id = unit.organization_id
           AND membership.handling_unit_plan_id = unit.handling_unit_plan_id
           AND membership.handling_unit_id = unit.id
       ) membership_stats
       WHERE unit.organization_id = current_plan.organization_id
         AND unit.handling_unit_plan_id = current_plan.id
         AND (
           membership_stats.membership_count < 1
           OR EXISTS (
             SELECT 1
             FROM generate_series(
               1,
               membership_stats.membership_count
             ) required_membership_sequence(value)
             WHERE NOT EXISTS (
               SELECT 1
               FROM operations_outbound_handling_unit_memberships membership
               WHERE membership.organization_id = unit.organization_id
                 AND membership.handling_unit_plan_id
                   = unit.handling_unit_plan_id
                 AND membership.handling_unit_id = unit.id
                 AND membership.membership_sequence
                   = required_membership_sequence.value
             )
           )
           OR (
             unit.unit_type = 'package'
             AND commodity_stats.commodity_count <> 0
           )
           OR (
             unit.unit_type = 'pallet'
             AND (
               commodity_stats.commodity_count < 1
               OR unit.mixed_commodities IS DISTINCT FROM
                    (commodity_stats.commodity_count > 1)
               OR commodity_stats.commodity_weight_grams
                    <> membership_stats.membership_weight_grams
               OR EXISTS (
                 SELECT 1
                 FROM generate_series(
                   1,
                   commodity_stats.commodity_count
                 ) required_commodity_sequence(value)
                 WHERE NOT EXISTS (
                   SELECT 1
                   FROM operations_outbound_handling_unit_commodities commodity
                   WHERE commodity.organization_id = unit.organization_id
                     AND commodity.handling_unit_plan_id
                       = unit.handling_unit_plan_id
                     AND commodity.handling_unit_id = unit.id
                     AND commodity.commodity_sequence
                       = required_commodity_sequence.value
                 )
               )
               OR EXISTS (
                 SELECT 1
                 FROM operations_outbound_handling_unit_commodities commodity
                 CROSS JOIN LATERAL unnest(
                   commodity.membership_sequences
                 ) membership_reference(membership_sequence)
                 WHERE commodity.organization_id = unit.organization_id
                   AND commodity.handling_unit_plan_id
                     = unit.handling_unit_plan_id
                   AND commodity.handling_unit_id = unit.id
                   AND NOT EXISTS (
                     SELECT 1
                     FROM operations_outbound_handling_unit_memberships membership
                     WHERE membership.organization_id = unit.organization_id
                       AND membership.handling_unit_plan_id
                         = unit.handling_unit_plan_id
                       AND membership.handling_unit_id = unit.id
                       AND membership.membership_sequence
                         = membership_reference.membership_sequence
                   )
               )
               OR EXISTS (
                 SELECT 1
                 FROM operations_outbound_handling_unit_memberships membership
                 WHERE membership.organization_id = unit.organization_id
                   AND membership.handling_unit_plan_id
                     = unit.handling_unit_plan_id
                   AND membership.handling_unit_id = unit.id
                   AND NOT EXISTS (
                     SELECT 1
                     FROM operations_outbound_handling_unit_commodities commodity
                     WHERE commodity.organization_id = unit.organization_id
                       AND commodity.handling_unit_plan_id
                         = unit.handling_unit_plan_id
                       AND commodity.handling_unit_id = unit.id
                       AND membership.membership_sequence
                         = ANY(commodity.membership_sequences)
                   )
               )
               OR EXISTS (
                 SELECT membership_reference.membership_sequence
                 FROM operations_outbound_handling_unit_commodities commodity
                 CROSS JOIN LATERAL unnest(
                   commodity.membership_sequences
                 ) membership_reference(membership_sequence)
                 WHERE commodity.organization_id = unit.organization_id
                   AND commodity.handling_unit_plan_id
                     = unit.handling_unit_plan_id
                   AND commodity.handling_unit_id = unit.id
                 GROUP BY membership_reference.membership_sequence
                 HAVING count(*) <> 1
               )
             )
           )
         )
     )
     OR (
       current_plan.transport_mode = 'small_parcel'
       AND (
         (
           SELECT COALESCE(
             jsonb_agg(
              jsonb_build_object(
                 'packageSequence', membership.package_sequence,
                 'packageForm', membership.package_form,
                 'packageReference', jsonb_build_object(
                   'referenceType', CASE
                     WHEN membership.package_id IS NOT NULL
                       THEN 'operations_package'
                     ELSE 'quote_package'
                   END,
                   'packageGlobalId', package.global_id,
                   'quotePackageKey', membership.quote_package_key
                 ),
                 'packageSnapshotHash', membership.package_snapshot_hash,
                 'dimensionsMm', jsonb_build_object(
                   'length', unit.length_mm,
                   'width', unit.width_mm,
                   'height', unit.height_mm
                 ),
                 'grossWeightGrams', unit.gross_weight_grams
               ) ORDER BY membership.package_sequence
             ),
             '[]'::jsonb
           )
           FROM operations_outbound_handling_units unit
           JOIN operations_outbound_handling_unit_memberships membership
             ON membership.organization_id = unit.organization_id
            AND membership.handling_unit_plan_id
              = unit.handling_unit_plan_id
            AND membership.handling_unit_id = unit.id
           LEFT JOIN operations_packages package
             ON package.organization_id = membership.organization_id
            AND package.id = membership.package_id
           WHERE unit.organization_id = current_plan.organization_id
             AND unit.handling_unit_plan_id = current_plan.id
         ) IS DISTINCT FROM current_plan.plan_snapshot->'packages'
         OR EXISTS (
           SELECT 1
           FROM operations_outbound_handling_units unit
           WHERE unit.organization_id = current_plan.organization_id
             AND unit.handling_unit_plan_id = current_plan.id
             AND unit.unit_snapshot_hash IS DISTINCT FROM
               operations_transport_json_sha256(
                 current_plan.plan_snapshot->'packages'
                   ->(unit.unit_sequence - 1)
               )
         )
       )
     )
     OR (
       current_plan.transport_mode = 'ltl'
       AND (
         (
           SELECT COALESCE(
             jsonb_agg(
               jsonb_build_object(
                 'palletKey', unit.unit_key,
                 'palletSequence', unit.unit_sequence,
                 'dimensionsMm', jsonb_build_object(
                   'length', unit.length_mm,
                   'width', unit.width_mm,
                   'height', unit.height_mm
                 ),
                 'tareWeightGrams', unit.tare_weight_grams,
                 'grossWeightGrams', unit.gross_weight_grams,
                 'stackability', unit.stackability,
                 'mixedCommodities', unit.mixed_commodities,
                 'memberships', (
                   SELECT COALESCE(
                     jsonb_agg(
                       jsonb_build_object(
                         'membershipSequence',
                           membership.membership_sequence,
                         'packageSequence', membership.package_sequence,
                         'packageForm', membership.package_form,
                         'packageReference', jsonb_build_object(
                           'referenceType', CASE
                             WHEN membership.package_id IS NOT NULL
                               THEN 'operations_package'
                             ELSE 'quote_package'
                           END,
                           'packageGlobalId', package.global_id,
                           'quotePackageKey',
                             membership.quote_package_key
                         ),
                         'packageSnapshotHash',
                           membership.package_snapshot_hash,
                         'packageGrossWeightGrams',
                           membership.allocated_gross_weight_grams
                       ) ORDER BY membership.membership_sequence
                     ),
                     '[]'::jsonb
                   )
                   FROM operations_outbound_handling_unit_memberships
                     membership
                   LEFT JOIN operations_packages package
                     ON package.organization_id = membership.organization_id
                    AND package.id = membership.package_id
                   WHERE membership.organization_id = unit.organization_id
                     AND membership.handling_unit_plan_id
                       = unit.handling_unit_plan_id
                     AND membership.handling_unit_id = unit.id
                 ),
                 'commodities', (
                   SELECT COALESCE(
                     jsonb_agg(
                       jsonb_build_object(
                         'commoditySequence',
                           commodity.commodity_sequence,
                         'description', commodity.description,
                         'pieces', commodity.pieces,
                         'weightGrams', commodity.weight_grams,
                         'classification',
                           commodity.classification_evidence,
                         'membershipSequences',
                           to_jsonb(commodity.membership_sequences)
                       ) ORDER BY commodity.commodity_sequence
                     ),
                     '[]'::jsonb
                   )
                   FROM operations_outbound_handling_unit_commodities
                     commodity
                   WHERE commodity.organization_id = unit.organization_id
                     AND commodity.handling_unit_plan_id
                       = unit.handling_unit_plan_id
                     AND commodity.handling_unit_id = unit.id
                 )
               ) ORDER BY unit.unit_sequence
             ),
             '[]'::jsonb
           )
           FROM operations_outbound_handling_units unit
           WHERE unit.organization_id = current_plan.organization_id
             AND unit.handling_unit_plan_id = current_plan.id
         ) IS DISTINCT FROM current_plan.plan_snapshot->'pallets'
         OR EXISTS (
           SELECT 1
           FROM operations_outbound_handling_units unit
           WHERE unit.organization_id = current_plan.organization_id
             AND unit.handling_unit_plan_id = current_plan.id
             AND unit.unit_snapshot_hash IS DISTINCT FROM
               operations_transport_json_sha256(
                 current_plan.plan_snapshot->'pallets'
                   ->(unit.unit_sequence - 1)
               )
         )
       )
     )
  THEN
    RAISE EXCEPTION
      'Outbound handling plan must retain exact hashed snapshot, contiguous units, package memberships, commodities, and gross weights';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_operations_outbound_handling_plan_deferred
  ON operations_outbound_handling_unit_plans;
CREATE CONSTRAINT TRIGGER
  validate_operations_outbound_handling_plan_deferred
AFTER INSERT ON operations_outbound_handling_unit_plans
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_outbound_handling_plan_complete();

DROP TRIGGER IF EXISTS validate_operations_outbound_handling_unit_deferred
  ON operations_outbound_handling_units;
CREATE CONSTRAINT TRIGGER
  validate_operations_outbound_handling_unit_deferred
AFTER INSERT ON operations_outbound_handling_units
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_outbound_handling_plan_complete();

DROP TRIGGER IF EXISTS validate_operations_outbound_handling_membership_deferred
  ON operations_outbound_handling_unit_memberships;
CREATE CONSTRAINT TRIGGER
  validate_operations_outbound_handling_membership_deferred
AFTER INSERT ON operations_outbound_handling_unit_memberships
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_outbound_handling_plan_complete();

DROP TRIGGER IF EXISTS validate_operations_outbound_handling_commodity_deferred
  ON operations_outbound_handling_unit_commodities;
CREATE CONSTRAINT TRIGGER
  validate_operations_outbound_handling_commodity_deferred
AFTER INSERT ON operations_outbound_handling_unit_commodities
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_outbound_handling_plan_complete();

CREATE OR REPLACE FUNCTION protect_operations_outbound_handling_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'Outbound handling-unit plans, units, memberships, and commodities are immutable';
END;
$$;

CREATE TRIGGER protect_operations_outbound_handling_plan_write
BEFORE UPDATE OR DELETE ON operations_outbound_handling_unit_plans
FOR EACH ROW EXECUTE FUNCTION protect_operations_outbound_handling_evidence();

CREATE TRIGGER protect_operations_outbound_handling_unit_write
BEFORE UPDATE OR DELETE ON operations_outbound_handling_units
FOR EACH ROW EXECUTE FUNCTION protect_operations_outbound_handling_evidence();

CREATE TRIGGER protect_operations_outbound_handling_membership_write
BEFORE UPDATE OR DELETE ON operations_outbound_handling_unit_memberships
FOR EACH ROW EXECUTE FUNCTION protect_operations_outbound_handling_evidence();

CREATE TRIGGER protect_operations_outbound_handling_commodity_write
BEFORE UPDATE OR DELETE ON operations_outbound_handling_unit_commodities
FOR EACH ROW EXECUTE FUNCTION protect_operations_outbound_handling_evidence();

-- Normalized transport identity on immutable offers. Existing direct rows are
-- backfilled while the append-only trigger is intentionally absent, then the
-- trigger is restored before application writes resume.
ALTER TABLE operations_one_off_shipment_quote_offers
  ADD COLUMN IF NOT EXISTS transport_mode text,
  ADD COLUMN IF NOT EXISTS handling_unit_mode text,
  ADD COLUMN IF NOT EXISTS executing_carrier_code text,
  ADD COLUMN IF NOT EXISTS executing_carrier_name text,
  ADD COLUMN IF NOT EXISTS executing_carrier_scac text,
  ADD COLUMN IF NOT EXISTS provider_quote_reference text,
  ADD COLUMN IF NOT EXISTS provider_offer_id text,
  ADD COLUMN IF NOT EXISTS provider_product_id text,
  ADD COLUMN IF NOT EXISTS provider_transaction_id text,
  ADD COLUMN IF NOT EXISTS credential_fingerprint text,
  ADD COLUMN IF NOT EXISTS handling_unit_plan_id uuid;

DROP TRIGGER IF EXISTS protect_operations_one_off_quote_offers_mutation
  ON operations_one_off_shipment_quote_offers;

UPDATE operations_one_off_shipment_quote_offers
SET transport_mode = COALESCE(transport_mode, 'small_parcel'),
    handling_unit_mode = COALESCE(handling_unit_mode, 'loose_packages'),
    executing_carrier_code = COALESCE(
      executing_carrier_code,
      CASE provider
        WHEN 'ups_rest' THEN 'UPS'
        WHEN 'fedex_rest' THEN 'FEDEX'
      END
    ),
    executing_carrier_name = COALESCE(
      executing_carrier_name,
      CASE provider
        WHEN 'ups_rest' THEN 'UPS'
        WHEN 'fedex_rest' THEN 'FedEx'
      END
    )
WHERE transport_mode IS NULL
   OR handling_unit_mode IS NULL
   OR executing_carrier_code IS NULL
   OR executing_carrier_name IS NULL;

ALTER TABLE operations_one_off_shipment_quote_offers
  ALTER COLUMN carrier_account_id DROP NOT NULL,
  ALTER COLUMN transport_mode SET DEFAULT 'small_parcel',
  ALTER COLUMN handling_unit_mode SET DEFAULT 'loose_packages',
  ALTER COLUMN transport_mode SET NOT NULL,
  ALTER COLUMN handling_unit_mode SET NOT NULL,
  ALTER COLUMN executing_carrier_code SET NOT NULL,
  ALTER COLUMN executing_carrier_name SET NOT NULL,
  DROP CONSTRAINT IF EXISTS
    operations_one_off_shipment_quote_offers_provider_check,
  DROP CONSTRAINT IF EXISTS operations_one_off_offer_provider_valid,
  ADD CONSTRAINT operations_one_off_offer_provider_valid CHECK (
    provider IN (
      'ups_rest',
      'fedex_rest',
      'wwex_speedship',
      'rl_carriers'
    )
  ),
  DROP CONSTRAINT IF EXISTS operations_one_off_offer_transport_valid,
  ADD CONSTRAINT operations_one_off_offer_transport_valid CHECK (
    (
      transport_mode = 'small_parcel'
      AND handling_unit_mode = 'loose_packages'
      AND provider_quote_reference IS NULL
      AND (
        (
          provider IN ('ups_rest', 'fedex_rest')
          AND carrier_account_id IS NOT NULL
          AND provider_offer_id IS NULL
          AND provider_product_id IS NULL
          AND provider_transaction_id IS NULL
          AND credential_fingerprint IS NULL
        )
        OR (
          provider = 'wwex_speedship'
          AND carrier_account_id IS NULL
          AND provider_offer_id IS NOT NULL
          AND provider_product_id IS NOT NULL
          AND provider_transaction_id IS NOT NULL
          AND credential_fingerprint IS NOT NULL
          AND handling_unit_plan_id IS NOT NULL
        )
      )
    )
    OR (
      transport_mode = 'ltl'
      AND handling_unit_mode = 'palletized_handling_units'
      AND provider IN ('wwex_speedship', 'rl_carriers')
      AND carrier_account_id IS NULL
      AND provider_quote_reference IS NOT NULL
      AND credential_fingerprint IS NOT NULL
      AND handling_unit_plan_id IS NOT NULL
      AND (
        (
          provider = 'wwex_speedship'
          AND executing_carrier_scac IS NOT NULL
          AND provider_offer_id IS NOT NULL
          AND provider_product_id IS NOT NULL
          AND provider_transaction_id IS NOT NULL
        )
        OR (
          provider = 'rl_carriers'
          AND provider_offer_id IS NULL
          AND provider_product_id IS NULL
          AND provider_transaction_id IS NULL
        )
      )
    )
  ),
  DROP CONSTRAINT IF EXISTS operations_one_off_offer_carrier_identity_valid,
  ADD CONSTRAINT operations_one_off_offer_carrier_identity_valid CHECK (
    executing_carrier_code ~ '^[A-Z0-9][A-Z0-9._-]{1,31}$'
    AND length(btrim(executing_carrier_name)) BETWEEN 1 AND 120
    AND (
      executing_carrier_scac IS NULL
      OR executing_carrier_scac ~ '^[A-Z]{2,4}$'
    )
    AND (provider <> 'ups_rest' OR executing_carrier_code = 'UPS')
    AND (provider <> 'fedex_rest' OR executing_carrier_code = 'FEDEX')
    AND (
      provider <> 'wwex_speedship'
      OR transport_mode <> 'small_parcel'
      OR executing_carrier_code = 'UPS'
    )
  ),
  DROP CONSTRAINT IF EXISTS operations_one_off_offer_provider_ids_valid,
  ADD CONSTRAINT operations_one_off_offer_provider_ids_valid CHECK (
    (
      provider_offer_id IS NULL
      OR length(btrim(provider_offer_id)) BETWEEN 1 AND 200
    )
    AND (
      provider_product_id IS NULL
      OR length(btrim(provider_product_id)) BETWEEN 1 AND 200
    )
    AND (
      provider_transaction_id IS NULL
      OR length(btrim(provider_transaction_id)) BETWEEN 1 AND 200
    )
    AND (
      credential_fingerprint IS NULL
      OR credential_fingerprint ~ '^[a-f0-9]{64}$'
    )
  ),
  DROP CONSTRAINT IF EXISTS operations_one_off_offer_transport_plan_fkey,
  ADD CONSTRAINT operations_one_off_offer_transport_plan_fkey
    FOREIGN KEY (organization_id, handling_unit_plan_id)
    REFERENCES operations_outbound_handling_unit_plans(organization_id, id)
    ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS
    operations_one_off_shipment_quote_offers_service_unique;

CREATE UNIQUE INDEX IF NOT EXISTS
  operations_one_off_shipment_quote_offers_service_unique
ON operations_one_off_shipment_quote_offers (
  organization_id,
  quote_id,
  provider,
  transport_mode,
  executing_carrier_code,
  service_code,
  COALESCE(provider_quote_reference, ''),
  COALESCE(provider_offer_id, ''),
  COALESCE(provider_product_id, ''),
  COALESCE(provider_transaction_id, '')
);

CREATE OR REPLACE FUNCTION normalize_operations_one_off_transport_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.transport_mode := COALESCE(NEW.transport_mode, 'small_parcel');
  NEW.handling_unit_mode := COALESCE(
    NEW.handling_unit_mode,
    CASE NEW.transport_mode
      WHEN 'small_parcel' THEN 'loose_packages'
      WHEN 'ltl' THEN 'palletized_handling_units'
    END
  );
  IF NEW.executing_carrier_code IS NULL THEN
    NEW.executing_carrier_code := CASE NEW.provider
      WHEN 'ups_rest' THEN 'UPS'
      WHEN 'fedex_rest' THEN 'FEDEX'
    END;
  END IF;
  IF NEW.executing_carrier_name IS NULL THEN
    NEW.executing_carrier_name := CASE NEW.provider
      WHEN 'ups_rest' THEN 'UPS'
      WHEN 'fedex_rest' THEN 'FedEx'
    END;
  END IF;
  NEW.executing_carrier_code := upper(btrim(NEW.executing_carrier_code));
  NEW.executing_carrier_name := btrim(NEW.executing_carrier_name);
  NEW.executing_carrier_scac := NULLIF(
    upper(btrim(NEW.executing_carrier_scac)),
    ''
  );
  NEW.provider_quote_reference := NULLIF(
    btrim(NEW.provider_quote_reference),
    ''
  );
  NEW.provider_offer_id := NULLIF(btrim(NEW.provider_offer_id), '');
  NEW.provider_product_id := NULLIF(btrim(NEW.provider_product_id), '');
  NEW.provider_transaction_id := NULLIF(
    btrim(NEW.provider_transaction_id),
    ''
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION validate_operations_one_off_offer_transport()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.handling_unit_plan_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM operations_outbound_handling_unit_plans plan
    WHERE plan.organization_id = NEW.organization_id
      AND plan.id = NEW.handling_unit_plan_id
      AND plan.one_off_quote_id = NEW.quote_id
      AND plan.transport_mode = NEW.transport_mode
      AND plan.handling_unit_mode = NEW.handling_unit_mode
  ) THEN
    RAISE EXCEPTION
      'One-off offer handling plan must match its exact quote and transport mode';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER normalize_operations_one_off_offer_transport_write
BEFORE INSERT OR UPDATE ON operations_one_off_shipment_quote_offers
FOR EACH ROW EXECUTE FUNCTION normalize_operations_one_off_transport_identity();

CREATE TRIGGER validate_operations_one_off_offer_transport_write
BEFORE INSERT OR UPDATE ON operations_one_off_shipment_quote_offers
FOR EACH ROW EXECUTE FUNCTION validate_operations_one_off_offer_transport();

CREATE TRIGGER protect_operations_one_off_quote_offers_mutation
BEFORE UPDATE OR DELETE ON operations_one_off_shipment_quote_offers
FOR EACH ROW EXECUTE FUNCTION protect_operations_append_only();

-- Permit the provider-neutral evidence purpose while retaining all exact
-- account, environment, request-hash, and succeeded-result requirements.
CREATE OR REPLACE FUNCTION validate_operations_one_off_quote_offer()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM operations_one_off_shipment_quotes quote
    JOIN operations_carrier_rate_requests evidence
      ON evidence.organization_id = quote.organization_id
     AND evidence.global_id = NEW.rate_evidence_global_id
    LEFT JOIN operations_carrier_credentials credential
      ON credential.organization_id = NEW.organization_id
     AND credential.integration_account_id = NEW.integration_account_id
    WHERE quote.organization_id = NEW.organization_id
      AND quote.id = NEW.quote_id
      AND quote.rate_environment = NEW.environment
      AND quote.currency = NEW.currency
      AND NEW.provider = ANY(quote.required_carrier_providers)
      AND (
        (
          quote.required_transport_sources IS NULL
          AND NEW.provider IN ('ups_rest', 'fedex_rest')
        )
        OR NEW.provider || ':' || NEW.transport_mode
          = ANY(quote.required_transport_sources)
      )
      AND evidence.provider = NEW.provider
      AND evidence.integration_account_id = NEW.integration_account_id
      AND evidence.carrier_account_id
        IS NOT DISTINCT FROM NEW.carrier_account_id
      AND evidence.credential_version = NEW.credential_version
      AND evidence.environment = NEW.environment
      AND evidence.purpose IN (
        'cartonization_shipment_rate',
        'one_off_transport_rate'
      )
      AND evidence.status = 'succeeded'
      AND evidence.request_hash = NEW.carrier_request_hash
      AND (
        (
          NEW.provider IN ('ups_rest', 'fedex_rest')
          AND NEW.credential_fingerprint IS NULL
        )
        OR (
          NEW.provider IN ('wwex_speedship', 'rl_carriers')
          AND credential.credential_version = NEW.credential_version
          AND credential.credential_fingerprint
            = NEW.credential_fingerprint
        )
      )
      AND (
        NEW.provider <> 'wwex_speedship'
        OR EXISTS (
          SELECT 1
          FROM jsonb_array_elements(
            CASE
              WHEN jsonb_typeof(evidence.redacted_response->'rates') = 'array'
                THEN evidence.redacted_response->'rates'
              ELSE '[]'::jsonb
            END
          ) retained_rate
          WHERE retained_rate->>'offerId' = NEW.provider_offer_id
            AND retained_rate->>'offeredProductId'
              = NEW.provider_product_id
            AND retained_rate->>'productTransactionId'
              = NEW.provider_transaction_id
        )
      )
  ) THEN
    RAISE EXCEPTION
      'One-off quote offer must retain exact succeeded transport-rate evidence';
  END IF;
  RETURN NEW;
END;
$$;

-- Mode-aware quote sealing. Legacy direct writers may temporarily omit the
-- additive source fields; every brokered offer must use provider:mode keys.
CREATE OR REPLACE FUNCTION validate_operations_one_off_quote_seal()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  successful_source_count integer;
  required_source_count integer;
  required_source text;
  source_has_offer boolean;
  source_result_status text;
  required_provider text;
BEGIN
  IF NEW.required_transport_sources IS NOT NULL THEN
    SELECT count(DISTINCT (
      offer.provider || ':' || offer.transport_mode
    ))::integer
    INTO successful_source_count
    FROM operations_one_off_shipment_quote_offers offer
    WHERE offer.organization_id = NEW.organization_id
      AND offer.quote_id = NEW.id;
    required_source_count := cardinality(NEW.required_transport_sources);

    FOREACH required_source IN ARRAY NEW.required_transport_sources LOOP
      source_has_offer := EXISTS (
        SELECT 1
        FROM operations_one_off_shipment_quote_offers offer
        WHERE offer.organization_id = NEW.organization_id
          AND offer.quote_id = NEW.id
          AND offer.provider || ':' || offer.transport_mode
            = required_source
      );
      source_result_status :=
        NEW.transport_results_snapshot -> required_source ->> 'status';
      IF source_result_status NOT IN ('succeeded', 'failed')
         OR source_has_offer IS DISTINCT FROM
            (source_result_status = 'succeeded')
      THEN
        RAISE EXCEPTION
          'One-off quote transport-source result does not match retained mode-specific offers';
      END IF;
    END LOOP;
  ELSE
    SELECT count(DISTINCT offer.provider)::integer
    INTO successful_source_count
    FROM operations_one_off_shipment_quote_offers offer
    WHERE offer.organization_id = NEW.organization_id
      AND offer.quote_id = NEW.id;
    required_source_count := cardinality(NEW.required_carrier_providers);

    FOREACH required_provider IN ARRAY NEW.required_carrier_providers LOOP
      source_has_offer := EXISTS (
        SELECT 1
        FROM operations_one_off_shipment_quote_offers offer
        WHERE offer.organization_id = NEW.organization_id
          AND offer.quote_id = NEW.id
          AND offer.provider = required_provider
      );
      source_result_status :=
        NEW.provider_results_snapshot -> required_provider ->> 'status';
      IF source_result_status NOT IN ('succeeded', 'failed')
         OR source_has_offer IS DISTINCT FROM
            (source_result_status = 'succeeded')
      THEN
        RAISE EXCEPTION
          'Legacy one-off quote provider result does not match retained offers';
      END IF;
    END LOOP;
  END IF;

  IF (
    NEW.status = 'succeeded'
    AND successful_source_count = required_source_count
  ) OR (
    NEW.status = 'partial'
    AND successful_source_count > 0
    AND successful_source_count < required_source_count
  ) OR (
    NEW.status = 'failed'
    AND successful_source_count = 0
  ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'One-off quote status does not match retained transport-source offers';
END;
$$;

CREATE OR REPLACE FUNCTION operations_one_off_plan_authority_is_valid(
  authority_organization_id uuid,
  authority_order_id uuid,
  authority_warehouse_id uuid,
  authority_quote_id uuid,
  authority_offer_id uuid,
  required_execution_mode text DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM operations_one_off_shipment_quotes quote
    JOIN operations_one_off_shipment_quote_offers offer
      ON offer.organization_id = quote.organization_id
     AND offer.quote_id = quote.id
     AND offer.id = authority_offer_id
    JOIN operations_one_off_shipment_quote_consumptions consumption
      ON consumption.organization_id = quote.organization_id
     AND consumption.quote_id = quote.id
     AND consumption.offer_id = offer.id
     AND consumption.order_id = authority_order_id
    JOIN operations_orders source_order
      ON source_order.organization_id = consumption.organization_id
     AND source_order.id = consumption.order_id
    JOIN operations_carrier_rate_requests evidence
      ON evidence.organization_id = offer.organization_id
     AND evidence.global_id = offer.rate_evidence_global_id
    WHERE quote.organization_id = authority_organization_id
      AND quote.id = authority_quote_id
      AND quote.warehouse_id = authority_warehouse_id
      AND quote.status IN ('succeeded', 'partial')
      AND source_order.source_provider = 'clawpilot_native'
      AND source_order.order_type = 'one_off'
      AND (
        required_execution_mode IS NULL
        OR quote.execution_mode = required_execution_mode
      )
      AND (
        (quote.execution_mode = 'test'
          AND quote.rate_environment = 'sandbox'
          AND offer.environment = 'sandbox'
          AND evidence.environment = 'sandbox')
        OR
        (quote.execution_mode = 'live'
          AND quote.rate_environment = 'production'
          AND offer.environment = 'production'
          AND evidence.environment = 'production')
      )
      AND evidence.status = 'succeeded'
      AND evidence.purpose IN (
        'cartonization_shipment_rate',
        'one_off_transport_rate'
      )
      AND evidence.provider = offer.provider
      AND evidence.integration_account_id = offer.integration_account_id
      AND evidence.carrier_account_id
        IS NOT DISTINCT FROM offer.carrier_account_id
      AND evidence.request_hash = offer.carrier_request_hash
      AND (
        (
          quote.required_transport_sources IS NULL
          AND offer.provider IN ('ups_rest', 'fedex_rest')
        )
        OR offer.provider || ':' || offer.transport_mode
          = ANY(quote.required_transport_sources)
      )
  )
$$;

CREATE OR REPLACE FUNCTION operations_one_off_purchase_quote_is_valid(
  authority_organization_id uuid,
  authority_plan_id uuid,
  authority_purchase_quote_id uuid,
  authority_purchase_offer_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM operations_fulfillment_plans plan
    JOIN operations_one_off_shipment_quotes planning_quote
      ON planning_quote.organization_id = plan.organization_id
     AND planning_quote.id = plan.one_off_quote_id
    JOIN operations_one_off_shipment_quote_offers planning_offer
      ON planning_offer.organization_id = plan.organization_id
     AND planning_offer.quote_id = plan.one_off_quote_id
     AND planning_offer.id = plan.one_off_offer_id
    JOIN operations_one_off_shipment_quotes purchase_quote
      ON purchase_quote.organization_id = plan.organization_id
     AND purchase_quote.id = authority_purchase_quote_id
    JOIN operations_one_off_shipment_quote_offers purchase_offer
      ON purchase_offer.organization_id = purchase_quote.organization_id
     AND purchase_offer.quote_id = purchase_quote.id
     AND purchase_offer.id = authority_purchase_offer_id
    JOIN operations_carrier_rate_requests evidence
      ON evidence.organization_id = purchase_offer.organization_id
     AND evidence.global_id = purchase_offer.rate_evidence_global_id
    WHERE plan.organization_id = authority_organization_id
      AND plan.id = authority_plan_id
      AND purchase_quote.id <> planning_quote.id
      AND purchase_quote.packed_rerate_order_id = plan.order_id
      AND purchase_quote.packed_rerate_plan_id = plan.id
      AND purchase_quote.expires_at > clock_timestamp()
      AND purchase_quote.status IN ('succeeded', 'partial')
      AND purchase_quote.execution_mode = planning_quote.execution_mode
      AND purchase_quote.rate_environment = planning_quote.rate_environment
      AND purchase_quote.warehouse_id = planning_quote.warehouse_id
      AND purchase_quote.customer_id = planning_quote.customer_id
      AND purchase_quote.inventory_pool_id = planning_quote.inventory_pool_id
      AND purchase_quote.receiving_location_id
        = planning_quote.receiving_location_id
      AND purchase_quote.currency = planning_quote.currency
      AND purchase_quote.destination_hash = planning_quote.destination_hash
      AND purchase_quote.packages_hash = planning_quote.packages_hash
      AND jsonb_array_length(purchase_quote.packages_snapshot) BETWEEN 1 AND 40
      AND NOT EXISTS (
        SELECT 1
        FROM operations_one_off_purchase_quote_consumptions used
        WHERE used.organization_id = purchase_quote.organization_id
          AND used.quote_id = purchase_quote.id
      )
      AND purchase_offer.provider = planning_offer.provider
      AND purchase_offer.transport_mode = planning_offer.transport_mode
      AND purchase_offer.handling_unit_mode
        = planning_offer.handling_unit_mode
      AND purchase_offer.executing_carrier_code
        = planning_offer.executing_carrier_code
      AND purchase_offer.executing_carrier_name
        = planning_offer.executing_carrier_name
      AND purchase_offer.executing_carrier_scac
        IS NOT DISTINCT FROM planning_offer.executing_carrier_scac
      AND purchase_offer.service_code = planning_offer.service_code
      AND purchase_offer.integration_account_id
        = planning_offer.integration_account_id
      AND purchase_offer.carrier_account_id
        IS NOT DISTINCT FROM planning_offer.carrier_account_id
      AND purchase_offer.environment = planning_offer.environment
      AND purchase_offer.currency = planning_offer.currency
      AND evidence.status = 'succeeded'
      AND evidence.purpose IN (
        'cartonization_shipment_rate',
        'one_off_transport_rate'
      )
      AND evidence.provider = purchase_offer.provider
      AND evidence.environment = purchase_offer.environment
      AND evidence.integration_account_id
        = purchase_offer.integration_account_id
      AND evidence.carrier_account_id
        IS NOT DISTINCT FROM purchase_offer.carrier_account_id
      AND evidence.request_hash = purchase_offer.carrier_request_hash
      AND (
        (
          purchase_quote.required_transport_sources IS NULL
          AND purchase_offer.provider IN ('ups_rest', 'fedex_rest')
        )
        OR purchase_offer.provider || ':' || purchase_offer.transport_mode
          = ANY(purchase_quote.required_transport_sources)
      )
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(
          CASE
            WHEN jsonb_typeof(evidence.redacted_response->'rates') = 'array'
              THEN evidence.redacted_response->'rates'
            ELSE '[]'::jsonb
          END
        ) retained_rate
        WHERE retained_rate->>'serviceCode' = purchase_offer.service_code
          AND upper(retained_rate->>'currency') = purchase_offer.currency
          AND retained_rate->>'amount' ~ '^[0-9]+(?:\.[0-9]{1,4})?$'
          AND round((retained_rate->>'amount')::numeric * 100)::bigint
            = purchase_offer.amount_minor
          AND (
            purchase_offer.provider <> 'wwex_speedship'
            OR (
              retained_rate->>'offerId' = purchase_offer.provider_offer_id
              AND retained_rate->>'offeredProductId'
                = purchase_offer.provider_product_id
              AND retained_rate->>'productTransactionId'
                = purchase_offer.provider_transaction_id
            )
          )
      )
  )
$$;

-- Carrier rates display executing-carrier identity; provider identity remains
-- on the selected immutable offer and rate evidence.
CREATE OR REPLACE FUNCTION validate_operations_one_off_carrier_rate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.one_off_quote_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM operations_fulfillment_plans plan
    JOIN operations_one_off_shipment_quotes quote
      ON quote.organization_id = plan.organization_id
     AND quote.id = plan.one_off_quote_id
    JOIN operations_one_off_shipment_quote_offers offer
      ON offer.organization_id = plan.organization_id
     AND offer.quote_id = plan.one_off_quote_id
     AND offer.id = plan.one_off_offer_id
    JOIN operations_carrier_rate_requests evidence
      ON evidence.organization_id = offer.organization_id
     AND evidence.global_id = offer.rate_evidence_global_id
    WHERE plan.organization_id = NEW.organization_id
      AND plan.id = NEW.plan_id
      AND plan.one_off_quote_id = NEW.one_off_quote_id
      AND NEW.one_off_offer_id = offer.id
      AND NEW.one_off_rate_evidence_global_id = offer.rate_evidence_global_id
      AND NEW.one_off_currency = offer.currency
      AND NEW.one_off_currency = quote.currency
      AND NEW.internal_cost_minor = offer.amount_minor
      AND NEW.service_code = offer.service_code
      AND (
        upper(regexp_replace(NEW.carrier, '[^A-Z0-9]', '', 'g'))
          = upper(regexp_replace(
              offer.executing_carrier_code,
              '[^A-Z0-9]',
              '',
              'g'
            ))
        OR lower(btrim(NEW.carrier))
          = lower(btrim(offer.executing_carrier_name))
      )
      AND evidence.status = 'succeeded'
      AND evidence.provider = offer.provider
      AND evidence.environment = offer.environment
      AND evidence.integration_account_id = offer.integration_account_id
      AND evidence.carrier_account_id
        IS NOT DISTINCT FROM offer.carrier_account_id
      AND evidence.request_hash = offer.carrier_request_hash
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(
          CASE
            WHEN jsonb_typeof(evidence.redacted_response->'rates') = 'array'
              THEN evidence.redacted_response->'rates'
            ELSE '[]'::jsonb
          END
        ) retained_rate
        WHERE retained_rate->>'serviceCode' = offer.service_code
          AND upper(retained_rate->>'currency') = offer.currency
          AND retained_rate->>'amount' ~ '^[0-9]+(?:\.[0-9]{1,4})?$'
          AND round((retained_rate->>'amount')::numeric * 100)::bigint
            = offer.amount_minor
      )
  ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION
    'One-off carrier rate must match its exact immutable offer, executing carrier, and provider evidence';
END;
$$;

-- Parcel group commands remain parcel commands. The explicit columns prevent
-- provider/executing-carrier collapse and make an accidental LTL label-group
-- insert fail closed.
ALTER TABLE operations_one_off_carrier_group_attempts
  ADD COLUMN IF NOT EXISTS transport_mode text,
  ADD COLUMN IF NOT EXISTS handling_unit_mode text,
  ADD COLUMN IF NOT EXISTS executing_carrier_code text,
  ADD COLUMN IF NOT EXISTS executing_carrier_name text,
  ADD COLUMN IF NOT EXISTS executing_carrier_scac text,
  ADD COLUMN IF NOT EXISTS provider_quote_reference text,
  ADD COLUMN IF NOT EXISTS provider_offer_id text,
  ADD COLUMN IF NOT EXISTS provider_product_id text,
  ADD COLUMN IF NOT EXISTS provider_transaction_id text,
  ADD COLUMN IF NOT EXISTS provider_billing_account_fingerprint text,
  ADD COLUMN IF NOT EXISTS credential_version integer,
  ADD COLUMN IF NOT EXISTS credential_fingerprint text,
  ADD COLUMN IF NOT EXISTS handling_unit_plan_id uuid,
  ADD COLUMN IF NOT EXISTS pickup_attempt_id uuid;

DROP TRIGGER IF EXISTS protect_operations_one_off_group_attempt_write
  ON operations_one_off_carrier_group_attempts;

UPDATE operations_one_off_carrier_group_attempts
SET transport_mode = COALESCE(transport_mode, 'small_parcel'),
    handling_unit_mode = COALESCE(handling_unit_mode, 'loose_packages'),
    executing_carrier_code = COALESCE(
      executing_carrier_code,
      CASE provider
        WHEN 'ups_rest' THEN 'UPS'
        WHEN 'fedex_rest' THEN 'FEDEX'
      END
    ),
    executing_carrier_name = COALESCE(
      executing_carrier_name,
      CASE provider
        WHEN 'ups_rest' THEN 'UPS'
        WHEN 'fedex_rest' THEN 'FedEx'
      END
    )
WHERE transport_mode IS NULL
   OR handling_unit_mode IS NULL
   OR executing_carrier_code IS NULL
   OR executing_carrier_name IS NULL;

ALTER TABLE operations_one_off_carrier_group_attempts
  ALTER COLUMN carrier_account_id DROP NOT NULL,
  ALTER COLUMN transport_mode SET DEFAULT 'small_parcel',
  ALTER COLUMN handling_unit_mode SET DEFAULT 'loose_packages',
  ALTER COLUMN transport_mode SET NOT NULL,
  ALTER COLUMN handling_unit_mode SET NOT NULL,
  DROP CONSTRAINT IF EXISTS
    operations_one_off_carrier_group_attempts_provider_check,
  DROP CONSTRAINT IF EXISTS operations_one_off_group_provider_valid,
  ADD CONSTRAINT operations_one_off_group_provider_valid CHECK (
    provider IN (
      'ups_rest',
      'fedex_rest',
      'wwex_speedship',
      'rl_carriers'
    )
  ),
  DROP CONSTRAINT IF EXISTS operations_one_off_group_transport_valid,
  ADD CONSTRAINT operations_one_off_group_transport_valid CHECK (
    transport_mode = 'small_parcel'
    AND handling_unit_mode = 'loose_packages'
    AND provider_quote_reference IS NULL
    AND (
      (
        provider IN ('ups_rest', 'fedex_rest')
        AND carrier_account_id IS NOT NULL
        AND provider_offer_id IS NULL
        AND provider_product_id IS NULL
        AND provider_transaction_id IS NULL
        AND provider_billing_account_fingerprint IS NULL
        AND credential_version IS NULL
        AND credential_fingerprint IS NULL
        AND handling_unit_plan_id IS NULL
        AND pickup_attempt_id IS NULL
      )
      OR (
        provider = 'wwex_speedship'
        AND carrier_account_id IS NULL
        AND provider_offer_id IS NOT NULL
        AND provider_product_id IS NOT NULL
        AND provider_transaction_id IS NOT NULL
        AND provider_billing_account_fingerprint IS NOT NULL
        AND credential_version IS NOT NULL
        AND credential_fingerprint IS NOT NULL
        AND handling_unit_plan_id IS NOT NULL
        AND pickup_attempt_id IS NOT NULL
      )
    )
  ),
  DROP CONSTRAINT IF EXISTS operations_one_off_group_carrier_identity_valid,
  ADD CONSTRAINT operations_one_off_group_carrier_identity_valid CHECK (
    executing_carrier_code ~ '^[A-Z0-9][A-Z0-9._-]{1,31}$'
    AND length(btrim(executing_carrier_name)) BETWEEN 1 AND 120
    AND (
      executing_carrier_scac IS NULL
      OR executing_carrier_scac ~ '^[A-Z]{2,4}$'
    )
    AND (provider <> 'ups_rest' OR executing_carrier_code = 'UPS')
    AND (provider <> 'fedex_rest' OR executing_carrier_code = 'FEDEX')
    AND (
      provider <> 'wwex_speedship'
      OR executing_carrier_code = 'UPS'
    )
  ),
  DROP CONSTRAINT IF EXISTS operations_one_off_group_provider_ids_valid,
  ADD CONSTRAINT operations_one_off_group_provider_ids_valid CHECK (
    (
      provider_offer_id IS NULL
      OR length(btrim(provider_offer_id)) BETWEEN 1 AND 200
    )
    AND (
      provider_product_id IS NULL
      OR length(btrim(provider_product_id)) BETWEEN 1 AND 200
    )
    AND (
      provider_transaction_id IS NULL
      OR length(btrim(provider_transaction_id)) BETWEEN 1 AND 200
    )
    AND (
      provider_billing_account_fingerprint IS NULL
      OR provider_billing_account_fingerprint ~ '^[a-f0-9]{64}$'
    )
    AND (credential_version IS NULL OR credential_version > 0)
    AND (
      credential_fingerprint IS NULL
      OR credential_fingerprint ~ '^[a-f0-9]{64}$'
    )
  ),
  DROP CONSTRAINT IF EXISTS operations_one_off_group_transport_plan_fkey,
  ADD CONSTRAINT operations_one_off_group_transport_plan_fkey
    FOREIGN KEY (organization_id, handling_unit_plan_id)
    REFERENCES operations_outbound_handling_unit_plans(organization_id, id)
    ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION validate_operations_one_off_group_prepare()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  activation_state text;
  linked_create operations_one_off_carrier_group_attempts%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'operations:one-off-carrier-group:' || NEW.organization_id::text
      || ':' || NEW.order_id::text,
    0
  ));
  SELECT activation.state INTO activation_state
  FROM operations_activation_scopes activation
  WHERE activation.organization_id = NEW.organization_id;
  IF NEW.action = 'create' AND (
    (NEW.environment = 'production' AND activation_state <> 'active')
    OR (NEW.environment = 'sandbox' AND activation_state <> 'shadow')
  ) THEN
    RAISE EXCEPTION
      'One-off carrier group environment does not match Operations activation';
  END IF;
  IF NEW.action = 'create' THEN
    IF EXISTS (
      SELECT 1
      FROM operations_one_off_carrier_group_attempts prior_create
      WHERE prior_create.organization_id = NEW.organization_id
        AND prior_create.order_id = NEW.order_id
        AND prior_create.plan_id = NEW.plan_id
        AND prior_create.action = 'create'
        AND prior_create.state = 'succeeded'
        AND NOT EXISTS (
          SELECT 1
          FROM operations_one_off_carrier_group_attempts prior_close
          WHERE prior_close.organization_id = prior_create.organization_id
            AND prior_close.create_attempt_id = prior_create.id
            AND prior_close.action IN ('void', 'close_sample')
            AND prior_close.state = 'succeeded'
        )
    ) THEN
      RAISE EXCEPTION
        'An active successful one-off carrier group must be voided before repurchase';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM operations_packages package
      JOIN operations_labels label
        ON label.organization_id = package.organization_id
       AND label.package_id = package.id
      WHERE package.organization_id = NEW.organization_id
        AND package.plan_id = NEW.plan_id
        AND label.status = 'created'
    ) THEN
      RAISE EXCEPTION
        'One-off group purchase cannot begin with a competing active label';
    END IF;
    IF NOT operations_one_off_plan_execution_is_exact(
      NEW.organization_id, NEW.plan_id,
      CASE WHEN NEW.environment = 'production' THEN 'live' ELSE 'test' END
    ) OR NOT operations_one_off_purchase_quote_is_valid(
      NEW.organization_id, NEW.plan_id,
      NEW.purchase_quote_id, NEW.purchase_offer_id
    ) OR NOT EXISTS (
      SELECT 1
      FROM operations_fulfillment_plans plan
      JOIN operations_orders source_order
        ON source_order.organization_id = plan.organization_id
       AND source_order.id = plan.order_id
      JOIN operations_one_off_shipment_quote_offers purchase_offer
        ON purchase_offer.organization_id = plan.organization_id
       AND purchase_offer.quote_id = NEW.purchase_quote_id
       AND purchase_offer.id = NEW.purchase_offer_id
      WHERE plan.organization_id = NEW.organization_id
        AND plan.id = NEW.plan_id
        AND plan.order_id = NEW.order_id
        AND plan.one_off_quote_id = NEW.planning_quote_id
        AND plan.one_off_offer_id = NEW.planning_offer_id
        AND source_order.status = 'packed'
        AND NEW.integration_account_id
          = purchase_offer.integration_account_id
        AND NEW.carrier_account_id
          IS NOT DISTINCT FROM purchase_offer.carrier_account_id
        AND NEW.provider = purchase_offer.provider
        AND NEW.transport_mode = purchase_offer.transport_mode
        AND NEW.handling_unit_mode = purchase_offer.handling_unit_mode
        AND NEW.executing_carrier_code
          = purchase_offer.executing_carrier_code
        AND NEW.executing_carrier_name
          = purchase_offer.executing_carrier_name
        AND NEW.executing_carrier_scac
          IS NOT DISTINCT FROM purchase_offer.executing_carrier_scac
        AND NEW.provider_offer_id
          IS NOT DISTINCT FROM purchase_offer.provider_offer_id
        AND NEW.provider_product_id
          IS NOT DISTINCT FROM purchase_offer.provider_product_id
        AND NEW.provider_transaction_id
          IS NOT DISTINCT FROM purchase_offer.provider_transaction_id
        AND NEW.service_code = purchase_offer.service_code
        AND NEW.selected_amount_minor = purchase_offer.amount_minor
        AND NEW.currency = purchase_offer.currency
        AND NEW.package_count = (
          SELECT count(*)
          FROM operations_packages package
          WHERE package.organization_id = plan.organization_id
            AND package.plan_id = plan.id
            AND package.status = 'packed'
        )
    ) THEN
      RAISE EXCEPTION
        'One-off group purchase must use a fresh exact packed rerate and complete package set';
    END IF;
  ELSE
    SELECT * INTO linked_create
    FROM operations_one_off_carrier_group_attempts candidate
    WHERE candidate.organization_id = NEW.organization_id
      AND candidate.id = NEW.create_attempt_id;
    IF linked_create.id IS NULL OR linked_create.action <> 'create'
       OR linked_create.state <> 'succeeded'
       OR linked_create.order_id <> NEW.order_id
       OR linked_create.plan_id <> NEW.plan_id
       OR linked_create.planning_quote_id <> NEW.planning_quote_id
       OR linked_create.planning_offer_id <> NEW.planning_offer_id
       OR linked_create.purchase_quote_id <> NEW.purchase_quote_id
       OR linked_create.purchase_offer_id <> NEW.purchase_offer_id
       OR linked_create.carrier_rate_id <> NEW.carrier_rate_id
       OR linked_create.integration_account_id <> NEW.integration_account_id
       OR linked_create.carrier_account_id
         IS DISTINCT FROM NEW.carrier_account_id
       OR linked_create.environment <> NEW.environment
       OR linked_create.provider <> NEW.provider
       OR linked_create.service_code <> NEW.service_code
       OR linked_create.package_count <> NEW.package_count
       OR linked_create.selected_amount_minor <> NEW.selected_amount_minor
       OR linked_create.currency <> NEW.currency
       OR linked_create.master_tracking_number <> NEW.master_tracking_number
       OR linked_create.provider_shipment_id <> NEW.provider_shipment_id
    THEN
      RAISE EXCEPTION
        'Whole-shipment void must retain the exact successful create group';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM operations_orders source_order
      WHERE source_order.organization_id = NEW.organization_id
        AND source_order.id = NEW.order_id
        AND source_order.status = 'packed'
        AND NOT EXISTS (
          SELECT 1
          FROM operations_shipments shipment
          WHERE shipment.organization_id = source_order.organization_id
            AND shipment.order_id = source_order.id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM operations_one_off_carrier_group_members member
          JOIN operations_packages package
            ON package.organization_id = member.organization_id
           AND package.id = member.package_id
          WHERE member.organization_id = NEW.organization_id
            AND member.carrier_group_attempt_id = NEW.create_attempt_id
            AND package.status <> 'labeled'
        )
    ) THEN
      RAISE EXCEPTION
        'Whole-shipment void is available only before shipment confirmation';
    END IF;
    IF NEW.action = 'close_sample' AND NOT (
      NEW.environment = 'sandbox' AND NEW.provider = 'ups_rest'
      AND NEW.master_tracking_number ~* '^1Z[X]{16}$'
      AND NEW.provider_shipment_id ~* '^1Z[X]{16}$'
    ) THEN
      RAISE EXCEPTION
        'Local sample close is limited to UPS CIE sample shipments';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER normalize_operations_one_off_group_transport_write
BEFORE INSERT OR UPDATE ON operations_one_off_carrier_group_attempts
FOR EACH ROW EXECUTE FUNCTION normalize_operations_one_off_transport_identity();

CREATE OR REPLACE FUNCTION validate_operations_one_off_group_transport()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.action = 'create' AND NOT EXISTS (
    SELECT 1
    FROM operations_one_off_shipment_quote_offers offer
    JOIN operations_integration_accounts integration
      ON integration.organization_id = offer.organization_id
     AND integration.id = offer.integration_account_id
    LEFT JOIN operations_carrier_credentials credential
      ON credential.organization_id = integration.organization_id
     AND credential.integration_account_id = integration.id
    WHERE offer.organization_id = NEW.organization_id
      AND offer.quote_id = NEW.purchase_quote_id
      AND offer.id = NEW.purchase_offer_id
      AND offer.provider = NEW.provider
      AND offer.environment = NEW.environment
      AND offer.integration_account_id = NEW.integration_account_id
      AND offer.carrier_account_id
        IS NOT DISTINCT FROM NEW.carrier_account_id
      AND offer.transport_mode = NEW.transport_mode
      AND offer.handling_unit_mode = NEW.handling_unit_mode
      AND offer.executing_carrier_code = NEW.executing_carrier_code
      AND offer.executing_carrier_name = NEW.executing_carrier_name
      AND offer.executing_carrier_scac
        IS NOT DISTINCT FROM NEW.executing_carrier_scac
      AND offer.provider_quote_reference
        IS NOT DISTINCT FROM NEW.provider_quote_reference
      AND offer.provider_offer_id
        IS NOT DISTINCT FROM NEW.provider_offer_id
      AND offer.provider_product_id
        IS NOT DISTINCT FROM NEW.provider_product_id
      AND offer.provider_transaction_id
        IS NOT DISTINCT FROM NEW.provider_transaction_id
      AND offer.handling_unit_plan_id
        IS NOT DISTINCT FROM NEW.handling_unit_plan_id
      AND (
        (
          NEW.provider IN ('ups_rest', 'fedex_rest')
          AND NEW.credential_version IS NULL
          AND NEW.credential_fingerprint IS NULL
          AND NEW.provider_billing_account_fingerprint IS NULL
        )
        OR (
          NEW.provider = 'wwex_speedship'
          AND offer.credential_version = NEW.credential_version
          AND offer.credential_fingerprint = NEW.credential_fingerprint
          AND credential.credential_version = NEW.credential_version
          AND credential.credential_fingerprint = NEW.credential_fingerprint
          AND credential.verification_status = 'verified'
          AND integration.integration_type = 'carrier'
          AND integration.provider = NEW.provider
          AND integration.environment = NEW.environment
          AND integration.status = 'active'
          AND integration.configuration
            @> '{"allowedCapabilities":["small_parcel_tender"]}'::jsonb
          AND integration.configuration
            #>> '{transportActivation,small_parcel,tenderEnabled}' = 'true'
          AND integration.configuration->>'activationStatus' = 'active'
          AND jsonb_typeof(
            integration.configuration->'activationBlockers'
          ) = 'array'
          AND jsonb_array_length(
            integration.configuration->'activationBlockers'
          ) = 0
          AND integration.configuration->>'billingAccountFingerprint'
            = NEW.provider_billing_account_fingerprint
        )
      )
  ) THEN
    RAISE EXCEPTION
      'One-off parcel group must retain exact provider and executing-carrier offer identity';
  END IF;
  IF NEW.action <> 'create' AND NOT EXISTS (
    SELECT 1
    FROM operations_one_off_carrier_group_attempts created
    WHERE created.organization_id = NEW.organization_id
      AND created.id = NEW.create_attempt_id
      AND created.transport_mode = NEW.transport_mode
      AND created.handling_unit_mode = NEW.handling_unit_mode
      AND created.executing_carrier_code = NEW.executing_carrier_code
      AND created.executing_carrier_name = NEW.executing_carrier_name
      AND created.executing_carrier_scac
        IS NOT DISTINCT FROM NEW.executing_carrier_scac
      AND created.provider_offer_id
        IS NOT DISTINCT FROM NEW.provider_offer_id
      AND created.provider_product_id
        IS NOT DISTINCT FROM NEW.provider_product_id
      AND created.provider_transaction_id
        IS NOT DISTINCT FROM NEW.provider_transaction_id
      AND created.provider_billing_account_fingerprint
        IS NOT DISTINCT FROM NEW.provider_billing_account_fingerprint
      AND created.credential_version
        IS NOT DISTINCT FROM NEW.credential_version
      AND created.credential_fingerprint
        IS NOT DISTINCT FROM NEW.credential_fingerprint
      AND created.handling_unit_plan_id
        IS NOT DISTINCT FROM NEW.handling_unit_plan_id
  ) THEN
    RAISE EXCEPTION
      'One-off parcel close must retain exact executing-carrier identity';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER validate_operations_one_off_group_transport_write
BEFORE INSERT ON operations_one_off_carrier_group_attempts
FOR EACH ROW EXECUTE FUNCTION validate_operations_one_off_group_transport();

CREATE OR REPLACE FUNCTION protect_operations_one_off_group_attempt()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'One-off carrier group attempts are immutable';
  END IF;
  IF ROW(
    NEW.global_id, NEW.organization_id, NEW.order_id, NEW.plan_id,
    NEW.planning_quote_id, NEW.planning_offer_id,
    NEW.purchase_quote_id, NEW.purchase_offer_id, NEW.carrier_rate_id,
    NEW.integration_account_id, NEW.carrier_account_id, NEW.create_attempt_id,
    NEW.action, NEW.environment, NEW.provider, NEW.service_code,
    NEW.transport_mode, NEW.handling_unit_mode,
    NEW.executing_carrier_code, NEW.executing_carrier_name,
    NEW.executing_carrier_scac, NEW.provider_quote_reference,
    NEW.provider_offer_id, NEW.provider_product_id,
    NEW.provider_transaction_id,
    NEW.provider_billing_account_fingerprint,
    NEW.credential_version, NEW.credential_fingerprint,
    NEW.handling_unit_plan_id, NEW.pickup_attempt_id,
    NEW.package_count, NEW.selected_amount_minor, NEW.currency,
    NEW.adapter_version, NEW.idempotency_key, NEW.request_hash,
    NEW.redacted_request, NEW.reason, NEW.actor_email,
    NEW.requested_at, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.global_id, OLD.organization_id, OLD.order_id, OLD.plan_id,
    OLD.planning_quote_id, OLD.planning_offer_id,
    OLD.purchase_quote_id, OLD.purchase_offer_id, OLD.carrier_rate_id,
    OLD.integration_account_id, OLD.carrier_account_id, OLD.create_attempt_id,
    OLD.action, OLD.environment, OLD.provider, OLD.service_code,
    OLD.transport_mode, OLD.handling_unit_mode,
    OLD.executing_carrier_code, OLD.executing_carrier_name,
    OLD.executing_carrier_scac, OLD.provider_quote_reference,
    OLD.provider_offer_id, OLD.provider_product_id,
    OLD.provider_transaction_id,
    OLD.provider_billing_account_fingerprint,
    OLD.credential_version, OLD.credential_fingerprint,
    OLD.handling_unit_plan_id, OLD.pickup_attempt_id,
    OLD.package_count, OLD.selected_amount_minor, OLD.currency,
    OLD.adapter_version, OLD.idempotency_key, OLD.request_hash,
    OLD.redacted_request, OLD.reason, OLD.actor_email,
    OLD.requested_at, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'One-off carrier group request evidence is immutable';
  END IF;
  IF OLD.state <> 'prepared' OR NEW.state = 'prepared'
     OR NEW.completed_at IS NULL THEN
    RAISE EXCEPTION 'One-off carrier group attempts finalize exactly once';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER protect_operations_one_off_group_attempt_write
BEFORE UPDATE OR DELETE ON operations_one_off_carrier_group_attempts
FOR EACH ROW EXECUTE FUNCTION protect_operations_one_off_group_attempt();

-- WWEX's pickup flow has a second shop/select boundary before shipment tender.
-- Insert a prepared row bound to the packed quote/offer and loose-package plan,
-- call schedulePickupFlow, and only then finalize it with the three returned
-- pickup identifiers. integratedOrderFlow is permitted only after that success.
CREATE TABLE IF NOT EXISTS operations_one_off_parcel_pickup_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gtpa'),
  organization_id uuid NOT NULL,
  order_id uuid NOT NULL,
  fulfillment_plan_id uuid NOT NULL,
  one_off_quote_id uuid NOT NULL,
  one_off_offer_id uuid NOT NULL,
  handling_unit_plan_id uuid NOT NULL,
  integration_account_id uuid NOT NULL,
  credential_version integer NOT NULL CHECK (credential_version > 0),
  credential_fingerprint text NOT NULL CHECK (
    credential_fingerprint ~ '^[a-f0-9]{64}$'
  ),
  schedule_attempt_id uuid,
  action text NOT NULL CHECK (action IN ('schedule', 'reconcile')),
  state text NOT NULL DEFAULT 'prepared' CHECK (
    state IN ('prepared', 'succeeded', 'failed', 'unknown')
  ),
  environment text NOT NULL CHECK (
    environment IN ('sandbox', 'production')
  ),
  provider text NOT NULL DEFAULT 'wwex_speedship' CHECK (
    provider = 'wwex_speedship'
  ),
  executing_carrier_code text NOT NULL DEFAULT 'UPS' CHECK (
    executing_carrier_code = 'UPS'
  ),
  provider_offer_id text NOT NULL,
  provider_product_id text NOT NULL,
  provider_transaction_id text NOT NULL,
  provider_billing_account_fingerprint text NOT NULL CHECK (
    provider_billing_account_fingerprint ~ '^[a-f0-9]{64}$'
  ),
  pickup_offer_id text,
  pickup_product_id text,
  pickup_transaction_id text,
  pickup_quote_request_hash text NOT NULL CHECK (
    pickup_quote_request_hash ~ '^[a-f0-9]{64}$'
  ),
  pickup_quote_response_hash text CHECK (
    pickup_quote_response_hash IS NULL
    OR pickup_quote_response_hash ~ '^[a-f0-9]{64}$'
  ),
  provider_pickup_reference text,
  adapter_version text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  redacted_request jsonb NOT NULL,
  redacted_response jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code text,
  reason text NOT NULL,
  actor_email text REFERENCES app_users(email) ON DELETE SET NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_one_off_parcel_pickup_global_valid CHECK (
    global_id ~ '^gtpa(?:[0-9]{7}|[0-9a-v]{12})$'
  ),
  CONSTRAINT operations_one_off_parcel_pickup_global_unique
    UNIQUE (global_id),
  CONSTRAINT operations_one_off_parcel_pickup_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_one_off_parcel_pickup_order_plan_fkey
    FOREIGN KEY (organization_id, order_id, fulfillment_plan_id)
    REFERENCES operations_fulfillment_plans(organization_id, order_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_one_off_parcel_pickup_offer_fkey
    FOREIGN KEY (organization_id, one_off_quote_id, one_off_offer_id)
    REFERENCES operations_one_off_shipment_quote_offers(
      organization_id,
      quote_id,
      id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_one_off_parcel_pickup_handling_plan_fkey
    FOREIGN KEY (organization_id, handling_unit_plan_id)
    REFERENCES operations_outbound_handling_unit_plans(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_one_off_parcel_pickup_integration_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_one_off_parcel_pickup_org_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT operations_one_off_parcel_pickup_action_valid CHECK (
    (action = 'schedule' AND schedule_attempt_id IS NULL)
    OR (action = 'reconcile' AND schedule_attempt_id IS NOT NULL)
  ),
  CONSTRAINT operations_one_off_parcel_pickup_identity_valid CHECK (
    length(btrim(provider_offer_id)) BETWEEN 1 AND 200
    AND length(btrim(provider_product_id)) BETWEEN 1 AND 200
    AND length(btrim(provider_transaction_id)) BETWEEN 1 AND 200
    AND (
      pickup_offer_id IS NULL
      OR length(btrim(pickup_offer_id)) BETWEEN 1 AND 200
    )
    AND (
      pickup_product_id IS NULL
      OR length(btrim(pickup_product_id)) BETWEEN 1 AND 200
    )
    AND (
      pickup_transaction_id IS NULL
      OR length(btrim(pickup_transaction_id)) BETWEEN 1 AND 200
    )
    AND (
      provider_pickup_reference IS NULL
      OR length(btrim(provider_pickup_reference)) BETWEEN 1 AND 200
    )
    AND length(btrim(adapter_version)) BETWEEN 1 AND 100
    AND length(btrim(idempotency_key)) BETWEEN 8 AND 200
    AND length(btrim(reason)) BETWEEN 3 AND 500
  ),
  CONSTRAINT operations_one_off_parcel_pickup_completion_valid CHECK (
    (
      state = 'prepared'
      AND completed_at IS NULL
      AND error_code IS NULL
      AND pickup_offer_id IS NULL
      AND pickup_product_id IS NULL
      AND pickup_transaction_id IS NULL
      AND pickup_quote_response_hash IS NULL
      AND provider_pickup_reference IS NULL
    )
    OR (
      state = 'succeeded'
      AND completed_at IS NOT NULL
      AND error_code IS NULL
      AND pickup_offer_id IS NOT NULL
      AND pickup_product_id IS NOT NULL
      AND pickup_transaction_id IS NOT NULL
      AND pickup_quote_response_hash IS NOT NULL
    )
    OR (
      state IN ('failed', 'unknown')
      AND completed_at IS NOT NULL
      AND NULLIF(btrim(error_code), '') IS NOT NULL
      AND pickup_offer_id IS NULL
      AND pickup_product_id IS NULL
      AND pickup_transaction_id IS NULL
      AND pickup_quote_response_hash IS NULL
      AND provider_pickup_reference IS NULL
    )
  ),
  CONSTRAINT operations_one_off_parcel_pickup_json_valid CHECK (
    jsonb_typeof(redacted_request) = 'object'
    AND jsonb_typeof(redacted_response) = 'object'
  )
);

ALTER TABLE operations_one_off_parcel_pickup_attempts
  DROP CONSTRAINT IF EXISTS operations_one_off_parcel_pickup_schedule_fkey,
  ADD CONSTRAINT operations_one_off_parcel_pickup_schedule_fkey
    FOREIGN KEY (organization_id, schedule_attempt_id)
    REFERENCES operations_one_off_parcel_pickup_attempts(organization_id, id)
    ON DELETE RESTRICT;

ALTER TABLE operations_one_off_carrier_group_attempts
  DROP CONSTRAINT IF EXISTS operations_one_off_group_pickup_attempt_fkey,
  ADD CONSTRAINT operations_one_off_group_pickup_attempt_fkey
    FOREIGN KEY (organization_id, pickup_attempt_id)
    REFERENCES operations_one_off_parcel_pickup_attempts(organization_id, id)
    ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS
  operations_one_off_parcel_pickup_idempotency_unique
ON operations_one_off_parcel_pickup_attempts (
  organization_id,
  idempotency_key
);

CREATE UNIQUE INDEX IF NOT EXISTS
  operations_one_off_parcel_pickup_unresolved_unique
ON operations_one_off_parcel_pickup_attempts (
  organization_id,
  fulfillment_plan_id,
  action,
  request_hash
)
WHERE state IN ('prepared', 'unknown');

CREATE UNIQUE INDEX IF NOT EXISTS
  operations_one_off_parcel_pickup_active_schedule_unique
ON operations_one_off_parcel_pickup_attempts (
  organization_id,
  fulfillment_plan_id,
  one_off_quote_id,
  one_off_offer_id
)
WHERE action = 'schedule' AND state IN ('prepared', 'succeeded', 'unknown');

CREATE OR REPLACE FUNCTION validate_operations_one_off_parcel_pickup_attempt()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  linked_schedule operations_one_off_parcel_pickup_attempts%ROWTYPE;
BEGIN
  IF NEW.state <> 'prepared' THEN
    RAISE EXCEPTION
      'Parcel pickup attempts must be persisted as prepared before provider execution';
  END IF;
  IF NEW.action = 'schedule' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM operations_fulfillment_plans fulfillment
      JOIN operations_orders source_order
        ON source_order.organization_id = fulfillment.organization_id
       AND source_order.id = fulfillment.order_id
      JOIN operations_one_off_shipment_quotes packed_quote
        ON packed_quote.organization_id = fulfillment.organization_id
       AND packed_quote.id = NEW.one_off_quote_id
      JOIN operations_one_off_shipment_quote_offers offer
        ON offer.organization_id = packed_quote.organization_id
       AND offer.quote_id = packed_quote.id
       AND offer.id = NEW.one_off_offer_id
      JOIN operations_outbound_handling_unit_plans handling_plan
        ON handling_plan.organization_id = offer.organization_id
       AND handling_plan.id = NEW.handling_unit_plan_id
       AND handling_plan.id = offer.handling_unit_plan_id
      JOIN operations_integration_accounts integration
        ON integration.organization_id = offer.organization_id
       AND integration.id = NEW.integration_account_id
      JOIN operations_carrier_credentials credential
        ON credential.organization_id = integration.organization_id
       AND credential.integration_account_id = integration.id
      WHERE fulfillment.organization_id = NEW.organization_id
        AND fulfillment.id = NEW.fulfillment_plan_id
        AND fulfillment.order_id = NEW.order_id
        AND source_order.status = 'packed'
        AND operations_one_off_purchase_quote_is_valid(
          NEW.organization_id,
          NEW.fulfillment_plan_id,
          NEW.one_off_quote_id,
          NEW.one_off_offer_id
        )
        AND offer.provider = NEW.provider
        AND offer.environment = NEW.environment
        AND offer.transport_mode = 'small_parcel'
        AND offer.handling_unit_mode = 'loose_packages'
        AND offer.executing_carrier_code = NEW.executing_carrier_code
        AND offer.integration_account_id = NEW.integration_account_id
        AND offer.carrier_account_id IS NULL
        AND offer.provider_offer_id = NEW.provider_offer_id
        AND offer.provider_product_id = NEW.provider_product_id
        AND offer.provider_transaction_id = NEW.provider_transaction_id
        AND offer.credential_version = NEW.credential_version
        AND offer.credential_fingerprint = NEW.credential_fingerprint
        AND handling_plan.transport_mode = 'small_parcel'
        AND handling_plan.handling_unit_mode = 'loose_packages'
        AND handling_plan.fulfillment_plan_id = fulfillment.id
        AND handling_plan.one_off_quote_id = packed_quote.id
        AND handling_plan.source = 'packed_rerate'
        AND handling_plan.request_profile->'pickupRequired' = 'true'::jsonb
        AND integration.integration_type = 'carrier'
        AND integration.provider = NEW.provider
        AND integration.environment = NEW.environment
        AND integration.status = 'active'
        AND integration.configuration
          @> '{"allowedCapabilities":["small_parcel_pickup"]}'::jsonb
        AND integration.configuration
          #>> '{transportActivation,small_parcel,tenderEnabled}' = 'true'
        AND integration.configuration->>'activationStatus' = 'active'
        AND jsonb_typeof(
          integration.configuration->'activationBlockers'
        ) = 'array'
        AND jsonb_array_length(
          integration.configuration->'activationBlockers'
        ) = 0
        AND integration.configuration->>'billingAccountFingerprint'
          = NEW.provider_billing_account_fingerprint
        AND credential.verification_status = 'verified'
        AND credential.credential_version = NEW.credential_version
        AND credential.credential_fingerprint = NEW.credential_fingerprint
    ) THEN
      RAISE EXCEPTION
        'Parcel pickup prepare requires an exact fresh packed WWEX offer, loose-package plan, verified credential, and active pickup authority';
    END IF;
  ELSE
    SELECT * INTO linked_schedule
    FROM operations_one_off_parcel_pickup_attempts attempt
    WHERE attempt.organization_id = NEW.organization_id
      AND attempt.id = NEW.schedule_attempt_id;
    IF linked_schedule.id IS NULL
       OR linked_schedule.action <> 'schedule'
       OR linked_schedule.state <> 'unknown'
       OR ROW(
         linked_schedule.order_id,
         linked_schedule.fulfillment_plan_id,
         linked_schedule.one_off_quote_id,
         linked_schedule.one_off_offer_id,
         linked_schedule.handling_unit_plan_id,
         linked_schedule.integration_account_id,
         linked_schedule.credential_version,
         linked_schedule.credential_fingerprint,
         linked_schedule.environment,
         linked_schedule.provider,
         linked_schedule.executing_carrier_code,
         linked_schedule.provider_offer_id,
         linked_schedule.provider_product_id,
         linked_schedule.provider_transaction_id,
         linked_schedule.provider_billing_account_fingerprint,
         linked_schedule.pickup_quote_request_hash,
         linked_schedule.request_hash
       ) IS DISTINCT FROM ROW(
         NEW.order_id,
         NEW.fulfillment_plan_id,
         NEW.one_off_quote_id,
         NEW.one_off_offer_id,
         NEW.handling_unit_plan_id,
         NEW.integration_account_id,
         NEW.credential_version,
         NEW.credential_fingerprint,
         NEW.environment,
         NEW.provider,
         NEW.executing_carrier_code,
         NEW.provider_offer_id,
         NEW.provider_product_id,
         NEW.provider_transaction_id,
         NEW.provider_billing_account_fingerprint,
         NEW.pickup_quote_request_hash,
         NEW.request_hash
       )
    THEN
      RAISE EXCEPTION
        'Parcel pickup reconciliation must retain the exact unknown prepared request authority';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER validate_operations_one_off_parcel_pickup_attempt_write
BEFORE INSERT ON operations_one_off_parcel_pickup_attempts
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_one_off_parcel_pickup_attempt();

CREATE OR REPLACE FUNCTION protect_operations_one_off_parcel_pickup_attempt()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'One-off parcel pickup attempts are immutable';
  END IF;
  IF ROW(
    NEW.global_id, NEW.organization_id, NEW.order_id,
    NEW.fulfillment_plan_id, NEW.one_off_quote_id, NEW.one_off_offer_id,
    NEW.handling_unit_plan_id,
    NEW.integration_account_id, NEW.credential_version,
    NEW.credential_fingerprint, NEW.schedule_attempt_id, NEW.action,
    NEW.environment, NEW.provider, NEW.executing_carrier_code,
    NEW.provider_offer_id, NEW.provider_product_id,
    NEW.provider_transaction_id,
    NEW.provider_billing_account_fingerprint,
    NEW.pickup_quote_request_hash, NEW.adapter_version,
    NEW.idempotency_key, NEW.request_hash, NEW.redacted_request,
    NEW.reason, NEW.actor_email, NEW.requested_at, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.global_id, OLD.organization_id, OLD.order_id,
    OLD.fulfillment_plan_id, OLD.one_off_quote_id, OLD.one_off_offer_id,
    OLD.handling_unit_plan_id,
    OLD.integration_account_id, OLD.credential_version,
    OLD.credential_fingerprint, OLD.schedule_attempt_id, OLD.action,
    OLD.environment, OLD.provider, OLD.executing_carrier_code,
    OLD.provider_offer_id, OLD.provider_product_id,
    OLD.provider_transaction_id,
    OLD.provider_billing_account_fingerprint,
    OLD.pickup_quote_request_hash, OLD.adapter_version,
    OLD.idempotency_key, OLD.request_hash, OLD.redacted_request,
    OLD.reason, OLD.actor_email, OLD.requested_at, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'One-off parcel pickup request evidence is immutable';
  END IF;
  IF OLD.state <> 'prepared' OR NEW.state = 'prepared'
     OR NEW.completed_at IS NULL THEN
    RAISE EXCEPTION 'One-off parcel pickup attempts finalize exactly once';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER protect_operations_one_off_parcel_pickup_attempt_write
BEFORE UPDATE OR DELETE ON operations_one_off_parcel_pickup_attempts
FOR EACH ROW EXECUTE FUNCTION
  protect_operations_one_off_parcel_pickup_attempt();

CREATE OR REPLACE FUNCTION validate_operations_one_off_group_pickup()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.action = 'create' AND NEW.provider = 'wwex_speedship'
     AND NOT EXISTS (
       SELECT 1
       FROM operations_one_off_parcel_pickup_attempts pickup
       WHERE pickup.organization_id = NEW.organization_id
         AND pickup.id = NEW.pickup_attempt_id
         AND pickup.action IN ('schedule', 'reconcile')
         AND pickup.state = 'succeeded'
         AND pickup.order_id = NEW.order_id
         AND pickup.fulfillment_plan_id = NEW.plan_id
         AND pickup.one_off_quote_id = NEW.purchase_quote_id
         AND pickup.one_off_offer_id = NEW.purchase_offer_id
         AND pickup.handling_unit_plan_id = NEW.handling_unit_plan_id
         AND pickup.integration_account_id = NEW.integration_account_id
         AND pickup.credential_version = NEW.credential_version
         AND pickup.credential_fingerprint = NEW.credential_fingerprint
         AND pickup.environment = NEW.environment
         AND pickup.provider = NEW.provider
         AND pickup.executing_carrier_code = NEW.executing_carrier_code
         AND pickup.provider_offer_id = NEW.provider_offer_id
         AND pickup.provider_product_id = NEW.provider_product_id
         AND pickup.provider_transaction_id = NEW.provider_transaction_id
         AND pickup.provider_billing_account_fingerprint
           = NEW.provider_billing_account_fingerprint
         AND pickup.pickup_offer_id IS NOT NULL
         AND pickup.pickup_product_id IS NOT NULL
         AND pickup.pickup_transaction_id IS NOT NULL
     )
  THEN
    RAISE EXCEPTION
      'WWEX integrated-order prepare requires the exact succeeded pre-tender pickup attempt';
  END IF;
  IF NEW.action <> 'create' AND NOT EXISTS (
    SELECT 1
    FROM operations_one_off_carrier_group_attempts created
    WHERE created.organization_id = NEW.organization_id
      AND created.id = NEW.create_attempt_id
      AND created.pickup_attempt_id
        IS NOT DISTINCT FROM NEW.pickup_attempt_id
  ) THEN
    RAISE EXCEPTION
      'One-off parcel close must retain the original pickup-attempt identity';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER validate_operations_one_off_group_pickup_write
BEFORE INSERT ON operations_one_off_carrier_group_attempts
FOR EACH ROW EXECUTE FUNCTION validate_operations_one_off_group_pickup();

CREATE TABLE IF NOT EXISTS operations_freight_tender_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gfta'),
  organization_id uuid NOT NULL,
  order_id uuid NOT NULL,
  fulfillment_plan_id uuid NOT NULL,
  one_off_quote_id uuid NOT NULL,
  one_off_offer_id uuid NOT NULL,
  handling_unit_plan_id uuid NOT NULL,
  integration_account_id uuid NOT NULL,
  carrier_account_id uuid,
  credential_version integer NOT NULL CHECK (credential_version > 0),
  credential_fingerprint text NOT NULL CHECK (
    credential_fingerprint ~ '^[a-f0-9]{64}$'
  ),
  create_attempt_id uuid,
  action text NOT NULL CHECK (action IN ('tender', 'reconcile')),
  state text NOT NULL DEFAULT 'prepared' CHECK (
    state IN ('prepared', 'succeeded', 'failed', 'unknown')
  ),
  environment text NOT NULL CHECK (
    environment IN ('sandbox', 'production')
  ),
  provider text NOT NULL CHECK (
    provider IN ('wwex_speedship', 'rl_carriers')
  ),
  provider_operation text NOT NULL CHECK (
    provider_operation IN ('quote_order', 'bill_of_lading')
  ),
  pickup_binding text NOT NULL CHECK (
    pickup_binding IN ('none', 'embedded_bol', 'integrated_order')
  ),
  executing_carrier_code text NOT NULL,
  executing_carrier_name text NOT NULL,
  executing_carrier_scac text,
  service_code text NOT NULL,
  provider_quote_reference text NOT NULL,
  provider_offer_id text,
  provider_product_id text,
  provider_transaction_id text,
  provider_billing_account_fingerprint text,
  provider_tender_reference text,
  pro_number text,
  bol_number text,
  pickup_request_id text,
  pickup_order_reference text,
  pickup_transaction_reference text,
  selected_amount_minor bigint NOT NULL CHECK (selected_amount_minor >= 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  provider_charge_minor bigint CHECK (provider_charge_minor >= 0),
  provider_charge_currency text,
  charge_variance_minor bigint,
  adapter_version text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  redacted_request jsonb NOT NULL,
  redacted_response jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code text,
  reason text NOT NULL,
  actor_email text REFERENCES app_users(email) ON DELETE SET NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_freight_tender_attempt_global_valid CHECK (
    global_id ~ '^gfta(?:[0-9]{7}|[0-9a-v]{12})$'
  ),
  CONSTRAINT operations_freight_tender_attempt_global_unique
    UNIQUE (global_id),
  CONSTRAINT operations_freight_tender_attempt_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_freight_tender_attempt_order_plan_fkey
    FOREIGN KEY (organization_id, order_id, fulfillment_plan_id)
    REFERENCES operations_fulfillment_plans(organization_id, order_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_freight_tender_attempt_offer_fkey
    FOREIGN KEY (organization_id, one_off_quote_id, one_off_offer_id)
    REFERENCES operations_one_off_shipment_quote_offers(
      organization_id,
      quote_id,
      id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_freight_tender_attempt_handling_plan_fkey
    FOREIGN KEY (organization_id, handling_unit_plan_id)
    REFERENCES operations_outbound_handling_unit_plans(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_freight_tender_attempt_integration_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_freight_tender_attempt_account_fkey
    FOREIGN KEY (organization_id, integration_account_id, carrier_account_id)
    REFERENCES operations_carrier_accounts(
      organization_id,
      integration_account_id,
      id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_freight_tender_attempt_org_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT operations_freight_tender_attempt_action_valid CHECK (
    (action = 'tender' AND create_attempt_id IS NULL)
    OR (action = 'reconcile' AND create_attempt_id IS NOT NULL)
  ),
  CONSTRAINT operations_freight_tender_attempt_identity_valid CHECK (
    carrier_account_id IS NULL
    AND executing_carrier_code ~ '^[A-Z0-9][A-Z0-9._-]{1,31}$'
    AND length(btrim(executing_carrier_name)) BETWEEN 1 AND 120
    AND (
      executing_carrier_scac IS NULL
      OR executing_carrier_scac ~ '^[A-Z]{2,4}$'
    )
    AND length(btrim(service_code)) BETWEEN 1 AND 128
    AND length(btrim(provider_quote_reference)) BETWEEN 1 AND 200
    AND (
      provider_offer_id IS NULL
      OR length(btrim(provider_offer_id)) BETWEEN 1 AND 200
    )
    AND (
      provider_product_id IS NULL
      OR length(btrim(provider_product_id)) BETWEEN 1 AND 200
    )
    AND (
      provider_transaction_id IS NULL
      OR length(btrim(provider_transaction_id)) BETWEEN 1 AND 200
    )
    AND (
      (
        provider = 'wwex_speedship'
        AND provider_operation = 'quote_order'
        AND pickup_binding = 'integrated_order'
        AND pickup_request_id IS NULL
        AND executing_carrier_scac IS NOT NULL
        AND provider_offer_id IS NOT NULL
        AND provider_product_id IS NOT NULL
        AND provider_transaction_id IS NOT NULL
        AND provider_billing_account_fingerprint
          ~ '^[a-f0-9]{64}$'
      )
      OR (
        provider = 'rl_carriers'
        AND provider_operation = 'bill_of_lading'
        AND pickup_binding IN ('none', 'embedded_bol')
        AND pickup_order_reference IS NULL
        AND pickup_transaction_reference IS NULL
        AND provider_offer_id IS NULL
        AND provider_product_id IS NULL
        AND provider_transaction_id IS NULL
        AND provider_billing_account_fingerprint IS NULL
      )
    )
    AND (
      provider_tender_reference IS NULL
      OR length(btrim(provider_tender_reference)) BETWEEN 1 AND 200
    )
    AND (pro_number IS NULL OR length(btrim(pro_number)) BETWEEN 1 AND 100)
    AND (bol_number IS NULL OR length(btrim(bol_number)) BETWEEN 1 AND 100)
    AND (
      pickup_request_id IS NULL
      OR length(btrim(pickup_request_id)) BETWEEN 1 AND 100
    )
    AND (
      pickup_order_reference IS NULL
      OR length(btrim(pickup_order_reference)) BETWEEN 1 AND 200
    )
    AND (
      pickup_transaction_reference IS NULL
      OR length(btrim(pickup_transaction_reference)) BETWEEN 1 AND 200
    )
    AND length(btrim(adapter_version)) BETWEEN 1 AND 100
    AND length(btrim(idempotency_key)) BETWEEN 8 AND 200
    AND length(btrim(reason)) BETWEEN 3 AND 500
  ),
  CONSTRAINT operations_freight_tender_attempt_completion_valid CHECK (
    (
      state = 'prepared'
      AND completed_at IS NULL
      AND error_code IS NULL
      AND provider_tender_reference IS NULL
      AND pro_number IS NULL
      AND bol_number IS NULL
      AND pickup_request_id IS NULL
      AND pickup_order_reference IS NULL
      AND pickup_transaction_reference IS NULL
    )
    OR (
      state = 'succeeded'
      AND completed_at IS NOT NULL
      AND error_code IS NULL
      AND (
        (
          provider = 'wwex_speedship'
          AND provider_tender_reference IS NOT NULL
          AND pickup_order_reference IS NOT NULL
          AND pickup_transaction_reference IS NOT NULL
          AND pickup_request_id IS NULL
        )
        OR (
          provider = 'rl_carriers'
          AND provider_tender_reference IS NULL
          AND pro_number IS NOT NULL
          AND pickup_order_reference IS NULL
          AND pickup_transaction_reference IS NULL
          AND (
            pickup_binding <> 'embedded_bol'
            OR pickup_request_id IS NOT NULL
          )
        )
      )
    )
    OR (
      state = 'failed'
      AND completed_at IS NOT NULL
      AND NULLIF(btrim(error_code), '') IS NOT NULL
      AND provider_tender_reference IS NULL
      AND pro_number IS NULL
      AND bol_number IS NULL
      AND pickup_request_id IS NULL
      AND pickup_order_reference IS NULL
      AND pickup_transaction_reference IS NULL
    )
    OR (
      state = 'unknown'
      AND completed_at IS NOT NULL
      AND NULLIF(btrim(error_code), '') IS NOT NULL
      -- A partial 2xx can contain either identifier. They remain evidence for
      -- reconciliation and never satisfy the succeeded branch above.
    )
  ),
  CONSTRAINT operations_freight_tender_attempt_charge_valid CHECK (
    (
      provider_charge_minor IS NULL
      AND provider_charge_currency IS NULL
      AND charge_variance_minor IS NULL
    )
    OR (
      provider_charge_minor IS NOT NULL
      AND provider_charge_currency ~ '^[A-Z]{3}$'
      AND (
        (
          provider_charge_currency = currency
          AND charge_variance_minor
            = provider_charge_minor - selected_amount_minor
        )
        OR (
          provider_charge_currency <> currency
          AND charge_variance_minor IS NULL
        )
      )
    )
  ),
  CONSTRAINT operations_freight_tender_attempt_json_valid CHECK (
    jsonb_typeof(redacted_request) = 'object'
    AND jsonb_typeof(redacted_response) = 'object'
  )
);

ALTER TABLE operations_freight_tender_attempts
  DROP CONSTRAINT IF EXISTS operations_freight_tender_create_attempt_fkey,
  ADD CONSTRAINT operations_freight_tender_create_attempt_fkey
    FOREIGN KEY (organization_id, create_attempt_id)
    REFERENCES operations_freight_tender_attempts(organization_id, id)
    ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS
  operations_freight_tender_attempt_idempotency_unique
ON operations_freight_tender_attempts (organization_id, idempotency_key);

CREATE UNIQUE INDEX IF NOT EXISTS
  operations_freight_tender_attempt_unresolved_semantic_unique
ON operations_freight_tender_attempts (
  organization_id,
  provider,
  action,
  request_hash
)
WHERE state IN ('prepared', 'unknown');

CREATE UNIQUE INDEX IF NOT EXISTS
  operations_freight_tender_attempt_active_tender_unique
ON operations_freight_tender_attempts (
  organization_id,
  order_id,
  fulfillment_plan_id
)
WHERE action = 'tender' AND state IN ('prepared', 'succeeded', 'unknown');

-- Keep operation-specific provider authority independent from the generic LTL
-- tender switch. In particular, R+L Bill of Lading is a distinct documented
-- mutation and cannot inherit authority merely from ltl_tender.
CREATE OR REPLACE FUNCTION
  validate_operations_freight_provider_operation_capability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.action = 'tender' AND NOT EXISTS (
    SELECT 1
    FROM operations_integration_accounts integration
    WHERE integration.organization_id = NEW.organization_id
      AND integration.id = NEW.integration_account_id
      AND integration.integration_type = 'carrier'
      AND integration.provider = NEW.provider
      AND integration.environment = NEW.environment
      AND integration.status = 'active'
      AND integration.configuration
        @> '{"allowedCapabilities":["ltl_tender"]}'::jsonb
      AND integration.configuration
        #>> '{transportActivation,ltl,tenderEnabled}' = 'true'
      AND integration.configuration->>'activationStatus' = 'active'
      AND jsonb_typeof(
        integration.configuration->'activationBlockers'
      ) = 'array'
      AND jsonb_array_length(
        integration.configuration->'activationBlockers'
      ) = 0
      AND (
        NEW.provider <> 'rl_carriers'
        OR NEW.provider_operation <> 'bill_of_lading'
        OR integration.configuration
          @> '{"allowedCapabilities":["ltl_bol"]}'::jsonb
      )
      AND (
        NEW.pickup_binding <> 'embedded_bol'
        OR integration.configuration
          @> '{"allowedCapabilities":["ltl_pickup"]}'::jsonb
      )
  ) THEN
    RAISE EXCEPTION
      'Freight provider operation requires active ltl_tender plus independent ltl_bol and ltl_pickup capabilities when applicable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER
  validate_operations_freight_provider_operation_capability_write
BEFORE INSERT ON operations_freight_tender_attempts
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_freight_provider_operation_capability();

CREATE OR REPLACE FUNCTION validate_operations_freight_tender_attempt()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  linked_create operations_freight_tender_attempts%ROWTYPE;
BEGIN
  IF NEW.action = 'tender' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM operations_fulfillment_plans fulfillment
      JOIN operations_orders source_order
        ON source_order.organization_id = fulfillment.organization_id
       AND source_order.id = fulfillment.order_id
      JOIN operations_one_off_shipment_quotes planning_quote
        ON planning_quote.organization_id = fulfillment.organization_id
       AND planning_quote.id = fulfillment.one_off_quote_id
      JOIN operations_one_off_shipment_quote_offers planning_offer
        ON planning_offer.organization_id = fulfillment.organization_id
       AND planning_offer.quote_id = planning_quote.id
       AND planning_offer.id = fulfillment.one_off_offer_id
      JOIN operations_one_off_shipment_quotes packed_quote
        ON packed_quote.organization_id = fulfillment.organization_id
       AND packed_quote.id = NEW.one_off_quote_id
      JOIN operations_one_off_shipment_quote_offers offer
        ON offer.organization_id = fulfillment.organization_id
       AND offer.quote_id = NEW.one_off_quote_id
       AND offer.id = NEW.one_off_offer_id
      JOIN operations_outbound_handling_unit_plans handling_plan
        ON handling_plan.organization_id = offer.organization_id
       AND handling_plan.id = NEW.handling_unit_plan_id
       AND handling_plan.id = offer.handling_unit_plan_id
      JOIN operations_integration_accounts integration
        ON integration.organization_id = offer.organization_id
       AND integration.id = NEW.integration_account_id
      JOIN operations_carrier_credentials credential
        ON credential.organization_id = integration.organization_id
       AND credential.integration_account_id = integration.id
      WHERE fulfillment.organization_id = NEW.organization_id
        AND fulfillment.id = NEW.fulfillment_plan_id
        AND fulfillment.order_id = NEW.order_id
        AND source_order.status = 'packed'
        AND packed_quote.id <> planning_quote.id
        AND packed_quote.packed_rerate_order_id = fulfillment.order_id
        AND packed_quote.packed_rerate_plan_id = fulfillment.id
        AND packed_quote.expires_at > clock_timestamp()
        AND packed_quote.status IN ('succeeded', 'partial')
        AND packed_quote.execution_mode = planning_quote.execution_mode
        AND packed_quote.rate_environment = planning_quote.rate_environment
        AND packed_quote.warehouse_id = planning_quote.warehouse_id
        AND packed_quote.customer_id = planning_quote.customer_id
        AND packed_quote.inventory_pool_id = planning_quote.inventory_pool_id
        AND packed_quote.receiving_location_id
          = planning_quote.receiving_location_id
        AND packed_quote.currency = planning_quote.currency
        AND packed_quote.destination_hash = planning_quote.destination_hash
        AND offer.provider = NEW.provider
        AND offer.provider = planning_offer.provider
        AND offer.transport_mode = 'ltl'
        AND planning_offer.transport_mode = 'ltl'
        AND offer.handling_unit_mode = 'palletized_handling_units'
        AND planning_offer.handling_unit_mode
          = 'palletized_handling_units'
        AND offer.executing_carrier_code = NEW.executing_carrier_code
        AND offer.executing_carrier_code
          = planning_offer.executing_carrier_code
        AND offer.executing_carrier_name = NEW.executing_carrier_name
        AND offer.executing_carrier_name
          = planning_offer.executing_carrier_name
        AND offer.executing_carrier_scac
          IS NOT DISTINCT FROM NEW.executing_carrier_scac
        AND offer.executing_carrier_scac
          IS NOT DISTINCT FROM planning_offer.executing_carrier_scac
        AND offer.service_code = NEW.service_code
        AND offer.service_code = planning_offer.service_code
        AND offer.provider_quote_reference = NEW.provider_quote_reference
        AND offer.provider_offer_id
          IS NOT DISTINCT FROM NEW.provider_offer_id
        AND offer.provider_product_id
          IS NOT DISTINCT FROM NEW.provider_product_id
        AND offer.provider_transaction_id
          IS NOT DISTINCT FROM NEW.provider_transaction_id
        AND offer.integration_account_id = NEW.integration_account_id
        AND offer.carrier_account_id
          IS NOT DISTINCT FROM NEW.carrier_account_id
        AND offer.credential_version = NEW.credential_version
        AND offer.credential_fingerprint = NEW.credential_fingerprint
        AND offer.amount_minor = NEW.selected_amount_minor
        AND offer.currency = NEW.currency
        AND handling_plan.transport_mode = 'ltl'
        AND handling_plan.handling_unit_mode
          = 'palletized_handling_units'
        AND handling_plan.fulfillment_plan_id = fulfillment.id
        AND handling_plan.one_off_quote_id = packed_quote.id
        AND handling_plan.source = 'packed_rerate'
        AND (
          (
            NEW.provider = 'wwex_speedship'
            AND NEW.pickup_binding = 'integrated_order'
            AND handling_plan.request_profile->'pickupRequired'
              = 'true'::jsonb
          )
          OR (
            NEW.provider = 'rl_carriers'
            AND (
              (
                handling_plan.request_profile->'pickupRequired' = 'true'::jsonb
                AND NEW.pickup_binding = 'embedded_bol'
              )
              OR (
                handling_plan.request_profile->'pickupRequired' = 'false'::jsonb
                AND NEW.pickup_binding = 'none'
              )
            )
          )
        )
        AND integration.integration_type = 'carrier'
        AND integration.provider = NEW.provider
        AND integration.environment = NEW.environment
        AND integration.status = 'active'
        AND credential.verification_status = 'verified'
        AND credential.credential_version = NEW.credential_version
        AND credential.credential_fingerprint = NEW.credential_fingerprint
        AND integration.configuration
          @> '{"allowedCapabilities":["ltl_tender"]}'::jsonb
        AND (
          NEW.provider <> 'rl_carriers'
          OR NEW.provider_operation <> 'bill_of_lading'
          OR integration.configuration
            @> '{"allowedCapabilities":["ltl_bol"]}'::jsonb
        )
        AND integration.configuration
          #>> '{transportActivation,ltl,tenderEnabled}' = 'true'
        AND (
          NEW.pickup_binding <> 'embedded_bol'
          OR integration.configuration
            @> '{"allowedCapabilities":["ltl_pickup"]}'::jsonb
        )
        AND integration.configuration->>'activationStatus' = 'active'
        AND jsonb_typeof(
          integration.configuration->'activationBlockers'
        ) = 'array'
        AND jsonb_array_length(
          integration.configuration->'activationBlockers'
        ) = 0
        AND (
          NEW.provider <> 'wwex_speedship'
          OR integration.configuration->>'billingAccountFingerprint'
            = NEW.provider_billing_account_fingerprint
        )
    ) THEN
      RAISE EXCEPTION
        'Freight tender requires exact packed LTL offer, pallet plan, verified provider authority, and tender activation';
    END IF;
  ELSE
    SELECT * INTO linked_create
    FROM operations_freight_tender_attempts attempt
    WHERE attempt.organization_id = NEW.organization_id
      AND attempt.id = NEW.create_attempt_id;
    IF linked_create.id IS NULL
       OR linked_create.action <> 'tender'
       OR linked_create.state NOT IN ('succeeded', 'unknown')
       OR ROW(
         linked_create.order_id,
         linked_create.fulfillment_plan_id,
         linked_create.one_off_quote_id,
         linked_create.one_off_offer_id,
         linked_create.handling_unit_plan_id,
         linked_create.integration_account_id,
         linked_create.carrier_account_id,
         linked_create.credential_version,
         linked_create.credential_fingerprint,
         linked_create.environment,
         linked_create.provider,
         linked_create.provider_operation,
         linked_create.pickup_binding,
         linked_create.executing_carrier_code,
         linked_create.executing_carrier_name,
         linked_create.executing_carrier_scac,
         linked_create.service_code,
         linked_create.provider_quote_reference,
         linked_create.provider_offer_id,
         linked_create.provider_product_id,
         linked_create.provider_transaction_id,
         linked_create.provider_billing_account_fingerprint,
         linked_create.selected_amount_minor,
         linked_create.currency
       ) IS DISTINCT FROM ROW(
         NEW.order_id,
         NEW.fulfillment_plan_id,
         NEW.one_off_quote_id,
         NEW.one_off_offer_id,
         NEW.handling_unit_plan_id,
         NEW.integration_account_id,
         NEW.carrier_account_id,
         NEW.credential_version,
         NEW.credential_fingerprint,
         NEW.environment,
         NEW.provider,
         NEW.provider_operation,
         NEW.pickup_binding,
         NEW.executing_carrier_code,
         NEW.executing_carrier_name,
         NEW.executing_carrier_scac,
         NEW.service_code,
         NEW.provider_quote_reference,
         NEW.provider_offer_id,
         NEW.provider_product_id,
         NEW.provider_transaction_id,
         NEW.provider_billing_account_fingerprint,
         NEW.selected_amount_minor,
         NEW.currency
       )
    THEN
      RAISE EXCEPTION
        'Freight reconciliation must retain the exact original tender identity';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER validate_operations_freight_tender_attempt_write
BEFORE INSERT ON operations_freight_tender_attempts
FOR EACH ROW EXECUTE FUNCTION validate_operations_freight_tender_attempt();

CREATE OR REPLACE FUNCTION protect_operations_freight_tender_attempt()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Freight tender attempts are immutable';
  END IF;
  IF ROW(
    NEW.global_id, NEW.organization_id, NEW.order_id,
    NEW.fulfillment_plan_id, NEW.one_off_quote_id, NEW.one_off_offer_id,
    NEW.handling_unit_plan_id, NEW.integration_account_id,
    NEW.carrier_account_id, NEW.credential_version,
    NEW.credential_fingerprint, NEW.create_attempt_id, NEW.action,
    NEW.environment, NEW.provider, NEW.provider_operation,
    NEW.pickup_binding, NEW.executing_carrier_code,
    NEW.executing_carrier_name, NEW.executing_carrier_scac,
    NEW.service_code, NEW.provider_quote_reference,
    NEW.provider_offer_id, NEW.provider_product_id,
    NEW.provider_transaction_id,
    NEW.provider_billing_account_fingerprint,
    NEW.selected_amount_minor, NEW.currency, NEW.adapter_version,
    NEW.idempotency_key, NEW.request_hash, NEW.redacted_request,
    NEW.reason, NEW.actor_email, NEW.requested_at, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.global_id, OLD.organization_id, OLD.order_id,
    OLD.fulfillment_plan_id, OLD.one_off_quote_id, OLD.one_off_offer_id,
    OLD.handling_unit_plan_id, OLD.integration_account_id,
    OLD.carrier_account_id, OLD.credential_version,
    OLD.credential_fingerprint, OLD.create_attempt_id, OLD.action,
    OLD.environment, OLD.provider, OLD.provider_operation,
    OLD.pickup_binding, OLD.executing_carrier_code,
    OLD.executing_carrier_name, OLD.executing_carrier_scac,
    OLD.service_code, OLD.provider_quote_reference,
    OLD.provider_offer_id, OLD.provider_product_id,
    OLD.provider_transaction_id,
    OLD.provider_billing_account_fingerprint,
    OLD.selected_amount_minor, OLD.currency, OLD.adapter_version,
    OLD.idempotency_key, OLD.request_hash, OLD.redacted_request,
    OLD.reason, OLD.actor_email, OLD.requested_at, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Freight tender request evidence is immutable';
  END IF;
  IF OLD.state <> 'prepared' OR NEW.state = 'prepared'
     OR NEW.completed_at IS NULL THEN
    RAISE EXCEPTION 'Freight tender attempts finalize exactly once';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER protect_operations_freight_tender_attempt_write
BEFORE UPDATE OR DELETE ON operations_freight_tender_attempts
FOR EACH ROW EXECUTE FUNCTION protect_operations_freight_tender_attempt();

CREATE TABLE IF NOT EXISTS operations_freight_tender_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gftd'),
  organization_id uuid NOT NULL,
  tender_attempt_id uuid NOT NULL,
  handling_unit_id uuid,
  document_type text NOT NULL CHECK (
    document_type IN (
      'bol',
      'shipping_label',
      'pallet_label',
      'rate_confirmation',
      'pickup_confirmation',
      'proof_of_delivery'
    )
  ),
  format text NOT NULL CHECK (format IN ('PDF', 'ZPL', 'PNG', 'TEXT')),
  provider_document_reference text NOT NULL,
  storage_reference text NOT NULL,
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  byte_length bigint NOT NULL CHECK (byte_length BETWEEN 1 AND 52428800),
  redacted_provider_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_freight_tender_document_global_valid CHECK (
    global_id ~ '^gftd(?:[0-9]{7}|[0-9a-v]{12})$'
  ),
  CONSTRAINT operations_freight_tender_document_global_unique
    UNIQUE (global_id),
  CONSTRAINT operations_freight_tender_document_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_freight_tender_document_attempt_fkey
    FOREIGN KEY (organization_id, tender_attempt_id)
    REFERENCES operations_freight_tender_attempts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_freight_tender_document_unit_fkey
    FOREIGN KEY (organization_id, handling_unit_id)
    REFERENCES operations_outbound_handling_units(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_freight_tender_document_org_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT operations_freight_tender_document_reference_unique
    UNIQUE (
      organization_id,
      tender_attempt_id,
      document_type,
      provider_document_reference
    ),
  CONSTRAINT operations_freight_tender_document_text_valid CHECK (
    length(btrim(provider_document_reference)) BETWEEN 1 AND 200
    AND length(btrim(storage_reference)) BETWEEN 1 AND 500
    AND jsonb_typeof(redacted_provider_evidence) = 'object'
  ),
  CONSTRAINT operations_freight_tender_document_unit_valid CHECK (
    (document_type = 'pallet_label' AND handling_unit_id IS NOT NULL)
    OR (document_type <> 'pallet_label' AND handling_unit_id IS NULL)
  )
);

CREATE OR REPLACE FUNCTION validate_operations_freight_tender_document()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM operations_freight_tender_attempts attempt
    JOIN operations_outbound_handling_unit_plans plan
      ON plan.organization_id = attempt.organization_id
     AND plan.id = attempt.handling_unit_plan_id
    WHERE attempt.organization_id = NEW.organization_id
      AND attempt.id = NEW.tender_attempt_id
      AND attempt.action IN ('tender', 'reconcile')
      AND attempt.state = 'succeeded'
      AND (
        NEW.handling_unit_id IS NULL
        OR EXISTS (
          SELECT 1
          FROM operations_outbound_handling_units unit
          WHERE unit.organization_id = plan.organization_id
            AND unit.handling_unit_plan_id = plan.id
            AND unit.id = NEW.handling_unit_id
            AND unit.unit_type = 'pallet'
        )
      )
  ) THEN
    RAISE EXCEPTION
      'Freight document requires a succeeded exact tender and pallet-plan lineage';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER validate_operations_freight_tender_document_write
BEFORE INSERT ON operations_freight_tender_documents
FOR EACH ROW EXECUTE FUNCTION validate_operations_freight_tender_document();

CREATE TRIGGER protect_operations_freight_tender_document_write
BEFORE UPDATE OR DELETE ON operations_freight_tender_documents
FOR EACH ROW EXECUTE FUNCTION protect_operations_append_only();

CREATE INDEX IF NOT EXISTS operations_freight_tender_attempt_order_idx
  ON operations_freight_tender_attempts (
    organization_id,
    order_id,
    requested_at DESC,
    id
  );

CREATE INDEX IF NOT EXISTS operations_freight_tender_document_attempt_idx
  ON operations_freight_tender_documents (
    organization_id,
    tender_attempt_id,
    document_type,
    recorded_at,
    id
  );

COMMENT ON TABLE operations_outbound_handling_unit_plans IS
  'Immutable versioned physical transport alternative: loose packages for small parcel or cartons assigned to pallet handling units for LTL.';
COMMENT ON TABLE operations_outbound_handling_units IS
  'Immutable package or pallet dimensions, tare/gross weight, stackability, and mixed-commodity state for one transport plan.';
COMMENT ON TABLE operations_outbound_handling_unit_memberships IS
  'Exactly-once package membership using a persisted operations_package or a pre-order quote package key.';
COMMENT ON TABLE operations_outbound_handling_unit_commodities IS
  'Immutable per-pallet commodity rows with exact package-membership allocation, pieces, weight, freight class, and optional NMFC evidence.';
COMMENT ON TABLE operations_freight_tender_attempts IS
  'Durable prepare/finalize ledger for LTL tender and reconciliation; unknown outcomes block semantic replay.';
COMMENT ON COLUMN operations_freight_tender_attempts.provider_tender_reference IS
  'WWEX shipmentOrderId. R+L has no separate tender reference; its authoritative success identifier is pro_number.';
COMMENT ON COLUMN operations_freight_tender_attempts.pickup_request_id IS
  'R+L PickupRequestNumber returned by an embedded Bill of Lading pickup.';
COMMENT ON COLUMN operations_freight_tender_attempts.pickup_order_reference IS
  'WWEX pickupOrderId returned by quoteOrderFlow integrated LTL tender.';
COMMENT ON COLUMN operations_freight_tender_attempts.pickup_transaction_reference IS
  'WWEX pickupTransactionId returned by quoteOrderFlow integrated LTL tender.';
COMMENT ON TABLE operations_freight_tender_documents IS
  'Immutable references and hashes for BOL, pallet labels, confirmations, and POD artifacts; raw document bytes remain outside business tables.';
