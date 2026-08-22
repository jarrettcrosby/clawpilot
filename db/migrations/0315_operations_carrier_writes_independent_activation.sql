-- Production carrier work is authorized by its exact execution, rerate,
-- carrier-account, credential, provider, package, label, and shipment
-- evidence. The legacy workspace activation profile is retained as telemetry;
-- it is not an authority for carrier reads or carrier shipment writes.

-- Preserve immutable production lineage and exact attempt ownership while
-- removing only the organization-wide activation-state predicate inherited
-- from 0179.
CREATE OR REPLACE FUNCTION
  public.validate_operations_active_fulfillment_lineage_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  linked_label_environment text;
  linked_label_execution_id uuid;
  linked_label_group_id uuid;
  linked_label_attempt_id uuid;
  linked_label_one_off_group_id uuid;
  linked_label_package_id uuid;
  linked_attempt_state text;
  linked_execution_order_id uuid;
  linked_execution_plan_id uuid;
  effective_execution_id uuid;
  effective_group_id uuid;
  effective_attempt_id uuid;
  row_environment text;
  row_one_off_group_id uuid;
  row_order_id uuid;
  row_plan_id uuid;
  row_package_id uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND ROW(
    NEW.active_fulfillment_execution_id,
    NEW.active_shipment_group_id,
    NEW.active_carrier_group_attempt_id
  ) IS DISTINCT FROM ROW(
    OLD.active_fulfillment_execution_id,
    OLD.active_shipment_group_id,
    OLD.active_carrier_group_attempt_id
  ) THEN
    RAISE EXCEPTION 'Active fulfillment carrier-write lineage is immutable';
  END IF;

  -- This trigger is shared by label-attempt, label, and shipment rows. Only
  -- the first two expose an environment column, so resolve it without a
  -- record-field access that is invalid for operations_shipments.
  row_environment := to_jsonb(NEW)->>'environment';
  row_one_off_group_id := NULLIF(
    to_jsonb(NEW)->>'one_off_carrier_group_attempt_id',
    ''
  )::uuid;
  row_order_id := NULLIF(to_jsonb(NEW)->>'order_id', '')::uuid;
  row_plan_id := NULLIF(to_jsonb(NEW)->>'plan_id', '')::uuid;
  row_package_id := NULLIF(to_jsonb(NEW)->>'package_id', '')::uuid;

  effective_execution_id := NEW.active_fulfillment_execution_id;
  effective_group_id := NEW.active_shipment_group_id;
  effective_attempt_id := NEW.active_carrier_group_attempt_id;

  IF TG_TABLE_NAME = 'operations_shipments' THEN
    SELECT
      label.environment,
      label.active_fulfillment_execution_id,
      label.active_shipment_group_id,
      label.active_carrier_group_attempt_id,
      label.one_off_carrier_group_attempt_id,
      label.package_id
    INTO
      linked_label_environment,
      linked_label_execution_id,
      linked_label_group_id,
      linked_label_attempt_id,
      linked_label_one_off_group_id,
      linked_label_package_id
    FROM operations_labels label
    WHERE label.organization_id = NEW.organization_id
      AND label.id = NEW.label_id;

    IF linked_label_environment = 'production'
       AND linked_label_execution_id IS NOT NULL
    THEN
      IF TG_OP = 'INSERT'
         AND NEW.active_fulfillment_execution_id IS NULL
         AND NEW.active_shipment_group_id IS NULL
         AND NEW.active_carrier_group_attempt_id IS NULL
      THEN
        -- The connected application insert carries the exact label identity;
        -- materialize that label's already-validated authority on the durable
        -- shipment so existing FKs and deferred completion checks stay exact.
        NEW.active_fulfillment_execution_id := linked_label_execution_id;
        NEW.active_shipment_group_id := linked_label_group_id;
        NEW.active_carrier_group_attempt_id := linked_label_attempt_id;
      END IF;
      IF linked_label_one_off_group_id IS NOT NULL
         OR row_one_off_group_id IS NOT NULL
         OR linked_label_package_id IS DISTINCT FROM row_package_id
         OR ROW(
           NEW.active_fulfillment_execution_id,
           NEW.active_shipment_group_id,
           NEW.active_carrier_group_attempt_id
         ) IS DISTINCT FROM ROW(
           linked_label_execution_id,
           linked_label_group_id,
           linked_label_attempt_id
         )
      THEN
        RAISE EXCEPTION
          'Active shipment lineage must match its production label';
      END IF;
      -- Validate through the linked label for both new and retained rows.
      effective_execution_id := linked_label_execution_id;
      effective_group_id := linked_label_group_id;
      effective_attempt_id := linked_label_attempt_id;
    END IF;
  END IF;

  IF effective_execution_id IS NULL THEN
    IF TG_TABLE_NAME IN ('operations_label_attempts', 'operations_labels')
       AND row_environment = 'production'
       AND row_one_off_group_id IS NULL
    THEN
      RAISE EXCEPTION
        'Production carrier label writes require exact carrier authority lineage';
    END IF;
    IF TG_TABLE_NAME = 'operations_shipments'
       AND linked_label_environment = 'production'
       AND (
         row_one_off_group_id IS NULL
         OR linked_label_one_off_group_id
           IS DISTINCT FROM row_one_off_group_id
       )
    THEN
      RAISE EXCEPTION
        'Production shipment writes require exact carrier authority lineage';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME IN ('operations_label_attempts', 'operations_labels')
     AND row_environment IS DISTINCT FROM 'production'
  THEN
    RAISE EXCEPTION
      'Active fulfillment carrier-write lineage requires production evidence';
  END IF;
  IF TG_TABLE_NAME = 'operations_shipments' AND (
    linked_label_environment IS DISTINCT FROM 'production'
    OR linked_label_execution_id IS DISTINCT FROM effective_execution_id
    OR linked_label_group_id IS DISTINCT FROM effective_group_id
    OR linked_label_attempt_id IS DISTINCT FROM effective_attempt_id
  ) THEN
    RAISE EXCEPTION
      'Active shipment lineage must match its production label';
  END IF;

  SELECT
    attempt.state,
    execution.order_id,
    execution.plan_id
  INTO
    linked_attempt_state,
    linked_execution_order_id,
    linked_execution_plan_id
  FROM operations_active_carrier_group_attempts attempt
  JOIN operations_active_fulfillment_executions execution
    ON execution.organization_id = attempt.organization_id
   AND execution.id = attempt.active_fulfillment_execution_id
  WHERE attempt.organization_id = NEW.organization_id
    AND attempt.id = effective_attempt_id
    AND attempt.active_fulfillment_execution_id
      = effective_execution_id
    AND attempt.active_shipment_group_id = effective_group_id
    AND execution.authority_mode = 'active';
  IF linked_attempt_state IS NULL THEN
    RAISE EXCEPTION 'Active carrier group attempt lineage was not found';
  END IF;
  IF TG_TABLE_NAME = 'operations_shipments' AND (
    linked_execution_order_id IS DISTINCT FROM row_order_id
    OR linked_execution_plan_id IS DISTINCT FROM row_plan_id
  ) THEN
    RAISE EXCEPTION
      'Active shipment lineage does not match its order and plan';
  END IF;
  RETURN NEW;
