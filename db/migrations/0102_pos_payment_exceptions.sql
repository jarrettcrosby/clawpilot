-- Preserve Toast order lifecycle timing so accounting can separate payment
-- activity from the later fulfillment business date.

ALTER TABLE toast_pos_orders
  ADD COLUMN IF NOT EXISTS created_at_source timestamptz,
  ADD COLUMN IF NOT EXISTS modified_at_source timestamptz,
  ADD COLUMN IF NOT EXISTS promised_at timestamptz,
  ADD COLUMN IF NOT EXISTS estimated_fulfillment_at timestamptz,
  ADD COLUMN IF NOT EXISTS payment_business_dates date[] NOT NULL DEFAULT '{}'::date[],
  ADD COLUMN IF NOT EXISTS fulfillment_business_date date;

UPDATE toast_pos_orders
SET fulfillment_business_date = business_date
WHERE fulfillment_business_date IS NULL;

-- Keep this column nullable during the expand phase. The previously deployed
-- worker does not write it, and Vercel can apply migrations before Railway
-- switches the worker process. New code always writes a value and falls back
-- to business_date when reading a legacy/null row.

-- Completing ingestion releases its processing lease so the accounting reload
-- can observe every source job as complete. Keep a second, durable lease across
-- that post-processing window: accounting failures remain retryable, while an
-- older worker cannot overwrite a newer claim.
ALTER TABLE toast_sync_outbox
  ADD COLUMN IF NOT EXISTS postprocess_token uuid,
  ADD COLUMN IF NOT EXISTS postprocess_started_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_toast_pos_orders_fulfillment_business_date
  ON toast_pos_orders (
    organization_id, restaurant_guid, fulfillment_business_date DESC
  );

-- Payment Exceptions is one stable accounting source, not one mapping per
-- preorder. It uses the same immutable catalog-mapping revision model as the
-- other account-backed POS sources.
ALTER TABLE pos_accounting_catalog_mappings
  DROP CONSTRAINT IF EXISTS pos_accounting_catalog_mappings_source_kind_check,
  DROP CONSTRAINT IF EXISTS pos_accounting_mapping_target_compatible;

ALTER TABLE pos_accounting_catalog_mappings
  ADD CONSTRAINT pos_accounting_catalog_mappings_source_kind_check CHECK (
    source_kind IN (
      'sales_item', 'sales_category', 'discount', 'tax', 'service_charge', 'tender',
      'cash_drawer', 'card_brand', 'payout', 'fee', 'over_short', 'payment_exception',
      'revenue_center', 'day_part', 'dining_option', 'order_source', 'payment_type', 'tax_treatment'
    )
  ),
  ADD CONSTRAINT pos_accounting_mapping_target_compatible CHECK (
    (source_kind IN ('sales_item', 'sales_category', 'discount') AND target_type = 'item')
    OR (source_kind = 'tax' AND target_type = 'tax_code')
    OR (source_kind IN (
      'service_charge', 'tender', 'cash_drawer', 'card_brand', 'payout', 'fee',
      'over_short', 'payment_exception'
    ) AND target_type = 'account')
    OR (source_kind IN (
      'revenue_center', 'day_part', 'dining_option', 'order_source', 'payment_type', 'tax_treatment'
    ) AND target_type IN ('class', 'department', 'location', 'customer', 'vendor'))
  );

-- A payment-date-only exception produces a Journal Entry but must not create a
-- zero-dollar Sales Receipt. Existing two-document batches remain unchanged.
ALTER TABLE pos_accounting_posting_batches
  ALTER COLUMN sales_receipt_request_id DROP NOT NULL;

-- External systems such as Shogo may have already posted the journal-only
-- payment-date half. Accept that exact matched evidence without inventing a
-- Sales Receipt, while sales-bearing dates still require both documents.
ALTER TABLE toast_accounting_export_drafts
  DROP CONSTRAINT IF EXISTS toast_accounting_export_drafts_review_evidence_check;

