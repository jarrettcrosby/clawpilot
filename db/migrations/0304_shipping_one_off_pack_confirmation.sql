-- Let a Shipping-only operator physically review and pack a ClawPilot-native
-- one-off plan without activating Operations or weakening imported-order gates.
-- The command receipt seals the exact pre-pack order, plan, package, content,
-- reservation, and inventory-position version evidence. Packing itself has no
-- carrier, label, shipment, or inventory mutation.

CREATE TABLE operations_shipping_one_off_pack_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  order_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  planning_quote_id uuid NOT NULL,
  planning_offer_id uuid NOT NULL,
  actor_email text REFERENCES app_users(email) ON DELETE SET NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  reason text NOT NULL,
  confirmation_statement text NOT NULL,
  expected_order_row_version bigint NOT NULL
    CHECK (expected_order_row_version >= 0),
  order_row_version_after bigint NOT NULL,
  plan_version_number integer NOT NULL CHECK (plan_version_number > 0),
  review_snapshot jsonb NOT NULL,
  review_snapshot_hash text NOT NULL
    CHECK (review_snapshot_hash ~ '^[a-f0-9]{64}$'),
  package_count integer NOT NULL CHECK (package_count BETWEEN 1 AND 40),
  reservation_count integer NOT NULL CHECK (reservation_count > 0),
  provider_write_count integer NOT NULL DEFAULT 0
    CHECK (provider_write_count = 0),
  label_write_count integer NOT NULL DEFAULT 0 CHECK (label_write_count = 0),
  shipment_write_count integer NOT NULL DEFAULT 0
    CHECK (shipment_write_count = 0),
  packed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_shipping_one_off_pack_receipts_order_fkey
    FOREIGN KEY (organization_id, order_id)
    REFERENCES operations_orders(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_shipping_one_off_pack_receipts_plan_fkey
    FOREIGN KEY (organization_id, plan_id)
    REFERENCES operations_fulfillment_plans(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_shipping_one_off_pack_receipts_quote_fkey
    FOREIGN KEY (organization_id, planning_quote_id)
    REFERENCES operations_one_off_shipment_quotes(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_shipping_one_off_pack_receipts_offer_fkey
    FOREIGN KEY (
      organization_id, planning_quote_id, planning_offer_id
    ) REFERENCES operations_one_off_shipment_quote_offers(
      organization_id, quote_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_shipping_one_off_pack_receipts_idempotency_unique
    UNIQUE (organization_id, idempotency_key),
  CONSTRAINT operations_shipping_one_off_pack_receipts_order_unique
    UNIQUE (organization_id, order_id),
  CONSTRAINT operations_shipping_one_off_pack_receipts_text_valid CHECK (
    length(btrim(idempotency_key)) BETWEEN 8 AND 200
    AND idempotency_key !~ '[[:cntrl:]]'
    AND length(btrim(reason)) BETWEEN 10 AND 500
    AND reason !~ '[[:cntrl:]]'
    AND confirmation_statement =
      'I CONFIRM THESE EXACT ITEMS ARE PHYSICALLY IN THESE PACKAGES'
  ),
  CONSTRAINT operations_shipping_one_off_pack_receipts_versions_valid CHECK (
    order_row_version_after = expected_order_row_version + 1
  ),
  CONSTRAINT operations_shipping_one_off_pack_receipts_snapshot_valid CHECK (
    jsonb_typeof(review_snapshot) = 'object'
    AND review_snapshot->>'schemaVersion' =
      'shipping.one_off_pack_review.v1'
    AND review_snapshot->'order'->>'status' = 'planned'
    AND review_snapshot->'plan'->>'status' = 'planned'
    AND jsonb_typeof(review_snapshot->'lines') = 'array'
    AND jsonb_array_length(review_snapshot->'lines') > 0
    AND jsonb_typeof(review_snapshot->'packages') = 'array'
    AND jsonb_array_length(review_snapshot->'packages') = package_count
    AND jsonb_typeof(review_snapshot->'reservations') = 'array'
    AND jsonb_array_length(review_snapshot->'reservations')
      = reservation_count
  )
);

COMMENT ON TABLE operations_shipping_one_off_pack_receipts IS
  'Immutable Shipping-only physical pack confirmations for exact ClawPilot-native one-off plans; every provider-write counter is structurally zero.';

CREATE INDEX operations_shipping_one_off_pack_receipts_plan_idx
  ON operations_shipping_one_off_pack_receipts (
    organization_id, plan_id, packed_at DESC
  );

-- Reconstruct the complete application snapshot from relational authority.
-- The order/package statuses and order row version are the exact pre-pack
-- values; the validator runs after the atomic status transition.
CREATE OR REPLACE FUNCTION operations_shipping_one_off_pack_review_snapshot(
  authority_organization_id uuid,
  authority_order_id uuid,
  authority_plan_id uuid,
  authority_quote_id uuid,
  authority_offer_id uuid
)
RETURNS jsonb
LANGUAGE sql
STABLE
STRICT
AS $$
  WITH authority AS (
    SELECT source_order.global_id AS order_global_id,
           source_order.row_version AS order_row_version_after,
           source_order.source_provider,
           source_order.order_type,
           plan.global_id AS plan_global_id,
           plan.status AS plan_status,
           plan.version_number,
           quote.global_id AS quote_global_id,
           quote.execution_mode,
           quote.lines_snapshot,
           quote.packages_snapshot,
           offer.global_id AS offer_global_id
    FROM operations_orders source_order
    JOIN operations_fulfillment_plans plan
      ON plan.organization_id = source_order.organization_id
     AND plan.order_id = source_order.id
     AND plan.id = authority_plan_id
    JOIN operations_one_off_shipment_quotes quote
      ON quote.organization_id = plan.organization_id
     AND quote.id = plan.one_off_quote_id
     AND quote.id = authority_quote_id
    JOIN operations_one_off_shipment_quote_offers offer
      ON offer.organization_id = quote.organization_id
     AND offer.quote_id = quote.id
     AND offer.id = plan.one_off_offer_id
     AND offer.id = authority_offer_id
    WHERE source_order.organization_id = authority_organization_id
      AND source_order.id = authority_order_id
  ), reviewed_lines AS (
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'lineKey', sealed.line_snapshot->>'lineKey',
        'kind', sealed.line_snapshot->>'kind',
        'name', COALESCE(
          NULLIF(sealed.line_snapshot->>'productName', ''),
          product.name,
          ad_hoc.item_snapshot->>'name',
          ''
        ),
        'sku', NULLIF(COALESCE(
          NULLIF(sealed.line_snapshot->>'sku', ''),
          NULLIF(btrim(product.sku), ''),
          NULLIF(ad_hoc.item_snapshot->>'sku', ''),
          ''
        ), ''),
        'productGlobalId', product.reference_code,
        'quantity', (sealed.line_snapshot->>'quantity')::numeric
      ) ORDER BY sealed.ordinality
    ), '[]'::jsonb) AS lines
    FROM authority
    CROSS JOIN LATERAL jsonb_array_elements(authority.lines_snapshot)
      WITH ORDINALITY sealed(line_snapshot, ordinality)
    LEFT JOIN operations_order_lines order_line
      ON order_line.organization_id = authority_organization_id
     AND order_line.order_id = authority_order_id
     AND order_line.external_line_id = sealed.line_snapshot->>'lineKey'
     AND order_line.revision_retired_at IS NULL
    LEFT JOIN crm_products product
      ON product.pipeline_id = order_line.pipeline_id
     AND product.id = order_line.product_id
    LEFT JOIN operations_one_off_ad_hoc_order_lines ad_hoc
      ON ad_hoc.organization_id = authority_organization_id
     AND ad_hoc.order_id = authority_order_id
     AND ad_hoc.line_key = sealed.line_snapshot->>'lineKey'
  ), reviewed_packages AS (
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'globalId', package.global_id,
        'packageNumber', package.package_number,
        'description', COALESCE(
          NULLIF(authority.packages_snapshot
            -> (package.package_number - 1) ->> 'description', ''),
          'Parcel ' || package.package_number::text
        ),
        'status', 'planned',
        'dimensionsMm', jsonb_build_object(
          'length', package.length_mm,
          'width', package.width_mm,
          'height', package.height_mm
        ),
        'grossWeightGrams', package.weight_grams,
        'contents', package_content.contents
      ) ORDER BY package.package_number, package.id
    ), '[]'::jsonb) AS packages
    FROM authority
    JOIN operations_packages package
      ON package.organization_id = authority_organization_id
     AND package.plan_id = authority_plan_id
    CROSS JOIN LATERAL (
      SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
          'lineKey', exact_content.line_key,
          'quantity', exact_content.quantity
        ) ORDER BY exact_content.line_key
      ), '[]'::jsonb) AS contents
      FROM (
        SELECT order_line.external_line_id AS line_key, content.quantity
        FROM operations_package_contents content
        JOIN operations_order_lines order_line
          ON order_line.organization_id = content.organization_id
         AND order_line.id = content.order_line_id
         AND order_line.order_id = content.order_id
         AND order_line.revision_retired_at IS NULL
        WHERE content.organization_id = authority_organization_id
          AND content.plan_id = authority_plan_id
          AND content.package_id = package.id
        UNION ALL
        SELECT ad_hoc.line_key, content.quantity
        FROM operations_one_off_ad_hoc_package_contents content
        JOIN operations_one_off_ad_hoc_order_lines ad_hoc
          ON ad_hoc.organization_id = content.organization_id
         AND ad_hoc.order_id = content.order_id
         AND ad_hoc.id = content.ad_hoc_order_line_id
        WHERE content.organization_id = authority_organization_id
          AND content.plan_id = authority_plan_id
          AND content.package_id = package.id
      ) exact_content
    ) package_content
  ), reviewed_reservations AS (
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'globalId', reservation.global_id,
        'lineKey', order_line.external_line_id,
        'productGlobalId', product.reference_code,
        'positionGlobalId', position.global_id,
        'positionRowVersion', position.version,
        'quantity', reservation.quantity,
        'status', reservation.status
      ) ORDER BY order_line.external_line_id, position.global_id,
                 reservation.global_id
    ), '[]'::jsonb) AS reservations
    FROM authority
    JOIN operations_fulfillment_allocations allocation
      ON allocation.organization_id = authority_organization_id
     AND allocation.plan_id = authority_plan_id
    JOIN operations_reservations reservation
      ON reservation.organization_id = allocation.organization_id
     AND reservation.id = allocation.reservation_id
     AND reservation.order_line_id = allocation.order_line_id
     AND reservation.position_id = allocation.position_id
    JOIN operations_order_lines order_line
      ON order_line.organization_id = allocation.organization_id
     AND order_line.order_id = authority_order_id
     AND order_line.id = allocation.order_line_id
     AND order_line.revision_retired_at IS NULL
    JOIN crm_products product
      ON product.pipeline_id = order_line.pipeline_id
     AND product.id = order_line.product_id
    JOIN operations_inventory_positions position
      ON position.organization_id = allocation.organization_id
     AND position.id = allocation.position_id
  )
  SELECT jsonb_build_object(
    'schemaVersion', 'shipping.one_off_pack_review.v1',
    'order', jsonb_build_object(
      'globalId', authority.order_global_id,
      'status', 'planned',
      'rowVersion', authority.order_row_version_after - 1,
      'sourceProvider', authority.source_provider,
      'orderType', authority.order_type
    ),
    'plan', jsonb_build_object(
      'globalId', authority.plan_global_id,
      'status', authority.plan_status,
      'versionNumber', authority.version_number,
      'quoteGlobalId', authority.quote_global_id,
      'offerGlobalId', authority.offer_global_id,
      'executionMode', authority.execution_mode
    ),
    'lines', reviewed_lines.lines,
    'packages', reviewed_packages.packages,
    'reservations', reviewed_reservations.reservations
  )
  FROM authority, reviewed_lines, reviewed_packages, reviewed_reservations
