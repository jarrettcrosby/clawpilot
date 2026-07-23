-- New cartonization output begins as a plan. Packing must be confirmed through
-- the controlled pack-verification command before labels or shipment exist.
ALTER TABLE operations_packages
  ALTER COLUMN status SET DEFAULT 'planned';
