-- Durable carrier billing import evidence and human GL Coding approval.
--
-- Carrier statements are untrusted external files. Raw account numbers are
-- deliberately absent from this schema: importers may persist only a masked
-- reference and a keyed account fingerprint. GL Coding runs remain immutable;
-- review and settlement are separate append-only records.

INSERT INTO global_reference_entity_types (prefix, entity_type, display_name) VALUES
  ('gbi', 'operations.carrier_billing_import_row', 'Carrier billing import row'),
  ('ggv', 'operations.gl_coding_review', 'GL Coding review'),
  ('ggw', 'operations.gl_coding_review_item', 'GL Coding review item')
ON CONFLICT (prefix) DO UPDATE SET
  entity_type = EXCLUDED.entity_type,
  display_name = EXCLUDED.display_name;

ALTER TABLE operations_carrier_billing_batches
  ADD COLUMN IF NOT EXISTS source_byte_length bigint,
  ADD COLUMN IF NOT EXISTS header_mapping jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS import_schema_version integer NOT NULL DEFAULT 1;

ALTER TABLE operations_carrier_billing_batches
  ADD CONSTRAINT operations_carrier_billing_batches_source_bytes_valid
    CHECK (source_byte_length IS NULL OR source_byte_length >= 0),
  ADD CONSTRAINT operations_carrier_billing_batches_header_mapping_valid
    CHECK (jsonb_typeof(header_mapping) = 'object'),
  ADD CONSTRAINT operations_carrier_billing_batches_schema_version_valid
    CHECK (import_schema_version > 0);

