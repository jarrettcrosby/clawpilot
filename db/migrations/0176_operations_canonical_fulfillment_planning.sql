-- Canonical fulfillment-planning acceptance boundaries.
--
-- This migration does not activate planning, carrier mutation, label purchase,
-- shipment confirmation, or commerce write-back. It gives a later guarded
-- command durable, tenant-safe links from an accepted fulfillment plan and its
-- physical packages to one sealed operational cartonization/rate aggregate.
--
-- Shopify-authoritative inventory already projects provider committed quantity
-- into operations_inventory_positions.reserved_quantity. A
-- provider_commitment reservation is therefore an immutable claim against the
-- exact successful reconciliation evidence; it never changes the projected
-- balance or writes a second reservation ledger delta.

ALTER TABLE operations_fulfillment_plans
  ADD COLUMN IF NOT EXISTS cartonization_evidence_id uuid;

-- A promoted provider order can carry exact fulfillment demand while its
-- header money remains incomplete. Preserve that distinction instead of
-- manufacturing zero-dollar checkout revenue, margin, or customer charges.
ALTER TABLE operations_fulfillment_plans
  ALTER COLUMN estimated_revenue_minor DROP NOT NULL,
  ALTER COLUMN estimated_margin_minor DROP NOT NULL;

ALTER TABLE operations_carrier_rates
  ALTER COLUMN customer_charge_minor DROP NOT NULL;

INSERT INTO global_reference_entity_types (
  prefix, entity_type, display_name
)
VALUES (
  'gpmc',
  'operations.packaging_material_claim',
  'Packaging material plan claim'
)
ON CONFLICT (prefix) DO UPDATE SET
  entity_type = EXCLUDED.entity_type,
  display_name = EXCLUDED.display_name;

ALTER TABLE operations_fulfillment_plans
  DROP CONSTRAINT IF EXISTS ops_plan_carton_evidence_fkey,
  ADD CONSTRAINT ops_plan_carton_evidence_fkey
    FOREIGN KEY (organization_id, cartonization_evidence_id)
    REFERENCES operations_cartonization_rate_evidence(
      organization_id, id
    ) ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS ops_plan_carton_evidence_unique,
  ADD CONSTRAINT ops_plan_carton_evidence_unique
    UNIQUE (organization_id, cartonization_evidence_id);

CREATE UNIQUE INDEX IF NOT EXISTS
  ops_fulfillment_plan_org_id_warehouse_unique
ON operations_fulfillment_plans (
  organization_id, id, warehouse_id
);

CREATE UNIQUE INDEX IF NOT EXISTS
  ops_packaging_stock_org_id_material_warehouse_unique
ON operations_packaging_material_stock (
  organization_id, id, packaging_material_id, warehouse_id
);

CREATE TABLE IF NOT EXISTS operations_packaging_material_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gpmc'),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  plan_id uuid NOT NULL,
  packaging_material_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  packaging_material_stock_id uuid NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  status text NOT NULL DEFAULT 'active' CHECK (
    status IN ('active', 'consumed', 'released')
  ),
  stock_row_version_at_claim bigint NOT NULL CHECK (
    stock_row_version_at_claim >= 0
  ),
  on_hand_quantity_at_claim integer NOT NULL CHECK (
    on_hand_quantity_at_claim >= 0
  ),
  claimed_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz,
  released_at timestamptz,
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  updated_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ops_packaging_claim_global_valid CHECK (
    global_id ~ '^gpmc[0-9]{7}$'
  ),
  CONSTRAINT ops_packaging_claim_global_unique UNIQUE (global_id),
  CONSTRAINT ops_packaging_claim_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT ops_packaging_claim_plan_warehouse_fkey
    FOREIGN KEY (organization_id, plan_id, warehouse_id)
    REFERENCES operations_fulfillment_plans(
      organization_id, id, warehouse_id
    ) ON DELETE RESTRICT,
  CONSTRAINT ops_packaging_claim_stock_fkey
    FOREIGN KEY (
      organization_id, packaging_material_stock_id,
      packaging_material_id, warehouse_id
    )
    REFERENCES operations_packaging_material_stock(
      organization_id, id, packaging_material_id, warehouse_id
    ) ON DELETE RESTRICT,
  CONSTRAINT ops_packaging_claim_lifecycle_valid CHECK (
    (
      status = 'active'
      AND consumed_at IS NULL
      AND released_at IS NULL
    )
    OR (
      status = 'consumed'
      AND consumed_at IS NOT NULL
      AND consumed_at >= claimed_at
      AND released_at IS NULL
    )
    OR (
      status = 'released'
      AND released_at IS NOT NULL
      AND released_at >= claimed_at
      AND consumed_at IS NULL
    )
  ),
  CONSTRAINT ops_packaging_claim_plan_material_unique UNIQUE (
    organization_id, plan_id, packaging_material_id, warehouse_id
  ),
  CONSTRAINT ops_packaging_claim_org_id_unique UNIQUE (
    organization_id, id
  )
);

