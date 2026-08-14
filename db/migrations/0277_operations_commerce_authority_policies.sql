-- Revisioned provider-authority policy for Shopify and Faire orders and
-- inventory.  This foundation records desired inbound behavior but grants no
-- provider-write authority.  A later migration must add an exact outbound
-- adapter and a separate activation fence before ClawPilot authority can be
-- represented here.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

INSERT INTO global_reference_entity_types (prefix, entity_type, display_name)
VALUES
  ('gaup', 'operations.commerce_authority_policy', 'Commerce authority policy revision'),
  ('gaud', 'operations.commerce_provider_write_scope_request', 'Commerce provider write scope request')
ON CONFLICT (prefix) DO UPDATE SET
  entity_type = EXCLUDED.entity_type,
  display_name = EXCLUDED.display_name;

CREATE TABLE IF NOT EXISTS operations_commerce_authority_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gaup'),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('shopify', 'faire')),
  resource text NOT NULL CHECK (resource IN ('orders', 'inventory')),
  revision bigint NOT NULL CHECK (revision > 0),
  authority_mode text NOT NULL CHECK (
    (provider = 'faire' AND resource = 'inventory'
      AND authority_mode = 'observation_only')
    OR (NOT (provider = 'faire' AND resource = 'inventory')
      AND authority_mode = 'provider')
  ),
  desired_ingest_mode text NOT NULL CHECK (
    (provider = 'shopify' AND resource = 'orders'
      AND desired_ingest_mode =
        'windowed_history_and_core_order_signals_plus_poll')
    OR (provider = 'faire' AND resource = 'orders'
      AND desired_ingest_mode =
        'provider_available_history_and_continuous_poll')
    OR (provider = 'shopify' AND resource = 'inventory'
      AND desired_ingest_mode = 'current_snapshot_and_realtime')
    OR (provider = 'faire' AND resource = 'inventory'
      AND desired_ingest_mode = 'observation_only')
  ),
  provider_write_mode text NOT NULL CHECK (provider_write_mode = 'disabled'),
  provider_write_count integer NOT NULL DEFAULT 0 CHECK (provider_write_count = 0),
  expected_previous_revision bigint NOT NULL
    CHECK (expected_previous_revision >= 0),
  reason text NOT NULL,
  actor_email text NOT NULL REFERENCES app_users(email) ON DELETE RESTRICT,
  actor_role text NOT NULL CHECK (actor_role IN ('owner', 'admin')),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_commerce_authority_policies_global_valid CHECK (
    global_id ~ '^gaup(?:[0-9]{7}|[0-9a-v]{12})$'
  ),
  CONSTRAINT operations_commerce_authority_policies_global_unique
    UNIQUE (global_id),
  CONSTRAINT operations_commerce_authority_policies_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_authority_policies_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_authority_policies_revision_unique
    UNIQUE (organization_id, integration_account_id, resource, revision),
  CONSTRAINT operations_commerce_authority_policies_idempotency_unique
    UNIQUE (organization_id, integration_account_id, idempotency_key),
  CONSTRAINT operations_commerce_authority_policies_org_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT operations_commerce_authority_policies_revision_chain_valid CHECK (
    revision = expected_previous_revision + 1
  ),
  CONSTRAINT operations_commerce_authority_policies_text_valid CHECK (
    length(btrim(reason)) BETWEEN 10 AND 500
    AND reason !~ '[[:cntrl:]]'
    AND length(btrim(idempotency_key)) BETWEEN 8 AND 200
    AND idempotency_key !~ '[[:cntrl:]]'
  )
);

CREATE INDEX IF NOT EXISTS operations_commerce_authority_policies_current_idx
  ON operations_commerce_authority_policies (
    organization_id, integration_account_id, resource, revision DESC
  );

