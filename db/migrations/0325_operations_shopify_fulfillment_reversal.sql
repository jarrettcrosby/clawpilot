-- Exact, separately-authorized reversal of an eligible Shopify fulfillment.
--
-- This migration does not weaken the ordinary order-management fence. A
-- fulfillment reversal may cross terminal warehouse history only when an
-- immutable external-fulfillment reconciliation matches the exact Shopify
-- fulfillment and there is no ClawPilot shipment, carrier label, export,
-- execution, billing, or other live warehouse work.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public.operations_shopify_order_management_authorizations
  ADD COLUMN fulfillment_gid text,
  ADD COLUMN expected_fulfillment_updated_at timestamptz,
  ADD COLUMN predecessor_authorization_id uuid;

ALTER TABLE public.operations_shopify_order_management_attempts
  ADD COLUMN fulfillment_gid text,
  ADD COLUMN expected_fulfillment_updated_at timestamptz,
  ADD COLUMN predecessor_authorization_id uuid;

ALTER TABLE public.operations_shopify_order_management_authorizations
  ADD CONSTRAINT ops_shopify_order_mgmt_auth_predecessor_fkey
    FOREIGN KEY (organization_id, predecessor_authorization_id)
    REFERENCES public.operations_shopify_order_management_authorizations(
      organization_id, id
    ) ON DELETE RESTRICT;

ALTER TABLE public.operations_shopify_order_management_attempts
  ADD CONSTRAINT ops_shopify_order_mgmt_attempt_predecessor_fkey
    FOREIGN KEY (organization_id, predecessor_authorization_id)
    REFERENCES public.operations_shopify_order_management_authorizations(
      organization_id, id
    ) ON DELETE RESTRICT;

ALTER TABLE public.operations_shopify_order_management_authorizations
  DROP CONSTRAINT operations_shopify_order_management_authorizations_action_check,
  DROP CONSTRAINT ops_shopify_order_mgmt_auth_action_valid;

