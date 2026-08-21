-- Per-commerce-account provider-write control.
--
-- This append-only control is intentionally independent from the historical
-- organization activation/cohort machinery.  A missing revision means Off.
-- Turning On binds the operator decision to the exact current credential
-- generation and canonical granted-scope set; credential or scope drift makes
-- that decision stale without silently granting a new generation authority.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog, public, pg_temp;

CREATE OR REPLACE FUNCTION public.operations_commerce_granted_scope_snapshot(
  requested_configuration jsonb
)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT COALESCE(
    pg_catalog.array_agg(scope.value ORDER BY scope.value),
    ARRAY[]::text[]
  )
  FROM (
    SELECT DISTINCT item.value
    FROM pg_catalog.jsonb_array_elements_text(
      CASE
        WHEN pg_catalog.jsonb_typeof(
          requested_configuration->'grantedScopes'
        ) = 'array'
          THEN requested_configuration->'grantedScopes'
        ELSE '[]'::jsonb
      END
    ) AS item(value)
  ) AS scope
$$;

CREATE OR REPLACE FUNCTION public.operations_commerce_granted_scope_digest(
  requested_scopes text[]
)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
        pg_catalog.array_to_string(requested_scopes, E'\n'),
        'UTF8'
      )
    ),
    'hex'
  )
$$;

CREATE TABLE IF NOT EXISTS public.operations_commerce_provider_write_controls (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES public.workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('shopify', 'faire')),
  row_version bigint NOT NULL CHECK (row_version > 0),
  expected_row_version bigint NOT NULL CHECK (expected_row_version >= 0),
  requested_mode text NOT NULL CHECK (requested_mode IN ('off', 'on')),
  bound_credential_generation integer,
  bound_granted_scopes text[],
  bound_granted_scope_digest text,
  changed_by text NOT NULL
    REFERENCES public.app_users(email) ON DELETE RESTRICT,
  changed_role text NOT NULL CHECK (changed_role IN ('owner', 'admin', 'member')),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT operations_commerce_provider_write_controls_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES public.operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_provider_write_controls_revision_unique
    UNIQUE (organization_id, integration_account_id, row_version),
  CONSTRAINT operations_commerce_provider_write_controls_idempotency_unique
    UNIQUE (organization_id, integration_account_id, idempotency_key),
  CONSTRAINT operations_commerce_provider_write_controls_revision_chain_valid
    CHECK (row_version = expected_row_version + 1),
  CONSTRAINT operations_commerce_provider_write_controls_binding_valid CHECK (
    (
      requested_mode = 'off'
      AND bound_credential_generation IS NULL
      AND bound_granted_scopes IS NULL
      AND bound_granted_scope_digest IS NULL
    )
    OR (
      requested_mode = 'on'
      AND bound_credential_generation > 0
      AND pg_catalog.cardinality(bound_granted_scopes) BETWEEN 1 AND 128
      AND pg_catalog.array_position(bound_granted_scopes, NULL) IS NULL
      AND bound_granted_scope_digest ~ '^[a-f0-9]{64}$'
    )
  ),
  CONSTRAINT operations_commerce_provider_write_controls_text_valid CHECK (
    pg_catalog.length(pg_catalog.btrim(idempotency_key)) BETWEEN 8 AND 200
    AND idempotency_key = pg_catalog.btrim(idempotency_key)
    AND idempotency_key !~ '[[:cntrl:]]'
  )
);

CREATE INDEX IF NOT EXISTS operations_commerce_provider_write_controls_current_idx
  ON public.operations_commerce_provider_write_controls (
    organization_id, integration_account_id, row_version DESC
  );

CREATE OR REPLACE FUNCTION
  public.validate_operations_commerce_provider_write_control()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  account_row public.operations_integration_accounts%ROWTYPE;
  credential_row public.operations_commerce_credentials%ROWTYPE;
  current_scopes text[];
  current_scope_digest text;
  current_row_version bigint;
