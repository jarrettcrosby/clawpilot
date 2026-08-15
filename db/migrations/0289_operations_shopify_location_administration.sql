-- Development-only Shopify merchant-location administration.
--
-- This control plane is intentionally separate from inventory projection and
-- from the broad commerce capability map.  It can add, edit, or activate one
-- merchant-managed Shopify Location after a five-minute owner/admin grant. It
-- can never deactivate/delete a location, change inventory quantities, or
-- mutate a fulfillment-service location.  Every provider dispatch is claimed
-- durably before the network call and an ambiguous dispatch is reconciliation
-- only: it is never blindly retried.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

INSERT INTO global_reference_entity_types (prefix, entity_type, display_name)
VALUES
  (
    'gsla',
    'operations.shopify_location_administration_authorization',
    'Shopify location administration authorization'
  ),
  (
    'gslt',
    'operations.shopify_location_administration_attempt',
    'Shopify location administration attempt'
  ),
  (
    'gslo',
    'operations.shopify_location_administration_outcome',
    'Shopify location administration outcome'
  )
ON CONFLICT (prefix) DO UPDATE SET
  entity_type = EXCLUDED.entity_type,
  display_name = EXCLUDED.display_name;

CREATE TABLE IF NOT EXISTS
  operations_shopify_location_administration_authorizations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    global_id text NOT NULL DEFAULT allocate_global_reference('gsla'),
    organization_id uuid NOT NULL
      REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
    integration_account_id uuid NOT NULL,
    integration_account_global_id text NOT NULL,
    provider text NOT NULL DEFAULT 'shopify' CHECK (provider = 'shopify'),
    account_environment text NOT NULL CHECK (account_environment = 'sandbox'),
    external_account_id text NOT NULL,
    shop_domain text NOT NULL,
    credential_generation integer NOT NULL CHECK (credential_generation > 0),
    activation_state text NOT NULL CHECK (
      activation_state IN ('shadow', 'active')
    ),
    activation_revision integer NOT NULL CHECK (activation_revision > 0),
    action text NOT NULL CHECK (
      action IN ('locationAdd', 'locationEdit', 'locationActivate')
    ),
    warehouse_id uuid NOT NULL,
    warehouse_global_id text NOT NULL,
    warehouse_row_version bigint NOT NULL CHECK (warehouse_row_version >= 0),
    warehouse_address_hash text NOT NULL CHECK (
      warehouse_address_hash ~ '^[a-f0-9]{64}$'
    ),
    location_mapping_id uuid,
    location_mapping_global_id text,
    location_mapping_row_version bigint,
    provider_location_id text,
    provider_snapshot_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    provider_snapshot_hash text,
    provider_location_set_hash text,
    provider_observed_at timestamptz NOT NULL,
    desired_location_json jsonb NOT NULL,
    desired_location_hash text NOT NULL CHECK (
      desired_location_hash ~ '^[a-f0-9]{64}$'
    ),
    authorization_reason text NOT NULL,
    confirmation_statement_version text NOT NULL CHECK (
      confirmation_statement_version = 'shopify-location-administration-v1'
    ),
    confirmation_hash text NOT NULL CHECK (
      confirmation_hash ~ '^[a-f0-9]{64}$'
    ),
    idempotency_key text NOT NULL,
    request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
    provider_idempotency_key uuid NOT NULL DEFAULT gen_random_uuid(),
    status text NOT NULL DEFAULT 'prepared' CHECK (
      status IN (
        'prepared', 'processing', 'succeeded', 'failed', 'unknown',
        'reconciled'
      )
    ),
    authorized_by text NOT NULL REFERENCES app_users(email) ON DELETE RESTRICT,
    authorized_role text NOT NULL CHECK (authorized_role IN ('owner', 'admin')),
    provider_attempt_id uuid,
    latest_outcome_id uuid,
    prepared_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL,
    processing_at timestamptz,
    completed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ops_shopify_location_admin_auth_global_valid CHECK (
      global_reference_code_is_valid(global_id, 'gsla')
    ),
    CONSTRAINT ops_shopify_location_admin_auth_global_unique UNIQUE (global_id),
    CONSTRAINT ops_shopify_location_admin_auth_org_id_unique
      UNIQUE (organization_id, id),
    CONSTRAINT ops_shopify_location_admin_auth_org_global_unique
      UNIQUE (organization_id, global_id),
    CONSTRAINT ops_shopify_location_admin_auth_registry_fkey
      FOREIGN KEY (global_id)
      REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
    CONSTRAINT ops_shopify_location_admin_auth_account_fkey
      FOREIGN KEY (organization_id, integration_account_id)
      REFERENCES operations_integration_accounts(organization_id, id)
      ON DELETE RESTRICT,
    CONSTRAINT ops_shopify_location_admin_auth_warehouse_fkey
      FOREIGN KEY (organization_id, warehouse_id)
      REFERENCES operations_warehouses(organization_id, id)
      ON DELETE RESTRICT,
    CONSTRAINT ops_shopify_location_admin_auth_mapping_fkey
      FOREIGN KEY (
        organization_id, integration_account_id, location_mapping_id
      ) REFERENCES operations_commerce_inventory_location_mappings (
        organization_id, integration_account_id, id
      ) ON DELETE RESTRICT,
    CONSTRAINT ops_shopify_location_admin_auth_idempotency_unique
      UNIQUE (organization_id, integration_account_id, idempotency_key),
    CONSTRAINT ops_shopify_location_admin_auth_identity_valid CHECK (
      global_reference_code_is_valid(
        integration_account_global_id, 'gia'
      )
      AND global_reference_code_is_valid(warehouse_global_id, 'gwh')
      AND external_account_id ~
        '^gid://shopify/Shop/[1-9][0-9]{0,20}$'
      AND shop_domain = lower(shop_domain)
      AND shop_domain ~
        '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$'
    ),
    CONSTRAINT ops_shopify_location_admin_auth_json_valid CHECK (
      jsonb_typeof(provider_snapshot_json) = 'object'
      AND jsonb_typeof(desired_location_json) = 'object'
      AND desired_location_json <> '{}'::jsonb
    ),
    CONSTRAINT ops_shopify_location_admin_auth_text_valid CHECK (
      length(btrim(idempotency_key)) BETWEEN 8 AND 200
      AND idempotency_key !~ '[[:cntrl:]]'
      AND length(btrim(authorization_reason)) BETWEEN 10 AND 500
      AND authorization_reason !~ '[[:cntrl:]]'
    ),
    CONSTRAINT ops_shopify_location_admin_auth_window_valid CHECK (
      expires_at = prepared_at + interval '5 minutes'
      AND provider_observed_at >= prepared_at - interval '2 minutes'
      AND provider_observed_at <= prepared_at + interval '1 minute'
    ),
    CONSTRAINT ops_shopify_location_admin_auth_action_valid CHECK (
      (
        action = 'locationAdd'
        AND location_mapping_id IS NULL
        AND location_mapping_global_id IS NULL
        AND location_mapping_row_version IS NULL
        AND provider_location_id IS NULL
        AND provider_snapshot_json = '{}'::jsonb
        AND provider_snapshot_hash IS NULL
        AND provider_location_set_hash ~ '^[a-f0-9]{64}$'
      )
      OR (
        action IN ('locationEdit', 'locationActivate')
        AND location_mapping_id IS NOT NULL
        AND global_reference_code_is_valid(
          location_mapping_global_id, 'gilm'
        )
        AND location_mapping_row_version >= 0
        AND provider_location_id ~
          '^gid://shopify/Location/[1-9][0-9]{0,20}$'
        AND provider_snapshot_json @>
          '{"isFulfillmentService": false}'::jsonb
        AND provider_snapshot_hash ~ '^[a-f0-9]{64}$'
        AND provider_location_set_hash IS NULL
      )
    ),
    CONSTRAINT ops_shopify_location_admin_auth_state_valid CHECK (
      (
        status = 'prepared'
        AND provider_attempt_id IS NULL
        AND latest_outcome_id IS NULL
        AND processing_at IS NULL
        AND completed_at IS NULL
      )
      OR (
        status = 'processing'
        AND provider_attempt_id IS NOT NULL
        AND latest_outcome_id IS NULL
        AND processing_at IS NOT NULL
        AND completed_at IS NULL
      )
      OR (
        status IN ('succeeded', 'failed', 'unknown', 'reconciled')
        AND provider_attempt_id IS NOT NULL
        AND latest_outcome_id IS NOT NULL
        AND processing_at IS NOT NULL
        AND completed_at IS NOT NULL
        AND completed_at >= processing_at
      )
    )
  );