$$;

CREATE OR REPLACE FUNCTION validate_operations_shipping_one_off_pack_receipt()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM operations_orders source_order
    JOIN operations_fulfillment_plans plan
      ON plan.organization_id = source_order.organization_id
     AND plan.order_id = source_order.id
     AND plan.id = NEW.plan_id
    JOIN operations_one_off_shipment_quotes quote
      ON quote.organization_id = plan.organization_id
     AND quote.id = plan.one_off_quote_id
     AND quote.id = NEW.planning_quote_id
    JOIN operations_one_off_shipment_quote_offers offer
      ON offer.organization_id = quote.organization_id
     AND offer.quote_id = quote.id
     AND offer.id = plan.one_off_offer_id
     AND offer.id = NEW.planning_offer_id
    WHERE source_order.organization_id = NEW.organization_id
      AND source_order.id = NEW.order_id
      AND source_order.source_provider = 'clawpilot_native'
      AND source_order.order_type = 'one_off'
      AND source_order.status = 'packed'
      AND source_order.row_version = NEW.order_row_version_after
      AND source_order.archived_at IS NULL
      AND plan.status = 'planned'
      AND plan.version_number = NEW.plan_version_number
      AND operations_one_off_plan_execution_is_exact(
        plan.organization_id, plan.id, quote.execution_mode
      )
      AND operations_one_off_plan_package_set_is_exact(
        plan.organization_id, plan.id, quote.id
      )
      AND NEW.review_snapshot->'order'->>'globalId'
        = source_order.global_id
      AND (NEW.review_snapshot->'order'->>'rowVersion')::bigint
        = NEW.expected_order_row_version
      AND NEW.review_snapshot->'order'->>'sourceProvider'
        = 'clawpilot_native'
      AND NEW.review_snapshot->'order'->>'orderType' = 'one_off'
      AND NEW.review_snapshot->'plan'->>'globalId' = plan.global_id
      AND (NEW.review_snapshot->'plan'->>'versionNumber')::integer
        = plan.version_number
      AND NEW.review_snapshot->'plan'->>'quoteGlobalId' = quote.global_id
      AND NEW.review_snapshot->'plan'->>'offerGlobalId' = offer.global_id
      AND NEW.review_snapshot =
        operations_shipping_one_off_pack_review_snapshot(
          NEW.organization_id,
          NEW.order_id,
          NEW.plan_id,
          NEW.planning_quote_id,
          NEW.planning_offer_id
        )
      AND NEW.review_snapshot_hash =
        operations_transport_json_sha256(NEW.review_snapshot)
      AND NEW.package_count = (
        SELECT count(*)
        FROM operations_packages package
        WHERE package.organization_id = plan.organization_id
          AND package.plan_id = plan.id
          AND package.status = 'packed'
          AND package.packed_by IS NOT DISTINCT FROM NEW.actor_email
          AND package.packed_at = NEW.packed_at
      )
      AND NEW.reservation_count = (
        SELECT count(*)
        FROM operations_fulfillment_allocations allocation
        JOIN operations_reservations reservation
          ON reservation.organization_id = allocation.organization_id
         AND reservation.id = allocation.reservation_id
         AND reservation.order_id = source_order.id
         AND reservation.order_line_id = allocation.order_line_id
         AND reservation.position_id = allocation.position_id
         AND reservation.quantity = allocation.quantity
         AND reservation.status = 'active'
        WHERE allocation.organization_id = plan.organization_id
          AND allocation.plan_id = plan.id
      )
  ) THEN
    RAISE EXCEPTION
      'Shipping one-off pack receipt must retain the exact native order, plan, packages, reservations, and row versions';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER validate_operations_shipping_one_off_pack_receipt_write
