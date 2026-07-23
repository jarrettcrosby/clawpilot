-- Carrier billing identity, match, assignment, GL, and settlement integrity.
--
-- Legacy rows remain readable. New evidence uses non-secret carrier-account
-- fingerprints, exact provider/tracking/account provenance, linear immutable
-- supersession, and either quote or billed-assignment settlement sources.

CREATE OR REPLACE FUNCTION operations_carrier_provider_identity(raw_provider text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE regexp_replace(
    lower(COALESCE(btrim(raw_provider), '')),
    '[^a-z0-9]+',
    '',
    'g'
  )
    WHEN 'upsrest' THEN 'ups'
    WHEN 'ups' THEN 'ups'
    WHEN 'fedexrest' THEN 'fedex'
    WHEN 'fedex' THEN 'fedex'
    WHEN 'uspsrest' THEN 'usps'
    WHEN 'usps' THEN 'usps'
    ELSE NULLIF(
      regexp_replace(
        lower(COALESCE(btrim(raw_provider), '')),
        '[^a-z0-9]+',
        '',
        'g'
      ),
      ''
    )
  END
$$;

CREATE OR REPLACE FUNCTION operations_tracking_identity(raw_tracking_number text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT NULLIF(
    upper(regexp_replace(COALESCE(raw_tracking_number, ''), '[^[:alnum:]]+', '', 'g')),
    ''
  )
$$;

-- The searchable identity surface intentionally omits ciphertext, IVs, tags,
-- registered addresses, and credentials. One provider connection can expose
-- any number of these account identities.
CREATE OR REPLACE VIEW operations_carrier_account_identities AS
SELECT
  account.id,
  account.global_id,
  account.organization_id,
  account.integration_account_id,
  account.display_name,
  account.account_number_last_four,
  account.account_number_fingerprint,
  account.registered_address_fingerprint,
  account.address_verification,
  account.allow_sender_billing,
  account.allow_recipient_billing,
  account.allow_third_party_billing,
  account.status,
  account.created_at,
  account.updated_at
FROM operations_carrier_accounts account;

ALTER TABLE operations_integration_accounts
  ADD CONSTRAINT operations_integration_accounts_provider_scope_unique
    UNIQUE (organization_id, id, provider, environment);

ALTER TABLE operations_carrier_accounts
  ADD CONSTRAINT operations_carrier_accounts_exact_identity_unique
    UNIQUE (
      organization_id, integration_account_id, id,
      account_number_fingerprint
    );

CREATE OR REPLACE FUNCTION protect_operations_carrier_account_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Carrier account identities cannot be deleted';
  END IF;

  IF ROW(
    NEW.id,
    NEW.global_id,
    NEW.organization_id,
    NEW.integration_account_id,
    NEW.account_number_last_four,
    NEW.account_number_fingerprint,
    NEW.created_by,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.id,
    OLD.global_id,
    OLD.organization_id,
    OLD.integration_account_id,
    OLD.account_number_last_four,
    OLD.account_number_fingerprint,
    OLD.created_by,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION
      'Carrier account ownership and non-secret account identity are immutable';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION validate_operations_carrier_billing_batch_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  importer_in_network boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM operations_carrier_rate_parties party
    WHERE party.network_id = NEW.network_id
      AND party.entity_type = 'workspace_organization'
      AND party.workspace_organization_id = NEW.importing_organization_id
      AND party.role IN ('platform_operator', 'reseller')
  )
  INTO importer_in_network;

  IF importer_in_network IS DISTINCT FROM true THEN
    RAISE EXCEPTION
      'Carrier billing batch importer must be an organization party in the rate network';
  END IF;
  IF operations_carrier_provider_identity(NEW.provider) IS NULL THEN
    RAISE EXCEPTION 'Carrier billing batch requires a provider identity';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_operations_carrier_billing_batch_scope_write
  ON operations_carrier_billing_batches;
CREATE TRIGGER validate_operations_carrier_billing_batch_scope_write
BEFORE INSERT ON operations_carrier_billing_batches
FOR EACH ROW EXECUTE FUNCTION validate_operations_carrier_billing_batch_scope();

ALTER TABLE operations_carrier_billing_account_resolutions
  ADD COLUMN IF NOT EXISTS provider_snapshot text,
  ADD COLUMN IF NOT EXISTS environment_snapshot text,
  ADD COLUMN IF NOT EXISTS account_number_fingerprint_snapshot text;

ALTER TABLE operations_carrier_billing_account_resolutions
  ADD CONSTRAINT operations_carrier_billing_account_resolutions_exact_scope_unique
    UNIQUE (
      network_id, statement_id, account_authorization_id,
      carrier_account_id, id
    ),
  ADD CONSTRAINT operations_carrier_billing_account_resolutions_identity_valid
    CHECK (
      (
        decision = 'matched'
        AND NULLIF(btrim(provider_snapshot), '') IS NOT NULL
        AND environment_snapshot IS NOT NULL
        AND environment_snapshot IN ('sandbox', 'production')
        AND account_number_fingerprint_snapshot IS NOT NULL
        AND account_number_fingerprint_snapshot
          ~ '^[a-f0-9]{64}$'
      )
      OR (
        decision <> 'matched'
        AND provider_snapshot IS NULL
        AND environment_snapshot IS NULL
        AND account_number_fingerprint_snapshot IS NULL
      )
    ) NOT VALID,
  ADD CONSTRAINT operations_carrier_billing_account_resolutions_exact_account_fkey
    FOREIGN KEY (
      account_owner_organization_id, integration_account_id,
      carrier_account_id, account_number_fingerprint_snapshot
    )
    REFERENCES operations_carrier_accounts(
      organization_id, integration_account_id, id,
      account_number_fingerprint
    ) ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT operations_carrier_billing_account_resolutions_provider_fkey
    FOREIGN KEY (
      account_owner_organization_id, integration_account_id,
      provider_snapshot, environment_snapshot
    )
    REFERENCES operations_integration_accounts(
      organization_id, id, provider, environment
    ) ON DELETE RESTRICT NOT VALID;

CREATE OR REPLACE FUNCTION validate_operations_carrier_billing_account_resolution()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_resolution_ids uuid[];
  statement_account_fingerprint text;
  batch_provider text;
  batch_environment text;
  selected_account_fingerprint text;
  selected_provider text;
  selected_environment text;
BEGIN
  PERFORM 1
  FROM operations_carrier_billing_statements statement
  WHERE statement.network_id = NEW.network_id
    AND statement.id = NEW.statement_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Carrier billing account resolution requires an existing network statement';
  END IF;

  SELECT array_agg(current.id ORDER BY current.decided_at, current.id)
  INTO current_resolution_ids
  FROM operations_carrier_billing_account_resolutions current
  WHERE current.network_id = NEW.network_id
    AND current.statement_id = NEW.statement_id
    AND NOT EXISTS (
      SELECT 1
      FROM operations_carrier_billing_account_resolutions child
      WHERE child.network_id = current.network_id
        AND child.statement_id = current.statement_id
        AND child.supersedes_resolution_id = current.id
    );

  IF COALESCE(cardinality(current_resolution_ids), 0) > 1 THEN
    RAISE EXCEPTION
      'Carrier billing account resolution lineage has multiple current decisions';
  END IF;
  IF COALESCE(cardinality(current_resolution_ids), 0) = 0
     AND NEW.supersedes_resolution_id IS NOT NULL THEN
    RAISE EXCEPTION
      'Initial carrier billing account resolution cannot supersede another decision';
  END IF;
  IF COALESCE(cardinality(current_resolution_ids), 0) = 1
     AND NEW.supersedes_resolution_id
       IS DISTINCT FROM current_resolution_ids[1] THEN
    RAISE EXCEPTION
      'Carrier billing account resolution must supersede the current decision';
  END IF;

  IF NEW.decision = 'matched' THEN
    SELECT
      statement.billed_account_fingerprint,
      batch.provider,
      batch.environment,
      account.account_number_fingerprint,
      integration.provider,
      integration.environment
    INTO
      statement_account_fingerprint,
      batch_provider,
      batch_environment,
      selected_account_fingerprint,
      selected_provider,
      selected_environment
    FROM operations_carrier_billing_statements statement
    JOIN operations_carrier_billing_batches batch
      ON batch.network_id = statement.network_id
     AND batch.id = statement.batch_id
    JOIN operations_carrier_accounts account
      ON account.organization_id = NEW.account_owner_organization_id
     AND account.integration_account_id = NEW.integration_account_id
     AND account.id = NEW.carrier_account_id
    JOIN operations_integration_accounts integration
      ON integration.organization_id = account.organization_id
     AND integration.id = account.integration_account_id
    WHERE statement.network_id = NEW.network_id
      AND statement.id = NEW.statement_id;

    IF selected_provider IS NULL THEN
      RAISE EXCEPTION
        'Matched carrier billing account resolution requires an exact carrier account';
    END IF;
    IF statement_account_fingerprint
         IS DISTINCT FROM selected_account_fingerprint THEN
      RAISE EXCEPTION
        'Billed account fingerprint does not match the selected carrier account';
    END IF;
    IF operations_carrier_provider_identity(batch_provider)
         IS DISTINCT FROM operations_carrier_provider_identity(selected_provider)
       OR batch_environment IS DISTINCT FROM selected_environment THEN
      RAISE EXCEPTION
        'Billing statement provider and environment do not match the selected carrier account';
    END IF;

    IF NEW.provider_snapshot IS NOT NULL
       AND NEW.provider_snapshot IS DISTINCT FROM selected_provider THEN
      RAISE EXCEPTION
        'Carrier billing account provider snapshot does not match the provider connection';
    END IF;
    IF NEW.environment_snapshot IS NOT NULL
       AND NEW.environment_snapshot IS DISTINCT FROM selected_environment THEN
      RAISE EXCEPTION
        'Carrier billing account environment snapshot does not match the provider connection';
    END IF;
    IF NEW.account_number_fingerprint_snapshot IS NOT NULL
       AND NEW.account_number_fingerprint_snapshot
         IS DISTINCT FROM selected_account_fingerprint THEN
      RAISE EXCEPTION
        'Carrier billing account fingerprint snapshot does not match the selected account';
    END IF;

    NEW.provider_snapshot := selected_provider;
    NEW.environment_snapshot := selected_environment;
    NEW.account_number_fingerprint_snapshot := selected_account_fingerprint;
  ELSIF NEW.provider_snapshot IS NOT NULL
     OR NEW.environment_snapshot IS NOT NULL
     OR NEW.account_number_fingerprint_snapshot IS NOT NULL THEN
    RAISE EXCEPTION
      'Unresolved carrier billing accounts cannot claim matched account provenance';
  END IF;

  IF NEW.match_method = 'manual'
     AND (
       NEW.decided_by IS NULL
       OR NULLIF(btrim(NEW.reason), '') IS NULL
     ) THEN
    RAISE EXCEPTION
      'Manual carrier account resolution requires a human actor and reason';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE VIEW operations_carrier_billing_current_account_resolutions AS
SELECT resolution.*
FROM operations_carrier_billing_account_resolutions resolution
WHERE NOT EXISTS (
  SELECT 1
  FROM operations_carrier_billing_account_resolutions child
  WHERE child.network_id = resolution.network_id
    AND child.statement_id = resolution.statement_id
    AND child.supersedes_resolution_id = resolution.id
);

ALTER TABLE operations_carrier_billing_charges
  ADD CONSTRAINT operations_carrier_billing_charges_statement_scope_unique
    UNIQUE (network_id, statement_id, id);

ALTER TABLE operations_carrier_billing_matches
  ADD COLUMN IF NOT EXISTS billing_statement_id uuid,
  ADD COLUMN IF NOT EXISTS account_resolution_id uuid,
  ADD COLUMN IF NOT EXISTS account_authorization_id uuid,
  ADD COLUMN IF NOT EXISTS carrier_account_id uuid,
  ADD COLUMN IF NOT EXISTS quote_snapshot_id uuid,
  ADD COLUMN IF NOT EXISTS provider_identity_snapshot text,
  ADD COLUMN IF NOT EXISTS tracking_number_snapshot text,
  ADD COLUMN IF NOT EXISTS billed_account_fingerprint_snapshot text,
  ADD COLUMN IF NOT EXISTS provider_label_id_snapshot text;

ALTER TABLE operations_carrier_billing_matches
  ADD CONSTRAINT operations_carrier_billing_matches_charge_statement_fkey
    FOREIGN KEY (network_id, billing_statement_id, charge_id)
    REFERENCES operations_carrier_billing_charges(
      network_id, statement_id, id
    ) ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT operations_carrier_billing_matches_account_resolution_fkey
    FOREIGN KEY (
      network_id, billing_statement_id, account_authorization_id,
      carrier_account_id, account_resolution_id
    )
    REFERENCES operations_carrier_billing_account_resolutions(
      network_id, statement_id, account_authorization_id,
      carrier_account_id, id
    ) ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT operations_carrier_billing_matches_quote_fkey
    FOREIGN KEY (
      network_id, executing_organization_id, account_authorization_id,
      carrier_account_id, quote_snapshot_id
    )
    REFERENCES operations_carrier_quote_snapshots(
      network_id, executing_organization_id, account_authorization_id,
      carrier_account_id, id
    ) ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT operations_carrier_billing_matches_provenance_valid
    CHECK (
      billing_statement_id IS NOT NULL
      AND (
        (
          decision = 'matched'
          AND account_resolution_id IS NOT NULL
          AND account_authorization_id IS NOT NULL
          AND carrier_account_id IS NOT NULL
          AND quote_snapshot_id IS NOT NULL
          AND provider_identity_snapshot IS NOT NULL
          AND provider_identity_snapshot ~ '^[a-z0-9]+$'
          AND NULLIF(btrim(tracking_number_snapshot), '') IS NOT NULL
          AND billed_account_fingerprint_snapshot IS NOT NULL
          AND billed_account_fingerprint_snapshot
            ~ '^[a-f0-9]{64}$'
          AND (
            match_method <> 'provider_label_id'
            OR NULLIF(btrim(provider_label_id_snapshot), '') IS NOT NULL
          )
        )
        OR (
          decision <> 'matched'
          AND account_resolution_id IS NULL
          AND account_authorization_id IS NULL
          AND carrier_account_id IS NULL
          AND quote_snapshot_id IS NULL
          AND provider_identity_snapshot IS NULL
          AND tracking_number_snapshot IS NULL
          AND billed_account_fingerprint_snapshot IS NULL
          AND provider_label_id_snapshot IS NULL
        )
      )
    ) NOT VALID;

CREATE OR REPLACE FUNCTION validate_operations_carrier_billing_match()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_match_ids uuid[];
  charge_statement_id uuid;
  charge_tracking_number text;
  charge_provider_label_id text;
  statement_account_fingerprint text;
  batch_provider text;
  batch_environment text;
  resolution_decision text;
  resolution_provider text;
  resolution_environment text;
  resolution_account_fingerprint text;
  resolution_is_current boolean;
  shipment_found boolean;
  shipment_in_rate_network boolean;
  shipment_package_id uuid;
  shipment_label_id uuid;
  shipment_tracking_number text;
  shipment_quote_snapshot_id uuid;
  label_tracking_number text;
  label_provider_label_id text;
  label_carrier text;
  rate_carrier text;
  quote_network_id uuid;
  quote_authorization_id uuid;
  quote_carrier_account_id uuid;
  quote_carrier text;
  quote_shipper_matches boolean;
  expected_provider_identity text;
  expected_tracking_identity text;
BEGIN
  SELECT
    charge.statement_id,
    charge.tracking_number,
    charge.provider_label_id,
    statement.billed_account_fingerprint,
    batch.provider,
    batch.environment
  INTO
    charge_statement_id,
    charge_tracking_number,
    charge_provider_label_id,
    statement_account_fingerprint,
    batch_provider,
    batch_environment
  FROM operations_carrier_billing_charges charge
  JOIN operations_carrier_billing_statements statement
    ON statement.network_id = charge.network_id
   AND statement.id = charge.statement_id
  JOIN operations_carrier_billing_batches batch
    ON batch.network_id = statement.network_id
   AND batch.id = statement.batch_id
  WHERE charge.network_id = NEW.network_id
    AND charge.id = NEW.charge_id
  FOR UPDATE OF charge, statement;

  IF charge_statement_id IS NULL THEN
    RAISE EXCEPTION 'Carrier billing match requires an existing network charge';
  END IF;
  IF NEW.billing_statement_id IS NOT NULL
     AND NEW.billing_statement_id IS DISTINCT FROM charge_statement_id THEN
    RAISE EXCEPTION
      'Carrier billing match statement does not own the selected charge';
  END IF;
  NEW.billing_statement_id := charge_statement_id;

  SELECT array_agg(current.id ORDER BY current.decided_at, current.id)
  INTO current_match_ids
  FROM operations_carrier_billing_matches current
  WHERE current.network_id = NEW.network_id
    AND current.charge_id = NEW.charge_id
    AND NOT EXISTS (
      SELECT 1
      FROM operations_carrier_billing_matches child
      WHERE child.network_id = current.network_id
        AND child.charge_id = current.charge_id
        AND child.supersedes_match_id = current.id
    );

  IF COALESCE(cardinality(current_match_ids), 0) > 1 THEN
    RAISE EXCEPTION 'Carrier billing match lineage has multiple current decisions';
  END IF;
  IF COALESCE(cardinality(current_match_ids), 0) = 0
     AND NEW.supersedes_match_id IS NOT NULL THEN
    RAISE EXCEPTION 'Initial carrier billing match cannot supersede another decision';
  END IF;
  IF COALESCE(cardinality(current_match_ids), 0) = 1
     AND NEW.supersedes_match_id IS DISTINCT FROM current_match_ids[1] THEN
    RAISE EXCEPTION 'Carrier billing match must supersede the current decision';
  END IF;

  IF NEW.decision <> 'matched' THEN
    IF NEW.account_resolution_id IS NOT NULL
       OR NEW.account_authorization_id IS NOT NULL
       OR NEW.carrier_account_id IS NOT NULL
       OR NEW.quote_snapshot_id IS NOT NULL
       OR NEW.provider_identity_snapshot IS NOT NULL
       OR NEW.tracking_number_snapshot IS NOT NULL
       OR NEW.billed_account_fingerprint_snapshot IS NOT NULL
       OR NEW.provider_label_id_snapshot IS NOT NULL THEN
      RAISE EXCEPTION
        'Unmatched shipment decisions cannot claim exact shipment-match provenance';
    END IF;
    RETURN NEW;
  END IF;

  SELECT
    resolution.decision,
    resolution.provider_snapshot,
    resolution.environment_snapshot,
    resolution.account_number_fingerprint_snapshot,
    NOT EXISTS (
      SELECT 1
      FROM operations_carrier_billing_account_resolutions child
      WHERE child.network_id = resolution.network_id
        AND child.statement_id = resolution.statement_id
        AND child.supersedes_resolution_id = resolution.id
    )
  INTO
    resolution_decision,
    resolution_provider,
    resolution_environment,
    resolution_account_fingerprint,
    resolution_is_current
  FROM operations_carrier_billing_account_resolutions resolution
  WHERE resolution.network_id = NEW.network_id
    AND resolution.statement_id = NEW.billing_statement_id
    AND resolution.id = NEW.account_resolution_id
    AND resolution.account_authorization_id = NEW.account_authorization_id
    AND resolution.carrier_account_id = NEW.carrier_account_id;

  IF resolution_decision IS DISTINCT FROM 'matched'
     OR resolution_is_current IS DISTINCT FROM true THEN
    RAISE EXCEPTION
      'Matched carrier charge requires the current exact account resolution';
  END IF;
  IF resolution_account_fingerprint
       IS DISTINCT FROM statement_account_fingerprint THEN
    RAISE EXCEPTION
      'Matched carrier charge account fingerprint differs from its billing statement';
  END IF;
  IF operations_carrier_provider_identity(resolution_provider)
       IS DISTINCT FROM operations_carrier_provider_identity(batch_provider)
     OR resolution_environment IS DISTINCT FROM batch_environment THEN
    RAISE EXCEPTION
      'Matched carrier charge account provider differs from its billing batch';
  END IF;

  SELECT
    true,
    shipment.package_id,
    shipment.label_id,
    shipment.tracking_number,
    shipment.rate_quote_snapshot_id,
    label.tracking_number,
    label.provider_label_id,
    label.carrier,
    rate.carrier,
    quote.network_id,
    quote.account_authorization_id,
    quote.carrier_account_id,
    quote.carrier,
    EXISTS (
      SELECT 1
      FROM operations_carrier_rate_parties party
      WHERE party.network_id = NEW.network_id
        AND party.id = quote.shipper_party_id
        AND party.role = 'shipper'
        AND (
          (
            party.entity_type = 'workspace_organization'
            AND party.workspace_organization_id = shipment.organization_id
          )
          OR (
            party.entity_type = 'crm_customer'
            AND party.crm_pipeline_id = shipment_order.pipeline_id
            AND party.crm_customer_id = shipment_order.customer_id
          )
        )
    )
  INTO
    shipment_found,
    shipment_package_id,
    shipment_label_id,
    shipment_tracking_number,
    shipment_quote_snapshot_id,
    label_tracking_number,
    label_provider_label_id,
    label_carrier,
    rate_carrier,
    quote_network_id,
    quote_authorization_id,
    quote_carrier_account_id,
    quote_carrier,
    quote_shipper_matches
  FROM operations_shipments shipment
  JOIN operations_orders shipment_order
    ON shipment_order.organization_id = shipment.organization_id
   AND shipment_order.id = shipment.order_id
  JOIN operations_labels label
    ON label.organization_id = shipment.organization_id
   AND label.id = shipment.label_id
  JOIN operations_carrier_rates rate
    ON rate.organization_id = label.organization_id
   AND rate.id = label.carrier_rate_id
  LEFT JOIN operations_carrier_quote_snapshots quote
    ON quote.executing_organization_id = shipment.organization_id
   AND quote.id = shipment.rate_quote_snapshot_id
  WHERE shipment.organization_id = NEW.executing_organization_id
    AND shipment.id = NEW.shipment_id;

  IF shipment_found IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Matched carrier charge requires an existing shipment';
  END IF;
  IF quote_shipper_matches IS DISTINCT FROM true THEN
    RAISE EXCEPTION
      'Matched shipment quote must identify its shipper party in the same rate network';
  END IF;
  IF NEW.package_id IS NOT NULL
     AND NEW.package_id IS DISTINCT FROM shipment_package_id THEN
    RAISE EXCEPTION 'Carrier billing package does not belong to the matched shipment';
  END IF;
  IF NEW.label_id IS NOT NULL
     AND NEW.label_id IS DISTINCT FROM shipment_label_id THEN
    RAISE EXCEPTION 'Carrier billing label does not belong to the matched shipment';
  END IF;
  NEW.package_id := shipment_package_id;
  NEW.label_id := shipment_label_id;

  IF NEW.quote_snapshot_id IS NOT NULL
     AND NEW.quote_snapshot_id IS DISTINCT FROM shipment_quote_snapshot_id THEN
    RAISE EXCEPTION
      'Carrier billing match quote does not belong to the matched shipment';
  END IF;
  NEW.quote_snapshot_id := shipment_quote_snapshot_id;

  IF quote_network_id IS DISTINCT FROM NEW.network_id
     OR quote_authorization_id IS DISTINCT FROM NEW.account_authorization_id
     OR quote_carrier_account_id IS DISTINCT FROM NEW.carrier_account_id THEN
    RAISE EXCEPTION
      'Matched shipment was not tendered with the billed carrier account';
  END IF;

  expected_provider_identity :=
    operations_carrier_provider_identity(batch_provider);
  IF expected_provider_identity IS NULL
     OR expected_provider_identity
       IS DISTINCT FROM operations_carrier_provider_identity(resolution_provider)
     OR expected_provider_identity
       IS DISTINCT FROM operations_carrier_provider_identity(label_carrier)
     OR expected_provider_identity
       IS DISTINCT FROM operations_carrier_provider_identity(rate_carrier)
     OR expected_provider_identity
       IS DISTINCT FROM operations_carrier_provider_identity(quote_carrier) THEN
    RAISE EXCEPTION
      'Carrier billing provider does not exactly match the shipment tender provider';
  END IF;

  expected_tracking_identity :=
    operations_tracking_identity(charge_tracking_number);
  IF expected_tracking_identity IS NULL
     OR expected_tracking_identity
       IS DISTINCT FROM operations_tracking_identity(shipment_tracking_number)
     OR expected_tracking_identity
       IS DISTINCT FROM operations_tracking_identity(label_tracking_number) THEN
    RAISE EXCEPTION
      'Carrier billing tracking number does not exactly match the shipment and label';
  END IF;

  IF NEW.match_method = 'provider_label_id'
     AND (
       NULLIF(btrim(charge_provider_label_id), '') IS NULL
       OR btrim(charge_provider_label_id)
         IS DISTINCT FROM btrim(label_provider_label_id)
     ) THEN
    RAISE EXCEPTION
      'Provider-label match requires the exact provider label identifier';
  END IF;

  IF NEW.provider_identity_snapshot IS NOT NULL
     AND NEW.provider_identity_snapshot
       IS DISTINCT FROM expected_provider_identity THEN
    RAISE EXCEPTION
      'Carrier billing provider snapshot differs from exact match evidence';
  END IF;
  IF NEW.tracking_number_snapshot IS NOT NULL
     AND NEW.tracking_number_snapshot
       IS DISTINCT FROM expected_tracking_identity THEN
    RAISE EXCEPTION
      'Carrier billing tracking snapshot differs from exact match evidence';
  END IF;
  IF NEW.billed_account_fingerprint_snapshot IS NOT NULL
     AND NEW.billed_account_fingerprint_snapshot
       IS DISTINCT FROM resolution_account_fingerprint THEN
    RAISE EXCEPTION
      'Carrier billing account snapshot differs from exact match evidence';
  END IF;
  IF NEW.provider_label_id_snapshot IS NOT NULL
     AND NEW.provider_label_id_snapshot
       IS DISTINCT FROM charge_provider_label_id THEN
    RAISE EXCEPTION
      'Carrier billing provider-label snapshot differs from charge evidence';
  END IF;

  NEW.provider_identity_snapshot := expected_provider_identity;
  NEW.tracking_number_snapshot := expected_tracking_identity;
  NEW.billed_account_fingerprint_snapshot := resolution_account_fingerprint;
  NEW.provider_label_id_snapshot := charge_provider_label_id;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE VIEW operations_carrier_billing_current_matches AS
SELECT match_decision.*
FROM operations_carrier_billing_matches match_decision
WHERE NOT EXISTS (
  SELECT 1
  FROM operations_carrier_billing_matches child
  WHERE child.network_id = match_decision.network_id
    AND child.charge_id = match_decision.charge_id
    AND child.supersedes_match_id = match_decision.id
);

ALTER TABLE operations_carrier_billing_routing_rules
  ADD CONSTRAINT operations_carrier_billing_routing_rules_version_scope_unique
    UNIQUE (network_id, id, version_number);

CREATE OR REPLACE FUNCTION validate_operations_carrier_billing_routing_rule()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_role text;
  prior_name text;
  prior_version_number integer;
  prior_is_current boolean;
BEGIN
  PERFORM 1
  FROM operations_carrier_rate_networks network
  WHERE network.id = NEW.network_id
  FOR UPDATE;

  SELECT party.role
  INTO target_role
  FROM operations_carrier_rate_parties party
  WHERE party.network_id = NEW.network_id
    AND party.id = NEW.target_shipper_party_id;

  IF target_role IS DISTINCT FROM 'shipper' THEN
    RAISE EXCEPTION 'Carrier billing routing rule target must be a shipper party';
  END IF;
  IF NEW.version_number > 1 AND NEW.supersedes_rule_id IS NULL THEN
    RAISE EXCEPTION
      'Versioned carrier billing routing rule must identify the superseded version';
  END IF;
  IF NEW.version_number = 1 AND NEW.supersedes_rule_id IS NOT NULL THEN
    RAISE EXCEPTION
      'Initial carrier billing routing rule cannot supersede another version';
  END IF;

  IF NEW.supersedes_rule_id IS NULL THEN
    IF EXISTS (
      SELECT 1
      FROM operations_carrier_billing_routing_rules existing
      WHERE existing.network_id = NEW.network_id
        AND lower(btrim(existing.name)) = lower(btrim(NEW.name))
    ) THEN
      RAISE EXCEPTION
        'Initial carrier billing routing rule name already has a version lineage';
    END IF;
  ELSE
    SELECT
      prior.name,
      prior.version_number,
      NOT EXISTS (
        SELECT 1
        FROM operations_carrier_billing_routing_rules child
        WHERE child.network_id = prior.network_id
          AND child.supersedes_rule_id = prior.id
      )
    INTO prior_name, prior_version_number, prior_is_current
    FROM operations_carrier_billing_routing_rules prior
    WHERE prior.network_id = NEW.network_id
      AND prior.id = NEW.supersedes_rule_id;

    IF lower(btrim(prior_name)) IS DISTINCT FROM lower(btrim(NEW.name)) THEN
      RAISE EXCEPTION
        'Carrier billing routing rule may only supersede the same named rule';
    END IF;
    IF NEW.version_number IS DISTINCT FROM prior_version_number + 1 THEN
      RAISE EXCEPTION 'Carrier billing routing rule versions must be sequential';
    END IF;
    IF prior_is_current IS DISTINCT FROM true THEN
      RAISE EXCEPTION
        'Carrier billing routing rule must supersede the current immutable version';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE VIEW operations_carrier_billing_current_routing_rules AS
SELECT rule.*
FROM operations_carrier_billing_routing_rules rule
WHERE NOT EXISTS (
  SELECT 1
  FROM operations_carrier_billing_routing_rules child
  WHERE child.network_id = rule.network_id
    AND child.supersedes_rule_id = rule.id
);

ALTER TABLE operations_carrier_billing_shipper_assignments
  ADD COLUMN IF NOT EXISTS manual_assignment_evidence jsonb,
  ADD COLUMN IF NOT EXISTS routing_rule_evidence jsonb,
  ADD COLUMN IF NOT EXISTS routing_rule_request_checksum text;

ALTER TABLE operations_carrier_billing_shipper_assignments
  ADD CONSTRAINT operations_carrier_billing_shipper_assignments_match_charge_fkey
    FOREIGN KEY (network_id, charge_id, billing_match_id)
    REFERENCES operations_carrier_billing_matches(network_id, charge_id, id)
    ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT operations_carrier_billing_shipper_assignments_rule_version_fkey
    FOREIGN KEY (network_id, routing_rule_id, routing_rule_version)
    REFERENCES operations_carrier_billing_routing_rules(
      network_id, id, version_number
    ) ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT operations_carrier_billing_shipper_assignments_provenance_valid
    CHECK (
      (
        assignment_source = 'manual'
        AND decision = 'assigned'
        AND decided_by IS NOT NULL
        AND NULLIF(btrim(reason), '') IS NOT NULL
        AND manual_assignment_evidence IS NOT NULL
        AND jsonb_typeof(manual_assignment_evidence) = 'object'
        AND manual_assignment_evidence <> '{}'::jsonb
        AND routing_rule_evidence IS NULL
        AND routing_rule_request_checksum IS NULL
      )
      OR (
        assignment_source = 'routing_rule'
        AND decision = 'assigned'
        AND manual_assignment_evidence IS NULL
        AND routing_rule_evidence IS NOT NULL
        AND jsonb_typeof(routing_rule_evidence) = 'object'
        AND routing_rule_evidence <> '{}'::jsonb
        AND routing_rule_evidence ? 'requestChecksum'
        AND NULLIF(
          btrim(routing_rule_evidence->>'requestChecksum'),
          ''
        ) IS NOT NULL
        AND routing_rule_request_checksum IS NOT NULL
        AND routing_rule_request_checksum ~ '^[a-f0-9]{64}$'
        AND routing_rule_evidence->>'requestChecksum'
          = routing_rule_request_checksum
      )
      OR (
        assignment_source IN ('shipment_match', 'none')
        AND manual_assignment_evidence IS NULL
        AND routing_rule_evidence IS NULL
        AND routing_rule_request_checksum IS NULL
      )
    ) NOT VALID;

CREATE OR REPLACE FUNCTION validate_operations_carrier_billing_shipper_assignment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_assignment_ids uuid[];
  current_assignment_decision text;
  current_match_ids uuid[];
  current_match_decision text;
  match_charge_id uuid;
  match_decision text;
  target_role text;
  rule_target_shipper uuid;
  rule_request_checksum text;
  rule_status text;
  rule_effective_from timestamptz;
  rule_effective_to timestamptz;
BEGIN
  PERFORM 1
  FROM operations_carrier_billing_charges charge
  WHERE charge.network_id = NEW.network_id
    AND charge.id = NEW.charge_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Carrier billing assignment requires an existing network charge';
  END IF;

  SELECT
    array_agg(current.id ORDER BY current.decided_at, current.id),
    (array_agg(current.decision ORDER BY current.decided_at, current.id))[1]
  INTO current_assignment_ids, current_assignment_decision
  FROM operations_carrier_billing_shipper_assignments current
  WHERE current.network_id = NEW.network_id
    AND current.charge_id = NEW.charge_id
    AND NOT EXISTS (
      SELECT 1
      FROM operations_carrier_billing_shipper_assignments child
      WHERE child.network_id = current.network_id
        AND child.charge_id = current.charge_id
        AND child.supersedes_assignment_id = current.id
    );

  IF COALESCE(cardinality(current_assignment_ids), 0) > 1 THEN
    RAISE EXCEPTION
      'Carrier billing shipper assignment lineage has multiple current decisions';
  END IF;
  IF COALESCE(cardinality(current_assignment_ids), 0) = 0
     AND NEW.supersedes_assignment_id IS NOT NULL THEN
    RAISE EXCEPTION
      'Initial carrier billing shipper assignment cannot supersede another decision';
  END IF;
  IF COALESCE(cardinality(current_assignment_ids), 0) = 1
     AND NEW.supersedes_assignment_id
       IS DISTINCT FROM current_assignment_ids[1] THEN
    RAISE EXCEPTION
      'Carrier billing shipper assignment must supersede the current decision';
  END IF;

  IF NEW.assignment_source = 'manual'
     AND current_assignment_ids IS NOT NULL
     AND current_assignment_decision NOT IN ('unassigned', 'ambiguous') THEN
    RAISE EXCEPTION
      'Manual shipper assignment may only replace the current unresolved decision';
  END IF;

  IF NEW.shipper_party_id IS NOT NULL THEN
    SELECT party.role
    INTO target_role
    FROM operations_carrier_rate_parties party
    WHERE party.network_id = NEW.network_id
      AND party.id = NEW.shipper_party_id;

    IF target_role IS DISTINCT FROM 'shipper' THEN
      RAISE EXCEPTION
        'Carrier billing assignment target must be a shipper party';
    END IF;
  END IF;

  IF NEW.billing_match_id IS NOT NULL THEN
    SELECT match_decision_row.charge_id, match_decision_row.decision
    INTO match_charge_id, match_decision
    FROM operations_carrier_billing_matches match_decision_row
    WHERE match_decision_row.network_id = NEW.network_id
      AND match_decision_row.charge_id = NEW.charge_id
      AND match_decision_row.id = NEW.billing_match_id;

    IF match_charge_id IS DISTINCT FROM NEW.charge_id THEN
      RAISE EXCEPTION
        'Carrier billing assignment match belongs to a different charge';
    END IF;
  END IF;

  IF NEW.assignment_source = 'shipment_match'
     AND match_decision IS DISTINCT FROM 'matched' THEN
    RAISE EXCEPTION
      'Shipment-derived shipper assignment requires a matched shipment decision';
  END IF;

  SELECT
    array_agg(current.id ORDER BY current.decided_at, current.id),
    (array_agg(current.decision ORDER BY current.decided_at, current.id))[1]
  INTO current_match_ids, current_match_decision
  FROM operations_carrier_billing_matches current
  WHERE current.network_id = NEW.network_id
    AND current.charge_id = NEW.charge_id
    AND NOT EXISTS (
      SELECT 1
      FROM operations_carrier_billing_matches child
      WHERE child.network_id = current.network_id
        AND child.charge_id = current.charge_id
        AND child.supersedes_match_id = current.id
    );

  IF COALESCE(cardinality(current_match_ids), 0) > 1 THEN
    RAISE EXCEPTION
      'Carrier billing match lineage has multiple current decisions';
  END IF;
  IF NEW.assignment_source IN ('manual', 'routing_rule')
     AND current_match_decision = 'matched' THEN
    RAISE EXCEPTION
      'Orphan shipper assignment cannot replace exact shipment-match evidence';
  END IF;

  IF NEW.assignment_source = 'routing_rule' THEN
    SELECT
      rule.target_shipper_party_id,
      rule.request_checksum,
      rule.status,
      rule.effective_from,
      rule.effective_to
    INTO
      rule_target_shipper,
      rule_request_checksum,
      rule_status,
      rule_effective_from,
      rule_effective_to
    FROM operations_carrier_billing_routing_rules rule
    WHERE rule.network_id = NEW.network_id
      AND rule.id = NEW.routing_rule_id
      AND rule.version_number = NEW.routing_rule_version;

    IF rule_target_shipper IS NULL THEN
      RAISE EXCEPTION 'Carrier billing routing rule version was not found';
    END IF;
    IF NEW.shipper_party_id IS DISTINCT FROM rule_target_shipper THEN
      RAISE EXCEPTION
        'Carrier billing assignment does not match the routing rule target';
    END IF;
    IF rule_status IS DISTINCT FROM 'active'
       OR NEW.decided_at < rule_effective_from
       OR (
         rule_effective_to IS NOT NULL
         AND NEW.decided_at >= rule_effective_to
       ) THEN
      RAISE EXCEPTION
        'Carrier billing routing rule was not active when the assignment was decided';
    END IF;
    IF NEW.routing_rule_request_checksum
         IS DISTINCT FROM rule_request_checksum THEN
      RAISE EXCEPTION
        'Carrier billing assignment routing-rule checksum does not match the immutable rule';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE VIEW operations_carrier_billing_current_shipper_assignments AS
SELECT assignment.*
FROM operations_carrier_billing_shipper_assignments assignment
WHERE NOT EXISTS (
  SELECT 1
  FROM operations_carrier_billing_shipper_assignments child
  WHERE child.network_id = assignment.network_id
    AND child.charge_id = assignment.charge_id
    AND child.supersedes_assignment_id = assignment.id
);

CREATE OR REPLACE FUNCTION validate_operations_gl_coding_assignment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  charge_in_selected_batch boolean;
  rule_outputs jsonb;
  rule_request_checksum text;
  run_status text;
BEGIN
  IF NEW.gl_coding_run_id IS NOT NULL THEN
    SELECT run.status
    INTO run_status
    FROM operations_gl_coding_runs run
    WHERE run.network_id = NEW.network_id
      AND run.id = NEW.gl_coding_run_id;

    IF run_status IS DISTINCT FROM 'running' THEN
      RAISE EXCEPTION 'GL Coding assignments require a running GL Coding run';
    END IF;

    SELECT EXISTS (
      SELECT 1
      FROM operations_carrier_billing_charges charge
      JOIN operations_carrier_billing_statements statement
        ON statement.network_id = charge.network_id
       AND statement.id = charge.statement_id
      JOIN operations_gl_coding_run_batches selected
        ON selected.network_id = statement.network_id
       AND selected.batch_id = statement.batch_id
       AND selected.run_id = NEW.gl_coding_run_id
      WHERE charge.network_id = NEW.network_id
        AND charge.id = NEW.charge_id
    )
    INTO charge_in_selected_batch;

    IF charge_in_selected_batch IS DISTINCT FROM true THEN
      RAISE EXCEPTION
        'GL Coding assignment charge is not part of a selected billing file';
    END IF;
  END IF;

  IF NEW.assignment_source = 'routing_rule' THEN
    SELECT rule.outputs, rule.request_checksum
    INTO rule_outputs, rule_request_checksum
    FROM operations_carrier_billing_routing_rules rule
    WHERE rule.network_id = NEW.network_id
      AND rule.id = NEW.routing_rule_id
      AND rule.version_number = NEW.routing_rule_version;

    IF rule_outputs IS NULL
       OR NEW.coding_outputs IS DISTINCT FROM rule_outputs THEN
      RAISE EXCEPTION
        'GL Coding assignment must preserve the selected routing rule output snapshot';
    END IF;
    IF NEW.routing_rule_request_checksum
         IS DISTINCT FROM rule_request_checksum THEN
      RAISE EXCEPTION
        'GL Coding assignment must preserve the selected routing rule checksum';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

ALTER TABLE operations_gl_coding_run_items
  ADD CONSTRAINT operations_gl_coding_run_items_match_charge_fkey
    FOREIGN KEY (network_id, charge_id, billing_match_id)
    REFERENCES operations_carrier_billing_matches(network_id, charge_id, id)
    ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT operations_gl_coding_run_items_assignment_charge_fkey
    FOREIGN KEY (network_id, charge_id, shipper_assignment_id)
    REFERENCES operations_carrier_billing_shipper_assignments(
      network_id, charge_id, id
    ) ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT operations_gl_coding_run_items_rule_version_fkey
    FOREIGN KEY (network_id, routing_rule_id, routing_rule_version)
    REFERENCES operations_carrier_billing_routing_rules(
      network_id, id, version_number
    ) ON DELETE RESTRICT NOT VALID;

CREATE OR REPLACE FUNCTION validate_operations_gl_coding_run_item()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  charge_in_selected_batch boolean;
  matched_decision text;
  match_is_current boolean;
  assignment_decision text;
  assignment_source text;
  assignment_match_id uuid;
  assignment_rule_id uuid;
  assignment_rule_version integer;
  assignment_run_id uuid;
  assignment_outputs jsonb;
  assignment_is_current boolean;
  run_status text;
BEGIN
  SELECT run.status
  INTO run_status
  FROM operations_gl_coding_runs run
  WHERE run.network_id = NEW.network_id
    AND run.id = NEW.run_id;

  IF run_status IS DISTINCT FROM 'running' THEN
    RAISE EXCEPTION 'GL Coding run items require a running GL Coding run';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM operations_carrier_billing_charges charge
    JOIN operations_carrier_billing_statements statement
      ON statement.network_id = charge.network_id
     AND statement.id = charge.statement_id
    JOIN operations_gl_coding_run_batches selected
      ON selected.network_id = statement.network_id
     AND selected.batch_id = statement.batch_id
     AND selected.run_id = NEW.run_id
    WHERE charge.network_id = NEW.network_id
      AND charge.id = NEW.charge_id
  )
  INTO charge_in_selected_batch;

  IF charge_in_selected_batch IS DISTINCT FROM true THEN
    RAISE EXCEPTION
      'GL Coding run item charge is not part of a selected billing file';
  END IF;

  IF NEW.billing_match_id IS NULL THEN
    IF NEW.shipment_match_status <> 'unmatched' THEN
      RAISE EXCEPTION
        'GL Coding item without match evidence must remain shipment-unmatched';
    END IF;
  ELSE
    SELECT
      match_decision.decision,
      NOT EXISTS (
        SELECT 1
        FROM operations_carrier_billing_matches child
        WHERE child.network_id = match_decision.network_id
          AND child.charge_id = match_decision.charge_id
          AND child.supersedes_match_id = match_decision.id
      )
    INTO matched_decision, match_is_current
    FROM operations_carrier_billing_matches match_decision
    WHERE match_decision.network_id = NEW.network_id
      AND match_decision.charge_id = NEW.charge_id
      AND match_decision.id = NEW.billing_match_id;

    IF matched_decision IS DISTINCT FROM NEW.shipment_match_status
       OR match_is_current IS DISTINCT FROM true THEN
      RAISE EXCEPTION
        'GL Coding item must preserve the current shipment-match decision';
    END IF;
  END IF;

  IF NEW.shipper_assignment_id IS NULL THEN
    IF NEW.shipper_assignment_status NOT IN ('unassigned', 'ambiguous')
       OR NEW.routing_rule_id IS NOT NULL
       OR NEW.routing_rule_version IS NOT NULL THEN
      RAISE EXCEPTION
        'GL Coding item without assignment evidence cannot claim an assignment or rule';
    END IF;
  ELSE
    SELECT
      assignment.decision,
      assignment.assignment_source,
      assignment.billing_match_id,
      assignment.routing_rule_id,
      assignment.routing_rule_version,
      assignment.gl_coding_run_id,
      assignment.coding_outputs,
      NOT EXISTS (
        SELECT 1
        FROM operations_carrier_billing_shipper_assignments child
        WHERE child.network_id = assignment.network_id
          AND child.charge_id = assignment.charge_id
          AND child.supersedes_assignment_id = assignment.id
      )
    INTO
      assignment_decision,
      assignment_source,
      assignment_match_id,
      assignment_rule_id,
      assignment_rule_version,
      assignment_run_id,
      assignment_outputs,
      assignment_is_current
    FROM operations_carrier_billing_shipper_assignments assignment
    WHERE assignment.network_id = NEW.network_id
      AND assignment.charge_id = NEW.charge_id
      AND assignment.id = NEW.shipper_assignment_id;

    IF assignment_decision IS DISTINCT FROM NEW.shipper_assignment_status
       OR assignment_is_current IS DISTINCT FROM true THEN
      RAISE EXCEPTION
        'GL Coding item must preserve the current shipper-assignment decision';
    END IF;
    IF NEW.coding_outputs IS DISTINCT FROM assignment_outputs THEN
      RAISE EXCEPTION
        'GL Coding item must preserve the assignment coding output snapshot';
    END IF;

    IF assignment_source = 'shipment_match' THEN
      IF NEW.billing_match_id IS DISTINCT FROM assignment_match_id
         OR NEW.routing_rule_id IS NOT NULL
         OR NEW.routing_rule_version IS NOT NULL THEN
        RAISE EXCEPTION
          'Shipment-derived GL assignment must reference only its shipment match';
      END IF;
    ELSIF assignment_source = 'manual' THEN
      IF NEW.routing_rule_id IS NOT NULL
         OR NEW.routing_rule_version IS NOT NULL THEN
        RAISE EXCEPTION
          'Manual GL assignment cannot claim routing-rule evidence';
      END IF;
    ELSIF assignment_source = 'routing_rule' THEN
      IF assignment_run_id IS DISTINCT FROM NEW.run_id
         OR NEW.routing_rule_id IS DISTINCT FROM assignment_rule_id
         OR NEW.routing_rule_version
           IS DISTINCT FROM assignment_rule_version THEN
        RAISE EXCEPTION
          'Rule-derived GL item must preserve its run and exact rule version';
      END IF;
    ELSIF NEW.routing_rule_id IS NOT NULL
       OR NEW.routing_rule_version IS NOT NULL THEN
      RAISE EXCEPTION
        'Unassigned GL item cannot claim routing-rule evidence';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

ALTER TABLE operations_settlement_entries
  ADD COLUMN IF NOT EXISTS billing_statement_id uuid,
  ADD COLUMN IF NOT EXISTS billing_charge_id uuid,
  ADD COLUMN IF NOT EXISTS billing_account_resolution_id uuid,
  ADD COLUMN IF NOT EXISTS shipper_assignment_id uuid,
  ADD COLUMN IF NOT EXISTS cost_basis text,
  ADD COLUMN IF NOT EXISTS source_charge_amount_minor bigint,
  ALTER COLUMN quote_snapshot_id DROP NOT NULL;

ALTER TABLE operations_settlement_entries
  DROP CONSTRAINT IF EXISTS operations_settlement_entries_amount_minor_check,
  DROP CONSTRAINT IF EXISTS operations_settlement_entries_source_type_check,
  ADD CONSTRAINT operations_settlement_entries_amount_valid CHECK (
    (
      settlement_type = 'platform_fee'
      AND amount_minor >= 0
    )
    OR (
      settlement_type <> 'platform_fee'
      AND amount_minor > 0
    )
  ),
  ADD CONSTRAINT operations_settlement_entries_source_type_valid CHECK (
    source_type IN (
      'quote_snapshot', 'shipper_assignment',
      'carrier_reconciliation', 'manual_adjustment'
    )
  ),
  ADD CONSTRAINT operations_settlement_entries_source_provenance_valid CHECK (
    cost_basis IS NOT NULL
    AND (
      (
        source_type = 'quote_snapshot'
        AND quote_snapshot_id IS NOT NULL
        AND billing_statement_id IS NULL
        AND billing_charge_id IS NULL
        AND billing_account_resolution_id IS NULL
        AND shipper_assignment_id IS NULL
        AND cost_basis = 'quoted_pro_forma'
        AND source_charge_amount_minor IS NULL
      )
      OR (
        source_type = 'shipper_assignment'
        AND quote_snapshot_id IS NULL
        AND billing_statement_id IS NOT NULL
        AND billing_charge_id IS NOT NULL
        AND billing_account_resolution_id IS NOT NULL
        AND shipper_assignment_id IS NOT NULL
        AND cost_basis = 'billed_actual'
        AND source_charge_amount_minor IS NOT NULL
      )
      OR (
        source_type = 'carrier_reconciliation'
        AND quote_snapshot_id IS NOT NULL
        AND billing_statement_id IS NULL
        AND billing_charge_id IS NULL
        AND billing_account_resolution_id IS NULL
        AND shipper_assignment_id IS NULL
        AND cost_basis = 'billed_actual'
        AND source_charge_amount_minor IS NULL
      )
      OR (
        source_type = 'manual_adjustment'
        AND quote_snapshot_id IS NOT NULL
        AND billing_statement_id IS NULL
        AND billing_charge_id IS NULL
        AND billing_account_resolution_id IS NULL
        AND shipper_assignment_id IS NULL
        AND cost_basis = 'manual_adjustment'
        AND source_charge_amount_minor IS NULL
      )
    )
  ) NOT VALID,
  ADD CONSTRAINT operations_settlement_entries_charge_fkey
    FOREIGN KEY (network_id, billing_statement_id, billing_charge_id)
    REFERENCES operations_carrier_billing_charges(
      network_id, statement_id, id
    ) ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT operations_settlement_entries_account_resolution_fkey
    FOREIGN KEY (
      network_id, billing_statement_id, account_authorization_id,
      carrier_account_id, billing_account_resolution_id
    )
    REFERENCES operations_carrier_billing_account_resolutions(
      network_id, statement_id, account_authorization_id,
      carrier_account_id, id
    ) ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT operations_settlement_entries_assignment_fkey
    FOREIGN KEY (network_id, billing_charge_id, shipper_assignment_id)
    REFERENCES operations_carrier_billing_shipper_assignments(
      network_id, charge_id, id
    ) ON DELETE RESTRICT NOT VALID;

CREATE OR REPLACE FUNCTION validate_operations_settlement_entry_source()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  quote_global_id text;
  quote_platform_fee_minor bigint;
  quote_currency text;
  quote_shipper_party_id uuid;
  platform_party_id uuid;
  assignment_global_id text;
  assignment_source text;
  assignment_decision text;
  assignment_is_current boolean;
  assignment_organization_id uuid;
  charge_statement_id uuid;
  charge_amount_minor bigint;
  charge_currency text;
  resolution_decision text;
  resolution_authorization_id uuid;
  resolution_carrier_account_id uuid;
  resolution_is_current boolean;
BEGIN
  IF NEW.source_type = 'quote_snapshot' THEN
    SELECT
      quote.global_id,
      quote.platform_fee_minor,
      quote.currency,
      quote.shipper_party_id,
      platform.id
    INTO
      quote_global_id,
      quote_platform_fee_minor,
      quote_currency,
      quote_shipper_party_id,
      platform_party_id
    FROM operations_carrier_quote_snapshots quote
    JOIN operations_carrier_rate_parties platform
      ON platform.network_id = quote.network_id
     AND platform.role = 'platform_operator'
    WHERE quote.network_id = NEW.network_id
      AND quote.executing_organization_id = NEW.executing_organization_id
      AND quote.account_authorization_id = NEW.account_authorization_id
      AND quote.carrier_account_id = NEW.carrier_account_id
      AND quote.id = NEW.quote_snapshot_id
    FOR UPDATE OF quote;

    IF quote_global_id IS NULL THEN
      RAISE EXCEPTION
        'Quote-sourced settlement requires an exact scoped quote snapshot';
    END IF;
    IF NEW.source_global_id IS DISTINCT FROM quote_global_id THEN
      RAISE EXCEPTION
        'Quote-sourced settlement global source does not match its quote';
    END IF;

    IF NEW.settlement_type = 'platform_fee' THEN
      IF NEW.payer_type IS DISTINCT FROM 'rate_party'
         OR NEW.payer_party_id IS DISTINCT FROM quote_shipper_party_id
         OR NEW.payee_type IS DISTINCT FROM 'rate_party'
         OR NEW.payee_party_id IS DISTINCT FROM platform_party_id
         OR NEW.amount_minor IS DISTINCT FROM quote_platform_fee_minor
         OR NEW.currency IS DISTINCT FROM quote_currency THEN
        RAISE EXCEPTION
          'Platform fee settlement must preserve Triangle participation and the quoted fee, including zero';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM operations_settlement_entries existing
        WHERE existing.network_id = NEW.network_id
          AND existing.quote_snapshot_id = NEW.quote_snapshot_id
          AND existing.settlement_type = 'platform_fee'
          AND existing.reverses_entry_id IS NULL
      ) THEN
        RAISE EXCEPTION
          'Quote already has an initial Triangle platform fee settlement';
      END IF;
    END IF;

    RETURN NEW;
  END IF;

  IF NEW.source_type = 'shipper_assignment' THEN
    PERFORM 1
    FROM operations_carrier_billing_charges charge
    WHERE charge.network_id = NEW.network_id
      AND charge.id = NEW.billing_charge_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'Assignment-sourced settlement requires an existing network charge';
    END IF;

    SELECT
      assignment.global_id,
      assignment.assignment_source,
      assignment.decision,
      NOT EXISTS (
        SELECT 1
        FROM operations_carrier_billing_shipper_assignments child
        WHERE child.network_id = assignment.network_id
          AND child.charge_id = assignment.charge_id
          AND child.supersedes_assignment_id = assignment.id
      ),
      COALESCE(
        shipper.workspace_organization_id,
        shipper_pipeline.workspace_organization_id
      ),
      charge.statement_id,
      charge.amount_minor,
      charge.currency,
      resolution.decision,
      resolution.account_authorization_id,
      resolution.carrier_account_id,
      NOT EXISTS (
        SELECT 1
        FROM operations_carrier_billing_account_resolutions child
        WHERE child.network_id = resolution.network_id
          AND child.statement_id = resolution.statement_id
          AND child.supersedes_resolution_id = resolution.id
      )
    INTO
      assignment_global_id,
      assignment_source,
      assignment_decision,
      assignment_is_current,
      assignment_organization_id,
      charge_statement_id,
      charge_amount_minor,
      charge_currency,
      resolution_decision,
      resolution_authorization_id,
      resolution_carrier_account_id,
      resolution_is_current
    FROM operations_carrier_billing_shipper_assignments assignment
    JOIN operations_carrier_billing_charges charge
      ON charge.network_id = assignment.network_id
     AND charge.id = assignment.charge_id
    JOIN operations_carrier_billing_account_resolutions resolution
      ON resolution.network_id = charge.network_id
     AND resolution.statement_id = charge.statement_id
     AND resolution.id = NEW.billing_account_resolution_id
    JOIN operations_carrier_rate_parties shipper
      ON shipper.network_id = assignment.network_id
     AND shipper.id = assignment.shipper_party_id
     AND shipper.role = 'shipper'
    LEFT JOIN pipeline_spaces shipper_pipeline
      ON shipper.entity_type = 'crm_customer'
     AND shipper_pipeline.id = shipper.crm_pipeline_id
    WHERE assignment.network_id = NEW.network_id
      AND assignment.charge_id = NEW.billing_charge_id
      AND assignment.id = NEW.shipper_assignment_id;

    IF assignment_global_id IS NULL THEN
      RAISE EXCEPTION
        'Assignment-sourced settlement requires an exact network charge and assignment';
    END IF;
    IF assignment_source NOT IN ('manual', 'routing_rule')
       OR assignment_decision IS DISTINCT FROM 'assigned'
       OR assignment_is_current IS DISTINCT FROM true THEN
      RAISE EXCEPTION
        'Assignment-sourced settlement requires the current manual or routing-rule assignment';
    END IF;
    IF assignment_organization_id
         IS DISTINCT FROM NEW.executing_organization_id THEN
      RAISE EXCEPTION
        'Assignment-sourced settlement organization does not own the assigned shipper';
    END IF;
    IF charge_statement_id IS DISTINCT FROM NEW.billing_statement_id THEN
      RAISE EXCEPTION
        'Assignment-sourced settlement statement does not own its charge';
    END IF;
    IF resolution_decision IS DISTINCT FROM 'matched'
       OR resolution_is_current IS DISTINCT FROM true
       OR resolution_authorization_id
         IS DISTINCT FROM NEW.account_authorization_id
       OR resolution_carrier_account_id
         IS DISTINCT FROM NEW.carrier_account_id THEN
      RAISE EXCEPTION
        'Assignment-sourced settlement requires the current exact account resolution';
    END IF;
    IF NEW.source_charge_amount_minor IS DISTINCT FROM charge_amount_minor
       OR NEW.currency IS DISTINCT FROM charge_currency THEN
      RAISE EXCEPTION
        'Assignment-sourced settlement must preserve the billed actual charge and currency';
    END IF;
    IF NEW.source_global_id IS DISTINCT FROM assignment_global_id THEN
      RAISE EXCEPTION
        'Assignment-sourced settlement global source does not match its assignment';
    END IF;

    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_operations_settlement_entry_source_write
  ON operations_settlement_entries;