COMMENT ON TABLE
  operations_shopify_location_administration_authorizations IS
  'Five-minute, actor-bound development grants for add/edit/activate of merchant-managed Shopify locations. This table grants no inventory writes, fulfillment-service ownership, deactivation, or deletion.';

CREATE UNIQUE INDEX IF NOT EXISTS
  ops_shopify_location_admin_one_unresolved_account_idx
  ON operations_shopify_location_administration_authorizations (
    organization_id, integration_account_id
  ) WHERE status IN ('processing', 'unknown');

CREATE INDEX IF NOT EXISTS ops_shopify_location_admin_auth_history_idx
  ON operations_shopify_location_administration_authorizations (
    organization_id, integration_account_id, prepared_at DESC, id DESC
  );

CREATE TABLE IF NOT EXISTS operations_shopify_location_administration_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gslt'),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  authorization_id uuid NOT NULL,
  integration_account_id uuid NOT NULL,
  action text NOT NULL CHECK (
    action IN ('locationAdd', 'locationEdit', 'locationActivate')
  ),
  provider_location_id text,
  credential_generation integer NOT NULL CHECK (credential_generation > 0),
  activation_revision integer NOT NULL CHECK (activation_revision > 0),
  provider_idempotency_key uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  dispatch_state text NOT NULL DEFAULT 'authorized' CHECK (
    dispatch_state = 'authorized'
  ),
  claimed_by text NOT NULL REFERENCES app_users(email) ON DELETE RESTRICT,
  claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ops_shopify_location_admin_attempt_global_valid CHECK (
    global_reference_code_is_valid(global_id, 'gslt')
  ),
  CONSTRAINT ops_shopify_location_admin_attempt_global_unique
    UNIQUE (global_id),
  CONSTRAINT ops_shopify_location_admin_attempt_org_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT ops_shopify_location_admin_attempt_org_global_unique
    UNIQUE (organization_id, global_id),
  CONSTRAINT ops_shopify_location_admin_attempt_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT ops_shopify_location_admin_attempt_auth_fkey
    FOREIGN KEY (organization_id, authorization_id)
    REFERENCES operations_shopify_location_administration_authorizations(
      organization_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT ops_shopify_location_admin_attempt_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT ops_shopify_location_admin_attempt_authorization_unique
    UNIQUE (organization_id, authorization_id),
  CONSTRAINT ops_shopify_location_admin_attempt_action_valid CHECK (
    (action = 'locationAdd' AND provider_location_id IS NULL)
    OR (
      action IN ('locationEdit', 'locationActivate')
      AND provider_location_id ~
        '^gid://shopify/Location/[1-9][0-9]{0,20}$'
    )
  )
);

