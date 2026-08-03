-- Provider-neutral, cohort-scoped authority for the explicit transition from
-- Operations Shadow mode to Active mode.
--
-- Preparation is metadata-only: it reads account identity, verification,
-- credential generation, and the provider-reported scope projection without
-- decrypting a credential or making a provider request. An owner or
-- administrator can then issue one short-lived authorization for that exact
-- cohort. Consumption and the Shadow-to-Active transition happen in one
-- transaction. Immutable transition evidence is the capability-claim root for
-- later provider effects; any account, credential, identity, scope, capability,
-- tenant, or activation drift makes a claim unavailable.

INSERT INTO global_reference_entity_types (
  prefix, entity_type, display_name
) VALUES
  (
    'gcap',
    'operations.commerce_active_transition_preparation',
    'Commerce Active transition preparation'
  ),
  (
    'gcaa',
    'operations.commerce_active_transition_authorization',
    'Commerce Active transition authorization'
  ),
  (
    'gcat',
    'operations.commerce_active_transition',
    'Commerce Active transition'
  )
ON CONFLICT (prefix) DO UPDATE SET
  entity_type = EXCLUDED.entity_type,
  display_name = EXCLUDED.display_name;

CREATE OR REPLACE FUNCTION
  operations_commerce_active_hash_token(requested_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
STRICT
AS $$
  SELECT octet_length(convert_to(requested_value, 'UTF8'))::text
    || ':' || requested_value
$$;

CREATE OR REPLACE FUNCTION
  operations_commerce_active_list_digest(
    requested_domain text,
    requested_values text[]
  )
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
STRICT
AS $$
  SELECT encode(
    digest(
      convert_to(
        operations_commerce_active_hash_token(requested_domain)
        || COALESCE(
          (
            SELECT string_agg(
              operations_commerce_active_hash_token(item.value),
              '' ORDER BY item.value
            )
            FROM unnest(requested_values) AS item(value)
          ),
          ''
        ),
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  )
$$;

CREATE OR REPLACE FUNCTION
  operations_commerce_active_configuration_scopes(
    requested_configuration jsonb
  )
RETURNS text[]
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN jsonb_typeof(requested_configuration->'grantedScopes') = 'array'
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(
          requested_configuration->'grantedScopes'
        ) AS entry(value)
        WHERE jsonb_typeof(entry.value) <> 'string'
      )
    THEN ARRAY(
      SELECT DISTINCT scope.value
      FROM jsonb_array_elements_text(
        requested_configuration->'grantedScopes'
      ) AS scope(value)
      WHERE scope.value ~ '^[A-Za-z][A-Za-z0-9_]{0,127}$'
      ORDER BY scope.value
    )
    ELSE '{}'::text[]
  END
$$;

CREATE OR REPLACE FUNCTION
  operations_commerce_active_capability_scopes(
    requested_provider text,
    requested_capability text
  )
RETURNS text[]
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN requested_provider = 'shopify' THEN
      CASE requested_capability
        WHEN 'catalog_publishing'
          THEN ARRAY['write_products', 'write_publications']::text[]
        WHEN 'inventory_export'
          THEN ARRAY['write_inventory', 'read_locations']::text[]
        WHEN 'inventory_transfer_synchronization'
          THEN ARRAY['write_inventory_transfers']::text[]
        WHEN 'inventory_shipment_synchronization'
          THEN ARRAY[
            'write_inventory_shipments',
            'read_inventory_shipments_received_items',
            'write_inventory_shipments_received_items'
          ]::text[]
        WHEN 'location_administration'
          THEN ARRAY['write_locations']::text[]
        WHEN 'customer_export'
          THEN ARRAY['write_customers']::text[]
        WHEN 'order_creation'
          THEN ARRAY['write_orders']::text[]
        WHEN 'order_update'
          THEN ARRAY['write_orders']::text[]
        WHEN 'order_edit'
          THEN ARRAY['write_order_edits']::text[]
        WHEN 'draft_order_synchronization'
          THEN ARRAY['write_draft_orders']::text[]
        WHEN 'refund_export'
          THEN ARRAY['write_orders']::text[]
        WHEN 'fulfillment_export'
          THEN ARRAY[
            'write_merchant_managed_fulfillment_orders'
          ]::text[]
        WHEN 'third_party_fulfillment_orchestration'
          THEN ARRAY[
            'write_third_party_fulfillment_orders'
          ]::text[]
        WHEN 'fulfillment_service'
          THEN ARRAY[
            'write_assigned_fulfillment_orders',
            'write_fulfillments'
          ]::text[]
        WHEN 'tracking_export'
          THEN ARRAY[
            'write_merchant_managed_fulfillment_orders'
          ]::text[]
        WHEN 'shipping_rate_callbacks'
          THEN ARRAY['write_shipping']::text[]
        WHEN 'return_export'
          THEN ARRAY['write_returns']::text[]
        ELSE NULL
      END
    WHEN requested_provider = 'faire' THEN
      CASE requested_capability
        WHEN 'catalog_publishing'
          THEN ARRAY['WRITE_PRODUCTS']::text[]
        WHEN 'inventory_export'
          THEN ARRAY['WRITE_INVENTORIES']::text[]
        WHEN 'order_update'
          THEN ARRAY['WRITE_ORDERS']::text[]
        WHEN 'fulfillment_export'
          THEN ARRAY['WRITE_ORDERS']::text[]
        WHEN 'tracking_export'
          THEN ARRAY['WRITE_ORDERS', 'READ_SHIPMENTS']::text[]
        ELSE NULL
      END
    ELSE NULL
  END
$$;

CREATE OR REPLACE FUNCTION
  operations_commerce_active_scope_grants_capability(
    requested_provider text,
    requested_granted_scopes text[],
    requested_capability text
  )
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT
    operations_commerce_active_capability_scopes(
      requested_provider,
      requested_capability
    ) IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM unnest(
        operations_commerce_active_capability_scopes(
          requested_provider,
          requested_capability
        )
      ) AS required(scope)
      WHERE NOT (required.scope = ANY(requested_granted_scopes))
    )
$$;

CREATE OR REPLACE FUNCTION
  operations_commerce_active_cohort_json_valid(requested_cohort jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT
    requested_cohort IS NOT NULL
    AND jsonb_typeof(requested_cohort) = 'array'
    AND jsonb_array_length(requested_cohort) BETWEEN 1 AND 8
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(requested_cohort) AS cohort(member)
      WHERE jsonb_typeof(cohort.member) <> 'object'
        OR NOT cohort.member ?& ARRAY[
          'accountId',
          'accountGlobalId',
          'provider',
          'environment',
          'externalAccountId',
          'credentialGeneration',
          'authMode',
          'priorAccountStatus',
          'targetAccountStatus',
          'grantedScopes',
          'grantedScopeDigest',
          'writeCapabilities',
          'capabilityDigest'
        ]
        OR (
          SELECT count(*)
          FROM jsonb_object_keys(cohort.member)
        ) <> 13
        OR jsonb_typeof(cohort.member->'accountId') <> 'string'
        OR cohort.member->>'accountId'
          !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
        OR jsonb_typeof(cohort.member->'accountGlobalId') <> 'string'
        OR cohort.member->>'accountGlobalId' !~ '^gia[0-9]{7}$'
        OR jsonb_typeof(cohort.member->'provider') <> 'string'
        OR cohort.member->>'provider' NOT IN ('shopify', 'faire')
        OR jsonb_typeof(cohort.member->'environment') <> 'string'
        OR cohort.member->>'environment'
          NOT IN ('sandbox', 'production')
        OR jsonb_typeof(cohort.member->'externalAccountId') <> 'string'
        OR length(btrim(cohort.member->>'externalAccountId'))
          NOT BETWEEN 1 AND 255
        OR cohort.member->>'externalAccountId' ~ '[[:cntrl:]]'
        OR jsonb_typeof(cohort.member->'credentialGeneration')
          <> 'number'
        OR cohort.member->>'credentialGeneration'
          !~ '^[1-9][0-9]{0,8}$'
        OR jsonb_typeof(cohort.member->'authMode') <> 'string'
        OR cohort.member->>'authMode'
          !~ '^[a-z][a-z0-9_]{0,63}$'
        OR jsonb_typeof(cohort.member->'priorAccountStatus') <> 'string'
        OR cohort.member->>'priorAccountStatus'
          NOT IN ('active', 'disabled')
        OR cohort.member->>'targetAccountStatus' <> 'active'
        OR jsonb_typeof(cohort.member->'grantedScopes') <> 'array'
        OR jsonb_array_length(cohort.member->'grantedScopes') > 128
        OR EXISTS (
          SELECT 1
          FROM jsonb_array_elements(
            cohort.member->'grantedScopes'
          ) AS scope(value)
          WHERE jsonb_typeof(scope.value) <> 'string'
            OR scope.value #>> '{}'
              !~ '^[A-Za-z][A-Za-z0-9_]{0,127}$'
        )
        OR ARRAY(
          SELECT scope.value
          FROM jsonb_array_elements_text(
            cohort.member->'grantedScopes'
          ) WITH ORDINALITY AS scope(value, ordinal)
          ORDER BY scope.ordinal
        ) IS DISTINCT FROM ARRAY(
          SELECT DISTINCT scope.value
          FROM jsonb_array_elements_text(
            cohort.member->'grantedScopes'
          ) AS scope(value)
          ORDER BY scope.value
        )
        OR cohort.member->>'grantedScopeDigest'
          !~ '^[a-f0-9]{64}$'
        OR jsonb_typeof(cohort.member->'writeCapabilities') <> 'array'
        OR jsonb_array_length(cohort.member->'writeCapabilities')
          NOT BETWEEN 1 AND 32
        OR EXISTS (
          SELECT 1
          FROM jsonb_array_elements(
            cohort.member->'writeCapabilities'
          ) AS capability(value)
          WHERE jsonb_typeof(capability.value) <> 'string'
            OR capability.value #>> '{}'
              !~ '^[a-z][a-z0-9_]{0,127}$'
        )
        OR ARRAY(
          SELECT capability.value
          FROM jsonb_array_elements_text(
            cohort.member->'writeCapabilities'
          ) WITH ORDINALITY AS capability(value, ordinal)
          ORDER BY capability.ordinal
        ) IS DISTINCT FROM ARRAY(
          SELECT DISTINCT capability.value
          FROM jsonb_array_elements_text(
            cohort.member->'writeCapabilities'
          ) AS capability(value)
          ORDER BY capability.value
        )
        OR cohort.member->>'capabilityDigest'
          !~ '^[a-f0-9]{64}$'
    )
    AND (
      SELECT count(*)
      FROM jsonb_array_elements(requested_cohort) AS cohort(member)
    ) = (
      SELECT count(DISTINCT cohort.member->>'accountGlobalId')
      FROM jsonb_array_elements(requested_cohort) AS cohort(member)
    )
    AND ARRAY(
      SELECT cohort.member->>'accountGlobalId'
      FROM jsonb_array_elements(requested_cohort)
        WITH ORDINALITY AS cohort(member, ordinal)
      ORDER BY cohort.ordinal
    ) IS NOT DISTINCT FROM ARRAY(
      SELECT cohort.member->>'accountGlobalId'
      FROM jsonb_array_elements(requested_cohort) AS cohort(member)
      ORDER BY cohort.member->>'accountGlobalId'
    )
$$;

CREATE OR REPLACE FUNCTION
  operations_commerce_active_cohort_hash(
    requested_organization_id uuid,
    requested_activation_state text,
    requested_activation_revision integer,
    requested_target_state text,
    requested_target_revision integer,
    requested_cohort jsonb
  )
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
STRICT
AS $$
  SELECT encode(
    digest(
      convert_to(
        operations_commerce_active_hash_token(
          'commerce-active-cohort-v1'
        )
        || operations_commerce_active_hash_token(
          requested_organization_id::text
        )
        || operations_commerce_active_hash_token(
          requested_activation_state
        )
        || operations_commerce_active_hash_token(
          requested_activation_revision::text
        )
        || operations_commerce_active_hash_token(
          requested_target_state
        )
        || operations_commerce_active_hash_token(
          requested_target_revision::text
        )
        || COALESCE(
          (
            SELECT string_agg(
              operations_commerce_active_hash_token(
                cohort.member->>'accountId'
              )
              || operations_commerce_active_hash_token(
                cohort.member->>'accountGlobalId'
              )
              || operations_commerce_active_hash_token(
                cohort.member->>'provider'
              )
              || operations_commerce_active_hash_token(
                cohort.member->>'environment'
              )
              || operations_commerce_active_hash_token(
                cohort.member->>'externalAccountId'
              )
              || operations_commerce_active_hash_token(
                cohort.member->>'credentialGeneration'
              )
              || operations_commerce_active_hash_token(
                cohort.member->>'authMode'
              )
              || operations_commerce_active_hash_token(
                cohort.member->>'priorAccountStatus'
              )
              || operations_commerce_active_hash_token(
                cohort.member->>'targetAccountStatus'
              )
              || operations_commerce_active_hash_token(
                cohort.member->>'grantedScopeDigest'
              )
              || operations_commerce_active_hash_token(
                cohort.member->>'capabilityDigest'
              ),
              '' ORDER BY cohort.member->>'accountGlobalId'
            )
            FROM jsonb_array_elements(requested_cohort)
              AS cohort(member)
          ),
          ''
        ),
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  )
$$;

CREATE TABLE IF NOT EXISTS
  operations_commerce_active_transition_preparations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    global_id text NOT NULL DEFAULT allocate_global_reference('gcap'),
    organization_id uuid NOT NULL
      REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
    cohort jsonb NOT NULL,
    cohort_hash text NOT NULL CHECK (cohort_hash ~ '^[a-f0-9]{64}$'),
    expected_activation_state text NOT NULL DEFAULT 'shadow'
      CHECK (expected_activation_state = 'shadow'),
    expected_activation_revision integer NOT NULL
      CHECK (expected_activation_revision >= 1),
    target_activation_state text NOT NULL DEFAULT 'active'
      CHECK (target_activation_state = 'active'),
    target_activation_revision integer NOT NULL
      CHECK (target_activation_revision >= 2),
    idempotency_key text NOT NULL CHECK (
      length(btrim(idempotency_key)) BETWEEN 1 AND 255
      AND idempotency_key !~ '[[:cntrl:]]'
    ),
    request_hash text NOT NULL CHECK (
      request_hash ~ '^[a-f0-9]{64}$'
    ),
    prepared_by text NOT NULL
      REFERENCES app_users(email) ON DELETE RESTRICT,
    prepared_role text NOT NULL CHECK (
      prepared_role IN ('owner', 'admin')
    ),
    prepared_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ops_commerce_active_prep_global_valid
      CHECK (global_id ~ '^gcap[0-9]{7}$'),
    CONSTRAINT ops_commerce_active_prep_global_unique UNIQUE (global_id),
    CONSTRAINT ops_commerce_active_prep_registry_fkey
      FOREIGN KEY (global_id)
      REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
    CONSTRAINT ops_commerce_active_prep_org_id_unique
      UNIQUE (organization_id, id),
    CONSTRAINT ops_commerce_active_prep_idempotency_unique
      UNIQUE (organization_id, idempotency_key),
    CONSTRAINT ops_commerce_active_prep_cohort_valid
      CHECK (operations_commerce_active_cohort_json_valid(cohort)),
    CONSTRAINT ops_commerce_active_prep_revision_valid
      CHECK (
        target_activation_revision = expected_activation_revision + 1
      )
  );

CREATE TABLE IF NOT EXISTS
  operations_commerce_active_transition_authorizations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    global_id text NOT NULL DEFAULT allocate_global_reference('gcaa'),
    organization_id uuid NOT NULL
      REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
    preparation_id uuid NOT NULL,
    cohort_hash text NOT NULL CHECK (cohort_hash ~ '^[a-f0-9]{64}$'),
    confirmation_statement_version text NOT NULL CHECK (
      confirmation_statement_version = 'commerce-active-transition-v1'
    ),
    confirmation_hash text NOT NULL CHECK (
      confirmation_hash ~ '^[a-f0-9]{64}$'
    ),
    idempotency_key text NOT NULL CHECK (
      length(btrim(idempotency_key)) BETWEEN 1 AND 255
      AND idempotency_key !~ '[[:cntrl:]]'
    ),
    request_hash text NOT NULL CHECK (
      request_hash ~ '^[a-f0-9]{64}$'
    ),
    authorized_by text NOT NULL
      REFERENCES app_users(email) ON DELETE RESTRICT,
    authorized_role text NOT NULL CHECK (
      authorized_role IN ('owner', 'admin')
    ),
    authorized_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    CONSTRAINT ops_commerce_active_auth_global_valid
      CHECK (global_id ~ '^gcaa[0-9]{7}$'),
    CONSTRAINT ops_commerce_active_auth_global_unique UNIQUE (global_id),
    CONSTRAINT ops_commerce_active_auth_registry_fkey
      FOREIGN KEY (global_id)
      REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
    CONSTRAINT ops_commerce_active_auth_prep_fkey
      FOREIGN KEY (organization_id, preparation_id)
      REFERENCES operations_commerce_active_transition_preparations(
        organization_id, id
      ) ON DELETE RESTRICT,
    CONSTRAINT ops_commerce_active_auth_org_id_unique
      UNIQUE (organization_id, id),
    CONSTRAINT ops_commerce_active_auth_idempotency_unique
      UNIQUE (organization_id, idempotency_key),
    CONSTRAINT ops_commerce_active_auth_expiry_valid CHECK (
      expires_at > authorized_at
      AND expires_at <= authorized_at + interval '5 minutes'
    )
  );

CREATE TABLE IF NOT EXISTS operations_commerce_active_transitions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    global_id text NOT NULL DEFAULT allocate_global_reference('gcat'),
    organization_id uuid NOT NULL
      REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
    preparation_id uuid NOT NULL,
    authorization_id uuid NOT NULL,
    cohort_hash text NOT NULL CHECK (cohort_hash ~ '^[a-f0-9]{64}$'),
    from_activation_state text NOT NULL CHECK (
      from_activation_state = 'shadow'
    ),
    from_activation_revision integer NOT NULL CHECK (
      from_activation_revision >= 1
    ),
    to_activation_state text NOT NULL CHECK (
      to_activation_state = 'active'
    ),
    to_activation_revision integer NOT NULL CHECK (
      to_activation_revision >= 2
    ),
    account_count integer NOT NULL CHECK (account_count BETWEEN 1 AND 8),
    capability_count integer NOT NULL CHECK (
      capability_count BETWEEN 1 AND 256
    ),
    idempotency_key text NOT NULL CHECK (
      length(btrim(idempotency_key)) BETWEEN 1 AND 255
      AND idempotency_key !~ '[[:cntrl:]]'
    ),
    request_hash text NOT NULL CHECK (
      request_hash ~ '^[a-f0-9]{64}$'
    ),
    reason text CHECK (
      reason IS NULL
      OR (
        length(btrim(reason)) BETWEEN 1 AND 500
        AND reason !~ '[[:cntrl:]]'
      )
    ),
    activated_by text NOT NULL
      REFERENCES app_users(email) ON DELETE RESTRICT,
    activated_role text NOT NULL CHECK (
      activated_role IN ('owner', 'admin')
    ),
    activated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ops_commerce_active_transition_global_valid
      CHECK (global_id ~ '^gcat[0-9]{7}$'),
    CONSTRAINT ops_commerce_active_transition_global_unique
      UNIQUE (global_id),
    CONSTRAINT ops_commerce_active_transition_registry_fkey
      FOREIGN KEY (global_id)
      REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
    CONSTRAINT ops_commerce_active_transition_prep_fkey
      FOREIGN KEY (organization_id, preparation_id)
      REFERENCES operations_commerce_active_transition_preparations(
        organization_id, id
      ) ON DELETE RESTRICT,
    CONSTRAINT ops_commerce_active_transition_auth_fkey
      FOREIGN KEY (organization_id, authorization_id)
      REFERENCES operations_commerce_active_transition_authorizations(
        organization_id, id
      ) ON DELETE RESTRICT,
    CONSTRAINT ops_commerce_active_transition_org_id_unique
      UNIQUE (organization_id, id),
    CONSTRAINT ops_commerce_active_transition_auth_unique
      UNIQUE (organization_id, authorization_id),
    CONSTRAINT ops_commerce_active_transition_revision_unique
      UNIQUE (organization_id, from_activation_revision),
    CONSTRAINT ops_commerce_active_transition_idempotency_unique
      UNIQUE (organization_id, idempotency_key),
    CONSTRAINT ops_commerce_active_transition_revision_valid CHECK (
      to_activation_revision = from_activation_revision + 1
    )
  );

