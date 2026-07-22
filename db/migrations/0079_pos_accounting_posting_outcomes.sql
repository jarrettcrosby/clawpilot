ALTER TABLE quickbooks_write_requests
  DROP CONSTRAINT IF EXISTS quickbooks_write_requests_operation_kind_check;

ALTER TABLE quickbooks_write_requests
  ADD CONSTRAINT quickbooks_write_requests_operation_kind_check CHECK (
    operation_kind IN (
      'customer.create', 'item.create', 'invoice.create',
      'sales_receipt.create', 'journal_entry.create'
    )
  );

ALTER TABLE toast_accounting_export_drafts
  ADD COLUMN IF NOT EXISTS review_outcome text,
  ADD COLUMN IF NOT EXISTS posting_origin text,
  ADD COLUMN IF NOT EXISTS reviewed_by text REFERENCES app_users(email) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS review_note text,
  ADD COLUMN IF NOT EXISTS quickbooks_sales_receipt_id text,
  ADD COLUMN IF NOT EXISTS quickbooks_journal_entry_id text;

ALTER TABLE toast_accounting_export_drafts
  DROP CONSTRAINT IF EXISTS toast_accounting_export_drafts_review_outcome_check,
  DROP CONSTRAINT IF EXISTS toast_accounting_export_drafts_posting_origin_check,
  DROP CONSTRAINT IF EXISTS toast_accounting_export_drafts_review_evidence_check;

ALTER TABLE toast_accounting_export_drafts
  ADD CONSTRAINT toast_accounting_export_drafts_review_outcome_check CHECK (
    review_outcome IS NULL
    OR review_outcome IN ('shogo_posted', 'clawpilot_post', 'needs_correction', 'skipped')
  ),
  ADD CONSTRAINT toast_accounting_export_drafts_posting_origin_check CHECK (
    posting_origin IS NULL OR posting_origin IN ('shogo', 'clawpilot')
  ),
  ADD CONSTRAINT toast_accounting_export_drafts_review_evidence_check CHECK (
    review_outcome IS NULL
    OR (
      reviewed_at IS NOT NULL
      AND (
        (review_outcome = 'shogo_posted'
          AND posting_origin = 'shogo'
          AND quickbooks_sales_receipt_id IS NOT NULL
          AND quickbooks_journal_entry_id IS NOT NULL)
        OR (review_outcome = 'clawpilot_post' AND posting_origin = 'clawpilot')
        OR (review_outcome IN ('needs_correction', 'skipped') AND posting_origin IS NULL)
      )
    )
  );

CREATE TABLE IF NOT EXISTS pos_accounting_posting_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE CASCADE,
  draft_id uuid NOT NULL UNIQUE REFERENCES toast_accounting_export_drafts(id) ON DELETE CASCADE,
  restaurant_guid uuid NOT NULL,
  business_date date NOT NULL,
  status text NOT NULL DEFAULT 'pending_approval' CHECK (
    status IN ('pending_approval', 'approved', 'posting', 'posted', 'partial_failed', 'failed', 'cancelled')
  ),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  sales_receipt_request_id uuid NOT NULL UNIQUE REFERENCES quickbooks_write_requests(id) ON DELETE RESTRICT,
  journal_entry_request_id uuid NOT NULL UNIQUE REFERENCES quickbooks_write_requests(id) ON DELETE RESTRICT,
  requested_by text NOT NULL REFERENCES app_users(email) ON DELETE RESTRICT,
  approved_by text REFERENCES app_users(email) ON DELETE SET NULL,
  cancelled_by text REFERENCES app_users(email) ON DELETE SET NULL,
  approval_note text,
  last_error text,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  posted_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, restaurant_guid)
    REFERENCES toast_locations (organization_id, restaurant_guid) ON DELETE CASCADE
);

ALTER TABLE toast_accounting_export_drafts
  ADD COLUMN IF NOT EXISTS posting_batch_id uuid REFERENCES pos_accounting_posting_batches(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_pos_accounting_posting_batches_workspace
  ON pos_accounting_posting_batches (organization_id, business_date DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pos_accounting_posting_batches_status
  ON pos_accounting_posting_batches (organization_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_toast_accounting_export_drafts_review_outcome
  ON toast_accounting_export_drafts (organization_id, review_outcome, business_date DESC)
  WHERE is_current;

CREATE OR REPLACE FUNCTION clawpilot_preserve_protected_toast_export_evidence()
RETURNS trigger AS $$
BEGIN
  IF OLD.status IN ('approved', 'posting', 'posted', 'failed') THEN
    NEW.idempotency_key := OLD.idempotency_key;
    NEW.draft_revision := OLD.draft_revision;
    NEW.generation_reason := OLD.generation_reason;
    NEW.generated_by := OLD.generated_by;
    NEW.source_revision := OLD.source_revision;
    NEW.supersedes_draft_id := OLD.supersedes_draft_id;
    NEW.reconciliation_status := OLD.reconciliation_status;
    NEW.source_summary := OLD.source_summary;
    NEW.proposed_lines := OLD.proposed_lines;
    NEW.quickbooks_payload := OLD.quickbooks_payload;
    NEW.approved_by := OLD.approved_by;
    NEW.approved_at := OLD.approved_at;
    NEW.created_at := OLD.created_at;

    IF (to_jsonb(NEW) - ARRAY[
        'idempotency_key', 'draft_revision', 'generation_reason', 'generated_by',
        'source_revision', 'supersedes_draft_id', 'reconciliation_status',
        'source_summary', 'proposed_lines', 'quickbooks_payload', 'approved_by',
        'approved_at', 'created_at', 'updated_at'
      ]::text[])
      IS NOT DISTINCT FROM
      (to_jsonb(OLD) - ARRAY[
        'idempotency_key', 'draft_revision', 'generation_reason', 'generated_by',
        'source_revision', 'supersedes_draft_id', 'reconciliation_status',
        'source_summary', 'proposed_lines', 'quickbooks_payload', 'approved_by',
        'approved_at', 'created_at', 'updated_at'
      ]::text[])
    THEN
      NEW.updated_at := OLD.updated_at;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