COMMENT ON TABLE operations_shopify_location_administration_attempts IS
  'Immutable authority for exactly one Shopify location mutation. An attempt with no terminal outcome is never redispatched.';

CREATE TABLE IF NOT EXISTS operations_shopify_location_administration_outcomes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gslo'),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  authorization_id uuid NOT NULL,
  provider_attempt_id uuid NOT NULL,
  outcome_state text NOT NULL CHECK (
    outcome_state IN ('succeeded', 'failed', 'unknown', 'reconciled')
  ),
  reconciliation_resolution text CHECK (
    reconciliation_resolution IS NULL
    OR reconciliation_resolution = 'confirmed_applied'
  ),
  provider_write_count integer CHECK (provider_write_count BETWEEN 0 AND 1),
  provider_location_id text,
  provider_reference text,
  evidence_json jsonb NOT NULL,
  evidence_hash text NOT NULL CHECK (evidence_hash ~ '^[a-f0-9]{64}$'),
  error_code text CHECK (
    error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{1,127}$'
  ),
  recorded_by text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ops_shopify_location_admin_outcome_global_valid CHECK (
    global_reference_code_is_valid(global_id, 'gslo')
  ),
  CONSTRAINT ops_shopify_location_admin_outcome_global_unique
    UNIQUE (global_id),
  CONSTRAINT ops_shopify_location_admin_outcome_org_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT ops_shopify_location_admin_outcome_org_global_unique
    UNIQUE (organization_id, global_id),
  CONSTRAINT ops_shopify_location_admin_outcome_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT ops_shopify_location_admin_outcome_auth_fkey
    FOREIGN KEY (organization_id, authorization_id)
    REFERENCES operations_shopify_location_administration_authorizations(
      organization_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT ops_shopify_location_admin_outcome_attempt_fkey
    FOREIGN KEY (organization_id, provider_attempt_id)
    REFERENCES operations_shopify_location_administration_attempts(
      organization_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT ops_shopify_location_admin_outcome_state_unique
    UNIQUE (organization_id, authorization_id, outcome_state),
  CONSTRAINT ops_shopify_location_admin_outcome_json_valid CHECK (
    jsonb_typeof(evidence_json) = 'object'
  ),
  CONSTRAINT ops_shopify_location_admin_outcome_text_valid CHECK (
    length(btrim(recorded_by)) BETWEEN 3 AND 320
    AND recorded_by !~ '[[:cntrl:]]'
    AND (
      provider_reference IS NULL
      OR (
        length(btrim(provider_reference)) BETWEEN 1 AND 512
        AND provider_reference !~ '[[:cntrl:]]'
      )
    )
    AND (
      provider_location_id IS NULL
      OR provider_location_id ~
        '^gid://shopify/Location/[1-9][0-9]{0,20}$'
    )
  ),
  CONSTRAINT ops_shopify_location_admin_outcome_state_valid CHECK (
    (
      outcome_state = 'succeeded'
      AND reconciliation_resolution IS NULL
      AND provider_write_count = 1
      AND provider_location_id IS NOT NULL
      AND error_code IS NULL
    )
    OR (
      outcome_state = 'failed'
      AND reconciliation_resolution IS NULL
      AND provider_write_count = 0
      AND error_code IS NOT NULL
    )
    OR (
      outcome_state = 'unknown'
      AND reconciliation_resolution IS NULL
      AND provider_write_count IS NULL
      AND error_code IS NOT NULL
    )
    OR (
      outcome_state = 'reconciled'
      AND reconciliation_resolution = 'confirmed_applied'
      AND provider_write_count IS NULL
      AND provider_location_id IS NOT NULL
      AND error_code IS NULL
    )
  )
);

COMMENT ON TABLE operations_shopify_location_administration_outcomes IS
  'Immutable redacted outcomes. Unknown attempts can only gain positive read-only confirmation that the desired provider state exists.';

ALTER TABLE operations_shopify_location_administration_authorizations
  ADD CONSTRAINT ops_shopify_location_admin_auth_attempt_fkey
  FOREIGN KEY (organization_id, provider_attempt_id)
  REFERENCES operations_shopify_location_administration_attempts(
    organization_id, id
  ) ON DELETE RESTRICT;

ALTER TABLE operations_shopify_location_administration_authorizations
  ADD CONSTRAINT ops_shopify_location_admin_auth_outcome_fkey
  FOREIGN KEY (organization_id, latest_outcome_id)
  REFERENCES operations_shopify_location_administration_outcomes(
    organization_id, id
  ) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION operations_shopify_location_admin_actor_current(
  p_organization_id uuid,
  p_actor_email text,
  p_actor_role text
)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1
    FROM app_user_organization_memberships membership
    WHERE membership.organization_id = p_organization_id
      AND membership.user_email = p_actor_email
      AND membership.status = 'active'
      AND membership.role = p_actor_role
      AND (
        membership.role = 'owner'
        OR (
          membership.role = 'admin'
          AND COALESCE(
            (membership.permissions->>'manageOperations')::boolean, false
          )
          AND COALESCE(
            (membership.permissions->>'executeWarehouse')::boolean, false
          )
        )
      )
  )
