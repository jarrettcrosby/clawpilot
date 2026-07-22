ALTER TABLE toast_accounting_export_drafts
  ADD COLUMN IF NOT EXISTS external_posting_provider text,
  ADD COLUMN IF NOT EXISTS external_posting_reference text;

UPDATE toast_accounting_export_drafts
SET external_posting_provider = 'Shogo'
WHERE review_outcome = 'shogo_posted'
  AND external_posting_provider IS NULL;

ALTER TABLE toast_accounting_export_drafts
  DROP CONSTRAINT IF EXISTS toast_accounting_export_drafts_review_outcome_check,
  DROP CONSTRAINT IF EXISTS toast_accounting_export_drafts_posting_origin_check,
  DROP CONSTRAINT IF EXISTS toast_accounting_export_drafts_review_evidence_check,
  DROP CONSTRAINT IF EXISTS toast_accounting_export_drafts_external_provider_check,
  DROP CONSTRAINT IF EXISTS toast_accounting_export_drafts_external_reference_check;

ALTER TABLE toast_accounting_export_drafts
  ADD CONSTRAINT toast_accounting_export_drafts_review_outcome_check CHECK (
    review_outcome IS NULL
    OR review_outcome IN (
      'shogo_posted', 'externally_posted', 'clawpilot_post',
      'needs_correction', 'skipped'
    )
  ),
  ADD CONSTRAINT toast_accounting_export_drafts_posting_origin_check CHECK (
    posting_origin IS NULL OR posting_origin IN ('shogo', 'external', 'clawpilot')
  ),
  ADD CONSTRAINT toast_accounting_export_drafts_external_provider_check CHECK (
    external_posting_provider IS NULL
    OR (
      external_posting_provider = btrim(external_posting_provider)
      AND char_length(external_posting_provider) BETWEEN 1 AND 120
      AND external_posting_provider !~ '[[:cntrl:]]'
    )
  ),
  ADD CONSTRAINT toast_accounting_export_drafts_external_reference_check CHECK (
    external_posting_reference IS NULL
    OR (
      external_posting_reference = btrim(external_posting_reference)
      AND char_length(external_posting_reference) BETWEEN 1 AND 200
      AND external_posting_reference !~ '[[:cntrl:]]'
    )
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
        OR (review_outcome = 'externally_posted'
          AND posting_origin = 'external'
          AND external_posting_provider IS NOT NULL
          AND quickbooks_sales_receipt_id IS NOT NULL
          AND quickbooks_journal_entry_id IS NOT NULL)
        OR (review_outcome = 'clawpilot_post' AND posting_origin = 'clawpilot')
        OR (review_outcome IN ('needs_correction', 'skipped') AND posting_origin IS NULL)
      )
    )
  );
