-- Extend the exact-order sandbox commerce E2E authority to Faire without
-- weakening the existing Shopify path. Faire authority is valid only while
-- its immutable promoted-candidate, mapped pack, canonical package, origin,
-- and destination evidence still matches live durable state.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '25s';

CREATE UNIQUE INDEX IF NOT EXISTS
  operations_sandbox_commerce_e2e_authorizations_scope_hash_unique
ON operations_sandbox_commerce_e2e_authorizations (
  organization_id, id, confirmation_hash
);

CREATE UNIQUE INDEX IF NOT EXISTS
  operations_commerce_order_candidate_lines_full_scope_unique
ON operations_commerce_order_candidate_lines (
  organization_id, integration_account_id, pipeline_id, run_id,
  order_candidate_id, id
);

CREATE OR REPLACE FUNCTION operations_sandbox_commerce_e2e_jsonb_hash(
  value jsonb
)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
STRICT
AS $$
  SELECT encode(digest(value::text, 'sha256'), 'hex')
$$;

CREATE TABLE IF NOT EXISTS
  operations_sandbox_commerce_e2e_faire_evidence (
    authorization_id uuid PRIMARY KEY,
    organization_id uuid NOT NULL,
    confirmation_hash text NOT NULL CHECK (
      confirmation_hash ~ '^[a-f0-9]{64}$'
    ),
    integration_account_id uuid NOT NULL,
    pipeline_id uuid NOT NULL,
    run_id uuid NOT NULL,
    order_id uuid NOT NULL,
    order_candidate_id uuid NOT NULL,
    order_candidate_global_id text NOT NULL,
    order_candidate_row_version bigint NOT NULL CHECK (
      order_candidate_row_version >= 0
    ),
    order_candidate_source_revision text NOT NULL,
    order_candidate_source_hash text NOT NULL CHECK (
      order_candidate_source_hash ~ '^[a-f0-9]{64}$'
    ),
    order_candidate_ship_to_hash text NOT NULL CHECK (
      order_candidate_ship_to_hash ~ '^[a-f0-9]{64}$'
    ),
    order_line_candidate_id uuid NOT NULL,
    order_line_candidate_global_id text NOT NULL,
    order_line_candidate_row_version bigint NOT NULL CHECK (
      order_line_candidate_row_version >= 0
    ),
    order_line_candidate_source_revision text NOT NULL,
    order_line_candidate_source_hash text NOT NULL CHECK (
      order_line_candidate_source_hash ~ '^[a-f0-9]{64}$'
    ),
    canonical_order_line_id uuid NOT NULL,
    variant_pack_mapping_id uuid NOT NULL,
    variant_pack_mapping_global_id text NOT NULL,
    variant_pack_mapping_row_version bigint NOT NULL CHECK (
      variant_pack_mapping_row_version >= 0
    ),
    variant_pack_evidence_hash text NOT NULL CHECK (
      variant_pack_evidence_hash ~ '^[a-f0-9]{64}$'
    ),
    pack_profile_version_id uuid NOT NULL,
    pack_profile_version_global_id text NOT NULL,
    pack_profile_version_row_version bigint NOT NULL CHECK (
      pack_profile_version_row_version >= 0
    ),
    external_product_id text NOT NULL,
    external_variant_id text NOT NULL,
    fulfillment_plan_id uuid NOT NULL,
    fulfillment_plan_global_id text NOT NULL,
    fulfillment_plan_version integer NOT NULL CHECK (
      fulfillment_plan_version > 0
    ),
    warehouse_id uuid NOT NULL,
    warehouse_address_hash text NOT NULL CHECK (
      warehouse_address_hash ~ '^[a-f0-9]{64}$'
    ),
    package_id uuid NOT NULL,
    package_global_id text NOT NULL,
    package_content_id uuid NOT NULL,
    package_content_global_id text NOT NULL,
    package_number integer NOT NULL CHECK (package_number > 0),
    item_quantity numeric(20,6) NOT NULL CHECK (item_quantity = 1),
    length_mm integer NOT NULL CHECK (length_mm > 0),
    width_mm integer NOT NULL CHECK (width_mm > 0),
    height_mm integer NOT NULL CHECK (height_mm > 0),
    gross_weight_grams integer NOT NULL CHECK (gross_weight_grams > 0),
    ship_to_hash text NOT NULL CHECK (ship_to_hash ~ '^[a-f0-9]{64}$'),
    destination_region text NOT NULL CHECK (destination_region = 'CA'),
    destination_country_code text NOT NULL CHECK (
      destination_country_code = 'US'
    ),
    package_evidence_hash text NOT NULL CHECK (
      package_evidence_hash ~ '^[a-f0-9]{64}$'
    ),
    evidence_hash text NOT NULL CHECK (evidence_hash ~ '^[a-f0-9]{64}$'),
    created_by text NOT NULL REFERENCES app_users(email) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT operations_sandbox_commerce_e2e_faire_evidence_auth_fkey
      FOREIGN KEY (organization_id, authorization_id, confirmation_hash)
      REFERENCES operations_sandbox_commerce_e2e_authorizations(
        organization_id, id, confirmation_hash
      ) ON DELETE RESTRICT,
    CONSTRAINT operations_sandbox_commerce_e2e_faire_evidence_account_fkey
      FOREIGN KEY (organization_id, integration_account_id)
      REFERENCES operations_integration_accounts(organization_id, id)
      ON DELETE RESTRICT,
    CONSTRAINT operations_sandbox_commerce_e2e_faire_evidence_order_fkey
      FOREIGN KEY (organization_id, order_id)
      REFERENCES operations_orders(organization_id, id) ON DELETE RESTRICT,
    CONSTRAINT operations_sandbox_commerce_e2e_faire_evidence_candidate_fkey
      FOREIGN KEY (
        organization_id, integration_account_id, pipeline_id, run_id,
        order_candidate_id
      ) REFERENCES operations_commerce_order_candidates(
        organization_id, integration_account_id, pipeline_id, run_id, id
      ) ON DELETE RESTRICT,
    CONSTRAINT operations_sandbox_commerce_e2e_faire_evidence_line_fkey
      FOREIGN KEY (
        organization_id, integration_account_id, pipeline_id, run_id,
        order_candidate_id, order_line_candidate_id
      ) REFERENCES operations_commerce_order_candidate_lines(
        organization_id, integration_account_id, pipeline_id, run_id,
        order_candidate_id, id
      ) ON DELETE RESTRICT,
    CONSTRAINT operations_sandbox_commerce_e2e_faire_evidence_order_line_fkey
      FOREIGN KEY (organization_id, canonical_order_line_id)
      REFERENCES operations_order_lines(organization_id, id)
      ON DELETE RESTRICT,
    CONSTRAINT operations_sandbox_commerce_e2e_faire_evidence_mapping_fkey
      FOREIGN KEY (organization_id, variant_pack_mapping_id)
      REFERENCES operations_commerce_variant_pack_mappings(
        organization_id, id
      ) ON DELETE RESTRICT,
    CONSTRAINT operations_sandbox_commerce_e2e_faire_evidence_version_fkey
      FOREIGN KEY (organization_id, pack_profile_version_id)
      REFERENCES operations_product_pack_profile_versions(
        organization_id, id
      ) ON DELETE RESTRICT,
    CONSTRAINT operations_sandbox_commerce_e2e_faire_evidence_plan_fkey
      FOREIGN KEY (organization_id, fulfillment_plan_id)
      REFERENCES operations_fulfillment_plans(organization_id, id)
      ON DELETE RESTRICT,
    CONSTRAINT operations_sandbox_commerce_e2e_faire_evidence_warehouse_fkey
      FOREIGN KEY (organization_id, warehouse_id)
      REFERENCES operations_warehouses(organization_id, id)
      ON DELETE RESTRICT,
    CONSTRAINT operations_sandbox_commerce_e2e_faire_evidence_package_fkey
      FOREIGN KEY (organization_id, package_id)
      REFERENCES operations_packages(organization_id, id)
      ON DELETE RESTRICT,
    CONSTRAINT operations_sandbox_commerce_e2e_faire_evidence_content_fkey
      FOREIGN KEY (organization_id, package_content_id)
      REFERENCES operations_package_contents(organization_id, id)
      ON DELETE RESTRICT,
    CONSTRAINT operations_sandbox_commerce_e2e_faire_evidence_external_valid
      CHECK (
        length(btrim(external_product_id)) BETWEEN 1 AND 512
        AND external_product_id !~ '[[:cntrl:]]'
        AND length(btrim(external_variant_id)) BETWEEN 1 AND 512
        AND external_variant_id !~ '[[:cntrl:]]'
      )
  );