END;
$$;

-- Preserve the exact immutable Shadow preparation, order, plan, warehouse,
-- and package lineage. activation_revision remains immutable correlation
-- metadata on the execution, not a global authorization predicate.
CREATE OR REPLACE FUNCTION
  public.validate_operations_active_execution_prepare()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  shadow_execution operations_fulfillment_executions%ROWTYPE;
  shadow_group operations_shipment_groups%ROWTYPE;
BEGIN
  SELECT * INTO shadow_execution
  FROM operations_fulfillment_executions execution
  WHERE execution.organization_id = NEW.organization_id
    AND execution.id = NEW.shadow_fulfillment_execution_id;
  SELECT * INTO shadow_group
  FROM operations_shipment_groups shipment_group
  WHERE shipment_group.organization_id = NEW.organization_id
    AND shipment_group.fulfillment_execution_id
      = NEW.shadow_fulfillment_execution_id;
  IF shadow_execution.id IS NULL
     OR shadow_execution.authority_mode IS DISTINCT FROM 'shadow'
     OR shadow_execution.state IS DISTINCT FROM 'shadow_prepared'
     OR shadow_execution.order_id IS DISTINCT FROM NEW.order_id
     OR shadow_execution.plan_id IS DISTINCT FROM NEW.plan_id
     OR shadow_group.warehouse_id IS DISTINCT FROM NEW.warehouse_id
  THEN
    RAISE EXCEPTION
      'Active execution must reference one exact immutable Shadow preparation';
  END IF;
  RETURN NEW;
