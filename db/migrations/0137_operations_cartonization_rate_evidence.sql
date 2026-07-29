-- Durable, reloadable evidence for an operator-triggered cartonization plan
-- followed by read-only UPS and FedEx sandbox rating. The aggregate stores the
-- exact plan and explicit assumptions; carrier payload evidence remains in the
-- existing append-only operations_carrier_rate_requests ledger.

INSERT INTO global_reference_entity_types (prefix, entity_type, display_name)
VALUES (
  'gcte',
  'operations.cartonization_rate_evidence',
  'Cartonization and rate evidence'
)
ON CONFLICT (prefix) DO UPDATE SET
  entity_type = EXCLUDED.entity_type,
  display_name = EXCLUDED.display_name;

ALTER TABLE operations_commerce_order_candidates
  DROP CONSTRAINT IF EXISTS
    commerce_order_candidates_account_id_unique,
  ADD CONSTRAINT commerce_order_candidates_account_id_unique
    UNIQUE (organization_id, integration_account_id, id);

ALTER TABLE operations_commerce_inventory_sync_runs
  DROP CONSTRAINT IF EXISTS
    operations_commerce_inventory_sync_runs_account_warehouse_id_unique,
  ADD CONSTRAINT
    operations_commerce_inventory_sync_runs_account_warehouse_id_unique
    UNIQUE (organization_id, integration_account_id, warehouse_id, id);

ALTER TABLE operations_approved_pack_recipes
  DROP CONSTRAINT IF EXISTS
    operations_approved_pack_recipes_org_material_id_unique,
  ADD CONSTRAINT operations_approved_pack_recipes_org_material_id_unique
    UNIQUE (organization_id, packaging_material_id, id);

ALTER TABLE operations_carrier_rate_requests
  DROP CONSTRAINT IF EXISTS
    operations_carrier_rate_requests_org_provider_purpose_id_unique,
  ADD CONSTRAINT
    operations_carrier_rate_requests_org_provider_purpose_id_unique
    UNIQUE (organization_id, provider, purpose, id);

