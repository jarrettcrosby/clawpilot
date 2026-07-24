-- Toast assigns activity before a restaurant's configured closeout hour to the
-- preceding business date. Persist that setting so POS posting readiness uses
-- the restaurant's business-day boundary instead of local calendar midnight.

ALTER TABLE toast_locations
  ADD COLUMN IF NOT EXISTS closeout_hour smallint;

ALTER TABLE toast_locations
  DROP CONSTRAINT IF EXISTS toast_locations_closeout_hour_valid;

ALTER TABLE toast_locations
  ADD CONSTRAINT toast_locations_closeout_hour_valid
  CHECK (closeout_hour BETWEEN 0 AND 12);