END;
$$;

-- Preserve every 0310 effective-address, currency, execution, plan,
-- warehouse, package-count, and successful Shadow source check. Remove only
-- the current global activation-state/revision lookup.
CREATE OR REPLACE FUNCTION
  public.validate_operations_production_rerate_run_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  active_execution operations_active_fulfillment_executions%ROWTYPE;
  active_group operations_active_shipment_groups%ROWTYPE;
  shadow_execution operations_fulfillment_executions%ROWTYPE;
  source_run operations_pack_rate_runs%ROWTYPE;
  current_order operations_orders%ROWTYPE;
BEGIN
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

-- Provider rerate attempts remain bound to one real production integration,
-- current carrier account and credential, registered origin, allowed billing
-- relationship, exact request evidence, and consecutive retry proof.
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

-- A selection remains an immutable, currently unexpired successful provider
-- offer with exact account, credential, destination, billing, and package-set
-- bindings. The workspace activation profile contributes no authority.
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

-- Dispatch preparation still requires the exact unexpired rerate selection,
-- provider/service/package set, production integration, carrier account,
-- credential, origin, billing relationship, and retry sequence.
CREATE OR REPLACE FUNCTION
  public.validate_operations_active_carrier_group_attempt_prepare()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
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

-- The exact development test-store claim remains bound to one unexpired
-- authorization, sandbox Shopify account, verified credential generation,
-- promoted provider-test candidate, canonical order, and immutable evidence.
-- The legacy read_only label and its revision are retained only in the
-- evidence record; they do not grant or revoke this exact-order claim.
CREATE OR REPLACE FUNCTION
  public.operations_shopify_test_store_e2e_is_current(
    requested_organization_id uuid,
    requested_authorization_id uuid,
    requested_order_id uuid
  )
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM operations_sandbox_commerce_e2e_authorizations auth
    JOIN operations_shopify_test_store_e2e_evidence evidence
      ON evidence.organization_id = auth.organization_id
     AND evidence.authorization_id = auth.id
     AND evidence.confirmation_hash = auth.confirmation_hash
    JOIN operations_orders source_order
      ON source_order.organization_id = evidence.organization_id
     AND source_order.id = evidence.order_id
    JOIN operations_integration_accounts account
      ON account.organization_id = evidence.organization_id
     AND account.id = evidence.integration_account_id
    JOIN operations_commerce_credentials credential
      ON credential.organization_id = account.organization_id
     AND credential.integration_account_id = account.id
    JOIN operations_commerce_order_candidates candidate
      ON candidate.organization_id = evidence.organization_id
     AND candidate.id = evidence.order_candidate_id
    WHERE auth.organization_id = requested_organization_id
      AND auth.id = requested_authorization_id
      AND auth.order_id = requested_order_id
      AND auth.state = 'active'
      AND auth.expires_at > statement_timestamp()
      AND auth.confirmation_statement_version =
            'shopify-test-store-canonical-e2e-v1'
      AND source_order.id = auth.order_id
      AND source_order.global_id = evidence.order_global_id
      AND source_order.source_provider = 'shopify'
      AND source_order.integration_account_id = account.id
      AND source_order.external_order_id = auth.external_order_id
      AND source_order.external_order_id = evidence.external_order_id
      AND source_order.row_version >= evidence.initial_order_row_version
      AND account.provider = 'shopify'
      AND account.integration_type = 'commerce'
      AND account.environment = 'sandbox'
      AND account.status = 'active'
      AND account.global_id = evidence.account_global_id
      AND account.external_account_id = evidence.external_account_id
      AND account.commerce_credential_generation =
            evidence.credential_generation
      AND credential.credential_version = evidence.credential_generation
      AND credential.external_account_id = evidence.external_account_id
      AND credential.verification_status = 'verified'
      AND candidate.integration_account_id = account.id
      AND candidate.canonical_order_id = source_order.id
      AND candidate.provider = 'shopify'
      AND candidate.workflow_state = 'promoted'
      AND candidate.test_order = true
      AND candidate.global_id = evidence.order_candidate_global_id
      AND candidate.row_version = evidence.order_candidate_row_version
      AND candidate.source_revision = evidence.order_candidate_source_revision
      AND candidate.source_hash = evidence.order_candidate_source_hash
      AND evidence.provider_test = true
  )
