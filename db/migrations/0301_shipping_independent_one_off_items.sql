-- Keep one-off Shipping independent from the Operations activation profile and
-- retain productless item evidence without weakening canonical product lines.

CREATE TABLE IF NOT EXISTS operations_shipping_scopes (
  organization_id uuid PRIMARY KEY
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  data_pipeline_id uuid NOT NULL REFERENCES pipeline_spaces(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_shipping_scopes_pipeline_scope_fkey
    FOREIGN KEY (organization_id, data_pipeline_id)
    REFERENCES pipeline_spaces(workspace_organization_id, id) ON DELETE RESTRICT
);

COMMENT ON TABLE operations_shipping_scopes IS
  'Organization Shipping pipeline selection; deliberately independent from Operations activation state.';

-- Preserve the current organization data partition at migration time. Later
-- Operations profile/state changes cannot alter this independent Shipping row.
INSERT INTO operations_shipping_scopes (organization_id, data_pipeline_id)
SELECT activation.organization_id, activation.data_pipeline_id
FROM operations_activation_scopes activation
ON CONFLICT (organization_id) DO NOTHING;

-- New Shipping permissions must preserve each legacy actor's effective
-- authority. Missing keys are backfilled from the exact pre-0301 route gates;
-- explicit grants and denials remain untouched.
UPDATE app_users app_user
SET permissions = COALESCE(app_user.permissions, '{}'::jsonb)
  || CASE WHEN NOT COALESCE(app_user.permissions, '{}'::jsonb) ? 'viewShipping'
    THEN jsonb_build_object(
      'viewShipping',
      app_user.role = 'owner'
        OR COALESCE(
          COALESCE(app_user.permissions, '{}'::jsonb)->'viewOperations',
          'false'::jsonb
        ) = 'true'::jsonb
    ) ELSE '{}'::jsonb END
  || CASE WHEN NOT COALESCE(app_user.permissions, '{}'::jsonb) ? 'createShipments'
    THEN jsonb_build_object(
      'createShipments',
      app_user.role = 'owner'
        OR (
          app_user.role = 'admin'
          AND COALESCE(
            COALESCE(app_user.permissions, '{}'::jsonb)->'manageOperations',
            'false'::jsonb
          ) = 'true'::jsonb
          AND COALESCE(
            COALESCE(app_user.permissions, '{}'::jsonb)->'executeWarehouse',
            'false'::jsonb
          ) = 'true'::jsonb
        )
    ) ELSE '{}'::jsonb END
  || CASE WHEN NOT COALESCE(app_user.permissions, '{}'::jsonb) ? 'purchaseLivePostage'
    THEN jsonb_build_object(
      'purchaseLivePostage',
      app_user.role = 'owner'
        OR (
          app_user.role = 'admin'
          AND COALESCE(
            COALESCE(app_user.permissions, '{}'::jsonb)->'manageOperations',
            'false'::jsonb
          ) = 'true'::jsonb
          AND COALESCE(
            COALESCE(app_user.permissions, '{}'::jsonb)->'executeWarehouse',
            'false'::jsonb
          ) = 'true'::jsonb
        )
    ) ELSE '{}'::jsonb END
WHERE NOT COALESCE(app_user.permissions, '{}'::jsonb)
  ?& ARRAY['viewShipping', 'createShipments', 'purchaseLivePostage'];

UPDATE app_user_organization_memberships membership
SET permissions = COALESCE(membership.permissions, '{}'::jsonb)
  || CASE WHEN NOT COALESCE(membership.permissions, '{}'::jsonb) ? 'viewShipping'
    THEN jsonb_build_object(
      'viewShipping',
      membership.role = 'owner'
        OR COALESCE(
          COALESCE(membership.permissions, '{}'::jsonb)->'viewOperations',
          'false'::jsonb
        ) = 'true'::jsonb
    ) ELSE '{}'::jsonb END
  || CASE WHEN NOT COALESCE(membership.permissions, '{}'::jsonb) ? 'createShipments'
    THEN jsonb_build_object(
      'createShipments',
      membership.role = 'owner'
        OR (
          membership.role = 'admin'
          AND COALESCE(
            COALESCE(membership.permissions, '{}'::jsonb)->'manageOperations',
            'false'::jsonb
          ) = 'true'::jsonb
          AND COALESCE(
            COALESCE(membership.permissions, '{}'::jsonb)->'executeWarehouse',
            'false'::jsonb
          ) = 'true'::jsonb
        )
    ) ELSE '{}'::jsonb END
  || CASE WHEN NOT COALESCE(membership.permissions, '{}'::jsonb) ? 'purchaseLivePostage'
    THEN jsonb_build_object(
      'purchaseLivePostage',
      membership.role = 'owner'
        OR (
          membership.role = 'admin'
          AND COALESCE(
            COALESCE(membership.permissions, '{}'::jsonb)->'manageOperations',
            'false'::jsonb
          ) = 'true'::jsonb
          AND COALESCE(
            COALESCE(membership.permissions, '{}'::jsonb)->'executeWarehouse',
            'false'::jsonb
          ) = 'true'::jsonb
        )
    ) ELSE '{}'::jsonb END
WHERE NOT COALESCE(membership.permissions, '{}'::jsonb)
  ?& ARRAY['viewShipping', 'createShipments', 'purchaseLivePostage'];

CREATE OR REPLACE FUNCTION operations_one_off_lines_are_pure_ad_hoc(
  lines_snapshot jsonb
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT jsonb_typeof(lines_snapshot) = 'array'
    AND jsonb_array_length(lines_snapshot) > 0
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(lines_snapshot) line
      WHERE line->>'kind' IS DISTINCT FROM 'ad_hoc'
    )
$$;

-- Preserve all canonical planning gates while deriving native one-off mode from
-- the sealed quote instead of the unrelated Operations activation profile.
CREATE OR REPLACE FUNCTION validate_ops_plan_cartonization_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  linked_sealed_at timestamptz;
  linked_mode text;
  linked_status text;
  linked_warehouse_id uuid;
  linked_candidate_order_id uuid;
  linked_candidate_state text;
  linked_candidate_source_hash text;
  evidence_candidate_source_hash text;
  linked_carrier_read_environment text;
  activation_state text;
  one_off_execution_mode text;
  active_sandbox_e2e_authorization boolean;
  valid_one_off_authority boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'operations:activation:' || NEW.organization_id::text,
      0
    )
  );

  IF TG_OP = 'UPDATE' AND (
    (OLD.cartonization_evidence_id IS NOT NULL AND
      NEW.cartonization_evidence_id IS DISTINCT FROM OLD.cartonization_evidence_id)
    OR NEW.one_off_quote_id IS DISTINCT FROM OLD.one_off_quote_id
    OR NEW.one_off_offer_id IS DISTINCT FROM OLD.one_off_offer_id
  ) THEN
    RAISE EXCEPTION
      'An accepted fulfillment plan carrier-rate evidence link is immutable';
  END IF;

  IF NEW.cartonization_evidence_id IS NOT NULL
     AND NEW.one_off_quote_id IS NOT NULL THEN
    RAISE EXCEPTION
      'A fulfillment plan must use exactly one carrier-rate authority';
  END IF;

  SELECT activation.state INTO activation_state
  FROM operations_activation_scopes activation
  WHERE activation.organization_id = NEW.organization_id
  LIMIT 1;

  SELECT quote.execution_mode INTO one_off_execution_mode
  FROM operations_one_off_shipment_quotes quote
  WHERE quote.organization_id = NEW.organization_id
    AND quote.id = NEW.one_off_quote_id
  LIMIT 1;

  SELECT EXISTS (
    SELECT 1 FROM operations_sandbox_commerce_e2e_authorizations sandbox_auth
    WHERE sandbox_auth.organization_id = NEW.organization_id
      AND sandbox_auth.order_id = NEW.order_id
      AND operations_sandbox_commerce_e2e_authorization_is_current(
        sandbox_auth.organization_id, sandbox_auth.id, sandbox_auth.order_id
      )
  ) INTO active_sandbox_e2e_authorization;

  valid_one_off_authority := NEW.one_off_quote_id IS NOT NULL
    AND one_off_execution_mode IN ('test', 'live')
    AND operations_one_off_plan_authority_is_valid(
      NEW.organization_id, NEW.order_id, NEW.warehouse_id,
      NEW.one_off_quote_id, NEW.one_off_offer_id,
      one_off_execution_mode
    );

  IF NEW.one_off_quote_id IS NOT NULL AND NOT valid_one_off_authority THEN
    RAISE EXCEPTION
      'One-off fulfillment plan authority is missing, mismatched, or stale';
  END IF;

  IF NEW.cartonization_evidence_id IS NULL THEN
    IF activation_state = 'active'
       AND (
         NEW.status IN ('planned', 'released')
         OR (TG_OP = 'UPDATE'
             AND OLD.status IN ('planned', 'released')
             AND NEW.status = 'fulfilled')
       )
       AND NOT active_sandbox_e2e_authorization
       AND NOT valid_one_off_authority
    THEN
      RAISE EXCEPTION
        'Active fulfillment planning requires sealed production carrier-read evidence';
    END IF;
    RETURN NEW;
  END IF;

  SELECT evidence.sealed_at, evidence.evidence_mode, evidence.status,
         evidence.warehouse_id, candidate.canonical_order_id,
         candidate.workflow_state, candidate.source_hash,
         evidence.candidate_source_hash,
         evidence.plan_snapshot->>'carrierReadEnvironment'
  INTO linked_sealed_at, linked_mode, linked_status,
       linked_warehouse_id, linked_candidate_order_id,
       linked_candidate_state, linked_candidate_source_hash,
       evidence_candidate_source_hash, linked_carrier_read_environment
  FROM operations_cartonization_rate_evidence evidence
  JOIN operations_commerce_order_candidates candidate
    ON candidate.organization_id = evidence.organization_id
   AND candidate.integration_account_id = evidence.integration_account_id
   AND candidate.id = evidence.order_candidate_id
  WHERE evidence.organization_id = NEW.organization_id
    AND evidence.id = NEW.cartonization_evidence_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Fulfillment plan cartonization evidence was not found in this organization';
  END IF;
  IF linked_sealed_at IS NULL THEN
    RAISE EXCEPTION 'Fulfillment planning requires sealed cartonization evidence';
  END IF;
  IF linked_mode IS DISTINCT FROM 'operational' THEN
    RAISE EXCEPTION 'Assumption-backed sandbox evidence cannot become a fulfillment plan';
  END IF;
  IF activation_state = 'active'
     AND linked_carrier_read_environment IS DISTINCT FROM 'production'
     AND NOT active_sandbox_e2e_authorization THEN
    RAISE EXCEPTION 'Active fulfillment planning requires production carrier-read evidence';
  END IF;
  IF linked_status NOT IN ('succeeded', 'partial') THEN
    RAISE EXCEPTION 'Failed cartonization evidence cannot become a fulfillment plan';
  END IF;
  IF linked_warehouse_id IS DISTINCT FROM NEW.warehouse_id THEN
    RAISE EXCEPTION 'Fulfillment plan warehouse must match its cartonization evidence';
  END IF;
  IF linked_candidate_state IS DISTINCT FROM 'promoted'
     OR linked_candidate_order_id IS DISTINCT FROM NEW.order_id THEN
    RAISE EXCEPTION 'Fulfillment plan evidence must belong to the promoted canonical order';
  END IF;
  IF linked_candidate_source_hash IS DISTINCT FROM evidence_candidate_source_hash THEN
    RAISE EXCEPTION 'Fulfillment plan cartonization evidence is stale';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION validate_ops_activation_canonical_plans()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE incompatible_plan_global_id text;