ALTER TABLE public.operations_shopify_order_management_authorizations
  ADD CONSTRAINT operations_shopify_order_management_authorizations_action_check
    CHECK (
      action IN (
        'add_tag', 'cancel_fulfillment', 'cancel',
        'cancel_order_after_fulfillment_reversal',
        'set_line_quantity', 'save_order'
      )
    ),
  ADD CONSTRAINT ops_shopify_order_mgmt_auth_action_valid CHECK (
    (
      action = 'add_tag'
      AND tag_hash IS NOT NULL
      AND accepted_observation_id IS NULL
      AND accepted_provider_order_updated_at IS NULL
      AND fulfillment_gid IS NULL
      AND expected_fulfillment_updated_at IS NULL
      AND predecessor_authorization_id IS NULL
      AND line_item_id IS NULL
      AND expected_line_quantity IS NULL
      AND requested_quantity IS NULL
      AND cancel_reason IS NULL
      AND staff_note_hash IS NULL
      AND requested_projection_hash IS NULL
      AND NOT requires_order_edits
    )
    OR (
      action = 'cancel_fulfillment'
      AND provider_order_test
      AND accepted_observation_id IS NULL
      AND accepted_provider_order_updated_at IS NULL
      AND fulfillment_gid ~
            '^gid://shopify/Fulfillment/[1-9][0-9]{0,20}$'
      AND expected_fulfillment_updated_at IS NOT NULL
      AND expected_fulfillment_updated_at <= provider_order_observed_at
      AND predecessor_authorization_id IS NULL
      AND line_item_id IS NULL
      AND expected_line_quantity IS NULL
      AND requested_quantity IS NULL
      AND tag_hash IS NULL
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
      AND fulfillment_gid IS NULL
      AND expected_fulfillment_updated_at IS NULL
      AND predecessor_authorization_id IS NULL
      AND tag_hash IS NULL
      AND line_item_id IS NULL
      AND expected_line_quantity IS NULL
      AND requested_quantity IS NULL
      AND cancel_reason IS NOT NULL
      AND requested_projection_hash IS NULL
      AND NOT requires_order_edits
    )
    OR (
      action = 'cancel_order_after_fulfillment_reversal'
      AND provider_order_test
      AND accepted_observation_id IS NULL
      AND accepted_provider_order_updated_at IS NULL
      AND fulfillment_gid IS NULL
      AND expected_fulfillment_updated_at IS NULL
      AND predecessor_authorization_id IS NOT NULL
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
      AND fulfillment_gid IS NULL
      AND expected_fulfillment_updated_at IS NULL
      AND predecessor_authorization_id IS NULL
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
      AND fulfillment_gid IS NULL
      AND expected_fulfillment_updated_at IS NULL
      AND predecessor_authorization_id IS NULL
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
  DROP CONSTRAINT operations_shopify_order_management_attempts_action_check,
  DROP CONSTRAINT ops_shopify_order_mgmt_attempt_identity_valid;

ALTER TABLE public.operations_shopify_order_management_attempts
  ADD CONSTRAINT operations_shopify_order_management_attempts_action_check
    CHECK (
      action IN (
        'add_tag', 'cancel_fulfillment', 'cancel',
        'cancel_order_after_fulfillment_reversal',
        'set_line_quantity', 'save_order'
      )
    ),
  ADD CONSTRAINT ops_shopify_order_mgmt_attempt_identity_valid CHECK (
    integration_account_global_id ~ '^gia(?:[0-9]{7}|[0-9a-v]{12})$'
    AND order_global_id ~ '^gor(?:[0-9]{7}|[0-9a-v]{12})$'
    AND external_account_id ~ '^gid://shopify/Shop/[1-9][0-9]{0,20}$'
    AND external_order_id ~ '^gid://shopify/Order/[1-9][0-9]{0,20}$'
    AND (
      (
        action IN (
          'add_tag', 'cancel_fulfillment',
          'cancel_order_after_fulfillment_reversal'
        )
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
        action = 'cancel_fulfillment'
        AND fulfillment_gid ~
              '^gid://shopify/Fulfillment/[1-9][0-9]{0,20}$'
        AND expected_fulfillment_updated_at IS NOT NULL
      )
      OR (
        action <> 'cancel_fulfillment'
        AND fulfillment_gid IS NULL
        AND expected_fulfillment_updated_at IS NULL
      )
    )
    AND (
      (
        action = 'cancel_order_after_fulfillment_reversal'
        AND predecessor_authorization_id IS NOT NULL
      )
      OR (
        action <> 'cancel_order_after_fulfillment_reversal'
        AND predecessor_authorization_id IS NULL
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

CREATE OR REPLACE FUNCTION
  public.operations_shopify_fulfillment_reversal_is_safe(
    p_organization_id uuid,
    p_order_id uuid,
    p_fulfillment_gid text,
    p_fulfillment_updated_at timestamptz
  )
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.operations_shopify_external_fulfillment_reconciliations recon
    JOIN public.operations_orders exact_order
      ON exact_order.organization_id = recon.organization_id
     AND exact_order.id = recon.order_id
     AND exact_order.integration_account_id = recon.integration_account_id
     AND exact_order.external_order_id = recon.external_order_id
    JOIN public.operations_fulfillment_plans exact_plan
      ON exact_plan.organization_id = recon.organization_id
     AND exact_plan.id = recon.plan_id
     AND exact_plan.order_id = recon.order_id
     AND exact_plan.status = 'cancelled'
    JOIN public.operations_waves exact_wave
      ON exact_wave.organization_id = recon.organization_id
     AND exact_wave.id = recon.wave_id
     AND exact_wave.status = 'cancelled'
    WHERE recon.organization_id = p_organization_id
      AND recon.order_id = p_order_id
      AND recon.provider_fulfillment_id = p_fulfillment_gid
      AND recon.provider_fulfillment_updated_at =
            p_fulfillment_updated_at
      AND recon.evidence_snapshot #>> '{version}' =
            'shopify-external-fulfillment-reconciliation-v2'
      AND recon.evidence_snapshot #>> '{order,id}' =
            recon.external_order_id
      AND recon.evidence_snapshot #>> '{fulfillment,id}' =
            recon.provider_fulfillment_id
      AND (
        recon.evidence_snapshot #>> '{fulfillment,updatedAt}'
      )::timestamptz = recon.provider_fulfillment_updated_at
      AND recon.evidence_snapshot #>> '{fulfillment,status}' = 'SUCCESS'
      AND recon.evidence_snapshot #>> '{fulfillment,displayStatus}' =
            'FULFILLED'
      AND NOT EXISTS (
        SELECT 1
        FROM public.operations_fulfillment_plans plan
        WHERE plan.organization_id = recon.organization_id
          AND plan.order_id = recon.order_id
          AND plan.status <> 'cancelled'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.operations_pick_tasks pick
        JOIN public.operations_fulfillment_plans plan
          ON plan.organization_id = pick.organization_id
         AND plan.id = pick.plan_id
        WHERE plan.organization_id = recon.organization_id
          AND plan.order_id = recon.order_id
          AND (
            pick.status <> 'cancelled'
            OR COALESCE(pick.picked_quantity, 0) <> 0
            OR pick.picked_at IS NOT NULL
          )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.operations_reservations reservation
        WHERE reservation.organization_id = recon.organization_id
          AND reservation.order_id = recon.order_id
          AND reservation.status <> 'released'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.operations_packaging_material_claims claim
        JOIN public.operations_fulfillment_plans plan
          ON plan.organization_id = claim.organization_id
         AND plan.id = claim.plan_id
        WHERE plan.organization_id = recon.organization_id
          AND plan.order_id = recon.order_id
          AND claim.status <> 'released'
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.operations_packages package
        JOIN public.operations_fulfillment_plans plan
          ON plan.organization_id = package.organization_id
         AND plan.id = package.plan_id
        WHERE plan.organization_id = recon.organization_id
          AND plan.order_id = recon.order_id
          AND (
            package.status <> 'planned'
            OR package.packed_by IS NOT NULL
            OR package.packed_at IS NOT NULL
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.operations_labels label
        JOIN public.operations_packages package
          ON package.organization_id = label.organization_id
         AND package.id = label.package_id
        JOIN public.operations_fulfillment_plans plan
          ON plan.organization_id = package.organization_id
         AND plan.id = package.plan_id
        WHERE plan.organization_id = recon.organization_id
          AND plan.order_id = recon.order_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.operations_shipments row
        WHERE row.organization_id = recon.organization_id
          AND row.order_id = recon.order_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.operations_commerce_fulfillment_exports row
        WHERE row.organization_id = recon.organization_id
          AND row.order_id = recon.order_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.operations_fulfillment_executions row
        WHERE row.organization_id = recon.organization_id
          AND row.order_id = recon.order_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.operations_active_fulfillment_executions row
        WHERE row.organization_id = recon.organization_id
          AND row.order_id = recon.order_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.operations_label_attempts row
        WHERE row.organization_id = recon.organization_id
          AND row.order_id = recon.order_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.operations_shipment_groups row
        WHERE row.organization_id = recon.organization_id
          AND row.order_id = recon.order_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.operations_billable_events row
        WHERE row.organization_id = recon.organization_id
          AND row.order_id = recon.order_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.operations_sandbox_commerce_e2e_authorizations row
        WHERE row.organization_id = recon.organization_id
          AND row.order_id = recon.order_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.operations_production_fulfillment_rerate_runs row
        WHERE row.organization_id = recon.organization_id
          AND row.order_id = recon.order_id
      )
  )
$$;

CREATE OR REPLACE FUNCTION
  public.operations_shopify_post_reversal_order_cancellation_is_safe(
    p_organization_id uuid,
    p_order_id uuid,
    p_predecessor_authorization_id uuid
  )
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.operations_shopify_external_fulfillment_reconciliations recon
    JOIN public.operations_shopify_order_management_authorizations reversal
      ON reversal.organization_id = recon.organization_id
     AND reversal.order_id = recon.order_id
     AND reversal.integration_account_id = recon.integration_account_id
     AND reversal.external_order_id = recon.external_order_id
     AND reversal.action = 'cancel_fulfillment'
     AND reversal.fulfillment_gid = recon.provider_fulfillment_id
     AND reversal.expected_fulfillment_updated_at =
           recon.provider_fulfillment_updated_at
     AND reversal.provider_order_test
     AND reversal.prepared_at >= recon.reconciled_at
    JOIN public.operations_shopify_order_management_attempts attempt
      ON attempt.organization_id = reversal.organization_id
     AND attempt.id = reversal.provider_attempt_id
     AND attempt.authorization_id = reversal.id
     AND attempt.action = 'cancel_fulfillment'
     AND attempt.fulfillment_gid = reversal.fulfillment_gid
     AND attempt.expected_fulfillment_updated_at =
           reversal.expected_fulfillment_updated_at
     AND attempt.predecessor_authorization_id IS NULL
    JOIN public.operations_shopify_order_management_outcomes outcome
      ON outcome.organization_id = reversal.organization_id
     AND outcome.id = reversal.latest_outcome_id
     AND outcome.authorization_id = reversal.id
     AND outcome.provider_attempt_id = attempt.id
     AND outcome.recorded_at >= reversal.prepared_at
    WHERE recon.organization_id = p_organization_id
      AND recon.order_id = p_order_id
      AND reversal.id = p_predecessor_authorization_id
      AND public.operations_shopify_fulfillment_reversal_is_safe(
            recon.organization_id,
            recon.order_id,
            recon.provider_fulfillment_id,
            recon.provider_fulfillment_updated_at
          )
      AND (
        (
          reversal.status = 'succeeded'
          AND outcome.outcome_state = 'succeeded'
          AND outcome.reconciliation_resolution IS NULL
          AND outcome.provider_write_count = 1
          AND outcome.provider_reference = recon.provider_fulfillment_id
        )
        OR (
          reversal.status = 'reconciled'
          AND outcome.outcome_state = 'reconciled'
          AND outcome.reconciliation_resolution = 'applied'
          AND (
            outcome.provider_write_count IS NULL
            OR outcome.provider_write_count = 1
          )
        )
      )
  )
$$;

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
      AND account.commerce_credential_generation = authz.credential_generation
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
            authz.action <> 'cancel_fulfillment'
            OR 'write_merchant_managed_fulfillment_orders' =
                 ANY(control.bound_granted_scopes)
          )
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
          authz.action NOT IN (
            'cancel_fulfillment',
            'cancel_order_after_fulfillment_reversal'
          )
          AND authz.provider_write_control_row_version IS NULL
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
      AND (
        (authz.action = 'cancel_fulfillment'
          AND order_row.status = 'cancelled')
        OR (
          authz.action = 'cancel_order_after_fulfillment_reversal'
          AND order_row.status = 'cancelled'
          AND public.operations_shopify_post_reversal_order_cancellation_is_safe(
                authz.organization_id,
                authz.order_id,
                authz.predecessor_authorization_id
              )
        )
        OR (
          authz.action NOT IN (
            'cancel_fulfillment',
            'cancel_order_after_fulfillment_reversal'
          )
          AND order_row.status = 'imported')
      )
      AND order_row.archived_at IS NULL
      AND order_row.source_payload->>'sourceHash' = authz.expected_source_hash
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
          authz.action = 'cancel_fulfillment'
          AND target.material_state = 'provider_fulfilled'
          AND authz.accepted_observation_id IS NULL
          AND authz.accepted_provider_order_updated_at IS NULL
          AND public.operations_shopify_fulfillment_reversal_is_safe(
                authz.organization_id,
                authz.order_id,
                authz.fulfillment_gid,
                authz.expected_fulfillment_updated_at
              )
        )
        OR (
          authz.action = 'cancel_order_after_fulfillment_reversal'
          AND authz.accepted_observation_id IS NULL
          AND authz.accepted_provider_order_updated_at IS NULL
          AND target.material_state IN ('provider_fulfilled', 'review_required')
          AND public.operations_shopify_post_reversal_order_cancellation_is_safe(
                authz.organization_id,
                authz.order_id,
                authz.predecessor_authorization_id
              )
        )
        OR (
          authz.action IN ('cancel', 'set_line_quantity', 'save_order')
          AND authz.accepted_observation_id IS NOT NULL
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
        OR (
          authz.action = 'cancel_fulfillment'
          AND public.operations_shopify_fulfillment_reversal_is_safe(
                authz.organization_id,
                authz.order_id,
                authz.fulfillment_gid,
                authz.expected_fulfillment_updated_at
              )
        )
        OR (
          authz.action = 'cancel_order_after_fulfillment_reversal'
          AND public.operations_shopify_post_reversal_order_cancellation_is_safe(
                authz.organization_id,
                authz.order_id,
                authz.predecessor_authorization_id
              )
        )
      )
  )
$$;

CREATE OR REPLACE FUNCTION
  public.protect_shopify_fulfillment_reversal_authorization_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.action <> 'cancel_fulfillment'
     OR NEW.status <> 'prepared'
     OR NOT NEW.provider_order_test
     OR NOT EXISTS (
       SELECT 1
       FROM public.operations_integration_accounts account
       JOIN public.operations_commerce_credentials credential
         ON credential.organization_id = account.organization_id
        AND credential.integration_account_id = account.id
       JOIN public.operations_commerce_provider_write_control_current control
         ON control.organization_id = account.organization_id
        AND control.integration_account_id = account.id
       JOIN public.operations_orders order_row
         ON order_row.organization_id = NEW.organization_id
        AND order_row.id = NEW.order_id
       JOIN public.operations_commerce_order_revision_targets target
         ON target.organization_id = order_row.organization_id
        AND target.order_id = order_row.id
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
         AND account.commerce_credential_generation = NEW.credential_generation
         AND credential.external_account_id = NEW.external_account_id
         AND credential.credential_version = NEW.credential_generation
         AND credential.auth_mode = 'shopify_client_credentials'
         AND credential.verification_status = 'verified'
         AND credential.last_error_code IS NULL
         AND NEW.activation_state IS NULL
         AND NEW.activation_revision IS NULL
         AND NEW.provider_write_control_row_version IS NOT NULL
         AND NEW.provider_write_scope_digest IS NOT NULL
         AND control.requested_mode = 'on'
         AND control.row_version = NEW.provider_write_control_row_version
         AND control.bound_credential_generation = NEW.credential_generation
         AND control.bound_granted_scope_digest =
               NEW.provider_write_scope_digest
         AND control.bound_granted_scopes =
               public.operations_commerce_granted_scope_snapshot(
                 account.configuration
               )
         AND 'write_orders' = ANY(control.bound_granted_scopes)
         AND 'write_merchant_managed_fulfillment_orders' =
               ANY(control.bound_granted_scopes)
         AND control.bound_granted_scope_digest =
               public.operations_commerce_granted_scope_digest(
                 public.operations_commerce_granted_scope_snapshot(
                   account.configuration
                 )
               )
         AND order_row.global_id = NEW.order_global_id
         AND order_row.integration_account_id = NEW.integration_account_id
         AND order_row.source_provider = 'shopify'
         AND order_row.external_order_id = NEW.external_order_id
         AND order_row.order_number = NEW.order_number
         AND order_row.row_version = NEW.expected_order_row_version
         AND order_row.status = 'cancelled'
         AND order_row.archived_at IS NULL
         AND order_row.source_payload->>'sourceHash' = NEW.expected_source_hash
         AND target.integration_account_id = NEW.integration_account_id
         AND target.provider = 'shopify'
         AND target.accepted_source_hash = NEW.expected_source_hash
         AND target.material_state = 'provider_fulfilled'
         AND public.operations_shopify_fulfillment_reversal_is_safe(
               NEW.organization_id,
               NEW.order_id,
               NEW.fulfillment_gid,
               NEW.expected_fulfillment_updated_at
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
           membership.role = 'owner'
           OR COALESCE(
             (membership.permissions->>'manageOperations')::boolean,
             false
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
      'Shopify fulfillment reversal authorization is not current or permitted';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION
  public.protect_shopify_post_reversal_order_cancel_authorization_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.action <> 'cancel_order_after_fulfillment_reversal'
     OR NEW.status <> 'prepared'
     OR NOT NEW.provider_order_test
     OR NEW.accepted_observation_id IS NOT NULL
     OR NEW.accepted_provider_order_updated_at IS NOT NULL
     OR NEW.predecessor_authorization_id IS NULL
     OR NOT EXISTS (
       SELECT 1
       FROM public.operations_integration_accounts account
       JOIN public.operations_commerce_credentials credential
         ON credential.organization_id = account.organization_id
        AND credential.integration_account_id = account.id
       JOIN public.operations_commerce_provider_write_control_current control
         ON control.organization_id = account.organization_id
        AND control.integration_account_id = account.id
       JOIN public.operations_orders order_row
         ON order_row.organization_id = NEW.organization_id
        AND order_row.id = NEW.order_id
       JOIN public.operations_commerce_order_revision_targets target
         ON target.organization_id = order_row.organization_id
        AND target.order_id = order_row.id
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
         AND account.commerce_credential_generation = NEW.credential_generation
         AND credential.external_account_id = NEW.external_account_id
         AND credential.credential_version = NEW.credential_generation
         AND credential.auth_mode = 'shopify_client_credentials'
         AND credential.verification_status = 'verified'
         AND credential.last_error_code IS NULL
         AND NEW.activation_state IS NULL
         AND NEW.activation_revision IS NULL
         AND NEW.provider_write_control_row_version IS NOT NULL
         AND NEW.provider_write_scope_digest IS NOT NULL
         AND control.requested_mode = 'on'
         AND control.row_version = NEW.provider_write_control_row_version
         AND control.bound_credential_generation = NEW.credential_generation
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
         AND order_row.global_id = NEW.order_global_id
         AND order_row.integration_account_id = NEW.integration_account_id
         AND order_row.source_provider = 'shopify'
         AND order_row.external_order_id = NEW.external_order_id
         AND order_row.order_number = NEW.order_number
         AND order_row.row_version = NEW.expected_order_row_version
         AND order_row.status = 'cancelled'
         AND order_row.archived_at IS NULL
         AND order_row.source_payload->>'sourceHash' = NEW.expected_source_hash
         AND target.integration_account_id = NEW.integration_account_id
         AND target.provider = 'shopify'
         AND target.accepted_source_hash = NEW.expected_source_hash
         AND target.material_state IN ('provider_fulfilled', 'review_required')
         AND public.operations_shopify_post_reversal_order_cancellation_is_safe(
               NEW.organization_id,
               NEW.order_id,
               NEW.predecessor_authorization_id
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
           membership.role = 'owner'
           OR COALESCE(
             (membership.permissions->>'manageOperations')::boolean,
             false
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
      'Post-reversal Shopify order cancellation is not current or permitted';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  protect_shopify_order_management_authorization_write
ON public.operations_shopify_order_management_authorizations;

CREATE TRIGGER
  protect_shopify_order_management_authorization_write
BEFORE UPDATE OR DELETE
ON public.operations_shopify_order_management_authorizations
FOR EACH ROW EXECUTE FUNCTION
  public.protect_shopify_order_management_authorization();

CREATE TRIGGER
  protect_shopify_order_management_authorization_insert
BEFORE INSERT
ON public.operations_shopify_order_management_authorizations
FOR EACH ROW
WHEN (
  NEW.action NOT IN (
    'cancel_fulfillment',
    'cancel_order_after_fulfillment_reversal'
  )
)
EXECUTE FUNCTION public.protect_shopify_order_management_authorization();

CREATE TRIGGER
  protect_shopify_fulfillment_reversal_authorization_insert
BEFORE INSERT
ON public.operations_shopify_order_management_authorizations
FOR EACH ROW
WHEN (NEW.action = 'cancel_fulfillment')
EXECUTE FUNCTION
  public.protect_shopify_fulfillment_reversal_authorization_insert();

CREATE TRIGGER
  protect_shopify_post_reversal_order_cancel_authorization_insert
BEFORE INSERT
ON public.operations_shopify_order_management_authorizations
FOR EACH ROW
WHEN (NEW.action = 'cancel_order_after_fulfillment_reversal')
EXECUTE FUNCTION
  public.protect_shopify_post_reversal_order_cancel_authorization_insert();

CREATE OR REPLACE FUNCTION
  public.protect_shopify_fulfillment_reversal_attempt_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.action <> 'cancel_fulfillment'
     OR NOT EXISTS (
       SELECT 1
       FROM public.operations_shopify_order_management_authorizations authz
       JOIN public.operations_commerce_provider_write_control_current control
         ON control.organization_id = authz.organization_id
        AND control.integration_account_id = authz.integration_account_id
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
         AND authz.activation_state IS NULL
         AND authz.activation_revision IS NULL
         AND authz.provider_write_control_row_version =
               NEW.provider_write_control_row_version
         AND authz.provider_write_scope_digest =
               NEW.provider_write_scope_digest
         AND control.requested_mode = 'on'
         AND control.row_version = NEW.provider_write_control_row_version
         AND control.bound_credential_generation = NEW.credential_generation
         AND control.bound_granted_scope_digest =
               NEW.provider_write_scope_digest
         AND 'write_orders' = ANY(control.bound_granted_scopes)
         AND 'write_merchant_managed_fulfillment_orders' =
               ANY(control.bound_granted_scopes)
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
         AND authz.fulfillment_gid = NEW.fulfillment_gid
         AND authz.expected_fulfillment_updated_at =
               NEW.expected_fulfillment_updated_at
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
     )
  THEN
    RAISE EXCEPTION
      'Shopify fulfillment reversal provider attempt is not currently authorized';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION
  public.protect_shopify_post_reversal_order_cancel_attempt_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.action <> 'cancel_order_after_fulfillment_reversal'
     OR NOT EXISTS (
       SELECT 1
       FROM public.operations_shopify_order_management_authorizations authz
       JOIN public.operations_commerce_provider_write_control_current control
         ON control.organization_id = authz.organization_id
        AND control.integration_account_id = authz.integration_account_id
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
         AND authz.activation_state IS NULL
         AND authz.activation_revision IS NULL
         AND NEW.activation_revision IS NULL
         AND authz.provider_write_control_row_version =
               NEW.provider_write_control_row_version
         AND authz.provider_write_scope_digest =
               NEW.provider_write_scope_digest
         AND control.requested_mode = 'on'
         AND control.row_version = NEW.provider_write_control_row_version
         AND control.bound_credential_generation = NEW.credential_generation
         AND control.bound_granted_scope_digest =
               NEW.provider_write_scope_digest
         AND 'write_orders' = ANY(control.bound_granted_scopes)
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
         AND authz.fulfillment_gid IS NULL
         AND NEW.fulfillment_gid IS NULL
         AND authz.expected_fulfillment_updated_at IS NULL
         AND NEW.expected_fulfillment_updated_at IS NULL
         AND authz.predecessor_authorization_id =
               NEW.predecessor_authorization_id
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
     )
  THEN
    RAISE EXCEPTION
      'Post-reversal Shopify order cancellation attempt is not currently authorized';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  protect_shopify_order_management_attempt_write
ON public.operations_shopify_order_management_attempts;

CREATE TRIGGER protect_shopify_order_management_attempt_write
BEFORE UPDATE OR DELETE
ON public.operations_shopify_order_management_attempts
FOR EACH ROW EXECUTE FUNCTION
  public.protect_shopify_order_management_attempt();

CREATE TRIGGER protect_shopify_order_management_attempt_insert
BEFORE INSERT
ON public.operations_shopify_order_management_attempts
FOR EACH ROW
WHEN (
  NEW.action NOT IN (
    'cancel_fulfillment',
    'cancel_order_after_fulfillment_reversal'
  )
)
EXECUTE FUNCTION public.protect_shopify_order_management_attempt();

CREATE TRIGGER protect_shopify_fulfillment_reversal_attempt_insert
BEFORE INSERT
ON public.operations_shopify_order_management_attempts
FOR EACH ROW
WHEN (NEW.action = 'cancel_fulfillment')
EXECUTE FUNCTION
  public.protect_shopify_fulfillment_reversal_attempt_insert();

CREATE TRIGGER protect_shopify_post_reversal_order_cancel_attempt_insert
BEFORE INSERT
ON public.operations_shopify_order_management_attempts
FOR EACH ROW
WHEN (NEW.action = 'cancel_order_after_fulfillment_reversal')
EXECUTE FUNCTION
  public.protect_shopify_post_reversal_order_cancel_attempt_insert();

-- Serialize every warehouse-side change that can invalidate the reversal
-- safety predicate against prepared, processing, and outcome-unknown Shopify
-- order-management work. This closes the interval between the final database
-- claim recheck and the provider mutation without rejecting terminal history
-- that remains safe (for example, a planned unpacked package).
CREATE OR REPLACE FUNCTION
  public.enforce_shopify_order_management_downstream_race(
    p_organization_id uuid,
    p_order_id uuid
  )
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF p_organization_id IS NULL OR p_order_id IS NULL THEN
    RETURN;
  END IF;

  -- The preparation path locks this same canonical order row before it reads
  -- the downstream predicate. Taking the lock even when no authorization
  -- exists prevents an uncommitted downstream insert from slipping through
  -- the no-authorization-yet window.
  PERFORM order_row.id
  FROM public.operations_orders order_row
  WHERE order_row.organization_id = p_organization_id
    AND order_row.id = p_order_id
  FOR UPDATE;

  PERFORM authz.id
  FROM public.operations_shopify_order_management_authorizations authz
  WHERE authz.organization_id = p_organization_id
    AND authz.order_id = p_order_id
    AND authz.status IN ('prepared', 'processing', 'unknown')
  ORDER BY authz.id
  FOR UPDATE;

  IF EXISTS (
    SELECT 1
    FROM public.operations_shopify_order_management_authorizations authz
    WHERE authz.organization_id = p_organization_id
      AND authz.order_id = p_order_id
      AND authz.status IN ('processing', 'unknown')
  ) THEN
    RAISE EXCEPTION
      'Shopify order management attempt blocks downstream planning';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION
  public.protect_shopify_order_management_downstream_race()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  scoped_organization_id uuid;
  scoped_order_id uuid;
BEGIN
  scoped_organization_id :=
    (pg_catalog.to_jsonb(NEW)->>'organization_id')::uuid;
  IF TG_TABLE_NAME = 'operations_orders' THEN
    IF pg_catalog.to_jsonb(NEW)->>'status' IS NOT DISTINCT FROM
         pg_catalog.to_jsonb(OLD)->>'status'
       AND pg_catalog.to_jsonb(NEW)->>'archived_at' IS NOT DISTINCT FROM
         pg_catalog.to_jsonb(OLD)->>'archived_at'
    THEN
      RETURN NEW;
    END IF;
    scoped_order_id := (pg_catalog.to_jsonb(NEW)->>'id')::uuid;
  ELSE
    scoped_order_id :=
      (pg_catalog.to_jsonb(NEW)->>'order_id')::uuid;
  END IF;

  PERFORM public.enforce_shopify_order_management_downstream_race(
    scoped_organization_id,
    scoped_order_id
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION
  public.protect_shopify_order_management_indirect_downstream_race()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  scoped_organization_id uuid;
  scoped_order_id uuid;
  scoped_plan_id uuid;
BEGIN
  scoped_organization_id :=
    (pg_catalog.to_jsonb(NEW)->>'organization_id')::uuid;

  IF TG_TABLE_NAME = 'operations_waves' THEN
    FOR scoped_order_id IN
      SELECT DISTINCT recon.order_id
      FROM public.operations_shopify_external_fulfillment_reconciliations recon
      WHERE recon.organization_id = scoped_organization_id
        AND recon.wave_id = (pg_catalog.to_jsonb(NEW)->>'id')::uuid
      ORDER BY recon.order_id
    LOOP
      PERFORM public.enforce_shopify_order_management_downstream_race(
        scoped_organization_id,
        scoped_order_id
      );
    END LOOP;
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'operations_labels' THEN
    SELECT plan.order_id
    INTO scoped_order_id
    FROM public.operations_packages package
    JOIN public.operations_fulfillment_plans plan
      ON plan.organization_id = package.organization_id
     AND plan.id = package.plan_id
    WHERE package.organization_id = scoped_organization_id
      AND package.id =
            (pg_catalog.to_jsonb(NEW)->>'package_id')::uuid;
  ELSE
    scoped_plan_id :=
      (pg_catalog.to_jsonb(NEW)->>'plan_id')::uuid;
    SELECT plan.order_id
    INTO scoped_order_id
    FROM public.operations_fulfillment_plans plan
    WHERE plan.organization_id = scoped_organization_id
      AND plan.id = scoped_plan_id;
  END IF;

  IF scoped_order_id IS NULL THEN
    RAISE EXCEPTION
      'Shopify order management downstream order could not be resolved';
  END IF;

  PERFORM public.enforce_shopify_order_management_downstream_race(
    scoped_organization_id,
    scoped_order_id
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_shopify_order_management_plan_race
  ON public.operations_fulfillment_plans;
CREATE TRIGGER protect_shopify_order_management_plan_race
BEFORE INSERT OR UPDATE OF organization_id, order_id, status
ON public.operations_fulfillment_plans
FOR EACH ROW EXECUTE FUNCTION
  public.protect_shopify_order_management_downstream_race();

DROP TRIGGER IF EXISTS protect_shopify_order_management_reservation_race
  ON public.operations_reservations;
CREATE TRIGGER protect_shopify_order_management_reservation_race
BEFORE INSERT OR UPDATE OF organization_id, order_id, status
ON public.operations_reservations
FOR EACH ROW EXECUTE FUNCTION
  public.protect_shopify_order_management_downstream_race();

DROP TRIGGER IF EXISTS protect_shopify_order_management_wave_race
  ON public.operations_waves;
CREATE TRIGGER protect_shopify_order_management_wave_race
BEFORE UPDATE OF organization_id, status
ON public.operations_waves
FOR EACH ROW EXECUTE FUNCTION
  public.protect_shopify_order_management_indirect_downstream_race();

DROP TRIGGER IF EXISTS protect_shopify_order_management_pick_race
  ON public.operations_pick_tasks;
CREATE TRIGGER protect_shopify_order_management_pick_race
BEFORE INSERT OR UPDATE OF
  organization_id, plan_id, status, picked_quantity, picked_at
ON public.operations_pick_tasks
FOR EACH ROW EXECUTE FUNCTION
  public.protect_shopify_order_management_indirect_downstream_race();

DROP TRIGGER IF EXISTS protect_shopify_order_management_packaging_claim_race
  ON public.operations_packaging_material_claims;
CREATE TRIGGER protect_shopify_order_management_packaging_claim_race
BEFORE INSERT OR UPDATE OF organization_id, plan_id, status
ON public.operations_packaging_material_claims
FOR EACH ROW EXECUTE FUNCTION
  public.protect_shopify_order_management_indirect_downstream_race();

DROP TRIGGER IF EXISTS protect_shopify_order_management_package_race
  ON public.operations_packages;
CREATE TRIGGER protect_shopify_order_management_package_race
BEFORE INSERT OR UPDATE OF
  organization_id, plan_id, status, packed_by, packed_at
ON public.operations_packages
FOR EACH ROW EXECUTE FUNCTION
  public.protect_shopify_order_management_indirect_downstream_race();

DROP TRIGGER IF EXISTS protect_shopify_order_management_label_race
  ON public.operations_labels;
CREATE TRIGGER protect_shopify_order_management_label_race
BEFORE INSERT OR UPDATE OF organization_id, package_id
ON public.operations_labels
FOR EACH ROW EXECUTE FUNCTION
  public.protect_shopify_order_management_indirect_downstream_race();

DROP TRIGGER IF EXISTS protect_shopify_order_management_shipment_race
  ON public.operations_shipments;
CREATE TRIGGER protect_shopify_order_management_shipment_race
BEFORE INSERT OR UPDATE OF organization_id, order_id
ON public.operations_shipments
FOR EACH ROW EXECUTE FUNCTION
  public.protect_shopify_order_management_downstream_race();

DROP TRIGGER IF EXISTS protect_shopify_order_management_export_race
  ON public.operations_commerce_fulfillment_exports;
CREATE TRIGGER protect_shopify_order_management_export_race
BEFORE INSERT OR UPDATE OF organization_id, order_id
ON public.operations_commerce_fulfillment_exports
FOR EACH ROW EXECUTE FUNCTION
  public.protect_shopify_order_management_downstream_race();

DROP TRIGGER IF EXISTS protect_shopify_order_management_execution_race
  ON public.operations_fulfillment_executions;
CREATE TRIGGER protect_shopify_order_management_execution_race
BEFORE INSERT OR UPDATE OF organization_id, order_id
ON public.operations_fulfillment_executions
FOR EACH ROW EXECUTE FUNCTION
  public.protect_shopify_order_management_downstream_race();

DROP TRIGGER IF EXISTS protect_shopify_order_management_active_execution_race
  ON public.operations_active_fulfillment_executions;
CREATE TRIGGER protect_shopify_order_management_active_execution_race
BEFORE INSERT OR UPDATE OF organization_id, order_id
ON public.operations_active_fulfillment_executions
FOR EACH ROW EXECUTE FUNCTION
  public.protect_shopify_order_management_downstream_race();

DROP TRIGGER IF EXISTS protect_shopify_order_management_label_attempt_race
  ON public.operations_label_attempts;
CREATE TRIGGER protect_shopify_order_management_label_attempt_race
BEFORE INSERT OR UPDATE OF organization_id, order_id
ON public.operations_label_attempts
FOR EACH ROW EXECUTE FUNCTION
  public.protect_shopify_order_management_downstream_race();

DROP TRIGGER IF EXISTS protect_shopify_order_management_shipment_group_race
  ON public.operations_shipment_groups;
CREATE TRIGGER protect_shopify_order_management_shipment_group_race
BEFORE INSERT OR UPDATE OF organization_id, order_id
ON public.operations_shipment_groups
FOR EACH ROW EXECUTE FUNCTION
  public.protect_shopify_order_management_downstream_race();

DROP TRIGGER IF EXISTS protect_shopify_order_management_rerate_race
  ON public.operations_production_fulfillment_rerate_runs;
CREATE TRIGGER protect_shopify_order_management_rerate_race
BEFORE INSERT OR UPDATE OF organization_id, order_id
ON public.operations_production_fulfillment_rerate_runs
FOR EACH ROW EXECUTE FUNCTION
  public.protect_shopify_order_management_downstream_race();

COMMENT ON FUNCTION
  public.operations_shopify_fulfillment_reversal_is_safe(
    uuid, uuid, text, timestamptz
  )
IS
  'Exact external Shopify fulfillment plus terminal-only warehouse history and no ClawPilot shipment, carrier label, export, execution, billing, or live warehouse work.';

COMMENT ON FUNCTION
  public.operations_shopify_post_reversal_order_cancellation_is_safe(
    uuid, uuid, uuid
  )
IS
  'Permits a separately authorized Shopify order cancellation only after the exact externally reconciled fulfillment has a succeeded or affirmatively applied reversal outcome and the carrier/warehouse safety fence remains clear.';

COMMENT ON COLUMN
  public.operations_shopify_order_management_authorizations.fulfillment_gid
IS
  'Exact Shopify Fulfillment GID selected for the separately-authorized reversal action.';

COMMENT ON COLUMN
  public.operations_shopify_order_management_authorizations.expected_fulfillment_updated_at
IS
  'Exact Shopify fulfillment updatedAt observed before reversal; stale values fail before dispatch.';

COMMENT ON COLUMN
  public.operations_shopify_order_management_attempts.fulfillment_gid
IS
  'Immutable provider-attempt copy of the exact Shopify Fulfillment GID.';

COMMENT ON COLUMN
  public.operations_shopify_order_management_attempts.expected_fulfillment_updated_at
IS
  'Immutable provider-attempt copy of the exact Shopify fulfillment updatedAt.';

COMMENT ON COLUMN
  public.operations_shopify_order_management_authorizations.predecessor_authorization_id
IS
  'Exact successful or affirmatively reconciled fulfillment-reversal authorization required by the separately authorized order cancellation.';

COMMENT ON COLUMN
  public.operations_shopify_order_management_attempts.predecessor_authorization_id
IS
  'Immutable provider-attempt copy of the exact fulfillment-reversal predecessor authorization.';

COMMENT ON FUNCTION
  public.operations_shopify_order_management_is_current(uuid, uuid, boolean)
IS
  'Exact tenant, Shopify sandbox account, current credential and Provider writes scopes, source-bound order, and claim fence. Fulfillment reversal has a separate exact external-evidence fence and does not weaken ordinary order management.';
