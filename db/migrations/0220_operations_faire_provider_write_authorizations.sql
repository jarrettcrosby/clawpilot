-- Durable, one-shot authority for an exact Faire provider write.
--
-- Scope evidence is immutable and credential-generation scoped. Authorization
-- creates one exact pending external effect while Operations remains Shadow.
-- Claiming consumes the authorization and inserts the existing provider-attempt
-- record in the same transaction before any network I/O. A consumed authority
-- and its attempt can never be reused for another provider call.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '25s';

INSERT INTO global_reference_entity_types (
  prefix, entity_type, display_name
) VALUES
  (
    'gfse',
    'operations.faire_provider_write_scope_evidence',
    'Faire provider-write scope evidence'
  ),
  (
    'gfwa',
    'operations.faire_provider_write_authorization',
    'Faire provider-write authorization'
  )
ON CONFLICT (prefix) DO UPDATE SET
  entity_type = EXCLUDED.entity_type,
  display_name = EXCLUDED.display_name;

CREATE OR REPLACE FUNCTION operations_faire_write_scope_list_valid(
  requested_scopes text[]
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT requested_scopes IS NOT NULL
    AND cardinality(requested_scopes) BETWEEN 1 AND 3
    AND requested_scopes <@ ARRAY[
      'WRITE_PRODUCTS', 'WRITE_INVENTORIES', 'WRITE_ORDERS'
    ]::text[]
    AND requested_scopes = ARRAY(
      SELECT DISTINCT scope
      FROM unnest(requested_scopes) AS item(scope)
      ORDER BY scope
    )
$$;

CREATE OR REPLACE FUNCTION operations_faire_write_capability_list_valid(
  requested_capabilities text[]
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT requested_capabilities IS NOT NULL
    AND cardinality(requested_capabilities) BETWEEN 1 AND 9
    AND requested_capabilities <@ ARRAY[
      'fulfillment_export',
      'inventory_update',
      'order_availability',
      'order_cancel',
      'order_processing',
      'product_draft_create',
      'product_draft_update',
      'product_image_upload',
      'tracking_export'
    ]::text[]
    AND requested_capabilities = ARRAY(
      SELECT DISTINCT capability
      FROM unnest(requested_capabilities) AS item(capability)
      ORDER BY capability
    )
$$;

CREATE OR REPLACE FUNCTION operations_faire_provider_write_canonical_jsonb(
  input_value jsonb
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
DECLARE
  serialized text;
BEGIN
  CASE jsonb_typeof(input_value)
    WHEN 'object' THEN
      SELECT
        '{' || COALESCE(
          string_agg(
            to_jsonb(entry.key)::text
              || ':'
              || operations_faire_provider_write_canonical_jsonb(entry.value),
            ',' ORDER BY entry.key
          ),
          ''
        ) || '}'
      INTO serialized
      FROM jsonb_each(input_value) entry;
    WHEN 'array' THEN
      SELECT
        '[' || COALESCE(
          string_agg(
            operations_faire_provider_write_canonical_jsonb(element.value),
            ',' ORDER BY element.ordinality
          ),
          ''
        ) || ']'
      INTO serialized
      FROM jsonb_array_elements(input_value)
        WITH ORDINALITY AS element(value, ordinality);
    ELSE
      serialized := input_value::text;
  END CASE;
  RETURN serialized;
END;
$$;

CREATE OR REPLACE FUNCTION operations_faire_provider_write_request_hash(
  input_value jsonb
)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT encode(
    digest(
      convert_to(
        operations_faire_provider_write_canonical_jsonb(input_value),
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  )
$$;

CREATE OR REPLACE FUNCTION operations_faire_provider_write_json_is_redacted(
  input_value jsonb
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  WITH RECURSIVE entries(key, node) AS (
    SELECT NULL::text, input_value
    UNION ALL
    SELECT child.key, child.node
    FROM entries parent
    CROSS JOIN LATERAL (
      SELECT object_entry.key, object_entry.value AS node
      FROM jsonb_each(
        CASE
          WHEN jsonb_typeof(parent.node) = 'object' THEN parent.node
          ELSE '{}'::jsonb
        END
      ) object_entry
      UNION ALL
      SELECT NULL::text, array_entry.value AS node
      FROM jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(parent.node) = 'array' THEN parent.node
          ELSE '[]'::jsonb
        END
      ) array_entry
    ) child
  ), normalized AS (
    SELECT regexp_replace(lower(key), '[^a-z0-9]', '', 'g') AS key
    FROM entries
    WHERE key IS NOT NULL
  )
  SELECT operations_commerce_external_effect_json_is_redacted(input_value)
    AND NOT EXISTS (
      SELECT 1
      FROM normalized
      WHERE key LIKE '%applicationsecret'
         OR (key LIKE '%faire%' AND key LIKE '%accesstoken')
         OR (key LIKE '%faire%' AND key LIKE '%brandtoken')
         OR (key LIKE '%faire%' AND key LIKE '%appcredentials')
    )
$$;

CREATE TABLE IF NOT EXISTS operations_faire_provider_write_scope_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gfse'),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  provider_attempt_id uuid NOT NULL,
  external_account_id text NOT NULL,
  credential_generation integer NOT NULL CHECK (credential_generation > 0),
  verified_write_scopes text[] NOT NULL,
  verification_source text NOT NULL CHECK (
    verification_source = 'oauth_grant'
  ),
  provider_reference text NOT NULL,
  redacted_evidence jsonb NOT NULL,
  evidence_hash text NOT NULL CHECK (evidence_hash ~ '^[a-f0-9]{64}$'),
  observed_at timestamptz NOT NULL,
  recorded_by text REFERENCES app_users(email) ON DELETE RESTRICT,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_faire_scope_evidence_global_valid CHECK (
    global_id ~ '^gfse(?:[0-9]{7}|[0-9a-v]{12})$'
  ),
  CONSTRAINT operations_faire_scope_evidence_global_unique UNIQUE (global_id),
  CONSTRAINT operations_faire_scope_evidence_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_faire_scope_evidence_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_faire_scope_evidence_attempt_fkey
    FOREIGN KEY (organization_id, provider_attempt_id)
    REFERENCES operations_commerce_provider_attempts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_faire_scope_evidence_org_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT operations_faire_scope_evidence_identity_unique UNIQUE (
    organization_id, integration_account_id, credential_generation,
    evidence_hash
  ),
  CONSTRAINT operations_faire_scope_evidence_attempt_unique UNIQUE (
    provider_attempt_id
  ),
  CONSTRAINT operations_faire_scope_evidence_scopes_valid CHECK (
    operations_faire_write_scope_list_valid(verified_write_scopes)
  ),
  CONSTRAINT operations_faire_scope_evidence_json_redacted CHECK (
    operations_faire_provider_write_json_is_redacted(redacted_evidence)
  ),
  CONSTRAINT operations_faire_scope_evidence_text_valid CHECK (
    length(btrim(external_account_id)) BETWEEN 1 AND 255
    AND external_account_id !~ '[[:cntrl:]]'
    AND length(btrim(provider_reference)) BETWEEN 1 AND 512
    AND provider_reference !~ '[[:cntrl:]]'
  ),
  CONSTRAINT operations_faire_scope_evidence_time_valid CHECK (
    observed_at <= recorded_at + interval '5 minutes'
  )
);

CREATE INDEX IF NOT EXISTS operations_faire_scope_evidence_account_idx
  ON operations_faire_provider_write_scope_evidence (
    organization_id, integration_account_id, credential_generation,
    observed_at DESC, id DESC
  );

CREATE OR REPLACE FUNCTION protect_operations_faire_scope_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Faire provider-write scope evidence cannot be deleted';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Faire provider-write scope evidence is immutable';
  END IF;

  -- Faire currently does not return a granted-scope claim in either its
  -- token response or connection probe. Requested OAuth scopes, account
  -- configuration, and application-authored attempt JSON are not proof of a
  -- granted write scope. Keep this append-only surface closed until a later
  -- migration can verify a provider-origin grant receipt cryptographically or
  -- through a provider read endpoint.
  RAISE EXCEPTION
    'Faire does not expose provider-verifiable OAuth write-scope proof; provider writes remain disabled';
END;
$$;

DROP TRIGGER IF EXISTS protect_operations_faire_scope_evidence_write
  ON operations_faire_provider_write_scope_evidence;
CREATE TRIGGER protect_operations_faire_scope_evidence_write
BEFORE INSERT OR UPDATE OR DELETE
ON operations_faire_provider_write_scope_evidence
FOR EACH ROW EXECUTE FUNCTION protect_operations_faire_scope_evidence();

CREATE OR REPLACE FUNCTION
  operations_faire_provider_write_scope_evidence_is_current(
    requested_organization_id uuid,
    requested_evidence_id uuid,
    requested_integration_account_id uuid,
    requested_credential_generation integer
  )
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  -- No provider-verifiable granted-scope receipt is currently available from
  -- Faire. Keep every production authorization path closed until one exists.
  SELECT false
$$;

CREATE OR REPLACE FUNCTION operations_faire_provider_write_fence_hash(
  requested_organization_id uuid,
  requested_integration_account_id uuid,
  requested_scope_evidence_id uuid,
  requested_external_account_id text,
  requested_credential_generation integer,
  requested_activation_revision integer,
  requested_action text,
  requested_aggregate_type text,
  requested_aggregate_id text,
  requested_aggregate_revision bigint,
  requested_aggregate_hash text,
  requested_idempotency_key text,
  requested_request_hash text,
  requested_capabilities text[],
  requested_verified_write_scopes text[],
  requested_confirmation_hash text
)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT encode(
    digest(
      convert_to(
        jsonb_build_object(
          'organizationId', requested_organization_id::text,
          'integrationAccountId', requested_integration_account_id::text,
          'scopeEvidenceId', requested_scope_evidence_id::text,
          'externalAccountId', requested_external_account_id,
          'credentialGeneration', requested_credential_generation,
          'activationRevision', requested_activation_revision,
          'action', requested_action,
          'aggregateType', requested_aggregate_type,
          'aggregateId', requested_aggregate_id,
          'aggregateRevision', requested_aggregate_revision,
          'aggregateHash', requested_aggregate_hash,
          'idempotencyKey', requested_idempotency_key,
          'requestHash', requested_request_hash,
          'capabilities', to_jsonb(requested_capabilities),
          'verifiedWriteScopes', to_jsonb(requested_verified_write_scopes),
          'confirmationHash', requested_confirmation_hash
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  )
$$;

CREATE TABLE IF NOT EXISTS operations_faire_provider_write_authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gfwa'),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  scope_evidence_id uuid NOT NULL,
  authorization_revision integer NOT NULL DEFAULT 1 CHECK (
    authorization_revision = 1
  ),
  external_account_id text NOT NULL,
  account_environment text NOT NULL DEFAULT 'production' CHECK (
    account_environment = 'production'
  ),
  credential_generation integer NOT NULL CHECK (credential_generation > 0),
  activation_state text NOT NULL DEFAULT 'shadow' CHECK (
    activation_state = 'shadow'
  ),
  activation_revision integer NOT NULL CHECK (activation_revision >= 1),
  action text NOT NULL CHECK (action = 'faire.product.draft.create'),
  aggregate_type text NOT NULL CHECK (
    aggregate_type ~ '^[a-z][a-z0-9_.:-]{0,127}$'
  ),
  aggregate_id text NOT NULL,
  aggregate_revision bigint NOT NULL CHECK (aggregate_revision >= 0),
  aggregate_hash text NOT NULL CHECK (aggregate_hash ~ '^[a-f0-9]{64}$'),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  redacted_request jsonb NOT NULL,
  capabilities text[] NOT NULL DEFAULT ARRAY['product_draft_create']::text[],
  verified_write_scopes text[] NOT NULL DEFAULT ARRAY['WRITE_PRODUCTS']::text[],
  scope_verification_source text NOT NULL CHECK (
    scope_verification_source = 'oauth_grant'
  ),
  scope_evidence_hash text NOT NULL CHECK (
    scope_evidence_hash ~ '^[a-f0-9]{64}$'
  ),
  confirmation_statement_version text NOT NULL CHECK (
    confirmation_statement_version = 'faire-provider-write-v1'
  ),
  confirmation_hash text NOT NULL CHECK (
    confirmation_hash ~ '^[a-f0-9]{64}$'
  ),
  authorization_fence_hash text GENERATED ALWAYS AS (
    operations_faire_provider_write_fence_hash(
      organization_id,
      integration_account_id,
      scope_evidence_id,
      external_account_id,
      credential_generation,
      activation_revision,
      action,
      aggregate_type,
      aggregate_id,
      aggregate_revision,
      aggregate_hash,
      idempotency_key,
      request_hash,
      capabilities,
      verified_write_scopes,
      confirmation_hash
    )
  ) STORED,
  state text NOT NULL DEFAULT 'active' CHECK (
    state IN ('active', 'consumed', 'expired', 'revoked')
  ),
  provider_attempt_id uuid,
  authorized_by text NOT NULL REFERENCES app_users(email) ON DELETE RESTRICT,
  authorized_role text NOT NULL CHECK (authorized_role IN ('owner', 'admin')),
  authorized_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  consumed_by text,
  expired_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_faire_write_auth_global_valid CHECK (
    global_id ~ '^gfwa(?:[0-9]{7}|[0-9a-v]{12})$'
  ),
  CONSTRAINT operations_faire_write_auth_global_unique UNIQUE (global_id),
  CONSTRAINT operations_faire_write_auth_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_faire_write_auth_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_faire_write_auth_scope_evidence_fkey
    FOREIGN KEY (organization_id, scope_evidence_id)
    REFERENCES operations_faire_provider_write_scope_evidence(
      organization_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_faire_write_auth_attempt_fkey
    FOREIGN KEY (organization_id, provider_attempt_id)
    REFERENCES operations_commerce_provider_attempts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_faire_write_auth_membership_fkey
    FOREIGN KEY (authorized_by, organization_id)
    REFERENCES app_user_organization_memberships(user_email, organization_id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_faire_write_auth_consumed_membership_fkey
    FOREIGN KEY (consumed_by, organization_id)
    REFERENCES app_user_organization_memberships(user_email, organization_id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_faire_write_auth_org_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT operations_faire_write_auth_idempotency_unique UNIQUE (
    organization_id, integration_account_id, action, idempotency_key
  ),
  CONSTRAINT operations_faire_write_auth_attempt_unique UNIQUE (
    provider_attempt_id
  ),
  CONSTRAINT operations_faire_write_auth_capabilities_valid CHECK (
    operations_faire_write_capability_list_valid(capabilities)
    AND capabilities = ARRAY['product_draft_create']::text[]
  ),
  CONSTRAINT operations_faire_write_auth_scopes_valid CHECK (
    operations_faire_write_scope_list_valid(verified_write_scopes)
    AND verified_write_scopes = ARRAY['WRITE_PRODUCTS']::text[]
  ),
  CONSTRAINT operations_faire_write_auth_request_redacted CHECK (
    operations_faire_provider_write_json_is_redacted(redacted_request)
    AND request_hash = operations_faire_provider_write_request_hash(
      redacted_request
    )
  ),
  CONSTRAINT operations_faire_write_auth_request_shape CHECK (
    redacted_request->>'operation' = 'productDraftCreate'
    AND jsonb_typeof(redacted_request->'draft') = 'object'
  ),
  CONSTRAINT operations_faire_write_auth_text_valid CHECK (
    length(btrim(external_account_id)) BETWEEN 1 AND 255
    AND external_account_id !~ '[[:cntrl:]]'
    AND length(btrim(aggregate_id)) BETWEEN 1 AND 512
    AND aggregate_id !~ '[[:cntrl:]]'
    AND length(btrim(idempotency_key)) BETWEEN 8 AND 255
    AND idempotency_key !~ '[[:cntrl:]]'
  ),
  CONSTRAINT operations_faire_write_auth_expiry_valid CHECK (
    expires_at > authorized_at
    AND expires_at <= authorized_at + interval '5 minutes'
  ),
  CONSTRAINT operations_faire_write_auth_lifecycle_valid CHECK (
    (
      state = 'active'
      AND provider_attempt_id IS NULL
      AND consumed_at IS NULL
      AND consumed_by IS NULL
      AND expired_at IS NULL
      AND revoked_at IS NULL
    )
    OR (
      state = 'consumed'
      AND provider_attempt_id IS NOT NULL
      AND consumed_at IS NOT NULL
      AND consumed_by IS NOT NULL
      AND expired_at IS NULL
      AND revoked_at IS NULL
    )
    OR (
      state = 'expired'
      AND provider_attempt_id IS NULL
      AND consumed_at IS NULL
      AND consumed_by IS NULL
      AND expired_at IS NOT NULL
      AND revoked_at IS NULL
    )
    OR (
      state = 'revoked'
      AND provider_attempt_id IS NULL
      AND consumed_at IS NULL
      AND consumed_by IS NULL
      AND expired_at IS NULL
      AND revoked_at IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS operations_faire_write_auth_active_aggregate_idx
  ON operations_faire_provider_write_authorizations (
    organization_id, integration_account_id, action,
    aggregate_type, aggregate_id
  )
  WHERE state = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS operations_faire_write_auth_effect_tombstone_idx
  ON operations_faire_provider_write_authorizations (
    organization_id, integration_account_id, action,
    aggregate_type, aggregate_id, aggregate_revision
  );

CREATE INDEX IF NOT EXISTS operations_faire_write_auth_expiry_idx
  ON operations_faire_provider_write_authorizations (
    expires_at, organization_id, id
  )
  WHERE state = 'active';

ALTER TABLE operations_commerce_external_effect_intents
  ADD COLUMN IF NOT EXISTS faire_provider_write_authorization_id uuid;

ALTER TABLE operations_commerce_external_effect_intents
  DROP CONSTRAINT IF EXISTS operations_commerce_effect_faire_auth_fkey,
  ADD CONSTRAINT operations_commerce_effect_faire_auth_fkey
    FOREIGN KEY (organization_id, faire_provider_write_authorization_id)
    REFERENCES operations_faire_provider_write_authorizations(
      organization_id, id
    ) ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS operations_commerce_effect_faire_auth_shape,
  ADD CONSTRAINT operations_commerce_effect_faire_auth_shape CHECK (
    faire_provider_write_authorization_id IS NULL
    OR (
      provider = 'faire'
      AND action = 'faire.product.draft.create'
      AND desired_mode = 'active'
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS operations_commerce_effect_faire_auth_unique
  ON operations_commerce_external_effect_intents (
    organization_id, faire_provider_write_authorization_id
  )
  WHERE faire_provider_write_authorization_id IS NOT NULL;

CREATE OR REPLACE FUNCTION protect_operations_faire_write_authorization()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  account_provider text;
  account_environment text;
  account_external_id text;
  account_status text;
  account_generation integer;
  credential_generation integer;
  credential_status text;
  activation_state text;
  activation_revision integer;
  evidence_account_id uuid;
  evidence_external_id text;
  evidence_generation integer;
  evidence_scopes text[];
  evidence_source text;
  evidence_hash text;
  membership_role text;
  effect_global_id text;
  attempt_account_id uuid;
  attempt_action text;
  attempt_external_object_id text;
  attempt_idempotency_key text;
  attempt_request_hash text;
  attempt_state text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Faire provider-write authorizations cannot be deleted';
  END IF;

  IF TG_OP = 'UPDATE' AND ROW(
    NEW.global_id,
    NEW.organization_id,
    NEW.integration_account_id,
    NEW.scope_evidence_id,
    NEW.authorization_revision,
    NEW.external_account_id,
    NEW.account_environment,
    NEW.credential_generation,
    NEW.activation_state,
    NEW.activation_revision,
    NEW.action,
    NEW.aggregate_type,
    NEW.aggregate_id,
    NEW.aggregate_revision,
    NEW.aggregate_hash,
    NEW.idempotency_key,
    NEW.request_hash,
    NEW.redacted_request,
    NEW.capabilities,
    NEW.verified_write_scopes,
    NEW.scope_verification_source,
    NEW.scope_evidence_hash,
    NEW.confirmation_statement_version,
    NEW.confirmation_hash,
    NEW.authorized_by,
    NEW.authorized_role,
    NEW.authorized_at,
    NEW.expires_at,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.global_id,
    OLD.organization_id,
    OLD.integration_account_id,
    OLD.scope_evidence_id,
    OLD.authorization_revision,
    OLD.external_account_id,
    OLD.account_environment,
    OLD.credential_generation,
    OLD.activation_state,
    OLD.activation_revision,
    OLD.action,
    OLD.aggregate_type,
    OLD.aggregate_id,
    OLD.aggregate_revision,
    OLD.aggregate_hash,
    OLD.idempotency_key,
    OLD.request_hash,
    OLD.redacted_request,
    OLD.capabilities,
    OLD.verified_write_scopes,
    OLD.scope_verification_source,
    OLD.scope_evidence_hash,
    OLD.confirmation_statement_version,
    OLD.confirmation_hash,
    OLD.authorized_by,
    OLD.authorized_role,
    OLD.authorized_at,
    OLD.expires_at,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Faire provider-write authorization identity is immutable';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT
      account.provider,
      account.environment,
      account.external_account_id,
      account.status,
      account.commerce_credential_generation,
      credential.credential_version,
      credential.verification_status,
      activation.state,
      activation.revision,
      membership.role
    INTO
      account_provider,
      account_environment,
      account_external_id,
      account_status,
      account_generation,
      credential_generation,
      credential_status,
      activation_state,
      activation_revision,
      membership_role
    FROM operations_integration_accounts account
    JOIN operations_commerce_credentials credential
      ON credential.organization_id = account.organization_id
     AND credential.integration_account_id = account.id
    JOIN operations_activation_scopes activation
      ON activation.organization_id = account.organization_id
    JOIN app_user_organization_memberships membership
      ON membership.organization_id = account.organization_id
     AND membership.user_email = NEW.authorized_by
     AND membership.status = 'active'
    WHERE account.organization_id = NEW.organization_id
      AND account.id = NEW.integration_account_id
      AND account.integration_type = 'commerce';

    SELECT
      evidence.integration_account_id,
      evidence.external_account_id,
      evidence.credential_generation,
      evidence.verified_write_scopes,
      evidence.verification_source,
      evidence.evidence_hash
    INTO
      evidence_account_id,
      evidence_external_id,
      evidence_generation,
      evidence_scopes,
      evidence_source,
      evidence_hash
    FROM operations_faire_provider_write_scope_evidence evidence
    WHERE evidence.organization_id = NEW.organization_id
      AND evidence.id = NEW.scope_evidence_id;

    IF NEW.state IS DISTINCT FROM 'active'
       OR account_provider IS DISTINCT FROM 'faire'
       OR account_environment IS DISTINCT FROM 'production'
       OR account_external_id IS DISTINCT FROM NEW.external_account_id
       OR account_status IS DISTINCT FROM 'active'
       OR account_generation IS DISTINCT FROM NEW.credential_generation
       OR credential_generation IS DISTINCT FROM NEW.credential_generation
       OR credential_status IS DISTINCT FROM 'verified'
       OR activation_state IS DISTINCT FROM 'shadow'
       OR activation_revision IS DISTINCT FROM NEW.activation_revision
       OR membership_role IS DISTINCT FROM NEW.authorized_role
       OR membership_role NOT IN ('owner', 'admin')
       OR evidence_account_id IS DISTINCT FROM NEW.integration_account_id
       OR evidence_external_id IS DISTINCT FROM NEW.external_account_id
       OR evidence_generation IS DISTINCT FROM NEW.credential_generation
       OR evidence_scopes IS DISTINCT FROM NEW.verified_write_scopes
       OR evidence_source IS DISTINCT FROM NEW.scope_verification_source
       OR evidence_hash IS DISTINCT FROM NEW.scope_evidence_hash
       OR NEW.request_hash IS DISTINCT FROM
            operations_faire_provider_write_request_hash(
              NEW.redacted_request
            )
       OR NOT operations_faire_provider_write_json_is_redacted(
            NEW.redacted_request
          )
       OR NOT operations_faire_provider_write_scope_evidence_is_current(
            NEW.organization_id,
            NEW.scope_evidence_id,
            NEW.integration_account_id,
            NEW.credential_generation
          ) THEN
      RAISE EXCEPTION
        'Faire provider-write authorization fence is stale or unverified';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.state <> 'active' THEN
    RAISE EXCEPTION 'Terminal Faire provider-write authorization is immutable';
  END IF;
  IF NEW.state NOT IN ('consumed', 'expired', 'revoked') THEN
    RAISE EXCEPTION 'Faire provider-write authorization transition is invalid';
  END IF;

  IF NEW.state = 'consumed' THEN
    IF OLD.expires_at <= clock_timestamp() THEN
      RAISE EXCEPTION 'Faire provider-write authorization expired before claim';
    END IF;

    SELECT effect.global_id
    INTO effect_global_id
    FROM operations_commerce_external_effect_intents effect
    WHERE effect.organization_id = NEW.organization_id
      AND effect.faire_provider_write_authorization_id = NEW.id
      AND effect.integration_account_id = NEW.integration_account_id
      AND effect.provider = 'faire'
      AND effect.action = NEW.action
      AND effect.desired_mode = 'active'
      AND effect.state = 'pending'
      AND effect.credential_generation = NEW.credential_generation
      AND effect.activation_revision = NEW.activation_revision
      AND effect.aggregate_type = NEW.aggregate_type
      AND effect.aggregate_id = NEW.aggregate_id
      AND effect.aggregate_revision = NEW.aggregate_revision
      AND effect.aggregate_hash = NEW.aggregate_hash
      AND effect.idempotency_key = NEW.idempotency_key
      AND effect.request_hash = NEW.request_hash
      AND effect.redacted_request = NEW.redacted_request
    FOR UPDATE;

    SELECT
      attempt.integration_account_id,
      attempt.action,
      attempt.external_object_id,
      attempt.idempotency_key,
      attempt.request_hash,
      attempt.state
    INTO
      attempt_account_id,
      attempt_action,
      attempt_external_object_id,
      attempt_idempotency_key,
      attempt_request_hash,
      attempt_state
    FROM operations_commerce_provider_attempts attempt
    WHERE attempt.organization_id = NEW.organization_id
      AND attempt.id = NEW.provider_attempt_id
      AND attempt.attempt_number = 1;

    IF effect_global_id IS NULL
       OR attempt_account_id IS DISTINCT FROM NEW.integration_account_id
       OR attempt_action IS DISTINCT FROM ('external_effect:' || NEW.action)
       OR attempt_external_object_id IS DISTINCT FROM effect_global_id
       OR attempt_idempotency_key IS DISTINCT FROM NEW.idempotency_key
       OR attempt_request_hash IS DISTINCT FROM NEW.request_hash
       OR attempt_state IS DISTINCT FROM 'prepared' THEN
      RAISE EXCEPTION
        'Faire provider-write claim attempt does not match its authorization';
    END IF;
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_operations_faire_write_authorization_write
  ON operations_faire_provider_write_authorizations;
CREATE TRIGGER protect_operations_faire_write_authorization_write
BEFORE INSERT OR UPDATE OR DELETE
ON operations_faire_provider_write_authorizations
FOR EACH ROW EXECUTE FUNCTION protect_operations_faire_write_authorization();

-- Exact current-state predicate shared by the external-effect protection
-- trigger. Before claim the authorization must be active and unexpired. During
-- the pending-to-claimed transition it must already be consumed by the same
-- prepared provider attempt.
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
      AND auth.request_hash =
        operations_faire_provider_write_request_hash(auth.redacted_request)
      AND requested_request_hash =
        operations_faire_provider_write_request_hash(
          requested_redacted_request
        )
      AND operations_faire_provider_write_json_is_redacted(
        auth.redacted_request
      )
      AND auth.capabilities = ARRAY['product_draft_create']::text[]
      AND auth.verified_write_scopes = ARRAY['WRITE_PRODUCTS']::text[]
      AND auth.scope_verification_source = evidence.verification_source
      AND auth.scope_evidence_hash = evidence.evidence_hash
      AND evidence.integration_account_id = auth.integration_account_id
      AND evidence.external_account_id = auth.external_account_id
      AND evidence.credential_generation = auth.credential_generation
      AND evidence.verified_write_scopes = auth.verified_write_scopes
      AND operations_faire_provider_write_scope_evidence_is_current(
        auth.organization_id,
        auth.scope_evidence_id,
        auth.integration_account_id,
        auth.credential_generation
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

-- Replace the current provider-neutral intent trigger with the same lifecycle
-- contract plus one exact Faire resource-scoped Shadow exception.
CREATE OR REPLACE FUNCTION protect_operations_commerce_external_effect_intent()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  account_provider text;
  account_type text;
  account_status text;
  account_generation integer;
  credential_generation integer;
  credential_status text;
  activation_state text;
  activation_revision integer;
  fence_revision bigint;
  fence_hash text;
  attempt_action text;
  attempt_external_object_id text;
  attempt_idempotency_key text;
  attempt_request_hash text;
  attempt_state text;
  attempt_lease_token uuid;
  attempt_redacted_response jsonb;
  attempt_provider_reference text;
  attempt_error_code text;
  exact_product_media_authority boolean := false;
  request_contains_product_media boolean := false;
  exact_product_media_parent_gid text;
  exact_faire_write_authority boolean := false;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'Commerce external-effect intents are immutable and cannot be deleted';
  END IF;

  IF NEW.provider = 'faire'
     AND NEW.action = 'faire.product.draft.create'
     AND (
       NOT operations_faire_provider_write_json_is_redacted(
         NEW.redacted_request
       )
       OR NEW.request_hash IS DISTINCT FROM
          operations_faire_provider_write_request_hash(
            NEW.redacted_request
          )
     ) THEN
    RAISE EXCEPTION
      'Faire provider-write request is not redacted or its hash is invalid';
  END IF;

  IF TG_OP = 'UPDATE' AND ROW(
    NEW.global_id,
    NEW.organization_id,
    NEW.integration_account_id,
    NEW.provider,
    NEW.action,
    NEW.desired_mode,
    NEW.credential_generation,
    NEW.activation_revision,
    NEW.aggregate_type,
    NEW.aggregate_id,
    NEW.aggregate_revision,
    NEW.aggregate_hash,
    NEW.idempotency_key,
    NEW.request_hash,
    NEW.redacted_request,
    NEW.shopify_product_media_authorization_id,
    NEW.faire_provider_write_authorization_id,
    NEW.created_by,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.global_id,
    OLD.organization_id,
    OLD.integration_account_id,
    OLD.provider,
    OLD.action,
    OLD.desired_mode,
    OLD.credential_generation,
    OLD.activation_revision,
    OLD.aggregate_type,
    OLD.aggregate_id,
    OLD.aggregate_revision,
    OLD.aggregate_hash,
    OLD.idempotency_key,
    OLD.request_hash,
    OLD.redacted_request,
    OLD.shopify_product_media_authorization_id,
    OLD.faire_provider_write_authorization_id,
    OLD.created_by,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION
      'Commerce external-effect intent identity and request are immutable';
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.provider_write_count IS DISTINCT FROM OLD.provider_write_count
     AND NOT (
       OLD.state = 'claimed'
       AND NEW.state IN ('succeeded', 'failed', 'unknown')
     ) THEN
    RAISE EXCEPTION
      'Commerce external-effect provider write count changes only at terminal finalization';
  END IF;

  IF TG_OP = 'INSERT' OR (
    TG_OP = 'UPDATE' AND OLD.state = 'pending' AND NEW.state = 'claimed'
  ) THEN
    SELECT
      account.provider,
      account.integration_type,
      account.status,
      account.commerce_credential_generation,
      credential.credential_version,
      credential.verification_status,
      activation.state,
      activation.revision,
      fence.aggregate_revision,
      fence.aggregate_hash
    INTO
      account_provider,
      account_type,
      account_status,
      account_generation,
      credential_generation,
      credential_status,
      activation_state,
      activation_revision,
      fence_revision,
      fence_hash
    FROM operations_integration_accounts account
    JOIN operations_commerce_credentials credential
      ON credential.organization_id = account.organization_id
     AND credential.integration_account_id = account.id
    JOIN operations_activation_scopes activation
      ON activation.organization_id = account.organization_id
    JOIN operations_commerce_external_effect_aggregate_fences fence
      ON fence.organization_id = account.organization_id
     AND fence.integration_account_id = account.id
     AND fence.provider = account.provider
     AND fence.aggregate_type = NEW.aggregate_type
     AND fence.aggregate_id = NEW.aggregate_id
    WHERE account.organization_id = NEW.organization_id
      AND account.id = NEW.integration_account_id;

    request_contains_product_media := (
      NEW.provider = 'shopify'
      AND NEW.action = 'shopify.product.update'
      AND COALESCE(NEW.redacted_request->'patch', '{}'::jsonb) ? 'media'
    );

    IF NEW.shopify_product_media_authorization_id IS NOT NULL THEN
      SELECT media_grant.product_gid
      INTO exact_product_media_parent_gid
      FROM operations_shopify_product_media_write_authorizations auth
      JOIN operations_shopify_product_media_delivery_grants media_grant
        ON media_grant.organization_id = auth.organization_id
       AND media_grant.id = auth.delivery_grant_id
      WHERE auth.organization_id = NEW.organization_id
        AND auth.id = NEW.shopify_product_media_authorization_id;

      IF exact_product_media_parent_gid IS NOT NULL THEN
        PERFORM pg_advisory_xact_lock(
          hashtextextended(
            'shopify-product-parent-map:'
              || NEW.organization_id::text
              || ':' || NEW.integration_account_id::text
              || ':' || exact_product_media_parent_gid,
            0
          )
        );
      END IF;

      exact_product_media_authority :=
        operations_shopify_product_media_authority_is_current(
          NEW.organization_id,
          NEW.shopify_product_media_authorization_id,
          NEW.integration_account_id,
          NEW.credential_generation,
          NEW.activation_revision,
          NEW.aggregate_type,
          NEW.aggregate_id,
          NEW.aggregate_revision,
          NEW.aggregate_hash,
          NEW.idempotency_key,
          NEW.redacted_request
        );
      IF NOT exact_product_media_authority THEN
        RAISE EXCEPTION
          'Shopify Product-image resource-scoped Shadow authority is stale, mismatched, or already invalid';
      END IF;
    END IF;

    IF NEW.faire_provider_write_authorization_id IS NOT NULL THEN
      exact_faire_write_authority :=
        operations_faire_provider_write_authority_is_current(
          NEW.organization_id,
          NEW.faire_provider_write_authorization_id,
          NEW.integration_account_id,
          NEW.global_id,
          NEW.credential_generation,
          NEW.activation_revision,
          NEW.action,
          NEW.aggregate_type,
          NEW.aggregate_id,
          NEW.aggregate_revision,
          NEW.aggregate_hash,
          NEW.idempotency_key,
          NEW.request_hash,
          NEW.redacted_request,
          NEW.provider_attempt_id
        );
      IF NOT exact_faire_write_authority THEN
        RAISE EXCEPTION
          'Faire resource-scoped Shadow provider-write authority is stale, mismatched, expired, or consumed';
      END IF;
    END IF;

    IF NEW.desired_mode = 'active'
       AND request_contains_product_media
       AND NOT exact_product_media_authority THEN
      RAISE EXCEPTION
        'An Active Shopify Product-image effect requires exact resource-scoped Shadow authority';
    END IF;

    IF NEW.provider = 'faire'
       AND NEW.desired_mode = 'active'
       AND NOT exact_faire_write_authority THEN
      RAISE EXCEPTION
        'An Active Faire effect requires exact one-shot resource-scoped Shadow authority';
    END IF;

    IF account_type IS DISTINCT FROM 'commerce'
       OR account_provider IS DISTINCT FROM NEW.provider
       OR (
         NEW.desired_mode = 'active'
         AND account_status IS DISTINCT FROM 'active'
         AND NOT exact_product_media_authority
         AND NOT exact_faire_write_authority
       )
       OR (
         (
           NEW.desired_mode = 'shadow'
           OR exact_product_media_authority
           OR exact_faire_write_authority
         )
         AND account_status NOT IN ('active', 'disabled')
       )
       OR (
         exact_faire_write_authority
         AND account_status IS DISTINCT FROM 'active'
       )
       OR account_generation IS DISTINCT FROM NEW.credential_generation
       OR credential_generation IS DISTINCT FROM NEW.credential_generation
       OR credential_status IS DISTINCT FROM 'verified' THEN
      RAISE EXCEPTION
        'Commerce external-effect credential fence is stale';
    END IF;

    IF (
      (exact_product_media_authority OR exact_faire_write_authority)
      AND (
        NEW.desired_mode IS DISTINCT FROM 'active'
        OR activation_state IS DISTINCT FROM 'shadow'
        OR activation_revision IS DISTINCT FROM NEW.activation_revision
      )
    ) OR (
      NOT exact_product_media_authority
      AND NOT exact_faire_write_authority
      AND (
        activation_state IS DISTINCT FROM NEW.desired_mode
        OR activation_revision IS DISTINCT FROM NEW.activation_revision
      )
    ) THEN
      RAISE EXCEPTION
        'Commerce external-effect activation fence is stale';
    END IF;

    IF fence_revision IS DISTINCT FROM NEW.aggregate_revision
       OR fence_hash IS DISTINCT FROM NEW.aggregate_hash THEN
      RAISE EXCEPTION
        'Commerce external-effect aggregate fence is stale';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF (
      NEW.desired_mode = 'shadow'
      AND NEW.state <> 'simulated'
    ) OR (
      NEW.desired_mode = 'active'
      AND NEW.state <> 'pending'
    ) THEN
      RAISE EXCEPTION
        'Commerce external-effect intent has an invalid initial state';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.state IN ('simulated', 'succeeded', 'failed', 'unknown') THEN
    RAISE EXCEPTION
      'Terminal commerce external-effect evidence is immutable';
  END IF;

  IF OLD.state = 'pending' THEN
    IF NEW.state <> 'claimed'
       OR OLD.desired_mode <> 'active'
       OR NEW.provider_attempt_id IS NULL
       OR NEW.lease_token IS NULL THEN
      RAISE EXCEPTION
        'Only a current provider-write external effect can be claimed';
    END IF;

    SELECT
      action,
      external_object_id,
      idempotency_key,
      request_hash,
      state,
      lease_token
    INTO
      attempt_action,
      attempt_external_object_id,
      attempt_idempotency_key,
      attempt_request_hash,
      attempt_state,
      attempt_lease_token
    FROM operations_commerce_provider_attempts
    WHERE id = NEW.provider_attempt_id
      AND organization_id = NEW.organization_id
      AND integration_account_id = NEW.integration_account_id;

    IF attempt_action IS DISTINCT FROM ('external_effect:' || NEW.action)
       OR (
         NEW.provider = 'faire'
         AND attempt_external_object_id IS DISTINCT FROM NEW.global_id
       )
       OR attempt_idempotency_key IS DISTINCT FROM NEW.idempotency_key
       OR attempt_request_hash IS DISTINCT FROM NEW.request_hash
       OR attempt_state IS DISTINCT FROM 'prepared'
       OR attempt_lease_token IS DISTINCT FROM NEW.lease_token THEN
      RAISE EXCEPTION
        'Commerce external-effect provider attempt does not match its intent';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.state <> 'claimed'
     OR NEW.state NOT IN ('succeeded', 'failed', 'unknown')
     OR NEW.provider_attempt_id IS DISTINCT FROM OLD.provider_attempt_id
     OR NEW.claimed_by IS DISTINCT FROM OLD.claimed_by
     OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at
     OR NEW.redacted_result IS NULL
     OR NEW.terminal_evidence_hash IS NULL
     OR NEW.completed_at IS NULL THEN
    RAISE EXCEPTION
      'Claimed commerce external effect must finalize exactly once';
  END IF;

  SELECT
    state,
    redacted_response,
    provider_reference,
    error_code
  INTO
    attempt_state,
    attempt_redacted_response,
    attempt_provider_reference,
    attempt_error_code
  FROM operations_commerce_provider_attempts
  WHERE id = NEW.provider_attempt_id
    AND organization_id = NEW.organization_id
    AND integration_account_id = NEW.integration_account_id;

  IF attempt_state IS DISTINCT FROM NEW.state
     OR attempt_redacted_response IS DISTINCT FROM NEW.redacted_result
     OR attempt_provider_reference IS DISTINCT FROM NEW.provider_reference
     OR attempt_error_code IS DISTINCT FROM NEW.error_code THEN
    RAISE EXCEPTION
      'Commerce external-effect terminal evidence must match its provider attempt';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON TABLE operations_faire_provider_write_scope_evidence IS
  'Immutable provider-origin evidence of exact Faire write scopes for one credential generation; requested or advertised scopes are not accepted.';
COMMENT ON TABLE operations_faire_provider_write_authorizations IS
  'Short-lived, one-use owner/admin authority for one exact Faire provider-write external effect.';
COMMENT ON COLUMN
  operations_commerce_external_effect_intents.faire_provider_write_authorization_id IS
  'Exact one-shot Faire provider-write authority; NULL for every non-Faire or non-authorized effect.';
