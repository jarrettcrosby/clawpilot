-- Ephemeral, development-only Shopify order diagnostics.
--
-- This is not the canonical commerce order-import path. It deliberately keeps
-- customer identity, addresses, contact fields, notes, tags, customized line
-- text, and raw provider payloads out of Postgres. Even this minimized order
-- projection is treated as protected customer data and expires after 24 hours.

CREATE OR REPLACE FUNCTION operations_shopify_preview_lines_valid(value jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN jsonb_typeof(value) <> 'array' THEN false
    WHEN jsonb_array_length(value) > 20 THEN false
    ELSE NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(value) AS item(line)
      WHERE jsonb_typeof(line) <> 'object'
        OR NOT line ?& ARRAY[
          'externalLineId',
          'sku',
          'quantity',
          'currentQuantity',
          'unfulfilledQuantity',
          'requiresShipping',
          'mappingStatus',
          'mappedProductGlobalId',
          'packageProfileReady'
        ]
        OR EXISTS (
          SELECT 1
          FROM jsonb_object_keys(line) AS field(key)
          WHERE key <> ALL (ARRAY[
            'externalLineId',
            'sku',
            'quantity',
            'currentQuantity',
            'unfulfilledQuantity',
            'requiresShipping',
            'mappingStatus',
            'mappedProductGlobalId',
            'packageProfileReady'
          ])
        )
        OR jsonb_typeof(line->'externalLineId') <> 'string'
        OR line->>'externalLineId'
          !~ '^gid://shopify/LineItem/[1-9][0-9]*$'
        OR (
          jsonb_typeof(line->'sku') <> 'null'
          AND (
            jsonb_typeof(line->'sku') <> 'string'
            OR length(line->>'sku') > 255
            OR line->>'sku' ~ '[[:cntrl:]]'
          )
        )
        OR jsonb_typeof(line->'quantity') <> 'number'
        OR line->>'quantity' !~ '^(0|[1-9][0-9]{0,9})$'
        OR jsonb_typeof(line->'currentQuantity') <> 'number'
        OR line->>'currentQuantity' !~ '^(0|[1-9][0-9]{0,9})$'
        OR jsonb_typeof(line->'unfulfilledQuantity') <> 'number'
        OR line->>'unfulfilledQuantity' !~ '^(0|[1-9][0-9]{0,9})$'
        OR jsonb_typeof(line->'requiresShipping') <> 'boolean'
        OR jsonb_typeof(line->'mappingStatus') <> 'string'
        OR line->>'mappingStatus' NOT IN (
          'inactive',
          'mapped',
          'missing',
          'sku_missing'
        )
        OR (
          jsonb_typeof(line->'mappedProductGlobalId') <> 'null'
          AND (
            jsonb_typeof(line->'mappedProductGlobalId') <> 'string'
            OR line->>'mappedProductGlobalId' !~ '^gp[0-9]{7}$'
          )
        )
        OR jsonb_typeof(line->'packageProfileReady') <> 'boolean'
    )
  END
$$;

CREATE TABLE IF NOT EXISTS operations_commerce_order_preview_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  credential_version integer NOT NULL CHECK (credential_version > 0),
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  policy_version text NOT NULL DEFAULT 'shopify-held-preview-v1'
    CHECK (policy_version = 'shopify-held-preview-v1'),
  window_end timestamptz NOT NULL,
  max_orders integer NOT NULL CHECK (max_orders BETWEEN 1 AND 25),
  orders_seen integer NOT NULL CHECK (orders_seen BETWEEN 0 AND 25),
  orders_staged integer NOT NULL CHECK (orders_staged BETWEEN 0 AND orders_seen),
  more_available boolean NOT NULL DEFAULT false,
  granted_scopes text[] NOT NULL DEFAULT '{}'::text[],
  canonical_orders_created integer NOT NULL DEFAULT 0
    CHECK (canonical_orders_created = 0),
  shopify_writes integer NOT NULL DEFAULT 0 CHECK (shopify_writes = 0),
  sync_cursor_advanced boolean NOT NULL DEFAULT false
    CHECK (sync_cursor_advanced = false),
  created_by text REFERENCES app_users(email) ON DELETE RESTRICT,
  completed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  CONSTRAINT operations_commerce_order_preview_runs_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_order_preview_runs_account_id_unique
    UNIQUE (organization_id, integration_account_id, id),
  CONSTRAINT operations_commerce_order_preview_runs_current_unique
    UNIQUE (organization_id, integration_account_id),
  CONSTRAINT operations_commerce_order_preview_runs_idempotency_unique
    UNIQUE (organization_id, integration_account_id, idempotency_key),
  CONSTRAINT operations_commerce_order_preview_runs_expiry_valid CHECK (
    expires_at > created_at
    AND expires_at <= created_at + interval '24 hours'
  ),
  CONSTRAINT operations_commerce_order_preview_runs_completed_valid CHECK (
    completed_at >= created_at
  )
);

