-- Immutable two-pass pack-and-rate evidence.
--
-- Checkout quoting and fulfillment execution are separate point-in-time runs.
-- The execution run references the checkout run, preserving exact package
-- allocations, all recorded carrier choices, the selected service, customer
-- charge/MUD economics, and the resulting variance. The initial executable
-- regression harness writes only sanitized recorded facts: provider writes,
-- postage purchases, and live label writes are structurally zero.

INSERT INTO global_reference_entity_types (prefix, entity_type, display_name)
VALUES
  (
    'gprr',
    'operations.pack_rate_run',
    'Pack and rate run'
  ),
  (
    'gprv',
    'operations.pack_rate_variance',
    'Pack and rate variance'
  )
ON CONFLICT (prefix) DO UPDATE SET
  entity_type = EXCLUDED.entity_type,
  display_name = EXCLUDED.display_name;

CREATE TABLE IF NOT EXISTS operations_pack_rate_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gprr'),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  replay_group_key text NOT NULL,
  scenario_id text NOT NULL,
  source_kind text NOT NULL CHECK (
    source_kind IN (
      'sanitized_historical_replay',
      'active_commerce_candidate',
      'provider_checkout'
    )
  ),
  source_reference text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('shopify', 'faire')),
  checkout_source text NOT NULL CHECK (
    checkout_source IN (
      'live_callback_recorded',
      'faire_checkout_estimate_captured'
    )
  ),
  purpose text NOT NULL CHECK (
    purpose IN ('checkout_quote', 'fulfillment_execution')
  ),
  prior_checkout_run_id uuid,
  pipeline_id uuid,
  customer_id uuid,
  customer_resolution_outcome text NOT NULL CHECK (
    customer_resolution_outcome IN (
      'not_attempted', 'created', 'reused', 'ambiguous'
    )
  ),
  status text NOT NULL CHECK (
    status IN ('succeeded', 'blocked', 'failed')
  ),
  blocker_code text,
  policy_version text NOT NULL,
  algorithm_version text NOT NULL,
  input_hash text NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  result_hash text NOT NULL CHECK (result_hash ~ '^[a-f0-9]{64}$'),
  input_snapshot jsonb NOT NULL,
  result_snapshot jsonb NOT NULL,
  stage_snapshot jsonb NOT NULL,
  line_count integer NOT NULL CHECK (line_count BETWEEN 0 AND 500),
  package_count integer NOT NULL CHECK (package_count BETWEEN 0 AND 50),
  rate_choice_count integer NOT NULL CHECK (
    rate_choice_count BETWEEN 0 AND 50
  ),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  selected_provider text CHECK (
    selected_provider IS NULL
    OR selected_provider IN ('ups_rest', 'fedex_rest')
  ),
  selected_service_code text,
  selected_service_name text,
  selected_carrier_cost_minor bigint,
  customer_charge_minor bigint,
  mud_markup_minor bigint,
  margin_minor bigint,
  idempotency_key text NOT NULL,
  actor_email text REFERENCES app_users(email) ON DELETE SET NULL,
  provider_write_count integer NOT NULL DEFAULT 0
    CHECK (provider_write_count = 0),
  postage_purchase_count integer NOT NULL DEFAULT 0
    CHECK (postage_purchase_count = 0),
  label_write_count integer NOT NULL DEFAULT 0
    CHECK (label_write_count = 0),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_pack_rate_runs_global_valid
    CHECK (global_id ~ '^gprr[0-9]{7}$'),
  CONSTRAINT operations_pack_rate_runs_global_unique UNIQUE (global_id),
  CONSTRAINT operations_pack_rate_runs_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_pack_rate_runs_org_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT operations_pack_rate_runs_group_purpose_unique
    UNIQUE (organization_id, replay_group_key, purpose),
  CONSTRAINT operations_pack_rate_runs_idempotency_unique
    UNIQUE (organization_id, idempotency_key),
  CONSTRAINT operations_pack_rate_runs_checkout_fkey
    FOREIGN KEY (organization_id, prior_checkout_run_id)
    REFERENCES operations_pack_rate_runs(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_pack_rate_runs_pipeline_fkey
    FOREIGN KEY (organization_id, pipeline_id)
    REFERENCES pipeline_spaces(workspace_organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_pack_rate_runs_customer_fkey
    FOREIGN KEY (pipeline_id, customer_id)
    REFERENCES crm_organizations(pipeline_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_pack_rate_runs_text_valid CHECK (
    length(btrim(replay_group_key)) BETWEEN 8 AND 180
    AND replay_group_key !~ '[[:cntrl:]]'
    AND length(btrim(scenario_id)) BETWEEN 3 AND 120
    AND scenario_id !~ '[[:cntrl:]]'
    AND length(btrim(source_reference)) BETWEEN 3 AND 500
    AND source_reference !~ '[[:cntrl:]]'
    AND length(btrim(policy_version)) BETWEEN 1 AND 160
    AND policy_version !~ '[[:cntrl:]]'
    AND length(btrim(algorithm_version)) BETWEEN 1 AND 160
    AND algorithm_version !~ '[[:cntrl:]]'
    AND length(btrim(idempotency_key)) BETWEEN 8 AND 180
    AND idempotency_key !~ '[[:cntrl:]]'
  ),
  CONSTRAINT operations_pack_rate_runs_snapshots_valid CHECK (
    jsonb_typeof(input_snapshot) = 'object'
    AND jsonb_typeof(result_snapshot) = 'object'
    AND jsonb_typeof(stage_snapshot) = 'object'
  ),
  CONSTRAINT operations_pack_rate_runs_selected_text_valid CHECK (
    (
      selected_service_code IS NULL
      AND selected_service_name IS NULL
    )
    OR (
      selected_service_code IS NOT NULL
      AND selected_service_name IS NOT NULL
      AND length(btrim(selected_service_code)) BETWEEN 1 AND 80
      AND selected_service_code !~ '[[:cntrl:]]'
      AND length(btrim(selected_service_name)) BETWEEN 1 AND 160
      AND selected_service_name !~ '[[:cntrl:]]'
    )
  ),
  CONSTRAINT operations_pack_rate_runs_provider_source_valid CHECK (
    (
      provider = 'shopify'
      AND checkout_source = 'live_callback_recorded'
    )
    OR (
      provider = 'faire'
      AND checkout_source = 'faire_checkout_estimate_captured'
    )
  ),
  CONSTRAINT operations_pack_rate_runs_blocker_valid CHECK (
    (
      status = 'succeeded'
      AND blocker_code IS NULL
    )
    OR (
      status IN ('blocked', 'failed')
      AND blocker_code IS NOT NULL
      AND length(btrim(blocker_code)) BETWEEN 3 AND 128
      AND blocker_code !~ '[[:cntrl:]]'
    )
  ),
  CONSTRAINT operations_pack_rate_runs_economics_valid CHECK (
    (
      status = 'succeeded'
      AND provider = 'faire'
      AND purpose = 'checkout_quote'
      AND checkout_source = 'faire_checkout_estimate_captured'
      AND line_count = 0
      AND package_count = 0
      AND rate_choice_count = 0
      AND selected_provider IS NULL
      AND selected_service_code IS NULL
      AND selected_service_name IS NULL
      AND selected_carrier_cost_minor IS NULL
      AND customer_charge_minor >= 0
      AND mud_markup_minor IS NULL
      AND margin_minor IS NULL
    )
    OR (
      status = 'succeeded'
      AND line_count BETWEEN 1 AND 500
      AND package_count BETWEEN 1 AND 50
      AND rate_choice_count BETWEEN 2 AND 50
      AND selected_provider IS NOT NULL
      AND selected_service_code IS NOT NULL
      AND selected_service_name IS NOT NULL
      AND selected_carrier_cost_minor >= 0
      AND customer_charge_minor >= 0
      AND mud_markup_minor >= 0
      AND margin_minor
        = customer_charge_minor - selected_carrier_cost_minor
      AND (
        purpose = 'fulfillment_execution'
        OR (
          customer_charge_minor
            = selected_carrier_cost_minor + mud_markup_minor
          AND margin_minor = mud_markup_minor
        )
      )
    )
    OR (
      status IN ('blocked', 'failed')
      AND line_count = 0
      AND package_count = 0
      AND rate_choice_count = 0
      AND selected_provider IS NULL
      AND selected_service_code IS NULL
      AND selected_service_name IS NULL
      AND selected_carrier_cost_minor IS NULL
      AND customer_charge_minor IS NULL
      AND mud_markup_minor IS NULL
      AND margin_minor IS NULL
    )
  ),
  CONSTRAINT operations_pack_rate_runs_customer_scope_valid CHECK (
    (pipeline_id IS NULL AND customer_id IS NULL)
    OR (pipeline_id IS NOT NULL AND customer_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS operations_pack_rate_runs_scenario_idx
  ON operations_pack_rate_runs (
    organization_id, scenario_id, created_at DESC, id
  );

CREATE INDEX IF NOT EXISTS operations_pack_rate_runs_checkout_idx
  ON operations_pack_rate_runs (
    organization_id, prior_checkout_run_id, created_at, id
  )
  WHERE purpose = 'fulfillment_execution';

CREATE TABLE IF NOT EXISTS operations_pack_rate_run_lines (
  organization_id uuid NOT NULL,
  run_id uuid NOT NULL,
  line_key text NOT NULL,
  product_key text NOT NULL,
  title text NOT NULL,
  required_quantity integer NOT NULL CHECK (required_quantity > 0),
  unit_weight_grams integer NOT NULL CHECK (unit_weight_grams > 0),
  line_hash text NOT NULL CHECK (line_hash ~ '^[a-f0-9]{64}$'),
  line_snapshot jsonb NOT NULL CHECK (
    jsonb_typeof(line_snapshot) = 'object'
  ),
  PRIMARY KEY (organization_id, run_id, line_key, product_key),
  CONSTRAINT operations_pack_rate_run_lines_run_fkey
    FOREIGN KEY (organization_id, run_id)
    REFERENCES operations_pack_rate_runs(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_pack_rate_run_lines_text_valid CHECK (
    length(btrim(line_key)) BETWEEN 1 AND 120
    AND line_key !~ '[[:cntrl:]]'
    AND length(btrim(product_key)) BETWEEN 1 AND 120
    AND product_key !~ '[[:cntrl:]]'
    AND length(btrim(title)) BETWEEN 1 AND 500
    AND title !~ '[[:cntrl:]]'
  )
);

CREATE TABLE IF NOT EXISTS operations_pack_rate_run_packages (
  organization_id uuid NOT NULL,
  run_id uuid NOT NULL,
  package_key text NOT NULL,
  package_sequence integer NOT NULL CHECK (package_sequence BETWEEN 1 AND 50),
  material_code text NOT NULL,
  material_name text NOT NULL,
  length_mm integer NOT NULL CHECK (length_mm > 0),
  width_mm integer NOT NULL CHECK (width_mm > 0),
  height_mm integer NOT NULL CHECK (height_mm > 0),
  content_weight_grams integer NOT NULL CHECK (content_weight_grams > 0),
  tare_weight_grams integer NOT NULL CHECK (tare_weight_grams > 0),
  gross_weight_grams integer NOT NULL CHECK (
    gross_weight_grams = content_weight_grams + tare_weight_grams
  ),
  allocation_count integer NOT NULL CHECK (allocation_count BETWEEN 1 AND 500),
  package_hash text NOT NULL CHECK (package_hash ~ '^[a-f0-9]{64}$'),
  package_snapshot jsonb NOT NULL CHECK (
    jsonb_typeof(package_snapshot) = 'object'
  ),
  PRIMARY KEY (organization_id, run_id, package_key),
  CONSTRAINT operations_pack_rate_run_packages_run_fkey
    FOREIGN KEY (organization_id, run_id)
    REFERENCES operations_pack_rate_runs(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_pack_rate_run_packages_sequence_unique
    UNIQUE (organization_id, run_id, package_sequence),
  CONSTRAINT operations_pack_rate_run_packages_text_valid CHECK (
    length(btrim(package_key)) BETWEEN 1 AND 100
    AND package_key !~ '[[:cntrl:]]'
    AND length(btrim(material_code)) BETWEEN 1 AND 80
    AND material_code !~ '[[:cntrl:]]'
    AND length(btrim(material_name)) BETWEEN 1 AND 160
    AND material_name !~ '[[:cntrl:]]'
  )
);

CREATE TABLE IF NOT EXISTS operations_pack_rate_run_allocations (
  organization_id uuid NOT NULL,
  run_id uuid NOT NULL,
  package_key text NOT NULL,
  line_key text NOT NULL,
  product_key text NOT NULL,
  title text NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  allocation_hash text NOT NULL CHECK (allocation_hash ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (
    organization_id, run_id, package_key, line_key, product_key
  ),
  CONSTRAINT operations_pack_rate_run_allocations_package_fkey
    FOREIGN KEY (organization_id, run_id, package_key)
    REFERENCES operations_pack_rate_run_packages(
      organization_id, run_id, package_key
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_pack_rate_run_allocations_line_fkey
    FOREIGN KEY (organization_id, run_id, line_key, product_key)
    REFERENCES operations_pack_rate_run_lines(
      organization_id, run_id, line_key, product_key
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_pack_rate_run_allocations_text_valid CHECK (
    length(btrim(line_key)) BETWEEN 1 AND 120
    AND line_key !~ '[[:cntrl:]]'
    AND length(btrim(product_key)) BETWEEN 1 AND 120
    AND product_key !~ '[[:cntrl:]]'
    AND length(btrim(title)) BETWEEN 1 AND 500
    AND title !~ '[[:cntrl:]]'
  )
);

CREATE TABLE IF NOT EXISTS operations_pack_rate_run_rate_choices (
  organization_id uuid NOT NULL,
  run_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('ups_rest', 'fedex_rest')),
  service_code text NOT NULL,
  service_name text NOT NULL,
  carrier_cost_minor bigint NOT NULL CHECK (carrier_cost_minor >= 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  selected boolean NOT NULL DEFAULT false,
  recorded_fact_version text NOT NULL,
  normalized_response jsonb NOT NULL CHECK (
    jsonb_typeof(normalized_response) = 'object'
  ),
  PRIMARY KEY (organization_id, run_id, provider, service_code),
  CONSTRAINT operations_pack_rate_run_rate_choices_run_fkey
    FOREIGN KEY (organization_id, run_id)
    REFERENCES operations_pack_rate_runs(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_pack_rate_run_rate_choices_text_valid CHECK (
    length(btrim(service_code)) BETWEEN 1 AND 80
    AND service_code !~ '[[:cntrl:]]'
    AND length(btrim(service_name)) BETWEEN 1 AND 160
    AND service_name !~ '[[:cntrl:]]'
    AND length(btrim(recorded_fact_version)) BETWEEN 3 AND 160
    AND recorded_fact_version !~ '[[:cntrl:]]'
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS
  operations_pack_rate_run_rate_choices_selected_unique
  ON operations_pack_rate_run_rate_choices (organization_id, run_id)
  WHERE selected = true;

CREATE TABLE IF NOT EXISTS
  operations_pack_rate_run_package_finalizations (
  organization_id uuid NOT NULL,
  run_id uuid NOT NULL,
  package_key text NOT NULL,
  response_source text NOT NULL CHECK (
    response_source = 'recorded_label_response'
  ),
  carrier text NOT NULL CHECK (
    carrier IN ('ups_rest', 'fedex_rest')
  ),
  service_code text NOT NULL,
  tracking_number text NOT NULL,
  recorded_label_reference text NOT NULL,
  packing_slip_artifact_id uuid NOT NULL,
  provider_write_count integer NOT NULL DEFAULT 0
    CHECK (provider_write_count = 0),
  postage_purchase_count integer NOT NULL DEFAULT 0
    CHECK (postage_purchase_count = 0),
  finalized_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, run_id, package_key),
  CONSTRAINT operations_pack_rate_run_finalizations_package_fkey
    FOREIGN KEY (organization_id, run_id, package_key)
    REFERENCES operations_pack_rate_run_packages(
      organization_id, run_id, package_key
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_pack_rate_run_finalizations_artifact_fkey
    FOREIGN KEY (organization_id, packing_slip_artifact_id)
    REFERENCES operations_print_artifacts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_pack_rate_run_finalizations_artifact_unique
    UNIQUE (organization_id, packing_slip_artifact_id),
  CONSTRAINT operations_pack_rate_run_finalizations_text_valid CHECK (
    length(btrim(service_code)) BETWEEN 1 AND 80
    AND service_code !~ '[[:cntrl:]]'
    AND length(btrim(tracking_number)) BETWEEN 8 AND 120
    AND tracking_number !~ '[[:cntrl:]]'
    AND length(btrim(recorded_label_reference)) BETWEEN 8 AND 180
    AND recorded_label_reference !~ '[[:cntrl:]]'
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS
  operations_pack_rate_run_finalizations_tracking_unique
  ON operations_pack_rate_run_package_finalizations (
    organization_id, run_id, tracking_number
  );

CREATE UNIQUE INDEX IF NOT EXISTS
  operations_pack_rate_run_finalizations_label_reference_unique
  ON operations_pack_rate_run_package_finalizations (
    organization_id, run_id, recorded_label_reference
  );

CREATE TABLE IF NOT EXISTS operations_pack_rate_variances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gprv'),
  organization_id uuid NOT NULL,
  checkout_run_id uuid NOT NULL,
  fulfillment_run_id uuid NOT NULL,
  package_count_delta integer NOT NULL,
  checkout_carrier_cost_minor bigint NOT NULL
    CHECK (checkout_carrier_cost_minor >= 0),
  checkout_customer_charge_minor bigint NOT NULL
    CHECK (checkout_customer_charge_minor >= 0),
  fulfillment_carrier_cost_minor bigint NOT NULL
    CHECK (fulfillment_carrier_cost_minor >= 0),
  carrier_cost_variance_minor bigint NOT NULL,
  realized_margin_minor bigint NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  allocation_changed boolean NOT NULL,
  material_changed boolean NOT NULL,
  service_changed boolean NOT NULL,
  causes jsonb NOT NULL CHECK (
    jsonb_typeof(causes) = 'array'
    AND jsonb_array_length(causes) BETWEEN 0 AND 50
  ),
  comparison_hash text NOT NULL CHECK (
    comparison_hash ~ '^[a-f0-9]{64}$'
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_pack_rate_variances_global_valid
    CHECK (global_id ~ '^gprv[0-9]{7}$'),
  CONSTRAINT operations_pack_rate_variances_global_unique UNIQUE (global_id),
  CONSTRAINT operations_pack_rate_variances_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_pack_rate_variances_checkout_fkey
    FOREIGN KEY (organization_id, checkout_run_id)
    REFERENCES operations_pack_rate_runs(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_pack_rate_variances_fulfillment_fkey
    FOREIGN KEY (organization_id, fulfillment_run_id)
    REFERENCES operations_pack_rate_runs(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_pack_rate_variances_run_unique
    UNIQUE (organization_id, checkout_run_id, fulfillment_run_id),
  CONSTRAINT operations_pack_rate_variances_math_valid CHECK (
    carrier_cost_variance_minor
      = fulfillment_carrier_cost_minor - checkout_carrier_cost_minor
    AND realized_margin_minor
      = checkout_customer_charge_minor - fulfillment_carrier_cost_minor
  )
);

CREATE OR REPLACE FUNCTION validate_operations_pack_rate_run_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  checkout_row operations_pack_rate_runs%ROWTYPE;
BEGIN
  IF NEW.purpose = 'checkout_quote' THEN
    IF NEW.prior_checkout_run_id IS NOT NULL
       OR NEW.customer_resolution_outcome <> 'not_attempted'
       OR NEW.pipeline_id IS NOT NULL
       OR NEW.customer_id IS NOT NULL
       OR NEW.status <> 'succeeded'
       OR NEW.expires_at IS NULL
       OR NEW.expires_at <= NEW.created_at
    THEN
      RAISE EXCEPTION
        'Checkout quote runs require an expiring, customer-neutral succeeded snapshot';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.prior_checkout_run_id IS NULL OR NEW.expires_at IS NOT NULL THEN
    RAISE EXCEPTION
      'Fulfillment execution runs require one checkout predecessor and do not expire';
  END IF;

  SELECT *
    INTO checkout_row
  FROM operations_pack_rate_runs
  WHERE organization_id = NEW.organization_id
    AND id = NEW.prior_checkout_run_id;
  IF NOT FOUND
     OR checkout_row.purpose <> 'checkout_quote'
     OR checkout_row.replay_group_key <> NEW.replay_group_key
     OR checkout_row.scenario_id <> NEW.scenario_id
     OR checkout_row.provider <> NEW.provider
     OR checkout_row.checkout_source <> NEW.checkout_source
     OR checkout_row.source_kind <> NEW.source_kind
     OR checkout_row.source_reference <> NEW.source_reference
  THEN
    RAISE EXCEPTION
      'Fulfillment execution lineage must reference the exact checkout quote context';
  END IF;

  IF NEW.status = 'succeeded' AND (
    NEW.customer_resolution_outcome NOT IN ('created', 'reused')
    OR NEW.pipeline_id IS NULL
    OR NEW.customer_id IS NULL
  ) THEN
    RAISE EXCEPTION
      'Succeeded fulfillment execution requires one resolved CRM customer';
  END IF;
  IF NEW.status = 'succeeded'
     AND NEW.provider = 'shopify'
     AND (
       NEW.customer_charge_minor
         IS DISTINCT FROM checkout_row.customer_charge_minor
       OR NEW.mud_markup_minor
         IS DISTINCT FROM checkout_row.mud_markup_minor
     )
  THEN
    RAISE EXCEPTION
      'Shopify fulfillment must preserve the quoted customer charge and MUD markup';
  END IF;
  IF NEW.status = 'succeeded'
     AND NEW.provider = 'faire'
     AND NEW.customer_charge_minor
       IS DISTINCT FROM checkout_row.customer_charge_minor
  THEN
    RAISE EXCEPTION
      'Faire fulfillment must preserve the captured marketplace estimate';
  END IF;
  IF NEW.status = 'blocked' AND (
    NEW.customer_resolution_outcome NOT IN ('not_attempted', 'ambiguous')
    OR NEW.pipeline_id IS NOT NULL
    OR NEW.customer_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'Blocked fulfillment execution requires an unresolved ambiguous customer';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION validate_operations_pack_rate_child_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  run_status text;
  run_purpose text;
  run_provider text;
  run_package_plan_hash text;
  expected_count integer;
  expected_rate_count integer;
  retained_count bigint;
  artifact_document_type text;
  artifact_format text;
  artifact_media_size text;
  artifact_content_sha256 text;
  artifact_byte_length bigint;
  artifact_payload_sha256 text;
  artifact_payload_byte_length bigint;
  artifact_render_snapshot jsonb;
  run_global_id text;
  package_sequence integer;
  exact_lines jsonb;
BEGIN
  SELECT
    status, purpose, provider, result_snapshot->>'packagePlanHash',
    package_count, rate_choice_count
    INTO
      run_status, run_purpose, run_provider, run_package_plan_hash,
      expected_count, expected_rate_count
  FROM operations_pack_rate_runs
  WHERE organization_id = NEW.organization_id
    AND id = NEW.run_id;
  IF run_status IS DISTINCT FROM 'succeeded' THEN
    RAISE EXCEPTION
      'Only succeeded pack-and-rate runs can retain package or rate children';
  END IF;
  IF run_purpose = 'checkout_quote' AND run_provider = 'faire' THEN
    RAISE EXCEPTION
      'Faire captured marketplace estimates cannot retain ClawPilot package or carrier children';
  END IF;

  IF TG_TABLE_NAME = 'operations_pack_rate_run_packages' THEN
    SELECT count(*) INTO retained_count
    FROM operations_pack_rate_run_packages
    WHERE organization_id = NEW.organization_id
      AND run_id = NEW.run_id;
    IF retained_count >= expected_count
       OR NEW.package_sequence > expected_count THEN
      RAISE EXCEPTION 'Pack-and-rate package count is already complete';
    END IF;
  ELSIF TG_TABLE_NAME = 'operations_pack_rate_run_lines' THEN
    SELECT count(*) INTO retained_count
    FROM operations_pack_rate_run_lines
    WHERE organization_id = NEW.organization_id
      AND run_id = NEW.run_id;
    IF retained_count >= (
      SELECT line_count
      FROM operations_pack_rate_runs
      WHERE organization_id = NEW.organization_id
        AND id = NEW.run_id
    ) THEN
      RAISE EXCEPTION 'Pack-and-rate line requirements are already complete';
    END IF;
  ELSIF TG_TABLE_NAME = 'operations_pack_rate_run_rate_choices' THEN
    SELECT count(*) INTO retained_count
    FROM operations_pack_rate_run_rate_choices
    WHERE organization_id = NEW.organization_id
      AND run_id = NEW.run_id;
    IF retained_count >= expected_rate_count THEN
      RAISE EXCEPTION
        'Pack-and-rate carrier choices are already complete';
    END IF;
    IF run_package_plan_hash IS NULL
       OR NEW.normalized_response->>'packagePlanHash'
         IS DISTINCT FROM run_package_plan_hash
       OR NEW.normalized_response->'packageCount'
         IS DISTINCT FROM to_jsonb(expected_count)
    THEN
      RAISE EXCEPTION
        'Recorded carrier choice must reference the exact immutable package plan';
    END IF;
  ELSIF TG_TABLE_NAME
    = 'operations_pack_rate_run_package_finalizations' THEN
    SELECT
      run.global_id,
      package.package_sequence,
      artifact.document_type,
      artifact.format,
      artifact.media_size,
      artifact.content_sha256,
      artifact.byte_length,
      encode(digest(payload.payload, 'sha256'), 'hex'),
      octet_length(payload.payload),
      payload.render_snapshot
      INTO
        run_global_id,
        package_sequence,
        artifact_document_type,
        artifact_format,
        artifact_media_size,
        artifact_content_sha256,
        artifact_byte_length,
        artifact_payload_sha256,
        artifact_payload_byte_length,
        artifact_render_snapshot
    FROM operations_pack_rate_runs run
    JOIN operations_pack_rate_run_packages package
      ON package.organization_id = run.organization_id
     AND package.run_id = run.id
     AND package.package_key = NEW.package_key
    JOIN operations_print_artifacts artifact
      ON artifact.organization_id = run.organization_id
     AND artifact.id = NEW.packing_slip_artifact_id
    JOIN operations_print_artifact_payloads payload
      ON payload.organization_id = artifact.organization_id
     AND payload.artifact_id = artifact.id
    WHERE run.organization_id = NEW.organization_id
      AND run.id = NEW.run_id
      AND run.purpose = 'fulfillment_execution'
      AND run.status = 'succeeded'
      AND run.selected_provider = NEW.carrier
      AND run.selected_service_code = NEW.service_code;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'Recorded package finalization requires one durable packing-slip artifact and the selected fulfillment rate';
    END IF;

    SELECT jsonb_agg(
      jsonb_build_object(
        'lineKey', allocation.line_key,
        'productKey', allocation.product_key,
        'title', allocation.title,
        'quantity', allocation.quantity
      )
      ORDER BY allocation.line_key, allocation.product_key
    )
      INTO exact_lines
    FROM operations_pack_rate_run_allocations allocation
    WHERE allocation.organization_id = NEW.organization_id
      AND allocation.run_id = NEW.run_id
      AND allocation.package_key = NEW.package_key;

    IF artifact_document_type <> 'packing_slip'
       OR artifact_format <> 'PDF'
       OR artifact_media_size <> 'letter'
       OR artifact_content_sha256 IS DISTINCT FROM artifact_payload_sha256
       OR artifact_byte_length IS DISTINCT FROM artifact_payload_byte_length
       OR jsonb_typeof(artifact_render_snapshot) <> 'object'
       OR artifact_render_snapshot->>'documentStage'
         IS DISTINCT FROM 'recorded_fulfillment_replay'
       OR artifact_render_snapshot->>'runGlobalId'
         IS DISTINCT FROM run_global_id
       OR artifact_render_snapshot->>'packageKey'
         IS DISTINCT FROM NEW.package_key
       OR artifact_render_snapshot->'packageSequence'
         IS DISTINCT FROM to_jsonb(package_sequence)
       OR artifact_render_snapshot->>'trackingNumber'
         IS DISTINCT FROM NEW.tracking_number
       OR artifact_render_snapshot->>'carrier'
         IS DISTINCT FROM NEW.carrier
       OR artifact_render_snapshot->>'serviceCode'
         IS DISTINCT FROM NEW.service_code
       OR artifact_render_snapshot->>'recordedLabelReference'
         IS DISTINCT FROM NEW.recorded_label_reference
       OR artifact_render_snapshot->'lines' IS DISTINCT FROM exact_lines
       OR artifact_render_snapshot->'providerWriteCount'
         IS DISTINCT FROM '0'::jsonb
       OR artifact_render_snapshot->'postagePurchaseCount'
         IS DISTINCT FROM '0'::jsonb
    THEN
      RAISE EXCEPTION
        'Recorded final packing slip must match its immutable package allocation and tracking evidence';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION
  validate_operations_pack_rate_allocation_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected_count integer;
  retained_count bigint;
BEGIN
  SELECT allocation_count
    INTO expected_count
  FROM operations_pack_rate_run_packages
  WHERE organization_id = NEW.organization_id
    AND run_id = NEW.run_id
    AND package_key = NEW.package_key;
  SELECT count(*) INTO retained_count
  FROM operations_pack_rate_run_allocations
  WHERE organization_id = NEW.organization_id
    AND run_id = NEW.run_id
    AND package_key = NEW.package_key;
  IF expected_count IS NULL OR retained_count >= expected_count THEN
    RAISE EXCEPTION 'Pack-and-rate package allocations are already complete';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION validate_operations_pack_rate_run_complete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  line_rows bigint;
  package_rows bigint;
  allocation_mismatch_rows bigint;
  allocation_quantity_mismatch_rows bigint;
  rate_rows bigint;
  selected_rows bigint;
  selected_row operations_pack_rate_run_rate_choices%ROWTYPE;
BEGIN
  IF NEW.status <> 'succeeded' THEN
    IF EXISTS (
      SELECT 1
      FROM operations_pack_rate_run_packages package
      WHERE package.organization_id = NEW.organization_id
        AND package.run_id = NEW.id
      UNION ALL
      SELECT 1
      FROM operations_pack_rate_run_rate_choices rate
      WHERE rate.organization_id = NEW.organization_id
        AND rate.run_id = NEW.id
    ) THEN
      RAISE EXCEPTION 'Blocked pack-and-rate runs cannot retain execution children';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.purpose = 'checkout_quote' AND NEW.provider = 'faire' THEN
    IF EXISTS (
      SELECT 1
      FROM operations_pack_rate_run_lines line
      WHERE line.organization_id = NEW.organization_id
        AND line.run_id = NEW.id
      UNION ALL
      SELECT 1
      FROM operations_pack_rate_run_packages package
      WHERE package.organization_id = NEW.organization_id
        AND package.run_id = NEW.id
      UNION ALL
      SELECT 1
      FROM operations_pack_rate_run_rate_choices rate
      WHERE rate.organization_id = NEW.organization_id
        AND rate.run_id = NEW.id
    ) THEN
      RAISE EXCEPTION
        'Faire captured marketplace estimates cannot retain ClawPilot package or carrier children';
    END IF;
    RETURN NEW;
  END IF;

  SELECT count(*) INTO line_rows
  FROM operations_pack_rate_run_lines line
  WHERE line.organization_id = NEW.organization_id
    AND line.run_id = NEW.id;
  SELECT count(*) INTO package_rows
  FROM operations_pack_rate_run_packages package
  WHERE package.organization_id = NEW.organization_id
    AND package.run_id = NEW.id;
  SELECT count(*) INTO allocation_mismatch_rows
  FROM (
    SELECT package.package_key
    FROM operations_pack_rate_run_packages package
    LEFT JOIN operations_pack_rate_run_allocations allocation
      ON allocation.organization_id = package.organization_id
     AND allocation.run_id = package.run_id
     AND allocation.package_key = package.package_key
    WHERE package.organization_id = NEW.organization_id
      AND package.run_id = NEW.id
    GROUP BY package.package_key, package.allocation_count
    HAVING count(allocation.line_key) <> package.allocation_count
  ) mismatch;
  SELECT count(*) INTO allocation_quantity_mismatch_rows
  FROM (
    SELECT line.line_key, line.product_key
    FROM operations_pack_rate_run_lines line
    LEFT JOIN operations_pack_rate_run_allocations allocation
      ON allocation.organization_id = line.organization_id
     AND allocation.run_id = line.run_id
     AND allocation.line_key = line.line_key
     AND allocation.product_key = line.product_key
    WHERE line.organization_id = NEW.organization_id
      AND line.run_id = NEW.id
    GROUP BY
      line.line_key, line.product_key, line.required_quantity
    HAVING COALESCE(sum(allocation.quantity), 0)
      <> line.required_quantity
  ) mismatch;
  SELECT
    count(*),
    count(*) FILTER (WHERE selected)
    INTO rate_rows, selected_rows
  FROM operations_pack_rate_run_rate_choices rate
  WHERE rate.organization_id = NEW.organization_id
    AND rate.run_id = NEW.id;
  SELECT *
    INTO selected_row
  FROM operations_pack_rate_run_rate_choices rate
  WHERE rate.organization_id = NEW.organization_id
    AND rate.run_id = NEW.id
    AND rate.selected = true;
  IF line_rows <> NEW.line_count
     OR package_rows <> NEW.package_count
     OR allocation_mismatch_rows <> 0
     OR allocation_quantity_mismatch_rows <> 0
     OR rate_rows <> NEW.rate_choice_count
     OR selected_rows <> 1
     OR NOT EXISTS (
       SELECT 1
       FROM operations_pack_rate_run_rate_choices rate
       WHERE rate.organization_id = NEW.organization_id
         AND rate.run_id = NEW.id
         AND rate.provider = 'ups_rest'
     )
     OR NOT EXISTS (
       SELECT 1
       FROM operations_pack_rate_run_rate_choices rate
       WHERE rate.organization_id = NEW.organization_id
         AND rate.run_id = NEW.id
         AND rate.provider = 'fedex_rest'
     )
     OR selected_row.provider IS DISTINCT FROM NEW.selected_provider
     OR selected_row.service_code IS DISTINCT FROM NEW.selected_service_code
     OR selected_row.service_name IS DISTINCT FROM NEW.selected_service_name
     OR selected_row.carrier_cost_minor
       IS DISTINCT FROM NEW.selected_carrier_cost_minor
     OR selected_row.currency IS DISTINCT FROM NEW.currency
  THEN
    RAISE EXCEPTION
      'Pack-and-rate run is missing exact packages, allocations, or selected-rate evidence';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION validate_operations_pack_rate_variance_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  checkout_row operations_pack_rate_runs%ROWTYPE;
  fulfillment_row operations_pack_rate_runs%ROWTYPE;
BEGIN
  SELECT * INTO checkout_row
  FROM operations_pack_rate_runs
  WHERE organization_id = NEW.organization_id
    AND id = NEW.checkout_run_id;
  SELECT * INTO fulfillment_row
  FROM operations_pack_rate_runs
  WHERE organization_id = NEW.organization_id
    AND id = NEW.fulfillment_run_id;
  IF checkout_row.purpose IS DISTINCT FROM 'checkout_quote'
     OR checkout_row.status IS DISTINCT FROM 'succeeded'
     OR fulfillment_row.purpose IS DISTINCT FROM 'fulfillment_execution'
     OR fulfillment_row.status IS DISTINCT FROM 'succeeded'
     OR fulfillment_row.prior_checkout_run_id
       IS DISTINCT FROM checkout_row.id
     OR NEW.package_count_delta
       <> fulfillment_row.package_count - checkout_row.package_count
     OR NEW.checkout_carrier_cost_minor
       <> checkout_row.selected_carrier_cost_minor
     OR NEW.checkout_customer_charge_minor
       <> checkout_row.customer_charge_minor
     OR NEW.fulfillment_carrier_cost_minor
       <> fulfillment_row.selected_carrier_cost_minor
     OR NEW.currency <> checkout_row.currency
     OR NEW.currency <> fulfillment_row.currency
     OR NEW.allocation_changed IS DISTINCT FROM (
       checkout_row.result_snapshot->>'allocationHash'
         IS DISTINCT FROM
       fulfillment_row.result_snapshot->>'allocationHash'
     )
     OR NEW.material_changed IS DISTINCT FROM (
       checkout_row.result_snapshot->>'materialHash'
         IS DISTINCT FROM
       fulfillment_row.result_snapshot->>'materialHash'
     )
     OR NEW.service_changed IS DISTINCT FROM (
       checkout_row.result_snapshot->>'serviceHash'
         IS DISTINCT FROM
       fulfillment_row.result_snapshot->>'serviceHash'
     )
     OR NEW.causes IS DISTINCT FROM (
       SELECT COALESCE(
         jsonb_agg(derived.cause ORDER BY derived.position),
         '[]'::jsonb
       )
       FROM (
         VALUES
           (
             1,
             'allocation_changed'::text,
             checkout_row.result_snapshot->>'allocationHash'
               IS DISTINCT FROM
             fulfillment_row.result_snapshot->>'allocationHash'
           ),
           (
             2,
             'material_changed'::text,
             checkout_row.result_snapshot->>'materialHash'
               IS DISTINCT FROM
             fulfillment_row.result_snapshot->>'materialHash'
           ),
           (
             3,
             'service_changed'::text,
             checkout_row.result_snapshot->>'serviceHash'
               IS DISTINCT FROM
             fulfillment_row.result_snapshot->>'serviceHash'
           ),
           (
             4,
             'recorded_rate_changed'::text,
             checkout_row.selected_carrier_cost_minor
               IS DISTINCT FROM
             fulfillment_row.selected_carrier_cost_minor
           )
       ) AS derived(position, cause, included)
       WHERE derived.included
     )
  THEN
    RAISE EXCEPTION
      'Pack-and-rate variance must exactly compare one checkout/execution lineage';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_operations_pack_rate_run_insert
  ON operations_pack_rate_runs;
CREATE TRIGGER validate_operations_pack_rate_run_insert
BEFORE INSERT ON operations_pack_rate_runs
FOR EACH ROW EXECUTE FUNCTION validate_operations_pack_rate_run_insert();

DROP TRIGGER IF EXISTS protect_operations_pack_rate_runs_mutation
  ON operations_pack_rate_runs;
CREATE TRIGGER protect_operations_pack_rate_runs_mutation
BEFORE UPDATE OR DELETE ON operations_pack_rate_runs
FOR EACH ROW EXECUTE FUNCTION protect_operations_append_only();

DROP TRIGGER IF EXISTS validate_operations_pack_rate_run_complete
  ON operations_pack_rate_runs;
CREATE CONSTRAINT TRIGGER validate_operations_pack_rate_run_complete
AFTER INSERT ON operations_pack_rate_runs
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_operations_pack_rate_run_complete();

DROP TRIGGER IF EXISTS validate_operations_pack_rate_package_insert
  ON operations_pack_rate_run_packages;
CREATE TRIGGER validate_operations_pack_rate_package_insert
BEFORE INSERT ON operations_pack_rate_run_packages
FOR EACH ROW EXECUTE FUNCTION validate_operations_pack_rate_child_insert();

DROP TRIGGER IF EXISTS validate_operations_pack_rate_line_insert
  ON operations_pack_rate_run_lines;
CREATE TRIGGER validate_operations_pack_rate_line_insert
BEFORE INSERT ON operations_pack_rate_run_lines
FOR EACH ROW EXECUTE FUNCTION validate_operations_pack_rate_child_insert();

DROP TRIGGER IF EXISTS protect_operations_pack_rate_lines_mutation
  ON operations_pack_rate_run_lines;
CREATE TRIGGER protect_operations_pack_rate_lines_mutation
BEFORE UPDATE OR DELETE ON operations_pack_rate_run_lines
FOR EACH ROW EXECUTE FUNCTION protect_operations_append_only();

DROP TRIGGER IF EXISTS protect_operations_pack_rate_packages_mutation
  ON operations_pack_rate_run_packages;
CREATE TRIGGER protect_operations_pack_rate_packages_mutation
BEFORE UPDATE OR DELETE ON operations_pack_rate_run_packages
FOR EACH ROW EXECUTE FUNCTION protect_operations_append_only();

DROP TRIGGER IF EXISTS validate_operations_pack_rate_allocation_insert
  ON operations_pack_rate_run_allocations;
CREATE TRIGGER validate_operations_pack_rate_allocation_insert
BEFORE INSERT ON operations_pack_rate_run_allocations
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_pack_rate_allocation_insert();

DROP TRIGGER IF EXISTS protect_operations_pack_rate_allocations_mutation
  ON operations_pack_rate_run_allocations;
CREATE TRIGGER protect_operations_pack_rate_allocations_mutation
BEFORE UPDATE OR DELETE ON operations_pack_rate_run_allocations
FOR EACH ROW EXECUTE FUNCTION protect_operations_append_only();

DROP TRIGGER IF EXISTS validate_operations_pack_rate_choice_insert
  ON operations_pack_rate_run_rate_choices;
CREATE TRIGGER validate_operations_pack_rate_choice_insert
BEFORE INSERT ON operations_pack_rate_run_rate_choices
FOR EACH ROW EXECUTE FUNCTION validate_operations_pack_rate_child_insert();

DROP TRIGGER IF EXISTS protect_operations_pack_rate_choices_mutation
  ON operations_pack_rate_run_rate_choices;
CREATE TRIGGER protect_operations_pack_rate_choices_mutation
BEFORE UPDATE OR DELETE ON operations_pack_rate_run_rate_choices
FOR EACH ROW EXECUTE FUNCTION protect_operations_append_only();

DROP TRIGGER IF EXISTS validate_operations_pack_rate_finalization_insert
  ON operations_pack_rate_run_package_finalizations;
CREATE TRIGGER validate_operations_pack_rate_finalization_insert
BEFORE INSERT ON operations_pack_rate_run_package_finalizations
FOR EACH ROW EXECUTE FUNCTION validate_operations_pack_rate_child_insert();

DROP TRIGGER IF EXISTS protect_operations_pack_rate_finalizations_mutation
  ON operations_pack_rate_run_package_finalizations;
CREATE TRIGGER protect_operations_pack_rate_finalizations_mutation
BEFORE UPDATE OR DELETE ON operations_pack_rate_run_package_finalizations
FOR EACH ROW EXECUTE FUNCTION protect_operations_append_only();

DROP TRIGGER IF EXISTS validate_operations_pack_rate_variance_insert
  ON operations_pack_rate_variances;
CREATE TRIGGER validate_operations_pack_rate_variance_insert
BEFORE INSERT ON operations_pack_rate_variances
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_pack_rate_variance_insert();

DROP TRIGGER IF EXISTS protect_operations_pack_rate_variances_mutation
  ON operations_pack_rate_variances;
CREATE TRIGGER protect_operations_pack_rate_variances_mutation
BEFORE UPDATE OR DELETE ON operations_pack_rate_variances
FOR EACH ROW EXECUTE FUNCTION protect_operations_append_only();

COMMENT ON TABLE operations_pack_rate_runs IS
  'Immutable checkout-quote and fulfillment-execution snapshots. Execution references checkout; regression rows retain recorded carrier facts and structurally prohibit provider/postage/label writes.';
COMMENT ON TABLE operations_pack_rate_run_allocations IS
  'Exact immutable unit allocation to each planned package at one point in time.';
COMMENT ON TABLE operations_pack_rate_run_lines IS
  'Immutable per-run required quantities used to prove exact allocation conservation.';
COMMENT ON TABLE operations_pack_rate_run_rate_choices IS
  'Whole-shipment carrier cost choices, distinct from customer charge and MUD markup.';
COMMENT ON TABLE operations_pack_rate_run_package_finalizations IS
  'Recorded replay-only label responses: each package references immutable downloadable packing-slip bytes whose render snapshot is database-validated against exact allocations and tracking, with zero provider/postage writes.';
COMMENT ON TABLE operations_pack_rate_variances IS
  'Immutable quoted-to-fulfillment package, carrier-cost, charge, margin, and cause comparison.';
