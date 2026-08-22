-- Preserve the provider-mirrored order address while allowing Operations to
-- keep one encrypted, editable shipment-address working copy. This table does
-- not authorize or enqueue provider writes.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog, public, pg_temp;

CREATE TABLE public.operations_order_shipment_address_working_copies (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES public.workspace_organizations(id) ON DELETE RESTRICT,
  order_id uuid NOT NULL,
  source_order_row_version bigint NOT NULL
    CHECK (source_order_row_version >= 0),
  source_order_hash text NOT NULL
    CHECK (source_order_hash ~ '^[a-f0-9]{64}$'),
  ship_to_state text NOT NULL CHECK (ship_to_state IN (
    'local_missing',
    'local_incomplete',
    'local_carrier_ready'
  )),
  ship_to_ciphertext bytea NOT NULL,
  ship_to_iv bytea NOT NULL,
  ship_to_tag bytea NOT NULL,
  ship_to_hash text NOT NULL CHECK (ship_to_hash ~ '^[a-f0-9]{64}$'),
  dispatch_core_fingerprint text NOT NULL
    CHECK (dispatch_core_fingerprint ~ '^[a-f0-9]{64}$'),
  ship_to_encryption_version integer NOT NULL DEFAULT 1
    CHECK (ship_to_encryption_version = 1),
  last_command_receipt_id uuid NOT NULL,
  last_idempotency_key text NOT NULL,
  last_request_hash text NOT NULL
    CHECK (last_request_hash ~ '^[a-f0-9]{64}$'),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT operations_order_ship_address_order_fkey
    FOREIGN KEY (organization_id, order_id)
    REFERENCES public.operations_orders(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_order_ship_address_receipt_fkey
    FOREIGN KEY (organization_id, last_command_receipt_id)
    REFERENCES public.operations_command_receipts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_order_ship_address_order_unique
    UNIQUE (organization_id, order_id),
  CONSTRAINT operations_order_ship_address_receipt_unique
    UNIQUE (organization_id, last_command_receipt_id),
  CONSTRAINT operations_order_ship_address_org_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT operations_order_ship_address_key_valid CHECK (
    pg_catalog.length(pg_catalog.btrim(last_idempotency_key)) BETWEEN 8 AND 200
    AND last_idempotency_key !~ '[[:cntrl:]]'
  )
);

CREATE INDEX operations_order_ship_address_updated_idx
  ON public.operations_order_shipment_address_working_copies (
    organization_id, updated_at DESC, id DESC
  );

-- The address remains encrypted. This fingerprint exposes only equality for
-- the same normalized core fields already bound by the Active dispatch
-- validators; contact enrichment and residential classification are ignored.
CREATE OR REPLACE FUNCTION
  public.operations_dispatch_address_core_fingerprint(address jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, public, pg_temp
AS $$
  WITH normalized AS (
    SELECT
      pg_catalog.lower(pg_catalog.regexp_replace(
        pg_catalog.btrim(COALESCE(
          address->>'contactName', address->>'name', ''
        )),
        '[[:space:]]+', ' ', 'g'
      )) AS recipient_name,
      pg_catalog.lower(pg_catalog.regexp_replace(
        pg_catalog.btrim(COALESCE(address->>'line1', '')),
        '[[:space:]]+', ' ', 'g'
      )) AS line1,
      pg_catalog.lower(pg_catalog.regexp_replace(
        pg_catalog.btrim(COALESCE(address->>'line2', '')),
        '[[:space:]]+', ' ', 'g'
      )) AS line2,
      pg_catalog.lower(pg_catalog.regexp_replace(
        pg_catalog.btrim(COALESCE(address->>'city', '')),
        '[[:space:]]+', ' ', 'g'
      )) AS city,
      pg_catalog.lower(pg_catalog.regexp_replace(
        pg_catalog.btrim(COALESCE(address->>'region', '')),
        '[[:space:]]+', ' ', 'g'
      )) AS region,
      pg_catalog.regexp_replace(
        pg_catalog.lower(pg_catalog.regexp_replace(
          pg_catalog.btrim(COALESCE(address->>'postalCode', '')),
          '[[:space:]]+', ' ', 'g'
        )),
        '[[:space:]-]+', '', 'g'
      ) AS postal_code,
      pg_catalog.lower(pg_catalog.regexp_replace(
        pg_catalog.btrim(COALESCE(
          address->>'countryCode', address->>'country', ''
        )),
        '[[:space:]]+', ' ', 'g'
      )) AS country_code
  )
  SELECT pg_catalog.encode(public.digest(pg_catalog.convert_to(
    'operations-dispatch-address-core-v1'
    || '|' || pg_catalog.octet_length(recipient_name)::text
      || ':' || recipient_name
    || '|' || pg_catalog.octet_length(line1)::text || ':' || line1
    || '|' || pg_catalog.octet_length(line2)::text || ':' || line2
    || '|' || pg_catalog.octet_length(city)::text || ':' || city
    || '|' || pg_catalog.octet_length(region)::text || ':' || region
    || '|' || pg_catalog.octet_length(postal_code)::text
      || ':' || postal_code
    || '|' || pg_catalog.octet_length(country_code)::text
      || ':' || country_code,
    'UTF8'
  ), 'sha256'), 'hex')
  FROM normalized
$$;

CREATE OR REPLACE FUNCTION
  public.operations_order_dispatch_destination_matches(
    requested_organization_id uuid,
    requested_order_id uuid,
    dispatch_address jsonb
  )
RETURNS boolean
LANGUAGE sql
STABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT COALESCE((
    SELECT CASE
      WHEN working_copy.id IS NULL THEN
        public.operations_dispatch_address_matches_core(
          dispatch_address,
          source_order.ship_to
        )
      ELSE working_copy.dispatch_core_fingerprint
        = public.operations_dispatch_address_core_fingerprint(
          dispatch_address
        )
      END
    FROM public.operations_orders source_order
    LEFT JOIN public.operations_order_shipment_address_working_copies
      working_copy
      ON working_copy.organization_id = source_order.organization_id
     AND working_copy.order_id = source_order.id
    WHERE source_order.organization_id = requested_organization_id
      AND source_order.id = requested_order_id
      AND source_order.archived_at IS NULL
    LIMIT 1
  ), false)
$$;

COMMENT ON FUNCTION
  public.operations_order_dispatch_destination_matches(uuid, uuid, jsonb) IS
  'Binds Active dispatch address checks to the encrypted operational override fingerprint when present, otherwise to the provider/source order address.';

-- Preserve every 0180 Active authority check while replacing only its
-- canonical-source destination comparison with the effective-address helper.
CREATE OR REPLACE FUNCTION
  public.validate_operations_production_rerate_run_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  activation_state text;
  current_activation_revision integer;
  active_execution operations_active_fulfillment_executions%ROWTYPE;
  active_group operations_active_shipment_groups%ROWTYPE;
  shadow_execution operations_fulfillment_executions%ROWTYPE;
  source_run operations_pack_rate_runs%ROWTYPE;
  current_order operations_orders%ROWTYPE;
BEGIN
  SELECT activation.state, activation.revision
    INTO activation_state, current_activation_revision
  FROM operations_activation_scopes activation
  WHERE activation.organization_id = NEW.organization_id
  FOR SHARE;
  IF activation_state IS DISTINCT FROM 'active'
     OR current_activation_revision IS DISTINCT FROM NEW.activation_revision
  THEN
    RAISE EXCEPTION
      'Production fulfillment rerate requires the current Operations Active revision';
  END IF;

  SELECT * INTO active_execution
  FROM operations_active_fulfillment_executions execution
  WHERE execution.organization_id = NEW.organization_id
    AND execution.id = NEW.active_fulfillment_execution_id;
  SELECT * INTO active_group
  FROM operations_active_shipment_groups shipment_group
  WHERE shipment_group.organization_id = NEW.organization_id
    AND shipment_group.id = NEW.active_shipment_group_id
    AND shipment_group.active_fulfillment_execution_id
      = NEW.active_fulfillment_execution_id;
  IF active_execution.id IS NULL
     OR active_group.id IS NULL
     OR active_execution.authority_mode IS DISTINCT FROM 'active'
     OR active_execution.state IS DISTINCT FROM 'prepared'
     OR active_execution.activation_revision
       IS DISTINCT FROM NEW.activation_revision
     OR active_execution.order_id IS DISTINCT FROM NEW.order_id
     OR active_execution.plan_id IS DISTINCT FROM NEW.plan_id
     OR active_execution.warehouse_id IS DISTINCT FROM NEW.warehouse_id
  THEN
    RAISE EXCEPTION
      'Production fulfillment rerate must bind one exact Active execution and shipment group';
  END IF;

  SELECT * INTO shadow_execution
  FROM operations_fulfillment_executions execution
  WHERE execution.organization_id = NEW.organization_id
    AND execution.id = active_execution.shadow_fulfillment_execution_id;
  SELECT * INTO source_run
  FROM operations_pack_rate_runs run
  WHERE run.organization_id = NEW.organization_id
    AND run.id = NEW.source_fulfillment_pack_rate_run_id;
  IF shadow_execution.id IS NULL
     OR source_run.id IS NULL
     OR shadow_execution.fulfillment_pack_rate_run_id
       IS DISTINCT FROM NEW.source_fulfillment_pack_rate_run_id
     OR source_run.purpose IS DISTINCT FROM 'fulfillment_execution'
     OR source_run.status IS DISTINCT FROM 'succeeded'
  THEN
    RAISE EXCEPTION
      'Production fulfillment rerate requires the exact successful Shadow fulfillment pack-rate source';
  END IF;

  SELECT * INTO current_order
  FROM operations_orders orders
  WHERE orders.organization_id = NEW.organization_id
    AND orders.id = NEW.order_id;
  IF current_order.id IS NULL
     OR current_order.currency IS DISTINCT FROM NEW.currency
     OR NOT public.operations_order_dispatch_destination_matches(
       NEW.organization_id,
       NEW.order_id,
       NEW.destination_snapshot
     )
  THEN
    RAISE EXCEPTION
      'Production fulfillment rerate destination or currency is stale';
  END IF;
  IF active_group.package_count IS DISTINCT FROM NEW.package_count THEN
    RAISE EXCEPTION
      'Production fulfillment rerate package count does not match the Active group';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION
  public.validate_operations_production_rerate_attempt_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  rerate_run operations_production_fulfillment_rerate_runs%ROWTYPE;
  integration_account operations_integration_accounts%ROWTYPE;
  carrier_account operations_carrier_accounts%ROWTYPE;
  carrier_credential operations_carrier_credentials%ROWTYPE;
  prior_attempt_id uuid;
  prior_attempt_number integer;
  prior_result_state text;
  expected_billing_snapshot jsonb;
BEGIN
  SELECT * INTO rerate_run
  FROM operations_production_fulfillment_rerate_runs run
  WHERE run.organization_id = NEW.organization_id
    AND run.id = NEW.rerate_run_id;
  IF rerate_run.id IS NULL THEN
    RAISE EXCEPTION 'Production fulfillment rerate run was not found';
  END IF;
  PERFORM 1
  FROM operations_activation_scopes activation
  WHERE activation.organization_id = NEW.organization_id
    AND activation.state = 'active'
    AND activation.revision = rerate_run.activation_revision
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Production fulfillment rerate attempt requires the current Operations Active revision';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM operations_orders orders
    WHERE orders.organization_id = rerate_run.organization_id
      AND orders.id = rerate_run.order_id
      AND (
        NOT public.operations_order_dispatch_destination_matches(
          rerate_run.organization_id,
          rerate_run.order_id,
          rerate_run.destination_snapshot
        )
        OR orders.currency IS DISTINCT FROM rerate_run.currency
      )
  ) THEN
    RAISE EXCEPTION
      'Production fulfillment rerate destination or currency changed after run preparation';
  END IF;

  SELECT * INTO integration_account
  FROM operations_integration_accounts account
  WHERE account.organization_id = NEW.organization_id
    AND account.id = NEW.integration_account_id;
  SELECT * INTO carrier_account
  FROM operations_carrier_accounts account
  WHERE account.organization_id = NEW.organization_id
    AND account.integration_account_id = NEW.integration_account_id
    AND account.id = NEW.carrier_account_id;
  SELECT * INTO carrier_credential
  FROM operations_carrier_credentials credential
  WHERE credential.organization_id = NEW.organization_id
    AND credential.integration_account_id = NEW.integration_account_id;
  IF integration_account.id IS NULL
     OR integration_account.integration_type IS DISTINCT FROM 'carrier'
     OR integration_account.provider IS DISTINCT FROM NEW.provider
     OR integration_account.environment IS DISTINCT FROM 'production'
     OR integration_account.status IS DISTINCT FROM 'active'
     OR carrier_account.id IS NULL
     OR carrier_account.status IS DISTINCT FROM 'active'
     OR carrier_account.configuration_revision
       IS DISTINCT FROM NEW.carrier_account_configuration_revision
     OR carrier_account.account_number_fingerprint
       IS DISTINCT FROM NEW.account_number_fingerprint
     OR carrier_account.registered_address_fingerprint
       IS DISTINCT FROM NEW.registered_origin_fingerprint
     OR NOT operations_dispatch_address_matches_core(
       NEW.origin_snapshot,
       carrier_account.registered_address
     )
     OR carrier_account.sender_name IS DISTINCT FROM NEW.sender_name_snapshot
     OR carrier_credential.integration_account_id IS NULL
     OR carrier_credential.verification_status IS DISTINCT FROM 'verified'
     OR carrier_credential.credential_version
       IS DISTINCT FROM NEW.credential_revision
     OR carrier_credential.credential_fingerprint
       IS DISTINCT FROM NEW.credential_fingerprint
  THEN
    RAISE EXCEPTION
      'Production fulfillment rerate attempt requires the exact current production account and credential revision';
  END IF;

  IF (NEW.billing_relationship = 'sender'
      AND carrier_account.allow_sender_billing IS DISTINCT FROM true)
     OR (NEW.billing_relationship = 'recipient'
      AND carrier_account.allow_recipient_billing IS DISTINCT FROM true)
     OR (NEW.billing_relationship = 'third_party'
      AND carrier_account.allow_third_party_billing IS DISTINCT FROM true)
     OR (
       NEW.billing_relationship = 'sender'
       AND NEW.payer_account_number_fingerprint
         IS DISTINCT FROM carrier_account.account_number_fingerprint
     )
  THEN
    RAISE EXCEPTION
      'Production fulfillment rerate billing relationship is not authorized by the selected account revision';
  END IF;
  expected_billing_snapshot := jsonb_build_object(
    'relationship', NEW.billing_relationship,
    'payerAccountNumberFingerprint',
      NEW.payer_account_number_fingerprint,
    'payerCountryCode', NEW.payer_country_code,
    'payerPostalCode', NEW.payer_postal_code
  );
  IF NEW.billing_snapshot IS DISTINCT FROM expected_billing_snapshot THEN
    RAISE EXCEPTION
      'Production fulfillment rerate billing snapshot does not match its exact columns';
  END IF;

  SELECT attempt.id, attempt.attempt_number, result.state
    INTO prior_attempt_id, prior_attempt_number, prior_result_state
  FROM operations_production_fulfillment_rerate_attempts attempt
  LEFT JOIN operations_production_fulfillment_rerate_results result
    ON result.organization_id = attempt.organization_id
   AND result.attempt_id = attempt.id
  WHERE attempt.organization_id = NEW.organization_id
    AND attempt.rerate_run_id = NEW.rerate_run_id
    AND attempt.provider = NEW.provider
  ORDER BY attempt.attempt_number DESC
  LIMIT 1
  FOR UPDATE OF attempt;
  IF prior_attempt_id IS NOT NULL
     AND prior_result_state IS DISTINCT FROM 'failed'
  THEN
    RAISE EXCEPTION
      'Prepared, succeeded, or unknown production rerate attempt cannot be retried';
  END IF;
  IF NEW.attempt_number IS DISTINCT FROM COALESCE(
    prior_attempt_number + 1,
    1
  ) THEN
    RAISE EXCEPTION
      'Production fulfillment rerate attempt number must be consecutive per provider';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION
  public.validate_operations_production_rerate_selection_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  rerate_run operations_production_fulfillment_rerate_runs%ROWTYPE;
  attempt_row operations_production_fulfillment_rerate_attempts%ROWTYPE;
  result_row operations_production_fulfillment_rerate_results%ROWTYPE;
  offer_row operations_production_fulfillment_rerate_offers%ROWTYPE;
  integration_account operations_integration_accounts%ROWTYPE;
  carrier_account operations_carrier_accounts%ROWTYPE;
  carrier_credential operations_carrier_credentials%ROWTYPE;
BEGIN
  SELECT * INTO rerate_run
  FROM operations_production_fulfillment_rerate_runs run
  WHERE run.organization_id = NEW.organization_id
    AND run.id = NEW.rerate_run_id;
  SELECT * INTO attempt_row
  FROM operations_production_fulfillment_rerate_attempts attempt
  WHERE attempt.organization_id = NEW.organization_id
    AND attempt.id = NEW.attempt_id
    AND attempt.rerate_run_id = NEW.rerate_run_id;
  SELECT * INTO result_row
  FROM operations_production_fulfillment_rerate_results result
  WHERE result.organization_id = NEW.organization_id
    AND result.id = NEW.result_id
    AND result.rerate_run_id = NEW.rerate_run_id
    AND result.attempt_id = NEW.attempt_id;
  SELECT * INTO offer_row
  FROM operations_production_fulfillment_rerate_offers offer
  WHERE offer.organization_id = NEW.organization_id
    AND offer.id = NEW.offer_id
    AND offer.rerate_run_id = NEW.rerate_run_id
    AND offer.attempt_id = NEW.attempt_id
    AND offer.result_id = NEW.result_id;
  IF rerate_run.id IS NULL
     OR attempt_row.id IS NULL
     OR result_row.id IS NULL
     OR offer_row.id IS NULL
     OR result_row.state IS DISTINCT FROM 'succeeded'
     OR NEW.active_fulfillment_execution_id
       IS DISTINCT FROM rerate_run.active_fulfillment_execution_id
     OR NEW.active_shipment_group_id
       IS DISTINCT FROM rerate_run.active_shipment_group_id
     OR NEW.provider IS DISTINCT FROM attempt_row.provider
     OR NEW.provider IS DISTINCT FROM offer_row.provider
     OR NEW.service_code IS DISTINCT FROM offer_row.service_code
     OR NEW.service_name IS DISTINCT FROM offer_row.service_name
     OR NEW.amount_minor IS DISTINCT FROM offer_row.amount_minor
     OR NEW.currency IS DISTINCT FROM offer_row.currency
     OR NEW.integration_account_id
       IS DISTINCT FROM attempt_row.integration_account_id
     OR NEW.carrier_account_id
       IS DISTINCT FROM attempt_row.carrier_account_id
     OR NEW.carrier_account_configuration_revision
       IS DISTINCT FROM attempt_row.carrier_account_configuration_revision
     OR NEW.account_number_fingerprint
       IS DISTINCT FROM attempt_row.account_number_fingerprint
     OR NEW.registered_origin_fingerprint
       IS DISTINCT FROM attempt_row.registered_origin_fingerprint
     OR NEW.credential_revision
       IS DISTINCT FROM attempt_row.credential_revision
     OR NEW.credential_fingerprint
       IS DISTINCT FROM attempt_row.credential_fingerprint
     OR NEW.adapter_version IS DISTINCT FROM attempt_row.adapter_version
     OR NEW.provider_reference IS DISTINCT FROM result_row.provider_reference
     OR NEW.input_hash IS DISTINCT FROM rerate_run.input_hash
     OR NEW.result_hash IS DISTINCT FROM result_row.result_hash
     OR NEW.origin_fingerprint IS DISTINCT FROM attempt_row.origin_fingerprint
     OR NEW.destination_fingerprint
       IS DISTINCT FROM rerate_run.destination_fingerprint
     OR NEW.billing_fingerprint
       IS DISTINCT FROM attempt_row.billing_fingerprint
     OR NEW.ordered_package_set_fingerprint
       IS DISTINCT FROM rerate_run.ordered_package_set_fingerprint
     OR NEW.expires_at IS DISTINCT FROM result_row.expires_at
     OR NEW.expires_at IS DISTINCT FROM offer_row.expires_at
  THEN
    RAISE EXCEPTION
      'Production fulfillment rerate selection must snapshot one exact successful offer and dispatch binding';
  END IF;
  IF NEW.selected_at < result_row.completed_at
     OR NEW.selected_at >= NEW.expires_at
     OR NEW.selected_at > clock_timestamp()
     OR clock_timestamp() >= NEW.expires_at
  THEN
    RAISE EXCEPTION
      'Production fulfillment rerate selection requires a currently unexpired successful offer and cannot be future-dated';
  END IF;

  PERFORM 1
  FROM operations_activation_scopes activation
  WHERE activation.organization_id = NEW.organization_id
    AND activation.state = 'active'
    AND activation.revision = rerate_run.activation_revision
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Production fulfillment rerate selection requires the current Operations Active revision';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM operations_orders orders
    WHERE orders.organization_id = rerate_run.organization_id
      AND orders.id = rerate_run.order_id
      AND (
        NOT public.operations_order_dispatch_destination_matches(
          rerate_run.organization_id,
          rerate_run.order_id,
          rerate_run.destination_snapshot
        )
        OR orders.currency IS DISTINCT FROM rerate_run.currency
      )
  ) THEN
    RAISE EXCEPTION
      'Production fulfillment rerate selection destination or currency is stale';
  END IF;

  SELECT * INTO integration_account
  FROM operations_integration_accounts account
  WHERE account.organization_id = NEW.organization_id
    AND account.id = NEW.integration_account_id;
  SELECT * INTO carrier_account
  FROM operations_carrier_accounts account
  WHERE account.organization_id = NEW.organization_id
    AND account.integration_account_id = NEW.integration_account_id
    AND account.id = NEW.carrier_account_id;
  SELECT * INTO carrier_credential
  FROM operations_carrier_credentials credential
  WHERE credential.organization_id = NEW.organization_id
    AND credential.integration_account_id = NEW.integration_account_id;
  IF integration_account.id IS NULL
     OR integration_account.integration_type IS DISTINCT FROM 'carrier'
     OR integration_account.provider IS DISTINCT FROM NEW.provider
     OR integration_account.provider IS DISTINCT FROM attempt_row.provider
     OR integration_account.environment IS DISTINCT FROM 'production'
     OR integration_account.status IS DISTINCT FROM 'active'
     OR carrier_account.id IS NULL
     OR carrier_account.status IS DISTINCT FROM 'active'
     OR carrier_account.configuration_revision
       IS DISTINCT FROM NEW.carrier_account_configuration_revision
     OR carrier_account.account_number_fingerprint
       IS DISTINCT FROM NEW.account_number_fingerprint
     OR carrier_account.registered_address_fingerprint
       IS DISTINCT FROM NEW.registered_origin_fingerprint
     OR carrier_credential.integration_account_id IS NULL
     OR carrier_credential.verification_status IS DISTINCT FROM 'verified'
     OR carrier_credential.credential_version
       IS DISTINCT FROM NEW.credential_revision
     OR carrier_credential.credential_fingerprint
       IS DISTINCT FROM NEW.credential_fingerprint
  THEN
    RAISE EXCEPTION
      'Production fulfillment rerate selection integration, account, or credential revision is stale';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION
  public.validate_operations_active_carrier_group_attempt_prepare()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  activation_state text;
  current_activation_revision integer;
  shipment_group operations_active_shipment_groups%ROWTYPE;
  selection operations_production_fulfillment_rerate_selections%ROWTYPE;
  rerate_run operations_production_fulfillment_rerate_runs%ROWTYPE;
  rerate_attempt
    operations_production_fulfillment_rerate_attempts%ROWTYPE;
  integration_account operations_integration_accounts%ROWTYPE;
  carrier_account operations_carrier_accounts%ROWTYPE;
  carrier_credential operations_carrier_credentials%ROWTYPE;
  current_order operations_orders%ROWTYPE;
  prior_attempt_state text;
  expected_attempt_number integer;
