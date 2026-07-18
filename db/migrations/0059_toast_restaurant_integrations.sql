CREATE TABLE IF NOT EXISTS organization_toast_credentials (
  organization_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE CASCADE,
  access_type text NOT NULL CHECK (access_type IN ('analytics', 'standard')),
  api_base_url text NOT NULL,
  client_id text NOT NULL,
  client_secret_ciphertext bytea NOT NULL,
  client_secret_iv bytea NOT NULL,
  client_secret_tag bytea NOT NULL,
  client_secret_last_four text NOT NULL,
  credential_version integer NOT NULL DEFAULT 1,
  sync_enabled boolean NOT NULL DEFAULT false,
  verified_at timestamptz,
  last_error_code text,
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  updated_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, access_type),
  CONSTRAINT organization_toast_credentials_url_valid CHECK (
    api_base_url ~* '^https://([a-z0-9-]+\.)*toasttab\.com/?$'
  ),
  CONSTRAINT organization_toast_credentials_client_id_valid CHECK (
    client_id = btrim(client_id)
    AND char_length(client_id) BETWEEN 8 AND 512
    AND client_id ~ '^[!-~]+$'
  ),
  CONSTRAINT organization_toast_credentials_secret_valid CHECK (
    octet_length(client_secret_ciphertext) > 0
    AND octet_length(client_secret_iv) = 12
    AND octet_length(client_secret_tag) = 16
    AND char_length(client_secret_last_four) = 4
  ),
  CONSTRAINT organization_toast_credentials_version_valid CHECK (credential_version > 0)
);

CREATE TABLE IF NOT EXISTS toast_locations (
  organization_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE CASCADE,
  restaurant_guid uuid NOT NULL,
  restaurant_name text NOT NULL,
  location_name text,
  location_code text,
  timezone text,
  active boolean NOT NULL DEFAULT true,
  test_mode boolean NOT NULL DEFAULT false,
  archived boolean NOT NULL DEFAULT false,
  analytics_access boolean NOT NULL DEFAULT false,
  standard_access boolean NOT NULL DEFAULT false,
  selected boolean NOT NULL DEFAULT false,
  last_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, restaurant_guid),
  CONSTRAINT toast_locations_name_valid CHECK (
    restaurant_name = btrim(restaurant_name)
    AND char_length(restaurant_name) BETWEEN 1 AND 200
    AND restaurant_name !~ '[[:cntrl:]]'
  )
);

CREATE INDEX IF NOT EXISTS idx_toast_locations_selected
  ON toast_locations (organization_id, selected, restaurant_name);

CREATE TABLE IF NOT EXISTS toast_sync_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE CASCADE,
  restaurant_guid uuid NOT NULL,
  sync_kind text NOT NULL CHECK (sync_kind IN ('analytics_sales', 'analytics_payouts', 'standard_orders')),
  business_date date NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'succeeded', 'failed', 'dead')),
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 8,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  request_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  result_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_error text,
  requested_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (organization_id, restaurant_guid, sync_kind, business_date),
  FOREIGN KEY (organization_id, restaurant_guid)
    REFERENCES toast_locations (organization_id, restaurant_guid) ON DELETE CASCADE,
  CONSTRAINT toast_sync_outbox_attempts_valid CHECK (
    attempt_count >= 0 AND max_attempts BETWEEN 1 AND 20
  )
);

CREATE INDEX IF NOT EXISTS idx_toast_sync_outbox_due
  ON toast_sync_outbox (available_at, created_at)
  WHERE status IN ('pending', 'failed');

CREATE TABLE IF NOT EXISTS toast_source_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE CASCADE,
  restaurant_guid uuid NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('analytics_sales', 'analytics_payout', 'standard_order')),
  source_id text NOT NULL,
  business_date date NOT NULL,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload jsonb NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, source_kind, source_id, payload_hash),
  FOREIGN KEY (organization_id, restaurant_guid)
    REFERENCES toast_locations (organization_id, restaurant_guid) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_toast_source_snapshots_business_date
  ON toast_source_snapshots (organization_id, restaurant_guid, business_date, source_kind);

CREATE TABLE IF NOT EXISTS toast_daily_sales (
  organization_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE CASCADE,
  restaurant_guid uuid NOT NULL,
  business_date date NOT NULL,
  gross_sales numeric(16, 2) NOT NULL DEFAULT 0,
  net_sales numeric(16, 2) NOT NULL DEFAULT 0,
  discounts numeric(16, 2) NOT NULL DEFAULT 0,
  voids numeric(16, 2) NOT NULL DEFAULT 0,
  refunds numeric(16, 2) NOT NULL DEFAULT 0,
  orders_count integer NOT NULL DEFAULT 0,
  guest_count integer NOT NULL DEFAULT 0,
  analytics_rows integer NOT NULL DEFAULT 0,
  standard_orders_count integer NOT NULL DEFAULT 0,
  source_revision integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, restaurant_guid, business_date),
  FOREIGN KEY (organization_id, restaurant_guid)
    REFERENCES toast_locations (organization_id, restaurant_guid) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS toast_accounting_mappings (
  organization_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE CASCADE,
  restaurant_guid uuid,
  mapping_key text NOT NULL CHECK (
    mapping_key IN ('gross_sales', 'discounts', 'voids', 'refunds', 'taxes', 'tips', 'service_charges', 'gift_cards', 'cash', 'card', 'other_tender', 'payouts', 'fees', 'over_short')
  ),
  quickbooks_account_id text,
  quickbooks_account_name text,
  updated_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, restaurant_guid, mapping_key),
  FOREIGN KEY (organization_id, restaurant_guid)
    REFERENCES toast_locations (organization_id, restaurant_guid) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS toast_accounting_export_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE CASCADE,
  restaurant_guid uuid NOT NULL,
  business_date date NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'needs_mapping' CHECK (
    status IN ('needs_mapping', 'needs_review', 'approved', 'posting', 'posted', 'failed', 'voided')
  ),
  reconciliation_status text NOT NULL DEFAULT 'pending' CHECK (
    reconciliation_status IN ('pending', 'analytics_only', 'orders_only', 'ready', 'variance')
  ),
  source_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  proposed_lines jsonb NOT NULL DEFAULT '[]'::jsonb,
  quickbooks_payload jsonb,
  quickbooks_transaction_id text,
  approved_by text REFERENCES app_users(email) ON DELETE SET NULL,
  approved_at timestamptz,
  posted_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, restaurant_guid, business_date),
  FOREIGN KEY (organization_id, restaurant_guid)
    REFERENCES toast_locations (organization_id, restaurant_guid) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_toast_accounting_drafts_review
  ON toast_accounting_export_drafts (organization_id, status, business_date DESC);
