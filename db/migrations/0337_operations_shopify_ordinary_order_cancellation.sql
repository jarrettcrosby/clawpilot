-- Guarded cancellation for an ordinary Shopify order in a verified account.
-- Runtime policy separately defaults production writes off and requires the
-- exact Railway production identity, a production-only enable flag, and an
-- exact account allowlist. The choices and payment snapshot are immutable on
-- both the authorization and attempt.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $$
DECLARE
  constraint_name text;
  removed_count integer := 0;
BEGIN
  FOR constraint_name IN
    SELECT conname
    FROM pg_catalog.pg_constraint
    WHERE conrelid =
          'public.operations_shopify_order_management_authorizations'::regclass
      AND contype = 'c'
      AND pg_catalog.pg_get_constraintdef(oid) LIKE '%account_environment%'
      AND pg_catalog.pg_get_constraintdef(oid) LIKE '%sandbox%'
      AND pg_catalog.pg_get_constraintdef(oid) NOT LIKE '%production%'
  LOOP
    EXECUTE pg_catalog.format(
      'ALTER TABLE public.operations_shopify_order_management_authorizations DROP CONSTRAINT %I',
      constraint_name
    );
    removed_count := removed_count + 1;
  END LOOP;
  IF removed_count <> 1 THEN
    RAISE EXCEPTION
      'Expected one sandbox-only Shopify authorization environment constraint, found %',
      removed_count;
  END IF;
END;
$$;

ALTER TABLE public.operations_shopify_order_management_authorizations
  ADD CONSTRAINT ops_shopify_order_mgmt_auth_environment_valid CHECK (
    account_environment IN ('sandbox', 'production')
  );

ALTER TABLE public.operations_shopify_order_management_authorizations
  ADD COLUMN cancel_refund_method text,
  ADD COLUMN cancel_restock boolean,
  ADD COLUMN cancel_notify_customer boolean,
  ADD COLUMN cancellation_payment_evidence jsonb;

ALTER TABLE public.operations_shopify_order_management_attempts
  ADD COLUMN cancel_refund_method text,
  ADD COLUMN cancel_restock boolean,
  ADD COLUMN cancel_notify_customer boolean,
  ADD COLUMN cancellation_payment_evidence jsonb;

-- Historical test-fixture rows did not retain the choices because all three
-- were hard-coded false. Preserve that exact meaning without fabricating the
-- older payment snapshot, which remains bound by provider_snapshot_hash.
UPDATE public.operations_shopify_order_management_authorizations
SET cancel_refund_method = 'none',
    cancel_restock = false,
    cancel_notify_customer = false
WHERE action IN ('cancel', 'cancel_order_after_fulfillment_reversal');

UPDATE public.operations_shopify_order_management_attempts
SET cancel_refund_method = 'none',
    cancel_restock = false,
    cancel_notify_customer = false
WHERE action IN ('cancel', 'cancel_order_after_fulfillment_reversal');

DO $$
DECLARE
  constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT conname
    FROM pg_catalog.pg_constraint
    WHERE conrelid =
          'public.operations_shopify_order_management_authorizations'::regclass
      AND contype = 'c'
      AND pg_catalog.pg_get_constraintdef(oid) LIKE '%cancel_reason%STAFF%OTHER%'
      AND conname <> 'ops_shopify_order_mgmt_auth_action_valid'
  LOOP
    EXECUTE pg_catalog.format(
      'ALTER TABLE public.operations_shopify_order_management_authorizations DROP CONSTRAINT %I',
      constraint_name
    );
  END LOOP;
END;
$$;

