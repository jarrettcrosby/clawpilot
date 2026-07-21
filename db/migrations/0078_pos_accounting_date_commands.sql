ALTER TABLE toast_accounting_export_drafts
  ADD COLUMN IF NOT EXISTS draft_revision integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS generation_reason text NOT NULL DEFAULT 'automatic_sync',
  ADD COLUMN IF NOT EXISTS generated_by text,
  ADD COLUMN IF NOT EXISTS source_revision integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS supersedes_draft_id uuid,
  ADD COLUMN IF NOT EXISTS is_current boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS superseded_at timestamptz;

DO $$
DECLARE
  date_scope_constraint text;
BEGIN
  SELECT constraint_row.conname
  INTO date_scope_constraint
  FROM pg_constraint constraint_row
  WHERE constraint_row.conrelid = 'toast_accounting_export_drafts'::regclass
    AND constraint_row.contype = 'u'
    AND (
      SELECT array_agg(attribute_row.attname::text ORDER BY key_column.ordinality)
      FROM unnest(constraint_row.conkey) WITH ORDINALITY AS key_column(attnum, ordinality)
      JOIN pg_attribute attribute_row
        ON attribute_row.attrelid = constraint_row.conrelid
       AND attribute_row.attnum = key_column.attnum
    ) = ARRAY['organization_id', 'restaurant_guid', 'business_date']::text[]
  LIMIT 1;

  IF date_scope_constraint IS NOT NULL THEN
    EXECUTE format(
      'ALTER TABLE toast_accounting_export_drafts DROP CONSTRAINT %I',
      date_scope_constraint
    );
  END IF;
END
$$;

ALTER TABLE toast_accounting_export_drafts
  DROP CONSTRAINT IF EXISTS toast_accounting_export_drafts_generation_reason_check,
  DROP CONSTRAINT IF EXISTS toast_accounting_export_drafts_revision_positive_check,
  DROP CONSTRAINT IF EXISTS toast_accounting_export_drafts_current_state_check,
  DROP CONSTRAINT IF EXISTS toast_accounting_export_drafts_supersedes_draft_id_fkey;

ALTER TABLE toast_accounting_export_drafts
  ADD CONSTRAINT toast_accounting_export_drafts_generation_reason_check CHECK (
    generation_reason IN ('automatic_sync', 'reload_sales', 'regenerate_accounting')
  ),
  ADD CONSTRAINT toast_accounting_export_drafts_revision_positive_check CHECK (draft_revision > 0),
  ADD CONSTRAINT toast_accounting_export_drafts_current_state_check CHECK (
    (is_current AND superseded_at IS NULL)
    OR (NOT is_current AND superseded_at IS NOT NULL)
  ),
  ADD CONSTRAINT toast_accounting_export_drafts_supersedes_draft_id_fkey
    FOREIGN KEY (supersedes_draft_id)
    REFERENCES toast_accounting_export_drafts(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_toast_accounting_draft_revision
  ON toast_accounting_export_drafts (
    organization_id, restaurant_guid, business_date, draft_revision
  );

CREATE UNIQUE INDEX IF NOT EXISTS uq_toast_accounting_current_draft
  ON toast_accounting_export_drafts (organization_id, restaurant_guid, business_date)
  WHERE is_current;

CREATE INDEX IF NOT EXISTS idx_toast_accounting_draft_history
  ON toast_accounting_export_drafts (
    organization_id, restaurant_guid, business_date DESC, draft_revision DESC
  );

CREATE TABLE IF NOT EXISTS pos_accounting_commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE CASCADE,
  restaurant_guid uuid NOT NULL,
  business_date date NOT NULL,
  command_type text NOT NULL CHECK (
    command_type IN ('reload_sales', 'regenerate_accounting')
  ),
  status text NOT NULL DEFAULT 'queued' CHECK (
    status IN ('queued', 'running', 'succeeded', 'failed')
  ),
  requested_by text NOT NULL,
  expected_sync_kinds text[] NOT NULL DEFAULT '{}'::text[],
  result_draft_id uuid REFERENCES toast_accounting_export_drafts(id) ON DELETE SET NULL,
  result_draft_revision integer,
  last_error text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, restaurant_guid)
    REFERENCES toast_locations (organization_id, restaurant_guid) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_pos_accounting_active_command
  ON pos_accounting_commands (organization_id, restaurant_guid, business_date)
  WHERE status IN ('queued', 'running');

CREATE INDEX IF NOT EXISTS idx_pos_accounting_commands_latest
  ON pos_accounting_commands (
    organization_id, restaurant_guid, business_date, created_at DESC
  );

CREATE OR REPLACE FUNCTION clawpilot_preserve_protected_toast_export_evidence()
RETURNS trigger AS $$
BEGIN
  IF OLD.status IN ('approved', 'posting', 'posted') THEN
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
