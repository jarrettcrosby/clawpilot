-- Preserve the exact carrier-native source selected for a sandbox diagnostic
-- label. Any future conversion is a separate immutable derivative with
-- explicit source-hash and converter provenance; provider bytes are never
-- replaced in place.

ALTER TABLE operations_carrier_rate_test_labels
  ADD COLUMN IF NOT EXISTS source_kind text,
  ADD COLUMN IF NOT EXISTS provider_image_type text,
  ADD COLUMN IF NOT EXISTS provider_stock_type text;

-- Migration 0116 protects every existing provider-source field from updates.
-- Temporarily remove that trigger inside this migration transaction so only
-- the new metadata columns can be backfilled. The replacement trigger below
-- expands the immutable field set and is recreated before commit.
DROP TRIGGER IF EXISTS protect_operations_carrier_rate_test_label_write
  ON operations_carrier_rate_test_labels;

UPDATE operations_carrier_rate_test_labels
   SET source_kind = 'provider_native',
       provider_image_type = CASE
         WHEN provider = 'fedex_rest' AND format = 'ZPL' THEN 'ZPLII'
         ELSE format
       END,
       provider_stock_type = CASE
         WHEN provider = 'ups_rest' THEN 'HEIGHT_6_WIDTH_4'
         WHEN format = 'ZPL' THEN 'STOCK_4X6'
         ELSE 'PAPER_4X6'
       END
 WHERE source_kind IS NULL
    OR provider_image_type IS NULL
    OR provider_stock_type IS NULL;

ALTER TABLE operations_carrier_rate_test_labels
  ALTER COLUMN source_kind SET NOT NULL,
  ALTER COLUMN provider_image_type SET NOT NULL,
  ALTER COLUMN provider_stock_type SET NOT NULL,
  DROP CONSTRAINT IF EXISTS
    operations_carrier_rate_test_labels_source_kind_valid,
  ADD CONSTRAINT operations_carrier_rate_test_labels_source_kind_valid
    CHECK (source_kind = 'provider_native'),
  DROP CONSTRAINT IF EXISTS
    operations_carrier_rate_test_labels_provider_output_valid,
  ADD CONSTRAINT operations_carrier_rate_test_labels_provider_output_valid
    CHECK (
      media_size = 'label_4x6'
      AND (
        (
          provider = 'ups_rest'
          AND format = 'ZPL'
          AND provider_image_type = 'ZPL'
          AND provider_stock_type = 'HEIGHT_6_WIDTH_4'
        )
        OR (
          provider = 'fedex_rest'
          AND (
            (
              format = 'ZPL'
              AND provider_image_type = 'ZPLII'
              AND provider_stock_type = 'STOCK_4X6'
            )
            OR (
              format = 'PDF'
              AND provider_image_type = 'PDF'
              AND provider_stock_type = 'PAPER_4X6'
            )
            OR (
              format = 'PNG'
              AND provider_image_type = 'PNG'
              AND provider_stock_type = 'PAPER_4X6'
            )
          )
        )
      )
    );