CREATE UNIQUE INDEX IF NOT EXISTS
  operations_sandbox_commerce_e2e_faire_evidence_scope_unique
ON operations_sandbox_commerce_e2e_faire_evidence (
  organization_id, authorization_id
);

CREATE OR REPLACE FUNCTION
  protect_sandbox_commerce_e2e_faire_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'Faire sandbox commerce E2E evidence is immutable';
END;
$$;

DROP TRIGGER IF EXISTS protect_sandbox_commerce_e2e_faire_evidence_write
  ON operations_sandbox_commerce_e2e_faire_evidence;
CREATE TRIGGER protect_sandbox_commerce_e2e_faire_evidence_write
BEFORE UPDATE OR DELETE ON operations_sandbox_commerce_e2e_faire_evidence
FOR EACH ROW EXECUTE FUNCTION
  protect_sandbox_commerce_e2e_faire_evidence();

CREATE OR REPLACE FUNCTION
  operations_sandbox_commerce_e2e_authorization_is_current(
    requested_organization_id uuid,
    requested_authorization_id uuid,
    requested_order_id uuid
  )
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM operations_sandbox_commerce_e2e_authorizations auth
    JOIN operations_orders source_order
      ON source_order.organization_id = auth.organization_id
     AND source_order.id = auth.order_id
    WHERE auth.organization_id = requested_organization_id
      AND auth.id = requested_authorization_id
      AND auth.order_id = requested_order_id
      AND auth.state = 'active'
      AND auth.expires_at > statement_timestamp()
      AND source_order.status = 'packed'
      AND auth.external_order_id = source_order.external_order_id
      AND (
        source_order.source_provider = 'shopify'
        OR (
          source_order.source_provider = 'faire'
          AND EXISTS (
            SELECT 1
            FROM operations_sandbox_commerce_e2e_faire_evidence evidence
            JOIN operations_integration_accounts account
              ON account.organization_id = evidence.organization_id
             AND account.id = evidence.integration_account_id
            JOIN operations_commerce_order_candidates candidate
              ON candidate.organization_id = evidence.organization_id
             AND candidate.integration_account_id =
                   evidence.integration_account_id
             AND candidate.pipeline_id = evidence.pipeline_id
             AND candidate.run_id = evidence.run_id
             AND candidate.id = evidence.order_candidate_id
            JOIN operations_commerce_order_candidate_lines candidate_line
              ON candidate_line.organization_id = evidence.organization_id
             AND candidate_line.integration_account_id =
                   evidence.integration_account_id
             AND candidate_line.pipeline_id = evidence.pipeline_id
             AND candidate_line.run_id = evidence.run_id
             AND candidate_line.order_candidate_id =
                   evidence.order_candidate_id
             AND candidate_line.id = evidence.order_line_candidate_id
            JOIN operations_order_lines canonical_line
              ON canonical_line.organization_id = evidence.organization_id
             AND canonical_line.order_id = evidence.order_id
             AND canonical_line.id = evidence.canonical_order_line_id
            JOIN operations_commerce_variant_pack_mappings pack_mapping
              ON pack_mapping.organization_id = evidence.organization_id
             AND pack_mapping.id = evidence.variant_pack_mapping_id
            JOIN operations_product_pack_profile_versions pack_version
              ON pack_version.organization_id = evidence.organization_id
             AND pack_version.id = evidence.pack_profile_version_id
            JOIN operations_fulfillment_plans plan
              ON plan.organization_id = evidence.organization_id
             AND plan.order_id = evidence.order_id
             AND plan.id = evidence.fulfillment_plan_id
            JOIN operations_warehouses warehouse
              ON warehouse.organization_id = evidence.organization_id
             AND warehouse.id = evidence.warehouse_id
            JOIN operations_packages package
              ON package.organization_id = evidence.organization_id
             AND package.plan_id = plan.id
             AND package.id = evidence.package_id
            JOIN operations_package_contents content
              ON content.organization_id = evidence.organization_id
             AND content.plan_id = plan.id
             AND content.order_id = evidence.order_id
             AND content.package_id = package.id
             AND content.order_line_id = canonical_line.id
             AND content.id = evidence.package_content_id
            WHERE evidence.authorization_id = auth.id
              AND evidence.organization_id = auth.organization_id
              AND evidence.confirmation_hash = auth.confirmation_hash
              AND source_order.integration_account_id = account.id
              AND account.provider = 'faire'
              AND account.integration_type = 'commerce'
              AND candidate.provider = 'faire'
              AND candidate.canonical_order_id = source_order.id
              AND candidate.workflow_state = 'promoted'
              AND candidate.global_id = evidence.order_candidate_global_id
              AND candidate.row_version =
                    evidence.order_candidate_row_version
              AND candidate.source_revision =
                    evidence.order_candidate_source_revision
              AND candidate.source_hash =
                    evidence.order_candidate_source_hash
              AND candidate.ship_to_snapshot_hash =
                    evidence.order_candidate_ship_to_hash
              AND candidate_line.provider = 'faire'
              AND candidate_line.workflow_state = 'promoted'
              AND candidate_line.global_id =
                    evidence.order_line_candidate_global_id
              AND candidate_line.row_version =
                    evidence.order_line_candidate_row_version
              AND candidate_line.source_revision =
                    evidence.order_line_candidate_source_revision
              AND candidate_line.source_hash =
                    evidence.order_line_candidate_source_hash
              AND candidate_line.canonical_order_line_id = canonical_line.id
              AND candidate_line.packaging_source = 'variant_pack_mapping'
              AND candidate_line.commerce_variant_pack_mapping_id =
                    pack_mapping.id
              AND candidate_line.commerce_variant_pack_mapping_row_version =
                    evidence.variant_pack_mapping_row_version
              AND candidate_line.pack_profile_version_id = pack_version.id
              AND candidate_line.pack_profile_version_row_version =
                    evidence.pack_profile_version_row_version
              AND candidate_line.unfulfilled_quantity = 1
              AND canonical_line.quantity = 1
              AND content.quantity = evidence.item_quantity
              AND evidence.item_quantity = 1
              AND pack_mapping.provider = 'faire'
              AND pack_mapping.global_id =
                    evidence.variant_pack_mapping_global_id
              AND pack_mapping.row_version =
                    evidence.variant_pack_mapping_row_version
              AND pack_mapping.pack_evidence_hash =
                    evidence.variant_pack_evidence_hash
              AND pack_mapping.external_product_id =
                    evidence.external_product_id
              AND pack_mapping.external_variant_id =
                    evidence.external_variant_id
              AND pack_mapping.default_pack_profile_version_id =
                    pack_version.id
              AND pack_mapping.is_current = true
              AND pack_mapping.projection_state = 'current'
              AND pack_version.global_id =
                    evidence.pack_profile_version_global_id
              AND pack_version.row_version =
                    evidence.pack_profile_version_row_version
              AND pack_version.is_current = true
              AND pack_version.lifecycle_state IN (
                'customer_confirmed', 'active'
              )
              AND pack_version.base_each_quantity = 1
              AND pack_version.dimension_basis = 'outer'
              AND pack_version.length_mm = evidence.length_mm
              AND pack_version.width_mm = evidence.width_mm
              AND pack_version.height_mm = evidence.height_mm
              AND pack_version.gross_weight_grams =
                    evidence.gross_weight_grams
              AND candidate_line.length_mm = evidence.length_mm
              AND candidate_line.width_mm = evidence.width_mm
              AND candidate_line.height_mm = evidence.height_mm
              AND candidate_line.weight_grams = evidence.gross_weight_grams
              AND (canonical_line.dimensions_mm->>'length')::integer =
                    evidence.length_mm
              AND (canonical_line.dimensions_mm->>'width')::integer =
                    evidence.width_mm
              AND (canonical_line.dimensions_mm->>'height')::integer =
                    evidence.height_mm
              AND canonical_line.weight_grams = evidence.gross_weight_grams
              AND plan.global_id = evidence.fulfillment_plan_global_id
              AND plan.version_number = evidence.fulfillment_plan_version
              AND plan.warehouse_id = evidence.warehouse_id
              AND plan.status = 'released'
              AND warehouse.address IS NOT NULL
              AND operations_sandbox_commerce_e2e_jsonb_hash(
                    warehouse.address
                  ) = evidence.warehouse_address_hash
              AND package.global_id = evidence.package_global_id
              AND package.package_number = evidence.package_number
              -- Shipment confirmation marks packages shipped immediately
              -- before the released plan transitions to fulfilled. The exact
              -- package identity and parcel evidence remain unchanged during
              -- that same transaction, so permit this transient state while
              -- the one-use authorization is still locked and active.
              AND package.status IN ('packed', 'labeled', 'shipped')
              AND package.length_mm = evidence.length_mm
              AND package.width_mm = evidence.width_mm
              AND package.height_mm = evidence.height_mm
              AND package.weight_grams = evidence.gross_weight_grams
              AND content.global_id = evidence.package_content_global_id
              AND operations_sandbox_commerce_e2e_jsonb_hash(
                    jsonb_build_object(
                      'packageGlobalId', package.global_id,
                      'contentGlobalId', content.global_id,
                      'orderLineGlobalId', canonical_line.global_id,
                      'quantity', content.quantity,
                      'lengthMm', package.length_mm,
                      'widthMm', package.width_mm,
                      'heightMm', package.height_mm,
                      'grossWeightGrams', package.weight_grams
                    )
                  ) = evidence.package_evidence_hash
              AND operations_sandbox_commerce_e2e_jsonb_hash(
                    source_order.ship_to
                  ) = evidence.ship_to_hash
              AND upper(coalesce(
                    source_order.ship_to->>'region',
                    source_order.ship_to->>'state'
                  )) = evidence.destination_region
              AND upper(coalesce(
                    source_order.ship_to->>'countryCode',
                    source_order.ship_to->>'country'
                  )) = evidence.destination_country_code
              AND length(btrim(coalesce(
                    source_order.ship_to->>'name', ''
                  ))) > 0
              AND length(btrim(coalesce(
                    source_order.ship_to->>'line1',
                    source_order.ship_to->>'street', ''
                  ))) > 0
              AND length(btrim(coalesce(
                    source_order.ship_to->>'city', ''
                  ))) > 0
              AND length(btrim(coalesce(
                    source_order.ship_to->>'postalCode',
                    source_order.ship_to->>'postal_code', ''
                  ))) > 0
              AND NOT EXISTS (
                SELECT 1
                FROM operations_commerce_order_candidates other_candidate
                WHERE other_candidate.organization_id = source_order.organization_id
                  AND other_candidate.canonical_order_id = source_order.id
                  AND other_candidate.id <> candidate.id
              )
              AND NOT EXISTS (
                SELECT 1
                FROM operations_commerce_order_candidate_lines other_line
                WHERE other_line.organization_id = candidate.organization_id
                  AND other_line.order_candidate_id = candidate.id
                  AND other_line.unfulfilled_quantity > 0
                  AND other_line.id <> candidate_line.id
              )
              AND NOT EXISTS (
                SELECT 1
                FROM operations_order_lines other_order_line
                WHERE other_order_line.organization_id = source_order.organization_id
                  AND other_order_line.order_id = source_order.id
                  AND other_order_line.id <> canonical_line.id
              )
              AND NOT EXISTS (
                SELECT 1
                FROM operations_packages other_package
                WHERE other_package.organization_id = plan.organization_id
                  AND other_package.plan_id = plan.id
                  AND other_package.id <> package.id
              )
              AND NOT EXISTS (
                SELECT 1
                FROM operations_package_contents other_content
                WHERE other_content.organization_id = package.organization_id
                  AND other_content.package_id = package.id
                  AND other_content.id <> content.id
              )
          )
        )
      )
  )
