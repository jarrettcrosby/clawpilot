-- Exact-order training is a local, zero-provider-write overlay. It remains
-- usable while the organization-wide advanced safety profile changes. The
-- profile revision is retained as authorization-time audit evidence, but it
-- is no longer execution authority for later local training commands.

CREATE OR REPLACE FUNCTION validate_operations_shadow_training_run_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_binding_valid boolean;
  authorization_binding_valid boolean;
  evidence_binding_valid boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended(
        'operations:activation:' || NEW.organization_id::text,
        0
      )
    );
    PERFORM 1
    FROM operations_activation_scopes activation
    WHERE activation.organization_id = NEW.organization_id
      AND activation.state IN (
        'disabled', 'shadow', 'read_only', 'active', 'frozen'
      )
      AND activation.revision = NEW.authorization_activation_revision
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Order training requires an exact current safety profile';
    END IF;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM operations_orders source_order
    JOIN operations_integration_accounts account
      ON account.organization_id = source_order.organization_id
     AND account.id = source_order.integration_account_id
    JOIN operations_commerce_order_candidates candidate
      ON candidate.organization_id = source_order.organization_id
     AND candidate.integration_account_id = source_order.integration_account_id
     AND candidate.canonical_order_id = source_order.id
    WHERE source_order.organization_id = NEW.organization_id
      AND source_order.id = NEW.source_order_id
      AND source_order.integration_account_id = NEW.integration_account_id
      AND source_order.source_provider = NEW.provider
      AND account.provider = NEW.provider
      AND account.integration_type = 'commerce'
      AND account.environment = NEW.account_environment
      AND account.environment IN ('sandbox', 'production')
      AND candidate.id = NEW.source_candidate_id
  ) INTO source_binding_valid;
  IF source_binding_valid IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Order training source order, account, provider, and candidate must be exact';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT EXISTS (
      SELECT 1
      FROM operations_orders source_order
      JOIN operations_integration_accounts account
        ON account.organization_id = source_order.organization_id
       AND account.id = source_order.integration_account_id
      JOIN operations_commerce_credentials credential
        ON credential.organization_id = account.organization_id
       AND credential.integration_account_id = account.id
      JOIN operations_commerce_order_candidates candidate
        ON candidate.organization_id = source_order.organization_id
       AND candidate.integration_account_id = source_order.integration_account_id
       AND candidate.canonical_order_id = source_order.id
      JOIN operations_activation_scopes activation
        ON activation.organization_id = source_order.organization_id
      WHERE source_order.organization_id = NEW.organization_id
        AND source_order.id = NEW.source_order_id
        AND source_order.status = 'imported'
        AND source_order.row_version = NEW.authorization_order_row_version
        AND account.id = NEW.integration_account_id
        AND account.status = 'active'
        AND account.environment IN ('sandbox', 'production')
        AND credential.verification_status = 'verified'
        AND credential.credential_version = NEW.authorization_credential_generation
        AND candidate.id = NEW.source_candidate_id
        AND candidate.workflow_state = 'promoted'
        AND candidate.row_version = NEW.authorization_candidate_row_version
        AND candidate.source_hash = NEW.authorization_candidate_source_hash
        AND activation.state IN (
          'disabled', 'shadow', 'read_only', 'active', 'frozen'
        )
        AND activation.revision = NEW.authorization_activation_revision
        AND ocr_order_has_zero_downstream(
          source_order.organization_id,
          source_order.id
        )
        AND EXISTS (
          SELECT 1
          FROM operations_commerce_order_candidate_lines candidate_line
          WHERE candidate_line.organization_id = candidate.organization_id
            AND candidate_line.integration_account_id = candidate.integration_account_id
            AND candidate_line.order_candidate_id = candidate.id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM operations_commerce_order_candidate_lines candidate_line
          LEFT JOIN crm_products product
            ON product.pipeline_id = candidate_line.pipeline_id
           AND product.id = candidate_line.product_id
          WHERE candidate_line.organization_id = candidate.organization_id
            AND candidate_line.integration_account_id = candidate.integration_account_id
            AND candidate_line.order_candidate_id = candidate.id
            AND product.id IS NULL
        )
    ) INTO authorization_binding_valid;
    IF authorization_binding_valid IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'Order training authorization requires an untouched imported connected-store order';
    END IF;
  END IF;

  IF NEW.cartonization_evidence_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
      FROM operations_cartonization_rate_evidence evidence
      WHERE evidence.organization_id = NEW.organization_id
        AND evidence.id = NEW.cartonization_evidence_id
        AND evidence.global_id = NEW.cartonization_evidence_global_id
        AND evidence.integration_account_id = NEW.integration_account_id
        AND evidence.order_candidate_id = NEW.source_candidate_id
        AND evidence.candidate_row_version = NEW.authorization_candidate_row_version
        AND evidence.candidate_source_hash = NEW.authorization_candidate_source_hash
        AND evidence.warehouse_id = NEW.warehouse_id
        AND evidence.sealed_at IS NOT NULL
        AND evidence.plan_snapshot->'shadowTraining'->>'version'
              = 'shadow-training-evidence-v1'
        AND evidence.plan_snapshot->'shadowTraining'->>'runGlobalId'
              = NEW.global_id
    ) INTO evidence_binding_valid;
    IF evidence_binding_valid IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'Order training evidence must match the exact account, candidate, and warehouse';
    END IF;
    IF TG_OP = 'UPDATE'
       AND OLD.state = 'enabled'
       AND NEW.state = 'planned'
       AND NOT EXISTS (
         SELECT 1
         FROM operations_cartonization_rate_evidence evidence
         WHERE evidence.organization_id = NEW.organization_id
           AND evidence.id = NEW.cartonization_evidence_id
           AND (evidence.plan_snapshot->'shadowTraining'->>'runRowVersion')::bigint
                 = OLD.row_version
       ) THEN
      RAISE EXCEPTION 'Order training evidence must match the exact enabled run version';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- Serialize every canonical write with exact-order training authorization.