BEGIN
  SELECT account.*
  INTO account_row
  FROM public.operations_integration_accounts account
  WHERE account.organization_id = NEW.organization_id
    AND account.id = NEW.integration_account_id
    AND account.integration_type = 'commerce'
    AND account.provider IN ('shopify', 'faire')
  FOR SHARE;

  IF NOT FOUND OR account_row.provider IS DISTINCT FROM NEW.provider THEN
    RAISE EXCEPTION
      'commerce provider-write control account binding is invalid';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.app_user_organization_memberships membership
    WHERE membership.organization_id = NEW.organization_id
      AND membership.user_email = NEW.changed_by
      AND membership.status = 'active'
      AND membership.role = NEW.changed_role
      AND (
        membership.role = 'owner'
        OR (
          membership.role IN ('admin', 'member')
          AND COALESCE(
            (membership.permissions->>'manageOperations')::boolean,
            false
          )
        )
      )
      AND (
        NEW.requested_mode = 'off'
        OR membership.role IN ('owner', 'admin')
      )
  ) THEN
    RAISE EXCEPTION
      'commerce provider-write control actor is not authorized';
  END IF;

  SELECT COALESCE(pg_catalog.max(control.row_version), 0::bigint)
  INTO current_row_version
  FROM public.operations_commerce_provider_write_controls control
  WHERE control.organization_id = NEW.organization_id
    AND control.integration_account_id = NEW.integration_account_id;

  IF current_row_version IS DISTINCT FROM NEW.expected_row_version THEN
    RAISE EXCEPTION
      'commerce provider-write control row version is stale';
  END IF;

  IF NEW.requested_mode = 'on' THEN
    SELECT credential.*
    INTO credential_row
    FROM public.operations_commerce_credentials credential
    WHERE credential.organization_id = account_row.organization_id
      AND credential.integration_account_id = account_row.id;

    IF account_row.status IS DISTINCT FROM 'active'
       OR account_row.external_account_id IS NULL
       OR account_row.commerce_credential_generation <= 0
       OR credential_row.integration_account_id IS NULL
       OR credential_row.external_account_id
            IS DISTINCT FROM account_row.external_account_id
       OR credential_row.credential_version
            IS DISTINCT FROM account_row.commerce_credential_generation
       OR credential_row.verification_status IS DISTINCT FROM 'verified'
       OR credential_row.last_error_code IS NOT NULL
       OR (
         account_row.provider = 'shopify'
         AND credential_row.auth_mode IS DISTINCT FROM
               'shopify_client_credentials'
       )
       OR (
         account_row.provider = 'faire'
         AND credential_row.auth_mode IS DISTINCT FROM 'faire_oauth'
       ) THEN
      RAISE EXCEPTION
        'commerce provider-write control requires current verified credentials';
    END IF;

    IF pg_catalog.jsonb_typeof(
         account_row.configuration->'grantedScopes'
       ) IS DISTINCT FROM 'array'
       OR pg_catalog.jsonb_array_length(
         account_row.configuration->'grantedScopes'
       ) NOT BETWEEN 1 AND 128
       OR EXISTS (
         SELECT 1
         FROM pg_catalog.jsonb_array_elements(
           account_row.configuration->'grantedScopes'
         ) AS item(value)
         WHERE pg_catalog.jsonb_typeof(item.value) <> 'string'
       ) THEN
      RAISE EXCEPTION
        'commerce provider-write control requires exact granted scopes';
    END IF;

    current_scopes := public.operations_commerce_granted_scope_snapshot(
      account_row.configuration
    );
    IF pg_catalog.cardinality(current_scopes)
         IS DISTINCT FROM pg_catalog.jsonb_array_length(
           account_row.configuration->'grantedScopes'
         )
       OR EXISTS (
         SELECT 1
         FROM pg_catalog.unnest(current_scopes) AS scope(value)
         WHERE scope.value IS DISTINCT FROM pg_catalog.btrim(scope.value)
           OR pg_catalog.length(scope.value) NOT BETWEEN 1 AND 128
           OR scope.value ~ '[[:cntrl:]]'
       ) THEN
      RAISE EXCEPTION
        'commerce provider-write control granted scopes are invalid';
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.unnest(current_scopes) AS scope(value)
      WHERE (
        account_row.provider = 'shopify'
        AND scope.value LIKE 'write\_%' ESCAPE '\'
      ) OR (
        account_row.provider = 'faire'
        AND scope.value IN (
          'WRITE_PRODUCTS', 'WRITE_INVENTORIES', 'WRITE_ORDERS'
        )
      )
    ) THEN
      RAISE EXCEPTION
        'commerce provider-write control requires a granted write scope';
    END IF;

    IF account_row.provider = 'faire' AND NOT EXISTS (
      SELECT 1
      FROM public.operations_faire_provider_write_scope_evidence evidence
      WHERE evidence.organization_id = account_row.organization_id
        AND evidence.integration_account_id = account_row.id
        AND evidence.credential_generation =
              account_row.commerce_credential_generation
        AND public.operations_faire_provider_write_scope_evidence_is_current(
          account_row.organization_id,
          evidence.id,
          account_row.id,
          account_row.commerce_credential_generation
        )
    ) THEN
      RAISE EXCEPTION
        'commerce provider-write control requires current Faire OAuth scope evidence';
    END IF;

    current_scope_digest :=
      public.operations_commerce_granted_scope_digest(current_scopes);
    IF NEW.bound_credential_generation
         IS DISTINCT FROM account_row.commerce_credential_generation
       OR NEW.bound_granted_scopes IS DISTINCT FROM current_scopes
       OR NEW.bound_granted_scope_digest IS DISTINCT FROM current_scope_digest
    THEN
      RAISE EXCEPTION
        'commerce provider-write control credential or scope binding is stale';
    END IF;
  END IF;

  NEW.created_at := pg_catalog.clock_timestamp();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS operations_commerce_provider_write_controls_validate
  ON public.operations_commerce_provider_write_controls;
