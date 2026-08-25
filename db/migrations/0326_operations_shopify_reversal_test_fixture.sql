-- Hidden development-only Shopify reversal fixture authority.
--
-- This is not an Operations workflow and it does not weaken any ordinary
-- order, fulfillment, or reversal command.  The three ledgers are immutable:
-- one prepared command, at most one provider claim, and append-only terminal
-- outcome evidence.  An unknown provider outcome can only be reconciled by a
-- read; it can never be claimed again.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

INSERT INTO public.global_reference_entity_types (
  prefix, entity_type, display_name
) VALUES
  ('gsfc', 'operations.shopify_reversal_fixture_command',
   'Shopify reversal fixture command'),
  ('gsft', 'operations.shopify_reversal_fixture_attempt',
   'Shopify reversal fixture provider attempt'),
  ('gsfo', 'operations.shopify_reversal_fixture_outcome',
   'Shopify reversal fixture outcome')
ON CONFLICT (prefix) DO UPDATE SET
  entity_type = EXCLUDED.entity_type,
  display_name = EXCLUDED.display_name;

CREATE TABLE public.operations_shopify_reversal_fixture_commands (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  global_id text NOT NULL DEFAULT public.allocate_global_reference('gsfc'),
  organization_id uuid NOT NULL
    REFERENCES public.workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  phase text NOT NULL CHECK (phase IN ('create_order', 'create_fulfillment')),
  fixture_profile_version text NOT NULL
    CHECK (fixture_profile_version = 'shopify-reversal-fixture-v1'),
  prepared_by text NOT NULL
    REFERENCES public.app_users(email) ON DELETE RESTRICT,
  prepared_role text NOT NULL CHECK (prepared_role IN ('owner', 'admin')),
  idempotency_key text NOT NULL,
  intent_hash text NOT NULL CHECK (intent_hash ~ '^[a-f0-9]{64}$'),
  confirmation_hash text NOT NULL
    CHECK (confirmation_hash ~ '^[a-f0-9]{64}$'),
  provider_write_control_row_version bigint NOT NULL
    CHECK (provider_write_control_row_version > 0),
  credential_generation integer NOT NULL CHECK (credential_generation > 0),
  granted_scope_digest text NOT NULL
    CHECK (granted_scope_digest ~ '^[a-f0-9]{64}$'),
  external_account_id text NOT NULL
    CHECK (external_account_id ~ '^gid://shopify/Shop/[1-9][0-9]{0,20}$'),
  shop_domain text NOT NULL
    CHECK (shop_domain ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$'),
  source_identifier text,
  unique_tag text,
  tag_fingerprint text,
  predecessor_command_id uuid,
  order_id uuid,
  order_global_id text,
  external_order_id text,
  expected_order_row_version bigint,
  released_at timestamptz,
  provider_location_id text,
  expected_lines jsonb,
  fulfillment_attempt_signature jsonb,
  fulfillment_attempt_signature_hash text,
  prepared_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT operations_shopify_reversal_fixture_commands_global_valid
    CHECK (global_id ~ '^gsfc(?:[0-9]{7}|[0-9a-v]{12})$'),
  CONSTRAINT operations_shopify_reversal_fixture_commands_global_unique
    UNIQUE (global_id),
  CONSTRAINT operations_shopify_reversal_fixture_commands_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES public.crm_reference_registry(reference_code)
    ON DELETE RESTRICT,
  CONSTRAINT operations_shopify_reversal_fixture_commands_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES public.operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_shopify_reversal_fixture_commands_order_fkey
    FOREIGN KEY (organization_id, order_id)
    REFERENCES public.operations_orders(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_shopify_reversal_fixture_commands_predecessor_fkey
    FOREIGN KEY (organization_id, predecessor_command_id)
    REFERENCES public.operations_shopify_reversal_fixture_commands(
      organization_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_shopify_reversal_fixture_commands_org_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT operations_shopify_reversal_fixture_commands_idempotency_unique
    UNIQUE (organization_id, phase, idempotency_key),
  CONSTRAINT operations_shopify_reversal_fixture_commands_intent_unique
    UNIQUE (organization_id, intent_hash),
  CONSTRAINT operations_shopify_reversal_fixture_commands_source_unique
    UNIQUE (organization_id, source_identifier),
  CONSTRAINT operations_shopify_reversal_fixture_commands_tag_unique
    UNIQUE (organization_id, unique_tag),
  CONSTRAINT operations_shopify_reversal_fixture_commands_text_valid CHECK (
    pg_catalog.length(idempotency_key) BETWEEN 8 AND 200
    AND idempotency_key = pg_catalog.btrim(idempotency_key)
    AND idempotency_key !~ '[[:cntrl:]]'
    AND expires_at > prepared_at
    AND expires_at <= prepared_at + interval '10 minutes'
  ),
  CONSTRAINT operations_shopify_reversal_fixture_commands_phase_valid CHECK (
    (
      phase = 'create_order'
      AND source_identifier ~ '^clawpilot-reversal-fixture:gsfc(?:[0-9]{7}|[0-9a-v]{12})$'
      AND unique_tag ~ '^clawpilot-reversal-[a-f0-9]{24}$'
      AND tag_fingerprint ~ '^[a-f0-9]{64}$'
      AND tag_fingerprint = pg_catalog.encode(
        public.digest(pg_catalog.convert_to(unique_tag, 'UTF8'), 'sha256'),
        'hex'
      )
      AND predecessor_command_id IS NULL
      AND order_id IS NULL
      AND order_global_id IS NULL
      AND external_order_id IS NULL
      AND expected_order_row_version IS NULL
      AND released_at IS NULL
      AND provider_location_id IS NULL
      AND expected_lines IS NULL
      AND fulfillment_attempt_signature IS NULL
      AND fulfillment_attempt_signature_hash IS NULL
    ) OR (
      phase = 'create_fulfillment'
      AND source_identifier IS NULL
      AND unique_tag IS NULL
      AND tag_fingerprint IS NULL
      AND predecessor_command_id IS NOT NULL
      AND order_id IS NOT NULL
      AND order_global_id ~ '^gor(?:[0-9]{7}|[0-9a-v]{12})$'
      AND external_order_id ~ '^gid://shopify/Order/[1-9][0-9]{0,20}$'
      AND expected_order_row_version >= 0
      AND released_at IS NOT NULL
      AND provider_location_id ~ '^gid://shopify/Location/[1-9][0-9]{0,20}$'
      AND pg_catalog.jsonb_typeof(expected_lines) = 'array'
      AND pg_catalog.jsonb_array_length(expected_lines) BETWEEN 1 AND 250
      AND pg_catalog.jsonb_typeof(fulfillment_attempt_signature) = 'object'
      AND fulfillment_attempt_signature_hash ~ '^[a-f0-9]{64}$'
    )
  )
);

CREATE TABLE public.operations_shopify_reversal_fixture_attempts (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  global_id text NOT NULL DEFAULT public.allocate_global_reference('gsft'),
  organization_id uuid NOT NULL
    REFERENCES public.workspace_organizations(id) ON DELETE RESTRICT,
  command_id uuid NOT NULL,
  phase text NOT NULL CHECK (phase IN ('create_order', 'create_fulfillment')),
  claimed_by text NOT NULL
    REFERENCES public.app_users(email) ON DELETE RESTRICT,
  claimed_role text NOT NULL CHECK (claimed_role IN ('owner', 'admin')),
  intent_hash text NOT NULL CHECK (intent_hash ~ '^[a-f0-9]{64}$'),
  confirmation_hash text NOT NULL
    CHECK (confirmation_hash ~ '^[a-f0-9]{64}$'),
  claimed_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT operations_shopify_reversal_fixture_attempts_global_valid
    CHECK (global_id ~ '^gsft(?:[0-9]{7}|[0-9a-v]{12})$'),
  CONSTRAINT operations_shopify_reversal_fixture_attempts_global_unique
    UNIQUE (global_id),
  CONSTRAINT operations_shopify_reversal_fixture_attempts_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES public.crm_reference_registry(reference_code)
    ON DELETE RESTRICT,
  CONSTRAINT operations_shopify_reversal_fixture_attempts_command_fkey
    FOREIGN KEY (organization_id, command_id)
    REFERENCES public.operations_shopify_reversal_fixture_commands(
      organization_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_shopify_reversal_fixture_attempts_command_unique
    UNIQUE (organization_id, command_id),
  CONSTRAINT operations_shopify_reversal_fixture_attempts_org_id_unique
    UNIQUE (organization_id, id)
);

CREATE TABLE public.operations_shopify_reversal_fixture_outcomes (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  global_id text NOT NULL DEFAULT public.allocate_global_reference('gsfo'),
  organization_id uuid NOT NULL
    REFERENCES public.workspace_organizations(id) ON DELETE RESTRICT,
  command_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  outcome_state text NOT NULL CHECK (outcome_state IN (
    'succeeded', 'rejected', 'unknown',
    'reconciled_applied', 'reconciled_absent', 'reconciled_ambiguous'
  )),
  provider_mutation_attempted boolean NOT NULL,
  provider_writes integer CHECK (provider_writes BETWEEN 0 AND 1),
  provider_reference text,
  provider_order_id text,
  provider_order_name text,
  provider_order_updated_at timestamptz,
  error_code text,
  evidence_hash text CHECK (
    evidence_hash IS NULL OR evidence_hash ~ '^[a-f0-9]{64}$'
  ),
  recorded_by text NOT NULL
    REFERENCES public.app_users(email) ON DELETE RESTRICT,
  recorded_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT operations_shopify_reversal_fixture_outcomes_global_valid
    CHECK (global_id ~ '^gsfo(?:[0-9]{7}|[0-9a-v]{12})$'),
  CONSTRAINT operations_shopify_reversal_fixture_outcomes_global_unique
    UNIQUE (global_id),
  CONSTRAINT operations_shopify_reversal_fixture_outcomes_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES public.crm_reference_registry(reference_code)
    ON DELETE RESTRICT,
  CONSTRAINT operations_shopify_reversal_fixture_outcomes_command_fkey
    FOREIGN KEY (organization_id, command_id)
    REFERENCES public.operations_shopify_reversal_fixture_commands(
      organization_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_shopify_reversal_fixture_outcomes_attempt_fkey
    FOREIGN KEY (organization_id, attempt_id)
    REFERENCES public.operations_shopify_reversal_fixture_attempts(
      organization_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_shopify_reversal_fixture_outcomes_org_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT operations_shopify_reversal_fixture_outcomes_shape_valid CHECK (
    (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{1,127}$')
    AND (
      (
        outcome_state = 'unknown'
        AND provider_mutation_attempted = true
        AND provider_writes IS NULL
        AND error_code IS NOT NULL
      )
      OR (
        outcome_state <> 'unknown'
        AND provider_writes IS NOT NULL
      )
    )
    AND (
      outcome_state NOT LIKE 'reconciled_%'
      OR (
        provider_mutation_attempted = false
        AND provider_writes = 0
        AND evidence_hash IS NOT NULL
      )
    )
    AND (
      outcome_state <> 'rejected'
      OR (provider_writes = 0 AND error_code IS NOT NULL)
    )
    AND (
      outcome_state <> 'succeeded'
      OR (error_code IS NULL AND evidence_hash IS NOT NULL)
    )
    AND (
      provider_order_id IS NULL
      OR provider_order_id ~ '^gid://shopify/Order/[1-9][0-9]{0,20}$'
    )
  )
);

CREATE UNIQUE INDEX operations_shopify_reversal_fixture_initial_outcome_unique
ON public.operations_shopify_reversal_fixture_outcomes (
  organization_id, attempt_id
)
WHERE outcome_state IN ('succeeded', 'rejected', 'unknown');

CREATE UNIQUE INDEX operations_shopify_reversal_fixture_reconciliation_unique
ON public.operations_shopify_reversal_fixture_outcomes (
  organization_id, attempt_id
)
WHERE outcome_state LIKE 'reconciled_%';

CREATE OR REPLACE FUNCTION
  public.operations_shopify_reversal_fixture_actor_is_manager(
    p_organization_id uuid,
    p_actor text,
    p_role text
  )
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.app_user_organization_memberships membership
    WHERE membership.organization_id = p_organization_id
      AND membership.user_email = p_actor
      AND membership.status = 'active'
      AND membership.role = p_role
      AND membership.role IN ('owner', 'admin')
  )
$$;

CREATE OR REPLACE FUNCTION
  public.operations_shopify_reversal_fixture_account_is_current(
    p_organization_id uuid,
    p_account_id uuid,
    p_control_row_version bigint,
    p_credential_generation integer,
    p_scope_digest text,
    p_external_account_id text,
    p_shop_domain text
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
    JOIN public.operations_commerce_provider_write_control_current control
      ON control.organization_id = account.organization_id
     AND control.integration_account_id = account.id
    WHERE account.organization_id = p_organization_id
      AND account.id = p_account_id
      AND account.global_id = 'giah34fedoa5b1o'
      AND account.integration_type = 'commerce'
      AND account.provider = 'shopify'
      AND account.environment = 'sandbox'
      AND account.status = 'active'
      AND account.external_account_id = p_external_account_id
      AND account.configuration->>'shopDomain' = p_shop_domain
      AND account.commerce_credential_generation = p_credential_generation
      AND credential.credential_version = p_credential_generation
      AND credential.external_account_id = p_external_account_id
      AND credential.verification_status = 'verified'
      AND credential.last_error_code IS NULL
      AND credential.auth_mode = 'shopify_client_credentials'
      AND control.requested_mode = 'on'
      AND control.row_version = p_control_row_version
      AND control.bound_credential_generation = p_credential_generation
      AND control.bound_granted_scope_digest = p_scope_digest
      AND control.bound_granted_scope_digest =
            public.operations_commerce_granted_scope_digest(
              public.operations_commerce_granted_scope_snapshot(
                account.configuration
              )
            )
      AND control.bound_granted_scopes =
            public.operations_commerce_granted_scope_snapshot(
              account.configuration
            )
      AND 'read_orders' = ANY(control.bound_granted_scopes)
      AND 'write_orders' = ANY(control.bound_granted_scopes)
      AND 'write_merchant_managed_fulfillment_orders' =
            ANY(control.bound_granted_scopes)
  )
$$;

CREATE OR REPLACE FUNCTION
  public.operations_shopify_reversal_fixture_database_is_trusted()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.app_settings setting
    WHERE setting.key = 'deployment.database.identity'
      AND setting.value->>'id' =
            '750aa268-0e31-4065-a99c-4016e4d4fab1'
  )
$$;

CREATE OR REPLACE FUNCTION
  public.operations_shopify_reversal_fixture_fulfillment_is_safe(
    p_organization_id uuid,
    p_predecessor_command_id uuid,
    p_order_id uuid,
    p_expected_order_row_version bigint,
    p_released_at timestamptz,
    p_provider_location_id text,
    p_expected_lines jsonb
  )
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.operations_orders source_order
    JOIN public.operations_shopify_reversal_fixture_commands predecessor
      ON predecessor.organization_id = source_order.organization_id
     AND predecessor.id = p_predecessor_command_id
     AND predecessor.phase = 'create_order'
    JOIN public.operations_shopify_reversal_fixture_attempts predecessor_attempt
      ON predecessor_attempt.organization_id = predecessor.organization_id
     AND predecessor_attempt.command_id = predecessor.id
    JOIN public.operations_shopify_reversal_fixture_outcomes predecessor_outcome
      ON predecessor_outcome.organization_id = predecessor.organization_id
     AND predecessor_outcome.command_id = predecessor.id
     AND predecessor_outcome.attempt_id = predecessor_attempt.id
     AND predecessor_outcome.outcome_state IN (
       'succeeded', 'reconciled_applied'
     )
     AND predecessor_outcome.provider_order_id =
           source_order.external_order_id
    JOIN public.operations_commerce_order_candidates candidate
      ON candidate.organization_id = source_order.organization_id
     AND candidate.integration_account_id = source_order.integration_account_id
     AND candidate.canonical_order_id = source_order.id
     AND candidate.workflow_state = 'promoted'
     AND candidate.test_order = true
     AND candidate.normalized_payment_status = 'pending'
     AND candidate.normalized_fulfillment_status = 'unfulfilled'
     AND candidate.normalized_order_status = 'open'
     AND candidate.requires_shipping = true
    JOIN public.operations_fulfillment_plans plan
      ON plan.organization_id = source_order.organization_id
     AND plan.order_id = source_order.id
     AND plan.status = 'released'
    WHERE source_order.organization_id = p_organization_id
      AND source_order.id = p_order_id
      AND source_order.source_provider = 'shopify'
      AND source_order.status = 'released'
      AND source_order.row_version = p_expected_order_row_version
      AND source_order.archived_at IS NULL
      AND p_released_at <= pg_catalog.clock_timestamp()
      AND (
        SELECT pg_catalog.count(*)
        FROM public.operations_fulfillment_plans all_plan
        WHERE all_plan.organization_id = source_order.organization_id
          AND all_plan.order_id = source_order.id
      ) = 1
      AND EXISTS (
        SELECT 1
        FROM public.operations_pick_tasks pick
        JOIN public.operations_waves wave
          ON wave.organization_id = pick.organization_id
         AND wave.id = pick.wave_id
        WHERE pick.organization_id = source_order.organization_id
          AND pick.plan_id = plan.id
        GROUP BY wave.id, wave.status, wave.released_at
        HAVING pg_catalog.count(*) > 0
          AND pg_catalog.count(DISTINCT pick.wave_id) = 1
          AND wave.status = 'released'
          AND wave.released_at = p_released_at
          AND pg_catalog.bool_and(
            pick.status = 'ready'
            AND COALESCE(pick.picked_quantity, 0) = 0
            AND pick.picked_at IS NULL
          )
      )
      AND p_expected_lines = (
        SELECT pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'lineItemId', line.external_line_id,
            'quantity', line.quantity::integer
          ) ORDER BY line.external_line_id
        )
        FROM public.operations_current_order_lines line
        WHERE line.organization_id = source_order.organization_id
          AND line.order_id = source_order.id
          AND line.quantity = pg_catalog.trunc(line.quantity)
          AND line.quantity BETWEEN 1 AND 2147483647
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.operations_current_order_lines line
        WHERE line.organization_id = source_order.organization_id
          AND line.order_id = source_order.id
          AND (
            line.external_line_id !~ '^gid://shopify/LineItem/[1-9][0-9]{0,20}$'
            OR line.quantity <> pg_catalog.trunc(line.quantity)
            OR line.quantity NOT BETWEEN 1 AND 2147483647
          )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.operations_current_order_lines line
        WHERE line.organization_id = source_order.organization_id
          AND line.order_id = source_order.id
          AND line.quantity <> COALESCE((
            SELECT pg_catalog.sum(allocation.quantity)
            FROM public.operations_fulfillment_allocations allocation
            WHERE allocation.organization_id = line.organization_id
              AND allocation.plan_id = plan.id
              AND allocation.order_line_id = line.id
          ), 0)
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.operations_fulfillment_allocations allocation
        WHERE allocation.organization_id = plan.organization_id
          AND allocation.plan_id = plan.id
          AND NOT EXISTS (
            SELECT 1
            FROM public.operations_pick_tasks pick
            WHERE pick.organization_id = allocation.organization_id
              AND pick.plan_id = allocation.plan_id
              AND pick.allocation_id = allocation.id
              AND pick.status = 'ready'
              AND COALESCE(pick.picked_quantity, 0) = 0
              AND pick.picked_at IS NULL
          )
      )
      AND EXISTS (
        SELECT 1
        FROM public.operations_fulfillment_allocations allocation
        JOIN public.operations_reservations reservation
          ON reservation.organization_id = allocation.organization_id
         AND reservation.id = allocation.reservation_id
        JOIN public.operations_commerce_inventory_levels source_level
          ON source_level.organization_id = reservation.organization_id
         AND source_level.id = reservation.provider_inventory_level_id
         AND source_level.sync_run_id =
               reservation.provider_inventory_sync_run_id
        WHERE allocation.organization_id = source_order.organization_id
          AND allocation.plan_id = plan.id
          AND reservation.status = 'active'
          AND reservation.reservation_authority = 'provider_commitment'
          AND source_level.integration_account_id =
                source_order.integration_account_id
        GROUP BY allocation.plan_id
        HAVING pg_catalog.count(DISTINCT source_level.provider_location_id) = 1
          AND pg_catalog.min(source_level.provider_location_id) =
                p_provider_location_id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.operations_fulfillment_allocations allocation
        JOIN public.operations_reservations reservation
          ON reservation.organization_id = allocation.organization_id
         AND reservation.id = allocation.reservation_id
        LEFT JOIN public.operations_commerce_inventory_levels source_level
          ON source_level.organization_id = reservation.organization_id
         AND source_level.id = reservation.provider_inventory_level_id
         AND source_level.sync_run_id =
               reservation.provider_inventory_sync_run_id
         AND source_level.integration_account_id =
               source_order.integration_account_id
         AND source_level.provider_location_id = p_provider_location_id
        WHERE allocation.organization_id = plan.organization_id
          AND allocation.plan_id = plan.id
          AND (
            reservation.status <> 'active'
            OR reservation.reservation_authority <> 'provider_commitment'
            OR source_level.id IS NULL
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.operations_shopify_external_fulfillment_reconciliations row
        WHERE row.organization_id = source_order.organization_id
          AND row.order_id = source_order.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.operations_fulfillment_executions row
        WHERE row.organization_id = source_order.organization_id
          AND row.order_id = source_order.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.operations_active_fulfillment_executions row
        WHERE row.organization_id = source_order.organization_id
          AND row.order_id = source_order.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.operations_label_attempts row
        WHERE row.organization_id = source_order.organization_id
          AND row.order_id = source_order.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.operations_packages row
        WHERE row.organization_id = plan.organization_id
          AND row.plan_id = plan.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.operations_labels label
        JOIN public.operations_packages package
          ON package.organization_id = label.organization_id
         AND package.id = label.package_id
        WHERE package.organization_id = source_order.organization_id
          AND package.plan_id = plan.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.operations_print_artifacts row
        WHERE row.organization_id = source_order.organization_id
          AND row.source_order_id = source_order.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.operations_shipments row
        WHERE row.organization_id = source_order.organization_id
          AND row.order_id = source_order.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.operations_commerce_fulfillment_exports row
        WHERE row.organization_id = source_order.organization_id
          AND row.order_id = source_order.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.operations_billable_events row
        WHERE row.organization_id = source_order.organization_id
          AND row.order_id = source_order.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.operations_shipment_groups row
        WHERE row.organization_id = source_order.organization_id
          AND row.order_id = source_order.id
      )
  )
$$;

CREATE OR REPLACE FUNCTION
  public.protect_shopify_reversal_fixture_command_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'shopify-reversal-fixture:'
        || NEW.organization_id::text
        || ':' || NEW.integration_account_id::text
        || ':' || NEW.phase,
      0
    )
  );
  NEW.prepared_at := pg_catalog.clock_timestamp();
  IF NOT public.operations_shopify_reversal_fixture_database_is_trusted()
     OR NOT public.operations_shopify_reversal_fixture_actor_is_manager(
       NEW.organization_id, NEW.prepared_by, NEW.prepared_role
     )
     OR NOT public.operations_shopify_reversal_fixture_account_is_current(
       NEW.organization_id,
       NEW.integration_account_id,
       NEW.provider_write_control_row_version,
       NEW.credential_generation,
       NEW.granted_scope_digest,
       NEW.external_account_id,
       NEW.shop_domain
     )
     OR (
       NEW.phase = 'create_fulfillment'
       AND NOT public.operations_shopify_reversal_fixture_fulfillment_is_safe(
         NEW.organization_id,
         NEW.predecessor_command_id,
         NEW.order_id,
         NEW.expected_order_row_version,
         NEW.released_at,
         NEW.provider_location_id,
         NEW.expected_lines
       )
     )
     OR EXISTS (
       SELECT 1
       FROM public.operations_shopify_reversal_fixture_commands unresolved
       LEFT JOIN public.operations_shopify_reversal_fixture_attempts attempt
         ON attempt.organization_id = unresolved.organization_id
        AND attempt.command_id = unresolved.id
       WHERE unresolved.organization_id = NEW.organization_id
         AND unresolved.integration_account_id = NEW.integration_account_id
         AND unresolved.phase = NEW.phase
         AND (
           (
             attempt.id IS NULL
             AND unresolved.expires_at > pg_catalog.clock_timestamp()
           )
           OR (
             attempt.id IS NOT NULL
             AND NOT EXISTS (
             SELECT 1
             FROM public.operations_shopify_reversal_fixture_outcomes initial
             WHERE initial.organization_id = attempt.organization_id
               AND initial.attempt_id = attempt.id
               AND initial.outcome_state IN ('succeeded', 'rejected')
             )
           )
         )
     )
  THEN
    RAISE EXCEPTION
      'Shopify reversal fixture command is not currently authorized';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION
  public.protect_shopify_reversal_fixture_attempt_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.operations_shopify_reversal_fixture_commands command
    WHERE command.organization_id = NEW.organization_id
      AND command.id = NEW.command_id
      AND command.phase = NEW.phase
      AND command.intent_hash = NEW.intent_hash
      AND command.confirmation_hash = NEW.confirmation_hash
      AND command.prepared_by = NEW.claimed_by
      AND command.prepared_role = NEW.claimed_role
      AND command.expires_at > pg_catalog.clock_timestamp()
      AND public.operations_shopify_reversal_fixture_database_is_trusted()
      AND public.operations_shopify_reversal_fixture_actor_is_manager(
        command.organization_id, NEW.claimed_by, NEW.claimed_role
      )
      AND public.operations_shopify_reversal_fixture_account_is_current(
        command.organization_id,
        command.integration_account_id,
        command.provider_write_control_row_version,
        command.credential_generation,
        command.granted_scope_digest,
        command.external_account_id,
        command.shop_domain
      )
      AND (
        command.phase <> 'create_fulfillment'
        OR public.operations_shopify_reversal_fixture_fulfillment_is_safe(
          command.organization_id,
          command.predecessor_command_id,
          command.order_id,
          command.expected_order_row_version,
          command.released_at,
          command.provider_location_id,
          command.expected_lines
        )
      )
  ) THEN
    RAISE EXCEPTION
      'Shopify reversal fixture provider claim is not currently authorized';
  END IF;
  NEW.claimed_at := pg_catalog.clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION
  public.protect_shopify_reversal_fixture_outcome_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.operations_shopify_reversal_fixture_attempts attempt
    WHERE attempt.organization_id = NEW.organization_id
      AND attempt.id = NEW.attempt_id
      AND attempt.command_id = NEW.command_id
      AND attempt.claimed_by = NEW.recorded_by
  ) OR (
    NEW.outcome_state LIKE 'reconciled_%'
    AND NOT EXISTS (
      SELECT 1
      FROM public.operations_shopify_reversal_fixture_outcomes unknown_outcome
      WHERE unknown_outcome.organization_id = NEW.organization_id
        AND unknown_outcome.attempt_id = NEW.attempt_id
        AND unknown_outcome.outcome_state = 'unknown'
    )
  ) THEN
    RAISE EXCEPTION 'Shopify reversal fixture outcome is not authorized';
  END IF;
  NEW.recorded_at := pg_catalog.clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION
  public.reject_shopify_reversal_fixture_ledger_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'Shopify reversal fixture ledgers are append-only';
