-- Product-aware storage roles and replenishment controls. Inventory positions
-- remain the source of current stock; these fields describe how each location
-- should be used and when a forward pick face should be replenished.

ALTER TABLE operations_warehouses
  ADD COLUMN IF NOT EXISTS carrier_cutoffs jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE operations_warehouses
  DROP CONSTRAINT IF EXISTS operations_warehouses_carrier_cutoffs_valid;

ALTER TABLE operations_warehouses
  ADD CONSTRAINT operations_warehouses_carrier_cutoffs_valid CHECK (
    jsonb_typeof(carrier_cutoffs) = 'object'
    AND NOT jsonb_path_exists(
      carrier_cutoffs,
      '$.* ? (!(@ like_regex "^([01][0-9]|2[0-3]):[0-5][0-9]$"))'
    )
  );

ALTER TABLE operations_locations
  ADD COLUMN IF NOT EXISTS storage_function text NOT NULL DEFAULT 'work_area';

UPDATE operations_locations
SET storage_function = CASE
  WHEN location_type = 'pick' THEN 'forward_pick'
  WHEN location_type = 'storage' THEN 'reserve'
  WHEN location_type = 'staging' THEN 'staging'
  ELSE 'work_area'
END
WHERE storage_function = 'work_area';

ALTER TABLE operations_locations
  DROP CONSTRAINT IF EXISTS operations_locations_storage_function_valid;

ALTER TABLE operations_locations
  ADD CONSTRAINT operations_locations_storage_function_valid CHECK (
    storage_function IN (
      'work_area', 'reserve', 'bulk', 'forward_pick', 'mezzanine_pick',
      'flow_rack', 'staging'
    )
  );

ALTER TABLE operations_location_product_rules
  ADD COLUMN IF NOT EXISTS replenishment_mode text NOT NULL DEFAULT 'disabled',
  ADD COLUMN IF NOT EXISTS replenishment_source_location_id uuid,
  ADD COLUMN IF NOT EXISTS min_quantity numeric(20,6),
  ADD COLUMN IF NOT EXISTS target_quantity numeric(20,6);

ALTER TABLE operations_location_product_rules
  DROP CONSTRAINT IF EXISTS operations_location_product_rules_replenishment_mode_valid,
  DROP CONSTRAINT IF EXISTS operations_location_product_rules_replenishment_thresholds_valid,
  DROP CONSTRAINT IF EXISTS operations_location_product_rules_replenishment_source_fkey,
  DROP CONSTRAINT IF EXISTS operations_location_product_rules_replenishment_source_not_self;

ALTER TABLE operations_location_product_rules
  ADD CONSTRAINT operations_location_product_rules_replenishment_mode_valid CHECK (
    replenishment_mode IN ('disabled', 'min_max', 'order_demand')
  ),
  ADD CONSTRAINT operations_location_product_rules_replenishment_thresholds_valid CHECK (
    (min_quantity IS NULL OR min_quantity >= 0)
    AND (target_quantity IS NULL OR target_quantity > 0)
    AND (
      min_quantity IS NULL
      OR target_quantity IS NULL
      OR min_quantity <= target_quantity
    )
    AND (
      target_quantity IS NULL
      OR max_quantity IS NULL
      OR target_quantity <= max_quantity
    )
    AND (
      replenishment_mode = 'disabled'
      OR (
        replenishment_source_location_id IS NOT NULL
        AND target_quantity IS NOT NULL
        AND (replenishment_mode <> 'min_max' OR min_quantity IS NOT NULL)
      )
    )
  ),
  ADD CONSTRAINT operations_location_product_rules_replenishment_source_fkey
    FOREIGN KEY (organization_id, replenishment_source_location_id)
    REFERENCES operations_locations(organization_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT operations_location_product_rules_replenishment_source_not_self CHECK (
    replenishment_source_location_id IS NULL
    OR replenishment_source_location_id <> location_id
  );

CREATE INDEX IF NOT EXISTS idx_operations_location_product_rules_replenishment
  ON operations_location_product_rules (
    organization_id, replenishment_mode, replenishment_source_location_id,
    location_id, product_id
  )
  WHERE active = true AND replenishment_mode <> 'disabled';
