-- ShipStation-like ordinary Shopify order Save.
--
-- This additive phase extends the frozen 0283/0308 authorization ledger with
-- one combined, hash-bound save_order intent. PII and note/tag values remain
-- outside durable authorization, attempt, outcome, and audit rows. Only the
-- SHA-256 hash of the exact desired provider projection is retained.
--
-- Cancellation remains a separate action. A save_order never fulfills,
-- cancels, restocks, refunds, or notifies a customer.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public.operations_shopify_order_management_authorizations
  ADD COLUMN requested_projection_hash text,
  ADD COLUMN requires_order_edits boolean NOT NULL DEFAULT false;

ALTER TABLE public.operations_shopify_order_management_authorizations
  ADD CONSTRAINT ops_shopify_order_mgmt_auth_projection_hash_valid CHECK (
    requested_projection_hash IS NULL
    OR requested_projection_hash ~ '^[a-f0-9]{64}$'
  );

ALTER TABLE public.operations_shopify_order_management_authorizations
  DROP CONSTRAINT operations_shopify_order_management_authorizations_action_check,
  DROP CONSTRAINT ops_shopify_order_mgmt_auth_action_valid;

ALTER TABLE public.operations_shopify_order_management_authorizations
  ADD CONSTRAINT operations_shopify_order_management_authorizations_action_check
    CHECK (
      action IN ('add_tag', 'cancel', 'set_line_quantity', 'save_order')
    ),
  ADD CONSTRAINT ops_shopify_order_mgmt_auth_action_valid CHECK (
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
      AND requested_projection_hash IS NULL
      AND NOT requires_order_edits
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
      AND requested_projection_hash IS NULL
      AND NOT requires_order_edits
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
      AND requested_projection_hash IS NULL
      AND NOT requires_order_edits
    )
    OR (
      action = 'save_order'
      AND (provider_order_test OR NOT requires_order_edits)
      AND accepted_observation_id IS NOT NULL
      AND accepted_provider_order_updated_at = provider_order_updated_at
      AND tag_hash IS NULL
      AND line_item_id IS NULL
      AND expected_line_quantity IS NULL
      AND requested_quantity IS NULL
      AND cancel_reason IS NULL
      AND staff_note_hash IS NULL
      AND requested_projection_hash ~ '^[a-f0-9]{64}$'
    )
  );

ALTER TABLE public.operations_shopify_order_management_attempts
  ADD COLUMN requested_projection_hash text,
  ADD COLUMN requires_order_edits boolean NOT NULL DEFAULT false;

ALTER TABLE public.operations_shopify_order_management_attempts
  ADD CONSTRAINT ops_shopify_order_mgmt_attempt_projection_hash_valid CHECK (
    requested_projection_hash IS NULL
    OR requested_projection_hash ~ '^[a-f0-9]{64}$'
  );

ALTER TABLE public.operations_shopify_order_management_attempts
  DROP CONSTRAINT operations_shopify_order_management_attempts_action_check,
  DROP CONSTRAINT ops_shopify_order_mgmt_attempt_identity_valid;

ALTER TABLE public.operations_shopify_order_management_attempts
  ADD CONSTRAINT operations_shopify_order_management_attempts_action_check
    CHECK (
      action IN ('add_tag', 'cancel', 'set_line_quantity', 'save_order')
    ),
  ADD CONSTRAINT ops_shopify_order_mgmt_attempt_identity_valid CHECK (
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
        action IN ('cancel', 'set_line_quantity', 'save_order')
        AND accepted_observation_id IS NOT NULL
        AND accepted_provider_order_updated_at IS NOT NULL
      )
    )
    AND (
      (
        action = 'set_line_quantity'
        AND expected_line_quantity BETWEEN 1 AND 2147483647
      )
      OR (
        action <> 'set_line_quantity'
        AND expected_line_quantity IS NULL
      )
    )
    AND (
      (
        action = 'save_order'
        AND requested_projection_hash ~ '^[a-f0-9]{64}$'
      )
      OR (
        action <> 'save_order'
        AND requested_projection_hash IS NULL
        AND NOT requires_order_edits
      )
    )
  );

