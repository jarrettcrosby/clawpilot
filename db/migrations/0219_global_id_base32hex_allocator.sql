-- Deployment B switches new Global ID allocation to a compact, lowercase
-- base32hex suffix. Existing numeric7 identifiers and all dual-format read
-- boundaries remain valid. The immutable suffix registry remains the global
-- authority across every prefix.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '25s';

-- PostgreSQL 18 resolves nested SQL-function calls used by expression indexes
-- under the function's configured search path. Deployment A intentionally did
-- not pin that path because it only expanded read compatibility. Pin and
-- schema-qualify the two dependent helpers before the v2 uniqueness index is
-- built so the migration behaves identically for hardened roles and across
-- supported PostgreSQL versions.
CREATE OR REPLACE FUNCTION public.global_reference_code_is_valid(
  value text,
  expected_prefix text
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
STRICT
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
  SELECT public.global_reference_prefix_is_valid(expected_prefix)
    AND value ~ (
      '^' || expected_prefix || '([0-9]{7}|[0-9a-v]{12})$'
    )
$$;

CREATE OR REPLACE FUNCTION public.global_reference_suffix(
  value text,
  expected_prefix text
)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
STRICT
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
  SELECT CASE
    WHEN public.global_reference_code_is_valid(value, expected_prefix)
      THEN substring(value FROM char_length(expected_prefix) + 1)
    ELSE NULL
  END
$$;

DO $$
DECLARE
  allocator_definition text;
  suffix_constraint_definition text;
BEGIN
  IF to_regprocedure('gen_random_bytes(integer)') IS NULL THEN
    RAISE EXCEPTION 'Deployment B requires pgcrypto gen_random_bytes(integer)';
  END IF;

  IF NOT public.global_reference_code_is_valid('ga1234567', 'ga')
    OR NOT public.global_reference_code_is_valid('ga0123456789av', 'ga')
  THEN
    RAISE EXCEPTION 'Deployment B requires dual-format Global ID compatibility';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_constraint constraint_row
    WHERE constraint_row.contype = 'c'
      AND position('^g' IN pg_get_constraintdef(constraint_row.oid, true)) > 0
      AND position('[0-9]{7}' IN pg_get_constraintdef(constraint_row.oid, true)) > 0
      AND position('[0-9a-v]{12}' IN pg_get_constraintdef(constraint_row.oid, true)) = 0
  ) THEN
    RAISE EXCEPTION 'Deployment B found a numeric-only Global ID CHECK';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_constraint constraint_row
    WHERE constraint_row.contype = 'c'
      AND NOT constraint_row.convalidated
      AND position('[0-9a-v]{12}' IN pg_get_constraintdef(constraint_row.oid, true)) > 0
  ) THEN
    RAISE EXCEPTION 'Deployment B found an unvalidated Global ID CHECK';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger trigger_row
    WHERE trigger_row.tgrelid = 'crm_reference_registry'::regclass
      AND trigger_row.tgname = 'enforce_crm_reference_number_exclusive_insert'
      AND trigger_row.tgenabled <> 'D'
      AND NOT trigger_row.tgisinternal
  ) THEN
    RAISE EXCEPTION 'Deployment B requires the Global ID exclusivity trigger';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.crm_reference_registry registry
    WHERE char_length(
      public.global_reference_suffix(registry.reference_code, registry.prefix)
    ) = 12
    GROUP BY public.global_reference_suffix(
      registry.reference_code,
      registry.prefix
    )
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Deployment B found duplicate base32hex Global ID suffixes';
  END IF;

  SELECT pg_get_constraintdef(constraint_row.oid, true)
  INTO suffix_constraint_definition
  FROM pg_constraint constraint_row
  WHERE constraint_row.conrelid = 'crm_reference_number_registry'::regclass
    AND constraint_row.conname = 'crm_reference_number_registry_valid';

  IF suffix_constraint_definition IS NULL
    OR position(
      'global_reference_suffix_is_valid(number_value)'
      IN suffix_constraint_definition
    ) = 0
  THEN
    RAISE EXCEPTION 'Deployment B requires the dual-format suffix registry';
  END IF;

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
    OR position('gen_random_bytes' IN allocator_definition) > 0
  THEN
    RAISE EXCEPTION 'Deployment B requires the deployed legacy allocator';
  END IF;
