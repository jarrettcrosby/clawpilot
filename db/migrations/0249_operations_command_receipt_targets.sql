BEGIN;

-- Command receipts retain the server-resolved aggregate identity separately
-- from caller-controlled idempotency keys. The column stays nullable so legacy
-- and non-targeted command types fail closed instead of inventing authority.
ALTER TABLE operations_command_receipts
  ADD COLUMN IF NOT EXISTS target_global_id text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'operations_command_receipts'::regclass
      AND conname = 'operations_command_receipts_target_fkey'
  ) THEN
    ALTER TABLE operations_command_receipts
      ADD CONSTRAINT operations_command_receipts_target_fkey
      FOREIGN KEY (target_global_id)
      REFERENCES crm_reference_registry(reference_code)
      ON DELETE RESTRICT;
  END IF;
END
$$;

CREATE TEMP TABLE authoritative_plan_receipt_targets
ON COMMIT DROP
AS
  SELECT
    receipt.id AS receipt_id,
    receipt.organization_id,
    receipt.command_type,
    receipt.request_hash,
    receipt.result_global_id AS target_global_id,
    receipt.created_at,
    receipt.completed_at,
    receipt.updated_at
  FROM operations_command_receipts receipt
  WHERE receipt.command_type = 'plan_operations_order'
    AND receipt.status = 'succeeded'
    AND receipt.error_code IS NULL
    AND receipt.error_message IS NULL
    AND receipt.completed_at IS NOT NULL
    AND receipt.completed_at >= receipt.created_at
    AND receipt.updated_at >= receipt.completed_at
    AND receipt.request_hash ~ '^[a-f0-9]{64}$'
    AND receipt.result_global_id
      ~ '^gor([0-9]{7}|[0-9a-v]{12})$'
    AND (
      receipt.target_global_id IS NULL
      OR receipt.target_global_id = receipt.result_global_id
    )
    AND jsonb_typeof(receipt.result_payload) = 'object'
    AND receipt.result_payload->>'orderGlobalId' =
      receipt.result_global_id
    AND receipt.result_payload->>'orderStatus' = 'planned'
    AND jsonb_typeof(receipt.result_payload->'rowVersion') = 'number'
    AND receipt.result_payload->>'rowVersion'
      ~ '^(0|[1-9][0-9]{0,14})$'
    AND receipt.result_payload->>'fulfillmentPlanGlobalId'
      ~ '^gfp([0-9]{7}|[0-9a-v]{12})$'
    AND receipt.result_payload->>'cartonizationEvidenceGlobalId'
      ~ '^gcte([0-9]{7}|[0-9a-v]{12})$'
    AND jsonb_typeof(receipt.result_payload->'packageCount') = 'number'
    AND receipt.result_payload->>'packageCount' ~ '^[1-9][0-9]{0,8}$'
    AND receipt.result_payload->>'carrier' IN ('UPS', 'FedEx')
    AND jsonb_typeof(receipt.result_payload->'serviceCode') = 'string'
    AND length(btrim(receipt.result_payload->>'serviceCode')) > 0
    AND jsonb_typeof(receipt.result_payload->'serviceName') = 'string'
    AND length(btrim(receipt.result_payload->>'serviceName')) > 0
    AND jsonb_typeof(receipt.result_payload->'carrierCostMinor') = 'number'
    AND receipt.result_payload->>'carrierCostMinor'
      ~ '^(0|[1-9][0-9]{0,14})$'
    AND jsonb_typeof(receipt.result_payload->'currency') = 'string'
    AND receipt.result_payload->>'currency' ~ '^[A-Z]{3}$'
    AND receipt.result_payload ? 'checkoutShippingChargeMinor'
    AND (
      receipt.result_payload->'checkoutShippingChargeMinor' = 'null'::jsonb
      OR (
        jsonb_typeof(
          receipt.result_payload->'checkoutShippingChargeMinor'
        ) = 'number'
        AND receipt.result_payload->>'checkoutShippingChargeMinor'
          ~ '^(0|[1-9][0-9]{0,14})$'
      )
    )
    AND receipt.result_payload ? 'checkoutVarianceMinor'
    AND (
      receipt.result_payload->'checkoutVarianceMinor' = 'null'::jsonb
      OR (
        jsonb_typeof(
          receipt.result_payload->'checkoutVarianceMinor'
        ) = 'number'
        AND receipt.result_payload->>'checkoutVarianceMinor'
          ~ '^-?(0|[1-9][0-9]{0,14})$'
      )
    )
    AND receipt.result_payload->'replayed' = 'false'::jsonb
    AND EXISTS (
      SELECT 1
      FROM operations_orders source_order
      WHERE source_order.organization_id = receipt.organization_id
        AND source_order.global_id = receipt.result_global_id
    );

UPDATE operations_command_receipts receipt
SET target_global_id = authoritative.target_global_id
FROM authoritative_plan_receipt_targets authoritative
WHERE receipt.id = authoritative.receipt_id
  AND receipt.target_global_id IS NULL;