DO $$
DECLARE
  write_count_constraint text;
BEGIN
  SELECT constraint_row.conname
    INTO STRICT write_count_constraint
  FROM pg_catalog.pg_constraint constraint_row
  WHERE constraint_row.conrelid = pg_catalog.to_regclass(
          'public.operations_shopify_order_management_outcomes'
        )
    AND constraint_row.contype = 'c'
    AND pg_catalog.pg_get_constraintdef(constraint_row.oid, false)
          LIKE 'CHECK (((provider_write_count >= 0)%provider_write_count <= 3)%';
  EXECUTE pg_catalog.format(
    'ALTER TABLE public.operations_shopify_order_management_outcomes DROP CONSTRAINT %I',
    write_count_constraint
  );
END;
$$;

ALTER TABLE public.operations_shopify_order_management_outcomes
  DROP CONSTRAINT ops_shopify_order_mgmt_outcome_state_valid;

ALTER TABLE public.operations_shopify_order_management_outcomes
  ADD CONSTRAINT ops_shopify_order_mgmt_outcome_write_count_valid
    CHECK (provider_write_count BETWEEN 0 AND 253),
  ADD CONSTRAINT ops_shopify_order_mgmt_outcome_state_valid CHECK (
    (
      outcome_state = 'succeeded'
      AND reconciliation_resolution IS NULL
      AND provider_write_count BETWEEN 0 AND 253
      AND error_code IS NULL
    )
    OR (
      outcome_state = 'failed'
      AND reconciliation_resolution IS NULL
      AND provider_write_count BETWEEN 0 AND 253
      AND error_code IS NOT NULL
    )
    OR (
      outcome_state = 'unknown'
      AND reconciliation_resolution IS NULL
      AND (
        provider_write_count IS NULL
        OR provider_write_count BETWEEN 0 AND 253
      )
      AND error_code IS NOT NULL
    )
    OR (
      outcome_state = 'reconciled'
      AND reconciliation_resolution IS NOT NULL
      AND (
        provider_write_count IS NULL
        OR provider_write_count BETWEEN 0 AND 253
      )
      AND error_code IS NULL
    )
  );

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
          AND (
            NOT authz.requires_order_edits
            OR 'write_order_edits' = ANY(control.bound_granted_scopes)
          )
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
          authz.action IN ('cancel', 'set_line_quantity', 'save_order')
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
               AND (
                 NOT NEW.requires_order_edits
                 OR 'write_order_edits' = ANY(control.bound_granted_scopes)
               )
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
               NEW.action IN ('cancel', 'set_line_quantity', 'save_order')
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
                 AND (
                   NOT authz.requires_order_edits
                   OR 'write_order_edits' = ANY(control.bound_granted_scopes)
                 )
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
         AND authz.requested_projection_hash IS NOT DISTINCT FROM
               NEW.requested_projection_hash
         AND authz.requires_order_edits = NEW.requires_order_edits
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

COMMENT ON COLUMN
  public.operations_shopify_order_management_authorizations.requested_projection_hash
IS
  'SHA-256 of the exact desired email, phone, PO, note, complete tag set, and complete line-quantity projection. No plaintext order field is retained.';

COMMENT ON COLUMN
  public.operations_shopify_order_management_attempts.requested_projection_hash
IS
  'Immutable copy of the save_order desired-projection hash used for read-only unknown-outcome reconciliation.';

COMMENT ON FUNCTION
  public.operations_shopify_order_management_is_current(uuid, uuid, boolean)
IS
  'Exact tenant, Shopify account, current credential, per-account Provider writes revision/scopes, imported-order/source, and optional zero-downstream claim fence. save_order additionally binds write_order_edits when quantities change.';
