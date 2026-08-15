-- Shopify CarrierService rating can retain paired direct-parcel account sets:
-- up to eight sandbox/TEST accounts for Shadow and up to eight production/LIVE
-- accounts for Active. Provider names classify adapters; the exact carrier
-- account is the durable binding and attempt identity. USPS and brokered LTL
-- remain outside this table until they have executable checkout and
-- fulfillment contracts of their own.
-- Keep one canonical readiness predicate so setup, provider registration,
-- callbacks, inventory projection, and downstream checkout consumers agree.

ALTER TABLE operations_shopify_carrier_service_config_carriers
  DROP CONSTRAINT IF EXISTS
    operations_shopify_carrier_service_config_carriers_pkey,
  DROP CONSTRAINT IF EXISTS
    operations_shopify_carrier_service_config_carriers_unique,
  ADD CONSTRAINT
    operations_shopify_carrier_service_config_carriers_pkey
    PRIMARY KEY (organization_id, config_id, carrier_account_id);

ALTER TABLE
  operations_shopify_checkout_rate_receipt_provider_attempts
  DROP CONSTRAINT IF EXISTS
    operations_shopify_checkout_rate_receipt_provider_attempts_pkey,
  DROP CONSTRAINT IF EXISTS
    op_shopify_checkout_provider_attempts_account_unique,
  ADD CONSTRAINT
    operations_shopify_checkout_rate_receipt_provider_attempts_pkey
    PRIMARY KEY (organization_id, receipt_id, carrier_account_id);

-- Preserve the exact selected account through rerating and Shadow fulfillment.
-- Historical rows remain nullable because provider-only evidence was the
-- deployed contract when they were written. New Shopify provider-checkout
-- rows are rejected by the account-lineage triggers below unless the exact
-- account is present from rate choice through shipment group and attempt.
ALTER TABLE operations_pack_rate_runs
  ADD COLUMN IF NOT EXISTS selected_carrier_account_id uuid,
  DROP CONSTRAINT IF EXISTS
    operations_pack_rate_runs_selected_carrier_account_fkey,
  ADD CONSTRAINT operations_pack_rate_runs_selected_carrier_account_fkey
    FOREIGN KEY (organization_id, selected_carrier_account_id)
    REFERENCES operations_carrier_accounts(organization_id, id)
    ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS
    operations_pack_rate_runs_selected_account_unique,
  ADD CONSTRAINT operations_pack_rate_runs_selected_account_unique
    UNIQUE (organization_id, id, selected_carrier_account_id);

ALTER TABLE operations_pack_rate_run_rate_choices
  ADD COLUMN IF NOT EXISTS id uuid DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS carrier_account_id uuid;

UPDATE operations_pack_rate_run_rate_choices
SET id = gen_random_uuid()
WHERE id IS NULL;

ALTER TABLE operations_pack_rate_run_rate_choices
  ALTER COLUMN id SET NOT NULL,
  DROP CONSTRAINT IF EXISTS operations_pack_rate_run_rate_choices_pkey,
  ADD CONSTRAINT operations_pack_rate_run_rate_choices_pkey
    PRIMARY KEY (organization_id, id),
  DROP CONSTRAINT IF EXISTS
    operations_pack_rate_run_rate_choices_account_fkey,
  ADD CONSTRAINT operations_pack_rate_run_rate_choices_account_fkey
    FOREIGN KEY (organization_id, carrier_account_id)
    REFERENCES operations_carrier_accounts(organization_id, id)
    ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS
  operations_pack_rate_choices_account_service_unique
ON operations_pack_rate_run_rate_choices (
  organization_id, run_id, carrier_account_id, provider, service_code
)
WHERE carrier_account_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS
  operations_pack_rate_choices_legacy_service_unique
ON operations_pack_rate_run_rate_choices (
  organization_id, run_id, provider, service_code
)
WHERE carrier_account_id IS NULL;

ALTER TABLE operations_shipment_groups
  ADD COLUMN IF NOT EXISTS selected_carrier_account_id uuid,
  DROP CONSTRAINT IF EXISTS
    operations_shipment_groups_selected_carrier_account_fkey,
  ADD CONSTRAINT
    operations_shipment_groups_selected_carrier_account_fkey
    FOREIGN KEY (organization_id, selected_carrier_account_id)
    REFERENCES operations_carrier_accounts(organization_id, id)
    ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS
    operations_shipment_groups_run_account_fkey,
  ADD CONSTRAINT operations_shipment_groups_run_account_fkey
    FOREIGN KEY (
      organization_id,
      fulfillment_pack_rate_run_id,
      selected_carrier_account_id
    )
    REFERENCES operations_pack_rate_runs(
      organization_id, id, selected_carrier_account_id
    ) ON DELETE RESTRICT;

ALTER TABLE operations_fulfillment_execution_rate_attempts
  DROP CONSTRAINT IF EXISTS
    operations_fulfillment_execution_rate_attempts_pkey,
  DROP CONSTRAINT IF EXISTS
    operations_fulfillment_rate_attempts_account_unique,
  ADD CONSTRAINT operations_fulfillment_execution_rate_attempts_pkey
    PRIMARY KEY (organization_id, execution_id, carrier_account_id);

CREATE OR REPLACE FUNCTION
  validate_operations_shopify_carrier_service_config_child()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  requested_organization_id uuid;
  requested_config_id uuid;
  config_state text;
  config_service_gid text;
  retained_config_row_version bigint;
  registered_write_token text;
  integration_provider text;
  selected_environment text;
  environment_binding_count bigint;
BEGIN
  requested_organization_id := COALESCE(
    NEW.organization_id, OLD.organization_id
  );
  requested_config_id := COALESCE(NEW.config_id, OLD.config_id);
  SELECT config.registration_state, config.service_gid, config.row_version
    INTO config_state, config_service_gid, retained_config_row_version
  FROM operations_shopify_carrier_service_configs config
  WHERE config.organization_id = requested_organization_id
    AND config.id = requested_config_id;
  registered_write_token := current_setting(
    'clawpilot.shopify_carrier_binding_write_token', true
  );
  IF config_state = 'registered'
     AND config_service_gid IS NOT NULL
     AND TG_TABLE_NAME
       = 'operations_shopify_carrier_service_config_carriers'
     AND registered_write_token
       = requested_config_id::text || ':'
         || retained_config_row_version::text
  THEN
    IF EXISTS (
      SELECT 1
      FROM operations_shopify_checkout_rate_receipts receipt
      WHERE receipt.organization_id = requested_organization_id
        AND receipt.config_id = requested_config_id
        AND receipt.config_row_version = retained_config_row_version
        AND receipt.status = 'processing'
        AND receipt.lease_expires_at > now()
    ) THEN
      RAISE EXCEPTION
        'Wait for the active checkout-rate request before changing carrier bindings';
    END IF;
  ELSIF config_state NOT IN ('unconfigured', 'disabled', 'error')
        OR config_service_gid IS NOT NULL THEN
    RAISE EXCEPTION
      'Disable the provider CarrierService before changing callback bindings';
  END IF;

  IF TG_TABLE_NAME
       = 'operations_shopify_carrier_service_config_carriers'
     AND TG_OP <> 'DELETE' THEN
    SELECT integration.provider, integration.environment
      INTO integration_provider, selected_environment
    FROM operations_carrier_accounts carrier_account
    JOIN operations_integration_accounts integration
      ON integration.organization_id = carrier_account.organization_id
     AND integration.id = carrier_account.integration_account_id
    WHERE carrier_account.organization_id = NEW.organization_id
      AND carrier_account.id = NEW.carrier_account_id;
    IF integration_provider IS DISTINCT FROM NEW.carrier_provider
       OR integration_provider NOT IN ('ups_rest', 'fedex_rest')
       OR selected_environment NOT IN ('sandbox', 'production') THEN
      RAISE EXCEPTION
        'Shopify callback carrier binding requires an exact TEST or LIVE direct carrier account';
    END IF;
    IF TG_OP = 'UPDATE' THEN
      SELECT count(*) INTO environment_binding_count
      FROM operations_shopify_carrier_service_config_carriers selected
      JOIN operations_carrier_accounts carrier_account
        ON carrier_account.organization_id = selected.organization_id
       AND carrier_account.id = selected.carrier_account_id
      JOIN operations_integration_accounts integration
        ON integration.organization_id = carrier_account.organization_id
       AND integration.id = carrier_account.integration_account_id
      WHERE selected.organization_id = NEW.organization_id
        AND selected.config_id = NEW.config_id
        AND selected.carrier_account_id <> OLD.carrier_account_id
        AND integration.environment = selected_environment;
    ELSE
      SELECT count(*) INTO environment_binding_count
      FROM operations_shopify_carrier_service_config_carriers selected
      JOIN operations_carrier_accounts carrier_account
        ON carrier_account.organization_id = selected.organization_id
       AND carrier_account.id = selected.carrier_account_id
      JOIN operations_integration_accounts integration
        ON integration.organization_id = carrier_account.organization_id
       AND integration.id = carrier_account.integration_account_id
      WHERE selected.organization_id = NEW.organization_id
        AND selected.config_id = NEW.config_id
        AND integration.environment = selected_environment;
    END IF;
    IF environment_binding_count >= 8 THEN
      RAISE EXCEPTION
        'Shopify callback supports at most eight carrier accounts per environment';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION
  validate_operations_shopify_carrier_service_config_child() IS
  'Allows up to eight exact sandbox and eight exact production direct-carrier bindings. Registered carrier-only replacement requires an exact transaction-local config row-version token and no live checkout receipt; other child edits remain disabled-only.';