BEFORE INSERT ON operations_shipping_one_off_pack_receipts
FOR EACH ROW
EXECUTE FUNCTION validate_operations_shipping_one_off_pack_receipt();

CREATE OR REPLACE FUNCTION protect_operations_shipping_one_off_pack_receipt()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Shipping one-off pack receipt is immutable';
END;
$$;

CREATE TRIGGER protect_operations_shipping_one_off_pack_receipt_write
BEFORE UPDATE OR DELETE ON operations_shipping_one_off_pack_receipts
FOR EACH ROW
EXECUTE FUNCTION protect_operations_shipping_one_off_pack_receipt();

-- Rows reviewed by a pack receipt cannot be changed or appended after a
-- concurrent writer waits on the pack transaction's parent/row locks. Package
-- and reservation lifecycle state may continue through label/ship/void; the
-- exact line, content, and allocation identities remain sealed.
CREATE OR REPLACE FUNCTION protect_operations_shipping_one_off_pack_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  linked_organization_id uuid;
  linked_order_id uuid;
  linked_plan_id uuid;
  linked_order_global_id text;
BEGIN
  linked_organization_id := COALESCE(NEW.organization_id, OLD.organization_id);
  IF TG_TABLE_NAME IN (
    'operations_order_lines',
    'operations_one_off_ad_hoc_order_lines'
  ) THEN
    linked_order_id := COALESCE(NEW.order_id, OLD.order_id);
  ELSE
    linked_plan_id := COALESCE(NEW.plan_id, OLD.plan_id);
  END IF;

  IF linked_order_id IS NULL THEN
    SELECT plan.order_id INTO linked_order_id
    FROM operations_fulfillment_plans plan
    WHERE plan.organization_id = linked_organization_id
      AND plan.id = linked_plan_id;
  END IF;
  SELECT source_order.global_id INTO linked_order_global_id
  FROM operations_orders source_order
  WHERE source_order.organization_id = linked_organization_id
    AND source_order.id = linked_order_id;
  IF linked_order_global_id IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Use the same lock order as the pack command. A writer that starts first is
  -- visible to pack review; a writer that starts second resumes after commit,
  -- refreshes its READ COMMITTED snapshot below, and sees the new receipt.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'shipping:one-off-pack:' || linked_organization_id::text || ':'
      || linked_order_global_id,
    0
  ));
  PERFORM 1
  FROM operations_orders source_order
  WHERE source_order.organization_id = linked_organization_id
    AND source_order.id = linked_order_id
  FOR UPDATE;

  IF EXISTS (
    SELECT 1
    FROM operations_shipping_one_off_pack_receipts receipt
    WHERE receipt.organization_id = linked_organization_id
      AND (
        receipt.order_id = linked_order_id
        OR (linked_plan_id IS NOT NULL AND receipt.plan_id = linked_plan_id)
      )
  ) THEN
    RAISE EXCEPTION
      'Shipping one-off pack line, content, and allocation evidence is sealed';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER protect_shipping_pack_order_line_evidence
