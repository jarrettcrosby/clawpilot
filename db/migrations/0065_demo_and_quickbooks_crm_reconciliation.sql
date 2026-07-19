ALTER TABLE app_sessions
  DROP CONSTRAINT IF EXISTS app_sessions_auth_method_check;

ALTER TABLE app_sessions
  ADD CONSTRAINT app_sessions_auth_method_check
  CHECK (auth_method IN ('magic_code', 'operator_password', 'legacy_upgrade', 'demo'));

CREATE TABLE IF NOT EXISTS demo_dataset_metadata (
  dataset_key text PRIMARY KEY,
  dataset_version integer NOT NULL CHECK (dataset_version >= 1),
  anchor_date date NOT NULL,
  recent_window_days integer NOT NULL DEFAULT 30 CHECK (recent_window_days BETWEEN 1 AND 365),
  context_window_days integer NOT NULL DEFAULT 90 CHECK (context_window_days BETWEEN 30 AND 730),
  generated_at timestamptz NOT NULL DEFAULT now(),
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT demo_dataset_metadata_key_present CHECK (length(btrim(dataset_key)) > 0)
);

ALTER TABLE organization_quickbooks_connections
  ADD COLUMN IF NOT EXISTS crm_pipeline_id uuid REFERENCES pipeline_spaces(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS crm_customer_sync_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS crm_product_sync_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS last_crm_synced_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_crm_sync_error text;

CREATE INDEX IF NOT EXISTS idx_quickbooks_connections_crm_pipeline
  ON organization_quickbooks_connections (crm_pipeline_id, organization_id)
  WHERE crm_pipeline_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS quickbooks_crm_links (
  organization_id uuid NOT NULL REFERENCES organization_quickbooks_connections(organization_id) ON DELETE CASCADE,
  pipeline_id uuid NOT NULL REFERENCES pipeline_spaces(id) ON DELETE CASCADE,
  provider_entity_type text NOT NULL CHECK (provider_entity_type IN ('customer', 'item')),
  provider_entity_id text NOT NULL,
  crm_entity_type text NOT NULL CHECK (crm_entity_type IN ('organization', 'contact', 'product')),
  crm_record_id uuid NOT NULL,
  source_hash text NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, pipeline_id, provider_entity_type, provider_entity_id, crm_entity_type),
  CONSTRAINT quickbooks_crm_links_provider_id_present CHECK (length(btrim(provider_entity_id)) > 0),
  CONSTRAINT quickbooks_crm_links_source_hash_valid CHECK (source_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS idx_quickbooks_crm_links_record
  ON quickbooks_crm_links (pipeline_id, crm_entity_type, crm_record_id);

CREATE INDEX IF NOT EXISTS idx_quickbooks_crm_links_provider
  ON quickbooks_crm_links (organization_id, provider_entity_type, provider_entity_id);