$$;

COMMENT ON FUNCTION
  public.validate_operations_active_fulfillment_lineage_write() IS
  'Validates immutable production label and shipment lineage against its exact carrier attempt without using the legacy Operations activation profile as authority.';

COMMENT ON FUNCTION public.validate_operations_active_execution_prepare() IS
  'Validates one exact immutable Shadow preparation for production carrier execution; activation_revision is retained as lineage metadata only.';

COMMENT ON FUNCTION
  public.validate_operations_production_rerate_run_insert() IS
  'Validates exact execution, source pack-rate, destination, currency, and package authority for a production rerate independent of the legacy Operations activation profile.';

COMMENT ON FUNCTION
  public.validate_operations_production_rerate_attempt_insert() IS
  'Validates exact production carrier account, credential, origin, billing, request, and retry authority independent of the legacy Operations activation profile.';

COMMENT ON FUNCTION
  public.validate_operations_production_rerate_selection_insert() IS
  'Validates one current successful production carrier offer and its complete dispatch binding independent of the legacy Operations activation profile.';

COMMENT ON FUNCTION
  public.validate_operations_active_carrier_group_attempt_prepare() IS
  'Validates exact unexpired production rerate, carrier, credential, origin, billing, package, and retry authority independent of the legacy Operations activation profile.';

COMMENT ON FUNCTION
  public.operations_shopify_test_store_e2e_is_current(uuid, uuid, uuid) IS
  'Checks one exact unexpired sandbox Shopify test-order claim against its current account, credential, candidate, canonical order, and immutable evidence independent of the legacy Operations activation profile.';

-- LIVE shipping-account diagnostics use the exact production integration,
-- credential generation, sender account, successful rate evidence, and
-- immutable request identity as their authority. The workspace activation
-- profile is not part of that carrier-specific authority.
CREATE OR REPLACE FUNCTION
  public.validate_operations_carrier_shipping_diagnostic_lineage()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  evidence operations_carrier_rate_requests%ROWTYPE;
  production_create_authorized boolean;
  production_void_authorized boolean;
  sandbox_void_authorized boolean;
  diagnostic_row jsonb;
