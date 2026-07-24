-- Facility-local operating calendars and throughput assumptions used by
-- warehouse readiness, promise planning, and capacity-aware optimization.

ALTER TABLE operations_warehouses
  ADD COLUMN IF NOT EXISTS operating_days smallint[] NOT NULL
    DEFAULT ARRAY[1, 2, 3, 4, 5]::smallint[],
  ADD COLUMN IF NOT EXISTS opens_at time NOT NULL DEFAULT '08:00'::time,
  ADD COLUMN IF NOT EXISTS closes_at time NOT NULL DEFAULT '17:00'::time,
  ADD COLUMN IF NOT EXISTS standard_processing_minutes integer NOT NULL DEFAULT 120,
  ADD COLUMN IF NOT EXISTS daily_order_capacity integer;

ALTER TABLE operations_warehouses
  DROP CONSTRAINT IF EXISTS operations_warehouses_operating_days_valid,
  DROP CONSTRAINT IF EXISTS operations_warehouses_operating_hours_valid,
  DROP CONSTRAINT IF EXISTS operations_warehouses_processing_minutes_valid,
  DROP CONSTRAINT IF EXISTS operations_warehouses_daily_order_capacity_valid;

ALTER TABLE operations_warehouses
  ADD CONSTRAINT operations_warehouses_operating_days_valid CHECK (
    cardinality(operating_days) BETWEEN 1 AND 7
    AND operating_days <@ ARRAY[0, 1, 2, 3, 4, 5, 6]::smallint[]
  ),
  ADD CONSTRAINT operations_warehouses_operating_hours_valid CHECK (
    opens_at <> closes_at
  ),
  ADD CONSTRAINT operations_warehouses_processing_minutes_valid CHECK (
    standard_processing_minutes BETWEEN 0 AND 10080
  ),
  ADD CONSTRAINT operations_warehouses_daily_order_capacity_valid CHECK (
    daily_order_capacity IS NULL OR daily_order_capacity > 0
  );
