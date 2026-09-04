-- Bound wide commerce evidence without weakening exact retry or downstream
-- fulfillment proofs.

ALTER TABLE operations_commerce_intake_read_intents
  ADD COLUMN IF NOT EXISTS response_purged_at timestamptz;

ALTER TABLE operations_commerce_intake_read_intents
  DROP CONSTRAINT IF EXISTS commerce_intake_read_intents_response_valid,
  ADD CONSTRAINT commerce_intake_read_intents_response_valid CHECK (
    (
      response_ciphertext IS NULL
      AND response_iv IS NULL
      AND response_tag IS NULL
      AND response_hash IS NULL
      AND response_bytes IS NULL
      AND response_encryption_version IS NULL
      AND response_purged_at IS NULL
    )
    OR (
      response_ciphertext IS NOT NULL
      AND octet_length(response_ciphertext) BETWEEN 2 AND 8388608
      AND response_iv IS NOT NULL
      AND octet_length(response_iv) = 12
      AND response_tag IS NOT NULL
      AND octet_length(response_tag) = 16
      AND response_hash ~ '^[a-f0-9]{64}$'
      AND response_bytes BETWEEN 2 AND 8388608
      AND response_encryption_version = 1
      AND response_purged_at IS NULL
    )
    OR (
      response_ciphertext IS NULL
      AND response_iv IS NULL
      AND response_tag IS NULL
      AND response_hash ~ '^[a-f0-9]{64}$'
      AND response_bytes BETWEEN 2 AND 8388608
      AND response_encryption_version = 1
      AND response_purged_at IS NOT NULL
      AND response_purged_at >= created_at
    )
  ) NOT VALID,
  DROP CONSTRAINT IF EXISTS commerce_intake_read_intents_state_valid,
  ADD CONSTRAINT commerce_intake_read_intents_state_valid CHECK (
    (
      intent_state = 'prepared'
      AND provider_attempt_id IS NULL
      AND lease_token IS NULL
      AND response_hash IS NULL
      AND response_purged_at IS NULL
      AND last_error_code IS NULL
      AND staged_run_id IS NULL
    )
    OR (
      intent_state = 'reading'
      AND provider_attempt_id IS NOT NULL
      AND lease_token IS NOT NULL
      AND response_hash IS NULL
      AND response_purged_at IS NULL
      AND last_error_code IS NULL
      AND staged_run_id IS NULL
    )
    OR (
      intent_state = 'captured'
      AND provider_attempt_id IS NOT NULL
      AND lease_token IS NULL
      AND response_ciphertext IS NOT NULL
      AND response_purged_at IS NULL
      AND last_error_code IS NULL
      AND staged_run_id IS NULL
    )
    OR (
      intent_state = 'staged'
      AND provider_attempt_id IS NOT NULL
      AND lease_token IS NULL
      AND response_hash IS NOT NULL
      AND last_error_code IS NULL
      AND staged_run_id IS NOT NULL
    )
    OR (
      intent_state = 'uncertain'
      AND provider_attempt_id IS NOT NULL
      AND lease_token IS NULL
      AND response_hash IS NULL
      AND response_purged_at IS NULL
      AND last_error_code IS NOT NULL
      AND staged_run_id IS NULL
    )
    OR (
      intent_state = 'expired'
      AND lease_token IS NULL
      AND staged_run_id IS NULL
      AND (
        response_hash IS NULL
        OR provider_attempt_id IS NOT NULL
      )
    )
  ) NOT VALID;

-- Production-sized indexes are built online by the nontransactional 0352
-- companion migration. Keeping them out of this transactional schema phase
-- prevents the deploy migrator's 30-second query budget from turning a large
-- table scan into an all-or-nothing release failure.

CREATE OR REPLACE FUNCTION protect_operations_commerce_intake_read_intent()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  attempt_action text;
  attempt_idempotency_key text;
  attempt_request_hash text;
  attempt_state text;
  attempt_lease_token uuid;
  attempt_lease_expires_at timestamptz;
  run_provider text;
  run_resource text;
  run_credential_version integer;
  run_idempotency_key text;
  run_provider_attempt_id uuid;
  run_window_start timestamptz;
  run_window_end timestamptz;
  response_redacted boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.intent_state <> 'prepared'
       OR NEW.provider_attempt_id IS NOT NULL
       OR NEW.lease_token IS NOT NULL
       OR NEW.response_ciphertext IS NOT NULL
       OR NEW.response_purged_at IS NOT NULL
       OR NEW.last_error_code IS NOT NULL
       OR NEW.staged_run_id IS NOT NULL
       OR NEW.row_version <> 0 THEN
      RAISE EXCEPTION
        'Commerce intake read intent must begin prepared at row version zero';
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(
    NEW.organization_id, NEW.integration_account_id, NEW.pipeline_id,
    NEW.provider, NEW.resource, NEW.intake_action, NEW.idempotency_key,
    NEW.request_hash, NEW.credential_version, NEW.target_kind,
    NEW.target_global_id, NEW.target_source_hash,
    NEW.target_external_id_hash, NEW.continuation_id,
    NEW.continuation_cursor_hash, NEW.continuation_row_version,
    NEW.session_id, NEW.batch_number, NEW.window_start, NEW.window_end,
    NEW.query_hash, NEW.created_by, NEW.created_at, NEW.expires_at
  ) IS DISTINCT FROM ROW(
    OLD.organization_id, OLD.integration_account_id, OLD.pipeline_id,
    OLD.provider, OLD.resource, OLD.intake_action, OLD.idempotency_key,
    OLD.request_hash, OLD.credential_version, OLD.target_kind,
    OLD.target_global_id, OLD.target_source_hash,
    OLD.target_external_id_hash, OLD.continuation_id,
    OLD.continuation_cursor_hash, OLD.continuation_row_version,
    OLD.session_id, OLD.batch_number, OLD.window_start, OLD.window_end,
    OLD.query_hash, OLD.created_by, OLD.created_at, OLD.expires_at
  ) THEN
    RAISE EXCEPTION 'Commerce intake read intent identity is immutable';
  END IF;
  IF NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION
      'Commerce intake read intent update requires the next row version';
  END IF;
  IF OLD.provider_attempt_id IS NOT NULL
     AND NEW.provider_attempt_id IS DISTINCT FROM OLD.provider_attempt_id THEN
    RAISE EXCEPTION
      'Commerce intake read intent provider attempt is immutable once reserved';
  END IF;

  response_redacted :=
    OLD.response_ciphertext IS NOT NULL
    AND OLD.response_iv IS NOT NULL
    AND OLD.response_tag IS NOT NULL
    AND OLD.response_purged_at IS NULL
    AND NEW.response_ciphertext IS NULL
    AND NEW.response_iv IS NULL
    AND NEW.response_tag IS NULL
    AND NEW.response_hash IS NOT DISTINCT FROM OLD.response_hash
    AND NEW.response_bytes IS NOT DISTINCT FROM OLD.response_bytes
    AND NEW.response_encryption_version
      IS NOT DISTINCT FROM OLD.response_encryption_version
    AND NEW.response_purged_at IS NOT NULL;

  IF OLD.response_purged_at IS NOT NULL AND ROW(
    NEW.response_ciphertext, NEW.response_iv, NEW.response_tag,
    NEW.response_hash, NEW.response_bytes, NEW.response_encryption_version,
    NEW.response_purged_at
  ) IS DISTINCT FROM ROW(
    OLD.response_ciphertext, OLD.response_iv, OLD.response_tag,
    OLD.response_hash, OLD.response_bytes, OLD.response_encryption_version,
    OLD.response_purged_at
  ) THEN
    RAISE EXCEPTION 'Purged commerce intake response evidence is immutable';
  END IF;
  IF OLD.response_ciphertext IS NOT NULL
     AND NOT response_redacted
     AND ROW(
       NEW.response_ciphertext, NEW.response_iv, NEW.response_tag,
       NEW.response_hash, NEW.response_bytes, NEW.response_encryption_version,
       NEW.response_purged_at
     ) IS DISTINCT FROM ROW(
       OLD.response_ciphertext, OLD.response_iv, OLD.response_tag,
       OLD.response_hash, OLD.response_bytes, OLD.response_encryption_version,
       OLD.response_purged_at
     ) THEN
    RAISE EXCEPTION 'Captured commerce intake response evidence is immutable';
  END IF;

  IF NOT (
    (OLD.intent_state = 'prepared'
      AND NEW.intent_state IN ('reading', 'expired'))
    OR (OLD.intent_state = 'reading'
      AND NEW.intent_state IN ('captured', 'uncertain'))
    OR (OLD.intent_state = 'captured'
      AND NEW.intent_state IN ('staged', 'expired'))
    OR (response_redacted
      AND OLD.intent_state = NEW.intent_state
      AND NEW.intent_state IN ('staged', 'expired'))
  ) THEN
    RAISE EXCEPTION 'Invalid commerce intake read intent transition';
  END IF;
  IF response_redacted
     AND OLD.intent_state = NEW.intent_state
     AND (to_jsonb(NEW) - ARRAY[
       'response_ciphertext', 'response_iv', 'response_tag',
       'response_purged_at', 'row_version', 'updated_by', 'updated_at'
     ]) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY[
       'response_ciphertext', 'response_iv', 'response_tag',
       'response_purged_at', 'row_version', 'updated_by', 'updated_at'
     ]) THEN
    RAISE EXCEPTION 'Commerce intake payload purge may only redact ciphertext';
  END IF;

  IF NEW.intent_state = 'reading' THEN
    SELECT attempt.action, attempt.idempotency_key, attempt.request_hash,
           attempt.state, attempt.lease_token, attempt.lease_expires_at
    INTO attempt_action, attempt_idempotency_key, attempt_request_hash,
         attempt_state, attempt_lease_token, attempt_lease_expires_at
    FROM operations_commerce_provider_attempts AS attempt
    WHERE attempt.organization_id = NEW.organization_id
      AND attempt.integration_account_id = NEW.integration_account_id
      AND attempt.id = NEW.provider_attempt_id;
    IF NOT FOUND
       OR attempt_action <> 'commerce.intake.read'
       OR attempt_idempotency_key <> NEW.idempotency_key
       OR attempt_request_hash <> NEW.request_hash
       OR attempt_state <> 'prepared'
       OR attempt_lease_token IS DISTINCT FROM NEW.lease_token
       OR attempt_lease_expires_at IS DISTINCT FROM NEW.lease_expires_at THEN
      RAISE EXCEPTION
        'Commerce intake reading lease must match its prepared provider attempt';
    END IF;
  END IF;
  IF NEW.intent_state IN ('captured', 'uncertain') THEN
    SELECT attempt.state INTO attempt_state
    FROM operations_commerce_provider_attempts AS attempt
    WHERE attempt.organization_id = NEW.organization_id
      AND attempt.integration_account_id = NEW.integration_account_id
      AND attempt.id = NEW.provider_attempt_id;
    IF NOT FOUND
       OR (NEW.intent_state = 'captured' AND attempt_state <> 'succeeded')
       OR (NEW.intent_state = 'uncertain' AND attempt_state <> 'unknown') THEN
      RAISE EXCEPTION
        'Commerce intake read outcome must match its provider attempt';
    END IF;
  END IF;
  IF NEW.intent_state = 'staged' THEN
    SELECT run.provider, run.resource, run.credential_version,
           run.idempotency_key, run.provider_attempt_id,
           run.window_start, run.window_end
    INTO run_provider, run_resource, run_credential_version,
         run_idempotency_key, run_provider_attempt_id,
         run_window_start, run_window_end
    FROM operations_commerce_intake_runs AS run
    WHERE run.organization_id = NEW.organization_id
      AND run.integration_account_id = NEW.integration_account_id
      AND run.pipeline_id = NEW.pipeline_id
      AND run.id = NEW.staged_run_id;
    IF NOT FOUND
       OR run_provider <> NEW.provider
       OR run_credential_version <> NEW.credential_version
       OR run_idempotency_key <> NEW.idempotency_key
       OR run_provider_attempt_id IS DISTINCT FROM NEW.provider_attempt_id
       OR run_window_start IS DISTINCT FROM NEW.window_start
       OR run_window_end IS DISTINCT FROM NEW.window_end
       OR (NEW.resource = 'orders' AND run_resource <> 'products_and_orders')
       OR (NEW.resource = 'products' AND run_resource <> 'products') THEN
      RAISE EXCEPTION
        'Commerce intake staged run must match its provider-read intent';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION purge_operations_commerce_intake_read_payloads(
  p_limit integer DEFAULT 250
)
RETURNS TABLE (purged_rows integer, purged_bytes bigint)
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_limit < 1 OR p_limit > 5000 THEN
    RAISE EXCEPTION 'commerce intake payload purge limit is invalid';
  END IF;
  RETURN QUERY
  WITH due AS (
    SELECT intent.id, intent.response_bytes
    FROM operations_commerce_intake_read_intents intent
    WHERE intent.response_ciphertext IS NOT NULL
      AND (
        (intent.intent_state = 'staged' AND intent.staged_run_id IS NOT NULL)
        OR (
          intent.intent_state IN ('captured', 'expired')
          AND intent.expires_at <= now()
          AND intent.staged_run_id IS NULL
        )
      )
    ORDER BY
      CASE intent.intent_state WHEN 'staged' THEN 0 ELSE 1 END,
      intent.expires_at, intent.updated_at, intent.id
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  ), purged AS (
    UPDATE operations_commerce_intake_read_intents intent
    SET intent_state = CASE
          WHEN intent.intent_state = 'captured' THEN 'expired'
          ELSE intent.intent_state
        END,
        response_ciphertext = NULL,
        response_iv = NULL,
        response_tag = NULL,
        response_purged_at = now(),
        last_error_code = CASE
          WHEN intent.intent_state = 'captured' THEN
            'COMMERCE_INTAKE_READ_INTENT_EXPIRED'
          ELSE intent.last_error_code
        END,
        row_version = intent.row_version + 1,
        updated_by = 'system:commerce-storage-maintenance',
        updated_at = now()
    FROM due
    WHERE intent.id = due.id
    RETURNING due.response_bytes
  )
  SELECT count(*)::integer,
         COALESCE(sum(response_bytes), 0)::bigint
  FROM purged;