CREATE TRIGGER operations_commerce_provider_write_controls_validate
BEFORE INSERT ON public.operations_commerce_provider_write_controls
FOR EACH ROW EXECUTE FUNCTION
  public.validate_operations_commerce_provider_write_control();

CREATE OR REPLACE FUNCTION
  public.reject_operations_commerce_provider_write_control_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'commerce provider-write control revisions are immutable';
END;
$$;

DROP TRIGGER IF EXISTS operations_commerce_provider_write_controls_immutable
  ON public.operations_commerce_provider_write_controls;
CREATE TRIGGER operations_commerce_provider_write_controls_immutable
BEFORE UPDATE OR DELETE
ON public.operations_commerce_provider_write_controls
FOR EACH ROW EXECUTE FUNCTION
  public.reject_operations_commerce_provider_write_control_mutation();

CREATE OR REPLACE VIEW public.operations_commerce_provider_write_control_current
AS
SELECT
  account.organization_id,
  account.id AS integration_account_id,
  account.global_id AS account_global_id,
  account.provider,
  account.environment,
  account.display_name,
  account.status AS account_status,
  account.commerce_credential_generation AS current_credential_generation,
  account.configuration AS current_configuration,
  COALESCE(control.row_version, 0::bigint) AS row_version,
  COALESCE(control.requested_mode, 'off'::text) AS requested_mode,
  control.bound_credential_generation,
  control.bound_granted_scopes,
  control.bound_granted_scope_digest,
  control.changed_by,
  control.changed_role,
  control.idempotency_key,
  control.request_hash,
  control.created_at,
  control.id IS NULL AS effective_from_default
FROM public.operations_integration_accounts account
LEFT JOIN LATERAL (
  SELECT candidate.*
  FROM public.operations_commerce_provider_write_controls candidate
  WHERE candidate.organization_id = account.organization_id
    AND candidate.integration_account_id = account.id
  ORDER BY candidate.row_version DESC
  LIMIT 1
) control ON true
WHERE account.integration_type = 'commerce'
  AND account.provider IN ('shopify', 'faire');

COMMENT ON TABLE public.operations_commerce_provider_write_controls IS
  'Append-only per-account Provider writes Off/On decisions. On is bound to an exact current credential generation and canonical granted-scope digest; it does not mutate organization activation or cohort state.';

COMMENT ON VIEW public.operations_commerce_provider_write_control_current IS
  'Current per-account provider-write decision. Accounts without revisions project as Off at row version zero.';

-- Connect the Shopify order-management command ledger to the per-account
-- control. Historical rows retain their legacy activation evidence, but every
-- new authorization and attempt is bound to one exact Provider writes
-- revision and scope digest. The old organization-wide activation values are
-- no longer dispatch authority for the new runtime. During rolling deploys,
-- the exact pre-0308 writer shape (legacy activation binding, owner/admin
-- permissions, and no new binding columns) remains accepted so the old
-- 9d67c8d runtime is not broken after predeploy. New application commands do
-- not emit that shape; remove this compatibility branch in a later contraction
-- only after every runtime is known to be post-0308.
ALTER TABLE public.operations_shopify_order_management_authorizations
  ALTER COLUMN activation_state DROP NOT NULL,
  ALTER COLUMN activation_revision DROP NOT NULL;
ALTER TABLE public.operations_shopify_order_management_authorizations
  DROP CONSTRAINT IF EXISTS
    operations_shopify_order_management_authorizations_activation_state_check;
