-- Immutable billing-time Markup Directive (MUD) evidence.
--
-- A checkout shipping charge is pro forma customer-facing evidence. It is not
-- a carrier invoice and it is never treated as MUD. MUD is evaluated only
-- after imported carrier-billing rows have an approved GL Coding review, an
-- exact shipment match, and an applicable actual-cost directive.

INSERT INTO global_reference_entity_types (prefix, entity_type, display_name)
VALUES (
  'gbm',
  'operations.carrier_billing_mud_calculation',
  'Carrier billing MUD calculation'
)
ON CONFLICT (prefix) DO UPDATE SET
  entity_type = EXCLUDED.entity_type,
  display_name = EXCLUDED.display_name;

CREATE TABLE IF NOT EXISTS operations_carrier_billing_mud_calculations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gbm'),
  network_id uuid NOT NULL,
  gl_coding_review_id uuid NOT NULL,
  billing_statement_id uuid NOT NULL,
  billing_statement_lineage_key text NOT NULL
    CHECK (billing_statement_lineage_key ~ '^[a-f0-9]{64}$'),
  billing_statement_version integer NOT NULL
    CHECK (billing_statement_version > 0),
  executing_organization_id uuid NOT NULL,
  shipment_id uuid NOT NULL,
  order_id uuid NOT NULL,
  shipper_party_id uuid NOT NULL,
  quote_snapshot_id uuid NOT NULL,
  account_authorization_id uuid NOT NULL,
  carrier_account_id uuid NOT NULL,
  contract_version_id uuid,
  commerce_order_candidate_id uuid,
  status text NOT NULL CHECK (
    status IN ('not_configured', 'calculated', 'blocked')
  ),
  blocker_code text,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  checkout_charge_status text NOT NULL CHECK (
    checkout_charge_status IN (
      'customer_paid',
      'not_captured',
      'unallocated_multi_shipment',
      'unavailable'
    )
  ),
  customer_paid_checkout_shipping_minor bigint,
  carrier_billed_actual_minor bigint NOT NULL,
  mud_adjustment_minor bigint,
  contract_billed_shipping_minor bigint,
  checkout_to_carrier_actual_variance_minor bigint,
  checkout_to_contract_bill_variance_minor bigint,
  charge_count integer NOT NULL CHECK (charge_count > 0),
  directive_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  calculation_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  input_hash text NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  idempotency_key text NOT NULL,
  actor_email text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_carrier_billing_mud_global_valid
    CHECK (global_id ~ '^gbm[0-9]{7}$'),
  CONSTRAINT operations_carrier_billing_mud_global_unique
    UNIQUE (global_id),
  CONSTRAINT operations_carrier_billing_mud_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_billing_mud_review_fkey
    FOREIGN KEY (network_id, gl_coding_review_id)
    REFERENCES operations_gl_coding_reviews(network_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_billing_mud_statement_fkey
    FOREIGN KEY (network_id, billing_statement_id)
    REFERENCES operations_carrier_billing_statements(network_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_billing_mud_shipment_fkey
    FOREIGN KEY (executing_organization_id, shipment_id)
    REFERENCES operations_shipments(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_billing_mud_order_fkey
    FOREIGN KEY (executing_organization_id, order_id)
    REFERENCES operations_orders(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_billing_mud_shipper_fkey
    FOREIGN KEY (network_id, shipper_party_id)
    REFERENCES operations_carrier_rate_parties(network_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_billing_mud_quote_fkey
    FOREIGN KEY (
      network_id, executing_organization_id, account_authorization_id,
      carrier_account_id, quote_snapshot_id
    )
    REFERENCES operations_carrier_quote_snapshots(
      network_id, executing_organization_id, account_authorization_id,
      carrier_account_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_billing_mud_contract_fkey
    FOREIGN KEY (executing_organization_id, contract_version_id)
    REFERENCES operations_contract_versions(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_billing_mud_candidate_fkey
    FOREIGN KEY (commerce_order_candidate_id)
    REFERENCES operations_commerce_order_candidates(id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_billing_mud_lineage_unique
    UNIQUE (
      network_id, billing_statement_lineage_key,
      billing_statement_version, shipment_id, currency
    ),
  CONSTRAINT operations_carrier_billing_mud_idempotency_unique
    UNIQUE (network_id, idempotency_key),
  CONSTRAINT operations_carrier_billing_mud_network_id_unique
    UNIQUE (network_id, id),
  CONSTRAINT operations_carrier_billing_mud_snapshots_valid CHECK (
    jsonb_typeof(directive_snapshot) = 'array'
    AND jsonb_typeof(calculation_snapshot) = 'object'
  ),
  CONSTRAINT operations_carrier_billing_mud_blocker_valid CHECK (
    (
      status = 'blocked'
      AND NULLIF(btrim(blocker_code), '') IS NOT NULL
    )
    OR (
      status <> 'blocked'
      AND blocker_code IS NULL
    )
  ),
  CONSTRAINT operations_carrier_billing_mud_checkout_valid CHECK (
    (
      checkout_charge_status = 'customer_paid'
      AND commerce_order_candidate_id IS NOT NULL
      AND customer_paid_checkout_shipping_minor IS NOT NULL
      AND customer_paid_checkout_shipping_minor >= 0
      AND checkout_to_carrier_actual_variance_minor IS NOT NULL
      AND checkout_to_carrier_actual_variance_minor
        = customer_paid_checkout_shipping_minor
          - carrier_billed_actual_minor
    )
    OR (
      checkout_charge_status <> 'customer_paid'
      AND customer_paid_checkout_shipping_minor IS NULL
      AND checkout_to_carrier_actual_variance_minor IS NULL
    )
  ),
  CONSTRAINT operations_carrier_billing_mud_result_valid CHECK (
    (
      status = 'calculated'
      AND contract_version_id IS NOT NULL
      AND carrier_billed_actual_minor >= 0
      AND mud_adjustment_minor IS NOT NULL
      AND mud_adjustment_minor >= 0
      AND contract_billed_shipping_minor IS NOT NULL
      AND contract_billed_shipping_minor
        = carrier_billed_actual_minor + mud_adjustment_minor
      AND (
        (
          customer_paid_checkout_shipping_minor IS NOT NULL
          AND checkout_to_contract_bill_variance_minor
            = customer_paid_checkout_shipping_minor
              - contract_billed_shipping_minor
        )
        OR (
          customer_paid_checkout_shipping_minor IS NULL
          AND checkout_to_contract_bill_variance_minor IS NULL
        )
      )
    )
    OR (
      status IN ('not_configured', 'blocked')
      AND mud_adjustment_minor IS NULL
      AND contract_billed_shipping_minor IS NULL
      AND checkout_to_contract_bill_variance_minor IS NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS
  operations_carrier_billing_mud_shipment_idx
  ON operations_carrier_billing_mud_calculations (
    executing_organization_id, shipment_id, created_at DESC, id
  );

CREATE TABLE IF NOT EXISTS
  operations_carrier_billing_mud_calculation_charges (
    network_id uuid NOT NULL,
    calculation_id uuid NOT NULL,
    billing_statement_id uuid NOT NULL,
    billing_charge_id uuid NOT NULL,
    billing_match_id uuid NOT NULL,
    shipper_assignment_id uuid NOT NULL,
    gl_coding_review_item_id uuid NOT NULL,
    source_charge_amount_minor bigint NOT NULL,
    currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (calculation_id, billing_charge_id),
    CONSTRAINT operations_carrier_billing_mud_charges_calculation_fkey
      FOREIGN KEY (network_id, calculation_id)
      REFERENCES operations_carrier_billing_mud_calculations(network_id, id)
      ON DELETE RESTRICT,
    CONSTRAINT operations_carrier_billing_mud_charges_charge_fkey
      FOREIGN KEY (
        network_id, billing_statement_id, billing_charge_id
      )
      REFERENCES operations_carrier_billing_charges(
        network_id, statement_id, id
      ) ON DELETE RESTRICT,
    CONSTRAINT operations_carrier_billing_mud_charges_match_fkey
      FOREIGN KEY (network_id, billing_charge_id, billing_match_id)
      REFERENCES operations_carrier_billing_matches(
        network_id, charge_id, id
      ) ON DELETE RESTRICT,
    CONSTRAINT operations_carrier_billing_mud_charges_assignment_fkey
      FOREIGN KEY (
        network_id, billing_charge_id, shipper_assignment_id
      )
      REFERENCES operations_carrier_billing_shipper_assignments(
        network_id, charge_id, id
      ) ON DELETE RESTRICT,
    CONSTRAINT operations_carrier_billing_mud_charges_review_item_fkey
      FOREIGN KEY (network_id, gl_coding_review_item_id)
      REFERENCES operations_gl_coding_review_items(network_id, id)
      ON DELETE RESTRICT,
    CONSTRAINT operations_carrier_billing_mud_charges_charge_unique
      UNIQUE (network_id, billing_charge_id)
  );

CREATE TABLE IF NOT EXISTS
  operations_carrier_billing_mud_calculation_directives (
    network_id uuid NOT NULL,
    calculation_id uuid NOT NULL,
    account_authorization_id uuid NOT NULL,
    grant_id uuid NOT NULL,
    directive_id uuid NOT NULL,
    directive_version integer NOT NULL CHECK (directive_version > 0),
    directive_priority integer NOT NULL,
    directive_type text NOT NULL CHECK (
      directive_type IN (
        'fixed_amount', 'percent_markup', 'cost_plus_percent',
        'minimum_charge', 'maximum_charge'
      )
    ),
    amount_minor bigint,
    basis_points integer,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (calculation_id, directive_id),
    CONSTRAINT operations_carrier_billing_mud_directives_calculation_fkey
      FOREIGN KEY (network_id, calculation_id)
      REFERENCES operations_carrier_billing_mud_calculations(network_id, id)
      ON DELETE RESTRICT,
    CONSTRAINT operations_carrier_billing_mud_directives_grant_fkey
      FOREIGN KEY (network_id, account_authorization_id, grant_id)
      REFERENCES operations_carrier_rate_grants(
        network_id, account_authorization_id, id
      ) ON DELETE RESTRICT,
    CONSTRAINT operations_carrier_billing_mud_directives_directive_fkey
      FOREIGN KEY (network_id, directive_id)
      REFERENCES operations_carrier_rate_directives(network_id, id)
      ON DELETE RESTRICT,
    CONSTRAINT operations_carrier_billing_mud_directives_value_valid CHECK (
      (
        directive_type IN (
          'fixed_amount', 'minimum_charge', 'maximum_charge'
        )
        AND amount_minor IS NOT NULL
        AND amount_minor >= 0
        AND basis_points IS NULL
      )
      OR (
        directive_type IN ('percent_markup', 'cost_plus_percent')
        AND basis_points IS NOT NULL
        AND basis_points BETWEEN 0 AND 100000
        AND amount_minor IS NULL
      )
    )
  );

CREATE OR REPLACE FUNCTION
  protect_operations_carrier_billing_mud_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Carrier billing MUD evidence is append-only';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION
  canonical_operations_billing_jsonb(input_value jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
DECLARE
  serialized text;
BEGIN
  CASE jsonb_typeof(input_value)
    WHEN 'object' THEN
      SELECT
        '{' || COALESCE(
          string_agg(
            to_jsonb(entry.key)::text
              || ':'
              || canonical_operations_billing_jsonb(entry.value),
            ',' ORDER BY entry.key
          ),
          ''
        ) || '}'
      INTO serialized
      FROM jsonb_each(input_value) entry;
    WHEN 'array' THEN
      SELECT
        '[' || COALESCE(
          string_agg(
            canonical_operations_billing_jsonb(element.value),
            ',' ORDER BY element.ordinality
          ),
          ''
        ) || ']'
      INTO serialized
      FROM jsonb_array_elements(input_value)
        WITH ORDINALITY AS element(value, ordinality);
    ELSE
      serialized := input_value::text;
  END CASE;
  RETURN serialized;
END;
$$;

CREATE OR REPLACE FUNCTION
  validate_operations_carrier_billing_mud_calculation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  review_decision text;
  statement_version integer;
  statement_lineage_key text;
  statement_source_format text;
  shipment_order_id uuid;
  quote_order_id uuid;
  quote_shipper_party_id uuid;
  candidate_organization_id uuid;
  candidate_order_id uuid;
  candidate_currency text;
  candidate_shipping_minor bigint;
  candidate_payment_status text;
  candidate_header_money_state text;
  active_shipment_count integer;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Carrier billing MUD calculations are append-only';
  END IF;

  SELECT review.decision
    INTO review_decision
  FROM operations_gl_coding_reviews review
  WHERE review.network_id = NEW.network_id
    AND review.id = NEW.gl_coding_review_id;
  IF review_decision IS DISTINCT FROM 'approved' THEN
    RAISE EXCEPTION
      'Carrier billing MUD calculation requires an approved GL Coding review';
  END IF;

  SELECT
    statement.version_number,
    encode(
      digest(
        statement.billed_account_fingerprint
          || ':' || statement.external_statement_id,
        'sha256'
      ),
      'hex'
    ),
    batch.source_format
  INTO
    statement_version,
    statement_lineage_key,
    statement_source_format
  FROM operations_carrier_billing_statements statement
  JOIN operations_carrier_billing_batches batch
    ON batch.network_id = statement.network_id
   AND batch.id = statement.batch_id
  WHERE statement.network_id = NEW.network_id
    AND statement.id = NEW.billing_statement_id;
  IF statement_version IS DISTINCT FROM NEW.billing_statement_version
     OR statement_lineage_key
       IS DISTINCT FROM NEW.billing_statement_lineage_key
     OR statement_source_format IS DISTINCT FROM 'csv'
  THEN
    RAISE EXCEPTION
      'Carrier billing MUD requires an uploaded CSV statement lineage';
  END IF;

  SELECT shipment.order_id
    INTO shipment_order_id
  FROM operations_shipments shipment
  WHERE shipment.organization_id = NEW.executing_organization_id
    AND shipment.id = NEW.shipment_id;
  IF shipment_order_id IS DISTINCT FROM NEW.order_id THEN
    RAISE EXCEPTION
      'Carrier billing MUD order does not own the matched shipment';
  END IF;

  SELECT quote.order_id, quote.shipper_party_id
    INTO quote_order_id, quote_shipper_party_id
  FROM operations_carrier_quote_snapshots quote
  WHERE quote.network_id = NEW.network_id
    AND quote.executing_organization_id = NEW.executing_organization_id
    AND quote.account_authorization_id = NEW.account_authorization_id
    AND quote.carrier_account_id = NEW.carrier_account_id
    AND quote.id = NEW.quote_snapshot_id;
  IF quote_order_id IS NOT NULL
     AND quote_order_id IS DISTINCT FROM NEW.order_id
  THEN
    RAISE EXCEPTION
      'Carrier billing MUD quote does not belong to the matched order';
  END IF;
  IF quote_shipper_party_id IS DISTINCT FROM NEW.shipper_party_id THEN
    RAISE EXCEPTION
      'Carrier billing MUD shipper differs from the matched quote';
  END IF;

  IF NEW.commerce_order_candidate_id IS NOT NULL THEN
    SELECT
      candidate.organization_id,
      candidate.canonical_order_id,
      candidate.currency_code,
      candidate.shipping_minor,
      candidate.normalized_payment_status,
      candidate.header_money_state
    INTO
      candidate_organization_id,
      candidate_order_id,
      candidate_currency,
      candidate_shipping_minor,
      candidate_payment_status,
      candidate_header_money_state
    FROM operations_commerce_order_candidates candidate
    WHERE candidate.id = NEW.commerce_order_candidate_id;
    IF candidate_organization_id
         IS DISTINCT FROM NEW.executing_organization_id
       OR candidate_order_id IS DISTINCT FROM NEW.order_id
       OR candidate_currency IS DISTINCT FROM NEW.currency
    THEN
      RAISE EXCEPTION
        'Carrier billing MUD checkout evidence does not belong to the matched order';
    END IF;

    SELECT count(*)::integer
      INTO active_shipment_count
    FROM operations_shipments shipment
    WHERE shipment.organization_id = NEW.executing_organization_id
      AND shipment.order_id = NEW.order_id
      AND shipment.status <> 'voided';

    IF NEW.checkout_charge_status = 'customer_paid'
       AND (
         candidate_header_money_state IS DISTINCT FROM 'complete'
         OR candidate_payment_status IS DISTINCT FROM 'paid'
         OR candidate_shipping_minor
           IS DISTINCT FROM NEW.customer_paid_checkout_shipping_minor
         OR active_shipment_count <> 1
       )
    THEN
      RAISE EXCEPTION
        'Customer-paid checkout shipping requires complete paid single-shipment evidence';
    END IF;
    IF NEW.checkout_charge_status = 'unallocated_multi_shipment'
       AND (
         candidate_header_money_state IS DISTINCT FROM 'complete'
         OR candidate_payment_status IS DISTINCT FROM 'paid'
         OR active_shipment_count <= 1
       )
    THEN
      RAISE EXCEPTION
        'Unallocated checkout shipping requires a paid multi-shipment order';
    END IF;
    IF NEW.checkout_charge_status = 'not_captured'
       AND candidate_header_money_state = 'complete'
       AND candidate_payment_status = 'paid'
    THEN
      RAISE EXCEPTION
        'Paid checkout shipping cannot be marked not captured';
    END IF;
  ELSIF NEW.checkout_charge_status <> 'unavailable' THEN
    RAISE EXCEPTION
      'Checkout charge status requires exact commerce-order evidence';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION
  validate_operations_carrier_billing_mud_charge()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  calculation_row
    operations_carrier_billing_mud_calculations%ROWTYPE;
  match_decision text;
  match_statement_id uuid;
  match_shipment_id uuid;
  match_quote_snapshot_id uuid;
  match_authorization_id uuid;
  match_carrier_account_id uuid;
  match_is_current boolean;
  assignment_decision text;
  assignment_shipper_party_id uuid;
  assignment_is_current boolean;
  review_item_review_id uuid;
  review_item_charge_id uuid;
  charge_amount_minor bigint;
  charge_currency text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Carrier billing MUD charge evidence is append-only';
  END IF;

  SELECT *
    INTO calculation_row
  FROM operations_carrier_billing_mud_calculations calculation
  WHERE calculation.network_id = NEW.network_id
    AND calculation.id = NEW.calculation_id;

  SELECT
    match_decision.decision,
    match_decision.billing_statement_id,
    match_decision.shipment_id,
    match_decision.quote_snapshot_id,
    match_decision.account_authorization_id,
    match_decision.carrier_account_id,
    NOT EXISTS (
      SELECT 1
      FROM operations_carrier_billing_matches child
      WHERE child.network_id = match_decision.network_id
        AND child.charge_id = match_decision.charge_id
        AND child.supersedes_match_id = match_decision.id
    )
  INTO
    match_decision,
    match_statement_id,
    match_shipment_id,
    match_quote_snapshot_id,
    match_authorization_id,
    match_carrier_account_id,
    match_is_current
  FROM operations_carrier_billing_matches match_decision
  WHERE match_decision.network_id = NEW.network_id
    AND match_decision.charge_id = NEW.billing_charge_id
    AND match_decision.id = NEW.billing_match_id;

  IF match_decision IS DISTINCT FROM 'matched'
     OR match_is_current IS DISTINCT FROM true
     OR match_statement_id IS DISTINCT FROM NEW.billing_statement_id
     OR match_shipment_id IS DISTINCT FROM calculation_row.shipment_id
     OR match_quote_snapshot_id
       IS DISTINCT FROM calculation_row.quote_snapshot_id
     OR match_authorization_id
       IS DISTINCT FROM calculation_row.account_authorization_id
     OR match_carrier_account_id
       IS DISTINCT FROM calculation_row.carrier_account_id
  THEN
    RAISE EXCEPTION
      'Carrier billing MUD charge requires the exact current shipment match';
  END IF;

  SELECT
    assignment.decision,
    assignment.shipper_party_id,
    NOT EXISTS (
      SELECT 1
      FROM operations_carrier_billing_shipper_assignments child
      WHERE child.network_id = assignment.network_id
        AND child.charge_id = assignment.charge_id
        AND child.supersedes_assignment_id = assignment.id
    )
    INTO
      assignment_decision,
      assignment_shipper_party_id,
      assignment_is_current
  FROM operations_carrier_billing_shipper_assignments assignment
  WHERE assignment.network_id = NEW.network_id
    AND assignment.charge_id = NEW.billing_charge_id
    AND assignment.id = NEW.shipper_assignment_id;
  IF assignment_decision IS DISTINCT FROM 'assigned'
     OR assignment_shipper_party_id
       IS DISTINCT FROM calculation_row.shipper_party_id
     OR assignment_is_current IS DISTINCT FROM true
  THEN
    RAISE EXCEPTION
      'Carrier billing MUD charge requires the exact shipper assignment';
  END IF;

  SELECT review_item.review_id, review_item.billing_charge_id
    INTO review_item_review_id, review_item_charge_id
  FROM operations_gl_coding_review_items review_item
  WHERE review_item.network_id = NEW.network_id
    AND review_item.id = NEW.gl_coding_review_item_id;
  IF review_item_review_id
       IS DISTINCT FROM calculation_row.gl_coding_review_id
     OR review_item_charge_id IS DISTINCT FROM NEW.billing_charge_id
  THEN
    RAISE EXCEPTION
      'Carrier billing MUD charge requires exact approved review evidence';
  END IF;

  SELECT charge.amount_minor, charge.currency
    INTO charge_amount_minor, charge_currency
  FROM operations_carrier_billing_charges charge
  WHERE charge.network_id = NEW.network_id
    AND charge.statement_id = NEW.billing_statement_id
    AND charge.id = NEW.billing_charge_id;
  IF charge_amount_minor IS DISTINCT FROM NEW.source_charge_amount_minor
     OR charge_currency IS DISTINCT FROM NEW.currency
     OR charge_currency IS DISTINCT FROM calculation_row.currency
  THEN
    RAISE EXCEPTION
      'Carrier billing MUD charge amount snapshot differs from imported evidence';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION
  validate_operations_carrier_billing_mud_directive()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  calculation_row
    operations_carrier_billing_mud_calculations%ROWTYPE;
  shipment_timestamp timestamptz;
  directive_record record;
  grant_record record;
  directive_is_current boolean;
  grant_is_current boolean;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Carrier billing MUD directive evidence is append-only';
  END IF;

  SELECT calculation.*
    INTO calculation_row
  FROM operations_carrier_billing_mud_calculations calculation
  WHERE calculation.network_id = NEW.network_id
    AND calculation.id = NEW.calculation_id;
  SELECT shipment.shipped_at
    INTO shipment_timestamp
  FROM operations_shipments shipment
  WHERE shipment.organization_id
      = calculation_row.executing_organization_id
    AND shipment.id = calculation_row.shipment_id;

  SELECT directive.*
    INTO directive_record
  FROM operations_carrier_rate_directives directive
  WHERE directive.network_id = NEW.network_id
    AND directive.id = NEW.directive_id;
  SELECT rate_grant.*
    INTO grant_record
  FROM operations_carrier_rate_grants rate_grant
  WHERE rate_grant.network_id = NEW.network_id
    AND rate_grant.account_authorization_id
      = NEW.account_authorization_id
    AND rate_grant.id = NEW.grant_id;

  SELECT NOT EXISTS (
    SELECT 1
    FROM operations_carrier_rate_directives child
    WHERE child.network_id = directive_record.network_id
      AND child.supersedes_directive_id = directive_record.id
      AND child.status = 'active'
      AND child.effective_from <= shipment_timestamp
      AND (
        child.effective_to IS NULL
        OR child.effective_to > shipment_timestamp
      )
  ) INTO directive_is_current;
  SELECT NOT EXISTS (
    SELECT 1
    FROM operations_carrier_rate_grants child
    WHERE child.network_id = grant_record.network_id
      AND child.supersedes_grant_id = grant_record.id
      AND child.status = 'active'
      AND child.allow_rating = true
      AND child.effective_from <= shipment_timestamp
      AND (
        child.effective_to IS NULL
        OR child.effective_to > shipment_timestamp
      )
  ) INTO grant_is_current;

  IF calculation_row.status IS DISTINCT FROM 'calculated'
     OR calculation_row.contract_version_id IS NULL
     OR shipment_timestamp IS NULL
     OR NEW.account_authorization_id
       IS DISTINCT FROM calculation_row.account_authorization_id
     OR directive_record.grant_id IS DISTINCT FROM NEW.grant_id
     OR directive_record.version_number
       IS DISTINCT FROM NEW.directive_version
     OR directive_record.priority IS DISTINCT FROM NEW.directive_priority
     OR directive_record.directive_type
       IS DISTINCT FROM NEW.directive_type
     OR directive_record.amount_minor IS DISTINCT FROM NEW.amount_minor
     OR directive_record.basis_points IS DISTINCT FROM NEW.basis_points
     OR directive_record.calculation_basis IS DISTINCT FROM 'actual_cost'
     OR directive_record.currency IS DISTINCT FROM calculation_row.currency
     OR directive_record.contract_version_id
       IS DISTINCT FROM calculation_row.contract_version_id
     OR directive_record.status IS DISTINCT FROM 'active'
     OR directive_record.approved_by IS NULL
     OR directive_record.effective_from > shipment_timestamp
     OR (
       directive_record.effective_to IS NOT NULL
       AND directive_record.effective_to <= shipment_timestamp
     )
     OR directive_is_current IS DISTINCT FROM true
     OR grant_record.grantee_party_id
       IS DISTINCT FROM calculation_row.shipper_party_id
     OR grant_record.status IS DISTINCT FROM 'active'
     OR grant_record.allow_rating IS DISTINCT FROM true
     OR grant_record.effective_from > shipment_timestamp
     OR (
       grant_record.effective_to IS NOT NULL
       AND grant_record.effective_to <= shipment_timestamp
     )
     OR grant_is_current IS DISTINCT FROM true
  THEN
    RAISE EXCEPTION
      'Carrier billing MUD directive is not the applicable approved actual-cost version';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION
  validate_operations_carrier_billing_mud_complete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_calculation_id uuid;
  calculation_row
    operations_carrier_billing_mud_calculations%ROWTYPE;
  evidence_charge_count integer;
  evidence_charge_total bigint;
  expected_charge_snapshot jsonb;
  directive_count integer;
  directive_grant_count integer;
  candidate_directive_count integer;
  candidate_grant_count integer;
  directive_record record;
  additive_minor bigint := 0;
  minimum_minor bigint;
  maximum_minor bigint;
  expected_contract_billed_minor bigint;
  expected_mud_adjustment_minor bigint;
  expected_directive_snapshot jsonb;
  expected_candidate_snapshot jsonb;
  expected_checkout_snapshot jsonb;
  expected_calculation_snapshot jsonb;
  expected_input_hash text;
  expected_configuration_reason text;
  shipment_timestamp timestamptz;
  active_shipment_count integer;
  review_global_id text;
  statement_global_id text;
  shipment_global_id text;
  order_global_id text;
  quote_snapshot_global_id text;
  contract_version_global_id text;
  shipper_party_global_id text;
  candidate_global_id text;
  candidate_payment_status text;
  candidate_header_money_state text;
BEGIN
  target_calculation_id := CASE
    WHEN TG_TABLE_NAME = 'operations_carrier_billing_mud_calculations'
      THEN NEW.id
    ELSE NEW.calculation_id
  END;

  SELECT *
    INTO calculation_row
  FROM operations_carrier_billing_mud_calculations calculation
  WHERE calculation.id = target_calculation_id;
  IF calculation_row.id IS NULL THEN
    RAISE EXCEPTION
      'Carrier billing MUD calculation evidence is missing its parent';
  END IF;

  SELECT
    count(*)::integer,
    COALESCE(sum(evidence.source_charge_amount_minor), 0),
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'chargeGlobalId', source_charge.global_id,
          'billingMatchGlobalId', source_match.global_id,
          'amountMinor', source_charge.amount_minor::text,
          'currency', source_charge.currency
        )
        ORDER BY source_charge.global_id
      ),
      '[]'::jsonb
    )
    INTO
      evidence_charge_count,
      evidence_charge_total,
      expected_charge_snapshot
  FROM operations_carrier_billing_mud_calculation_charges evidence
  JOIN operations_carrier_billing_charges source_charge
    ON source_charge.network_id = evidence.network_id
   AND source_charge.id = evidence.billing_charge_id
  JOIN operations_carrier_billing_matches source_match
    ON source_match.network_id = evidence.network_id
   AND source_match.id = evidence.billing_match_id
  WHERE evidence.network_id = calculation_row.network_id
    AND evidence.calculation_id = calculation_row.id;
  SELECT
    count(*)::integer,
    count(DISTINCT evidence.grant_id)::integer,
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'grantGlobalId', rate_grant.global_id,
          'directiveGlobalId', source_directive.global_id,
          'versionNumber', source_directive.version_number,
          'priority', source_directive.priority,
          'type', source_directive.directive_type,
          'amountMinor', CASE
            WHEN source_directive.amount_minor IS NULL THEN NULL
            ELSE to_jsonb(source_directive.amount_minor::text)
          END,
          'basisPoints', source_directive.basis_points,
          'calculationBasis', source_directive.calculation_basis,
          'approvedBy', source_directive.approved_by,
          'contractVersionGlobalId', contract_version.global_id
        )
        ORDER BY
          source_directive.priority,
          source_directive.global_id
      ),
      '[]'::jsonb
    )
    INTO
      directive_count,
      directive_grant_count,
      expected_directive_snapshot
  FROM operations_carrier_billing_mud_calculation_directives evidence
  JOIN operations_carrier_rate_grants rate_grant
    ON rate_grant.network_id = evidence.network_id
   AND rate_grant.id = evidence.grant_id
  JOIN operations_carrier_rate_directives source_directive
    ON source_directive.network_id = evidence.network_id
   AND source_directive.id = evidence.directive_id
  JOIN operations_contract_versions contract_version
    ON contract_version.id = source_directive.contract_version_id
  WHERE evidence.network_id = calculation_row.network_id
    AND evidence.calculation_id = calculation_row.id;

  SELECT shipment.shipped_at
    INTO shipment_timestamp
  FROM operations_shipments shipment
  WHERE shipment.organization_id
      = calculation_row.executing_organization_id
    AND shipment.id = calculation_row.shipment_id;
  IF shipment_timestamp IS NULL THEN
    RAISE EXCEPTION
      'Carrier billing MUD requires a shipped shipment timestamp';
  END IF;

  SELECT
    count(*)::integer,
    count(DISTINCT rate_grant.id)::integer,
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'grantGlobalId', rate_grant.global_id,
          'directiveGlobalId', source_directive.global_id,
          'versionNumber', source_directive.version_number,
          'priority', source_directive.priority,
          'type', source_directive.directive_type,
          'amountMinor', source_directive.amount_minor::text,
          'basisPoints', source_directive.basis_points,
          'calculationBasis', source_directive.calculation_basis,
          'approvedBy', source_directive.approved_by,
          'contractVersionGlobalId', contract_version.global_id
        )
        ORDER BY
          rate_grant.global_id,
          source_directive.priority,
          source_directive.global_id
      ),
      '[]'::jsonb
    )
    INTO
      candidate_directive_count,
      candidate_grant_count,
      expected_candidate_snapshot
  FROM operations_carrier_rate_grants rate_grant
  JOIN operations_carrier_rate_directives source_directive
    ON source_directive.network_id = rate_grant.network_id
   AND source_directive.grant_id = rate_grant.id
   AND source_directive.calculation_basis = 'actual_cost'
   AND source_directive.currency = calculation_row.currency
   AND source_directive.contract_version_id
       = calculation_row.contract_version_id
   AND source_directive.status = 'active'
   AND source_directive.approved_by IS NOT NULL
   AND source_directive.effective_from <= shipment_timestamp
   AND (
     source_directive.effective_to IS NULL
     OR source_directive.effective_to > shipment_timestamp
   )
   AND NOT EXISTS (
     SELECT 1
     FROM operations_carrier_rate_directives child
     WHERE child.network_id = source_directive.network_id
       AND child.supersedes_directive_id = source_directive.id
       AND child.status = 'active'
       AND child.effective_from <= shipment_timestamp
       AND (
         child.effective_to IS NULL
         OR child.effective_to > shipment_timestamp
       )
   )
  JOIN operations_contract_versions contract_version
    ON contract_version.id = source_directive.contract_version_id
  WHERE rate_grant.network_id = calculation_row.network_id
    AND rate_grant.account_authorization_id
        = calculation_row.account_authorization_id
    AND rate_grant.grantee_party_id = calculation_row.shipper_party_id
    AND rate_grant.status = 'active'
    AND rate_grant.allow_rating = true
    AND rate_grant.effective_from <= shipment_timestamp
    AND (
      rate_grant.effective_to IS NULL
      OR rate_grant.effective_to > shipment_timestamp
    )
    AND NOT EXISTS (
      SELECT 1
      FROM operations_carrier_rate_grants child
      WHERE child.network_id = rate_grant.network_id
        AND child.supersedes_grant_id = rate_grant.id
        AND child.status = 'active'
        AND child.allow_rating = true
        AND child.effective_from <= shipment_timestamp
        AND (
          child.effective_to IS NULL
          OR child.effective_to > shipment_timestamp
        )
    );

  IF evidence_charge_count IS DISTINCT FROM calculation_row.charge_count
     OR evidence_charge_total
       IS DISTINCT FROM calculation_row.carrier_billed_actual_minor
  THEN
    RAISE EXCEPTION
      'Carrier billing MUD calculation must preserve every billed charge exactly once';
  END IF;
  IF candidate_directive_count = 0 THEN
    IF calculation_row.status IS DISTINCT FROM 'not_configured' THEN
      RAISE EXCEPTION
        'Carrier billing MUD without an applicable directive must be not configured';
    END IF;
    expected_configuration_reason := CASE
      WHEN calculation_row.contract_version_id IS NULL
        THEN 'MUD_CONTRACT_NOT_CONFIGURED'
      ELSE 'MUD_ACTUAL_COST_DIRECTIVE_NOT_CONFIGURED'
    END;
  ELSIF candidate_grant_count > 1 THEN
    IF calculation_row.status IS DISTINCT FROM 'blocked'
       OR calculation_row.blocker_code
         IS DISTINCT FROM 'MUD_GRANT_AMBIGUOUS'
    THEN
      RAISE EXCEPTION
        'Carrier billing MUD with multiple direct grant paths must be blocked';
    END IF;
    expected_configuration_reason := 'MUD_GRANT_AMBIGUOUS';
  ELSIF calculation_row.status = 'calculated' THEN
    expected_configuration_reason :=
      'MUD_CALCULATED_FROM_BILLED_ACTUAL';
  ELSIF calculation_row.status = 'blocked' THEN
    expected_configuration_reason := calculation_row.blocker_code;
  ELSE
    RAISE EXCEPTION
      'Applicable carrier billing MUD directives require a calculated or blocked result';
  END IF;
  IF (
       calculation_row.status = 'calculated'
       AND (
         directive_count < 1
         OR directive_grant_count <> 1
         OR directive_count <> candidate_directive_count
         OR expected_directive_snapshot
           IS DISTINCT FROM expected_candidate_snapshot
       )
     )
     OR (
       calculation_row.status <> 'calculated'
       AND (
         directive_count <> 0
         OR directive_grant_count <> 0
       )
     )
  THEN
    RAISE EXCEPTION
      'Carrier billing MUD directive evidence does not match calculation status';
  END IF;
  IF jsonb_array_length(calculation_row.directive_snapshot)
       IS DISTINCT FROM directive_count
     OR calculation_row.directive_snapshot
       IS DISTINCT FROM expected_directive_snapshot
  THEN
    RAISE EXCEPTION
      'Carrier billing MUD directive snapshot differs from source evidence';
  END IF;
  IF calculation_row.calculation_snapshot->>'model'
       IS DISTINCT FROM 'billing_actual_mud_v1'
     OR NULLIF(
       btrim(
         COALESCE(
           calculation_row.calculation_snapshot->>'configurationReason',
           ''
         )
       ),
       ''
     ) IS NULL
  THEN
    RAISE EXCEPTION
      'Carrier billing MUD calculation snapshot is missing its model or configuration reason';
  END IF;

  IF calculation_row.status = 'calculated' THEN
    FOR directive_record IN
      SELECT
        evidence.directive_type,
        evidence.amount_minor,
        evidence.basis_points
      FROM operations_carrier_billing_mud_calculation_directives evidence
      JOIN operations_carrier_rate_directives source_directive
        ON source_directive.network_id = evidence.network_id
       AND source_directive.id = evidence.directive_id
      WHERE evidence.network_id = calculation_row.network_id
        AND evidence.calculation_id = calculation_row.id
      ORDER BY evidence.directive_priority, source_directive.global_id
    LOOP
      IF directive_record.directive_type = 'fixed_amount' THEN
        additive_minor :=
          additive_minor + directive_record.amount_minor;
      ELSIF directive_record.directive_type IN (
        'percent_markup', 'cost_plus_percent'
      ) THEN
        additive_minor := additive_minor + floor(
          (
            calculation_row.carrier_billed_actual_minor::numeric
              * directive_record.basis_points::numeric
              + 5000::numeric
          ) / 10000::numeric
        )::bigint;
      ELSIF directive_record.directive_type = 'minimum_charge' THEN
        minimum_minor := directive_record.amount_minor;
      ELSIF directive_record.directive_type = 'maximum_charge' THEN
        maximum_minor := directive_record.amount_minor;
      ELSE
        RAISE EXCEPTION
          'Carrier billing MUD directive type is not supported';
      END IF;
    END LOOP;

    IF minimum_minor IS NOT NULL
       AND maximum_minor IS NOT NULL
       AND minimum_minor > maximum_minor
    THEN
      RAISE EXCEPTION
        'Carrier billing MUD directive bounds are invalid';
    END IF;

    expected_contract_billed_minor :=
      calculation_row.carrier_billed_actual_minor + additive_minor;
    IF minimum_minor IS NOT NULL
       AND expected_contract_billed_minor < minimum_minor
    THEN
      expected_contract_billed_minor := minimum_minor;
    END IF;
    IF maximum_minor IS NOT NULL
       AND expected_contract_billed_minor > maximum_minor
    THEN
      expected_contract_billed_minor := maximum_minor;
    END IF;
    IF expected_contract_billed_minor
         < calculation_row.carrier_billed_actual_minor
    THEN
      RAISE EXCEPTION
        'Carrier billing MUD cannot create a negative margin';
    END IF;

    expected_mud_adjustment_minor :=
      expected_contract_billed_minor
        - calculation_row.carrier_billed_actual_minor;
    IF calculation_row.contract_billed_shipping_minor
         IS DISTINCT FROM expected_contract_billed_minor
       OR calculation_row.mud_adjustment_minor
         IS DISTINCT FROM expected_mud_adjustment_minor
    THEN
      RAISE EXCEPTION
        'Carrier billing MUD stored result differs from directive recomputation';
    END IF;
    IF calculation_row.calculation_snapshot->>'configurationReason'
         IS DISTINCT FROM 'MUD_CALCULATED_FROM_BILLED_ACTUAL'
    THEN
      RAISE EXCEPTION
        'Calculated carrier billing MUD requires calculated configuration provenance';
    END IF;
  END IF;

  SELECT
    review.global_id,
    statement.global_id,
    shipment.global_id,
    canonical_order.global_id,
    quote.global_id,
    contract_version.global_id,
    shipper_party.global_id
    INTO
      review_global_id,
      statement_global_id,
      shipment_global_id,
      order_global_id,
      quote_snapshot_global_id,
      contract_version_global_id,
      shipper_party_global_id
  FROM operations_gl_coding_reviews review
  JOIN operations_carrier_billing_statements statement
    ON statement.network_id = calculation_row.network_id
   AND statement.id = calculation_row.billing_statement_id
  JOIN operations_shipments shipment
    ON shipment.organization_id
        = calculation_row.executing_organization_id
   AND shipment.id = calculation_row.shipment_id
  JOIN operations_orders canonical_order
    ON canonical_order.organization_id
        = calculation_row.executing_organization_id
   AND canonical_order.id = calculation_row.order_id
  JOIN operations_carrier_quote_snapshots quote
    ON quote.network_id = calculation_row.network_id
   AND quote.id = calculation_row.quote_snapshot_id
  JOIN operations_carrier_rate_parties shipper_party
    ON shipper_party.network_id = calculation_row.network_id
   AND shipper_party.id = calculation_row.shipper_party_id
  LEFT JOIN operations_contract_versions contract_version
    ON contract_version.id = calculation_row.contract_version_id
  WHERE review.network_id = calculation_row.network_id
    AND review.id = calculation_row.gl_coding_review_id;

  IF calculation_row.commerce_order_candidate_id IS NOT NULL THEN
    SELECT
      candidate.global_id,
      candidate.normalized_payment_status,
      candidate.header_money_state
      INTO
        candidate_global_id,
        candidate_payment_status,
        candidate_header_money_state
    FROM operations_commerce_order_candidates candidate
    WHERE candidate.id = calculation_row.commerce_order_candidate_id;
  END IF;
  SELECT count(*)::integer
    INTO active_shipment_count
  FROM operations_shipments shipment
  WHERE shipment.organization_id
      = calculation_row.executing_organization_id
    AND shipment.order_id = calculation_row.order_id
    AND shipment.status <> 'voided';

  expected_checkout_snapshot := jsonb_build_object(
    'status', calculation_row.checkout_charge_status,
    'commerceOrderCandidateGlobalId', candidate_global_id,
    'paymentStatus', candidate_payment_status,
    'headerMoneyState', candidate_header_money_state,
    'activeShipmentCount', active_shipment_count,
    'noMultiShipmentAllocationInferred', true
  );
  expected_calculation_snapshot := jsonb_build_object(
    'model', 'billing_actual_mud_v1',
    'configurationReason', expected_configuration_reason,
    'reviewGlobalId', review_global_id,
    'statementGlobalId', statement_global_id,
    'statementVersion', calculation_row.billing_statement_version,
    'shipmentGlobalId', shipment_global_id,
    'orderGlobalId', order_global_id,
    'quoteSnapshotGlobalId', quote_snapshot_global_id,
    'contractVersionGlobalId', contract_version_global_id,
    'shipperPartyGlobalId', shipper_party_global_id,
    'directiveCandidates', expected_candidate_snapshot,
    'checkoutEvidence', expected_checkout_snapshot,
    'carrierBillingEvidence', expected_charge_snapshot,
    'signConvention', jsonb_build_object(
      'checkoutToCarrierActual',
        'customer_paid_checkout_shipping_minus_carrier_billed_actual',
      'checkoutToContractBill',
        'customer_paid_checkout_shipping_minus_contract_billed_shipping'
    )
  );
  IF calculation_row.calculation_snapshot
       IS DISTINCT FROM expected_calculation_snapshot
  THEN
    RAISE EXCEPTION
      'Carrier billing MUD calculation snapshot differs from source evidence';
  END IF;

  expected_input_hash := encode(
    digest(
      canonical_operations_billing_jsonb(
        jsonb_build_object(
          'networkId', calculation_row.network_id::text,
          'reviewId', calculation_row.gl_coding_review_id::text,
          'statementLineageKey',
            calculation_row.billing_statement_lineage_key,
          'statementVersion',
            calculation_row.billing_statement_version,
          'shipmentId', calculation_row.shipment_id::text,
          'currency', calculation_row.currency,
          'carrierBillingEvidence', expected_charge_snapshot,
          'directiveSnapshot', expected_directive_snapshot,
          'directiveCandidates', expected_candidate_snapshot,
          'checkoutEvidence', expected_checkout_snapshot
        )
      ),
      'sha256'
    ),
    'hex'
  );
  IF calculation_row.input_hash IS DISTINCT FROM expected_input_hash THEN
    RAISE EXCEPTION
      'Carrier billing MUD input hash differs from source evidence';
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS
  protect_operations_carrier_billing_mud_calculation_write
  ON operations_carrier_billing_mud_calculations;
CREATE TRIGGER
  protect_operations_carrier_billing_mud_calculation_write
BEFORE UPDATE OR DELETE
  ON operations_carrier_billing_mud_calculations
FOR EACH ROW EXECUTE FUNCTION
  protect_operations_carrier_billing_mud_evidence();

DROP TRIGGER IF EXISTS
  validate_operations_carrier_billing_mud_calculation_write
  ON operations_carrier_billing_mud_calculations;
CREATE TRIGGER
  validate_operations_carrier_billing_mud_calculation_write
BEFORE INSERT
  ON operations_carrier_billing_mud_calculations
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_carrier_billing_mud_calculation();

DROP TRIGGER IF EXISTS
  validate_operations_carrier_billing_mud_charge_write
  ON operations_carrier_billing_mud_calculation_charges;
CREATE TRIGGER
  validate_operations_carrier_billing_mud_charge_write
BEFORE INSERT OR UPDATE OR DELETE
  ON operations_carrier_billing_mud_calculation_charges
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_carrier_billing_mud_charge();

DROP TRIGGER IF EXISTS
  validate_operations_carrier_billing_mud_directive_write
  ON operations_carrier_billing_mud_calculation_directives;
CREATE TRIGGER
  validate_operations_carrier_billing_mud_directive_write
BEFORE INSERT OR UPDATE OR DELETE
  ON operations_carrier_billing_mud_calculation_directives
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_carrier_billing_mud_directive();

DROP TRIGGER IF EXISTS
  validate_operations_carrier_billing_mud_parent_complete
  ON operations_carrier_billing_mud_calculations;
CREATE CONSTRAINT TRIGGER
  validate_operations_carrier_billing_mud_parent_complete
AFTER INSERT
  ON operations_carrier_billing_mud_calculations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_carrier_billing_mud_complete();

DROP TRIGGER IF EXISTS
  validate_operations_carrier_billing_mud_charge_complete
  ON operations_carrier_billing_mud_calculation_charges;
CREATE CONSTRAINT TRIGGER
  validate_operations_carrier_billing_mud_charge_complete
AFTER INSERT
  ON operations_carrier_billing_mud_calculation_charges
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_carrier_billing_mud_complete();

DROP TRIGGER IF EXISTS
  validate_operations_carrier_billing_mud_directive_complete
  ON operations_carrier_billing_mud_calculation_directives;
CREATE CONSTRAINT TRIGGER
  validate_operations_carrier_billing_mud_directive_complete
AFTER INSERT
  ON operations_carrier_billing_mud_calculation_directives
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_carrier_billing_mud_complete();

COMMENT ON TABLE operations_carrier_billing_mud_calculations IS
  'Immutable billing-time MUD result derived only from approved, exactly matched carrier-bill evidence.';
COMMENT ON COLUMN
  operations_carrier_billing_mud_calculations.customer_paid_checkout_shipping_minor
IS
  'Customer-paid checkout shipping for a complete paid single-shipment commerce order; never inferred or allocated.';