CREATE OR REPLACE VIEW operations_commerce_authority_policy_current AS
SELECT
  account.organization_id,
  account.id AS integration_account_id,
  account.global_id AS account_global_id,
  account.display_name AS account_display_name,
  account.environment AS account_environment,
  account.status AS account_status,
  account.provider,
  resource.name AS resource,
  policy.global_id,
  COALESCE(policy.revision, 0::bigint) AS revision,
  COALESCE(
    policy.authority_mode,
    CASE
      WHEN account.provider = 'faire' AND resource.name = 'inventory'
      THEN 'observation_only'
      ELSE 'provider'
    END
  ) AS authority_mode,
  COALESCE(
    policy.desired_ingest_mode,
    CASE
      WHEN account.provider = 'shopify' AND resource.name = 'orders'
      THEN 'windowed_history_and_core_order_signals_plus_poll'
      WHEN account.provider = 'faire' AND resource.name = 'orders'
      THEN 'provider_available_history_and_continuous_poll'
      WHEN account.provider = 'shopify'
      THEN 'current_snapshot_and_realtime'
      ELSE 'observation_only'
    END
  ) AS desired_ingest_mode,
  COALESCE(policy.provider_write_mode, 'disabled') AS provider_write_mode,
  COALESCE(policy.provider_write_count, 0) AS provider_write_count,
  COALESCE(policy.expected_previous_revision, 0::bigint)
    AS expected_previous_revision,
  policy.reason,
  policy.actor_email,
  policy.actor_role,
  policy.idempotency_key,
  policy.request_hash,
  policy.created_at,
  policy.id IS NULL AS effective_from_default
FROM operations_integration_accounts account
CROSS JOIN (VALUES ('orders'::text), ('inventory'::text)) resource(name)
LEFT JOIN LATERAL (
  SELECT candidate.*
  FROM operations_commerce_authority_policies candidate
  WHERE candidate.organization_id = account.organization_id
    AND candidate.integration_account_id = account.id
    AND candidate.provider = account.provider
    AND candidate.resource = resource.name
  ORDER BY candidate.revision DESC
  LIMIT 1
) policy ON true
WHERE account.integration_type = 'commerce'
  AND account.provider IN ('shopify', 'faire');

CREATE OR REPLACE FUNCTION validate_operations_commerce_authority_policy()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM app_user_organization_memberships membership
    WHERE membership.organization_id = NEW.organization_id
      AND membership.user_email = NEW.actor_email
      AND membership.status = 'active'
      AND membership.role = NEW.actor_role
      AND (
        membership.role = 'owner'
        OR (
          membership.role = 'admin'
          AND COALESCE(
            (membership.permissions->>'manageOperations')::boolean,
            false
          )
        )
      )
  ) THEN
    RAISE EXCEPTION
      'commerce authority policy requires an active owner or operations administrator';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM operations_integration_accounts account
    JOIN operations_commerce_credentials credential
      ON credential.organization_id = account.organization_id
     AND credential.integration_account_id = account.id
    WHERE account.organization_id = NEW.organization_id
      AND account.id = NEW.integration_account_id
      AND account.integration_type = 'commerce'
      AND account.provider = NEW.provider
      AND account.provider IN ('shopify', 'faire')
      AND (
        (account.provider = 'shopify'
          AND credential.auth_mode = 'shopify_client_credentials')
        OR (account.provider = 'faire'
          AND credential.auth_mode IN ('faire_brand_token', 'faire_oauth'))
      )
      AND account.status = 'active'
      AND account.external_account_id IS NOT NULL
      AND account.commerce_credential_generation > 0
      AND credential.external_account_id = account.external_account_id
      AND credential.credential_version =
            account.commerce_credential_generation
      AND credential.verification_status = 'verified'
  ) THEN
    RAISE EXCEPTION
      'commerce authority policy requires an active account with current verified credentials';
  END IF;

  IF NEW.revision = 1 THEN
    IF NEW.expected_previous_revision <> 0 OR EXISTS (
      SELECT 1
      FROM operations_commerce_authority_policies prior
      WHERE prior.organization_id = NEW.organization_id
        AND prior.integration_account_id = NEW.integration_account_id
        AND prior.resource = NEW.resource
    ) THEN
      RAISE EXCEPTION 'commerce authority policy initial revision is invalid';
    END IF;
  ELSIF NOT EXISTS (
    SELECT 1
    FROM operations_commerce_authority_policies prior
    WHERE prior.organization_id = NEW.organization_id
      AND prior.integration_account_id = NEW.integration_account_id
      AND prior.resource = NEW.resource
      AND prior.revision = NEW.expected_previous_revision
      AND NOT EXISTS (
        SELECT 1
        FROM operations_commerce_authority_policies later
        WHERE later.organization_id = prior.organization_id
          AND later.integration_account_id = prior.integration_account_id
          AND later.resource = prior.resource
          AND later.revision > prior.revision
      )
  ) THEN
    RAISE EXCEPTION 'commerce authority policy revision lineage is invalid';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS operations_commerce_authority_policies_lineage_guard
  ON operations_commerce_authority_policies;