BEGIN
  IF NEW.state IS DISTINCT FROM 'active' THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended('operations:activation:' || NEW.organization_id::text, 0)
  );
  SELECT plan.global_id INTO incompatible_plan_global_id
  FROM operations_fulfillment_plans plan
  JOIN operations_orders source_order
    ON source_order.organization_id = plan.organization_id
   AND source_order.id = plan.order_id
  LEFT JOIN operations_cartonization_rate_evidence evidence
    ON evidence.organization_id = plan.organization_id
   AND evidence.id = plan.cartonization_evidence_id
  WHERE plan.organization_id = NEW.organization_id
    AND plan.status IN ('planned', 'released')
    AND source_order.status NOT IN ('shipped', 'cancelled')
    AND NOT (
      source_order.source_provider = 'clawpilot_native'
      AND source_order.order_type = 'one_off'
    )
    AND NOT (
      plan.cartonization_evidence_id IS NOT NULL
      AND evidence.plan_snapshot->>'carrierReadEnvironment' = 'production'
    )
    AND NOT operations_one_off_plan_execution_is_exact(
      plan.organization_id, plan.id, 'live'
    )
    AND NOT EXISTS (
      SELECT 1 FROM operations_sandbox_commerce_e2e_authorizations sandbox_auth
      WHERE sandbox_auth.organization_id = plan.organization_id
        AND sandbox_auth.order_id = plan.order_id
        AND operations_sandbox_commerce_e2e_authorization_is_current(
          sandbox_auth.organization_id, sandbox_auth.id, sandbox_auth.order_id
        )
    )
  ORDER BY plan.created_at, plan.id LIMIT 1;
  IF incompatible_plan_global_id IS NOT NULL THEN
    RAISE EXCEPTION
      'Active Operations cannot retain missing or non-production carrier-read plan %',
      incompatible_plan_global_id;
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE operations_one_off_shipment_quotes
  ALTER COLUMN customer_id DROP NOT NULL,
  ALTER COLUMN inventory_pool_id DROP NOT NULL,
  ALTER COLUMN receiving_location_id DROP NOT NULL;

