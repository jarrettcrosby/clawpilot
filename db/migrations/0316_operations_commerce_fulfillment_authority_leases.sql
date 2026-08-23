-- Exact credential-generation leases for Shopify and Faire fulfillment writes.
--
-- A prepared v2 fulfillment provider attempt is the durable boundary for one
-- possible external mutation.  The attempt's exact token and expiry fence the
-- worker, while system-managed parent counters prevent the bound commerce
-- account or credential generation from drifting until that attempt becomes
-- terminal.  Provider Writes may still be turned Off while an exact attempt is
-- in flight; Off prevents new attempts and does not rewrite durable history.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, public, pg_temp;

-- Match the runtime trigger order before ALTER takes any parent-table lock:
-- provider attempt, account, then credential. ACCESS EXCLUSIVE is retained for
-- the transaction and makes later ALTER/backfill locks reentrant.
LOCK TABLE public.operations_commerce_provider_attempts,
  public.operations_integration_accounts,
  public.operations_commerce_credentials
  IN ACCESS EXCLUSIVE MODE;

ALTER TABLE public.operations_integration_accounts
  ADD COLUMN IF NOT EXISTS commerce_fulfillment_lease_count integer
    NOT NULL DEFAULT 0;

ALTER TABLE public.operations_integration_accounts
  DROP CONSTRAINT IF EXISTS ops_integration_accounts_fulfillment_lease_valid,
  ADD CONSTRAINT ops_integration_accounts_fulfillment_lease_valid CHECK (
    commerce_fulfillment_lease_count >= 0
  );

ALTER TABLE public.operations_commerce_credentials
  ADD COLUMN IF NOT EXISTS commerce_fulfillment_lease_count integer
    NOT NULL DEFAULT 0;

ALTER TABLE public.operations_commerce_credentials
  DROP CONSTRAINT IF EXISTS ops_commerce_credentials_fulfillment_lease_valid,
  ADD CONSTRAINT ops_commerce_credentials_fulfillment_lease_valid CHECK (
    commerce_fulfillment_lease_count >= 0
  );

