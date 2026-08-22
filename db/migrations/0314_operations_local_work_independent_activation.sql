-- Ordinary local Operations work and provider reads are controlled by their
-- own account, order, evidence, and carrier authorities. The legacy workspace
-- activation profile is not an authority for those zero-commerce-write paths.

CREATE OR REPLACE FUNCTION operations_commerce_store_sync_effective_reason(
  requested_organization_id uuid,
  requested_integration_account_id uuid
)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN control.integration_account_id IS NULL
      THEN 'STORE_SYNC_CONTROL_MISSING'
    WHEN account.status <> 'active'
      THEN 'STORE_SYNC_ACCOUNT_UNAVAILABLE'
    WHEN control.desired_state = 'running' AND control.explicit_choice
      THEN 'STORE_SYNC_EXPLICIT_RUNNING'
    WHEN control.desired_state = 'running'
      THEN 'STORE_SYNC_LEGACY_ACTIVE_RUNNING'
    WHEN control.desired_state = 'paused'
         AND EXISTS (
           SELECT 1
           FROM operations_commerce_store_sync_read_leases lease
           WHERE lease.organization_id = account.organization_id
             AND lease.integration_account_id = account.id
             AND lease.authority_kind = 'automatic'
             AND lease.released_at IS NULL
             AND lease.expires_at > clock_timestamp()
         )
      THEN 'STORE_SYNC_EXPLICIT_PAUSED_DRAINING'
    WHEN control.explicit_choice
      THEN 'STORE_SYNC_EXPLICIT_PAUSED'
    ELSE 'STORE_SYNC_LEGACY_READ_ONLY_PAUSED'
  END
  FROM operations_integration_accounts account
  LEFT JOIN operations_commerce_store_sync_controls control
    ON control.organization_id = account.organization_id
   AND control.integration_account_id = account.id
  WHERE account.organization_id = requested_organization_id
    AND account.id = requested_integration_account_id
    AND account.integration_type = 'commerce'
    AND account.provider IN ('shopify', 'faire')
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION operations_commerce_provider_read_authority_is_current(
  requested_organization_id uuid,
  requested_integration_account_id uuid,
  requested_authority text
)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT CASE requested_authority
    WHEN 'automatic' THEN
      operations_commerce_store_sync_is_running(
        requested_organization_id,
        requested_integration_account_id
      )
    WHEN 'manual_read_only' THEN EXISTS (
      SELECT 1
      FROM operations_integration_accounts account
      JOIN operations_commerce_store_sync_controls control
        ON control.organization_id = account.organization_id
       AND control.integration_account_id = account.id
      WHERE account.organization_id = requested_organization_id
        AND account.id = requested_integration_account_id
        AND account.integration_type = 'commerce'
        AND account.provider IN ('shopify', 'faire')
        AND account.status = 'active'
    )
    ELSE false
  END
$$;

CREATE OR REPLACE FUNCTION seed_operations_commerce_store_sync_control()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.integration_type <> 'commerce'
     OR NEW.provider NOT IN ('shopify', 'faire') THEN
    RETURN NEW;
  END IF;

  INSERT INTO operations_commerce_store_sync_controls (
    organization_id,
    integration_account_id,
    desired_state,
    explicit_choice,
    revision,
    reason,
    created_by,
    updated_by
  ) VALUES (
    NEW.organization_id,
    NEW.id,
    'running',
    false,
    1,
    'Initialized as Running for the commerce account',
    NEW.created_by,
    NEW.updated_by
  )
  ON CONFLICT (organization_id, integration_account_id) DO NOTHING;

  RETURN NEW;
END;
$$;

-- Retain the accepted-evidence lineage and exact one-off authority checks, but
-- do not reinterpret the workspace activation profile as a carrier-read
-- environment or local-plan authority.
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
  one_off_execution_mode text;
  valid_one_off_authority boolean;
