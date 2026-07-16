ALTER TABLE crm_contacts
  ADD COLUMN IF NOT EXISTS pipeline_user boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_crm_contacts_pipeline_users
  ON crm_contacts (pipeline_id, organization_id, lower(full_name), id)
  WHERE pipeline_user = true;

-- Products use the same permanent, globally exclusive numeric registry as the
-- other CRM modules. Expanding these checks does not release or rewrite any
-- previously allocated reference.
ALTER TABLE crm_reference_registry
  DROP CONSTRAINT IF EXISTS crm_reference_registry_code_valid,
  DROP CONSTRAINT IF EXISTS crm_reference_registry_prefix_valid,
  DROP CONSTRAINT IF EXISTS crm_reference_registry_canonical_valid;

ALTER TABLE crm_reference_registry
  ADD CONSTRAINT crm_reference_registry_code_valid
    CHECK (reference_code ~ '^g[aciklmop][0-9]{7}$'),
  ADD CONSTRAINT crm_reference_registry_prefix_valid CHECK (
    prefix IN ('ga', 'gc', 'gl', 'go', 'gm', 'gi', 'gk', 'gp')
    AND prefix = left(reference_code, 2)
  ),
  ADD CONSTRAINT crm_reference_registry_canonical_valid
    CHECK (canonical_code ~ '^g[aciklmop][0-9]{7}$');

CREATE OR REPLACE FUNCTION allocate_crm_reference(requested_prefix text)
RETURNS text
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  candidate_number text;
  candidate text;
  reserved_number text;
BEGIN
  IF requested_prefix NOT IN ('ga', 'gc', 'gl', 'go', 'gm', 'gi', 'gk', 'gp') THEN
    RAISE EXCEPTION 'Unsupported CRM reference prefix: %', requested_prefix;
  END IF;

  FOR attempt IN 1..1000 LOOP
    candidate_number := (1000000 + floor(random() * 9000000)::bigint)::text;
    candidate := requested_prefix || candidate_number;
    reserved_number := NULL;

    INSERT INTO crm_reference_number_registry (number_value, allocated_at)
    VALUES (candidate_number, now())
    ON CONFLICT (number_value) DO NOTHING
    RETURNING number_value INTO reserved_number;

    IF reserved_number IS NULL THEN
      CONTINUE;
    END IF;

    INSERT INTO crm_reference_registry (
      reference_code, prefix, canonical_code, status, allocated_at
    )
    VALUES (candidate, requested_prefix, candidate, 'active', now());

    RETURN candidate;
  END LOOP;

  RAISE EXCEPTION 'Unable to allocate a unique CRM reference for prefix %', requested_prefix;
END;
$$;

