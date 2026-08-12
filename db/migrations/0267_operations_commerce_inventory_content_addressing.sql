-- Content-addressed Shopify inventory evidence.
--
-- Every provider call remains represented by its immutable attempt, capture,
-- sync-run, and run-scoped level rows. Only repeated wide provider content is
-- stored once; planning, reservation, freshness, and replay identities remain
-- unchanged.

CREATE TABLE IF NOT EXISTS operations_commerce_inventory_snapshot_contents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider = 'shopify'),
  adapter_version text NOT NULL,
  provider_location_id text NOT NULL,
  snapshot_hash text NOT NULL CHECK (snapshot_hash ~ '^[a-f0-9]{64}$'),
  level_count integer NOT NULL CHECK (level_count >= 0),
  snapshot_content jsonb NOT NULL CHECK (
    jsonb_typeof(snapshot_content) = 'object'
    AND NOT snapshot_content ? 'fetchedAt'
    AND NOT snapshot_content ? 'pageCount'
    AND snapshot_content->>'snapshotHash' = snapshot_hash
    AND snapshot_content#>>'{location,id}' = provider_location_id
    AND jsonb_typeof(snapshot_content->'levels') = 'array'
    AND jsonb_array_length(snapshot_content->'levels') = level_count
  ),
  content_bytes integer NOT NULL CHECK (
    content_bytes BETWEEN 2 AND 16777216
  ),
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_commerce_inventory_snapshot_contents_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_inventory_snapshot_contents_identity_valid
    CHECK (
      length(btrim(adapter_version)) BETWEEN 1 AND 160
      AND adapter_version !~ '[[:cntrl:]]'
      AND length(btrim(provider_location_id)) BETWEEN 1 AND 512
      AND provider_location_id !~ '[[:cntrl:]]'
    ),
  CONSTRAINT operations_commerce_inventory_snapshot_contents_hash_unique
    UNIQUE (
      organization_id, integration_account_id, provider_location_id,
      adapter_version, snapshot_hash
    ),
  CONSTRAINT operations_commerce_inventory_snapshot_contents_account_id_unique
    UNIQUE (organization_id, integration_account_id, id)
);

DROP TRIGGER IF EXISTS protect_operations_commerce_inventory_snapshot_contents
  ON operations_commerce_inventory_snapshot_contents;
CREATE TRIGGER protect_operations_commerce_inventory_snapshot_contents
BEFORE UPDATE OR DELETE
ON operations_commerce_inventory_snapshot_contents
FOR EACH ROW EXECUTE FUNCTION protect_operations_commerce_inventory_evidence();

ALTER TABLE operations_commerce_inventory_captures
  ALTER COLUMN captured_snapshot DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS snapshot_content_id uuid,
  ADD COLUMN IF NOT EXISTS provider_page_count integer;

ALTER TABLE operations_commerce_inventory_captures
  DROP CONSTRAINT IF EXISTS
    operations_inventory_captures_provider_page_count_valid,
  ADD CONSTRAINT
    operations_inventory_captures_provider_page_count_valid
    CHECK (
      provider_page_count IS NULL
      OR provider_page_count BETWEEN 1 AND 400
    ) NOT VALID,
  DROP CONSTRAINT IF EXISTS
    operations_commerce_inventory_captures_snapshot_content_fkey,
  ADD CONSTRAINT operations_commerce_inventory_captures_snapshot_content_fkey
    FOREIGN KEY (
      organization_id, integration_account_id, snapshot_content_id
    )
    REFERENCES operations_commerce_inventory_snapshot_contents(
      organization_id, integration_account_id, id
    ) ON DELETE RESTRICT NOT VALID,
  DROP CONSTRAINT IF EXISTS
    operations_commerce_inventory_captures_storage_mode_valid,
  ADD CONSTRAINT operations_commerce_inventory_captures_storage_mode_valid
    CHECK (
      (
        captured_snapshot IS NOT NULL
        AND snapshot_content_id IS NULL
        AND jsonb_typeof(captured_snapshot) = 'object'
      )
      OR (
        captured_snapshot IS NULL
        AND snapshot_content_id IS NOT NULL
        AND provider_page_count IS NOT NULL
      )
    ) NOT VALID;

CREATE OR REPLACE FUNCTION
  validate_operations_commerce_inventory_capture_content()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.snapshot_content_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM operations_commerce_inventory_snapshot_contents content
      WHERE content.organization_id = NEW.organization_id
        AND content.integration_account_id = NEW.integration_account_id
        AND content.id = NEW.snapshot_content_id
        AND content.provider = NEW.provider
        AND content.adapter_version = NEW.adapter_version
        AND content.provider_location_id = NEW.provider_location_id
        AND content.snapshot_hash = NEW.snapshot_hash
        AND content.level_count = NEW.level_count
    ) THEN
      RAISE EXCEPTION
        'Commerce inventory capture content does not match its observation';
    END IF;
    RETURN NEW;
  END IF;

  -- Existing tests, imports, and historical writers retain the original
  -- inline evidence contract. Strict cross-row validation applies only to the
  -- new content-backed mode.
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  validate_operations_commerce_inventory_capture_content_insert
  ON operations_commerce_inventory_captures;
CREATE TRIGGER
  validate_operations_commerce_inventory_capture_content_insert
BEFORE INSERT ON operations_commerce_inventory_captures
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_commerce_inventory_capture_content();

COMMENT ON TABLE operations_commerce_inventory_snapshot_contents IS
  'Immutable content-addressed Shopify inventory payloads. Observation-specific fetch time remains on the capture row.';