ALTER TABLE operations_one_off_shipment_quotes
  DROP CONSTRAINT IF EXISTS operations_one_off_shipment_quotes_inventory_scope_valid,
  ADD CONSTRAINT operations_one_off_shipment_quotes_inventory_scope_valid CHECK (
    (
      inventory_pool_id IS NOT NULL
      AND receiving_location_id IS NOT NULL
    ) OR (
      inventory_pool_id IS NULL
      AND receiving_location_id IS NULL
      AND operations_one_off_lines_are_pure_ad_hoc(lines_snapshot)
    )
  );

ALTER TABLE operations_one_off_shipment_quotes
  DROP CONSTRAINT IF EXISTS operations_one_off_shipment_quotes_customer_scope_valid,
  ADD CONSTRAINT operations_one_off_shipment_quotes_customer_scope_valid CHECK (
    customer_id IS NOT NULL
    OR operations_one_off_lines_are_pure_ad_hoc(lines_snapshot)
  );

ALTER TABLE operations_orders
  ALTER COLUMN customer_id DROP NOT NULL;

ALTER TABLE operations_orders
  DROP CONSTRAINT IF EXISTS operations_orders_recipient_scope_valid,
  ADD CONSTRAINT operations_orders_recipient_scope_valid CHECK (
    customer_id IS NOT NULL
    OR (
      source_provider = 'clawpilot_native'
      AND order_type = 'one_off'
      AND jsonb_typeof(ship_to) = 'object'
      AND length(btrim(ship_to->>'name')) BETWEEN 1 AND 120
      AND length(btrim(ship_to->>'line1')) BETWEEN 1 AND 200
      AND length(btrim(ship_to->>'city')) BETWEEN 1 AND 120
      AND length(btrim(ship_to->>'postalCode')) BETWEEN 1 AND 24
    )
  );

CREATE OR REPLACE FUNCTION validate_operations_one_off_direct_recipient()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.customer_id IS NOT NULL THEN RETURN NULL; END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM operations_one_off_shipment_quote_consumptions consumption
    JOIN operations_one_off_shipment_quotes quote
      ON quote.organization_id = consumption.organization_id
     AND quote.id = consumption.quote_id
    WHERE consumption.organization_id = NEW.organization_id
      AND consumption.order_id = NEW.id
      AND quote.customer_id IS NULL
      AND operations_one_off_lines_are_pure_ad_hoc(quote.lines_snapshot)
      AND quote.destination_snapshot = NEW.ship_to
  ) THEN
    RAISE EXCEPTION
      'A productless native one-off order requires exact sealed direct-recipient evidence';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER validate_operations_one_off_direct_recipient_deferred
AFTER INSERT OR UPDATE OF customer_id, ship_to ON operations_orders
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_operations_one_off_direct_recipient();

INSERT INTO global_reference_entity_types (prefix, entity_type, display_name)
VALUES
  ('goi', 'operations.one_off_ad_hoc_order_line', 'One-off ad-hoc item'),
  ('gohc', 'operations.one_off_ad_hoc_package_content', 'One-off ad-hoc package content')
ON CONFLICT (prefix) DO UPDATE SET
  entity_type = EXCLUDED.entity_type,
  display_name = EXCLUDED.display_name;