CREATE OR REPLACE FUNCTION
  public.operations_commerce_fulfillment_authority_is_current(
    requested_organization_id uuid,
    requested_integration_account_id uuid,
    requested_action text,
    requested_adapter_version text,
    requested_external_object_id text,
    requested_attempt_number integer,
    requested_redacted_request jsonb,
    require_latest_on_control boolean
  )
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.operations_integration_accounts account
    JOIN public.operations_commerce_credentials credential
      ON credential.organization_id = account.organization_id
     AND credential.integration_account_id = account.id
    JOIN public.operations_commerce_fulfillment_exports fulfillment_export
      ON fulfillment_export.organization_id = account.organization_id
     AND fulfillment_export.global_id = requested_external_object_id
     AND fulfillment_export.provider = account.provider
    JOIN public.operations_orders source_order
      ON source_order.organization_id = fulfillment_export.organization_id
     AND source_order.id = fulfillment_export.order_id
     AND source_order.integration_account_id = account.id
     AND source_order.source_provider = account.provider
     AND source_order.external_order_id =
           fulfillment_export.external_order_id
    JOIN public.operations_commerce_provider_write_controls control
      ON control.organization_id = account.organization_id
     AND control.integration_account_id = account.id
     AND control.provider = account.provider
     AND control.row_version = CASE
           WHEN (
             requested_redacted_request->'providerWriteAuthority'
               ->>'controlRowVersion'
           ) ~ '^[0-9]+$'
           THEN (
             requested_redacted_request->'providerWriteAuthority'
               ->>'controlRowVersion'
           )::bigint
           ELSE -1
         END
    WHERE account.organization_id = requested_organization_id
      AND account.id = requested_integration_account_id
      AND account.integration_type = 'commerce'
      AND account.provider IN ('shopify', 'faire')
      AND account.status = 'active'
      AND account.external_account_id IS NOT NULL
      AND account.commerce_credential_generation > 0
      AND credential.external_account_id = account.external_account_id
      AND credential.credential_version =
            account.commerce_credential_generation
      AND credential.verification_status = 'verified'
      AND credential.last_error_code IS NULL
      AND fulfillment_export.state = 'processing'
      AND fulfillment_export.attempts = requested_attempt_number
      AND control.requested_mode = 'on'
      AND control.bound_credential_generation =
            account.commerce_credential_generation
      AND control.bound_granted_scopes =
            public.operations_commerce_granted_scope_snapshot(
              account.configuration
            )
      AND control.bound_granted_scope_digest =
            public.operations_commerce_granted_scope_digest(
              public.operations_commerce_granted_scope_snapshot(
                account.configuration
              )
            )
      AND (
        NOT require_latest_on_control
        OR NOT EXISTS (
          SELECT 1
          FROM public.operations_commerce_provider_write_controls later
          WHERE later.organization_id = control.organization_id
            AND later.integration_account_id = control.integration_account_id
            AND later.row_version > control.row_version
        )
      )
      AND requested_redacted_request->'providerWriteAuthority' =
            pg_catalog.jsonb_build_object(
              'accountGlobalId', account.global_id,
              'provider', account.provider,
              'environment', account.environment,
              'controlRowVersion', control.row_version,
              'credentialGeneration', account.commerce_credential_generation,
              'grantedScopeDigest', control.bound_granted_scope_digest
            )
      AND (
        (
          account.provider = 'shopify'
          AND requested_action = 'shopify.fulfillment.create'
          AND requested_adapter_version =
                'shopify-fulfillment-writeback-v2'
          AND account.environment IN ('sandbox', 'production')
          AND credential.auth_mode = 'shopify_client_credentials'
          AND (
            'read_orders' = ANY(control.bound_granted_scopes)
            OR 'write_orders' = ANY(control.bound_granted_scopes)
          )
          AND 'write_merchant_managed_fulfillment_orders' =
                ANY(control.bound_granted_scopes)
        )
        OR (
          account.provider = 'faire'
          AND requested_action = 'faire.fulfillment.shipments.create'
          AND requested_adapter_version =
                'faire-fulfillment-writeback-v2'
          AND account.environment = 'production'
          AND credential.auth_mode = 'faire_oauth'
          AND control.bound_granted_scopes @> ARRAY[
            'READ_BRAND', 'READ_ORDERS', 'READ_SHIPMENTS', 'WRITE_ORDERS'
          ]::text[]
          AND EXISTS (
            SELECT 1
            FROM public.operations_faire_provider_write_scope_evidence evidence
            WHERE evidence.organization_id = account.organization_id
              AND evidence.integration_account_id = account.id
              AND evidence.credential_generation =
                    account.commerce_credential_generation
              AND public.operations_faire_provider_write_scope_evidence_is_current(
                account.organization_id,
                evidence.id,
                account.id,
                account.commerce_credential_generation
              )
          )
        )
      )
  )
$$;

CREATE OR REPLACE FUNCTION
  public.maintain_operations_commerce_fulfillment_authority_lease()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  authority jsonb;
  credential_generation integer;
  affected_rows integer;
  prior_internal_setting text;
  exact_contract boolean;
