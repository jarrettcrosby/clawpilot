-- Strengthen cartonization/rate evidence after the initial aggregate shipped.
--
-- 1. A package can retain every approved recipe that contributed to a mixed
--    product carton.
-- 2. Each quote is bound to the exact destination and parcel submitted to the
--    carrier-rate ledger.
-- 3. A durable command reservation claims semantic idempotency before any
--    external carrier read occurs.

ALTER TABLE operations_approved_pack_recipes
  DROP CONSTRAINT IF EXISTS
    operations_approved_pack_recipes_evidence_recipe_context_unique,
  ADD CONSTRAINT
    operations_approved_pack_recipes_evidence_recipe_context_unique
    UNIQUE (
      organization_id, packaging_material_id, id, product_id,
      input_pack_profile_version_id
    );

ALTER TABLE operations_cartonization_rate_evidence_packages
  DROP CONSTRAINT IF EXISTS
    operations_cartonization_rate_evidence_packages_material_unique,
  ADD CONSTRAINT
    operations_cartonization_rate_evidence_packages_material_unique
    UNIQUE (
      organization_id, evidence_id, package_key, packaging_material_id
    );

ALTER TABLE operations_cartonization_rate_evidence
  ADD COLUMN IF NOT EXISTS destination_fingerprint text;

ALTER TABLE operations_cartonization_rate_evidence_packages
  ADD COLUMN IF NOT EXISTS carrier_parcel_snapshot jsonb;

ALTER TABLE operations_cartonization_rate_evidence_quotes
  ADD COLUMN IF NOT EXISTS carrier_request_hash text,
  ADD COLUMN IF NOT EXISTS package_rate_context_hash text;

WITH evidence_destinations AS (
  SELECT
    quote.organization_id,
    quote.evidence_id,
    min(
      rate.redacted_request #>> '{shipment,destinationFingerprint}'
    ) AS destination_fingerprint
  FROM operations_cartonization_rate_evidence_quotes quote
  JOIN operations_carrier_rate_requests rate
    ON rate.organization_id = quote.organization_id
   AND rate.provider = quote.provider
   AND rate.purpose = quote.rate_purpose
   AND rate.id = quote.carrier_rate_request_id
  GROUP BY quote.organization_id, quote.evidence_id
)
UPDATE operations_cartonization_rate_evidence evidence
SET destination_fingerprint = destination.destination_fingerprint
FROM evidence_destinations destination
WHERE destination.organization_id = evidence.organization_id
  AND destination.evidence_id = evidence.id
  AND evidence.destination_fingerprint IS NULL;

WITH package_parcels AS (
  SELECT DISTINCT ON (
    quote.organization_id, quote.evidence_id, quote.package_key
  )
    quote.organization_id,
    quote.evidence_id,
    quote.package_key,
    rate.redacted_request #> '{shipment,parcel}' AS carrier_parcel
  FROM operations_cartonization_rate_evidence_quotes quote
  JOIN operations_carrier_rate_requests rate
    ON rate.organization_id = quote.organization_id
   AND rate.provider = quote.provider
   AND rate.purpose = quote.rate_purpose
   AND rate.id = quote.carrier_rate_request_id
  ORDER BY
    quote.organization_id, quote.evidence_id, quote.package_key,
    quote.provider
)
UPDATE operations_cartonization_rate_evidence_packages package
SET carrier_parcel_snapshot = parcel.carrier_parcel
FROM package_parcels parcel
WHERE parcel.organization_id = package.organization_id
  AND parcel.evidence_id = package.evidence_id
  AND parcel.package_key = package.package_key
  AND package.carrier_parcel_snapshot IS NULL;

UPDATE operations_cartonization_rate_evidence_quotes quote
SET
  carrier_request_hash = rate.request_hash,
  package_rate_context_hash = encode(
    digest(
      jsonb_build_object(
        'version', 'cartonization-package-rate-context-v1',
        'provider', quote.provider,
        'purpose', quote.rate_purpose,
        'destinationFingerprint', evidence.destination_fingerprint,
        'parcel', package.carrier_parcel_snapshot
      )::text,
      'sha256'
    ),
    'hex'
  )
FROM operations_carrier_rate_requests rate,
     operations_cartonization_rate_evidence evidence,
     operations_cartonization_rate_evidence_packages package