ALTER TABLE toast_accounting_export_drafts
  ADD CONSTRAINT toast_accounting_export_drafts_review_evidence_check CHECK (
    review_outcome IS NULL
    OR (
      reviewed_at IS NOT NULL
      AND (
        (review_outcome IN ('shogo_posted', 'externally_posted')
          AND (
            (review_outcome = 'shogo_posted' AND posting_origin = 'shogo')
            OR (
              review_outcome = 'externally_posted'
              AND posting_origin = 'external'
              AND external_posting_provider IS NOT NULL
            )
          )
          AND quickbooks_journal_entry_id IS NOT NULL
          AND (
            quickbooks_sales_receipt_id IS NOT NULL
            OR (
              jsonb_path_exists(
                proposed_lines,
                '$[*] ? (@.document == "payments_journal" && @.sourceKind == "payment_exception" && @.code == "payment_exception_capture")'
              )
              AND NOT jsonb_path_exists(
                proposed_lines,
                '$[*] ? (@.document == "sales_receipt")'
              )
            )
          ))
        OR (review_outcome = 'clawpilot_post' AND posting_origin = 'clawpilot')
        OR (review_outcome IN ('needs_correction', 'skipped') AND posting_origin IS NULL)
      )
    )
  );

-- Existing projected orders predate the lifecycle fields above. Stage a
-- bounded modified-order replay for every active, selected location with
-- Standard API access. It discovers future preorders created or changed
-- during the lookback without duplicating fulfillment-date jobs. The rows
-- remain unavailable until the updated Railway runtime passes health and
-- activates them, so the previous worker cannot consume the new backfill.
INSERT INTO toast_sync_outbox AS job (
  organization_id,
  restaurant_guid,
  sync_kind,
  business_date,
  status,
  attempt_count,
  available_at,
  request_state,
  result_summary,
  created_at,
  updated_at
)
SELECT
  location.organization_id,
  location.restaurant_guid,
  'standard_order_updates',
  (
    (now() AT TIME ZONE COALESCE(zone.name, 'UTC'))::date
    - recent.day_offset
  )::date,
  'pending',
  0,
  'infinity'::timestamptz,
  '{"backfill":"pos_payment_exceptions_v1","staged":true}'::jsonb,
  '{}'::jsonb,
  now(),
  now()
FROM toast_locations location
JOIN organization_toast_credentials credential
  ON credential.organization_id = location.organization_id
 AND credential.access_type = 'standard'
 AND credential.sync_enabled = true
LEFT JOIN pg_timezone_names zone
  ON zone.name = NULLIF(location.timezone, '')
CROSS JOIN generate_series(0, 30) AS recent(day_offset)
WHERE location.selected = true
  AND location.active = true
  AND location.archived = false
  AND location.standard_access = true
ON CONFLICT (organization_id, restaurant_guid, sync_kind, business_date)
DO UPDATE SET
  rerun_requested_at = CASE
    WHEN job.status = 'processing' THEN now()
    ELSE NULL
  END,
  status = CASE
    WHEN job.status = 'processing' THEN job.status
    ELSE 'pending'
  END,
  attempt_count = CASE
    WHEN job.status = 'processing' OR job.postprocess_token IS NOT NULL THEN job.attempt_count
    ELSE 0
  END,
  available_at = CASE
    WHEN job.status = 'processing' THEN job.available_at
    ELSE EXCLUDED.available_at
  END,
  request_state = CASE
    WHEN job.status = 'processing' OR job.postprocess_token IS NOT NULL THEN job.request_state
    ELSE EXCLUDED.request_state
  END,
  result_summary = CASE
    WHEN job.status = 'processing' OR job.postprocess_token IS NOT NULL THEN job.result_summary
    ELSE '{}'::jsonb
  END,
  last_error = CASE
    WHEN job.status = 'processing' THEN job.last_error
    ELSE NULL
  END,
  locked_at = CASE
    WHEN job.status = 'processing' THEN job.locked_at
    ELSE NULL
  END,
  locked_by = CASE
    WHEN job.status = 'processing' THEN job.locked_by
    ELSE NULL
  END,
  lock_token = CASE
    WHEN job.status = 'processing' THEN job.lock_token
    ELSE NULL
  END,
  postprocess_token = CASE
    WHEN job.postprocess_token IS NOT NULL THEN job.postprocess_token
    ELSE NULL
  END,
  postprocess_started_at = CASE
    WHEN job.postprocess_token IS NOT NULL THEN job.postprocess_started_at
    ELSE NULL
  END,
  completed_at = CASE
    WHEN job.status = 'processing' THEN job.completed_at
    ELSE NULL
  END,
  updated_at = now();