BEGIN
  exact_contract := (
    NEW.action = 'shopify.fulfillment.create'
    AND NEW.adapter_version = 'shopify-fulfillment-writeback-v2'
  ) OR (
    NEW.action = 'faire.fulfillment.shipments.create'
    AND NEW.adapter_version = 'faire-fulfillment-writeback-v2'
  );

  IF NOT exact_contract THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'prepared' THEN
      IF NEW.lease_token IS NOT NULL OR NEW.lease_expires_at IS NOT NULL THEN
        RAISE EXCEPTION
          'Terminal commerce fulfillment provider attempt cannot retain a lease';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW.lease_token IS NULL
       OR NEW.lease_expires_at IS NULL
       OR NEW.lease_expires_at <= pg_catalog.clock_timestamp()
       OR NEW.lease_expires_at >
            pg_catalog.clock_timestamp() + interval '5 minutes'
       OR NEW.lease_expires_at >
            NEW.requested_at + interval '5 minutes'
    THEN
      RAISE EXCEPTION
        'Commerce fulfillment provider attempt requires a live exact lease';
    END IF;

    -- Lock in the same account-then-credential order used by sanctioned
    -- reconnects.  The counter writes below make the insertion and any direct
    -- authority mutation serialize even when application advisory locks are
    -- bypassed.
    PERFORM 1
    FROM public.operations_integration_accounts account
    WHERE account.organization_id = NEW.organization_id
      AND account.id = NEW.integration_account_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'Commerce fulfillment provider attempt account is unavailable';
    END IF;

    PERFORM 1
    FROM public.operations_commerce_credentials credential
    WHERE credential.organization_id = NEW.organization_id
      AND credential.integration_account_id = NEW.integration_account_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'Commerce fulfillment provider attempt credential is unavailable';
    END IF;

    IF NOT public.operations_commerce_fulfillment_authority_is_current(
      NEW.organization_id,
      NEW.integration_account_id,
      NEW.action,
      NEW.adapter_version,
      NEW.external_object_id,
      NEW.attempt_number,
      NEW.redacted_request,
      true
    ) THEN
      RAISE EXCEPTION
        'Commerce fulfillment provider attempt authority is stale or invalid';
    END IF;

    authority := NEW.redacted_request->'providerWriteAuthority';
    credential_generation :=
      (authority->>'credentialGeneration')::integer;
    prior_internal_setting := pg_catalog.current_setting(
      'clawpilot.commerce_fulfillment_lease_update', true
    );
    PERFORM pg_catalog.set_config(
      'clawpilot.commerce_fulfillment_lease_update', '1', true
    );

    UPDATE public.operations_integration_accounts account
    SET commerce_fulfillment_lease_count =
          account.commerce_fulfillment_lease_count + 1
    WHERE account.organization_id = NEW.organization_id
      AND account.id = NEW.integration_account_id;
    GET DIAGNOSTICS affected_rows = ROW_COUNT;
    IF affected_rows <> 1 THEN
      RAISE EXCEPTION
        'Commerce fulfillment provider attempt account lease was not acquired';
    END IF;

    UPDATE public.operations_commerce_credentials credential
    SET commerce_fulfillment_lease_count =
          credential.commerce_fulfillment_lease_count + 1
    WHERE credential.organization_id = NEW.organization_id
      AND credential.integration_account_id = NEW.integration_account_id
      AND credential.credential_version = credential_generation;
    GET DIAGNOSTICS affected_rows = ROW_COUNT;
    IF affected_rows <> 1 THEN
      RAISE EXCEPTION
        'Commerce fulfillment provider attempt credential lease was not acquired';
    END IF;

    PERFORM pg_catalog.set_config(
      'clawpilot.commerce_fulfillment_lease_update',
      COALESCE(prior_internal_setting, ''),
      true
    );
    RETURN NEW;
  END IF;

  IF OLD.state = 'prepared' AND NEW.state <> 'prepared' THEN
    IF NEW.lease_token IS NOT NULL OR NEW.lease_expires_at IS NOT NULL THEN
      RAISE EXCEPTION
        'Terminal commerce fulfillment provider attempt must clear its lease';
    END IF;
    authority := OLD.redacted_request->'providerWriteAuthority';
    credential_generation :=
      (authority->>'credentialGeneration')::integer;
    prior_internal_setting := pg_catalog.current_setting(
      'clawpilot.commerce_fulfillment_lease_update', true
    );
    PERFORM pg_catalog.set_config(
      'clawpilot.commerce_fulfillment_lease_update', '1', true
    );

    UPDATE public.operations_integration_accounts account
    SET commerce_fulfillment_lease_count =
          account.commerce_fulfillment_lease_count - 1
    WHERE account.organization_id = OLD.organization_id
      AND account.id = OLD.integration_account_id
      AND account.commerce_fulfillment_lease_count > 0;
    GET DIAGNOSTICS affected_rows = ROW_COUNT;
    IF affected_rows <> 1 THEN
      RAISE EXCEPTION
        'Commerce fulfillment provider attempt account lease is inconsistent';
    END IF;

    UPDATE public.operations_commerce_credentials credential
    SET commerce_fulfillment_lease_count =
          credential.commerce_fulfillment_lease_count - 1
    WHERE credential.organization_id = OLD.organization_id
      AND credential.integration_account_id = OLD.integration_account_id
      AND credential.credential_version = credential_generation
      AND credential.commerce_fulfillment_lease_count > 0;
    GET DIAGNOSTICS affected_rows = ROW_COUNT;
    IF affected_rows <> 1 THEN
      RAISE EXCEPTION
        'Commerce fulfillment provider attempt credential lease is inconsistent';
    END IF;

    PERFORM pg_catalog.set_config(
      'clawpilot.commerce_fulfillment_lease_update',
      COALESCE(prior_internal_setting, ''),
      true
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION
  public.protect_operations_commerce_fulfillment_account_authority()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.commerce_fulfillment_lease_count > 0 THEN
      RAISE EXCEPTION
        'Commerce fulfillment provider authority is leased by a prepared attempt';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.commerce_fulfillment_lease_count
       IS DISTINCT FROM OLD.commerce_fulfillment_lease_count
     AND NOT (
       pg_catalog.current_setting(
         'clawpilot.commerce_fulfillment_lease_update', true
       ) = '1'
       AND pg_catalog.pg_trigger_depth() > 1
       AND (
         pg_catalog.to_jsonb(NEW) - 'commerce_fulfillment_lease_count'
       ) = (
         pg_catalog.to_jsonb(OLD) - 'commerce_fulfillment_lease_count'
       )
     )
  THEN
    RAISE EXCEPTION
      'Commerce fulfillment provider lease count is system managed';
  END IF;

  IF OLD.commerce_fulfillment_lease_count > 0
     AND ROW(
       NEW.id,
       NEW.organization_id,
       NEW.global_id,
       NEW.integration_type,
       NEW.provider,
       NEW.environment,
       NEW.status,
       NEW.external_account_id,
       NEW.commerce_credential_generation,
       NEW.credential_reference,
       NEW.configuration->'grantedScopes',
       NEW.configuration->'requestedScopes',
       NEW.configuration->>'shopDomain',
       NEW.configuration->>'authMode',
       NEW.configuration->>'scopeVerification',
       NEW.configuration->>'tokenAcquisition',
       NEW.configuration->>'oauthGrantTokenType',
       NEW.configuration->>'oauthGrantCredentialFingerprintSha256',
       NEW.configuration->>'scopeProofProviderReference',
       NEW.configuration->>'scopeProofAttemptGlobalId'
     ) IS DISTINCT FROM ROW(
       OLD.id,
       OLD.organization_id,
       OLD.global_id,
       OLD.integration_type,
       OLD.provider,
       OLD.environment,
       OLD.status,
       OLD.external_account_id,
       OLD.commerce_credential_generation,
       OLD.credential_reference,
       OLD.configuration->'grantedScopes',
       OLD.configuration->'requestedScopes',
       OLD.configuration->>'shopDomain',
       OLD.configuration->>'authMode',
       OLD.configuration->>'scopeVerification',
       OLD.configuration->>'tokenAcquisition',
       OLD.configuration->>'oauthGrantTokenType',
       OLD.configuration->>'oauthGrantCredentialFingerprintSha256',
       OLD.configuration->>'scopeProofProviderReference',
       OLD.configuration->>'scopeProofAttemptGlobalId'
     )
  THEN
    RAISE EXCEPTION
      'Commerce fulfillment provider account authority cannot drift while leased';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION
  public.protect_operations_commerce_fulfillment_credential_authority()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.commerce_fulfillment_lease_count > 0 THEN
      RAISE EXCEPTION
        'Commerce fulfillment provider credential is leased by a prepared attempt';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.commerce_fulfillment_lease_count
       IS DISTINCT FROM OLD.commerce_fulfillment_lease_count
     AND NOT (
       pg_catalog.current_setting(
         'clawpilot.commerce_fulfillment_lease_update', true
       ) = '1'
       AND pg_catalog.pg_trigger_depth() > 1
       AND (
         pg_catalog.to_jsonb(NEW) - 'commerce_fulfillment_lease_count'
       ) = (
         pg_catalog.to_jsonb(OLD) - 'commerce_fulfillment_lease_count'
       )
     )
  THEN
    RAISE EXCEPTION
      'Commerce fulfillment provider credential lease count is system managed';
  END IF;

  IF OLD.commerce_fulfillment_lease_count > 0
     AND ROW(
       NEW.organization_id,
       NEW.integration_account_id,
       NEW.external_account_id,
       NEW.auth_mode,
       NEW.credential_ciphertext,
       NEW.credential_iv,
       NEW.credential_tag,
       NEW.credential_version,
       NEW.credential_identifier_last_four,
       NEW.verification_status,
       NEW.verified_at,
       NEW.last_error_code
     ) IS DISTINCT FROM ROW(
       OLD.organization_id,
       OLD.integration_account_id,
       OLD.external_account_id,
       OLD.auth_mode,
       OLD.credential_ciphertext,
       OLD.credential_iv,
       OLD.credential_tag,
       OLD.credential_version,
       OLD.credential_identifier_last_four,
       OLD.verification_status,
       OLD.verified_at,
       OLD.last_error_code
     )
  THEN
    RAISE EXCEPTION
      'Commerce fulfillment provider credential authority cannot drift while leased';
  END IF;
  RETURN NEW;
END;
$$;

-- Migration 0303 freezes credentials while a Shopify webhook command is open.
-- Preserve that behavior while allowing only the system-owned counter update
-- performed by the exact fulfillment lease trigger.
CREATE OR REPLACE FUNCTION public.protect_shopify_order_webhook_credential_drift()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  internal_counter_only boolean := false;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    internal_counter_only := (
      pg_catalog.current_setting(
        'clawpilot.commerce_fulfillment_lease_update', true
      ) = '1'
      AND pg_catalog.pg_trigger_depth() > 1
      AND NEW.commerce_fulfillment_lease_count
            IS DISTINCT FROM OLD.commerce_fulfillment_lease_count
      AND (pg_catalog.to_jsonb(NEW) - 'commerce_fulfillment_lease_count') =
            (pg_catalog.to_jsonb(OLD) - 'commerce_fulfillment_lease_count')
    );
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.operations_shopify_order_webhook_commands command
    WHERE command.organization_id = OLD.organization_id
      AND command.integration_account_id = OLD.integration_account_id
      AND command.status IN ('prepared', 'processing', 'recoverable', 'unknown')
  ) AND (
    TG_OP = 'DELETE'
    OR (NEW IS DISTINCT FROM OLD AND NOT internal_counter_only)
  ) THEN
    RAISE EXCEPTION
      'Shopify order webhook credential cannot rotate during dispatch';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION
  public.fence_operations_commerce_fulfillment_expired_leases(
    requested_organization_id uuid,
    requested_account_global_id text
  )
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  fenced_count integer;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'commerce-provider-writes:' || requested_organization_id::text || ':' ||
        requested_account_global_id,
      0
    )
  );

  UPDATE public.operations_commerce_provider_attempts attempt
  SET state = 'unknown',
      redacted_response = pg_catalog.jsonb_build_object(
        'outcome', 'unknown',
        'reason', 'expired commerce fulfillment provider lease fenced',
        'providerWrites', 0
      ),
      error_code = 'COMMERCE_FULFILLMENT_PROVIDER_LEASE_EXPIRED',
      next_attempt_at = pg_catalog.clock_timestamp(),
      lease_token = NULL,
      lease_expires_at = NULL,
      completed_at = pg_catalog.clock_timestamp()
  FROM public.operations_integration_accounts account
  WHERE account.organization_id = requested_organization_id
    AND account.global_id = requested_account_global_id
    AND account.integration_type = 'commerce'
    AND account.provider IN ('shopify', 'faire')
    AND attempt.organization_id = account.organization_id
    AND attempt.integration_account_id = account.id
    AND attempt.state = 'prepared'
    AND (
      (
        attempt.action = 'shopify.fulfillment.create'
        AND attempt.adapter_version = 'shopify-fulfillment-writeback-v2'
      ) OR (
        attempt.action = 'faire.fulfillment.shipments.create'
        AND attempt.adapter_version = 'faire-fulfillment-writeback-v2'
      )
    )
    AND (
      attempt.lease_token IS NULL
      OR attempt.lease_expires_at IS NULL
      OR attempt.lease_expires_at <= pg_catalog.clock_timestamp()
    );
  GET DIAGNOSTICS fenced_count = ROW_COUNT;
  RETURN fenced_count;
