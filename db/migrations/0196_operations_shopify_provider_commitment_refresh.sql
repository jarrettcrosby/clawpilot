-- Keep active provider commitments valid across newer Shopify inventory
-- snapshots when the newest provider evidence still supports every claim.
-- Reconciliation and reservation creation share one per-position advisory
-- lock, so neither side can observe a partially checked balance.

CREATE OR REPLACE FUNCTION protect_shopify_inventory_position()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  position_organization_id uuid;
  target_position_id uuid;
  prospective_committed_quantity numeric(20,6);
  active_claimed_quantity numeric(20,6);
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.source_authority = 'shopify'
       AND current_setting(
         'clawpilot.shopify_inventory_sync', true
       ) IS DISTINCT FROM 'on' THEN
      RAISE EXCEPTION
        'Shopify-authoritative inventory positions can only be created through reconciliation';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.source_authority IS DISTINCT FROM OLD.source_authority THEN
    RAISE EXCEPTION
      'Inventory position source authority is immutable';
  END IF;

  IF OLD.source_authority = 'shopify'
     AND current_setting(
       'clawpilot.shopify_inventory_sync', true
     ) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION
      'Shopify-authoritative inventory positions can only change through reconciliation';
  END IF;

  IF OLD.source_authority = 'shopify' THEN
    position_organization_id := OLD.organization_id;
    target_position_id := OLD.id;
    prospective_committed_quantity := CASE
      WHEN TG_OP = 'DELETE' THEN 0::numeric
      ELSE NEW.reserved_quantity
    END;

    PERFORM pg_advisory_xact_lock(
      hashtextextended(
        'operations:inventory-reservation:'
          || position_organization_id::text || ':'
          || target_position_id::text,
        0
      )
    );

    SELECT COALESCE(sum(reservation.quantity), 0)
      INTO active_claimed_quantity
    FROM operations_reservations reservation
    WHERE reservation.organization_id = position_organization_id
      AND reservation.position_id = target_position_id
      AND reservation.reservation_authority = 'provider_commitment'
      AND reservation.status = 'active';

    IF active_claimed_quantity > prospective_committed_quantity THEN
      RAISE EXCEPTION
        'SHOPIFY_INVENTORY_PROVIDER_COMMITMENT_CONFLICT: Active provider commitment claims exceed Shopify committed quantity';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

-- Callers normally pass only organization and reservation. The optional
-- context exists solely for the reservation BEFORE INSERT trigger, where the
-- generated reservation id is not visible to a table query yet.
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
      AND level.sync_run_id = latest_run.id
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

COMMENT ON FUNCTION operations_provider_commitment_current_support(
  uuid, uuid, uuid, uuid, uuid, numeric, text, uuid, uuid
) IS
  'Evaluates one provider commitment against the newest successful Shopify location/product evidence and every active claim on its projected position.';

