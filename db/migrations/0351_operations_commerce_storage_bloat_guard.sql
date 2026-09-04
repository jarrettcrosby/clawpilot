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

CREATE INDEX IF NOT EXISTS commerce_intake_read_intents_payload_purge_idx
  ON operations_commerce_intake_read_intents (
    intent_state, expires_at, updated_at, id
  )
  WHERE response_ciphertext IS NOT NULL;

CREATE OR REPLACE FUNCTION protect_operations_commerce_intake_read_intent()
RETURNS trigger
LANGUAGE plpgsql
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
    ) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS operations_commerce_inventory_level_set_reuse_idx
  ON operations_commerce_inventory_sync_runs (
    organization_id, integration_account_id, location_mapping_id,
    level_set_hash, completed_at DESC, id DESC
  )
  WHERE status = 'succeeded' AND level_set_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS operations_commerce_inventory_level_set_source_idx
  ON operations_commerce_inventory_sync_runs (
    organization_id, integration_account_id, source_level_set_run_id
  ) WHERE source_level_set_run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS operations_commerce_inventory_retention_idx
  ON operations_commerce_inventory_sync_runs (
    organization_id, integration_account_id, location_mapping_id,
    completed_at DESC, id DESC
  ) WHERE status = 'succeeded';

CREATE OR REPLACE FUNCTION validate_operations_commerce_inventory_level_set_alias()
RETURNS trigger
LANGUAGE plpgsql
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

CREATE OR REPLACE FUNCTION
  convert_operations_commerce_inventory_legacy_captures(
    p_limit integer DEFAULT 25
  )
RETURNS TABLE (converted_rows integer, converted_bytes bigint)
LANGUAGE plpgsql
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
    ) DO NOTHING
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
AS $$
DECLARE
  evidence_rank bigint;
  completed_at timestamptz;
BEGIN
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
AS $$
DECLARE
  intake_rows integer;
  intake_bytes bigint;
  intake_truncated boolean;
  capture_rows integer;
  capture_bytes bigint;
  capture_truncated boolean;
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