CREATE TRIGGER validate_operations_settlement_entry_source_write
BEFORE INSERT ON operations_settlement_entries
FOR EACH ROW EXECUTE FUNCTION validate_operations_settlement_entry_source();

CREATE OR REPLACE FUNCTION require_operations_triangle_platform_fee()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  requires_platform_fee boolean;
  platform_party_id uuid;
  platform_fee_count integer;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(NEW.party_path_snapshot) party
    WHERE party->>'role' = 'reseller'
  )
  INTO requires_platform_fee;

  IF requires_platform_fee IS DISTINCT FROM true THEN
    RETURN NULL;
  END IF;

  SELECT party.id
  INTO platform_party_id
  FROM operations_carrier_rate_parties party
  WHERE party.network_id = NEW.network_id
    AND party.role = 'platform_operator';

  IF platform_party_id IS NULL THEN
    RAISE EXCEPTION
      'Square-to-circle quote requires a Triangle platform party';
  END IF;

  SELECT count(*)
  INTO platform_fee_count
  FROM operations_settlement_entries settlement
  WHERE settlement.network_id = NEW.network_id
    AND settlement.quote_snapshot_id = NEW.id
    AND settlement.source_type = 'quote_snapshot'
    AND settlement.settlement_type = 'platform_fee'
    AND settlement.payer_type = 'rate_party'
    AND settlement.payer_party_id = NEW.shipper_party_id
    AND settlement.payee_type = 'rate_party'
    AND settlement.payee_party_id = platform_party_id
    AND settlement.amount_minor = NEW.platform_fee_minor
    AND settlement.currency = NEW.currency
    AND settlement.reverses_entry_id IS NULL;

  IF platform_fee_count <> 1 THEN
    RAISE EXCEPTION
      'Square-to-circle quote requires exactly one Triangle platform fee settlement, including a zero fee';
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS require_operations_triangle_platform_fee_write
  ON operations_carrier_quote_snapshots;