-- Railway applies migrations before replacing every running app instance. The
-- pre-0285 writer therefore remains valid during that rolling window even
-- though it cannot name the newly added exact-account columns. Derive only
-- from immutable checkout evidence or a single activation-applicable config
-- binding; never choose the first of multiple same-provider accounts.
CREATE OR REPLACE FUNCTION
  operations_legacy_shopify_receipt_offer_carrier_account_id(
    requested_organization_id uuid,
    requested_receipt_global_id text,
    requested_provider text,
    requested_service_code text,
    requested_service_name text,
    requested_carrier_cost_minor bigint,
    requested_currency text
  )
RETURNS uuid
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  candidate_ids uuid[];
BEGIN
  SELECT array_agg(
           DISTINCT offer.carrier_account_id
           ORDER BY offer.carrier_account_id
         )
    INTO candidate_ids
  FROM operations_shopify_checkout_rate_receipts receipt
  JOIN operations_shopify_checkout_rate_receipt_offers offer
    ON offer.organization_id = receipt.organization_id
   AND offer.receipt_id = receipt.id
  WHERE receipt.organization_id = requested_organization_id
    AND receipt.global_id = requested_receipt_global_id
    AND receipt.status = 'succeeded'
    AND offer.carrier_provider = requested_provider
    AND offer.service_code = requested_service_code
    AND offer.service_name = requested_service_name
    AND offer.carrier_cost_minor = requested_carrier_cost_minor
    AND offer.currency = requested_currency;

  IF COALESCE(cardinality(candidate_ids), 0) > 1 THEN
    RAISE EXCEPTION
      'Legacy Shopify checkout rate lineage is ambiguous across carrier accounts';
  END IF;
  RETURN candidate_ids[1];
END;
$$;

COMMENT ON FUNCTION
  operations_legacy_shopify_receipt_offer_carrier_account_id(
    uuid, text, text, text, text, bigint, text
  ) IS
  'Rolling-deploy bridge: returns the one exact carrier account proven by a succeeded Shopify receipt offer, raises on multiple candidates, and never guesses.';

CREATE OR REPLACE FUNCTION
  operations_legacy_shopify_config_carrier_account_id(
    requested_organization_id uuid,
    requested_receipt_global_id text,
    requested_provider text
  )
RETURNS uuid
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  candidate_ids uuid[];
BEGIN
  SELECT array_agg(
           DISTINCT configured.carrier_account_id
           ORDER BY configured.carrier_account_id
         )
    INTO candidate_ids
  FROM operations_shopify_checkout_rate_receipts receipt
  JOIN operations_shopify_carrier_service_config_carriers configured
    ON configured.organization_id = receipt.organization_id
   AND configured.config_id = receipt.config_id
  JOIN operations_carrier_accounts carrier_account
    ON carrier_account.organization_id = configured.organization_id
   AND carrier_account.id = configured.carrier_account_id
  JOIN operations_integration_accounts integration
    ON integration.organization_id = carrier_account.organization_id
   AND integration.id = carrier_account.integration_account_id
  WHERE receipt.organization_id = requested_organization_id
    AND receipt.global_id = requested_receipt_global_id
    AND configured.carrier_provider = requested_provider
    AND integration.provider = requested_provider
    AND integration.environment = CASE receipt.activation_state
      WHEN 'shadow' THEN 'sandbox'
      WHEN 'active' THEN 'production'
      ELSE NULL
    END;

  IF COALESCE(cardinality(candidate_ids), 0) > 1 THEN
    RAISE EXCEPTION
      'Legacy Shopify configured carrier lineage is ambiguous across accounts';
  END IF;
  RETURN candidate_ids[1];
END;
$$;

COMMENT ON FUNCTION
  operations_legacy_shopify_config_carrier_account_id(
    uuid, text, text
  ) IS
  'Rolling-deploy bridge: returns the one exact TEST account for a Shadow receipt or LIVE account for an Active receipt and provider, raises on multiple candidates, and never crosses environments.';

CREATE OR REPLACE FUNCTION
  operations_legacy_shopify_fulfillment_attempt_carrier_account_id(
    requested_organization_id uuid,
    requested_fulfillment_run_id uuid,
    requested_provider text,
    requested_selected_only boolean
  )
RETURNS uuid
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  candidate_ids uuid[];
BEGIN
  SELECT array_agg(
           DISTINCT attempt.carrier_account_id
           ORDER BY attempt.carrier_account_id
         )
    INTO candidate_ids
  FROM operations_fulfillment_executions execution
  JOIN operations_fulfillment_execution_rate_attempts attempt
    ON attempt.organization_id = execution.organization_id
   AND attempt.execution_id = execution.id
   AND attempt.fulfillment_pack_rate_run_id
     = execution.fulfillment_pack_rate_run_id
  WHERE execution.organization_id = requested_organization_id
    AND execution.fulfillment_pack_rate_run_id
      = requested_fulfillment_run_id
    AND attempt.carrier_provider = requested_provider
    AND attempt.attempt_status = 'succeeded'
    AND (
      NOT requested_selected_only
      OR attempt.selected
    );

  IF COALESCE(cardinality(candidate_ids), 0) > 1 THEN
    RAISE EXCEPTION
      'Historical Shopify fulfillment evidence is ambiguous across carrier accounts';
  END IF;
  RETURN candidate_ids[1];
END;
$$;

COMMENT ON FUNCTION
  operations_legacy_shopify_fulfillment_attempt_carrier_account_id(
    uuid, uuid, text, boolean
  ) IS
  'Historical backfill helper: derives exact carrier-account lineage only from the immutable fulfillment execution attempt that used the run; it never relabels history from current configuration.';

-- Backfill the same uniquely provable lineage for pre-0285 immutable rows.
-- These updates are the only migration-authorized mutation of the append-only
-- evidence tables. A missing source stays nullable for historical inspection;
-- multiple candidates raise rather than silently relabeling an account.
ALTER TABLE operations_pack_rate_runs
  DISABLE TRIGGER protect_operations_pack_rate_runs_mutation;

UPDATE operations_pack_rate_runs run
SET selected_carrier_account_id = CASE run.purpose
  WHEN 'checkout_quote' THEN
    operations_legacy_shopify_receipt_offer_carrier_account_id(
      run.organization_id,
      run.source_reference,
      run.selected_provider,
      run.selected_service_code,
      run.selected_service_name,
      run.selected_carrier_cost_minor,
      run.currency
    )
  WHEN 'fulfillment_execution' THEN
    operations_legacy_shopify_fulfillment_attempt_carrier_account_id(
      run.organization_id,
      run.id,
      run.selected_provider,
      true
    )
  ELSE NULL
END
WHERE run.selected_carrier_account_id IS NULL
  AND run.status = 'succeeded'
  AND run.provider = 'shopify'
  AND run.source_kind = 'provider_checkout';

ALTER TABLE operations_pack_rate_runs
  ENABLE TRIGGER protect_operations_pack_rate_runs_mutation;

ALTER TABLE operations_pack_rate_run_rate_choices
  DISABLE TRIGGER protect_operations_pack_rate_choices_mutation;

UPDATE operations_pack_rate_run_rate_choices choice
SET carrier_account_id = CASE
  WHEN run.purpose = 'checkout_quote' THEN
    operations_legacy_shopify_receipt_offer_carrier_account_id(
      choice.organization_id,
      run.source_reference,
      choice.provider,
      choice.service_code,
      choice.service_name,
      choice.carrier_cost_minor,
      choice.currency
    )
  WHEN run.purpose = 'fulfillment_execution' AND choice.selected THEN
    run.selected_carrier_account_id
  WHEN run.purpose = 'fulfillment_execution' THEN
    operations_legacy_shopify_fulfillment_attempt_carrier_account_id(
      choice.organization_id,
      run.id,
      choice.provider,
      false
    )
  ELSE NULL