END;
$$;

-- A full run is now a content-addressed projected level set. Repeated provider
-- observations retain their attempt/capture/run audit rows while reusing the
-- immutable level rows of a matching full source run.
ALTER TABLE operations_commerce_inventory_sync_runs
  ADD COLUMN IF NOT EXISTS level_set_hash text,
  ADD COLUMN IF NOT EXISTS source_level_set_run_id uuid;

ALTER TABLE operations_commerce_inventory_sync_runs
  DROP CONSTRAINT IF EXISTS operations_commerce_inventory_level_set_hash_valid,
  ADD CONSTRAINT operations_commerce_inventory_level_set_hash_valid
    CHECK (level_set_hash IS NULL OR level_set_hash ~ '^[a-f0-9]{64}$')
    NOT VALID,
  DROP CONSTRAINT IF EXISTS operations_commerce_inventory_level_set_source_valid,
  ADD CONSTRAINT operations_commerce_inventory_level_set_source_valid
    CHECK (
      source_level_set_run_id IS NULL
      OR (
        source_level_set_run_id <> id
        AND status = 'succeeded'
        AND level_set_hash IS NOT NULL
      )
    )
    NOT VALID;

ALTER TABLE operations_commerce_inventory_sync_runs
  DROP CONSTRAINT IF EXISTS operations_commerce_inventory_level_set_source_fkey,
  ADD CONSTRAINT operations_commerce_inventory_level_set_source_fkey
    FOREIGN KEY (
      organization_id, integration_account_id, source_level_set_run_id
    ) REFERENCES operations_commerce_inventory_sync_runs(
      organization_id, integration_account_id, id
    ) ON DELETE RESTRICT NOT VALID;

CREATE OR REPLACE FUNCTION validate_operations_commerce_inventory_level_set_alias()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  source_run operations_commerce_inventory_sync_runs%ROWTYPE;
  source_level_count bigint;
BEGIN
  IF NEW.source_level_set_run_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT source.* INTO source_run
  FROM operations_commerce_inventory_sync_runs source
  WHERE source.organization_id = NEW.organization_id
    AND source.integration_account_id = NEW.integration_account_id
    AND source.id = NEW.source_level_set_run_id
  FOR SHARE;
  IF NOT FOUND
     OR source_run.status <> 'succeeded'
     OR source_run.source_level_set_run_id IS NOT NULL
     OR source_run.level_set_hash IS DISTINCT FROM NEW.level_set_hash
     OR source_run.location_mapping_id IS DISTINCT FROM NEW.location_mapping_id
     OR source_run.warehouse_id IS DISTINCT FROM NEW.warehouse_id
     OR source_run.location_id IS DISTINCT FROM NEW.location_id
     OR source_run.inventory_pool_id IS DISTINCT FROM NEW.inventory_pool_id
     OR source_run.provider_location_id IS DISTINCT FROM NEW.provider_location_id
     OR source_run.levels_seen IS DISTINCT FROM NEW.levels_seen
     OR source_run.levels_mapped IS DISTINCT FROM NEW.levels_mapped
     OR source_run.levels_projected IS DISTINCT FROM NEW.levels_projected
     OR source_run.levels_unmapped IS DISTINCT FROM NEW.levels_unmapped
     OR source_run.levels_untracked IS DISTINCT FROM NEW.levels_untracked
     OR source_run.negative_available_levels
          IS DISTINCT FROM NEW.negative_available_levels
     OR source_run.equation_mismatch_levels
          IS DISTINCT FROM NEW.equation_mismatch_levels THEN
    RAISE EXCEPTION
      'Commerce inventory level-set alias does not match its source run';
  END IF;
  SELECT count(*) INTO source_level_count
  FROM operations_commerce_inventory_levels level
  WHERE level.organization_id = NEW.organization_id
    AND level.integration_account_id = NEW.integration_account_id
    AND level.sync_run_id = NEW.source_level_set_run_id;
  IF source_level_count <> NEW.levels_seen THEN
    RAISE EXCEPTION
      'Commerce inventory level-set alias source is incomplete';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_operations_commerce_inventory_level_set_alias
  ON operations_commerce_inventory_sync_runs;