WHERE rate.organization_id = quote.organization_id
  AND rate.provider = quote.provider
  AND rate.purpose = quote.rate_purpose
  AND rate.id = quote.carrier_rate_request_id
  AND evidence.organization_id = quote.organization_id
  AND evidence.id = quote.evidence_id
  AND package.organization_id = quote.organization_id
  AND package.evidence_id = quote.evidence_id
  AND package.package_key = quote.package_key
  AND (
    quote.carrier_request_hash IS NULL
    OR quote.package_rate_context_hash IS NULL
  );

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM operations_cartonization_rate_evidence evidence
    WHERE evidence.destination_fingerprint IS NULL
  ) OR EXISTS (
    SELECT 1
    FROM operations_cartonization_rate_evidence_packages package
    WHERE package.carrier_parcel_snapshot IS NULL
  ) OR EXISTS (
    SELECT 1
    FROM operations_cartonization_rate_evidence_quotes quote
    WHERE quote.carrier_request_hash IS NULL
       OR quote.package_rate_context_hash IS NULL
  ) THEN
    RAISE EXCEPTION
      'Existing cartonization evidence cannot be upgraded without exact carrier request context';
  END IF;
END;
$$;

ALTER TABLE operations_cartonization_rate_evidence
  ALTER COLUMN destination_fingerprint SET NOT NULL,
  DROP CONSTRAINT IF EXISTS
    operations_cartonization_rate_evidence_destination_valid,
  ADD CONSTRAINT operations_cartonization_rate_evidence_destination_valid
    CHECK (destination_fingerprint ~ '^[a-f0-9]{64}$');

CREATE OR REPLACE FUNCTION operations_cartonization_carrier_parcel_valid(
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
    ) IS DISTINCT FROM ARRAY[
      'description', 'dimensionUnit', 'height', 'length',
      'weight', 'weightUnit', 'width'
    ]::text[] THEN false
    ELSE COALESCE(
      jsonb_typeof(value->'description') = 'string'
      AND length(btrim(value->>'description')) BETWEEN 1 AND 120
      AND value->>'dimensionUnit' = 'IN'
      AND value->>'weightUnit' = 'LB'
      AND jsonb_typeof(value->'length') = 'number'
      AND jsonb_typeof(value->'width') = 'number'
      AND jsonb_typeof(value->'height') = 'number'
      AND jsonb_typeof(value->'weight') = 'number'
      AND (value->>'length')::numeric > 0
      AND (value->>'width')::numeric > 0
      AND (value->>'height')::numeric > 0
      AND (value->>'weight')::numeric > 0,
      false
    )
  END
$$;

ALTER TABLE operations_cartonization_rate_evidence_packages
  ALTER COLUMN carrier_parcel_snapshot SET NOT NULL,
  DROP CONSTRAINT IF EXISTS
    operations_cartonization_rate_evidence_packages_parcel_valid,
  ADD CONSTRAINT
    operations_cartonization_rate_evidence_packages_parcel_valid
    CHECK (
      operations_cartonization_carrier_parcel_valid(
        carrier_parcel_snapshot
      )
    );

ALTER TABLE operations_cartonization_rate_evidence_quotes
  ALTER COLUMN carrier_request_hash SET NOT NULL,
  ALTER COLUMN package_rate_context_hash SET NOT NULL,
  DROP CONSTRAINT IF EXISTS
    operations_cartonization_rate_evidence_quotes_hashes_valid,
  ADD CONSTRAINT
    operations_cartonization_rate_evidence_quotes_hashes_valid
    CHECK (
      carrier_request_hash ~ '^[a-f0-9]{64}$'
      AND package_rate_context_hash ~ '^[a-f0-9]{64}$'
    );

CREATE TABLE IF NOT EXISTS
  operations_cartonization_rate_evidence_package_recipes (
    organization_id uuid NOT NULL,
    evidence_id uuid NOT NULL,
    package_key text NOT NULL,
    packaging_material_id uuid NOT NULL,
    approved_pack_recipe_id uuid NOT NULL,
    product_id uuid NOT NULL,
    input_pack_profile_version_id uuid NOT NULL,
    recipe_global_id text NOT NULL
      CHECK (recipe_global_id ~ '^gpre[0-9]{7}$'),
    recipe_name_snapshot text NOT NULL CHECK (
      length(btrim(recipe_name_snapshot)) BETWEEN 1 AND 160
      AND recipe_name_snapshot !~ '[[:cntrl:]]'
    ),
    product_global_id text NOT NULL
      CHECK (product_global_id ~ '^gp[0-9]{7}$'),
    input_profile_version_global_id text NOT NULL
      CHECK (input_profile_version_global_id ~ '^gppv[0-9]{7}$'),
    recipe_row_version bigint NOT NULL CHECK (recipe_row_version >= 0),
    input_profile_version_row_version bigint NOT NULL
      CHECK (input_profile_version_row_version >= 0),
    PRIMARY KEY (
      organization_id, evidence_id, package_key, approved_pack_recipe_id
    ),
    CONSTRAINT
      operations_cartonization_rate_evidence_package_recipes_package_fkey
      FOREIGN KEY (
        organization_id, evidence_id, package_key, packaging_material_id
      )
      REFERENCES operations_cartonization_rate_evidence_packages(
        organization_id, evidence_id, package_key, packaging_material_id
      ) ON DELETE RESTRICT,
    CONSTRAINT
      operations_cartonization_rate_evidence_package_recipes_recipe_fkey
      FOREIGN KEY (
        organization_id, packaging_material_id, approved_pack_recipe_id,
        product_id, input_pack_profile_version_id
      )
      REFERENCES operations_approved_pack_recipes(
        organization_id, packaging_material_id, id, product_id,
        input_pack_profile_version_id
      ) ON DELETE RESTRICT
  );