BEGIN
  diagnostic_row := to_jsonb(NEW);
  SELECT * INTO evidence
  FROM operations_carrier_rate_requests rate
  WHERE rate.organization_id = NEW.organization_id
    AND rate.id = NEW.rate_request_id;

  IF NOT FOUND
     OR evidence.status <> 'succeeded'
     OR evidence.provider NOT IN ('ups_rest', 'fedex_rest')
     OR evidence.purpose NOT IN (
       'sandbox_rate_test',
       'shipping_account_diagnostic'
     )
     OR evidence.provider <> NEW.provider
     OR evidence.environment <> NEW.environment
     OR evidence.integration_account_id <> NEW.integration_account_id
     OR evidence.carrier_account_id <> NEW.carrier_account_id
     OR (
       evidence.purpose = 'sandbox_rate_test'
       AND evidence.environment <> 'sandbox'
     )
     OR (
       evidence.purpose = 'shipping_account_diagnostic'
       AND evidence.environment <> 'production'
     )
     OR (
       evidence.credential_version <> NEW.credential_version
       AND NOT (
         TG_TABLE_NAME = 'operations_carrier_rate_test_label_attempts'
         AND diagnostic_row->>'action' = 'void'
         AND NEW.environment IN ('sandbox', 'production')
       )
     )
  THEN
    RAISE EXCEPTION
      'Carrier shipping diagnostic must bind exact successful rate evidence';
  END IF;

  IF TG_TABLE_NAME = 'operations_carrier_rate_test_labels'
     AND evidence.request_hash <>
       diagnostic_row->>'rate_request_hash'
  THEN
    RAISE EXCEPTION
      'Carrier shipping diagnostic label must retain the exact rate request hash';
  END IF;

  IF TG_TABLE_NAME = 'operations_carrier_rate_test_label_attempts'
     AND diagnostic_row->>'action' = 'create'
     AND NEW.environment = 'production'
  THEN
    PERFORM 1
      FROM operations_integration_accounts integration
      JOIN operations_carrier_credentials credential
        ON credential.organization_id = integration.organization_id
       AND credential.integration_account_id = integration.id
      JOIN operations_carrier_accounts carrier_account
        ON carrier_account.organization_id = integration.organization_id
       AND carrier_account.integration_account_id = integration.id
      WHERE integration.organization_id = NEW.organization_id
        AND integration.id = NEW.integration_account_id
        AND integration.provider = NEW.provider
        AND integration.environment = 'production'
        AND integration.status = 'active'
        AND integration.configuration->'allowedCapabilities'
          ? 'production_rate'
        AND integration.configuration->'allowedCapabilities'
          ? 'production_label'
        AND credential.credential_version = NEW.credential_version
        AND credential.verification_status = 'verified'
        AND evidence.billing_selection_snapshot->>'credentialFingerprint'
          = credential.credential_fingerprint
        AND carrier_account.id = NEW.carrier_account_id
        AND carrier_account.status = 'active'
        AND carrier_account.allow_sender_billing = true
        AND evidence.billing_selection_snapshot->>'accountNumberFingerprint'
          = carrier_account.account_number_fingerprint
        AND evidence.billing_selection_snapshot->>'registeredAddressFingerprint'
          = carrier_account.registered_address_fingerprint
        AND evidence.billing_selection_snapshot->>'senderName'
          = carrier_account.sender_name
      FOR UPDATE OF integration, credential, carrier_account;
    production_create_authorized := FOUND;

    IF NOT production_create_authorized THEN
      RAISE EXCEPTION
        'LIVE carrier shipping diagnostic create requires current exact production-label authority';
    END IF;
  END IF;

  -- Sandbox labels remain voidable after a verified credential rotation. The
  -- immutable label and rate evidence continue to bind the original account.
  IF TG_TABLE_NAME = 'operations_carrier_rate_test_label_attempts'
     AND diagnostic_row->>'action' = 'void'
     AND NEW.environment = 'sandbox'
  THEN
    SELECT EXISTS (
      SELECT 1
      FROM operations_carrier_rate_test_labels label
      JOIN operations_integration_accounts integration
        ON integration.organization_id = label.organization_id
       AND integration.id = label.integration_account_id
      JOIN operations_carrier_credentials credential
        ON credential.organization_id = integration.organization_id
       AND credential.integration_account_id = integration.id
      JOIN operations_carrier_accounts carrier_account
        ON carrier_account.organization_id = integration.organization_id
       AND carrier_account.integration_account_id = integration.id
       AND carrier_account.id = label.carrier_account_id
      WHERE label.organization_id = NEW.organization_id
        AND label.id = NEW.label_id
        AND label.rate_request_id = NEW.rate_request_id
        AND label.integration_account_id = NEW.integration_account_id
        AND label.carrier_account_id = NEW.carrier_account_id
        AND label.provider = NEW.provider
        AND label.environment = 'sandbox'
        AND label.status = 'created'
        AND label.account_number_fingerprint =
          carrier_account.account_number_fingerprint
        AND integration.provider = NEW.provider
        AND integration.environment = 'sandbox'
        AND integration.status = 'active'
        AND credential.credential_version = NEW.credential_version
        AND credential.verification_status = 'verified'
        AND carrier_account.status = 'active'
        AND carrier_account.allow_sender_billing = true
    ) INTO sandbox_void_authorized;

    IF NOT sandbox_void_authorized THEN
      RAISE EXCEPTION
        'Sandbox carrier shipping diagnostic void requires the current exact credential and original sender account';
    END IF;
  END IF;

  -- A paid production label remains voidable if its current exact production
  -- credential and sender account are still valid.
  IF TG_TABLE_NAME = 'operations_carrier_rate_test_label_attempts'
     AND diagnostic_row->>'action' = 'void'
     AND NEW.environment = 'production'
  THEN
    SELECT EXISTS (
      SELECT 1
      FROM operations_integration_accounts integration
      JOIN operations_carrier_credentials credential
        ON credential.organization_id = integration.organization_id
       AND credential.integration_account_id = integration.id
      JOIN operations_carrier_accounts carrier_account
        ON carrier_account.organization_id = integration.organization_id
       AND carrier_account.integration_account_id = integration.id
      WHERE integration.organization_id = NEW.organization_id
        AND integration.id = NEW.integration_account_id
        AND integration.provider = NEW.provider
        AND integration.environment = 'production'
        AND integration.status = 'active'
        AND credential.credential_version = NEW.credential_version
        AND credential.verification_status = 'verified'
        AND carrier_account.id = NEW.carrier_account_id
        AND carrier_account.status = 'active'
        AND carrier_account.allow_sender_billing = true
    ) INTO production_void_authorized;

    IF NOT production_void_authorized THEN
      RAISE EXCEPTION
        'LIVE carrier shipping diagnostic void requires the current exact production credential and sender account';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- Prepared LIVE diagnostics retain account-scoped leases on the exact