CREATE TRIGGER validate_operations_commerce_inventory_level_set_alias
BEFORE INSERT ON operations_commerce_inventory_sync_runs
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_commerce_inventory_level_set_alias();

CREATE OR REPLACE FUNCTION
  reject_operations_commerce_inventory_level_for_alias()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM operations_commerce_inventory_sync_runs run
    WHERE run.organization_id = NEW.organization_id
      AND run.integration_account_id = NEW.integration_account_id
      AND run.id = NEW.sync_run_id
      AND run.source_level_set_run_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'Commerce inventory observation alias cannot own level rows';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS reject_operations_commerce_inventory_level_for_alias
  ON operations_commerce_inventory_levels;
CREATE TRIGGER reject_operations_commerce_inventory_level_for_alias
BEFORE INSERT ON operations_commerce_inventory_levels
FOR EACH ROW EXECUTE FUNCTION
  reject_operations_commerce_inventory_level_for_alias();

-- Provider commitments continue to use the newest observation for freshness,
-- but an unchanged observation owns no duplicate levels. Resolve the effective
-- immutable level-set run while returning the alias run as the latest proof.
CREATE OR REPLACE FUNCTION operations_provider_commitment_current_support(
  p_organization_id uuid,
  p_reservation_id uuid,
  p_position_id uuid DEFAULT NULL,
  p_order_id uuid DEFAULT NULL,
  p_order_line_id uuid DEFAULT NULL,
  p_quantity numeric DEFAULT NULL,
  p_status text DEFAULT NULL,
  p_provider_inventory_sync_run_id uuid DEFAULT NULL,
  p_provider_inventory_level_id uuid DEFAULT NULL
)
RETURNS TABLE (
  reservation_id uuid,
  latest_inventory_sync_run_id uuid,
  latest_inventory_sync_run_global_id text,
  latest_inventory_level_global_ids text[],
  latest_provider_committed_quantity numeric(20,6),
  active_claimed_quantity numeric(20,6),
  position_on_hand_quantity numeric(20,6),
  position_reserved_quantity numeric(20,6),
  supported boolean,
  reason_code text
)
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  stored_reservation operations_reservations%ROWTYPE;
  source_order operations_orders%ROWTYPE;
  source_line operations_order_lines%ROWTYPE;
  source_position operations_inventory_positions%ROWTYPE;
  source_run operations_commerce_inventory_sync_runs%ROWTYPE;
  source_level operations_commerce_inventory_levels%ROWTYPE;
  latest_run operations_commerce_inventory_sync_runs%ROWTYPE;
  context_position_id uuid;
  context_order_id uuid;
  context_order_line_id uuid;
  context_quantity numeric(20,6);
  context_status text;
  context_sync_run_id uuid;
  context_level_id uuid;
  candidate_level_count integer := 0;
  valid_level_count integer := 0;
  invalid_level_count integer := 0;
  latest_committed numeric(20,6) := 0;
  latest_available numeric(20,6) := 0;
  other_active_claims numeric(20,6) := 0;
  total_active_claims numeric(20,6) := 0;
  latest_level_global_ids text[] := ARRAY[]::text[];
  result_supported boolean := false;
  result_reason text := 'SHOPIFY_INVENTORY_PROVIDER_COMMITMENT_MISSING';
BEGIN
  SELECT * INTO stored_reservation
  FROM operations_reservations reservation
  WHERE reservation.organization_id = p_organization_id
    AND reservation.id = p_reservation_id;

  IF stored_reservation.id IS NOT NULL THEN
    IF stored_reservation.reservation_authority
         IS DISTINCT FROM 'provider_commitment' THEN
      RETURN QUERY SELECT
        p_reservation_id, NULL::uuid, NULL::text, ARRAY[]::text[],
        0::numeric(20,6), 0::numeric(20,6),
        NULL::numeric(20,6), NULL::numeric(20,6), false,
        'SHOPIFY_INVENTORY_NOT_PROVIDER_COMMITMENT'::text;
      RETURN;
    END IF;
    context_position_id := stored_reservation.position_id;
    context_order_id := stored_reservation.order_id;
    context_order_line_id := stored_reservation.order_line_id;
    context_quantity := stored_reservation.quantity;
    context_status := stored_reservation.status;
    context_sync_run_id :=
      stored_reservation.provider_inventory_sync_run_id;
    context_level_id := stored_reservation.provider_inventory_level_id;
  ELSE
    context_position_id := p_position_id;
    context_order_id := p_order_id;
    context_order_line_id := p_order_line_id;
    context_quantity := p_quantity;
    context_status := p_status;
    context_sync_run_id := p_provider_inventory_sync_run_id;
    context_level_id := p_provider_inventory_level_id;
  END IF;

  IF context_position_id IS NULL
     OR context_order_id IS NULL
     OR context_order_line_id IS NULL
     OR context_quantity IS NULL
     OR context_quantity <= 0
     OR context_status IS NULL
     OR context_sync_run_id IS NULL
     OR context_level_id IS NULL THEN
    RETURN QUERY SELECT
      p_reservation_id, NULL::uuid, NULL::text, ARRAY[]::text[],
      0::numeric(20,6), 0::numeric(20,6),
      NULL::numeric(20,6), NULL::numeric(20,6), false,
      result_reason;
    RETURN;
  END IF;

  SELECT * INTO source_position
  FROM operations_inventory_positions position
  WHERE position.organization_id = p_organization_id
    AND position.id = context_position_id;
  SELECT * INTO source_order
  FROM operations_orders source
  WHERE source.organization_id = p_organization_id
    AND source.id = context_order_id;
  SELECT * INTO source_line
  FROM operations_order_lines line
  WHERE line.organization_id = p_organization_id
    AND line.id = context_order_line_id;
  SELECT * INTO source_run
  FROM operations_commerce_inventory_sync_runs run
  WHERE run.organization_id = p_organization_id
    AND run.id = context_sync_run_id;
  SELECT * INTO source_level
  FROM operations_commerce_inventory_levels level
  WHERE level.organization_id = p_organization_id
    AND level.sync_run_id = context_sync_run_id
    AND level.id = context_level_id
    AND level.inventory_position_id = context_position_id;

  IF source_position.id IS NULL
     OR source_order.id IS NULL
     OR source_line.id IS NULL
     OR source_run.id IS NULL
     OR source_level.id IS NULL
     OR source_line.order_id IS DISTINCT FROM context_order_id
     OR source_line.product_id IS DISTINCT FROM source_position.product_id
     OR source_position.source_authority IS DISTINCT FROM 'shopify'
     OR source_order.source_provider IS DISTINCT FROM 'shopify'
     OR source_run.status IS DISTINCT FROM 'succeeded'
     OR source_run.provider IS DISTINCT FROM 'shopify'
     OR source_run.integration_account_id
          IS DISTINCT FROM source_order.integration_account_id
     OR source_level.projection_state IS DISTINCT FROM 'projected'
     OR source_level.mapping_state IS DISTINCT FROM 'mapped'
     OR source_level.tracked IS DISTINCT FROM true
     OR source_level.equation_matches IS DISTINCT FROM true
     OR source_level.product_id IS DISTINCT FROM source_line.product_id
     OR source_level.pipeline_id IS DISTINCT FROM source_line.pipeline_id THEN
    result_reason := 'SHOPIFY_INVENTORY_PROVIDER_EVIDENCE_INVALID';
    RETURN QUERY SELECT
      p_reservation_id, NULL::uuid, NULL::text, ARRAY[]::text[],
      0::numeric(20,6), 0::numeric(20,6),
      source_position.on_hand_quantity,
      source_position.reserved_quantity,
      false, result_reason;
    RETURN;
  END IF;

  SELECT newer.* INTO latest_run
  FROM operations_commerce_inventory_sync_runs newer
  WHERE newer.organization_id = p_organization_id
    AND newer.integration_account_id = source_run.integration_account_id
    AND newer.provider_location_id = source_run.provider_location_id
    AND newer.provider = 'shopify'
    AND newer.status = 'succeeded'
  ORDER BY newer.completed_at DESC, newer.id DESC
  LIMIT 1;

  IF latest_run.id IS NULL THEN
    result_reason := 'SHOPIFY_INVENTORY_LATEST_RUN_MISSING';
  ELSE
    SELECT
      count(*)::integer,
      count(*) FILTER (
        WHERE level.mapping_state = 'mapped'
          AND level.projection_state = 'projected'
          AND level.tracked = true
          AND level.equation_matches = true
          AND level.product_id = source_line.product_id
          AND level.pipeline_id = source_line.pipeline_id
          AND level.inventory_position_id = context_position_id
      )::integer,
      count(*) FILTER (
        WHERE NOT (
          level.mapping_state = 'mapped'
          AND level.projection_state = 'projected'
          AND level.tracked = true
          AND level.equation_matches = true
          AND level.product_id = source_line.product_id
          AND level.pipeline_id = source_line.pipeline_id
          AND level.inventory_position_id = context_position_id
        )
      )::integer,
      COALESCE(sum(level.provider_committed_quantity) FILTER (
        WHERE level.mapping_state = 'mapped'
          AND level.projection_state = 'projected'
          AND level.tracked = true
          AND level.equation_matches = true
          AND level.product_id = source_line.product_id
          AND level.pipeline_id = source_line.pipeline_id
          AND level.inventory_position_id = context_position_id
      ), 0),
      COALESCE(sum(level.operational_available_quantity) FILTER (
        WHERE level.mapping_state = 'mapped'
          AND level.projection_state = 'projected'
          AND level.tracked = true
          AND level.equation_matches = true
          AND level.product_id = source_line.product_id
          AND level.pipeline_id = source_line.pipeline_id
          AND level.inventory_position_id = context_position_id
      ), 0),
      COALESCE(array_agg(level.global_id ORDER BY level.global_id) FILTER (
        WHERE level.mapping_state = 'mapped'
          AND level.projection_state = 'projected'
          AND level.tracked = true
          AND level.equation_matches = true
          AND level.product_id = source_line.product_id
          AND level.pipeline_id = source_line.pipeline_id
          AND level.inventory_position_id = context_position_id
      ), ARRAY[]::text[])
    INTO candidate_level_count, valid_level_count, invalid_level_count,
         latest_committed, latest_available, latest_level_global_ids
    FROM operations_commerce_inventory_levels level
    WHERE level.organization_id = p_organization_id
      AND level.sync_run_id = COALESCE(
        latest_run.source_level_set_run_id, latest_run.id
      )
      AND level.provider_location_id = source_run.provider_location_id
      AND (
        level.product_id = source_line.product_id
        OR level.external_inventory_item_id
             = source_level.external_inventory_item_id
      );

    SELECT COALESCE(sum(reservation.quantity), 0)
      INTO other_active_claims
    FROM operations_reservations reservation
    WHERE reservation.organization_id = p_organization_id
      AND reservation.position_id = context_position_id
      AND reservation.reservation_authority = 'provider_commitment'
      AND reservation.status = 'active'
      AND reservation.id IS DISTINCT FROM p_reservation_id;

    total_active_claims := other_active_claims + CASE
      WHEN context_status = 'active' THEN context_quantity
      ELSE 0::numeric
    END;

    IF candidate_level_count = 0 OR valid_level_count = 0 THEN
      result_reason := 'SHOPIFY_INVENTORY_PRODUCT_EVIDENCE_MISSING';
    ELSIF invalid_level_count > 0 THEN
      result_reason := 'SHOPIFY_INVENTORY_PRODUCT_EVIDENCE_INVALID';
    ELSIF source_position.reserved_quantity
            IS DISTINCT FROM latest_committed
       OR source_position.on_hand_quantity
            IS DISTINCT FROM latest_available + latest_committed THEN
      result_reason := 'SHOPIFY_INVENTORY_POSITION_MISMATCH';
    ELSIF total_active_claims > latest_committed THEN
      result_reason :=
        'SHOPIFY_INVENTORY_PROVIDER_COMMITMENT_CONFLICT';
    ELSE
      result_supported := true;
      result_reason := 'OK';
    END IF;
  END IF;

  RETURN QUERY SELECT
    p_reservation_id,
    latest_run.id,
    latest_run.global_id,
    latest_level_global_ids,
    latest_committed,
    total_active_claims,
    source_position.on_hand_quantity,
    source_position.reserved_quantity,
    result_supported,
    result_reason;
