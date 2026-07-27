-- Provider-neutral commerce intake, resolution, and promotion evidence.
--
-- These tables are bounded, tenant-scoped projections used to normalize and
-- resolve Shopify and Faire data before an explicit promotion command writes
-- the existing CRM product/customer and operations order authorities. They
-- are not product or order masters. Provider raw bodies are deliberately not
-- stored here, and this workflow is structurally read-only toward providers.

CREATE OR REPLACE FUNCTION operations_commerce_code_list_valid(value text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT value IS NOT NULL
    AND cardinality(value) <= 50
    AND NOT EXISTS (
      SELECT 1
      FROM unnest(value) AS code(item)
      WHERE item IS NULL
        OR item !~ '^[a-z][a-z0-9_.:-]{0,127}$'
    )
$$;

CREATE OR REPLACE FUNCTION operations_commerce_workflow_transition_valid(
  current_state text,
  next_state text
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE current_state
    WHEN 'held' THEN next_state IN (
      'held', 'resolving', 'ready', 'failed', 'expired'
    )
    WHEN 'resolving' THEN next_state IN (
      'held', 'resolving', 'ready', 'failed', 'expired'
    )
    WHEN 'ready' THEN next_state IN (
      'held', 'resolving', 'ready', 'promoted', 'failed', 'expired'
    )
    WHEN 'promoted' THEN next_state = 'promoted'
    WHEN 'failed' THEN next_state IN (
      'held', 'resolving', 'failed', 'expired'
    )
    WHEN 'expired' THEN next_state = 'expired'
    ELSE false
  END
$$;

CREATE OR REPLACE FUNCTION operations_commerce_protected_snapshot_valid(
  snapshot_state text,
  snapshot_ciphertext bytea,
  snapshot_iv bytea,
  snapshot_tag bytea,
  snapshot_hash text,
  encryption_version integer
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN snapshot_state IN ('missing', 'redacted') THEN
      snapshot_ciphertext IS NULL
      AND snapshot_iv IS NULL
      AND snapshot_tag IS NULL
      AND snapshot_hash IS NULL
      AND encryption_version IS NULL
    WHEN snapshot_state IN ('protected', 'confirmed') THEN
      snapshot_ciphertext IS NOT NULL
      AND octet_length(snapshot_ciphertext) BETWEEN 2 AND 65536
      AND snapshot_iv IS NOT NULL
      AND octet_length(snapshot_iv) = 12
      AND snapshot_tag IS NOT NULL
      AND octet_length(snapshot_tag) = 16
      AND snapshot_hash IS NOT NULL
      AND snapshot_hash ~ '^[a-f0-9]{64}$'
      AND encryption_version IS NOT NULL
      AND encryption_version > 0
    ELSE false
  END
$$;

INSERT INTO global_reference_entity_types (prefix, entity_type, display_name)
VALUES
  ('gcir', 'operations.commerce_intake_run', 'Commerce intake run'),
  ('gcpc', 'operations.commerce_product_candidate', 'Commerce product candidate'),
  ('gcoc', 'operations.commerce_order_candidate', 'Commerce order candidate'),
  ('gcol', 'operations.commerce_order_candidate_line', 'Commerce order candidate line'),
  ('gcrd', 'operations.commerce_resolution_decision', 'Commerce resolution decision')
ON CONFLICT (prefix) DO UPDATE SET
  entity_type = EXCLUDED.entity_type,
  display_name = EXCLUDED.display_name;

-- Existing mappings remain valid. New normalized mappings can bind an exact
-- account-scoped provider variant even when the provider supplies no SKU.
ALTER TABLE operations_product_mappings
  ALTER COLUMN channel_sku DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS external_variant_id text,
  ADD COLUMN IF NOT EXISTS external_inventory_item_id text,
  ADD COLUMN IF NOT EXISTS mapping_method text NOT NULL DEFAULT 'legacy_sku',
  ADD COLUMN IF NOT EXISTS mapping_source_revision text;

ALTER TABLE operations_product_mappings
  DROP CONSTRAINT IF EXISTS operations_product_mappings_sku_unique,
  DROP CONSTRAINT IF EXISTS operations_product_mappings_variant_id_valid,
  DROP CONSTRAINT IF EXISTS operations_product_mappings_inventory_id_valid,
  DROP CONSTRAINT IF EXISTS operations_product_mappings_method_valid,
  DROP CONSTRAINT IF EXISTS operations_product_mappings_method_identity_valid,
  ADD CONSTRAINT operations_product_mappings_variant_id_valid CHECK (
    external_variant_id IS NULL
    OR (
      length(btrim(external_variant_id)) BETWEEN 1 AND 512
      AND external_variant_id !~ '[[:cntrl:]]'
    )
  ),
  ADD CONSTRAINT operations_product_mappings_inventory_id_valid CHECK (
    external_inventory_item_id IS NULL
    OR (
      length(btrim(external_inventory_item_id)) BETWEEN 1 AND 512
      AND external_inventory_item_id !~ '[[:cntrl:]]'
    )
  ),
  ADD CONSTRAINT operations_product_mappings_method_valid CHECK (
    mapping_method IN (
      'legacy_sku', 'exact_variant', 'manual', 'product_created'
    )
  ),
  ADD CONSTRAINT operations_product_mappings_method_identity_valid CHECK (
    mapping_method = 'legacy_sku'
    OR external_variant_id IS NOT NULL
  );

CREATE UNIQUE INDEX IF NOT EXISTS
  idx_operations_product_mappings_sku
  ON operations_product_mappings (
    organization_id, integration_account_id, channel_sku
  )
  WHERE channel_sku IS NOT NULL
    AND mapping_method = 'legacy_sku';

CREATE UNIQUE INDEX IF NOT EXISTS
  idx_operations_product_mappings_exact_variant
  ON operations_product_mappings (
    organization_id, integration_account_id, external_variant_id
  )
  WHERE external_variant_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS
  idx_operations_product_mappings_scope_product
  ON operations_product_mappings (
    organization_id, integration_account_id, pipeline_id, id, product_id
  );

CREATE UNIQUE INDEX IF NOT EXISTS
  idx_operations_command_receipts_org_id
  ON operations_command_receipts (organization_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS
  idx_operations_commerce_attempts_account_id
  ON operations_commerce_provider_attempts (
    organization_id, integration_account_id, id
  );

CREATE UNIQUE INDEX IF NOT EXISTS
  idx_operations_package_profiles_scope_product
  ON operations_product_package_profiles (
    organization_id, pipeline_id, product_id, id
  );

CREATE OR REPLACE FUNCTION protect_operations_product_mapping_variant()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.external_variant_id IS NOT NULL
     AND NEW.external_variant_id IS DISTINCT FROM OLD.external_variant_id THEN
    RAISE EXCEPTION
      'Commerce product mapping provider variant identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_operations_product_mapping_variant
  ON operations_product_mappings;
CREATE TRIGGER protect_operations_product_mapping_variant
BEFORE UPDATE OF external_variant_id ON operations_product_mappings
FOR EACH ROW EXECUTE FUNCTION
  protect_operations_product_mapping_variant();

CREATE TABLE IF NOT EXISTS operations_commerce_intake_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gcir'),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  pipeline_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('shopify', 'faire')),
  resource text NOT NULL
    CHECK (resource IN ('products', 'orders', 'products_and_orders')),
  credential_version integer NOT NULL CHECK (credential_version > 0),
  provider_api_version text NOT NULL,
  normalizer_version text NOT NULL,
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  provider_access_mode text NOT NULL DEFAULT 'read_only'
    CHECK (provider_access_mode = 'read_only'),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  provider_attempt_id uuid,
  window_start timestamptz,
  window_end timestamptz NOT NULL,
  workflow_state text NOT NULL DEFAULT 'held'
    CHECK (workflow_state IN (
      'held', 'resolving', 'ready', 'promoted', 'failed', 'expired'
    )),
  records_seen integer NOT NULL DEFAULT 0 CHECK (records_seen >= 0),
  records_staged integer NOT NULL DEFAULT 0 CHECK (records_staged >= 0),
  records_ready integer NOT NULL DEFAULT 0 CHECK (records_ready >= 0),
  records_promoted integer NOT NULL DEFAULT 0 CHECK (records_promoted >= 0),
  records_failed integer NOT NULL DEFAULT 0 CHECK (records_failed >= 0),
  canonical_orders_created integer NOT NULL DEFAULT 0
    CHECK (canonical_orders_created >= 0),
  canonical_products_created integer NOT NULL DEFAULT 0
    CHECK (canonical_products_created >= 0),
  canonical_customers_created integer NOT NULL DEFAULT 0
    CHECK (canonical_customers_created >= 0),
  product_mappings_created integer NOT NULL DEFAULT 0
    CHECK (product_mappings_created >= 0),
  provider_write_count integer NOT NULL DEFAULT 0
    CHECK (provider_write_count = 0),
  sync_cursor_advanced boolean NOT NULL DEFAULT false
    CHECK (sync_cursor_advanced = false),
  inventory_write_count integer NOT NULL DEFAULT 0
    CHECK (inventory_write_count = 0),
  reservation_write_count integer NOT NULL DEFAULT 0
    CHECK (reservation_write_count = 0),
  fulfillment_write_count integer NOT NULL DEFAULT 0
    CHECK (fulfillment_write_count = 0),
  shipment_write_count integer NOT NULL DEFAULT 0
    CHECK (shipment_write_count = 0),
  commerce_export_write_count integer NOT NULL DEFAULT 0
    CHECK (commerce_export_write_count = 0),
  last_error_code text,
  row_version bigint NOT NULL DEFAULT 0 CHECK (row_version >= 0),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_by text NOT NULL,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  CONSTRAINT commerce_intake_runs_global_valid
    CHECK (global_id ~ '^gcir[0-9]{7}$'),
  CONSTRAINT commerce_intake_runs_global_unique UNIQUE (global_id),
  CONSTRAINT commerce_intake_runs_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT commerce_intake_runs_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT commerce_intake_runs_pipeline_fkey
    FOREIGN KEY (organization_id, pipeline_id)
    REFERENCES pipeline_spaces(workspace_organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT commerce_intake_runs_attempt_fkey
    FOREIGN KEY (
      organization_id, integration_account_id, provider_attempt_id
    )
    REFERENCES operations_commerce_provider_attempts(
      organization_id, integration_account_id, id
    )
    ON DELETE RESTRICT,
  CONSTRAINT commerce_intake_runs_scope_id_unique
    UNIQUE (
      organization_id, integration_account_id, pipeline_id, id
    ),
  CONSTRAINT commerce_intake_runs_idempotency_unique
    UNIQUE (
      organization_id, integration_account_id, resource, idempotency_key
    ),
  CONSTRAINT commerce_intake_runs_api_version_valid CHECK (
    length(btrim(provider_api_version)) BETWEEN 1 AND 64
    AND provider_api_version !~ '[[:cntrl:]]'
  ),
  CONSTRAINT commerce_intake_runs_normalizer_valid CHECK (
    length(btrim(normalizer_version)) BETWEEN 1 AND 128
    AND normalizer_version !~ '[[:cntrl:]]'
  ),
  CONSTRAINT commerce_intake_runs_key_valid CHECK (
    length(btrim(idempotency_key)) BETWEEN 1 AND 255
    AND idempotency_key !~ '[[:cntrl:]]'
  ),
  CONSTRAINT commerce_intake_runs_window_valid CHECK (
    window_start IS NULL OR window_start <= window_end
  ),
  CONSTRAINT commerce_intake_runs_counts_valid CHECK (
    records_staged <= records_seen
    AND records_ready + records_promoted + records_failed <= records_staged
  ),
  CONSTRAINT commerce_intake_runs_failure_valid CHECK (
    workflow_state <> 'failed'
    OR (
      last_error_code IS NOT NULL
      AND length(btrim(last_error_code)) BETWEEN 1 AND 128
    )
  ),
  CONSTRAINT commerce_intake_runs_completion_valid CHECK (
    completed_at IS NULL OR completed_at >= started_at
  ),
  CONSTRAINT commerce_intake_runs_retention_valid CHECK (
    expires_at > created_at
    AND expires_at <= created_at + interval '30 days'
  )
);

CREATE INDEX IF NOT EXISTS commerce_intake_runs_workflow_idx
  ON operations_commerce_intake_runs (
    organization_id, workflow_state, updated_at DESC, id
  );

CREATE INDEX IF NOT EXISTS commerce_intake_runs_account_idx
  ON operations_commerce_intake_runs (
    organization_id, integration_account_id, created_at DESC, id
  );

CREATE INDEX IF NOT EXISTS commerce_intake_runs_expiry_idx
  ON operations_commerce_intake_runs (expires_at, id)
  WHERE workflow_state <> 'promoted';

CREATE OR REPLACE FUNCTION protect_operations_commerce_intake_run()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  account_provider text;
  account_type text;
  account_generation integer;
  attempt_action text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT lower(account.provider), account.integration_type,
           account.commerce_credential_generation
    INTO account_provider, account_type, account_generation
    FROM operations_integration_accounts AS account
    WHERE account.organization_id = NEW.organization_id
      AND account.id = NEW.integration_account_id;

    IF NOT FOUND
       OR account_type <> 'commerce'
       OR account_provider <> NEW.provider THEN
      RAISE EXCEPTION
        'Commerce intake run must match its tenant commerce account provider';
    END IF;
    IF account_generation <> NEW.credential_version THEN
      RAISE EXCEPTION
        'Commerce intake run credential generation is stale';
    END IF;
    IF NEW.provider_attempt_id IS NOT NULL THEN
      SELECT attempt.action
      INTO attempt_action
      FROM operations_commerce_provider_attempts AS attempt
      WHERE attempt.organization_id = NEW.organization_id
        AND attempt.integration_account_id = NEW.integration_account_id
        AND attempt.id = NEW.provider_attempt_id;
      IF attempt_action IS DISTINCT FROM 'commerce.intake.read' THEN
        RAISE EXCEPTION
          'Commerce intake run can reference only a read provider attempt';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(
    NEW.global_id,
    NEW.organization_id,
    NEW.integration_account_id,
    NEW.pipeline_id,
    NEW.provider,
    NEW.resource,
    NEW.credential_version,
    NEW.provider_api_version,
    NEW.normalizer_version,
    NEW.schema_version,
    NEW.provider_access_mode,
    NEW.idempotency_key,
    NEW.request_hash,
    NEW.window_start,
    NEW.window_end,
    NEW.started_at,
    NEW.created_by,
    NEW.created_at,
    NEW.expires_at
  ) IS DISTINCT FROM ROW(
    OLD.global_id,
    OLD.organization_id,
    OLD.integration_account_id,
    OLD.pipeline_id,
    OLD.provider,
    OLD.resource,
    OLD.credential_version,
    OLD.provider_api_version,
    OLD.normalizer_version,
    OLD.schema_version,
    OLD.provider_access_mode,
    OLD.idempotency_key,
    OLD.request_hash,
    OLD.window_start,
    OLD.window_end,
    OLD.started_at,
    OLD.created_by,
    OLD.created_at,
    OLD.expires_at
  ) THEN
    RAISE EXCEPTION 'Commerce intake run identity is immutable';
  END IF;

  IF OLD.provider_attempt_id IS NOT NULL
     AND NEW.provider_attempt_id IS DISTINCT FROM OLD.provider_attempt_id THEN
    RAISE EXCEPTION 'Commerce intake run provider attempt is immutable';
  END IF;
  IF OLD.provider_attempt_id IS NULL
     AND NEW.provider_attempt_id IS NOT NULL THEN
    SELECT attempt.action
    INTO attempt_action
    FROM operations_commerce_provider_attempts AS attempt
    WHERE attempt.organization_id = NEW.organization_id
      AND attempt.integration_account_id = NEW.integration_account_id
      AND attempt.id = NEW.provider_attempt_id;
    IF attempt_action IS DISTINCT FROM 'commerce.intake.read' THEN
      RAISE EXCEPTION
        'Commerce intake run can reference only a read provider attempt';
    END IF;
  END IF;
  IF NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION
      'Commerce intake run update requires the next row version';
  END IF;
  IF NOT operations_commerce_workflow_transition_valid(
    OLD.workflow_state, NEW.workflow_state
  ) THEN
    RAISE EXCEPTION 'Invalid commerce intake run workflow transition';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_operations_commerce_intake_run
  ON operations_commerce_intake_runs;
CREATE TRIGGER protect_operations_commerce_intake_run
BEFORE INSERT OR UPDATE ON operations_commerce_intake_runs
FOR EACH ROW EXECUTE FUNCTION
  protect_operations_commerce_intake_run();

CREATE TABLE IF NOT EXISTS operations_commerce_product_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gcpc'),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  pipeline_id uuid NOT NULL,
  run_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('shopify', 'faire')),
  external_product_id text NOT NULL,
  external_variant_id text NOT NULL,
  external_inventory_item_id text,
  sku_snapshot text,
  barcode_snapshot text,
  product_title_snapshot text NOT NULL,
  variant_title_snapshot text,
  vendor_snapshot text,
  product_type_snapshot text,
  normalized_options jsonb NOT NULL DEFAULT '[]'::jsonb,
  provider_status_raw text NOT NULL,
  normalized_status text NOT NULL DEFAULT 'unknown'
    CHECK (normalized_status IN (
      'active', 'draft', 'archived', 'unavailable', 'unknown'
    )),
  unit_multiplier numeric(20,6) NOT NULL DEFAULT 1
    CHECK (unit_multiplier > 0),
  currency_code text,
  price_minor bigint,
  compare_at_price_minor bigint,
  taxable boolean,
  requires_shipping boolean,
  inventory_quantity numeric(20,6),
  weight_grams integer,
  provider_created_at timestamptz,
  provider_updated_at timestamptz,
  observed_at timestamptz NOT NULL,
  source_revision text NOT NULL,
  source_hash text NOT NULL CHECK (source_hash ~ '^[a-f0-9]{64}$'),
  provider_api_version text NOT NULL,
  normalizer_version text NOT NULL,
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  workflow_state text NOT NULL DEFAULT 'held'
    CHECK (workflow_state IN (
      'held', 'resolving', 'ready', 'promoted', 'failed', 'expired'
    )),
  mapping_state text NOT NULL DEFAULT 'unresolved'
    CHECK (mapping_state IN (
      'unresolved', 'suggested', 'resolved', 'unsupported'
    )),
  product_id uuid,
  product_mapping_id uuid,
  blocking_codes text[] NOT NULL DEFAULT '{}'::text[]
    CHECK (operations_commerce_code_list_valid(blocking_codes)),
  unsupported_reason_code text,
  unsupported_reason_detail text,
  last_error_code text,
  row_version bigint NOT NULL DEFAULT 0 CHECK (row_version >= 0),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT commerce_product_candidates_global_valid
    CHECK (global_id ~ '^gcpc[0-9]{7}$'),
  CONSTRAINT commerce_product_candidates_global_unique UNIQUE (global_id),
  CONSTRAINT commerce_product_candidates_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT commerce_product_candidates_run_fkey
    FOREIGN KEY (
      organization_id, integration_account_id, pipeline_id, run_id
    )
    REFERENCES operations_commerce_intake_runs(
      organization_id, integration_account_id, pipeline_id, id
    ) ON DELETE CASCADE,
  CONSTRAINT commerce_product_candidates_product_fkey
    FOREIGN KEY (pipeline_id, product_id)
    REFERENCES crm_products(pipeline_id, id) ON DELETE RESTRICT,
  CONSTRAINT commerce_product_candidates_mapping_fkey
    FOREIGN KEY (
      organization_id, integration_account_id, pipeline_id,
      product_mapping_id, product_id
    )
    REFERENCES operations_product_mappings(
      organization_id, integration_account_id, pipeline_id, id, product_id
    ) ON DELETE RESTRICT,
  CONSTRAINT commerce_product_candidates_scope_id_unique
    UNIQUE (organization_id, integration_account_id, pipeline_id, id),
  CONSTRAINT commerce_product_candidates_run_variant_unique
    UNIQUE (run_id, external_variant_id),
  CONSTRAINT commerce_product_candidates_external_ids_valid CHECK (
    length(btrim(external_product_id)) BETWEEN 1 AND 512
    AND external_product_id !~ '[[:cntrl:]]'
    AND length(btrim(external_variant_id)) BETWEEN 1 AND 512
    AND external_variant_id !~ '[[:cntrl:]]'
    AND (
      external_inventory_item_id IS NULL
      OR (
        length(btrim(external_inventory_item_id)) BETWEEN 1 AND 512
        AND external_inventory_item_id !~ '[[:cntrl:]]'
      )
    )
  ),
  CONSTRAINT commerce_product_candidates_snapshots_valid CHECK (
    length(btrim(product_title_snapshot)) BETWEEN 1 AND 500
    AND product_title_snapshot !~ '[[:cntrl:]]'
    AND (
      sku_snapshot IS NULL
      OR (
        length(sku_snapshot) <= 255
        AND sku_snapshot !~ '[[:cntrl:]]'
      )
    )
    AND (
      barcode_snapshot IS NULL
      OR (
        length(barcode_snapshot) <= 255
        AND barcode_snapshot !~ '[[:cntrl:]]'
      )
    )
    AND jsonb_typeof(normalized_options) = 'array'
    AND jsonb_array_length(normalized_options) <= 25
    AND octet_length(convert_to(normalized_options::text, 'UTF8')) <= 16384
  ),
  CONSTRAINT commerce_product_candidates_status_raw_valid CHECK (
    length(btrim(provider_status_raw)) BETWEEN 1 AND 255
    AND provider_status_raw !~ '[[:cntrl:]]'
  ),
  CONSTRAINT commerce_product_candidates_money_valid CHECK (
    (
      currency_code IS NULL
      AND price_minor IS NULL
      AND compare_at_price_minor IS NULL
    )
    OR (
      currency_code IS NOT NULL
      AND currency_code ~ '^[A-Z]{3}$'
      AND price_minor IS NOT NULL
      AND price_minor >= 0
      AND (
        compare_at_price_minor IS NULL
        OR compare_at_price_minor >= 0
      )
    )
  ),
  CONSTRAINT commerce_product_candidates_quantity_valid CHECK (
    inventory_quantity IS NULL OR inventory_quantity >= 0
  ),
  CONSTRAINT commerce_product_candidates_weight_valid CHECK (
    weight_grams IS NULL OR weight_grams > 0
  ),
  CONSTRAINT commerce_product_candidates_source_valid CHECK (
    length(btrim(source_revision)) BETWEEN 1 AND 512
    AND source_revision !~ '[[:cntrl:]]'
    AND length(btrim(provider_api_version)) BETWEEN 1 AND 64
    AND length(btrim(normalizer_version)) BETWEEN 1 AND 128
  ),
  CONSTRAINT commerce_product_candidates_mapping_valid CHECK (
    product_mapping_id IS NULL OR product_id IS NOT NULL
  ),
  CONSTRAINT commerce_product_candidates_ready_valid CHECK (
    workflow_state NOT IN ('ready', 'promoted')
    OR (
      mapping_state = 'resolved'
      AND product_id IS NOT NULL
      AND product_mapping_id IS NOT NULL
      AND unsupported_reason_code IS NULL
      AND cardinality(blocking_codes) = 0
    )
  ),
  CONSTRAINT commerce_product_candidates_unsupported_valid CHECK (
    mapping_state <> 'unsupported'
    OR (
      unsupported_reason_code IS NOT NULL
      AND length(btrim(unsupported_reason_code)) BETWEEN 1 AND 128
    )
  ),
  CONSTRAINT commerce_product_candidates_retention_valid CHECK (
    expires_at > created_at
    AND expires_at <= created_at + interval '30 days'
  )
);

CREATE INDEX IF NOT EXISTS commerce_product_candidates_workflow_idx
  ON operations_commerce_product_candidates (
    organization_id, workflow_state, updated_at DESC, id
  );

CREATE INDEX IF NOT EXISTS commerce_product_candidates_identity_idx
  ON operations_commerce_product_candidates (
    organization_id, integration_account_id, external_variant_id,
    observed_at DESC, id
  );

CREATE INDEX IF NOT EXISTS commerce_product_candidates_mapping_idx
  ON operations_commerce_product_candidates (
    organization_id, mapping_state, sku_snapshot, id
  )
  WHERE workflow_state IN ('held', 'resolving');

CREATE INDEX IF NOT EXISTS commerce_product_candidates_expiry_idx
  ON operations_commerce_product_candidates (expires_at, id)
  WHERE workflow_state <> 'promoted';

CREATE OR REPLACE FUNCTION protect_operations_commerce_product_candidate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    NEW.global_id,
    NEW.organization_id,
    NEW.integration_account_id,
    NEW.pipeline_id,
    NEW.run_id,
    NEW.provider,
    NEW.external_product_id,
    NEW.external_variant_id,
    NEW.external_inventory_item_id,
    NEW.sku_snapshot,
    NEW.barcode_snapshot,
    NEW.product_title_snapshot,
    NEW.variant_title_snapshot,
    NEW.vendor_snapshot,
    NEW.product_type_snapshot,
    NEW.normalized_options,
    NEW.provider_status_raw,
    NEW.normalized_status,
    NEW.unit_multiplier,
    NEW.currency_code,
    NEW.price_minor,
    NEW.compare_at_price_minor,
    NEW.taxable,
    NEW.requires_shipping,
    NEW.inventory_quantity,
    NEW.weight_grams,
    NEW.provider_created_at,
    NEW.provider_updated_at,
    NEW.observed_at,
    NEW.source_revision,
    NEW.source_hash,
    NEW.provider_api_version,
    NEW.normalizer_version,
    NEW.schema_version,
    NEW.created_by,
    NEW.created_at,
    NEW.expires_at
  ) IS DISTINCT FROM ROW(
    OLD.global_id,
    OLD.organization_id,
    OLD.integration_account_id,
    OLD.pipeline_id,
    OLD.run_id,
    OLD.provider,
    OLD.external_product_id,
    OLD.external_variant_id,
    OLD.external_inventory_item_id,
    OLD.sku_snapshot,
    OLD.barcode_snapshot,
    OLD.product_title_snapshot,
    OLD.variant_title_snapshot,
    OLD.vendor_snapshot,
    OLD.product_type_snapshot,
    OLD.normalized_options,
    OLD.provider_status_raw,
    OLD.normalized_status,
    OLD.unit_multiplier,
    OLD.currency_code,
    OLD.price_minor,
    OLD.compare_at_price_minor,
    OLD.taxable,
    OLD.requires_shipping,
    OLD.inventory_quantity,
    OLD.weight_grams,
    OLD.provider_created_at,
    OLD.provider_updated_at,
    OLD.observed_at,
    OLD.source_revision,
    OLD.source_hash,
    OLD.provider_api_version,
    OLD.normalizer_version,
    OLD.schema_version,
    OLD.created_by,
    OLD.created_at,
    OLD.expires_at
  ) THEN
    RAISE EXCEPTION 'Commerce product candidate source is immutable';
  END IF;
  IF NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION
      'Commerce product candidate update requires the next row version';
  END IF;
  IF NOT operations_commerce_workflow_transition_valid(
    OLD.workflow_state, NEW.workflow_state
  ) THEN
    RAISE EXCEPTION 'Invalid commerce product candidate workflow transition';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_operations_commerce_product_candidate
  ON operations_commerce_product_candidates;
CREATE TRIGGER protect_operations_commerce_product_candidate
BEFORE UPDATE ON operations_commerce_product_candidates
FOR EACH ROW EXECUTE FUNCTION
  protect_operations_commerce_product_candidate();

CREATE TABLE IF NOT EXISTS operations_commerce_order_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gcoc'),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  pipeline_id uuid NOT NULL,
  run_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('shopify', 'faire')),
  external_order_id text NOT NULL,
  order_number_snapshot text NOT NULL,
  source_channel text,
  provider_order_status_raw text NOT NULL,
  provider_financial_status_raw text NOT NULL,
  provider_fulfillment_status_raw text NOT NULL,
  provider_return_status_raw text NOT NULL,
  normalized_order_status text NOT NULL DEFAULT 'unknown'
    CHECK (normalized_order_status IN (
      'open', 'cancelled', 'fulfilled', 'closed', 'unknown'
    )),
  normalized_payment_status text NOT NULL DEFAULT 'unknown'
    CHECK (normalized_payment_status IN (
      'unpaid', 'pending', 'authorized', 'partially_paid', 'paid',
      'partially_refunded', 'refunded', 'voided', 'unknown'
    )),
  normalized_fulfillment_status text NOT NULL DEFAULT 'unknown'
    CHECK (normalized_fulfillment_status IN (
      'unfulfilled', 'partial', 'fulfilled', 'cancelled', 'unknown'
    )),
  normalized_return_status text NOT NULL DEFAULT 'unknown'
    CHECK (normalized_return_status IN (
      'none', 'requested', 'in_progress', 'partial', 'returned',
      'unavailable', 'unknown'
    )),
  test_order boolean NOT NULL DEFAULT false,
  requires_shipping boolean NOT NULL DEFAULT true,
  currency_code text NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  subtotal_minor bigint NOT NULL CHECK (subtotal_minor >= 0),
  discount_minor bigint NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  brand_discount_minor bigint NOT NULL DEFAULT 0
    CHECK (brand_discount_minor >= 0),
  shipping_minor bigint NOT NULL DEFAULT 0 CHECK (shipping_minor >= 0),
  tax_minor bigint NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  other_adjustment_minor bigint NOT NULL DEFAULT 0,
  total_minor bigint NOT NULL CHECK (total_minor >= 0),
  presentment_currency_code text,
  presentment_subtotal_minor bigint,
  presentment_discount_minor bigint,
  presentment_brand_discount_minor bigint,
  presentment_shipping_minor bigint,
  presentment_tax_minor bigint,
  presentment_other_adjustment_minor bigint,
  presentment_total_minor bigint,
  merchant_payout_currency_code text,
  merchant_payout_minor bigint,
  party_kind text NOT NULL DEFAULT 'unknown'
    CHECK (party_kind IN ('consumer', 'retailer', 'business', 'unknown')),
  party_snapshot_state text NOT NULL DEFAULT 'missing'
    CHECK (party_snapshot_state IN ('missing', 'redacted', 'protected')),
  party_snapshot_ciphertext bytea,
  party_snapshot_iv bytea,
  party_snapshot_tag bytea,
  party_snapshot_hash text,
  party_snapshot_encryption_version integer,
  customer_resolution_state text NOT NULL DEFAULT 'unresolved'
    CHECK (customer_resolution_state IN (
      'unresolved', 'suggested', 'resolved', 'unsupported'
    )),
  customer_match_method text,
  customer_id uuid,
  ship_to_snapshot_state text NOT NULL DEFAULT 'missing'
    CHECK (ship_to_snapshot_state IN (
      'missing', 'redacted', 'protected', 'confirmed'
    )),
  ship_to_snapshot_source text NOT NULL DEFAULT 'none'
    CHECK (ship_to_snapshot_source IN ('none', 'provider', 'manual')),
  ship_to_snapshot_ciphertext bytea,
  ship_to_snapshot_iv bytea,
  ship_to_snapshot_tag bytea,
  ship_to_snapshot_hash text,
  ship_to_snapshot_encryption_version integer,
  delivery_resolution_state text NOT NULL DEFAULT 'unresolved'
    CHECK (delivery_resolution_state IN (
      'unresolved', 'provider', 'manual', 'policy', 'not_required'
    )),
  provider_requested_delivery_at timestamptz,
  requested_delivery_at timestamptz,
  delivery_policy_version text,
  provider_created_at timestamptz,
  provider_processed_at timestamptz,
  provider_updated_at timestamptz,
  provider_cancelled_at timestamptz,
  provider_closed_at timestamptz,
  observed_at timestamptz NOT NULL,
  source_revision text NOT NULL,
  source_hash text NOT NULL CHECK (source_hash ~ '^[a-f0-9]{64}$'),
  provider_api_version text NOT NULL,
  normalizer_version text NOT NULL,
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  workflow_state text NOT NULL DEFAULT 'held'
    CHECK (workflow_state IN (
      'held', 'resolving', 'ready', 'promoted', 'failed', 'expired'
    )),
  blocking_codes text[] NOT NULL DEFAULT '{}'::text[]
    CHECK (operations_commerce_code_list_valid(blocking_codes)),
  unsupported_reason_code text,
  unsupported_reason_detail text,
  last_error_code text,
  canonical_order_id uuid,
  promotion_command_receipt_id uuid,
  promotion_idempotency_key text,
  promotion_request_hash text,
  promoted_at timestamptz,
  row_version bigint NOT NULL DEFAULT 0 CHECK (row_version >= 0),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT commerce_order_candidates_global_valid
    CHECK (global_id ~ '^gcoc[0-9]{7}$'),
  CONSTRAINT commerce_order_candidates_global_unique UNIQUE (global_id),
  CONSTRAINT commerce_order_candidates_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT commerce_order_candidates_run_fkey
    FOREIGN KEY (
      organization_id, integration_account_id, pipeline_id, run_id
    )
    REFERENCES operations_commerce_intake_runs(
      organization_id, integration_account_id, pipeline_id, id
    ) ON DELETE CASCADE,
  CONSTRAINT commerce_order_candidates_customer_fkey
    FOREIGN KEY (pipeline_id, customer_id)
    REFERENCES crm_organizations(pipeline_id, id) ON DELETE RESTRICT,
  CONSTRAINT commerce_order_candidates_order_fkey
    FOREIGN KEY (organization_id, canonical_order_id)
    REFERENCES operations_orders(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT commerce_order_candidates_receipt_fkey
    FOREIGN KEY (organization_id, promotion_command_receipt_id)
    REFERENCES operations_command_receipts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT commerce_order_candidates_scope_id_unique
    UNIQUE (
      organization_id, integration_account_id, pipeline_id, run_id, id
    ),
  CONSTRAINT commerce_order_candidates_run_order_unique
    UNIQUE (run_id, external_order_id),
  CONSTRAINT commerce_order_candidates_order_unique
    UNIQUE (organization_id, canonical_order_id),
  CONSTRAINT commerce_order_candidates_external_valid CHECK (
    length(btrim(external_order_id)) BETWEEN 1 AND 512
    AND external_order_id !~ '[[:cntrl:]]'
    AND length(btrim(order_number_snapshot)) BETWEEN 1 AND 255
    AND order_number_snapshot !~ '[[:cntrl:]]'
  ),
  CONSTRAINT commerce_order_candidates_raw_statuses_valid CHECK (
    length(btrim(provider_order_status_raw)) BETWEEN 1 AND 255
    AND provider_order_status_raw !~ '[[:cntrl:]]'
    AND length(btrim(provider_financial_status_raw)) BETWEEN 1 AND 255
    AND provider_financial_status_raw !~ '[[:cntrl:]]'
    AND length(btrim(provider_fulfillment_status_raw)) BETWEEN 1 AND 255
    AND provider_fulfillment_status_raw !~ '[[:cntrl:]]'
    AND length(btrim(provider_return_status_raw)) BETWEEN 1 AND 255
    AND provider_return_status_raw !~ '[[:cntrl:]]'
  ),
  CONSTRAINT commerce_order_candidates_money_valid CHECK (
    total_minor = subtotal_minor
      - discount_minor
      - brand_discount_minor
      + shipping_minor
      + tax_minor
      + other_adjustment_minor
  ),
  CONSTRAINT commerce_order_candidates_presentment_valid CHECK (
    (
      presentment_currency_code IS NULL
      AND presentment_subtotal_minor IS NULL
      AND presentment_discount_minor IS NULL
      AND presentment_brand_discount_minor IS NULL
      AND presentment_shipping_minor IS NULL
      AND presentment_tax_minor IS NULL
      AND presentment_other_adjustment_minor IS NULL
      AND presentment_total_minor IS NULL
    )
    OR (
      presentment_currency_code IS NOT NULL
      AND presentment_currency_code ~ '^[A-Z]{3}$'
      AND presentment_subtotal_minor IS NOT NULL
      AND presentment_subtotal_minor >= 0
      AND presentment_discount_minor IS NOT NULL
      AND presentment_discount_minor >= 0
      AND presentment_brand_discount_minor IS NOT NULL
      AND presentment_brand_discount_minor >= 0
      AND presentment_shipping_minor IS NOT NULL
      AND presentment_shipping_minor >= 0
      AND presentment_tax_minor IS NOT NULL
      AND presentment_tax_minor >= 0
      AND presentment_other_adjustment_minor IS NOT NULL
      AND presentment_total_minor IS NOT NULL
      AND presentment_total_minor >= 0
      AND presentment_total_minor = presentment_subtotal_minor
        - presentment_discount_minor
        - presentment_brand_discount_minor
        + presentment_shipping_minor
        + presentment_tax_minor
        + presentment_other_adjustment_minor
    )
  ),
  CONSTRAINT commerce_order_candidates_payout_valid CHECK (
    (
      merchant_payout_currency_code IS NULL
      AND merchant_payout_minor IS NULL
    )
    OR (
      merchant_payout_currency_code IS NOT NULL
      AND merchant_payout_currency_code ~ '^[A-Z]{3}$'
      AND merchant_payout_minor IS NOT NULL
      AND merchant_payout_minor >= 0
    )
  ),
  CONSTRAINT commerce_order_candidates_party_snapshot_valid CHECK (
    operations_commerce_protected_snapshot_valid(
      party_snapshot_state,
      party_snapshot_ciphertext,
      party_snapshot_iv,
      party_snapshot_tag,
      party_snapshot_hash,
      party_snapshot_encryption_version
    )
  ),
  CONSTRAINT commerce_order_candidates_customer_valid CHECK (
    (
      customer_resolution_state = 'resolved'
      AND customer_id IS NOT NULL
      AND customer_match_method IS NOT NULL
      AND length(btrim(customer_match_method)) BETWEEN 1 AND 128
    )
    OR (
      customer_resolution_state <> 'resolved'
      AND customer_id IS NULL
    )
  ),
  CONSTRAINT commerce_order_candidates_ship_to_snapshot_valid CHECK (
    operations_commerce_protected_snapshot_valid(
      ship_to_snapshot_state,
      ship_to_snapshot_ciphertext,
      ship_to_snapshot_iv,
      ship_to_snapshot_tag,
      ship_to_snapshot_hash,
      ship_to_snapshot_encryption_version
    )
    AND (
      (ship_to_snapshot_state = 'missing'
        AND ship_to_snapshot_source = 'none')
      OR (ship_to_snapshot_state = 'redacted'
        AND ship_to_snapshot_source = 'provider')
      OR (ship_to_snapshot_state = 'protected'
        AND ship_to_snapshot_source = 'provider')
      OR (ship_to_snapshot_state = 'confirmed'
        AND ship_to_snapshot_source IN ('provider', 'manual'))
    )
  ),
  CONSTRAINT commerce_order_candidates_delivery_valid CHECK (
    (
      delivery_resolution_state = 'provider'
      AND provider_requested_delivery_at IS NOT NULL
      AND requested_delivery_at = provider_requested_delivery_at
    )
    OR (
      delivery_resolution_state IN ('manual', 'policy')
      AND requested_delivery_at IS NOT NULL
    )
    OR (
      delivery_resolution_state = 'not_required'
      AND requires_shipping = false
      AND requested_delivery_at IS NULL
    )
    OR (
      delivery_resolution_state = 'unresolved'
      AND requested_delivery_at IS NULL
    )
  ),
  CONSTRAINT commerce_order_candidates_source_valid CHECK (
    length(btrim(source_revision)) BETWEEN 1 AND 512
    AND source_revision !~ '[[:cntrl:]]'
    AND length(btrim(provider_api_version)) BETWEEN 1 AND 64
    AND length(btrim(normalizer_version)) BETWEEN 1 AND 128
  ),
  CONSTRAINT commerce_order_candidates_ready_valid CHECK (
    workflow_state NOT IN ('ready', 'promoted')
    OR (
      customer_resolution_state = 'resolved'
      AND customer_id IS NOT NULL
      AND (
        (requires_shipping = true
          AND ship_to_snapshot_state = 'confirmed')
        OR requires_shipping = false
      )
      AND delivery_resolution_state IN (
        'provider', 'manual', 'policy', 'not_required'
      )
      AND unsupported_reason_code IS NULL
      AND cardinality(blocking_codes) = 0
    )
  ),
  CONSTRAINT commerce_order_candidates_promotion_valid CHECK (
    (
      workflow_state = 'promoted'
      AND canonical_order_id IS NOT NULL
      AND promotion_command_receipt_id IS NOT NULL
      AND promotion_idempotency_key IS NOT NULL
      AND length(btrim(promotion_idempotency_key)) BETWEEN 1 AND 255
      AND promotion_request_hash IS NOT NULL
      AND promotion_request_hash ~ '^[a-f0-9]{64}$'
      AND promoted_at IS NOT NULL
    )
    OR (
      workflow_state <> 'promoted'
      AND canonical_order_id IS NULL
      AND promotion_command_receipt_id IS NULL
      AND promotion_idempotency_key IS NULL
      AND promotion_request_hash IS NULL
      AND promoted_at IS NULL
    )
  ),
  CONSTRAINT commerce_order_candidates_unsupported_valid CHECK (
    customer_resolution_state <> 'unsupported'
    OR (
      unsupported_reason_code IS NOT NULL
      AND length(btrim(unsupported_reason_code)) BETWEEN 1 AND 128
    )
  ),
  CONSTRAINT commerce_order_candidates_retention_valid CHECK (
    expires_at > created_at
    AND expires_at <= created_at + interval '30 days'
  )
);