ALTER TABLE public.operations_shopify_order_management_authorizations
  ADD CONSTRAINT ops_shopify_order_mgmt_cancel_reason_valid CHECK (
    cancel_reason IS NULL OR cancel_reason IN (
      'CUSTOMER', 'DECLINED', 'FRAUD', 'INVENTORY', 'OTHER', 'STAFF'
    )
  ),
  ADD CONSTRAINT ops_shopify_order_mgmt_cancel_choices_valid CHECK (
    (
      action IN ('cancel', 'cancel_order_after_fulfillment_reversal')
      AND cancel_refund_method IN ('none', 'original_payment_methods')
      AND cancel_restock IS NOT NULL
      AND cancel_notify_customer IS NOT NULL
      AND (
        cancellation_payment_evidence IS NULL
        OR (
          cancellation_payment_evidence->>'schema' IN (
            'shopify-order-cancel-payment-evidence-v1',
            'shopify-order-cancel-payment-evidence-v2'
          )
          AND (
            cancellation_payment_evidence->>'schema' <>
              'shopify-order-cancel-payment-evidence-v2'
            OR cancellation_payment_evidence->>'refundMethod' =
                 cancel_refund_method
          )
        )
      )
    )
    OR (
      action NOT IN ('cancel', 'cancel_order_after_fulfillment_reversal')
      AND cancel_refund_method IS NULL
      AND cancel_restock IS NULL
      AND cancel_notify_customer IS NULL
      AND cancellation_payment_evidence IS NULL
    )
  );

ALTER TABLE public.operations_shopify_order_management_attempts
  ADD CONSTRAINT ops_shopify_order_mgmt_attempt_cancel_choices_valid CHECK (
    (
      action IN ('cancel', 'cancel_order_after_fulfillment_reversal')
      AND cancel_refund_method IN ('none', 'original_payment_methods')
      AND cancel_restock IS NOT NULL
      AND cancel_notify_customer IS NOT NULL
      AND (
        cancellation_payment_evidence IS NULL
        OR cancellation_payment_evidence->>'schema' IN (
          'shopify-order-cancel-payment-evidence-v1',
          'shopify-order-cancel-payment-evidence-v2'
        )
      )
    )
    OR (
      action NOT IN ('cancel', 'cancel_order_after_fulfillment_reversal')
      AND cancel_refund_method IS NULL
      AND cancel_restock IS NULL
      AND cancel_notify_customer IS NULL
      AND cancellation_payment_evidence IS NULL
    )
  );

ALTER TABLE public.operations_shopify_order_management_authorizations
  DROP CONSTRAINT ops_shopify_order_mgmt_auth_action_valid;

ALTER TABLE public.operations_shopify_order_management_authorizations
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
      AND fulfillment_gid ~ '^gid://shopify/Fulfillment/[1-9][0-9]{0,20}$'
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

-- The predecessor ledger functions were intentionally sandbox-only. Expand
-- exactly their one environment predicate so a production account can retain
-- and claim only an ordinary cancellation intent. Production cannot use the
-- legacy rolling activation lane: it must bind the current Provider-writes
-- control row and scope digest. Every other production action remains denied.
-- The replacement fails closed if either predecessor definition changes.
DO $migration$
DECLARE
  current_definition text;
  updated_definition text;
  sandbox_predicate constant text :=
    'AND account.environment = ''sandbox''';
BEGIN
  SELECT pg_catalog.pg_get_functiondef(
    'public.operations_shopify_order_management_is_current(uuid,uuid,boolean)'::regprocedure
  )
  INTO current_definition;

  IF (
    pg_catalog.length(current_definition)
    - pg_catalog.length(
        pg_catalog.replace(current_definition, sandbox_predicate, '')
      )
  ) <> pg_catalog.length(sandbox_predicate) THEN
    RAISE EXCEPTION
      'Unexpected Shopify authorization-current environment predicate';
  END IF;

  updated_definition := pg_catalog.replace(
    current_definition,
    sandbox_predicate,
    'AND (
        account.environment = ''sandbox''
        OR (
          account.environment = ''production''
          AND authz.action = ''cancel''
          AND authz.activation_state IS NULL
          AND authz.activation_revision IS NULL
          AND authz.provider_write_control_row_version IS NOT NULL
          AND authz.provider_write_scope_digest IS NOT NULL
        )
      )'
  );
  EXECUTE updated_definition;

  SELECT pg_catalog.pg_get_functiondef(
    'public.protect_shopify_order_management_authorization()'::regprocedure
  )
  INTO current_definition;

  IF (
    pg_catalog.length(current_definition)
    - pg_catalog.length(
        pg_catalog.replace(current_definition, sandbox_predicate, '')
      )
  ) <> pg_catalog.length(sandbox_predicate) THEN
    RAISE EXCEPTION
      'Unexpected Shopify authorization-insert environment predicate';
  END IF;

  updated_definition := pg_catalog.replace(
    current_definition,
    sandbox_predicate,
    'AND (
             account.environment = ''sandbox''
             OR (
               account.environment = ''production''
               AND NEW.action = ''cancel''
               AND NEW.activation_state IS NULL
               AND NEW.activation_revision IS NULL
               AND NEW.provider_write_control_row_version IS NOT NULL
               AND NEW.provider_write_scope_digest IS NOT NULL
             )
           )'
  );
  EXECUTE updated_definition;
