-- Exact-order Shadow training overlay.
--
-- Training deliberately leaves the canonical commerce order in its provider-
-- mirrored state. These tables contain local simulation state only. They must
-- never be used as reservation, inventory, packaging-stock, shipment, postage,
-- or commerce-export authority.

INSERT INTO global_reference_entity_types (prefix, entity_type, display_name)
VALUES
  ('gtrn', 'operations.shadow_training_run', 'Shadow training run'),
  ('gtpk', 'operations.shadow_training_package', 'Shadow training package'),
  ('gtpt', 'operations.shadow_training_pick_task', 'Shadow training pick task'),
  ('gtll', 'operations.shadow_training_label_link', 'Shadow training label link'),
  ('gtev', 'operations.shadow_training_event', 'Shadow training event')
ON CONFLICT (prefix) DO UPDATE SET
  entity_type = EXCLUDED.entity_type,
  display_name = EXCLUDED.display_name;

CREATE TABLE IF NOT EXISTS operations_shadow_training_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gtrn'),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  source_order_id uuid NOT NULL,
  integration_account_id uuid NOT NULL,
  source_candidate_id uuid NOT NULL,
  generation integer NOT NULL CHECK (generation > 0),
  provider text NOT NULL CHECK (provider IN ('shopify', 'faire')),
  account_environment text NOT NULL
    CHECK (account_environment IN ('sandbox', 'production')),
  authorization_activation_revision integer NOT NULL
    CHECK (authorization_activation_revision > 0),
  authorization_order_row_version bigint NOT NULL
    CHECK (authorization_order_row_version >= 0),
  authorization_candidate_row_version bigint NOT NULL
    CHECK (authorization_candidate_row_version >= 0),
  authorization_candidate_source_hash text NOT NULL
    CHECK (authorization_candidate_source_hash ~ '^[a-f0-9]{64}$'),
  authorization_credential_generation integer NOT NULL
    CHECK (authorization_credential_generation >= 0),
  authorization_idempotency_key text NOT NULL CHECK (
    length(btrim(authorization_idempotency_key)) BETWEEN 8 AND 200
    AND authorization_idempotency_key !~ '[[:cntrl:]]'
  ),
  authorization_request_hash text NOT NULL
    CHECK (authorization_request_hash ~ '^[a-f0-9]{64}$'),
  authorization_reason text NOT NULL CHECK (
    length(btrim(authorization_reason)) BETWEEN 1 AND 500
    AND authorization_reason !~ '[[:cntrl:]]'
  ),
  authorized_by text NOT NULL REFERENCES app_users(email) ON DELETE RESTRICT,
  authorized_at timestamptz NOT NULL DEFAULT now(),
  source_snapshot jsonb NOT NULL,
  source_snapshot_sha256 text NOT NULL
    CHECK (source_snapshot_sha256 ~ '^[a-f0-9]{64}$'),
  cartonization_evidence_id uuid,
  cartonization_evidence_global_id text,
  cartonization_evidence_sha256 text,
  warehouse_id uuid,
  state text NOT NULL DEFAULT 'enabled' CHECK (state IN (
    'enabled', 'planned', 'released', 'picked', 'packed', 'labeled',
    'completed', 'reset', 'reset_blocked'
  )),
  commerce_provider_read_count integer NOT NULL DEFAULT 0
    CHECK (commerce_provider_read_count >= 0),
  commerce_provider_write_count integer NOT NULL DEFAULT 0
    CHECK (commerce_provider_write_count = 0),
  carrier_sandbox_write_count integer NOT NULL DEFAULT 0
    CHECK (carrier_sandbox_write_count >= 0),
  production_postage_count integer NOT NULL DEFAULT 0
    CHECK (production_postage_count = 0),
  inventory_mutation_count integer NOT NULL DEFAULT 0
    CHECK (inventory_mutation_count = 0),
  packaging_stock_mutation_count integer NOT NULL DEFAULT 0
    CHECK (packaging_stock_mutation_count = 0),
  row_version bigint NOT NULL DEFAULT 0 CHECK (row_version >= 0),
  completed_at timestamptz,
  reset_at timestamptz,
  reset_reason text,
  reset_blocker_code text,
  updated_by text NOT NULL REFERENCES app_users(email) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_shadow_training_runs_global_valid
    CHECK (global_id ~ '^gtrn([0-9]{7}|[0-9a-v]{12})$'),
  CONSTRAINT operations_shadow_training_runs_global_unique UNIQUE (global_id),
  CONSTRAINT operations_shadow_training_runs_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_shadow_training_runs_order_fkey
    FOREIGN KEY (organization_id, source_order_id)
    REFERENCES operations_orders(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_shadow_training_runs_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_shadow_training_runs_candidate_fkey
    FOREIGN KEY (
      organization_id, integration_account_id, source_candidate_id
    ) REFERENCES operations_commerce_order_candidates(
      organization_id, integration_account_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_shadow_training_runs_evidence_fkey
    FOREIGN KEY (organization_id, cartonization_evidence_id)
    REFERENCES operations_cartonization_rate_evidence(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_shadow_training_runs_warehouse_fkey
    FOREIGN KEY (organization_id, warehouse_id)
    REFERENCES operations_warehouses(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_shadow_training_runs_org_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT operations_shadow_training_runs_generation_unique
    UNIQUE (organization_id, source_order_id, generation),
  CONSTRAINT operations_shadow_training_runs_authorization_key_unique
    UNIQUE (organization_id, authorization_idempotency_key),
  CONSTRAINT operations_shadow_training_runs_snapshot_valid CHECK (
    jsonb_typeof(source_snapshot) = 'object'
  ),
  CONSTRAINT operations_shadow_training_runs_evidence_valid CHECK (
    (
      state = 'enabled'
      AND cartonization_evidence_id IS NULL
      AND cartonization_evidence_global_id IS NULL
      AND cartonization_evidence_sha256 IS NULL
      AND warehouse_id IS NULL
    )
    OR (
      state = 'reset'
      AND (
        (
          cartonization_evidence_id IS NULL
          AND cartonization_evidence_global_id IS NULL
          AND cartonization_evidence_sha256 IS NULL
          AND warehouse_id IS NULL
        )
        OR (
          cartonization_evidence_id IS NOT NULL
          AND cartonization_evidence_global_id ~ '^gcte([0-9]{7}|[0-9a-v]{12})$'
          AND cartonization_evidence_sha256 ~ '^[a-f0-9]{64}$'
          AND warehouse_id IS NOT NULL
        )
      )
    )
    OR (
      state NOT IN ('enabled', 'reset')
      AND cartonization_evidence_id IS NOT NULL
      AND cartonization_evidence_global_id ~ '^gcte([0-9]{7}|[0-9a-v]{12})$'
      AND cartonization_evidence_sha256 ~ '^[a-f0-9]{64}$'
      AND warehouse_id IS NOT NULL
    )
  ),
  CONSTRAINT operations_shadow_training_runs_terminal_valid CHECK (
    (state = 'completed' AND completed_at IS NOT NULL)
    OR (state IN ('reset', 'reset_blocked'))
    OR (state NOT IN ('completed', 'reset', 'reset_blocked') AND completed_at IS NULL)
  ),
  CONSTRAINT operations_shadow_training_runs_reset_valid CHECK (
    (
      state = 'reset'
      AND reset_at IS NOT NULL
      AND reset_reason IS NOT NULL
      AND length(btrim(reset_reason)) BETWEEN 1 AND 500
      AND reset_blocker_code IS NULL
    )
    OR (
      state = 'reset_blocked'
      AND reset_at IS NULL
      AND reset_reason IS NULL
      AND reset_blocker_code IS NOT NULL
      AND length(btrim(reset_blocker_code)) BETWEEN 1 AND 120
    )
    OR (
      state NOT IN ('reset', 'reset_blocked')
      AND reset_at IS NULL
      AND reset_reason IS NULL
      AND reset_blocker_code IS NULL
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS
  operations_shadow_training_runs_one_open_order
ON operations_shadow_training_runs (organization_id, source_order_id)
WHERE state <> 'reset';

CREATE INDEX IF NOT EXISTS operations_shadow_training_runs_order_history
ON operations_shadow_training_runs (
  organization_id, source_order_id, generation DESC, created_at DESC
);

CREATE TABLE IF NOT EXISTS operations_shadow_training_packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gtpk'),
  organization_id uuid NOT NULL,
  training_run_id uuid NOT NULL,
  package_sequence integer NOT NULL CHECK (package_sequence > 0),
  evidence_package_key text NOT NULL CHECK (
    length(btrim(evidence_package_key)) BETWEEN 1 AND 80
    AND evidence_package_key !~ '[[:cntrl:]]'
  ),
  packaging_material_global_id text NOT NULL
    CHECK (packaging_material_global_id ~ '^gmat([0-9]{7}|[0-9a-v]{12})$'),
  packaging_material_name text NOT NULL CHECK (
    length(btrim(packaging_material_name)) BETWEEN 1 AND 255
    AND packaging_material_name !~ '[[:cntrl:]]'
  ),
  rated_outer_dimensions_mm jsonb NOT NULL,
  content_weight_grams integer NOT NULL CHECK (content_weight_grams > 0),
  tare_weight_grams integer NOT NULL CHECK (tare_weight_grams > 0),
  rated_gross_weight_grams integer NOT NULL
    CHECK (rated_gross_weight_grams > 0),
  allocations jsonb NOT NULL,
  source_package_hash text NOT NULL CHECK (source_package_hash ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned', 'packed', 'labeled', 'completed')),
  packed_by text REFERENCES app_users(email) ON DELETE RESTRICT,
  packed_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_shadow_training_packages_global_valid
    CHECK (global_id ~ '^gtpk([0-9]{7}|[0-9a-v]{12})$'),
  CONSTRAINT operations_shadow_training_packages_global_unique UNIQUE (global_id),
  CONSTRAINT operations_shadow_training_packages_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_shadow_training_packages_run_fkey
    FOREIGN KEY (organization_id, training_run_id)
    REFERENCES operations_shadow_training_runs(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_shadow_training_packages_org_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT operations_shadow_training_packages_run_id_unique
    UNIQUE (organization_id, training_run_id, id),
  CONSTRAINT operations_shadow_training_packages_sequence_unique
    UNIQUE (training_run_id, package_sequence),
  CONSTRAINT operations_shadow_training_packages_key_unique
    UNIQUE (training_run_id, evidence_package_key),
  CONSTRAINT operations_shadow_training_packages_dimensions_valid CHECK (
    operations_cartonization_dimensions_mm_valid(rated_outer_dimensions_mm)
  ),
  CONSTRAINT operations_shadow_training_packages_allocations_valid CHECK (
    operations_cartonization_allocations_valid(allocations)
  ),
  CONSTRAINT operations_shadow_training_packages_status_valid CHECK (
    (status = 'planned' AND packed_by IS NULL AND packed_at IS NULL AND completed_at IS NULL)
    OR (status IN ('packed', 'labeled') AND packed_by IS NOT NULL AND packed_at IS NOT NULL AND completed_at IS NULL)
    OR (status = 'completed' AND packed_by IS NOT NULL AND packed_at IS NOT NULL AND completed_at IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS operations_shadow_training_pick_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gtpt'),
  organization_id uuid NOT NULL,
  training_run_id uuid NOT NULL,
  training_package_id uuid NOT NULL,
  task_sequence integer NOT NULL CHECK (task_sequence > 0),
  source_line_global_id text NOT NULL
    CHECK (source_line_global_id ~ '^(gcol|gcal)([0-9]{7}|[0-9a-v]{12})$'),
  product_global_id text NOT NULL
    CHECK (product_global_id ~ '^gp([0-9]{7}|[0-9a-v]{12})$'),
  title text NOT NULL CHECK (
    length(btrim(title)) BETWEEN 1 AND 512 AND title !~ '[[:cntrl:]]'
  ),
  quantity numeric(20,6) NOT NULL CHECK (quantity > 0),
  status text NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'picked')),
  picked_by text REFERENCES app_users(email) ON DELETE RESTRICT,
  picked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_shadow_training_pick_tasks_global_valid
    CHECK (global_id ~ '^gtpt([0-9]{7}|[0-9a-v]{12})$'),
  CONSTRAINT operations_shadow_training_pick_tasks_global_unique UNIQUE (global_id),
  CONSTRAINT operations_shadow_training_pick_tasks_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_shadow_training_pick_tasks_run_fkey
    FOREIGN KEY (organization_id, training_run_id)
    REFERENCES operations_shadow_training_runs(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_shadow_training_pick_tasks_package_fkey
    FOREIGN KEY (organization_id, training_run_id, training_package_id)
    REFERENCES operations_shadow_training_packages(
      organization_id, training_run_id, id
    )
    ON DELETE RESTRICT,
  CONSTRAINT operations_shadow_training_pick_tasks_org_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT operations_shadow_training_pick_tasks_run_id_unique
    UNIQUE (organization_id, training_run_id, id),
  CONSTRAINT operations_shadow_training_pick_tasks_sequence_unique
    UNIQUE (training_run_id, task_sequence),
  CONSTRAINT operations_shadow_training_pick_tasks_allocation_unique
    UNIQUE (training_run_id, training_package_id, source_line_global_id),
  CONSTRAINT operations_shadow_training_pick_tasks_status_valid CHECK (
    (status = 'ready' AND picked_by IS NULL AND picked_at IS NULL)
    OR (status = 'picked' AND picked_by IS NOT NULL AND picked_at IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS operations_shadow_training_label_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gtll'),
  organization_id uuid NOT NULL,
  training_run_id uuid NOT NULL,
  training_package_id uuid NOT NULL,
  carrier_rate_test_label_id uuid,
  print_job_id uuid,
  carrier_environment text NOT NULL DEFAULT 'sandbox'
    CHECK (carrier_environment = 'sandbox'),
  status text NOT NULL CHECK (status IN (
    'create_prepared', 'create_unknown', 'create_reconciled_none',
    'created', 'print_queued', 'printed', 'void_unknown', 'voided'
  )),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_shadow_training_label_links_global_valid
    CHECK (global_id ~ '^gtll([0-9]{7}|[0-9a-v]{12})$'),
  CONSTRAINT operations_shadow_training_label_links_global_unique UNIQUE (global_id),
  CONSTRAINT operations_shadow_training_label_links_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_shadow_training_label_links_run_fkey
    FOREIGN KEY (organization_id, training_run_id)
    REFERENCES operations_shadow_training_runs(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_shadow_training_label_links_package_fkey
    FOREIGN KEY (organization_id, training_run_id, training_package_id)
    REFERENCES operations_shadow_training_packages(
      organization_id, training_run_id, id
    )
    ON DELETE RESTRICT,
  CONSTRAINT operations_shadow_training_label_links_label_fkey
    FOREIGN KEY (organization_id, carrier_rate_test_label_id)
    REFERENCES operations_carrier_rate_test_labels(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_shadow_training_label_links_print_job_fkey
    FOREIGN KEY (organization_id, print_job_id)
    REFERENCES operations_print_jobs(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_shadow_training_label_links_org_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT operations_shadow_training_label_links_package_unique
    UNIQUE (training_run_id, training_package_id),
  CONSTRAINT operations_shadow_training_label_links_state_valid CHECK (
    (status IN ('create_prepared', 'create_unknown') AND carrier_rate_test_label_id IS NULL AND print_job_id IS NULL)
    OR (status = 'create_reconciled_none' AND carrier_rate_test_label_id IS NULL AND print_job_id IS NULL)
    OR (status = 'created' AND carrier_rate_test_label_id IS NOT NULL AND print_job_id IS NULL)
    OR (status IN ('print_queued', 'printed') AND carrier_rate_test_label_id IS NOT NULL AND print_job_id IS NOT NULL)
    OR (status IN ('void_unknown', 'voided') AND carrier_rate_test_label_id IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS operations_shadow_training_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gtev'),
  organization_id uuid NOT NULL,
  training_run_id uuid NOT NULL,
  event_type text NOT NULL CHECK (
    length(btrim(event_type)) BETWEEN 1 AND 120
    AND event_type !~ '[[:cntrl:]]'
  ),
  from_state text,
  to_state text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  idempotency_key text NOT NULL CHECK (
    length(btrim(idempotency_key)) BETWEEN 8 AND 200
    AND idempotency_key !~ '[[:cntrl:]]'
  ),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_email text NOT NULL REFERENCES app_users(email) ON DELETE RESTRICT,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_shadow_training_events_global_valid
    CHECK (global_id ~ '^gtev([0-9]{7}|[0-9a-v]{12})$'),
  CONSTRAINT operations_shadow_training_events_global_unique UNIQUE (global_id),
  CONSTRAINT operations_shadow_training_events_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_shadow_training_events_run_fkey
    FOREIGN KEY (organization_id, training_run_id)
    REFERENCES operations_shadow_training_runs(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_shadow_training_events_idempotency_unique
    UNIQUE (organization_id, idempotency_key),
  CONSTRAINT operations_shadow_training_events_payload_valid
    CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX IF NOT EXISTS operations_shadow_training_events_run_history
ON operations_shadow_training_events (
  organization_id, training_run_id, occurred_at, id
);

-- Child facts are copies of one exact sealed cartonization evidence record.
-- Constraint triggers are deferred because the application inserts child rows
-- before changing the parent run from enabled to planned in the same
-- transaction. At commit the parent binding and every copied fact must agree.
CREATE OR REPLACE FUNCTION validate_operations_shadow_training_package_fact()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM operations_shadow_training_runs run
    JOIN operations_cartonization_rate_evidence evidence
      ON evidence.organization_id = run.organization_id
     AND evidence.id = run.cartonization_evidence_id
     AND evidence.sealed_at IS NOT NULL
    JOIN operations_cartonization_rate_evidence_packages evidence_package
      ON evidence_package.organization_id = evidence.organization_id
     AND evidence_package.evidence_id = evidence.id
     AND evidence_package.package_key = NEW.evidence_package_key
     AND evidence_package.package_sequence = NEW.package_sequence
    JOIN operations_packaging_materials material
      ON material.organization_id = evidence_package.organization_id
     AND material.id = evidence_package.packaging_material_id
    WHERE run.organization_id = NEW.organization_id
      AND run.id = NEW.training_run_id
      AND material.global_id = NEW.packaging_material_global_id
      AND material.name = NEW.packaging_material_name
      AND evidence_package.rated_outer_dimensions_mm = NEW.rated_outer_dimensions_mm
      AND evidence_package.content_weight_grams = NEW.content_weight_grams
      AND evidence_package.tare_weight_grams = NEW.tare_weight_grams
      AND evidence_package.rated_gross_weight_grams = NEW.rated_gross_weight_grams
      AND evidence_package.allocations = NEW.allocations
      AND evidence_package.package_hash = NEW.source_package_hash
  ) THEN
    RAISE EXCEPTION 'OPERATIONS_SHADOW_TRAINING_PACKAGE_EVIDENCE_MISMATCH'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER validate_operations_shadow_training_package_fact_commit
AFTER INSERT ON operations_shadow_training_packages
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_operations_shadow_training_package_fact();

CREATE OR REPLACE FUNCTION validate_operations_shadow_training_pick_fact()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM operations_shadow_training_packages package
    CROSS JOIN LATERAL jsonb_array_elements(package.allocations) allocation(item)
    WHERE package.organization_id = NEW.organization_id
      AND package.training_run_id = NEW.training_run_id
      AND package.id = NEW.training_package_id
      AND allocation.item->>'lineGlobalId' = NEW.source_line_global_id
      AND allocation.item->>'productGlobalId' = NEW.product_global_id
      AND allocation.item->>'title' = NEW.title
      AND (allocation.item->>'quantity')::numeric = NEW.quantity
  ) THEN
    RAISE EXCEPTION 'OPERATIONS_SHADOW_TRAINING_PICK_EVIDENCE_MISMATCH'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER validate_operations_shadow_training_pick_fact_commit
AFTER INSERT ON operations_shadow_training_pick_tasks
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_operations_shadow_training_pick_fact();

CREATE OR REPLACE FUNCTION validate_operations_shadow_training_plan_coverage()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  evidence_package_count integer;
  training_package_count integer;
  evidence_allocation_count integer;
  training_pick_count integer;
BEGIN
  IF NOT (OLD.state = 'enabled' AND NEW.state = 'planned') THEN
    RETURN NEW;
  END IF;

  SELECT count(*)::integer,
         COALESCE(sum(jsonb_array_length(package.allocations)), 0)::integer
    INTO evidence_package_count, evidence_allocation_count
  FROM operations_cartonization_rate_evidence_packages package
  WHERE package.organization_id = NEW.organization_id
    AND package.evidence_id = NEW.cartonization_evidence_id;

  SELECT count(*)::integer
    INTO training_package_count
  FROM operations_shadow_training_packages package
  WHERE package.organization_id = NEW.organization_id
    AND package.training_run_id = NEW.id;

  SELECT count(*)::integer
    INTO training_pick_count
  FROM operations_shadow_training_pick_tasks task
  WHERE task.organization_id = NEW.organization_id
    AND task.training_run_id = NEW.id;

  IF evidence_package_count < 1
     OR training_package_count <> evidence_package_count
     OR training_pick_count <> evidence_allocation_count THEN
    RAISE EXCEPTION 'OPERATIONS_SHADOW_TRAINING_PLAN_COVERAGE_MISMATCH'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER validate_operations_shadow_training_plan_coverage_update
BEFORE UPDATE OF state ON operations_shadow_training_runs
FOR EACH ROW EXECUTE FUNCTION validate_operations_shadow_training_plan_coverage();

CREATE OR REPLACE FUNCTION protect_operations_shadow_training_run()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Shadow training runs are immutable history';
  END IF;

  IF ROW(
    NEW.global_id, NEW.organization_id, NEW.source_order_id,
    NEW.integration_account_id, NEW.source_candidate_id, NEW.generation,
    NEW.provider, NEW.account_environment,
    NEW.authorization_activation_revision,
    NEW.authorization_order_row_version,
    NEW.authorization_candidate_row_version,
    NEW.authorization_candidate_source_hash,
    NEW.authorization_credential_generation,
    NEW.authorization_idempotency_key, NEW.authorization_request_hash,
    NEW.authorization_reason, NEW.authorized_by, NEW.authorized_at,
    NEW.source_snapshot, NEW.source_snapshot_sha256,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.global_id, OLD.organization_id, OLD.source_order_id,
    OLD.integration_account_id, OLD.source_candidate_id, OLD.generation,
    OLD.provider, OLD.account_environment,
    OLD.authorization_activation_revision,
    OLD.authorization_order_row_version,
    OLD.authorization_candidate_row_version,
    OLD.authorization_candidate_source_hash,
    OLD.authorization_credential_generation,
    OLD.authorization_idempotency_key, OLD.authorization_request_hash,
    OLD.authorization_reason, OLD.authorized_by, OLD.authorized_at,
    OLD.source_snapshot, OLD.source_snapshot_sha256,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Shadow training authorization and source identity are immutable';
  END IF;

  IF NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION 'Shadow training run version must advance exactly once';
  END IF;

  IF OLD.completed_at IS NOT NULL
     AND NEW.completed_at IS DISTINCT FROM OLD.completed_at
     AND NOT (
       OLD.state = 'completed'
       AND NEW.state = 'packed'
       AND NEW.completed_at IS NULL
     ) THEN
    RAISE EXCEPTION 'Shadow training completion timestamp is immutable';
  END IF;
  IF OLD.completed_at IS NULL
     AND NEW.completed_at IS NOT NULL
     AND NEW.state <> 'completed' THEN
    RAISE EXCEPTION 'Shadow training completion timestamp requires completed state';
  END IF;

  IF OLD.cartonization_evidence_id IS NOT NULL AND ROW(
    NEW.cartonization_evidence_id,
    NEW.cartonization_evidence_global_id,
    NEW.cartonization_evidence_sha256,
    NEW.warehouse_id
  ) IS DISTINCT FROM ROW(
    OLD.cartonization_evidence_id,
    OLD.cartonization_evidence_global_id,
    OLD.cartonization_evidence_sha256,
    OLD.warehouse_id
  ) THEN
    RAISE EXCEPTION 'Shadow training cartonization evidence is immutable once selected';
  END IF;

  IF OLD.cartonization_evidence_id IS NULL
     AND NEW.cartonization_evidence_id IS NOT NULL
     AND NOT (OLD.state = 'enabled' AND NEW.state = 'planned') THEN
    RAISE EXCEPTION 'Shadow training evidence may be selected only while planning';
  END IF;

  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
    (OLD.state = 'enabled' AND NEW.state IN ('planned', 'reset', 'reset_blocked'))
    OR (OLD.state = 'planned' AND NEW.state IN ('released', 'reset', 'reset_blocked'))
    OR (OLD.state = 'released' AND NEW.state IN ('planned', 'picked', 'reset', 'reset_blocked'))
    OR (OLD.state = 'picked' AND NEW.state IN ('released', 'packed', 'reset', 'reset_blocked'))
    OR (OLD.state = 'packed' AND NEW.state IN ('picked', 'labeled', 'completed', 'reset', 'reset_blocked'))
    OR (OLD.state = 'labeled' AND NEW.state IN ('completed', 'reset', 'reset_blocked'))
    OR (OLD.state = 'completed' AND NEW.state IN ('packed', 'reset', 'reset_blocked'))
    OR (OLD.state = 'reset_blocked' AND NEW.state = 'reset')
  ) THEN
    RAISE EXCEPTION 'Illegal Shadow training state transition from % to %', OLD.state, NEW.state;
  END IF;

  IF OLD.state = 'reset' THEN
    RAISE EXCEPTION 'Reset Shadow training runs are terminal';
  END IF;

  IF NEW.state = 'reset' AND EXISTS (
    SELECT 1
    FROM operations_shadow_training_label_links link
    WHERE link.organization_id = OLD.organization_id
      AND link.training_run_id = OLD.id
      AND link.status NOT IN ('voided', 'create_reconciled_none')
  ) THEN
    RAISE EXCEPTION 'Shadow training label outcome must be positively reconciled before reset';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION validate_operations_shadow_training_run_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_binding_valid boolean;
  authorization_binding_valid boolean;
  evidence_binding_valid boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM 1
    FROM operations_activation_scopes activation
    WHERE activation.organization_id = NEW.organization_id
    FOR UPDATE;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM operations_orders source_order
    JOIN operations_integration_accounts account
      ON account.organization_id = source_order.organization_id
     AND account.id = source_order.integration_account_id
    JOIN operations_commerce_order_candidates candidate
      ON candidate.organization_id = source_order.organization_id
     AND candidate.integration_account_id = source_order.integration_account_id
     AND candidate.canonical_order_id = source_order.id
    WHERE source_order.organization_id = NEW.organization_id
      AND source_order.id = NEW.source_order_id
      AND source_order.integration_account_id = NEW.integration_account_id
      AND source_order.source_provider = NEW.provider
      AND account.provider = NEW.provider
      AND account.integration_type = 'commerce'
      AND account.environment = NEW.account_environment
      AND account.environment IN ('sandbox', 'production')
      AND candidate.id = NEW.source_candidate_id
  ) INTO source_binding_valid;
  IF source_binding_valid IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Shadow training source order, account, provider, and candidate must be exact';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT EXISTS (
      SELECT 1
      FROM operations_orders source_order
      JOIN operations_integration_accounts account
        ON account.organization_id = source_order.organization_id
       AND account.id = source_order.integration_account_id
      JOIN operations_commerce_credentials credential
        ON credential.organization_id = account.organization_id
       AND credential.integration_account_id = account.id
      JOIN operations_commerce_order_candidates candidate
        ON candidate.organization_id = source_order.organization_id
       AND candidate.integration_account_id = source_order.integration_account_id
       AND candidate.canonical_order_id = source_order.id
      JOIN operations_activation_scopes activation
        ON activation.organization_id = source_order.organization_id
      WHERE source_order.organization_id = NEW.organization_id
        AND source_order.id = NEW.source_order_id
        AND source_order.status = 'imported'
        AND source_order.row_version = NEW.authorization_order_row_version
        AND account.id = NEW.integration_account_id
        AND account.status = 'active'
        AND account.environment IN ('sandbox', 'production')
        AND credential.verification_status = 'verified'
        AND credential.credential_version = NEW.authorization_credential_generation
        AND candidate.id = NEW.source_candidate_id
        AND candidate.workflow_state = 'promoted'
        AND candidate.row_version = NEW.authorization_candidate_row_version
        AND candidate.source_hash = NEW.authorization_candidate_source_hash
        AND activation.state = 'shadow'
        AND activation.revision = NEW.authorization_activation_revision
        AND ocr_order_has_zero_downstream(
          source_order.organization_id,
          source_order.id
        )
        AND EXISTS (
          SELECT 1
          FROM operations_commerce_order_candidate_lines candidate_line
          WHERE candidate_line.organization_id = candidate.organization_id
            AND candidate_line.integration_account_id = candidate.integration_account_id
            AND candidate_line.order_candidate_id = candidate.id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM operations_commerce_order_candidate_lines candidate_line
          LEFT JOIN crm_products product
            ON product.pipeline_id = candidate_line.pipeline_id
           AND product.id = candidate_line.product_id
          WHERE candidate_line.organization_id = candidate.organization_id
            AND candidate_line.integration_account_id = candidate.integration_account_id
            AND candidate_line.order_candidate_id = candidate.id
            AND product.id IS NULL
        )
    ) INTO authorization_binding_valid;
    IF authorization_binding_valid IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'Shadow training authorization requires an untouched imported connected-store order in Shadow';
    END IF;
  END IF;

  IF NEW.cartonization_evidence_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
      FROM operations_cartonization_rate_evidence evidence
      WHERE evidence.organization_id = NEW.organization_id
        AND evidence.id = NEW.cartonization_evidence_id
        AND evidence.global_id = NEW.cartonization_evidence_global_id
        AND evidence.integration_account_id = NEW.integration_account_id
        AND evidence.order_candidate_id = NEW.source_candidate_id
        AND evidence.candidate_row_version = NEW.authorization_candidate_row_version
        AND evidence.candidate_source_hash = NEW.authorization_candidate_source_hash
        AND evidence.warehouse_id = NEW.warehouse_id
        AND evidence.sealed_at IS NOT NULL
        AND evidence.plan_snapshot->'shadowTraining'->>'version'
              = 'shadow-training-evidence-v1'
        AND evidence.plan_snapshot->'shadowTraining'->>'runGlobalId'
              = NEW.global_id
    ) INTO evidence_binding_valid;
    IF evidence_binding_valid IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'Shadow training evidence must match the exact account, candidate, and warehouse';
    END IF;
    IF TG_OP = 'UPDATE'
       AND OLD.state = 'enabled'
       AND NEW.state = 'planned'
       AND NOT EXISTS (
         SELECT 1
         FROM operations_cartonization_rate_evidence evidence
         WHERE evidence.organization_id = NEW.organization_id
           AND evidence.id = NEW.cartonization_evidence_id
           AND (evidence.plan_snapshot->'shadowTraining'->>'runRowVersion')::bigint
                 = OLD.row_version
       ) THEN
      RAISE EXCEPTION 'Shadow training evidence must match the exact enabled run version';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER validate_operations_shadow_training_run_identity_mutation
BEFORE INSERT OR UPDATE ON operations_shadow_training_runs
FOR EACH ROW EXECUTE FUNCTION validate_operations_shadow_training_run_identity();

CREATE TRIGGER protect_operations_shadow_training_run_mutation
BEFORE UPDATE OR DELETE ON operations_shadow_training_runs
FOR EACH ROW EXECUTE FUNCTION protect_operations_shadow_training_run();

CREATE OR REPLACE FUNCTION protect_operations_shadow_training_package()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Shadow training packages are immutable history';
  END IF;
  IF ROW(
    NEW.global_id, NEW.organization_id, NEW.training_run_id,
    NEW.package_sequence, NEW.evidence_package_key,
    NEW.packaging_material_global_id, NEW.packaging_material_name,
    NEW.rated_outer_dimensions_mm, NEW.content_weight_grams,
    NEW.tare_weight_grams, NEW.rated_gross_weight_grams,
    NEW.allocations, NEW.source_package_hash, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.global_id, OLD.organization_id, OLD.training_run_id,
    OLD.package_sequence, OLD.evidence_package_key,
    OLD.packaging_material_global_id, OLD.packaging_material_name,
    OLD.rated_outer_dimensions_mm, OLD.content_weight_grams,
    OLD.tare_weight_grams, OLD.rated_gross_weight_grams,
    OLD.allocations, OLD.source_package_hash, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Shadow training package facts are immutable';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'planned' AND NEW.status = 'packed')
    OR (OLD.status = 'packed' AND NEW.status = 'planned')
    OR (OLD.status = 'packed' AND NEW.status IN ('labeled', 'completed'))
    OR (OLD.status = 'labeled' AND NEW.status = 'completed')
    OR (OLD.status = 'completed' AND NEW.status = 'packed')
  ) THEN
    RAISE EXCEPTION 'Illegal Shadow training package transition';
  END IF;
  IF NEW.status IS NOT DISTINCT FROM OLD.status AND ROW(
    NEW.packed_by, NEW.packed_at, NEW.completed_at
  ) IS DISTINCT FROM ROW(
    OLD.packed_by, OLD.packed_at, OLD.completed_at
  ) THEN
    RAISE EXCEPTION 'Shadow training package actor and timestamps change only with status';
  END IF;
  IF OLD.status IN ('packed', 'labeled', 'completed') AND ROW(
    NEW.packed_by, NEW.packed_at
  ) IS DISTINCT FROM ROW(
    OLD.packed_by, OLD.packed_at
  ) AND NOT (
    OLD.status = 'packed'
    AND NEW.status = 'planned'
    AND NEW.packed_by IS NULL
    AND NEW.packed_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Shadow training package packing evidence is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER protect_operations_shadow_training_package_mutation
BEFORE UPDATE OR DELETE ON operations_shadow_training_packages
FOR EACH ROW EXECUTE FUNCTION protect_operations_shadow_training_package();

CREATE OR REPLACE FUNCTION protect_operations_shadow_training_pick_task()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Shadow training pick tasks are immutable history';
  END IF;
  IF ROW(
    NEW.global_id, NEW.organization_id, NEW.training_run_id,
    NEW.training_package_id, NEW.task_sequence, NEW.source_line_global_id,
    NEW.product_global_id, NEW.title, NEW.quantity, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.global_id, OLD.organization_id, OLD.training_run_id,
    OLD.training_package_id, OLD.task_sequence, OLD.source_line_global_id,
    OLD.product_global_id, OLD.title, OLD.quantity, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Shadow training pick task facts are immutable';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (
       (OLD.status = 'ready' AND NEW.status = 'picked')
       OR (OLD.status = 'picked' AND NEW.status = 'ready')
     ) THEN
    RAISE EXCEPTION 'Illegal Shadow training pick transition';
  END IF;
  IF NEW.status IS NOT DISTINCT FROM OLD.status AND ROW(
    NEW.picked_by, NEW.picked_at
  ) IS DISTINCT FROM ROW(
    OLD.picked_by, OLD.picked_at
  ) THEN
    RAISE EXCEPTION 'Shadow training pick actor and timestamp change only with status';
  END IF;
  IF OLD.status = 'picked' AND ROW(
    NEW.picked_by, NEW.picked_at
  ) IS DISTINCT FROM ROW(
    OLD.picked_by, OLD.picked_at
  ) AND NOT (
    NEW.status = 'ready'
    AND NEW.picked_by IS NULL
    AND NEW.picked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Shadow training pick evidence is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER protect_operations_shadow_training_pick_task_mutation
BEFORE UPDATE OR DELETE ON operations_shadow_training_pick_tasks
FOR EACH ROW EXECUTE FUNCTION protect_operations_shadow_training_pick_task();

CREATE OR REPLACE FUNCTION protect_operations_shadow_training_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Shadow training events are append-only';
END;
$$;

CREATE TRIGGER protect_operations_shadow_training_event_mutation
BEFORE UPDATE OR DELETE ON operations_shadow_training_events
FOR EACH ROW EXECUTE FUNCTION protect_operations_shadow_training_event();

CREATE OR REPLACE FUNCTION validate_operations_shadow_training_label_link()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  resolved_environment text;
  resolved_purpose text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Shadow training label links are immutable history';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF ROW(
      NEW.global_id, NEW.organization_id, NEW.training_run_id,
      NEW.training_package_id, NEW.carrier_environment, NEW.created_at
    ) IS DISTINCT FROM ROW(
      OLD.global_id, OLD.organization_id, OLD.training_run_id,
      OLD.training_package_id, OLD.carrier_environment, OLD.created_at
    ) THEN
      RAISE EXCEPTION 'Shadow training label-link identity is immutable';
    END IF;
    IF OLD.carrier_rate_test_label_id IS NOT NULL
       AND NEW.carrier_rate_test_label_id IS DISTINCT FROM OLD.carrier_rate_test_label_id THEN
      RAISE EXCEPTION 'Shadow training carrier label evidence cannot be removed or replaced';
    END IF;
    IF OLD.print_job_id IS NOT NULL
       AND NEW.print_job_id IS DISTINCT FROM OLD.print_job_id THEN
      RAISE EXCEPTION 'Shadow training print evidence cannot be removed or replaced';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
      (OLD.status = 'create_prepared' AND NEW.status IN ('create_unknown', 'created'))
      OR (OLD.status = 'create_unknown' AND NEW.status = 'create_reconciled_none')
      OR (OLD.status = 'created' AND NEW.status IN ('print_queued', 'void_unknown', 'voided'))
      OR (OLD.status = 'print_queued' AND NEW.status IN ('printed', 'void_unknown', 'voided'))
      OR (OLD.status = 'printed' AND NEW.status IN ('void_unknown', 'voided'))
      OR (OLD.status = 'void_unknown' AND NEW.status = 'voided')
    ) THEN
      RAISE EXCEPTION 'Illegal Shadow training label transition';
    END IF;
    IF NEW.status IS NOT DISTINCT FROM OLD.status AND ROW(
      NEW.carrier_rate_test_label_id, NEW.print_job_id, NEW.updated_at
    ) IS DISTINCT FROM ROW(
      OLD.carrier_rate_test_label_id, OLD.print_job_id, OLD.updated_at
    ) THEN
      RAISE EXCEPTION 'Shadow training label evidence changes only with status';
    END IF;
  END IF;
  IF NEW.carrier_rate_test_label_id IS NOT NULL THEN
    SELECT label.environment, rate.purpose
      INTO resolved_environment, resolved_purpose
    FROM operations_carrier_rate_test_labels label
    JOIN operations_carrier_rate_requests rate
      ON rate.organization_id = label.organization_id
     AND rate.id = label.rate_request_id
    WHERE label.organization_id = NEW.organization_id
      AND label.id = NEW.carrier_rate_test_label_id;
    IF resolved_environment IS DISTINCT FROM 'sandbox'
       OR resolved_purpose IS DISTINCT FROM 'sandbox_rate_test' THEN
      RAISE EXCEPTION 'Shadow training labels require exact sandbox rate-test evidence';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER validate_operations_shadow_training_label_link_mutation
BEFORE INSERT OR UPDATE OR DELETE ON operations_shadow_training_label_links
FOR EACH ROW EXECUTE FUNCTION validate_operations_shadow_training_label_link();

-- Canonical imported Shopify/Faire orders are mirror-only while Operations is
-- in Shadow. This database fence makes a direct API call roll back before a
-- real plan can be persisted; the application adds a friendly preflight error.
CREATE OR REPLACE FUNCTION guard_shadow_commerce_canonical_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  activation_state text;
  order_provider text;
  account_type text;
  canonical_identity_changed boolean := TG_OP = 'INSERT';
BEGIN
  IF TG_TABLE_NAME = 'operations_fulfillment_plans'
     AND EXISTS (
       SELECT 1
       FROM operations_cartonization_rate_evidence evidence
       WHERE evidence.organization_id = NEW.organization_id
         AND evidence.id = NULLIF(
           to_jsonb(NEW)->>'cartonization_evidence_id',
           ''
         )::uuid
         AND evidence.plan_snapshot ? 'shadowTraining'
     ) THEN
    RAISE EXCEPTION 'OPERATIONS_SHADOW_TRAINING_EVIDENCE_CANONICAL_FORBIDDEN'
      USING ERRCODE = 'P0001';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    canonical_identity_changed :=
      NEW.order_id IS DISTINCT FROM OLD.order_id;
  END IF;

  -- Emergency transitions out of Shadow are intentionally available while a
  -- training run remains open, but they do not authorize canonical work for
  -- that exact order. Fence creation and cross-order rebinding independently
  -- of the current activation state. Same-order provider reconciliation
  -- updates remain available below.
  IF canonical_identity_changed AND EXISTS (
    SELECT 1
    FROM operations_shadow_training_runs training_run
    WHERE training_run.organization_id = NEW.organization_id
      AND training_run.source_order_id = NEW.order_id
      AND training_run.state <> 'reset'
  ) THEN
    RAISE EXCEPTION 'OPERATIONS_SHADOW_TRAINING_OVERLAY_REQUIRED'
      USING ERRCODE = 'P0001';
  END IF;

  -- Provider fulfillment reconciliation legitimately advances or cancels
  -- existing same-order facts while Shadow mirrors the connected store. Only
  -- creation and cross-order rebinding are overlay violations; the training
  -- evidence quarantine above remains unconditional.
  IF TG_OP = 'UPDATE'
     AND NEW.order_id IS NOT DISTINCT FROM OLD.order_id THEN
    RETURN NEW;
  END IF;

  SELECT activation.state, source_order.source_provider,
         account.integration_type
    INTO activation_state, order_provider, account_type
  FROM operations_orders source_order
  JOIN operations_integration_accounts account
    ON account.organization_id = source_order.organization_id
   AND account.id = source_order.integration_account_id
  JOIN operations_activation_scopes activation
    ON activation.organization_id = source_order.organization_id
  WHERE source_order.organization_id = NEW.organization_id
    AND source_order.id = NEW.order_id;

  IF activation_state = 'shadow'
     AND order_provider IN ('shopify', 'faire')
     AND account_type = 'commerce' THEN
    RAISE EXCEPTION 'OPERATIONS_SHADOW_TRAINING_OVERLAY_REQUIRED'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_shadow_commerce_canonical_plan_insert
BEFORE INSERT OR UPDATE ON operations_fulfillment_plans
FOR EACH ROW EXECUTE FUNCTION guard_shadow_commerce_canonical_write();

CREATE TRIGGER guard_shadow_commerce_canonical_reservation_insert
BEFORE INSERT OR UPDATE ON operations_reservations
FOR EACH ROW EXECUTE FUNCTION guard_shadow_commerce_canonical_write();

CREATE TRIGGER guard_shadow_commerce_canonical_shipment_insert
BEFORE INSERT OR UPDATE ON operations_shipments
FOR EACH ROW EXECUTE FUNCTION guard_shadow_commerce_canonical_write();

CREATE TRIGGER guard_shadow_commerce_canonical_export_insert
BEFORE INSERT OR UPDATE ON operations_commerce_fulfillment_exports
FOR EACH ROW EXECUTE FUNCTION guard_shadow_commerce_canonical_write();

CREATE OR REPLACE FUNCTION guard_shadow_training_activation_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND EXISTS (
       SELECT 1
       FROM operations_shadow_training_runs run
       WHERE run.organization_id = OLD.organization_id
         AND run.state <> 'reset'
     ) THEN
    RAISE EXCEPTION 'OPERATIONS_SHADOW_TRAINING_RESET_REQUIRED'
      USING ERRCODE = 'P0001';
  END IF;

  IF TG_OP = 'INSERT'
     AND NEW.state = 'active'
     AND EXISTS (
       SELECT 1
       FROM operations_shadow_training_runs run
       WHERE run.organization_id = NEW.organization_id
         AND run.state <> 'reset'
     ) THEN
    RAISE EXCEPTION 'OPERATIONS_SHADOW_TRAINING_RESET_REQUIRED'
      USING ERRCODE = 'P0001';
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.state = 'active'
     AND OLD.state IS DISTINCT FROM 'active'
     AND EXISTS (
       SELECT 1
       FROM operations_shadow_training_runs run
       WHERE run.organization_id = OLD.organization_id
         AND run.state <> 'reset'
     ) THEN
    RAISE EXCEPTION 'OPERATIONS_SHADOW_TRAINING_RESET_REQUIRED'
      USING ERRCODE = 'P0001';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_shadow_training_activation_change_insert
BEFORE INSERT ON operations_activation_scopes
FOR EACH ROW EXECUTE FUNCTION guard_shadow_training_activation_change();

CREATE TRIGGER guard_shadow_training_activation_change_update
BEFORE UPDATE OF state ON operations_activation_scopes
FOR EACH ROW EXECUTE FUNCTION guard_shadow_training_activation_change();

CREATE TRIGGER guard_shadow_training_activation_change_delete
BEFORE DELETE ON operations_activation_scopes
FOR EACH ROW EXECUTE FUNCTION guard_shadow_training_activation_change();

COMMENT ON TABLE operations_shadow_training_runs IS
  'Exact-order Shadow simulation overlay. Canonical commerce orders remain provider-mirrored; commerce writes, production postage, inventory, and packaging-stock mutations are constrained to zero.';
COMMENT ON TABLE operations_shadow_training_label_links IS
  'Optional links to exact sandbox carrier diagnostic labels and print jobs. Production carrier evidence is rejected by trigger.';