CREATE TABLE IF NOT EXISTS operations_one_off_ad_hoc_order_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('goi'),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  quote_id uuid NOT NULL,
  order_id uuid NOT NULL,
  line_key text NOT NULL,
  description text NOT NULL,
  item_reference text,
  quantity numeric(20,6) NOT NULL CHECK (quantity > 0),
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor >= 0),
  unit_weight_grams integer NOT NULL CHECK (unit_weight_grams > 0),
  unit_dimensions_mm jsonb NOT NULL,
  item_snapshot jsonb NOT NULL,
  item_snapshot_hash text NOT NULL CHECK (item_snapshot_hash ~ '^[a-f0-9]{64}$'),
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_one_off_ad_hoc_lines_global_valid
    CHECK (global_id ~ '^goi(?:[0-9]{7}|[0-9a-v]{12})$'),
  CONSTRAINT operations_one_off_ad_hoc_lines_global_unique UNIQUE (global_id),
  CONSTRAINT operations_one_off_ad_hoc_lines_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_one_off_ad_hoc_lines_quote_fkey
    FOREIGN KEY (organization_id, quote_id)
    REFERENCES operations_one_off_shipment_quotes(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_one_off_ad_hoc_lines_order_fkey
    FOREIGN KEY (organization_id, order_id)
    REFERENCES operations_orders(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_one_off_ad_hoc_lines_line_unique
    UNIQUE (organization_id, order_id, line_key),
  CONSTRAINT operations_one_off_ad_hoc_lines_order_id_unique
    UNIQUE (organization_id, order_id, id),
  CONSTRAINT operations_one_off_ad_hoc_lines_org_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT operations_one_off_ad_hoc_lines_text_valid CHECK (
    length(btrim(line_key)) BETWEEN 1 AND 80
    AND line_key !~ '[[:cntrl:]]'
    AND length(btrim(description)) BETWEEN 1 AND 255
    AND description !~ '[[:cntrl:]]'
    AND (
      item_reference IS NULL OR (
        length(btrim(item_reference)) BETWEEN 1 AND 80
        AND item_reference !~ '[[:cntrl:]]'
      )
    )
  ),
  CONSTRAINT operations_one_off_ad_hoc_lines_snapshot_valid CHECK (
    jsonb_typeof(unit_dimensions_mm) = 'object'
    AND jsonb_typeof(item_snapshot) = 'object'
    AND item_snapshot->>'kind' = 'ad_hoc'
    AND item_snapshot->>'lineKey' = line_key
    AND item_snapshot->>'name' = description
    AND item_snapshot->>'sku' IS NOT DISTINCT FROM item_reference
    AND (item_snapshot->>'quantity')::numeric = quantity
    AND (item_snapshot->>'unitPriceMinor')::bigint = unit_price_minor
    AND (item_snapshot->>'unitWeightGrams')::integer = unit_weight_grams
    AND item_snapshot->'unitDimensionsMm' = unit_dimensions_mm
  )
);

CREATE TABLE IF NOT EXISTS operations_one_off_ad_hoc_package_contents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gohc'),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  plan_id uuid NOT NULL,
  order_id uuid NOT NULL,
  package_id uuid NOT NULL,
  ad_hoc_order_line_id uuid NOT NULL,
  quantity numeric(20,6) NOT NULL CHECK (quantity > 0),
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_one_off_ad_hoc_contents_global_valid
    CHECK (global_id ~ '^gohc(?:[0-9]{7}|[0-9a-v]{12})$'),
  CONSTRAINT operations_one_off_ad_hoc_contents_global_unique UNIQUE (global_id),
  CONSTRAINT operations_one_off_ad_hoc_contents_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_one_off_ad_hoc_contents_plan_fkey
    FOREIGN KEY (organization_id, order_id, plan_id)
    REFERENCES operations_fulfillment_plans(organization_id, order_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_one_off_ad_hoc_contents_package_fkey
    FOREIGN KEY (organization_id, plan_id, package_id)
    REFERENCES operations_packages(organization_id, plan_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_one_off_ad_hoc_contents_line_fkey
    FOREIGN KEY (organization_id, order_id, ad_hoc_order_line_id)
    REFERENCES operations_one_off_ad_hoc_order_lines(organization_id, order_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_one_off_ad_hoc_contents_package_line_unique
    UNIQUE (organization_id, package_id, ad_hoc_order_line_id),
  CONSTRAINT operations_one_off_ad_hoc_contents_org_id_unique
    UNIQUE (organization_id, id)
);

CREATE OR REPLACE FUNCTION validate_operations_one_off_ad_hoc_line_lineage()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM operations_one_off_shipment_quotes quote
    JOIN operations_orders source_order
      ON source_order.organization_id = quote.organization_id
     AND source_order.id = NEW.order_id
     AND source_order.pipeline_id = quote.pipeline_id
     AND source_order.customer_id IS NOT DISTINCT FROM quote.customer_id
     AND source_order.ship_to = quote.destination_snapshot
     AND source_order.source_provider = 'clawpilot_native'
     AND source_order.order_type = 'one_off'
    WHERE quote.organization_id = NEW.organization_id
      AND quote.id = NEW.quote_id
      AND operations_one_off_lines_are_pure_ad_hoc(quote.lines_snapshot)
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(quote.lines_snapshot) snapshot
        WHERE snapshot->>'lineKey' = NEW.line_key
          AND snapshot->>'kind' = 'ad_hoc'
          AND snapshot->>'productName' = NEW.description
          AND NULLIF(btrim(snapshot->>'sku'), '')
            IS NOT DISTINCT FROM NEW.item_reference
          AND (snapshot->>'quantity')::numeric = NEW.quantity
          AND (snapshot->>'unitPriceMinor')::bigint = NEW.unit_price_minor
          AND (snapshot->>'unitWeightGrams')::integer = NEW.unit_weight_grams
          AND snapshot->'unitDimensionsMm' = NEW.unit_dimensions_mm
      )
  ) THEN
    RAISE EXCEPTION
      'One-off ad-hoc item must match its exact sealed quote, recipient, and native order';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER validate_operations_one_off_ad_hoc_line_lineage_write
BEFORE INSERT ON operations_one_off_ad_hoc_order_lines
FOR EACH ROW EXECUTE FUNCTION validate_operations_one_off_ad_hoc_line_lineage();

CREATE OR REPLACE FUNCTION validate_operations_one_off_ad_hoc_content_lineage()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM operations_fulfillment_plans plan
    JOIN operations_one_off_ad_hoc_order_lines item
      ON item.organization_id = plan.organization_id
     AND item.order_id = plan.order_id
     AND item.quote_id = plan.one_off_quote_id
     AND item.id = NEW.ad_hoc_order_line_id
    WHERE plan.organization_id = NEW.organization_id
      AND plan.order_id = NEW.order_id
      AND plan.id = NEW.plan_id
  ) THEN
    RAISE EXCEPTION
      'One-off ad-hoc package content must retain exact quote, order, plan, and item lineage';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER validate_operations_one_off_ad_hoc_content_lineage_write
