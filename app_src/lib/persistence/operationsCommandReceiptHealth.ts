export const OPERATIONS_COMMAND_RECEIPT_CLASSIFICATION_CTES = `
  WITH non_demo_organizations AS MATERIALIZED (
    SELECT organization.id
    FROM workspace_organizations organization
    WHERE organization.is_demo = false
  ),
  failed_receipts AS MATERIALIZED (
    SELECT
      receipt.*,
      substring(
        receipt.idempotency_key
        FROM '^operations-shadow-fulfillment-(gor([0-9]{7}|[0-9a-v]{12}))-[0-9]{8}-v[1-9][0-9]*$'
      ) AS preparation_order_global_id
    FROM operations_command_receipts receipt
    JOIN non_demo_organizations organization
      ON organization.id = receipt.organization_id
    WHERE receipt.status = 'failed'
  ),
  classified_failures AS (
    SELECT
      failed.id,
      failed.idempotency_key,
      CASE
        WHEN failed.command_type = 'prepare_mock_operations_order'
          AND failed.idempotency_key
            ~ '^mock-commerce:[a-z0-9][a-z0-9:_-]{2,180}:planned$'
          AND failed.error_code = 'OPERATIONS_PROOF_REQUIRES_SHADOW'
          AND failed.error_message =
            'Mock proof orders are available only while Operations is in shadow mode'
          AND failed.result_global_id IS NULL
          AND failed.result_payload IS NULL
          AND failed.completed_at IS NOT NULL
        THEN 'policy_rejected'
        WHEN failed.command_type = 'prepare_operations_shipment_execution'
          AND failed.error_code = 'OPERATIONS_REQUEST_FAILED'
          AND failed.error_message =
            'Fulfillment execution requires exact canonical lines, packages, allocations, and one succeeded selected whole-shipment rate attempt'
          AND failed.result_global_id IS NULL
          AND failed.result_payload IS NULL
          AND failed.completed_at IS NOT NULL
          AND failed.preparation_order_global_id IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM operations_command_receipts successor
            WHERE successor.organization_id = failed.organization_id
              AND successor.command_type = failed.command_type
              AND successor.status = 'succeeded'
              AND successor.created_at > failed.created_at
              AND successor.completed_at > failed.completed_at
              AND successor.result_global_id
                ~ '^gofe([0-9]{7}|[0-9a-v]{12})$'
              AND jsonb_typeof(successor.result_payload) = 'object'
              AND successor.result_payload->>'orderGlobalId' =
                failed.preparation_order_global_id
              AND successor.result_payload->>'fulfillmentExecutionGlobalId' =
                successor.result_global_id
          )
        THEN 'superseded'
        ELSE 'actionable'
      END AS classification
    FROM failed_receipts failed
  )
`

export const OPERATIONS_COMMAND_RECEIPT_HEALTH_QUERY = `
  ${OPERATIONS_COMMAND_RECEIPT_CLASSIFICATION_CTES},
  receipt_counts AS (
    SELECT
      count(*) FILTER (
        WHERE receipt.status = 'processing'
      )::integer AS processing,
      count(*) FILTER (
        WHERE receipt.status = 'failed'
      )::integer AS failed,
      count(*) FILTER (
        WHERE receipt.status = 'processing'
          AND receipt.updated_at < now() - interval '15 minutes'
      )::integer AS stale_processing
    FROM operations_command_receipts receipt
    JOIN non_demo_organizations organization
      ON organization.id = receipt.organization_id
  )
  SELECT
    counts.processing,
    counts.failed,
    counts.stale_processing,
    (
      SELECT count(*)::integer
      FROM classified_failures failure
      WHERE failure.classification = 'policy_rejected'
    ) AS policy_rejected,
    (
      SELECT count(*)::integer
      FROM classified_failures failure
      WHERE failure.classification = 'superseded'
    ) AS superseded,
    (
      SELECT count(*)::integer
      FROM classified_failures failure
      WHERE failure.classification = 'actionable'
    ) AS actionable_failed,
    (
      SELECT count(*)::integer
      FROM operations_activation_scopes
      WHERE state = 'active'
    ) AS active_organizations,
    (
      SELECT count(*)::integer
      FROM operations_activation_scopes
      WHERE state = 'shadow'
    ) AS shadow_organizations
  FROM receipt_counts counts
`