END;
$$;

-- Preserve grandfathered numeric7 duplicates while making every v2 suffix
-- database-unique across prefixes, including direct/manual concurrent writes.
CREATE UNIQUE INDEX crm_reference_registry_base32hex_suffix_unique_idx
  ON public.crm_reference_registry (
    (public.global_reference_suffix(reference_code, prefix))
  )
  WHERE char_length(
    public.global_reference_suffix(reference_code, prefix)
  ) = 12;

CREATE OR REPLACE FUNCTION allocate_global_reference(requested_prefix text)
RETURNS text
LANGUAGE plpgsql
VOLATILE
PARALLEL UNSAFE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  candidate_suffix text;
  candidate text;
  reserved_suffix text;
  resolved_entity_type text;
  random_material bytea;
  base32hex_alphabet CONSTANT text := '0123456789abcdefghijklmnopqrstuv';
BEGIN
  SELECT entity_type INTO resolved_entity_type
  FROM public.global_reference_entity_types
  WHERE prefix = requested_prefix;

  IF resolved_entity_type IS NULL THEN
    RAISE EXCEPTION 'Unsupported Global ID prefix: %', requested_prefix;
  END IF;

  -- Each byte is uniform over 0..255, so modulo 32 introduces no bias. Twelve
  -- symbols provide 60 random bits. The suffix reservation and reference row
  -- are inserted in the caller's transaction; an exception rolls both writes
  -- back together. A successful caller can intentionally retain a reservation
  -- even when it does not create a downstream domain row.
  FOR attempt IN 1..32 LOOP
    random_material := public.gen_random_bytes(12);
    candidate_suffix := '';

    FOR symbol_index IN 0..11 LOOP
      candidate_suffix := candidate_suffix || substr(
        base32hex_alphabet,
        (get_byte(random_material, symbol_index) % 32) + 1,
        1
      );
    END LOOP;

    candidate := requested_prefix || candidate_suffix;
    reserved_suffix := NULL;

    INSERT INTO public.crm_reference_number_registry (number_value, allocated_at)
    VALUES (candidate_suffix, now())
    ON CONFLICT (number_value) DO NOTHING
    RETURNING number_value INTO reserved_suffix;

    IF reserved_suffix IS NULL THEN
      CONTINUE;
    END IF;

    INSERT INTO public.crm_reference_registry (
      reference_code, prefix, canonical_code, status, allocated_at, entity_type
    ) VALUES (
      candidate, requested_prefix, candidate, 'active', now(), resolved_entity_type
    );

    RETURN candidate;
  END LOOP;

  RAISE EXCEPTION 'Unable to allocate a unique Global ID for prefix %', requested_prefix;
END;
$$;

DO $$
DECLARE
  allocator_definition text;
  allocator_index_definition text;
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
    OR position('gen_random_bytes(12)' IN allocator_definition) = 0
    OR position('0123456789abcdefghijklmnopqrstuv' IN allocator_definition) = 0
    OR position('FOR attempt IN 1..32 LOOP' IN allocator_definition) = 0
    OR position('ON CONFLICT (number_value) DO NOTHING' IN allocator_definition) = 0
    OR position('1000000 + floor(random() * 9000000)' IN allocator_definition) > 0
  THEN
    RAISE EXCEPTION 'Deployment B allocator contract is incomplete';
  END IF;

  SELECT pg_get_indexdef(index_row.indexrelid)
  INTO allocator_index_definition
  FROM pg_index index_row
  WHERE index_row.indexrelid =
    'crm_reference_registry_base32hex_suffix_unique_idx'::regclass
    AND index_row.indisunique;

  IF allocator_index_definition IS NULL
    OR position('global_reference_suffix' IN allocator_index_definition) = 0
    OR position('= 12' IN allocator_index_definition) = 0
  THEN
    RAISE EXCEPTION 'Deployment B base32hex suffix uniqueness index is missing';
  END IF;
END;
$$;