END;
$$;

-- The top-level lock freezes the cutover set. Fence only already-expired exact
-- attempts, validate every remaining live authority, and then backfill
-- counters before installing the maintenance/protection triggers.

UPDATE public.operations_commerce_provider_attempts attempt
SET state = 'unknown',
    redacted_response = pg_catalog.jsonb_build_object(
      'outcome', 'unknown',
      'reason', 'pre-0316 expired commerce fulfillment lease fenced',
      'providerWrites', 0
    ),
    error_code = 'COMMERCE_FULFILLMENT_PROVIDER_LEASE_EXPIRED',
    next_attempt_at = pg_catalog.clock_timestamp(),
    lease_token = NULL,
    lease_expires_at = NULL,
    completed_at = pg_catalog.clock_timestamp()
WHERE attempt.state = 'prepared'
  AND (
    (
      attempt.action = 'shopify.fulfillment.create'
      AND attempt.adapter_version = 'shopify-fulfillment-writeback-v2'
    ) OR (
      attempt.action = 'faire.fulfillment.shipments.create'
      AND attempt.adapter_version = 'faire-fulfillment-writeback-v2'
    )
  )
  AND (
    attempt.lease_token IS NULL
    OR attempt.lease_expires_at IS NULL
    OR attempt.lease_expires_at <= pg_catalog.clock_timestamp()
  );

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.operations_commerce_provider_attempts attempt
    WHERE attempt.state = 'prepared'
      AND (
        (
          attempt.action = 'shopify.fulfillment.create'
          AND attempt.adapter_version = 'shopify-fulfillment-writeback-v2'
        ) OR (
          attempt.action = 'faire.fulfillment.shipments.create'
          AND attempt.adapter_version = 'faire-fulfillment-writeback-v2'
        )
      )
      AND (
        NOT public.operations_commerce_fulfillment_authority_is_current(
          attempt.organization_id,
          attempt.integration_account_id,
          attempt.action,
          attempt.adapter_version,
          attempt.external_object_id,
          attempt.attempt_number,
          attempt.redacted_request,
          false
        )
        OR attempt.lease_expires_at >
             pg_catalog.clock_timestamp() + interval '5 minutes'
        OR attempt.lease_expires_at >
             attempt.requested_at + interval '5 minutes'
      )
  ) THEN
    RAISE EXCEPTION
      'Cannot install commerce fulfillment leases over stale prepared authority';
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS protect_shopify_order_webhook_credential_drift
  ON public.operations_commerce_credentials;
