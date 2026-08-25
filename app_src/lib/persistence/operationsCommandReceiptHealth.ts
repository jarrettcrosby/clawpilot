export const OPERATIONS_COMMAND_RECEIPT_CLASSIFICATION_CTES = `
  WITH non_demo_organizations AS MATERIALIZED (
    SELECT organization.id
    FROM workspace_organizations organization
    WHERE organization.is_demo = false
  ),
  successful_external_fulfillment_reconciliations AS MATERIALIZED (
    SELECT receipt.organization_id,
           receipt.target_global_id,
           receipt.created_at,
           receipt.completed_at
    FROM operations_command_receipts receipt
    JOIN non_demo_organizations organization
      ON organization.id = receipt.organization_id
    WHERE receipt.command_type =
            'reconcile_shopify_external_fulfillment'
      AND receipt.status = 'succeeded'
      AND receipt.completed_at IS NOT NULL
      AND receipt.completed_at >= receipt.created_at
      AND receipt.updated_at >= receipt.completed_at
      AND receipt.error_code IS NULL
      AND receipt.error_message IS NULL
      AND receipt.target_global_id
        ~ '^gor([0-9]{7}|[0-9a-v]{12})$'
      AND receipt.result_global_id = receipt.target_global_id
      AND jsonb_typeof(receipt.result_payload) = 'object'
      AND receipt.result_payload->>'orderGlobalId' =
            receipt.result_global_id
      AND receipt.result_payload->>'orderStatus' = 'cancelled'
      AND jsonb_typeof(receipt.result_payload->'rowVersion') = 'number'
      AND receipt.result_payload->>'rowVersion'
        ~ '^[1-9][0-9]{0,14}$'
      AND receipt.result_payload->>'reconciliationGlobalId'
        ~ '^gsfr([0-9]{7}|[0-9a-v]{12})$'
      AND jsonb_typeof(
        receipt.result_payload->'providerFulfillmentId'
      ) = 'string'
      AND length(btrim(
        receipt.result_payload->>'providerFulfillmentId'
      )) > 0
      AND jsonb_typeof(
        receipt.result_payload->'providerFulfillmentName'
      ) = 'string'
      AND length(btrim(
        receipt.result_payload->>'providerFulfillmentName'
      )) > 0
      AND receipt.result_payload->'providerReads' = '2'::jsonb
      AND receipt.result_payload->'providerWrites' = '0'::jsonb
      AND receipt.result_payload->'replayed' = 'false'::jsonb
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
        WHEN failed.command_type = 'record_wearable_pick_scan_evidence'
          AND failed.error_code = 'OPERATIONS_ORDER_NOT_FOUND'
          AND failed.error_message = 'Operations order was not found'
          AND failed.result_global_id IS NULL
          AND failed.result_payload IS NULL
          AND failed.completed_at IS NOT NULL
          AND failed.completed_at >= failed.created_at
          AND failed.updated_at >= failed.completed_at
          AND failed.target_global_id
            ~ '^gor([0-9]{7}|[0-9a-v]{12})$'
          AND NOT EXISTS (
            SELECT 1
            FROM operations_orders scoped_order
            WHERE scoped_order.organization_id = failed.organization_id
              AND scoped_order.global_id = failed.target_global_id
          )
          AND EXISTS (
            SELECT 1
            FROM operations_orders other_order
            JOIN non_demo_organizations other_organization
              ON other_organization.id = other_order.organization_id
            WHERE other_order.organization_id <> failed.organization_id
              AND other_order.global_id = failed.target_global_id
          )
        THEN 'policy_rejected'
        WHEN failed.command_type = 'plan_operations_order'
          AND failed.result_global_id IS NULL
          AND failed.result_payload IS NULL
          AND failed.completed_at IS NOT NULL
          AND failed.completed_at >= failed.created_at
          AND failed.updated_at >= failed.completed_at
          AND failed.error_code IS NOT NULL
          AND length(btrim(failed.error_code)) > 0
          AND failed.error_message IS NOT NULL
          AND length(btrim(failed.error_message)) > 0
          AND failed.target_global_id
            ~ '^gor([0-9]{7}|[0-9a-v]{12})$'
          AND EXISTS (
            SELECT 1
            FROM operations_command_receipts successor
            WHERE successor.organization_id = failed.organization_id
              AND successor.command_type = failed.command_type
              AND successor.status = 'succeeded'
              AND successor.created_at > failed.completed_at
              AND successor.completed_at > failed.completed_at
              AND successor.completed_at >= successor.created_at
              AND successor.updated_at >= successor.completed_at
              AND successor.error_code IS NULL
              AND successor.error_message IS NULL
              AND successor.target_global_id = failed.target_global_id
              AND successor.result_global_id =
                failed.target_global_id
              AND successor.result_global_id
                ~ '^gor([0-9]{7}|[0-9a-v]{12})$'
              AND jsonb_typeof(successor.result_payload) = 'object'
              AND jsonb_typeof(
                successor.result_payload->'orderGlobalId'
              ) = 'string'
              AND successor.result_payload->>'orderGlobalId' =
                successor.result_global_id
              AND successor.result_payload->>'orderStatus' = 'planned'
              AND jsonb_typeof(
                successor.result_payload->'rowVersion'
              ) = 'number'
              AND successor.result_payload->>'rowVersion'
                ~ '^(0|[1-9][0-9]{0,14})$'
              AND successor.result_payload->>'fulfillmentPlanGlobalId'
                ~ '^gfp([0-9]{7}|[0-9a-v]{12})$'
              AND successor.result_payload->>'cartonizationEvidenceGlobalId'
                ~ '^gcte([0-9]{7}|[0-9a-v]{12})$'
              AND jsonb_typeof(
                successor.result_payload->'packageCount'
              ) = 'number'
              AND successor.result_payload->>'packageCount'
                ~ '^[1-9][0-9]{0,8}$'
              AND successor.result_payload->>'carrier' IN ('UPS', 'FedEx')
              AND jsonb_typeof(
                successor.result_payload->'serviceCode'
              ) = 'string'
              AND length(btrim(
                successor.result_payload->>'serviceCode'
              )) > 0
              AND jsonb_typeof(
                successor.result_payload->'serviceName'
              ) = 'string'
              AND length(btrim(
                successor.result_payload->>'serviceName'
              )) > 0
              AND jsonb_typeof(
                successor.result_payload->'carrierCostMinor'
              ) = 'number'
              AND successor.result_payload->>'carrierCostMinor'
                ~ '^(0|[1-9][0-9]{0,14})$'
              AND jsonb_typeof(
                successor.result_payload->'currency'
              ) = 'string'
              AND successor.result_payload->>'currency' ~ '^[A-Z]{3}$'
              AND successor.result_payload
                ? 'checkoutShippingChargeMinor'
              AND (
                successor.result_payload->'checkoutShippingChargeMinor'
                  = 'null'::jsonb
                OR (
                  jsonb_typeof(
                    successor.result_payload
                      ->'checkoutShippingChargeMinor'
                  ) = 'number'
                  AND successor.result_payload
                    ->>'checkoutShippingChargeMinor'
                    ~ '^(0|[1-9][0-9]{0,14})$'
                )
              )
              AND successor.result_payload ? 'checkoutVarianceMinor'
              AND (
                successor.result_payload->'checkoutVarianceMinor'
                  = 'null'::jsonb
                OR (
                  jsonb_typeof(
                    successor.result_payload->'checkoutVarianceMinor'
                  ) = 'number'
                  AND successor.result_payload->>'checkoutVarianceMinor'
                    ~ '^-?(0|[1-9][0-9]{0,14})$'
                )
              )
              AND successor.result_payload->'replayed' = 'false'::jsonb
          )
        THEN 'superseded'
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
        WHEN failed.command_type =
              'reconcile_shopify_external_fulfillment'
          AND failed.error_code =
              'SHOPIFY_EXTERNAL_FULFILLMENT_LINE_CHANGED'
          AND failed.error_message IS NOT NULL
          AND length(btrim(failed.error_message)) > 0
          AND failed.result_global_id IS NULL
          AND failed.result_payload IS NULL
          AND failed.completed_at IS NOT NULL
          AND failed.completed_at >= failed.created_at
          AND failed.updated_at >= failed.completed_at
          AND failed.target_global_id
            ~ '^gor([0-9]{7}|[0-9a-v]{12})$'
          AND EXISTS (
            SELECT 1
            FROM successful_external_fulfillment_reconciliations successor
            WHERE successor.organization_id = failed.organization_id
              AND successor.target_global_id = failed.target_global_id
              AND successor.created_at > failed.completed_at
              AND successor.completed_at > failed.completed_at
          )
        THEN 'superseded'
        WHEN failed.command_type = 'confirm_operations_order_picks'
          AND failed.error_code =
              'OPERATIONS_SHOPIFY_EXTERNAL_FULFILLMENT_RECONCILIATION_REQUIRED'
          AND failed.error_message IS NOT NULL
          AND length(btrim(failed.error_message)) > 0
          AND failed.result_global_id IS NULL
          AND failed.result_payload IS NULL
          AND failed.completed_at IS NOT NULL
          AND failed.completed_at >= failed.created_at
          AND failed.updated_at >= failed.completed_at
          AND failed.target_global_id
            ~ '^gor([0-9]{7}|[0-9a-v]{12})$'
          AND EXISTS (
            SELECT 1
            FROM successful_external_fulfillment_reconciliations successor
            WHERE successor.organization_id = failed.organization_id
              AND successor.target_global_id = failed.target_global_id
              AND successor.created_at > failed.completed_at
              AND successor.completed_at > failed.completed_at
          )
        THEN 'superseded'
        WHEN failed.command_type =
              'operations.commerce_order_workbench.update_ship_to'
          AND failed.error_code =
              'OPERATIONS_IMPORTED_ORDER_ALREADY_CANONICAL'
          AND failed.error_message IS NOT NULL
          AND length(btrim(failed.error_message)) > 0
          AND failed.completed_at IS NOT NULL
          AND failed.completed_at >= failed.created_at
          AND failed.updated_at >= failed.completed_at
          AND failed.target_global_id
            ~ '^gcoc([0-9]{7}|[0-9a-v]{12})$'
          AND failed.result_global_id
            ~ '^gor([0-9]{7}|[0-9a-v]{12})$'
          AND EXISTS (
            SELECT 1
            FROM operations_commerce_order_candidates candidate
            LEFT JOIN operations_commerce_order_workbench workbench
              ON workbench.organization_id = candidate.organization_id
             AND workbench.integration_account_id =
                   candidate.integration_account_id
             AND workbench.candidate_id = candidate.id
            JOIN operations_orders canonical_order
              ON canonical_order.organization_id = candidate.organization_id
             AND canonical_order.id = COALESCE(
                   candidate.canonical_order_id,
                   workbench.canonical_order_id
                 )
            WHERE candidate.organization_id = failed.organization_id
              AND candidate.global_id = failed.target_global_id
              AND canonical_order.global_id = failed.result_global_id
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