ALTER TABLE public.operations_shopify_order_management_authorizations
  DROP CONSTRAINT IF EXISTS
    operations_shopify_order_management_authorizations_activation_revision_check;
ALTER TABLE public.operations_shopify_order_management_authorizations
  DROP CONSTRAINT IF EXISTS
    operations_shopify_order_management_authorizations_authorized_role_check;
ALTER TABLE public.operations_shopify_order_management_authorizations
  ADD CONSTRAINT ops_shopify_order_mgmt_auth_legacy_activation_valid CHECK (
    (activation_state IS NULL AND activation_revision IS NULL)
    OR (
      activation_state IN ('shadow', 'active')
      AND activation_revision > 0
    )
  ),
  ADD CONSTRAINT ops_shopify_order_mgmt_auth_manage_role_valid CHECK (
    authorized_role IN ('owner', 'admin', 'member')
  ),
  ADD COLUMN IF NOT EXISTS provider_write_control_row_version bigint,
  ADD COLUMN IF NOT EXISTS provider_write_scope_digest text;
ALTER TABLE public.operations_shopify_order_management_authorizations
  ADD CONSTRAINT ops_shopify_order_mgmt_auth_provider_write_binding_valid
  CHECK (
    (
      provider_write_control_row_version IS NULL
      AND provider_write_scope_digest IS NULL
    )
    OR (
      provider_write_control_row_version > 0
      AND provider_write_scope_digest ~ '^[a-f0-9]{64}$'
    )
  ),
  ADD CONSTRAINT ops_shopify_order_mgmt_auth_provider_write_control_fkey
  FOREIGN KEY (
    organization_id, integration_account_id,
    provider_write_control_row_version
  ) REFERENCES public.operations_commerce_provider_write_controls (
    organization_id, integration_account_id, row_version
  ) ON DELETE RESTRICT;

ALTER TABLE public.operations_shopify_order_management_attempts
  ALTER COLUMN activation_revision DROP NOT NULL;
ALTER TABLE public.operations_shopify_order_management_attempts
  DROP CONSTRAINT IF EXISTS
    operations_shopify_order_management_attempts_activation_revision_check;
ALTER TABLE public.operations_shopify_order_management_attempts
  ADD COLUMN IF NOT EXISTS provider_write_control_row_version bigint,
  ADD COLUMN IF NOT EXISTS provider_write_scope_digest text,
  ADD CONSTRAINT ops_shopify_order_mgmt_attempt_legacy_activation_valid CHECK (
    activation_revision IS NULL OR activation_revision > 0
  ),
  ADD CONSTRAINT ops_shopify_order_mgmt_attempt_provider_write_binding_valid
  CHECK (
    (
      provider_write_control_row_version IS NULL
      AND provider_write_scope_digest IS NULL
    )
    OR (
      provider_write_control_row_version > 0
      AND provider_write_scope_digest ~ '^[a-f0-9]{64}$'
    )
  ),
  ADD CONSTRAINT ops_shopify_order_mgmt_attempt_provider_write_control_fkey
  FOREIGN KEY (
    organization_id, integration_account_id,
    provider_write_control_row_version
  ) REFERENCES public.operations_commerce_provider_write_controls (
    organization_id, integration_account_id, row_version
  ) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION
  public.operations_shopify_order_management_is_current(
    p_organization_id uuid,
    p_authorization_id uuid,
    p_require_claim_fence boolean DEFAULT true
  )
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.operations_shopify_order_management_authorizations authz
    JOIN public.operations_integration_accounts account
      ON account.organization_id = authz.organization_id
     AND account.id = authz.integration_account_id
    JOIN public.operations_commerce_credentials credential
      ON credential.organization_id = account.organization_id
     AND credential.integration_account_id = account.id
    JOIN public.operations_commerce_provider_write_control_current control
      ON control.organization_id = account.organization_id
     AND control.integration_account_id = account.id
    LEFT JOIN public.operations_activation_scopes activation
      ON activation.organization_id = authz.organization_id
    JOIN public.operations_orders order_row
      ON order_row.organization_id = authz.organization_id
     AND order_row.id = authz.order_id
    JOIN public.operations_commerce_order_revision_targets target
      ON target.organization_id = order_row.organization_id
     AND target.order_id = order_row.id
    LEFT JOIN public.operations_commerce_order_revision_observations accepted
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
      AND credential.last_error_code IS NULL
      AND (
        (
          authz.activation_state IS NULL
          AND authz.activation_revision IS NULL
          AND authz.provider_write_control_row_version IS NOT NULL
          AND authz.provider_write_scope_digest IS NOT NULL
          AND control.requested_mode = 'on'
          AND control.row_version = authz.provider_write_control_row_version
          AND control.bound_credential_generation = authz.credential_generation
          AND control.bound_granted_scope_digest =
                authz.provider_write_scope_digest
          AND control.bound_granted_scopes =
                public.operations_commerce_granted_scope_snapshot(
                  account.configuration
                )
          AND 'write_orders' = ANY(control.bound_granted_scopes)
          AND control.bound_granted_scope_digest =
                public.operations_commerce_granted_scope_digest(
                  public.operations_commerce_granted_scope_snapshot(
                    account.configuration
                  )
                )
        )
        OR (
          authz.provider_write_control_row_version IS NULL
          AND authz.provider_write_scope_digest IS NULL
          AND authz.activation_state IN ('shadow', 'active')
          AND authz.activation_revision > 0
          AND activation.state = authz.activation_state
          AND activation.revision = authz.activation_revision
        )
      )
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
          AND target.accepted_observation_id = authz.accepted_observation_id
          AND accepted.id = authz.accepted_observation_id
          AND public.operations_shopify_order_management_snapshot_updated_at(
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
        OR public.ocr_order_has_zero_downstream(
          authz.organization_id,
          authz.order_id
        )
      )
  )