-- integration, credential generation, and sender account. They do not lease
-- or lock the workspace activation row.
--
-- Hold this lock through the lease-function cutover and legacy activation
-- counter reset. INSERT/UPDATE/DELETE on the attempt table takes ROW EXCLUSIVE,
-- which conflicts with SHARE ROW EXCLUSIVE, so no prepared attempt can cross
-- the old/new lease boundary with only part of its authority counters updated.
LOCK TABLE public.operations_carrier_rate_test_label_attempts
  IN SHARE ROW EXCLUSIVE MODE;

CREATE OR REPLACE FUNCTION
  public.maintain_operations_carrier_shipping_diagnostic_authority_lease()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  attempt_row operations_carrier_rate_test_label_attempts%ROWTYPE;
  lease_delta integer := 0;
  prior_internal_flag text;
BEGIN
  attempt_row := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  IF attempt_row.environment <> 'production'
     OR attempt_row.action <> 'create'
  THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' AND NEW.state = 'prepared' THEN
    lease_delta := 1;
  ELSIF TG_OP = 'UPDATE'
        AND OLD.state = 'prepared'
        AND NEW.state <> 'prepared'
  THEN
    lease_delta := -1;
  ELSIF TG_OP = 'DELETE' AND OLD.state = 'prepared' THEN
    lease_delta := -1;
  ELSE
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  prior_internal_flag := current_setting(
    'clawpilot.carrier_shipping_diagnostic_lease_update', true
  );
  PERFORM set_config(
    'clawpilot.carrier_shipping_diagnostic_lease_update', '1', true
  );

  UPDATE operations_integration_accounts
  SET production_shipping_diagnostic_lease_count =
    production_shipping_diagnostic_lease_count + lease_delta
  WHERE organization_id = attempt_row.organization_id
    AND id = attempt_row.integration_account_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'LIVE carrier diagnostic authority lease requires its integration';
  END IF;

  UPDATE operations_carrier_credentials
  SET production_shipping_diagnostic_lease_count =
    production_shipping_diagnostic_lease_count + lease_delta
  WHERE organization_id = attempt_row.organization_id
    AND integration_account_id = attempt_row.integration_account_id
    AND credential_version = attempt_row.credential_version;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'LIVE carrier diagnostic authority lease requires its credential';
  END IF;

  UPDATE operations_carrier_accounts
  SET production_shipping_diagnostic_lease_count =
    production_shipping_diagnostic_lease_count + lease_delta
  WHERE organization_id = attempt_row.organization_id
    AND integration_account_id = attempt_row.integration_account_id
    AND id = attempt_row.carrier_account_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'LIVE carrier diagnostic authority lease requires its sender account';
  END IF;

  PERFORM set_config(
    'clawpilot.carrier_shipping_diagnostic_lease_update',
    COALESCE(prior_internal_flag, ''),
    true
  );
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

