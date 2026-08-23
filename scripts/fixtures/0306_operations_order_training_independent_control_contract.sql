-- Exact-order training is a local, zero-provider-write overlay. It remains
-- usable while the organization-wide advanced safety profile changes. The
-- profile revision is retained as authorization-time audit evidence, but it
-- is no longer execution authority for later local training commands.

SET LOCAL search_path = pg_catalog, public, pg_temp;

DO $contract$
DECLARE
  installed_function_count integer;
  function_catalog_hash text;
BEGIN
  IF NOT EXISTS (
       SELECT 1
       FROM public.schema_migrations
       WHERE filename = '0290_operations_shadow_training_runs.sql'
         AND checksum =
           '86ca66773b0a64e2b78aabfc35b5419ddc022123f96ab402204bbf0724e8aef0'
     )
     OR NOT EXISTS (
       SELECT 1
       FROM public.schema_migrations
       WHERE filename =
         '0300_operations_order_training_independent_control.sql'
         AND checksum =
           '1369a29d818c56f8bfdfa1ee1340c2e6902af9445ca8f00c8dc184b9685d4b84'
     )
  THEN
    RAISE EXCEPTION
      'Order Training contract requires exact 0290 and 0300 predecessors';
  END IF;

  SELECT pg_catalog.count(installed.oid)::integer,
         pg_catalog.encode(
           public.digest(
             pg_catalog.convert_to(
               pg_catalog.string_agg(
                 pg_catalog.concat_ws(
                   '|', required.signature, installed_namespace.nspname,
                   installed_language.lanname, installed.prokind::text,
                   installed.provolatile::text, installed.proparallel::text,
                   installed.proisstrict::text, installed.prosecdef::text,
                   installed.proleakproof::text,
                   COALESCE(
                     pg_catalog.array_to_string(installed.proconfig, ','),
                     ''
                   ),
                   pg_catalog.pg_get_function_result(installed.oid),
                   pg_catalog.regexp_replace(
                     pg_catalog.btrim(pg_catalog.regexp_replace(
                       installed.prosrc,
                       E'(^|[\\n\\r])[[:blank:]]*--[^\\n\\r]*',
                       ' ',
                       'g'
                     )),
                     '[[:space:]]+',
                     ' ',
                     'g'
                   )
                 ),
                 pg_catalog.chr(10) ORDER BY required.signature
               ),
               'UTF8'
             ),
             'sha256'
           ),
           'hex'
         )
    INTO installed_function_count, function_catalog_hash
  FROM (VALUES
    ('public.guard_shadow_commerce_canonical_write()'),
    ('public.guard_shadow_training_activation_change()'),
    ('public.protect_operations_shadow_training_event()'),
    ('public.protect_operations_shadow_training_package()'),
    ('public.protect_operations_shadow_training_pick_task()'),
    ('public.protect_operations_shadow_training_run()'),
    ('public.validate_operations_shadow_training_label_link()'),
    ('public.validate_operations_shadow_training_package_fact()'),
    ('public.validate_operations_shadow_training_pick_fact()'),
    ('public.validate_operations_shadow_training_plan_coverage()'),
    ('public.validate_operations_shadow_training_run_identity()')
  ) AS required(signature)
  LEFT JOIN pg_catalog.pg_proc installed
    ON installed.oid = pg_catalog.to_regprocedure(required.signature)
  LEFT JOIN pg_catalog.pg_namespace installed_namespace
    ON installed_namespace.oid = installed.pronamespace
  LEFT JOIN pg_catalog.pg_language installed_language
    ON installed_language.oid = installed.prolang;

  IF installed_function_count <> 11
     OR (
       EXISTS (
         SELECT 1
         FROM public.schema_migrations
         WHERE filename =
           '0314_operations_local_work_independent_activation.sql'
           AND checksum =
             '2c69fa93d265ced3a0019cc5f5b6770ae2890146e4bc00d213d9b67ae18d7d3c'
       )
       AND function_catalog_hash IS DISTINCT FROM
         '193a1231079de374c3ffe2f8009d750bb8cc70838ce9e5c81a6df9f677883d65'
     )
     OR (
       NOT EXISTS (
         SELECT 1
         FROM public.schema_migrations
         WHERE filename =
           '0314_operations_local_work_independent_activation.sql'
       )
       AND function_catalog_hash IS DISTINCT FROM
         'd36fac978d58106ed11e30a2079253fae5b47c54612a4d5901d2de1c71742b33'
     )
     OR EXISTS (
       SELECT 1
       FROM public.schema_migrations
       WHERE filename =
         '0314_operations_local_work_independent_activation.sql'
         AND checksum IS DISTINCT FROM
           '2c69fa93d265ced3a0019cc5f5b6770ae2890146e4bc00d213d9b67ae18d7d3c'
     )
  THEN
    RAISE EXCEPTION
      'Order Training contract requires exact profile-bound predecessors';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger installed
    WHERE NOT installed.tgisinternal
      AND installed.tgfoid IN (
        pg_catalog.to_regprocedure(
          'public.validate_operations_shadow_training_package_fact()'
        ),
        pg_catalog.to_regprocedure(
          'public.validate_operations_shadow_training_pick_fact()'
        ),
        pg_catalog.to_regprocedure(
          'public.validate_operations_shadow_training_plan_coverage()'
        ),
        pg_catalog.to_regprocedure(
          'public.protect_operations_shadow_training_run()'
        ),
        pg_catalog.to_regprocedure(
          'public.validate_operations_shadow_training_run_identity()'
        ),
        pg_catalog.to_regprocedure(
          'public.protect_operations_shadow_training_package()'
        ),
        pg_catalog.to_regprocedure(
          'public.protect_operations_shadow_training_pick_task()'
        ),
        pg_catalog.to_regprocedure(
          'public.protect_operations_shadow_training_event()'
        ),
        pg_catalog.to_regprocedure(
          'public.validate_operations_shadow_training_label_link()'
        ),
        pg_catalog.to_regprocedure(
          'public.guard_shadow_commerce_canonical_write()'
        ),
        pg_catalog.to_regprocedure(
          'public.guard_shadow_training_activation_change()'
        )
      )
  ) <> 16
  OR EXISTS (
    SELECT 1
    FROM (VALUES
      ('public.operations_shadow_training_packages',
       'validate_operations_shadow_training_package_fact_commit', 5,
       true, true, true,
       'public.validate_operations_shadow_training_package_fact()'),
      ('public.operations_shadow_training_pick_tasks',
       'validate_operations_shadow_training_pick_fact_commit', 5,
       true, true, true,
       'public.validate_operations_shadow_training_pick_fact()'),
      ('public.operations_shadow_training_runs',
       'validate_operations_shadow_training_plan_coverage_update', 19,
       false, false, false,
       'public.validate_operations_shadow_training_plan_coverage()'),
      ('public.operations_shadow_training_runs',
       'validate_operations_shadow_training_run_identity_mutation', 23,
       false, false, false,
       'public.validate_operations_shadow_training_run_identity()'),
      ('public.operations_shadow_training_runs',
       'protect_operations_shadow_training_run_mutation', 27,
       false, false, false,
       'public.protect_operations_shadow_training_run()'),
      ('public.operations_shadow_training_packages',
       'protect_operations_shadow_training_package_mutation', 27,
       false, false, false,
       'public.protect_operations_shadow_training_package()'),
      ('public.operations_shadow_training_pick_tasks',
       'protect_operations_shadow_training_pick_task_mutation', 27,
       false, false, false,
       'public.protect_operations_shadow_training_pick_task()'),
      ('public.operations_shadow_training_events',
       'protect_operations_shadow_training_event_mutation', 27,
       false, false, false,
       'public.protect_operations_shadow_training_event()'),
      ('public.operations_shadow_training_label_links',
       'validate_operations_shadow_training_label_link_mutation', 31,
       false, false, false,
       'public.validate_operations_shadow_training_label_link()'),
      ('public.operations_fulfillment_plans',
       'guard_shadow_commerce_canonical_plan_insert', 23,
       false, false, false,
       'public.guard_shadow_commerce_canonical_write()'),
      ('public.operations_reservations',
       'guard_shadow_commerce_canonical_reservation_insert', 23,
       false, false, false,
       'public.guard_shadow_commerce_canonical_write()'),
      ('public.operations_shipments',
       'guard_shadow_commerce_canonical_shipment_insert', 23,
       false, false, false,
       'public.guard_shadow_commerce_canonical_write()'),
      ('public.operations_commerce_fulfillment_exports',
       'guard_shadow_commerce_canonical_export_insert', 23,
       false, false, false,
       'public.guard_shadow_commerce_canonical_write()'),
      ('public.operations_activation_scopes',
       'guard_shadow_training_activation_change_insert', 7,
       false, false, false,
       'public.guard_shadow_training_activation_change()'),
      ('public.operations_activation_scopes',
       'guard_shadow_training_activation_change_update', 19,
       false, false, false,
       'public.guard_shadow_training_activation_change()'),
      ('public.operations_activation_scopes',
       'guard_shadow_training_activation_change_delete', 11,
       false, false, false,
       'public.guard_shadow_training_activation_change()')
    ) AS required(
      table_name, trigger_name, trigger_type, constraint_trigger,
      trigger_deferrable, initially_deferred, function_signature
    )
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_trigger installed
      WHERE installed.tgrelid = pg_catalog.to_regclass(required.table_name)
        AND installed.tgname = required.trigger_name
        AND installed.tgtype = required.trigger_type
        AND installed.tgenabled = 'O'
        AND NOT installed.tgisinternal
        AND (installed.tgconstraint <> 0) = required.constraint_trigger
        AND installed.tgdeferrable = required.trigger_deferrable
        AND installed.tginitdeferred = required.initially_deferred
        AND installed.tgfoid =
              pg_catalog.to_regprocedure(required.function_signature)
        AND installed.tgqual IS NULL
        AND ARRAY(
          SELECT installed_column.attname
          FROM pg_catalog.unnest(installed.tgattr::smallint[]) WITH ORDINALITY
            update_attribute(attnum, ordinal)
          JOIN pg_catalog.pg_attribute installed_column
            ON installed_column.attrelid = installed.tgrelid
           AND installed_column.attnum = update_attribute.attnum
          ORDER BY update_attribute.ordinal
        ) = CASE
          WHEN required.trigger_name IN (
            'validate_operations_shadow_training_plan_coverage_update',
            'guard_shadow_training_activation_change_update'
          )
          THEN ARRAY['state']::name[]
          ELSE ARRAY[]::name[]
        END
    )
  ) THEN
    RAISE EXCEPTION
      'Order Training contract requires exact predecessor trigger bindings';
  END IF;
