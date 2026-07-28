-- Durable carton-to-order-line allocation for package-specific documents.
--
-- The existing carton plan stores package dimensions, but it does not identify
-- the exact quantity of each order line placed in each physical package. That
-- omission makes a package-specific packing list unverifiable. This migration
-- adds the smallest durable allocation boundary and links new print artifacts
-- to their source package.

INSERT INTO global_reference_entity_types (prefix, entity_type, display_name)
VALUES ('gpc', 'operations.package_content', 'Package content allocation')
ON CONFLICT (prefix) DO UPDATE SET
  entity_type = EXCLUDED.entity_type,
  display_name = EXCLUDED.display_name;

CREATE UNIQUE INDEX IF NOT EXISTS
  operations_fulfillment_plans_order_plan_unique
ON operations_fulfillment_plans (organization_id, order_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS
  operations_packages_plan_package_unique
ON operations_packages (organization_id, plan_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS
  operations_order_lines_order_line_unique
ON operations_order_lines (organization_id, order_id, id);

CREATE TABLE IF NOT EXISTS operations_package_contents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gpc'),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  plan_id uuid NOT NULL,
  order_id uuid NOT NULL,
  package_id uuid NOT NULL,
  order_line_id uuid NOT NULL,
  quantity numeric(20,6) NOT NULL CHECK (quantity > 0),
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_package_contents_global_valid
    CHECK (global_id ~ '^gpc[0-9]{7}$'),
  CONSTRAINT operations_package_contents_global_unique UNIQUE (global_id),
  CONSTRAINT operations_package_contents_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_package_contents_plan_fkey
    FOREIGN KEY (organization_id, order_id, plan_id)
    REFERENCES operations_fulfillment_plans(organization_id, order_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_package_contents_package_fkey
    FOREIGN KEY (organization_id, plan_id, package_id)
    REFERENCES operations_packages(organization_id, plan_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_package_contents_order_line_fkey
    FOREIGN KEY (organization_id, order_id, order_line_id)
    REFERENCES operations_order_lines(organization_id, order_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_package_contents_package_line_unique
    UNIQUE (organization_id, package_id, order_line_id),
  CONSTRAINT operations_package_contents_org_id_unique
    UNIQUE (organization_id, id)
);

CREATE INDEX IF NOT EXISTS operations_package_contents_plan_idx
  ON operations_package_contents (
    organization_id, plan_id, package_id, order_line_id
  );

CREATE INDEX IF NOT EXISTS operations_package_contents_order_line_idx
  ON operations_package_contents (
    organization_id, order_id, order_line_id, package_id
  );

-- Existing plans can be backfilled only when there is exactly one package.
-- Assigning quantities across two or more historical packages would invent
-- cartonization evidence, so those plans deliberately remain unresolved.
WITH single_package_plans AS (
  SELECT
    package.organization_id,
    package.plan_id,
    (array_agg(package.id ORDER BY package.id))[1] AS package_id
  FROM operations_packages package
  GROUP BY package.organization_id, package.plan_id
  HAVING count(*) = 1
),
allocated_lines AS (
  SELECT
    allocation.organization_id,
    allocation.plan_id,
    plan.order_id,
    allocation.order_line_id,
    sum(allocation.quantity) AS quantity
  FROM operations_fulfillment_allocations allocation
  JOIN operations_fulfillment_plans plan
    ON plan.organization_id = allocation.organization_id
   AND plan.id = allocation.plan_id
  GROUP BY
    allocation.organization_id,
    allocation.plan_id,
    plan.order_id,
    allocation.order_line_id
)
INSERT INTO operations_package_contents (
  organization_id,
  plan_id,
  order_id,
  package_id,
  order_line_id,
  quantity,
  created_by
)
SELECT
  allocated.organization_id,
  allocated.plan_id,
  allocated.order_id,
  single_package.package_id,
  allocated.order_line_id,
  allocated.quantity,
  plan.created_by
FROM allocated_lines allocated
JOIN single_package_plans single_package
  ON single_package.organization_id = allocated.organization_id
 AND single_package.plan_id = allocated.plan_id
JOIN operations_fulfillment_plans plan
  ON plan.organization_id = allocated.organization_id
 AND plan.id = allocated.plan_id
WHERE allocated.quantity > 0
ON CONFLICT (
  organization_id,
  package_id,
  order_line_id
) DO NOTHING;

CREATE OR REPLACE FUNCTION protect_operations_package_content()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'Package content allocations are immutable and cannot be updated or deleted';
END;
$$;

DROP TRIGGER IF EXISTS protect_operations_package_content_write
  ON operations_package_contents;
CREATE TRIGGER protect_operations_package_content_write
BEFORE UPDATE OR DELETE ON operations_package_contents
FOR EACH ROW EXECUTE FUNCTION protect_operations_package_content();

COMMENT ON TABLE operations_package_contents IS
  'Immutable exact order-line quantities assigned to one physical package by a fulfillment plan.';

ALTER TABLE operations_print_artifacts
  ADD COLUMN IF NOT EXISTS source_package_id uuid;

ALTER TABLE operations_print_artifacts
  DROP CONSTRAINT IF EXISTS operations_print_artifacts_source_package_fkey,
  ADD CONSTRAINT operations_print_artifacts_source_package_fkey
    FOREIGN KEY (organization_id, source_package_id)
    REFERENCES operations_packages(organization_id, id)
    ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_operations_print_artifacts_source_package
  ON operations_print_artifacts (
    organization_id, source_package_id, created_at DESC
  )
  WHERE source_package_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS
  operations_print_artifacts_package_packing_list_unique
ON operations_print_artifacts (
  organization_id, source_package_id, format, media_size
)
WHERE document_type = 'packing_slip'
  AND source_package_id IS NOT NULL
  AND source_shipment_id IS NULL;
