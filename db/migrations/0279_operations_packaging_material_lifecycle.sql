-- Dependency-safe packaging-material removal and provider-file provenance.
--
-- Shopify's public Admin GraphQL schema exposes saved-package mutations but
-- no supported query that lists a store's saved packages. ClawPilot therefore
-- records an operator-supplied CSV as read-only import evidence. Imports never
-- call a provider mutation and always begin as drafts.

ALTER TABLE operations_packaging_materials
  ADD COLUMN IF NOT EXISTS source_integration_account_id uuid,
  ADD COLUMN IF NOT EXISTS source_external_key text,
  ADD COLUMN IF NOT EXISTS source_external_package_id text,
  ADD COLUMN IF NOT EXISTS source_is_default boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS source_imported_at timestamptz,
  ADD COLUMN IF NOT EXISTS source_file_sha256 text;

ALTER TABLE operations_packaging_materials
  DROP CONSTRAINT IF EXISTS operations_packaging_materials_status_check,
  DROP CONSTRAINT IF EXISTS operations_packaging_materials_source_check,
  DROP CONSTRAINT IF EXISTS operations_packaging_materials_shopify_source_fkey,
  DROP CONSTRAINT IF EXISTS operations_packaging_materials_shopify_source_valid;

ALTER TABLE operations_packaging_materials
  ADD CONSTRAINT operations_packaging_materials_status_check CHECK (
    status IN ('draft', 'active', 'retired')
  ),
  ADD CONSTRAINT operations_packaging_materials_source_check CHECK (
    source IN (
      'manual', 'starter_assortment', 'customer_supplied', 'csv_import',
      'shopify_import'
    )
  ),
  ADD CONSTRAINT operations_packaging_materials_shopify_source_fkey
    FOREIGN KEY (organization_id, source_integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT operations_packaging_materials_shopify_source_valid CHECK (
    (
      source = 'shopify_import'
      AND source_integration_account_id IS NOT NULL
      AND length(btrim(source_external_key)) BETWEEN 1 AND 255
      AND (
        source_external_package_id IS NULL
        OR source_external_package_id ~
          '^gid://shopify/ShippingPackage/[1-9][0-9]{0,20}$'
      )
      AND source_imported_at IS NOT NULL
      AND source_file_sha256 ~ '^[0-9a-f]{64}$'
      AND status IN ('draft', 'active', 'retired')
    )
    OR (
      source <> 'shopify_import'
      AND source_integration_account_id IS NULL
      AND source_external_key IS NULL
      AND source_external_package_id IS NULL
      AND source_is_default = false
      AND source_imported_at IS NULL
      AND source_file_sha256 IS NULL
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS
  operations_packaging_materials_shopify_source_unique
ON operations_packaging_materials (
  organization_id, source_integration_account_id, source_external_key
)
WHERE source = 'shopify_import';

CREATE UNIQUE INDEX IF NOT EXISTS
  operations_packaging_materials_shopify_default_unique
ON operations_packaging_materials (
  organization_id, source_integration_account_id
)
WHERE source = 'shopify_import' AND source_is_default = true;

CREATE INDEX IF NOT EXISTS
  operations_packaging_materials_visible_catalog
ON operations_packaging_materials (
  organization_id, status, material_type, lower(name), id
)
WHERE status <> 'retired';

CREATE OR REPLACE FUNCTION protect_packaging_material_source_lineage()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_account_valid boolean;
BEGIN
  IF NEW.source = 'shopify_import' THEN
    SELECT EXISTS (
      SELECT 1
      FROM operations_integration_accounts account
      WHERE account.organization_id = NEW.organization_id
        AND account.id = NEW.source_integration_account_id
        AND account.integration_type = 'commerce'
        AND account.provider = 'shopify'
    ) INTO source_account_valid;
    IF source_account_valid IS DISTINCT FROM true THEN
      RAISE EXCEPTION
        'Shopify packaging import source account lineage is invalid';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE'
     AND (
       OLD.source = 'shopify_import'
       OR NEW.source = 'shopify_import'
     )
     AND (
       NEW.source IS DISTINCT FROM OLD.source
       OR NEW.source_integration_account_id
            IS DISTINCT FROM OLD.source_integration_account_id
       OR NEW.source_external_key IS DISTINCT FROM OLD.source_external_key
     )
  THEN
    RAISE EXCEPTION
      'Shopify packaging import source lineage is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS packaging_material_source_lineage_guard
  ON operations_packaging_materials;
CREATE TRIGGER packaging_material_source_lineage_guard
BEFORE INSERT OR UPDATE OF
  organization_id, source, source_integration_account_id, source_external_key
ON operations_packaging_materials
FOR EACH ROW EXECUTE FUNCTION protect_packaging_material_source_lineage();

CREATE OR REPLACE FUNCTION protect_packaging_material_retirement()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'retired' AND NEW.status <> 'retired' THEN
    RAISE EXCEPTION
      'Retired packaging materials cannot be restored by a generic update';
  END IF;
  IF NEW.status = 'retired'
     AND OLD.status <> 'retired'
     AND EXISTS (
       SELECT 1
       FROM operations_packaging_material_stock stock
       WHERE stock.organization_id = NEW.organization_id
         AND stock.packaging_material_id = NEW.id
         AND stock.is_available = true
     )
  THEN
    RAISE EXCEPTION
      'Packaging material stock must be unavailable before retirement';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS packaging_material_retirement_guard
  ON operations_packaging_materials;
CREATE TRIGGER packaging_material_retirement_guard
BEFORE UPDATE OF status ON operations_packaging_materials
FOR EACH ROW EXECUTE FUNCTION protect_packaging_material_retirement();

CREATE OR REPLACE FUNCTION protect_retired_packaging_material_stock()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.is_available = true
     AND EXISTS (
       SELECT 1
       FROM operations_packaging_materials material
       WHERE material.organization_id = NEW.organization_id
         AND material.id = NEW.packaging_material_id
         AND material.status = 'retired'
     )
  THEN
    RAISE EXCEPTION
      'Retired packaging materials cannot have available warehouse stock';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS retired_packaging_material_stock_guard
  ON operations_packaging_material_stock;
CREATE TRIGGER retired_packaging_material_stock_guard
BEFORE INSERT OR UPDATE OF
  organization_id, packaging_material_id, is_available
ON operations_packaging_material_stock
FOR EACH ROW EXECUTE FUNCTION protect_retired_packaging_material_stock();

COMMENT ON COLUMN operations_packaging_materials.source_external_key IS
  'Stable package key from an operator-supplied Shopify saved-package CSV; this is not evidence of a provider list API read.';
COMMENT ON COLUMN operations_packaging_materials.source_file_sha256 IS
  'SHA-256 of the exact bounded CSV accepted by the read-only Shopify package import.';
COMMENT ON CONSTRAINT operations_packaging_materials_shopify_source_valid
  ON operations_packaging_materials IS
  'Shopify-imported package drafts retain exact store/file lineage. Non-Shopify materials cannot carry provider provenance.';