END;
$contract$;

CREATE OR REPLACE FUNCTION public.validate_operations_shadow_training_run_identity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  source_binding_valid boolean;
  authorization_binding_valid boolean;
  evidence_binding_valid boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended(
        'operations:activation:' || NEW.organization_id::text,
        0
      )
    );
    PERFORM 1
    FROM operations_activation_scopes activation
    WHERE activation.organization_id = NEW.organization_id
      AND activation.state IN (
        'disabled', 'shadow', 'read_only', 'active', 'frozen'
      )
      AND activation.revision = NEW.authorization_activation_revision
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Order training requires an exact current safety profile';
    END IF;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM operations_orders source_order
    JOIN operations_integration_accounts account
      ON account.organization_id = source_order.organization_id
     AND account.id = source_order.integration_account_id
    JOIN operations_commerce_order_candidates candidate
      ON candidate.organization_id = source_order.organization_id
     AND candidate.integration_account_id = source_order.integration_account_id
     AND candidate.canonical_order_id = source_order.id
    WHERE source_order.organization_id = NEW.organization_id
      AND source_order.id = NEW.source_order_id
      AND source_order.integration_account_id = NEW.integration_account_id
      AND source_order.source_provider = NEW.provider
      AND account.provider = NEW.provider
      AND account.integration_type = 'commerce'
      AND account.environment = NEW.account_environment
      AND account.environment IN ('sandbox', 'production')
      AND candidate.id = NEW.source_candidate_id
  ) INTO source_binding_valid;
  IF source_binding_valid IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Order training source order, account, provider, and candidate must be exact';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT EXISTS (
      SELECT 1
      FROM operations_orders source_order
      JOIN operations_integration_accounts account
        ON account.organization_id = source_order.organization_id
       AND account.id = source_order.integration_account_id
      JOIN operations_commerce_credentials credential
        ON credential.organization_id = account.organization_id
       AND credential.integration_account_id = account.id
      JOIN operations_commerce_order_candidates candidate
        ON candidate.organization_id = source_order.organization_id
       AND candidate.integration_account_id = source_order.integration_account_id
       AND candidate.canonical_order_id = source_order.id
      JOIN operations_activation_scopes activation
        ON activation.organization_id = source_order.organization_id
      WHERE source_order.organization_id = NEW.organization_id
        AND source_order.id = NEW.source_order_id
        AND source_order.status = 'imported'
        AND source_order.row_version = NEW.authorization_order_row_version
        AND account.id = NEW.integration_account_id
        AND account.status = 'active'
        AND account.environment IN ('sandbox', 'production')
        AND credential.verification_status = 'verified'
        AND credential.credential_version = NEW.authorization_credential_generation
        AND candidate.id = NEW.source_candidate_id
        AND candidate.workflow_state = 'promoted'
        AND candidate.row_version = NEW.authorization_candidate_row_version
        AND candidate.source_hash = NEW.authorization_candidate_source_hash
        AND activation.state IN (
          'disabled', 'shadow', 'read_only', 'active', 'frozen'
        )
        AND activation.revision = NEW.authorization_activation_revision
        AND ocr_order_has_zero_downstream(
          source_order.organization_id,
          source_order.id
        )
        AND EXISTS (
          SELECT 1
          FROM operations_commerce_order_candidate_lines candidate_line
          WHERE candidate_line.organization_id = candidate.organization_id
            AND candidate_line.integration_account_id = candidate.integration_account_id
            AND candidate_line.order_candidate_id = candidate.id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM operations_commerce_order_candidate_lines candidate_line
          LEFT JOIN crm_products product
            ON product.pipeline_id = candidate_line.pipeline_id
           AND product.id = candidate_line.product_id
          WHERE candidate_line.organization_id = candidate.organization_id
            AND candidate_line.integration_account_id = candidate.integration_account_id
            AND candidate_line.order_candidate_id = candidate.id
            AND product.id IS NULL
        )
    ) INTO authorization_binding_valid;
    IF authorization_binding_valid IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'Order training authorization requires an untouched imported connected-store order';
    END IF;
  END IF;

  IF NEW.cartonization_evidence_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
      FROM operations_cartonization_rate_evidence evidence
      WHERE evidence.organization_id = NEW.organization_id
        AND evidence.id = NEW.cartonization_evidence_id
        AND evidence.global_id = NEW.cartonization_evidence_global_id
        AND evidence.integration_account_id = NEW.integration_account_id
        AND evidence.order_candidate_id = NEW.source_candidate_id
        AND evidence.candidate_row_version = NEW.authorization_candidate_row_version
        AND evidence.candidate_source_hash = NEW.authorization_candidate_source_hash
        AND evidence.warehouse_id = NEW.warehouse_id
        AND evidence.sealed_at IS NOT NULL
        AND evidence.plan_snapshot->'shadowTraining'->>'version'
              = 'shadow-training-evidence-v1'
        AND evidence.plan_snapshot->'shadowTraining'->>'runGlobalId'
              = NEW.global_id
    ) INTO evidence_binding_valid;
    IF evidence_binding_valid IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'Order training evidence must match the exact account, candidate, and warehouse';
    END IF;
    IF TG_OP = 'UPDATE'
       AND OLD.state = 'enabled'
       AND NEW.state = 'planned'
       AND NOT EXISTS (
         SELECT 1
         FROM operations_cartonization_rate_evidence evidence
         WHERE evidence.organization_id = NEW.organization_id
           AND evidence.id = NEW.cartonization_evidence_id
           AND (evidence.plan_snapshot->'shadowTraining'->>'runRowVersion')::bigint
                 = OLD.row_version
       ) THEN
      RAISE EXCEPTION 'Order training evidence must match the exact enabled run version';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- Keep exact-order training isolation and evidence quarantine without