$$;

CREATE OR REPLACE FUNCTION
  public.protect_shopify_order_management_authorization()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
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
         FROM public.operations_integration_accounts account
         JOIN public.operations_commerce_credentials credential
           ON credential.organization_id = account.organization_id
          AND credential.integration_account_id = account.id
         JOIN public.operations_commerce_provider_write_control_current control
           ON control.organization_id = account.organization_id
          AND control.integration_account_id = account.id
         LEFT JOIN public.operations_activation_scopes activation
           ON activation.organization_id = NEW.organization_id
         JOIN public.operations_orders order_row
           ON order_row.organization_id = NEW.organization_id
          AND order_row.id = NEW.order_id
         JOIN public.operations_commerce_order_revision_targets target
           ON target.organization_id = order_row.organization_id
          AND target.order_id = order_row.id
         LEFT JOIN public.operations_commerce_order_revision_observations accepted
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
           AND credential.last_error_code IS NULL
           AND (
             (
               NEW.activation_state IS NULL
               AND NEW.activation_revision IS NULL
               AND NEW.provider_write_control_row_version IS NOT NULL
               AND NEW.provider_write_scope_digest IS NOT NULL
               AND control.requested_mode = 'on'
               AND control.row_version =
                     NEW.provider_write_control_row_version
               AND control.bound_credential_generation =
                     NEW.credential_generation
               AND control.bound_granted_scope_digest =
                     NEW.provider_write_scope_digest
               AND control.bound_granted_scopes =
                     public.operations_commerce_granted_scope_snapshot(
                       account.configuration
                     )
               AND 'write_orders' = ANY(control.bound_granted_scopes)
               AND control.bound_granted_scope_digest =
                     public.operations_commerce_granted_scope_digest(
                       public.operations_commerce_granted_scope_snapshot(
                         account.configuration
                       )
                     )
             )
             OR (
               NEW.provider_write_control_row_version IS NULL
               AND NEW.provider_write_scope_digest IS NULL
               AND NEW.authorized_role IN ('owner', 'admin')
               AND NEW.activation_state IN ('shadow', 'active')
               AND NEW.activation_revision > 0
               AND activation.state = NEW.activation_state
               AND activation.revision = NEW.activation_revision
             )
           )
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
               AND public.operations_shopify_order_management_snapshot_updated_at(
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
           AND public.ocr_order_has_zero_downstream(
             NEW.organization_id,
             NEW.order_id
           )
       )
       OR NOT EXISTS (
         SELECT 1
         FROM public.app_user_organization_memberships membership
         WHERE membership.organization_id = NEW.organization_id
           AND membership.user_email = NEW.authorized_by
           AND membership.status = 'active'
           AND membership.role = NEW.authorized_role
           AND (
             (
               NEW.provider_write_control_row_version IS NOT NULL
               AND NEW.provider_write_scope_digest IS NOT NULL
               AND (
                 membership.role = 'owner'
                 OR COALESCE(
                   (membership.permissions->>'manageOperations')::boolean,
                   false
                 )
               )
             )
             OR (
               NEW.provider_write_control_row_version IS NULL
               AND NEW.provider_write_scope_digest IS NULL
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
           )
       )
       OR EXISTS (
         SELECT 1
         FROM public.operations_shopify_order_management_authorizations unresolved
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
    pg_catalog.to_jsonb(NEW) - ARRAY[
      'status', 'provider_attempt_id', 'latest_outcome_id',
      'processing_at', 'completed_at', 'updated_at'
    ]::text[]
  ) IS DISTINCT FROM (
    pg_catalog.to_jsonb(OLD) - ARRAY[
      'status', 'provider_attempt_id', 'latest_outcome_id',
      'processing_at', 'completed_at', 'updated_at'
    ]::text[]
  ) OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'Shopify order management authorization identity is immutable';
  END IF;

  IF OLD.status = 'prepared' AND NEW.status = 'processing' THEN
    IF OLD.expires_at <= pg_catalog.clock_timestamp()
       OR NEW.provider_attempt_id IS NULL
       OR NEW.latest_outcome_id IS NOT NULL
       OR NEW.processing_at IS NULL
       OR NEW.completed_at IS NOT NULL
       OR NOT public.operations_shopify_order_management_is_current(
         NEW.organization_id,
         NEW.id,
         true
       )
       OR NOT EXISTS (
         SELECT 1
         FROM public.operations_shopify_order_management_attempts attempt
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
    IF OLD.expires_at > pg_catalog.clock_timestamp()
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
    FROM public.operations_shopify_order_management_outcomes outcome
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
    FROM public.operations_shopify_order_management_outcomes outcome
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

CREATE OR REPLACE FUNCTION
  public.protect_shopify_order_management_attempt()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Shopify order management attempts are immutable';
  END IF;

  IF NOT EXISTS (
       SELECT 1
       FROM public.operations_shopify_order_management_authorizations authz
       WHERE authz.organization_id = NEW.organization_id
         AND authz.id = NEW.authorization_id
         AND authz.status = 'prepared'
         AND authz.expires_at > pg_catalog.clock_timestamp()
         AND authz.integration_account_id = NEW.integration_account_id
         AND authz.integration_account_global_id =
               NEW.integration_account_global_id
         AND authz.provider = NEW.provider
         AND authz.external_account_id = NEW.external_account_id
         AND authz.credential_generation = NEW.credential_generation
         AND (
           (
             NEW.activation_revision IS NULL
             AND NEW.provider_write_control_row_version IS NOT NULL
             AND NEW.provider_write_scope_digest IS NOT NULL
             AND authz.activation_state IS NULL
             AND authz.activation_revision IS NULL
             AND authz.provider_write_control_row_version =
                   NEW.provider_write_control_row_version
             AND authz.provider_write_scope_digest =
                   NEW.provider_write_scope_digest
             AND EXISTS (
               SELECT 1
               FROM public.operations_commerce_provider_write_control_current
                 control
               WHERE control.organization_id = authz.organization_id
                 AND control.integration_account_id =
                       authz.integration_account_id
                 AND control.requested_mode = 'on'
                 AND control.row_version =
                       NEW.provider_write_control_row_version
                 AND control.bound_credential_generation =
                       NEW.credential_generation
                 AND control.bound_granted_scope_digest =
                       NEW.provider_write_scope_digest
                 AND 'write_orders' = ANY(control.bound_granted_scopes)
             )
           )
           OR (
             NEW.provider_write_control_row_version IS NULL
             AND NEW.provider_write_scope_digest IS NULL
             AND NEW.activation_revision > 0
             AND authz.provider_write_control_row_version IS NULL
             AND authz.provider_write_scope_digest IS NULL
             AND authz.activation_state IN ('shadow', 'active')
             AND authz.activation_revision = NEW.activation_revision
           )
         )
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
         AND public.operations_shopify_order_management_is_current(
           authz.organization_id,
           authz.id,
           true
         )
         AND NOT EXISTS (
           SELECT 1
           FROM public.operations_shopify_order_management_authorizations unresolved
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

COMMENT ON FUNCTION
  public.operations_shopify_order_management_is_current(uuid, uuid, boolean)
IS
  'Exact tenant, Shopify account, current credential, per-account Provider writes revision and scope digest, imported-order/source, and optional zero-downstream claim fence. Organization activation is not provider-write authority.';