END;
$$;

CREATE TRIGGER protect_shopify_reversal_fixture_command_insert
BEFORE INSERT ON public.operations_shopify_reversal_fixture_commands
FOR EACH ROW EXECUTE FUNCTION
  public.protect_shopify_reversal_fixture_command_insert();
CREATE TRIGGER protect_shopify_reversal_fixture_attempt_insert
BEFORE INSERT ON public.operations_shopify_reversal_fixture_attempts
FOR EACH ROW EXECUTE FUNCTION
  public.protect_shopify_reversal_fixture_attempt_insert();
CREATE TRIGGER protect_shopify_reversal_fixture_outcome_insert
BEFORE INSERT ON public.operations_shopify_reversal_fixture_outcomes
FOR EACH ROW EXECUTE FUNCTION
  public.protect_shopify_reversal_fixture_outcome_insert();

CREATE TRIGGER immutable_shopify_reversal_fixture_commands
BEFORE UPDATE OR DELETE
ON public.operations_shopify_reversal_fixture_commands
FOR EACH ROW EXECUTE FUNCTION
  public.reject_shopify_reversal_fixture_ledger_mutation();
CREATE TRIGGER immutable_shopify_reversal_fixture_attempts
BEFORE UPDATE OR DELETE
ON public.operations_shopify_reversal_fixture_attempts
FOR EACH ROW EXECUTE FUNCTION
  public.reject_shopify_reversal_fixture_ledger_mutation();