CREATE INDEX IF NOT EXISTS commerce_order_candidates_workflow_idx
  ON operations_commerce_order_candidates (
    organization_id, workflow_state, updated_at DESC, id
  );

CREATE INDEX IF NOT EXISTS commerce_order_candidates_identity_idx
  ON operations_commerce_order_candidates (
    organization_id, integration_account_id, external_order_id,
    observed_at DESC, id
  );

CREATE INDEX IF NOT EXISTS commerce_order_candidates_resolution_idx
  ON operations_commerce_order_candidates (
    organization_id, customer_resolution_state,
    ship_to_snapshot_state, delivery_resolution_state, id
  )
  WHERE workflow_state IN ('held', 'resolving');

CREATE INDEX IF NOT EXISTS commerce_order_candidates_expiry_idx
  ON operations_commerce_order_candidates (expires_at, id)
  WHERE workflow_state <> 'promoted';

CREATE OR REPLACE FUNCTION protect_operations_commerce_order_candidate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    NEW.global_id,
    NEW.organization_id,
    NEW.integration_account_id,
    NEW.pipeline_id,
    NEW.run_id,
    NEW.provider,
    NEW.external_order_id,
    NEW.order_number_snapshot,
    NEW.source_channel,
    NEW.provider_order_status_raw,
    NEW.provider_financial_status_raw,
    NEW.provider_fulfillment_status_raw,
    NEW.provider_return_status_raw,
    NEW.normalized_order_status,
    NEW.normalized_payment_status,
    NEW.normalized_fulfillment_status,
    NEW.normalized_return_status,
    NEW.test_order,
    NEW.requires_shipping,
    NEW.currency_code,
    NEW.subtotal_minor,
    NEW.discount_minor,
    NEW.brand_discount_minor,
    NEW.shipping_minor,
    NEW.tax_minor,
    NEW.other_adjustment_minor,
    NEW.total_minor,
    NEW.presentment_currency_code,
    NEW.presentment_subtotal_minor,
    NEW.presentment_discount_minor,
    NEW.presentment_brand_discount_minor,
    NEW.presentment_shipping_minor,
    NEW.presentment_tax_minor,
    NEW.presentment_other_adjustment_minor,
    NEW.presentment_total_minor,
    NEW.merchant_payout_currency_code,
    NEW.merchant_payout_minor,
    NEW.party_kind,
    NEW.party_snapshot_state,
    NEW.party_snapshot_ciphertext,
    NEW.party_snapshot_iv,
    NEW.party_snapshot_tag,
    NEW.party_snapshot_hash,
    NEW.party_snapshot_encryption_version,
    NEW.provider_requested_delivery_at,
    NEW.provider_created_at,
    NEW.provider_processed_at,
    NEW.provider_updated_at,
    NEW.provider_cancelled_at,
    NEW.provider_closed_at,
    NEW.observed_at,
    NEW.source_revision,
    NEW.source_hash,
    NEW.provider_api_version,
    NEW.normalizer_version,
    NEW.schema_version,
    NEW.created_by,
    NEW.created_at,
    NEW.expires_at
  ) IS DISTINCT FROM ROW(
    OLD.global_id,
    OLD.organization_id,
    OLD.integration_account_id,
    OLD.pipeline_id,
    OLD.run_id,
    OLD.provider,
    OLD.external_order_id,
    OLD.order_number_snapshot,
    OLD.source_channel,
    OLD.provider_order_status_raw,
    OLD.provider_financial_status_raw,
    OLD.provider_fulfillment_status_raw,
    OLD.provider_return_status_raw,
    OLD.normalized_order_status,
    OLD.normalized_payment_status,
    OLD.normalized_fulfillment_status,
    OLD.normalized_return_status,
    OLD.test_order,
    OLD.requires_shipping,
    OLD.currency_code,
    OLD.subtotal_minor,
    OLD.discount_minor,
    OLD.brand_discount_minor,
    OLD.shipping_minor,
    OLD.tax_minor,
    OLD.other_adjustment_minor,
    OLD.total_minor,
    OLD.presentment_currency_code,
    OLD.presentment_subtotal_minor,
    OLD.presentment_discount_minor,
    OLD.presentment_brand_discount_minor,
    OLD.presentment_shipping_minor,
    OLD.presentment_tax_minor,
    OLD.presentment_other_adjustment_minor,
    OLD.presentment_total_minor,
    OLD.merchant_payout_currency_code,
    OLD.merchant_payout_minor,
    OLD.party_kind,
    OLD.party_snapshot_state,
    OLD.party_snapshot_ciphertext,
    OLD.party_snapshot_iv,
    OLD.party_snapshot_tag,
    OLD.party_snapshot_hash,
    OLD.party_snapshot_encryption_version,
    OLD.provider_requested_delivery_at,
    OLD.provider_created_at,
    OLD.provider_processed_at,
    OLD.provider_updated_at,
    OLD.provider_cancelled_at,
    OLD.provider_closed_at,
    OLD.observed_at,
    OLD.source_revision,
    OLD.source_hash,
    OLD.provider_api_version,
    OLD.normalizer_version,
    OLD.schema_version,
    OLD.created_by,
    OLD.created_at,
    OLD.expires_at
  ) THEN
    RAISE EXCEPTION 'Commerce order candidate provider source is immutable';
  END IF;
  IF NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION
      'Commerce order candidate update requires the next row version';
  END IF;
  IF NOT operations_commerce_workflow_transition_valid(
    OLD.workflow_state, NEW.workflow_state
  ) THEN
    RAISE EXCEPTION 'Invalid commerce order candidate workflow transition';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_operations_commerce_order_candidate
  ON operations_commerce_order_candidates;