BEGIN
  SELECT activation.state, activation.revision
    INTO activation_state, current_activation_revision
  FROM operations_activation_scopes activation
  WHERE activation.organization_id = NEW.organization_id;
  IF activation_state IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION
      'Active carrier group attempt requires Operations Active';
  END IF;

  SELECT * INTO shipment_group
  FROM operations_active_shipment_groups candidate
  WHERE candidate.organization_id = NEW.organization_id
    AND candidate.id = NEW.active_shipment_group_id
    AND candidate.active_fulfillment_execution_id
      = NEW.active_fulfillment_execution_id;
  SELECT * INTO selection
  FROM operations_production_fulfillment_rerate_selections candidate
  WHERE candidate.organization_id = NEW.organization_id
    AND candidate.id = NEW.production_rerate_selection_id
    AND candidate.active_fulfillment_execution_id
      = NEW.active_fulfillment_execution_id
    AND candidate.active_shipment_group_id = NEW.active_shipment_group_id;
  SELECT * INTO rerate_run
  FROM operations_production_fulfillment_rerate_runs run
  WHERE run.organization_id = NEW.organization_id
    AND run.id = selection.rerate_run_id;
  SELECT * INTO rerate_attempt
  FROM operations_production_fulfillment_rerate_attempts attempt
  WHERE attempt.organization_id = NEW.organization_id
    AND attempt.id = selection.attempt_id
    AND attempt.rerate_run_id = selection.rerate_run_id;
  SELECT * INTO integration_account
  FROM operations_integration_accounts account
  WHERE account.organization_id = NEW.organization_id
    AND account.id = selection.integration_account_id;
  SELECT * INTO carrier_account
  FROM operations_carrier_accounts account
  WHERE account.organization_id = NEW.organization_id
    AND account.integration_account_id = selection.integration_account_id
    AND account.id = selection.carrier_account_id;
  SELECT * INTO carrier_credential
  FROM operations_carrier_credentials credential
  WHERE credential.organization_id = NEW.organization_id
    AND credential.integration_account_id = selection.integration_account_id;
  SELECT * INTO current_order
  FROM operations_orders orders
  WHERE orders.organization_id = NEW.organization_id
    AND orders.id = rerate_run.order_id;
  IF shipment_group.id IS NULL
     OR selection.id IS NULL
     OR rerate_run.id IS NULL
     OR rerate_attempt.id IS NULL
     OR current_activation_revision
       IS DISTINCT FROM rerate_run.activation_revision
     OR NEW.persisted_at >= selection.expires_at
     OR clock_timestamp() >= selection.expires_at
     OR NEW.selected_provider IS DISTINCT FROM selection.provider
     OR NEW.selected_service_code IS DISTINCT FROM selection.service_code
     OR NEW.selected_service_name IS DISTINCT FROM selection.service_name
     OR NEW.package_count IS DISTINCT FROM rerate_run.package_count
  THEN
    RAISE EXCEPTION
      'Active carrier attempt requires the exact current unexpired production rerate selection';
  END IF;

  IF current_order.id IS NULL
     OR current_order.currency IS DISTINCT FROM rerate_run.currency
     OR NOT public.operations_order_dispatch_destination_matches(
       rerate_run.organization_id,
       rerate_run.order_id,
       rerate_run.destination_snapshot
     )
  THEN
    RAISE EXCEPTION
      'Active carrier attempt destination or currency changed after production rerating';
  END IF;

  IF integration_account.id IS NULL
     OR integration_account.integration_type IS DISTINCT FROM 'carrier'
     OR integration_account.provider IS DISTINCT FROM selection.provider
     OR integration_account.environment IS DISTINCT FROM 'production'
     OR integration_account.status IS DISTINCT FROM 'active'
     OR carrier_account.id IS NULL
     OR carrier_account.status IS DISTINCT FROM 'active'
     OR carrier_account.configuration_revision
       IS DISTINCT FROM selection.carrier_account_configuration_revision
     OR carrier_account.configuration_revision
       IS DISTINCT FROM rerate_attempt.carrier_account_configuration_revision
     OR carrier_account.account_number_fingerprint
       IS DISTINCT FROM selection.account_number_fingerprint
     OR carrier_account.account_number_fingerprint
       IS DISTINCT FROM rerate_attempt.account_number_fingerprint
     OR carrier_account.registered_address_fingerprint
       IS DISTINCT FROM selection.registered_origin_fingerprint
     OR carrier_account.registered_address_fingerprint
       IS DISTINCT FROM rerate_attempt.registered_origin_fingerprint
     OR NOT operations_dispatch_address_matches_core(
       rerate_attempt.origin_snapshot,
       carrier_account.registered_address
     )
     OR rerate_attempt.origin_fingerprint
       IS DISTINCT FROM selection.origin_fingerprint
     OR rerate_attempt.billing_fingerprint
       IS DISTINCT FROM selection.billing_fingerprint
     OR (
       rerate_attempt.billing_relationship = 'sender'
       AND carrier_account.allow_sender_billing IS DISTINCT FROM true
     )
     OR (
       rerate_attempt.billing_relationship = 'recipient'
       AND carrier_account.allow_recipient_billing IS DISTINCT FROM true
     )
     OR (
       rerate_attempt.billing_relationship = 'third_party'
       AND carrier_account.allow_third_party_billing IS DISTINCT FROM true
     )
     OR carrier_credential.integration_account_id IS NULL
     OR carrier_credential.verification_status IS DISTINCT FROM 'verified'
     OR carrier_credential.credential_version
       IS DISTINCT FROM selection.credential_revision
     OR carrier_credential.credential_version
       IS DISTINCT FROM rerate_attempt.credential_revision
     OR carrier_credential.credential_fingerprint
       IS DISTINCT FROM selection.credential_fingerprint
     OR carrier_credential.credential_fingerprint
       IS DISTINCT FROM rerate_attempt.credential_fingerprint
  THEN
    RAISE EXCEPTION
      'Active carrier attempt requires the current production integration, account, credential, origin, and billing authority';
  END IF;

  SELECT attempt.state, attempt.attempt_number + 1
    INTO prior_attempt_state, expected_attempt_number
  FROM operations_active_carrier_group_attempts attempt
  WHERE attempt.organization_id = NEW.organization_id
    AND attempt.active_shipment_group_id = NEW.active_shipment_group_id
  ORDER BY attempt.attempt_number DESC
  LIMIT 1;
  expected_attempt_number := COALESCE(expected_attempt_number, 1);
  IF prior_attempt_state IS NOT NULL AND prior_attempt_state <> 'failed' THEN
    RAISE EXCEPTION
      'Prepared, succeeded, or unknown Active carrier attempt cannot be retried';
  END IF;
  IF NEW.attempt_number <> expected_attempt_number THEN
    RAISE EXCEPTION
      'Active carrier group attempt number must be consecutive';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION
  public.validate_operations_order_shipment_address_working_copy()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  bound_order_global_id text;
  bound_order_row_version bigint;
  bound_account_global_id text;