END;
$$;

-- Raw inventory snapshots are replay aids, not the durable quantity ledger.
-- Keep their immutable hash, original byte count, level count, capture, run,
-- and projected levels forever, while bounding the optional wide JSON. A
-- purged hash may later recur, so uniqueness applies only to live payloads;
-- the new observation receives a new content row and can again be replayed.
-- Only the newest successful observation keeps mandatory replay JSON. Older
-- reservation, cartonization, and watermark proofs remain intact through
-- their immutable capture/run/level rows and the content tombstone's hash,
-- byte count, and level count; those references do not defeat the hard cap.
ALTER TABLE operations_commerce_inventory_snapshot_contents
  ADD COLUMN IF NOT EXISTS payload_purged_at timestamptz,
  ALTER COLUMN snapshot_content DROP NOT NULL,
  DROP CONSTRAINT IF EXISTS
    operations_commerce_inventory_snapshot_contents_hash_unique,
  DROP CONSTRAINT IF EXISTS
    operations_commerce_inventory_snapshot_contents_payload_valid,
  ADD CONSTRAINT
    operations_commerce_inventory_snapshot_contents_payload_valid CHECK (
      (
        snapshot_content IS NOT NULL
        AND jsonb_typeof(snapshot_content) = 'object'
        AND NOT snapshot_content ? 'fetchedAt'
        AND NOT snapshot_content ? 'pageCount'
        AND snapshot_content->>'snapshotHash' = snapshot_hash
        AND snapshot_content#>>'{location,id}' = provider_location_id
        AND jsonb_typeof(snapshot_content->'levels') = 'array'
        AND jsonb_array_length(snapshot_content->'levels') = level_count
        AND payload_purged_at IS NULL
      )
      OR (
        snapshot_content IS NULL
        AND payload_purged_at IS NOT NULL
        AND payload_purged_at >= created_at
      )
    ) NOT VALID;

CREATE OR REPLACE VIEW
  operations_commerce_inventory_snapshot_payload_retention
AS
WITH latest_observation AS (
  SELECT DISTINCT ON (
    run.organization_id,
    run.integration_account_id,
    run.provider_location_id
  )
    run.organization_id,
    run.integration_account_id,
    run.provider_location_id,
    capture.snapshot_content_id
  FROM operations_commerce_inventory_sync_runs run
  LEFT JOIN operations_commerce_inventory_captures capture
    ON capture.organization_id = run.organization_id
   AND capture.integration_account_id = run.integration_account_id
   AND capture.id = run.capture_id
  WHERE run.status = 'succeeded'
  ORDER BY
    run.organization_id,
    run.integration_account_id,
    run.provider_location_id,
    run.completed_at DESC,
    run.id DESC
)
SELECT
  content.id,
  content.organization_id,
  content.integration_account_id,
  content.provider_location_id,
  content.created_at,
  COALESCE(latest.snapshot_content_id = content.id, false)
    AS current_payload,
  row_number() OVER (
    PARTITION BY content.organization_id,
                 content.integration_account_id,
                 content.provider_location_id
    ORDER BY
      COALESCE(latest.snapshot_content_id = content.id, false) DESC,
      content.created_at DESC,
      content.id DESC
  ) AS payload_rank
FROM operations_commerce_inventory_snapshot_contents content
LEFT JOIN latest_observation latest
  ON latest.organization_id = content.organization_id
 AND latest.integration_account_id = content.integration_account_id
 AND latest.provider_location_id = content.provider_location_id
WHERE content.snapshot_content IS NOT NULL;

CREATE OR REPLACE FUNCTION
  validate_operations_commerce_inventory_capture_content()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.snapshot_content_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM operations_commerce_inventory_snapshot_contents content
      WHERE content.organization_id = NEW.organization_id
        AND content.integration_account_id = NEW.integration_account_id
        AND content.id = NEW.snapshot_content_id
        AND content.provider = NEW.provider
        AND content.adapter_version = NEW.adapter_version
        AND content.provider_location_id = NEW.provider_location_id
        AND content.snapshot_hash = NEW.snapshot_hash
        AND content.level_count = NEW.level_count
        AND content.snapshot_content IS NOT NULL
        AND content.payload_purged_at IS NULL
    ) THEN
      RAISE EXCEPTION
        'Commerce inventory capture content does not match live replay evidence';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION
  operations_commerce_inventory_snapshot_content_is_purgeable(
    p_organization_id uuid,
    p_integration_account_id uuid,
    p_content_id uuid
  )
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT COALESCE((
    SELECT (
      ranked.payload_rank > 32
      OR (
        ranked.payload_rank > 8
        AND ranked.created_at < now() - interval '30 days'
      )
    )
      AND NOT ranked.current_payload
      -- A captured prepared attempt is an exact crash/retry boundary. Its
      -- content remains replayable until projection either succeeds or the
      -- attempt reaches a terminal state.
      AND NOT EXISTS (
        SELECT 1
        FROM operations_commerce_inventory_captures capture
        JOIN operations_commerce_provider_attempts attempt
          ON attempt.organization_id = capture.organization_id
         AND attempt.integration_account_id =
             capture.integration_account_id
         AND attempt.id = capture.provider_attempt_id
        WHERE capture.organization_id = ranked.organization_id
          AND capture.integration_account_id =
              ranked.integration_account_id
          AND capture.snapshot_content_id = ranked.id
          AND attempt.state = 'prepared'
      )
    FROM operations_commerce_inventory_snapshot_payload_retention ranked
    WHERE ranked.organization_id = p_organization_id
      AND ranked.integration_account_id = p_integration_account_id
      AND ranked.id = p_content_id
  ), false);
