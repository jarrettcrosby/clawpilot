-- Provider-write control plane for Shopify and Faire.
--
-- Every possible provider mutation is first captured as an immutable,
-- tenant-scoped intent. Shadow intents are completed locally as simulations
-- and can never enter the network-claimable state. Active intents can be
-- claimed only while the commerce credential, Operations activation, and
-- source aggregate fences still exactly match the reviewed request.

INSERT INTO global_reference_entity_types (
  prefix, entity_type, display_name
) VALUES (
  'gcef',
  'operations.commerce_external_effect_intent',
  'Commerce external effect intent'
)
ON CONFLICT (prefix) DO UPDATE SET
  entity_type = EXCLUDED.entity_type,
  display_name = EXCLUDED.display_name;

CREATE OR REPLACE FUNCTION
  operations_commerce_external_effect_json_is_redacted(value jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  WITH RECURSIVE entries(key, node) AS (
    SELECT NULL::text, value
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
  )
  SELECT value IS NOT NULL
    AND jsonb_typeof(value) = 'object'
    AND octet_length(value::text) BETWEEN 2 AND 1048576
    AND NOT EXISTS (
      SELECT 1
      FROM entries
      WHERE regexp_replace(
        lower(key), '[^a-z0-9]', '', 'g'
      ) IN (
        'authorization',
        'accesstoken',
        'refreshtoken',
        'clientsecret',
        'secret',
        'secretid',
        'password',
        'apikey',
        'privatekey',
        'xshopifyaccesstoken'
      )
    )
$$;

-- This table is the provider-neutral current-revision fence for an aggregate
-- projection that can produce an external effect. Advancing it invalidates
-- any older pending intent at claim time.
CREATE TABLE IF NOT EXISTS
  operations_commerce_external_effect_aggregate_fences (
    organization_id uuid NOT NULL
      REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
    integration_account_id uuid NOT NULL,
    provider text NOT NULL CHECK (provider IN ('shopify', 'faire')),
    aggregate_type text NOT NULL CHECK (
      aggregate_type ~ '^[a-z][a-z0-9_.:-]{0,127}$'
    ),
    aggregate_id text NOT NULL CHECK (
      length(btrim(aggregate_id)) BETWEEN 1 AND 512
      AND aggregate_id !~ '[[:cntrl:]]'
    ),
    aggregate_revision bigint NOT NULL CHECK (aggregate_revision >= 0),
    aggregate_hash text NOT NULL CHECK (aggregate_hash ~ '^[a-f0-9]{64}$'),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (
      organization_id, integration_account_id, provider,
      aggregate_type, aggregate_id
    ),
    CONSTRAINT
      op_commerce_effect_fences_account_fkey
      FOREIGN KEY (organization_id, integration_account_id)
      REFERENCES operations_integration_accounts(organization_id, id)
      ON DELETE RESTRICT
  );

CREATE OR REPLACE FUNCTION
  protect_operations_commerce_external_effect_aggregate_fence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  account_provider text;
  account_type text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'Commerce external-effect aggregate fences cannot be deleted';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT provider, integration_type
      INTO account_provider, account_type
    FROM operations_integration_accounts
    WHERE organization_id = NEW.organization_id
      AND id = NEW.integration_account_id;

    IF account_type IS DISTINCT FROM 'commerce'
       OR account_provider IS DISTINCT FROM NEW.provider THEN
      RAISE EXCEPTION
        'Commerce external-effect aggregate fence account is invalid';
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(
    NEW.organization_id,
    NEW.integration_account_id,
    NEW.provider,
    NEW.aggregate_type,
    NEW.aggregate_id
  ) IS DISTINCT FROM ROW(
    OLD.organization_id,
    OLD.integration_account_id,
    OLD.provider,
    OLD.aggregate_type,
    OLD.aggregate_id
  ) THEN
    RAISE EXCEPTION
      'Commerce external-effect aggregate fence identity is immutable';
  END IF;

  IF NEW.aggregate_revision <= OLD.aggregate_revision THEN
    RAISE EXCEPTION
      'Commerce external-effect aggregate revision must increase';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  protect_op_commerce_effect_fence_write
  ON operations_commerce_external_effect_aggregate_fences;
CREATE TRIGGER
  protect_op_commerce_effect_fence_write
BEFORE INSERT OR UPDATE OR DELETE
ON operations_commerce_external_effect_aggregate_fences
FOR EACH ROW EXECUTE FUNCTION
  protect_operations_commerce_external_effect_aggregate_fence();

CREATE TABLE IF NOT EXISTS operations_commerce_external_effect_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gcef'),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('shopify', 'faire')),
  action text NOT NULL CHECK (
    action ~ '^[a-z][a-z0-9_.:-]{0,127}$'
  ),
  desired_mode text NOT NULL CHECK (desired_mode IN ('shadow', 'active')),
  credential_generation integer NOT NULL CHECK (credential_generation > 0),
  activation_revision integer NOT NULL CHECK (activation_revision >= 1),
  aggregate_type text NOT NULL CHECK (
    aggregate_type ~ '^[a-z][a-z0-9_.:-]{0,127}$'
  ),
  aggregate_id text NOT NULL CHECK (
    length(btrim(aggregate_id)) BETWEEN 1 AND 512
    AND aggregate_id !~ '[[:cntrl:]]'
  ),
  aggregate_revision bigint NOT NULL CHECK (aggregate_revision >= 0),
  aggregate_hash text NOT NULL CHECK (aggregate_hash ~ '^[a-f0-9]{64}$'),
  idempotency_key text NOT NULL CHECK (
    length(btrim(idempotency_key)) BETWEEN 1 AND 255
    AND idempotency_key !~ '[[:cntrl:]]'
  ),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  redacted_request jsonb NOT NULL,
  state text NOT NULL CHECK (
    state IN (
      'pending', 'claimed', 'simulated', 'succeeded', 'failed', 'unknown'
    )
  ),
  provider_attempt_id uuid
    REFERENCES operations_commerce_provider_attempts(id) ON DELETE RESTRICT,
  lease_token uuid,
  lease_expires_at timestamptz,
  claimed_by text,
  claimed_at timestamptz,
  redacted_result jsonb,
  terminal_evidence_hash text,
  provider_reference text,
  error_code text,
  provider_write_count integer NOT NULL DEFAULT 0
    CHECK (provider_write_count >= 0),
  completed_at timestamptz,
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_commerce_external_effect_intents_global_valid
    CHECK (global_id ~ '^gcef[0-9]{7}$'),
  CONSTRAINT operations_commerce_external_effect_intents_global_unique
    UNIQUE (global_id),
  CONSTRAINT operations_commerce_external_effect_intents_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_external_effect_intents_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_external_effect_intents_fence_fkey
    FOREIGN KEY (
      organization_id, integration_account_id, provider,
      aggregate_type, aggregate_id
    )
    REFERENCES operations_commerce_external_effect_aggregate_fences(
      organization_id, integration_account_id, provider,
      aggregate_type, aggregate_id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_external_effect_intents_idempotency_unique
    UNIQUE (
      organization_id, integration_account_id, action, idempotency_key
    ),
  CONSTRAINT operations_commerce_external_effect_intents_org_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT operations_commerce_external_effect_intents_request_redacted
    CHECK (
      operations_commerce_external_effect_json_is_redacted(redacted_request)
    ),
  CONSTRAINT operations_commerce_external_effect_intents_result_redacted
    CHECK (
      redacted_result IS NULL
      OR operations_commerce_external_effect_json_is_redacted(redacted_result)
    ),
  CONSTRAINT operations_commerce_external_effect_intents_terminal_hash_valid
    CHECK (
      terminal_evidence_hash IS NULL
      OR terminal_evidence_hash ~ '^[a-f0-9]{64}$'
    ),
  CONSTRAINT op_commerce_effect_intents_provider_ref_valid
    CHECK (
      provider_reference IS NULL
      OR (
        length(btrim(provider_reference)) BETWEEN 1 AND 512
        AND provider_reference !~ '[[:cntrl:]]'
      )
    ),
  CONSTRAINT operations_commerce_external_effect_intents_error_code_valid
    CHECK (
      error_code IS NULL
      OR error_code ~ '^[A-Z][A-Z0-9_]{1,127}$'
    ),
  CONSTRAINT op_commerce_effect_intents_claim_identity_valid
    CHECK (
      (provider_attempt_id IS NULL AND state IN ('pending', 'simulated'))
      OR (provider_attempt_id IS NOT NULL AND state IN (
        'claimed', 'succeeded', 'failed', 'unknown'
      ))
    ),
  CONSTRAINT operations_commerce_external_effect_intents_state_valid CHECK (
    (
      desired_mode = 'active'
      AND state = 'pending'
      AND provider_attempt_id IS NULL
      AND lease_token IS NULL
      AND lease_expires_at IS NULL
      AND claimed_by IS NULL
      AND claimed_at IS NULL
      AND redacted_result IS NULL
      AND terminal_evidence_hash IS NULL
      AND provider_reference IS NULL
      AND error_code IS NULL
      AND provider_write_count = 0
      AND completed_at IS NULL
    )
    OR (
      desired_mode = 'active'
      AND state = 'claimed'
      AND provider_attempt_id IS NOT NULL
      AND lease_token IS NOT NULL
      AND lease_expires_at IS NOT NULL
      AND claimed_by IS NOT NULL
      AND length(btrim(claimed_by)) BETWEEN 1 AND 255
      AND claimed_at IS NOT NULL
      AND redacted_result IS NULL
      AND terminal_evidence_hash IS NULL
      AND provider_reference IS NULL
      AND error_code IS NULL
      AND provider_write_count = 0
      AND completed_at IS NULL
    )
    OR (
      desired_mode = 'shadow'
      AND state = 'simulated'
      AND provider_attempt_id IS NULL
      AND lease_token IS NULL
      AND lease_expires_at IS NULL
      AND claimed_by IS NULL
      AND claimed_at IS NULL
      AND redacted_result IS NOT NULL
      AND terminal_evidence_hash IS NOT NULL
      AND provider_reference IS NULL
      AND error_code IS NULL
      AND provider_write_count = 0
      AND completed_at IS NOT NULL
      AND redacted_result->>'providerWrites' = '0'
    )
    OR (
      desired_mode = 'active'
      AND state IN ('succeeded', 'failed', 'unknown')
      AND provider_attempt_id IS NOT NULL
      AND lease_token IS NULL
      AND lease_expires_at IS NULL
      AND claimed_by IS NOT NULL
      AND claimed_at IS NOT NULL
      AND redacted_result IS NOT NULL
      AND terminal_evidence_hash IS NOT NULL
      AND completed_at IS NOT NULL
      AND redacted_result->>'providerWrites'
        = provider_write_count::text
      AND (
        (state = 'succeeded' AND error_code IS NULL)
        OR (state IN ('failed', 'unknown') AND error_code IS NOT NULL)
      )
    )
  )
);

CREATE INDEX IF NOT EXISTS
  operations_commerce_external_effect_intents_claim_idx
  ON operations_commerce_external_effect_intents (
    created_at, id
  )
  WHERE state = 'pending' AND desired_mode = 'active';

CREATE INDEX IF NOT EXISTS
  operations_commerce_external_effect_intents_account_idx
  ON operations_commerce_external_effect_intents (
    organization_id, integration_account_id, created_at DESC, id DESC
  );

CREATE OR REPLACE FUNCTION
  protect_operations_commerce_external_effect_intent()
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
  attempt_idempotency_key text;
  attempt_request_hash text;
  attempt_state text;
  attempt_lease_token uuid;
  attempt_redacted_response jsonb;
  attempt_provider_reference text;
  attempt_error_code text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'Commerce external-effect intents are immutable and cannot be deleted';
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
     )
  THEN
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

    IF account_type IS DISTINCT FROM 'commerce'
       OR account_provider IS DISTINCT FROM NEW.provider
       OR (
         NEW.desired_mode = 'active'
         AND account_status IS DISTINCT FROM 'active'
       )
       OR (
         NEW.desired_mode = 'shadow'
         AND account_status NOT IN ('active', 'disabled')
       )
       OR account_generation IS DISTINCT FROM NEW.credential_generation
       OR credential_generation IS DISTINCT FROM NEW.credential_generation
       OR credential_status IS DISTINCT FROM 'verified' THEN
      RAISE EXCEPTION
        'Commerce external-effect credential fence is stale';
    END IF;

    IF activation_state IS DISTINCT FROM NEW.desired_mode
       OR activation_revision IS DISTINCT FROM NEW.activation_revision THEN
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
        'Only a current Active external effect can be claimed';
    END IF;

    SELECT
      action,
      idempotency_key,
      request_hash,
      state,
      lease_token
    INTO
      attempt_action,
      attempt_idempotency_key,
      attempt_request_hash,
      attempt_state,
      attempt_lease_token
    FROM operations_commerce_provider_attempts
    WHERE id = NEW.provider_attempt_id
      AND organization_id = NEW.organization_id
      AND integration_account_id = NEW.integration_account_id;

    IF attempt_action IS DISTINCT FROM
         ('external_effect:' || NEW.action)
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

DROP TRIGGER IF EXISTS
  protect_operations_commerce_external_effect_intent_write
  ON operations_commerce_external_effect_intents;
CREATE TRIGGER
  protect_operations_commerce_external_effect_intent_write
BEFORE INSERT OR UPDATE OR DELETE
ON operations_commerce_external_effect_intents
FOR EACH ROW EXECUTE FUNCTION
  protect_operations_commerce_external_effect_intent();

COMMENT ON TABLE
  operations_commerce_external_effect_aggregate_fences IS
  'Current provider-neutral aggregate revisions that fail closed stale commerce external effects.';
COMMENT ON TABLE operations_commerce_external_effect_intents IS
  'Immutable and idempotent Shadow simulations or Active provider-write outbox intents.';