BEFORE INSERT ON operations_one_off_ad_hoc_package_contents
FOR EACH ROW EXECUTE FUNCTION validate_operations_one_off_ad_hoc_content_lineage();

CREATE OR REPLACE FUNCTION protect_operations_one_off_ad_hoc_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'One-off ad-hoc item evidence is immutable';
END;
$$;

CREATE TRIGGER protect_operations_one_off_ad_hoc_line_write
BEFORE UPDATE OR DELETE ON operations_one_off_ad_hoc_order_lines
FOR EACH ROW EXECUTE FUNCTION protect_operations_one_off_ad_hoc_evidence();

CREATE TRIGGER protect_operations_one_off_ad_hoc_content_write
BEFORE UPDATE OR DELETE ON operations_one_off_ad_hoc_package_contents
FOR EACH ROW EXECUTE FUNCTION protect_operations_one_off_ad_hoc_evidence();

CREATE CONSTRAINT TRIGGER validate_operations_one_off_ad_hoc_content_set_deferred
AFTER INSERT OR UPDATE OR DELETE ON operations_one_off_ad_hoc_package_contents
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_operations_one_off_plan_package_set();

CREATE OR REPLACE FUNCTION operations_one_off_plan_package_set_is_exact(
  authority_organization_id uuid,
  authority_plan_id uuid,
  authority_quote_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  WITH quote_row AS (
    SELECT quote.packages_snapshot
    FROM operations_one_off_shipment_quotes quote
    JOIN operations_fulfillment_plans plan
      ON plan.organization_id = quote.organization_id
     AND plan.id = authority_plan_id
     AND plan.one_off_quote_id = quote.id
    WHERE quote.organization_id = authority_organization_id
      AND quote.id = authority_quote_id
  ), expected_packages AS (
    SELECT ordinality::integer AS package_number, package_snapshot
    FROM quote_row,
      jsonb_array_elements(packages_snapshot)
        WITH ORDINALITY AS item(package_snapshot, ordinality)
  ), actual_packages AS (
    SELECT package.id, package.package_number, package.length_mm,
           package.width_mm, package.height_mm, package.weight_grams
    FROM operations_packages package
    WHERE package.organization_id = authority_organization_id
      AND package.plan_id = authority_plan_id
  ), expected_contents AS (
    SELECT expected.package_number,
           allocation->>'lineKey' AS line_key,
           (allocation->>'quantity')::numeric AS quantity
    FROM expected_packages expected,
      jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(expected.package_snapshot->'allocations') = 'array'
            THEN expected.package_snapshot->'allocations'
          ELSE '[]'::jsonb
        END
      ) allocation
  ), actual_contents AS (
    SELECT package.package_number,
           line.external_line_id AS line_key,
           content.quantity
    FROM actual_packages package
    JOIN operations_package_contents content
      ON content.organization_id = authority_organization_id
     AND content.package_id = package.id
     AND content.plan_id = authority_plan_id
    JOIN operations_order_lines line
      ON line.organization_id = content.organization_id
     AND line.id = content.order_line_id
     AND line.order_id = content.order_id
    UNION ALL
    SELECT package.package_number,
           line.line_key,
           content.quantity
    FROM actual_packages package
    JOIN operations_one_off_ad_hoc_package_contents content
      ON content.organization_id = authority_organization_id
     AND content.package_id = package.id
     AND content.plan_id = authority_plan_id
    JOIN operations_one_off_ad_hoc_order_lines line
      ON line.organization_id = content.organization_id
     AND line.id = content.ad_hoc_order_line_id
     AND line.order_id = content.order_id
  )
  SELECT EXISTS (SELECT 1 FROM quote_row)
    AND (SELECT count(*) FROM expected_packages)
      = (SELECT count(*) FROM actual_packages)
    AND NOT EXISTS (
      SELECT 1
      FROM expected_packages expected
      FULL JOIN actual_packages actual
        ON actual.package_number = expected.package_number
      WHERE expected.package_number IS NULL
         OR actual.package_number IS NULL
         OR actual.length_mm IS DISTINCT FROM
              (expected.package_snapshot->'dimensionsMm'->>'length')::integer
         OR actual.width_mm IS DISTINCT FROM
              (expected.package_snapshot->'dimensionsMm'->>'width')::integer
         OR actual.height_mm IS DISTINCT FROM
              (expected.package_snapshot->'dimensionsMm'->>'height')::integer
         OR actual.weight_grams IS DISTINCT FROM
              (expected.package_snapshot->>'grossWeightGrams')::integer
    )
    AND NOT EXISTS (
      (SELECT * FROM expected_contents EXCEPT SELECT * FROM actual_contents)
      UNION ALL
      (SELECT * FROM actual_contents EXCEPT SELECT * FROM expected_contents)
    )