CREATE INDEX IF NOT EXISTS operations_commerce_order_preview_runs_latest_idx
  ON operations_commerce_order_preview_runs (
    organization_id, integration_account_id, completed_at DESC, id DESC
  );

CREATE INDEX IF NOT EXISTS operations_commerce_order_preview_runs_expiry_idx
  ON operations_commerce_order_preview_runs (expires_at, id);

CREATE TABLE IF NOT EXISTS operations_commerce_order_previews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  run_id uuid NOT NULL,
  external_order_id text NOT NULL
    CHECK (external_order_id ~ '^gid://shopify/Order/[1-9][0-9]*$'),
  order_name text NOT NULL
    CHECK (
      length(btrim(order_name)) BETWEEN 1 AND 255
      AND order_name !~ '[[:cntrl:]]'
    ),
  provider_created_at timestamptz NOT NULL,
  provider_processed_at timestamptz NOT NULL,
  provider_updated_at timestamptz NOT NULL,
  provider_cancelled_at timestamptz,
  provider_closed_at timestamptz,
  test_order boolean NOT NULL DEFAULT false CHECK (test_order = false),
  source_name text CHECK (
    source_name IS NULL
    OR source_name ~ '^[A-Za-z0-9_.:/ -]{1,120}$'
  ),
  financial_status text CHECK (
    financial_status IS NULL
    OR financial_status ~ '^[A-Z][A-Z0-9_]{0,63}$'
  ),
  fulfillment_status text NOT NULL
    CHECK (fulfillment_status ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  fulfillable boolean NOT NULL,
  requires_shipping boolean NOT NULL,
  currency_code text NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  subtotal_amount numeric(20,6) NOT NULL CHECK (subtotal_amount >= 0),
  shipping_amount numeric(20,6) NOT NULL CHECK (shipping_amount >= 0),
  tax_amount numeric(20,6) NOT NULL CHECK (tax_amount >= 0),
  total_amount numeric(20,6) NOT NULL CHECK (total_amount >= 0),
  line_item_quantity integer NOT NULL CHECK (line_item_quantity >= 0),
  line_items_truncated boolean NOT NULL DEFAULT false,
  normalized_lines jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (operations_shopify_preview_lines_valid(normalized_lines)),
  gap_codes text[] NOT NULL DEFAULT '{}'::text[],
  diagnostic_state text NOT NULL
    CHECK (diagnostic_state IN ('complete', 'gaps')),
  source_hash text NOT NULL CHECK (source_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT operations_commerce_order_previews_run_fkey
    FOREIGN KEY (organization_id, integration_account_id, run_id)
    REFERENCES operations_commerce_order_preview_runs(
      organization_id, integration_account_id, id
    ) ON DELETE CASCADE,
  CONSTRAINT operations_commerce_order_previews_run_order_unique
    UNIQUE (run_id, external_order_id),
  CONSTRAINT operations_commerce_order_previews_expiry_valid CHECK (
    expires_at > created_at
    AND expires_at <= created_at + interval '24 hours'
  ),
  CONSTRAINT operations_commerce_order_previews_gap_codes_valid CHECK (
    gap_codes <@ ARRAY[
      'canonical_import_not_implemented',
      'customer_resolution_not_evaluated',
      'line_items_empty',
      'line_items_truncated',
      'non_shippable_order',
      'order_already_fulfilled',
      'order_cancelled',
      'package_profile_missing',
      'product_mapping_inactive',
      'product_mapping_missing',
      'requested_delivery_not_mapped',
      'ship_to_not_ingested',
      'sku_missing'
    ]::text[]
  )
);

CREATE INDEX IF NOT EXISTS operations_commerce_order_previews_run_idx
  ON operations_commerce_order_previews (
    organization_id, integration_account_id, run_id,
    provider_created_at DESC, id
  );

CREATE OR REPLACE FUNCTION protect_operations_commerce_order_preview_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Commerce order preview evidence cannot be updated';
END;
$$;

DROP TRIGGER IF EXISTS protect_operations_commerce_order_preview_run_update
  ON operations_commerce_order_preview_runs;
CREATE TRIGGER protect_operations_commerce_order_preview_run_update
BEFORE UPDATE ON operations_commerce_order_preview_runs
FOR EACH ROW EXECUTE FUNCTION
  protect_operations_commerce_order_preview_update();

DROP TRIGGER IF EXISTS protect_operations_commerce_order_preview_update
  ON operations_commerce_order_previews;
CREATE TRIGGER protect_operations_commerce_order_preview_update
BEFORE UPDATE ON operations_commerce_order_previews
FOR EACH ROW EXECUTE FUNCTION
  protect_operations_commerce_order_preview_update();