CREATE OR REPLACE FUNCTION operations_cartonization_dimensions_mm_valid(
  value jsonb
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN jsonb_typeof(value) IS DISTINCT FROM 'object' THEN false
    WHEN (
      SELECT array_agg(key ORDER BY key)
      FROM jsonb_object_keys(value) AS field(key)
    ) IS DISTINCT FROM
      ARRAY['height', 'length', 'width']::text[] THEN false
    ELSE
      COALESCE(
        value->>'length' ~ '^[1-9][0-9]{0,8}$'
        AND value->>'width' ~ '^[1-9][0-9]{0,8}$'
        AND value->>'height' ~ '^[1-9][0-9]{0,8}$',
        false
      )
  END
$$;

CREATE OR REPLACE FUNCTION operations_cartonization_allocations_valid(
  value jsonb
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN jsonb_typeof(value) IS DISTINCT FROM 'array' THEN false
    WHEN jsonb_array_length(value) NOT BETWEEN 1 AND 500 THEN false
    ELSE NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(value) AS allocation(item)
      WHERE jsonb_typeof(item) IS DISTINCT FROM 'object'
        OR (
          SELECT array_agg(key ORDER BY key)
          FROM jsonb_object_keys(item) AS field(key)
        ) IS DISTINCT FROM ARRAY[
          'lineGlobalId',
          'productGlobalId',
          'quantity',
          'title'
        ]::text[]
        OR COALESCE(
          item->>'lineGlobalId' !~ '^gcol[0-9]{7}$',
          true
        )
        OR COALESCE(
          item->>'productGlobalId' !~ '^gp[0-9]{7}$',
          true
        )
        OR jsonb_typeof(item->'title') IS DISTINCT FROM 'string'
        OR length(btrim(item->>'title')) NOT BETWEEN 1 AND 512
        OR item->>'title' ~ '[[:cntrl:]]'
        OR jsonb_typeof(item->'quantity') IS DISTINCT FROM 'number'
        OR COALESCE(
          item->>'quantity' !~ '^[1-9][0-9]{0,8}$',
          true
        )
    )
  END
$$;

CREATE TABLE IF NOT EXISTS operations_cartonization_rate_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gcte'),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  order_candidate_id uuid NOT NULL,
  candidate_row_version bigint NOT NULL CHECK (candidate_row_version >= 0),
  candidate_source_hash text NOT NULL
    CHECK (candidate_source_hash ~ '^[a-f0-9]{64}$'),
  warehouse_id uuid NOT NULL,
  inventory_sync_run_id uuid,
  evidence_mode text NOT NULL CHECK (
    evidence_mode IN ('operational', 'assumption_backed_sandbox')
  ),
  policy_version text NOT NULL,
  algorithm_version text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  plan_input_hash text NOT NULL CHECK (plan_input_hash ~ '^[a-f0-9]{64}$'),
  plan_result_hash text NOT NULL CHECK (plan_result_hash ~ '^[a-f0-9]{64}$'),
  plan_snapshot jsonb NOT NULL,
  assumption_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL CHECK (
    status IN ('succeeded', 'partial', 'failed')
  ),
  idempotency_key text NOT NULL CHECK (
    length(btrim(idempotency_key)) BETWEEN 8 AND 160
    AND idempotency_key !~ '[[:cntrl:]]'
  ),
  actor_email text REFERENCES app_users(email) ON DELETE SET NULL,
  write_token_hash text NOT NULL CHECK (
    write_token_hash ~ '^[a-f0-9]{64}$'
  ),
  sealed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_cartonization_rate_evidence_global_valid
    CHECK (global_id ~ '^gcte[0-9]{7}$'),
  CONSTRAINT operations_cartonization_rate_evidence_global_unique
    UNIQUE (global_id),
  CONSTRAINT operations_cartonization_rate_evidence_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_cartonization_rate_evidence_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_cartonization_rate_evidence_candidate_fkey
    FOREIGN KEY (
      organization_id, integration_account_id, order_candidate_id
    )
    REFERENCES operations_commerce_order_candidates(
      organization_id, integration_account_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_cartonization_rate_evidence_warehouse_fkey
    FOREIGN KEY (organization_id, warehouse_id)
    REFERENCES operations_warehouses(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_cartonization_rate_evidence_inventory_fkey
    FOREIGN KEY (
      organization_id, integration_account_id, warehouse_id,
      inventory_sync_run_id
    )
    REFERENCES operations_commerce_inventory_sync_runs(
      organization_id, integration_account_id, warehouse_id, id
    )
    ON DELETE RESTRICT,
  CONSTRAINT operations_cartonization_rate_evidence_org_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT operations_cartonization_rate_evidence_idempotency_unique
    UNIQUE (organization_id, idempotency_key),
  CONSTRAINT operations_cartonization_rate_evidence_text_valid CHECK (
    length(btrim(policy_version)) BETWEEN 1 AND 160
    AND policy_version !~ '[[:cntrl:]]'
    AND length(btrim(algorithm_version)) BETWEEN 1 AND 160
    AND algorithm_version !~ '[[:cntrl:]]'
  ),
  CONSTRAINT operations_cartonization_rate_evidence_snapshots_valid CHECK (
    jsonb_typeof(plan_snapshot) = 'object'
    AND jsonb_typeof(assumption_snapshot) = 'object'
  ),
  CONSTRAINT operations_cartonization_rate_evidence_seal_valid CHECK (
    sealed_at IS NULL OR sealed_at >= created_at
  )
);

CREATE INDEX IF NOT EXISTS
  idx_operations_cartonization_rate_evidence_candidate
  ON operations_cartonization_rate_evidence (
    organization_id, order_candidate_id, created_at DESC, id
  );

CREATE TABLE IF NOT EXISTS operations_cartonization_rate_evidence_packages (
  organization_id uuid NOT NULL,
  evidence_id uuid NOT NULL,
  package_key text NOT NULL CHECK (
    length(btrim(package_key)) BETWEEN 1 AND 80
    AND package_key !~ '[[:cntrl:]]'
  ),
  package_sequence integer NOT NULL CHECK (package_sequence > 0),
  planning_method text NOT NULL CHECK (
    planning_method IN ('approved_recipe', 'or_tools')
  ),
  packaging_material_id uuid NOT NULL,
  approved_pack_recipe_id uuid,
  material_row_version bigint NOT NULL CHECK (material_row_version >= 0),
  recipe_row_version bigint,
  inner_dimensions_mm jsonb NOT NULL,
  rated_outer_dimensions_mm jsonb NOT NULL,
  content_weight_grams integer NOT NULL CHECK (content_weight_grams > 0),
  tare_weight_grams integer NOT NULL CHECK (tare_weight_grams > 0),
  rated_gross_weight_grams integer NOT NULL
    CHECK (rated_gross_weight_grams > 0),
  max_weight_grams integer,
  allocations jsonb NOT NULL,
  package_hash text NOT NULL CHECK (package_hash ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (organization_id, evidence_id, package_key),
  CONSTRAINT operations_cartonization_rate_evidence_packages_evidence_fkey
    FOREIGN KEY (organization_id, evidence_id)
    REFERENCES operations_cartonization_rate_evidence(
      organization_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_cartonization_rate_evidence_packages_material_fkey
    FOREIGN KEY (organization_id, packaging_material_id)
    REFERENCES operations_packaging_materials(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_cartonization_rate_evidence_packages_recipe_fkey
    FOREIGN KEY (
      organization_id, packaging_material_id, approved_pack_recipe_id
    )
    REFERENCES operations_approved_pack_recipes(
      organization_id, packaging_material_id, id
    )
    ON DELETE RESTRICT,
  CONSTRAINT operations_cartonization_rate_evidence_packages_sequence_unique
    UNIQUE (organization_id, evidence_id, package_sequence),
  CONSTRAINT operations_cartonization_rate_evidence_packages_dimensions_valid
    CHECK (
      operations_cartonization_dimensions_mm_valid(inner_dimensions_mm)
      AND operations_cartonization_dimensions_mm_valid(
        rated_outer_dimensions_mm
      )
    ),
  CONSTRAINT operations_cartonization_rate_evidence_packages_allocations_valid
    CHECK (operations_cartonization_allocations_valid(allocations)),
  CONSTRAINT operations_cartonization_rate_evidence_packages_recipe_valid
    CHECK (
      (
        planning_method = 'approved_recipe'
        AND approved_pack_recipe_id IS NOT NULL
        AND recipe_row_version IS NOT NULL
        AND recipe_row_version >= 0
      )
      OR (
        planning_method = 'or_tools'
        AND approved_pack_recipe_id IS NULL
        AND recipe_row_version IS NULL
      )
    ),
  CONSTRAINT operations_cartonization_rate_evidence_packages_weight_valid
    CHECK (
      rated_gross_weight_grams = content_weight_grams + tare_weight_grams
      AND (
        max_weight_grams IS NULL
        OR (
          max_weight_grams > 0
          AND max_weight_grams >= rated_gross_weight_grams
        )
      )
    )
);

CREATE TABLE IF NOT EXISTS operations_cartonization_rate_evidence_quotes (
  organization_id uuid NOT NULL,
  evidence_id uuid NOT NULL,
  package_key text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('ups_rest', 'fedex_rest')),
  rate_purpose text NOT NULL DEFAULT 'cartonization_package_rate'
    CHECK (rate_purpose = 'cartonization_package_rate'),
  carrier_rate_request_id uuid NOT NULL,
  quote_status text NOT NULL CHECK (
    quote_status IN ('succeeded', 'failed')
  ),
  error_code text,
  PRIMARY KEY (organization_id, evidence_id, package_key, provider),
  CONSTRAINT operations_cartonization_rate_evidence_quotes_package_fkey
    FOREIGN KEY (organization_id, evidence_id, package_key)
    REFERENCES operations_cartonization_rate_evidence_packages(
      organization_id, evidence_id, package_key
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_cartonization_rate_evidence_quotes_rate_fkey
    FOREIGN KEY (
      organization_id, provider, rate_purpose, carrier_rate_request_id
    )
    REFERENCES operations_carrier_rate_requests(
      organization_id, provider, purpose, id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_cartonization_rate_evidence_quotes_state_valid
    CHECK (
      (quote_status = 'succeeded' AND error_code IS NULL)
      OR (
        quote_status = 'failed'
        AND error_code IS NOT NULL
        AND length(btrim(error_code)) BETWEEN 3 AND 128
      )
    )
);

CREATE OR REPLACE FUNCTION
  validate_operations_cartonization_rate_evidence_child_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected_hash text;
  evidence_sealed_at timestamptz;
  supplied_token text;
BEGIN
  SELECT evidence.write_token_hash, evidence.sealed_at
    INTO expected_hash, evidence_sealed_at
  FROM operations_cartonization_rate_evidence evidence
  WHERE evidence.organization_id = NEW.organization_id
    AND evidence.id = NEW.evidence_id;

  supplied_token := current_setting(
    'clawpilot.cartonization_evidence_write_token',
    true
  );
  IF expected_hash IS NULL
     OR evidence_sealed_at IS NOT NULL
     OR supplied_token IS NULL
     OR encode(digest(supplied_token, 'sha256'), 'hex') <> expected_hash
  THEN
    RAISE EXCEPTION
      'Cartonization rate evidence children require the active aggregate write token';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION
  protect_operations_cartonization_rate_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  supplied_token text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    supplied_token := current_setting(
      'clawpilot.cartonization_evidence_write_token',
      true
    );
    IF OLD.sealed_at IS NULL
       AND NEW.sealed_at IS NOT NULL
       AND (to_jsonb(NEW) - 'sealed_at') = (to_jsonb(OLD) - 'sealed_at')
       AND supplied_token IS NOT NULL
       AND encode(digest(supplied_token, 'sha256'), 'hex')
         = OLD.write_token_hash
    THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION
    'Cartonization rate evidence is immutable after its one-time seal';
END;
$$;

CREATE OR REPLACE FUNCTION
  validate_operations_cartonization_rate_evidence_complete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  evidence_status text;
  failed_quote_count bigint;
  package_count bigint;
  quote_count bigint;
BEGIN
  SELECT evidence.status
    INTO evidence_status
  FROM operations_cartonization_rate_evidence evidence
  WHERE evidence.organization_id = NEW.organization_id
    AND evidence.id = NEW.id
    AND evidence.sealed_at IS NOT NULL;
  IF evidence_status IS NULL THEN
    RAISE EXCEPTION
      'Cartonization rate evidence must be sealed before commit';
  END IF;

  SELECT count(*)
    INTO package_count
  FROM operations_cartonization_rate_evidence_packages package
  WHERE package.organization_id = NEW.organization_id
    AND package.evidence_id = NEW.id;
  IF package_count NOT BETWEEN 1 AND 8 OR EXISTS (
    SELECT 1
    FROM operations_cartonization_rate_evidence_packages package
    LEFT JOIN operations_cartonization_rate_evidence_quotes quote
      ON quote.organization_id = package.organization_id
     AND quote.evidence_id = package.evidence_id
     AND quote.package_key = package.package_key
    WHERE package.organization_id = NEW.organization_id
      AND package.evidence_id = NEW.id
    GROUP BY package.package_key
    HAVING count(quote.provider) <> 2
       OR count(quote.provider) FILTER (
         WHERE quote.provider = 'ups_rest'
       ) <> 1
       OR count(quote.provider) FILTER (
         WHERE quote.provider = 'fedex_rest'
       ) <> 1
  ) THEN
    RAISE EXCEPTION
      'Cartonization rate evidence requires one UPS and one FedEx quote per package';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM operations_cartonization_rate_evidence_quotes quote
    JOIN operations_carrier_rate_requests rate
      ON rate.organization_id = quote.organization_id
     AND rate.provider = quote.provider
     AND rate.purpose = quote.rate_purpose
     AND rate.id = quote.carrier_rate_request_id
    WHERE quote.organization_id = NEW.organization_id
      AND quote.evidence_id = NEW.id
      AND (
        quote.quote_status IS DISTINCT FROM rate.status
        OR quote.error_code IS DISTINCT FROM rate.error_code
      )
  ) THEN
    RAISE EXCEPTION
      'Cartonization quote state must match its carrier-rate evidence';
  END IF;

  SELECT
    count(*),
    count(*) FILTER (WHERE quote.quote_status = 'failed')
    INTO quote_count, failed_quote_count
  FROM operations_cartonization_rate_evidence_quotes quote
  WHERE quote.organization_id = NEW.organization_id
    AND quote.evidence_id = NEW.id;
  IF (
    evidence_status = 'succeeded'
    AND failed_quote_count <> 0
  ) OR (
    evidence_status = 'failed'
    AND failed_quote_count <> quote_count
  ) OR (
    evidence_status = 'partial'
    AND (
      failed_quote_count = 0
      OR failed_quote_count = quote_count
    )
  ) THEN
    RAISE EXCEPTION
      'Cartonization evidence status must match its retained carrier results';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_operations_cartonization_rate_evidence_mutation
  ON operations_cartonization_rate_evidence;
CREATE TRIGGER protect_operations_cartonization_rate_evidence_mutation
BEFORE UPDATE OR DELETE ON operations_cartonization_rate_evidence
FOR EACH ROW EXECUTE FUNCTION
  protect_operations_cartonization_rate_evidence();

DROP TRIGGER IF EXISTS validate_operations_cartonization_rate_evidence_complete
  ON operations_cartonization_rate_evidence;
CREATE CONSTRAINT TRIGGER
  validate_operations_cartonization_rate_evidence_complete
AFTER INSERT OR UPDATE ON operations_cartonization_rate_evidence
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_cartonization_rate_evidence_complete();

DROP TRIGGER IF EXISTS
  protect_operations_cartonization_rate_evidence_packages_mutation
  ON operations_cartonization_rate_evidence_packages;
DROP TRIGGER IF EXISTS
  validate_operations_cartonization_rate_evidence_package_insert
  ON operations_cartonization_rate_evidence_packages;
CREATE TRIGGER
  validate_operations_cartonization_rate_evidence_package_insert
BEFORE INSERT ON operations_cartonization_rate_evidence_packages
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_cartonization_rate_evidence_child_insert();
CREATE TRIGGER
  protect_operations_cartonization_rate_evidence_packages_mutation
BEFORE UPDATE OR DELETE ON operations_cartonization_rate_evidence_packages
FOR EACH ROW EXECUTE FUNCTION protect_operations_append_only();

DROP TRIGGER IF EXISTS
  protect_operations_cartonization_rate_evidence_quotes_mutation
  ON operations_cartonization_rate_evidence_quotes;
DROP TRIGGER IF EXISTS
  validate_operations_cartonization_rate_evidence_quote_insert
  ON operations_cartonization_rate_evidence_quotes;
CREATE TRIGGER
  validate_operations_cartonization_rate_evidence_quote_insert
BEFORE INSERT ON operations_cartonization_rate_evidence_quotes
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_cartonization_rate_evidence_child_insert();
CREATE TRIGGER
  protect_operations_cartonization_rate_evidence_quotes_mutation
BEFORE UPDATE OR DELETE ON operations_cartonization_rate_evidence_quotes
FOR EACH ROW EXECUTE FUNCTION protect_operations_append_only();

COMMENT ON TABLE operations_cartonization_rate_evidence IS
  'Immutable operator-visible aggregate joining one exact commerce candidate pack plan to read-only carrier sandbox-rate evidence.';
COMMENT ON COLUMN
  operations_cartonization_rate_evidence.assumption_snapshot IS
  'Explicitly acknowledged facts used only by an assumption-backed sandbox proof; never silently promoted into operational packaging master data.';