INSERT INTO operations_cartonization_rate_evidence_package_recipes (
  organization_id, evidence_id, package_key, packaging_material_id,
  approved_pack_recipe_id, product_id, input_pack_profile_version_id,
  recipe_global_id, recipe_name_snapshot, product_global_id,
  input_profile_version_global_id, recipe_row_version,
  input_profile_version_row_version
)
SELECT
  package.organization_id,
  package.evidence_id,
  package.package_key,
  package.packaging_material_id,
  recipe.id,
  recipe.product_id,
  recipe.input_pack_profile_version_id,
  recipe.global_id,
  recipe.recipe_name,
  product.reference_code,
  profile_version.global_id,
  package.recipe_row_version,
  profile_version.row_version
FROM operations_cartonization_rate_evidence_packages package
JOIN operations_approved_pack_recipes recipe
  ON recipe.organization_id = package.organization_id
 AND recipe.packaging_material_id = package.packaging_material_id
 AND recipe.id = package.approved_pack_recipe_id
JOIN crm_products product
  ON product.id = recipe.product_id
 AND product.pipeline_id = recipe.pipeline_id
JOIN operations_product_pack_profile_versions profile_version
  ON profile_version.organization_id = recipe.organization_id
 AND profile_version.pipeline_id = recipe.pipeline_id
 AND profile_version.product_id = recipe.product_id
 AND profile_version.id = recipe.input_pack_profile_version_id
WHERE package.planning_method = 'approved_recipe'
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS
  operations_cartonization_rate_evidence_commands (
    organization_id uuid NOT NULL
      REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
    idempotency_key text NOT NULL CHECK (
      length(btrim(idempotency_key)) BETWEEN 8 AND 160
      AND idempotency_key !~ '[[:cntrl:]]'
    ),
    semantic_request_hash text NOT NULL
      CHECK (semantic_request_hash ~ '^[a-f0-9]{64}$'),
    state text NOT NULL DEFAULT 'pending'
      CHECK (state IN ('pending', 'completed', 'failed')),
    evidence_id uuid,
    error_code text,
    actor_email text REFERENCES app_users(email) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    PRIMARY KEY (organization_id, idempotency_key),
    CONSTRAINT
      operations_cartonization_rate_evidence_commands_evidence_fkey
      FOREIGN KEY (organization_id, evidence_id)
      REFERENCES operations_cartonization_rate_evidence(
        organization_id, id
      ) ON DELETE RESTRICT,
    CONSTRAINT
      operations_cartonization_rate_evidence_commands_state_valid
      CHECK (
        (
          state = 'pending'
          AND evidence_id IS NULL
          AND error_code IS NULL
          AND completed_at IS NULL
        )
        OR (
          state = 'completed'
          AND evidence_id IS NOT NULL
          AND error_code IS NULL
          AND completed_at IS NOT NULL
        )
        OR (
          state = 'failed'
          AND evidence_id IS NULL
          AND error_code IS NOT NULL
          AND length(btrim(error_code)) BETWEEN 3 AND 128
          AND completed_at IS NOT NULL
        )
      )
  );

INSERT INTO operations_cartonization_rate_evidence_commands (
  organization_id, idempotency_key, semantic_request_hash, state,
  evidence_id, actor_email, created_at, completed_at
)
SELECT
  evidence.organization_id,
  evidence.idempotency_key,
  evidence.request_hash,
  'completed',
  evidence.id,
  evidence.actor_email,
  evidence.created_at,
  COALESCE(evidence.sealed_at, evidence.created_at)
FROM operations_cartonization_rate_evidence evidence
WHERE evidence.sealed_at IS NOT NULL
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION
  protect_operations_cartonization_rate_evidence_command()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'Cartonization rate evidence command reservations are immutable';
  END IF;
  IF OLD.state = 'pending'
     AND NEW.state IN ('completed', 'failed')
     AND NEW.organization_id = OLD.organization_id
     AND NEW.idempotency_key = OLD.idempotency_key
     AND NEW.semantic_request_hash = OLD.semantic_request_hash
     AND NEW.actor_email IS NOT DISTINCT FROM OLD.actor_email
     AND NEW.created_at = OLD.created_at
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION
    'Cartonization rate evidence command permits only one terminal transition';