-- Whichever transaction acquires the organization authority first wins:
-- canonical work makes a later training authorization ineligible, while a
-- committed training run quarantines later canonical work for that order.
CREATE OR REPLACE FUNCTION guard_shadow_commerce_canonical_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  activation_state text;
  order_provider text;
  account_type text;
  canonical_identity_changed boolean := TG_OP = 'INSERT';
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'operations:activation:' || NEW.organization_id::text,
      0
    )
  );

  IF TG_TABLE_NAME = 'operations_fulfillment_plans'
     AND EXISTS (
       SELECT 1
       FROM operations_cartonization_rate_evidence evidence
       WHERE evidence.organization_id = NEW.organization_id
         AND evidence.id = NULLIF(
           to_jsonb(NEW)->>'cartonization_evidence_id',
           ''
         )::uuid
         AND evidence.plan_snapshot ? 'shadowTraining'
     ) THEN
    RAISE EXCEPTION 'OPERATIONS_SHADOW_TRAINING_EVIDENCE_CANONICAL_FORBIDDEN'
      USING ERRCODE = 'P0001';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    canonical_identity_changed :=
      NEW.order_id IS DISTINCT FROM OLD.order_id;
  END IF;

  IF canonical_identity_changed AND EXISTS (
    SELECT 1
    FROM operations_shadow_training_runs training_run
    WHERE training_run.organization_id = NEW.organization_id
      AND training_run.source_order_id = NEW.order_id
      AND training_run.state <> 'reset'
  ) THEN
    RAISE EXCEPTION 'OPERATIONS_SHADOW_TRAINING_OVERLAY_REQUIRED'
      USING ERRCODE = 'P0001';
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.order_id IS NOT DISTINCT FROM OLD.order_id THEN
    RETURN NEW;
  END IF;

  SELECT activation.state, source_order.source_provider,
         account.integration_type
    INTO activation_state, order_provider, account_type
  FROM operations_orders source_order
  JOIN operations_integration_accounts account
    ON account.organization_id = source_order.organization_id
   AND account.id = source_order.integration_account_id
  JOIN operations_activation_scopes activation
    ON activation.organization_id = source_order.organization_id
  WHERE source_order.organization_id = NEW.organization_id
    AND source_order.id = NEW.order_id;

  IF activation_state = 'shadow'
     AND order_provider IN ('shopify', 'faire')
     AND account_type = 'commerce' THEN
    RAISE EXCEPTION 'OPERATIONS_SHADOW_TRAINING_OVERLAY_REQUIRED'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

-- Profile changes no longer strand or invalidate an exact local training run.
-- Deleting the only profile row remains blocked while a run is open because
-- the row is still part of organization identity and audit history.
CREATE OR REPLACE FUNCTION guard_shadow_training_activation_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND EXISTS (
       SELECT 1
       FROM operations_shadow_training_runs run
       WHERE run.organization_id = OLD.organization_id
         AND run.state <> 'reset'
     ) THEN
    RAISE EXCEPTION 'OPERATIONS_ORDER_TRAINING_SAFETY_PROFILE_REQUIRED'
      USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON TABLE operations_shadow_training_runs IS
  'Exact-order local training overlay. Advanced safety profile changes do not invalidate a run; commerce writes, production postage, operational inventory, and packaging-stock mutations remain constrained to zero.';