-- Account-scoped authority cannot be revoked while its prepared provider
-- outcome remains unresolved. The workspace activation row is intentionally
-- outside this protection contract.
CREATE OR REPLACE FUNCTION
  public.protect_operations_carrier_shipping_diagnostic_authority()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.production_shipping_diagnostic_lease_count IS DISTINCT FROM
       OLD.production_shipping_diagnostic_lease_count
     AND current_setting(
       'clawpilot.carrier_shipping_diagnostic_lease_update', true
     ) IS DISTINCT FROM '1'
  THEN
    RAISE EXCEPTION
      'LIVE carrier diagnostic authority lease counters are system-managed';
  END IF;

  IF TG_TABLE_NAME = 'operations_integration_accounts' THEN
    IF NEW.production_shipping_diagnostic_lease_count > 0
       AND (
         NEW.status <> 'active'
         OR NEW.environment <> 'production'
         OR NEW.provider NOT IN ('ups_rest', 'fedex_rest')
         OR NOT (NEW.configuration->'allowedCapabilities'
           ? 'production_rate')
         OR NOT (NEW.configuration->'allowedCapabilities'
           ? 'production_label')
       )
    THEN
      RAISE EXCEPTION
        'LIVE carrier authority cannot be revoked during a prepared diagnostic';
    END IF;
  ELSIF TG_TABLE_NAME = 'operations_carrier_credentials' THEN
    IF NEW.production_shipping_diagnostic_lease_count > 0
       AND ROW(
         NEW.credential_ciphertext,
         NEW.credential_iv,
         NEW.credential_tag,
         NEW.credential_version,
         NEW.credential_fingerprint,
         NEW.verification_status
       ) IS DISTINCT FROM ROW(
         OLD.credential_ciphertext,
         OLD.credential_iv,
         OLD.credential_tag,
         OLD.credential_version,
         OLD.credential_fingerprint,
         OLD.verification_status
       )
    THEN
      RAISE EXCEPTION
        'LIVE carrier credential cannot change during a prepared diagnostic';
    END IF;
  ELSIF TG_TABLE_NAME = 'operations_carrier_accounts' THEN
    IF NEW.production_shipping_diagnostic_lease_count > 0
       AND ROW(
         NEW.integration_account_id,
         NEW.status,
         NEW.allow_sender_billing,
         NEW.account_number_ciphertext,
         NEW.account_number_iv,
         NEW.account_number_tag,
         NEW.encryption_version,
         NEW.account_number_last_four,
         NEW.account_number_fingerprint,
         NEW.registered_address,
         NEW.registered_address_fingerprint,
         NEW.sender_name
       ) IS DISTINCT FROM ROW(
         OLD.integration_account_id,
         OLD.status,
         OLD.allow_sender_billing,
         OLD.account_number_ciphertext,
         OLD.account_number_iv,
         OLD.account_number_tag,
         OLD.encryption_version,
         OLD.account_number_last_four,
         OLD.account_number_fingerprint,
         OLD.registered_address,
         OLD.registered_address_fingerprint,
         OLD.sender_name
       )
    THEN
      RAISE EXCEPTION
        'LIVE carrier sender account cannot change during a prepared diagnostic';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- No carrier-specific lease is stored on the workspace activation row after
-- this phase. The three account-scoped protection triggers remain installed.
DROP TRIGGER IF EXISTS
  protect_operations_carrier_shipping_diagnostic_activation
  ON public.operations_activation_scopes;

-- Migration 0286 leased prepared LIVE diagnostics against the workspace
-- activation row. The replacement lease function above never touches that
-- row, so every legacy counter must be retired atomically at cutover; otherwise
-- an attempt prepared before 0315 can complete with a permanently stale count.
UPDATE public.operations_activation_scopes
SET production_shipping_diagnostic_lease_count = 0
WHERE production_shipping_diagnostic_lease_count <> 0;

COMMENT ON FUNCTION
  public.validate_operations_carrier_shipping_diagnostic_lineage() IS
  'Validates exact LIVE diagnostic rate, production carrier, credential, sender account, and immutable request authority without consulting the workspace activation profile.';

COMMENT ON FUNCTION
  public.maintain_operations_carrier_shipping_diagnostic_authority_lease() IS
  'Maintains prepared LIVE diagnostic leases only on the exact integration, credential generation, and sender carrier account.';

COMMENT ON FUNCTION
  public.protect_operations_carrier_shipping_diagnostic_authority() IS
  'Protects exact production carrier, credential, and sender-account authority while a LIVE diagnostic provider outcome remains prepared.';
