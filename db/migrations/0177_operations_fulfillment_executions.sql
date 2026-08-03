-- Durable fulfillment execution preparation and package-group lineage.
--
-- A checkout quote and a fulfillment rerate are immutable, separate facts.
-- This migration binds the fulfillment rerate to the exact canonical order,
-- released plan, physical packages, package allocations, and selected
-- whole-shipment service. This slice is deliberately Shadow-only and
-- append-only. A later migration must add Active label authority after a
-- production whole-shipment rate/label adapter exists.

INSERT INTO global_reference_entity_types (
  prefix, entity_type, display_name
)
VALUES
  (
    'gofe',
    'operations.fulfillment_execution',
    'Fulfillment execution'
  ),
  (
    'gshg',
    'operations.shipment_group',
    'Shipment group'
  )
ON CONFLICT (prefix) DO UPDATE SET
  entity_type = EXCLUDED.entity_type,
  display_name = EXCLUDED.display_name;

-- A live whole-shipment request can retain as many as fifty services from
-- each of the two configured carriers. Recorded fixtures remain capped at
-- fifty through the economics constraint below.
ALTER TABLE operations_pack_rate_runs
  DROP CONSTRAINT IF EXISTS operations_pack_rate_runs_rate_choice_count_check,
  ADD CONSTRAINT operations_pack_rate_runs_rate_choice_count_check
    CHECK (rate_choice_count BETWEEN 0 AND 100);

ALTER TABLE operations_pack_rate_runs
  DROP CONSTRAINT IF EXISTS operations_pack_rate_runs_economics_valid;

ALTER TABLE operations_pack_rate_runs
  ADD CONSTRAINT operations_pack_rate_runs_economics_valid CHECK (
    (
      pricing_semantics_version = 1
      AND (
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
          AND (
            (
              source_kind = 'provider_checkout'
              AND rate_choice_count BETWEEN 1 AND 100
            )
            OR (
              source_kind <> 'provider_checkout'
              AND rate_choice_count BETWEEN 2 AND 50
            )
          )
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
      )
    )
    OR (
      pricing_semantics_version = 2
      AND (
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
          AND (
            (
              source_kind = 'provider_checkout'
              AND rate_choice_count BETWEEN 1 AND 100
            )
            OR (
              source_kind <> 'provider_checkout'
              AND rate_choice_count BETWEEN 2 AND 50
            )
          )
          AND selected_provider IS NOT NULL
          AND selected_service_code IS NOT NULL
          AND selected_service_name IS NOT NULL
          AND selected_carrier_cost_minor >= 0
          AND customer_charge_minor >= 0
          AND mud_markup_minor IS NULL
          AND margin_minor
            = customer_charge_minor - selected_carrier_cost_minor
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
      )
    )
  );

-- Checkout callbacks identify sellable units by Shopify ProductVariant GID,
-- while canonical fulfillment rows use ClawPilot order/product Global IDs.
-- Preserve those stage-specific identities and add one nullable comparison
-- identity for the subset of runs that participates in checkout-to-fulfillment
-- variance. Existing replay/marketplace evidence remains valid; the variance
-- validator below fails closed when either compared run lacks this identity.
ALTER TABLE operations_pack_rate_run_allocations
  ADD COLUMN IF NOT EXISTS comparison_product_key text;

ALTER TABLE operations_pack_rate_run_allocations
  DROP CONSTRAINT IF EXISTS
    operations_pack_rate_run_allocations_comparison_product_key_valid,
  ADD CONSTRAINT
    operations_pack_rate_run_allocations_comparison_product_key_valid CHECK (
      comparison_product_key IS NULL
      OR (
        length(btrim(comparison_product_key)) BETWEEN 1 AND 512
        AND comparison_product_key !~ '[[:cntrl:]]'
      )
    );

COMMENT ON COLUMN
  operations_pack_rate_run_allocations.comparison_product_key IS
  'Immutable cross-stage sellable-unit identity used only for canonical allocation variance; Shopify stores the exact ProductVariant GID.';

-- Variance truth is derived from the immutable run children, not optional
-- producer-specific snapshot fields. This keeps live checkout/fulfillment
-- evidence and regression replay on one canonical comparison contract.
CREATE OR REPLACE FUNCTION validate_operations_pack_rate_variance_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  checkout_row operations_pack_rate_runs%ROWTYPE;
  fulfillment_row operations_pack_rate_runs%ROWTYPE;
  derived_allocation_changed boolean;
  derived_material_changed boolean;
  derived_service_changed boolean;
  derived_causes jsonb;
BEGIN
  SELECT * INTO checkout_row
  FROM operations_pack_rate_runs
  WHERE organization_id = NEW.organization_id
    AND id = NEW.checkout_run_id;
  SELECT * INTO fulfillment_row
  FROM operations_pack_rate_runs
  WHERE organization_id = NEW.organization_id
    AND id = NEW.fulfillment_run_id;

  IF EXISTS (
    SELECT 1
    FROM operations_pack_rate_run_allocations allocation
    WHERE allocation.organization_id = NEW.organization_id
      AND allocation.run_id IN (
        NEW.checkout_run_id,
        NEW.fulfillment_run_id
      )
      AND allocation.comparison_product_key IS NULL
  ) THEN
    RAISE EXCEPTION
      'Pack-and-rate variance requires canonical comparison product identities';
  END IF;

  SELECT EXISTS (
    (
      SELECT
        package_key,
        comparison_product_key,
        sum(quantity)::bigint AS quantity
      FROM operations_pack_rate_run_allocations
      WHERE organization_id = NEW.organization_id
        AND run_id = NEW.checkout_run_id
      GROUP BY package_key, comparison_product_key
      EXCEPT
      SELECT
        package_key,
        comparison_product_key,
        sum(quantity)::bigint AS quantity
      FROM operations_pack_rate_run_allocations
      WHERE organization_id = NEW.organization_id
        AND run_id = NEW.fulfillment_run_id
      GROUP BY package_key, comparison_product_key
    )
    UNION ALL
    (
      SELECT
        package_key,
        comparison_product_key,
        sum(quantity)::bigint AS quantity
      FROM operations_pack_rate_run_allocations
      WHERE organization_id = NEW.organization_id
        AND run_id = NEW.fulfillment_run_id
      GROUP BY package_key, comparison_product_key
      EXCEPT
      SELECT
        package_key,
        comparison_product_key,
        sum(quantity)::bigint AS quantity
      FROM operations_pack_rate_run_allocations
      WHERE organization_id = NEW.organization_id
        AND run_id = NEW.checkout_run_id
      GROUP BY package_key, comparison_product_key
    )
  ) INTO derived_allocation_changed;

  SELECT EXISTS (
    (
      SELECT package_key, material_code, length_mm, width_mm,
             height_mm, gross_weight_grams
      FROM operations_pack_rate_run_packages
      WHERE organization_id = NEW.organization_id
        AND run_id = NEW.checkout_run_id
      EXCEPT
      SELECT package_key, material_code, length_mm, width_mm,
             height_mm, gross_weight_grams
      FROM operations_pack_rate_run_packages
      WHERE organization_id = NEW.organization_id
        AND run_id = NEW.fulfillment_run_id
    )
    UNION ALL
    (
      SELECT package_key, material_code, length_mm, width_mm,
             height_mm, gross_weight_grams
      FROM operations_pack_rate_run_packages
      WHERE organization_id = NEW.organization_id
        AND run_id = NEW.fulfillment_run_id
      EXCEPT
      SELECT package_key, material_code, length_mm, width_mm,
             height_mm, gross_weight_grams
      FROM operations_pack_rate_run_packages
      WHERE organization_id = NEW.organization_id
        AND run_id = NEW.checkout_run_id
    )
  ) INTO derived_material_changed;

  derived_service_changed := (
    checkout_row.selected_provider
      IS DISTINCT FROM fulfillment_row.selected_provider
    OR checkout_row.selected_service_code
      IS DISTINCT FROM fulfillment_row.selected_service_code
  );

  SELECT COALESCE(
    jsonb_agg(derived.cause ORDER BY derived.position),
    '[]'::jsonb
  ) INTO derived_causes
  FROM (
    VALUES
      (1, 'allocation_changed'::text, derived_allocation_changed),
      (2, 'material_changed'::text, derived_material_changed),
      (3, 'service_changed'::text, derived_service_changed),
      (
        4,
        'recorded_rate_changed'::text,
        checkout_row.selected_carrier_cost_minor
          IS DISTINCT FROM fulfillment_row.selected_carrier_cost_minor
      )
  ) AS derived(position, cause, included)
  WHERE derived.included;

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
     OR NEW.allocation_changed IS DISTINCT FROM derived_allocation_changed
     OR NEW.material_changed IS DISTINCT FROM derived_material_changed
     OR NEW.service_changed IS DISTINCT FROM derived_service_changed
     OR NEW.causes IS DISTINCT FROM derived_causes
  THEN
    RAISE EXCEPTION
      'Pack-and-rate variance must exactly compare one checkout/execution lineage';
  END IF;
  RETURN NEW;
END;
$$;

-- Preserve immutable legacy package packing lists while allowing one new,
-- explicitly warned Pack Work Instruction to coexist for the same package.
-- The durable printer contract remains `packing_slip`; the render template
-- and storage namespace distinguish document semantics without rewriting old
-- bytes or falsely relabeling them.
DROP INDEX IF EXISTS operations_print_artifacts_package_packing_list_unique;

