-- Contract the temporary rolling-deployment compatibility added by 0298 and 0299.
-- Every serving runtime now writes provider_read_authority and rate_source explicitly.
SET LOCAL lock_timeout = '30s';
SET LOCAL search_path = pg_catalog, public, pg_temp;

DO $contract$
DECLARE
  authority_column_catalog_hash text;
  authority_constraint_catalog_hash text;
  authority_operator_binding_count integer;
  authority_operator_binding_hash text;
  bridge_function_hash text;
  bridge_trigger_hash text;
  config_validator_hash text;
  config_trigger_hash text;
BEGIN
  IF NOT EXISTS (
       SELECT 1
       FROM public.schema_migrations
       WHERE filename =
         '0298_operations_commerce_store_sync_controls.sql'
         AND checksum =
           'e3eb479cc613479a09081bb6f22d2344ce74540f86595a020dfdbd711cfb1abd'
     )
     OR NOT EXISTS (
       SELECT 1
       FROM public.schema_migrations
       WHERE filename =
         '0299_operations_shopify_checkout_rate_control.sql'
         AND checksum =
           'ad82ca01e9e19cb20c95bfec25588d50ad706419ee3a58db24e0662de85e3618'
     )
  THEN
    RAISE EXCEPTION
      'Commerce rollout contract requires exact 0298 and 0299 predecessors';
  END IF;

  SELECT encode(
           digest(
             convert_to(
               string_agg(
                 concat_ws(
                   '|', table_name, column_name, ordinal_position::text,
                   data_type, udt_schema, udt_name, is_nullable,
                   COALESCE(
                     CASE
                       WHEN table_name =
                              'operations_commerce_store_sync_change_receipts'
                        AND column_name = 'id'
                        AND column_default = 'gen_random_uuid()'
                        AND EXISTS (
                          SELECT 1
                          FROM pg_catalog.pg_attrdef installed_default
                          JOIN pg_catalog.pg_depend default_dependency
                            ON default_dependency.classid =
                                 'pg_catalog.pg_attrdef'::regclass
                           AND default_dependency.objid = installed_default.oid
                           AND default_dependency.refclassid =
                                 'pg_catalog.pg_proc'::regclass
                           AND default_dependency.refobjid =
                                 pg_catalog.to_regprocedure(
                                   'public.gen_random_uuid()'
                                 )
                           AND default_dependency.deptype = 'n'
                          WHERE installed_default.adrelid =
                                  pg_catalog.to_regclass(
                                    'public.' || table_name
                                  )
                            AND installed_default.adnum = ordinal_position
                        )
                       THEN 'public.gen_random_uuid()'
                       ELSE column_default
                     END,
                     '<null>'
                   ), is_identity,
                   COALESCE(identity_generation, '<null>'), is_generated,
                   COALESCE(generation_expression, '<null>'),
                   COALESCE(collation_schema, '<null>'),
                   COALESCE(collation_name, '<null>'),
                   COALESCE(character_maximum_length::text, '<null>'),
                   COALESCE(numeric_precision::text, '<null>'),
                   COALESCE(numeric_scale::text, '<null>'),
                   COALESCE(datetime_precision::text, '<null>')
                 ),
                 chr(10) ORDER BY table_name, column_name
               ),
               'UTF8'
             ),
             'sha256'
           ),
           'hex'
         )
    INTO authority_column_catalog_hash
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND (
      table_name IN (
        'operations_commerce_store_sync_controls',
        'operations_commerce_store_sync_change_receipts',
        'operations_commerce_store_sync_read_leases'
      )
      OR (
        table_name IN (
          'operations_commerce_intake_read_intents',
          'operations_commerce_product_image_observation_sets',
          'operations_commerce_product_image_import_jobs'
        )
        AND column_name = 'provider_read_authority'
      )
    );

  IF authority_column_catalog_hash IS DISTINCT FROM
       'd8a27f153b77f54154bc82a5f28dbcb97c064d915500bdb6fcbff643b1608a66'
  THEN
    RAISE EXCEPTION
      'Commerce rollout contract requires the exact expanded column catalog';
  END IF;

  SELECT encode(
           digest(
             convert_to(
               string_agg(
                 concat_ws(
                   '|', installed_table.relname,
                   installed_constraint.conname,
                   installed_constraint.contype::text,
                   installed_constraint.convalidated::text,
                   installed_constraint.confdeltype::text,
                   installed_constraint.confupdtype::text,
                   pg_get_constraintdef(installed_constraint.oid)
                 ),
                 chr(10) ORDER BY
                   installed_table.relname, installed_constraint.conname
               ),
               'UTF8'
             ),
             'sha256'
           ),
           'hex'
         )
    INTO authority_constraint_catalog_hash
  FROM pg_catalog.pg_constraint installed_constraint
  JOIN pg_catalog.pg_class installed_table
    ON installed_table.oid = installed_constraint.conrelid
  JOIN pg_catalog.pg_namespace installed_namespace
    ON installed_namespace.oid = installed_table.relnamespace
  WHERE installed_namespace.nspname = 'public'
    AND installed_constraint.contype <> 'n'
    AND (
      installed_constraint.conrelid IN (
        to_regclass('public.operations_commerce_store_sync_controls'),
        to_regclass('public.operations_commerce_store_sync_change_receipts'),
        to_regclass('public.operations_commerce_store_sync_read_leases')
      )
      OR (
        installed_constraint.conrelid IN (
          to_regclass('public.operations_commerce_intake_read_intents'),
          to_regclass(
            'public.operations_commerce_product_image_observation_sets'
          ),
          to_regclass(
            'public.operations_commerce_product_image_import_jobs'
          )
        )
        AND installed_constraint.contype = 'c'
        AND position(
          'provider_read_authority'
          IN pg_get_constraintdef(installed_constraint.oid)
        ) > 0
      )
    );

  SELECT pg_catalog.count(*)::integer,
         pg_catalog.encode(
           public.digest(
             pg_catalog.convert_to(
               pg_catalog.string_agg(
                 pg_catalog.concat_ws(
                   '|',
                   installed_table.relname,
                   installed_constraint.conname,
                   bound_operator.binding_ordinal::pg_catalog.text,
                   operator_namespace.nspname,
                   installed_operator.oprname,
                   installed_operator.oprkind::pg_catalog.text,
                   COALESCE(
                     pg_catalog.concat(
                       left_type_namespace.nspname,
                       '.',
                       left_type.typname
                     ),
                     '<none>'
                   ),
                   COALESCE(
                     pg_catalog.concat(
                       right_type_namespace.nspname,
                       '.',
                       right_type.typname
                     ),
                     '<none>'
                   ),
                   pg_catalog.concat(
                     result_type_namespace.nspname,
                     '.',
                     result_type.typname
                   ),
                   pg_catalog.concat(
                     procedure_namespace.nspname,
                     '.',
                     installed_procedure.proname
                   ),
                   installed_operator.oprcanmerge::pg_catalog.text,
                   installed_operator.oprcanhash::pg_catalog.text
                 ),
                 pg_catalog.chr(10) ORDER BY
                   installed_table.relname,
                   installed_constraint.conname,
                   bound_operator.binding_ordinal
               ),
               'UTF8'
             ),
             'sha256'
           ),
           'hex'
         )
    INTO authority_operator_binding_count,
         authority_operator_binding_hash
  FROM pg_catalog.pg_constraint installed_constraint
  JOIN pg_catalog.pg_class installed_table
    ON installed_table.oid OPERATOR(pg_catalog.=)
      installed_constraint.conrelid
  JOIN pg_catalog.pg_namespace installed_namespace
    ON installed_namespace.oid OPERATOR(pg_catalog.=)
      installed_table.relnamespace
  CROSS JOIN LATERAL pg_catalog.regexp_matches(
    installed_constraint.conbin::pg_catalog.text,
    ':opno ([0-9]+)',
    'g'
  ) WITH ORDINALITY AS bound_operator(oid_match, binding_ordinal)
  JOIN pg_catalog.pg_operator installed_operator
    ON installed_operator.oid OPERATOR(pg_catalog.=)
         bound_operator.oid_match[1]::pg_catalog.oid
  JOIN pg_catalog.pg_namespace operator_namespace
    ON operator_namespace.oid OPERATOR(pg_catalog.=)
      installed_operator.oprnamespace
  LEFT JOIN pg_catalog.pg_type left_type
    ON left_type.oid OPERATOR(pg_catalog.=) installed_operator.oprleft
   AND installed_operator.oprleft OPERATOR(pg_catalog.<>) 0
  LEFT JOIN pg_catalog.pg_namespace left_type_namespace
    ON left_type_namespace.oid OPERATOR(pg_catalog.=)
      left_type.typnamespace
  LEFT JOIN pg_catalog.pg_type right_type
    ON right_type.oid OPERATOR(pg_catalog.=) installed_operator.oprright
   AND installed_operator.oprright OPERATOR(pg_catalog.<>) 0
  LEFT JOIN pg_catalog.pg_namespace right_type_namespace
    ON right_type_namespace.oid OPERATOR(pg_catalog.=)
      right_type.typnamespace
  JOIN pg_catalog.pg_type result_type
    ON result_type.oid OPERATOR(pg_catalog.=) installed_operator.oprresult
  JOIN pg_catalog.pg_namespace result_type_namespace
    ON result_type_namespace.oid OPERATOR(pg_catalog.=)
      result_type.typnamespace
  JOIN pg_catalog.pg_proc installed_procedure
    ON installed_procedure.oid OPERATOR(pg_catalog.=)
      installed_operator.oprcode
  JOIN pg_catalog.pg_namespace procedure_namespace
    ON procedure_namespace.oid OPERATOR(pg_catalog.=)
      installed_procedure.pronamespace
  WHERE installed_namespace.nspname OPERATOR(pg_catalog.=) 'public'
    AND installed_constraint.contype OPERATOR(pg_catalog.=) 'c'
    AND (
      installed_constraint.conrelid OPERATOR(pg_catalog.=) ANY (
        ARRAY[
          pg_catalog.to_regclass(
            'public.operations_commerce_store_sync_controls'
          ),
          pg_catalog.to_regclass(
            'public.operations_commerce_store_sync_change_receipts'
          ),
          pg_catalog.to_regclass(
            'public.operations_commerce_store_sync_read_leases'
          )
        ]::pg_catalog.oid[]
      )
      OR (
        installed_constraint.conrelid OPERATOR(pg_catalog.=) ANY (
          ARRAY[
            pg_catalog.to_regclass(
              'public.operations_commerce_intake_read_intents'
            ),
            pg_catalog.to_regclass(
              'public.operations_commerce_product_image_observation_sets'
            ),
            pg_catalog.to_regclass(
              'public.operations_commerce_product_image_import_jobs'
            )
          ]::pg_catalog.oid[]
        )
        AND pg_catalog.strpos(
              pg_catalog.pg_get_constraintdef(installed_constraint.oid),
              'provider_read_authority'
            ) OPERATOR(pg_catalog.>) 0
      )
    );

  IF authority_operator_binding_count OPERATOR(pg_catalog.=) 37
     AND authority_operator_binding_hash IS DISTINCT FROM
       '724e0c8f03f49d3f9664948070f811a28a9dbeea2b6a60bd6c12d28d8c33b3bc'
  THEN
    RAISE EXCEPTION
      'Commerce rollout contract requires exact CHECK operator bindings';
  END IF;

  IF authority_constraint_catalog_hash IS DISTINCT FROM
       'a28138f13bf3b2eaf60624e9efb6e7fff669032bcf27043adff648b2d82528da'
  THEN
    RAISE EXCEPTION
      'Commerce rollout contract requires the exact authority constraints';
  END IF;

  IF authority_operator_binding_count IS DISTINCT FROM 37
     OR authority_operator_binding_hash IS DISTINCT FROM
       '724e0c8f03f49d3f9664948070f811a28a9dbeea2b6a60bd6c12d28d8c33b3bc'
  THEN
    RAISE EXCEPTION
      'Commerce rollout contract requires exact CHECK operator bindings';
  END IF;

  SELECT encode(digest(convert_to(concat_ws('|',
           'derive_operations_shopify_checkout_rate_source_compat()',
           installed_namespace.nspname,
           language.lanname,
           installed.prokind::text,
           installed.provolatile::text,
           installed.proparallel::text,
           installed.proisstrict::text,
           installed.prosecdef::text,
           installed.proleakproof::text,
           COALESCE(array_to_string(installed.proconfig, ','), ''),
           pg_get_function_result(installed.oid),
           trim(regexp_replace(
             installed.prosrc, '[[:space:]]+', ' ', 'g'
           ))
         ), 'UTF8'), 'sha256'), 'hex')
    INTO bridge_function_hash
  FROM pg_catalog.pg_proc installed
  JOIN pg_catalog.pg_namespace installed_namespace
    ON installed_namespace.oid = installed.pronamespace
  JOIN pg_catalog.pg_language language
    ON language.oid = installed.prolang
  WHERE installed.oid = to_regprocedure(
    'public.derive_operations_shopify_checkout_rate_source_compat()'
  );

  IF bridge_function_hash IS DISTINCT FROM
       '35818f8af90aa04cc95a7fecbf10f3af0fcb31f708e14c374db7e4521b01c698'
  THEN
    RAISE EXCEPTION
      'Commerce rollout contract requires the exact receipt-writer bridge';
  END IF;

  SELECT encode(digest(convert_to(concat_ws('|',
           table_row.relname,
           table_namespace.nspname,
           installed.tgname,
           installed.tgtype::text,
           installed.tgenabled::text,
           installed.tgisinternal::text,
           (installed.tgconstraint <> 0)::text,
           installed.tgdeferrable::text,
           installed.tginitdeferred::text,
           procedure_namespace.nspname || '.' || procedure.proname
             || '(' || pg_get_function_identity_arguments(procedure.oid)
             || ')',
           COALESCE(array_to_string(installed.tgattr::smallint[], ','), ''),
           trim(regexp_replace(
             pg_get_triggerdef(installed.oid), '[[:space:]]+', ' ', 'g'
           ))
         ), 'UTF8'), 'sha256'), 'hex')
    INTO bridge_trigger_hash
  FROM pg_catalog.pg_trigger installed
  JOIN pg_catalog.pg_class table_row
    ON table_row.oid = installed.tgrelid
  JOIN pg_catalog.pg_namespace table_namespace
    ON table_namespace.oid = table_row.relnamespace
  JOIN pg_catalog.pg_proc procedure
    ON procedure.oid = installed.tgfoid
  JOIN pg_catalog.pg_namespace procedure_namespace
    ON procedure_namespace.oid = procedure.pronamespace
  WHERE installed.tgrelid = to_regclass(
    'public.operations_shopify_checkout_rate_receipts'
  )
    AND installed.tgname =
      'derive_operations_shopify_checkout_rate_source_compat_write'
    AND NOT installed.tgisinternal;

  IF bridge_trigger_hash IS DISTINCT FROM
       '055e248fcf32fa04416ba9048da9d9b261669706c17dbc926206952d214fb13c'
     OR (
       SELECT count(*)
       FROM pg_catalog.pg_trigger installed
       WHERE NOT installed.tgisinternal
         AND installed.tgfoid = pg_catalog.to_regprocedure(
           'public.derive_operations_shopify_checkout_rate_source_compat()'
         )
     ) <> 1
  THEN
    RAISE EXCEPTION
      'Commerce rollout contract requires the exact receipt-writer trigger';
  END IF;

  SELECT encode(digest(convert_to(concat_ws('|',
           'validate_operations_shopify_checkout_rate_control_config()',
           installed_namespace.nspname,
           language.lanname,
           installed.prokind::text,
           installed.provolatile::text,
           installed.proparallel::text,
           installed.proisstrict::text,
           installed.prosecdef::text,
           installed.proleakproof::text,
           COALESCE(array_to_string(installed.proconfig, ','), ''),
           pg_get_function_result(installed.oid),
           trim(regexp_replace(
             installed.prosrc, '[[:space:]]+', ' ', 'g'
           ))
         ), 'UTF8'), 'sha256'), 'hex')
    INTO config_validator_hash
  FROM pg_catalog.pg_proc installed
  JOIN pg_catalog.pg_namespace installed_namespace
    ON installed_namespace.oid = installed.pronamespace
  JOIN pg_catalog.pg_language language
    ON language.oid = installed.prolang
  WHERE installed.oid = pg_catalog.to_regprocedure(
    'public.validate_operations_shopify_checkout_rate_control_config()'
  );

  IF config_validator_hash IS DISTINCT FROM
       '168e74862eb9bb0cd18408b3cfd9d5a6b2c9d16761985577e6b88790b10427df'
  THEN
    RAISE EXCEPTION
      'Commerce rollout contract requires the exact legacy config-writer bridge';
  END IF;

  SELECT encode(digest(convert_to(concat_ws('|',
           table_row.relname,
           table_namespace.nspname,
           installed.tgname,
           installed.tgtype::text,
           installed.tgenabled::text,
           installed.tgisinternal::text,
           (installed.tgconstraint <> 0)::text,
           installed.tgdeferrable::text,
           installed.tginitdeferred::text,
           procedure_namespace.nspname || '.' || procedure.proname
             || '(' || pg_get_function_identity_arguments(procedure.oid)
             || ')',
           COALESCE(array_to_string(installed.tgattr::smallint[], ','), ''),
           trim(regexp_replace(
             pg_get_triggerdef(installed.oid), '[[:space:]]+', ' ', 'g'
           ))
         ), 'UTF8'), 'sha256'), 'hex')
    INTO config_trigger_hash
  FROM pg_catalog.pg_trigger installed
  JOIN pg_catalog.pg_class table_row
    ON table_row.oid = installed.tgrelid
  JOIN pg_catalog.pg_namespace table_namespace
    ON table_namespace.oid = table_row.relnamespace
  JOIN pg_catalog.pg_proc procedure
    ON procedure.oid = installed.tgfoid
  JOIN pg_catalog.pg_namespace procedure_namespace
    ON procedure_namespace.oid = procedure.pronamespace
  WHERE installed.tgrelid = pg_catalog.to_regclass(
    'public.operations_shopify_carrier_service_configs'
  )
    AND installed.tgname =
      'validate_operations_shopify_checkout_rate_control_config_write'
    AND NOT installed.tgisinternal;

  IF config_trigger_hash IS DISTINCT FROM
       'b88b7652ca71ac176f2b02b4a82bf7cd38a4dbf605fded4370853e4167746dd7'
     OR (
       SELECT count(*)
       FROM pg_catalog.pg_trigger installed
       WHERE NOT installed.tgisinternal
         AND installed.tgfoid = pg_catalog.to_regprocedure(
           'public.validate_operations_shopify_checkout_rate_control_config()'
         )
     ) <> 1
  THEN
    RAISE EXCEPTION
      'Commerce rollout contract requires the exact config-writer trigger';
  END IF;