CREATE INDEX IF NOT EXISTS
  ops_commerce_active_prep_latest_idx
  ON operations_commerce_active_transition_preparations (
    organization_id, prepared_at DESC, id DESC
  );

CREATE INDEX IF NOT EXISTS
  ops_commerce_active_auth_expiry_idx
  ON operations_commerce_active_transition_authorizations (
    expires_at, organization_id, id
  );

CREATE INDEX IF NOT EXISTS
  ops_commerce_active_transition_latest_idx
  ON operations_commerce_active_transitions (
    organization_id, activated_at DESC, id DESC
  );

CREATE OR REPLACE FUNCTION
  operations_commerce_active_cohort_matches_current(
    requested_organization_id uuid,
    requested_cohort jsonb,
    requested_activation_state text,
    requested_activation_revision integer,
    requested_account_status_field text
  )
RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  current_activation_state text;
  current_activation_revision integer;
  member jsonb;
  account_id uuid;
  account_global_id text;
  account_provider text;
  account_environment text;
  account_external_id text;
  account_status text;
  account_generation integer;
  account_configuration jsonb;
  credential_external_id text;
  credential_generation integer;
  credential_auth_mode text;
  credential_status text;
  current_scopes text[];
  claimed_scopes text[];
  claimed_capabilities text[];
  capability text;