$$;

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
  active_sandbox_e2e_authorization boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'operations:activation:' || NEW.organization_id::text,
      0
    )
  );

  IF TG_OP = 'UPDATE'
     AND OLD.cartonization_evidence_id IS NOT NULL
     AND NEW.cartonization_evidence_id
       IS DISTINCT FROM OLD.cartonization_evidence_id
  THEN
    RAISE EXCEPTION
      'An accepted fulfillment plan cartonization evidence link is immutable';
  END IF;

  SELECT activation.state
    INTO activation_state
  FROM operations_activation_scopes activation
  WHERE activation.organization_id = NEW.organization_id
  LIMIT 1;

  SELECT EXISTS (
    SELECT 1
    FROM operations_sandbox_commerce_e2e_authorizations sandbox_auth
    WHERE sandbox_auth.organization_id = NEW.organization_id
      AND sandbox_auth.order_id = NEW.order_id
      AND operations_sandbox_commerce_e2e_authorization_is_current(
            sandbox_auth.organization_id,
            sandbox_auth.id,
            sandbox_auth.order_id
          )
  ) INTO active_sandbox_e2e_authorization;

  IF NEW.cartonization_evidence_id IS NULL THEN
    IF activation_state = 'active'
       AND (
         NEW.status IN ('planned', 'released')
         OR (
           TG_OP = 'UPDATE'
           AND OLD.status IN ('planned', 'released')
           AND NEW.status = 'fulfilled'
         )
       )
       AND NOT active_sandbox_e2e_authorization
    THEN
      RAISE EXCEPTION
        'Active fulfillment planning requires sealed production carrier-read evidence';
    END IF;
    RETURN NEW;
  END IF;

  SELECT
    evidence.sealed_at,
    evidence.evidence_mode,
    evidence.status,
    evidence.warehouse_id,
    candidate.canonical_order_id,
    candidate.workflow_state,
    candidate.source_hash,
    evidence.candidate_source_hash,
    evidence.plan_snapshot->>'carrierReadEnvironment'
  INTO
    linked_sealed_at,
    linked_mode,
    linked_status,
    linked_warehouse_id,
    linked_candidate_order_id,
    linked_candidate_state,
    linked_candidate_source_hash,
    evidence_candidate_source_hash,
    linked_carrier_read_environment
  FROM operations_cartonization_rate_evidence evidence
  JOIN operations_commerce_order_candidates candidate
    ON candidate.organization_id = evidence.organization_id
   AND candidate.integration_account_id = evidence.integration_account_id
   AND candidate.id = evidence.order_candidate_id
  WHERE evidence.organization_id = NEW.organization_id
    AND evidence.id = NEW.cartonization_evidence_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Fulfillment plan cartonization evidence was not found in this organization';
  END IF;
  IF linked_sealed_at IS NULL THEN
    RAISE EXCEPTION
      'Fulfillment planning requires sealed cartonization evidence';
  END IF;
  IF linked_mode IS DISTINCT FROM 'operational' THEN
    RAISE EXCEPTION
      'Assumption-backed sandbox evidence cannot become a fulfillment plan';
  END IF;
  IF activation_state = 'active'
     AND linked_carrier_read_environment IS DISTINCT FROM 'production'
     AND NOT active_sandbox_e2e_authorization
  THEN
    RAISE EXCEPTION
      'Active fulfillment planning requires production carrier-read evidence';
  END IF;
  IF linked_status NOT IN ('succeeded', 'partial') THEN
    RAISE EXCEPTION
      'Failed cartonization evidence cannot become a fulfillment plan';
  END IF;
  IF linked_warehouse_id IS DISTINCT FROM NEW.warehouse_id THEN
    RAISE EXCEPTION
      'Fulfillment plan warehouse must match its cartonization evidence';
  END IF;
  IF linked_candidate_state IS DISTINCT FROM 'promoted'
     OR linked_candidate_order_id IS DISTINCT FROM NEW.order_id
  THEN
    RAISE EXCEPTION
      'Fulfillment plan evidence must belong to the promoted canonical order';
  END IF;
  IF linked_candidate_source_hash
       IS DISTINCT FROM evidence_candidate_source_hash
  THEN
    RAISE EXCEPTION
      'Fulfillment plan cartonization evidence is stale';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION validate_ops_activation_canonical_plans()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  incompatible_plan_global_id text;