CREATE TRIGGER immutable_shopify_reversal_fixture_outcomes
BEFORE UPDATE OR DELETE
ON public.operations_shopify_reversal_fixture_outcomes
FOR EACH ROW EXECUTE FUNCTION
  public.reject_shopify_reversal_fixture_ledger_mutation();

CREATE OR REPLACE VIEW public.operations_shopify_reversal_fixture_command_state
AS
SELECT command.organization_id,
       command.id AS command_id,
       command.global_id AS command_global_id,
       command.phase,
       CASE
         WHEN attempt.id IS NULL THEN 'prepared'
         WHEN initial_outcome.id IS NULL THEN 'processing'
         WHEN reconciliation.id IS NOT NULL THEN reconciliation.outcome_state
         ELSE initial_outcome.outcome_state
       END AS state,
       attempt.global_id AS attempt_global_id,
       initial_outcome.global_id AS initial_outcome_global_id,
       reconciliation.global_id AS reconciliation_outcome_global_id,
       COALESCE(
         reconciliation.provider_order_id,
         initial_outcome.provider_order_id
       ) AS provider_order_id,
       COALESCE(
         reconciliation.provider_reference,
         initial_outcome.provider_reference
       ) AS provider_reference,
       command.prepared_at,
       command.expires_at
FROM public.operations_shopify_reversal_fixture_commands command
LEFT JOIN public.operations_shopify_reversal_fixture_attempts attempt
  ON attempt.organization_id = command.organization_id
 AND attempt.command_id = command.id
LEFT JOIN public.operations_shopify_reversal_fixture_outcomes initial_outcome
  ON initial_outcome.organization_id = command.organization_id
 AND initial_outcome.attempt_id = attempt.id
 AND initial_outcome.outcome_state IN ('succeeded', 'rejected', 'unknown')
LEFT JOIN public.operations_shopify_reversal_fixture_outcomes reconciliation
  ON reconciliation.organization_id = command.organization_id
 AND reconciliation.attempt_id = attempt.id
 AND reconciliation.outcome_state LIKE 'reconciled_%';

COMMENT ON TABLE public.operations_shopify_reversal_fixture_commands IS
  'Immutable hidden development-only fixed-profile Shopify reversal fixture commands. These records do not authorize the normal reversal or cancellation workflows.';
COMMENT ON TABLE public.operations_shopify_reversal_fixture_attempts IS
  'One immutable provider claim per Shopify reversal fixture command. A command cannot be retried after claim.';
COMMENT ON TABLE public.operations_shopify_reversal_fixture_outcomes IS
  'Append-only known, unknown, and read-reconciliation evidence for the exact fixture provider attempt.';