BEGIN
  IF TG_OP = 'UPDATE' AND ROW(
    NEW.organization_id,
    NEW.order_id,
    NEW.created_by,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.organization_id,
    OLD.order_id,
    OLD.created_by,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION
      'Operations shipment-address order binding is immutable';
  END IF;

  SELECT source_order.global_id, source_order.row_version,
         source_account.global_id
  INTO bound_order_global_id, bound_order_row_version,
       bound_account_global_id
  FROM public.operations_orders source_order
  LEFT JOIN public.operations_integration_accounts source_account
    ON source_account.organization_id = source_order.organization_id
   AND source_account.id = source_order.integration_account_id
  WHERE source_order.organization_id = NEW.organization_id
    AND source_order.id = NEW.order_id
    AND source_order.archived_at IS NULL
  FOR UPDATE OF source_order;

  IF bound_order_global_id IS NULL THEN
    RAISE EXCEPTION
      'Operations shipment-address order binding is invalid';
  END IF;

  IF bound_order_row_version <> NEW.source_order_row_version THEN
    RAISE EXCEPTION
      'Operations shipment-address order version is stale';
  END IF;

  IF bound_account_global_id IS NULL THEN
    RAISE EXCEPTION
      'Operations shipment-address provider account binding is invalid';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.operations_command_receipts receipt
    WHERE receipt.organization_id = NEW.organization_id
      AND receipt.id = NEW.last_command_receipt_id
      AND receipt.command_type =
        'operations.order_shipment_address.update'
      AND receipt.target_global_id = bound_order_global_id
      AND receipt.request_hash = NEW.last_request_hash
  ) THEN
    RAISE EXCEPTION
      'Operations shipment-address receipt binding is invalid';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER validate_operations_order_shipment_address_working_copy
BEFORE INSERT OR UPDATE
ON public.operations_order_shipment_address_working_copies
FOR EACH ROW EXECUTE FUNCTION
  public.validate_operations_order_shipment_address_working_copy();

COMMENT ON TABLE public.operations_order_shipment_address_working_copies IS
  'Encrypted tenant-scoped operational shipment-address overrides. The provider-mirrored operations_orders.ship_to value remains separate and provider writes remain zero.';

COMMENT ON COLUMN
  public.operations_order_shipment_address_working_copies.source_order_hash IS
  'Hash of the provider/source address and canonical order identity accepted by the latest local save; drift is projected without discarding the local working copy.';

COMMENT ON COLUMN
  public.operations_order_shipment_address_working_copies.source_order_row_version IS
  'Canonical order row version observed under lock during the latest local save. A later canonical change must be refreshed before another edit.';