DROP TRIGGER IF EXISTS protect_commerce_fulfillment_account_authority
  ON public.operations_integration_accounts;
DROP TRIGGER IF EXISTS protect_commerce_fulfillment_credential_authority
  ON public.operations_commerce_credentials;

SELECT pg_catalog.set_config(
  'clawpilot.commerce_fulfillment_lease_update', '1', true
);

UPDATE public.operations_integration_accounts
SET commerce_fulfillment_lease_count = 0
WHERE commerce_fulfillment_lease_count <> 0;

UPDATE public.operations_commerce_credentials
SET commerce_fulfillment_lease_count = 0
WHERE commerce_fulfillment_lease_count <> 0;

UPDATE public.operations_integration_accounts account
SET commerce_fulfillment_lease_count = live.count
FROM (
  SELECT attempt.organization_id,
         attempt.integration_account_id,
         pg_catalog.count(*)::integer AS count
  FROM public.operations_commerce_provider_attempts attempt
  WHERE attempt.state = 'prepared'
    AND (
      (
        attempt.action = 'shopify.fulfillment.create'
        AND attempt.adapter_version = 'shopify-fulfillment-writeback-v2'
      ) OR (
        attempt.action = 'faire.fulfillment.shipments.create'
        AND attempt.adapter_version = 'faire-fulfillment-writeback-v2'
      )
    )
  GROUP BY attempt.organization_id, attempt.integration_account_id
) live
WHERE account.organization_id = live.organization_id
  AND account.id = live.integration_account_id;

