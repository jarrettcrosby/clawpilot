-- Fail-closed Active authority for Faire fulfillment writes.
--
-- Faire's OAuth callback currently records requested scopes only; it does not
-- expose a provider-verifiable granted-scope receipt. Requested scopes and
-- mutable account configuration must therefore never create write authority.
-- Migration 0220 remains the root of trust and currently makes every live
-- Faire write-scope assertion false. This migration binds the Commerce Active
-- cohort to that immutable evidence surface and keeps fulfillment writes
-- closed until a future migration can validate an actual provider receipt.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '25s';

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
          THEN ARRAY[
            'READ_BRAND', 'READ_ORDERS', 'READ_SHIPMENTS', 'WRITE_ORDERS'
          ]::text[]
        WHEN 'fulfillment_export'
          THEN ARRAY[
            'READ_BRAND', 'READ_ORDERS', 'READ_SHIPMENTS', 'WRITE_ORDERS'
          ]::text[]
        WHEN 'tracking_export'
          THEN ARRAY[
            'READ_BRAND', 'READ_ORDERS', 'READ_SHIPMENTS', 'WRITE_ORDERS'
          ]::text[]
        ELSE NULL
      END
    ELSE NULL
  END
$$;

CREATE OR REPLACE FUNCTION
  operations_faire_fulfillment_scope_evidence_is_current(
    requested_organization_id uuid,
    requested_integration_account_id uuid,
    requested_credential_generation integer
  )
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM operations_integration_accounts account
    JOIN operations_commerce_credentials credential
      ON credential.organization_id = account.organization_id
     AND credential.integration_account_id = account.id
    JOIN operations_faire_provider_write_scope_evidence evidence
      ON evidence.organization_id = account.organization_id
     AND evidence.integration_account_id = account.id
     AND evidence.credential_generation = credential.credential_version
    WHERE account.organization_id = requested_organization_id
      AND account.id = requested_integration_account_id
      AND account.integration_type = 'commerce'
      AND account.provider = 'faire'
      AND account.environment = 'production'
      AND account.status IN ('active', 'disabled')
      AND account.external_account_id IS NOT NULL
      AND credential.external_account_id = account.external_account_id
      AND account.commerce_credential_generation =
        requested_credential_generation
      AND credential.credential_version = requested_credential_generation
      AND credential.auth_mode = 'faire_oauth'
      AND credential.verification_status = 'verified'
      AND account.configuration->>'scopeVerification' = 'oauth_grant'
      AND evidence.external_account_id = account.external_account_id
      AND evidence.verification_source = 'oauth_grant'
      AND evidence.verified_write_scopes @> ARRAY['WRITE_ORDERS']::text[]
      AND operations_commerce_active_configuration_scopes(
            account.configuration
          ) = operations_commerce_active_configuration_scopes(
            jsonb_build_object(
              'grantedScopes',
              evidence.redacted_evidence->'grantedScopes'
            )
          )
      AND ARRAY[
            'READ_BRAND', 'READ_ORDERS', 'READ_SHIPMENTS', 'WRITE_ORDERS'
          ]::text[] <@ operations_commerce_active_configuration_scopes(
            jsonb_build_object(
              'grantedScopes',
              evidence.redacted_evidence->'grantedScopes'
            )
          )
      AND operations_faire_provider_write_scope_evidence_is_current(
            requested_organization_id,
            evidence.id,
            requested_integration_account_id,
            requested_credential_generation
          )
  )
$$;

COMMENT ON FUNCTION operations_faire_fulfillment_scope_evidence_is_current(
  uuid, uuid, integer
) IS
  'Requires immutable provider-verifiable Faire OAuth evidence for the exact account and credential generation. Requested scopes and mutable configuration alone never qualify.';

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
    ORDER BY (cohort.member->>'accountGlobalId') COLLATE "C"
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
      ORDER BY scope.value COLLATE "C"
    ) INTO claimed_scopes;
    SELECT ARRAY(
      SELECT item.value
      FROM jsonb_array_elements_text(member->'writeCapabilities')
        AS item(value)
      ORDER BY item.value COLLATE "C"
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

    IF account_provider = 'faire'
       AND claimed_capabilities && ARRAY[
         'order_update', 'fulfillment_export', 'tracking_export'
       ]::text[]
       AND NOT operations_faire_fulfillment_scope_evidence_is_current(
         requested_organization_id,
         account_id,
         account_generation
       )
    THEN
      RETURN false;
    END IF;
  END LOOP;

  RETURN true;
END;
$$;