$$;

CREATE OR REPLACE FUNCTION operations_shopify_location_admin_is_current(
  p_organization_id uuid,
  p_authorization_id uuid
)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1
    FROM operations_shopify_location_administration_authorizations authz
    JOIN operations_integration_accounts account
      ON account.organization_id = authz.organization_id
     AND account.id = authz.integration_account_id
    JOIN operations_commerce_credentials credential
      ON credential.organization_id = account.organization_id
     AND credential.integration_account_id = account.id
    JOIN operations_activation_scopes activation
      ON activation.organization_id = authz.organization_id
    JOIN operations_warehouses warehouse
      ON warehouse.organization_id = authz.organization_id
     AND warehouse.id = authz.warehouse_id
    LEFT JOIN operations_commerce_inventory_location_mappings mapping
      ON mapping.organization_id = authz.organization_id
     AND mapping.integration_account_id = authz.integration_account_id
     AND mapping.id = authz.location_mapping_id
    WHERE authz.organization_id = p_organization_id
      AND authz.id = p_authorization_id
      AND account.global_id = authz.integration_account_global_id
      AND account.integration_type = 'commerce'
      AND account.provider = 'shopify'
      AND account.environment = 'sandbox'
      AND account.environment = authz.account_environment
      AND account.status = 'active'
      AND account.external_account_id = authz.external_account_id
      AND account.configuration->>'shopDomain' = authz.shop_domain
      AND account.commerce_credential_generation = authz.credential_generation
      AND credential.external_account_id = authz.external_account_id
      AND credential.auth_mode = 'shopify_client_credentials'
      AND credential.credential_version = authz.credential_generation
      AND credential.verification_status = 'verified'
      AND activation.state = authz.activation_state
      AND activation.state IN ('shadow', 'active')
      AND activation.revision = authz.activation_revision
      AND warehouse.global_id = authz.warehouse_global_id
      AND warehouse.status = 'active'
      AND warehouse.row_version = authz.warehouse_row_version
      AND encode(
        digest(convert_to(warehouse.address::text, 'UTF8'), 'sha256'),
        'hex'
      ) = authz.warehouse_address_hash
      AND operations_shopify_location_admin_actor_current(
        authz.organization_id, authz.authorized_by, authz.authorized_role
      )
      AND (
        (
          authz.action = 'locationAdd'
          AND mapping.id IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM operations_commerce_inventory_location_mappings existing
            WHERE existing.organization_id = authz.organization_id
              AND existing.warehouse_id = authz.warehouse_id
              AND existing.active
          )
        )
        OR (
          authz.action IN ('locationEdit', 'locationActivate')
          AND mapping.id = authz.location_mapping_id
          AND mapping.global_id = authz.location_mapping_global_id
          AND mapping.row_version = authz.location_mapping_row_version
          AND mapping.warehouse_id = authz.warehouse_id
          AND mapping.external_location_id = authz.provider_location_id
          AND mapping.active
          AND mapping.ownership_classification = 'merchant_managed'
          AND mapping.provider_snapshot_hash = authz.provider_snapshot_hash
          AND mapping.provider_snapshot_json = authz.provider_snapshot_json
          AND mapping.provider_snapshot_json @>
                '{"isFulfillmentService": false}'::jsonb
        )
      )
  )
