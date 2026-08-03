-- Exact, one-shot ClawPilot -> Faire Product-image publication.
--
-- The provider operation is two writes: upload immutable bytes, then attach
-- the returned Faire URL to the exact mapped Product. Raw provider URLs are
-- never durable evidence; only SHA-256 locator fingerprints are stored.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '25s';

CREATE TABLE IF NOT EXISTS operations_faire_product_image_delivery_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  pipeline_id uuid NOT NULL,
  product_id uuid NOT NULL,
  channel_state_id uuid NOT NULL,
  image_asset_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  desired_mode text NOT NULL CHECK (desired_mode IN ('shadow', 'active')),
  account_global_id text NOT NULL,
  external_account_id text NOT NULL,
  external_product_id text NOT NULL,
  external_variant_id text NOT NULL,
  product_reference_code text NOT NULL,
  product_source_hash text NOT NULL,
  channel_state_global_id text NOT NULL,
  channel_state_row_version bigint NOT NULL CHECK (channel_state_row_version >= 0),
  channel_source_revision text NOT NULL,
  channel_source_hash text NOT NULL,
  channel_normalized_status text NOT NULL,
  channel_provider_active boolean NOT NULL,
  asset_revision bigint NOT NULL CHECK (asset_revision >= 1),
  asset_row_version bigint NOT NULL CHECK (asset_row_version >= 1),
  asset_content_sha256 text NOT NULL,
  asset_mime_type text NOT NULL,
  asset_byte_length integer NOT NULL,
  asset_pixel_width integer NOT NULL,
  asset_pixel_height integer NOT NULL,
  asset_alt_text text NOT NULL,
  credential_generation integer NOT NULL CHECK (credential_generation >= 1),
  activation_revision integer NOT NULL CHECK (activation_revision >= 1),
  aggregate_revision bigint NOT NULL CHECK (aggregate_revision >= 1),
  aggregate_hash text NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  created_by text NOT NULL REFERENCES app_users(email) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT operations_faire_product_image_grant_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_faire_product_image_grant_pipeline_fkey
    FOREIGN KEY (organization_id, pipeline_id)
    REFERENCES pipeline_spaces(workspace_organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_faire_product_image_grant_product_fkey
    FOREIGN KEY (pipeline_id, product_id)
    REFERENCES crm_products(pipeline_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_faire_product_image_grant_channel_fkey
    FOREIGN KEY (organization_id, integration_account_id, channel_state_id)
    REFERENCES operations_product_channel_states(
      organization_id, integration_account_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_faire_product_image_grant_asset_fkey
    FOREIGN KEY (organization_id, pipeline_id, product_id, image_asset_id)
    REFERENCES crm_product_image_assets(
      organization_id, pipeline_id, product_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_faire_product_image_grant_idempotency_unique
    UNIQUE (organization_id, integration_account_id, idempotency_key),
  CONSTRAINT operations_faire_product_image_grant_org_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT operations_faire_product_image_grant_revision_unique
    UNIQUE (
      organization_id, integration_account_id, product_id,
      aggregate_revision
    ),
  CONSTRAINT operations_faire_product_image_grant_text_valid CHECK (
    length(btrim(idempotency_key)) BETWEEN 8 AND 255
    AND idempotency_key !~ '[[:cntrl:]]'
    AND account_global_id ~ '^gia(?:[0-9]{7}|[0-9a-v]{12})$'
    AND length(btrim(external_account_id)) BETWEEN 1 AND 255
    AND external_account_id !~ '[[:cntrl:]]'
    AND length(btrim(external_product_id)) BETWEEN 1 AND 512
    AND external_product_id !~ '[[:cntrl:]]'
    AND length(btrim(external_variant_id)) BETWEEN 1 AND 512
    AND external_variant_id !~ '[[:cntrl:]]'
    AND product_reference_code ~ '^gp(?:[0-9]{7}|[0-9a-v]{12})$'
    AND channel_state_global_id ~ '^gpcs(?:[0-9]{7}|[0-9a-v]{12})$'
    AND length(btrim(channel_source_revision)) BETWEEN 1 AND 2048
    AND channel_source_revision !~ '[[:cntrl:]]'
    AND length(btrim(asset_alt_text)) BETWEEN 1 AND 500
    AND asset_alt_text !~ '[[:cntrl:]]'
  ),
  CONSTRAINT operations_faire_product_image_grant_hashes_valid CHECK (
    product_source_hash ~ '^[a-f0-9]{64}$'
    AND channel_source_hash ~ '^[a-f0-9]{64}$'
    AND asset_content_sha256 ~ '^[a-f0-9]{64}$'
    AND aggregate_hash ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT operations_faire_product_image_grant_asset_valid CHECK (
    asset_mime_type IN ('image/png', 'image/jpeg', 'image/webp')
    AND asset_byte_length BETWEEN 1 AND 2097152
    AND asset_pixel_width BETWEEN 1 AND 8192
    AND asset_pixel_height BETWEEN 1 AND 8192
    AND asset_pixel_width::bigint * asset_pixel_height::bigint <= 40000000
  ),
  CONSTRAINT operations_faire_product_image_grant_channel_valid CHECK (
    channel_normalized_status = 'active'
    AND channel_provider_active = true
  ),
  CONSTRAINT operations_faire_product_image_grant_expiry_valid CHECK (
    expires_at > issued_at
    AND expires_at <= issued_at + CASE
      WHEN desired_mode = 'active' THEN interval '5 minutes'
      ELSE interval '1 minute'
    END
  )
);

CREATE INDEX IF NOT EXISTS operations_faire_product_image_grant_product_idx
  ON operations_faire_product_image_delivery_grants (
    organization_id, product_id, created_at DESC, id DESC
  );

CREATE OR REPLACE FUNCTION protect_operations_faire_product_image_grant()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Faire Product-image delivery grants are immutable';
END;
$$;

DROP TRIGGER IF EXISTS protect_operations_faire_product_image_grant_write
  ON operations_faire_product_image_delivery_grants;
CREATE TRIGGER protect_operations_faire_product_image_grant_write
BEFORE UPDATE OR DELETE ON operations_faire_product_image_delivery_grants
FOR EACH ROW EXECUTE FUNCTION protect_operations_faire_product_image_grant();

ALTER TABLE operations_faire_provider_write_authorizations
  ADD COLUMN IF NOT EXISTS product_image_delivery_grant_id uuid,
  ADD COLUMN IF NOT EXISTS shadow_simulation_effect_id uuid;

ALTER TABLE operations_faire_provider_write_authorizations
  DROP CONSTRAINT IF EXISTS operations_faire_write_auth_image_grant_fkey,
  ADD CONSTRAINT operations_faire_write_auth_image_grant_fkey
    FOREIGN KEY (organization_id, product_image_delivery_grant_id)
    REFERENCES operations_faire_product_image_delivery_grants(
      organization_id, id
    ) ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS operations_faire_write_auth_shadow_effect_fkey,
  ADD CONSTRAINT operations_faire_write_auth_shadow_effect_fkey
    FOREIGN KEY (organization_id, shadow_simulation_effect_id)
    REFERENCES operations_commerce_external_effect_intents(
      organization_id, id
    ) ON DELETE RESTRICT;

ALTER TABLE operations_faire_provider_write_authorizations
  DROP CONSTRAINT IF EXISTS operations_faire_provider_write_authorizations_action_check,
  ADD CONSTRAINT operations_faire_provider_write_authorizations_action_check
    CHECK (action IN (
      'faire.product.draft.create',
      'faire.product.image.publish'
    )),
  DROP CONSTRAINT IF EXISTS operations_faire_write_auth_capabilities_valid,
  ADD CONSTRAINT operations_faire_write_auth_capabilities_valid CHECK (
    operations_faire_write_capability_list_valid(capabilities)
    AND capabilities = CASE action
      WHEN 'faire.product.draft.create'
        THEN ARRAY['product_draft_create']::text[]
      WHEN 'faire.product.image.publish'
        THEN ARRAY['product_draft_update', 'product_image_upload']::text[]
    END
  ),
  -- 0220 declared this CHECK inline. PostgreSQL generated and truncated its
  -- identifier to this exact 63-byte name; dropping the untruncated spelling
  -- does not remove the legacy single-action constraint.
  DROP CONSTRAINT IF EXISTS operations_faire_provider_wr_confirmation_statement_versi_check,
  DROP CONSTRAINT IF EXISTS operations_faire_provider_write_authorizations_confirmation_statement_version_check,
  ADD CONSTRAINT operations_faire_write_auth_confirmation_version_valid
    CHECK (confirmation_statement_version = CASE action
      WHEN 'faire.product.draft.create' THEN 'faire-provider-write-v1'
      WHEN 'faire.product.image.publish'
        THEN 'faire-product-image-shadow-provider-write-v1'
    END),
  DROP CONSTRAINT IF EXISTS operations_faire_write_auth_request_shape,
  ADD CONSTRAINT operations_faire_write_auth_request_shape CHECK (
    (
      action = 'faire.product.draft.create'
      AND redacted_request->>'operation' = 'productDraftCreate'
      AND jsonb_typeof(redacted_request->'draft') = 'object'
      AND product_image_delivery_grant_id IS NULL
      AND shadow_simulation_effect_id IS NULL
    )
    OR (
      action = 'faire.product.image.publish'
      AND redacted_request->>'operation' = 'productImagePublish'
      AND jsonb_typeof(redacted_request->'patch') = 'object'
      AND product_image_delivery_grant_id IS NOT NULL
      AND shadow_simulation_effect_id IS NOT NULL
      AND redacted_request->>'deliveryGrantId' =
        product_image_delivery_grant_id::text
      AND redacted_request->>'shadowSimulationEffectId' =
        shadow_simulation_effect_id::text
    )
  );

ALTER TABLE operations_commerce_external_effect_intents
  DROP CONSTRAINT IF EXISTS operations_commerce_effect_faire_auth_shape,
  ADD CONSTRAINT operations_commerce_effect_faire_auth_shape CHECK (
    faire_provider_write_authorization_id IS NULL
    OR (
      provider = 'faire'
      AND action IN (
        'faire.product.draft.create',
        'faire.product.image.publish'
      )
      AND desired_mode = 'active'
    )
  );

CREATE OR REPLACE FUNCTION protect_operations_faire_product_image_authority()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  grant_row operations_faire_product_image_delivery_grants%ROWTYPE;
  simulation_row operations_commerce_external_effect_intents%ROWTYPE;
  shadow_grant operations_faire_product_image_delivery_grants%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Faire provider-write authorizations cannot be deleted';
  END IF;
  IF TG_OP = 'UPDATE' AND ROW(
    NEW.product_image_delivery_grant_id,
    NEW.shadow_simulation_effect_id
  ) IS DISTINCT FROM ROW(
    OLD.product_image_delivery_grant_id,
    OLD.shadow_simulation_effect_id
  ) THEN
    RAISE EXCEPTION 'Faire Product-image authority binding is immutable';
  END IF;
  IF NEW.action <> 'faire.product.image.publish' THEN
    IF NEW.product_image_delivery_grant_id IS NOT NULL
       OR NEW.shadow_simulation_effect_id IS NOT NULL THEN
      RAISE EXCEPTION 'Non-image Faire authority cannot bind image evidence';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO grant_row
  FROM operations_faire_product_image_delivery_grants
  WHERE organization_id = NEW.organization_id
    AND id = NEW.product_image_delivery_grant_id;
  SELECT * INTO simulation_row
  FROM operations_commerce_external_effect_intents
  WHERE organization_id = NEW.organization_id
    AND id = NEW.shadow_simulation_effect_id;
  SELECT shadow.* INTO shadow_grant
  FROM operations_faire_product_image_delivery_grants shadow
  WHERE shadow.organization_id = simulation_row.organization_id
    AND shadow.integration_account_id = simulation_row.integration_account_id
    AND shadow.idempotency_key = simulation_row.idempotency_key;
  IF grant_row.id IS NULL
     OR grant_row.desired_mode <> 'active'
     OR grant_row.integration_account_id <> NEW.integration_account_id
     OR grant_row.external_account_id <> NEW.external_account_id
     OR grant_row.credential_generation <> NEW.credential_generation
     OR grant_row.activation_revision <> NEW.activation_revision
     OR grant_row.product_reference_code <> NEW.aggregate_id
     OR grant_row.aggregate_revision <> NEW.aggregate_revision
     OR grant_row.aggregate_hash <> NEW.aggregate_hash
     OR grant_row.idempotency_key <> NEW.idempotency_key
     OR simulation_row.id IS NULL
     OR simulation_row.provider <> 'faire'
     OR simulation_row.action <> 'faire.product.image.publish'
     OR simulation_row.desired_mode <> 'shadow'
     OR simulation_row.state <> 'simulated'
     OR simulation_row.provider_write_count <> 0
     OR shadow_grant.id IS NULL
     OR shadow_grant.desired_mode <> 'shadow'
     OR shadow_grant.expires_at <= clock_timestamp()
     OR simulation_row.completed_at IS NULL
     OR simulation_row.completed_at < shadow_grant.issued_at
     OR simulation_row.completed_at > shadow_grant.expires_at
     OR ROW(
       shadow_grant.integration_account_id,
       shadow_grant.product_id,
       shadow_grant.channel_state_id,
       shadow_grant.image_asset_id,
       shadow_grant.external_product_id,
       shadow_grant.external_variant_id,
       shadow_grant.product_reference_code,
       shadow_grant.product_source_hash,
       shadow_grant.channel_state_row_version,
       shadow_grant.channel_source_revision,
       shadow_grant.channel_source_hash,
       shadow_grant.asset_revision,
       shadow_grant.asset_row_version,
       shadow_grant.asset_content_sha256,
       shadow_grant.credential_generation,
       shadow_grant.activation_revision
     ) IS DISTINCT FROM ROW(
       grant_row.integration_account_id,
       grant_row.product_id,
       grant_row.channel_state_id,
       grant_row.image_asset_id,
       grant_row.external_product_id,
       grant_row.external_variant_id,
       grant_row.product_reference_code,
       grant_row.product_source_hash,
       grant_row.channel_state_row_version,
       grant_row.channel_source_revision,
       grant_row.channel_source_hash,
       grant_row.asset_revision,
       grant_row.asset_row_version,
       grant_row.asset_content_sha256,
       grant_row.credential_generation,
       grant_row.activation_revision
     ) THEN
    RAISE EXCEPTION 'Faire Product-image authority does not match its exact Shadow simulation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_operations_faire_product_image_authority_write
  ON operations_faire_provider_write_authorizations;
CREATE TRIGGER protect_operations_faire_product_image_authority_write
BEFORE INSERT OR UPDATE OR DELETE
ON operations_faire_provider_write_authorizations
FOR EACH ROW EXECUTE FUNCTION protect_operations_faire_product_image_authority();

CREATE OR REPLACE FUNCTION operations_faire_provider_write_authority_is_current(
  requested_organization_id uuid,
  requested_authorization_id uuid,
  requested_integration_account_id uuid,
  requested_effect_global_id text,
  requested_credential_generation integer,
  requested_activation_revision integer,
  requested_action text,
  requested_aggregate_type text,
  requested_aggregate_id text,
  requested_aggregate_revision bigint,
  requested_aggregate_hash text,
  requested_idempotency_key text,
  requested_request_hash text,
  requested_redacted_request jsonb,
  requested_provider_attempt_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM operations_faire_provider_write_authorizations auth
    JOIN operations_faire_provider_write_scope_evidence evidence
      ON evidence.organization_id = auth.organization_id
     AND evidence.id = auth.scope_evidence_id
    JOIN operations_integration_accounts account
      ON account.organization_id = auth.organization_id
     AND account.id = auth.integration_account_id
    JOIN operations_commerce_credentials credential
      ON credential.organization_id = account.organization_id
     AND credential.integration_account_id = account.id
    JOIN operations_activation_scopes activation
      ON activation.organization_id = account.organization_id
    LEFT JOIN operations_commerce_provider_attempts attempt
      ON attempt.organization_id = auth.organization_id
     AND attempt.id = requested_provider_attempt_id
    LEFT JOIN operations_faire_product_image_delivery_grants image_grant
      ON image_grant.organization_id = auth.organization_id
     AND image_grant.id = auth.product_image_delivery_grant_id
    LEFT JOIN operations_commerce_external_effect_intents simulation
      ON simulation.organization_id = auth.organization_id
     AND simulation.id = auth.shadow_simulation_effect_id
    LEFT JOIN operations_faire_product_image_delivery_grants shadow_grant
      ON shadow_grant.organization_id = simulation.organization_id
     AND shadow_grant.integration_account_id = simulation.integration_account_id
     AND shadow_grant.idempotency_key = simulation.idempotency_key
    LEFT JOIN crm_products product
      ON product.pipeline_id = image_grant.pipeline_id
     AND product.id = image_grant.product_id
    LEFT JOIN operations_product_channel_states channel_state
      ON channel_state.organization_id = image_grant.organization_id
     AND channel_state.integration_account_id = image_grant.integration_account_id
     AND channel_state.id = image_grant.channel_state_id
    LEFT JOIN operations_product_mappings mapping
      ON mapping.organization_id = channel_state.organization_id
     AND mapping.integration_account_id = channel_state.integration_account_id
     AND mapping.pipeline_id = channel_state.pipeline_id
     AND mapping.id = channel_state.product_mapping_id
    LEFT JOIN crm_product_image_assets image_asset
      ON image_asset.organization_id = image_grant.organization_id
     AND image_asset.pipeline_id = image_grant.pipeline_id
     AND image_asset.product_id = image_grant.product_id
     AND image_asset.id = image_grant.image_asset_id
    WHERE auth.organization_id = requested_organization_id
      AND auth.id = requested_authorization_id
      AND auth.integration_account_id = requested_integration_account_id
      AND auth.external_account_id = account.external_account_id
      AND auth.credential_generation = requested_credential_generation
      AND auth.activation_state = 'shadow'
      AND auth.activation_revision = requested_activation_revision
      AND auth.action = requested_action
      AND auth.aggregate_type = requested_aggregate_type
      AND auth.aggregate_id = requested_aggregate_id
      AND auth.aggregate_revision = requested_aggregate_revision
      AND auth.aggregate_hash = requested_aggregate_hash
      AND auth.idempotency_key = requested_idempotency_key
      AND auth.request_hash = requested_request_hash
      AND auth.redacted_request = requested_redacted_request
      AND auth.request_hash = operations_faire_provider_write_request_hash(auth.redacted_request)
      AND operations_faire_provider_write_json_is_redacted(auth.redacted_request)
      AND auth.verified_write_scopes = ARRAY['WRITE_PRODUCTS']::text[]
      AND auth.scope_verification_source = evidence.verification_source
      AND auth.scope_evidence_hash = evidence.evidence_hash
      AND evidence.integration_account_id = auth.integration_account_id
      AND evidence.external_account_id = auth.external_account_id
      AND evidence.credential_generation = auth.credential_generation
      AND evidence.verified_write_scopes @> auth.verified_write_scopes
      AND operations_faire_provider_write_scope_evidence_is_current(
        auth.organization_id, auth.scope_evidence_id,
        auth.integration_account_id, auth.credential_generation
      )
      AND account.integration_type = 'commerce'
      AND account.provider = 'faire'
      AND account.environment = 'production'
      AND account.status = 'active'
      AND account.commerce_credential_generation = auth.credential_generation
      AND credential.credential_version = auth.credential_generation
      AND credential.verification_status = 'verified'
      AND activation.state = 'shadow'
      AND activation.revision = auth.activation_revision
      AND (
        (
          auth.action = 'faire.product.draft.create'
          AND auth.capabilities = ARRAY['product_draft_create']::text[]
          AND auth.product_image_delivery_grant_id IS NULL
          AND auth.shadow_simulation_effect_id IS NULL
        )
        OR (
          auth.action = 'faire.product.image.publish'
          AND auth.capabilities = ARRAY[
            'product_draft_update', 'product_image_upload'
          ]::text[]
          AND image_grant.desired_mode = 'active'
          AND image_grant.integration_account_id = auth.integration_account_id
          AND image_grant.credential_generation = auth.credential_generation
          AND image_grant.activation_revision = auth.activation_revision
          AND image_grant.product_reference_code = auth.aggregate_id
          AND image_grant.aggregate_revision = auth.aggregate_revision
          AND image_grant.aggregate_hash = auth.aggregate_hash
          AND image_grant.idempotency_key = auth.idempotency_key
          AND auth.redacted_request->>'deliveryGrantId' = image_grant.id::text
          AND auth.redacted_request->>'shadowSimulationEffectId' = simulation.id::text
          AND auth.redacted_request->'patch'->>'externalProductId' = image_grant.external_product_id
          AND auth.redacted_request->'patch'->>'assetContentSha256' = image_grant.asset_content_sha256
          AND simulation.provider = 'faire'
          AND simulation.action = auth.action
          AND simulation.desired_mode = 'shadow'
          AND simulation.state = 'simulated'
          AND simulation.provider_write_count = 0
          AND shadow_grant.desired_mode = 'shadow'
          AND shadow_grant.expires_at > clock_timestamp()
          AND simulation.completed_at IS NOT NULL
          AND simulation.completed_at >= shadow_grant.issued_at
          AND simulation.completed_at <= shadow_grant.expires_at
          AND shadow_grant.product_id = image_grant.product_id
          AND shadow_grant.channel_state_id = image_grant.channel_state_id
          AND shadow_grant.image_asset_id = image_grant.image_asset_id
          AND shadow_grant.product_source_hash = image_grant.product_source_hash
          AND shadow_grant.channel_state_row_version = image_grant.channel_state_row_version
          AND shadow_grant.channel_source_revision = image_grant.channel_source_revision
          AND shadow_grant.channel_source_hash = image_grant.channel_source_hash
          AND shadow_grant.asset_revision = image_grant.asset_revision
          AND shadow_grant.asset_row_version = image_grant.asset_row_version
          AND shadow_grant.asset_content_sha256 = image_grant.asset_content_sha256
          AND product.reference_code = image_grant.product_reference_code
          AND product.source_hash = image_grant.product_source_hash
          AND channel_state.product_id = image_grant.product_id
          AND channel_state.external_product_id = image_grant.external_product_id
          AND channel_state.external_variant_id = image_grant.external_variant_id
          AND channel_state.row_version = image_grant.channel_state_row_version
          AND channel_state.source_revision = image_grant.channel_source_revision
          AND channel_state.source_hash = image_grant.channel_source_hash
          AND channel_state.normalized_status = 'active'
          AND channel_state.provider_active = true
          AND mapping.product_id = image_grant.product_id
          AND mapping.external_product_id = image_grant.external_product_id
          AND mapping.external_variant_id = image_grant.external_variant_id
          AND mapping.active = true
          AND image_asset.asset_revision = image_grant.asset_revision
          AND image_asset.row_version = image_grant.asset_row_version
          AND image_asset.content_sha256 = image_grant.asset_content_sha256
          AND image_asset.is_primary = true
          AND NOT EXISTS (
            SELECT 1
            FROM operations_product_channel_states sibling
            WHERE sibling.organization_id = image_grant.organization_id
              AND sibling.integration_account_id = image_grant.integration_account_id
              AND sibling.provider = 'faire'
              AND sibling.external_product_id = image_grant.external_product_id
              AND sibling.product_id IS NOT NULL
              AND sibling.product_id <> image_grant.product_id
          )
        )
      )
      AND (
        (
          requested_provider_attempt_id IS NULL
          AND auth.state = 'active'
          AND auth.provider_attempt_id IS NULL
          AND auth.expires_at > clock_timestamp()
        )
        OR (
          requested_provider_attempt_id IS NOT NULL
          AND auth.state = 'consumed'
          AND auth.provider_attempt_id = requested_provider_attempt_id
          AND attempt.integration_account_id = auth.integration_account_id
          AND attempt.action = 'external_effect:' || auth.action
          AND attempt.external_object_id = requested_effect_global_id
          AND attempt.idempotency_key = auth.idempotency_key
          AND attempt.request_hash = auth.request_hash
          AND attempt.state = 'prepared'
          AND attempt.attempt_number = 1
        )
      )
  )
$$;

ALTER TABLE operations_faire_product_image_delivery_grants
  DROP CONSTRAINT IF EXISTS operations_faire_product_image_grant_step_identity_unique,
  ADD CONSTRAINT operations_faire_product_image_grant_step_identity_unique
    UNIQUE (organization_id, integration_account_id, id, idempotency_key);

ALTER TABLE operations_commerce_external_effect_intents
  DROP CONSTRAINT IF EXISTS operations_commerce_effect_step_identity_unique,
  ADD CONSTRAINT operations_commerce_effect_step_identity_unique
    UNIQUE (organization_id, integration_account_id, id, idempotency_key),
  DROP CONSTRAINT IF EXISTS operations_commerce_effect_step_attempt_unique,
  ADD CONSTRAINT operations_commerce_effect_step_attempt_unique
    UNIQUE (organization_id, id, provider_attempt_id);

CREATE TABLE IF NOT EXISTS operations_faire_product_image_provider_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  integration_account_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  delivery_grant_id uuid NOT NULL,
  external_effect_id uuid NOT NULL,
  provider_attempt_id uuid,
  stage text NOT NULL CHECK (stage IN ('upload', 'attach', 'reconcile')),
  outcome text NOT NULL CHECK (outcome IN (
    'succeeded', 'failed', 'unknown', 'observed_applied',
    'observed_absent', 'manual_review'
  )),
  uploaded_locator_sha256 text,
  provider_write_count integer NOT NULL CHECK (provider_write_count BETWEEN 0 AND 2),
  redacted_evidence jsonb NOT NULL,
  evidence_hash text NOT NULL CHECK (evidence_hash ~ '^[a-f0-9]{64}$'),
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  recorded_by text REFERENCES app_users(email) ON DELETE RESTRICT,
  CONSTRAINT operations_faire_product_image_step_grant_fkey
    FOREIGN KEY (organization_id, delivery_grant_id)
    REFERENCES operations_faire_product_image_delivery_grants(
      organization_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_faire_product_image_step_effect_fkey
    FOREIGN KEY (organization_id, external_effect_id)
    REFERENCES operations_commerce_external_effect_intents(
      organization_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_faire_product_image_step_attempt_fkey
    FOREIGN KEY (organization_id, provider_attempt_id)
    REFERENCES operations_commerce_provider_attempts(
      organization_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_faire_product_image_step_grant_identity_fkey
    FOREIGN KEY (
      organization_id, integration_account_id,
      delivery_grant_id, idempotency_key
    ) REFERENCES operations_faire_product_image_delivery_grants(
      organization_id, integration_account_id, id, idempotency_key
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_faire_product_image_step_effect_identity_fkey
    FOREIGN KEY (
      organization_id, integration_account_id,
      external_effect_id, idempotency_key
    ) REFERENCES operations_commerce_external_effect_intents(
      organization_id, integration_account_id, id, idempotency_key
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_faire_product_image_step_attempt_identity_fkey
    FOREIGN KEY (organization_id, external_effect_id, provider_attempt_id)
    REFERENCES operations_commerce_external_effect_intents(
      organization_id, id, provider_attempt_id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_faire_product_image_step_attempt_shape CHECK (
    (stage IN ('upload', 'attach') AND provider_attempt_id IS NOT NULL)
    OR (stage = 'reconcile' AND provider_attempt_id IS NULL)
  ),
  CONSTRAINT operations_faire_product_image_step_hash_valid CHECK (
    (uploaded_locator_sha256 IS NULL OR uploaded_locator_sha256 ~ '^[a-f0-9]{64}$')
    AND evidence_hash = operations_faire_provider_write_request_hash(redacted_evidence)
    AND operations_faire_provider_write_json_is_redacted(redacted_evidence)
  )
);

CREATE INDEX IF NOT EXISTS operations_faire_product_image_step_effect_idx
  ON operations_faire_product_image_provider_steps (
    organization_id, external_effect_id, observed_at DESC, id DESC
  );

CREATE OR REPLACE FUNCTION protect_operations_faire_product_image_step()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Faire Product-image provider-step evidence is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_operations_faire_product_image_step_write
  ON operations_faire_product_image_provider_steps;
CREATE TRIGGER protect_operations_faire_product_image_step_write
BEFORE UPDATE OR DELETE ON operations_faire_product_image_provider_steps
FOR EACH ROW EXECUTE FUNCTION protect_operations_faire_product_image_step();

COMMENT ON TABLE operations_faire_product_image_delivery_grants IS
  'Immutable exact Product, Faire listing, primary image, credential, and activation evidence for one Shadow simulation or one Active publication.';
COMMENT ON TABLE operations_faire_product_image_provider_steps IS
  'Append-only redacted provider-call and readback evidence. Raw Faire image URLs are prohibited; only locator SHA-256 values are stored.';