$$;

CREATE OR REPLACE FUNCTION
  purge_operations_commerce_inventory_snapshot_payloads(
    p_limit integer DEFAULT 100
  )
RETURNS TABLE (purged_rows integer, purged_bytes bigint)
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  content_row record;
  current_bytes bigint;
  total_rows integer := 0;
  total_bytes bigint := 0;
BEGIN
  IF p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'commerce inventory snapshot payload limit is invalid';
  END IF;
  PERFORM set_config(
    'clawpilot.commerce_inventory_snapshot_payload_compaction', 'on', true
  );
  FOR content_row IN
    SELECT content.id, content.organization_id,
           content.integration_account_id, content.provider,
           content.adapter_version, content.provider_location_id,
           content.snapshot_hash
    FROM operations_commerce_inventory_snapshot_contents content
    JOIN operations_commerce_inventory_snapshot_payload_retention ranked
      ON ranked.organization_id = content.organization_id
     AND ranked.integration_account_id = content.integration_account_id
     AND ranked.id = content.id
    WHERE (
      ranked.payload_rank > 32
      OR (
        ranked.payload_rank > 8
        AND ranked.created_at < now() - interval '30 days'
      )
    )
      AND NOT ranked.current_payload
      AND operations_commerce_inventory_snapshot_content_is_purgeable(
        content.organization_id, content.integration_account_id, content.id
      )
    ORDER BY content.created_at, content.id
    LIMIT p_limit
  LOOP
    -- Capture and purge acquire the immutable provider-content identity lock
    -- before either can lock the content row. Taking FOR UPDATE while selecting
    -- candidates would invert the production capture order (advisory lock,
    -- then FK key-share) and can deadlock. The UPDATE obtains the row lock only
    -- after this advisory lock and freshly rechecks prepared-attempt evidence.
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'commerce-inventory-snapshot-content:'
      || content_row.organization_id::text || ':'
      || content_row.integration_account_id::text || ':'
      || content_row.provider || ':'
      || content_row.adapter_version || ':'
      || content_row.provider_location_id || ':'
      || content_row.snapshot_hash,
      0
    ));
    current_bytes := NULL;
    UPDATE operations_commerce_inventory_snapshot_contents content
    SET snapshot_content = NULL,
        payload_purged_at = now()
    WHERE content.organization_id = content_row.organization_id
      AND content.integration_account_id = content_row.integration_account_id
      AND content.id = content_row.id
      AND content.snapshot_content IS NOT NULL
      AND operations_commerce_inventory_snapshot_content_is_purgeable(
        content.organization_id, content.integration_account_id, content.id
      )
    RETURNING content.content_bytes::bigint INTO current_bytes;
    IF current_bytes IS NOT NULL THEN
      total_rows := total_rows + 1;
      total_bytes := total_bytes + current_bytes;
    END IF;
  END LOOP;
  RETURN QUERY SELECT total_rows, total_bytes;
END;
$$;

-- Both foreground workers may offer to maintain storage every ten seconds.
-- This persisted singleton makes that offer a cheap, atomic lease instead of
-- duplicating global ranked scans. Each purge statement remains bounded.
CREATE TABLE IF NOT EXISTS operations_commerce_storage_maintenance_lanes (
  lane_name text PRIMARY KEY CHECK (lane_name = 'commerce-storage'),
  next_run_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_owner text,
  lease_expires_at timestamptz,
  last_started_at timestamptz,
  last_completed_at timestamptz,
  last_failed_at timestamptz,
  last_error_code text,
  last_result jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(last_result) = 'object'
  ),
  row_version bigint NOT NULL DEFAULT 0 CHECK (row_version >= 0),
  CHECK (
    (lease_token IS NULL AND lease_owner IS NULL AND lease_expires_at IS NULL)
    OR (
      lease_token IS NOT NULL
      AND length(btrim(lease_owner)) BETWEEN 1 AND 160
      AND lease_expires_at IS NOT NULL
    )
  )
);

INSERT INTO operations_commerce_storage_maintenance_lanes (lane_name)
VALUES ('commerce-storage')
ON CONFLICT (lane_name) DO NOTHING;

CREATE OR REPLACE FUNCTION claim_operations_commerce_storage_maintenance(
  p_lease_owner text,
  p_cadence_seconds integer DEFAULT 10,
  p_lease_seconds integer DEFAULT 120
)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  claimed_token uuid;
BEGIN
  IF p_lease_owner IS NULL
     OR length(btrim(p_lease_owner)) NOT BETWEEN 1 AND 160
     OR p_cadence_seconds NOT BETWEEN 5 AND 3600
     OR p_lease_seconds NOT BETWEEN 30 AND 900 THEN
    RAISE EXCEPTION 'commerce storage maintenance lease is invalid';
  END IF;
  UPDATE operations_commerce_storage_maintenance_lanes lane
  SET lease_token = gen_random_uuid(),
      lease_owner = btrim(p_lease_owner),
      lease_expires_at = clock_timestamp()
        + make_interval(secs => p_lease_seconds),
      next_run_at = clock_timestamp()
        + make_interval(secs => p_cadence_seconds),
      last_started_at = clock_timestamp(),
      row_version = lane.row_version + 1
  WHERE lane.lane_name = 'commerce-storage'
    AND lane.next_run_at <= clock_timestamp()
    AND (
      lane.lease_token IS NULL
      OR lane.lease_expires_at <= clock_timestamp()
    )
  RETURNING lane.lease_token INTO claimed_token;
  RETURN claimed_token;
END;
$$;

CREATE OR REPLACE FUNCTION complete_operations_commerce_storage_maintenance(
  p_lease_token uuid,
  p_result jsonb,
  p_error_code text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  completed boolean;
BEGIN
  IF p_lease_token IS NULL
     OR p_result IS NULL
     OR jsonb_typeof(p_result) <> 'object'
     OR (p_error_code IS NOT NULL AND (
       length(btrim(p_error_code)) NOT BETWEEN 1 AND 160
       OR p_error_code ~ '[[:cntrl:]]'
     )) THEN
    RAISE EXCEPTION 'commerce storage maintenance completion is invalid';
  END IF;
  UPDATE operations_commerce_storage_maintenance_lanes lane
  SET lease_token = NULL,
      lease_owner = NULL,
      lease_expires_at = NULL,
      last_completed_at = CASE
        WHEN p_error_code IS NULL THEN clock_timestamp()
        ELSE lane.last_completed_at
      END,
      last_failed_at = CASE
        WHEN p_error_code IS NULL THEN lane.last_failed_at
        ELSE clock_timestamp()
      END,
      last_error_code = NULLIF(btrim(p_error_code), ''),
      last_result = p_result,
      next_run_at = CASE
        WHEN p_error_code IS NULL THEN lane.next_run_at
        ELSE clock_timestamp() + interval '10 seconds'
      END,
      row_version = lane.row_version + 1
  WHERE lane.lane_name = 'commerce-storage'
    AND lane.lease_token = p_lease_token
    AND lane.lease_expires_at > clock_timestamp()
  RETURNING true INTO completed;
  RETURN COALESCE(completed, false);
END;
$$;

CREATE OR REPLACE FUNCTION renew_operations_commerce_storage_maintenance(
  p_lease_token uuid,
  p_lease_seconds integer DEFAULT 120
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  renewed boolean;
BEGIN
  IF p_lease_token IS NULL
     OR p_lease_seconds NOT BETWEEN 30 AND 900 THEN
    RAISE EXCEPTION 'commerce storage maintenance renewal is invalid';
  END IF;
  UPDATE operations_commerce_storage_maintenance_lanes lane
  SET lease_expires_at = clock_timestamp()
        + make_interval(secs => p_lease_seconds),
      row_version = lane.row_version + 1
  WHERE lane.lane_name = 'commerce-storage'
    AND lane.lease_token = p_lease_token
    AND lane.lease_expires_at > clock_timestamp()
  RETURNING true INTO renewed;
  RETURN COALESCE(renewed, false);
END;
$$;

CREATE OR REPLACE FUNCTION
  convert_operations_commerce_inventory_legacy_captures(
    p_limit integer DEFAULT 25
  )
RETURNS TABLE (converted_rows integer, converted_bytes bigint)
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  capture_row operations_commerce_inventory_captures%ROWTYPE;
  content_json jsonb;
  content_id uuid;
  content_byte_count integer;
  page_count integer;
  total_rows integer := 0;
  total_bytes bigint := 0;
BEGIN
  IF p_limit < 1 OR p_limit > 250 THEN
    RAISE EXCEPTION 'legacy commerce inventory capture limit is invalid';
  END IF;
  PERFORM set_config(
    'clawpilot.commerce_inventory_capture_conversion', 'on', true
  );
  FOR capture_row IN
    SELECT capture.*
    FROM operations_commerce_inventory_captures capture
    WHERE capture.captured_snapshot IS NOT NULL
      AND capture.snapshot_content_id IS NULL
      AND jsonb_typeof(capture.captured_snapshot) = 'object'
    ORDER BY capture.created_at, capture.id
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  LOOP
    content_json := capture_row.captured_snapshot
      - 'fetchedAt' - 'pageCount';
    content_byte_count := octet_length(
      convert_to(content_json::text, 'UTF8')
    );
    page_count := LEAST(400, GREATEST(
      1,
      CASE
        WHEN capture_row.captured_snapshot->>'pageCount' ~ '^[0-9]{1,3}$'
          THEN (capture_row.captured_snapshot->>'pageCount')::integer
        WHEN capture_row.captured_snapshot->>'pageCount' ~ '^[0-9]+$'
          THEN 400
        ELSE 1
      END
    ));
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'commerce-inventory-snapshot-content:'
      || capture_row.organization_id::text || ':'
      || capture_row.integration_account_id::text || ':'
      || capture_row.provider || ':'
      || capture_row.adapter_version || ':'
      || capture_row.provider_location_id || ':'
      || capture_row.snapshot_hash,
      0
    ));
    INSERT INTO operations_commerce_inventory_snapshot_contents (
      organization_id, integration_account_id, provider,
      adapter_version, provider_location_id, snapshot_hash, level_count,
      snapshot_content, content_bytes, created_by
    ) VALUES (
      capture_row.organization_id,
      capture_row.integration_account_id,
      capture_row.provider,
      capture_row.adapter_version,
      capture_row.provider_location_id,
      capture_row.snapshot_hash,
      capture_row.level_count,
      content_json,
      content_byte_count,
      capture_row.created_by
    )
    ON CONFLICT (
      organization_id, integration_account_id, provider_location_id,
      adapter_version, snapshot_hash
    ) WHERE snapshot_content IS NOT NULL DO NOTHING
    RETURNING id INTO content_id;
    IF content_id IS NULL THEN
      SELECT content.id INTO content_id
      FROM operations_commerce_inventory_snapshot_contents content
      WHERE content.organization_id = capture_row.organization_id
        AND content.integration_account_id =
            capture_row.integration_account_id
        AND content.provider_location_id = capture_row.provider_location_id
        AND content.adapter_version = capture_row.adapter_version
        AND content.snapshot_hash = capture_row.snapshot_hash
        AND content.level_count = capture_row.level_count
        AND content.payload_purged_at IS NULL
        AND content.snapshot_content = content_json;
    END IF;
    IF content_id IS NULL THEN
      RAISE EXCEPTION
        'Legacy commerce inventory capture content conflicts with its hash';
    END IF;
    UPDATE operations_commerce_inventory_captures capture
    SET captured_snapshot = NULL,
        snapshot_content_id = content_id,
        provider_page_count = page_count
    WHERE capture.id = capture_row.id;
    total_rows := total_rows + 1;
    total_bytes := total_bytes
      + pg_column_size(capture_row.captured_snapshot);
  END LOOP;
  RETURN QUERY SELECT total_rows, total_bytes;
