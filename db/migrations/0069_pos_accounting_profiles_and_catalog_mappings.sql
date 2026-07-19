CREATE TABLE IF NOT EXISTS pos_accounting_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE CASCADE,
  restaurant_guid uuid,
  profile_revision integer NOT NULL CHECK (profile_revision > 0),
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz,
  quickbooks_binding_status text NOT NULL DEFAULT 'unbound' CHECK (
    quickbooks_binding_status IN ('unbound', 'verified')
  ),
  quickbooks_connection_fingerprint text,
  quickbooks_company_name text,
  quickbooks_connection_verified_at timestamptz,
  quickbooks_catalog_synced_at timestamptz,
  posting_method text NOT NULL DEFAULT 'itemized_sales_receipt' CHECK (
    posting_method IN ('itemized_sales_receipt', 'summary_sales_receipt', 'journal_entry')
  ),
  quickbooks_class_id text,
  quickbooks_class_name text,
  quickbooks_department_id text,
  quickbooks_department_name text,
  quickbooks_customer_id text,
  quickbooks_customer_name text,
  quickbooks_clearing_account_id text,
  quickbooks_clearing_account_name text,
  track_sales_tax boolean NOT NULL DEFAULT true,
  breakout_dimensions text[] NOT NULL DEFAULT '{}'::text[] CHECK (
    breakout_dimensions <@ ARRAY[
      'revenue_center', 'day_part', 'dining_option', 'order_source', 'payment_type', 'tax_treatment'
    ]::text[]
    AND cardinality(breakout_dimensions) <= 6
  ),
  memo_mode text NOT NULL DEFAULT 'pos_date' CHECK (
    memo_mode IN ('pos_date', 'store_date', 'location', 'custom')
  ),
  custom_memo text,
  custom_transaction_number boolean NOT NULL DEFAULT false,
  transaction_number_suffix text,
  suppress_zero_over_short boolean NOT NULL DEFAULT false,
  auto_payout_tips boolean NOT NULL DEFAULT false,
  deposit_checks_with_cash boolean NOT NULL DEFAULT false,
  open_check_policy text NOT NULL DEFAULT 'hold' CHECK (
    open_check_policy IN ('hold', 'exclude', 'include')
  ),
  batch_hold_policy text NOT NULL DEFAULT 'hold_until_closed' CHECK (
    batch_hold_policy IN ('hold_until_closed', 'hold_until_settled', 'do_not_hold')
  ),
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, restaurant_guid)
    REFERENCES toast_locations (organization_id, restaurant_guid) ON DELETE CASCADE,
  CONSTRAINT pos_accounting_profile_effective_window CHECK (
    effective_to IS NULL OR effective_to > effective_from
  ),
  CONSTRAINT pos_accounting_profile_binding_evidence CHECK (
    (quickbooks_binding_status = 'unbound'
      AND quickbooks_connection_fingerprint IS NULL
      AND quickbooks_company_name IS NULL
      AND quickbooks_connection_verified_at IS NULL)
    OR (quickbooks_binding_status = 'verified'
      AND quickbooks_connection_fingerprint ~ '^[0-9a-f]{64}$'
      AND quickbooks_company_name IS NOT NULL
      AND quickbooks_connection_verified_at IS NOT NULL)
  ),
  CONSTRAINT pos_accounting_profile_class_pair CHECK (
    (quickbooks_class_id IS NULL) = (quickbooks_class_name IS NULL)
  ),
  CONSTRAINT pos_accounting_profile_department_pair CHECK (
    (quickbooks_department_id IS NULL) = (quickbooks_department_name IS NULL)
  ),
  CONSTRAINT pos_accounting_profile_customer_pair CHECK (
    (quickbooks_customer_id IS NULL) = (quickbooks_customer_name IS NULL)
  ),
  CONSTRAINT pos_accounting_profile_clearing_pair CHECK (
    (quickbooks_clearing_account_id IS NULL) = (quickbooks_clearing_account_name IS NULL)
  ),
  CONSTRAINT pos_accounting_profile_ids_valid CHECK (
    (quickbooks_class_id IS NULL OR (
      quickbooks_class_id = btrim(quickbooks_class_id)
      AND char_length(quickbooks_class_id) BETWEEN 1 AND 200
      AND quickbooks_class_id ~ '^[!-~]+$'
    ))
    AND (quickbooks_department_id IS NULL OR (
      quickbooks_department_id = btrim(quickbooks_department_id)
      AND char_length(quickbooks_department_id) BETWEEN 1 AND 200
      AND quickbooks_department_id ~ '^[!-~]+$'
    ))
    AND (quickbooks_customer_id IS NULL OR (
      quickbooks_customer_id = btrim(quickbooks_customer_id)
      AND char_length(quickbooks_customer_id) BETWEEN 1 AND 200
      AND quickbooks_customer_id ~ '^[!-~]+$'
    ))
    AND (quickbooks_clearing_account_id IS NULL OR (
      quickbooks_clearing_account_id = btrim(quickbooks_clearing_account_id)
      AND char_length(quickbooks_clearing_account_id) BETWEEN 1 AND 200
      AND quickbooks_clearing_account_id ~ '^[!-~]+$'
    ))
  ),
  CONSTRAINT pos_accounting_profile_names_valid CHECK (
    (quickbooks_company_name IS NULL OR (
      quickbooks_company_name = btrim(quickbooks_company_name)
      AND char_length(quickbooks_company_name) BETWEEN 1 AND 240
      AND quickbooks_company_name !~ '[[:cntrl:]]'
    ))
    AND (quickbooks_class_name IS NULL OR (
      quickbooks_class_name = btrim(quickbooks_class_name)
      AND char_length(quickbooks_class_name) BETWEEN 1 AND 240
      AND quickbooks_class_name !~ '[[:cntrl:]]'
    ))
    AND (quickbooks_department_name IS NULL OR (
      quickbooks_department_name = btrim(quickbooks_department_name)
      AND char_length(quickbooks_department_name) BETWEEN 1 AND 240
      AND quickbooks_department_name !~ '[[:cntrl:]]'
    ))
    AND (quickbooks_customer_name IS NULL OR (
      quickbooks_customer_name = btrim(quickbooks_customer_name)
      AND char_length(quickbooks_customer_name) BETWEEN 1 AND 240
      AND quickbooks_customer_name !~ '[[:cntrl:]]'
    ))
    AND (quickbooks_clearing_account_name IS NULL OR (
      quickbooks_clearing_account_name = btrim(quickbooks_clearing_account_name)
      AND char_length(quickbooks_clearing_account_name) BETWEEN 1 AND 240
      AND quickbooks_clearing_account_name !~ '[[:cntrl:]]'
    ))
  ),
  CONSTRAINT pos_accounting_profile_memo_valid CHECK (
    (memo_mode = 'custom' AND custom_memo IS NOT NULL
      AND custom_memo = btrim(custom_memo)
      AND char_length(custom_memo) BETWEEN 1 AND 500
      AND custom_memo !~ '[[:cntrl:]]')
    OR (memo_mode <> 'custom' AND custom_memo IS NULL)
  ),
  CONSTRAINT pos_accounting_profile_suffix_valid CHECK (
    (custom_transaction_number = true AND transaction_number_suffix IS NOT NULL
      AND transaction_number_suffix = btrim(transaction_number_suffix)
      AND char_length(transaction_number_suffix) BETWEEN 1 AND 32
      AND transaction_number_suffix ~ '^[A-Za-z0-9._-]+$')
    OR (custom_transaction_number = false AND transaction_number_suffix IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pos_accounting_profile_default_revision
  ON pos_accounting_profiles (organization_id, profile_revision)
  WHERE restaurant_guid IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_pos_accounting_profile_location_revision
  ON pos_accounting_profiles (organization_id, restaurant_guid, profile_revision)
  WHERE restaurant_guid IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_pos_accounting_profile_default_current
  ON pos_accounting_profiles (organization_id)
  WHERE restaurant_guid IS NULL AND effective_to IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_pos_accounting_profile_location_current
  ON pos_accounting_profiles (organization_id, restaurant_guid)
  WHERE restaurant_guid IS NOT NULL AND effective_to IS NULL;

CREATE TABLE IF NOT EXISTS pos_accounting_catalog_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE CASCADE,
  restaurant_guid uuid,
  source_kind text NOT NULL CHECK (
    source_kind IN (
      'sales_item', 'sales_category', 'discount', 'tax', 'service_charge', 'tender',
      'cash_drawer', 'card_brand', 'payout', 'fee', 'over_short',
      'revenue_center', 'day_part', 'dining_option', 'order_source', 'payment_type', 'tax_treatment'
    )
  ),
  source_id text NOT NULL,
  source_name text NOT NULL,
  target_type text NOT NULL CHECK (
    target_type IN ('item', 'account', 'tax_code', 'class', 'department', 'location', 'customer', 'vendor')
  ),
  target_id text NOT NULL,
  target_name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  mapping_revision integer NOT NULL CHECK (mapping_revision > 0),
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz,
  validation_status text NOT NULL DEFAULT 'unvalidated' CHECK (
    validation_status IN ('unvalidated', 'valid', 'invalid', 'stale', 'missing_source', 'missing_target')
  ),
  validation_reason text,
  source_catalog_revision bigint NOT NULL DEFAULT 0 CHECK (source_catalog_revision >= 0),
  target_catalog_revision bigint NOT NULL DEFAULT 0 CHECK (target_catalog_revision >= 0),
  last_validated_at timestamptz,
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, restaurant_guid)
    REFERENCES toast_locations (organization_id, restaurant_guid) ON DELETE CASCADE,
  CONSTRAINT pos_accounting_mapping_effective_window CHECK (
    effective_to IS NULL OR effective_to > effective_from
  ),
  CONSTRAINT pos_accounting_mapping_source_id_valid CHECK (
    source_id = btrim(source_id)
    AND char_length(source_id) BETWEEN 1 AND 200
    AND source_id ~ '^[!-~]+$'
  ),
  CONSTRAINT pos_accounting_mapping_source_name_valid CHECK (
    source_name = btrim(source_name)
    AND char_length(source_name) BETWEEN 1 AND 240
    AND source_name !~ '[[:cntrl:]]'
  ),
  CONSTRAINT pos_accounting_mapping_target_id_valid CHECK (
    target_id = btrim(target_id)
    AND char_length(target_id) BETWEEN 1 AND 200
    AND target_id ~ '^[!-~]+$'
  ),
  CONSTRAINT pos_accounting_mapping_target_name_valid CHECK (
    target_name = btrim(target_name)
    AND char_length(target_name) BETWEEN 1 AND 240
    AND target_name !~ '[[:cntrl:]]'
  ),
  CONSTRAINT pos_accounting_mapping_validation_reason_valid CHECK (
    validation_reason IS NULL OR (
      validation_reason = btrim(validation_reason)
      AND char_length(validation_reason) BETWEEN 1 AND 500
      AND validation_reason !~ '[[:cntrl:]]'
    )
  ),
  CONSTRAINT pos_accounting_mapping_target_compatible CHECK (
    (source_kind IN ('sales_item', 'sales_category', 'discount') AND target_type = 'item')
    OR (source_kind = 'tax' AND target_type = 'tax_code')
    OR (source_kind IN (
      'service_charge', 'tender', 'cash_drawer', 'card_brand', 'payout', 'fee', 'over_short'
    ) AND target_type = 'account')
    OR (source_kind IN (
      'revenue_center', 'day_part', 'dining_option', 'order_source', 'payment_type', 'tax_treatment'
    ) AND target_type IN ('class', 'department', 'location', 'customer', 'vendor'))
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pos_accounting_mapping_default_revision
  ON pos_accounting_catalog_mappings (
    organization_id, source_kind, source_id, target_type, mapping_revision
  ) WHERE restaurant_guid IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_pos_accounting_mapping_location_revision
  ON pos_accounting_catalog_mappings (
    organization_id, restaurant_guid, source_kind, source_id, target_type, mapping_revision
  ) WHERE restaurant_guid IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_pos_accounting_mapping_default_current
  ON pos_accounting_catalog_mappings (organization_id, source_kind, source_id)
  WHERE restaurant_guid IS NULL AND effective_to IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_pos_accounting_mapping_location_current
  ON pos_accounting_catalog_mappings (
    organization_id, restaurant_guid, source_kind, source_id
  ) WHERE restaurant_guid IS NOT NULL AND effective_to IS NULL;

CREATE INDEX IF NOT EXISTS idx_pos_accounting_mappings_validation
  ON pos_accounting_catalog_mappings (
    organization_id, restaurant_guid, validation_status, source_kind
  ) WHERE effective_to IS NULL;

CREATE OR REPLACE FUNCTION clawpilot_close_immutable_pos_accounting_revision()
RETURNS trigger AS $$
BEGIN
  IF OLD.effective_to IS NOT NULL
    OR NEW.effective_to IS NULL
    OR NEW.effective_to <= OLD.effective_from
    OR (to_jsonb(NEW) - 'effective_to') IS DISTINCT FROM (to_jsonb(OLD) - 'effective_to')
  THEN
    RAISE EXCEPTION 'POS accounting revisions are immutable; only an open revision may be closed';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_close_pos_accounting_profile_revision ON pos_accounting_profiles;
CREATE TRIGGER trg_close_pos_accounting_profile_revision
BEFORE UPDATE ON pos_accounting_profiles
FOR EACH ROW EXECUTE FUNCTION clawpilot_close_immutable_pos_accounting_revision();

DROP TRIGGER IF EXISTS trg_close_pos_accounting_mapping_revision ON pos_accounting_catalog_mappings;
CREATE TRIGGER trg_close_pos_accounting_mapping_revision
BEFORE UPDATE ON pos_accounting_catalog_mappings
FOR EACH ROW EXECUTE FUNCTION clawpilot_close_immutable_pos_accounting_revision();

CREATE OR REPLACE FUNCTION clawpilot_preserve_protected_toast_export_evidence()
RETURNS trigger AS $$
BEGIN
  IF OLD.status IN ('approved', 'posting', 'posted') THEN
    NEW.idempotency_key := OLD.idempotency_key;
    NEW.reconciliation_status := OLD.reconciliation_status;
    NEW.source_summary := OLD.source_summary;
    NEW.proposed_lines := OLD.proposed_lines;
    NEW.quickbooks_payload := OLD.quickbooks_payload;
    NEW.approved_by := OLD.approved_by;
    NEW.approved_at := OLD.approved_at;

    IF (to_jsonb(NEW) - ARRAY[
        'idempotency_key', 'reconciliation_status', 'source_summary', 'proposed_lines',
        'quickbooks_payload', 'approved_by', 'approved_at', 'updated_at'
      ]::text[])
      IS NOT DISTINCT FROM
      (to_jsonb(OLD) - ARRAY[
        'idempotency_key', 'reconciliation_status', 'source_summary', 'proposed_lines',
        'quickbooks_payload', 'approved_by', 'approved_at', 'updated_at'
      ]::text[])
    THEN
      NEW.updated_at := OLD.updated_at;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_preserve_protected_toast_export_evidence ON toast_accounting_export_drafts;
CREATE TRIGGER trg_preserve_protected_toast_export_evidence
BEFORE UPDATE ON toast_accounting_export_drafts
FOR EACH ROW EXECUTE FUNCTION clawpilot_preserve_protected_toast_export_evidence();
