-- Active, single-warehouse, multi-package carrier execution evidence.
--
-- Migration 0177 remains the immutable Shadow preparation boundary. Active
-- execution never upgrades or mutates those rows; it references one exact
-- Shadow execution and creates separate authority, shipment-group, dispatch,
-- and package-result records. This migration adds no worker, provider call,
-- or activation-state change.

INSERT INTO global_reference_entity_types (
  prefix, entity_type, display_name
)
VALUES
  (
    'gaex',
    'operations.active_fulfillment_execution',
    'Active fulfillment execution'
  ),
  (
    'gash',
    'operations.active_shipment_group',
    'Active shipment group'
  ),
  (
    'gaca',
    'operations.active_carrier_group_attempt',
    'Active carrier group attempt'
  ),
  (
    'gapr',
    'operations.active_carrier_package_result',
    'Active carrier package result'
  )
ON CONFLICT (prefix) DO UPDATE SET
  entity_type = EXCLUDED.entity_type,
  display_name = EXCLUDED.display_name;

CREATE TABLE IF NOT EXISTS operations_active_fulfillment_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gaex'),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  shadow_fulfillment_execution_id uuid NOT NULL,
  order_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  authority_mode text NOT NULL CHECK (authority_mode = 'active'),
  state text NOT NULL CHECK (state = 'prepared'),
  activation_revision integer NOT NULL CHECK (activation_revision >= 1),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  prepared_by text REFERENCES app_users(email) ON DELETE SET NULL,
  prepared_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_active_fulfillment_executions_global_valid CHECK (
    global_id ~ '^gaex[0-9]{7}$'
  ),
  CONSTRAINT operations_active_fulfillment_executions_global_unique
    UNIQUE (global_id),
  CONSTRAINT operations_active_fulfillment_executions_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_active_fulfillment_executions_shadow_fkey
    FOREIGN KEY (organization_id, shadow_fulfillment_execution_id)
    REFERENCES operations_fulfillment_executions(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_active_fulfillment_executions_order_fkey
    FOREIGN KEY (organization_id, order_id)
    REFERENCES operations_orders(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_active_fulfillment_executions_plan_fkey
    FOREIGN KEY (organization_id, plan_id)
    REFERENCES operations_fulfillment_plans(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_active_fulfillment_executions_warehouse_fkey
    FOREIGN KEY (organization_id, warehouse_id)
    REFERENCES operations_warehouses(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_active_fulfillment_executions_org_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT operations_active_fulfillment_executions_shadow_unique
    UNIQUE (organization_id, shadow_fulfillment_execution_id),
  CONSTRAINT operations_active_fulfillment_executions_idempotency_unique
    UNIQUE (organization_id, idempotency_key),
  CONSTRAINT operations_active_fulfillment_executions_text_valid CHECK (
    length(btrim(idempotency_key)) BETWEEN 8 AND 200
    AND idempotency_key !~ '[[:cntrl:]]'
  )
);

CREATE TABLE IF NOT EXISTS operations_active_shipment_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gash'),
  organization_id uuid NOT NULL,
  active_fulfillment_execution_id uuid NOT NULL,
  shadow_shipment_group_id uuid NOT NULL,
  selected_provider text NOT NULL CHECK (
    selected_provider IN ('ups_rest', 'fedex_rest')
  ),
  selected_service_code text NOT NULL,
  selected_service_name text NOT NULL,
  selected_carrier_cost_minor bigint NOT NULL CHECK (
    selected_carrier_cost_minor >= 0
  ),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  package_count integer NOT NULL CHECK (package_count BETWEEN 1 AND 50),
  state text NOT NULL CHECK (state = 'prepared'),
  prepared_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_active_shipment_groups_global_valid CHECK (
    global_id ~ '^gash[0-9]{7}$'
  ),
  CONSTRAINT operations_active_shipment_groups_global_unique UNIQUE (
    global_id
  ),
  CONSTRAINT operations_active_shipment_groups_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_active_shipment_groups_execution_fkey
    FOREIGN KEY (organization_id, active_fulfillment_execution_id)
    REFERENCES operations_active_fulfillment_executions(
      organization_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_active_shipment_groups_shadow_group_fkey
    FOREIGN KEY (organization_id, shadow_shipment_group_id)
    REFERENCES operations_shipment_groups(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_active_shipment_groups_org_id_unique UNIQUE (
    organization_id, id
  ),
  CONSTRAINT operations_active_shipment_groups_execution_unique UNIQUE (
    organization_id, active_fulfillment_execution_id
  ),
  CONSTRAINT operations_active_shipment_groups_execution_id_unique UNIQUE (
    organization_id, active_fulfillment_execution_id, id
  ),
  CONSTRAINT operations_active_shipment_groups_text_valid CHECK (
    length(btrim(selected_service_code)) BETWEEN 1 AND 80
    AND selected_service_code !~ '[[:cntrl:]]'
    AND length(btrim(selected_service_name)) BETWEEN 1 AND 160
    AND selected_service_name !~ '[[:cntrl:]]'
  )
);

-- Packages inherit the one carrier/service choice from their shipment group.
-- Per-package provider or service columns are intentionally absent.
CREATE TABLE IF NOT EXISTS operations_active_execution_packages (
  organization_id uuid NOT NULL,
  active_fulfillment_execution_id uuid NOT NULL,
  active_shipment_group_id uuid NOT NULL,
  shadow_fulfillment_execution_id uuid NOT NULL,
  package_id uuid NOT NULL,
  package_key text NOT NULL,
  package_number integer NOT NULL CHECK (package_number > 0),
  PRIMARY KEY (
    organization_id, active_fulfillment_execution_id, package_id
  ),
  CONSTRAINT operations_active_execution_packages_execution_fkey
    FOREIGN KEY (organization_id, active_fulfillment_execution_id)
    REFERENCES operations_active_fulfillment_executions(
      organization_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_active_execution_packages_group_pair_fkey
    FOREIGN KEY (
      organization_id, active_fulfillment_execution_id,
      active_shipment_group_id
    )
    REFERENCES operations_active_shipment_groups(
      organization_id, active_fulfillment_execution_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_active_execution_packages_shadow_package_fkey
    FOREIGN KEY (
      organization_id, shadow_fulfillment_execution_id, package_id
    )
    REFERENCES operations_fulfillment_execution_packages(
      organization_id, execution_id, package_id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_active_execution_packages_group_package_unique
    UNIQUE (
      organization_id, active_fulfillment_execution_id,
      active_shipment_group_id, package_id
    ),
  CONSTRAINT operations_active_execution_packages_group_number_unique
    UNIQUE (
      organization_id, active_shipment_group_id, package_number
    ),
  CONSTRAINT operations_active_execution_packages_key_valid CHECK (
    length(btrim(package_key)) BETWEEN 1 AND 160
    AND package_key !~ '[[:cntrl:]]'
  )
);

-- This row is the durable prepare-before-dispatch boundary for the complete
-- package group. A known failure may be followed by a new, separately durable
-- attempt. A prepared, succeeded, or unknown attempt blocks another dispatch;
-- an unknown result can never be retried against the same group.
CREATE TABLE IF NOT EXISTS operations_active_carrier_group_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gaca'),
  organization_id uuid NOT NULL,
  active_fulfillment_execution_id uuid NOT NULL,
  active_shipment_group_id uuid NOT NULL,
  attempt_number integer NOT NULL CHECK (attempt_number >= 1),
  state text NOT NULL DEFAULT 'prepared' CHECK (
    state IN ('prepared', 'succeeded', 'failed', 'unknown')
  ),
  environment text NOT NULL CHECK (environment = 'production'),
  selected_provider text NOT NULL CHECK (
    selected_provider IN ('ups_rest', 'fedex_rest')
  ),
  selected_service_code text NOT NULL,
  selected_service_name text NOT NULL,
  package_count integer NOT NULL CHECK (package_count BETWEEN 1 AND 50),
  adapter_version text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  redacted_request jsonb NOT NULL,
  redacted_response jsonb NOT NULL DEFAULT '{}'::jsonb,
  provider_reference text,
  error_code text,
  actor_email text REFERENCES app_users(email) ON DELETE SET NULL,
  persisted_at timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_active_carrier_group_attempts_global_valid CHECK (
    global_id ~ '^gaca[0-9]{7}$'
  ),
  CONSTRAINT operations_active_carrier_group_attempts_global_unique UNIQUE (
    global_id
  ),
  CONSTRAINT operations_active_carrier_group_attempts_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_active_carrier_group_attempts_group_fkey
    FOREIGN KEY (
      organization_id, active_fulfillment_execution_id,
      active_shipment_group_id
    )
    REFERENCES operations_active_shipment_groups(
      organization_id, active_fulfillment_execution_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_active_carrier_group_attempts_org_id_unique UNIQUE (
    organization_id, id
  ),
  CONSTRAINT operations_active_carrier_group_attempts_lineage_unique UNIQUE (
    organization_id, id, active_fulfillment_execution_id,
    active_shipment_group_id
  ),
  CONSTRAINT operations_active_carrier_group_attempts_number_unique UNIQUE (
    organization_id, active_shipment_group_id, attempt_number
  ),
  CONSTRAINT operations_active_carrier_group_attempts_idempotency_unique
    UNIQUE (organization_id, idempotency_key),
  CONSTRAINT operations_active_carrier_group_attempts_text_valid CHECK (
    length(btrim(selected_service_code)) BETWEEN 1 AND 80
    AND selected_service_code !~ '[[:cntrl:]]'
    AND length(btrim(selected_service_name)) BETWEEN 1 AND 160
    AND selected_service_name !~ '[[:cntrl:]]'
    AND length(btrim(adapter_version)) BETWEEN 1 AND 100
    AND adapter_version !~ '[[:cntrl:]]'
    AND length(btrim(idempotency_key)) BETWEEN 8 AND 200
    AND idempotency_key !~ '[[:cntrl:]]'
  ),
  CONSTRAINT operations_active_carrier_group_attempts_completion_valid CHECK (
    (
      state = 'prepared'
      AND dispatched_at IS NULL
      AND completed_at IS NULL
      AND provider_reference IS NULL
      AND error_code IS NULL
    )
    OR (
      state = 'succeeded'
      AND dispatched_at IS NOT NULL
      AND completed_at IS NOT NULL
      AND provider_reference IS NOT NULL
      AND error_code IS NULL
    )
    OR (
      state = 'failed'
      AND dispatched_at IS NOT NULL
      AND completed_at IS NOT NULL
      AND provider_reference IS NULL
      AND error_code IS NOT NULL
    )
    OR (
      state = 'unknown'
      AND dispatched_at IS NOT NULL
      AND completed_at IS NOT NULL
      AND error_code IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX
  operations_active_carrier_group_attempts_open_unique
ON operations_active_carrier_group_attempts (
  organization_id, active_shipment_group_id
)
WHERE state IN ('prepared', 'succeeded', 'unknown');

CREATE TABLE IF NOT EXISTS operations_active_carrier_package_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gapr'),
  organization_id uuid NOT NULL,
  carrier_group_attempt_id uuid NOT NULL,
  active_fulfillment_execution_id uuid NOT NULL,
  active_shipment_group_id uuid NOT NULL,
  package_id uuid NOT NULL,
  package_number integer NOT NULL CHECK (package_number > 0),
  state text NOT NULL CHECK (state IN ('succeeded', 'unknown')),
  label_id uuid,
  shipment_id uuid,
  tracking_number text,
  provider_package_reference text,
  redacted_provider_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_active_carrier_package_results_global_valid CHECK (
    global_id ~ '^gapr[0-9]{7}$'
  ),
  CONSTRAINT operations_active_carrier_package_results_global_unique UNIQUE (
    global_id
  ),
  CONSTRAINT operations_active_carrier_package_results_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_active_carrier_package_results_attempt_fkey
    FOREIGN KEY (
      organization_id, carrier_group_attempt_id,
      active_fulfillment_execution_id, active_shipment_group_id
    )
    REFERENCES operations_active_carrier_group_attempts(
      organization_id, id, active_fulfillment_execution_id,
      active_shipment_group_id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_active_carrier_package_results_package_fkey
    FOREIGN KEY (
      organization_id, active_fulfillment_execution_id,
      active_shipment_group_id, package_id
    )
    REFERENCES operations_active_execution_packages(
      organization_id, active_fulfillment_execution_id,
      active_shipment_group_id, package_id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_active_carrier_package_results_label_fkey
    FOREIGN KEY (organization_id, label_id)
    REFERENCES operations_labels(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_active_carrier_package_results_shipment_fkey
    FOREIGN KEY (organization_id, shipment_id)
    REFERENCES operations_shipments(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_active_carrier_package_results_org_id_unique UNIQUE (
    organization_id, id
  ),
  CONSTRAINT operations_active_carrier_package_results_package_unique UNIQUE (
    organization_id, carrier_group_attempt_id, package_id
  ),
  CONSTRAINT operations_active_carrier_package_results_lineage_valid CHECK (
    (
      state = 'succeeded'
      AND label_id IS NOT NULL
      AND shipment_id IS NOT NULL
      AND tracking_number IS NOT NULL
      AND provider_package_reference IS NOT NULL
    )
    OR (
      state = 'unknown'
      AND label_id IS NULL
      AND shipment_id IS NULL
    )
  ),
  CONSTRAINT operations_active_carrier_package_results_text_valid CHECK (
    (tracking_number IS NULL OR (
      length(btrim(tracking_number)) BETWEEN 3 AND 160
      AND tracking_number !~ '[[:cntrl:]]'
    ))
    AND (provider_package_reference IS NULL OR (
      length(btrim(provider_package_reference)) BETWEEN 1 AND 200
      AND provider_package_reference !~ '[[:cntrl:]]'
    ))
  )
);

ALTER TABLE operations_label_attempts
  ADD COLUMN IF NOT EXISTS active_fulfillment_execution_id uuid,
  ADD COLUMN IF NOT EXISTS active_shipment_group_id uuid,
  ADD COLUMN IF NOT EXISTS active_carrier_group_attempt_id uuid;

ALTER TABLE operations_labels
  ADD COLUMN IF NOT EXISTS active_fulfillment_execution_id uuid,
  ADD COLUMN IF NOT EXISTS active_shipment_group_id uuid,
  ADD COLUMN IF NOT EXISTS active_carrier_group_attempt_id uuid;

ALTER TABLE operations_shipments
  ADD COLUMN IF NOT EXISTS active_fulfillment_execution_id uuid,
  ADD COLUMN IF NOT EXISTS active_shipment_group_id uuid,
  ADD COLUMN IF NOT EXISTS active_carrier_group_attempt_id uuid;

ALTER TABLE operations_label_attempts
  ADD CONSTRAINT operations_label_attempts_active_attempt_fkey
    FOREIGN KEY (
      organization_id, active_carrier_group_attempt_id,
      active_fulfillment_execution_id, active_shipment_group_id
    )
    REFERENCES operations_active_carrier_group_attempts(
      organization_id, id, active_fulfillment_execution_id,
      active_shipment_group_id
    ) ON DELETE RESTRICT,
  ADD CONSTRAINT operations_label_attempts_active_package_fkey
    FOREIGN KEY (
      organization_id, active_fulfillment_execution_id,
      active_shipment_group_id, package_id
    )
    REFERENCES operations_active_execution_packages(
      organization_id, active_fulfillment_execution_id,
      active_shipment_group_id, package_id
    ) ON DELETE RESTRICT,
  ADD CONSTRAINT operations_label_attempts_active_lineage_valid CHECK (
    (
      active_fulfillment_execution_id IS NULL
      AND active_shipment_group_id IS NULL
      AND active_carrier_group_attempt_id IS NULL
    )
    OR (
      active_fulfillment_execution_id IS NOT NULL
      AND active_shipment_group_id IS NOT NULL
      AND active_carrier_group_attempt_id IS NOT NULL
      AND fulfillment_execution_id IS NULL
      AND shipment_group_id IS NULL
    )
  );

ALTER TABLE operations_labels
  ADD CONSTRAINT operations_labels_active_attempt_fkey
    FOREIGN KEY (
      organization_id, active_carrier_group_attempt_id,
      active_fulfillment_execution_id, active_shipment_group_id
    )
    REFERENCES operations_active_carrier_group_attempts(
      organization_id, id, active_fulfillment_execution_id,
      active_shipment_group_id
    ) ON DELETE RESTRICT,
  ADD CONSTRAINT operations_labels_active_package_fkey
    FOREIGN KEY (
      organization_id, active_fulfillment_execution_id,
      active_shipment_group_id, package_id
    )
    REFERENCES operations_active_execution_packages(
      organization_id, active_fulfillment_execution_id,
      active_shipment_group_id, package_id
    ) ON DELETE RESTRICT,
  ADD CONSTRAINT operations_labels_active_lineage_valid CHECK (
    (
      active_fulfillment_execution_id IS NULL
      AND active_shipment_group_id IS NULL
      AND active_carrier_group_attempt_id IS NULL
    )
    OR (
      active_fulfillment_execution_id IS NOT NULL
      AND active_shipment_group_id IS NOT NULL
      AND active_carrier_group_attempt_id IS NOT NULL
      AND fulfillment_execution_id IS NULL
      AND shipment_group_id IS NULL
    )
  );

ALTER TABLE operations_shipments
  ADD CONSTRAINT operations_shipments_active_attempt_fkey
    FOREIGN KEY (
      organization_id, active_carrier_group_attempt_id,
      active_fulfillment_execution_id, active_shipment_group_id
    )
    REFERENCES operations_active_carrier_group_attempts(
      organization_id, id, active_fulfillment_execution_id,
      active_shipment_group_id
    ) ON DELETE RESTRICT,
  ADD CONSTRAINT operations_shipments_active_package_fkey
    FOREIGN KEY (
      organization_id, active_fulfillment_execution_id,
      active_shipment_group_id, package_id
    )
    REFERENCES operations_active_execution_packages(
      organization_id, active_fulfillment_execution_id,
      active_shipment_group_id, package_id
    ) ON DELETE RESTRICT,
  ADD CONSTRAINT operations_shipments_active_lineage_valid CHECK (
    (
      active_fulfillment_execution_id IS NULL
      AND active_shipment_group_id IS NULL
      AND active_carrier_group_attempt_id IS NULL
    )
    OR (
      active_fulfillment_execution_id IS NOT NULL
      AND active_shipment_group_id IS NOT NULL
      AND active_carrier_group_attempt_id IS NOT NULL
      AND fulfillment_execution_id IS NULL
      AND shipment_group_id IS NULL
    )
  );

CREATE OR REPLACE FUNCTION
  validate_operations_active_fulfillment_lineage_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  activation_state text;
  linked_label_environment text;
  linked_label_execution_id uuid;
  linked_label_group_id uuid;
  linked_label_attempt_id uuid;
  linked_attempt_state text;
  row_environment text;
BEGIN
  IF TG_OP = 'UPDATE' AND ROW(
    NEW.active_fulfillment_execution_id,
    NEW.active_shipment_group_id,
    NEW.active_carrier_group_attempt_id
  ) IS DISTINCT FROM ROW(
    OLD.active_fulfillment_execution_id,
    OLD.active_shipment_group_id,
    OLD.active_carrier_group_attempt_id
  ) THEN
    RAISE EXCEPTION 'Active fulfillment carrier-write lineage is immutable';
  END IF;

  SELECT activation.state INTO activation_state
  FROM operations_activation_scopes activation
  WHERE activation.organization_id = NEW.organization_id;

  -- This trigger is shared by label-attempt, label, and shipment rows. Only
  -- the first two expose an environment column, so resolve it without a
  -- record-field access that is invalid for operations_shipments.
  row_environment := to_jsonb(NEW)->>'environment';

  IF TG_TABLE_NAME IN ('operations_label_attempts', 'operations_labels')
     AND row_environment = 'production'
     AND activation_state IS DISTINCT FROM 'active'
  THEN
    RAISE EXCEPTION
      'Production carrier label writes require Operations Active';
  END IF;

  IF TG_TABLE_NAME = 'operations_shipments' THEN
    SELECT
      label.environment,
      label.active_fulfillment_execution_id,
      label.active_shipment_group_id,
      label.active_carrier_group_attempt_id
    INTO
      linked_label_environment,
      linked_label_execution_id,
      linked_label_group_id,
      linked_label_attempt_id
    FROM operations_labels label
    WHERE label.organization_id = NEW.organization_id
      AND label.id = NEW.label_id;
    IF linked_label_environment = 'production'
       AND activation_state IS DISTINCT FROM 'active'
    THEN
      RAISE EXCEPTION
        'Production shipment writes require Operations Active';
    END IF;
  END IF;

  IF NEW.active_fulfillment_execution_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF activation_state IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION
      'Active fulfillment carrier-write lineage requires Operations Active';
  END IF;
  IF TG_TABLE_NAME IN ('operations_label_attempts', 'operations_labels')
     AND row_environment IS DISTINCT FROM 'production'
  THEN
    RAISE EXCEPTION
      'Active fulfillment carrier-write lineage requires production evidence';
  END IF;
  IF TG_TABLE_NAME = 'operations_shipments' AND (
    linked_label_environment IS DISTINCT FROM 'production'
    OR linked_label_execution_id
      IS DISTINCT FROM NEW.active_fulfillment_execution_id
    OR linked_label_group_id
      IS DISTINCT FROM NEW.active_shipment_group_id
    OR linked_label_attempt_id
      IS DISTINCT FROM NEW.active_carrier_group_attempt_id
  ) THEN
    RAISE EXCEPTION
      'Active shipment lineage must match its production label';
  END IF;

  SELECT attempt.state INTO linked_attempt_state
  FROM operations_active_carrier_group_attempts attempt
  JOIN operations_active_fulfillment_executions execution
    ON execution.organization_id = attempt.organization_id
   AND execution.id = attempt.active_fulfillment_execution_id
  WHERE attempt.organization_id = NEW.organization_id
    AND attempt.id = NEW.active_carrier_group_attempt_id
    AND attempt.active_fulfillment_execution_id
      = NEW.active_fulfillment_execution_id
    AND attempt.active_shipment_group_id = NEW.active_shipment_group_id
    AND execution.authority_mode = 'active';
  IF linked_attempt_state IS NULL THEN
    RAISE EXCEPTION 'Active carrier group attempt lineage was not found';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER validate_operations_label_attempt_active_lineage
BEFORE INSERT OR UPDATE ON operations_label_attempts
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_active_fulfillment_lineage_write();

CREATE TRIGGER validate_operations_label_active_lineage
BEFORE INSERT OR UPDATE ON operations_labels
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_active_fulfillment_lineage_write();

CREATE TRIGGER validate_operations_shipment_active_lineage
BEFORE INSERT OR UPDATE ON operations_shipments
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_active_fulfillment_lineage_write();

CREATE OR REPLACE FUNCTION
  validate_operations_active_execution_prepare()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  activation_state text;
  current_activation_revision integer;
  shadow_execution operations_fulfillment_executions%ROWTYPE;
  shadow_group operations_shipment_groups%ROWTYPE;
BEGIN
  SELECT activation.state, activation.revision
    INTO activation_state, current_activation_revision
  FROM operations_activation_scopes activation
  WHERE activation.organization_id = NEW.organization_id;
  IF activation_state IS DISTINCT FROM 'active'
     OR current_activation_revision IS DISTINCT FROM NEW.activation_revision
  THEN
    RAISE EXCEPTION
      'Active fulfillment execution requires the current Operations Active revision';
  END IF;

  SELECT * INTO shadow_execution
  FROM operations_fulfillment_executions execution
  WHERE execution.organization_id = NEW.organization_id
    AND execution.id = NEW.shadow_fulfillment_execution_id;
  SELECT * INTO shadow_group
  FROM operations_shipment_groups shipment_group
  WHERE shipment_group.organization_id = NEW.organization_id
    AND shipment_group.fulfillment_execution_id
      = NEW.shadow_fulfillment_execution_id;
  IF shadow_execution.id IS NULL
     OR shadow_execution.authority_mode IS DISTINCT FROM 'shadow'
     OR shadow_execution.state IS DISTINCT FROM 'shadow_prepared'
     OR shadow_execution.order_id IS DISTINCT FROM NEW.order_id
     OR shadow_execution.plan_id IS DISTINCT FROM NEW.plan_id
     OR shadow_group.warehouse_id IS DISTINCT FROM NEW.warehouse_id
  THEN
    RAISE EXCEPTION
      'Active execution must reference one exact immutable Shadow preparation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER validate_operations_active_execution_prepare_trigger
BEFORE INSERT ON operations_active_fulfillment_executions
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_active_execution_prepare();

CREATE OR REPLACE FUNCTION
  protect_operations_active_execution_request_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'Active fulfillment execution request evidence is immutable';
END;
$$;

CREATE TRIGGER protect_operations_active_execution_mutation
BEFORE UPDATE OR DELETE ON operations_active_fulfillment_executions
FOR EACH ROW EXECUTE FUNCTION
  protect_operations_active_execution_request_immutable();

CREATE TRIGGER protect_operations_active_shipment_group_mutation
BEFORE UPDATE OR DELETE ON operations_active_shipment_groups
FOR EACH ROW EXECUTE FUNCTION
  protect_operations_active_execution_request_immutable();

CREATE TRIGGER protect_operations_active_execution_package_mutation
BEFORE UPDATE OR DELETE ON operations_active_execution_packages
FOR EACH ROW EXECUTE FUNCTION
  protect_operations_active_execution_request_immutable();

CREATE OR REPLACE FUNCTION
  protect_operations_active_carrier_group_attempt()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'Active carrier group attempts are immutable and cannot be deleted';
  END IF;
  IF ROW(
    NEW.global_id,
    NEW.organization_id,
    NEW.active_fulfillment_execution_id,
    NEW.active_shipment_group_id,
    NEW.attempt_number,
    NEW.environment,
    NEW.selected_provider,
    NEW.selected_service_code,
    NEW.selected_service_name,
    NEW.package_count,
    NEW.adapter_version,
    NEW.idempotency_key,
    NEW.request_hash,
    NEW.redacted_request,
    NEW.actor_email,
    NEW.persisted_at,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.global_id,
    OLD.organization_id,
    OLD.active_fulfillment_execution_id,
    OLD.active_shipment_group_id,
    OLD.attempt_number,
    OLD.environment,
    OLD.selected_provider,
    OLD.selected_service_code,
    OLD.selected_service_name,
    OLD.package_count,
    OLD.adapter_version,
    OLD.idempotency_key,
    OLD.request_hash,
    OLD.redacted_request,
    OLD.actor_email,
    OLD.persisted_at,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION
      'Active carrier group attempt identity and request are immutable';
  END IF;
  IF OLD.state <> 'prepared' THEN
    RAISE EXCEPTION
      'Terminal Active carrier group attempt cannot be retried or changed';
  END IF;
  IF NEW.state = 'prepared' OR NEW.completed_at IS NULL THEN
    RAISE EXCEPTION
      'Active carrier group attempt must finalize exactly once';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION
  validate_operations_active_carrier_group_attempt_prepare()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  activation_state text;
  shipment_group operations_active_shipment_groups%ROWTYPE;
  prior_attempt_state text;
  expected_attempt_number integer;
BEGIN
  SELECT activation.state INTO activation_state
  FROM operations_activation_scopes activation
  WHERE activation.organization_id = NEW.organization_id;
  IF activation_state IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION
      'Active carrier group attempt requires Operations Active';
  END IF;

  SELECT * INTO shipment_group
  FROM operations_active_shipment_groups candidate
  WHERE candidate.organization_id = NEW.organization_id
    AND candidate.id = NEW.active_shipment_group_id
    AND candidate.active_fulfillment_execution_id
      = NEW.active_fulfillment_execution_id;
  IF shipment_group.id IS NULL
     OR NEW.selected_provider
       IS DISTINCT FROM shipment_group.selected_provider
     OR NEW.selected_service_code
       IS DISTINCT FROM shipment_group.selected_service_code
     OR NEW.selected_service_name
       IS DISTINCT FROM shipment_group.selected_service_name
     OR NEW.package_count IS DISTINCT FROM shipment_group.package_count
  THEN
    RAISE EXCEPTION
      'Active carrier attempt must use its exact shipment-group service and package count';
  END IF;

  SELECT attempt.state, attempt.attempt_number + 1
    INTO prior_attempt_state, expected_attempt_number
  FROM operations_active_carrier_group_attempts attempt
  WHERE attempt.organization_id = NEW.organization_id
    AND attempt.active_shipment_group_id = NEW.active_shipment_group_id
  ORDER BY attempt.attempt_number DESC
  LIMIT 1;
  expected_attempt_number := COALESCE(expected_attempt_number, 1);
  IF prior_attempt_state IS NOT NULL AND prior_attempt_state <> 'failed' THEN
    RAISE EXCEPTION
      'Prepared, succeeded, or unknown Active carrier attempt cannot be retried';
  END IF;
  IF NEW.attempt_number <> expected_attempt_number THEN
    RAISE EXCEPTION
      'Active carrier group attempt number must be consecutive';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER
  validate_operations_active_carrier_group_attempt_prepare_trigger
BEFORE INSERT ON operations_active_carrier_group_attempts
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_active_carrier_group_attempt_prepare();

CREATE TRIGGER protect_operations_active_carrier_group_attempt_write
BEFORE UPDATE OR DELETE ON operations_active_carrier_group_attempts
FOR EACH ROW EXECUTE FUNCTION
  protect_operations_active_carrier_group_attempt();

CREATE TRIGGER protect_operations_active_carrier_package_result_mutation
BEFORE UPDATE OR DELETE ON operations_active_carrier_package_results
FOR EACH ROW EXECUTE FUNCTION
  protect_operations_active_execution_request_immutable();

CREATE OR REPLACE FUNCTION
  validate_operations_active_execution_complete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  execution operations_active_fulfillment_executions%ROWTYPE;
  shipment_group operations_active_shipment_groups%ROWTYPE;
  shadow_group operations_shipment_groups%ROWTYPE;
  carrier_attempt operations_active_carrier_group_attempts%ROWTYPE;
  package_rows bigint;
  shadow_package_rows bigint;
  package_mismatch_rows bigint;
  result_rows bigint;
  result_mismatch_rows bigint;
  label_rows bigint;
  shipment_rows bigint;
BEGIN
  IF TG_TABLE_NAME = 'operations_active_fulfillment_executions' THEN
    execution := NEW;
  ELSIF TG_TABLE_NAME = 'operations_active_shipment_groups' THEN
    SELECT * INTO execution
    FROM operations_active_fulfillment_executions candidate
    WHERE candidate.organization_id = NEW.organization_id
      AND candidate.id = NEW.active_fulfillment_execution_id;
  ELSIF TG_TABLE_NAME IN (
    'operations_active_carrier_group_attempts',
    'operations_active_carrier_package_results',
    'operations_label_attempts',
    'operations_labels',
    'operations_shipments'
  ) THEN
    IF NEW.active_fulfillment_execution_id IS NULL THEN
      RETURN NULL;
    END IF;
    SELECT * INTO execution
    FROM operations_active_fulfillment_executions candidate
    WHERE candidate.organization_id = NEW.organization_id
      AND candidate.id = NEW.active_fulfillment_execution_id;
  ELSE
    SELECT * INTO execution
    FROM operations_active_fulfillment_executions candidate
    WHERE candidate.organization_id = NEW.organization_id
      AND candidate.id = NEW.active_fulfillment_execution_id;
  END IF;
  IF execution.id IS NULL THEN
    RAISE EXCEPTION 'Active fulfillment execution was not found';
  END IF;

  SELECT * INTO shipment_group
  FROM operations_active_shipment_groups candidate
  WHERE candidate.organization_id = execution.organization_id
    AND candidate.active_fulfillment_execution_id = execution.id;
  SELECT * INTO shadow_group
  FROM operations_shipment_groups candidate
  WHERE candidate.organization_id = execution.organization_id
    AND candidate.fulfillment_execution_id
      = execution.shadow_fulfillment_execution_id;
  SELECT * INTO carrier_attempt
  FROM operations_active_carrier_group_attempts candidate
  WHERE candidate.organization_id = execution.organization_id
    AND candidate.active_fulfillment_execution_id = execution.id
  ORDER BY candidate.attempt_number DESC
  LIMIT 1;

  SELECT count(*) INTO package_rows
  FROM operations_active_execution_packages package
  WHERE package.organization_id = execution.organization_id
    AND package.active_fulfillment_execution_id = execution.id;
  SELECT count(*) INTO shadow_package_rows
  FROM operations_fulfillment_execution_packages package
  WHERE package.organization_id = execution.organization_id
    AND package.execution_id = execution.shadow_fulfillment_execution_id;
  SELECT count(*) INTO package_mismatch_rows
  FROM (
    (
      SELECT package_id, package_key
      FROM operations_active_execution_packages
      WHERE organization_id = execution.organization_id
        AND active_fulfillment_execution_id = execution.id
      EXCEPT
      SELECT package_id, package_key
      FROM operations_fulfillment_execution_packages
      WHERE organization_id = execution.organization_id
        AND execution_id = execution.shadow_fulfillment_execution_id
    )
    UNION ALL
    (
      SELECT package_id, package_key
      FROM operations_fulfillment_execution_packages
      WHERE organization_id = execution.organization_id
        AND execution_id = execution.shadow_fulfillment_execution_id
      EXCEPT
      SELECT package_id, package_key
      FROM operations_active_execution_packages
      WHERE organization_id = execution.organization_id
        AND active_fulfillment_execution_id = execution.id
    )
  ) mismatch;

  IF shipment_group.id IS NULL
     OR shadow_group.id IS NULL
     OR carrier_attempt.id IS NULL
     OR shipment_group.shadow_shipment_group_id
       IS DISTINCT FROM shadow_group.id
     OR shipment_group.selected_provider
       IS DISTINCT FROM shadow_group.selected_provider
     OR shipment_group.selected_service_code
       IS DISTINCT FROM shadow_group.selected_service_code
     OR shipment_group.selected_service_name
       IS DISTINCT FROM shadow_group.selected_service_name
     OR shipment_group.selected_carrier_cost_minor
       IS DISTINCT FROM shadow_group.selected_carrier_cost_minor
     OR shipment_group.currency IS DISTINCT FROM shadow_group.currency
     OR shipment_group.package_count <> package_rows
     OR package_rows <> shadow_package_rows
     OR package_mismatch_rows <> 0
     OR carrier_attempt.active_shipment_group_id
       IS DISTINCT FROM shipment_group.id
     OR carrier_attempt.selected_provider
       IS DISTINCT FROM shipment_group.selected_provider
     OR carrier_attempt.selected_service_code
       IS DISTINCT FROM shipment_group.selected_service_code
     OR carrier_attempt.selected_service_name
       IS DISTINCT FROM shipment_group.selected_service_name
     OR carrier_attempt.package_count <> shipment_group.package_count
  THEN
    RAISE EXCEPTION
      'Active execution requires one exact Shadow-derived package group, service, and durable carrier attempt';
  END IF;

  SELECT count(*) INTO result_rows
  FROM operations_active_carrier_package_results result
  WHERE result.organization_id = execution.organization_id
    AND result.carrier_group_attempt_id = carrier_attempt.id;
  SELECT count(*) INTO result_mismatch_rows
  FROM operations_active_carrier_package_results result
  JOIN operations_labels label
    ON label.organization_id = result.organization_id
   AND label.id = result.label_id
  JOIN operations_shipments shipment
    ON shipment.organization_id = result.organization_id
   AND shipment.id = result.shipment_id
  WHERE result.organization_id = execution.organization_id
    AND result.carrier_group_attempt_id = carrier_attempt.id
    AND (
      result.state <> 'succeeded'
      OR label.package_id <> result.package_id
      OR shipment.package_id <> result.package_id
      OR shipment.label_id <> result.label_id
      OR label.tracking_number <> result.tracking_number
      OR shipment.tracking_number <> result.tracking_number
      OR label.service_code <> shipment_group.selected_service_code
      OR label.active_carrier_group_attempt_id <> carrier_attempt.id
      OR shipment.active_carrier_group_attempt_id <> carrier_attempt.id
    );
  SELECT count(*) INTO label_rows
  FROM operations_labels label
  WHERE label.organization_id = execution.organization_id
    AND label.active_fulfillment_execution_id = execution.id
    AND label.status = 'created';
  SELECT count(*) INTO shipment_rows
  FROM operations_shipments shipment
  WHERE shipment.organization_id = execution.organization_id
    AND shipment.active_fulfillment_execution_id = execution.id
    AND shipment.status <> 'voided';

  IF carrier_attempt.state = 'prepared' AND (
    result_rows <> 0 OR label_rows <> 0 OR shipment_rows <> 0
  ) THEN
    RAISE EXCEPTION
      'Prepared Active attempt cannot retain provider results';
  END IF;
  IF carrier_attempt.state = 'failed' AND (
    result_rows <> 0 OR label_rows <> 0 OR shipment_rows <> 0
  ) THEN
    RAISE EXCEPTION
      'Failed Active attempt cannot retain label or shipment results';
  END IF;
  IF carrier_attempt.state = 'succeeded' AND (
    result_rows <> shipment_group.package_count
    OR label_rows <> shipment_group.package_count
    OR shipment_rows <> shipment_group.package_count
    OR result_mismatch_rows <> 0
  ) THEN
    RAISE EXCEPTION
      'Succeeded Active attempt requires one matching label and shipment for every package';
  END IF;
  IF carrier_attempt.state = 'unknown' AND (
    result_rows <> 0 OR label_rows <> 0 OR shipment_rows <> 0
  ) THEN
    RAISE EXCEPTION
      'Unknown Active attempt requires reconciliation and cannot retain assumed package results';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER
  validate_operations_active_execution_deferred
AFTER INSERT OR UPDATE
ON operations_active_fulfillment_executions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_active_execution_complete();

CREATE CONSTRAINT TRIGGER
  validate_operations_active_shipment_group_deferred
AFTER INSERT OR UPDATE
ON operations_active_shipment_groups
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_active_execution_complete();

CREATE CONSTRAINT TRIGGER
  validate_operations_active_package_deferred
AFTER INSERT OR UPDATE
ON operations_active_execution_packages
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_active_execution_complete();

CREATE CONSTRAINT TRIGGER
  validate_operations_active_carrier_attempt_deferred
AFTER INSERT OR UPDATE
ON operations_active_carrier_group_attempts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_active_execution_complete();

CREATE CONSTRAINT TRIGGER
  validate_operations_active_package_result_deferred
AFTER INSERT OR UPDATE
ON operations_active_carrier_package_results
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_active_execution_complete();

CREATE CONSTRAINT TRIGGER validate_operations_active_label_deferred
AFTER INSERT OR UPDATE ON operations_labels
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_active_execution_complete();

CREATE CONSTRAINT TRIGGER validate_operations_active_shipment_deferred
AFTER INSERT OR UPDATE ON operations_shipments
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_active_execution_complete();

COMMENT ON TABLE operations_active_fulfillment_executions IS
  'Separate Active authority derived from one immutable 0177 Shadow execution. Creating a row requires Operations Active at the exact activation revision.';
COMMENT ON TABLE operations_active_shipment_groups IS
  'One single-warehouse shipment group with one selected carrier and service inherited by every package.';
COMMENT ON TABLE operations_active_carrier_group_attempts IS
  'Durable prepare-before-dispatch record for one whole-shipment provider call. Known failures can create a consecutive attempt; prepared, succeeded, and unknown outcomes block retry.';
COMMENT ON TABLE operations_active_carrier_package_results IS
  'Per-package label and shipment lineage returned by one whole-shipment carrier group attempt.';