UPDATE public.operations_commerce_credentials credential
SET commerce_fulfillment_lease_count = live.count
FROM (
  SELECT attempt.organization_id,
         attempt.integration_account_id,
         (attempt.redacted_request->'providerWriteAuthority'
           ->>'credentialGeneration')::integer AS credential_generation,
         pg_catalog.count(*)::integer AS count
  FROM public.operations_commerce_provider_attempts attempt
  WHERE attempt.state = 'prepared'
    AND (
      (
        attempt.action = 'shopify.fulfillment.create'
        AND attempt.adapter_version = 'shopify-fulfillment-writeback-v2'
      ) OR (
        attempt.action = 'faire.fulfillment.shipments.create'
        AND attempt.adapter_version = 'faire-fulfillment-writeback-v2'
      )
    )
  GROUP BY attempt.organization_id, attempt.integration_account_id,
           (attempt.redacted_request->'providerWriteAuthority'
             ->>'credentialGeneration')::integer
) live
WHERE credential.organization_id = live.organization_id
  AND credential.integration_account_id = live.integration_account_id
  AND credential.credential_version = live.credential_generation;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.operations_integration_accounts account
    WHERE account.commerce_fulfillment_lease_count IS DISTINCT FROM (
      SELECT pg_catalog.count(*)::integer
      FROM public.operations_commerce_provider_attempts attempt
      WHERE attempt.organization_id = account.organization_id
        AND attempt.integration_account_id = account.id
        AND attempt.state = 'prepared'
        AND (
          (
            attempt.action = 'shopify.fulfillment.create'
            AND attempt.adapter_version = 'shopify-fulfillment-writeback-v2'
          ) OR (
            attempt.action = 'faire.fulfillment.shipments.create'
            AND attempt.adapter_version = 'faire-fulfillment-writeback-v2'
          )
        )
    )
  ) OR EXISTS (
    SELECT 1
    FROM public.operations_commerce_credentials credential
    WHERE credential.commerce_fulfillment_lease_count IS DISTINCT FROM (
      SELECT pg_catalog.count(*)::integer
      FROM public.operations_commerce_provider_attempts attempt
      WHERE attempt.organization_id = credential.organization_id
        AND attempt.integration_account_id = credential.integration_account_id
        AND attempt.state = 'prepared'
        AND (
          attempt.redacted_request->'providerWriteAuthority'
            ->>'credentialGeneration'
        )::integer = credential.credential_version
        AND (
          (
            attempt.action = 'shopify.fulfillment.create'
            AND attempt.adapter_version = 'shopify-fulfillment-writeback-v2'
          ) OR (
            attempt.action = 'faire.fulfillment.shipments.create'
            AND attempt.adapter_version = 'faire-fulfillment-writeback-v2'
          )
        )
    )
  ) THEN
    RAISE EXCEPTION
      'Commerce fulfillment provider lease counter backfill is inconsistent';
  END IF;
