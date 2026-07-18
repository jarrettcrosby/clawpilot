ALTER TABLE quickbooks_accounts
  ADD COLUMN IF NOT EXISTS current_balance numeric(26, 6) NOT NULL DEFAULT 0;

ALTER TABLE quickbooks_items
  ADD COLUMN IF NOT EXISTS quantity_on_hand numeric(26, 6),
  ADD COLUMN IF NOT EXISTS track_quantity boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS quickbooks_customers (
  organization_id uuid NOT NULL REFERENCES organization_quickbooks_connections(organization_id) ON DELETE CASCADE,
  quickbooks_customer_id text NOT NULL,
  display_name text NOT NULL,
  company_name text,
  email text,
  phone text,
  currency_code text,
  balance numeric(26, 6) NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  source_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, quickbooks_customer_id),
  CONSTRAINT quickbooks_customers_id_present CHECK (length(btrim(quickbooks_customer_id)) > 0),
  CONSTRAINT quickbooks_customers_name_present CHECK (length(btrim(display_name)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_quickbooks_customers_explorer
  ON quickbooks_customers (organization_id, active, display_name, quickbooks_customer_id);

CREATE TABLE IF NOT EXISTS quickbooks_vendors (
  organization_id uuid NOT NULL REFERENCES organization_quickbooks_connections(organization_id) ON DELETE CASCADE,
  quickbooks_vendor_id text NOT NULL,
  display_name text NOT NULL,
  company_name text,
  email text,
  phone text,
  currency_code text,
  balance numeric(26, 6) NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  source_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, quickbooks_vendor_id),
  CONSTRAINT quickbooks_vendors_id_present CHECK (length(btrim(quickbooks_vendor_id)) > 0),
  CONSTRAINT quickbooks_vendors_name_present CHECK (length(btrim(display_name)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_quickbooks_vendors_explorer
  ON quickbooks_vendors (organization_id, active, display_name, quickbooks_vendor_id);

CREATE TABLE IF NOT EXISTS quickbooks_transactions (
  organization_id uuid NOT NULL REFERENCES organization_quickbooks_connections(organization_id) ON DELETE CASCADE,
  entity_type text NOT NULL,
  quickbooks_transaction_id text NOT NULL,
  document_number text,
  transaction_date date,
  due_date date,
  party_id text,
  party_name text,
  account_id text,
  account_name text,
  currency_code text,
  total_amount numeric(26, 6) NOT NULL DEFAULT 0,
  open_balance numeric(26, 6) NOT NULL DEFAULT 0,
  transaction_status text NOT NULL DEFAULT 'Posted',
  email_status text,
  payment_method text,
  memo text,
  source_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, entity_type, quickbooks_transaction_id),
  CONSTRAINT quickbooks_transactions_type_present CHECK (
    entity_type = btrim(entity_type) AND char_length(entity_type) BETWEEN 1 AND 80
  ),
  CONSTRAINT quickbooks_transactions_id_present CHECK (length(btrim(quickbooks_transaction_id)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_quickbooks_transactions_explorer
  ON quickbooks_transactions (organization_id, entity_type, transaction_date DESC, quickbooks_transaction_id);

CREATE INDEX IF NOT EXISTS idx_quickbooks_transactions_party
  ON quickbooks_transactions (organization_id, party_id, party_name, transaction_date DESC);

CREATE INDEX IF NOT EXISTS idx_quickbooks_transactions_open
  ON quickbooks_transactions (organization_id, entity_type, due_date, open_balance)
  WHERE open_balance <> 0;

CREATE TABLE IF NOT EXISTS quickbooks_attachments (
  organization_id uuid NOT NULL REFERENCES organization_quickbooks_connections(organization_id) ON DELETE CASCADE,
  quickbooks_attachment_id text NOT NULL,
  file_name text,
  content_type text,
  size_bytes bigint,
  note text,
  entity_references jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, quickbooks_attachment_id),
  CONSTRAINT quickbooks_attachments_id_present CHECK (length(btrim(quickbooks_attachment_id)) > 0),
  CONSTRAINT quickbooks_attachments_size_valid CHECK (size_bytes IS NULL OR size_bytes >= 0)
);

CREATE INDEX IF NOT EXISTS idx_quickbooks_attachments_explorer
  ON quickbooks_attachments (organization_id, file_name, quickbooks_attachment_id);