-- restoring the retired organization-wide Shadow gate for unrelated work.
CREATE OR REPLACE FUNCTION public.guard_shadow_commerce_canonical_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  canonical_identity_changed boolean := TG_OP = 'INSERT';
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'operations:activation:' || NEW.organization_id::text,
      0
    )
  );

  IF TG_TABLE_NAME = 'operations_fulfillment_plans'
     AND EXISTS (
       SELECT 1
       FROM operations_cartonization_rate_evidence evidence
       WHERE evidence.organization_id = NEW.organization_id
         AND evidence.id = NULLIF(
           to_jsonb(NEW)->>'cartonization_evidence_id',
           ''
         )::uuid
         AND evidence.plan_snapshot ? 'shadowTraining'
     ) THEN
    RAISE EXCEPTION 'OPERATIONS_SHADOW_TRAINING_EVIDENCE_CANONICAL_FORBIDDEN'
      USING ERRCODE = 'P0001';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    canonical_identity_changed :=
      NEW.order_id IS DISTINCT FROM OLD.order_id;
  END IF;

  IF canonical_identity_changed AND EXISTS (
    SELECT 1
    FROM operations_shadow_training_runs training_run
    WHERE training_run.organization_id = NEW.organization_id
      AND training_run.source_order_id = NEW.order_id
      AND training_run.state <> 'reset'
  ) THEN
    RAISE EXCEPTION 'OPERATIONS_SHADOW_TRAINING_OVERLAY_REQUIRED'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

