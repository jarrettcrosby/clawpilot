-- Exact, zero-write recovery when Shopify has already fulfilled a released,
-- wholly unpicked ClawPilot order. The provider read is retained immutably;
-- warehouse state is terminalized by the guarded application transaction.

INSERT INTO global_reference_entity_types (prefix, entity_type, display_name)
VALUES (
  'gsfr',
  'operations.shopify_external_fulfillment_reconciliation',
  'Shopify external fulfillment reconciliation'
)
ON CONFLICT (prefix) DO UPDATE SET
  entity_type = EXCLUDED.entity_type,
  display_name = EXCLUDED.display_name;

-- A failed projection still retains its immutable provider capture. Surface a
-- released plan when that strictly newer capture no longer contains enough
-- Shopify committed quantity to support every active claim on the position.
-- The command must still prove exact fulfillment with a fresh Shopify order
-- read; this signal alone never authorizes cancellation.
CREATE OR REPLACE FUNCTION
  operations_shopify_external_fulfillment_reconciliation_required(
    p_organization_id uuid,
    p_plan_id uuid
  )
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  WITH plan_claims AS (
    SELECT DISTINCT
      reservation.position_id,
      source_level.integration_account_id,
      source_level.provider_location_id,
      source_level.external_inventory_item_id,
      source_run.provider_fetched_at AS source_provider_fetched_at,
      source_capture.created_at AS source_capture_created_at
    FROM operations_fulfillment_allocations allocation
    JOIN operations_reservations reservation
      ON reservation.organization_id = allocation.organization_id
     AND reservation.id = allocation.reservation_id
    JOIN operations_commerce_inventory_levels source_level
      ON source_level.organization_id = reservation.organization_id
     AND source_level.id = reservation.provider_inventory_level_id
     AND source_level.sync_run_id =
           reservation.provider_inventory_sync_run_id
     AND source_level.inventory_position_id = reservation.position_id
    JOIN operations_commerce_inventory_sync_runs source_run
      ON source_run.organization_id = source_level.organization_id
     AND source_run.id = source_level.sync_run_id
    JOIN operations_commerce_inventory_captures source_capture
      ON source_capture.organization_id = source_run.organization_id
     AND source_capture.integration_account_id =
           source_run.integration_account_id
     AND source_capture.provider_attempt_id = source_run.provider_attempt_id
     AND source_capture.id = source_run.capture_id
    WHERE allocation.organization_id = p_organization_id
      AND allocation.plan_id = p_plan_id
      AND allocation.order_line_id = reservation.order_line_id
      AND allocation.position_id = reservation.position_id
      AND allocation.quantity = reservation.quantity
      AND reservation.reservation_authority = 'provider_commitment'
      AND reservation.status = 'active'
  ),
  active_claim_totals AS (
    SELECT
      active_claim.position_id,
      sum(active_claim.quantity) AS active_claim_quantity
    FROM operations_reservations active_claim
    WHERE active_claim.organization_id = p_organization_id
      AND active_claim.reservation_authority = 'provider_commitment'
      AND active_claim.status = 'active'
      AND active_claim.position_id IN (
        SELECT claim.position_id FROM plan_claims claim
      )
    GROUP BY active_claim.position_id
  ),
  claim_locations AS (
    SELECT DISTINCT
      claim.integration_account_id,
      claim.provider_location_id
    FROM plan_claims claim
  ),
  latest_captures AS (
    SELECT
      claim_location.integration_account_id,
      claim_location.provider_location_id,
      latest.provider_fetched_at,
      latest.created_at,
      latest.snapshot
    FROM claim_locations claim_location
    JOIN LATERAL (
      SELECT
        capture.provider_fetched_at,
        capture.created_at,
        COALESCE(
          capture.captured_snapshot,
          content.snapshot_content
        ) AS snapshot
      FROM operations_commerce_inventory_captures capture
      LEFT JOIN operations_commerce_inventory_snapshot_contents content
        ON content.organization_id = capture.organization_id
       AND content.integration_account_id = capture.integration_account_id
       AND content.id = capture.snapshot_content_id
      WHERE capture.organization_id = p_organization_id
        AND capture.integration_account_id =
              claim_location.integration_account_id
        AND capture.provider_location_id =
              claim_location.provider_location_id
      ORDER BY
        capture.provider_fetched_at DESC,
        capture.created_at DESC,
        capture.id DESC
      LIMIT 1
    ) latest ON true
  ),
  captured_levels AS (
    SELECT
      latest_capture.integration_account_id,
      latest_capture.provider_location_id,
      latest_capture.provider_fetched_at,
      level ->> 'inventoryItemId' AS inventory_item_id,
      CASE
        WHEN level #>> '{quantities,committed}'
               ~ '^-?[0-9]+([.][0-9]+)?$'
        THEN (level #>> '{quantities,committed}')::numeric
        ELSE NULL
      END AS committed_quantity
    FROM latest_captures latest_capture
    CROSS JOIN LATERAL jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(latest_capture.snapshot -> 'levels') = 'array'
          THEN latest_capture.snapshot -> 'levels'
          ELSE '[]'::jsonb
        END
      ) level
  )
  SELECT EXISTS (
    SELECT 1
    FROM plan_claims claim
    JOIN active_claim_totals total
      ON total.position_id = claim.position_id
    JOIN latest_captures latest_capture
      ON latest_capture.integration_account_id =
           claim.integration_account_id
     AND latest_capture.provider_location_id = claim.provider_location_id
    LEFT JOIN captured_levels provider_level
      ON provider_level.integration_account_id =
           claim.integration_account_id
     AND provider_level.provider_location_id = claim.provider_location_id
     AND provider_level.inventory_item_id =
           claim.external_inventory_item_id
    WHERE (
      latest_capture.provider_fetched_at,
      latest_capture.created_at
    ) > (
      claim.source_provider_fetched_at,
      claim.source_capture_created_at
    )
      AND (
        provider_level.inventory_item_id IS NULL
        OR provider_level.committed_quantity IS NULL
        OR provider_level.committed_quantity < total.active_claim_quantity
      )
  );