END;
$$;

DROP TRIGGER IF EXISTS
  protect_operations_cartonization_rate_evidence_command_mutation
  ON operations_cartonization_rate_evidence_commands;
CREATE TRIGGER
  protect_operations_cartonization_rate_evidence_command_mutation
BEFORE UPDATE OR DELETE
ON operations_cartonization_rate_evidence_commands
FOR EACH ROW EXECUTE FUNCTION
  protect_operations_cartonization_rate_evidence_command();

DROP TRIGGER IF EXISTS
  validate_operations_cartonization_rate_evidence_package_recipe_insert
  ON operations_cartonization_rate_evidence_package_recipes;
CREATE TRIGGER
  validate_operations_cartonization_rate_evidence_package_recipe_insert
BEFORE INSERT
ON operations_cartonization_rate_evidence_package_recipes
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_cartonization_rate_evidence_child_insert();

DROP TRIGGER IF EXISTS
  protect_operations_cartonization_rate_evidence_package_recipes_mutation
  ON operations_cartonization_rate_evidence_package_recipes;
CREATE TRIGGER
  protect_operations_cartonization_rate_evidence_package_recipes_mutation
BEFORE UPDATE OR DELETE
ON operations_cartonization_rate_evidence_package_recipes
FOR EACH ROW EXECUTE FUNCTION protect_operations_append_only();

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
    FROM operations_cartonization_rate_evidence_packages package
    LEFT JOIN
      operations_cartonization_rate_evidence_package_recipes recipe_edge
      ON recipe_edge.organization_id = package.organization_id
     AND recipe_edge.evidence_id = package.evidence_id
     AND recipe_edge.package_key = package.package_key
    WHERE package.organization_id = NEW.organization_id
      AND package.evidence_id = NEW.id
    GROUP BY
      package.package_key, package.planning_method,
      package.approved_pack_recipe_id
    HAVING (
      package.planning_method = 'approved_recipe'
      AND (
        count(recipe_edge.approved_pack_recipe_id) < 1
        OR count(recipe_edge.approved_pack_recipe_id) FILTER (
          WHERE recipe_edge.approved_pack_recipe_id
            = package.approved_pack_recipe_id
        ) <> 1
      )
    ) OR (
      package.planning_method = 'or_tools'
      AND count(recipe_edge.approved_pack_recipe_id) <> 0
    )
  ) THEN
    RAISE EXCEPTION
      'Cartonization package recipe evidence is incomplete';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM operations_cartonization_rate_evidence_quotes quote
    JOIN operations_carrier_rate_requests rate
      ON rate.organization_id = quote.organization_id
     AND rate.provider = quote.provider
     AND rate.purpose = quote.rate_purpose
     AND rate.id = quote.carrier_rate_request_id
    JOIN operations_cartonization_rate_evidence evidence
      ON evidence.organization_id = quote.organization_id
     AND evidence.id = quote.evidence_id
    JOIN operations_cartonization_rate_evidence_packages package
      ON package.organization_id = quote.organization_id
     AND package.evidence_id = quote.evidence_id
     AND package.package_key = quote.package_key
    WHERE quote.organization_id = NEW.organization_id
      AND quote.evidence_id = NEW.id
      AND (
        quote.quote_status IS DISTINCT FROM rate.status
        OR quote.error_code IS DISTINCT FROM rate.error_code
        OR quote.carrier_request_hash IS DISTINCT FROM rate.request_hash
        OR rate.redacted_request #>>
          '{shipment,destinationFingerprint}'
          IS DISTINCT FROM evidence.destination_fingerprint
        OR rate.redacted_request #> '{shipment,parcel}'
          IS DISTINCT FROM package.carrier_parcel_snapshot
      )
  ) THEN
    RAISE EXCEPTION
      'Cartonization quote must match its exact carrier request context';
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

COMMENT ON TABLE
  operations_cartonization_rate_evidence_package_recipes IS
  'Immutable package-to-recipe edges retaining every approved recipe and input profile used by a cartonization proof.';
COMMENT ON COLUMN
  operations_cartonization_rate_evidence_packages.carrier_parcel_snapshot IS
  'Exact normalized parcel submitted to both carrier sandbox rating reads.';
COMMENT ON COLUMN
  operations_cartonization_rate_evidence.destination_fingerprint IS
  'SHA-256 fingerprint of the exact confirmed destination submitted for rating.';
COMMENT ON TABLE
  operations_cartonization_rate_evidence_commands IS
  'Durable semantic idempotency reservation claimed before carrier reads so retries never create duplicate rate-request evidence.';