CREATE CONSTRAINT TRIGGER require_operations_triangle_platform_fee_write
AFTER INSERT ON operations_carrier_quote_snapshots
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION require_operations_triangle_platform_fee();

COMMENT ON VIEW operations_carrier_account_identities IS
  'Searchable multi-account carrier identities containing fingerprints and masked metadata only; secrets remain outside this view.';
COMMENT ON COLUMN operations_carrier_billing_account_resolutions.account_number_fingerprint_snapshot IS
  'Non-secret exact identity of the billed carrier account selected for this immutable decision.';
COMMENT ON COLUMN operations_carrier_billing_matches.tracking_number_snapshot IS
  'Canonical tracking identity proven equal across billed charge, shipment, and label at match time.';
COMMENT ON COLUMN operations_carrier_billing_matches.quote_snapshot_id IS
  'Tender quote proving which carrier account created the shipment; independent of economic shipper assignment.';
COMMENT ON COLUMN operations_carrier_billing_charges.amount_minor IS
  'Actual signed carrier-billed charge from immutable imported billing evidence.';
COMMENT ON COLUMN operations_carrier_quote_snapshots.quoted_carrier_cost_minor IS
  'Pro forma carrier quote used for tender and pricing; never substituted for actual billed charge evidence.';
COMMENT ON COLUMN operations_settlement_entries.cost_basis IS
  'quoted_pro_forma for quote economics, billed_actual for carrier-bill evidence, or manual_adjustment for an explicit adjustment.';
COMMENT ON COLUMN operations_settlement_entries.source_charge_amount_minor IS
  'Signed actual carrier-billed amount preserved when settlement provenance is a manual or routing-rule shipper assignment.';