CREATE INDEX IF NOT EXISTS ops_packaging_claim_active_stock_idx
ON operations_packaging_material_claims (
  organization_id, warehouse_id, packaging_material_id, status, id
)
WHERE status = 'active';

ALTER TABLE operations_packages
  ADD COLUMN IF NOT EXISTS cartonization_evidence_id uuid,
  ADD COLUMN IF NOT EXISTS evidence_package_key text;

ALTER TABLE operations_packages
  DROP CONSTRAINT IF EXISTS ops_package_evidence_pair_valid,
  ADD CONSTRAINT ops_package_evidence_pair_valid CHECK (
    (
      cartonization_evidence_id IS NULL
      AND evidence_package_key IS NULL
    )
    OR (
      cartonization_evidence_id IS NOT NULL
      AND evidence_package_key IS NOT NULL
      AND length(btrim(evidence_package_key)) BETWEEN 1 AND 80
      AND evidence_package_key !~ '[[:cntrl:]]'
    )
  ),
  DROP CONSTRAINT IF EXISTS ops_package_evidence_fkey,
  ADD CONSTRAINT ops_package_evidence_fkey
    FOREIGN KEY (
      organization_id, cartonization_evidence_id, evidence_package_key
    )
    REFERENCES operations_cartonization_rate_evidence_packages(
      organization_id, evidence_id, package_key
    ) ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS ops_package_evidence_unique,
  ADD CONSTRAINT ops_package_evidence_unique
    UNIQUE (
      organization_id, cartonization_evidence_id, evidence_package_key
    );

ALTER TABLE operations_reservations
  DROP CONSTRAINT IF EXISTS ops_reservation_inventory_level_fkey;

ALTER TABLE operations_commerce_inventory_levels
  DROP CONSTRAINT IF EXISTS ops_inventory_level_run_position_unique,
  ADD CONSTRAINT ops_inventory_level_run_position_unique
    UNIQUE (
      organization_id, sync_run_id, id, inventory_position_id
    );

ALTER TABLE operations_reservations
  ADD COLUMN IF NOT EXISTS reservation_authority text NOT NULL
    DEFAULT 'local_balance',
  ADD COLUMN IF NOT EXISTS provider_inventory_sync_run_id uuid,
  ADD COLUMN IF NOT EXISTS provider_inventory_level_id uuid;

ALTER TABLE operations_reservations
  DROP CONSTRAINT IF EXISTS ops_reservation_authority_valid,
  ADD CONSTRAINT ops_reservation_authority_valid CHECK (
    reservation_authority IN ('local_balance', 'provider_commitment')
  ),
  DROP CONSTRAINT IF EXISTS ops_reservation_authority_evidence_valid,
  ADD CONSTRAINT ops_reservation_authority_evidence_valid CHECK (
    (
      reservation_authority = 'local_balance'
      AND provider_inventory_sync_run_id IS NULL
      AND provider_inventory_level_id IS NULL
    )
    OR (
      reservation_authority = 'provider_commitment'
      AND provider_inventory_sync_run_id IS NOT NULL
      AND provider_inventory_level_id IS NOT NULL
    )
  ),
  DROP CONSTRAINT IF EXISTS ops_reservation_inventory_run_fkey,
  ADD CONSTRAINT ops_reservation_inventory_run_fkey
    FOREIGN KEY (
      organization_id, provider_inventory_sync_run_id
    )
    REFERENCES operations_commerce_inventory_sync_runs(
      organization_id, id
    ) ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS ops_reservation_inventory_level_fkey,
  ADD CONSTRAINT ops_reservation_inventory_level_fkey
    FOREIGN KEY (
      organization_id, provider_inventory_sync_run_id,
      provider_inventory_level_id, position_id
    )
    REFERENCES operations_commerce_inventory_levels(
      organization_id, sync_run_id, id, inventory_position_id
    ) ON DELETE RESTRICT;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM operations_reservations reservation
    JOIN operations_inventory_positions position
      ON position.organization_id = reservation.organization_id
     AND position.id = reservation.position_id
    WHERE reservation.reservation_authority = 'local_balance'
      AND position.source_authority <> 'clawpilot'
  ) THEN
    RAISE EXCEPTION
      'Existing reservations against provider-authoritative inventory require explicit reconciliation evidence';
  END IF;