END
FROM operations_pack_rate_runs run
WHERE choice.organization_id = run.organization_id
  AND choice.run_id = run.id
  AND choice.carrier_account_id IS NULL
  AND run.status = 'succeeded'
  AND run.provider = 'shopify'
  AND run.source_kind = 'provider_checkout';

ALTER TABLE operations_pack_rate_run_rate_choices
  ENABLE TRIGGER protect_operations_pack_rate_choices_mutation;

ALTER TABLE operations_shipment_groups
  DISABLE TRIGGER protect_operations_shipment_group_mutation;
ALTER TABLE operations_shipment_groups
  DISABLE TRIGGER validate_operations_fulfillment_group_deferred;

UPDATE operations_shipment_groups shipment_group
SET selected_carrier_account_id = run.selected_carrier_account_id
FROM operations_pack_rate_runs run
WHERE shipment_group.organization_id = run.organization_id
  AND shipment_group.fulfillment_pack_rate_run_id = run.id
  AND shipment_group.selected_carrier_account_id IS NULL
  AND run.selected_carrier_account_id IS NOT NULL
  AND run.selected_provider = shipment_group.selected_provider;

ALTER TABLE operations_shipment_groups
  ENABLE TRIGGER validate_operations_fulfillment_group_deferred;
ALTER TABLE operations_shipment_groups
  ENABLE TRIGGER protect_operations_shipment_group_mutation;

CREATE OR REPLACE FUNCTION
  derive_operations_legacy_pack_rate_run_account()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.selected_carrier_account_id IS NULL
     AND NEW.status = 'succeeded'
     AND NEW.provider = 'shopify'
     AND NEW.source_kind = 'provider_checkout' THEN
    IF NEW.purpose = 'checkout_quote' THEN
      NEW.selected_carrier_account_id :=
        operations_legacy_shopify_receipt_offer_carrier_account_id(
          NEW.organization_id,
          NEW.source_reference,
          NEW.selected_provider,
          NEW.selected_service_code,
          NEW.selected_service_name,
          NEW.selected_carrier_cost_minor,
          NEW.currency
        );
    ELSIF NEW.purpose = 'fulfillment_execution' THEN
      NEW.selected_carrier_account_id :=
        operations_legacy_shopify_config_carrier_account_id(
          NEW.organization_id,
          NEW.source_reference,
          NEW.selected_provider
        );
    END IF;

    IF NEW.selected_carrier_account_id IS NULL THEN
      RAISE EXCEPTION
        'Legacy Shopify pack-and-rate run cannot prove one exact carrier account';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  a_derive_operations_legacy_pack_rate_run_account
  ON operations_pack_rate_runs;
CREATE TRIGGER a_derive_operations_legacy_pack_rate_run_account
BEFORE INSERT OR UPDATE
ON operations_pack_rate_runs
FOR EACH ROW EXECUTE FUNCTION
  derive_operations_legacy_pack_rate_run_account();

CREATE OR REPLACE FUNCTION
  derive_operations_legacy_pack_rate_choice_account()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  run_row operations_pack_rate_runs%ROWTYPE;
BEGIN
  IF NEW.carrier_account_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO run_row
  FROM operations_pack_rate_runs run
  WHERE run.organization_id = NEW.organization_id
    AND run.id = NEW.run_id;
  IF run_row.provider <> 'shopify'
     OR run_row.source_kind <> 'provider_checkout'
     OR run_row.status <> 'succeeded' THEN
    RETURN NEW;
  END IF;

  IF run_row.purpose = 'checkout_quote' THEN
    NEW.carrier_account_id :=
      operations_legacy_shopify_receipt_offer_carrier_account_id(
        NEW.organization_id,
        run_row.source_reference,
        NEW.provider,
        NEW.service_code,
        NEW.service_name,
        NEW.carrier_cost_minor,
        NEW.currency
      );
  ELSIF run_row.purpose = 'fulfillment_execution'
        AND NEW.selected THEN
    NEW.carrier_account_id := run_row.selected_carrier_account_id;
  ELSIF run_row.purpose = 'fulfillment_execution' THEN
    NEW.carrier_account_id :=
      operations_legacy_shopify_config_carrier_account_id(
        NEW.organization_id,
        run_row.source_reference,
        NEW.provider
      );
  END IF;

  IF NEW.carrier_account_id IS NULL THEN
    RAISE EXCEPTION
      'Legacy Shopify pack-and-rate choice cannot prove one exact carrier account';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  a_derive_operations_legacy_pack_rate_choice_account
  ON operations_pack_rate_run_rate_choices;
CREATE TRIGGER a_derive_operations_legacy_pack_rate_choice_account
BEFORE INSERT OR UPDATE
ON operations_pack_rate_run_rate_choices
FOR EACH ROW EXECUTE FUNCTION
  derive_operations_legacy_pack_rate_choice_account();

CREATE OR REPLACE FUNCTION
  derive_operations_legacy_shipment_group_account()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.selected_carrier_account_id IS NULL THEN
    SELECT run.selected_carrier_account_id
      INTO NEW.selected_carrier_account_id
    FROM operations_pack_rate_runs run
    WHERE run.organization_id = NEW.organization_id
      AND run.id = NEW.fulfillment_pack_rate_run_id
      AND run.selected_provider = NEW.selected_provider;
    IF NEW.selected_carrier_account_id IS NULL THEN
      RAISE EXCEPTION
        'Legacy shipment group cannot prove its run selected carrier account';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  a_derive_operations_legacy_shipment_group_account
  ON operations_shipment_groups;
CREATE TRIGGER a_derive_operations_legacy_shipment_group_account
BEFORE INSERT OR UPDATE
ON operations_shipment_groups
FOR EACH ROW EXECUTE FUNCTION
  derive_operations_legacy_shipment_group_account();

CREATE OR REPLACE FUNCTION
  validate_operations_pack_rate_choice_account()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  run_row operations_pack_rate_runs%ROWTYPE;
  account_provider text;
BEGIN
  SELECT * INTO run_row
  FROM operations_pack_rate_runs run
  WHERE run.organization_id = NEW.organization_id
    AND run.id = NEW.run_id;
  IF run_row.id IS NULL THEN
    RAISE EXCEPTION 'Pack-and-rate choice requires its parent run';
  END IF;

  IF run_row.provider = 'shopify'
     AND run_row.source_kind = 'provider_checkout'
     AND NEW.carrier_account_id IS NULL THEN
    RAISE EXCEPTION
      'Shopify provider-checkout rate choice requires an exact carrier account';
  END IF;

  IF NEW.carrier_account_id IS NOT NULL THEN
    SELECT integration.provider INTO account_provider
    FROM operations_carrier_accounts carrier_account
    JOIN operations_integration_accounts integration
      ON integration.organization_id = carrier_account.organization_id
     AND integration.id = carrier_account.integration_account_id
    WHERE carrier_account.organization_id = NEW.organization_id
      AND carrier_account.id = NEW.carrier_account_id;
    IF account_provider IS DISTINCT FROM NEW.provider THEN
      RAISE EXCEPTION
        'Pack-and-rate choice carrier account does not match its provider';
    END IF;
  END IF;

  IF NEW.selected
     AND run_row.selected_carrier_account_id
       IS DISTINCT FROM NEW.carrier_account_id THEN
    RAISE EXCEPTION
      'Selected pack-and-rate choice must use the run selected carrier account';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  validate_operations_pack_rate_choice_account_write
  ON operations_pack_rate_run_rate_choices;
CREATE TRIGGER validate_operations_pack_rate_choice_account_write
BEFORE INSERT OR UPDATE
ON operations_pack_rate_run_rate_choices
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_pack_rate_choice_account();

CREATE OR REPLACE FUNCTION
  validate_operations_shipment_group_account()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  account_provider text;
  run_selected_account_id uuid;
BEGIN
  IF NEW.selected_carrier_account_id IS NULL THEN
    RAISE EXCEPTION
      'Shipment group requires the exact selected carrier account';
  END IF;
  SELECT run.selected_carrier_account_id
    INTO run_selected_account_id
  FROM operations_pack_rate_runs run
  WHERE run.organization_id = NEW.organization_id
    AND run.id = NEW.fulfillment_pack_rate_run_id;
  SELECT integration.provider INTO account_provider
  FROM operations_carrier_accounts carrier_account
  JOIN operations_integration_accounts integration
    ON integration.organization_id = carrier_account.organization_id
   AND integration.id = carrier_account.integration_account_id
  WHERE carrier_account.organization_id = NEW.organization_id
    AND carrier_account.id = NEW.selected_carrier_account_id;
  IF run_selected_account_id
       IS DISTINCT FROM NEW.selected_carrier_account_id
     OR account_provider IS DISTINCT FROM NEW.selected_provider THEN
    RAISE EXCEPTION
      'Shipment group selected carrier account does not match its run and provider';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  validate_operations_shipment_group_account_write
  ON operations_shipment_groups;