$$;

CREATE OR REPLACE FUNCTION protect_shopify_location_admin_authorization()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  outcome_row record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Shopify location authorizations cannot be deleted';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'prepared'
       OR NOT operations_shopify_location_admin_is_current(
         NEW.organization_id, NEW.id
       )
    THEN
      RAISE EXCEPTION 'Shopify location authorization is stale or forbidden';
    END IF;
    RETURN NEW;
  END IF;

  IF (
    to_jsonb(NEW) - ARRAY[
      'status', 'provider_attempt_id', 'latest_outcome_id', 'processing_at',
      'completed_at', 'updated_at'
    ]::text[]
  ) IS DISTINCT FROM (
    to_jsonb(OLD) - ARRAY[
      'status', 'provider_attempt_id', 'latest_outcome_id', 'processing_at',
      'completed_at', 'updated_at'
    ]::text[]
  ) THEN
    RAISE EXCEPTION 'Shopify location authorization identity is immutable';
  END IF;

  IF OLD.status = 'prepared' AND NEW.status = 'processing' THEN
    IF NEW.provider_attempt_id IS NULL
       OR NEW.latest_outcome_id IS NOT NULL
       OR NEW.processing_at IS NULL
       OR NEW.completed_at IS NOT NULL
       OR NOT operations_shopify_location_admin_is_current(
         NEW.organization_id, NEW.id
       )
       OR NOT EXISTS (
         SELECT 1
         FROM operations_shopify_location_administration_attempts attempt
         WHERE attempt.organization_id = NEW.organization_id
           AND attempt.id = NEW.provider_attempt_id
           AND attempt.authorization_id = NEW.id
           AND attempt.claimed_by = NEW.authorized_by
           AND attempt.provider_idempotency_key =
                 NEW.provider_idempotency_key
       )
    THEN
      RAISE EXCEPTION 'Shopify location claim is invalid';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'processing'
     AND NEW.status IN ('succeeded', 'failed', 'unknown') THEN
    SELECT * INTO outcome_row
    FROM operations_shopify_location_administration_outcomes outcome
    WHERE outcome.organization_id = NEW.organization_id
      AND outcome.id = NEW.latest_outcome_id
      AND outcome.authorization_id = NEW.id
      AND outcome.provider_attempt_id = NEW.provider_attempt_id;
    IF outcome_row.id IS NULL
       OR outcome_row.outcome_state <> NEW.status
       OR NEW.completed_at IS NULL
    THEN
      RAISE EXCEPTION 'Shopify location terminal outcome is invalid';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'unknown' AND NEW.status = 'reconciled' THEN
    SELECT * INTO outcome_row
    FROM operations_shopify_location_administration_outcomes outcome
    WHERE outcome.organization_id = NEW.organization_id
      AND outcome.id = NEW.latest_outcome_id
      AND outcome.authorization_id = NEW.id
      AND outcome.provider_attempt_id = NEW.provider_attempt_id
      AND outcome.outcome_state = 'reconciled'
      AND outcome.reconciliation_resolution = 'confirmed_applied';
    IF outcome_row.id IS NULL OR NEW.completed_at IS NULL THEN
      RAISE EXCEPTION 'Shopify location reconciliation is invalid';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Shopify location authorization transition is invalid';
