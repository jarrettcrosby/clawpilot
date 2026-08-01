-- Deployment A expands every Global ID boundary to accept the existing
-- seven-digit suffix and the future twelve-character lowercase base32hex
-- suffix. Allocation intentionally remains on the seven-digit format.
-- Live development validation expressions measured below 100 ms; these
-- transaction-local limits fail cleanly on lock contention and bound drift.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '25s';

CREATE OR REPLACE FUNCTION global_reference_prefix_is_valid(value text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
STRICT
AS $$
  SELECT value ~ '^g[a-z]{1,4}$'
$$;

CREATE OR REPLACE FUNCTION global_reference_suffix_is_valid(value text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
STRICT
AS $$
  SELECT value ~ '^([0-9]{7}|[0-9a-v]{12})$'
$$;

CREATE OR REPLACE FUNCTION global_reference_code_is_valid(
  value text,
  expected_prefix text
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
STRICT
AS $$
  SELECT global_reference_prefix_is_valid(expected_prefix)
    AND value ~ (
      '^' || expected_prefix || '([0-9]{7}|[0-9a-v]{12})$'
    )
$$;

CREATE OR REPLACE FUNCTION global_reference_suffix(
  value text,
  expected_prefix text
)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
STRICT
AS $$
  SELECT CASE
    WHEN global_reference_code_is_valid(value, expected_prefix)
      THEN substring(value FROM char_length(expected_prefix) + 1)
    ELSE NULL
  END
$$;

DO $$
BEGIN
  IF NOT global_reference_code_is_valid('ga1234567', 'ga')
    OR NOT global_reference_code_is_valid('ga0123456789av', 'ga')
    OR global_reference_code_is_valid('gc1234567', 'ga')
    OR global_reference_code_is_valid('ga0123456789aw', 'ga')
    OR global_reference_code_is_valid('ga0123456789AV', 'ga')
    OR global_reference_code_is_valid('ga12345678', 'ga')
  THEN
    RAISE EXCEPTION 'Global ID compatibility helper contract failed';
  END IF;
END;
$$;

ALTER TABLE crm_reference_number_registry
  DROP CONSTRAINT crm_reference_number_registry_valid,
  ADD CONSTRAINT crm_reference_number_registry_valid
    CHECK (global_reference_suffix_is_valid(number_value));

COMMENT ON TABLE crm_reference_number_registry IS
  'Immutable reservation registry for legacy numeric7 and future lowercase base32hex12 Global ID suffixes.';
COMMENT ON COLUMN crm_reference_number_registry.number_value IS
  'Reserved Global ID suffix. The historical column name remains for compatibility.';

ALTER TABLE crm_reference_registry
  DROP CONSTRAINT crm_reference_registry_prefix_valid,
  ADD CONSTRAINT crm_reference_registry_prefix_valid CHECK (
    global_reference_code_is_valid(reference_code, prefix)
    AND global_reference_suffix(reference_code, prefix) =
      substring(reference_code FROM char_length(prefix) + 1)
  );

CREATE INDEX IF NOT EXISTS crm_reference_registry_suffix_lookup_idx
  ON crm_reference_registry (
    (substring(reference_code FROM char_length(prefix) + 1))
  );

CREATE OR REPLACE FUNCTION enforce_crm_reference_number_exclusive()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  requested_suffix text;
BEGIN
  requested_suffix := global_reference_suffix(NEW.reference_code, NEW.prefix);
  IF requested_suffix IS NULL THEN
    RAISE EXCEPTION 'Global reference does not match its registered prefix'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM crm_reference_number_registry
    WHERE number_value = requested_suffix
  ) THEN
    RAISE EXCEPTION 'Global reference suffix was not reserved'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM crm_reference_registry existing
    WHERE substring(
      existing.reference_code FROM char_length(existing.prefix) + 1
    ) = requested_suffix
      AND existing.reference_code <> NEW.reference_code
  ) THEN
    RAISE EXCEPTION 'Global reference suffix is already allocated'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DO $$
DECLARE
  manifest record;
  procedure_definition text;
  procedure_count integer := 0;
BEGIN
  FOR manifest IN
    SELECT *
    FROM (VALUES
      ('operations_cartonization_allocations_valid', 'value jsonb'),
      ('operations_commerce_active_cohort_json_valid', 'requested_cohort jsonb'),
      ('operations_shopify_preview_lines_valid', 'value jsonb'),
      ('preserve_quarantined_pipeline_short_link_disable', '')
    ) AS expected(function_name, identity_arguments)
  LOOP
    SELECT pg_get_functiondef(procedure.oid)
    INTO procedure_definition
    FROM pg_proc procedure
    JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname = current_schema()
      AND procedure.prokind = 'f'
      AND procedure.proname = manifest.function_name
      AND pg_get_function_identity_arguments(procedure.oid) =
        manifest.identity_arguments;

    IF procedure_definition IS NULL THEN
      RAISE EXCEPTION 'Global ID function manifest entry is missing: %(%)',
        manifest.function_name,
        manifest.identity_arguments;
    END IF;
    IF position('[0-9a-v]{12}' IN procedure_definition) > 0 THEN
      RAISE EXCEPTION 'Global ID function was unexpectedly expanded before 0202: %(%)',
        manifest.function_name,
        manifest.identity_arguments;
    END IF;
    IF position('[0-9]{7}' IN procedure_definition) = 0 THEN
      RAISE EXCEPTION 'Global ID function has no legacy suffix rule: %(%)',
        manifest.function_name,
        manifest.identity_arguments;
    END IF;

    EXECUTE replace(
      procedure_definition,
      '[0-9]{7}',
      '([0-9]{7}|[0-9a-v]{12})'
    );
    procedure_count := procedure_count + 1;
  END LOOP;

  IF procedure_count <> 4 THEN
    RAISE EXCEPTION 'Expected four generated Global ID function updates, found %',
      procedure_count;
  END IF;
END;
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM short_links link
    LEFT JOIN crm_reference_registry registry
      ON registry.reference_code = CASE
        WHEN lower(link.slug) ~
          '^g[aciklmop]([0-9]{7}|[0-9a-v]{12})$'
          THEN lower(link.slug)
        WHEN lower(link.slug) ~
          '^mail-g[aciklmop]([0-9]{7}|[0-9a-v]{12})$'
          THEN substring(lower(link.slug) FROM 6)
        ELSE NULL
      END
    WHERE (
      lower(link.slug) ~ '^g[aciklmop]([0-9]{7}|[0-9a-v]{12})$'
      OR lower(link.slug) ~
        '^mail-g[aciklmop]([0-9]{7}|[0-9a-v]{12})$'
    )
      AND (
        link.source_app <> 'clawpilot-crm'
        OR registry.reference_code IS NULL
      )
  ) THEN
    RAISE EXCEPTION 'Reserved CRM short-link slugs contain an invalid preclaim';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_global_reference_short_link_reservation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  reserved_reference text;