CREATE TRIGGER validate_operations_shipment_group_account_write
BEFORE INSERT OR UPDATE
ON operations_shipment_groups
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_shipment_group_account();

CREATE OR REPLACE FUNCTION
  validate_operations_pack_rate_account_lineage_complete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  requested_organization_id uuid;
  requested_run_id uuid;
  run_row operations_pack_rate_runs%ROWTYPE;
  selected_match_count bigint;
  invalid_choice_count bigint;
  source_choice_mismatch_count bigint;
BEGIN
  requested_organization_id := NEW.organization_id;
  requested_run_id := CASE TG_TABLE_NAME
    WHEN 'operations_pack_rate_runs' THEN NEW.id
    ELSE NEW.run_id
  END;
  SELECT * INTO run_row
  FROM operations_pack_rate_runs run
  WHERE run.organization_id = requested_organization_id
    AND run.id = requested_run_id;
  IF run_row.id IS NULL
     OR run_row.status <> 'succeeded'
     OR run_row.provider <> 'shopify'
     OR run_row.source_kind <> 'provider_checkout' THEN
    RETURN NULL;
  END IF;

  SELECT count(*) INTO selected_match_count
  FROM operations_pack_rate_run_rate_choices choice
  WHERE choice.organization_id = run_row.organization_id
    AND choice.run_id = run_row.id
    AND choice.selected
    AND choice.carrier_account_id = run_row.selected_carrier_account_id
    AND choice.provider = run_row.selected_provider
    AND choice.service_code = run_row.selected_service_code
    AND choice.service_name = run_row.selected_service_name
    AND choice.carrier_cost_minor = run_row.selected_carrier_cost_minor
    AND choice.currency = run_row.currency;

  SELECT count(*) INTO invalid_choice_count
  FROM operations_pack_rate_run_rate_choices choice
  LEFT JOIN operations_carrier_accounts carrier_account
    ON carrier_account.organization_id = choice.organization_id
   AND carrier_account.id = choice.carrier_account_id
  LEFT JOIN operations_integration_accounts integration
    ON integration.organization_id = carrier_account.organization_id
   AND integration.id = carrier_account.integration_account_id
  WHERE choice.organization_id = run_row.organization_id
    AND choice.run_id = run_row.id
    AND (
      choice.carrier_account_id IS NULL
      OR integration.provider IS DISTINCT FROM choice.provider
    );

  source_choice_mismatch_count := 0;
  IF run_row.purpose = 'checkout_quote' THEN
    SELECT count(*) INTO source_choice_mismatch_count
    FROM operations_pack_rate_run_rate_choices choice
    LEFT JOIN operations_shopify_checkout_rate_receipts receipt
      ON receipt.organization_id = choice.organization_id
     AND receipt.global_id = run_row.source_reference
     AND receipt.status = 'succeeded'
    LEFT JOIN operations_shopify_checkout_rate_receipt_offers offer
      ON offer.organization_id = receipt.organization_id
     AND offer.receipt_id = receipt.id
     AND offer.carrier_account_id = choice.carrier_account_id
     AND offer.carrier_provider = choice.provider
     AND offer.service_code = choice.service_code
     AND offer.service_name = choice.service_name
     AND offer.carrier_cost_minor = choice.carrier_cost_minor
     AND offer.currency = choice.currency
    WHERE choice.organization_id = run_row.organization_id
      AND choice.run_id = run_row.id
      AND offer.receipt_id IS NULL;
  END IF;

  IF run_row.selected_carrier_account_id IS NULL
     OR selected_match_count <> 1
     OR invalid_choice_count <> 0
     OR source_choice_mismatch_count <> 0 THEN
    RAISE EXCEPTION
      'Shopify pack-and-rate run requires exact carrier-account choice lineage';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS
  validate_operations_pack_rate_account_run_deferred
  ON operations_pack_rate_runs;
CREATE CONSTRAINT TRIGGER
  validate_operations_pack_rate_account_run_deferred
AFTER INSERT ON operations_pack_rate_runs
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_pack_rate_account_lineage_complete();

DROP TRIGGER IF EXISTS
  validate_operations_pack_rate_account_choice_deferred
  ON operations_pack_rate_run_rate_choices;
CREATE CONSTRAINT TRIGGER
  validate_operations_pack_rate_account_choice_deferred
AFTER INSERT ON operations_pack_rate_run_rate_choices
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_pack_rate_account_lineage_complete();

CREATE OR REPLACE FUNCTION
  validate_operations_fulfillment_account_lineage_complete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  requested_organization_id uuid;
  requested_run_id uuid;
  run_row operations_pack_rate_runs%ROWTYPE;
  execution_id uuid;
  selected_attempt_count bigint;
  choice_attempt_mismatch_count bigint;
  degraded_attempt_with_choice_count bigint;
BEGIN
  requested_organization_id := NEW.organization_id;
  requested_run_id := CASE TG_TABLE_NAME
    WHEN 'operations_pack_rate_runs' THEN NEW.id
    WHEN 'operations_pack_rate_run_rate_choices' THEN NEW.run_id
    WHEN 'operations_fulfillment_executions'
      THEN NEW.fulfillment_pack_rate_run_id
    WHEN 'operations_shipment_groups'
      THEN NEW.fulfillment_pack_rate_run_id
    ELSE NEW.fulfillment_pack_rate_run_id
  END;
  SELECT * INTO run_row
  FROM operations_pack_rate_runs run
  WHERE run.organization_id = requested_organization_id
    AND run.id = requested_run_id;
  IF run_row.id IS NULL
     OR run_row.status <> 'succeeded'
     OR run_row.provider <> 'shopify'
     OR run_row.source_kind <> 'provider_checkout'
     OR run_row.purpose <> 'fulfillment_execution' THEN
    RETURN NULL;
  END IF;

  SELECT execution.id INTO execution_id
  FROM operations_fulfillment_executions execution
  WHERE execution.organization_id = run_row.organization_id
    AND execution.fulfillment_pack_rate_run_id = run_row.id;

  SELECT count(*) INTO selected_attempt_count
  FROM operations_fulfillment_execution_rate_attempts attempt
  JOIN operations_shipment_groups shipment_group
    ON shipment_group.organization_id = attempt.organization_id
   AND shipment_group.fulfillment_execution_id = attempt.execution_id
  WHERE attempt.organization_id = run_row.organization_id
    AND attempt.execution_id = execution_id
    AND attempt.selected
    AND attempt.attempt_status = 'succeeded'
    AND attempt.carrier_account_id = run_row.selected_carrier_account_id
    AND attempt.carrier_provider = run_row.selected_provider
    AND shipment_group.selected_carrier_account_id
      = run_row.selected_carrier_account_id;

  SELECT count(*) INTO choice_attempt_mismatch_count
  FROM operations_pack_rate_run_rate_choices choice
  LEFT JOIN operations_fulfillment_execution_rate_attempts attempt
    ON attempt.organization_id = choice.organization_id
   AND attempt.execution_id = execution_id
   AND attempt.carrier_account_id = choice.carrier_account_id
   AND attempt.carrier_provider = choice.provider
   AND attempt.attempt_status = 'succeeded'
  WHERE choice.organization_id = run_row.organization_id
    AND choice.run_id = run_row.id
    AND attempt.carrier_account_id IS NULL;

  SELECT count(*) INTO degraded_attempt_with_choice_count
  FROM operations_fulfillment_execution_rate_attempts attempt
  WHERE attempt.organization_id = run_row.organization_id
    AND attempt.execution_id = execution_id
    AND attempt.attempt_status = 'degraded'
    AND EXISTS (
      SELECT 1
      FROM operations_pack_rate_run_rate_choices choice
      WHERE choice.organization_id = attempt.organization_id
        AND choice.run_id = attempt.fulfillment_pack_rate_run_id
        AND choice.carrier_account_id = attempt.carrier_account_id
        AND choice.provider = attempt.carrier_provider
    );

  IF execution_id IS NULL
     OR selected_attempt_count <> 1
     OR choice_attempt_mismatch_count <> 0
     OR degraded_attempt_with_choice_count <> 0 THEN
    RAISE EXCEPTION
      'Fulfillment execution requires exact carrier-account choice, group, and attempt lineage';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS
  validate_operations_fulfillment_account_execution_deferred
  ON operations_fulfillment_executions;
