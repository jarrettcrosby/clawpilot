-- A sales-channel listing is not a second ClawPilot product. When an operator
-- confirms that two local products represent the same sellable inventory and
-- pack identity, retain the superseded Global ID as an alias to the canonical
-- product instead of deleting either record or rewriting historical evidence.

INSERT INTO global_reference_entity_types (prefix, entity_type, display_name)
VALUES (
  'gpid',
  'crm.product_identity_alias',
  'CRM product identity alias'
)
ON CONFLICT (prefix) DO UPDATE SET
  entity_type = EXCLUDED.entity_type,
  display_name = EXCLUDED.display_name;

CREATE TABLE IF NOT EXISTS crm_product_identity_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gpid'),
  pipeline_id uuid NOT NULL REFERENCES pipeline_spaces(id) ON DELETE RESTRICT,
  alias_product_id uuid NOT NULL,
  canonical_product_id uuid NOT NULL,
  evidence_type text NOT NULL CHECK (
    evidence_type IN (
      'exact_sku',
      'exact_gtin',
      'exact_barcode',
      'operator_confirmed'
    )
  ),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_product_identity_aliases_global_valid
    CHECK (global_id ~ '^gpid[0-9]{7}$'),
  CONSTRAINT crm_product_identity_aliases_global_unique
    UNIQUE (global_id),
  CONSTRAINT crm_product_identity_aliases_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT crm_product_identity_aliases_alias_fkey
    FOREIGN KEY (pipeline_id, alias_product_id)
    REFERENCES crm_products(pipeline_id, id) ON DELETE RESTRICT,
  CONSTRAINT crm_product_identity_aliases_canonical_fkey
    FOREIGN KEY (pipeline_id, canonical_product_id)
    REFERENCES crm_products(pipeline_id, id) ON DELETE RESTRICT,
  CONSTRAINT crm_product_identity_aliases_distinct
    CHECK (alias_product_id <> canonical_product_id),
  CONSTRAINT crm_product_identity_aliases_alias_unique
    UNIQUE (pipeline_id, alias_product_id),
  CONSTRAINT crm_product_identity_aliases_evidence_object
    CHECK (jsonb_typeof(evidence) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_crm_product_identity_aliases_canonical
  ON crm_product_identity_aliases (
    pipeline_id, canonical_product_id, created_at DESC
  );

-- Aliases are deliberately one hop. A product that is already an alias cannot
-- become a canonical target, and a canonical target that already has aliases
-- cannot later become another alias. That keeps every historical Global ID
-- resolvable with one indexed lookup and prevents both chains and cycles.
CREATE OR REPLACE FUNCTION validate_crm_product_identity_alias()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  canonical_is_active boolean;
BEGIN
  SELECT
    product.active
    AND COALESCE(lower(product.source_payload->>'archived'), 'false')
      NOT IN ('true', '1', 'yes')
  INTO canonical_is_active
  FROM crm_products AS product
  WHERE product.pipeline_id = NEW.pipeline_id
    AND product.id = NEW.canonical_product_id;

  IF canonical_is_active IS DISTINCT FROM true THEN
    RAISE EXCEPTION
      'Product identity aliases must target an active canonical product';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM crm_product_identity_aliases AS existing
    WHERE existing.pipeline_id = NEW.pipeline_id
      AND existing.alias_product_id = NEW.canonical_product_id
      AND existing.id IS DISTINCT FROM NEW.id
  ) THEN
    RAISE EXCEPTION
      'Product identity aliases cannot target another alias';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM crm_product_identity_aliases AS existing
    WHERE existing.pipeline_id = NEW.pipeline_id
      AND existing.canonical_product_id = NEW.alias_product_id
      AND existing.id IS DISTINCT FROM NEW.id
  ) THEN
    RAISE EXCEPTION
      'A canonical product with aliases cannot become an alias';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_crm_product_identity_alias
  ON crm_product_identity_aliases;
CREATE TRIGGER validate_crm_product_identity_alias
BEFORE INSERT OR UPDATE
ON crm_product_identity_aliases
FOR EACH ROW EXECUTE FUNCTION validate_crm_product_identity_alias();

CREATE OR REPLACE FUNCTION resolve_crm_product_identity(
  requested_pipeline_id uuid,
  requested_product_id uuid
)
RETURNS uuid
LANGUAGE sql
STABLE
STRICT
AS $$
  SELECT COALESCE(alias.canonical_product_id, requested_product_id)
  FROM (SELECT 1) AS singleton
  LEFT JOIN crm_product_identity_aliases AS alias
    ON alias.pipeline_id = requested_pipeline_id
   AND alias.alias_product_id = requested_product_id;
$$;

COMMENT ON TABLE crm_product_identity_aliases IS
  'Permanent redirect from an archived duplicate CRM product Global ID to the canonical sellable product. Historical order, candidate, and mapping evidence remains attached to its original rows.';
COMMENT ON FUNCTION resolve_crm_product_identity(uuid, uuid) IS
  'Resolves a CRM product UUID to its direct canonical UUID. Alias invariants guarantee a single lookup with no alias chains.';