END;
$$;

SELECT pg_catalog.set_config(
  'clawpilot.commerce_fulfillment_lease_update', '', true
);

CREATE TRIGGER protect_shopify_order_webhook_credential_drift
BEFORE UPDATE OR DELETE ON public.operations_commerce_credentials
FOR EACH ROW EXECUTE FUNCTION
  public.protect_shopify_order_webhook_credential_drift();

DROP TRIGGER IF EXISTS maintain_commerce_fulfillment_authority_lease
  ON public.operations_commerce_provider_attempts;
CREATE TRIGGER maintain_commerce_fulfillment_authority_lease
AFTER INSERT OR UPDATE ON public.operations_commerce_provider_attempts
FOR EACH ROW EXECUTE FUNCTION
  public.maintain_operations_commerce_fulfillment_authority_lease();

DROP TRIGGER IF EXISTS protect_commerce_fulfillment_account_authority
  ON public.operations_integration_accounts;
CREATE TRIGGER protect_commerce_fulfillment_account_authority
BEFORE UPDATE OR DELETE ON public.operations_integration_accounts
FOR EACH ROW EXECUTE FUNCTION
  public.protect_operations_commerce_fulfillment_account_authority();

DROP TRIGGER IF EXISTS protect_commerce_fulfillment_credential_authority
  ON public.operations_commerce_credentials;
CREATE TRIGGER protect_commerce_fulfillment_credential_authority
BEFORE UPDATE OR DELETE ON public.operations_commerce_credentials
FOR EACH ROW EXECUTE FUNCTION
  public.protect_operations_commerce_fulfillment_credential_authority();

COMMENT ON COLUMN
  public.operations_integration_accounts.commerce_fulfillment_lease_count IS
  'System-managed count of exact prepared Shopify/Faire fulfillment provider attempts that fence account authority drift.';

COMMENT ON COLUMN
  public.operations_commerce_credentials.commerce_fulfillment_lease_count IS
  'System-managed count of exact prepared Shopify/Faire fulfillment provider attempts bound to this credential generation.';

COMMENT ON FUNCTION
  public.fence_operations_commerce_fulfillment_expired_leases(uuid, text) IS
  'Under the per-account Provider Writes advisory lock, terminalizes only expired exact prepared fulfillment attempts as unknown so sanctioned reconnects cannot re-POST them.';