CREATE TABLE IF NOT EXISTS crm_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id uuid NOT NULL REFERENCES pipeline_spaces(id) ON DELETE CASCADE,
  suitecrm_id text,
  source_key text NOT NULL,
  source_sheet_id text,
  source_row_number integer,
  reference_code text NOT NULL DEFAULT allocate_crm_reference('gp'),
  name text NOT NULL,
  sku text,
  product_type text NOT NULL DEFAULT 'Good',
  category text,
  status text NOT NULL DEFAULT 'Active',
  price numeric(26,6) NOT NULL DEFAULT 0,
  cost numeric(26,6) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'USD',
  url text,
  description text,
  active boolean NOT NULL DEFAULT true,
  source_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_hash text NOT NULL,
  sync_status text NOT NULL DEFAULT 'pending'
    CHECK (sync_status IN ('pending', 'syncing', 'synced', 'failed')),
  sync_error text,
  suitecrm_synced_at timestamptz,
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  updated_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_products_name_present CHECK (length(btrim(name)) > 0),
  CONSTRAINT crm_products_source_key_present CHECK (length(btrim(source_key)) > 0),
  CONSTRAINT crm_products_source_row_valid CHECK (source_row_number IS NULL OR source_row_number >= 1),
  CONSTRAINT crm_products_sku_length_valid CHECK (sku IS NULL OR length(sku) <= 25),
  CONSTRAINT crm_products_reference_code_valid CHECK (reference_code ~ '^gp[0-9]{7}$'),
  CONSTRAINT crm_products_reference_code_unique UNIQUE (reference_code),
  CONSTRAINT crm_products_pipeline_source_unique UNIQUE (pipeline_id, source_key),
  CONSTRAINT crm_products_price_valid CHECK (price >= 0),
  CONSTRAINT crm_products_cost_valid CHECK (cost >= 0),
  CONSTRAINT crm_products_currency_valid CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT crm_products_reference_registry_fkey
    FOREIGN KEY (reference_code)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_products_pipeline_id
  ON crm_products (pipeline_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_products_suitecrm
  ON crm_products (pipeline_id, suitecrm_id)
  WHERE suitecrm_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_products_pipeline_name_unique
  ON crm_products (pipeline_id, lower(name));

CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_products_pipeline_sku_unique
  ON crm_products (pipeline_id, lower(sku))
  WHERE NULLIF(btrim(sku), '') IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_crm_products_catalog
  ON crm_products (pipeline_id, active DESC, lower(name), lower(COALESCE(sku, '')), id);

CREATE INDEX IF NOT EXISTS idx_crm_products_status
  ON crm_products (pipeline_id, status, updated_at DESC, id);

ALTER TABLE crm_opportunities
  ADD COLUMN IF NOT EXISTS owner_contact_id uuid;

ALTER TABLE crm_opportunities
  DROP CONSTRAINT IF EXISTS crm_opportunities_pipeline_owner_contact_fkey,
  ADD CONSTRAINT crm_opportunities_pipeline_owner_contact_fkey
    FOREIGN KEY (pipeline_id, owner_contact_id)
    REFERENCES crm_contacts (pipeline_id, id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_crm_opportunities_owner_contact
  ON crm_opportunities (pipeline_id, owner_contact_id, updated_at DESC)
  WHERE owner_contact_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS crm_opportunity_products (
  pipeline_id uuid NOT NULL REFERENCES pipeline_spaces(id) ON DELETE CASCADE,
  opportunity_id uuid NOT NULL,
  product_id uuid NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (opportunity_id, product_id),
  CONSTRAINT crm_opportunity_products_pipeline_opportunity_fkey
    FOREIGN KEY (pipeline_id, opportunity_id)
    REFERENCES crm_opportunities (pipeline_id, id) ON DELETE CASCADE,
  CONSTRAINT crm_opportunity_products_pipeline_product_fkey
    FOREIGN KEY (pipeline_id, product_id)
    REFERENCES crm_products (pipeline_id, id) ON DELETE RESTRICT,
  CONSTRAINT crm_opportunity_products_sort_order_valid CHECK (sort_order >= 0),
  CONSTRAINT crm_opportunity_products_sort_order_unique UNIQUE (opportunity_id, sort_order)
);

CREATE INDEX IF NOT EXISTS idx_crm_opportunity_products_product
  ON crm_opportunity_products (pipeline_id, product_id, opportunity_id);

CREATE INDEX IF NOT EXISTS idx_crm_opportunity_products_opportunity
  ON crm_opportunity_products (pipeline_id, opportunity_id, sort_order, product_id);

CREATE TABLE IF NOT EXISTS pipeline_dropdown_catalogs (
  pipeline_id uuid PRIMARY KEY REFERENCES pipeline_spaces(id) ON DELETE CASCADE,
  catalog jsonb NOT NULL DEFAULT '{"syncedAt":null,"source":"app","dropdowns":{}}'::jsonb,
  source text NOT NULL DEFAULT 'app' CHECK (source IN ('app', 'sheet')),
  desired_revision bigint NOT NULL DEFAULT 0,
  applied_revision bigint NOT NULL DEFAULT 0,
  updated_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pipeline_dropdown_catalogs_object CHECK (jsonb_typeof(catalog) = 'object')
);

ALTER TABLE pipeline_dropdown_catalogs
  ADD COLUMN IF NOT EXISTS desired_revision bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS applied_revision bigint NOT NULL DEFAULT 0;

INSERT INTO pipeline_dropdown_catalogs (
  pipeline_id, catalog, source, updated_by, created_at, updated_at
)
SELECT
  pipeline.id,
  setting.value,
  CASE WHEN setting.value->>'source' = 'app' THEN 'app' ELSE 'sheet' END,
  pipeline.owner_email,
  setting.updated_at,
  setting.updated_at
FROM pipeline_spaces pipeline
JOIN app_settings setting
  ON setting.key = 'pipeline.dropdowns.current:' || pipeline.id::text
WHERE jsonb_typeof(setting.value) = 'object'
ON CONFLICT (pipeline_id) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_pipeline_dropdown_catalogs_updated
  ON pipeline_dropdown_catalogs (updated_at DESC, pipeline_id);