BEGIN
  IF NEW.state IS DISTINCT FROM 'active' THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'operations:activation:' || NEW.organization_id::text,
      0
    )
  );

  SELECT plan.global_id
    INTO incompatible_plan_global_id
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
    AND (
      plan.cartonization_evidence_id IS NULL
      OR evidence.plan_snapshot->>'carrierReadEnvironment'
           IS DISTINCT FROM 'production'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM operations_sandbox_commerce_e2e_authorizations sandbox_auth
      WHERE sandbox_auth.organization_id = plan.organization_id
        AND sandbox_auth.order_id = plan.order_id
        AND operations_sandbox_commerce_e2e_authorization_is_current(
              sandbox_auth.organization_id,
              sandbox_auth.id,
              sandbox_auth.order_id
            )
    )
  ORDER BY plan.created_at, plan.id
  LIMIT 1;

  IF incompatible_plan_global_id IS NOT NULL THEN
    RAISE EXCEPTION
      'Active Operations cannot retain missing or non-production carrier-read plan %',
      incompatible_plan_global_id;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON TABLE operations_sandbox_commerce_e2e_faire_evidence IS
  'Immutable exact promoted-order, mapped-pack, package, origin, and CA destination evidence for one Faire sandbox E2E authorization.';
COMMENT ON FUNCTION operations_sandbox_commerce_e2e_authorization_is_current(
  uuid, uuid, uuid
) IS
  'Preserves existing Shopify sandbox authority and requires exact immutable Faire order/pack/package/address evidence.';