BEGIN
  IF requested_account_status_field NOT IN (
    'priorAccountStatus',
    'targetAccountStatus'
  ) OR NOT operations_commerce_active_cohort_json_valid(requested_cohort)
  THEN
    RETURN false;
  END IF;

  SELECT activation.state, activation.revision
    INTO current_activation_state, current_activation_revision
  FROM operations_activation_scopes activation
  WHERE activation.organization_id = requested_organization_id;

  IF current_activation_state IS DISTINCT FROM requested_activation_state
     OR current_activation_revision IS DISTINCT FROM
       requested_activation_revision
  THEN
    RETURN false;
  END IF;

  FOR member IN
    SELECT cohort.member
    FROM jsonb_array_elements(requested_cohort) AS cohort(member)
    ORDER BY cohort.member->>'accountGlobalId'
  LOOP
    account_id := NULL;
    account_global_id := NULL;
    account_provider := NULL;
    account_environment := NULL;
    account_external_id := NULL;
    account_status := NULL;
    account_generation := NULL;
    account_configuration := NULL;
    credential_external_id := NULL;
    credential_generation := NULL;
    credential_auth_mode := NULL;
    credential_status := NULL;

    SELECT
      account.id,
      account.global_id,
      account.provider,
      account.environment,
      account.external_account_id,
      account.status,
      account.commerce_credential_generation,
      account.configuration,
      credential.external_account_id,
      credential.credential_version,
      credential.auth_mode,
      credential.verification_status
    INTO
      account_id,
      account_global_id,
      account_provider,
      account_environment,
      account_external_id,
      account_status,
      account_generation,
      account_configuration,
      credential_external_id,
      credential_generation,
      credential_auth_mode,
      credential_status
    FROM operations_integration_accounts account
    JOIN operations_commerce_credentials credential
      ON credential.organization_id = account.organization_id
     AND credential.integration_account_id = account.id
    WHERE account.organization_id = requested_organization_id
      AND account.id = (member->>'accountId')::uuid
      AND account.global_id = member->>'accountGlobalId'
      AND account.integration_type = 'commerce'
      AND account.provider IN ('shopify', 'faire');

    IF account_id IS NULL
       OR account_global_id IS DISTINCT FROM member->>'accountGlobalId'
       OR account_provider IS DISTINCT FROM member->>'provider'
       OR account_environment IS DISTINCT FROM member->>'environment'
       OR account_external_id IS DISTINCT FROM member->>'externalAccountId'
       OR credential_external_id IS DISTINCT FROM
         member->>'externalAccountId'
       OR account_status IS DISTINCT FROM
         member->>requested_account_status_field
       OR account_generation IS DISTINCT FROM
         (member->>'credentialGeneration')::integer
       OR credential_generation IS DISTINCT FROM
         (member->>'credentialGeneration')::integer
       OR credential_auth_mode IS DISTINCT FROM member->>'authMode'
       OR credential_status IS DISTINCT FROM 'verified'
    THEN
      RETURN false;
    END IF;

    current_scopes :=
      operations_commerce_active_configuration_scopes(
        account_configuration
      );
    SELECT ARRAY(
      SELECT scope.value
      FROM jsonb_array_elements_text(member->'grantedScopes')
        AS scope(value)
      ORDER BY scope.value
    ) INTO claimed_scopes;
    SELECT ARRAY(
      SELECT item.value
      FROM jsonb_array_elements_text(member->'writeCapabilities')
        AS item(value)
      ORDER BY item.value
    ) INTO claimed_capabilities;

    IF current_scopes IS DISTINCT FROM claimed_scopes
       OR operations_commerce_active_list_digest(
            'commerce-active-scopes-v1',
            current_scopes
          ) IS DISTINCT FROM member->>'grantedScopeDigest'
       OR operations_commerce_active_list_digest(
            'commerce-active-capabilities-v1',
            claimed_capabilities
          ) IS DISTINCT FROM member->>'capabilityDigest'
    THEN
      RETURN false;
    END IF;

    FOREACH capability IN ARRAY claimed_capabilities LOOP
      IF NOT operations_commerce_active_scope_grants_capability(
        account_provider,
        current_scopes,
        capability
      ) THEN
        RETURN false;
      END IF;
    END LOOP;
  END LOOP;

  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION
  operations_commerce_active_preparation_is_current(
    requested_organization_id uuid,
    requested_preparation_id uuid,
    requested_phase text
  )
RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  preparation record;
BEGIN
  SELECT prepared.*
    INTO preparation
  FROM operations_commerce_active_transition_preparations prepared
  WHERE prepared.organization_id = requested_organization_id
    AND prepared.id = requested_preparation_id;

  IF preparation.id IS NULL THEN
    RETURN false;
  END IF;
  IF requested_phase = 'shadow' THEN
    RETURN operations_commerce_active_cohort_matches_current(
      preparation.organization_id,
      preparation.cohort,
      preparation.expected_activation_state,
      preparation.expected_activation_revision,
      'priorAccountStatus'
    );
  END IF;
  IF requested_phase = 'active' THEN
    RETURN operations_commerce_active_cohort_matches_current(
      preparation.organization_id,
      preparation.cohort,
      preparation.target_activation_state,
      preparation.target_activation_revision,
      'targetAccountStatus'
    );
  END IF;
  RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION
  operations_commerce_active_confirmation_hash(
    requested_statement_version text,
    requested_cohort_hash text,
    requested_actor text,
    requested_role text
  )
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
STRICT
AS $$
  SELECT encode(
    digest(
      convert_to(
        operations_commerce_active_hash_token(
          requested_statement_version
        )
        || operations_commerce_active_hash_token(
          requested_cohort_hash
        )
        || operations_commerce_active_hash_token(
          lower(requested_actor)
        )
        || operations_commerce_active_hash_token(requested_role),
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  )
$$;

CREATE OR REPLACE FUNCTION
  protect_operations_commerce_active_preparation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  membership_role text;
  membership_status text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION
      'Commerce Active transition preparations are append-only';
  END IF;

  SELECT membership.role, membership.status
    INTO membership_role, membership_status
  FROM app_user_organization_memberships membership
  WHERE membership.organization_id = NEW.organization_id
    AND membership.user_email = NEW.prepared_by;

  IF membership_status IS DISTINCT FROM 'active'
     OR membership_role NOT IN ('owner', 'admin')
     OR membership_role IS DISTINCT FROM NEW.prepared_role
  THEN
    RAISE EXCEPTION
      'Commerce Active transition preparation requires an active owner or administrator';
  END IF;

  IF NEW.cohort_hash IS DISTINCT FROM
      operations_commerce_active_cohort_hash(
        NEW.organization_id,
        NEW.expected_activation_state,
        NEW.expected_activation_revision,
        NEW.target_activation_state,
        NEW.target_activation_revision,
        NEW.cohort
      )
     OR NOT operations_commerce_active_cohort_matches_current(
       NEW.organization_id,
       NEW.cohort,
       NEW.expected_activation_state,
       NEW.expected_activation_revision,
       'priorAccountStatus'
     )
  THEN
    RAISE EXCEPTION
      'Commerce Active transition preparation cohort is stale or mismatched';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION
  protect_operations_commerce_active_authorization()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  preparation_cohort_hash text;
  membership_role text;
  membership_status text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION
      'Commerce Active transition authorizations are append-only';
  END IF;

  SELECT prepared.cohort_hash
    INTO preparation_cohort_hash
  FROM operations_commerce_active_transition_preparations prepared
  WHERE prepared.organization_id = NEW.organization_id
    AND prepared.id = NEW.preparation_id;

  SELECT membership.role, membership.status
    INTO membership_role, membership_status
  FROM app_user_organization_memberships membership
  WHERE membership.organization_id = NEW.organization_id
    AND membership.user_email = NEW.authorized_by;

  IF preparation_cohort_hash IS DISTINCT FROM NEW.cohort_hash
     OR membership_status IS DISTINCT FROM 'active'
     OR membership_role NOT IN ('owner', 'admin')
     OR membership_role IS DISTINCT FROM NEW.authorized_role
     OR NOT operations_commerce_active_preparation_is_current(
       NEW.organization_id,
       NEW.preparation_id,
       'shadow'
     )
     OR NEW.confirmation_hash IS DISTINCT FROM
       operations_commerce_active_confirmation_hash(
         NEW.confirmation_statement_version,
         NEW.cohort_hash,
         NEW.authorized_by,
         NEW.authorized_role
       )
  THEN
    RAISE EXCEPTION
      'Commerce Active transition authorization fence is invalid';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM operations_commerce_active_transition_authorizations prior
    LEFT JOIN operations_commerce_active_transitions transition
      ON transition.organization_id = prior.organization_id
     AND transition.authorization_id = prior.id
    WHERE prior.organization_id = NEW.organization_id
      AND prior.preparation_id = NEW.preparation_id
      AND prior.id <> NEW.id
      AND prior.expires_at > now()
      AND transition.id IS NULL
  ) THEN
    RAISE EXCEPTION
      'An unconsumed Commerce Active transition authorization already exists';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION
  protect_operations_commerce_active_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  authorization_row record;
  preparation_row record;
  membership_role text;
  membership_status text;
  activation_state text;
  activation_revision integer;
  activation_actor text;
  expected_account_count integer;
  expected_capability_count integer;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION
      'Commerce Active transitions are append-only';
  END IF;

  SELECT authorized.*
    INTO authorization_row
  FROM operations_commerce_active_transition_authorizations authorized
  WHERE authorized.organization_id = NEW.organization_id
    AND authorized.id = NEW.authorization_id;

  SELECT prepared.*
    INTO preparation_row
  FROM operations_commerce_active_transition_preparations prepared
  WHERE prepared.organization_id = NEW.organization_id
    AND prepared.id = NEW.preparation_id;

  SELECT membership.role, membership.status
    INTO membership_role, membership_status
  FROM app_user_organization_memberships membership
  WHERE membership.organization_id = NEW.organization_id
    AND membership.user_email = NEW.activated_by;

  SELECT activation.state, activation.revision, activation.updated_by
    INTO activation_state, activation_revision, activation_actor
  FROM operations_activation_scopes activation
  WHERE activation.organization_id = NEW.organization_id;

  SELECT jsonb_array_length(preparation_row.cohort)
    INTO expected_account_count;
  SELECT sum(jsonb_array_length(member->'writeCapabilities'))::integer
    INTO expected_capability_count
  FROM jsonb_array_elements(preparation_row.cohort) AS cohort(member);

  IF authorization_row.id IS NULL
     OR preparation_row.id IS NULL
     OR authorization_row.preparation_id IS DISTINCT FROM preparation_row.id
     OR authorization_row.cohort_hash IS DISTINCT FROM
       preparation_row.cohort_hash
     OR NEW.cohort_hash IS DISTINCT FROM preparation_row.cohort_hash
     OR authorization_row.authorized_by IS DISTINCT FROM NEW.activated_by
     OR authorization_row.authorized_role IS DISTINCT FROM NEW.activated_role
     OR authorization_row.expires_at <= NEW.activated_at
     OR membership_status IS DISTINCT FROM 'active'
     OR membership_role IS DISTINCT FROM NEW.activated_role
     OR membership_role NOT IN ('owner', 'admin')
     OR activation_state IS DISTINCT FROM NEW.to_activation_state
     OR activation_revision IS DISTINCT FROM NEW.to_activation_revision
     OR activation_actor IS DISTINCT FROM NEW.activated_by
     OR NEW.from_activation_state IS DISTINCT FROM
       preparation_row.expected_activation_state
     OR NEW.from_activation_revision IS DISTINCT FROM
       preparation_row.expected_activation_revision
     OR NEW.to_activation_state IS DISTINCT FROM
       preparation_row.target_activation_state
     OR NEW.to_activation_revision IS DISTINCT FROM
       preparation_row.target_activation_revision
     OR NEW.account_count IS DISTINCT FROM expected_account_count
     OR NEW.capability_count IS DISTINCT FROM expected_capability_count
     OR NOT operations_commerce_active_preparation_is_current(
       NEW.organization_id,
       NEW.preparation_id,
       'active'
     )
  THEN
    RAISE EXCEPTION
      'Commerce Active transition authorization expired, was consumed, or became stale';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  protect_operations_commerce_active_preparation_write
  ON operations_commerce_active_transition_preparations;
CREATE TRIGGER
  protect_operations_commerce_active_preparation_write
BEFORE INSERT OR UPDATE OR DELETE
ON operations_commerce_active_transition_preparations
FOR EACH ROW EXECUTE FUNCTION
  protect_operations_commerce_active_preparation();

DROP TRIGGER IF EXISTS
  protect_operations_commerce_active_authorization_write
  ON operations_commerce_active_transition_authorizations;
CREATE TRIGGER
  protect_operations_commerce_active_authorization_write
BEFORE INSERT OR UPDATE OR DELETE
ON operations_commerce_active_transition_authorizations
FOR EACH ROW EXECUTE FUNCTION
  protect_operations_commerce_active_authorization();

DROP TRIGGER IF EXISTS
  protect_operations_commerce_active_transition_write
  ON operations_commerce_active_transitions;
CREATE TRIGGER
  protect_operations_commerce_active_transition_write
BEFORE INSERT OR UPDATE OR DELETE
ON operations_commerce_active_transitions
FOR EACH ROW EXECUTE FUNCTION
  protect_operations_commerce_active_transition();

CREATE OR REPLACE FUNCTION
  operations_commerce_active_capability_claim_is_current(
    requested_organization_id uuid,
    requested_transition_id uuid,
    requested_account_global_id text,
    requested_capability text
  )
RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  claim record;
BEGIN
  SELECT transition.preparation_id, prepared.cohort
    INTO claim
  FROM operations_commerce_active_transitions transition
  JOIN operations_commerce_active_transition_preparations prepared
    ON prepared.organization_id = transition.organization_id
   AND prepared.id = transition.preparation_id
  WHERE transition.organization_id = requested_organization_id
    AND transition.id = requested_transition_id
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements(prepared.cohort) AS cohort(member)
      WHERE cohort.member->>'accountGlobalId'
        = requested_account_global_id
        AND cohort.member->'writeCapabilities'
          ? requested_capability
    );

  RETURN claim.preparation_id IS NOT NULL
    AND operations_commerce_active_preparation_is_current(
      requested_organization_id,
      claim.preparation_id,
      'active'
    );
END;
$$;

COMMENT ON TABLE
  operations_commerce_active_transition_preparations IS
  'Immutable zero-secret and zero-network review evidence for one exact verified Shopify/Faire account and write-capability cohort.';
COMMENT ON TABLE
  operations_commerce_active_transition_authorizations IS
  'Immutable, owner/admin-issued, five-minute, one-time authorization for one exact Commerce Active cohort.';
COMMENT ON TABLE operations_commerce_active_transitions IS
  'Immutable evidence that one exact authorization and account cohort atomically advanced Operations from Shadow to Active.';