$$;

-- Packed rerates preserve the exact planning scope. Productless quotes use
-- NULL inventory scope, so NULL-safe comparison is required for that evidence.
CREATE OR REPLACE FUNCTION operations_one_off_purchase_quote_is_valid(
  authority_organization_id uuid,
  authority_plan_id uuid,
  authority_purchase_quote_id uuid,
  authority_purchase_offer_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM operations_fulfillment_plans plan
    JOIN operations_one_off_shipment_quotes planning_quote
      ON planning_quote.organization_id = plan.organization_id
     AND planning_quote.id = plan.one_off_quote_id
    JOIN operations_one_off_shipment_quote_offers planning_offer
      ON planning_offer.organization_id = plan.organization_id
     AND planning_offer.quote_id = plan.one_off_quote_id
     AND planning_offer.id = plan.one_off_offer_id
    JOIN operations_one_off_shipment_quotes purchase_quote
      ON purchase_quote.organization_id = plan.organization_id
     AND purchase_quote.id = authority_purchase_quote_id
    JOIN operations_one_off_shipment_quote_offers purchase_offer
      ON purchase_offer.organization_id = purchase_quote.organization_id
     AND purchase_offer.quote_id = purchase_quote.id
     AND purchase_offer.id = authority_purchase_offer_id
    JOIN operations_carrier_rate_requests evidence
      ON evidence.organization_id = purchase_offer.organization_id
     AND evidence.global_id = purchase_offer.rate_evidence_global_id
    WHERE plan.organization_id = authority_organization_id
      AND plan.id = authority_plan_id
      AND purchase_quote.id <> planning_quote.id
      AND purchase_quote.packed_rerate_order_id = plan.order_id
      AND purchase_quote.packed_rerate_plan_id = plan.id
      AND purchase_quote.expires_at > clock_timestamp()
      AND purchase_quote.status IN ('succeeded', 'partial')
      AND purchase_quote.execution_mode = planning_quote.execution_mode
      AND purchase_quote.rate_environment = planning_quote.rate_environment
      AND purchase_quote.warehouse_id = planning_quote.warehouse_id
      AND purchase_quote.customer_id
        IS NOT DISTINCT FROM planning_quote.customer_id
      AND purchase_quote.inventory_pool_id
        IS NOT DISTINCT FROM planning_quote.inventory_pool_id
      AND purchase_quote.receiving_location_id
        IS NOT DISTINCT FROM planning_quote.receiving_location_id
      AND purchase_quote.currency = planning_quote.currency
      AND purchase_quote.destination_hash = planning_quote.destination_hash
      AND purchase_quote.packages_hash = planning_quote.packages_hash
      AND jsonb_array_length(purchase_quote.packages_snapshot) BETWEEN 1 AND 40
      AND NOT EXISTS (
        SELECT 1
        FROM operations_one_off_purchase_quote_consumptions used
        WHERE used.organization_id = purchase_quote.organization_id
          AND used.quote_id = purchase_quote.id
      )
      AND purchase_offer.provider = planning_offer.provider
      AND purchase_offer.transport_mode = planning_offer.transport_mode
      AND purchase_offer.handling_unit_mode
        = planning_offer.handling_unit_mode
      AND purchase_offer.executing_carrier_code
        = planning_offer.executing_carrier_code
      AND purchase_offer.executing_carrier_name
        = planning_offer.executing_carrier_name
      AND purchase_offer.executing_carrier_scac
        IS NOT DISTINCT FROM planning_offer.executing_carrier_scac
      AND purchase_offer.service_code = planning_offer.service_code
      AND purchase_offer.integration_account_id
        = planning_offer.integration_account_id
      AND purchase_offer.carrier_account_id
        IS NOT DISTINCT FROM planning_offer.carrier_account_id
      AND purchase_offer.environment = planning_offer.environment
      AND purchase_offer.currency = planning_offer.currency
      AND evidence.status = 'succeeded'
      AND evidence.purpose IN (
        'cartonization_shipment_rate',
        'one_off_transport_rate'
      )
      AND evidence.provider = purchase_offer.provider
      AND evidence.environment = purchase_offer.environment
      AND evidence.integration_account_id
        = purchase_offer.integration_account_id
      AND evidence.carrier_account_id
        IS NOT DISTINCT FROM purchase_offer.carrier_account_id
      AND evidence.request_hash = purchase_offer.carrier_request_hash
      AND (
        (
          purchase_quote.required_transport_sources IS NULL
          AND purchase_offer.provider IN ('ups_rest', 'fedex_rest')
        )
        OR purchase_offer.provider || ':' || purchase_offer.transport_mode
          = ANY(purchase_quote.required_transport_sources)
      )
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(
          CASE
            WHEN jsonb_typeof(evidence.redacted_response->'rates') = 'array'
              THEN evidence.redacted_response->'rates'
            ELSE '[]'::jsonb
          END
        ) retained_rate
        WHERE retained_rate->>'serviceCode' = purchase_offer.service_code
          AND upper(retained_rate->>'currency') = purchase_offer.currency
          AND retained_rate->>'amount' ~ '^[0-9]+(?:\.[0-9]{1,4})?$'
          AND round((retained_rate->>'amount')::numeric * 100)::bigint
            = purchase_offer.amount_minor
          AND (
            purchase_offer.provider <> 'wwex_speedship'
            OR (
              retained_rate->>'offerId' = purchase_offer.provider_offer_id
              AND retained_rate->>'offeredProductId'
                = purchase_offer.provider_product_id
              AND retained_rate->>'productTransactionId'
                = purchase_offer.provider_transaction_id
            )
          )
      )
  )
