-- Permit one exact, expiring, operator-authorized sandbox commerce E2E order
-- to coexist with Operations Active mode. This does not make sandbox carrier
-- evidence production evidence: every label and shipment mutation still has
-- to present and consume the same actor-bound authorization.

CREATE OR REPLACE FUNCTION validate_ops_plan_cartonization_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  linked_sealed_at timestamptz;
  linked_mode text;
  linked_status text;
  linked_warehouse_id uuid;
  linked_candidate_order_id uuid;
  linked_candidate_state text;
  linked_candidate_source_hash text;
  evidence_candidate_source_hash text;
  linked_carrier_read_environment text;
  activation_state text;
  active_sandbox_e2e_authorization boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'operations:activation:' || NEW.organization_id::text,
      0
    )
  );

  IF TG_OP = 'UPDATE'
     AND OLD.cartonization_evidence_id IS NOT NULL
     AND NEW.cartonization_evidence_id
       IS DISTINCT FROM OLD.cartonization_evidence_id
  THEN
    RAISE EXCEPTION
      'An accepted fulfillment plan cartonization evidence link is immutable';
  END IF;

  SELECT activation.state
    INTO activation_state
  FROM operations_activation_scopes activation
  WHERE activation.organization_id = NEW.organization_id
  LIMIT 1;

  SELECT EXISTS (
    SELECT 1
    FROM operations_sandbox_commerce_e2e_authorizations sandbox_auth
    JOIN operations_orders authorized_order
      ON authorized_order.organization_id = sandbox_auth.organization_id
     AND authorized_order.id = sandbox_auth.order_id
    WHERE sandbox_auth.organization_id = NEW.organization_id
      AND sandbox_auth.order_id = NEW.order_id
      AND sandbox_auth.state = 'active'
      AND sandbox_auth.expires_at > statement_timestamp()
      AND authorized_order.status = 'packed'
      AND authorized_order.source_provider = 'shopify'
      AND sandbox_auth.external_order_id = authorized_order.external_order_id
  ) INTO active_sandbox_e2e_authorization;

  IF NEW.cartonization_evidence_id IS NULL THEN
    IF activation_state = 'active'
       AND (
         NEW.status IN ('planned', 'released')
         OR (
           TG_OP = 'UPDATE'
           AND OLD.status IN ('planned', 'released')
           AND NEW.status = 'fulfilled'
         )
       )
       AND NOT active_sandbox_e2e_authorization
    THEN
      RAISE EXCEPTION
        'Active fulfillment planning requires sealed production carrier-read evidence';
    END IF;
    RETURN NEW;
  END IF;

  SELECT
    evidence.sealed_at,
    evidence.evidence_mode,
    evidence.status,
    evidence.warehouse_id,
    candidate.canonical_order_id,
    candidate.workflow_state,
    candidate.source_hash,
    evidence.candidate_source_hash,
    evidence.plan_snapshot->>'carrierReadEnvironment'
  INTO
    linked_sealed_at,
    linked_mode,
    linked_status,
    linked_warehouse_id,
    linked_candidate_order_id,
    linked_candidate_state,
    linked_candidate_source_hash,
    evidence_candidate_source_hash,
    linked_carrier_read_environment
  FROM operations_cartonization_rate_evidence evidence
  JOIN operations_commerce_order_candidates candidate
    ON candidate.organization_id = evidence.organization_id
   AND candidate.integration_account_id
     = evidence.integration_account_id
   AND candidate.id = evidence.order_candidate_id
  WHERE evidence.organization_id = NEW.organization_id
    AND evidence.id = NEW.cartonization_evidence_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Fulfillment plan cartonization evidence was not found in this organization';
  END IF;
  IF linked_sealed_at IS NULL THEN
    RAISE EXCEPTION
      'Fulfillment planning requires sealed cartonization evidence';
  END IF;
  IF linked_mode IS DISTINCT FROM 'operational' THEN
    RAISE EXCEPTION
      'Assumption-backed sandbox evidence cannot become a fulfillment plan';
  END IF;
  IF activation_state = 'active'
     AND linked_carrier_read_environment IS DISTINCT FROM 'production'
     AND NOT active_sandbox_e2e_authorization
  THEN
    RAISE EXCEPTION
      'Active fulfillment planning requires production carrier-read evidence';
  END IF;
  IF linked_status NOT IN ('succeeded', 'partial') THEN
    RAISE EXCEPTION
      'Failed cartonization evidence cannot become a fulfillment plan';
  END IF;
  IF linked_warehouse_id IS DISTINCT FROM NEW.warehouse_id THEN
    RAISE EXCEPTION
      'Fulfillment plan warehouse must match its cartonization evidence';
  END IF;
  IF linked_candidate_state IS DISTINCT FROM 'promoted'
     OR linked_candidate_order_id IS DISTINCT FROM NEW.order_id
  THEN
    RAISE EXCEPTION
      'Fulfillment plan evidence must belong to the promoted canonical order';
  END IF;
  -- Promotion advances the candidate row version after the operational
  -- evidence is sealed. The immutable provider source hash, promoted canonical
  -- order link, and warehouse are the durable planning boundary; requiring the
  -- pre-promotion row version to remain current would reject every legitimate
  -- promoted order.
  IF linked_candidate_source_hash
       IS DISTINCT FROM evidence_candidate_source_hash
  THEN
    RAISE EXCEPTION
      'Fulfillment plan cartonization evidence is stale';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION validate_ops_activation_canonical_plans()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  incompatible_plan_global_id text;
BEGIN
  IF NEW.state IS DISTINCT FROM 'active' THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'operations:activation:' || NEW.organization_id::text,
      0
    )
  );

  SELECT plan.global_id
    INTO incompatible_plan_global_id
  FROM operations_fulfillment_plans plan
  JOIN operations_orders source_order
    ON source_order.organization_id = plan.organization_id
   AND source_order.id = plan.order_id
  LEFT JOIN operations_cartonization_rate_evidence evidence
    ON evidence.organization_id = plan.organization_id
   AND evidence.id = plan.cartonization_evidence_id
  WHERE plan.organization_id = NEW.organization_id
    AND plan.status IN ('planned', 'released')
    AND source_order.status NOT IN ('shipped', 'cancelled')
    AND (
      plan.cartonization_evidence_id IS NULL
      OR evidence.plan_snapshot->>'carrierReadEnvironment'
           IS DISTINCT FROM 'production'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM operations_sandbox_commerce_e2e_authorizations sandbox_auth
      WHERE sandbox_auth.organization_id = plan.organization_id
        AND sandbox_auth.order_id = plan.order_id
        AND sandbox_auth.state = 'active'
        AND sandbox_auth.expires_at > statement_timestamp()
        AND source_order.status = 'packed'
        AND source_order.source_provider = 'shopify'
        AND sandbox_auth.external_order_id = source_order.external_order_id
    )
  ORDER BY plan.created_at, plan.id
  LIMIT 1;

  IF incompatible_plan_global_id IS NOT NULL THEN
    RAISE EXCEPTION
      'Active Operations cannot retain missing or non-production carrier-read plan %',
      incompatible_plan_global_id;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION validate_ops_plan_cartonization_evidence() IS
  'Fail-closed canonical-plan guard with an exact active order-bound sandbox commerce E2E exception.';
COMMENT ON FUNCTION validate_ops_activation_canonical_plans() IS
  'Fail-closed Active transition guard with an exact active order-bound sandbox commerce E2E exception.';