CREATE OR REPLACE FUNCTION validate_ops_reservation_authority()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_order operations_orders%ROWTYPE;
  source_line operations_order_lines%ROWTYPE;
  source_position operations_inventory_positions%ROWTYPE;
  source_run operations_commerce_inventory_sync_runs%ROWTYPE;
  source_level operations_commerce_inventory_levels%ROWTYPE;
  support record;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.reservation_authority
       IS DISTINCT FROM OLD.reservation_authority THEN
    RAISE EXCEPTION 'Reservation authority is immutable';
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD.reservation_authority = 'provider_commitment'
     AND (
       NEW.organization_id IS DISTINCT FROM OLD.organization_id
       OR NEW.order_id IS DISTINCT FROM OLD.order_id
       OR NEW.order_line_id IS DISTINCT FROM OLD.order_line_id
       OR NEW.position_id IS DISTINCT FROM OLD.position_id
       OR NEW.quantity IS DISTINCT FROM OLD.quantity
       OR NEW.provider_inventory_sync_run_id
         IS DISTINCT FROM OLD.provider_inventory_sync_run_id
       OR NEW.provider_inventory_level_id
         IS DISTINCT FROM OLD.provider_inventory_level_id
     ) THEN
    RAISE EXCEPTION
      'Provider commitment reservation identity and evidence are immutable';
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD.reservation_authority = 'provider_commitment'
     AND OLD.status <> 'active'
     AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION
      'A terminal provider commitment reservation cannot be reactivated';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'operations:inventory-reservation:'
        || NEW.organization_id::text || ':' || NEW.position_id::text,
      0
    )
  );

  SELECT * INTO source_position
  FROM operations_inventory_positions position
  WHERE position.organization_id = NEW.organization_id
    AND position.id = NEW.position_id
  FOR UPDATE;
  SELECT * INTO source_order
  FROM operations_orders source
  WHERE source.organization_id = NEW.organization_id
    AND source.id = NEW.order_id;
  SELECT * INTO source_line
  FROM operations_order_lines line
  WHERE line.organization_id = NEW.organization_id
    AND line.id = NEW.order_line_id;

  IF source_position.id IS NULL
     OR source_order.id IS NULL
     OR source_line.id IS NULL THEN
    RAISE EXCEPTION
      'Reservation order, line, and inventory position must exist';
  END IF;
  IF source_line.order_id IS DISTINCT FROM NEW.order_id
     OR source_line.product_id IS DISTINCT FROM source_position.product_id THEN
    RAISE EXCEPTION
      'Reservation line and inventory position must belong to the same order product';
  END IF;

  IF NEW.reservation_authority = 'local_balance' THEN
    IF source_position.source_authority IS DISTINCT FROM 'clawpilot' THEN
      RAISE EXCEPTION
        'Local balance reservations require ClawPilot-authoritative inventory';
    END IF;
    RETURN NEW;
  END IF;

  IF source_position.source_authority IS DISTINCT FROM 'shopify' THEN
    RAISE EXCEPTION
      'Provider commitment reservations require Shopify-authoritative inventory';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION
      'A provider commitment reservation must begin active';
  END IF;

  SELECT * INTO source_run
  FROM operations_commerce_inventory_sync_runs run
  WHERE run.organization_id = NEW.organization_id
    AND run.id = NEW.provider_inventory_sync_run_id;
  SELECT * INTO source_level
  FROM operations_commerce_inventory_levels level
  WHERE level.organization_id = NEW.organization_id
    AND level.sync_run_id = NEW.provider_inventory_sync_run_id
    AND level.id = NEW.provider_inventory_level_id
    AND level.inventory_position_id = NEW.position_id;

  IF source_run.id IS NULL OR source_level.id IS NULL THEN
    RAISE EXCEPTION
      'Provider commitment requires exact successful inventory reconciliation evidence';
  END IF;
  IF source_run.status IS DISTINCT FROM 'succeeded'
     OR source_run.provider IS DISTINCT FROM 'shopify'
     OR source_run.integration_account_id
       IS DISTINCT FROM source_order.integration_account_id
     OR source_order.source_provider IS DISTINCT FROM 'shopify' THEN
    RAISE EXCEPTION
      'Provider commitment evidence must match the Shopify order account';
  END IF;
  IF source_level.projection_state IS DISTINCT FROM 'projected'
     OR source_level.mapping_state IS DISTINCT FROM 'mapped'
     OR source_level.tracked IS DISTINCT FROM true
     OR source_level.equation_matches IS DISTINCT FROM true
     OR source_level.product_id IS DISTINCT FROM source_line.product_id
     OR source_level.pipeline_id IS DISTINCT FROM source_line.pipeline_id THEN
    RAISE EXCEPTION
      'Provider commitment inventory evidence is not an exact projected product level';
  END IF;

  -- Cancelling or replanning must be able to release an active claim even
  -- after provider support disappears. Creating, retaining, or consuming a
  -- claim remains fail-closed against the newest successful snapshot.
  IF NEW.status = 'active'
     OR (
       TG_OP = 'UPDATE'
       AND OLD.status = 'active'
       AND NEW.status = 'consumed'
     ) THEN
    IF TG_OP = 'INSERT' THEN
      SELECT * INTO support
      FROM operations_provider_commitment_current_support(
        NEW.organization_id,
        NEW.id,
        NEW.position_id,
        NEW.order_id,
        NEW.order_line_id,
        NEW.quantity,
        NEW.status,
        NEW.provider_inventory_sync_run_id,
        NEW.provider_inventory_level_id
      );
    ELSE
      SELECT * INTO support
      FROM operations_provider_commitment_current_support(
        NEW.organization_id,
        NEW.id
      );
    END IF;

    IF support.supported IS DISTINCT FROM true THEN
      RAISE EXCEPTION
        'Provider commitment current Shopify support failed: %',
        COALESCE(
          support.reason_code,
          'SHOPIFY_INVENTORY_PROVIDER_COMMITMENT_CONFLICT'
        );
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION validate_ops_reservation_authority() IS
  'Keeps provider commitment identity immutable while revalidating active and consumed claims against current Shopify support; active claims may always be released for cancellation or replanning.';
