-- Preserve provider-owned product taxonomy beside the canonical ClawPilot
-- category. Shopify Standard Product Taxonomy and Faire Product Type are
-- separate schemes and must never be collapsed into a shared free-text field.

ALTER TABLE operations_commerce_product_candidates
  ADD COLUMN IF NOT EXISTS provider_taxonomy_scheme text,
  ADD COLUMN IF NOT EXISTS provider_category_id text,
  ADD COLUMN IF NOT EXISTS provider_category_name text,
  ADD COLUMN IF NOT EXISTS provider_category_full_name text,
  ADD COLUMN IF NOT EXISTS provider_category_paths jsonb
    NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE operations_product_channel_states
  ADD COLUMN IF NOT EXISTS provider_taxonomy_scheme text,
  ADD COLUMN IF NOT EXISTS provider_category_id text,
  ADD COLUMN IF NOT EXISTS provider_category_name text,
  ADD COLUMN IF NOT EXISTS provider_category_full_name text,
  ADD COLUMN IF NOT EXISTS provider_category_paths jsonb
    NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE operations_commerce_product_candidates
  DROP CONSTRAINT IF EXISTS
    operations_commerce_product_candidates_provider_taxonomy_valid,
  ADD CONSTRAINT
    operations_commerce_product_candidates_provider_taxonomy_valid CHECK (
      jsonb_typeof(provider_category_paths) = 'array'
      AND jsonb_array_length(provider_category_paths) <= 25
      AND NOT jsonb_path_exists(
        provider_category_paths,
        '$[*] ? (@.type() != "string")'
      )
      AND octet_length(
        convert_to(provider_category_paths::text, 'UTF8')
      ) <= 16384
      AND (
        (
          provider_taxonomy_scheme IS NULL
          AND provider_category_id IS NULL
          AND provider_category_name IS NULL
          AND provider_category_full_name IS NULL
          AND provider_category_paths = '[]'::jsonb
        )
        OR (
          provider_taxonomy_scheme IS NOT NULL
          AND provider_taxonomy_scheme = CASE provider
            WHEN 'shopify' THEN 'shopify_standard_product_taxonomy'
            WHEN 'faire' THEN 'faire_product_type'
          END
          AND (
            provider_category_id IS NOT NULL
            OR provider_category_name IS NOT NULL
          )
          AND (
            provider_category_id IS NULL
            OR (
              length(btrim(provider_category_id)) BETWEEN 1 AND 512
              AND provider_category_id !~ '[[:cntrl:]]'
            )
          )
          AND (
            provider_category_name IS NULL
            OR (
              length(btrim(provider_category_name)) BETWEEN 1 AND 512
              AND provider_category_name !~ '[[:cntrl:]]'
            )
          )
          AND (
            provider_category_full_name IS NULL
            OR (
              length(btrim(provider_category_full_name))
                BETWEEN 1 AND 2000
              AND provider_category_full_name !~ '[[:cntrl:]]'
            )
          )
        )
      )
    );

ALTER TABLE operations_product_channel_states
  DROP CONSTRAINT IF EXISTS
    operations_product_channel_states_provider_taxonomy_valid,
  ADD CONSTRAINT
    operations_product_channel_states_provider_taxonomy_valid CHECK (
      jsonb_typeof(provider_category_paths) = 'array'
      AND jsonb_array_length(provider_category_paths) <= 25
      AND NOT jsonb_path_exists(
        provider_category_paths,
        '$[*] ? (@.type() != "string")'
      )
      AND octet_length(
        convert_to(provider_category_paths::text, 'UTF8')
      ) <= 16384
      AND (
        (
          provider_taxonomy_scheme IS NULL
          AND provider_category_id IS NULL
          AND provider_category_name IS NULL
          AND provider_category_full_name IS NULL
          AND provider_category_paths = '[]'::jsonb
        )
        OR (
          provider_taxonomy_scheme IS NOT NULL
          AND provider_taxonomy_scheme = CASE provider
            WHEN 'shopify' THEN 'shopify_standard_product_taxonomy'
            WHEN 'faire' THEN 'faire_product_type'
          END
          AND (
            provider_category_id IS NOT NULL
            OR provider_category_name IS NOT NULL
          )
          AND (
            provider_category_id IS NULL
            OR (
              length(btrim(provider_category_id)) BETWEEN 1 AND 512
              AND provider_category_id !~ '[[:cntrl:]]'
            )
          )
          AND (
            provider_category_name IS NULL
            OR (
              length(btrim(provider_category_name)) BETWEEN 1 AND 512
              AND provider_category_name !~ '[[:cntrl:]]'
            )
          )
          AND (
            provider_category_full_name IS NULL
            OR (
              length(btrim(provider_category_full_name))
                BETWEEN 1 AND 2000
              AND provider_category_full_name !~ '[[:cntrl:]]'
            )
          )
        )
      )
    );

CREATE OR REPLACE FUNCTION
  protect_operations_commerce_product_candidate_taxonomy()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    NEW.provider_taxonomy_scheme,
    NEW.provider_category_id,
    NEW.provider_category_name,
    NEW.provider_category_full_name,
    NEW.provider_category_paths
  ) IS DISTINCT FROM ROW(
    OLD.provider_taxonomy_scheme,
    OLD.provider_category_id,
    OLD.provider_category_name,
    OLD.provider_category_full_name,
    OLD.provider_category_paths
  ) THEN
    RAISE EXCEPTION
      'Commerce product candidate provider taxonomy is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  protect_operations_commerce_product_candidate_taxonomy
  ON operations_commerce_product_candidates;
CREATE TRIGGER protect_operations_commerce_product_candidate_taxonomy
BEFORE UPDATE ON operations_commerce_product_candidates
FOR EACH ROW EXECUTE FUNCTION
  protect_operations_commerce_product_candidate_taxonomy();

CREATE INDEX IF NOT EXISTS
  idx_operations_product_channel_states_taxonomy
  ON operations_product_channel_states (
    organization_id,
    integration_account_id,
    provider_taxonomy_scheme,
    provider_category_id
  )
  WHERE provider_taxonomy_scheme IS NOT NULL;

COMMENT ON COLUMN
  operations_product_channel_states.provider_category_id IS
  'Stable provider taxonomy identity for this exact listing; not a ClawPilot category or a cross-provider identity.';

COMMENT ON COLUMN
  operations_product_channel_states.provider_category_full_name IS
  'Provider-owned display path observed during catalog intake.';

COMMENT ON COLUMN
  operations_commerce_product_candidates.provider_taxonomy_scheme IS
  'Provider taxonomy scheme captured at intake so first-create policy can initialize, but never silently overwrite, the internal category.';