BEFORE INSERT OR UPDATE OR DELETE ON operations_order_lines
FOR EACH ROW
EXECUTE FUNCTION protect_operations_shipping_one_off_pack_evidence();

CREATE TRIGGER protect_shipping_pack_allocation_evidence
BEFORE INSERT OR UPDATE OR DELETE ON operations_fulfillment_allocations
FOR EACH ROW
EXECUTE FUNCTION protect_operations_shipping_one_off_pack_evidence();

CREATE TRIGGER protect_shipping_pack_package_content_evidence
BEFORE INSERT OR UPDATE OR DELETE ON operations_package_contents
FOR EACH ROW
EXECUTE FUNCTION protect_operations_shipping_one_off_pack_evidence();

CREATE TRIGGER protect_shipping_pack_ad_hoc_line_evidence
BEFORE INSERT OR UPDATE OR DELETE
ON operations_one_off_ad_hoc_order_lines
FOR EACH ROW
EXECUTE FUNCTION protect_operations_shipping_one_off_pack_evidence();

CREATE TRIGGER protect_shipping_pack_ad_hoc_content_evidence
BEFORE INSERT OR UPDATE OR DELETE
ON operations_one_off_ad_hoc_package_contents
FOR EACH ROW
EXECUTE FUNCTION protect_operations_shipping_one_off_pack_evidence();