END;
$$;

CREATE OR REPLACE FUNCTION protect_operations_commerce_inventory_evidence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  evidence_rank bigint;
  completed_at timestamptz;
BEGIN
  IF TG_OP = 'UPDATE'
     AND TG_TABLE_NAME =
       'operations_commerce_inventory_snapshot_contents' THEN
    IF current_setting(
         'clawpilot.commerce_inventory_snapshot_payload_compaction', true
       ) = 'on'
       AND OLD.snapshot_content IS NOT NULL
       AND OLD.payload_purged_at IS NULL
       AND NEW.snapshot_content IS NULL
       AND NEW.payload_purged_at IS NOT NULL
       AND (
         to_jsonb(NEW) - ARRAY['snapshot_content', 'payload_purged_at']
       ) IS NOT DISTINCT FROM (
         to_jsonb(OLD) - ARRAY['snapshot_content', 'payload_purged_at']
       )
       AND operations_commerce_inventory_snapshot_content_is_purgeable(
         OLD.organization_id, OLD.integration_account_id, OLD.id
       ) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF TG_OP = 'UPDATE'
     AND TG_TABLE_NAME = 'operations_commerce_inventory_captures' THEN
    IF current_setting(
         'clawpilot.commerce_inventory_capture_conversion', true
       ) = 'on'
       AND OLD.captured_snapshot IS NOT NULL
       AND OLD.snapshot_content_id IS NULL
       AND NEW.captured_snapshot IS NULL
       AND NEW.snapshot_content_id IS NOT NULL
       AND NEW.provider_page_count BETWEEN 1 AND 400
       AND (
         to_jsonb(NEW) - ARRAY[
           'captured_snapshot', 'snapshot_content_id', 'provider_page_count'
         ]
       ) IS NOT DISTINCT FROM (
         to_jsonb(OLD) - ARRAY[
           'captured_snapshot', 'snapshot_content_id', 'provider_page_count'
         ]
       )
       AND EXISTS (
         SELECT 1
         FROM operations_commerce_inventory_snapshot_contents content
         WHERE content.organization_id = NEW.organization_id
           AND content.integration_account_id = NEW.integration_account_id
           AND content.id = NEW.snapshot_content_id
           AND content.provider = NEW.provider
           AND content.adapter_version = NEW.adapter_version
           AND content.provider_location_id = NEW.provider_location_id
           AND content.snapshot_hash = NEW.snapshot_hash
           AND content.level_count = NEW.level_count
       ) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF TG_OP = 'DELETE'
     AND TG_TABLE_NAME = 'operations_commerce_inventory_sync_runs' THEN
    IF current_setting(
         'clawpilot.commerce_inventory_alias_compaction', true
       ) = 'on'
       AND OLD.source_level_set_run_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM operations_commerce_inventory_levels level
         WHERE level.organization_id = OLD.organization_id
           AND level.integration_account_id = OLD.integration_account_id
           AND level.sync_run_id = OLD.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM operations_reservations reservation
         WHERE reservation.organization_id = OLD.organization_id
           AND reservation.provider_inventory_sync_run_id = OLD.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM operations_cartonization_rate_evidence evidence
         WHERE evidence.organization_id = OLD.organization_id
           AND evidence.inventory_sync_run_id = OLD.id
       )
       AND NOT EXISTS (
         SELECT 1
         FROM operations_shopify_inventory_refresh_watermarks watermark
         WHERE watermark.organization_id = OLD.organization_id
           AND watermark.last_reconciled_run_global_id = OLD.global_id
       )
       AND (
         SELECT count(*)
         FROM operations_commerce_inventory_sync_runs newer
         WHERE newer.organization_id = OLD.organization_id
           AND newer.integration_account_id = OLD.integration_account_id
           AND newer.location_mapping_id = OLD.location_mapping_id
           AND newer.status = 'succeeded'
           AND ROW(newer.completed_at, newer.id)
               > ROW(OLD.completed_at, OLD.id)
       ) >= 128 THEN
      RETURN OLD;
    END IF;
  END IF;
  IF TG_OP = 'DELETE'
     AND TG_TABLE_NAME = 'operations_commerce_inventory_levels'
     AND current_setting(
       'clawpilot.commerce_inventory_compaction', true
     ) = 'on' THEN
    SELECT run.completed_at,
           1 + count(newer.id)
    INTO completed_at, evidence_rank
    FROM operations_commerce_inventory_sync_runs run
    LEFT JOIN operations_commerce_inventory_sync_runs newer
      ON newer.organization_id = run.organization_id
     AND newer.integration_account_id = run.integration_account_id
     AND newer.location_mapping_id = run.location_mapping_id
     AND newer.status = 'succeeded'
     AND ROW(newer.completed_at, newer.id) > ROW(run.completed_at, run.id)
    WHERE run.organization_id = OLD.organization_id
      AND run.integration_account_id = OLD.integration_account_id
      AND run.id = OLD.sync_run_id
      AND run.status = 'succeeded'
      AND run.source_level_set_run_id IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM operations_commerce_inventory_sync_runs alias
        WHERE alias.organization_id = run.organization_id
          AND alias.integration_account_id = run.integration_account_id
          AND alias.source_level_set_run_id = run.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM operations_reservations reservation
        WHERE reservation.organization_id = run.organization_id
          AND reservation.provider_inventory_sync_run_id = run.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM operations_cartonization_rate_evidence evidence
        WHERE evidence.organization_id = run.organization_id
          AND evidence.inventory_sync_run_id = run.id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM operations_shopify_inventory_refresh_watermarks watermark
        WHERE watermark.organization_id = run.organization_id
          AND watermark.last_reconciled_run_global_id = run.global_id
      )
    GROUP BY run.completed_at;
    IF FOUND AND (
      evidence_rank > 128
      OR (evidence_rank > 32 AND completed_at < now() - interval '90 days')
    ) THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'Commerce inventory evidence is immutable';
END;
$$;

CREATE OR REPLACE FUNCTION
  purge_operations_commerce_inventory_observation_aliases(
    p_limit integer DEFAULT 1000
  )