CREATE TABLE IF NOT EXISTS operations_carrier_billing_import_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gbi'),
  network_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  row_number integer NOT NULL CHECK (row_number > 0),
  line_number integer NOT NULL CHECK (line_number > 0),
  status text NOT NULL CHECK (status IN ('imported', 'rejected')),
  billing_statement_id uuid,
  billing_charge_id uuid,
  billed_account_masked_reference text,
  billed_account_fingerprint text
    CHECK (
      billed_account_fingerprint IS NULL
      OR billed_account_fingerprint ~ '^[a-f0-9]{64}$'
    ),
  source_row_hash text NOT NULL CHECK (source_row_hash ~ '^[a-f0-9]{64}$'),
  issues jsonb NOT NULL DEFAULT '[]'::jsonb,
  redacted_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_carrier_billing_import_rows_global_valid
    CHECK (global_id ~ '^gbi[0-9]{7}$'),
  CONSTRAINT operations_carrier_billing_import_rows_global_unique UNIQUE (global_id),
  CONSTRAINT operations_carrier_billing_import_rows_registry_fkey
    FOREIGN KEY (global_id) REFERENCES crm_reference_registry(reference_code)
    ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_billing_import_rows_batch_fkey
    FOREIGN KEY (network_id, batch_id)
    REFERENCES operations_carrier_billing_batches(network_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_billing_import_rows_charge_fkey
    FOREIGN KEY (network_id, billing_statement_id, billing_charge_id)
    REFERENCES operations_carrier_billing_charges(network_id, statement_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_billing_import_rows_issues_valid
    CHECK (jsonb_typeof(issues) = 'array'),
  CONSTRAINT operations_carrier_billing_import_rows_evidence_valid
    CHECK (jsonb_typeof(redacted_evidence) = 'object'),
  CONSTRAINT operations_carrier_billing_import_rows_status_valid CHECK (
    (
      status = 'imported'
      AND billing_statement_id IS NOT NULL
      AND billing_charge_id IS NOT NULL
      AND billed_account_masked_reference IS NOT NULL
      AND billed_account_fingerprint IS NOT NULL
      AND issues = '[]'::jsonb
    )
    OR (
      status = 'rejected'
      AND billing_statement_id IS NULL
      AND billing_charge_id IS NULL
      AND issues <> '[]'::jsonb
    )
  ),
  CONSTRAINT operations_carrier_billing_import_rows_batch_row_unique
    UNIQUE (batch_id, row_number),
  CONSTRAINT operations_carrier_billing_import_rows_network_id_unique
    UNIQUE (network_id, id)
);

CREATE INDEX IF NOT EXISTS idx_operations_carrier_billing_import_rows_batch
  ON operations_carrier_billing_import_rows (
    network_id, batch_id, status, row_number
  );

CREATE TABLE IF NOT EXISTS operations_gl_coding_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('ggv'),
  network_id uuid NOT NULL,
  run_id uuid NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approved', 'rejected')),
  reason text NOT NULL,
  idempotency_key text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  reviewed_by text NOT NULL REFERENCES app_users(email) ON DELETE RESTRICT,
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_gl_coding_reviews_global_valid
    CHECK (global_id ~ '^ggv[0-9]{7}$'),
  CONSTRAINT operations_gl_coding_reviews_global_unique UNIQUE (global_id),
  CONSTRAINT operations_gl_coding_reviews_registry_fkey
    FOREIGN KEY (global_id) REFERENCES crm_reference_registry(reference_code)
    ON DELETE RESTRICT,
  CONSTRAINT operations_gl_coding_reviews_run_fkey
    FOREIGN KEY (network_id, run_id)
    REFERENCES operations_gl_coding_runs(network_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_gl_coding_reviews_reason_present
    CHECK (NULLIF(btrim(reason), '') IS NOT NULL),
  CONSTRAINT operations_gl_coding_reviews_evidence_valid
    CHECK (jsonb_typeof(evidence) = 'object'),
  CONSTRAINT operations_gl_coding_reviews_run_unique UNIQUE (run_id),
  CONSTRAINT operations_gl_coding_reviews_idempotency_unique
    UNIQUE (network_id, idempotency_key),
  CONSTRAINT operations_gl_coding_reviews_network_run_id_unique
    UNIQUE (network_id, run_id, id),
  CONSTRAINT operations_gl_coding_reviews_network_id_unique
    UNIQUE (network_id, id)
);

CREATE TABLE IF NOT EXISTS operations_gl_coding_review_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('ggw'),
  network_id uuid NOT NULL,
  run_id uuid NOT NULL,
  review_id uuid NOT NULL,
  run_item_id uuid NOT NULL,
  billing_statement_id uuid NOT NULL,
  billing_charge_id uuid NOT NULL,
  billing_account_resolution_id uuid NOT NULL,
  account_authorization_id uuid NOT NULL,
  carrier_account_id uuid NOT NULL,
  shipper_assignment_id uuid NOT NULL,
  source_charge_amount_minor bigint NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_gl_coding_review_items_global_valid
    CHECK (global_id ~ '^ggw[0-9]{7}$'),
  CONSTRAINT operations_gl_coding_review_items_global_unique UNIQUE (global_id),
  CONSTRAINT operations_gl_coding_review_items_registry_fkey
    FOREIGN KEY (global_id) REFERENCES crm_reference_registry(reference_code)
    ON DELETE RESTRICT,
  CONSTRAINT operations_gl_coding_review_items_review_fkey
    FOREIGN KEY (network_id, run_id, review_id)
    REFERENCES operations_gl_coding_reviews(network_id, run_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_gl_coding_review_items_run_item_fkey
    FOREIGN KEY (network_id, run_item_id)
    REFERENCES operations_gl_coding_run_items(network_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_gl_coding_review_items_charge_fkey
    FOREIGN KEY (network_id, billing_statement_id, billing_charge_id)
    REFERENCES operations_carrier_billing_charges(network_id, statement_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_gl_coding_review_items_resolution_fkey
    FOREIGN KEY (
      network_id, billing_statement_id, account_authorization_id,
      carrier_account_id, billing_account_resolution_id
    )
    REFERENCES operations_carrier_billing_account_resolutions(
      network_id, statement_id, account_authorization_id,
      carrier_account_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_gl_coding_review_items_assignment_fkey
    FOREIGN KEY (
      network_id, billing_charge_id, shipper_assignment_id
    )
    REFERENCES operations_carrier_billing_shipper_assignments(
      network_id, charge_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_gl_coding_review_items_evidence_valid
    CHECK (jsonb_typeof(evidence) = 'object'),
  CONSTRAINT operations_gl_coding_review_items_review_run_item_unique
    UNIQUE (review_id, run_item_id),
  CONSTRAINT operations_gl_coding_review_items_review_charge_unique
    UNIQUE (review_id, billing_charge_id),
  CONSTRAINT operations_gl_coding_review_items_charge_unique
    UNIQUE (network_id, billing_charge_id),
  CONSTRAINT operations_gl_coding_review_items_network_id_unique
    UNIQUE (network_id, id)
);

CREATE TABLE IF NOT EXISTS operations_gl_coding_review_settlements (
  network_id uuid NOT NULL,
  review_item_id uuid NOT NULL,
  settlement_entry_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN (
    'carrier_payable', 'carrier_cost_reimbursement', 'credit'
  )),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (review_item_id, settlement_entry_id),
  CONSTRAINT operations_gl_coding_review_settlements_item_fkey
    FOREIGN KEY (network_id, review_item_id)
    REFERENCES operations_gl_coding_review_items(network_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_gl_coding_review_settlements_entry_fkey
    FOREIGN KEY (network_id, settlement_entry_id)
    REFERENCES operations_settlement_entries(network_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_gl_coding_review_settlements_entry_unique
    UNIQUE (settlement_entry_id)
);

CREATE OR REPLACE FUNCTION protect_operations_carrier_billing_import_row()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Carrier billing import rows are append-only';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_operations_carrier_billing_import_row_write
  ON operations_carrier_billing_import_rows;
CREATE TRIGGER protect_operations_carrier_billing_import_row_write
BEFORE UPDATE OR DELETE ON operations_carrier_billing_import_rows
FOR EACH ROW EXECUTE FUNCTION protect_operations_carrier_billing_import_row();

CREATE OR REPLACE FUNCTION validate_operations_gl_coding_review()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  run_status text;
  orphan_count integer;
  error_count integer;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'GL Coding reviews are append-only';
  END IF;

  SELECT run.status, run.orphan_count, run.error_count
  INTO run_status, orphan_count, error_count
  FROM operations_gl_coding_runs run
  WHERE run.network_id = NEW.network_id
    AND run.id = NEW.run_id
  FOR UPDATE;

  IF run_status IS NULL THEN
    RAISE EXCEPTION 'GL Coding review requires an existing run';
  END IF;
  IF NEW.decision = 'approved'
     AND (
       run_status IS DISTINCT FROM 'completed'
       OR orphan_count <> 0
       OR error_count <> 0
     ) THEN
    RAISE EXCEPTION
      'Only a completed GL Coding run without orphan or error items may be approved';
  END IF;
  IF NEW.decision = 'rejected'
     AND run_status NOT IN ('completed', 'needs_review') THEN
    RAISE EXCEPTION
      'Only a terminal GL Coding run may be rejected';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_operations_gl_coding_review_write
  ON operations_gl_coding_reviews;
CREATE TRIGGER validate_operations_gl_coding_review_write
BEFORE INSERT OR UPDATE OR DELETE ON operations_gl_coding_reviews
FOR EACH ROW EXECUTE FUNCTION validate_operations_gl_coding_review();

CREATE OR REPLACE FUNCTION validate_operations_gl_coding_review_item()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  review_decision text;
  item_run_id uuid;
  item_charge_id uuid;
  item_assignment_id uuid;
  item_result text;
  statement_id uuid;
  charge_amount_minor bigint;
  charge_currency text;
  resolution_decision text;
  resolution_is_current boolean;
  assignment_decision text;
  assignment_is_current boolean;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'GL Coding review items are append-only';
  END IF;

  SELECT review.decision
  INTO review_decision
  FROM operations_gl_coding_reviews review
  WHERE review.network_id = NEW.network_id
    AND review.run_id = NEW.run_id
    AND review.id = NEW.review_id;

  IF review_decision IS DISTINCT FROM 'approved' THEN
    RAISE EXCEPTION 'GL Coding review items require an approved review';
  END IF;

  SELECT
    item.run_id,
    item.charge_id,
    item.shipper_assignment_id,
    item.result
  INTO
    item_run_id,
    item_charge_id,
    item_assignment_id,
    item_result
  FROM operations_gl_coding_run_items item
  WHERE item.network_id = NEW.network_id
    AND item.id = NEW.run_item_id;

  IF item_run_id IS DISTINCT FROM NEW.run_id
     OR item_charge_id IS DISTINCT FROM NEW.billing_charge_id
     OR item_assignment_id IS DISTINCT FROM NEW.shipper_assignment_id
     OR item_result IS DISTINCT FROM 'assigned' THEN
    RAISE EXCEPTION
      'GL Coding review item must preserve an assigned run-item decision';
  END IF;

  SELECT charge.statement_id, charge.amount_minor, charge.currency
  INTO statement_id, charge_amount_minor, charge_currency
  FROM operations_carrier_billing_charges charge
  WHERE charge.network_id = NEW.network_id
    AND charge.id = NEW.billing_charge_id;

  IF statement_id IS DISTINCT FROM NEW.billing_statement_id
     OR charge_amount_minor IS DISTINCT FROM NEW.source_charge_amount_minor
     OR charge_currency IS DISTINCT FROM NEW.currency THEN
    RAISE EXCEPTION
      'GL Coding review item must preserve the carrier billed-actual charge';
  END IF;

  SELECT
    resolution.decision,
    NOT EXISTS (
      SELECT 1
      FROM operations_carrier_billing_account_resolutions child
      WHERE child.network_id = resolution.network_id
        AND child.statement_id = resolution.statement_id
        AND child.supersedes_resolution_id = resolution.id
    )
  INTO resolution_decision, resolution_is_current
  FROM operations_carrier_billing_account_resolutions resolution
  WHERE resolution.network_id = NEW.network_id
    AND resolution.statement_id = NEW.billing_statement_id
    AND resolution.account_authorization_id = NEW.account_authorization_id
    AND resolution.carrier_account_id = NEW.carrier_account_id
    AND resolution.id = NEW.billing_account_resolution_id;

  IF resolution_decision IS DISTINCT FROM 'matched'
     OR resolution_is_current IS DISTINCT FROM true THEN
    RAISE EXCEPTION
      'GL Coding review item requires the current exact carrier-account resolution';
  END IF;

  SELECT
    assignment.decision,
    NOT EXISTS (
      SELECT 1
      FROM operations_carrier_billing_shipper_assignments child
      WHERE child.network_id = assignment.network_id
        AND child.charge_id = assignment.charge_id
        AND child.supersedes_assignment_id = assignment.id
    )
  INTO assignment_decision, assignment_is_current
  FROM operations_carrier_billing_shipper_assignments assignment
  WHERE assignment.network_id = NEW.network_id
    AND assignment.charge_id = NEW.billing_charge_id
    AND assignment.id = NEW.shipper_assignment_id;

  IF assignment_decision IS DISTINCT FROM 'assigned'
     OR assignment_is_current IS DISTINCT FROM true THEN
    RAISE EXCEPTION
      'GL Coding review item requires the current shipper assignment';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_operations_gl_coding_review_item_write
  ON operations_gl_coding_review_items;
CREATE TRIGGER validate_operations_gl_coding_review_item_write
BEFORE INSERT OR UPDATE OR DELETE ON operations_gl_coding_review_items
FOR EACH ROW EXECUTE FUNCTION validate_operations_gl_coding_review_item();

CREATE OR REPLACE FUNCTION validate_operations_gl_coding_review_settlement()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  reviewed_statement_id uuid;
  reviewed_charge_id uuid;
  reviewed_resolution_id uuid;
  reviewed_assignment_id uuid;
  reviewed_amount_minor bigint;
  reviewed_currency text;
  settlement_type text;
  settlement_statement_id uuid;
  settlement_charge_id uuid;
  settlement_resolution_id uuid;
  settlement_assignment_id uuid;
  settlement_amount_minor bigint;
  settlement_source_amount_minor bigint;
  settlement_currency text;
  settlement_source_type text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'GL Coding review settlement links are append-only';
  END IF;

  SELECT
    item.billing_statement_id,
    item.billing_charge_id,
    item.billing_account_resolution_id,
    item.shipper_assignment_id,
    item.source_charge_amount_minor,
    item.currency
  INTO
    reviewed_statement_id,
    reviewed_charge_id,
    reviewed_resolution_id,
    reviewed_assignment_id,
    reviewed_amount_minor,
    reviewed_currency
  FROM operations_gl_coding_review_items item
  WHERE item.network_id = NEW.network_id
    AND item.id = NEW.review_item_id;

  SELECT
    settlement.settlement_type,
    settlement.billing_statement_id,
    settlement.billing_charge_id,
    settlement.billing_account_resolution_id,
    settlement.shipper_assignment_id,
    settlement.amount_minor,
    settlement.source_charge_amount_minor,
    settlement.currency,
    settlement.source_type
  INTO
    settlement_type,
    settlement_statement_id,
    settlement_charge_id,
    settlement_resolution_id,
    settlement_assignment_id,
    settlement_amount_minor,
    settlement_source_amount_minor,
    settlement_currency,
    settlement_source_type
  FROM operations_settlement_entries settlement
  WHERE settlement.network_id = NEW.network_id
    AND settlement.id = NEW.settlement_entry_id;

  IF reviewed_charge_id IS NULL OR settlement_charge_id IS NULL THEN
    RAISE EXCEPTION
      'GL Coding review settlement requires an exact review item and settlement';
  END IF;
  IF settlement_source_type IS DISTINCT FROM 'shipper_assignment'
     OR settlement_statement_id IS DISTINCT FROM reviewed_statement_id
     OR settlement_charge_id IS DISTINCT FROM reviewed_charge_id
     OR settlement_resolution_id IS DISTINCT FROM reviewed_resolution_id
     OR settlement_assignment_id IS DISTINCT FROM reviewed_assignment_id
     OR settlement_source_amount_minor IS DISTINCT FROM reviewed_amount_minor
     OR settlement_currency IS DISTINCT FROM reviewed_currency
     OR settlement_amount_minor IS DISTINCT FROM abs(reviewed_amount_minor) THEN
    RAISE EXCEPTION
      'GL Coding review settlement must preserve the exact reviewed billed-actual decision';
  END IF;
  IF (
       NEW.role = 'carrier_payable'
       AND settlement_type IS DISTINCT FROM 'carrier_payable'
     )
     OR (
       NEW.role = 'carrier_cost_reimbursement'
       AND settlement_type IS DISTINCT FROM 'carrier_cost_reimbursement'
     )
     OR (
       NEW.role = 'credit'
       AND settlement_type IS DISTINCT FROM 'credit'
     ) THEN
    RAISE EXCEPTION
      'GL Coding review settlement role does not match its settlement entry';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_operations_gl_coding_review_settlement_write
  ON operations_gl_coding_review_settlements;
CREATE TRIGGER validate_operations_gl_coding_review_settlement_write
BEFORE INSERT OR UPDATE OR DELETE ON operations_gl_coding_review_settlements
FOR EACH ROW EXECUTE FUNCTION validate_operations_gl_coding_review_settlement();

-- Every shipper assignment becomes billable only after a human approves the
-- exact current GL Coding run item. This applies equally to deterministic
-- shipment matches, routing rules, and manual orphan assignments.
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
  assignment_is_reviewed boolean;
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
      EXISTS (
        SELECT 1
        FROM operations_gl_coding_review_items reviewed_item
        JOIN operations_gl_coding_reviews review
          ON review.network_id = reviewed_item.network_id
         AND review.id = reviewed_item.review_id
         AND review.decision = 'approved'
        WHERE reviewed_item.network_id = assignment.network_id
          AND reviewed_item.billing_charge_id = assignment.charge_id
          AND reviewed_item.shipper_assignment_id = assignment.id
          AND reviewed_item.billing_account_resolution_id
            = NEW.billing_account_resolution_id
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
      assignment_is_reviewed,
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
    IF assignment_source NOT IN ('shipment_match', 'manual', 'routing_rule')
       OR assignment_is_reviewed IS DISTINCT FROM true
       OR assignment_decision IS DISTINCT FROM 'assigned'
       OR assignment_is_current IS DISTINCT FROM true THEN
      RAISE EXCEPTION
        'Assignment-sourced settlement requires a current reviewed assignment';
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