CREATE TRIGGER operations_commerce_authority_policies_lineage_guard
BEFORE INSERT ON operations_commerce_authority_policies
FOR EACH ROW EXECUTE FUNCTION validate_operations_commerce_authority_policy();

CREATE OR REPLACE FUNCTION reject_operations_commerce_authority_policy_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'commerce authority policy revisions are immutable';
END;
$$;

DROP TRIGGER IF EXISTS operations_commerce_authority_policies_immutable
  ON operations_commerce_authority_policies;
CREATE TRIGGER operations_commerce_authority_policies_immutable
BEFORE UPDATE OR DELETE ON operations_commerce_authority_policies
FOR EACH ROW EXECUTE FUNCTION reject_operations_commerce_authority_policy_mutation();

CREATE TABLE IF NOT EXISTS operations_commerce_provider_write_scope_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gaud'),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  pipeline_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  product_mapping_id uuid NOT NULL,
  product_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider = 'shopify'),
  account_environment text NOT NULL CHECK (account_environment = 'sandbox'),
  deployment_scope text NOT NULL CHECK (deployment_scope = 'development'),
  requested_resources text[] NOT NULL CHECK (
    requested_resources = ARRAY['orders', 'inventory']::text[]
  ),
  state text NOT NULL CHECK (state = 'blocked'),
  provider_write_enabled boolean NOT NULL DEFAULT false
    CHECK (provider_write_enabled = false),
  supported_outbound_effect text CHECK (supported_outbound_effect IS NULL),
  blocker_codes text[] NOT NULL CHECK (
    blocker_codes = ARRAY[
      'COMMERCE_ORDER_WRITE_ADAPTER_UNAVAILABLE',
      'COMMERCE_CUSTOMER_SCOPED_INVENTORY_NOT_REPRESENTABLE'
    ]::text[]
  ),
  account_global_id text NOT NULL,
  external_account_id text NOT NULL,
  customer_global_id text NOT NULL,
  product_global_id text NOT NULL,
  product_mapping_global_id text NOT NULL,
  channel_sku text NOT NULL,
  external_product_id text NOT NULL,
  external_variant_id text NOT NULL,
  external_inventory_item_id text NOT NULL,
  credential_generation integer NOT NULL CHECK (credential_generation > 0),
  product_mapping_updated_at timestamptz NOT NULL,
  channel_state_id uuid NOT NULL,
  channel_state_row_version bigint NOT NULL CHECK (channel_state_row_version >= 0),
  channel_state_source_hash text NOT NULL
    CHECK (channel_state_source_hash ~ '^[a-f0-9]{64}$'),
  channel_state_observed_at timestamptz NOT NULL,
  request_reason text NOT NULL,
  recorded_by text NOT NULL REFERENCES app_users(email) ON DELETE RESTRICT,
  recorded_role text NOT NULL CHECK (recorded_role IN ('owner', 'admin')),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_commerce_provider_write_scope_requests_global_valid
    CHECK (global_id ~ '^gaud(?:[0-9]{7}|[0-9a-v]{12})$'),
  CONSTRAINT operations_commerce_provider_write_scope_requests_global_unique
    UNIQUE (global_id),
  CONSTRAINT operations_commerce_provider_write_scope_requests_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_provider_write_scope_requests_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_provider_write_scope_requests_customer_fkey
    FOREIGN KEY (pipeline_id, customer_id)
    REFERENCES crm_organizations(pipeline_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_provider_write_scope_requests_mapping_fkey
    FOREIGN KEY (
      organization_id, integration_account_id, pipeline_id,
      product_mapping_id, product_id
    ) REFERENCES operations_product_mappings (
      organization_id, integration_account_id, pipeline_id, id, product_id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_provider_write_scope_requests_channel_fkey
    FOREIGN KEY (organization_id, channel_state_id)
    REFERENCES operations_product_channel_states(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_provider_write_scope_requests_exact_unique
    UNIQUE (
      organization_id, integration_account_id, customer_id,
      product_mapping_id, deployment_scope
    ),
  CONSTRAINT operations_commerce_provider_write_scope_requests_idempotency_unique
    UNIQUE (organization_id, integration_account_id, idempotency_key),
  CONSTRAINT operations_commerce_provider_write_scope_requests_text_valid CHECK (
    account_global_id ~ '^gia(?:[0-9]{7}|[0-9a-v]{12})$'
    AND customer_global_id ~ '^ga(?:[0-9]{7}|[0-9a-v]{12})$'
    AND product_global_id ~ '^gp(?:[0-9]{7}|[0-9a-v]{12})$'
    AND product_mapping_global_id ~ '^gpm(?:[0-9]{7}|[0-9a-v]{12})$'
    AND length(btrim(channel_sku)) BETWEEN 1 AND 255
    AND length(btrim(external_account_id)) BETWEEN 1 AND 512
    AND length(btrim(external_product_id)) BETWEEN 1 AND 512
    AND length(btrim(external_variant_id)) BETWEEN 1 AND 512
    AND length(btrim(external_inventory_item_id)) BETWEEN 1 AND 512
    AND length(btrim(request_reason)) BETWEEN 10 AND 500
    AND length(btrim(idempotency_key)) BETWEEN 8 AND 200
    AND idempotency_key !~ '[[:cntrl:]]'
    AND request_reason !~ '[[:cntrl:]]'
  )
);

CREATE OR REPLACE FUNCTION validate_operations_commerce_write_scope_request()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.provider_write_enabled
     OR NEW.supported_outbound_effect IS NOT NULL
     OR NEW.state <> 'blocked' THEN
    RAISE EXCEPTION 'commerce provider write scope request cannot authorize writes';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM app_user_organization_memberships membership
    WHERE membership.organization_id = NEW.organization_id
      AND membership.user_email = NEW.recorded_by
      AND membership.status = 'active'
      AND membership.role = NEW.recorded_role
      AND (
        membership.role = 'owner'
        OR (
          membership.role = 'admin'
          AND COALESCE(
            (membership.permissions->>'manageOperations')::boolean,
            false
          )
        )
      )
  ) THEN
    RAISE EXCEPTION
      'commerce provider write scope request requires an active owner or operations administrator';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM operations_integration_accounts account
    JOIN operations_product_mappings mapping
      ON mapping.organization_id = account.organization_id
     AND mapping.integration_account_id = account.id
    JOIN crm_products product
      ON product.pipeline_id = mapping.pipeline_id
     AND product.id = mapping.product_id
    JOIN crm_organizations customer
      ON customer.pipeline_id = mapping.pipeline_id
     AND customer.id = NEW.customer_id
    JOIN operations_commerce_credentials credential
      ON credential.organization_id = account.organization_id
     AND credential.integration_account_id = account.id
    JOIN operations_product_channel_states channel_state
      ON channel_state.organization_id = mapping.organization_id
     AND channel_state.integration_account_id = mapping.integration_account_id
     AND channel_state.id = NEW.channel_state_id
    WHERE account.organization_id = NEW.organization_id
      AND account.id = NEW.integration_account_id
      AND account.integration_type = 'commerce'
      AND account.provider = NEW.provider
      AND account.environment = NEW.account_environment
      AND account.status = 'active'
      AND account.global_id = NEW.account_global_id
      AND account.external_account_id = NEW.external_account_id
      AND account.commerce_credential_generation = NEW.credential_generation
      AND credential.credential_version = NEW.credential_generation
      AND credential.auth_mode = 'shopify_client_credentials'
      AND credential.verification_status = 'verified'
      AND credential.last_error_code IS NULL
      AND credential.external_account_id = account.external_account_id
      AND mapping.pipeline_id = NEW.pipeline_id
      AND mapping.id = NEW.product_mapping_id
      AND mapping.product_id = NEW.product_id
      AND mapping.global_id = NEW.product_mapping_global_id
      AND mapping.channel_sku = NEW.channel_sku
      AND mapping.external_product_id = NEW.external_product_id
      AND mapping.external_variant_id = NEW.external_variant_id
      AND mapping.external_inventory_item_id = NEW.external_inventory_item_id
      AND mapping.active = true
      AND mapping.updated_at = NEW.product_mapping_updated_at
      AND product.reference_code = NEW.product_global_id
      AND product.active = true
      AND customer.reference_code = NEW.customer_global_id
      AND channel_state.provider = 'shopify'
      AND channel_state.integration_account_id = account.id
      AND channel_state.pipeline_id = mapping.pipeline_id
      AND channel_state.product_mapping_id = mapping.id
      AND channel_state.product_id = mapping.product_id
      AND channel_state.external_product_id = NEW.external_product_id
      AND channel_state.external_variant_id = NEW.external_variant_id
      AND channel_state.external_inventory_item_id = NEW.external_inventory_item_id
      AND channel_state.normalized_status IN ('active', 'unlisted')
      AND channel_state.row_version = NEW.channel_state_row_version
      AND channel_state.source_hash = NEW.channel_state_source_hash
      AND channel_state.observed_at = NEW.channel_state_observed_at
  ) THEN
    RAISE EXCEPTION 'commerce provider write scope request lineage is invalid';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS operations_commerce_provider_write_scope_requests_lineage_guard
  ON operations_commerce_provider_write_scope_requests;