$$;

COMMENT ON FUNCTION
  operations_shopify_external_fulfillment_reconciliation_required(uuid, uuid)
IS
  'Signals a released plan whose active Shopify provider commitment is unsupported by a strictly newer immutable capture; exact live fulfillment readback is still required.';

CREATE TABLE IF NOT EXISTS
  operations_shopify_external_fulfillment_reconciliations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    global_id text NOT NULL DEFAULT allocate_global_reference('gsfr'),
    organization_id uuid NOT NULL
      REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
    command_receipt_id uuid NOT NULL,
    order_id uuid NOT NULL,
    integration_account_id uuid NOT NULL,
    plan_id uuid NOT NULL,
    wave_id uuid NOT NULL,
    external_order_id text NOT NULL,
    provider_order_name text NOT NULL,
    provider_order_updated_at timestamptz NOT NULL,
    provider_order_closed_at timestamptz,
    provider_fulfillment_id text NOT NULL,
    provider_fulfillment_name text NOT NULL,
    provider_fulfillment_created_at timestamptz NOT NULL,
    provider_fulfillment_updated_at timestamptz NOT NULL,
    provider_location_id text NOT NULL,
    provider_fulfillment_order_ids text[] NOT NULL,
    evidence_hash text NOT NULL CHECK (evidence_hash ~ '^[a-f0-9]{64}$'),
    evidence_snapshot jsonb NOT NULL CHECK (
      jsonb_typeof(evidence_snapshot) = 'object'
    ),
    provider_read_count integer NOT NULL CHECK (provider_read_count = 2),
    provider_write_count integer NOT NULL CHECK (provider_write_count = 0),
    reason text NOT NULL,
    reconciled_by text NOT NULL
      REFERENCES app_users(email) ON DELETE RESTRICT,
    reconciled_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ops_shopify_external_fulfillment_recon_global_valid CHECK (
      global_id ~ '^gsfr(?:[0-9]{7}|[0-9a-v]{12})$'
    ),
    CONSTRAINT ops_shopify_external_fulfillment_recon_global_unique
      UNIQUE (global_id),
    CONSTRAINT ops_shopify_external_fulfillment_recon_registry_fkey
      FOREIGN KEY (global_id)
      REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
    CONSTRAINT ops_shopify_external_fulfillment_recon_receipt_fkey
      FOREIGN KEY (organization_id, command_receipt_id)
      REFERENCES operations_command_receipts(organization_id, id)
      ON DELETE RESTRICT,
    CONSTRAINT ops_shopify_external_fulfillment_recon_order_fkey
      FOREIGN KEY (organization_id, order_id)
      REFERENCES operations_orders(organization_id, id) ON DELETE RESTRICT,
    CONSTRAINT ops_shopify_external_fulfillment_recon_account_fkey
      FOREIGN KEY (organization_id, integration_account_id)
      REFERENCES operations_integration_accounts(organization_id, id)
      ON DELETE RESTRICT,
    CONSTRAINT ops_shopify_external_fulfillment_recon_plan_fkey
      FOREIGN KEY (organization_id, plan_id)
      REFERENCES operations_fulfillment_plans(organization_id, id)
      ON DELETE RESTRICT,
    CONSTRAINT ops_shopify_external_fulfillment_recon_wave_fkey
      FOREIGN KEY (organization_id, wave_id)
      REFERENCES operations_waves(organization_id, id) ON DELETE RESTRICT,
    CONSTRAINT ops_shopify_external_fulfillment_recon_order_unique
      UNIQUE (organization_id, order_id),
    CONSTRAINT ops_shopify_external_fulfillment_recon_receipt_unique
      UNIQUE (organization_id, command_receipt_id),
    CONSTRAINT ops_shopify_external_fulfillment_recon_identity_valid CHECK (
      length(btrim(external_order_id)) BETWEEN 1 AND 512
      AND length(btrim(provider_order_name)) BETWEEN 1 AND 255
      AND length(btrim(provider_fulfillment_id)) BETWEEN 1 AND 512
      AND length(btrim(provider_fulfillment_name)) BETWEEN 1 AND 255
      AND length(btrim(provider_location_id)) BETWEEN 1 AND 512
      AND cardinality(provider_fulfillment_order_ids) BETWEEN 1 AND 25
      AND reason = btrim(reason)
      AND length(reason) BETWEEN 1 AND 500
      AND external_order_id !~ '[[:cntrl:]]'
      AND provider_order_name !~ '[[:cntrl:]]'
      AND provider_fulfillment_id !~ '[[:cntrl:]]'
      AND provider_fulfillment_name !~ '[[:cntrl:]]'
      AND provider_location_id !~ '[[:cntrl:]]'
      AND reason !~ '[[:cntrl:]]'
    )
  );

CREATE INDEX IF NOT EXISTS
  idx_ops_shopify_external_fulfillment_recon_recent
ON operations_shopify_external_fulfillment_reconciliations (
  organization_id, reconciled_at DESC, id DESC
);

CREATE OR REPLACE FUNCTION
  reject_operations_shopify_external_fulfillment_reconciliation_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'operations_shopify_external_fulfillment_reconciliations rows are immutable';
END;
$$;

DROP TRIGGER IF EXISTS
  operations_shopify_external_fulfillment_reconciliations_immutable
ON operations_shopify_external_fulfillment_reconciliations;
CREATE TRIGGER
  operations_shopify_external_fulfillment_reconciliations_immutable
BEFORE UPDATE OR DELETE
ON operations_shopify_external_fulfillment_reconciliations
FOR EACH ROW EXECUTE FUNCTION
  reject_operations_shopify_external_fulfillment_reconciliation_mutation();

COMMENT ON TABLE
  operations_shopify_external_fulfillment_reconciliations IS
  'Immutable exact Shopify fulfillment readback used to cancel stale released warehouse work without a provider write.';