RETURNS TABLE (purged_rows integer, purged_bytes bigint)
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_limit < 1 OR p_limit > 5000 THEN
    RAISE EXCEPTION 'commerce inventory alias purge limit is invalid';
  END IF;
  PERFORM set_config(
    'clawpilot.commerce_inventory_alias_compaction', 'on', true
  );
  RETURN QUERY
  WITH ranked AS (
    SELECT run.id, run.organization_id, run.integration_account_id,
           row_number() OVER (
             PARTITION BY run.organization_id, run.integration_account_id,
                          run.location_mapping_id
             ORDER BY run.completed_at DESC, run.id DESC
           ) AS observation_rank
    FROM operations_commerce_inventory_sync_runs run
    WHERE run.status = 'succeeded'
  ), due AS (
    SELECT run.id, pg_column_size(run.*)::bigint AS row_bytes
    FROM operations_commerce_inventory_sync_runs run
    JOIN ranked
      ON ranked.organization_id = run.organization_id
     AND ranked.integration_account_id = run.integration_account_id
     AND ranked.id = run.id
    WHERE run.source_level_set_run_id IS NOT NULL
      AND ranked.observation_rank > 128
      AND NOT EXISTS (
        SELECT 1 FROM operations_commerce_inventory_levels level
        WHERE level.organization_id = run.organization_id
          AND level.integration_account_id = run.integration_account_id
          AND level.sync_run_id = run.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM operations_reservations reservation
        WHERE reservation.organization_id = run.organization_id
          AND reservation.provider_inventory_sync_run_id = run.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM operations_cartonization_rate_evidence evidence
        WHERE evidence.organization_id = run.organization_id
          AND evidence.inventory_sync_run_id = run.id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM operations_shopify_inventory_refresh_watermarks watermark
        WHERE watermark.organization_id = run.organization_id
          AND watermark.last_reconciled_run_global_id = run.global_id
      )
    ORDER BY run.completed_at, run.id
    FOR UPDATE OF run SKIP LOCKED
    LIMIT p_limit
  ), purged AS (
    DELETE FROM operations_commerce_inventory_sync_runs run
    USING due
    WHERE run.id = due.id
    RETURNING due.row_bytes
  )
  SELECT count(*)::integer, COALESCE(sum(row_bytes), 0)::bigint
  FROM purged;
END;
$$;

CREATE OR REPLACE FUNCTION purge_operations_commerce_inventory_level_evidence(
  p_limit integer DEFAULT 250
)
RETURNS TABLE (purged_rows integer, purged_bytes bigint)
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_limit < 1 OR p_limit > 10000 THEN
    RAISE EXCEPTION 'commerce inventory evidence purge limit is invalid';
  END IF;
  PERFORM set_config('clawpilot.commerce_inventory_compaction', 'on', true);
  RETURN QUERY
  WITH ranked_runs AS (
    SELECT run.id, run.organization_id, run.integration_account_id,
           row_number() OVER (
             PARTITION BY run.organization_id, run.integration_account_id,
                          run.location_mapping_id
             ORDER BY run.completed_at DESC, run.id DESC
           ) AS evidence_rank,
           run.completed_at
    FROM operations_commerce_inventory_sync_runs run
    WHERE run.status = 'succeeded'
      AND run.source_level_set_run_id IS NULL
  ), compactable_runs AS (
    SELECT run.id, run.organization_id,
           ranked.integration_account_id
    FROM ranked_runs ranked
    JOIN operations_commerce_inventory_sync_runs run
      ON run.organization_id = ranked.organization_id
     AND run.integration_account_id = ranked.integration_account_id
     AND run.id = ranked.id
    WHERE (
      (ranked.evidence_rank > 32
        AND ranked.completed_at < now() - interval '90 days')
      OR ranked.evidence_rank > 128
    )
      AND NOT EXISTS (
        SELECT 1
        FROM operations_commerce_inventory_sync_runs alias
        WHERE alias.organization_id = ranked.organization_id
          AND alias.integration_account_id = ranked.integration_account_id
          AND alias.source_level_set_run_id = ranked.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM operations_reservations reservation
        WHERE reservation.organization_id = ranked.organization_id
          AND reservation.provider_inventory_sync_run_id = ranked.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM operations_cartonization_rate_evidence evidence
        WHERE evidence.organization_id = ranked.organization_id
          AND evidence.inventory_sync_run_id = ranked.id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM operations_shopify_inventory_refresh_watermarks watermark
        JOIN operations_commerce_inventory_sync_runs source
          ON source.organization_id = watermark.organization_id
         AND source.global_id = watermark.last_reconciled_run_global_id
        WHERE source.organization_id = ranked.organization_id
          AND source.integration_account_id = ranked.integration_account_id
          AND source.id = ranked.id
      )
    ORDER BY ranked.completed_at, ranked.id
    FOR UPDATE OF run SKIP LOCKED
  ), due AS (
    SELECT level.id, pg_column_size(level.*)::bigint AS row_bytes
    FROM operations_commerce_inventory_levels level
    JOIN compactable_runs run
      ON run.organization_id = level.organization_id
     AND run.integration_account_id = level.integration_account_id
     AND run.id = level.sync_run_id
    ORDER BY level.created_at, level.id
    FOR UPDATE OF level SKIP LOCKED
    LIMIT p_limit
  ), purged AS (
    DELETE FROM operations_commerce_inventory_levels level
    USING due
    WHERE level.id = due.id
    RETURNING due.row_bytes
  )
  SELECT count(*)::integer, COALESCE(sum(row_bytes), 0)::bigint
  FROM purged;
END;
$$;