END;
$migration$;

CREATE OR REPLACE FUNCTION
  public.protect_shopify_order_cancel_intent_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.action NOT IN ('cancel', 'cancel_order_after_fulfillment_reversal')
     OR NEW.cancel_refund_method NOT IN ('none', 'original_payment_methods')
     OR NEW.cancel_restock IS NULL
     OR NEW.cancel_notify_customer IS NULL
     OR NEW.cancellation_payment_evidence IS NULL
     OR NEW.cancellation_payment_evidence->>'schema' NOT IN (
       'shopify-order-cancel-payment-evidence-v1',
       'shopify-order-cancel-payment-evidence-v2'
     )
     OR (
       NEW.cancellation_payment_evidence->>'schema' =
         'shopify-order-cancel-payment-evidence-v2'
       AND NEW.cancellation_payment_evidence->>'refundMethod' <>
             NEW.cancel_refund_method
     )
     OR (
       NOT NEW.provider_order_test
       AND (
         NEW.action <> 'cancel'
         OR NEW.cancellation_payment_evidence->>'schema' <>
              'shopify-order-cancel-payment-evidence-v2'
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
  THEN
    RAISE EXCEPTION
      'Shopify order cancellation intent is incomplete or not permitted';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION
  public.protect_shopify_order_cancel_attempt_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.action NOT IN ('cancel', 'cancel_order_after_fulfillment_reversal')
     OR NOT EXISTS (
       SELECT 1
       FROM public.operations_shopify_order_management_authorizations authz
       WHERE authz.organization_id = NEW.organization_id
         AND authz.id = NEW.authorization_id
         AND authz.status = 'prepared'
         AND authz.cancel_refund_method = NEW.cancel_refund_method
         AND authz.cancel_restock = NEW.cancel_restock
         AND authz.cancel_notify_customer = NEW.cancel_notify_customer
         AND authz.cancellation_payment_evidence =
               NEW.cancellation_payment_evidence
         AND authz.intent_hash = NEW.intent_hash
         AND authz.provider_snapshot_hash = NEW.provider_snapshot_hash
     )
  THEN
    RAISE EXCEPTION
      'Shopify order cancellation attempt does not match its durable intent';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_shopify_order_cancel_intent_insert
ON public.operations_shopify_order_management_authorizations;

CREATE TRIGGER protect_shopify_order_cancel_intent_insert
BEFORE INSERT ON public.operations_shopify_order_management_authorizations
FOR EACH ROW
WHEN (NEW.action IN ('cancel', 'cancel_order_after_fulfillment_reversal'))
EXECUTE FUNCTION public.protect_shopify_order_cancel_intent_insert();

DROP TRIGGER IF EXISTS protect_shopify_order_cancel_attempt_insert
ON public.operations_shopify_order_management_attempts;

CREATE TRIGGER protect_shopify_order_cancel_attempt_insert
BEFORE INSERT ON public.operations_shopify_order_management_attempts
FOR EACH ROW
WHEN (NEW.action IN ('cancel', 'cancel_order_after_fulfillment_reversal'))
EXECUTE FUNCTION public.protect_shopify_order_cancel_attempt_insert();

COMMENT ON COLUMN
  public.operations_shopify_order_management_authorizations.cancellation_payment_evidence
IS 'Immutable bounded payment snapshot used to reconcile orderCancel without retrying an unknown provider outcome.';