END;
$$;

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

  IF NEW.cartonization_evidence_id IS NULL THEN
    IF activation_state = 'active'
       AND NEW.status IN ('planned', 'released')
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

DROP TRIGGER IF EXISTS validate_ops_plan_cartonization_evidence
  ON operations_fulfillment_plans;
CREATE TRIGGER validate_ops_plan_cartonization_evidence
BEFORE INSERT OR UPDATE
ON operations_fulfillment_plans
FOR EACH ROW EXECUTE FUNCTION
  validate_ops_plan_cartonization_evidence();

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

DROP TRIGGER IF EXISTS validate_ops_activation_canonical_plans
  ON operations_activation_scopes;
CREATE TRIGGER validate_ops_activation_canonical_plans
BEFORE INSERT OR UPDATE OF state ON operations_activation_scopes
FOR EACH ROW EXECUTE FUNCTION
  validate_ops_activation_canonical_plans();

-- BEGIN 0176 ACTIVE PLAN UPGRADE PREFLIGHT
-- Adding cartonization_evidence_id leaves legacy accepted plans with NULL.
-- Triggers protect later writes, but they do not retroactively validate an
-- organization that was already Active before this migration. Stop the
-- upgrade instead of silently retaining work that Active mode could release.
DO $$
DECLARE
  incompatible_organization_id uuid;
  incompatible_plan_global_id text;
BEGIN
  SELECT plan.organization_id, plan.global_id
    INTO incompatible_organization_id, incompatible_plan_global_id
  FROM operations_activation_scopes activation
  JOIN operations_fulfillment_plans plan
    ON plan.organization_id = activation.organization_id
  JOIN operations_orders source_order
    ON source_order.organization_id = plan.organization_id
   AND source_order.id = plan.order_id
  LEFT JOIN operations_cartonization_rate_evidence evidence
    ON evidence.organization_id = plan.organization_id
   AND evidence.id = plan.cartonization_evidence_id
  WHERE activation.state = 'active'
    AND plan.status IN ('planned', 'released')
    AND source_order.status NOT IN ('shipped', 'cancelled')
    AND (
      plan.cartonization_evidence_id IS NULL
      OR evidence.plan_snapshot->>'carrierReadEnvironment'
           IS DISTINCT FROM 'production'
    )
  ORDER BY plan.created_at, plan.id
  LIMIT 1;

  IF incompatible_plan_global_id IS NOT NULL THEN
    RAISE EXCEPTION
      'Migration 0176 cannot preserve Active Operations organization % while plan % lacks production carrier-read evidence; set Operations to Shadow and retry the migration',
      incompatible_organization_id,
      incompatible_plan_global_id;
  END IF;
END;
$$;
-- END 0176 ACTIVE PLAN UPGRADE PREFLIGHT

