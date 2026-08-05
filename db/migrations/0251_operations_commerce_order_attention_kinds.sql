-- Order reconciliation attention is durable operational state, not an error
-- category. Keep promotion, Faire exact-refresh, and legacy unattributed
-- attention independently so worker failures and mixed outcomes cannot
-- overwrite or invent subtype provenance.

ALTER TABLE operations_commerce_sync_cursors
  ADD COLUMN IF NOT EXISTS automatic_promotion_attention_required boolean
    NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS automatic_exact_refresh_attention_required boolean
    NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS automatic_unattributed_attention_required boolean
    NOT NULL DEFAULT false;

UPDATE operations_commerce_sync_cursors
SET automatic_promotion_attention_required = true
WHERE resource = 'orders'
  AND last_error_code IN (
    'COMMERCE_SHOPIFY_ORDER_AUTO_PROMOTION_ATTENTION_REQUIRED',
    'COMMERCE_FAIRE_PROMOTION_ATTENTION_REQUIRED',
    'COMMERCE_FAIRE_PROMOTION_AND_EXACT_REFRESH_ATTENTION_REQUIRED'
  );

UPDATE operations_commerce_sync_cursors
SET automatic_exact_refresh_attention_required = true
WHERE resource = 'orders'
  AND last_error_code IN (
    'COMMERCE_FAIRE_EXACT_REFRESH_ATTENTION_REQUIRED',
    'COMMERCE_FAIRE_PROMOTION_AND_EXACT_REFRESH_ATTENTION_REQUIRED'
  );

-- Before subtype provenance existed, both Faire promotion and exact-refresh
-- paths wrote the same generic candidate marker. Preserve it only as aggregate
-- operator attention. Candidate evidence also recovers the signal when a later
-- reconciliation failure overwrote the cursor last_error_code.
UPDATE operations_commerce_sync_cursors cursor
SET automatic_unattributed_attention_required = true
WHERE cursor.resource = 'orders'
  AND (
    cursor.last_error_code =
      'COMMERCE_FAIRE_ORDER_AUTO_PROMOTION_ATTENTION_REQUIRED'
    OR EXISTS (
      SELECT 1
      FROM operations_commerce_order_candidates candidate
      JOIN operations_commerce_intake_runs run
        ON run.organization_id = candidate.organization_id
       AND run.integration_account_id = candidate.integration_account_id
       AND run.id = candidate.run_id
      WHERE candidate.organization_id = cursor.organization_id
        AND candidate.integration_account_id = cursor.integration_account_id
        AND candidate.provider = 'faire'
        AND candidate.workflow_state IN ('held', 'resolving', 'ready')
        AND candidate.customer_resolution_state <> 'unsupported'
        AND candidate.expires_at > now()
        AND candidate.last_error_code =
          'COMMERCE_FAIRE_ORDER_AUTO_PROMOTION_ATTENTION_REQUIRED'
        AND candidate.created_by = 'system:commerce-order-reconciliation'
        AND run.provider = 'faire'
        AND run.resource = 'products_and_orders'
        AND run.created_by = 'system:commerce-order-reconciliation'
        AND run.workflow_state <> 'expired'
        AND run.expires_at > now()
        AND NOT EXISTS (
          SELECT 1
          FROM operations_orders canonical
          WHERE canonical.organization_id = candidate.organization_id
            AND canonical.integration_account_id =
              candidate.integration_account_id
            AND canonical.external_order_id = candidate.external_order_id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM operations_external_identifiers external
          WHERE external.organization_id = candidate.organization_id
            AND external.integration_account_id =
              candidate.integration_account_id
            AND external.entity_type = 'operations.order'
            AND external.status = 'active'
            AND external.external_id = candidate.external_order_id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM operations_commerce_order_candidates newer
          WHERE newer.organization_id = candidate.organization_id
            AND newer.integration_account_id = candidate.integration_account_id
            AND newer.external_order_id = candidate.external_order_id
            AND newer.id <> candidate.id
            AND (
              newer.observed_at > candidate.observed_at
              OR (
                newer.observed_at = candidate.observed_at
                AND newer.created_at > candidate.created_at
              )
              OR (
                newer.observed_at = candidate.observed_at
                AND newer.created_at = candidate.created_at
                AND newer.id > candidate.id
              )
            )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM operations_commerce_order_candidates history
          WHERE history.organization_id = candidate.organization_id
            AND history.integration_account_id =
              candidate.integration_account_id
            AND history.external_order_id = candidate.external_order_id
            AND (
              history.created_by <> 'system:commerce-order-reconciliation'
              OR history.updated_by <>
                'system:commerce-order-reconciliation'
              OR EXISTS (
                SELECT 1
                FROM operations_commerce_resolution_decisions decision
                WHERE decision.organization_id = history.organization_id
                  AND decision.target_global_id = history.global_id
                  AND decision.actor_email <>
                    'system:commerce-order-reconciliation'
              )
              OR EXISTS (
                SELECT 1
                FROM operations_commerce_intake_read_intents human_intent
                WHERE human_intent.organization_id = history.organization_id
                  AND human_intent.integration_account_id =
                    history.integration_account_id
                  AND human_intent.provider = 'faire'
                  AND human_intent.resource = 'orders'
                  AND human_intent.target_kind = 'candidate'
                  AND human_intent.target_global_id = history.global_id
                  AND human_intent.created_by <>
                    'system:commerce-order-reconciliation'
              )
            )
        )
    )
  );

CREATE INDEX IF NOT EXISTS
  operations_commerce_sync_cursors_order_attention_idx
ON operations_commerce_sync_cursors (
  organization_id,
  integration_account_id
)
WHERE resource = 'orders'
  AND (
    automatic_promotion_attention_required
    OR automatic_exact_refresh_attention_required
    OR automatic_unattributed_attention_required
  );

COMMENT ON COLUMN
  operations_commerce_sync_cursors.automatic_promotion_attention_required IS
  'Durable unresolved automatic order-promotion attention; independent from last_error_code.';

COMMENT ON COLUMN
  operations_commerce_sync_cursors.automatic_exact_refresh_attention_required IS
  'Durable unresolved Faire exact-refresh attention; independent from promotion and last_error_code.';

COMMENT ON COLUMN
  operations_commerce_sync_cursors.automatic_unattributed_attention_required IS
  'Durable unresolved legacy Faire attention without trustworthy subtype provenance.';