CREATE UNIQUE INDEX IF NOT EXISTS
  operations_print_artifacts_package_legacy_prelabel_unique
ON operations_print_artifacts (
  organization_id, source_package_id, format, media_size
)
WHERE document_type = 'packing_slip'
  AND source_package_id IS NOT NULL
  AND source_shipment_id IS NULL
  AND storage_reference NOT LIKE
    'clawpilot-document:%:pack-work-instruction:%';

CREATE UNIQUE INDEX IF NOT EXISTS
  operations_print_artifacts_package_work_instruction_unique
ON operations_print_artifacts (
  organization_id, source_package_id, format, media_size
)
WHERE document_type = 'packing_slip'
  AND source_package_id IS NOT NULL
  AND source_shipment_id IS NULL
  AND storage_reference LIKE
    'clawpilot-document:%:pack-work-instruction:%';

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
      FROM operations_pack_rate_run_allocations allocation
      WHERE allocation.organization_id = NEW.organization_id
        AND allocation.run_id = NEW.id
      UNION ALL
      SELECT 1
      FROM operations_pack_rate_run_rate_choices rate
      WHERE rate.organization_id = NEW.organization_id
        AND rate.run_id = NEW.id
    ) THEN
      RAISE EXCEPTION
        'Blocked pack-and-rate runs cannot retain execution children';
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
     OR (
       NEW.source_kind <> 'provider_checkout'
       AND (
         NOT EXISTS (
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
       )
     )
     OR selected_row.provider IS DISTINCT FROM NEW.selected_provider
     OR selected_row.service_code IS DISTINCT FROM NEW.selected_service_code
     OR selected_row.service_name IS DISTINCT FROM NEW.selected_service_name
     OR selected_row.carrier_cost_minor
       IS DISTINCT FROM NEW.selected_carrier_cost_minor
     OR selected_row.currency IS DISTINCT FROM NEW.currency
     OR (
       NEW.source_kind = 'provider_checkout'
       AND NEW.purpose = 'checkout_quote'
       AND NOT EXISTS (
         SELECT 1
         FROM operations_shopify_checkout_rate_receipts receipt
         WHERE receipt.organization_id = NEW.organization_id
           AND receipt.global_id = NEW.source_reference
           AND receipt.status = 'succeeded'
           AND receipt.line_count = NEW.line_count
           AND receipt.package_count = NEW.package_count
           AND receipt.offer_count = NEW.rate_choice_count
           AND NOT EXISTS (
             (
               SELECT configured.carrier_provider,
                      configured.carrier_account_id
               FROM operations_shopify_carrier_service_config_carriers
                 configured
               WHERE configured.organization_id = receipt.organization_id
                 AND configured.config_id = receipt.config_id
               EXCEPT
               SELECT attempt.carrier_provider,
                      attempt.carrier_account_id
               FROM operations_shopify_checkout_rate_receipt_provider_attempts
                 attempt
               WHERE attempt.organization_id = receipt.organization_id
                 AND attempt.receipt_id = receipt.id
             )
             UNION ALL
             (
               SELECT attempt.carrier_provider,
                      attempt.carrier_account_id
               FROM operations_shopify_checkout_rate_receipt_provider_attempts
                 attempt
               WHERE attempt.organization_id = receipt.organization_id
                 AND attempt.receipt_id = receipt.id
               EXCEPT
               SELECT configured.carrier_provider,
                      configured.carrier_account_id
               FROM operations_shopify_carrier_service_config_carriers
                 configured
               WHERE configured.organization_id = receipt.organization_id
                 AND configured.config_id = receipt.config_id
             )
           )
       )
     )
     OR (
       NEW.source_kind = 'provider_checkout'
       AND NEW.purpose = 'fulfillment_execution'
       AND NOT EXISTS (
         SELECT 1
         FROM operations_fulfillment_executions execution
         WHERE execution.organization_id = NEW.organization_id
           AND execution.fulfillment_pack_rate_run_id = NEW.id
       )
     )
  THEN
    RAISE EXCEPTION
      'Pack-and-rate run is missing exact packages, allocations, or selected-rate evidence';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS operations_fulfillment_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gofe'),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  order_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  checkout_pack_rate_run_id uuid NOT NULL,
  fulfillment_pack_rate_run_id uuid NOT NULL,
  shopify_checkout_reconciliation_id uuid,
  shopify_checkout_receipt_id uuid,
  authority_mode text NOT NULL CHECK (authority_mode = 'shadow'),
  state text NOT NULL CHECK (state = 'shadow_prepared'),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  provider_write_count integer NOT NULL DEFAULT 0
    CHECK (provider_write_count = 0),
  postage_purchase_count integer NOT NULL DEFAULT 0
    CHECK (postage_purchase_count = 0),
  label_write_count integer NOT NULL DEFAULT 0
    CHECK (label_write_count = 0),
  commerce_write_count integer NOT NULL DEFAULT 0
    CHECK (commerce_write_count = 0),
  row_version bigint NOT NULL DEFAULT 0 CHECK (row_version = 0),
  prepared_by text REFERENCES app_users(email) ON DELETE SET NULL,
  prepared_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_fulfillment_executions_global_valid CHECK (
    global_id ~ '^gofe[0-9]{7}$'
  ),
  CONSTRAINT operations_fulfillment_executions_global_unique UNIQUE (
    global_id
  ),
  CONSTRAINT operations_fulfillment_executions_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_fulfillment_executions_order_fkey
    FOREIGN KEY (organization_id, order_id)
    REFERENCES operations_orders(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_fulfillment_executions_plan_fkey
    FOREIGN KEY (organization_id, plan_id)
    REFERENCES operations_fulfillment_plans(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_fulfillment_executions_checkout_run_fkey
    FOREIGN KEY (organization_id, checkout_pack_rate_run_id)
    REFERENCES operations_pack_rate_runs(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_fulfillment_executions_run_fkey
    FOREIGN KEY (organization_id, fulfillment_pack_rate_run_id)
    REFERENCES operations_pack_rate_runs(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_fulfillment_executions_receipt_fkey
    FOREIGN KEY (organization_id, shopify_checkout_receipt_id)
    REFERENCES operations_shopify_checkout_rate_receipts(
      organization_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_fulfillment_executions_org_id_unique UNIQUE (
    organization_id, id
  ),
  CONSTRAINT operations_fulfillment_executions_order_unique UNIQUE (
    organization_id, order_id
  ),
  CONSTRAINT operations_fulfillment_executions_run_unique UNIQUE (
    organization_id, fulfillment_pack_rate_run_id
  ),
  CONSTRAINT operations_fulfillment_executions_run_lineage_unique UNIQUE (
    organization_id, id, fulfillment_pack_rate_run_id
  ),
  CONSTRAINT operations_fulfillment_executions_idempotency_unique UNIQUE (
    organization_id, idempotency_key
  ),
  CONSTRAINT operations_fulfillment_executions_text_valid CHECK (
    length(btrim(idempotency_key)) BETWEEN 8 AND 200
    AND idempotency_key !~ '[[:cntrl:]]'
  ),
  CONSTRAINT operations_fulfillment_executions_authority_valid CHECK (
    authority_mode = 'shadow'
    AND state = 'shadow_prepared'
    AND provider_write_count = 0
    AND postage_purchase_count = 0
    AND label_write_count = 0
    AND commerce_write_count = 0
  )
);

CREATE INDEX IF NOT EXISTS operations_fulfillment_executions_order_idx
  ON operations_fulfillment_executions (
    organization_id, order_id, prepared_at DESC, id DESC
  );

CREATE TABLE IF NOT EXISTS operations_shipment_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gshg'),
  organization_id uuid NOT NULL,
  fulfillment_execution_id uuid NOT NULL,
  order_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  fulfillment_pack_rate_run_id uuid NOT NULL,
  selected_provider text NOT NULL CHECK (
    selected_provider IN ('ups_rest', 'fedex_rest')
  ),
  selected_service_code text NOT NULL,
  selected_service_name text NOT NULL,
  selected_carrier_cost_minor bigint NOT NULL CHECK (
    selected_carrier_cost_minor >= 0
  ),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  state text NOT NULL CHECK (state = 'shadow_prepared'),
  row_version bigint NOT NULL DEFAULT 0 CHECK (row_version = 0),
  prepared_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_shipment_groups_global_valid CHECK (
    global_id ~ '^gshg[0-9]{7}$'
  ),
  CONSTRAINT operations_shipment_groups_global_unique UNIQUE (global_id),
  CONSTRAINT operations_shipment_groups_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_shipment_groups_execution_fkey
    FOREIGN KEY (organization_id, fulfillment_execution_id)
    REFERENCES operations_fulfillment_executions(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_shipment_groups_order_fkey
    FOREIGN KEY (organization_id, order_id)
    REFERENCES operations_orders(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_shipment_groups_plan_fkey
    FOREIGN KEY (organization_id, plan_id)
    REFERENCES operations_fulfillment_plans(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_shipment_groups_warehouse_fkey
    FOREIGN KEY (organization_id, warehouse_id)
    REFERENCES operations_warehouses(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_shipment_groups_run_fkey
    FOREIGN KEY (organization_id, fulfillment_pack_rate_run_id)
    REFERENCES operations_pack_rate_runs(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_shipment_groups_org_id_unique UNIQUE (
    organization_id, id
  ),
  CONSTRAINT operations_shipment_groups_execution_unique UNIQUE (
    organization_id, fulfillment_execution_id
  ),
  CONSTRAINT operations_shipment_groups_execution_id_unique UNIQUE (
    organization_id, fulfillment_execution_id, id
  ),
  CONSTRAINT operations_shipment_groups_execution_run_unique UNIQUE (
    organization_id, fulfillment_execution_id, id,
    fulfillment_pack_rate_run_id
  ),
  CONSTRAINT operations_shipment_groups_text_valid CHECK (
    length(btrim(selected_service_code)) BETWEEN 1 AND 80
    AND selected_service_code !~ '[[:cntrl:]]'
    AND length(btrim(selected_service_name)) BETWEEN 1 AND 160
    AND selected_service_name !~ '[[:cntrl:]]'
  )
);

CREATE TABLE IF NOT EXISTS operations_fulfillment_execution_lines (
  organization_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  fulfillment_pack_rate_run_id uuid NOT NULL,
  order_line_id uuid NOT NULL,
  line_key text NOT NULL,
  product_key text NOT NULL,
  required_quantity numeric(20,6) NOT NULL CHECK (
    required_quantity > 0
  ),
  PRIMARY KEY (organization_id, execution_id, order_line_id),
  CONSTRAINT operations_fulfillment_execution_lines_execution_fkey
    FOREIGN KEY (organization_id, execution_id)
    REFERENCES operations_fulfillment_executions(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_fulfillment_execution_lines_execution_run_fkey
    FOREIGN KEY (
      organization_id, execution_id, fulfillment_pack_rate_run_id
    )
    REFERENCES operations_fulfillment_executions(
      organization_id, id, fulfillment_pack_rate_run_id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_fulfillment_execution_lines_run_fkey
    FOREIGN KEY (
      organization_id, fulfillment_pack_rate_run_id,
      line_key, product_key
    )
    REFERENCES operations_pack_rate_run_lines(
      organization_id, run_id, line_key, product_key
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_fulfillment_execution_lines_order_line_fkey
    FOREIGN KEY (organization_id, order_line_id)
    REFERENCES operations_order_lines(organization_id, id)
    ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS operations_fulfillment_execution_packages (
  organization_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  shipment_group_id uuid NOT NULL,
  fulfillment_pack_rate_run_id uuid NOT NULL,
  package_id uuid NOT NULL,
  package_key text NOT NULL,
  PRIMARY KEY (organization_id, execution_id, package_id),
  CONSTRAINT operations_fulfillment_execution_packages_execution_fkey
    FOREIGN KEY (organization_id, execution_id)
    REFERENCES operations_fulfillment_executions(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_fulfillment_execution_packages_group_fkey
    FOREIGN KEY (organization_id, shipment_group_id)
    REFERENCES operations_shipment_groups(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_fulfillment_execution_packages_group_pair_fkey
    FOREIGN KEY (
      organization_id, execution_id, shipment_group_id
    )
    REFERENCES operations_shipment_groups(
      organization_id, fulfillment_execution_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_fulfillment_execution_packages_lineage_fkey
    FOREIGN KEY (
      organization_id, execution_id, shipment_group_id,
      fulfillment_pack_rate_run_id
    )
    REFERENCES operations_shipment_groups(
      organization_id, fulfillment_execution_id, id,
      fulfillment_pack_rate_run_id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_fulfillment_execution_packages_run_fkey
    FOREIGN KEY (
      organization_id, fulfillment_pack_rate_run_id, package_key
    )
    REFERENCES operations_pack_rate_run_packages(
      organization_id, run_id, package_key
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_fulfillment_execution_packages_package_fkey
    FOREIGN KEY (organization_id, package_id)
    REFERENCES operations_packages(organization_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS
  operations_fulfillment_execution_rate_attempts (
    organization_id uuid NOT NULL,
    execution_id uuid NOT NULL,
    carrier_provider text NOT NULL CHECK (
      carrier_provider IN ('ups_rest', 'fedex_rest')
    ),
    fulfillment_pack_rate_run_id uuid NOT NULL,
    carrier_account_id uuid NOT NULL,
    carrier_rate_request_id uuid NOT NULL,
    carrier_rate_purpose text NOT NULL DEFAULT
      'cartonization_shipment_rate' CHECK (
        carrier_rate_purpose = 'cartonization_shipment_rate'
      ),
    carrier_request_hash text NOT NULL CHECK (
      carrier_request_hash ~ '^[a-f0-9]{64}$'
    ),
    environment text NOT NULL CHECK (environment = 'sandbox'),
    attempt_status text NOT NULL CHECK (
      attempt_status IN ('succeeded', 'degraded')
    ),
    failure_code text,
    selected boolean NOT NULL DEFAULT false,
    PRIMARY KEY (organization_id, execution_id, carrier_provider),
    CONSTRAINT operations_fulfillment_rate_attempts_execution_fkey
      FOREIGN KEY (organization_id, execution_id)
      REFERENCES operations_fulfillment_executions(organization_id, id)
      ON DELETE RESTRICT,
    CONSTRAINT operations_fulfillment_rate_attempts_execution_run_fkey
      FOREIGN KEY (
        organization_id, execution_id, fulfillment_pack_rate_run_id
      )
      REFERENCES operations_fulfillment_executions(
        organization_id, id, fulfillment_pack_rate_run_id
      ) ON DELETE RESTRICT,
    CONSTRAINT operations_fulfillment_rate_attempts_account_fkey
      FOREIGN KEY (organization_id, carrier_account_id)
      REFERENCES operations_carrier_accounts(organization_id, id)
      ON DELETE RESTRICT,
    CONSTRAINT operations_fulfillment_rate_attempts_rate_fkey
      FOREIGN KEY (
        organization_id, carrier_provider, carrier_rate_purpose,
        carrier_rate_request_id
      )
      REFERENCES operations_carrier_rate_requests(
        organization_id, provider, purpose, id
      ) ON DELETE RESTRICT,
    CONSTRAINT operations_fulfillment_rate_attempts_account_unique UNIQUE (
      organization_id, execution_id, carrier_account_id
    ),
    CONSTRAINT operations_fulfillment_rate_attempts_state_valid CHECK (
      (
        attempt_status = 'succeeded'
        AND failure_code IS NULL
      )
      OR (
        attempt_status = 'degraded'
        AND NOT selected
        AND failure_code IS NOT NULL
        AND length(btrim(failure_code)) BETWEEN 3 AND 128
        AND failure_code ~ '^[A-Z0-9_]+$'
      )
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS
  operations_fulfillment_rate_attempts_selected_unique
ON operations_fulfillment_execution_rate_attempts (
  organization_id, execution_id
)
WHERE selected = true;

ALTER TABLE operations_label_attempts
  ADD COLUMN IF NOT EXISTS fulfillment_execution_id uuid,
  ADD COLUMN IF NOT EXISTS shipment_group_id uuid,
  DROP CONSTRAINT IF EXISTS operations_label_attempts_execution_fkey,
  ADD CONSTRAINT operations_label_attempts_execution_fkey
    FOREIGN KEY (organization_id, fulfillment_execution_id)
    REFERENCES operations_fulfillment_executions(organization_id, id)
    ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS operations_label_attempts_shipment_group_fkey,
  ADD CONSTRAINT operations_label_attempts_shipment_group_fkey
    FOREIGN KEY (organization_id, shipment_group_id)
    REFERENCES operations_shipment_groups(organization_id, id)
    ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS
    operations_label_attempts_execution_group_pair_fkey,
  ADD CONSTRAINT operations_label_attempts_execution_group_pair_fkey
    FOREIGN KEY (
      organization_id, fulfillment_execution_id, shipment_group_id
    )
    REFERENCES operations_shipment_groups(
      organization_id, fulfillment_execution_id, id
    ) ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS
    operations_label_attempts_execution_package_fkey,
  ADD CONSTRAINT operations_label_attempts_execution_package_fkey
    FOREIGN KEY (
      organization_id, fulfillment_execution_id, package_id
    )
    REFERENCES operations_fulfillment_execution_packages(
      organization_id, execution_id, package_id
    ) ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS operations_label_attempts_execution_pair_valid,
  ADD CONSTRAINT operations_label_attempts_execution_pair_valid CHECK (
    (
      fulfillment_execution_id IS NULL
      AND shipment_group_id IS NULL
    )
    OR (
      fulfillment_execution_id IS NOT NULL
      AND shipment_group_id IS NOT NULL
    )
  );

ALTER TABLE operations_labels
  ADD COLUMN IF NOT EXISTS fulfillment_execution_id uuid,
  ADD COLUMN IF NOT EXISTS shipment_group_id uuid,
  DROP CONSTRAINT IF EXISTS operations_labels_execution_fkey,
  ADD CONSTRAINT operations_labels_execution_fkey
    FOREIGN KEY (organization_id, fulfillment_execution_id)
    REFERENCES operations_fulfillment_executions(organization_id, id)
    ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS operations_labels_shipment_group_fkey,
  ADD CONSTRAINT operations_labels_shipment_group_fkey
    FOREIGN KEY (organization_id, shipment_group_id)
    REFERENCES operations_shipment_groups(organization_id, id)
    ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS operations_labels_execution_group_pair_fkey,
  ADD CONSTRAINT operations_labels_execution_group_pair_fkey
    FOREIGN KEY (
      organization_id, fulfillment_execution_id, shipment_group_id
    )
    REFERENCES operations_shipment_groups(
      organization_id, fulfillment_execution_id, id
    ) ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS operations_labels_execution_package_fkey,
  ADD CONSTRAINT operations_labels_execution_package_fkey
    FOREIGN KEY (
      organization_id, fulfillment_execution_id, package_id
    )
    REFERENCES operations_fulfillment_execution_packages(
      organization_id, execution_id, package_id
    ) ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS operations_labels_execution_pair_valid,
  ADD CONSTRAINT operations_labels_execution_pair_valid CHECK (
    (
      fulfillment_execution_id IS NULL
      AND shipment_group_id IS NULL
    )
    OR (
      fulfillment_execution_id IS NOT NULL
      AND shipment_group_id IS NOT NULL
    )
  );

ALTER TABLE operations_shipments
  ADD COLUMN IF NOT EXISTS fulfillment_execution_id uuid,
  ADD COLUMN IF NOT EXISTS shipment_group_id uuid,
  DROP CONSTRAINT IF EXISTS operations_shipments_execution_fkey,
  ADD CONSTRAINT operations_shipments_execution_fkey
    FOREIGN KEY (organization_id, fulfillment_execution_id)
    REFERENCES operations_fulfillment_executions(organization_id, id)
    ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS operations_shipments_shipment_group_fkey,
  ADD CONSTRAINT operations_shipments_shipment_group_fkey
    FOREIGN KEY (organization_id, shipment_group_id)
    REFERENCES operations_shipment_groups(organization_id, id)
    ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS
    operations_shipments_execution_group_pair_fkey,
  ADD CONSTRAINT operations_shipments_execution_group_pair_fkey
    FOREIGN KEY (
      organization_id, fulfillment_execution_id, shipment_group_id
    )
    REFERENCES operations_shipment_groups(
      organization_id, fulfillment_execution_id, id
    ) ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS operations_shipments_execution_package_fkey,
  ADD CONSTRAINT operations_shipments_execution_package_fkey
    FOREIGN KEY (
      organization_id, fulfillment_execution_id, package_id
    )
    REFERENCES operations_fulfillment_execution_packages(
      organization_id, execution_id, package_id
    ) ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS operations_shipments_execution_pair_valid,
  ADD CONSTRAINT operations_shipments_execution_pair_valid CHECK (
    (
      fulfillment_execution_id IS NULL
      AND shipment_group_id IS NULL
    )
    OR (
      fulfillment_execution_id IS NOT NULL
      AND shipment_group_id IS NOT NULL
    )
  );

CREATE OR REPLACE FUNCTION
  protect_operations_shadow_fulfillment_link()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND (
       NEW.fulfillment_execution_id
         IS DISTINCT FROM OLD.fulfillment_execution_id
       OR NEW.shipment_group_id IS DISTINCT FROM OLD.shipment_group_id
     )
  THEN
    RAISE EXCEPTION
      'Fulfillment execution carrier-write links are immutable';
  END IF;
  IF NEW.fulfillment_execution_id IS NOT NULL
     OR NEW.shipment_group_id IS NOT NULL
  THEN
    RAISE EXCEPTION
      'Migration 0177 fulfillment executions are Shadow-only and cannot authorize label or shipment writes';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  protect_operations_label_attempt_shadow_execution_link
  ON operations_label_attempts;
CREATE TRIGGER protect_operations_label_attempt_shadow_execution_link
BEFORE INSERT OR UPDATE
ON operations_label_attempts
FOR EACH ROW EXECUTE FUNCTION
  protect_operations_shadow_fulfillment_link();

DROP TRIGGER IF EXISTS protect_operations_label_shadow_execution_link
  ON operations_labels;
CREATE TRIGGER protect_operations_label_shadow_execution_link
BEFORE INSERT OR UPDATE
ON operations_labels
FOR EACH ROW EXECUTE FUNCTION
  protect_operations_shadow_fulfillment_link();

DROP TRIGGER IF EXISTS protect_operations_shipment_shadow_execution_link
  ON operations_shipments;
CREATE TRIGGER protect_operations_shipment_shadow_execution_link
BEFORE INSERT OR UPDATE
ON operations_shipments
FOR EACH ROW EXECUTE FUNCTION
  protect_operations_shadow_fulfillment_link();

CREATE OR REPLACE FUNCTION
  protect_operations_fulfillment_preparation_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'Shadow fulfillment preparation evidence is immutable';
END;
$$;

CREATE TRIGGER protect_operations_fulfillment_execution_mutation
BEFORE UPDATE OR DELETE ON operations_fulfillment_executions
FOR EACH ROW EXECUTE FUNCTION
  protect_operations_fulfillment_preparation_immutable();

CREATE TRIGGER protect_operations_shipment_group_mutation
BEFORE UPDATE OR DELETE ON operations_shipment_groups
FOR EACH ROW EXECUTE FUNCTION
  protect_operations_fulfillment_preparation_immutable();

CREATE TRIGGER protect_operations_fulfillment_line_mutation
BEFORE UPDATE OR DELETE ON operations_fulfillment_execution_lines
FOR EACH ROW EXECUTE FUNCTION
  protect_operations_fulfillment_preparation_immutable();

CREATE TRIGGER protect_operations_fulfillment_package_mutation
BEFORE UPDATE OR DELETE ON operations_fulfillment_execution_packages
FOR EACH ROW EXECUTE FUNCTION
  protect_operations_fulfillment_preparation_immutable();

CREATE TRIGGER protect_operations_fulfillment_attempt_mutation
BEFORE UPDATE OR DELETE
ON operations_fulfillment_execution_rate_attempts
FOR EACH ROW EXECUTE FUNCTION
  protect_operations_fulfillment_preparation_immutable();

CREATE OR REPLACE FUNCTION validate_operations_fulfillment_execution()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  execution operations_fulfillment_executions%ROWTYPE;
  run operations_pack_rate_runs%ROWTYPE;
  checkout_run operations_pack_rate_runs%ROWTYPE;
  group_row operations_shipment_groups%ROWTYPE;
  order_status text;
  order_currency text;
  order_source_provider text;
  order_integration_account_id uuid;
  plan_status text;
  plan_order_id uuid;
  plan_warehouse_id uuid;
  group_count bigint;
  line_mismatch_count bigint;
  package_mismatch_count bigint;
  allocation_mismatch_count bigint;
  comparison_product_mismatch_count bigint := 0;
  checkout_line_mismatch_count bigint := 0;
  checkout_package_mismatch_count bigint := 0;
  checkout_allocation_mismatch_count bigint := 0;
  checkout_rate_mismatch_count bigint := 0;
  shopify_current_match_count bigint := 0;
  variance_count bigint := 0;
  configured_attempt_mismatch_count bigint := 0;
  rate_evidence_mismatch_count bigint := 0;
  selected_rate_evidence_count bigint := 0;
  selected_attempt_count bigint;
  selected_rate_attempt_status text;
  expected_destination_fingerprint text;
  ordered_fulfillment_parcels jsonb;
BEGIN
  IF TG_TABLE_NAME = 'operations_fulfillment_executions' THEN
    execution := NEW;
  ELSIF TG_TABLE_NAME = 'operations_shipment_groups' THEN
    SELECT * INTO execution
    FROM operations_fulfillment_executions candidate
    WHERE candidate.organization_id = NEW.organization_id
      AND candidate.id = NEW.fulfillment_execution_id;
  ELSIF TG_TABLE_NAME IN (
    'operations_label_attempts',
    'operations_labels',
    'operations_shipments'
  ) THEN
    IF NEW.fulfillment_execution_id IS NULL THEN
      RETURN NULL;
    END IF;
    SELECT * INTO execution
    FROM operations_fulfillment_executions candidate
    WHERE candidate.organization_id = NEW.organization_id
      AND candidate.id = NEW.fulfillment_execution_id;
  ELSE
    SELECT * INTO execution
    FROM operations_fulfillment_executions candidate
    WHERE candidate.organization_id = NEW.organization_id
      AND candidate.id = NEW.execution_id;
  END IF;
  IF execution.id IS NULL THEN
    RAISE EXCEPTION 'Fulfillment execution was not found';
  END IF;

  SELECT * INTO run
  FROM operations_pack_rate_runs candidate
  WHERE candidate.organization_id = execution.organization_id
    AND candidate.id = execution.fulfillment_pack_rate_run_id;
  SELECT * INTO checkout_run
  FROM operations_pack_rate_runs candidate
  WHERE candidate.organization_id = execution.organization_id
    AND candidate.id = execution.checkout_pack_rate_run_id;
  SELECT
    status, currency, source_provider, integration_account_id
    INTO
      order_status, order_currency, order_source_provider,
      order_integration_account_id
  FROM operations_orders source_order
  WHERE source_order.organization_id = execution.organization_id
    AND source_order.id = execution.order_id;
  SELECT status, order_id, warehouse_id
    INTO plan_status, plan_order_id, plan_warehouse_id
  FROM operations_fulfillment_plans plan
  WHERE plan.organization_id = execution.organization_id
    AND plan.id = execution.plan_id;
  SELECT count(*) INTO group_count
  FROM operations_shipment_groups candidate
  WHERE candidate.organization_id = execution.organization_id
    AND candidate.fulfillment_execution_id = execution.id;
  SELECT * INTO group_row
  FROM operations_shipment_groups candidate
  WHERE candidate.organization_id = execution.organization_id
    AND candidate.fulfillment_execution_id = execution.id;

  IF run.id IS NULL
     OR checkout_run.id IS NULL
     OR run.purpose <> 'fulfillment_execution'
     OR run.status <> 'succeeded'
     OR run.source_kind <> 'provider_checkout'
     OR run.prior_checkout_run_id
       IS DISTINCT FROM execution.checkout_pack_rate_run_id
     OR checkout_run.purpose <> 'checkout_quote'
     OR checkout_run.status <> 'succeeded'
     OR checkout_run.source_kind <> 'provider_checkout'
     OR checkout_run.provider IS DISTINCT FROM run.provider
     OR run.currency <> order_currency
     OR checkout_run.currency <> order_currency
     OR order_status <> 'packed'
     OR plan_status <> 'released'
     OR plan_order_id IS DISTINCT FROM execution.order_id
     OR group_count <> 1
     OR group_row.order_id IS DISTINCT FROM execution.order_id
     OR group_row.plan_id IS DISTINCT FROM execution.plan_id
     OR group_row.warehouse_id IS DISTINCT FROM plan_warehouse_id
     OR group_row.fulfillment_pack_rate_run_id
       IS DISTINCT FROM execution.fulfillment_pack_rate_run_id
     OR group_row.selected_provider IS DISTINCT FROM run.selected_provider
     OR group_row.selected_service_code
       IS DISTINCT FROM run.selected_service_code
     OR group_row.selected_service_name
       IS DISTINCT FROM run.selected_service_name
     OR group_row.selected_carrier_cost_minor
       IS DISTINCT FROM run.selected_carrier_cost_minor
     OR group_row.currency IS DISTINCT FROM run.currency
     OR group_row.state IS DISTINCT FROM execution.state
  THEN
    RAISE EXCEPTION
      'Fulfillment execution requires one exact packed order, released single-warehouse plan, rerate run, and shipment group';
  END IF;

  IF run.provider = 'shopify' THEN
    IF execution.shopify_checkout_reconciliation_id IS NULL
       OR execution.shopify_checkout_receipt_id IS NULL
       OR lower(order_source_provider) <> 'shopify'
    THEN
      RAISE EXCEPTION
        'Shopify Shadow preparation requires current matched checkout reconciliation and receipt lineage';
    END IF;

    SELECT
      count(*),
      max(receipt.carrier_destination_fingerprint)
      INTO shopify_current_match_count, expected_destination_fingerprint
    FROM operations_shopify_checkout_rate_current_reconciliations
      reconciliation
    JOIN operations_shopify_checkout_rate_receipts receipt
      ON receipt.organization_id = reconciliation.organization_id
     AND receipt.id = reconciliation.receipt_id
    WHERE reconciliation.organization_id = execution.organization_id
      AND reconciliation.id
        = execution.shopify_checkout_reconciliation_id
      AND reconciliation.order_id = execution.order_id
      AND reconciliation.receipt_id
        = execution.shopify_checkout_receipt_id
      AND reconciliation.integration_account_id
        = order_integration_account_id
      AND reconciliation.outcome = 'matched'
      AND receipt.status = 'succeeded'
      AND receipt.global_id = checkout_run.source_reference
      AND receipt.line_count = checkout_run.line_count
      AND receipt.package_count = checkout_run.package_count
      AND receipt.offer_count = checkout_run.rate_choice_count
      AND reconciliation.selected_carrier_provider
        = checkout_run.selected_provider
      AND reconciliation.selected_service_code
        = checkout_run.selected_service_code
      AND reconciliation.selected_customer_charge_minor
        = checkout_run.customer_charge_minor
      AND reconciliation.selected_currency = checkout_run.currency;

    SELECT count(*) INTO variance_count
    FROM operations_pack_rate_variances variance
    WHERE variance.organization_id = execution.organization_id
      AND variance.checkout_run_id = execution.checkout_pack_rate_run_id
      AND variance.fulfillment_run_id
        = execution.fulfillment_pack_rate_run_id;

    SELECT count(*) INTO checkout_line_mismatch_count
    FROM (
      (
        SELECT
          line.line_key,
          line.provider_variant_id,
          line.quantity,
          line.unit_weight_grams
        FROM operations_shopify_checkout_rate_receipt_lines line
        WHERE line.organization_id = execution.organization_id
          AND line.receipt_id = execution.shopify_checkout_receipt_id
        EXCEPT
        SELECT
          run_line.line_key,
          run_line.product_key,
          run_line.required_quantity,
          run_line.unit_weight_grams
        FROM operations_pack_rate_run_lines run_line
        WHERE run_line.organization_id = execution.organization_id
          AND run_line.run_id = execution.checkout_pack_rate_run_id
      )
      UNION ALL
      (
        SELECT
          run_line.line_key,
          run_line.product_key,
          run_line.required_quantity,
          run_line.unit_weight_grams
        FROM operations_pack_rate_run_lines run_line
        WHERE run_line.organization_id = execution.organization_id
          AND run_line.run_id = execution.checkout_pack_rate_run_id
        EXCEPT
        SELECT
          line.line_key,
          line.provider_variant_id,
          line.quantity,
          line.unit_weight_grams
        FROM operations_shopify_checkout_rate_receipt_lines line
        WHERE line.organization_id = execution.organization_id
          AND line.receipt_id = execution.shopify_checkout_receipt_id
      )
    ) mismatch;

    SELECT count(*) INTO checkout_package_mismatch_count
    FROM (
      (
        SELECT
          package.package_key,
          package.package_sequence,
          material.code,
          material.name,
          package.rated_outer_length_mm,
          package.rated_outer_width_mm,
          package.rated_outer_height_mm,
          package.content_weight_grams,
          package.tare_weight_grams,
          package.gross_weight_grams
        FROM operations_shopify_checkout_rate_receipt_packages package
        JOIN operations_packaging_materials material
          ON material.organization_id = package.organization_id
         AND material.id = package.packaging_material_id
        WHERE package.organization_id = execution.organization_id
          AND package.receipt_id = execution.shopify_checkout_receipt_id
        EXCEPT
        SELECT
          run_package.package_key,
          run_package.package_sequence,
          run_package.material_code,
          run_package.material_name,
          run_package.length_mm,
          run_package.width_mm,
          run_package.height_mm,
          run_package.content_weight_grams,
          run_package.tare_weight_grams,
          run_package.gross_weight_grams
        FROM operations_pack_rate_run_packages run_package
        WHERE run_package.organization_id = execution.organization_id
          AND run_package.run_id = execution.checkout_pack_rate_run_id
      )
      UNION ALL
      (
        SELECT
          run_package.package_key,
          run_package.package_sequence,
          run_package.material_code,
          run_package.material_name,
          run_package.length_mm,
          run_package.width_mm,
          run_package.height_mm,
          run_package.content_weight_grams,
          run_package.tare_weight_grams,
          run_package.gross_weight_grams
        FROM operations_pack_rate_run_packages run_package
        WHERE run_package.organization_id = execution.organization_id
          AND run_package.run_id = execution.checkout_pack_rate_run_id
        EXCEPT
        SELECT
          package.package_key,
          package.package_sequence,
          material.code,
          material.name,
          package.rated_outer_length_mm,
          package.rated_outer_width_mm,
          package.rated_outer_height_mm,
          package.content_weight_grams,
          package.tare_weight_grams,
          package.gross_weight_grams
        FROM operations_shopify_checkout_rate_receipt_packages package
        JOIN operations_packaging_materials material
          ON material.organization_id = package.organization_id
         AND material.id = package.packaging_material_id
        WHERE package.organization_id = execution.organization_id
          AND package.receipt_id = execution.shopify_checkout_receipt_id
      )
    ) mismatch;

    SELECT count(*) INTO checkout_allocation_mismatch_count
    FROM (
      (
        SELECT
          allocation.package_key,
          allocation.line_key,
          line.provider_variant_id,
          line.provider_variant_id,
          allocation.quantity
        FROM operations_shopify_checkout_rate_receipt_allocations
          allocation
        JOIN operations_shopify_checkout_rate_receipt_lines line
          ON line.organization_id = allocation.organization_id
         AND line.receipt_id = allocation.receipt_id
         AND line.line_key = allocation.line_key
        WHERE allocation.organization_id = execution.organization_id
          AND allocation.receipt_id
            = execution.shopify_checkout_receipt_id
        EXCEPT
        SELECT
          run_allocation.package_key,
          run_allocation.line_key,
          run_allocation.product_key,
          run_allocation.comparison_product_key,
          run_allocation.quantity
        FROM operations_pack_rate_run_allocations run_allocation
        WHERE run_allocation.organization_id = execution.organization_id
          AND run_allocation.run_id = execution.checkout_pack_rate_run_id
      )
      UNION ALL
      (
        SELECT
          run_allocation.package_key,
          run_allocation.line_key,
          run_allocation.product_key,
          run_allocation.comparison_product_key,
          run_allocation.quantity
        FROM operations_pack_rate_run_allocations run_allocation
        WHERE run_allocation.organization_id = execution.organization_id
          AND run_allocation.run_id = execution.checkout_pack_rate_run_id
        EXCEPT
        SELECT
          allocation.package_key,
          allocation.line_key,
          line.provider_variant_id,
          line.provider_variant_id,
          allocation.quantity
        FROM operations_shopify_checkout_rate_receipt_allocations
          allocation
        JOIN operations_shopify_checkout_rate_receipt_lines line
          ON line.organization_id = allocation.organization_id
         AND line.receipt_id = allocation.receipt_id
         AND line.line_key = allocation.line_key
        WHERE allocation.organization_id = execution.organization_id
          AND allocation.receipt_id
            = execution.shopify_checkout_receipt_id
      )
    ) mismatch;

    SELECT count(*) INTO checkout_rate_mismatch_count
    FROM (
      (
        SELECT
          offer.carrier_provider,
          offer.service_code,
          offer.service_name,
          offer.carrier_cost_minor,
          offer.currency
        FROM operations_shopify_checkout_rate_receipt_offers offer
        WHERE offer.organization_id = execution.organization_id
          AND offer.receipt_id = execution.shopify_checkout_receipt_id
        EXCEPT
        SELECT
          choice.provider,
          choice.service_code,
          choice.service_name,
          choice.carrier_cost_minor,
          choice.currency
        FROM operations_pack_rate_run_rate_choices choice
        WHERE choice.organization_id = execution.organization_id
          AND choice.run_id = execution.checkout_pack_rate_run_id
      )
      UNION ALL
      (
        SELECT
          choice.provider,
          choice.service_code,
          choice.service_name,
          choice.carrier_cost_minor,
          choice.currency
        FROM operations_pack_rate_run_rate_choices choice
        WHERE choice.organization_id = execution.organization_id
          AND choice.run_id = execution.checkout_pack_rate_run_id
        EXCEPT
        SELECT
          offer.carrier_provider,
          offer.service_code,
          offer.service_name,
          offer.carrier_cost_minor,
          offer.currency
        FROM operations_shopify_checkout_rate_receipt_offers offer
        WHERE offer.organization_id = execution.organization_id
          AND offer.receipt_id = execution.shopify_checkout_receipt_id
      )
    ) mismatch;

    IF shopify_current_match_count <> 1
       OR variance_count <> 1
       OR checkout_line_mismatch_count <> 0
       OR checkout_package_mismatch_count <> 0
       OR checkout_allocation_mismatch_count <> 0
       OR checkout_rate_mismatch_count <> 0
    THEN
      RAISE EXCEPTION
        'Shopify Shadow preparation requires exact current checkout receipt, pack-rate, and variance lineage';
    END IF;
  ELSE
    IF execution.shopify_checkout_reconciliation_id IS NOT NULL
       OR execution.shopify_checkout_receipt_id IS NOT NULL
    THEN
      RAISE EXCEPTION
        'Non-Shopify preparation cannot claim Shopify checkout lineage';
    END IF;
    expected_destination_fingerprint :=
      run.input_snapshot->>'carrierDestinationFingerprint';
  END IF;

  IF expected_destination_fingerprint IS NULL
     OR expected_destination_fingerprint !~ '^[a-f0-9]{64}$'
  THEN
    RAISE EXCEPTION
      'Shadow fulfillment rerate requires one keyed destination fingerprint';
  END IF;

  SELECT count(*) INTO line_mismatch_count
  FROM (
    (
      SELECT
        order_line.global_id,
        product.reference_code,
        order_line.quantity
      FROM operations_order_lines order_line
      JOIN crm_products product
        ON product.pipeline_id = order_line.pipeline_id
       AND product.id = order_line.product_id
      WHERE order_line.organization_id = execution.organization_id
        AND order_line.order_id = execution.order_id
      EXCEPT
      SELECT
        run_line.line_key,
        run_line.product_key,
        run_line.required_quantity::numeric
      FROM operations_pack_rate_run_lines run_line
      WHERE run_line.organization_id = execution.organization_id
        AND run_line.run_id = execution.fulfillment_pack_rate_run_id
    )
    UNION ALL
    (
      SELECT
        run_line.line_key,
        run_line.product_key,
        run_line.required_quantity::numeric
      FROM operations_pack_rate_run_lines run_line
      WHERE run_line.organization_id = execution.organization_id
        AND run_line.run_id = execution.fulfillment_pack_rate_run_id
      EXCEPT
      SELECT
        order_line.global_id,
        product.reference_code,
        order_line.quantity
      FROM operations_order_lines order_line
      JOIN crm_products product
        ON product.pipeline_id = order_line.pipeline_id
       AND product.id = order_line.product_id
      WHERE order_line.organization_id = execution.organization_id
        AND order_line.order_id = execution.order_id
    )
    UNION ALL
    (
      SELECT
        edge.order_line_id,
        edge.line_key,
        edge.product_key,
        edge.required_quantity
      FROM operations_fulfillment_execution_lines edge
      WHERE edge.organization_id = execution.organization_id
        AND edge.execution_id = execution.id
      EXCEPT
      SELECT
        order_line.id,
        order_line.global_id,
        product.reference_code,
        order_line.quantity
      FROM operations_order_lines order_line
      JOIN crm_products product
        ON product.pipeline_id = order_line.pipeline_id
       AND product.id = order_line.product_id
      WHERE order_line.organization_id = execution.organization_id
        AND order_line.order_id = execution.order_id
    )
    UNION ALL
    (
      SELECT
        order_line.id,
        order_line.global_id,
        product.reference_code,
        order_line.quantity
      FROM operations_order_lines order_line
      JOIN crm_products product
        ON product.pipeline_id = order_line.pipeline_id
       AND product.id = order_line.product_id
      WHERE order_line.organization_id = execution.organization_id
        AND order_line.order_id = execution.order_id
      EXCEPT
      SELECT
        edge.order_line_id,
        edge.line_key,
        edge.product_key,
        edge.required_quantity
      FROM operations_fulfillment_execution_lines edge
      WHERE edge.organization_id = execution.organization_id
        AND edge.execution_id = execution.id
    )
  ) mismatch;

  SELECT count(*) INTO package_mismatch_count
  FROM (
    (
      SELECT
        package.evidence_package_key,
        package.package_number,
        material.code,
        material.name,
        package.length_mm,
        package.width_mm,
        package.height_mm,
        evidence_package.content_weight_grams,
        evidence_package.tare_weight_grams,
        package.weight_grams
      FROM operations_packages package
      JOIN operations_cartonization_rate_evidence_packages
        evidence_package
        ON evidence_package.organization_id = package.organization_id
       AND evidence_package.evidence_id = package.cartonization_evidence_id
       AND evidence_package.package_key = package.evidence_package_key
      JOIN operations_packaging_materials material
        ON material.organization_id = evidence_package.organization_id
       AND material.id = evidence_package.packaging_material_id
      WHERE package.organization_id = execution.organization_id
        AND package.plan_id = execution.plan_id
        AND package.status = 'packed'
      EXCEPT
      SELECT
        run_package.package_key,
        run_package.package_sequence,
        run_package.material_code,
        run_package.material_name,
        run_package.length_mm,
        run_package.width_mm,
        run_package.height_mm,
        run_package.content_weight_grams,
        run_package.tare_weight_grams,
        run_package.gross_weight_grams
      FROM operations_pack_rate_run_packages run_package
      WHERE run_package.organization_id = execution.organization_id
        AND run_package.run_id = execution.fulfillment_pack_rate_run_id
    )
    UNION ALL
    (
      SELECT
        run_package.package_key,
        run_package.package_sequence,
        run_package.material_code,
        run_package.material_name,
        run_package.length_mm,
        run_package.width_mm,
        run_package.height_mm,
        run_package.content_weight_grams,
        run_package.tare_weight_grams,
        run_package.gross_weight_grams
      FROM operations_pack_rate_run_packages run_package
      WHERE run_package.organization_id = execution.organization_id
        AND run_package.run_id = execution.fulfillment_pack_rate_run_id
      EXCEPT
      SELECT
        package.evidence_package_key,
        package.package_number,
        material.code,
        material.name,
        package.length_mm,
        package.width_mm,
        package.height_mm,
        evidence_package.content_weight_grams,
        evidence_package.tare_weight_grams,
        package.weight_grams
      FROM operations_packages package
      JOIN operations_cartonization_rate_evidence_packages
        evidence_package
        ON evidence_package.organization_id = package.organization_id
       AND evidence_package.evidence_id = package.cartonization_evidence_id
       AND evidence_package.package_key = package.evidence_package_key
      JOIN operations_packaging_materials material
        ON material.organization_id = evidence_package.organization_id
       AND material.id = evidence_package.packaging_material_id
      WHERE package.organization_id = execution.organization_id
        AND package.plan_id = execution.plan_id
        AND package.status = 'packed'
    )
    UNION ALL
    (
      SELECT edge.package_id, edge.package_key
      FROM operations_fulfillment_execution_packages edge
      WHERE edge.organization_id = execution.organization_id
        AND edge.execution_id = execution.id
        AND edge.shipment_group_id = group_row.id
      EXCEPT
      SELECT package.id, package.evidence_package_key
      FROM operations_packages package
      WHERE package.organization_id = execution.organization_id
        AND package.plan_id = execution.plan_id
        AND package.status = 'packed'
    )
    UNION ALL
    (
      SELECT package.id, package.evidence_package_key
      FROM operations_packages package
      WHERE package.organization_id = execution.organization_id
        AND package.plan_id = execution.plan_id
        AND package.status = 'packed'
      EXCEPT
      SELECT edge.package_id, edge.package_key
      FROM operations_fulfillment_execution_packages edge
      WHERE edge.organization_id = execution.organization_id
        AND edge.execution_id = execution.id
        AND edge.shipment_group_id = group_row.id
    )
  ) mismatch;

  SELECT count(*) INTO allocation_mismatch_count
  FROM (
    (
      SELECT
        run_allocation.package_key,
        run_allocation.line_key,
        run_allocation.product_key,
        run_allocation.quantity::numeric
      FROM operations_pack_rate_run_allocations run_allocation
      WHERE run_allocation.organization_id = execution.organization_id
        AND run_allocation.run_id
          = execution.fulfillment_pack_rate_run_id
      EXCEPT
      SELECT
        package.evidence_package_key,
        order_line.global_id,
        product.reference_code,
        content.quantity
      FROM operations_package_contents content
      JOIN operations_packages package
        ON package.organization_id = content.organization_id
       AND package.id = content.package_id
      JOIN operations_order_lines order_line
        ON order_line.organization_id = content.organization_id
       AND order_line.id = content.order_line_id
      JOIN crm_products product
        ON product.pipeline_id = order_line.pipeline_id
       AND product.id = order_line.product_id
      WHERE content.organization_id = execution.organization_id
        AND content.plan_id = execution.plan_id
    )
    UNION ALL
    (
      SELECT
        package.evidence_package_key,
        order_line.global_id,
        product.reference_code,
        content.quantity
      FROM operations_package_contents content
      JOIN operations_packages package
        ON package.organization_id = content.organization_id
       AND package.id = content.package_id
      JOIN operations_order_lines order_line
        ON order_line.organization_id = content.organization_id
       AND order_line.id = content.order_line_id
      JOIN crm_products product
        ON product.pipeline_id = order_line.pipeline_id
       AND product.id = order_line.product_id
      WHERE content.organization_id = execution.organization_id
        AND content.plan_id = execution.plan_id
      EXCEPT
      SELECT
        run_allocation.package_key,
        run_allocation.line_key,
        run_allocation.product_key,
        run_allocation.quantity::numeric
      FROM operations_pack_rate_run_allocations run_allocation
      WHERE run_allocation.organization_id = execution.organization_id
        AND run_allocation.run_id
          = execution.fulfillment_pack_rate_run_id
    )
  ) mismatch;

  IF run.provider = 'shopify' THEN
    SELECT count(*) INTO comparison_product_mismatch_count
    FROM (
      (
        SELECT
          run_allocation.package_key,
          run_allocation.line_key,
          run_allocation.product_key,
          run_allocation.comparison_product_key,
          run_allocation.quantity::numeric
        FROM operations_pack_rate_run_allocations run_allocation
        WHERE run_allocation.organization_id = execution.organization_id
          AND run_allocation.run_id
            = execution.fulfillment_pack_rate_run_id
        EXCEPT
        SELECT
          package.evidence_package_key,
          order_line.global_id,
          product.reference_code,
          candidate_line.external_variant_id,
          content.quantity
        FROM operations_package_contents content
        JOIN operations_packages package
          ON package.organization_id = content.organization_id
         AND package.id = content.package_id
        JOIN operations_order_lines order_line
          ON order_line.organization_id = content.organization_id
         AND order_line.id = content.order_line_id
        JOIN crm_products product
          ON product.pipeline_id = order_line.pipeline_id
         AND product.id = order_line.product_id
        JOIN operations_commerce_order_candidates order_candidate
          ON order_candidate.organization_id = content.organization_id
         AND order_candidate.canonical_order_id = execution.order_id
         AND order_candidate.integration_account_id
           = order_integration_account_id
         AND order_candidate.provider = 'shopify'
         AND order_candidate.workflow_state = 'promoted'
        JOIN operations_commerce_order_candidate_lines candidate_line
          ON candidate_line.organization_id = content.organization_id
         AND candidate_line.order_candidate_id = order_candidate.id
         AND candidate_line.canonical_order_line_id = order_line.id
         AND candidate_line.provider = 'shopify'
         AND candidate_line.workflow_state = 'promoted'
        WHERE content.organization_id = execution.organization_id
          AND content.plan_id = execution.plan_id
          AND candidate_line.external_variant_id IS NOT NULL
      )
      UNION ALL
      (
        SELECT
          package.evidence_package_key,
          order_line.global_id,
          product.reference_code,
          candidate_line.external_variant_id,
          content.quantity
        FROM operations_package_contents content
        JOIN operations_packages package
          ON package.organization_id = content.organization_id
         AND package.id = content.package_id
        JOIN operations_order_lines order_line
          ON order_line.organization_id = content.organization_id
         AND order_line.id = content.order_line_id
        JOIN crm_products product
          ON product.pipeline_id = order_line.pipeline_id
         AND product.id = order_line.product_id
        JOIN operations_commerce_order_candidates order_candidate
          ON order_candidate.organization_id = content.organization_id
         AND order_candidate.canonical_order_id = execution.order_id
         AND order_candidate.integration_account_id
           = order_integration_account_id
         AND order_candidate.provider = 'shopify'
         AND order_candidate.workflow_state = 'promoted'
        JOIN operations_commerce_order_candidate_lines candidate_line
          ON candidate_line.organization_id = content.organization_id
         AND candidate_line.order_candidate_id = order_candidate.id
         AND candidate_line.canonical_order_line_id = order_line.id
         AND candidate_line.provider = 'shopify'
         AND candidate_line.workflow_state = 'promoted'
        WHERE content.organization_id = execution.organization_id
          AND content.plan_id = execution.plan_id
          AND candidate_line.external_variant_id IS NOT NULL
        EXCEPT
        SELECT
          run_allocation.package_key,
          run_allocation.line_key,
          run_allocation.product_key,
          run_allocation.comparison_product_key,
          run_allocation.quantity::numeric
        FROM operations_pack_rate_run_allocations run_allocation
        WHERE run_allocation.organization_id = execution.organization_id
          AND run_allocation.run_id
            = execution.fulfillment_pack_rate_run_id
      )
    ) mismatch;
  END IF;

  SELECT jsonb_agg(
    operations_shopify_checkout_carrier_parcel_snapshot(
      package.package_key,
      package.package_sequence,
      package.length_mm,
      package.width_mm,
      package.height_mm,
      package.gross_weight_grams
    )
    ORDER BY package.package_sequence, package.package_key
  )
  INTO ordered_fulfillment_parcels
  FROM operations_pack_rate_run_packages package
  WHERE package.organization_id = execution.organization_id
    AND package.run_id = execution.fulfillment_pack_rate_run_id;

  IF run.provider = 'shopify' THEN
    SELECT count(*) INTO configured_attempt_mismatch_count
    FROM (
      (
        SELECT configured.carrier_provider,
               configured.carrier_account_id::text
        FROM operations_shopify_checkout_rate_receipts receipt
        JOIN operations_shopify_carrier_service_config_carriers
          configured
          ON configured.organization_id = receipt.organization_id
         AND configured.config_id = receipt.config_id
        WHERE receipt.organization_id = execution.organization_id
          AND receipt.id = execution.shopify_checkout_receipt_id
        EXCEPT
        SELECT attempt.carrier_provider,
               attempt.carrier_account_id::text
        FROM operations_fulfillment_execution_rate_attempts attempt
        WHERE attempt.organization_id = execution.organization_id
          AND attempt.execution_id = execution.id
      )
      UNION ALL
      (
        SELECT attempt.carrier_provider,
               attempt.carrier_account_id::text
        FROM operations_fulfillment_execution_rate_attempts attempt
        WHERE attempt.organization_id = execution.organization_id
          AND attempt.execution_id = execution.id
        EXCEPT
        SELECT configured.carrier_provider,
               configured.carrier_account_id::text
        FROM operations_shopify_checkout_rate_receipts receipt
        JOIN operations_shopify_carrier_service_config_carriers
          configured
          ON configured.organization_id = receipt.organization_id
         AND configured.config_id = receipt.config_id
        WHERE receipt.organization_id = execution.organization_id
          AND receipt.id = execution.shopify_checkout_receipt_id
      )
    ) mismatch;
  ELSE
    SELECT count(*) INTO configured_attempt_mismatch_count
    FROM (
      (
        SELECT
          configured.value->>'provider',
          configured.value->>'carrierAccountId'
        FROM jsonb_array_elements(
          COALESCE(
            run.input_snapshot->'configuredCarriers',
            '[]'::jsonb
          )
        ) configured(value)
        EXCEPT
        SELECT attempt.carrier_provider,
               attempt.carrier_account_id::text
        FROM operations_fulfillment_execution_rate_attempts attempt
        WHERE attempt.organization_id = execution.organization_id
          AND attempt.execution_id = execution.id
      )
      UNION ALL
      (
        SELECT attempt.carrier_provider,
               attempt.carrier_account_id::text
        FROM operations_fulfillment_execution_rate_attempts attempt
        WHERE attempt.organization_id = execution.organization_id
          AND attempt.execution_id = execution.id
        EXCEPT
        SELECT
          configured.value->>'provider',
          configured.value->>'carrierAccountId'
        FROM jsonb_array_elements(
          COALESCE(
            run.input_snapshot->'configuredCarriers',
            '[]'::jsonb
          )
        ) configured(value)
      )
    ) mismatch;
  END IF;

  SELECT count(*) INTO rate_evidence_mismatch_count
  FROM operations_fulfillment_execution_rate_attempts attempt
  LEFT JOIN operations_carrier_accounts carrier_account
    ON carrier_account.organization_id = attempt.organization_id
   AND carrier_account.id = attempt.carrier_account_id
  LEFT JOIN operations_carrier_rate_requests rate_evidence
    ON rate_evidence.organization_id = attempt.organization_id
   AND rate_evidence.id = attempt.carrier_rate_request_id
  WHERE attempt.organization_id = execution.organization_id
    AND attempt.execution_id = execution.id
    AND (
      attempt.fulfillment_pack_rate_run_id
        IS DISTINCT FROM execution.fulfillment_pack_rate_run_id
      OR rate_evidence.id IS NULL
      OR rate_evidence.integration_account_id
        IS DISTINCT FROM carrier_account.integration_account_id
      OR rate_evidence.carrier_account_id
        IS DISTINCT FROM attempt.carrier_account_id
      OR rate_evidence.provider IS DISTINCT FROM attempt.carrier_provider
      OR rate_evidence.purpose IS DISTINCT FROM attempt.carrier_rate_purpose
      OR rate_evidence.request_hash
        IS DISTINCT FROM attempt.carrier_request_hash
      OR rate_evidence.environment IS DISTINCT FROM attempt.environment
      OR rate_evidence.environment IS DISTINCT FROM 'sandbox'
      OR rate_evidence.redacted_request #>>
        '{shipment,destinationFingerprint}'
        IS DISTINCT FROM expected_destination_fingerprint
      OR rate_evidence.redacted_request #>>
        '{shipment,rateScope}'
        IS DISTINCT FROM 'multi_package_shipment'
      OR rate_evidence.redacted_request #> '{shipment,packageCount}'
        IS DISTINCT FROM to_jsonb(run.package_count)
      OR rate_evidence.redacted_request #> '{shipment,parcels}'
        IS DISTINCT FROM ordered_fulfillment_parcels
      OR rate_evidence.redacted_response #>>
        '{rateScope}' IS DISTINCT FROM 'multi_package_shipment'
      OR rate_evidence.redacted_response #> '{packageCount}'
        IS DISTINCT FROM to_jsonb(run.package_count)
      OR (
        attempt.attempt_status = 'succeeded'
        AND (
          rate_evidence.status IS DISTINCT FROM 'succeeded'
          OR rate_evidence.error_code IS NOT NULL
          OR attempt.failure_code IS NOT NULL
        )
      )
      OR (
        attempt.attempt_status = 'degraded'
        AND (
          rate_evidence.status IS DISTINCT FROM 'failed'
          OR rate_evidence.error_code
            IS DISTINCT FROM attempt.failure_code
          OR rate_evidence.redacted_response #>> '{errorCode}'
            IS DISTINCT FROM attempt.failure_code
        )
      )
    );

  SELECT
    count(*) FILTER (WHERE selected),
    max(attempt_status) FILTER (WHERE selected)
    INTO selected_attempt_count, selected_rate_attempt_status
  FROM operations_fulfillment_execution_rate_attempts attempt
  WHERE attempt.organization_id = execution.organization_id
    AND attempt.execution_id = execution.id
    AND (
      NOT attempt.selected
      OR attempt.carrier_provider = run.selected_provider
    );

  SELECT count(*) INTO selected_rate_evidence_count
  FROM operations_fulfillment_execution_rate_attempts attempt
  JOIN operations_carrier_rate_requests rate_evidence
    ON rate_evidence.organization_id = attempt.organization_id
   AND rate_evidence.id = attempt.carrier_rate_request_id
  JOIN operations_pack_rate_run_rate_choices choice
    ON choice.organization_id = attempt.organization_id
   AND choice.run_id = attempt.fulfillment_pack_rate_run_id
   AND choice.provider = attempt.carrier_provider
   AND choice.selected
  WHERE attempt.organization_id = execution.organization_id
    AND attempt.execution_id = execution.id
    AND attempt.selected
    AND attempt.attempt_status = 'succeeded'
    AND attempt.carrier_provider = run.selected_provider
    AND choice.service_code = run.selected_service_code
    AND choice.service_name = run.selected_service_name
    AND choice.carrier_cost_minor = run.selected_carrier_cost_minor
    AND choice.currency = run.currency
    AND (
      SELECT count(*)
      FROM jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(rate_evidence.redacted_response->'rates')
            = 'array'
          THEN rate_evidence.redacted_response->'rates'
          ELSE '[]'::jsonb
        END
      ) response_rate(value)
      WHERE response_rate.value = choice.normalized_response
        AND lower(response_rate.value->>'serviceCode')
          = lower(choice.service_code)
        AND response_rate.value->>'serviceName' = choice.service_name
        AND upper(response_rate.value->>'currency') = choice.currency
        AND CASE
          WHEN response_rate.value->>'amount'
            ~ '^(0|[1-9][0-9]{0,12})(\.[0-9]{1,2})?$'
          THEN (
            (response_rate.value->>'amount')::numeric * 100
          )::bigint = choice.carrier_cost_minor
          ELSE false
        END
    ) = 1;

  IF line_mismatch_count <> 0
     OR package_mismatch_count <> 0
     OR allocation_mismatch_count <> 0
     OR comparison_product_mismatch_count <> 0
     OR configured_attempt_mismatch_count <> 0
     OR rate_evidence_mismatch_count <> 0
     OR selected_attempt_count <> 1
     OR selected_rate_attempt_status IS DISTINCT FROM 'succeeded'
     OR selected_rate_evidence_count <> 1
     OR EXISTS (
       SELECT 1
       FROM operations_pack_rate_run_rate_choices choice
       LEFT JOIN operations_fulfillment_execution_rate_attempts attempt
         ON attempt.organization_id = choice.organization_id
        AND attempt.execution_id = execution.id
        AND attempt.carrier_provider = choice.provider
        AND attempt.attempt_status = 'succeeded'
       WHERE choice.organization_id = execution.organization_id
         AND choice.run_id = execution.fulfillment_pack_rate_run_id
         AND attempt.carrier_provider IS NULL
     )
     OR EXISTS (
       SELECT 1
       FROM operations_fulfillment_execution_rate_attempts attempt
       WHERE attempt.organization_id = execution.organization_id
         AND attempt.execution_id = execution.id
         AND (
           (
             attempt.attempt_status = 'succeeded'
             AND NOT EXISTS (
               SELECT 1
               FROM operations_pack_rate_run_rate_choices choice
               WHERE choice.organization_id = attempt.organization_id
                 AND choice.run_id
                   = execution.fulfillment_pack_rate_run_id
                 AND choice.provider = attempt.carrier_provider
             )
           )
           OR (
             attempt.attempt_status = 'degraded'
             AND EXISTS (
               SELECT 1
               FROM operations_pack_rate_run_rate_choices choice
               WHERE choice.organization_id = attempt.organization_id
                 AND choice.run_id
                   = execution.fulfillment_pack_rate_run_id
                 AND choice.provider = attempt.carrier_provider
             )
           )
         )
     )
  THEN
    RAISE EXCEPTION
      'Fulfillment execution requires exact canonical lines, packages, allocations, and one succeeded selected whole-shipment rate attempt';
  END IF;

  IF execution.authority_mode = 'shadow' AND (
    EXISTS (
      SELECT 1
      FROM operations_label_attempts attempt
      WHERE attempt.organization_id = execution.organization_id
        AND attempt.fulfillment_execution_id = execution.id
    )
    OR EXISTS (
      SELECT 1
      FROM operations_labels label
      WHERE label.organization_id = execution.organization_id
        AND label.fulfillment_execution_id = execution.id
    )
    OR EXISTS (
      SELECT 1
      FROM operations_shipments shipment
      WHERE shipment.organization_id = execution.organization_id
        AND shipment.fulfillment_execution_id = execution.id
    )
  ) THEN
    RAISE EXCEPTION
      'Shadow fulfillment execution cannot retain carrier labels or shipments';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER validate_operations_fulfillment_execution_deferred
AFTER INSERT OR UPDATE
ON operations_fulfillment_executions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_operations_fulfillment_execution();

CREATE CONSTRAINT TRIGGER validate_operations_fulfillment_group_deferred
AFTER INSERT OR UPDATE
ON operations_shipment_groups
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_operations_fulfillment_execution();

CREATE CONSTRAINT TRIGGER validate_operations_fulfillment_lines_deferred
AFTER INSERT OR UPDATE
ON operations_fulfillment_execution_lines
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_operations_fulfillment_execution();

CREATE CONSTRAINT TRIGGER validate_operations_fulfillment_packages_deferred
AFTER INSERT OR UPDATE
ON operations_fulfillment_execution_packages
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_operations_fulfillment_execution();

CREATE CONSTRAINT TRIGGER validate_operations_fulfillment_attempts_deferred
AFTER INSERT OR UPDATE
ON operations_fulfillment_execution_rate_attempts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_operations_fulfillment_execution();

CREATE CONSTRAINT TRIGGER validate_operations_fulfillment_label_attempt_link_deferred
AFTER INSERT OR UPDATE
ON operations_label_attempts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_operations_fulfillment_execution();

CREATE CONSTRAINT TRIGGER validate_operations_fulfillment_label_link_deferred
AFTER INSERT OR UPDATE
ON operations_labels
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_operations_fulfillment_execution();

CREATE CONSTRAINT TRIGGER validate_operations_fulfillment_shipment_link_deferred
AFTER INSERT OR UPDATE
ON operations_shipments
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_operations_fulfillment_execution();

COMMENT ON TABLE operations_fulfillment_executions IS
  'Immutable Shadow-only fulfillment-rerate preparation. Rows prove exact checkout, order, plan, package, variance, and carrier-read lineage with zero provider, postage, label, or commerce writes.';
COMMENT ON TABLE operations_shipment_groups IS
  'One selected carrier service for the complete current single-warehouse package set. Future split-warehouse work expands this boundary without allowing per-package service stitching inside a group.';
COMMENT ON TABLE operations_fulfillment_execution_rate_attempts IS
  'Typed whole-shipment rerate attempts. Exactly one succeeded provider attempt must match the selected service before fulfillment execution can be prepared.';