CREATE OR REPLACE FUNCTION validate_ops_package_cartonization_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  linked_plan_evidence_id uuid;
  linked_package_sequence integer;
  linked_dimensions jsonb;
  linked_weight_grams integer;
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.cartonization_evidence_id IS NOT NULL
     AND (
       NEW.cartonization_evidence_id
         IS DISTINCT FROM OLD.cartonization_evidence_id
       OR NEW.evidence_package_key
         IS DISTINCT FROM OLD.evidence_package_key
     )
  THEN
    RAISE EXCEPTION
      'An accepted physical package evidence link is immutable';
  END IF;

  IF NEW.cartonization_evidence_id IS NULL
     AND NEW.evidence_package_key IS NULL
  THEN
    RETURN NEW;
  END IF;
  IF NEW.cartonization_evidence_id IS NULL
     OR NEW.evidence_package_key IS NULL
  THEN
    RAISE EXCEPTION
      'Physical package evidence requires both aggregate and package keys';
  END IF;

  SELECT
    plan.cartonization_evidence_id,
    evidence_package.package_sequence,
    evidence_package.rated_outer_dimensions_mm,
    evidence_package.rated_gross_weight_grams
  INTO
    linked_plan_evidence_id,
    linked_package_sequence,
    linked_dimensions,
    linked_weight_grams
  FROM operations_fulfillment_plans plan
  JOIN operations_cartonization_rate_evidence_packages evidence_package
    ON evidence_package.organization_id = NEW.organization_id
   AND evidence_package.evidence_id = NEW.cartonization_evidence_id
   AND evidence_package.package_key = NEW.evidence_package_key
  WHERE plan.organization_id = NEW.organization_id
    AND plan.id = NEW.plan_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Physical package cartonization evidence was not found';
  END IF;
  IF linked_plan_evidence_id
       IS DISTINCT FROM NEW.cartonization_evidence_id
  THEN
    RAISE EXCEPTION
      'Physical package evidence must belong to its fulfillment plan';
  END IF;
  IF NEW.package_number IS DISTINCT FROM linked_package_sequence THEN
    RAISE EXCEPTION
      'Physical package number must match its evidence sequence';
  END IF;
  IF NEW.length_mm
       IS DISTINCT FROM (linked_dimensions->>'length')::integer
     OR NEW.width_mm
       IS DISTINCT FROM (linked_dimensions->>'width')::integer
     OR NEW.height_mm
       IS DISTINCT FROM (linked_dimensions->>'height')::integer
     OR NEW.weight_grams IS DISTINCT FROM linked_weight_grams
  THEN
    RAISE EXCEPTION
      'Physical package dimensions and weight must equal sealed evidence';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_ops_package_cartonization_evidence
  ON operations_packages;
CREATE TRIGGER validate_ops_package_cartonization_evidence
BEFORE INSERT OR UPDATE OF
  plan_id, package_number, length_mm, width_mm, height_mm, weight_grams,
  cartonization_evidence_id, evidence_package_key
ON operations_packages
FOR EACH ROW EXECUTE FUNCTION
  validate_ops_package_cartonization_evidence();

CREATE OR REPLACE FUNCTION validate_ops_packaging_material_claim()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_stock operations_packaging_material_stock%ROWTYPE;
  active_claimed_quantity bigint;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION
      'A packaging material claim must begin active';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
       OR NEW.plan_id IS DISTINCT FROM OLD.plan_id
       OR NEW.packaging_material_id
         IS DISTINCT FROM OLD.packaging_material_id
       OR NEW.warehouse_id IS DISTINCT FROM OLD.warehouse_id
       OR NEW.packaging_material_stock_id
         IS DISTINCT FROM OLD.packaging_material_stock_id
       OR NEW.quantity IS DISTINCT FROM OLD.quantity
       OR NEW.stock_row_version_at_claim
         IS DISTINCT FROM OLD.stock_row_version_at_claim
       OR NEW.on_hand_quantity_at_claim
         IS DISTINCT FROM OLD.on_hand_quantity_at_claim
       OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at
    THEN
      RAISE EXCEPTION
        'Packaging material claim identity, quantity, and stock evidence are immutable';
    END IF;
    IF OLD.status <> 'active'
       OR NEW.status NOT IN ('consumed', 'released')
    THEN
      RAISE EXCEPTION
        'Packaging material claim lifecycle is terminal';
    END IF;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'operations:packaging-material-claim:'
        || NEW.organization_id::text || ':'
        || NEW.warehouse_id::text || ':'
        || NEW.packaging_material_id::text,
      0
    )
  );

  SELECT * INTO source_stock
  FROM operations_packaging_material_stock stock
  WHERE stock.organization_id = NEW.organization_id
    AND stock.id = NEW.packaging_material_stock_id
    AND stock.packaging_material_id = NEW.packaging_material_id
    AND stock.warehouse_id = NEW.warehouse_id
  FOR UPDATE;

  IF source_stock.id IS NULL THEN
    RAISE EXCEPTION
      'Packaging material stock was not found for this claim';
  END IF;
  IF TG_OP = 'INSERT'
     AND (
       source_stock.is_available IS DISTINCT FROM true
       OR source_stock.on_hand_quantity IS NULL
     )
  THEN
    RAISE EXCEPTION
      'Packaging material stock is not available for this plan';
  END IF;
  IF TG_OP = 'INSERT'
     AND (
       source_stock.row_version
         IS DISTINCT FROM NEW.stock_row_version_at_claim
       OR source_stock.on_hand_quantity
         IS DISTINCT FROM NEW.on_hand_quantity_at_claim
     )
  THEN
    RAISE EXCEPTION
      'Packaging material stock changed before the claim was recorded';
  END IF;

  IF NEW.status = 'active' THEN
    PERFORM claim.id
    FROM operations_packaging_material_claims claim
    WHERE claim.organization_id = NEW.organization_id
      AND claim.warehouse_id = NEW.warehouse_id
      AND claim.packaging_material_id = NEW.packaging_material_id
      AND claim.status = 'active'
      AND (
        TG_OP <> 'UPDATE'
        OR claim.id <> NEW.id
      )
    ORDER BY claim.id
    FOR UPDATE;

    SELECT COALESCE(sum(claim.quantity), 0)
      INTO active_claimed_quantity
    FROM operations_packaging_material_claims claim
    WHERE claim.organization_id = NEW.organization_id
      AND claim.warehouse_id = NEW.warehouse_id
      AND claim.packaging_material_id = NEW.packaging_material_id
      AND claim.status = 'active'
      AND (
        TG_OP <> 'UPDATE'
        OR claim.id <> NEW.id
      );

    IF active_claimed_quantity + NEW.quantity
         > source_stock.on_hand_quantity
    THEN
      RAISE EXCEPTION
        'Active packaging material claims exceed physical on-hand stock';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_ops_packaging_material_claim
  ON operations_packaging_material_claims;