CREATE TRIGGER operations_commerce_provider_write_scope_requests_lineage_guard
BEFORE INSERT ON operations_commerce_provider_write_scope_requests
FOR EACH ROW EXECUTE FUNCTION validate_operations_commerce_write_scope_request();

CREATE OR REPLACE FUNCTION reject_operations_commerce_write_scope_request_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'commerce provider write scope requests are immutable';
END;
$$;

DROP TRIGGER IF EXISTS operations_commerce_provider_write_scope_requests_immutable
  ON operations_commerce_provider_write_scope_requests;
CREATE TRIGGER operations_commerce_provider_write_scope_requests_immutable
BEFORE UPDATE OR DELETE ON operations_commerce_provider_write_scope_requests
FOR EACH ROW EXECUTE FUNCTION reject_operations_commerce_write_scope_request_mutation();

COMMENT ON TABLE operations_commerce_authority_policies IS
  'Append-only per-account and per-resource desired authority policy revisions. Shopify and Faire orders are provider-authoritative, Shopify inventory is a current provider projection, and Faire inventory is observation-only. Provider writes remain disabled.';

COMMENT ON VIEW operations_commerce_authority_policy_current IS
  'Effective desired policy for every Shopify and Faire order and inventory resource. Actual account, credential, historical backfill, continuous poll, and inventory freshness readiness is reported separately by the application.';

COMMENT ON TABLE operations_commerce_provider_write_scope_requests IS
  'Immutable exact-scope requests only. Rows in this table cannot authorize or execute a provider write.';