CREATE OR REPLACE FUNCTION protect_operations_carrier_rate_test_label()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Carrier rate test labels are immutable and cannot be deleted';
  END IF;

  IF ROW(
    NEW.id,
    NEW.global_id,
    NEW.organization_id,
    NEW.rate_request_id,
    NEW.integration_account_id,
    NEW.carrier_account_id,
    NEW.provider,
    NEW.environment,
    NEW.credential_version,
    NEW.account_number_fingerprint,
    NEW.rate_request_hash,
    NEW.destination_fingerprint,
    NEW.service_code,
    NEW.service_name,
    NEW.rate_type,
    NEW.rated_amount,
    NEW.rated_currency,
    NEW.provider_label_id,
    NEW.tracking_number,
    NEW.format,
    NEW.media_size,
    NEW.source_kind,
    NEW.provider_image_type,
    NEW.provider_stock_type,
    NEW.label_payload,
    NEW.content_sha256,
    NEW.provider_reference,
    NEW.redacted_provider_evidence,
    NEW.create_attempt_id,
    NEW.created_by,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.id,
    OLD.global_id,
    OLD.organization_id,
    OLD.rate_request_id,
    OLD.integration_account_id,
    OLD.carrier_account_id,
    OLD.provider,
    OLD.environment,
    OLD.credential_version,
    OLD.account_number_fingerprint,
    OLD.rate_request_hash,
    OLD.destination_fingerprint,
    OLD.service_code,
    OLD.service_name,
    OLD.rate_type,
    OLD.rated_amount,
    OLD.rated_currency,
    OLD.provider_label_id,
    OLD.tracking_number,
    OLD.format,
    OLD.media_size,
    OLD.source_kind,
    OLD.provider_image_type,
    OLD.provider_stock_type,
    OLD.label_payload,
    OLD.content_sha256,
    OLD.provider_reference,
    OLD.redacted_provider_evidence,
    OLD.create_attempt_id,
    OLD.created_by,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Carrier rate test label identity and provider bytes are immutable';
  END IF;

  IF OLD.status <> 'created'
     OR NEW.status <> 'voided'
     OR NEW.void_attempt_id IS NULL
     OR NEW.voided_at IS NULL THEN
    RAISE EXCEPTION 'Carrier rate test label may transition from created to voided exactly once';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_operations_carrier_rate_test_label_write
  ON operations_carrier_rate_test_labels;
CREATE TRIGGER protect_operations_carrier_rate_test_label_write
BEFORE UPDATE OR DELETE ON operations_carrier_rate_test_labels
FOR EACH ROW EXECUTE FUNCTION protect_operations_carrier_rate_test_label();

INSERT INTO global_reference_entity_types (prefix, entity_type, display_name)
VALUES (
  'gda',
  'operations.carrier_rate_test_label_derivative',
  'Carrier label derived artifact'
)
ON CONFLICT (prefix) DO UPDATE SET
  entity_type = EXCLUDED.entity_type,
  display_name = EXCLUDED.display_name;

CREATE TABLE IF NOT EXISTS operations_carrier_rate_test_label_derivatives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gda'),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  source_label_id uuid NOT NULL,
  source_content_sha256 text NOT NULL
    CHECK (source_content_sha256 ~ '^[a-f0-9]{64}$'),
  format text NOT NULL CHECK (format IN ('ZPL', 'PDF', 'PNG')),
  media_size text NOT NULL CHECK (
    media_size IN ('label_4x6', 'label_4x8', 'letter', 'a4')
  ),
  artifact_payload bytea NOT NULL CHECK (
    octet_length(artifact_payload) BETWEEN 1 AND 10485760
  ),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  converter_name text NOT NULL CHECK (
    length(btrim(converter_name)) BETWEEN 1 AND 120
    AND converter_name !~ '[[:cntrl:]]'
  ),
  converter_version text NOT NULL CHECK (
    length(btrim(converter_version)) BETWEEN 1 AND 80
    AND converter_version !~ '[[:cntrl:]]'
  ),
  conversion_options jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(conversion_options) = 'object'),
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_carrier_rate_test_label_derivatives_global_valid
    CHECK (global_id ~ '^gda[0-9]{7}$'),
  CONSTRAINT operations_carrier_rate_test_label_derivatives_global_unique
    UNIQUE (global_id),
  CONSTRAINT operations_carrier_rate_test_label_derivatives_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_rate_test_label_derivatives_org_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT operations_carrier_rate_test_label_derivatives_source_fkey
    FOREIGN KEY (organization_id, source_label_id)
    REFERENCES operations_carrier_rate_test_labels(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_rate_test_label_derivatives_content_unique
    UNIQUE (
      organization_id,
      source_label_id,
      format,
      media_size,
      content_sha256
    )
);

CREATE OR REPLACE FUNCTION
  protect_operations_carrier_rate_test_label_derivative()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected_source_hash text;
  expected_artifact_hash text;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'Carrier label derived artifacts are immutable';
  END IF;

  SELECT content_sha256
    INTO expected_source_hash
    FROM operations_carrier_rate_test_labels
   WHERE organization_id = NEW.organization_id
     AND id = NEW.source_label_id;
  IF expected_source_hash IS NULL
     OR expected_source_hash IS DISTINCT FROM NEW.source_content_sha256 THEN
    RAISE EXCEPTION 'Carrier label derivative source hash does not match';
  END IF;

  expected_artifact_hash := encode(
    digest(NEW.artifact_payload, 'sha256'),
    'hex'
  );
  IF expected_artifact_hash IS DISTINCT FROM NEW.content_sha256 THEN
    RAISE EXCEPTION 'Carrier label derivative content hash does not match';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  protect_operations_carrier_rate_test_label_derivative_write
  ON operations_carrier_rate_test_label_derivatives;
CREATE TRIGGER protect_operations_carrier_rate_test_label_derivative_write
BEFORE INSERT OR UPDATE OR DELETE
ON operations_carrier_rate_test_label_derivatives
FOR EACH ROW EXECUTE FUNCTION
  protect_operations_carrier_rate_test_label_derivative();