CREATE TRIGGER validate_ops_packaging_material_claim
BEFORE INSERT OR UPDATE ON operations_packaging_material_claims
FOR EACH ROW EXECUTE FUNCTION
  validate_ops_packaging_material_claim();

CREATE OR REPLACE FUNCTION validate_ops_packaging_stock_active_claims()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  active_claimed_quantity bigint;
BEGIN
  SELECT COALESCE(sum(claim.quantity), 0)
    INTO active_claimed_quantity
  FROM operations_packaging_material_claims claim
  WHERE claim.organization_id = NEW.organization_id
    AND claim.packaging_material_id = NEW.packaging_material_id
    AND claim.warehouse_id = NEW.warehouse_id
    AND claim.status = 'active';

  IF active_claimed_quantity > 0
     AND (
       NEW.is_available IS DISTINCT FROM true
       OR NEW.on_hand_quantity IS NULL
       OR NEW.on_hand_quantity < active_claimed_quantity
     )
  THEN
    RAISE EXCEPTION
      'Packaging material stock cannot fall below active plan claims';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_ops_packaging_stock_active_claims
  ON operations_packaging_material_stock;
CREATE TRIGGER validate_ops_packaging_stock_active_claims
BEFORE UPDATE OF is_available, on_hand_quantity
ON operations_packaging_material_stock
FOR EACH ROW EXECUTE FUNCTION
  validate_ops_packaging_stock_active_claims();

CREATE OR REPLACE FUNCTION validate_ops_fulfillment_allocation_integrity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  linked_reservation operations_reservations%ROWTYPE;
  linked_plan_order_id uuid;
  linked_line_order_id uuid;
