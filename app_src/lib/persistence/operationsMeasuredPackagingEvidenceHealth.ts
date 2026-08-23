// Exact runtime attestation for migration 0309. The migration checksum pins
// the intended transition while the catalog digests detect constraint or
// function drift after the ledger row was written.
export const OPERATIONS_MEASURED_PACKAGING_EVIDENCE_HEALTH_SQL = String.raw`
  EXISTS (
    SELECT 1
    FROM public.schema_migrations
    WHERE filename = '0309_operations_measured_packaging_evidence.sql'
      AND checksum =
        '52b83a83329d8f4f60e2f0ff539d54849e5e4c69c88ad80917970f880b754da2'
  )
  AND (
    SELECT pg_catalog.count(installed.oid) = 2
      AND pg_catalog.encode(public.digest(
        pg_catalog.convert_to(pg_catalog.string_agg(
          pg_catalog.concat_ws('|',
            installed_namespace.nspname,
            table_row.relname,
            installed.conname,
            installed.contype::text,
            installed.convalidated::text,
            installed.connoinherit::text,
            pg_catalog.pg_get_constraintdef(installed.oid, true)
          ), E'\n' ORDER BY required.constraint_name
        ), 'UTF8'),
        'sha256'
      ), 'hex') =
        '06e3e7e26b652015f36b9dac1287aa0fe9c20254745d42cb6f149561f6d5f94d'
    FROM (VALUES
      ('operations_packaging_materials_dimension_evidence_valid'),
      ('operations_packaging_materials_rated_outer_evidence_valid')
    ) required(constraint_name)
    LEFT JOIN pg_catalog.pg_constraint installed
      ON installed.conrelid = pg_catalog.to_regclass(
        'public.operations_packaging_materials'
      )
     AND installed.conname = required.constraint_name
    LEFT JOIN pg_catalog.pg_class table_row
      ON table_row.oid = installed.conrelid
    LEFT JOIN pg_catalog.pg_namespace installed_namespace
      ON installed_namespace.oid = installed.connamespace
  )
  AND (
    SELECT pg_catalog.count(installed.oid) = 3
      AND pg_catalog.encode(public.digest(
        pg_catalog.convert_to(pg_catalog.string_agg(
          pg_catalog.concat_ws('|',
            installed_namespace.nspname,
            installed.proname || '(' ||
              pg_catalog.pg_get_function_identity_arguments(installed.oid) ||
              ')',
            language.lanname,
            installed.provolatile::text,
            installed.prosecdef::text,
            installed.proisstrict::text,
            installed.proparallel::text,
            COALESCE(pg_catalog.array_to_string(installed.proconfig, ','), ''),
            pg_catalog.btrim(pg_catalog.regexp_replace(
              installed.prosrc,
              '[[:space:]]+', ' ', 'g'
            ))
          ), E'\n' ORDER BY required.signature
        ), 'UTF8'),
        'sha256'
      ), 'hex') =
        'a238395b77ca22ad3defca336d2340eafdb36e75e382462809a09f54140e4aab'
    FROM (VALUES
      (
        'operations_shopify_carrier_service_config_environment_is_ready(uuid,uuid,text)'
      ),
      (
        'operations_shopify_carrier_service_rating_environment_is_ready(uuid,uuid,text)'
      ),
      ('validate_operations_approved_pack_recipe()')
    ) required(signature)
    LEFT JOIN pg_catalog.pg_proc installed
      ON installed.oid = pg_catalog.to_regprocedure(
        'public.' || required.signature
      )
    LEFT JOIN pg_catalog.pg_namespace installed_namespace
      ON installed_namespace.oid = installed.pronamespace
    LEFT JOIN pg_catalog.pg_language language
      ON language.oid = installed.prolang
  )
`