CREATE CONSTRAINT TRIGGER
  validate_operations_fulfillment_account_execution_deferred
AFTER INSERT ON operations_fulfillment_executions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_fulfillment_account_lineage_complete();

DROP TRIGGER IF EXISTS
  validate_operations_fulfillment_account_group_deferred
  ON operations_shipment_groups;
CREATE CONSTRAINT TRIGGER
  validate_operations_fulfillment_account_group_deferred
AFTER INSERT ON operations_shipment_groups
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_fulfillment_account_lineage_complete();

DROP TRIGGER IF EXISTS
  validate_operations_fulfillment_account_attempt_deferred
  ON operations_fulfillment_execution_rate_attempts;
CREATE CONSTRAINT TRIGGER
  validate_operations_fulfillment_account_attempt_deferred
AFTER INSERT ON operations_fulfillment_execution_rate_attempts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_fulfillment_account_lineage_complete();

DROP TRIGGER IF EXISTS
  validate_operations_fulfillment_account_choice_deferred
  ON operations_pack_rate_run_rate_choices;
CREATE CONSTRAINT TRIGGER
  validate_operations_fulfillment_account_choice_deferred
AFTER INSERT ON operations_pack_rate_run_rate_choices
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_fulfillment_account_lineage_complete();

-- Migration 0177 compared the checkout receipt's attempts with every carrier
-- binding because only one environment existed at the time. Paired TEST/LIVE
-- bindings must compare only the set applicable to that receipt activation.
DO $$
DECLARE
  function_definition text;
  prior_definition text;
BEGIN
  SELECT pg_get_functiondef(
    'validate_operations_pack_rate_run_complete()'::regprocedure
  ) INTO function_definition;

  prior_definition := function_definition;
  function_definition := replace(
    function_definition,
    'FROM operations_shopify_carrier_service_config_carriers
                 configured
               WHERE configured.organization_id = receipt.organization_id
                 AND configured.config_id = receipt.config_id',
    'FROM operations_shopify_carrier_service_config_carriers
                 configured
               JOIN operations_carrier_accounts configured_carrier_account
                 ON configured_carrier_account.organization_id
                   = configured.organization_id
                AND configured_carrier_account.id
                   = configured.carrier_account_id
               JOIN operations_integration_accounts configured_integration
                 ON configured_integration.organization_id
                   = configured_carrier_account.organization_id
                AND configured_integration.id
                   = configured_carrier_account.integration_account_id
               WHERE configured.organization_id = receipt.organization_id
                 AND configured.config_id = receipt.config_id
                 AND configured_integration.environment =
                   CASE receipt.activation_state
                     WHEN ''shadow'' THEN ''sandbox''
                     WHEN ''active'' THEN ''production''
                     ELSE ''__invalid__''
                   END'
  );
  IF function_definition = prior_definition THEN
    RAISE EXCEPTION
      'Unable to scope Shopify checkout run attempts to its activation environment';
  END IF;

  EXECUTE function_definition;
END;
$$;

-- Migration 0177's otherwise-current fulfillment validator compared rate
-- attempts and choices by provider because that schema allowed only one
-- account per provider. Preserve the full validator and surgically strengthen
-- those joins to the new exact-account columns instead of replacing its other
-- carton, inventory, receipt, and execution integrity checks.
DO $$
DECLARE
  function_definition text;
  prior_definition text;
