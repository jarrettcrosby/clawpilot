-- Exact, operator-authorized Shopify order management for the bounded
-- development test lane.  This is intentionally separate from broad commerce
-- authority policy.  Every provider dispatch is bound to one imported order,
-- one current credential generation, one activation revision, one immutable
-- five-minute intent, and one durable attempt row written before the network.
--
-- Plaintext tags and staff notes are never retained.  Apart from the bounded
-- human authorization reason, the authorization keeps provider IDs, bounded
-- numeric facts, and SHA-256 evidence.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

INSERT INTO global_reference_entity_types (prefix, entity_type, display_name)
VALUES
  (
    'gsom',
    'operations.shopify_order_management_authorization',
    'Shopify order management authorization'
  ),
  (
    'gsoa',
    'operations.shopify_order_management_attempt',
    'Shopify order management provider attempt'
  ),
  (
    'gsor',
    'operations.shopify_order_management_outcome',
    'Shopify order management outcome'
  )
ON CONFLICT (prefix) DO UPDATE SET
  entity_type = EXCLUDED.entity_type,
  display_name = EXCLUDED.display_name;

CREATE TABLE IF NOT EXISTS operations_shopify_order_management_authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gsom'),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  integration_account_global_id text NOT NULL,
  provider text NOT NULL DEFAULT 'shopify' CHECK (provider = 'shopify'),
  account_environment text NOT NULL CHECK (account_environment = 'sandbox'),
  external_account_id text NOT NULL,
  shop_domain text NOT NULL,
  credential_generation integer NOT NULL CHECK (credential_generation > 0),
  activation_state text NOT NULL CHECK (activation_state IN ('shadow', 'active')),
  activation_revision integer NOT NULL CHECK (activation_revision > 0),
  order_id uuid NOT NULL,
  order_global_id text NOT NULL,
  external_order_id text NOT NULL,
  order_number text NOT NULL,
  expected_order_row_version bigint NOT NULL
    CHECK (expected_order_row_version >= 0),
  expected_source_hash text NOT NULL
    CHECK (expected_source_hash ~ '^[a-f0-9]{64}$'),
  accepted_observation_id uuid,
  accepted_provider_order_updated_at timestamptz,
  provider_order_updated_at timestamptz NOT NULL,
  provider_order_observed_at timestamptz NOT NULL,
  provider_order_test boolean NOT NULL,
  provider_snapshot_hash text NOT NULL
    CHECK (provider_snapshot_hash ~ '^[a-f0-9]{64}$'),
  action text NOT NULL CHECK (
    action IN ('add_tag', 'cancel', 'set_line_quantity')
  ),
  line_item_id text,
  expected_line_quantity integer,
  requested_quantity integer,
  tag_hash text CHECK (tag_hash IS NULL OR tag_hash ~ '^[a-f0-9]{64}$'),
  cancel_reason text CHECK (
    cancel_reason IS NULL OR cancel_reason IN ('STAFF', 'OTHER')
  ),
  staff_note_hash text CHECK (
    staff_note_hash IS NULL OR staff_note_hash ~ '^[a-f0-9]{64}$'
  ),
  authorization_reason text NOT NULL,
  intent_hash text NOT NULL CHECK (intent_hash ~ '^[a-f0-9]{64}$'),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'prepared' CHECK (
    status IN (
      'prepared', 'processing', 'succeeded', 'failed', 'unknown',
      'reconciled', 'expired'
    )
  ),
  authorized_by text NOT NULL REFERENCES app_users(email) ON DELETE RESTRICT,
  authorized_role text NOT NULL CHECK (authorized_role IN ('owner', 'admin')),
  provider_attempt_id uuid,
  latest_outcome_id uuid,
  prepared_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  processing_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ops_shopify_order_mgmt_auth_global_valid CHECK (
    global_id ~ '^gsom(?:[0-9]{7}|[0-9a-v]{12})$'
  ),
  CONSTRAINT ops_shopify_order_mgmt_auth_global_unique UNIQUE (global_id),
  CONSTRAINT ops_shopify_order_mgmt_auth_org_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT ops_shopify_order_mgmt_auth_org_global_unique
    UNIQUE (organization_id, global_id),
  CONSTRAINT ops_shopify_order_mgmt_auth_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT ops_shopify_order_mgmt_auth_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT ops_shopify_order_mgmt_auth_order_fkey
    FOREIGN KEY (organization_id, order_id)
    REFERENCES operations_orders(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT ops_shopify_order_mgmt_auth_accepted_observation_fkey
    FOREIGN KEY (organization_id, accepted_observation_id)
    REFERENCES operations_commerce_order_revision_observations(
      organization_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT ops_shopify_order_mgmt_auth_idempotency_unique
    UNIQUE (organization_id, integration_account_id, idempotency_key),
  CONSTRAINT ops_shopify_order_mgmt_auth_identity_valid CHECK (
    integration_account_global_id ~ '^gia(?:[0-9]{7}|[0-9a-v]{12})$'
    AND order_global_id ~ '^gor(?:[0-9]{7}|[0-9a-v]{12})$'
    AND external_account_id ~ '^gid://shopify/Shop/[1-9][0-9]{0,20}$'
    AND external_order_id ~ '^gid://shopify/Order/[1-9][0-9]{0,20}$'
    AND length(order_number) BETWEEN 1 AND 255
    AND order_number !~ '[[:cntrl:]]'
    AND shop_domain = lower(shop_domain)
    AND shop_domain ~
      '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$'
  ),
  CONSTRAINT ops_shopify_order_mgmt_auth_text_valid CHECK (
    length(btrim(idempotency_key)) BETWEEN 8 AND 200
    AND idempotency_key !~ '[[:cntrl:]]'
    AND length(btrim(authorization_reason)) BETWEEN 10 AND 500
    AND authorization_reason !~ '[[:cntrl:]]'
  ),
  CONSTRAINT ops_shopify_order_mgmt_auth_window_valid CHECK (
    expires_at = prepared_at + interval '5 minutes'
    AND provider_order_observed_at >= prepared_at - interval '5 minutes'
    AND provider_order_observed_at <= prepared_at + interval '1 minute'
    AND provider_order_updated_at <= provider_order_observed_at + interval '10 minutes'
  ),
  CONSTRAINT ops_shopify_order_mgmt_auth_action_valid CHECK (
    (
      action = 'add_tag'
      AND tag_hash IS NOT NULL
      AND accepted_observation_id IS NULL
      AND accepted_provider_order_updated_at IS NULL
      AND line_item_id IS NULL
      AND expected_line_quantity IS NULL
      AND requested_quantity IS NULL
      AND cancel_reason IS NULL
      AND staff_note_hash IS NULL
    )
    OR (
      action = 'cancel'
      AND provider_order_test
      AND accepted_observation_id IS NOT NULL
      AND accepted_provider_order_updated_at = provider_order_updated_at
      AND tag_hash IS NULL
      AND line_item_id IS NULL
      AND expected_line_quantity IS NULL
      AND requested_quantity IS NULL
      AND cancel_reason IS NOT NULL
    )
    OR (
      action = 'set_line_quantity'
      AND provider_order_test
      AND accepted_observation_id IS NOT NULL
      AND accepted_provider_order_updated_at = provider_order_updated_at
      AND tag_hash IS NULL
      AND line_item_id ~ '^gid://shopify/LineItem/[1-9][0-9]{0,20}$'
      AND expected_line_quantity BETWEEN 1 AND 2147483647
      AND requested_quantity BETWEEN 0 AND 2147483647
      AND requested_quantity < expected_line_quantity
      AND cancel_reason IS NULL
    )
  ),
  CONSTRAINT ops_shopify_order_mgmt_auth_state_valid CHECK (
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
    OR (
      status = 'expired'
      AND provider_attempt_id IS NULL
      AND latest_outcome_id IS NULL
      AND processing_at IS NULL
      AND completed_at IS NOT NULL
      AND completed_at >= expires_at
    )
  )
);

COMMENT ON TABLE operations_shopify_order_management_authorizations IS
  'Five-minute, single-order Shopify provider-write authorizations. Plaintext tags and staff notes are not retained; only SHA-256 hashes and provider IDs are stored.';

CREATE UNIQUE INDEX IF NOT EXISTS ops_shopify_order_mgmt_one_unresolved_idx
  ON operations_shopify_order_management_authorizations (
    organization_id, order_id
  )
  WHERE status IN ('processing', 'unknown');

CREATE INDEX IF NOT EXISTS ops_shopify_order_mgmt_order_time_idx
  ON operations_shopify_order_management_authorizations (
    organization_id, order_id, prepared_at DESC, id DESC
  );

CREATE TABLE IF NOT EXISTS operations_shopify_order_management_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gsoa'),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  authorization_id uuid NOT NULL,
  integration_account_id uuid NOT NULL,
  integration_account_global_id text NOT NULL,
  provider text NOT NULL CHECK (provider = 'shopify'),
  external_account_id text NOT NULL,
  credential_generation integer NOT NULL CHECK (credential_generation > 0),
  activation_revision integer NOT NULL CHECK (activation_revision > 0),
  order_id uuid NOT NULL,
  order_global_id text NOT NULL,
  external_order_id text NOT NULL,
  expected_order_row_version bigint NOT NULL
    CHECK (expected_order_row_version >= 0),
  expected_source_hash text NOT NULL
    CHECK (expected_source_hash ~ '^[a-f0-9]{64}$'),
  accepted_observation_id uuid,
  accepted_provider_order_updated_at timestamptz,
  provider_snapshot_hash text NOT NULL
    CHECK (provider_snapshot_hash ~ '^[a-f0-9]{64}$'),
  action text NOT NULL CHECK (
    action IN ('add_tag', 'cancel', 'set_line_quantity')
  ),
  expected_line_quantity integer,
  intent_hash text NOT NULL CHECK (intent_hash ~ '^[a-f0-9]{64}$'),
  attempt_hash text NOT NULL CHECK (attempt_hash ~ '^[a-f0-9]{64}$'),
  dispatch_state text NOT NULL CHECK (dispatch_state = 'authorized'),
  claimed_by text NOT NULL REFERENCES app_users(email) ON DELETE RESTRICT,
  claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  processing_lease_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ops_shopify_order_mgmt_attempt_global_valid CHECK (
    global_id ~ '^gsoa(?:[0-9]{7}|[0-9a-v]{12})$'
  ),
  CONSTRAINT ops_shopify_order_mgmt_attempt_global_unique UNIQUE (global_id),
  CONSTRAINT ops_shopify_order_mgmt_attempt_org_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT ops_shopify_order_mgmt_attempt_org_global_unique
    UNIQUE (organization_id, global_id),
  CONSTRAINT ops_shopify_order_mgmt_attempt_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT ops_shopify_order_mgmt_attempt_authorization_fkey
    FOREIGN KEY (organization_id, authorization_id)
    REFERENCES operations_shopify_order_management_authorizations(
      organization_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT ops_shopify_order_mgmt_attempt_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT ops_shopify_order_mgmt_attempt_order_fkey
    FOREIGN KEY (organization_id, order_id)
    REFERENCES operations_orders(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT ops_shopify_order_mgmt_attempt_accepted_observation_fkey
    FOREIGN KEY (organization_id, accepted_observation_id)
    REFERENCES operations_commerce_order_revision_observations(
      organization_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT ops_shopify_order_mgmt_attempt_authorization_unique
    UNIQUE (organization_id, authorization_id),
  CONSTRAINT ops_shopify_order_mgmt_attempt_lease_valid CHECK (
    processing_lease_expires_at = claimed_at + interval '5 minutes'
  ),
  CONSTRAINT ops_shopify_order_mgmt_attempt_identity_valid CHECK (
    integration_account_global_id ~ '^gia(?:[0-9]{7}|[0-9a-v]{12})$'
    AND order_global_id ~ '^gor(?:[0-9]{7}|[0-9a-v]{12})$'
    AND external_account_id ~ '^gid://shopify/Shop/[1-9][0-9]{0,20}$'
    AND external_order_id ~ '^gid://shopify/Order/[1-9][0-9]{0,20}$'
    AND (
      (
        action = 'add_tag'
        AND accepted_observation_id IS NULL
        AND accepted_provider_order_updated_at IS NULL
      )
      OR (
        action IN ('cancel', 'set_line_quantity')
        AND accepted_observation_id IS NOT NULL
        AND accepted_provider_order_updated_at IS NOT NULL
      )
    )
    AND (
      (action = 'set_line_quantity'
        AND expected_line_quantity BETWEEN 1 AND 2147483647)
      OR (action <> 'set_line_quantity' AND expected_line_quantity IS NULL)
    )
  )
);

COMMENT ON TABLE operations_shopify_order_management_attempts IS
  'Immutable provider-dispatch authority committed before any Shopify network call. A processing attempt is never blindly retried; after its exact five-minute lease it may only be recovered to unknown for read-only reconciliation.';

CREATE TABLE IF NOT EXISTS operations_shopify_order_management_outcomes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gsor'),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  authorization_id uuid NOT NULL,
  provider_attempt_id uuid NOT NULL,
  outcome_state text NOT NULL CHECK (
    outcome_state IN ('succeeded', 'failed', 'unknown', 'reconciled')
  ),
  reconciliation_resolution text CHECK (
    reconciliation_resolution IS NULL
    OR reconciliation_resolution IN ('applied', 'not_applied')
  ),
  provider_write_count integer CHECK (provider_write_count BETWEEN 0 AND 3),
  provider_reference text,
  evidence_hash text NOT NULL CHECK (evidence_hash ~ '^[a-f0-9]{64}$'),
  error_code text CHECK (
    error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{1,127}$'
  ),
  recorded_by text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ops_shopify_order_mgmt_outcome_global_valid CHECK (
    global_id ~ '^gsor(?:[0-9]{7}|[0-9a-v]{12})$'
  ),
  CONSTRAINT ops_shopify_order_mgmt_outcome_global_unique UNIQUE (global_id),
  CONSTRAINT ops_shopify_order_mgmt_outcome_org_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT ops_shopify_order_mgmt_outcome_org_global_unique
    UNIQUE (organization_id, global_id),
  CONSTRAINT ops_shopify_order_mgmt_outcome_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT ops_shopify_order_mgmt_outcome_authorization_fkey
    FOREIGN KEY (organization_id, authorization_id)
    REFERENCES operations_shopify_order_management_authorizations(
      organization_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT ops_shopify_order_mgmt_outcome_attempt_fkey
    FOREIGN KEY (organization_id, provider_attempt_id)
    REFERENCES operations_shopify_order_management_attempts(
      organization_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT ops_shopify_order_mgmt_outcome_state_unique
    UNIQUE (organization_id, authorization_id, outcome_state),
  CONSTRAINT ops_shopify_order_mgmt_outcome_text_valid CHECK (
    length(btrim(recorded_by)) BETWEEN 3 AND 320
    AND recorded_by !~ '[[:cntrl:]]'
    AND (
      provider_reference IS NULL
      OR (
        length(btrim(provider_reference)) BETWEEN 1 AND 512
        AND provider_reference !~ '[[:cntrl:]]'
      )
    )
  ),
  CONSTRAINT ops_shopify_order_mgmt_outcome_state_valid CHECK (
    (
      outcome_state = 'succeeded'
      AND reconciliation_resolution IS NULL
      AND provider_write_count BETWEEN 0 AND 3
      AND error_code IS NULL
    )
    OR (
      outcome_state = 'failed'
      AND reconciliation_resolution IS NULL
      AND provider_write_count BETWEEN 0 AND 3
      AND error_code IS NOT NULL
    )
    OR (
      outcome_state = 'unknown'
      AND reconciliation_resolution IS NULL
      AND (
        provider_write_count IS NULL
        OR provider_write_count BETWEEN 0 AND 3
      )
      AND error_code IS NOT NULL
    )
    OR (
      outcome_state = 'reconciled'
      AND reconciliation_resolution IS NOT NULL
      AND (
        provider_write_count IS NULL
        OR provider_write_count BETWEEN 0 AND 3
      )
      AND error_code IS NULL
    )
  )
);

COMMENT ON TABLE operations_shopify_order_management_outcomes IS
  'Immutable, redacted Shopify order-write outcome and exact-read reconciliation evidence.';

ALTER TABLE operations_shopify_order_management_authorizations
  ADD CONSTRAINT ops_shopify_order_mgmt_auth_attempt_fkey
  FOREIGN KEY (organization_id, provider_attempt_id)
  REFERENCES operations_shopify_order_management_attempts(organization_id, id)
  ON DELETE RESTRICT;

ALTER TABLE operations_shopify_order_management_authorizations
  ADD CONSTRAINT ops_shopify_order_mgmt_auth_outcome_fkey
  FOREIGN KEY (organization_id, latest_outcome_id)
  REFERENCES operations_shopify_order_management_outcomes(organization_id, id)
  ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION operations_shopify_order_management_snapshot_updated_at(
  p_snapshot jsonb
)
RETURNS timestamptz LANGUAGE plpgsql STABLE AS $$
DECLARE
  raw_updated_at text;
BEGIN
  raw_updated_at := p_snapshot #>> '{order,providerUpdatedAt}';
  IF raw_updated_at IS NULL OR raw_updated_at !~
       '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:[.][0-9]{1,6})?(?:Z|[+-][0-9]{2}:[0-9]{2})$'
  THEN
    RETURN NULL;
  END IF;
  BEGIN
    RETURN raw_updated_at::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
  END;
END;
$$;

CREATE OR REPLACE FUNCTION operations_shopify_order_management_is_current(
  p_organization_id uuid,
  p_authorization_id uuid,
  p_require_claim_fence boolean DEFAULT true
)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1
    FROM operations_shopify_order_management_authorizations authz
    JOIN operations_integration_accounts account
      ON account.organization_id = authz.organization_id
     AND account.id = authz.integration_account_id
    JOIN operations_commerce_credentials credential
      ON credential.organization_id = account.organization_id
     AND credential.integration_account_id = account.id
    JOIN operations_activation_scopes activation
      ON activation.organization_id = authz.organization_id
    JOIN operations_orders order_row
      ON order_row.organization_id = authz.organization_id
     AND order_row.id = authz.order_id
    JOIN operations_commerce_order_revision_targets target
      ON target.organization_id = order_row.organization_id
     AND target.order_id = order_row.id
    LEFT JOIN operations_commerce_order_revision_observations accepted
      ON accepted.organization_id = target.organization_id
     AND accepted.id = target.accepted_observation_id
     AND accepted.integration_account_id = target.integration_account_id
     AND accepted.target_id = target.id
     AND accepted.order_id = target.order_id
     AND accepted.provider = target.provider
     AND accepted.external_order_id = order_row.external_order_id
     AND accepted.source_hash = target.accepted_source_hash
     AND accepted.canonical_row_version = order_row.row_version
    WHERE authz.organization_id = p_organization_id
      AND authz.id = p_authorization_id
      AND account.global_id = authz.integration_account_global_id
      AND account.provider = 'shopify'
      AND account.integration_type = 'commerce'
      AND account.environment = authz.account_environment
      AND account.environment = 'sandbox'
      AND account.status = 'active'
      AND account.external_account_id = authz.external_account_id
      AND account.configuration->>'shopDomain' = authz.shop_domain
      AND account.commerce_credential_generation =
            authz.credential_generation
      AND credential.external_account_id = authz.external_account_id
      AND credential.credential_version = authz.credential_generation
      AND credential.auth_mode = 'shopify_client_credentials'
      AND credential.verification_status = 'verified'
      AND activation.state = authz.activation_state
      AND activation.state IN ('shadow', 'active')
      AND activation.revision = authz.activation_revision
      AND order_row.global_id = authz.order_global_id
      AND order_row.integration_account_id = authz.integration_account_id
      AND order_row.source_provider = 'shopify'
      AND order_row.external_order_id = authz.external_order_id
      AND order_row.order_number = authz.order_number
      AND order_row.row_version = authz.expected_order_row_version
      AND order_row.status = 'imported'
      AND order_row.archived_at IS NULL
      AND order_row.source_payload->>'sourceHash' =
            authz.expected_source_hash
      AND target.integration_account_id = authz.integration_account_id
      AND target.provider = 'shopify'
      AND target.accepted_source_hash = authz.expected_source_hash
      AND (
        (
          authz.action = 'add_tag'
          AND target.material_state IN (
            'current', 'review_required', 'provider_cancelled',
            'provider_fulfilled'
          )
        )
        OR (
          authz.action IN ('cancel', 'set_line_quantity')
          AND target.accepted_observation_id =
                authz.accepted_observation_id
          AND accepted.id = authz.accepted_observation_id
          AND operations_shopify_order_management_snapshot_updated_at(
                accepted.normalized_snapshot
              ) = authz.accepted_provider_order_updated_at
          AND authz.accepted_provider_order_updated_at =
                authz.provider_order_updated_at
          AND (
            target.latest_source_hash IS NULL
            OR target.latest_source_hash = authz.expected_source_hash
          )
          AND target.material_state = 'current'
        )
      )
      AND (
        NOT p_require_claim_fence
        OR ocr_order_has_zero_downstream(
          authz.organization_id,
          authz.order_id
        )
      )
  )
$$;

CREATE OR REPLACE FUNCTION protect_shopify_order_management_authorization()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  matching_outcome record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Shopify order management authorizations cannot be deleted';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'prepared'
       OR NOT EXISTS (
         SELECT 1
         FROM operations_integration_accounts account
         JOIN operations_commerce_credentials credential
           ON credential.organization_id = account.organization_id
          AND credential.integration_account_id = account.id
         JOIN operations_activation_scopes activation
           ON activation.organization_id = NEW.organization_id
         JOIN operations_orders order_row
           ON order_row.organization_id = NEW.organization_id
          AND order_row.id = NEW.order_id
         JOIN operations_commerce_order_revision_targets target
           ON target.organization_id = order_row.organization_id
          AND target.order_id = order_row.id
         LEFT JOIN operations_commerce_order_revision_observations accepted
           ON accepted.organization_id = target.organization_id
          AND accepted.id = target.accepted_observation_id
          AND accepted.integration_account_id = target.integration_account_id
          AND accepted.target_id = target.id
          AND accepted.order_id = target.order_id
          AND accepted.provider = target.provider
          AND accepted.external_order_id = order_row.external_order_id
          AND accepted.source_hash = target.accepted_source_hash
          AND accepted.canonical_row_version = order_row.row_version
         WHERE account.organization_id = NEW.organization_id
           AND account.id = NEW.integration_account_id
           AND account.global_id = NEW.integration_account_global_id
           AND account.provider = 'shopify'
           AND account.integration_type = 'commerce'
           AND account.environment = NEW.account_environment
           AND account.environment = 'sandbox'
           AND account.status = 'active'
           AND account.external_account_id = NEW.external_account_id
           AND account.configuration->>'shopDomain' = NEW.shop_domain
           AND account.commerce_credential_generation =
                 NEW.credential_generation
           AND credential.external_account_id = NEW.external_account_id
           AND credential.credential_version = NEW.credential_generation
           AND credential.auth_mode = 'shopify_client_credentials'
           AND credential.verification_status = 'verified'
           AND activation.state = NEW.activation_state
           AND activation.state IN ('shadow', 'active')
           AND activation.revision = NEW.activation_revision
           AND order_row.global_id = NEW.order_global_id
           AND order_row.integration_account_id = NEW.integration_account_id
           AND order_row.source_provider = 'shopify'
           AND order_row.external_order_id = NEW.external_order_id
           AND order_row.order_number = NEW.order_number
           AND order_row.row_version = NEW.expected_order_row_version
           AND order_row.status = 'imported'
           AND order_row.archived_at IS NULL
           AND order_row.source_payload->>'sourceHash' =
                 NEW.expected_source_hash
           AND target.integration_account_id = NEW.integration_account_id
           AND target.provider = 'shopify'
           AND target.accepted_source_hash = NEW.expected_source_hash
           AND (
             (
               NEW.action = 'add_tag'
               AND target.material_state IN (
                 'current', 'review_required', 'provider_cancelled',
                 'provider_fulfilled'
               )
             )
             OR (
               NEW.action IN ('cancel', 'set_line_quantity')
               AND target.accepted_observation_id =
                     NEW.accepted_observation_id
               AND accepted.id = NEW.accepted_observation_id
               AND operations_shopify_order_management_snapshot_updated_at(
                     accepted.normalized_snapshot
                   ) = NEW.accepted_provider_order_updated_at
               AND NEW.accepted_provider_order_updated_at =
                     NEW.provider_order_updated_at
               AND (
                 target.latest_source_hash IS NULL
                 OR target.latest_source_hash = NEW.expected_source_hash
               )
               AND target.material_state = 'current'
             )
           )
           AND ocr_order_has_zero_downstream(
             NEW.organization_id, NEW.order_id
           )
       )
       OR NOT EXISTS (
         SELECT 1
         FROM app_user_organization_memberships membership
         WHERE membership.organization_id = NEW.organization_id
           AND membership.user_email = NEW.authorized_by
           AND membership.status = 'active'
           AND membership.role = NEW.authorized_role
           AND (
             membership.role = 'owner'
             OR (
               membership.role = 'admin'
               AND COALESCE(
                 (membership.permissions->>'manageOperations')::boolean,
                 false
               )
               AND COALESCE(
                 (membership.permissions->>'executeWarehouse')::boolean,
                 false
               )
             )
           )
       )
       OR EXISTS (
         SELECT 1
         FROM operations_shopify_order_management_authorizations unresolved
         WHERE unresolved.organization_id = NEW.organization_id
           AND unresolved.order_id = NEW.order_id
           AND unresolved.status IN ('processing', 'unknown')
       )
    THEN
      RAISE EXCEPTION
        'Shopify order management authorization is not current or permitted';
    END IF;
    RETURN NEW;
  END IF;

  IF (
    to_jsonb(NEW) - ARRAY[
      'status', 'provider_attempt_id', 'latest_outcome_id',
      'processing_at', 'completed_at', 'updated_at'
    ]::text[]
  ) IS DISTINCT FROM (
    to_jsonb(OLD) - ARRAY[
      'status', 'provider_attempt_id', 'latest_outcome_id',
      'processing_at', 'completed_at', 'updated_at'
    ]::text[]
  ) OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'Shopify order management authorization identity is immutable';
  END IF;

  IF OLD.status = 'prepared' AND NEW.status = 'processing' THEN
    IF OLD.expires_at <= clock_timestamp()
       OR NEW.provider_attempt_id IS NULL
       OR NEW.latest_outcome_id IS NOT NULL
       OR NEW.processing_at IS NULL
       OR NEW.completed_at IS NOT NULL
       OR NOT operations_shopify_order_management_is_current(
         NEW.organization_id, NEW.id, true
       )
       OR NOT EXISTS (
         SELECT 1
         FROM operations_shopify_order_management_attempts attempt
         WHERE attempt.organization_id = NEW.organization_id
           AND attempt.id = NEW.provider_attempt_id
           AND attempt.authorization_id = NEW.id
       )
    THEN
      RAISE EXCEPTION 'Shopify order management claim is not current';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'prepared' AND NEW.status = 'expired' THEN
    IF OLD.expires_at > clock_timestamp()
       OR NEW.provider_attempt_id IS NOT NULL
       OR NEW.latest_outcome_id IS NOT NULL
       OR NEW.processing_at IS NOT NULL
       OR NEW.completed_at < OLD.expires_at
    THEN
      RAISE EXCEPTION 'Shopify order management expiry is invalid';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'processing'
     AND NEW.status IN ('succeeded', 'failed', 'unknown') THEN
    SELECT outcome.* INTO matching_outcome
    FROM operations_shopify_order_management_outcomes outcome
    WHERE outcome.organization_id = NEW.organization_id
      AND outcome.id = NEW.latest_outcome_id
      AND outcome.authorization_id = NEW.id
      AND outcome.provider_attempt_id = NEW.provider_attempt_id
      AND outcome.outcome_state = NEW.status;
    IF matching_outcome IS NULL
       OR NEW.provider_attempt_id IS DISTINCT FROM OLD.provider_attempt_id
       OR NEW.processing_at IS DISTINCT FROM OLD.processing_at
       OR NEW.completed_at IS NULL
    THEN
      RAISE EXCEPTION 'Shopify order management outcome transition is invalid';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'unknown' AND NEW.status = 'reconciled' THEN
    SELECT outcome.* INTO matching_outcome
    FROM operations_shopify_order_management_outcomes outcome
    WHERE outcome.organization_id = NEW.organization_id
      AND outcome.id = NEW.latest_outcome_id
      AND outcome.authorization_id = NEW.id
      AND outcome.provider_attempt_id = NEW.provider_attempt_id
      AND outcome.outcome_state = 'reconciled';
    IF matching_outcome IS NULL
       OR NEW.provider_attempt_id IS DISTINCT FROM OLD.provider_attempt_id
       OR NEW.processing_at IS DISTINCT FROM OLD.processing_at
       OR NEW.completed_at IS NULL
    THEN
      RAISE EXCEPTION
        'Shopify order management reconciliation transition is invalid';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Shopify order management status transition is invalid';
END;
$$;

DROP TRIGGER IF EXISTS protect_shopify_order_management_authorization_write
  ON operations_shopify_order_management_authorizations;
CREATE TRIGGER protect_shopify_order_management_authorization_write
BEFORE INSERT OR UPDATE OR DELETE
ON operations_shopify_order_management_authorizations
FOR EACH ROW EXECUTE FUNCTION protect_shopify_order_management_authorization();

CREATE OR REPLACE FUNCTION protect_shopify_order_management_attempt()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Shopify order management attempts are immutable';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM operations_shopify_order_management_authorizations authz
    WHERE authz.organization_id = NEW.organization_id
      AND authz.id = NEW.authorization_id
      AND authz.status = 'prepared'
      AND authz.expires_at > clock_timestamp()
      AND authz.integration_account_id = NEW.integration_account_id
      AND authz.integration_account_global_id =
            NEW.integration_account_global_id
      AND authz.provider = NEW.provider
      AND authz.external_account_id = NEW.external_account_id
      AND authz.credential_generation = NEW.credential_generation
      AND authz.activation_revision = NEW.activation_revision
      AND authz.order_id = NEW.order_id
      AND authz.order_global_id = NEW.order_global_id
      AND authz.external_order_id = NEW.external_order_id
      AND authz.expected_order_row_version =
            NEW.expected_order_row_version
      AND authz.expected_source_hash = NEW.expected_source_hash
      AND authz.accepted_observation_id IS NOT DISTINCT FROM
            NEW.accepted_observation_id
      AND authz.accepted_provider_order_updated_at IS NOT DISTINCT FROM
            NEW.accepted_provider_order_updated_at
      AND authz.provider_snapshot_hash = NEW.provider_snapshot_hash
      AND authz.action = NEW.action
      AND authz.expected_line_quantity IS NOT DISTINCT FROM
            NEW.expected_line_quantity
      AND authz.intent_hash = NEW.intent_hash
      AND authz.authorized_by = NEW.claimed_by
      AND operations_shopify_order_management_is_current(
        authz.organization_id, authz.id, true
      )
      AND NOT EXISTS (
        SELECT 1
        FROM operations_shopify_order_management_authorizations unresolved
        WHERE unresolved.organization_id = authz.organization_id
          AND unresolved.order_id = authz.order_id
          AND unresolved.id <> authz.id
          AND unresolved.status IN ('processing', 'unknown')
      )
  ) THEN
    RAISE EXCEPTION
      'Shopify order management provider attempt is not currently authorized';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_shopify_order_management_attempt_write
  ON operations_shopify_order_management_attempts;
CREATE TRIGGER protect_shopify_order_management_attempt_write
BEFORE INSERT OR UPDATE OR DELETE
ON operations_shopify_order_management_attempts
FOR EACH ROW EXECUTE FUNCTION protect_shopify_order_management_attempt();

CREATE OR REPLACE FUNCTION protect_shopify_order_management_outcome()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Shopify order management outcomes are immutable';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM operations_shopify_order_management_authorizations authz
    JOIN operations_shopify_order_management_attempts attempt
      ON attempt.organization_id = authz.organization_id
     AND attempt.id = NEW.provider_attempt_id
     AND attempt.authorization_id = authz.id
    WHERE authz.organization_id = NEW.organization_id
      AND authz.id = NEW.authorization_id
      AND authz.provider_attempt_id = attempt.id
      AND (
        (
          authz.status = 'processing'
          AND NEW.outcome_state IN ('succeeded', 'failed', 'unknown')
        )
        OR (
          authz.status = 'unknown'
          AND NEW.outcome_state = 'reconciled'
        )
      )
  ) THEN
    RAISE EXCEPTION
      'Shopify order management outcome has no current provider attempt';
  END IF;

  IF NEW.outcome_state = 'unknown'
     AND NEW.error_code =
           'SHOPIFY_ORDER_MANAGEMENT_PROCESSING_LEASE_EXPIRED'
     AND NOT EXISTS (
       SELECT 1
       FROM operations_shopify_order_management_authorizations authz
       JOIN operations_shopify_order_management_attempts attempt
         ON attempt.organization_id = authz.organization_id
        AND attempt.id = NEW.provider_attempt_id
        AND attempt.authorization_id = authz.id
       WHERE authz.organization_id = NEW.organization_id
         AND authz.id = NEW.authorization_id
         AND authz.status = 'processing'
         AND authz.provider_attempt_id = attempt.id
         AND attempt.processing_lease_expires_at <= clock_timestamp()
         AND NEW.provider_write_count IS NULL
         AND NEW.provider_reference IS NULL
     )
  THEN
    RAISE EXCEPTION
      'Shopify order management processing lease is still active';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_shopify_order_management_outcome_write
  ON operations_shopify_order_management_outcomes;
CREATE TRIGGER protect_shopify_order_management_outcome_write
BEFORE INSERT OR UPDATE OR DELETE
ON operations_shopify_order_management_outcomes
FOR EACH ROW EXECUTE FUNCTION protect_shopify_order_management_outcome();

CREATE OR REPLACE FUNCTION protect_shopify_order_management_downstream_race()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  scoped_organization_id uuid;
  scoped_order_id uuid;
BEGIN
  scoped_organization_id :=
    (to_jsonb(NEW)->>'organization_id')::uuid;
  IF TG_TABLE_NAME = 'operations_orders' THEN
    IF to_jsonb(NEW)->>'status' IS NOT DISTINCT FROM
         to_jsonb(OLD)->>'status'
       AND to_jsonb(NEW)->>'archived_at' IS NOT DISTINCT FROM
         to_jsonb(OLD)->>'archived_at'
    THEN
      RETURN NEW;
    END IF;
    scoped_order_id := (to_jsonb(NEW)->>'id')::uuid;
  ELSE
    scoped_order_id := (to_jsonb(NEW)->>'order_id')::uuid;
  END IF;
  IF scoped_organization_id IS NULL OR scoped_order_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Lock even prepared authorizations. If planning wins, a waiting claim sees
  -- the committed downstream row and fails its zero-downstream recheck. If
  -- claim wins, status is processing before this lock is released and the
  -- downstream write is rejected. Unknown attempts retain the same fence.
  PERFORM authz.id
  FROM operations_shopify_order_management_authorizations authz
  WHERE authz.organization_id = scoped_organization_id
    AND authz.order_id = scoped_order_id
    AND authz.status IN ('prepared', 'processing', 'unknown')
  ORDER BY authz.id
  FOR UPDATE;

  IF EXISTS (
    SELECT 1
    FROM operations_shopify_order_management_authorizations authz
    WHERE authz.organization_id = scoped_organization_id
      AND authz.order_id = scoped_order_id
      AND authz.status IN ('processing', 'unknown')
  ) THEN
    RAISE EXCEPTION
      'Shopify order management attempt blocks downstream planning';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_shopify_order_management_order_status_race
  ON operations_orders;
CREATE TRIGGER protect_shopify_order_management_order_status_race
BEFORE UPDATE OF status, archived_at
ON operations_orders
FOR EACH ROW EXECUTE FUNCTION
  protect_shopify_order_management_downstream_race();

DROP TRIGGER IF EXISTS protect_shopify_order_management_plan_race
  ON operations_fulfillment_plans;
CREATE TRIGGER protect_shopify_order_management_plan_race
BEFORE INSERT OR UPDATE OF organization_id, order_id
ON operations_fulfillment_plans
FOR EACH ROW EXECUTE FUNCTION
  protect_shopify_order_management_downstream_race();

DROP TRIGGER IF EXISTS protect_shopify_order_management_reservation_race
  ON operations_reservations;
CREATE TRIGGER protect_shopify_order_management_reservation_race
BEFORE INSERT OR UPDATE OF organization_id, order_id
ON operations_reservations
FOR EACH ROW EXECUTE FUNCTION
  protect_shopify_order_management_downstream_race();

DROP TRIGGER IF EXISTS protect_shopify_order_management_billable_event_race
  ON operations_billable_events;
CREATE TRIGGER protect_shopify_order_management_billable_event_race
BEFORE INSERT OR UPDATE OF organization_id, order_id
ON operations_billable_events
FOR EACH ROW EXECUTE FUNCTION
  protect_shopify_order_management_downstream_race();

DROP TRIGGER IF EXISTS
  block_shopify_order_management_sandbox_e2e_authorization_race
  ON operations_sandbox_commerce_e2e_authorizations;
CREATE TRIGGER
  block_shopify_order_management_sandbox_e2e_authorization_race
BEFORE INSERT OR UPDATE OF organization_id, order_id
ON operations_sandbox_commerce_e2e_authorizations
FOR EACH ROW EXECUTE FUNCTION
  protect_shopify_order_management_downstream_race();

COMMENT ON FUNCTION operations_shopify_order_management_is_current(
  uuid, uuid, boolean
) IS
  'Exact account, credential, activation, imported-order, source-hash, and optional zero-downstream claim fence for Shopify order management.';