CREATE OR REPLACE FUNCTION operations_commerce_storage_bloat_health(
  p_sample_limit integer DEFAULT 1000
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  intake_rows integer;
  intake_bytes bigint;
  intake_truncated boolean;
  capture_rows integer;
  capture_bytes bigint;
  capture_truncated boolean;
  snapshot_backlog_rows integer;
  snapshot_backlog_bytes bigint;
  snapshot_backlog_truncated boolean;
  snapshot_live_rows integer;
  snapshot_live_bytes bigint;
  snapshot_live_truncated boolean;
  alias_rows integer;
  alias_bytes bigint;
  alias_truncated boolean;
  inventory_rows integer;
  inventory_bytes bigint;
  inventory_truncated boolean;
BEGIN
  IF p_sample_limit < 1 OR p_sample_limit > 5000 THEN
    RAISE EXCEPTION 'commerce storage health sample limit is invalid';
  END IF;
  WITH sample AS (
    SELECT response_bytes
    FROM operations_commerce_intake_read_intents intent
    WHERE intent.response_ciphertext IS NOT NULL
      AND (
        (intent.intent_state = 'staged' AND intent.staged_run_id IS NOT NULL)
        OR (intent.intent_state IN ('captured', 'expired')
          AND intent.expires_at <= now()
          AND intent.staged_run_id IS NULL)
      )
    ORDER BY intent.expires_at, intent.id
    LIMIT p_sample_limit + 1
  )
  SELECT LEAST(count(*), p_sample_limit)::integer,
         COALESCE(sum(response_bytes) FILTER (
           WHERE ordinal <= p_sample_limit
         ), 0)::bigint,
         count(*) > p_sample_limit
  INTO intake_rows, intake_bytes, intake_truncated
  FROM (
    SELECT response_bytes, row_number() OVER () AS ordinal FROM sample
  ) counted;

  WITH sample AS (
    SELECT pg_column_size(capture.captured_snapshot)::bigint AS row_bytes
    FROM operations_commerce_inventory_captures capture
    WHERE capture.captured_snapshot IS NOT NULL
      AND capture.snapshot_content_id IS NULL
    ORDER BY capture.created_at, capture.id
    LIMIT p_sample_limit + 1
  )
  SELECT LEAST(count(*), p_sample_limit)::integer,
         COALESCE(sum(row_bytes) FILTER (
           WHERE ordinal <= p_sample_limit
         ), 0)::bigint,
         count(*) > p_sample_limit
  INTO capture_rows, capture_bytes, capture_truncated
  FROM (
    SELECT row_bytes, row_number() OVER () AS ordinal FROM sample
  ) counted;

  WITH sample AS (
    SELECT content.content_bytes::bigint AS row_bytes
    FROM operations_commerce_inventory_snapshot_contents content
    JOIN operations_commerce_inventory_snapshot_payload_retention ranked
      ON ranked.organization_id = content.organization_id
     AND ranked.integration_account_id = content.integration_account_id
     AND ranked.id = content.id
    WHERE (
      ranked.payload_rank > 32
      OR (
        ranked.payload_rank > 8
        AND ranked.created_at < now() - interval '30 days'
      )
    )
      AND NOT ranked.current_payload
      AND operations_commerce_inventory_snapshot_content_is_purgeable(
        content.organization_id, content.integration_account_id, content.id
      )
    ORDER BY content.created_at, content.id
    LIMIT p_sample_limit + 1
  )
  SELECT LEAST(count(*), p_sample_limit)::integer,
         COALESCE(sum(row_bytes) FILTER (
           WHERE ordinal <= p_sample_limit
         ), 0)::bigint,
         count(*) > p_sample_limit
  INTO snapshot_backlog_rows, snapshot_backlog_bytes,
       snapshot_backlog_truncated
  FROM (
    SELECT row_bytes, row_number() OVER () AS ordinal FROM sample
  ) counted;

  WITH sample AS (
    SELECT content.content_bytes::bigint AS row_bytes
    FROM operations_commerce_inventory_snapshot_contents content
    WHERE content.snapshot_content IS NOT NULL
    ORDER BY content.created_at DESC, content.id DESC
    LIMIT p_sample_limit + 1
  )
  SELECT LEAST(count(*), p_sample_limit)::integer,
         COALESCE(sum(row_bytes) FILTER (
           WHERE ordinal <= p_sample_limit
         ), 0)::bigint,
         count(*) > p_sample_limit
  INTO snapshot_live_rows, snapshot_live_bytes, snapshot_live_truncated
  FROM (
    SELECT row_bytes, row_number() OVER () AS ordinal FROM sample
  ) counted;

  WITH ranked AS (
    SELECT run.id, run.organization_id, run.integration_account_id,
           row_number() OVER (
             PARTITION BY run.organization_id, run.integration_account_id,
                          run.location_mapping_id
             ORDER BY run.completed_at DESC, run.id DESC
           ) AS observation_rank
    FROM operations_commerce_inventory_sync_runs run
    WHERE run.status = 'succeeded'
  ), sample AS (
    SELECT pg_column_size(run.*)::bigint AS row_bytes
    FROM operations_commerce_inventory_sync_runs run
    JOIN ranked
      ON ranked.organization_id = run.organization_id
     AND ranked.integration_account_id = run.integration_account_id
     AND ranked.id = run.id
    WHERE run.source_level_set_run_id IS NOT NULL
      AND ranked.observation_rank > 128
      AND NOT EXISTS (
        SELECT 1 FROM operations_commerce_inventory_levels level
        WHERE level.organization_id = run.organization_id
          AND level.integration_account_id = run.integration_account_id
          AND level.sync_run_id = run.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM operations_reservations reservation
        WHERE reservation.organization_id = run.organization_id
          AND reservation.provider_inventory_sync_run_id = run.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM operations_cartonization_rate_evidence evidence
        WHERE evidence.organization_id = run.organization_id
          AND evidence.inventory_sync_run_id = run.id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM operations_shopify_inventory_refresh_watermarks watermark
        WHERE watermark.organization_id = run.organization_id
          AND watermark.last_reconciled_run_global_id = run.global_id
      )
    ORDER BY run.completed_at, run.id
    LIMIT p_sample_limit + 1
  )
  SELECT LEAST(count(*), p_sample_limit)::integer,
         COALESCE(sum(row_bytes) FILTER (
           WHERE ordinal <= p_sample_limit
         ), 0)::bigint,
         count(*) > p_sample_limit
  INTO alias_rows, alias_bytes, alias_truncated
  FROM (
    SELECT row_bytes, row_number() OVER () AS ordinal FROM sample
  ) counted;

  WITH ranked_runs AS (
    SELECT run.id, run.organization_id, run.integration_account_id,
           row_number() OVER (
             PARTITION BY run.organization_id, run.integration_account_id,
                          run.location_mapping_id
             ORDER BY run.completed_at DESC, run.id DESC
           ) AS evidence_rank,
           run.completed_at
    FROM operations_commerce_inventory_sync_runs run
    WHERE run.status = 'succeeded'
      AND run.source_level_set_run_id IS NULL
  ), sample AS (
    SELECT pg_column_size(level.*)::bigint AS row_bytes
    FROM operations_commerce_inventory_levels level
    JOIN ranked_runs run
      ON run.organization_id = level.organization_id
     AND run.integration_account_id = level.integration_account_id
     AND run.id = level.sync_run_id
    WHERE ((run.evidence_rank > 32
          AND run.completed_at < now() - interval '90 days')
        OR run.evidence_rank > 128)
      AND NOT EXISTS (
        SELECT 1
        FROM operations_commerce_inventory_sync_runs alias
        WHERE alias.organization_id = run.organization_id
          AND alias.integration_account_id = run.integration_account_id
          AND alias.source_level_set_run_id = run.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM operations_reservations reservation
        WHERE reservation.organization_id = run.organization_id
          AND reservation.provider_inventory_sync_run_id = run.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM operations_cartonization_rate_evidence evidence
        WHERE evidence.organization_id = run.organization_id
          AND evidence.inventory_sync_run_id = run.id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM operations_shopify_inventory_refresh_watermarks watermark
        JOIN operations_commerce_inventory_sync_runs source
          ON source.organization_id = watermark.organization_id
         AND source.global_id = watermark.last_reconciled_run_global_id
        WHERE source.organization_id = run.organization_id
          AND source.integration_account_id = run.integration_account_id
          AND source.id = run.id
      )
    ORDER BY level.created_at, level.id
    LIMIT p_sample_limit + 1
  )
  SELECT LEAST(count(*), p_sample_limit)::integer,
         COALESCE(sum(row_bytes) FILTER (
           WHERE ordinal <= p_sample_limit
         ), 0)::bigint,
         count(*) > p_sample_limit
  INTO inventory_rows, inventory_bytes, inventory_truncated
  FROM (
    SELECT row_bytes, row_number() OVER () AS ordinal FROM sample
  ) counted;

  RETURN jsonb_build_object(
    'intakePayloadBacklogRows', intake_rows,
    'intakePayloadBacklogBytes', intake_bytes,
    'intakePayloadBacklogTruncated', intake_truncated,
    'legacyInventoryCaptureBacklogRows', capture_rows,
    'legacyInventoryCaptureBacklogBytes', capture_bytes,
    'legacyInventoryCaptureBacklogTruncated', capture_truncated,
    'inventorySnapshotPayloadBacklogRows', snapshot_backlog_rows,
    'inventorySnapshotPayloadBacklogBytes', snapshot_backlog_bytes,
    'inventorySnapshotPayloadBacklogTruncated',
      snapshot_backlog_truncated,
    'inventorySnapshotLivePayloadRows', snapshot_live_rows,
    'inventorySnapshotLivePayloadBytes', snapshot_live_bytes,
    'inventorySnapshotLivePayloadTruncated', snapshot_live_truncated,
    'inventorySnapshotContentStorageBytes', pg_total_relation_size(
      'operations_commerce_inventory_snapshot_contents'
    ),
    'inventorySnapshotContentRowEstimate', COALESCE((
      SELECT reltuples::bigint FROM pg_class
      WHERE oid =
        'operations_commerce_inventory_snapshot_contents'::regclass
    ), 0),
    'inventoryObservationAliasBacklogRows', alias_rows,
    'inventoryObservationAliasBacklogBytes', alias_bytes,
    'inventoryObservationAliasBacklogTruncated', alias_truncated,
    'inventoryLevelBacklogRows', inventory_rows,
    'inventoryLevelBacklogBytes', inventory_bytes,
    'inventoryLevelBacklogTruncated', inventory_truncated,
    'inventoryLevelStorageBytes',
      pg_total_relation_size('operations_commerce_inventory_levels'),
    'inventoryLevelRowEstimate', COALESCE((
      SELECT reltuples::bigint FROM pg_class
      WHERE oid = 'operations_commerce_inventory_levels'::regclass
    ), 0),
    'inventoryObservationHardCapPerAccountLocation', 128,
    'inventoryFullLevelSetHardCapPerAccountLocation', 128,
    'inventoryFullLevelSetSoftCapAfter90Days', 32,
    'inventorySnapshotLivePayloadHardCapPerAccountLocation', 32,
    'inventorySnapshotLivePayloadSoftCapAfter30Days', 8,
    'storageMaintenance', COALESCE((
      SELECT jsonb_build_object(
        'nextRunAt', lane.next_run_at,
        'leaseOwner', lane.lease_owner,
        'leaseExpiresAt', lane.lease_expires_at,
        'lastStartedAt', lane.last_started_at,
        'lastCompletedAt', lane.last_completed_at,
        'lastFailedAt', lane.last_failed_at,
        'lastErrorCode', lane.last_error_code,
        'lastResult', lane.last_result,
        'rowVersion', lane.row_version
      )
      FROM operations_commerce_storage_maintenance_lanes lane
      WHERE lane.lane_name = 'commerce-storage'
    ), '{}'::jsonb),
    'checkedAt', now()
  );
END;
$$;

COMMENT ON COLUMN operations_commerce_intake_read_intents.response_purged_at IS
  'One-way proof that encrypted response bytes were removed after successful staging or expiry; hash and byte count remain immutable.';
COMMENT ON COLUMN operations_commerce_inventory_sync_runs.level_set_hash IS
  'Content hash of the projected immutable level set, excluding observation freshness.';
COMMENT ON COLUMN operations_commerce_inventory_sync_runs.source_level_set_run_id IS
  'For an unchanged poll, the prior full immutable run whose level rows are reused; this run retains current attempt, capture, metrics, and freshness without duplicating the level set.';
COMMENT ON COLUMN
  operations_commerce_inventory_snapshot_contents.payload_purged_at IS
  'One-way proof that bounded maintenance removed replay-only raw JSON while retaining its immutable hash, original byte count, level count, captures, runs, and projected level evidence.';
