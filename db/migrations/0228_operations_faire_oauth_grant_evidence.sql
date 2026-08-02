-- Provider-origin Faire OAuth grant evidence.
--
-- Faire grants the exact permission list approved during authorization only
-- when a successful authorization-code exchange repeats that same list. The
-- BEARER exchange is therefore the provider grant event. This migration opens
-- the evidence table created by 0220 only for an exact, current OAuth
-- credential generation and its immutable, redacted successful exchange.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '25s';

CREATE OR REPLACE FUNCTION operations_faire_oauth_scope_list_valid(
  requested_scopes text[]
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT requested_scopes IS NOT NULL
    AND cardinality(requested_scopes) BETWEEN 1 AND 10
    AND requested_scopes <@ ARRAY[
      'READ_PRODUCTS',
      'WRITE_PRODUCTS',
      'READ_ORDERS',
      'WRITE_ORDERS',
      'READ_BRAND',
      'READ_RETAILER',
      'READ_INVENTORIES',
      'WRITE_INVENTORIES',
      'READ_SHIPMENTS',
      'READ_REVIEWS'
    ]::text[]
    AND cardinality(requested_scopes) = cardinality(ARRAY(
      SELECT DISTINCT scope
      FROM unnest(requested_scopes) AS item(scope)
    ))
$$;

CREATE OR REPLACE FUNCTION operations_faire_oauth_scope_json_valid(
  requested_scopes jsonb
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT jsonb_typeof(requested_scopes) = 'array'
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(requested_scopes) = 'array'
            THEN requested_scopes
          ELSE '[]'::jsonb
        END
      ) AS item(value)
      WHERE jsonb_typeof(item.value) <> 'string'
    )
    AND operations_faire_oauth_scope_list_valid(ARRAY(
      SELECT item.value
      FROM jsonb_array_elements_text(
        CASE
          WHEN jsonb_typeof(requested_scopes) = 'array'
            THEN requested_scopes
          ELSE '[]'::jsonb
        END
      ) WITH ORDINALITY AS item(value, ordinality)
      ORDER BY item.ordinality
    ))
