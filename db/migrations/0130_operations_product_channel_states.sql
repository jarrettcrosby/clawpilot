-- Preserve provider product lifecycle independently from the local CRM product
-- availability flag and from expiring commerce-intake candidates.

INSERT INTO global_reference_entity_types (prefix, entity_type, display_name)
VALUES (
  'gpcs',
  'operations.product_channel_state',
  'Product sales-channel state'
)
ON CONFLICT (prefix) DO UPDATE SET
  entity_type = EXCLUDED.entity_type,
  display_name = EXCLUDED.display_name;

ALTER TABLE operations_commerce_product_candidates
  DROP CONSTRAINT IF EXISTS
    operations_commerce_product_candidates_normalized_status_check;

ALTER TABLE operations_commerce_product_candidates
  ADD CONSTRAINT
    operations_commerce_product_candidates_normalized_status_check
  CHECK (normalized_status IN (
    'active', 'draft', 'archived', 'unlisted', 'unavailable', 'unknown'
  ));

CREATE TABLE IF NOT EXISTS operations_product_channel_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gpcs'),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  pipeline_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('shopify', 'faire')),
  external_product_id text NOT NULL,
  external_variant_id text NOT NULL,
  external_inventory_item_id text,
  product_id uuid,
  product_mapping_id uuid,
  provider_status_raw text NOT NULL,
  normalized_status text NOT NULL
    CHECK (normalized_status IN (
      'active', 'draft', 'archived', 'unlisted', 'unavailable', 'unknown'
    )),
  provider_active boolean,
  provider_updated_at timestamptz,
  observed_at timestamptz NOT NULL,
  source_revision text NOT NULL,
  source_hash text NOT NULL CHECK (source_hash ~ '^[a-f0-9]{64}$'),
  row_version bigint NOT NULL DEFAULT 0 CHECK (row_version >= 0),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_product_channel_states_global_valid
    CHECK (global_id ~ '^gpcs[0-9]{7}$'),
  CONSTRAINT operations_product_channel_states_global_unique
    UNIQUE (global_id),
  CONSTRAINT operations_product_channel_states_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_product_channel_states_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_product_channel_states_pipeline_fkey
    FOREIGN KEY (organization_id, pipeline_id)
    REFERENCES pipeline_spaces(workspace_organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_product_channel_states_product_fkey
    FOREIGN KEY (pipeline_id, product_id)
    REFERENCES crm_products(pipeline_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_product_channel_states_mapping_fkey
    FOREIGN KEY (
      organization_id, integration_account_id, pipeline_id,
      product_mapping_id, product_id
    )
    REFERENCES operations_product_mappings(
      organization_id, integration_account_id, pipeline_id, id, product_id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_product_channel_states_mapping_pair_valid CHECK (
    (product_id IS NULL AND product_mapping_id IS NULL)
    OR (product_id IS NOT NULL AND product_mapping_id IS NOT NULL)
  ),
  CONSTRAINT operations_product_channel_states_external_ids_valid CHECK (
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
  CONSTRAINT operations_product_channel_states_raw_status_valid CHECK (
    length(btrim(provider_status_raw)) BETWEEN 1 AND 255
    AND provider_status_raw !~ '[[:cntrl:]]'
  ),
  CONSTRAINT operations_product_channel_states_scope_variant_unique
    UNIQUE (
      organization_id, integration_account_id, external_variant_id
    )
);

CREATE INDEX IF NOT EXISTS idx_operations_product_channel_states_product
  ON operations_product_channel_states (
    pipeline_id, product_id, provider, normalized_status
  )
  WHERE product_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_operations_product_channel_states_observed
  ON operations_product_channel_states (
    organization_id, integration_account_id, observed_at DESC
  );

WITH latest_candidate AS (
  SELECT DISTINCT ON (
    candidate.organization_id,
    candidate.integration_account_id,
    candidate.external_variant_id
  )
    candidate.*
  FROM operations_commerce_product_candidates AS candidate
  ORDER BY
    candidate.organization_id,
    candidate.integration_account_id,
    candidate.external_variant_id,
    candidate.provider_updated_at DESC NULLS LAST,
    candidate.observed_at DESC,
    candidate.created_at DESC,
    candidate.id DESC
)
INSERT INTO operations_product_channel_states (
  organization_id,
  integration_account_id,
  pipeline_id,
  provider,
  external_product_id,
  external_variant_id,
  external_inventory_item_id,
  product_id,
  product_mapping_id,
  provider_status_raw,
  normalized_status,
  provider_active,
  provider_updated_at,
  observed_at,
  source_revision,
  source_hash,
  created_by,
  updated_by
)
SELECT
  candidate.organization_id,
  candidate.integration_account_id,
  candidate.pipeline_id,
  candidate.provider,
  candidate.external_product_id,
  candidate.external_variant_id,
  candidate.external_inventory_item_id,
  mapping.product_id,
  mapping.id,
  candidate.provider_status_raw,
  candidate.normalized_status,
  CASE
    WHEN candidate.normalized_status = 'active' THEN true
    WHEN candidate.normalized_status IN (
      'draft', 'archived', 'unlisted', 'unavailable'
    ) THEN false
    ELSE NULL
  END,
  candidate.provider_updated_at,
  candidate.observed_at,
  candidate.source_revision,
  candidate.source_hash,
  candidate.created_by,
  candidate.updated_by
FROM latest_candidate AS candidate
LEFT JOIN operations_product_mappings AS mapping
  ON mapping.organization_id = candidate.organization_id
 AND mapping.integration_account_id = candidate.integration_account_id
 AND mapping.pipeline_id = candidate.pipeline_id
 AND mapping.external_variant_id = candidate.external_variant_id
 AND mapping.active = true
ON CONFLICT (
  organization_id, integration_account_id, external_variant_id
) DO UPDATE SET
  provider = EXCLUDED.provider,
  external_product_id = EXCLUDED.external_product_id,
  external_inventory_item_id = EXCLUDED.external_inventory_item_id,
  product_id = COALESCE(
    EXCLUDED.product_id,
    operations_product_channel_states.product_id
  ),
  product_mapping_id = COALESCE(
    EXCLUDED.product_mapping_id,
    operations_product_channel_states.product_mapping_id
  ),
  provider_status_raw = EXCLUDED.provider_status_raw,
  normalized_status = EXCLUDED.normalized_status,
  provider_active = EXCLUDED.provider_active,
  provider_updated_at = EXCLUDED.provider_updated_at,
  observed_at = EXCLUDED.observed_at,
  source_revision = EXCLUDED.source_revision,
  source_hash = EXCLUDED.source_hash,
  row_version = operations_product_channel_states.row_version + 1,
  updated_by = EXCLUDED.updated_by,
  updated_at = now()
WHERE COALESCE(
  EXCLUDED.provider_updated_at,
  EXCLUDED.observed_at
) >= COALESCE(
  operations_product_channel_states.provider_updated_at,
  operations_product_channel_states.observed_at
);

COMMENT ON TABLE operations_product_channel_states IS
  'Durable current provider lifecycle per exact sales-channel variant; independent from crm_products.active and intake-candidate retention.';

COMMENT ON COLUMN operations_product_channel_states.provider_active IS
  'Provider source-active fact only. It does not prove storefront publication.';