END;
$contract$;

ALTER TABLE public.operations_commerce_intake_read_intents
  ALTER COLUMN provider_read_authority DROP DEFAULT;

ALTER TABLE public.operations_commerce_product_image_observation_sets
  ALTER COLUMN provider_read_authority DROP DEFAULT;

ALTER TABLE public.operations_commerce_product_image_import_jobs
  ALTER COLUMN provider_read_authority DROP DEFAULT;

DROP TRIGGER
  derive_operations_shopify_checkout_rate_source_compat_write
  ON public.operations_shopify_checkout_rate_receipts;
DROP FUNCTION public.derive_operations_shopify_checkout_rate_source_compat();

CREATE OR REPLACE FUNCTION
  public.validate_operations_shopify_checkout_rate_control_config()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  account_environment text;
BEGIN
  SELECT environment INTO account_environment
  FROM public.operations_integration_accounts
  WHERE organization_id = NEW.organization_id
    AND id = NEW.integration_account_id
    AND integration_type = 'commerce'
    AND provider = 'shopify';

  IF account_environment IS NULL THEN
    RAISE EXCEPTION
      'Shopify checkout-rate control requires its exact Shopify account';
  END IF;
  RETURN NEW;
END;
$$;

DO $contract$
DECLARE
  authority_column_catalog_hash text;
  authority_constraint_catalog_hash text;
  authority_operator_binding_count integer;
  authority_operator_binding_hash text;
  config_validator_hash text;
  config_trigger_hash text;
