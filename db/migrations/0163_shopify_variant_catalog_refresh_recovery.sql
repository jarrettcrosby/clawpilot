-- Shopify ProductVariants are sellable inventory identities. A single parent
-- Product may therefore map to more than one ClawPilot Product when its
-- variants have distinct SKUs, inventory, or pack profiles.
--
-- Product-image delivery remains parent-Product scoped. Its prepare, grant,
-- claim, and effect boundaries already reject an ambiguous parent mapping.
-- The broader channel-state trigger introduced in 0160 duplicated that guard
-- at catalog ingestion time and prevented otherwise-valid variant refreshes.

DROP TRIGGER IF EXISTS
  protect_operations_shopify_parent_product_mapping_write
  ON operations_product_channel_states;

DROP FUNCTION IF EXISTS
  protect_operations_shopify_parent_product_mapping();

-- A catalog job that encountered the retired trigger stored only PostgreSQL's
-- generic P0001 code. Requeue only recent Shopify jobs whose account currently
-- exhibits the exact multi-product parent condition repaired above. Preserve
-- the prior terminal evidence in result_summary instead of deleting the job.
UPDATE operations_commerce_catalog_sync_jobs AS job
SET status = 'failed',
    attempt_count = 0,
    available_at = now(),
    locked_at = NULL,
    locked_by = NULL,
    lock_token = NULL,
    completed_at = NULL,
    last_error_code =
      'COMMERCE_CATALOG_SYNC_RECOVERED_VARIANT_PARENT_SCOPE',
    result_summary = COALESCE(job.result_summary, '{}'::jsonb)
      || jsonb_build_object(
        'recovery',
        'shopify_variant_parent_scope_v1',
        'recoveredPriorErrorCode',
        'P0001',
        'recoveredAt',
        now()
      ),
    updated_at = now()
WHERE job.status = 'dead'
  AND job.provider = 'shopify'
  AND job.last_error_code = 'P0001'
  AND job.updated_at >= now() - interval '24 hours'
  AND EXISTS (
    SELECT 1
    FROM operations_product_channel_states AS state
    WHERE state.organization_id = job.organization_id
      AND state.integration_account_id = job.integration_account_id
      AND state.provider = 'shopify'
      AND state.product_id IS NOT NULL
    GROUP BY state.external_product_id
    HAVING count(DISTINCT state.product_id) > 1
  );

COMMENT ON TABLE operations_product_channel_states IS
  'Durable current provider lifecycle per exact sales-channel variant; Shopify siblings may map to distinct ClawPilot sellable products, while parent-scoped media writes fail closed at their dedicated authority boundaries.';