CREATE TRIGGER protect_operations_commerce_order_candidate
BEFORE UPDATE ON operations_commerce_order_candidates
FOR EACH ROW EXECUTE FUNCTION
  protect_operations_commerce_order_candidate();

CREATE TABLE IF NOT EXISTS operations_commerce_order_candidate_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gcol'),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  pipeline_id uuid NOT NULL,
  run_id uuid NOT NULL,
  order_candidate_id uuid NOT NULL,
  product_candidate_id uuid,
  provider text NOT NULL CHECK (provider IN ('shopify', 'faire')),
  external_line_id text NOT NULL,
  external_product_id text,
  external_variant_id text,
  external_inventory_item_id text,
  sku_snapshot text,
  barcode_snapshot text,
  product_title_snapshot text NOT NULL,
  variant_title_snapshot text,
  provider_status_raw text NOT NULL,
  normalized_status text NOT NULL DEFAULT 'unknown'
    CHECK (normalized_status IN (
      'open', 'cancelled', 'fulfilled', 'returned', 'unknown'
    )),
  ordered_quantity numeric(20,6) NOT NULL CHECK (ordered_quantity > 0),
  current_quantity numeric(20,6) NOT NULL CHECK (current_quantity >= 0),
  cancelled_quantity numeric(20,6) NOT NULL DEFAULT 0
    CHECK (cancelled_quantity >= 0),
  fulfilled_quantity numeric(20,6) NOT NULL DEFAULT 0
    CHECK (fulfilled_quantity >= 0),
  unfulfilled_quantity numeric(20,6) NOT NULL DEFAULT 0
    CHECK (unfulfilled_quantity >= 0),
  returned_quantity numeric(20,6) NOT NULL DEFAULT 0
    CHECK (returned_quantity >= 0),
  unit_multiplier numeric(20,6) NOT NULL DEFAULT 1
    CHECK (unit_multiplier > 0),
  physical_quantity numeric(20,6) NOT NULL
    CHECK (physical_quantity > 0),
  -- Provider-observed money is immutable and nullable when the provider did
  -- not expose an exact order-time price. Missing money is never coerced to 0.
  currency_code text,
  unit_price_minor bigint,
  subtotal_minor bigint,
  discount_minor bigint,
  brand_discount_minor bigint,
  tax_minor bigint,
  other_adjustment_minor bigint,
  total_minor bigint,
  -- Resolution copies the exact provider unit price or records an explicit
  -- manual unit price. Optional breakdown fields are all-or-none; promotion
  -- never invents line discount or tax values.
  price_resolution_state text NOT NULL DEFAULT 'unresolved'
    CHECK (price_resolution_state IN (
      'unresolved', 'provider', 'manual', 'unsupported'
    )),
  resolved_currency_code text,
  resolved_unit_price_minor bigint,
  resolved_subtotal_minor bigint,
  resolved_discount_minor bigint,
  resolved_brand_discount_minor bigint,
  resolved_tax_minor bigint,
  resolved_other_adjustment_minor bigint,
  resolved_total_minor bigint,
  taxable boolean,
  requires_shipping boolean NOT NULL DEFAULT true,
  mapping_state text NOT NULL DEFAULT 'unresolved'
    CHECK (mapping_state IN (
      'unresolved', 'suggested', 'resolved', 'not_required', 'unsupported'
    )),
  product_id uuid,
  product_mapping_id uuid,
  packaging_state text NOT NULL DEFAULT 'unresolved'
    CHECK (packaging_state IN (
      'unresolved', 'resolved', 'not_required', 'unsupported'
    )),
  package_profile_id uuid,
  packaging_source text NOT NULL DEFAULT 'none'
    CHECK (packaging_source IN ('none', 'profile', 'provider', 'manual')),
  weight_grams integer,
  length_mm integer,
  width_mm integer,
  height_mm integer,
  provider_created_at timestamptz,
  provider_updated_at timestamptz,
  observed_at timestamptz NOT NULL,
  source_revision text NOT NULL,
  source_hash text NOT NULL CHECK (source_hash ~ '^[a-f0-9]{64}$'),
  provider_api_version text NOT NULL,
  normalizer_version text NOT NULL,
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  workflow_state text NOT NULL DEFAULT 'held'
    CHECK (workflow_state IN (
      'held', 'resolving', 'ready', 'promoted', 'failed', 'expired'
    )),
  blocking_codes text[] NOT NULL DEFAULT '{}'::text[]
    CHECK (operations_commerce_code_list_valid(blocking_codes)),
  unsupported_reason_code text,
  unsupported_reason_detail text,
  last_error_code text,
  canonical_order_line_id uuid,
  promoted_at timestamptz,
  row_version bigint NOT NULL DEFAULT 0 CHECK (row_version >= 0),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT commerce_order_lines_global_valid
    CHECK (global_id ~ '^gcol[0-9]{7}$'),
  CONSTRAINT commerce_order_lines_global_unique UNIQUE (global_id),
  CONSTRAINT commerce_order_lines_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT commerce_order_lines_order_candidate_fkey
    FOREIGN KEY (
      organization_id, integration_account_id, pipeline_id, run_id,
      order_candidate_id
    )
    REFERENCES operations_commerce_order_candidates(
      organization_id, integration_account_id, pipeline_id, run_id, id
    ) ON DELETE CASCADE,
  CONSTRAINT commerce_order_lines_product_candidate_fkey
    FOREIGN KEY (
      organization_id, integration_account_id, pipeline_id,
      product_candidate_id
    )
    REFERENCES operations_commerce_product_candidates(
      organization_id, integration_account_id, pipeline_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT commerce_order_lines_product_fkey
    FOREIGN KEY (pipeline_id, product_id)
    REFERENCES crm_products(pipeline_id, id) ON DELETE RESTRICT,
  CONSTRAINT commerce_order_lines_mapping_fkey
    FOREIGN KEY (
      organization_id, integration_account_id, pipeline_id,
      product_mapping_id, product_id
    )
    REFERENCES operations_product_mappings(
      organization_id, integration_account_id, pipeline_id, id, product_id
    ) ON DELETE RESTRICT,
  CONSTRAINT commerce_order_lines_package_fkey
    FOREIGN KEY (
      organization_id, pipeline_id, product_id, package_profile_id
    )
    REFERENCES operations_product_package_profiles(
      organization_id, pipeline_id, product_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT commerce_order_lines_canonical_line_fkey
    FOREIGN KEY (organization_id, canonical_order_line_id)
    REFERENCES operations_order_lines(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT commerce_order_lines_scope_id_unique
    UNIQUE (organization_id, integration_account_id, pipeline_id, id),
  CONSTRAINT commerce_order_lines_external_unique
    UNIQUE (order_candidate_id, external_line_id),
  CONSTRAINT commerce_order_lines_canonical_unique
    UNIQUE (organization_id, canonical_order_line_id),
  CONSTRAINT commerce_order_lines_external_valid CHECK (
    length(btrim(external_line_id)) BETWEEN 1 AND 512
    AND external_line_id !~ '[[:cntrl:]]'
    AND (
      external_product_id IS NULL
      OR (
        length(btrim(external_product_id)) BETWEEN 1 AND 512
        AND external_product_id !~ '[[:cntrl:]]'
      )
    )
    AND (
      external_variant_id IS NULL
      OR (
        length(btrim(external_variant_id)) BETWEEN 1 AND 512
        AND external_variant_id !~ '[[:cntrl:]]'
      )
    )
    AND (
      external_inventory_item_id IS NULL
      OR (
        length(btrim(external_inventory_item_id)) BETWEEN 1 AND 512
        AND external_inventory_item_id !~ '[[:cntrl:]]'
      )
    )
  ),
  CONSTRAINT commerce_order_lines_snapshots_valid CHECK (
    length(btrim(product_title_snapshot)) BETWEEN 1 AND 500
    AND product_title_snapshot !~ '[[:cntrl:]]'
    AND (
      sku_snapshot IS NULL
      OR (
        length(sku_snapshot) <= 255
        AND sku_snapshot !~ '[[:cntrl:]]'
      )
    )
    AND (
      barcode_snapshot IS NULL
      OR (
        length(barcode_snapshot) <= 255
        AND barcode_snapshot !~ '[[:cntrl:]]'
      )
    )
    AND length(btrim(provider_status_raw)) BETWEEN 1 AND 255
    AND provider_status_raw !~ '[[:cntrl:]]'
  ),
  CONSTRAINT commerce_order_lines_quantities_valid CHECK (
    current_quantity <= ordered_quantity
    AND cancelled_quantity <= ordered_quantity
    AND fulfilled_quantity <= ordered_quantity
    AND unfulfilled_quantity <= ordered_quantity
    AND returned_quantity <= ordered_quantity
  ),
  CONSTRAINT commerce_order_lines_provider_money_valid CHECK (
    (
      currency_code IS NULL
      AND unit_price_minor IS NULL
      AND subtotal_minor IS NULL
      AND discount_minor IS NULL
      AND brand_discount_minor IS NULL
      AND tax_minor IS NULL
      AND other_adjustment_minor IS NULL
      AND total_minor IS NULL
    )
    OR (
      currency_code IS NOT NULL
      AND currency_code ~ '^[A-Z]{3}$'
      AND (unit_price_minor IS NULL OR unit_price_minor >= 0)
      AND (subtotal_minor IS NULL OR subtotal_minor >= 0)
      AND (discount_minor IS NULL OR discount_minor >= 0)
      AND (brand_discount_minor IS NULL OR brand_discount_minor >= 0)
      AND (tax_minor IS NULL OR tax_minor >= 0)
      AND (total_minor IS NULL OR total_minor >= 0)
      AND (
        total_minor IS NULL
        OR subtotal_minor IS NULL
        OR discount_minor IS NULL
        OR brand_discount_minor IS NULL
        OR tax_minor IS NULL
        OR other_adjustment_minor IS NULL
        OR total_minor = subtotal_minor
          - discount_minor
          - brand_discount_minor
          + tax_minor
          + other_adjustment_minor
      )
    )
  ),
  CONSTRAINT commerce_order_lines_resolved_money_valid CHECK (
    (
      price_resolution_state IN ('unresolved', 'unsupported')
      AND resolved_currency_code IS NULL
      AND resolved_unit_price_minor IS NULL
      AND resolved_subtotal_minor IS NULL
      AND resolved_discount_minor IS NULL
      AND resolved_brand_discount_minor IS NULL
      AND resolved_tax_minor IS NULL
      AND resolved_other_adjustment_minor IS NULL
      AND resolved_total_minor IS NULL
    )
    OR (
      price_resolution_state IN ('provider', 'manual')
      AND resolved_currency_code IS NOT NULL
      AND resolved_currency_code ~ '^[A-Z]{3}$'
      AND resolved_unit_price_minor IS NOT NULL
      AND resolved_unit_price_minor >= 0
      AND (
        (
          resolved_subtotal_minor IS NULL
          AND resolved_discount_minor IS NULL
          AND resolved_brand_discount_minor IS NULL
          AND resolved_tax_minor IS NULL
          AND resolved_other_adjustment_minor IS NULL
          AND resolved_total_minor IS NULL
        )
        OR (
          resolved_subtotal_minor IS NOT NULL
          AND resolved_subtotal_minor >= 0
          AND resolved_discount_minor IS NOT NULL
          AND resolved_discount_minor >= 0
          AND resolved_brand_discount_minor IS NOT NULL
          AND resolved_brand_discount_minor >= 0
          AND resolved_tax_minor IS NOT NULL
          AND resolved_tax_minor >= 0
          AND resolved_other_adjustment_minor IS NOT NULL
          AND resolved_total_minor IS NOT NULL
          AND resolved_total_minor >= 0
          AND resolved_total_minor = resolved_subtotal_minor
            - resolved_discount_minor
            - resolved_brand_discount_minor
            + resolved_tax_minor
            + resolved_other_adjustment_minor
        )
      )
    )
  ),
  CONSTRAINT commerce_order_lines_provider_price_copy_valid CHECK (
    price_resolution_state <> 'provider'
    OR (
      currency_code IS NOT NULL
      AND unit_price_minor IS NOT NULL
      AND resolved_currency_code = currency_code
      AND resolved_unit_price_minor = unit_price_minor
    )
  ),
  CONSTRAINT commerce_order_lines_price_block_valid CHECK (
    price_resolution_state <> 'unresolved'
    OR 'line_price_required' = ANY(blocking_codes)
  ),
  CONSTRAINT commerce_order_lines_mapping_valid CHECK (
    product_mapping_id IS NULL OR product_id IS NOT NULL
  ),
  CONSTRAINT commerce_order_lines_dimensions_valid CHECK (
    (
      weight_grams IS NULL
      AND length_mm IS NULL
      AND width_mm IS NULL
      AND height_mm IS NULL
    )
    OR (
      weight_grams IS NOT NULL
      AND weight_grams > 0
      AND length_mm IS NOT NULL
      AND length_mm > 0
      AND width_mm IS NOT NULL
      AND width_mm > 0
      AND height_mm IS NOT NULL
      AND height_mm > 0
    )
  ),
  CONSTRAINT commerce_order_lines_packaging_valid CHECK (
    (
      packaging_state = 'resolved'
      AND packaging_source <> 'none'
      AND weight_grams IS NOT NULL
      AND weight_grams > 0
      AND length_mm IS NOT NULL
      AND length_mm > 0
      AND width_mm IS NOT NULL
      AND width_mm > 0
      AND height_mm IS NOT NULL
      AND height_mm > 0
    )
    OR packaging_state <> 'resolved'
  ),
  CONSTRAINT commerce_order_lines_source_valid CHECK (
    length(btrim(source_revision)) BETWEEN 1 AND 512
    AND source_revision !~ '[[:cntrl:]]'
    AND length(btrim(provider_api_version)) BETWEEN 1 AND 64
    AND length(btrim(normalizer_version)) BETWEEN 1 AND 128
  ),
  CONSTRAINT commerce_order_lines_ready_valid CHECK (
    workflow_state NOT IN ('ready', 'promoted')
    OR (
      mapping_state IN ('resolved', 'not_required')
      AND (
        mapping_state = 'not_required'
        OR (
          product_id IS NOT NULL
          AND (
            product_mapping_id IS NOT NULL
            OR (
              external_variant_id IS NULL
              AND external_product_id IS NULL
            )
          )
        )
      )
      AND (
        requires_shipping = false
        OR packaging_state = 'resolved'
      )
      AND price_resolution_state IN ('provider', 'manual')
      AND resolved_currency_code IS NOT NULL
      AND resolved_unit_price_minor IS NOT NULL
      AND unsupported_reason_code IS NULL
      AND cardinality(blocking_codes) = 0
    )
  ),
  CONSTRAINT commerce_order_lines_promotion_valid CHECK (
    (
      workflow_state = 'promoted'
      AND canonical_order_line_id IS NOT NULL
      AND promoted_at IS NOT NULL
    )
    OR (
      workflow_state <> 'promoted'
      AND canonical_order_line_id IS NULL
      AND promoted_at IS NULL
    )
  ),
  CONSTRAINT commerce_order_lines_unsupported_valid CHECK (
    mapping_state <> 'unsupported'
    AND packaging_state <> 'unsupported'
    AND price_resolution_state <> 'unsupported'
    OR (
      unsupported_reason_code IS NOT NULL
      AND length(btrim(unsupported_reason_code)) BETWEEN 1 AND 128
    )
  ),
  CONSTRAINT commerce_order_lines_retention_valid CHECK (
    expires_at > created_at
    AND expires_at <= created_at + interval '30 days'
  )
);

CREATE INDEX IF NOT EXISTS commerce_order_lines_order_idx
  ON operations_commerce_order_candidate_lines (
    organization_id, order_candidate_id, id
  );

CREATE INDEX IF NOT EXISTS commerce_order_lines_mapping_idx
  ON operations_commerce_order_candidate_lines (
    organization_id, mapping_state, packaging_state, sku_snapshot, id
  )
  WHERE workflow_state IN ('held', 'resolving');

CREATE INDEX IF NOT EXISTS commerce_order_lines_variant_idx
  ON operations_commerce_order_candidate_lines (
    organization_id, integration_account_id, external_variant_id, id
  )
  WHERE external_variant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS commerce_order_lines_expiry_idx
  ON operations_commerce_order_candidate_lines (expires_at, id)
  WHERE workflow_state <> 'promoted';

CREATE OR REPLACE FUNCTION protect_operations_commerce_order_candidate_line()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    NEW.global_id,
    NEW.organization_id,
    NEW.integration_account_id,
    NEW.pipeline_id,
    NEW.run_id,
    NEW.order_candidate_id,
    NEW.product_candidate_id,
    NEW.provider,
    NEW.external_line_id,
    NEW.external_product_id,
    NEW.external_variant_id,
    NEW.external_inventory_item_id,
    NEW.sku_snapshot,
    NEW.barcode_snapshot,
    NEW.product_title_snapshot,
    NEW.variant_title_snapshot,
    NEW.provider_status_raw,
    NEW.normalized_status,
    NEW.ordered_quantity,
    NEW.current_quantity,
    NEW.cancelled_quantity,
    NEW.fulfilled_quantity,
    NEW.unfulfilled_quantity,
    NEW.returned_quantity,
    NEW.unit_multiplier,
    NEW.physical_quantity,
    NEW.currency_code,
    NEW.unit_price_minor,
    NEW.subtotal_minor,
    NEW.discount_minor,
    NEW.brand_discount_minor,
    NEW.tax_minor,
    NEW.other_adjustment_minor,
    NEW.total_minor,
    NEW.taxable,
    NEW.requires_shipping,
    NEW.provider_created_at,
    NEW.provider_updated_at,
    NEW.observed_at,
    NEW.source_revision,
    NEW.source_hash,
    NEW.provider_api_version,
    NEW.normalizer_version,
    NEW.schema_version,
    NEW.created_by,
    NEW.created_at,
    NEW.expires_at
  ) IS DISTINCT FROM ROW(
    OLD.global_id,
    OLD.organization_id,
    OLD.integration_account_id,
    OLD.pipeline_id,
    OLD.run_id,
    OLD.order_candidate_id,
    OLD.product_candidate_id,
    OLD.provider,
    OLD.external_line_id,
    OLD.external_product_id,
    OLD.external_variant_id,
    OLD.external_inventory_item_id,
    OLD.sku_snapshot,
    OLD.barcode_snapshot,
    OLD.product_title_snapshot,
    OLD.variant_title_snapshot,
    OLD.provider_status_raw,
    OLD.normalized_status,
    OLD.ordered_quantity,
    OLD.current_quantity,
    OLD.cancelled_quantity,
    OLD.fulfilled_quantity,
    OLD.unfulfilled_quantity,
    OLD.returned_quantity,
    OLD.unit_multiplier,
    OLD.physical_quantity,
    OLD.currency_code,
    OLD.unit_price_minor,
    OLD.subtotal_minor,
    OLD.discount_minor,
    OLD.brand_discount_minor,
    OLD.tax_minor,
    OLD.other_adjustment_minor,
    OLD.total_minor,
    OLD.taxable,
    OLD.requires_shipping,
    OLD.provider_created_at,
    OLD.provider_updated_at,
    OLD.observed_at,
    OLD.source_revision,
    OLD.source_hash,
    OLD.provider_api_version,
    OLD.normalizer_version,
    OLD.schema_version,
    OLD.created_by,
    OLD.created_at,
    OLD.expires_at
  ) THEN
    RAISE EXCEPTION 'Commerce order candidate line source is immutable';
  END IF;
  IF NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION
      'Commerce order candidate line update requires the next row version';
  END IF;
  IF NOT operations_commerce_workflow_transition_valid(
    OLD.workflow_state, NEW.workflow_state
  ) THEN
    RAISE EXCEPTION 'Invalid commerce order candidate line workflow transition';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_operations_commerce_order_candidate_line
  ON operations_commerce_order_candidate_lines;
CREATE TRIGGER protect_operations_commerce_order_candidate_line
BEFORE UPDATE ON operations_commerce_order_candidate_lines
FOR EACH ROW EXECUTE FUNCTION
  protect_operations_commerce_order_candidate_line();

-- Decisions contain only identifiers, hashes, safe reason codes, and policy
-- references. Protected party/address values remain encrypted on the temporary
-- order candidate and can therefore be purged without rewriting this evidence.
CREATE TABLE IF NOT EXISTS operations_commerce_resolution_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gcrd'),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  pipeline_id uuid NOT NULL,
  intake_run_global_id text NOT NULL,
  target_type text NOT NULL
    CHECK (target_type IN (
      'product_candidate', 'order_candidate', 'order_candidate_line'
    )),
  target_global_id text NOT NULL,
  target_source_revision text NOT NULL,
  target_source_hash text NOT NULL
    CHECK (target_source_hash ~ '^[a-f0-9]{64}$'),
  decision_type text NOT NULL
    CHECK (decision_type IN (
      'product_binding',
      'product_creation',
      'customer_binding',
      'customer_creation',
      'address_confirmation',
      'delivery_policy',
      'package_resolution',
      'refresh',
      'validation',
      'unsupported_acknowledgement',
      'promotion'
    )),
  outcome text NOT NULL
    CHECK (outcome IN ('applied', 'rejected', 'failed', 'replayed')),
  resulting_workflow_state text NOT NULL
    CHECK (resulting_workflow_state IN (
      'held', 'resolving', 'ready', 'promoted', 'failed', 'expired'
    )),
  reason_code text NOT NULL,
  snapshot_hash text,
  policy_version text,
  product_id uuid,
  customer_id uuid,
  product_mapping_id uuid,
  package_profile_id uuid,
  canonical_order_id uuid,
  canonical_order_line_id uuid,
  command_receipt_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  actor_email text NOT NULL,
  correlation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commerce_resolution_decisions_global_valid
    CHECK (global_id ~ '^gcrd[0-9]{7}$'),
  CONSTRAINT commerce_resolution_decisions_global_unique UNIQUE (global_id),
  CONSTRAINT commerce_resolution_decisions_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT commerce_resolution_decisions_run_registry_fkey
    FOREIGN KEY (intake_run_global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT commerce_resolution_decisions_target_registry_fkey
    FOREIGN KEY (target_global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT commerce_resolution_decisions_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT commerce_resolution_decisions_pipeline_fkey
    FOREIGN KEY (organization_id, pipeline_id)
    REFERENCES pipeline_spaces(workspace_organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT commerce_resolution_decisions_product_fkey
    FOREIGN KEY (pipeline_id, product_id)
    REFERENCES crm_products(pipeline_id, id) ON DELETE RESTRICT,
  CONSTRAINT commerce_resolution_decisions_customer_fkey
    FOREIGN KEY (pipeline_id, customer_id)
    REFERENCES crm_organizations(pipeline_id, id) ON DELETE RESTRICT,
  CONSTRAINT commerce_resolution_decisions_mapping_fkey
    FOREIGN KEY (
      organization_id, integration_account_id, pipeline_id,
      product_mapping_id, product_id
    )
    REFERENCES operations_product_mappings(
      organization_id, integration_account_id, pipeline_id, id, product_id
    ) ON DELETE RESTRICT,
  CONSTRAINT commerce_resolution_decisions_package_fkey
    FOREIGN KEY (
      organization_id, pipeline_id, product_id, package_profile_id
    )
    REFERENCES operations_product_package_profiles(
      organization_id, pipeline_id, product_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT commerce_resolution_decisions_order_fkey
    FOREIGN KEY (organization_id, canonical_order_id)
    REFERENCES operations_orders(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT commerce_resolution_decisions_order_line_fkey
    FOREIGN KEY (organization_id, canonical_order_line_id)
    REFERENCES operations_order_lines(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT commerce_resolution_decisions_receipt_fkey
    FOREIGN KEY (organization_id, command_receipt_id)
    REFERENCES operations_command_receipts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT commerce_resolution_decisions_idempotency_unique
    UNIQUE (
      organization_id, target_global_id, decision_type, idempotency_key
    ),
  CONSTRAINT commerce_resolution_decisions_source_valid CHECK (
    length(btrim(target_source_revision)) BETWEEN 1 AND 512
    AND target_source_revision !~ '[[:cntrl:]]'
  ),
  CONSTRAINT commerce_resolution_decisions_reason_valid CHECK (
    reason_code ~ '^[a-z][a-z0-9_.:-]{0,127}$'
  ),
  CONSTRAINT commerce_resolution_decisions_snapshot_valid CHECK (
    snapshot_hash IS NULL OR snapshot_hash ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT commerce_resolution_decisions_key_valid CHECK (
    length(btrim(idempotency_key)) BETWEEN 1 AND 255
    AND idempotency_key !~ '[[:cntrl:]]'
  ),
  CONSTRAINT commerce_resolution_decisions_mapping_valid CHECK (
    product_mapping_id IS NULL OR product_id IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS commerce_resolution_decisions_target_idx
  ON operations_commerce_resolution_decisions (
    organization_id, target_global_id, created_at, id
  );

CREATE INDEX IF NOT EXISTS commerce_resolution_decisions_run_idx
  ON operations_commerce_resolution_decisions (
    organization_id, intake_run_global_id, created_at, id
  );

CREATE OR REPLACE FUNCTION validate_operations_commerce_resolution_target()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_exists boolean;
  resolved_run_global_id text;
BEGIN
  IF NEW.target_type = 'product_candidate' THEN
    SELECT true, run.global_id
    INTO target_exists, resolved_run_global_id
    FROM operations_commerce_product_candidates AS candidate
    JOIN operations_commerce_intake_runs AS run
      ON run.organization_id = candidate.organization_id
     AND run.integration_account_id = candidate.integration_account_id
     AND run.pipeline_id = candidate.pipeline_id
     AND run.id = candidate.run_id
    WHERE candidate.organization_id = NEW.organization_id
      AND candidate.integration_account_id = NEW.integration_account_id
      AND candidate.pipeline_id = NEW.pipeline_id
      AND candidate.global_id = NEW.target_global_id
      AND candidate.source_revision = NEW.target_source_revision
      AND candidate.source_hash = NEW.target_source_hash;
  ELSIF NEW.target_type = 'order_candidate' THEN
    SELECT true, run.global_id
    INTO target_exists, resolved_run_global_id
    FROM operations_commerce_order_candidates AS candidate
    JOIN operations_commerce_intake_runs AS run
      ON run.organization_id = candidate.organization_id
     AND run.integration_account_id = candidate.integration_account_id
     AND run.pipeline_id = candidate.pipeline_id
     AND run.id = candidate.run_id
    WHERE candidate.organization_id = NEW.organization_id
      AND candidate.integration_account_id = NEW.integration_account_id
      AND candidate.pipeline_id = NEW.pipeline_id
      AND candidate.global_id = NEW.target_global_id
      AND candidate.source_revision = NEW.target_source_revision
      AND candidate.source_hash = NEW.target_source_hash;
  ELSE
    SELECT true, run.global_id
    INTO target_exists, resolved_run_global_id
    FROM operations_commerce_order_candidate_lines AS candidate
    JOIN operations_commerce_intake_runs AS run
      ON run.organization_id = candidate.organization_id
     AND run.integration_account_id = candidate.integration_account_id
     AND run.pipeline_id = candidate.pipeline_id
     AND run.id = candidate.run_id
    WHERE candidate.organization_id = NEW.organization_id
      AND candidate.integration_account_id = NEW.integration_account_id
      AND candidate.pipeline_id = NEW.pipeline_id
      AND candidate.global_id = NEW.target_global_id
      AND candidate.source_revision = NEW.target_source_revision
      AND candidate.source_hash = NEW.target_source_hash;
  END IF;

  IF COALESCE(target_exists, false) = false
     OR resolved_run_global_id IS DISTINCT FROM NEW.intake_run_global_id THEN
    RAISE EXCEPTION
      'Commerce resolution decision target does not match its tenant source revision';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_operations_commerce_resolution_target
  ON operations_commerce_resolution_decisions;
CREATE TRIGGER validate_operations_commerce_resolution_target
BEFORE INSERT ON operations_commerce_resolution_decisions
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_commerce_resolution_target();

CREATE OR REPLACE FUNCTION protect_operations_commerce_resolution_decision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'Commerce resolution decisions are append-only';
END;
$$;

DROP TRIGGER IF EXISTS protect_operations_commerce_resolution_decision
  ON operations_commerce_resolution_decisions;
CREATE TRIGGER protect_operations_commerce_resolution_decision
BEFORE UPDATE OR DELETE ON operations_commerce_resolution_decisions
FOR EACH ROW EXECUTE FUNCTION
  protect_operations_commerce_resolution_decision();

COMMENT ON TABLE operations_commerce_intake_runs IS
  'Bounded Shopify/Faire read-only intake execution. Provider writes, cursor advancement, and WMS side effects are constrained to zero.';
COMMENT ON TABLE operations_commerce_product_candidates IS
  'Temporary provider product/variant projections awaiting an exact gp mapping; never a product master.';
COMMENT ON TABLE operations_commerce_order_candidates IS
  'Temporary normalized order projections with encrypted party/address snapshots; never the canonical gor order.';
COMMENT ON TABLE operations_commerce_order_candidate_lines IS
  'Temporary normalized order-line projections awaiting product and package resolution; never canonical gol lines.';
COMMENT ON TABLE operations_commerce_resolution_decisions IS
  'Append-only, non-PII command evidence for candidate resolution and promotion.';