-- Profile changes no longer strand or invalidate an exact local training run.
-- Deleting the only profile row remains blocked while a run is open because
-- the row is still part of organization identity and audit history.
CREATE OR REPLACE FUNCTION public.guard_shadow_training_activation_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND EXISTS (
       SELECT 1
       FROM operations_shadow_training_runs run
       WHERE run.organization_id = OLD.organization_id
         AND run.state <> 'reset'
     ) THEN
    RAISE EXCEPTION 'OPERATIONS_ORDER_TRAINING_SAFETY_PROFILE_REQUIRED'
      USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

-- Release B pins every trigger function in this authority surface. Release A
-- intentionally retains the legacy 0290 metadata until old runtimes drain.
ALTER FUNCTION public.validate_operations_shadow_training_package_fact()
  SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.validate_operations_shadow_training_pick_fact()
  SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.validate_operations_shadow_training_plan_coverage()
  SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.protect_operations_shadow_training_run()
  SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.validate_operations_shadow_training_run_identity()
  SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.protect_operations_shadow_training_package()
  SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.protect_operations_shadow_training_pick_task()
  SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.protect_operations_shadow_training_event()
  SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.validate_operations_shadow_training_label_link()
  SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.guard_shadow_commerce_canonical_write()
  SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.guard_shadow_training_activation_change()
  SET search_path = pg_catalog, public, pg_temp;