BEGIN
  SELECT encode(
           digest(
             convert_to(
               string_agg(
                 concat_ws(
                   '|', table_name, column_name, ordinal_position::text,
                   data_type, udt_schema, udt_name, is_nullable,
                   COALESCE(
                     CASE
                       WHEN table_name =
                              'operations_commerce_store_sync_change_receipts'
                        AND column_name = 'id'
                        AND column_default = 'gen_random_uuid()'
                        AND EXISTS (
                          SELECT 1
                          FROM pg_catalog.pg_attrdef installed_default
                          JOIN pg_catalog.pg_depend default_dependency
                            ON default_dependency.classid =
                                 'pg_catalog.pg_attrdef'::regclass
                           AND default_dependency.objid = installed_default.oid
                           AND default_dependency.refclassid =
                                 'pg_catalog.pg_proc'::regclass
                           AND default_dependency.refobjid =
                                 pg_catalog.to_regprocedure(
                                   'public.gen_random_uuid()'
                                 )
                           AND default_dependency.deptype = 'n'
                          WHERE installed_default.adrelid =
                                  pg_catalog.to_regclass(
                                    'public.' || table_name
                                  )
                            AND installed_default.adnum = ordinal_position
                        )
                       THEN 'public.gen_random_uuid()'
                       ELSE column_default
                     END,
                     '<null>'
                   ), is_identity,
                   COALESCE(identity_generation, '<null>'), is_generated,
                   COALESCE(generation_expression, '<null>'),
                   COALESCE(collation_schema, '<null>'),
                   COALESCE(collation_name, '<null>'),
                   COALESCE(character_maximum_length::text, '<null>'),
                   COALESCE(numeric_precision::text, '<null>'),
                   COALESCE(numeric_scale::text, '<null>'),
                   COALESCE(datetime_precision::text, '<null>')
                 ),
                 chr(10) ORDER BY table_name, column_name
               ),
               'UTF8'
             ),
             'sha256'
           ),
           'hex'
         )
    INTO authority_column_catalog_hash
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND (
      table_name IN (
        'operations_commerce_store_sync_controls',
        'operations_commerce_store_sync_change_receipts',
        'operations_commerce_store_sync_read_leases'
      )
      OR (
        table_name IN (
          'operations_commerce_intake_read_intents',
          'operations_commerce_product_image_observation_sets',
          'operations_commerce_product_image_import_jobs'
        )
        AND column_name = 'provider_read_authority'
      )
    );

  SELECT encode(digest(convert_to(concat_ws('|',
           'validate_operations_shopify_checkout_rate_control_config()',
           installed_namespace.nspname,
           language.lanname,
           installed.prokind::text,
           installed.provolatile::text,
           installed.proparallel::text,
           installed.proisstrict::text,
           installed.prosecdef::text,
           installed.proleakproof::text,
           COALESCE(array_to_string(installed.proconfig, ','), ''),
           pg_get_function_result(installed.oid),
           trim(regexp_replace(
             installed.prosrc, '[[:space:]]+', ' ', 'g'
           ))
         ), 'UTF8'), 'sha256'), 'hex')
    INTO config_validator_hash
  FROM pg_catalog.pg_proc installed
  JOIN pg_catalog.pg_namespace installed_namespace
    ON installed_namespace.oid = installed.pronamespace
  JOIN pg_catalog.pg_language language
    ON language.oid = installed.prolang
  WHERE installed.oid = pg_catalog.to_regprocedure(
    'public.validate_operations_shopify_checkout_rate_control_config()'
  );

  SELECT encode(digest(convert_to(concat_ws('|',
           table_row.relname,
           table_namespace.nspname,
           installed.tgname,
           installed.tgtype::text,
           installed.tgenabled::text,
           installed.tgisinternal::text,
           (installed.tgconstraint <> 0)::text,
           installed.tgdeferrable::text,
           installed.tginitdeferred::text,
           procedure_namespace.nspname || '.' || procedure.proname
             || '(' || pg_get_function_identity_arguments(procedure.oid)
             || ')',
           COALESCE(array_to_string(installed.tgattr::smallint[], ','), ''),
           trim(regexp_replace(
             pg_get_triggerdef(installed.oid), '[[:space:]]+', ' ', 'g'
           ))
         ), 'UTF8'), 'sha256'), 'hex')
    INTO config_trigger_hash
  FROM pg_catalog.pg_trigger installed
  JOIN pg_catalog.pg_class table_row
    ON table_row.oid = installed.tgrelid
  JOIN pg_catalog.pg_namespace table_namespace
    ON table_namespace.oid = table_row.relnamespace
  JOIN pg_catalog.pg_proc procedure
    ON procedure.oid = installed.tgfoid
  JOIN pg_catalog.pg_namespace procedure_namespace
    ON procedure_namespace.oid = procedure.pronamespace
  WHERE installed.tgrelid = pg_catalog.to_regclass(
    'public.operations_shopify_carrier_service_configs'
  )
    AND installed.tgname =
      'validate_operations_shopify_checkout_rate_control_config_write'
    AND NOT installed.tgisinternal;

  SELECT encode(
           digest(
             convert_to(
               string_agg(
                 concat_ws(
                   '|', installed_table.relname,
                   installed_constraint.conname,
                   installed_constraint.contype::text,
                   installed_constraint.convalidated::text,
                   installed_constraint.confdeltype::text,
                   installed_constraint.confupdtype::text,
                   pg_get_constraintdef(installed_constraint.oid)
                 ),
                 chr(10) ORDER BY
                   installed_table.relname, installed_constraint.conname
               ),
               'UTF8'
             ),
             'sha256'
           ),
           'hex'
         )
    INTO authority_constraint_catalog_hash
  FROM pg_catalog.pg_constraint installed_constraint
  JOIN pg_catalog.pg_class installed_table
    ON installed_table.oid = installed_constraint.conrelid
  JOIN pg_catalog.pg_namespace installed_namespace
    ON installed_namespace.oid = installed_table.relnamespace
  WHERE installed_namespace.nspname = 'public'
    AND installed_constraint.contype <> 'n'
    AND (
      installed_constraint.conrelid IN (
        to_regclass('public.operations_commerce_store_sync_controls'),
        to_regclass('public.operations_commerce_store_sync_change_receipts'),
        to_regclass('public.operations_commerce_store_sync_read_leases')
      )
      OR (
        installed_constraint.conrelid IN (
          to_regclass('public.operations_commerce_intake_read_intents'),
          to_regclass(
            'public.operations_commerce_product_image_observation_sets'
          ),
          to_regclass(
            'public.operations_commerce_product_image_import_jobs'
          )
        )
        AND installed_constraint.contype = 'c'
        AND position(
          'provider_read_authority'
          IN pg_get_constraintdef(installed_constraint.oid)
        ) > 0
      )
    );

  SELECT pg_catalog.count(*)::integer,
         pg_catalog.encode(
           public.digest(
             pg_catalog.convert_to(
               pg_catalog.string_agg(
                 pg_catalog.concat_ws(
                   '|',
                   installed_table.relname,
                   installed_constraint.conname,
                   bound_operator.binding_ordinal::pg_catalog.text,
                   operator_namespace.nspname,
                   installed_operator.oprname,
                   installed_operator.oprkind::pg_catalog.text,
                   COALESCE(
                     pg_catalog.concat(
                       left_type_namespace.nspname,
                       '.',
                       left_type.typname
                     ),
                     '<none>'
                   ),
                   COALESCE(
                     pg_catalog.concat(
                       right_type_namespace.nspname,
                       '.',
                       right_type.typname
                     ),
                     '<none>'
                   ),
                   pg_catalog.concat(
                     result_type_namespace.nspname,
                     '.',
                     result_type.typname
                   ),
                   pg_catalog.concat(
                     procedure_namespace.nspname,
                     '.',
                     installed_procedure.proname
                   ),
                   installed_operator.oprcanmerge::pg_catalog.text,
                   installed_operator.oprcanhash::pg_catalog.text
                 ),
                 pg_catalog.chr(10) ORDER BY
                   installed_table.relname,
                   installed_constraint.conname,
                   bound_operator.binding_ordinal
               ),
               'UTF8'
             ),
             'sha256'
           ),
           'hex'
         )
    INTO authority_operator_binding_count,
         authority_operator_binding_hash
  FROM pg_catalog.pg_constraint installed_constraint
  JOIN pg_catalog.pg_class installed_table
    ON installed_table.oid OPERATOR(pg_catalog.=)
      installed_constraint.conrelid
  JOIN pg_catalog.pg_namespace installed_namespace
    ON installed_namespace.oid OPERATOR(pg_catalog.=)
      installed_table.relnamespace
  CROSS JOIN LATERAL pg_catalog.regexp_matches(
    installed_constraint.conbin::pg_catalog.text,
    ':opno ([0-9]+)',
    'g'
  ) WITH ORDINALITY AS bound_operator(oid_match, binding_ordinal)
  JOIN pg_catalog.pg_operator installed_operator
    ON installed_operator.oid OPERATOR(pg_catalog.=)
         bound_operator.oid_match[1]::pg_catalog.oid
  JOIN pg_catalog.pg_namespace operator_namespace
    ON operator_namespace.oid OPERATOR(pg_catalog.=)
      installed_operator.oprnamespace
  LEFT JOIN pg_catalog.pg_type left_type
    ON left_type.oid OPERATOR(pg_catalog.=) installed_operator.oprleft
   AND installed_operator.oprleft OPERATOR(pg_catalog.<>) 0
  LEFT JOIN pg_catalog.pg_namespace left_type_namespace
    ON left_type_namespace.oid OPERATOR(pg_catalog.=)
      left_type.typnamespace
  LEFT JOIN pg_catalog.pg_type right_type
    ON right_type.oid OPERATOR(pg_catalog.=) installed_operator.oprright
   AND installed_operator.oprright OPERATOR(pg_catalog.<>) 0
  LEFT JOIN pg_catalog.pg_namespace right_type_namespace
    ON right_type_namespace.oid OPERATOR(pg_catalog.=)
      right_type.typnamespace
  JOIN pg_catalog.pg_type result_type
    ON result_type.oid OPERATOR(pg_catalog.=) installed_operator.oprresult
  JOIN pg_catalog.pg_namespace result_type_namespace
    ON result_type_namespace.oid OPERATOR(pg_catalog.=)
      result_type.typnamespace
  JOIN pg_catalog.pg_proc installed_procedure
    ON installed_procedure.oid OPERATOR(pg_catalog.=)
      installed_operator.oprcode
  JOIN pg_catalog.pg_namespace procedure_namespace
    ON procedure_namespace.oid OPERATOR(pg_catalog.=)
      installed_procedure.pronamespace
  WHERE installed_namespace.nspname OPERATOR(pg_catalog.=) 'public'
    AND installed_constraint.contype OPERATOR(pg_catalog.=) 'c'
    AND (
      installed_constraint.conrelid OPERATOR(pg_catalog.=) ANY (
        ARRAY[
          pg_catalog.to_regclass(
            'public.operations_commerce_store_sync_controls'
          ),
          pg_catalog.to_regclass(
            'public.operations_commerce_store_sync_change_receipts'
          ),
          pg_catalog.to_regclass(
            'public.operations_commerce_store_sync_read_leases'
          )
        ]::pg_catalog.oid[]
      )
      OR (
        installed_constraint.conrelid OPERATOR(pg_catalog.=) ANY (
          ARRAY[
            pg_catalog.to_regclass(
              'public.operations_commerce_intake_read_intents'
            ),
            pg_catalog.to_regclass(
              'public.operations_commerce_product_image_observation_sets'
            ),
            pg_catalog.to_regclass(
              'public.operations_commerce_product_image_import_jobs'
            )
          ]::pg_catalog.oid[]
        )
        AND pg_catalog.strpos(
              pg_catalog.pg_get_constraintdef(installed_constraint.oid),
              'provider_read_authority'
            ) OPERATOR(pg_catalog.>) 0
      )
    );

  IF authority_column_catalog_hash IS DISTINCT FROM
       '4abf9b4700d86b2cd84eab60bd59ca5935531dad5ee7566979d93a0612c3ef71'
     OR authority_constraint_catalog_hash IS DISTINCT FROM
       'a28138f13bf3b2eaf60624e9efb6e7fff669032bcf27043adff648b2d82528da'
     OR authority_operator_binding_count IS DISTINCT FROM 37
     OR authority_operator_binding_hash IS DISTINCT FROM
       '724e0c8f03f49d3f9664948070f811a28a9dbeea2b6a60bd6c12d28d8c33b3bc'
     OR to_regprocedure(
       'public.derive_operations_shopify_checkout_rate_source_compat()'
     ) IS NOT NULL
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_trigger installed
       WHERE installed.tgrelid = to_regclass(
         'public.operations_shopify_checkout_rate_receipts'
       )
         AND installed.tgname =
           'derive_operations_shopify_checkout_rate_source_compat_write'
         AND NOT installed.tgisinternal
     )
     OR config_validator_hash IS DISTINCT FROM
       'fdbeb95ff017923bc7010b597d99ff1237db6c73f71f91f2bcd90b2cf4a79f3b'
     OR config_trigger_hash IS DISTINCT FROM
       'b88b7652ca71ac176f2b02b4a82bf7cd38a4dbf605fded4370853e4167746dd7'
     OR (
       SELECT count(*)
       FROM pg_catalog.pg_trigger installed
       WHERE NOT installed.tgisinternal
         AND installed.tgfoid = pg_catalog.to_regprocedure(
           'public.validate_operations_shopify_checkout_rate_control_config()'
         )
     ) <> 1
  THEN
    RAISE EXCEPTION
      'Commerce rollout contract did not reach the exact strict writer shape';
  END IF;
END;
$contract$;