BEGIN
  SELECT pg_get_functiondef(
    'validate_operations_fulfillment_execution()'::regprocedure
  ) INTO function_definition;

  prior_definition := function_definition;
  function_definition := replace(
    function_definition,
    'OR attempt.carrier_provider = run.selected_provider',
    'OR (
        attempt.carrier_provider = run.selected_provider
        AND attempt.carrier_account_id
          = run.selected_carrier_account_id
      )'
  );
  IF function_definition = prior_definition THEN
    RAISE EXCEPTION
      'Unable to strengthen selected fulfillment attempt account identity';
  END IF;

  prior_definition := function_definition;
  function_definition := replace(
    function_definition,
    'AND attempt.carrier_provider = run.selected_provider',
    'AND attempt.carrier_provider = run.selected_provider
    AND attempt.carrier_account_id = run.selected_carrier_account_id'
  );
  IF function_definition = prior_definition THEN
    RAISE EXCEPTION
      'Unable to strengthen selected fulfillment evidence account identity';
  END IF;

  prior_definition := function_definition;
  function_definition := replace(
    function_definition,
    'AND choice.provider = attempt.carrier_provider',
    'AND choice.provider = attempt.carrier_provider
   AND choice.carrier_account_id = attempt.carrier_account_id'
  );
  IF function_definition = prior_definition THEN
    RAISE EXCEPTION
      'Unable to strengthen fulfillment choice-to-attempt account identity';
  END IF;

  prior_definition := function_definition;
  function_definition := replace(
    function_definition,
    'AND attempt.carrier_provider = choice.provider',
    'AND attempt.carrier_provider = choice.provider
        AND attempt.carrier_account_id = choice.carrier_account_id'
  );
  IF function_definition = prior_definition THEN
    RAISE EXCEPTION
      'Unable to strengthen fulfillment attempt-to-choice account identity';
  END IF;

  prior_definition := function_definition;
  function_definition := replace(
    function_definition,
    'AND configured.config_id = receipt.config_id
        WHERE receipt.organization_id = execution.organization_id',
    'AND configured.config_id = receipt.config_id
        JOIN operations_carrier_accounts configured_carrier_account
          ON configured_carrier_account.organization_id
            = configured.organization_id
         AND configured_carrier_account.id
            = configured.carrier_account_id
        JOIN operations_integration_accounts configured_integration
          ON configured_integration.organization_id
            = configured_carrier_account.organization_id
         AND configured_integration.id
            = configured_carrier_account.integration_account_id
        WHERE receipt.organization_id = execution.organization_id
          AND configured_integration.environment = ''sandbox'''
  );
  IF function_definition = prior_definition THEN
    RAISE EXCEPTION
      'Unable to scope Shopify fulfillment attempts to TEST bindings';
  END IF;

  EXECUTE function_definition;
END;
$$;

CREATE OR REPLACE FUNCTION
  operations_shopify_carrier_configuration_allows_rating(
    configuration jsonb,
    requested_environment text
  )
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE requested_environment
    WHEN 'sandbox' THEN CASE
      WHEN (
        configuration ->> 'managedBy'
          = 'ag-alchemy-episcs-sandbox-rating-delegation'
        OR (
          configuration ->> 'authorizationScope' IN (
            'sandbox_rating_only',
            'sandbox_fulfillment_diagnostic'
          )
          AND configuration -> 'credentialRevealAllowed' = 'false'::jsonb
        )
      ) THEN (
        configuration ->> 'managedBy'
          = 'ag-alchemy-episcs-sandbox-rating-delegation'
        AND configuration -> 'credentialRevealAllowed' = 'false'::jsonb
        AND configuration ->> 'senderOriginWarehouseGlobalId'
          = 'gwh5366613'
        AND (
          (
            configuration ->> 'authorizationScope'
              = 'sandbox_rating_only'
            AND configuration -> 'allowedCapabilities'
              = '["sandbox_rate"]'::jsonb
          )
          OR (
            configuration ->> 'authorizationScope'
              = 'sandbox_fulfillment_diagnostic'
            AND configuration -> 'allowedCapabilities'
              = '["sandbox_rate","sandbox_label"]'::jsonb
          )
        )
      )
      ELSE (
        jsonb_typeof(configuration -> 'allowedCapabilities')
          IS DISTINCT FROM 'array'
        OR configuration -> 'allowedCapabilities' ? 'sandbox_rate'
      )
    END
    WHEN 'production' THEN (
      NOT COALESCE((
        configuration ->> 'managedBy'
          = 'ag-alchemy-episcs-sandbox-rating-delegation'
        OR (
          configuration ->> 'authorizationScope' IN (
            'sandbox_rating_only',
            'sandbox_fulfillment_diagnostic'
          )
          AND configuration -> 'credentialRevealAllowed' = 'false'::jsonb
        )
      ), false)
      AND jsonb_typeof(configuration -> 'allowedCapabilities') = 'array'
      AND configuration -> 'allowedCapabilities' ? 'production_rate'
    )
    ELSE false
  END;
$$;

COMMENT ON FUNCTION
  operations_shopify_carrier_configuration_allows_rating(jsonb, text) IS
  'Matches direct-carrier runtime capability semantics: legacy non-managed TEST connections without an array remain rating-capable, managed delegation must be exact, and LIVE production_rate is always explicit.';

CREATE OR REPLACE FUNCTION
  operations_shopify_carrier_service_config_environment_is_ready(
    requested_organization_id uuid,
    requested_config_id uuid,
    requested_environment text
  )
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM operations_shopify_carrier_service_configs config
    JOIN operations_integration_accounts account
      ON account.organization_id = config.organization_id
     AND account.id = config.integration_account_id
    JOIN operations_commerce_credentials credential
      ON credential.organization_id = account.organization_id
     AND credential.integration_account_id = account.id
    JOIN operations_activation_scopes activation
      ON activation.organization_id = config.organization_id
    JOIN operations_warehouses warehouse
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
        FROM operations_shopify_carrier_service_config_materials selected
        JOIN operations_packaging_materials material
          ON material.organization_id = selected.organization_id
         AND material.id = selected.packaging_material_id
        JOIN operations_packaging_material_stock stock
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
            'customer_confirmed', 'measured', 'provider', 'legacy'
          )
          AND length(
            btrim(material.rated_outer_dimension_evidence_reference)
          ) BETWEEN 1 AND 500
          AND material.rated_outer_dimension_confirmed_at IS NOT NULL
          AND stock.is_available = true
          AND stock.on_hand_quantity > 0
      ) = (
        SELECT count(*)
        FROM operations_shopify_carrier_service_config_materials selected
        WHERE selected.organization_id = config.organization_id
          AND selected.config_id = config.id
      )
      AND (
        SELECT count(*)
        FROM operations_shopify_carrier_service_config_materials selected
        WHERE selected.organization_id = config.organization_id
          AND selected.config_id = config.id
      ) BETWEEN 1 AND 8
      AND (
        SELECT count(*)
        FROM operations_shopify_carrier_service_config_carriers selected
        JOIN operations_carrier_accounts carrier_account
          ON carrier_account.organization_id = selected.organization_id
         AND carrier_account.id = selected.carrier_account_id
        JOIN operations_integration_accounts carrier_integration
          ON carrier_integration.organization_id
            = carrier_account.organization_id
         AND carrier_integration.id
            = carrier_account.integration_account_id
        JOIN operations_carrier_credentials carrier_credential
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
          AND operations_shopify_carrier_configuration_allows_rating(
            carrier_integration.configuration,
            requested_environment
          )
          AND carrier_credential.verification_status = 'verified'
      ) = (
        SELECT count(*)
        FROM operations_shopify_carrier_service_config_carriers selected
        JOIN operations_carrier_accounts carrier_account
          ON carrier_account.organization_id = selected.organization_id
         AND carrier_account.id = selected.carrier_account_id
        JOIN operations_integration_accounts carrier_integration
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
        FROM operations_shopify_carrier_service_config_carriers selected
        JOIN operations_carrier_accounts carrier_account
          ON carrier_account.organization_id = selected.organization_id
         AND carrier_account.id = selected.carrier_account_id
        JOIN operations_integration_accounts carrier_integration
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
        FROM operations_shopify_carrier_service_config_carriers selected
        WHERE selected.organization_id = config.organization_id
          AND selected.config_id = config.id
      ) BETWEEN 1 AND 16
  )
$$;

COMMENT ON FUNCTION
  operations_shopify_carrier_service_config_environment_is_ready(
    uuid, uuid, text
  ) IS
  'Returns true only when the sandbox Shopify store, exact activation revision, warehouse, current packaging stock, and one through eight selected unique verified direct UPS/FedEx accounts with matching warehouse origins and the requested TEST or LIVE rating capability are ready. The opposite environment set may coexist and does not affect this predicate.';

CREATE OR REPLACE FUNCTION
  operations_shopify_carrier_service_config_is_ready(
    requested_organization_id uuid,
    requested_config_id uuid
  )
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE((
    SELECT CASE
      WHEN activation.state = 'shadow'
           AND config.registration_state IN (
             'shadow_simulated', 'registered'
           )
      THEN operations_shopify_carrier_service_config_environment_is_ready(
        config.organization_id, config.id, 'sandbox'
      )
      WHEN activation.state = 'active'
           AND config.registration_state = 'registered'
      THEN operations_shopify_carrier_service_config_environment_is_ready(
        config.organization_id, config.id, 'production'
      )
      ELSE false
    END
    FROM operations_shopify_carrier_service_configs config
    JOIN operations_activation_scopes activation
      ON activation.organization_id = config.organization_id
    WHERE config.organization_id = requested_organization_id
      AND config.id = requested_config_id
  ), false)
$$;

COMMENT ON FUNCTION
  operations_shopify_carrier_service_config_is_ready(uuid, uuid) IS
  'Current-state callback readiness selects only sandbox/TEST bindings in Shadow and only production/LIVE bindings in Active; paired opposite-environment bindings remain stored without mixed execution.';

-- The direct carrier foundation retains provider package codes in its
-- canonical parcel evidence. Checkout receipt packages intentionally remain
-- provider-neutral. Remove only that provider selector before exact ordered
-- comparison; dimensions, weight, units, description, order, and any unknown
-- fields must still match byte-for-byte as jsonb.
CREATE OR REPLACE FUNCTION
  operations_shopify_checkout_carrier_parcels_match(
    requested_organization_id uuid,
    requested_receipt_id uuid,
    provider_parcels jsonb
  )
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    jsonb_typeof(provider_parcels) = 'array'
    AND (
      SELECT jsonb_agg(
        provider_parcel.value - 'packageCode'
        ORDER BY provider_parcel.ordinality
      )
      FROM jsonb_array_elements(provider_parcels)
        WITH ORDINALITY provider_parcel(value, ordinality)
    ) = (
      SELECT jsonb_agg(
        operations_shopify_checkout_carrier_request_parcel_snapshot(
          package.planning_method,
          package.package_sequence,
          package.rated_outer_length_mm,
          package.rated_outer_width_mm,
          package.rated_outer_height_mm,
          package.gross_weight_grams
        )
        ORDER BY package.package_sequence, package.package_key
      )
      FROM operations_shopify_checkout_rate_receipt_packages package
      WHERE package.organization_id = requested_organization_id
        AND package.receipt_id = requested_receipt_id
    ),
    false
  );
$$;

COMMENT ON FUNCTION
  operations_shopify_checkout_carrier_parcels_match(uuid, uuid, jsonb) IS
  'Compares ordered direct-carrier whole-shipment parcel evidence with neutral Shopify receipt parcels after stripping only provider packageCode.';

CREATE OR REPLACE FUNCTION
  operations_shopify_checkout_carrier_selection_key(
    requested_receipt_global_id text,
    requested_carrier_account_global_id text
  )
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT encode(
    digest(
      'shopify-checkout-carrier-selection-v1|'
        || requested_receipt_global_id || '|'
        || requested_carrier_account_global_id,
      'sha256'
    ),
    'hex'
  );
$$;

COMMENT ON FUNCTION
  operations_shopify_checkout_carrier_selection_key(text, text) IS
  'Immutable receipt-and-account identity for checkout carrier rate evidence; prevents otherwise-identical concurrent receipts from cross-linking a 30-second rate request.';

-- Old application instances in the migration rolling window do not yet send
-- carrier_selection_key. Provider evidence is written before the receipt's
-- package children, so bind only when the exact account, applicable
-- environment, destination, and time window name one processing receipt.
-- Offers and attempts are written after package children and retain the exact
-- parcel/count guards below. Two otherwise-identical concurrent receipts are
-- deliberately rejected instead of allowing cross-receipt evidence reuse.
CREATE OR REPLACE FUNCTION
  derive_operations_legacy_shopify_carrier_selection_key()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  candidate_receipt_global_ids text[];
  carrier_account_global_id text;
BEGIN
  IF NEW.carrier_selection_key IS NOT NULL
     OR NEW.actor_email IS NOT NULL
     OR NEW.purpose <> 'cartonization_shipment_rate'
     OR NEW.provider NOT IN ('ups_rest', 'fedex_rest')
     OR NEW.carrier_account_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT
    array_agg(DISTINCT receipt.global_id ORDER BY receipt.global_id),
    max(carrier_account.global_id)
    INTO candidate_receipt_global_ids, carrier_account_global_id
  FROM operations_shopify_checkout_rate_receipts receipt
  JOIN operations_shopify_carrier_service_config_carriers configured
    ON configured.organization_id = receipt.organization_id
   AND configured.config_id = receipt.config_id
   AND configured.carrier_provider = NEW.provider
   AND configured.carrier_account_id = NEW.carrier_account_id
  JOIN operations_carrier_accounts carrier_account
    ON carrier_account.organization_id = configured.organization_id
   AND carrier_account.id = configured.carrier_account_id
   AND carrier_account.integration_account_id = NEW.integration_account_id
  JOIN operations_integration_accounts carrier_integration
    ON carrier_integration.organization_id = carrier_account.organization_id
   AND carrier_integration.id = carrier_account.integration_account_id
   AND carrier_integration.provider = NEW.provider
   AND carrier_integration.environment = NEW.environment
  WHERE receipt.organization_id = NEW.organization_id
    AND receipt.status = 'processing'
    AND receipt.lease_expires_at > now()
    AND carrier_integration.environment = CASE receipt.activation_state
      WHEN 'shadow' THEN 'sandbox'
      WHEN 'active' THEN 'production'
      ELSE '__invalid__'
    END
    AND NEW.requested_at >= receipt.created_at
    AND NEW.completed_at <= receipt.created_at + interval '30 seconds'
    AND COALESCE(
      NEW.redacted_request #>> '{shipment,destinationFingerprint}',
      NEW.redacted_request ->> 'destinationFingerprint'
    ) = receipt.carrier_destination_fingerprint
    AND COALESCE(
      NEW.redacted_request #>> '{shipment,rateScope}',
      NEW.redacted_request ->> 'rateScope'
    ) = 'multi_package_shipment'
  ;

  IF COALESCE(cardinality(candidate_receipt_global_ids), 0) > 1 THEN
    RAISE EXCEPTION
      'Legacy Shopify carrier rate evidence matches multiple processing receipts';
  END IF;
  IF COALESCE(cardinality(candidate_receipt_global_ids), 0) = 1 THEN
    NEW.carrier_selection_key :=
      operations_shopify_checkout_carrier_selection_key(
        candidate_receipt_global_ids[1],
        carrier_account_global_id
      );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  derive_operations_legacy_shopify_carrier_selection_key_write
  ON operations_carrier_rate_requests;
CREATE TRIGGER
  derive_operations_legacy_shopify_carrier_selection_key_write
BEFORE INSERT ON operations_carrier_rate_requests
FOR EACH ROW EXECUTE FUNCTION
  derive_operations_legacy_shopify_carrier_selection_key();

-- Migration 0275 treated every non-null carrier_selection_key as a one-off
-- shipment selection. Shopify callback evidence has a different immutable
-- receipt/account identity. Keep the two contexts mutually exclusive: the
-- callback writer is system-owned (NULL actor after persistence normalization)
-- and uses cartonization whole-shipment rate evidence; operator-owned one-off
-- evidence retains the original exact integration/account/credential key.
CREATE OR REPLACE FUNCTION validate_one_off_rate_selection_key()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.carrier_selection_key IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.actor_email IS NULL
     AND NEW.purpose = 'cartonization_shipment_rate'
     AND NEW.provider IN ('ups_rest', 'fedex_rest')
     AND NEW.carrier_account_id IS NOT NULL
  THEN
    PERFORM 1
    FROM operations_shopify_checkout_rate_receipts receipt
    JOIN operations_shopify_carrier_service_config_carriers configured
      ON configured.organization_id = receipt.organization_id
     AND configured.config_id = receipt.config_id
     AND configured.carrier_provider = NEW.provider
     AND configured.carrier_account_id = NEW.carrier_account_id
    JOIN operations_carrier_accounts carrier_account
      ON carrier_account.organization_id = configured.organization_id
     AND carrier_account.id = configured.carrier_account_id
     AND carrier_account.integration_account_id = NEW.integration_account_id
    JOIN operations_integration_accounts carrier_integration
      ON carrier_integration.organization_id = carrier_account.organization_id
     AND carrier_integration.id = carrier_account.integration_account_id
     AND carrier_integration.provider = NEW.provider
     AND carrier_integration.environment = NEW.environment
    JOIN operations_carrier_credentials credential
      ON credential.organization_id = carrier_integration.organization_id
     AND credential.integration_account_id = carrier_integration.id
     AND credential.credential_version = NEW.credential_version
     AND credential.verification_status = 'verified'
    WHERE receipt.organization_id = NEW.organization_id
      AND receipt.status = 'processing'
      AND receipt.lease_expires_at > now()
      AND carrier_integration.environment = CASE receipt.activation_state
        WHEN 'shadow' THEN 'sandbox'
        WHEN 'active' THEN 'production'
        ELSE '__invalid__'
      END
      AND NEW.requested_at >= receipt.created_at
      AND NEW.completed_at <= receipt.created_at + interval '30 seconds'
      AND COALESCE(
        NEW.redacted_request #>> '{shipment,destinationFingerprint}',
        NEW.redacted_request ->> 'destinationFingerprint'
      ) = receipt.carrier_destination_fingerprint
      AND COALESCE(
        NEW.redacted_request #>> '{shipment,rateScope}',
        NEW.redacted_request ->> 'rateScope'
      ) = 'multi_package_shipment'
      AND NEW.carrier_selection_key =
        operations_shopify_checkout_carrier_selection_key(
          receipt.global_id, carrier_account.global_id
        )
    FOR SHARE OF receipt, configured, carrier_account,
      carrier_integration, credential;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'Shopify carrier-rate selection key must bind one exact processing receipt and carrier account';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.actor_email IS NULL THEN
    RAISE EXCEPTION
      'System Shopify carrier-rate evidence requires a receipt/account selection key';
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

COMMENT ON FUNCTION validate_one_off_rate_selection_key() IS
  'Validates mutually exclusive Shopify receipt/account and operator one-off carrier selection keys without allowing either identity contract to cross into the other context.';

-- Offers are written before attempts. Require their immutable rate evidence to
-- carry the same receipt/account selection key as the final attempt.
DO $$
DECLARE
  function_definition text;
  prior_definition text;
BEGIN
  SELECT pg_get_functiondef(
    'protect_operations_shopify_checkout_rate_receipt_offer()'::regprocedure
  ) INTO function_definition;
  prior_definition := function_definition;
  function_definition := replace(
    function_definition,
    'AND rate_evidence.request_hash = NEW.carrier_request_hash',
    'AND rate_evidence.request_hash = NEW.carrier_request_hash
     AND rate_evidence.carrier_selection_key =
       operations_shopify_checkout_carrier_selection_key(
         receipt.global_id, carrier_account.global_id
       )'
  );
  IF function_definition = prior_definition THEN
    RAISE EXCEPTION
      'Unable to bind Shopify checkout offers to receipt/account rate evidence';
  END IF;
  EXECUTE function_definition;
END;
$$;

CREATE OR REPLACE FUNCTION
  protect_op_shopify_checkout_provider_attempt()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  receipt_status text;
  attempt_ready boolean;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION
      'Shopify checkout provider-attempt evidence is immutable';
  END IF;

  SELECT status INTO receipt_status
  FROM operations_shopify_checkout_rate_receipts
  WHERE organization_id = NEW.organization_id
    AND id = NEW.receipt_id;
  IF receipt_status IS DISTINCT FROM 'processing' THEN
    RAISE EXCEPTION
      'Shopify checkout provider attempts require a processing claim';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM operations_shopify_checkout_rate_receipts receipt
    JOIN operations_shopify_carrier_service_config_carriers selected
      ON selected.organization_id = receipt.organization_id
     AND selected.config_id = receipt.config_id
     AND selected.carrier_provider = NEW.carrier_provider
     AND selected.carrier_account_id = NEW.carrier_account_id
    JOIN operations_carrier_accounts carrier_account
      ON carrier_account.organization_id = selected.organization_id
     AND carrier_account.id = selected.carrier_account_id
    JOIN operations_integration_accounts carrier_integration
      ON carrier_integration.organization_id
        = carrier_account.organization_id
     AND carrier_integration.id = carrier_account.integration_account_id
     AND carrier_integration.provider = selected.carrier_provider
    JOIN operations_carrier_rate_requests rate_evidence
      ON rate_evidence.organization_id = receipt.organization_id
     AND rate_evidence.id = NEW.carrier_rate_request_id
     AND rate_evidence.integration_account_id
       = carrier_account.integration_account_id
     AND rate_evidence.provider = NEW.carrier_provider
     AND rate_evidence.purpose = NEW.carrier_rate_purpose
     AND rate_evidence.carrier_account_id = NEW.carrier_account_id
     AND rate_evidence.request_hash = NEW.carrier_request_hash
     AND rate_evidence.carrier_selection_key =
       operations_shopify_checkout_carrier_selection_key(
         receipt.global_id, carrier_account.global_id
       )
     AND rate_evidence.environment = carrier_integration.environment
     AND rate_evidence.requested_at >= receipt.created_at
     AND rate_evidence.completed_at
       <= receipt.created_at + interval '30 seconds'
    JOIN operations_carrier_credentials current_credential
      ON current_credential.organization_id
        = carrier_account.organization_id
     AND current_credential.integration_account_id
        = carrier_account.integration_account_id
     AND current_credential.credential_version
        = rate_evidence.credential_version
    WHERE receipt.organization_id = NEW.organization_id
      AND receipt.id = NEW.receipt_id
      AND carrier_integration.environment = CASE receipt.activation_state
        WHEN 'shadow' THEN 'sandbox'
        WHEN 'active' THEN 'production'
        ELSE '__invalid__'
      END
      AND COALESCE(
        rate_evidence.redacted_request #>>
          '{shipment,destinationFingerprint}',
        rate_evidence.redacted_request ->> 'destinationFingerprint'
      )
        = receipt.carrier_destination_fingerprint
      AND COALESCE(
        rate_evidence.redacted_request #>> '{shipment,rateScope}',
        rate_evidence.redacted_request ->> 'rateScope'
      ) = 'multi_package_shipment'
      AND COALESCE(
        rate_evidence.redacted_request #> '{shipment,packageCount}',
        rate_evidence.redacted_request -> 'packageCount'
      ) = (
          SELECT to_jsonb(count(*)::integer)
          FROM operations_shopify_checkout_rate_receipt_packages package
          WHERE package.organization_id = receipt.organization_id
            AND package.receipt_id = receipt.id
        )
      AND operations_shopify_checkout_carrier_parcels_match(
        receipt.organization_id,
        receipt.id,
        COALESCE(
          rate_evidence.redacted_request #> '{shipment,parcels}',
          rate_evidence.redacted_request -> 'parcels'
        )
      )
      AND rate_evidence.redacted_response #>>
        '{rateScope}' = 'multi_package_shipment'
      AND rate_evidence.redacted_response #>
        '{packageCount}' = (
          SELECT to_jsonb(count(*)::integer)
          FROM operations_shopify_checkout_rate_receipt_packages package
          WHERE package.organization_id = receipt.organization_id
            AND package.receipt_id = receipt.id
        )
      AND (
        (
          NEW.attempt_status = 'succeeded'
          AND rate_evidence.status = 'succeeded'
          AND rate_evidence.error_code IS NULL
          AND NEW.failure_code IS NULL
        )
        OR (
          NEW.attempt_status = 'degraded'
          AND rate_evidence.status = 'failed'
          AND rate_evidence.error_code = NEW.failure_code
          AND rate_evidence.redacted_response #>>
            '{errorCode}' = NEW.failure_code
        )
      )
  ) INTO attempt_ready;

  IF NOT attempt_ready THEN
    RAISE EXCEPTION
      'Shopify checkout provider attempt requires exact configured carrier, environment, and rate evidence';
  END IF;
  RETURN NEW;
END;
$$;

-- A successful account attempt may lose deterministic public service-code
-- deduplication to another account and therefore retain no published offer.
-- Every configured account must still retain exactly one immutable attempt;
-- every published offer must map to a succeeded exact-account attempt; and a
-- degraded attempt may never publish an offer.
CREATE OR REPLACE FUNCTION
  validate_op_shopify_checkout_attempt_finalization()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected_account_count bigint;
  retained_attempt_count bigint;
  successful_attempt_count bigint;
  attempt_config_mismatch_count bigint;
  offer_attempt_mismatch_count bigint;
  degraded_attempt_with_offer_count bigint;
BEGIN
  IF NEW.status <> 'succeeded' THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO expected_account_count
  FROM operations_shopify_carrier_service_config_carriers selected
  JOIN operations_carrier_accounts carrier_account
    ON carrier_account.organization_id = selected.organization_id
   AND carrier_account.id = selected.carrier_account_id
  JOIN operations_integration_accounts carrier_integration
    ON carrier_integration.organization_id = carrier_account.organization_id
   AND carrier_integration.id = carrier_account.integration_account_id
  WHERE selected.organization_id = NEW.organization_id
    AND selected.config_id = NEW.config_id
    AND carrier_integration.environment = CASE NEW.activation_state
      WHEN 'shadow' THEN 'sandbox'
      WHEN 'active' THEN 'production'
      ELSE '__invalid__'
    END;

  SELECT count(*) INTO retained_attempt_count
  FROM operations_shopify_checkout_rate_receipt_provider_attempts attempt
  WHERE attempt.organization_id = NEW.organization_id
    AND attempt.receipt_id = NEW.id;

  SELECT count(*) INTO successful_attempt_count
  FROM operations_shopify_checkout_rate_receipt_provider_attempts attempt
  WHERE attempt.organization_id = NEW.organization_id
    AND attempt.receipt_id = NEW.id
    AND attempt.attempt_status = 'succeeded';

  SELECT count(*) INTO attempt_config_mismatch_count
  FROM operations_shopify_checkout_rate_receipt_provider_attempts attempt
  LEFT JOIN operations_shopify_carrier_service_config_carriers selected
    ON selected.organization_id = NEW.organization_id
   AND selected.config_id = NEW.config_id
   AND selected.carrier_provider = attempt.carrier_provider
   AND selected.carrier_account_id = attempt.carrier_account_id
  LEFT JOIN operations_carrier_accounts carrier_account
    ON carrier_account.organization_id = selected.organization_id
   AND carrier_account.id = selected.carrier_account_id
  LEFT JOIN operations_integration_accounts carrier_integration
    ON carrier_integration.organization_id = carrier_account.organization_id
   AND carrier_integration.id = carrier_account.integration_account_id
  LEFT JOIN operations_carrier_rate_requests rate_evidence
    ON rate_evidence.organization_id = attempt.organization_id
   AND rate_evidence.id = attempt.carrier_rate_request_id
   AND rate_evidence.provider = attempt.carrier_provider
   AND rate_evidence.carrier_account_id = attempt.carrier_account_id
  WHERE attempt.organization_id = NEW.organization_id
    AND attempt.receipt_id = NEW.id
    AND (
      selected.carrier_account_id IS NULL
      OR carrier_integration.environment IS DISTINCT FROM
        CASE NEW.activation_state
          WHEN 'shadow' THEN 'sandbox'
          WHEN 'active' THEN 'production'
          ELSE '__invalid__'
        END
      OR rate_evidence.carrier_selection_key IS DISTINCT FROM
        operations_shopify_checkout_carrier_selection_key(
          NEW.global_id, carrier_account.global_id
        )
    );

  SELECT count(*) INTO offer_attempt_mismatch_count
  FROM operations_shopify_checkout_rate_receipt_offers offer
  LEFT JOIN
    operations_shopify_checkout_rate_receipt_provider_attempts attempt
    ON attempt.organization_id = offer.organization_id
   AND attempt.receipt_id = offer.receipt_id
   AND attempt.carrier_provider = offer.carrier_provider
   AND attempt.carrier_account_id = offer.carrier_account_id
   AND attempt.carrier_rate_request_id = offer.carrier_rate_request_id
   AND attempt.attempt_status = 'succeeded'
  WHERE offer.organization_id = NEW.organization_id
    AND offer.receipt_id = NEW.id
    AND attempt.carrier_account_id IS NULL;

  SELECT count(*) INTO degraded_attempt_with_offer_count
  FROM operations_shopify_checkout_rate_receipt_provider_attempts attempt
  WHERE attempt.organization_id = NEW.organization_id
    AND attempt.receipt_id = NEW.id
    AND attempt.attempt_status = 'degraded'
    AND EXISTS (
      SELECT 1
      FROM operations_shopify_checkout_rate_receipt_offers offer
      WHERE offer.organization_id = attempt.organization_id
        AND offer.receipt_id = attempt.receipt_id
        AND offer.carrier_provider = attempt.carrier_provider
        AND offer.carrier_account_id = attempt.carrier_account_id
    );

  IF expected_account_count NOT BETWEEN 1 AND 8
     OR retained_attempt_count <> expected_account_count
     OR successful_attempt_count < 1
     OR attempt_config_mismatch_count <> 0
     OR offer_attempt_mismatch_count <> 0
     OR degraded_attempt_with_offer_count <> 0
  THEN
    RAISE EXCEPTION
      'Shopify checkout receipt carrier-account attempt evidence is incomplete';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION
  validate_op_shopify_checkout_attempt_finalization() IS
  'Requires one immutable attempt per activation-applicable configured direct carrier account and exact succeeded account evidence for every public offer; successful losing accounts may have no deduplicated offer and the opposite configured environment is not executed.';