BEGIN
  IF TG_OP = 'UPDATE'
     AND (
       NEW.organization_id IS DISTINCT FROM OLD.organization_id
       OR NEW.plan_id IS DISTINCT FROM OLD.plan_id
       OR NEW.order_line_id IS DISTINCT FROM OLD.order_line_id
       OR NEW.reservation_id IS DISTINCT FROM OLD.reservation_id
       OR NEW.position_id IS DISTINCT FROM OLD.position_id
       OR NEW.quantity IS DISTINCT FROM OLD.quantity
     )
  THEN
    RAISE EXCEPTION
      'Fulfillment allocation identity and quantity are immutable';
  END IF;

  SELECT * INTO linked_reservation
  FROM operations_reservations reservation
  WHERE reservation.organization_id = NEW.organization_id
    AND reservation.id = NEW.reservation_id
  FOR SHARE;

  IF linked_reservation.id IS NULL
     OR linked_reservation.status IS DISTINCT FROM 'active'
     OR linked_reservation.order_line_id
          IS DISTINCT FROM NEW.order_line_id
     OR linked_reservation.position_id IS DISTINCT FROM NEW.position_id
     OR linked_reservation.quantity IS DISTINCT FROM NEW.quantity
  THEN
    RAISE EXCEPTION
      'Fulfillment allocation must exactly match its active reservation';
  END IF;

  SELECT plan.order_id
    INTO linked_plan_order_id
  FROM operations_fulfillment_plans plan
  WHERE plan.organization_id = NEW.organization_id
    AND plan.id = NEW.plan_id;

  SELECT source_line.order_id
    INTO linked_line_order_id
  FROM operations_order_lines source_line
  WHERE source_line.organization_id = NEW.organization_id
    AND source_line.id = NEW.order_line_id;

  IF linked_plan_order_id IS NULL
     OR linked_line_order_id IS NULL
     OR linked_plan_order_id IS DISTINCT FROM linked_line_order_id
  THEN
    RAISE EXCEPTION
      'Fulfillment allocation line must belong to its plan order';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_ops_fulfillment_allocation_integrity
  ON operations_fulfillment_allocations;
CREATE TRIGGER validate_ops_fulfillment_allocation_integrity
BEFORE INSERT OR UPDATE ON operations_fulfillment_allocations
FOR EACH ROW EXECUTE FUNCTION
  validate_ops_fulfillment_allocation_integrity();

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
  active_claimed_quantity numeric(20,6);
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.reservation_authority
       IS DISTINCT FROM OLD.reservation_authority
  THEN
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
     )
  THEN
    RAISE EXCEPTION
      'Provider commitment reservation identity and evidence are immutable';
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD.reservation_authority = 'provider_commitment'
     AND OLD.status <> 'active'
     AND NEW.status IS DISTINCT FROM OLD.status
  THEN
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
     OR source_line.id IS NULL
  THEN
    RAISE EXCEPTION
      'Reservation order, line, and inventory position must exist';
  END IF;
  IF source_line.order_id IS DISTINCT FROM NEW.order_id
     OR source_line.product_id IS DISTINCT FROM source_position.product_id
  THEN
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
     OR source_order.source_provider IS DISTINCT FROM 'shopify'
  THEN
    RAISE EXCEPTION
      'Provider commitment evidence must match the Shopify order account';
  END IF;
  IF source_level.projection_state IS DISTINCT FROM 'projected'
     OR source_level.mapping_state IS DISTINCT FROM 'mapped'
     OR source_level.tracked IS DISTINCT FROM true
     OR source_level.equation_matches IS DISTINCT FROM true
     OR source_level.product_id IS DISTINCT FROM source_line.product_id
     OR source_level.pipeline_id IS DISTINCT FROM source_line.pipeline_id
  THEN
    RAISE EXCEPTION
      'Provider commitment inventory evidence is not an exact projected product level';
  END IF;

  IF NEW.status = 'active' THEN
    IF EXISTS (
      SELECT 1
      FROM operations_commerce_inventory_sync_runs newer
      WHERE newer.organization_id = source_run.organization_id
        AND newer.integration_account_id
          = source_run.integration_account_id
        AND newer.provider_location_id = source_run.provider_location_id
        AND newer.status = 'succeeded'
        AND (
          newer.completed_at,
          newer.id
        ) > (
          source_run.completed_at,
          source_run.id
        )
    ) THEN
      RAISE EXCEPTION
        'Provider commitment inventory evidence is stale';
    END IF;
    IF source_position.on_hand_quantity IS DISTINCT FROM (
         source_level.operational_available_quantity
           + source_level.provider_committed_quantity
       )
       OR source_position.reserved_quantity
         IS DISTINCT FROM source_level.provider_committed_quantity
    THEN
      RAISE EXCEPTION
        'Shopify-authoritative balances changed after the referenced reconciliation';
    END IF;

    SELECT COALESCE(sum(reservation.quantity), 0)
      INTO active_claimed_quantity
    FROM operations_reservations reservation
    WHERE reservation.organization_id = NEW.organization_id
      AND reservation.position_id = NEW.position_id
      AND reservation.reservation_authority = 'provider_commitment'
      AND reservation.status = 'active'
      AND (
        TG_OP <> 'UPDATE'
        OR reservation.id <> NEW.id
      );

    IF active_claimed_quantity + NEW.quantity
         > source_level.provider_committed_quantity
    THEN
      RAISE EXCEPTION
        'Active provider commitment claims exceed Shopify committed quantity';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_ops_reservation_authority
  ON operations_reservations;
