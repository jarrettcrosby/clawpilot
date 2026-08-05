BEGIN;

-- Follow-up to 0249 for the two audited development receipts whose PostgreSQL
-- timestamps retain microseconds that the application client rounded to
-- milliseconds during the original evidence read. Every immutable failed
-- receipt field and the exact later succeeded receipt must match. These UUIDs
-- are development-only, so production is intentionally a no-op.
WITH audited_failed_receipts (
  receipt_id,
  organization_id,
  idempotency_key,
  request_hash,
  actor_email,
  correlation_id,
  attempts,
  error_code,
  error_message,
  started_at,
  created_at,
  completed_at,
  updated_at,
  target_global_id,
  successor_receipt_id,
  successor_correlation_id,
  successor_attempts
) AS (
  VALUES
    (
      '684f5a84-0f47-4bca-ab2e-027f17ac4950'::uuid,
      '60832306-9876-4384-98e8-e179b427c3c1'::uuid,
      'operations-plan:gor3gqctppbqk2c:1a117b53-34c6-4b52-bbb9-376af5edb2b2',
      'e422f911970377b598ea7e743efb95d1ca5b63bf0181e07183a0da08ffe28274',
      'jarrett@suburbiasandwichco.com',
      '9efe8904-b38f-45de-8d3f-1ccc44fb1acb'::uuid,
      1,
      'OPERATIONS_ACTIVE_RATE_EVIDENCE_REQUIRES_PRODUCTION',
      'Active warehouse planning requires production carrier-read evidence. Use Shadow for sandbox carrier estimates.',
      '2026-08-03T11:11:31.100605Z'::timestamptz,
      '2026-08-03T11:11:31.100605Z'::timestamptz,
      '2026-08-03T11:11:31.110882Z'::timestamptz,
      '2026-08-03T11:11:31.110882Z'::timestamptz,
      'gor3gqctppbqk2c',
      '6e70478c-cd3b-4df5-9694-928f42e50d40'::uuid,
      '4463472c-ae48-44a8-b332-bb9a9f24e684'::uuid,
      1
    ),
    (
      '2e7e43aa-7381-4de3-9294-f663ea5f880d'::uuid,
      '60832306-9876-4384-98e8-e179b427c3c1'::uuid,
      'operations-plan:gor3gqctppbqk2c:8bc80086-093b-4232-87cc-7e94f5f2754d',
      'e422f911970377b598ea7e743efb95d1ca5b63bf0181e07183a0da08ffe28274',
      'jarrett@suburbiasandwichco.com',
      'db5e1731-a210-4f79-a3ec-50feacf8790b'::uuid,
      1,
      'OPERATIONS_CANONICAL_FULFILLMENT_RATE_PROMISE_UNAVAILABLE',
      'No whole-shipment UPS or FedEx service meets the requested delivery timestamp',
      '2026-08-03T11:13:13.178687Z'::timestamptz,
      '2026-08-03T11:13:13.178687Z'::timestamptz,
      '2026-08-03T11:13:13.209979Z'::timestamptz,
      '2026-08-03T11:13:13.209979Z'::timestamptz,
      'gor3gqctppbqk2c',
      '6e70478c-cd3b-4df5-9694-928f42e50d40'::uuid,
      '4463472c-ae48-44a8-b332-bb9a9f24e684'::uuid,
      1
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
  AND failed.correlation_id = audited.correlation_id
  AND failed.attempts = audited.attempts
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
    FROM operations_command_receipts successor
    WHERE successor.id = audited.successor_receipt_id
      AND successor.organization_id = audited.organization_id
      AND successor.command_type = 'plan_operations_order'
      AND successor.idempotency_key =
        'operations-plan:gor3gqctppbqk2c:88fea5a6-0f35-4b2e-b41e-7658196a2424'
      AND successor.request_hash =
        'dc0be151be1c427af4aa7240f8f6646e1fee04156ff306b3706693b2daabdabc'
      AND successor.actor_email = 'jarrett@suburbiasandwichco.com'
      AND successor.correlation_id = audited.successor_correlation_id
      AND successor.attempts = audited.successor_attempts
      AND successor.status = 'succeeded'
      AND successor.error_code IS NULL
      AND successor.error_message IS NULL
      AND successor.target_global_id = audited.target_global_id
      AND successor.result_global_id = audited.target_global_id
      AND successor.result_payload =
        '{"carrier":"FedEx","currency":"USD","replayed":false,"rowVersion":2,"orderStatus":"planned","serviceCode":"fedex_ground","serviceName":"FedEx Ground®","packageCount":1,"orderGlobalId":"gor3gqctppbqk2c","carrierCostMinor":2032,"checkoutVarianceMinor":null,"fulfillmentPlanGlobalId":"gfpji951ll2matg","checkoutShippingChargeMinor":null,"cartonizationEvidenceGlobalId":"gcteutldj608te53"}'::jsonb
      AND successor.started_at =
        '2026-08-03T11:15:47.260995Z'::timestamptz
      AND successor.created_at =
        '2026-08-03T11:15:47.260995Z'::timestamptz
      AND successor.completed_at =
        '2026-08-03T11:15:47.265098Z'::timestamptz
      AND successor.updated_at =
        '2026-08-03T11:15:47.265098Z'::timestamptz
      AND successor.created_at > failed.completed_at
      AND successor.completed_at > failed.completed_at
  )
  AND EXISTS (
    SELECT 1
    FROM operations_orders source_order
    WHERE source_order.organization_id = audited.organization_id
      AND source_order.global_id = audited.target_global_id
  );

COMMIT;
