CREATE TABLE IF NOT EXISTS organization_quickbooks_connections (
  organization_id uuid PRIMARY KEY REFERENCES workspace_organizations(id) ON DELETE CASCADE,
  credential_owner_email text NOT NULL REFERENCES app_users(email) ON DELETE RESTRICT,
  maton_connection_id text NOT NULL UNIQUE,
  company_name text NOT NULL,
  country text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'error', 'disconnected')),
  catalog_sync_enabled boolean NOT NULL DEFAULT true,
  verified_at timestamptz NOT NULL,
  last_catalog_synced_at timestamptz,
  last_error_code text,
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  updated_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organization_quickbooks_connection_id_valid CHECK (
    maton_connection_id = btrim(maton_connection_id)
    AND char_length(maton_connection_id) BETWEEN 1 AND 512
    AND maton_connection_id ~ '^[!-~]+$'
  ),
  CONSTRAINT organization_quickbooks_company_name_present CHECK (
    company_name = btrim(company_name)
    AND char_length(company_name) BETWEEN 1 AND 200
    AND company_name !~ '[[:cntrl:]]'
  )
);

CREATE TABLE IF NOT EXISTS quickbooks_accounts (
  organization_id uuid NOT NULL REFERENCES organization_quickbooks_connections(organization_id) ON DELETE CASCADE,
  quickbooks_account_id text NOT NULL,
  name text NOT NULL,
  fully_qualified_name text NOT NULL,
  classification text,
  account_type text,
  account_sub_type text,
  currency_code text,
  active boolean NOT NULL DEFAULT true,
  source_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, quickbooks_account_id),
  CONSTRAINT quickbooks_accounts_id_present CHECK (length(btrim(quickbooks_account_id)) > 0),
  CONSTRAINT quickbooks_accounts_name_present CHECK (length(btrim(name)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_quickbooks_accounts_mapping
  ON quickbooks_accounts (organization_id, active, classification, fully_qualified_name);

CREATE TABLE IF NOT EXISTS quickbooks_items (
  organization_id uuid NOT NULL REFERENCES organization_quickbooks_connections(organization_id) ON DELETE CASCADE,
  quickbooks_item_id text NOT NULL,
  name text NOT NULL,
  fully_qualified_name text NOT NULL,
  item_type text NOT NULL,
  sku text,
  description text,
  unit_price numeric(26, 6) NOT NULL DEFAULT 0,
  purchase_cost numeric(26, 6) NOT NULL DEFAULT 0,
  income_account_id text,
  expense_account_id text,
  asset_account_id text,
  active boolean NOT NULL DEFAULT true,
  taxable boolean NOT NULL DEFAULT false,
  source_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, quickbooks_item_id),
  CONSTRAINT quickbooks_items_id_present CHECK (length(btrim(quickbooks_item_id)) > 0),
  CONSTRAINT quickbooks_items_name_present CHECK (length(btrim(name)) > 0),
  CONSTRAINT quickbooks_items_price_valid CHECK (unit_price >= 0),
  CONSTRAINT quickbooks_items_cost_valid CHECK (purchase_cost >= 0)
);

CREATE INDEX IF NOT EXISTS idx_quickbooks_items_catalog
  ON quickbooks_items (organization_id, active, item_type, fully_qualified_name);

CREATE TABLE IF NOT EXISTS quickbooks_sync_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization_quickbooks_connections(organization_id) ON DELETE CASCADE,
  sync_kind text NOT NULL DEFAULT 'catalog' CHECK (sync_kind IN ('catalog')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'succeeded', 'failed', 'dead')),
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 8,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  lock_token uuid,
  result_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_error text,
  requested_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (organization_id, sync_kind),
  CONSTRAINT quickbooks_sync_attempts_valid CHECK (
    attempt_count >= 0 AND max_attempts BETWEEN 1 AND 20
  )
);

CREATE INDEX IF NOT EXISTS idx_quickbooks_sync_outbox_due
  ON quickbooks_sync_outbox (available_at, created_at)
  WHERE status IN ('pending', 'failed');