END;
$$;

CREATE OR REPLACE FUNCTION protect_shopify_location_admin_attempt()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Shopify location attempts are immutable';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM operations_shopify_location_administration_authorizations authz
    WHERE authz.organization_id = NEW.organization_id
      AND authz.id = NEW.authorization_id
      AND authz.integration_account_id = NEW.integration_account_id
      AND authz.action = NEW.action
      AND authz.provider_location_id IS NOT DISTINCT FROM
            NEW.provider_location_id
      AND authz.credential_generation = NEW.credential_generation
      AND authz.activation_revision = NEW.activation_revision
      AND authz.provider_idempotency_key = NEW.provider_idempotency_key
      AND authz.request_hash = NEW.request_hash
      AND authz.authorized_by = NEW.claimed_by
      AND authz.status = 'prepared'
      AND authz.expires_at > clock_timestamp()
      AND operations_shopify_location_admin_is_current(
        authz.organization_id, authz.id
      )
  ) THEN
    RAISE EXCEPTION 'Shopify location attempt is stale or forbidden';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION protect_shopify_location_admin_outcome()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  auth_state text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Shopify location outcomes are immutable';
  END IF;
  SELECT authz.status INTO auth_state
  FROM operations_shopify_location_administration_authorizations authz
  JOIN operations_shopify_location_administration_attempts attempt
    ON attempt.organization_id = authz.organization_id
   AND attempt.id = NEW.provider_attempt_id
   AND attempt.authorization_id = authz.id
  WHERE authz.organization_id = NEW.organization_id
    AND authz.id = NEW.authorization_id
    AND authz.provider_attempt_id = NEW.provider_attempt_id;
  IF auth_state IS NULL
     OR (
       NEW.outcome_state IN ('succeeded', 'failed', 'unknown')
       AND auth_state <> 'processing'
     )
     OR (
       NEW.outcome_state = 'reconciled'
       AND auth_state <> 'unknown'
     )
  THEN
    RAISE EXCEPTION 'Shopify location outcome has no matching authority';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_shopify_location_admin_auth_write
  ON operations_shopify_location_administration_authorizations;
DROP TRIGGER IF EXISTS validate_shopify_location_admin_auth_insert
  ON operations_shopify_location_administration_authorizations;
CREATE TRIGGER validate_shopify_location_admin_auth_insert
AFTER INSERT
ON operations_shopify_location_administration_authorizations
FOR EACH ROW EXECUTE FUNCTION
  protect_shopify_location_admin_authorization();

CREATE TRIGGER protect_shopify_location_admin_auth_write
BEFORE UPDATE OR DELETE
ON operations_shopify_location_administration_authorizations
FOR EACH ROW EXECUTE FUNCTION
  protect_shopify_location_admin_authorization();

DROP TRIGGER IF EXISTS protect_shopify_location_admin_attempt_write
  ON operations_shopify_location_administration_attempts;
CREATE TRIGGER protect_shopify_location_admin_attempt_write
BEFORE INSERT OR UPDATE OR DELETE
ON operations_shopify_location_administration_attempts
FOR EACH ROW EXECUTE FUNCTION protect_shopify_location_admin_attempt();

DROP TRIGGER IF EXISTS protect_shopify_location_admin_outcome_write
  ON operations_shopify_location_administration_outcomes;
CREATE TRIGGER protect_shopify_location_admin_outcome_write
BEFORE INSERT OR UPDATE OR DELETE
ON operations_shopify_location_administration_outcomes
FOR EACH ROW EXECUTE FUNCTION protect_shopify_location_admin_outcome();