$$;

CREATE OR REPLACE FUNCTION validate_operations_one_off_group_prepare()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  linked_create operations_one_off_carrier_group_attempts%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'operations:one-off-carrier-group:' || NEW.organization_id::text
      || ':' || NEW.order_id::text,
    0
  ));
  IF NEW.action = 'create' THEN
    IF EXISTS (
      SELECT 1
      FROM operations_one_off_carrier_group_attempts prior_create
      WHERE prior_create.organization_id = NEW.organization_id
        AND prior_create.order_id = NEW.order_id
        AND prior_create.plan_id = NEW.plan_id
        AND prior_create.action = 'create'
        AND prior_create.state = 'succeeded'
        AND NOT EXISTS (
          SELECT 1
          FROM operations_one_off_carrier_group_attempts prior_close
          WHERE prior_close.organization_id = prior_create.organization_id
            AND prior_close.create_attempt_id = prior_create.id
            AND prior_close.action IN ('void', 'close_sample')
            AND prior_close.state = 'succeeded'
        )
    ) THEN
      RAISE EXCEPTION
        'An active successful one-off carrier group must be voided before repurchase';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM operations_packages package
      JOIN operations_labels label
        ON label.organization_id = package.organization_id
       AND label.package_id = package.id
      WHERE package.organization_id = NEW.organization_id
        AND package.plan_id = NEW.plan_id
        AND label.status = 'created'
    ) THEN
      RAISE EXCEPTION
        'One-off group purchase cannot begin with a competing active label';
    END IF;
    IF NOT operations_one_off_plan_execution_is_exact(
      NEW.organization_id, NEW.plan_id,
      CASE WHEN NEW.environment = 'production' THEN 'live' ELSE 'test' END
    ) OR NOT operations_one_off_purchase_quote_is_valid(
      NEW.organization_id, NEW.plan_id,
      NEW.purchase_quote_id, NEW.purchase_offer_id
    ) OR NOT EXISTS (
      SELECT 1
      FROM operations_fulfillment_plans plan
      JOIN operations_orders source_order
        ON source_order.organization_id = plan.organization_id
       AND source_order.id = plan.order_id
      JOIN operations_one_off_shipment_quote_offers purchase_offer
        ON purchase_offer.organization_id = plan.organization_id
       AND purchase_offer.quote_id = NEW.purchase_quote_id
       AND purchase_offer.id = NEW.purchase_offer_id
      WHERE plan.organization_id = NEW.organization_id
        AND plan.id = NEW.plan_id
        AND plan.order_id = NEW.order_id
        AND plan.one_off_quote_id = NEW.planning_quote_id
        AND plan.one_off_offer_id = NEW.planning_offer_id
        AND source_order.status = 'packed'
        AND NEW.integration_account_id = purchase_offer.integration_account_id
        AND NEW.carrier_account_id
          IS NOT DISTINCT FROM purchase_offer.carrier_account_id
        AND NEW.provider = purchase_offer.provider
        AND NEW.transport_mode = purchase_offer.transport_mode
        AND NEW.handling_unit_mode = purchase_offer.handling_unit_mode
        AND NEW.executing_carrier_code = purchase_offer.executing_carrier_code
        AND NEW.executing_carrier_name = purchase_offer.executing_carrier_name
        AND NEW.executing_carrier_scac
          IS NOT DISTINCT FROM purchase_offer.executing_carrier_scac
        AND NEW.provider_offer_id
          IS NOT DISTINCT FROM purchase_offer.provider_offer_id
        AND NEW.provider_product_id
          IS NOT DISTINCT FROM purchase_offer.provider_product_id
        AND NEW.provider_transaction_id
          IS NOT DISTINCT FROM purchase_offer.provider_transaction_id
        AND NEW.service_code = purchase_offer.service_code
        AND NEW.selected_amount_minor = purchase_offer.amount_minor
        AND NEW.currency = purchase_offer.currency
        AND NEW.package_count = (
          SELECT count(*)
          FROM operations_packages package
          WHERE package.organization_id = plan.organization_id
            AND package.plan_id = plan.id
            AND package.status = 'packed'
        )
    ) THEN
      RAISE EXCEPTION
        'One-off group purchase must use a fresh exact packed rerate and complete package set';
    END IF;
  ELSE
    SELECT * INTO linked_create
    FROM operations_one_off_carrier_group_attempts candidate
    WHERE candidate.organization_id = NEW.organization_id
      AND candidate.id = NEW.create_attempt_id;
    IF linked_create.id IS NULL OR linked_create.action <> 'create'
       OR linked_create.state <> 'succeeded'
       OR linked_create.order_id <> NEW.order_id
       OR linked_create.plan_id <> NEW.plan_id
       OR linked_create.planning_quote_id <> NEW.planning_quote_id
       OR linked_create.planning_offer_id <> NEW.planning_offer_id
       OR linked_create.purchase_quote_id <> NEW.purchase_quote_id
       OR linked_create.purchase_offer_id <> NEW.purchase_offer_id
       OR linked_create.carrier_rate_id <> NEW.carrier_rate_id
       OR linked_create.integration_account_id <> NEW.integration_account_id
       OR linked_create.carrier_account_id
         IS DISTINCT FROM NEW.carrier_account_id
       OR linked_create.environment <> NEW.environment
       OR linked_create.provider <> NEW.provider
       OR linked_create.service_code <> NEW.service_code
       OR linked_create.package_count <> NEW.package_count
       OR linked_create.selected_amount_minor <> NEW.selected_amount_minor
       OR linked_create.currency <> NEW.currency
       OR linked_create.master_tracking_number <> NEW.master_tracking_number
       OR linked_create.provider_shipment_id <> NEW.provider_shipment_id
    THEN
      RAISE EXCEPTION
        'Whole-shipment void must retain the exact successful create group';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM operations_orders source_order
      WHERE source_order.organization_id = NEW.organization_id
        AND source_order.id = NEW.order_id
        AND source_order.status = 'packed'
        AND NOT EXISTS (
          SELECT 1
          FROM operations_shipments shipment
          WHERE shipment.organization_id = source_order.organization_id
            AND shipment.order_id = source_order.id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM operations_one_off_carrier_group_members member
          JOIN operations_packages package
            ON package.organization_id = member.organization_id
           AND package.id = member.package_id
          WHERE member.organization_id = NEW.organization_id
            AND member.carrier_group_attempt_id = NEW.create_attempt_id
            AND package.status <> 'labeled'
        )
    ) THEN
      RAISE EXCEPTION
        'Whole-shipment void is available only before shipment confirmation';
    END IF;
    IF NEW.action = 'close_sample' AND NOT (
      NEW.environment = 'sandbox' AND NEW.provider = 'ups_rest'
      AND NEW.master_tracking_number ~* '^1Z[X]{16}$'
      AND NEW.provider_shipment_id ~* '^1Z[X]{16}$'
    ) THEN
      RAISE EXCEPTION
        'Local sample close is limited to UPS CIE sample shipments';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION validate_operations_one_off_group_shipment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'operations:one-off-carrier-group:' || NEW.organization_id::text
      || ':' || NEW.order_id::text,
    0
  ));
  IF TG_OP = 'UPDATE' AND NEW.one_off_carrier_group_attempt_id
      IS DISTINCT FROM OLD.one_off_carrier_group_attempt_id THEN
    RAISE EXCEPTION 'One-off shipment group lineage is immutable';
  END IF;
  IF NEW.one_off_carrier_group_attempt_id IS NULL THEN
    IF EXISTS (
      SELECT 1
      FROM operations_labels label
      WHERE label.organization_id = NEW.organization_id
        AND label.id = NEW.label_id
        AND label.one_off_carrier_group_attempt_id IS NOT NULL
    ) OR EXISTS (
      SELECT 1
      FROM operations_fulfillment_plans plan
      WHERE plan.organization_id = NEW.organization_id
        AND plan.id = NEW.plan_id
        AND plan.order_id = NEW.order_id
        AND plan.one_off_quote_id IS NOT NULL
    ) THEN
      RAISE EXCEPTION
        'A native one-off shipment requires the exact carrier group lineage';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.active_fulfillment_execution_id IS NOT NULL
     OR NEW.active_shipment_group_id IS NOT NULL
     OR NEW.active_carrier_group_attempt_id IS NOT NULL
     OR NEW.fulfillment_execution_id IS NOT NULL
     OR NEW.shipment_group_id IS NOT NULL THEN
    RAISE EXCEPTION 'One-off shipment cannot mix carrier execution lineages';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM operations_one_off_carrier_group_attempts attempt
    JOIN operations_one_off_carrier_group_members member
      ON member.organization_id = attempt.organization_id
     AND member.carrier_group_attempt_id = attempt.id
     AND member.package_id = NEW.package_id
    JOIN operations_one_off_carrier_group_results result
      ON result.organization_id = member.organization_id
     AND result.carrier_group_attempt_id = member.carrier_group_attempt_id
     AND result.package_id = member.package_id
    JOIN operations_labels label
      ON label.organization_id = result.organization_id
     AND label.id = result.label_id
     AND label.id = NEW.label_id
    WHERE attempt.organization_id = NEW.organization_id
      AND attempt.id = NEW.one_off_carrier_group_attempt_id
      AND attempt.order_id = NEW.order_id
      AND attempt.plan_id = NEW.plan_id
      AND attempt.action = 'create'
      AND attempt.state = 'succeeded'
      AND operations_one_off_plan_execution_is_exact(
        attempt.organization_id,
        attempt.plan_id,
        CASE WHEN attempt.environment = 'production' THEN 'live' ELSE 'test' END
      )
      AND label.status = 'created'
      AND label.one_off_void_group_attempt_id IS NULL
      AND label.carrier = CASE attempt.provider
        WHEN 'ups_rest' THEN 'UPS'
        WHEN 'fedex_rest' THEN 'FedEx'
      END
      AND label.service_code = attempt.service_code
      AND label.tracking_number = NEW.tracking_number
      AND NEW.quoted_carrier_cost_minor = member.allocated_selected_cost_minor
      AND (
        SELECT COALESCE(sum(group_member.allocated_selected_cost_minor), 0)
        FROM operations_one_off_carrier_group_members group_member
        WHERE group_member.organization_id = attempt.organization_id
          AND group_member.carrier_group_attempt_id = attempt.id
      ) = attempt.selected_amount_minor
      AND NOT EXISTS (
        SELECT 1
        FROM operations_one_off_carrier_group_attempts closed
        WHERE closed.organization_id = attempt.organization_id
          AND closed.create_attempt_id = attempt.id
          AND closed.action IN ('void', 'close_sample')
          AND closed.state IN ('prepared', 'succeeded', 'unknown')
      )
  ) THEN
    RAISE EXCEPTION
      'One-off shipment requires an exact complete active carrier group for its execution mode';
  END IF;
  RETURN NEW;
END;
$$;