COMMENT ON TABLE public.operations_shadow_training_runs IS
  'Exact-order local training overlay. Advanced safety profile changes do not invalidate a run; commerce writes, production postage, operational inventory, and packaging-stock mutations remain constrained to zero.';

DO $contract$
DECLARE
  installed_function_count integer;
  function_catalog_hash text;
BEGIN
  SELECT pg_catalog.count(installed.oid)::integer,
         pg_catalog.encode(
           public.digest(
             pg_catalog.convert_to(
               pg_catalog.string_agg(
                 pg_catalog.concat_ws(
                   '|', required.signature, installed_namespace.nspname,
                   installed_language.lanname, installed.prokind::text,
                   installed.provolatile::text, installed.proparallel::text,
                   installed.proisstrict::text, installed.prosecdef::text,
                   installed.proleakproof::text,
                   COALESCE(
                     pg_catalog.array_to_string(installed.proconfig, ','),
                     ''
                   ),
                   pg_catalog.pg_get_function_result(installed.oid),
                   pg_catalog.regexp_replace(
                     pg_catalog.btrim(pg_catalog.regexp_replace(
                       installed.prosrc,
                       E'(^|[\\n\\r])[[:blank:]]*--[^\\n\\r]*',
                       ' ',
                       'g'
                     )),
                     '[[:space:]]+',
                     ' ',
                     'g'
                   )
                 ),
                 pg_catalog.chr(10) ORDER BY required.signature
               ),
               'UTF8'
             ),
             'sha256'
           ),
           'hex'
         )
    INTO installed_function_count, function_catalog_hash
  FROM (VALUES
    ('public.guard_shadow_commerce_canonical_write()'),
    ('public.guard_shadow_training_activation_change()'),
    ('public.protect_operations_shadow_training_event()'),
    ('public.protect_operations_shadow_training_package()'),
    ('public.protect_operations_shadow_training_pick_task()'),
    ('public.protect_operations_shadow_training_run()'),
    ('public.validate_operations_shadow_training_label_link()'),
    ('public.validate_operations_shadow_training_package_fact()'),
    ('public.validate_operations_shadow_training_pick_fact()'),
    ('public.validate_operations_shadow_training_plan_coverage()'),
    ('public.validate_operations_shadow_training_run_identity()')
  ) AS required(signature)
  LEFT JOIN pg_catalog.pg_proc installed
    ON installed.oid = pg_catalog.to_regprocedure(required.signature)
  LEFT JOIN pg_catalog.pg_namespace installed_namespace
    ON installed_namespace.oid = installed.pronamespace
  LEFT JOIN pg_catalog.pg_language installed_language
    ON installed_language.oid = installed.prolang;

  IF installed_function_count <> 11
     OR function_catalog_hash IS DISTINCT FROM
       '6e65ce001f133f420e3a80621774d55d65119c03609a5b91245596d3635d8503'
  THEN
    RAISE EXCEPTION
      'Order Training contract did not install exact independent functions';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger installed
    WHERE NOT installed.tgisinternal
      AND installed.tgfoid IN (
        pg_catalog.to_regprocedure(
          'public.validate_operations_shadow_training_package_fact()'
        ),
        pg_catalog.to_regprocedure(
          'public.validate_operations_shadow_training_pick_fact()'
        ),
        pg_catalog.to_regprocedure(
          'public.validate_operations_shadow_training_plan_coverage()'
        ),
        pg_catalog.to_regprocedure(
          'public.protect_operations_shadow_training_run()'
        ),
        pg_catalog.to_regprocedure(
          'public.validate_operations_shadow_training_run_identity()'
        ),
        pg_catalog.to_regprocedure(
          'public.protect_operations_shadow_training_package()'
        ),
        pg_catalog.to_regprocedure(
          'public.protect_operations_shadow_training_pick_task()'
        ),
        pg_catalog.to_regprocedure(
          'public.protect_operations_shadow_training_event()'
        ),
        pg_catalog.to_regprocedure(
          'public.validate_operations_shadow_training_label_link()'
        ),
        pg_catalog.to_regprocedure(
          'public.guard_shadow_commerce_canonical_write()'
        ),
        pg_catalog.to_regprocedure(
          'public.guard_shadow_training_activation_change()'
        )
      )
  ) <> 16
  OR EXISTS (
    SELECT 1
    FROM (VALUES
      ('public.operations_shadow_training_packages',
       'validate_operations_shadow_training_package_fact_commit', 5,
       true, true, true,
       'public.validate_operations_shadow_training_package_fact()'),
      ('public.operations_shadow_training_pick_tasks',
       'validate_operations_shadow_training_pick_fact_commit', 5,
       true, true, true,
       'public.validate_operations_shadow_training_pick_fact()'),
      ('public.operations_shadow_training_runs',
       'validate_operations_shadow_training_plan_coverage_update', 19,
       false, false, false,
       'public.validate_operations_shadow_training_plan_coverage()'),
      ('public.operations_shadow_training_runs',
       'validate_operations_shadow_training_run_identity_mutation', 23,
       false, false, false,
       'public.validate_operations_shadow_training_run_identity()'),
      ('public.operations_shadow_training_runs',
       'protect_operations_shadow_training_run_mutation', 27,
       false, false, false,
       'public.protect_operations_shadow_training_run()'),
      ('public.operations_shadow_training_packages',
       'protect_operations_shadow_training_package_mutation', 27,
       false, false, false,
       'public.protect_operations_shadow_training_package()'),
      ('public.operations_shadow_training_pick_tasks',
       'protect_operations_shadow_training_pick_task_mutation', 27,
       false, false, false,
       'public.protect_operations_shadow_training_pick_task()'),
      ('public.operations_shadow_training_events',
       'protect_operations_shadow_training_event_mutation', 27,
       false, false, false,
       'public.protect_operations_shadow_training_event()'),
      ('public.operations_shadow_training_label_links',
       'validate_operations_shadow_training_label_link_mutation', 31,
       false, false, false,
       'public.validate_operations_shadow_training_label_link()'),
      ('public.operations_fulfillment_plans',
       'guard_shadow_commerce_canonical_plan_insert', 23,
       false, false, false,
       'public.guard_shadow_commerce_canonical_write()'),
      ('public.operations_reservations',
       'guard_shadow_commerce_canonical_reservation_insert', 23,
       false, false, false,
       'public.guard_shadow_commerce_canonical_write()'),
      ('public.operations_shipments',
       'guard_shadow_commerce_canonical_shipment_insert', 23,
       false, false, false,
       'public.guard_shadow_commerce_canonical_write()'),
      ('public.operations_commerce_fulfillment_exports',
       'guard_shadow_commerce_canonical_export_insert', 23,
       false, false, false,
       'public.guard_shadow_commerce_canonical_write()'),
      ('public.operations_activation_scopes',
       'guard_shadow_training_activation_change_insert', 7,
       false, false, false,
       'public.guard_shadow_training_activation_change()'),
      ('public.operations_activation_scopes',
       'guard_shadow_training_activation_change_update', 19,
       false, false, false,
       'public.guard_shadow_training_activation_change()'),
      ('public.operations_activation_scopes',
       'guard_shadow_training_activation_change_delete', 11,
       false, false, false,
       'public.guard_shadow_training_activation_change()')
    ) AS required(
      table_name, trigger_name, trigger_type, constraint_trigger,
      trigger_deferrable, initially_deferred, function_signature
    )
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_trigger installed
      WHERE installed.tgrelid = pg_catalog.to_regclass(required.table_name)
        AND installed.tgname = required.trigger_name
        AND installed.tgtype = required.trigger_type
        AND installed.tgenabled = 'O'
        AND NOT installed.tgisinternal
        AND (installed.tgconstraint <> 0) = required.constraint_trigger
        AND installed.tgdeferrable = required.trigger_deferrable
        AND installed.tginitdeferred = required.initially_deferred
        AND installed.tgfoid =
              pg_catalog.to_regprocedure(required.function_signature)
        AND installed.tgqual IS NULL
        AND ARRAY(
          SELECT installed_column.attname
          FROM pg_catalog.unnest(installed.tgattr::smallint[]) WITH ORDINALITY
            update_attribute(attnum, ordinal)
          JOIN pg_catalog.pg_attribute installed_column
            ON installed_column.attrelid = installed.tgrelid
           AND installed_column.attnum = update_attribute.attnum
          ORDER BY update_attribute.ordinal
        ) = CASE
          WHEN required.trigger_name IN (
            'validate_operations_shadow_training_plan_coverage_update',
            'guard_shadow_training_activation_change_update'
          )
          THEN ARRAY['state']::name[]
          ELSE ARRAY[]::name[]
        END
    )
  ) THEN
    RAISE EXCEPTION
      'Order Training contract did not preserve exact trigger bindings';
  END IF;
END;
$contract$;