BEGIN
  reserved_reference := CASE
    WHEN lower(NEW.slug) ~
      '^g[aciklmop]([0-9]{7}|[0-9a-v]{12})$'
      THEN lower(NEW.slug)
    WHEN lower(NEW.slug) ~
      '^mail-g[aciklmop]([0-9]{7}|[0-9a-v]{12})$'
      THEN substring(lower(NEW.slug) FROM 6)
    ELSE NULL
  END;

  IF reserved_reference IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.source_app <> 'clawpilot-crm' THEN
    RAISE EXCEPTION 'Global reference short-link slugs are reserved for CRM'
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM crm_reference_registry registry
    WHERE registry.reference_code = reserved_reference
  ) THEN
    RAISE EXCEPTION 'Global reference short-link slug is not registered'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_global_reference_short_link_reservation
  ON short_links;
CREATE TRIGGER trg_enforce_global_reference_short_link_reservation
BEFORE INSERT OR UPDATE OF source_app, slug ON short_links
FOR EACH ROW EXECUTE FUNCTION enforce_global_reference_short_link_reservation();

-- Deployment A must not change the active allocator format.
DO $$
DECLARE
  allocator_definition text;
BEGIN
  SELECT pg_get_functiondef(procedure.oid)
  INTO allocator_definition
  FROM pg_proc procedure
  JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
  WHERE namespace.nspname = current_schema()
    AND procedure.proname = 'allocate_global_reference'
    AND pg_get_function_identity_arguments(procedure.oid) =
      'requested_prefix text';

  IF allocator_definition IS NULL
    OR position('1000000 + floor(random() * 9000000)' IN allocator_definition) = 0
  THEN
    RAISE EXCEPTION 'Deployment A requires the legacy numeric allocator';
  END IF;
END;
$$;