BEGIN
  IF TG_OP = 'UPDATE' AND (
    (OLD.cartonization_evidence_id IS NOT NULL AND
      NEW.cartonization_evidence_id IS DISTINCT FROM OLD.cartonization_evidence_id)
    OR NEW.one_off_quote_id IS DISTINCT FROM OLD.one_off_quote_id
    OR NEW.one_off_offer_id IS DISTINCT FROM OLD.one_off_offer_id
  ) THEN
    RAISE EXCEPTION
      'An accepted fulfillment plan carrier-rate evidence link is immutable';
  END IF;

  IF NEW.cartonization_evidence_id IS NOT NULL
     AND NEW.one_off_quote_id IS NOT NULL THEN
    RAISE EXCEPTION
      'A fulfillment plan must use exactly one carrier-rate authority';
  END IF;

  SELECT quote.execution_mode INTO one_off_execution_mode
  FROM operations_one_off_shipment_quotes quote
  WHERE quote.organization_id = NEW.organization_id
    AND quote.id = NEW.one_off_quote_id
  LIMIT 1;

  valid_one_off_authority := NEW.one_off_quote_id IS NOT NULL
    AND one_off_execution_mode IN ('test', 'live')
    AND operations_one_off_plan_authority_is_valid(
      NEW.organization_id, NEW.order_id, NEW.warehouse_id,
      NEW.one_off_quote_id, NEW.one_off_offer_id,
      one_off_execution_mode
    );

  IF NEW.one_off_quote_id IS NOT NULL AND NOT valid_one_off_authority THEN
    RAISE EXCEPTION
      'One-off fulfillment plan authority is missing, mismatched, or stale';
  END IF;

  IF NEW.cartonization_evidence_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT evidence.sealed_at, evidence.evidence_mode, evidence.status,
         evidence.warehouse_id, candidate.canonical_order_id,
         candidate.workflow_state, candidate.source_hash,
         evidence.candidate_source_hash
  INTO linked_sealed_at, linked_mode, linked_status,
       linked_warehouse_id, linked_candidate_order_id,
       linked_candidate_state, linked_candidate_source_hash,
       evidence_candidate_source_hash
  FROM operations_cartonization_rate_evidence evidence
  JOIN operations_commerce_order_candidates candidate
    ON candidate.organization_id = evidence.organization_id
   AND candidate.integration_account_id = evidence.integration_account_id
   AND candidate.id = evidence.order_candidate_id
  WHERE evidence.organization_id = NEW.organization_id
    AND evidence.id = NEW.cartonization_evidence_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Fulfillment plan cartonization evidence was not found in this organization';
  END IF;
  IF linked_sealed_at IS NULL THEN
    RAISE EXCEPTION 'Fulfillment planning requires sealed cartonization evidence';
  END IF;
  IF linked_mode IS DISTINCT FROM 'operational' THEN
    RAISE EXCEPTION 'Assumption-backed sandbox evidence cannot become a fulfillment plan';
  END IF;
  IF linked_status NOT IN ('succeeded', 'partial') THEN
    RAISE EXCEPTION 'Failed cartonization evidence cannot become a fulfillment plan';
  END IF;
  IF linked_warehouse_id IS DISTINCT FROM NEW.warehouse_id THEN
    RAISE EXCEPTION 'Fulfillment plan warehouse must match its cartonization evidence';
  END IF;
  IF linked_candidate_state IS DISTINCT FROM 'promoted'
     OR linked_candidate_order_id IS DISTINCT FROM NEW.order_id THEN
    RAISE EXCEPTION 'Fulfillment plan evidence must belong to the promoted canonical order';
  END IF;
  IF linked_candidate_source_hash IS DISTINCT FROM evidence_candidate_source_hash THEN
    RAISE EXCEPTION 'Fulfillment plan cartonization evidence is stale';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION validate_ops_activation_canonical_plans()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN NEW;
END;
$$;

-- Keep exact-order training isolation and evidence quarantine. Remove only the
-- organization-wide Shadow branch that rejected unrelated canonical work.
CREATE OR REPLACE FUNCTION guard_shadow_commerce_canonical_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  canonical_identity_changed boolean := TG_OP = 'INSERT';
BEGIN
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

  RETURN NEW;
END;
$$;

ALTER FUNCTION operations_commerce_store_sync_effective_reason(uuid,uuid)
  SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION operations_commerce_provider_read_authority_is_current(uuid,uuid,text)
  SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION seed_operations_commerce_store_sync_control()
  SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION validate_ops_plan_cartonization_evidence()
  SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION validate_ops_activation_canonical_plans()
  SET search_path = pg_catalog, public, pg_temp;