WITH authoritative_request_targets AS MATERIALIZED (
  SELECT
    authoritative.organization_id,
    authoritative.command_type,
    authoritative.request_hash,
    min(authoritative.target_global_id) AS target_global_id
  FROM authoritative_plan_receipt_targets authoritative
  JOIN operations_command_receipts succeeded
    ON succeeded.id = authoritative.receipt_id
   AND succeeded.target_global_id = authoritative.target_global_id
  GROUP BY
    authoritative.organization_id,
    authoritative.command_type,
    authoritative.request_hash
  HAVING count(DISTINCT authoritative.target_global_id) = 1
)
UPDATE operations_command_receipts receipt
SET target_global_id = authoritative.target_global_id
FROM authoritative_request_targets authoritative
WHERE receipt.organization_id = authoritative.organization_id
  AND receipt.command_type = authoritative.command_type
  AND receipt.request_hash = authoritative.request_hash
  AND receipt.status IN ('processing', 'failed')
  AND receipt.result_global_id IS NULL
  AND receipt.result_payload IS NULL
  AND receipt.target_global_id IS NULL;

-- Narrowly audited development receipt adjudication. Every immutable receipt
-- field and the exact later authoritative success must match. These UUIDs are
-- development-only, so production is intentionally a no-op.
WITH audited_failed_receipts (
  receipt_id,
  organization_id,
  idempotency_key,
  request_hash,
  actor_email,
  error_code,
  error_message,
  started_at,
  created_at,
  completed_at,
  updated_at,
  target_global_id,
  successor_receipt_id
) AS (
  VALUES
    (
      '684f5a84-0f47-4bca-ab2e-027f17ac4950'::uuid,
      '60832306-9876-4384-98e8-e179b427c3c1'::uuid,
      'operations-plan:gor3gqctppbqk2c:1a117b53-34c6-4b52-bbb9-376af5edb2b2',
      'e422f911970377b598ea7e743efb95d1ca5b63bf0181e07183a0da08ffe28274',
      'jarrett@suburbiasandwichco.com',
      'OPERATIONS_ACTIVE_RATE_EVIDENCE_REQUIRES_PRODUCTION',
      'Active warehouse planning requires production carrier-read evidence. Use Shadow for sandbox carrier estimates.',
      '2026-08-03T11:11:31.100Z'::timestamptz,
      '2026-08-03T11:11:31.100Z'::timestamptz,
      '2026-08-03T11:11:31.110Z'::timestamptz,
      '2026-08-03T11:11:31.110Z'::timestamptz,
      'gor3gqctppbqk2c',
      '6e70478c-cd3b-4df5-9694-928f42e50d40'::uuid
    ),
    (
      '2e7e43aa-7381-4de3-9294-f663ea5f880d'::uuid,
      '60832306-9876-4384-98e8-e179b427c3c1'::uuid,
      'operations-plan:gor3gqctppbqk2c:8bc80086-093b-4232-87cc-7e94f5f2754d',
      'e422f911970377b598ea7e743efb95d1ca5b63bf0181e07183a0da08ffe28274',
      'jarrett@suburbiasandwichco.com',
      'OPERATIONS_CANONICAL_FULFILLMENT_RATE_PROMISE_UNAVAILABLE',
      'No whole-shipment UPS or FedEx service meets the requested delivery timestamp',
      '2026-08-03T11:13:13.178Z'::timestamptz,
      '2026-08-03T11:13:13.178Z'::timestamptz,
      '2026-08-03T11:13:13.209Z'::timestamptz,
      '2026-08-03T11:13:13.209Z'::timestamptz,
      'gor3gqctppbqk2c',
      '6e70478c-cd3b-4df5-9694-928f42e50d40'::uuid
    )
)
UPDATE operations_command_receipts failed
SET target_global_id = audited.target_global_id
FROM audited_failed_receipts audited
WHERE failed.id = audited.receipt_id
  AND failed.organization_id = audited.organization_id
  AND failed.command_type = 'plan_operations_order'
  AND failed.idempotency_key = audited.idempotency_key
  AND failed.request_hash = audited.request_hash
  AND failed.actor_email = audited.actor_email
  AND failed.status = 'failed'
  AND failed.result_global_id IS NULL
  AND failed.result_payload IS NULL
  AND failed.error_code = audited.error_code
  AND failed.error_message = audited.error_message
  AND failed.started_at = audited.started_at
  AND failed.created_at = audited.created_at
  AND failed.completed_at = audited.completed_at
  AND failed.updated_at = audited.updated_at
  AND failed.target_global_id IS NULL
  AND EXISTS (
    SELECT 1
    FROM authoritative_plan_receipt_targets authoritative
    JOIN operations_command_receipts successor
      ON successor.id = authoritative.receipt_id
     AND successor.target_global_id = authoritative.target_global_id
    WHERE authoritative.receipt_id = audited.successor_receipt_id
      AND authoritative.organization_id = audited.organization_id
      AND authoritative.target_global_id = audited.target_global_id
      AND successor.created_at > failed.completed_at
      AND successor.completed_at > failed.completed_at
  )
  AND EXISTS (
    SELECT 1
    FROM operations_orders source_order
    WHERE source_order.organization_id = audited.organization_id
      AND source_order.global_id = audited.target_global_id
  );

CREATE INDEX IF NOT EXISTS idx_operations_command_receipts_target_health
  ON operations_command_receipts (
    organization_id,
    command_type,
    target_global_id,
    status,
    created_at,
    completed_at
  );

COMMIT;