$$;

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
  RETURN NEW;
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
  SELECT EXISTS (
    SELECT 1
    FROM operations_faire_provider_write_scope_evidence evidence
    JOIN operations_integration_accounts account
      ON account.organization_id = evidence.organization_id
     AND account.id = evidence.integration_account_id
    JOIN operations_commerce_credentials credential
      ON credential.organization_id = account.organization_id
     AND credential.integration_account_id = account.id
    JOIN operations_commerce_provider_attempts attempt
      ON attempt.organization_id = evidence.organization_id
     AND attempt.id = evidence.provider_attempt_id
    CROSS JOIN LATERAL (
      SELECT ARRAY(
        SELECT scope.value
        FROM jsonb_array_elements_text(
          CASE
            WHEN jsonb_typeof(
              evidence.redacted_evidence->'grantedScopes'
            ) = 'array'
              THEN evidence.redacted_evidence->'grantedScopes'
            ELSE '[]'::jsonb
          END
        ) AS scope(value)
        WHERE scope.value IN (
          'WRITE_PRODUCTS', 'WRITE_INVENTORIES', 'WRITE_ORDERS'
        )
        ORDER BY scope.value
      ) AS verified_write_scopes
    ) grant_binding
    WHERE evidence.organization_id = requested_organization_id
      AND evidence.id = requested_evidence_id
      AND evidence.integration_account_id =
        requested_integration_account_id
      AND evidence.credential_generation =
        requested_credential_generation
      AND account.integration_type = 'commerce'
      AND account.provider = 'faire'
      AND account.environment = 'production'
      AND account.status = 'active'
      AND account.external_account_id IS NOT NULL
      AND account.external_account_id = evidence.external_account_id
      AND account.commerce_credential_generation =
        requested_credential_generation
      AND account.credential_reference =
        'commerce-credential:' || account.id::text || ':v'
          || requested_credential_generation::text
      AND credential.external_account_id = account.external_account_id
      AND credential.credential_version = requested_credential_generation
      AND credential.auth_mode = 'faire_oauth'
      AND credential.verification_status = 'verified'
      AND credential.webhook_verification_status = 'not_applicable'
      AND account.configuration->>'authMode' = 'faire_oauth'
      AND account.configuration->>'tokenAcquisition' = 'authorization_code'
      AND account.configuration->>'scopeVerification' = 'oauth_grant'
      AND account.configuration->>'oauthGrantTokenType' = 'BEARER'
      AND operations_faire_oauth_scope_json_valid(
        account.configuration->'requestedScopes'
      )
      AND account.configuration->'grantedScopes' =
        account.configuration->'requestedScopes'
      AND account.configuration->'requestedScopes' =
        evidence.redacted_evidence->'requestedScopes'
      AND account.configuration->'grantedScopes' =
        evidence.redacted_evidence->'grantedScopes'
      AND account.configuration
            ->>'oauthGrantCredentialFingerprintSha256' =
        evidence.provider_reference
      AND account.configuration
            ->>'oauthGrantCredentialFingerprintSha256'
            ~ '^[a-f0-9]{64}$'
      AND account.configuration->>'scopeProofProviderReference' =
        evidence.provider_reference
      AND account.configuration->>'scopeProofAttemptGlobalId' =
        attempt.global_id
      AND evidence.verification_source = 'oauth_grant'
      AND evidence.provider_reference ~ '^[a-f0-9]{64}$'
      AND evidence.verified_write_scopes =
        grant_binding.verified_write_scopes
      AND evidence.evidence_hash =
        operations_faire_provider_write_request_hash(
          evidence.redacted_evidence
        )
      AND operations_faire_provider_write_json_is_redacted(
        evidence.redacted_evidence
      )
      AND attempt.integration_account_id = account.id
      AND attempt.action = 'faire.oauth.authorization_code.exchange'
      AND attempt.adapter_version =
        'faire-external-api-v2-oauth-authorization-code-v1'
      AND attempt.external_object_id = account.credential_reference
      AND attempt.idempotency_key =
        'faire-oauth-grant:' || requested_credential_generation::text || ':'
          || evidence.provider_reference
      AND attempt.request_hash =
        operations_faire_provider_write_request_hash(
          attempt.redacted_request
        )
      AND attempt.redacted_request = jsonb_build_object(
        'provider', 'faire',
        'operation', 'authorizationCodeExchange',
        'grantType', 'AUTHORIZATION_CODE',
        'requestedScopes', account.configuration->'requestedScopes',
        'credentialFingerprintSha256', evidence.provider_reference,
        'providerWrites', 0
      )
      AND attempt.redacted_response = evidence.redacted_evidence
      AND evidence.redacted_evidence = jsonb_build_object(
        'provider', 'faire',
        'operation', 'authorizationCodeExchange',
        'grantType', 'AUTHORIZATION_CODE',
        'tokenType', 'BEARER',
        'externalAccountId', account.external_account_id,
        'credentialGeneration', requested_credential_generation,
        'requestedScopes', account.configuration->'requestedScopes',
        'grantedScopes', account.configuration->'grantedScopes',
        'credentialFingerprintSha256', evidence.provider_reference,
        'providerReference', evidence.provider_reference,
        'providerWrites', 0
      )
      AND attempt.state = 'succeeded'
      AND attempt.attempt_number = 1
      AND attempt.provider_reference = evidence.provider_reference
      AND attempt.error_code IS NULL
      AND attempt.next_attempt_at IS NULL
      AND attempt.lease_token IS NULL
      AND attempt.lease_expires_at IS NULL
      AND attempt.completed_at IS NOT NULL
      AND attempt.requested_at <= attempt.completed_at
      AND attempt.completed_at - attempt.requested_at <= interval '60 seconds'
      AND attempt.completed_at >= evidence.recorded_at - interval '5 minutes'
      AND attempt.completed_at <= evidence.recorded_at + interval '30 seconds'
      AND attempt.completed_at = evidence.observed_at
      AND attempt.created_by IS NOT DISTINCT FROM evidence.recorded_by
  )
$$;

CREATE OR REPLACE FUNCTION validate_operations_faire_scope_evidence_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT operations_faire_provider_write_scope_evidence_is_current(
    NEW.organization_id,
    NEW.id,
    NEW.integration_account_id,
    NEW.credential_generation
  ) THEN
    RAISE EXCEPTION
      'Faire OAuth scope evidence does not match the current credential grant';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_operations_faire_scope_evidence_insert_write
  ON operations_faire_provider_write_scope_evidence;
CREATE TRIGGER validate_operations_faire_scope_evidence_insert_write
AFTER INSERT ON operations_faire_provider_write_scope_evidence
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_faire_scope_evidence_insert();

-- A one-shot authorization remains narrowly scoped. Its required scopes are
-- a subset of the complete immutable OAuth grant recorded for the credential.
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
       OR NOT NEW.verified_write_scopes <@ evidence_scopes
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
      AND auth.verified_write_scopes <@ evidence.verified_write_scopes
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

COMMENT ON FUNCTION operations_faire_provider_write_scope_evidence_is_current(
  uuid, uuid, uuid, integer
) IS
  'Accepts only the exact current Faire OAuth credential generation whose repeated requested scope list produced a successful BEARER authorization-code exchange and matching immutable redacted evidence.';
COMMENT ON TABLE operations_faire_provider_write_scope_evidence IS
  'Immutable exact-generation evidence from a successful Faire OAuth BEARER authorization-code exchange; contains scopes and a SHA-256 access-token fingerprint, never tokens, codes, or application secrets.';