CREATE TRIGGER validate_ops_reservation_authority
BEFORE INSERT OR UPDATE ON operations_reservations
FOR EACH ROW EXECUTE FUNCTION validate_ops_reservation_authority();

CREATE OR REPLACE FUNCTION protect_ops_inventory_ledger_authority()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  position_authority text;
BEGIN
  SELECT position.source_authority
    INTO position_authority
  FROM operations_inventory_positions position
  WHERE position.organization_id = NEW.organization_id
    AND position.id = NEW.position_id;

  IF position_authority = 'shopify' THEN
    IF NEW.source_authority IS DISTINCT FROM 'shopify'
       OR current_setting(
         'clawpilot.shopify_inventory_sync', true
       ) IS DISTINCT FROM 'on'
    THEN
      RAISE EXCEPTION
        'Shopify-authoritative balances and ledger can only change through reconciliation';
    END IF;
  ELSIF position_authority = 'clawpilot'
        AND NEW.source_authority IS DISTINCT FROM 'clawpilot'
  THEN
    RAISE EXCEPTION
      'ClawPilot-authoritative inventory requires a local ledger source';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_ops_inventory_ledger_authority
  ON operations_inventory_ledger;
CREATE TRIGGER protect_ops_inventory_ledger_authority
BEFORE INSERT ON operations_inventory_ledger
FOR EACH ROW EXECUTE FUNCTION protect_ops_inventory_ledger_authority();

COMMENT ON COLUMN
  operations_fulfillment_plans.cartonization_evidence_id IS
  'One-time immutable link to sealed operational cartonization and whole-shipment rate evidence for this accepted plan.';
COMMENT ON COLUMN
  operations_fulfillment_plans.estimated_revenue_minor IS
  'Authorized checkout shipping revenue in minor units; NULL when commerce header-money authority blocks or cannot prove the customer charge.';
COMMENT ON COLUMN
  operations_fulfillment_plans.estimated_margin_minor IS
  'Authorized checkout shipping revenue minus selected carrier estimate; NULL whenever checkout shipping revenue is unknown.';
COMMENT ON COLUMN
  operations_packages.evidence_package_key IS
  'Exact package key within the fulfillment plan cartonization evidence; dimensions, gross weight, and sequence must match.';
COMMENT ON COLUMN operations_carrier_rates.customer_charge_minor IS
  'Authorized checkout shipping charge in minor units; NULL when commerce header-money authority blocks or cannot prove the customer charge.';
COMMENT ON COLUMN
  operations_reservations.reservation_authority IS
  'local_balance changes a ClawPilot-owned balance; provider_commitment claims Shopify committed evidence without applying a second balance or ledger delta.';
COMMENT ON COLUMN
  operations_reservations.provider_inventory_sync_run_id IS
  'Exact immutable successful Shopify reconciliation used by a provider commitment claim.';
COMMENT ON COLUMN
  operations_reservations.provider_inventory_level_id IS
  'Exact projected Shopify product/position level bounding a provider commitment claim.';
COMMENT ON COLUMN
  operations_cartonization_rate_evidence_commands.semantic_request_hash IS
  'Stable normalized operator-command hash claimed before database or carrier reads. It excludes volatile read timestamps; the evidence request_hash retains the exact resulting plan snapshot.';
COMMENT ON TABLE operations_packaging_material_claims IS
  'Durable plan-scoped claims against physical packaging stock. Active claims reduce planning availability without decrementing warehouse on-hand; successful shipment confirmation atomically consumes each claim and decrements stock exactly once.';
COMMENT ON COLUMN operations_packaging_material_claims.quantity IS
  'Exact number of this packaging material required by the sealed plan.';
COMMENT ON COLUMN
  operations_packaging_material_claims.stock_row_version_at_claim IS
  'Warehouse packaging-stock revision locked and verified when the claim was created.';
