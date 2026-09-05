// This expression is intentionally shared by runtime health and the
// disposable-PostgreSQL tamper test. Function OIDs and trigger bindings survive
// CREATE OR REPLACE, so object-presence checks alone cannot attest the Store
// sync safety contract.
export const OPERATIONS_COMMERCE_STORE_SYNC_FUNCTION_HEALTH_SQL = String.raw`
  (
    WITH required_function(
      signature,
      body_sha256,
      language_name,
      volatility,
      result_type
    ) AS (
      VALUES
        (
          'public.operations_commerce_store_sync_effective_reason(uuid,uuid)',
          CASE WHEN EXISTS (
            SELECT 1 FROM public.schema_migrations
            WHERE filename =
              '0314_operations_local_work_independent_activation.sql'
              AND checksum =
                '2c69fa93d265ced3a0019cc5f5b6770ae2890146e4bc00d213d9b67ae18d7d3c'
          ) THEN
            'e3464f9506ab744c174b026ad6d525c711b2f3f5153c42246f112a003174b1c3'
          ELSE
            '74bebc0fb36d86c9970249a91cef314962596faf7e17ad6d426680bc6cc7c593'
          END,
          'sql', 's', 'text'
        ),
        (
          'public.operations_commerce_store_sync_is_running(uuid,uuid)',
          '10dd931110d6c6596516a08f545807710d2433ec6de0ea2faaf600f32b5b170b',
          'sql', 's', 'boolean'
        ),
        (
          'public.seed_operations_commerce_store_sync_control()',
          CASE WHEN EXISTS (
            SELECT 1 FROM public.schema_migrations
            WHERE filename =
              '0314_operations_local_work_independent_activation.sql'
              AND checksum =
                '2c69fa93d265ced3a0019cc5f5b6770ae2890146e4bc00d213d9b67ae18d7d3c'
          ) THEN
            '0c8f917c0f8f477eb06e8fc4978e5e74cb85a9a6741c1bbc660a03b96e012d5f'
          ELSE
            '82527578c401058683ed859165997af9a89ed5cee2162d09b808b485267912e1'
          END,
          'plpgsql', 'v', 'trigger'
        ),
        (
          'public.protect_operations_commerce_store_sync_receipt()',
          '16279b889782e8cc3926edd0529b70740a2f3d26e9118472351873df2de55051',
          'plpgsql', 'v', 'trigger'
        ),
        (
          'public.validate_operations_commerce_store_sync_identity()',
          '9ddd587a92ded9d4e531ed1cc1bcdaa49d6f39268dd901496c623b39b06d8044',
          'plpgsql', 'v', 'trigger'
        ),
        (
          'public.operations_shopify_inventory_read_config_is_ready(uuid,uuid)',
          'd0e46b48d90213824182fc6aee753253f88bda93ad7a28021b6d3f835ef25d21',
          'sql', 's', 'boolean'
        ),
        (
          'public.operations_commerce_provider_read_authority_is_current(uuid,uuid,text)',
          CASE WHEN EXISTS (
            SELECT 1 FROM public.schema_migrations
            WHERE filename =
              '0314_operations_local_work_independent_activation.sql'
              AND checksum =
                '2c69fa93d265ced3a0019cc5f5b6770ae2890146e4bc00d213d9b67ae18d7d3c'
          ) THEN
            '0b035f56b1645b1c29ebc3fe0f5db2accf017aa742f91d5582c5ef4df9697c33'
          ELSE
            '4f0f62a1eef912a6a648c6df67e9e1998b5f01247df9b46d006d120ac0e2abd4'
          END,
          'sql', 's', 'boolean'
        ),
        (
          'public.operations_commerce_product_image_read_authority_is_current(uuid,uuid,text,integer,text)',
          '9e11bd5dd48b47d7fbee5db9e88db82bc012ba9b8feb9d62694aca8ad052d5c5',
          'sql', 's', 'boolean'
        ),
        (
          'public.guard_operations_commerce_product_image_read_authority()',
          '056c1f8a5ae21ae7cc0098e89a810dfe1c8cc7212e7d5c83d70fd7729d622b72',
          'plpgsql', 'v', 'trigger'
        ),
        (
          'public.guard_operations_commerce_store_sync_read_lease()',
          '1749c76b4da7f20107175c650cfb09c1eeb13ef6b07dbee22b1d656431368ecf',
          'plpgsql', 'v', 'trigger'
        )
    )
    SELECT pg_catalog.count(*) OPERATOR(pg_catalog.=) 10
      AND pg_catalog.count(installed_function.oid) OPERATOR(pg_catalog.=) 10
      AND pg_catalog.bool_and(COALESCE(
        pg_catalog.encode(
          public.digest(
            pg_catalog.convert_to(
              pg_catalog.btrim(pg_catalog.regexp_replace(
                installed_function.prosrc,
                '[[:space:]]+', ' ', 'g'
              )),
              'UTF8'
            ),
            'sha256'
          ),
          'hex'
        ) OPERATOR(pg_catalog.=) required_function.body_sha256
        AND installed_language.lanname OPERATOR(pg_catalog.=)
              required_function.language_name
        AND installed_function.provolatile OPERATOR(pg_catalog.=)
              required_function.volatility
        AND pg_catalog.pg_get_function_result(installed_function.oid)
              OPERATOR(pg_catalog.=)
              required_function.result_type
        AND installed_function.prokind OPERATOR(pg_catalog.=) 'f'
        AND NOT installed_function.proisstrict
        AND NOT installed_function.prosecdef
        AND NOT installed_function.proleakproof
        AND installed_function.proparallel OPERATOR(pg_catalog.=) 'u'
        AND installed_function.proconfig OPERATOR(pg_catalog.=) ARRAY[
          'search_path=pg_catalog, public, pg_temp'
        ]::text[],
        false
      ))
    FROM required_function
    LEFT JOIN pg_catalog.pg_proc installed_function
      ON installed_function.oid OPERATOR(pg_catalog.=)
        pg_catalog.to_regprocedure(
        required_function.signature
      )
    LEFT JOIN pg_catalog.pg_language installed_language
      ON installed_language.oid OPERATOR(pg_catalog.=)
        installed_function.prolang
  )
`

// Migration 0298 deliberately rewrites several pre-existing order/webhook and
// product-image functions. Pin the complete resulting catalog, not only the
// six newly introduced control functions, so a legacy activation latch or a
// weakened projection/lineage guard cannot be restored with CREATE OR REPLACE.
export const OPERATIONS_COMMERCE_STORE_SYNC_REWRITTEN_FUNCTION_HEALTH_SQL =
  String.raw`
  (
    WITH required_function(signature) AS (
      VALUES
        ('public.operations_commerce_store_sync_effective_reason(uuid,uuid)'),
        ('public.operations_commerce_store_sync_is_running(uuid,uuid)'),
        ('public.operations_commerce_provider_read_authority_is_current(uuid,uuid,text)'),
        ('public.operations_commerce_product_image_read_authority_is_current(uuid,uuid,text,integer,text)'),
        ('public.guard_operations_commerce_product_image_read_authority()'),
        ('public.guard_operations_commerce_store_sync_read_lease()'),
        ('public.seed_operations_commerce_store_sync_control()'),
        ('public.protect_commerce_order_sync_session_lineage()'),
        ('public.protect_commerce_order_observation_lineage()'),
        ('public.commerce_order_observation_accepts_children(uuid,uuid)'),
        ('public.protect_shopify_order_webhook_read()'),
        ('public.protect_shopify_order_webhook_target()'),
        ('public.guard_operations_commerce_product_image_binding()'),
        ('public.protect_operations_commerce_store_sync_receipt()'),
        ('public.validate_operations_commerce_store_sync_identity()'),
        ('public.operations_shopify_inventory_read_config_is_ready(uuid,uuid)'),
        ('public.operations_commerce_product_image_account_is_current(uuid,uuid,text,integer)'),
        ('public.operations_commerce_product_image_account_lineage_is_current(uuid,uuid,text,integer)'),
        ('public.operations_commerce_product_image_mapping_targets(uuid,uuid,text,text)'),
        ('public.operations_commerce_product_image_job_fences_are_current(uuid,uuid)'),
        ('public.operations_commerce_product_image_projection_fences_are_current(uuid,uuid)')
    )
    SELECT pg_catalog.count(*) OPERATOR(pg_catalog.=) 21
      AND pg_catalog.count(installed_function.oid) OPERATOR(pg_catalog.=) 21
      AND pg_catalog.encode(
        public.digest(
          pg_catalog.convert_to(
            pg_catalog.string_agg(
              pg_catalog.concat_ws(
                '|',
                required_function.signature,
                pg_catalog.btrim(pg_catalog.regexp_replace(
                  installed_function.prosrc,
                  '[[:space:]]+', ' ', 'g'
                )),
                installed_language.lanname,
                installed_function.provolatile::text,
                installed_function.proisstrict::text,
                installed_function.prosecdef::text,
                installed_function.proleakproof::text,
                installed_function.proparallel::text,
                COALESCE(
                  pg_catalog.array_to_string(
                    installed_function.proconfig,
                    ','
                  ),
                  ''
                ),
                pg_catalog.pg_get_function_result(installed_function.oid)
              ),
              pg_catalog.chr(10) ORDER BY required_function.signature
            ),
            'UTF8'
          ),
          'sha256'
        ),
        'hex'
      ) OPERATOR(pg_catalog.=)
        CASE WHEN EXISTS (
          SELECT 1 FROM public.schema_migrations
          WHERE filename =
            '0350_operations_commerce_order_history_exclusions.sql'
            AND checksum =
              '76335d56e966a7f6fe7959401df7345e98e76c342824261b55a4a25e93781369'
        ) THEN
          '08c6612ba7b6c776646f48601f6ac37cb77afde842b196c6fcc3b4372bd444f0'
        WHEN EXISTS (
          SELECT 1 FROM public.schema_migrations
          WHERE filename =
            '0348_operations_commerce_native_activity_evidence.sql'
            AND checksum =
              '082763c4db98dd3c53498b3e35c57edc7dbddec1ee4b7568040e14aab29efaee'
        ) THEN
          '895eb8a49a4c574608eb78a4c7b81d6120153139cc1fc9e568fbffc09f2d1db5'
        WHEN EXISTS (
          SELECT 1 FROM public.schema_migrations
          WHERE filename =
            '0341_operations_faire_order_workbench_exact_history.sql'
            AND checksum =
              '10fc19cc5a8b52d9ee8d48bde8d2773a6ead8325182d8c64ad2c852815529eb1'
        ) THEN
          '354a02eca72636fc7f298f7a7438bbd043340072507503a11dd12e949185304e'
        WHEN EXISTS (
          SELECT 1 FROM public.schema_migrations
          WHERE filename =
            '0340_operations_order_workbench_exact_history.sql'
            AND checksum =
              '1668f266ef3c628e71fa9b75e120f086ffcbd4e40e6fe3ee42c9a39386db297e'
        ) THEN
          '83c2a275eacb5131cad13fc4f6c296b24fde4a56e1eda5d3f0e8057ffa0f1b81'
        WHEN EXISTS (
          SELECT 1 FROM public.schema_migrations
          WHERE filename =
            '0314_operations_local_work_independent_activation.sql'
            AND checksum =
              '2c69fa93d265ced3a0019cc5f5b6770ae2890146e4bc00d213d9b67ae18d7d3c'
        ) THEN
          '1d86f5c2c2693c949e6de870e0e1f93af2dc5c5b8aa306349c11291e82d6e78f'
        ELSE
          'bb66159fdec700a84c7dccd76088b9052f107f78cf604bb43dbd95163513e2b6'
        END
    FROM required_function
    LEFT JOIN pg_catalog.pg_proc installed_function
      ON installed_function.oid OPERATOR(pg_catalog.=)
        pg_catalog.to_regprocedure(
        required_function.signature
      )
    LEFT JOIN pg_catalog.pg_language installed_language
      ON installed_language.oid OPERATOR(pg_catalog.=)
        installed_function.prolang
  )
`

// Pin every control/receipt constraint and every unique index, including the
// exact constrained key order. Count/type checks do not detect a same-named
// CHECK (true) replacement or a re-keyed unique index.
export const OPERATIONS_COMMERCE_STORE_SYNC_STRUCTURE_HEALTH_SQL = String.raw`
  (
    (
      SELECT pg_catalog.encode(
        public.digest(
          pg_catalog.convert_to(
            pg_catalog.string_agg(
              pg_catalog.concat_ws(
                '|',
                installed_table.relname,
                installed_constraint.conname,
                installed_constraint.contype::text,
                installed_constraint.convalidated::text,
                installed_constraint.confdeltype::text,
                installed_constraint.confupdtype::text,
                canonical_constraint.definition
              ),
              pg_catalog.chr(10) ORDER BY
                installed_table.relname,
                installed_constraint.conname
            ),
            'UTF8'
          ),
          'sha256'
        ),
        'hex'
      )
      FROM pg_catalog.pg_constraint installed_constraint
      JOIN pg_catalog.pg_class installed_table
        ON installed_table.oid OPERATOR(pg_catalog.=)
          installed_constraint.conrelid
      JOIN pg_catalog.pg_namespace installed_namespace
        ON installed_namespace.oid OPERATOR(pg_catalog.=)
          installed_table.relnamespace
      CROSS JOIN LATERAL (
        SELECT pg_catalog.pg_get_constraintdef(
          installed_constraint.oid
        ) AS definition
      ) raw_constraint
      CROSS JOIN LATERAL (
        SELECT CASE
          WHEN installed_constraint.conname OPERATOR(pg_catalog.=)
                 'operations_commerce_store_sync_controls_account_fkey'
           AND COALESCE(
                 installed_constraint.confrelid OPERATOR(pg_catalog.=)
                   pg_catalog.to_regclass(
                     'public.operations_integration_accounts'
                   ),
                 false
               ) IS NOT TRUE
            THEN '<unexpected-reference-binding>' OPERATOR(pg_catalog.||)
              raw_constraint.definition
          WHEN installed_constraint.conname OPERATOR(pg_catalog.=) ANY (
                 ARRAY[
                   'operations_commerce_store_sync_receipts_account_fkey',
                   'operations_commerce_store_sync_read_leases_account_fkey'
                 ]::pg_catalog.text[]
               )
           AND COALESCE(
                 installed_constraint.confrelid OPERATOR(pg_catalog.=)
                   pg_catalog.to_regclass(
                     'public.operations_commerce_store_sync_controls'
                   ),
                 false
               ) IS NOT TRUE
            THEN '<unexpected-reference-binding>' OPERATOR(pg_catalog.||)
              raw_constraint.definition
          WHEN installed_constraint.conname OPERATOR(pg_catalog.=)
                 'operations_commerce_store_sync_controls_account_fkey'
            THEN pg_catalog.replace(
              raw_constraint.definition,
              'REFERENCES public.operations_integration_accounts',
              'REFERENCES operations_integration_accounts'
            )
          WHEN installed_constraint.conname OPERATOR(pg_catalog.=) ANY (
                 ARRAY[
                   'operations_commerce_store_sync_receipts_account_fkey',
                   'operations_commerce_store_sync_read_leases_account_fkey'
                 ]::pg_catalog.text[]
               )
            THEN pg_catalog.replace(
              raw_constraint.definition,
              'REFERENCES public.operations_commerce_store_sync_controls',
              'REFERENCES operations_commerce_store_sync_controls'
            )
          ELSE raw_constraint.definition
        END AS definition
      ) reference_normalized_constraint
      CROSS JOIN LATERAL (
        SELECT CASE
          WHEN pg_catalog.strpos(
                 reference_normalized_constraint.definition,
                 'length('
               ) OPERATOR(pg_catalog.>) 0
            THEN CASE
              WHEN pg_catalog.strpos(
                     installed_constraint.conbin::pg_catalog.text,
                     ':funcid '
                       OPERATOR(pg_catalog.||) pg_catalog.to_regprocedure(
                         'pg_catalog.length(text)'
                       )::pg_catalog.oid::pg_catalog.text
                       OPERATOR(pg_catalog.||) ' '
                   ) OPERATOR(pg_catalog.>) 0
                THEN pg_catalog.replace(
                  reference_normalized_constraint.definition,
                  'pg_catalog.length(',
                  'length('
                )
              ELSE '<unexpected-length-binding>' OPERATOR(pg_catalog.||)
                reference_normalized_constraint.definition
            END
          ELSE reference_normalized_constraint.definition
        END AS definition
      ) length_normalized_constraint
      CROSS JOIN LATERAL (
        SELECT CASE
          WHEN pg_catalog.strpos(
                 length_normalized_constraint.definition,
                 'btrim('
               ) OPERATOR(pg_catalog.>) 0
            THEN CASE
              WHEN pg_catalog.strpos(
                     installed_constraint.conbin::pg_catalog.text,
                     ':funcid '
                       OPERATOR(pg_catalog.||) pg_catalog.to_regprocedure(
                         'pg_catalog.btrim(text)'
                       )::pg_catalog.oid::pg_catalog.text
                       OPERATOR(pg_catalog.||) ' '
                   ) OPERATOR(pg_catalog.>) 0
                THEN pg_catalog.replace(
                  length_normalized_constraint.definition,
                  'pg_catalog.btrim(',
                  'btrim('
                )
              ELSE '<unexpected-btrim-binding>' OPERATOR(pg_catalog.||)
                length_normalized_constraint.definition
            END
          ELSE length_normalized_constraint.definition
        END AS definition
      ) btrim_normalized_constraint
      CROSS JOIN LATERAL (
        SELECT CASE
          WHEN pg_catalog.strpos(
                 btrim_normalized_constraint.definition,
                 'jsonb_typeof('
               ) OPERATOR(pg_catalog.>) 0
            THEN CASE
              WHEN pg_catalog.strpos(
                     installed_constraint.conbin::pg_catalog.text,
                     ':funcid '
                       OPERATOR(pg_catalog.||) pg_catalog.to_regprocedure(
                         'pg_catalog.jsonb_typeof(jsonb)'
                       )::pg_catalog.oid::pg_catalog.text
                       OPERATOR(pg_catalog.||) ' '
                   ) OPERATOR(pg_catalog.>) 0
                THEN pg_catalog.replace(
                  btrim_normalized_constraint.definition,
                  'pg_catalog.jsonb_typeof(',
                  'jsonb_typeof('
                )
              ELSE '<unexpected-jsonb-typeof-binding>'
                OPERATOR(pg_catalog.||) btrim_normalized_constraint.definition
            END
          ELSE btrim_normalized_constraint.definition
        END AS definition
      ) canonical_constraint
      WHERE installed_namespace.nspname OPERATOR(pg_catalog.=) 'public'
        -- PostgreSQL 18 exposes NOT NULL column metadata as contype = 'n'
        -- rows in pg_constraint. Nullability is pinned independently by the
        -- exact column catalog below, so keep this cross-version constraint
        -- hash scoped to the table constraints it was designed to attest.
        AND installed_constraint.contype OPERATOR(pg_catalog.<>) 'n'
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
            AND installed_constraint.contype OPERATOR(pg_catalog.=) 'c'
            AND position(
              'provider_read_authority'
              IN raw_constraint.definition
            ) OPERATOR(pg_catalog.>) 0
          )
        )
    ) OPERATOR(pg_catalog.=)
      CASE WHEN EXISTS (
        SELECT 1 FROM public.schema_migrations
        WHERE filename =
          '0350_operations_commerce_order_history_exclusions.sql'
          AND checksum =
            '76335d56e966a7f6fe7959401df7345e98e76c342824261b55a4a25e93781369'
      ) THEN
        '781547ec55717096d63670bc1e72b5b14705e8a26c7f3f614e7ce11ceb6a123f'
      ELSE
        'a28138f13bf3b2eaf60624e9efb6e7fff669032bcf27043adff648b2d82528da'
      END
    -- pg_get_constraintdef() is intentionally human-readable and does not
    -- expose bound operator OIDs. Resolve every parsed CHECK operator to stable
    -- namespace/type/procedure identities, so byte-identical text rebound to
    -- an attacker operator fails closed without pinning cluster-local OIDs.
    AND (
      SELECT pg_catalog.count(*) OPERATOR(pg_catalog.=)
          CASE WHEN EXISTS (
            SELECT 1 FROM public.schema_migrations
            WHERE filename =
              '0350_operations_commerce_order_history_exclusions.sql'
              AND checksum =
                '76335d56e966a7f6fe7959401df7345e98e76c342824261b55a4a25e93781369'
          ) THEN 45 ELSE 37 END
        AND pg_catalog.encode(
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
        ) OPERATOR(pg_catalog.=)
          CASE WHEN EXISTS (
            SELECT 1 FROM public.schema_migrations
            WHERE filename =
              '0350_operations_commerce_order_history_exclusions.sql'
              AND checksum =
                '76335d56e966a7f6fe7959401df7345e98e76c342824261b55a4a25e93781369'
          ) THEN
            'b8dcf5dd48bc901d4217f554d1fe58a20537e3f97b10d1990947747d69f4a3d9'
          ELSE
            '724e0c8f03f49d3f9664948070f811a28a9dbeea2b6a60bd6c12d28d8c33b3bc'
          END
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
        ON result_type.oid OPERATOR(pg_catalog.=)
          installed_operator.oprresult
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
                  pg_catalog.pg_get_constraintdef(
                    installed_constraint.oid
                  ),
                  'provider_read_authority'
                ) OPERATOR(pg_catalog.>) 0
          )
        )
    )
    AND (
      SELECT pg_catalog.encode(
        public.digest(
          pg_catalog.convert_to(
            pg_catalog.string_agg(
              pg_catalog.concat_ws(
                '|',
                installed_table.relname,
                installed_index_class.relname,
                installed_index.indisprimary::text,
                installed_index.indisunique::text,
                installed_index.indisvalid::text,
                installed_index.indisready::text,
                installed_index.indkey::text,
                pg_catalog.pg_get_indexdef(installed_index.indexrelid)
              ),
              pg_catalog.chr(10) ORDER BY
                installed_table.relname,
                installed_index_class.relname
            ),
            'UTF8'
          ),
          'sha256'
        ),
        'hex'
      )
      FROM pg_catalog.pg_index installed_index
      JOIN pg_catalog.pg_class installed_table
        ON installed_table.oid OPERATOR(pg_catalog.=)
          installed_index.indrelid
      JOIN pg_catalog.pg_class installed_index_class
        ON installed_index_class.oid OPERATOR(pg_catalog.=)
          installed_index.indexrelid
      JOIN pg_catalog.pg_namespace installed_namespace
        ON installed_namespace.oid OPERATOR(pg_catalog.=)
          installed_table.relnamespace
      WHERE installed_namespace.nspname OPERATOR(pg_catalog.=) 'public'
        AND installed_index.indrelid OPERATOR(pg_catalog.=) ANY (
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
    ) OPERATOR(pg_catalog.=)
      '05e6f2a2a4ea7612265a6063c89670f73aa5030a26ddffe80601ba24fd310498'
    -- The first rollout retains automatic defaults for old-runtime inserts;
    -- the next rollout removes all three together. No mixed state is healthy.
    AND (
      (
        SELECT pg_catalog.encode(
        public.digest(
          pg_catalog.convert_to(
            pg_catalog.string_agg(
              pg_catalog.concat_ws(
                '|',
                table_name,
                column_name,
                ordinal_position::text,
                data_type,
                udt_schema,
                udt_name,
                is_nullable,
                COALESCE(
                  CASE
                    WHEN table_name OPERATOR(pg_catalog.=)
                           'operations_commerce_store_sync_change_receipts'
                     AND column_name OPERATOR(pg_catalog.=) 'id'
                     AND column_default OPERATOR(pg_catalog.=) ANY (
                       ARRAY[
                         'gen_random_uuid()',
                         'public.gen_random_uuid()'
                       ]::pg_catalog.text[]
                     )
                      THEN CASE
                        WHEN EXISTS (
                          SELECT 1
                          FROM pg_catalog.pg_attrdef installed_default
                          WHERE installed_default.adrelid
                                  OPERATOR(pg_catalog.=)
                                  pg_catalog.to_regclass(
                                    pg_catalog.concat('public.', table_name)
                                  )
                            AND installed_default.adnum OPERATOR(pg_catalog.=)
                                  ordinal_position
                            AND pg_catalog.strpos(
                                  installed_default.adbin::pg_catalog.text,
                                  ':funcid '
                                    OPERATOR(pg_catalog.||)
                                      pg_catalog.to_regprocedure(
                                      'public.gen_random_uuid()'
                                    )::pg_catalog.oid::pg_catalog.text
                                    OPERATOR(pg_catalog.||) ' '
                                ) OPERATOR(pg_catalog.>) 0
                        )
                          THEN 'public.gen_random_uuid()'
                        ELSE '<unexpected-gen-random-binding>'
                          OPERATOR(pg_catalog.||) column_default
                      END
                    WHEN column_default OPERATOR(pg_catalog.=) ANY (
                           ARRAY[
                             'now()',
                             'pg_catalog.now()'
                           ]::pg_catalog.text[]
                         )
                      THEN CASE
                        WHEN EXISTS (
                          SELECT 1
                          FROM pg_catalog.pg_attrdef installed_default
                          WHERE installed_default.adrelid
                                  OPERATOR(pg_catalog.=)
                                  pg_catalog.to_regclass(
                                    pg_catalog.concat('public.', table_name)
                                  )
                            AND installed_default.adnum OPERATOR(pg_catalog.=)
                                  ordinal_position
                            AND pg_catalog.strpos(
                                  installed_default.adbin::pg_catalog.text,
                                  ':funcid '
                                    OPERATOR(pg_catalog.||)
                                      pg_catalog.to_regprocedure(
                                      'pg_catalog.now()'
                                    )::pg_catalog.oid::pg_catalog.text
                                    OPERATOR(pg_catalog.||) ' '
                                ) OPERATOR(pg_catalog.>) 0
                        )
                          THEN 'now()'
                        ELSE '<unexpected-now-binding>'
                          OPERATOR(pg_catalog.||) column_default
                      END
                    ELSE column_default
                  END,
                  '<null>'
                ),
                is_identity,
                COALESCE(identity_generation, '<null>'),
                is_generated,
                COALESCE(generation_expression, '<null>'),
                COALESCE(collation_schema, '<null>'),
                COALESCE(collation_name, '<null>'),
                COALESCE(character_maximum_length::text, '<null>'),
                COALESCE(numeric_precision::text, '<null>'),
                COALESCE(numeric_scale::text, '<null>'),
                COALESCE(datetime_precision::text, '<null>')
              ),
              pg_catalog.chr(10) ORDER BY table_name, column_name
            ),
            'UTF8'
          ),
          'sha256'
        ),
        'hex'
      )
      FROM information_schema.columns
      WHERE table_schema OPERATOR(pg_catalog.=) 'public'
        AND (
          table_name OPERATOR(pg_catalog.=) ANY (
            ARRAY[
              'operations_commerce_store_sync_controls',
              'operations_commerce_store_sync_change_receipts',
              'operations_commerce_store_sync_read_leases'
            ]::pg_catalog.text[]
          )
          OR (
            table_name OPERATOR(pg_catalog.=) ANY (
              ARRAY[
                'operations_commerce_intake_read_intents',
                'operations_commerce_product_image_observation_sets',
                'operations_commerce_product_image_import_jobs'
              ]::pg_catalog.text[]
            )
            AND column_name OPERATOR(pg_catalog.=)
                  'provider_read_authority'
          )
        )
      ) OPERATOR(pg_catalog.=)
        CASE WHEN EXISTS (
          SELECT 1 FROM public.schema_migrations
          WHERE filename =
            '0350_operations_commerce_order_history_exclusions.sql'
            AND checksum =
              '76335d56e966a7f6fe7959401df7345e98e76c342824261b55a4a25e93781369'
        ) THEN
          '790b37421ad6764a8b8990cab88b8756a59b9032e279c1647627d3cce2bddb1a'
        ELSE
          'd8a27f153b77f54154bc82a5f28dbcb97c064d915500bdb6fcbff643b1608a66'
        END
      AND NOT EXISTS (
        SELECT 1
        FROM public.schema_migrations
        WHERE filename OPERATOR(pg_catalog.=)
          '0305_operations_commerce_rollout_contract.sql'
      )
      OR (
        (
        SELECT pg_catalog.encode(
          public.digest(
            pg_catalog.convert_to(
              pg_catalog.string_agg(
                pg_catalog.concat_ws(
                  '|',
                  table_name,
                  column_name,
                  ordinal_position::text,
                  data_type,
                  udt_schema,
                  udt_name,
                  is_nullable,
                  COALESCE(
                    CASE
                      WHEN table_name OPERATOR(pg_catalog.=)
                             'operations_commerce_store_sync_change_receipts'
                       AND column_name OPERATOR(pg_catalog.=) 'id'
                       AND column_default OPERATOR(pg_catalog.=) ANY (
                         ARRAY[
                           'gen_random_uuid()',
                           'public.gen_random_uuid()'
                         ]::pg_catalog.text[]
                       )
                        THEN CASE
                          WHEN EXISTS (
                            SELECT 1
                            FROM pg_catalog.pg_attrdef installed_default
                            WHERE installed_default.adrelid
                                    OPERATOR(pg_catalog.=)
                                    pg_catalog.to_regclass(
                                      pg_catalog.concat('public.', table_name)
                                    )
                              AND installed_default.adnum
                                    OPERATOR(pg_catalog.=) ordinal_position
                              AND pg_catalog.strpos(
                                    installed_default.adbin::pg_catalog.text,
                                    ':funcid '
                                      OPERATOR(pg_catalog.||)
                                        pg_catalog.to_regprocedure(
                                        'public.gen_random_uuid()'
                                      )::pg_catalog.oid::pg_catalog.text
                                      OPERATOR(pg_catalog.||) ' '
                                  ) OPERATOR(pg_catalog.>) 0
                          )
                            THEN 'public.gen_random_uuid()'
                          ELSE '<unexpected-gen-random-binding>'
                            OPERATOR(pg_catalog.||) column_default
                        END
                      WHEN column_default OPERATOR(pg_catalog.=) ANY (
                             ARRAY[
                               'now()',
                               'pg_catalog.now()'
                             ]::pg_catalog.text[]
                           )
                        THEN CASE
                          WHEN EXISTS (
                            SELECT 1
                            FROM pg_catalog.pg_attrdef installed_default
                            WHERE installed_default.adrelid
                                    OPERATOR(pg_catalog.=)
                                    pg_catalog.to_regclass(
                                      pg_catalog.concat('public.', table_name)
                                    )
                              AND installed_default.adnum
                                    OPERATOR(pg_catalog.=) ordinal_position
                              AND pg_catalog.strpos(
                                    installed_default.adbin::pg_catalog.text,
                                    ':funcid '
                                      OPERATOR(pg_catalog.||)
                                        pg_catalog.to_regprocedure(
                                        'pg_catalog.now()'
                                      )::pg_catalog.oid::pg_catalog.text
                                      OPERATOR(pg_catalog.||) ' '
                                  ) OPERATOR(pg_catalog.>) 0
                          )
                            THEN 'now()'
                          ELSE '<unexpected-now-binding>'
                            OPERATOR(pg_catalog.||) column_default
                        END
                      ELSE column_default
                    END,
                    '<null>'
                  ),
                  is_identity,
                  COALESCE(identity_generation, '<null>'),
                  is_generated,
                  COALESCE(generation_expression, '<null>'),
                  COALESCE(collation_schema, '<null>'),
                  COALESCE(collation_name, '<null>'),
                  COALESCE(character_maximum_length::text, '<null>'),
                  COALESCE(numeric_precision::text, '<null>'),
                  COALESCE(numeric_scale::text, '<null>'),
                  COALESCE(datetime_precision::text, '<null>')
                ),
                pg_catalog.chr(10) ORDER BY table_name, column_name
              ),
              'UTF8'
            ),
            'sha256'
          ),
          'hex'
        )
        FROM information_schema.columns
        WHERE table_schema OPERATOR(pg_catalog.=) 'public'
          AND (
            table_name OPERATOR(pg_catalog.=) ANY (
              ARRAY[
                'operations_commerce_store_sync_controls',
                'operations_commerce_store_sync_change_receipts',
                'operations_commerce_store_sync_read_leases'
              ]::pg_catalog.text[]
            )
            OR (
              table_name OPERATOR(pg_catalog.=) ANY (
                ARRAY[
                  'operations_commerce_intake_read_intents',
                  'operations_commerce_product_image_observation_sets',
                  'operations_commerce_product_image_import_jobs'
                ]::pg_catalog.text[]
              )
              AND column_name OPERATOR(pg_catalog.=)
                    'provider_read_authority'
            )
          )
        ) OPERATOR(pg_catalog.=)
          CASE WHEN EXISTS (
            SELECT 1 FROM public.schema_migrations
            WHERE filename =
              '0350_operations_commerce_order_history_exclusions.sql'
              AND checksum =
                '76335d56e966a7f6fe7959401df7345e98e76c342824261b55a4a25e93781369'
          ) THEN
            '94207eb17485a62b79d0de6a847797a9948ec85d008dbe42c48cfb9ddeffc596'
          ELSE
            '4abf9b4700d86b2cd84eab60bd59ca5935531dad5ee7566979d93a0612c3ef71'
          END
        AND EXISTS (
          SELECT 1
          FROM public.schema_migrations
          WHERE filename OPERATOR(pg_catalog.=)
              '0305_operations_commerce_rollout_contract.sql'
            AND checksum OPERATOR(pg_catalog.=)
              'e5ad3008d637149bc5e1d86f6d4345c6aa42d50420f0af09afae312f32f8145b'
        )
      )
    )
    AND (
      SELECT pg_catalog.count(*) OPERATOR(pg_catalog.=)
          CASE WHEN EXISTS (
            SELECT 1 FROM public.schema_migrations
            WHERE filename =
              '0350_operations_commerce_order_history_exclusions.sql'
              AND checksum =
                '76335d56e966a7f6fe7959401df7345e98e76c342824261b55a4a25e93781369'
          ) THEN 12 ELSE 11 END
        AND pg_catalog.encode(
          public.digest(
            pg_catalog.convert_to(
              pg_catalog.string_agg(
                pg_catalog.concat_ws(
                  '|',
                  trigger_namespace.nspname,
                  trigger_table.relname,
                  installed_trigger.tgname,
                  installed_trigger.tgtype::text,
                  installed_trigger.tgenabled::text,
                  installed_trigger.tgisinternal::text,
                  (
                    installed_trigger.tgconstraint
                      OPERATOR(pg_catalog.<>) 0
                  )::text,
                  installed_trigger.tgdeferrable::text,
                  installed_trigger.tginitdeferred::text,
                  pg_catalog.concat(
                    procedure_namespace.nspname,
                    '.',
                    installed_procedure.proname,
                    '(',
                    pg_catalog.pg_get_function_identity_arguments(
                      installed_procedure.oid
                    ),
                    ')'
                  ),
                  COALESCE(pg_catalog.pg_get_expr(
                    installed_trigger.tgqual,
                    installed_trigger.tgrelid
                  ), ''),
                  installed_trigger.tgattr::text
                ),
                pg_catalog.chr(10) ORDER BY
                  trigger_namespace.nspname,
                  trigger_table.relname,
                  installed_trigger.tgname
              ),
              'UTF8'
            ),
            'sha256'
          ),
          'hex'
        ) OPERATOR(pg_catalog.=)
          CASE WHEN EXISTS (
            SELECT 1 FROM public.schema_migrations
            WHERE filename =
              '0350_operations_commerce_order_history_exclusions.sql'
              AND checksum =
                '76335d56e966a7f6fe7959401df7345e98e76c342824261b55a4a25e93781369'
          ) THEN
            '80dd02356810339e89c53262a7b2a16371665da2ce7dbbcfc2585c4b02099196'
          ELSE
            '6a4c29744ed7377933b90739df8d35d30b8d168d4f195b1014ded507f0a5010a'
          END
      FROM pg_catalog.pg_trigger installed_trigger
      JOIN pg_catalog.pg_class trigger_table
        ON trigger_table.oid OPERATOR(pg_catalog.=)
          installed_trigger.tgrelid
      JOIN pg_catalog.pg_namespace trigger_namespace
        ON trigger_namespace.oid OPERATOR(pg_catalog.=)
          trigger_table.relnamespace
      JOIN pg_catalog.pg_proc installed_procedure
        ON installed_procedure.oid OPERATOR(pg_catalog.=)
          installed_trigger.tgfoid
      JOIN pg_catalog.pg_namespace procedure_namespace
        ON procedure_namespace.oid OPERATOR(pg_catalog.=)
          installed_procedure.pronamespace
      WHERE NOT installed_trigger.tgisinternal
        AND installed_trigger.tgfoid OPERATOR(pg_catalog.=) ANY (
          ARRAY[
            pg_catalog.to_regprocedure(
              'public.guard_operations_commerce_product_image_read_authority()'
            ),
            pg_catalog.to_regprocedure(
              'public.guard_operations_commerce_store_sync_read_lease()'
            ),
            pg_catalog.to_regprocedure(
              'public.seed_operations_commerce_store_sync_control()'
            ),
            pg_catalog.to_regprocedure(
              'public.protect_commerce_order_sync_session_lineage()'
            ),
            pg_catalog.to_regprocedure(
              'public.protect_commerce_order_observation_lineage()'
            ),
            pg_catalog.to_regprocedure(
              'public.protect_shopify_order_webhook_read()'
            ),
            pg_catalog.to_regprocedure(
              'public.protect_shopify_order_webhook_target()'
            ),
            pg_catalog.to_regprocedure(
              'public.guard_operations_commerce_product_image_binding()'
            ),
            pg_catalog.to_regprocedure(
              'public.protect_operations_commerce_store_sync_receipt()'
            ),
            pg_catalog.to_regprocedure(
              'public.validate_operations_commerce_store_sync_identity()'
            ),
            pg_catalog.to_regprocedure(
              'public.guard_commerce_order_history_lease_exclusion()'
            )
          ]::pg_catalog.oid[]
        )
    )
    AND (
      NOT EXISTS (
        SELECT 1 FROM public.schema_migrations
        WHERE filename =
          '0350_operations_commerce_order_history_exclusions.sql'
      )
      OR (
        EXISTS (
          SELECT 1 FROM public.schema_migrations
          WHERE filename =
            '0350_operations_commerce_order_history_exclusions.sql'
            AND checksum =
              '76335d56e966a7f6fe7959401df7345e98e76c342824261b55a4a25e93781369'
        )
        AND COALESCE((
          SELECT
            pg_catalog.encode(
              public.digest(
                pg_catalog.convert_to(
                  pg_catalog.btrim(pg_catalog.regexp_replace(
                    installed_function.prosrc,
                    '[[:space:]]+', ' ', 'g'
                  )),
                  'UTF8'
                ),
                'sha256'
              ),
              'hex'
            ) OPERATOR(pg_catalog.=)
              'd292cec75ea5790d80b985e179f043245f33744bd71ac10036b578681e0f83be'
            AND installed_language.lanname OPERATOR(pg_catalog.=) 'plpgsql'
            AND installed_function.provolatile OPERATOR(pg_catalog.=) 'v'
            AND pg_catalog.pg_get_function_result(installed_function.oid)
                  OPERATOR(pg_catalog.=) 'trigger'
            AND installed_function.prokind OPERATOR(pg_catalog.=) 'f'
            AND NOT installed_function.proisstrict
            AND NOT installed_function.prosecdef
            AND NOT installed_function.proleakproof
            AND installed_function.proparallel OPERATOR(pg_catalog.=) 'u'
            AND installed_function.proconfig OPERATOR(pg_catalog.=) ARRAY[
              'search_path=pg_catalog, public, pg_temp'
            ]::text[]
          FROM pg_catalog.pg_proc installed_function
          JOIN pg_catalog.pg_language installed_language
            ON installed_language.oid OPERATOR(pg_catalog.=)
              installed_function.prolang
          WHERE installed_function.oid OPERATOR(pg_catalog.=)
            pg_catalog.to_regprocedure(
              'public.guard_commerce_order_history_lease_exclusion()'
            )
        ), false)
      )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.operations_commerce_store_sync_read_leases lease
      WHERE lease.released_at IS NULL
        AND lease.expires_at OPERATOR(pg_catalog.<=)
              pg_catalog.clock_timestamp()
    )
  )
`

// The authority-column rollout phase is safe to expose only when the complete
// Store-sync function and structure contracts agree with the exact migration
// ledger. Checking defaults alone would advertise a healthy overlap after a
// function, trigger, constraint, or metadata tamper.
export const OPERATIONS_COMMERCE_STORE_SYNC_AUTHORITY_CONTRACT_SQL = String.raw`
  (
    WITH store_sync_health AS (
      SELECT
        ${OPERATIONS_COMMERCE_STORE_SYNC_FUNCTION_HEALTH_SQL}
          AS function_healthy,
        ${OPERATIONS_COMMERCE_STORE_SYNC_REWRITTEN_FUNCTION_HEALTH_SQL}
          AS rewritten_function_healthy,
        ${OPERATIONS_COMMERCE_STORE_SYNC_STRUCTURE_HEALTH_SQL}
          AS structure_healthy
    ), authority_default_catalog AS (
      SELECT
        pg_catalog.count(
          installed_attribute.attrelid
        ) AS installed_column_count,
        pg_catalog.count(installed_default.oid) AS installed_default_count,
        pg_catalog.bool_and(COALESCE(
          pg_catalog.pg_get_expr(
            installed_default.adbin,
            installed_default.adrelid
          ) OPERATOR(pg_catalog.=) '''automatic''::text',
          false
        )) AS exact_automatic_defaults
      FROM (VALUES
        ('operations_commerce_intake_read_intents',
          'provider_read_authority'),
        ('operations_commerce_product_image_observation_sets',
          'provider_read_authority'),
        ('operations_commerce_product_image_import_jobs',
          'provider_read_authority')
      ) AS required_default(table_name, column_name)
      LEFT JOIN pg_catalog.pg_class installed_table
        ON installed_table.oid OPERATOR(pg_catalog.=) pg_catalog.to_regclass(
          pg_catalog.concat('public.', required_default.table_name)
        )
      LEFT JOIN pg_catalog.pg_namespace installed_namespace
        ON installed_namespace.oid OPERATOR(pg_catalog.=)
          installed_table.relnamespace
       AND installed_namespace.nspname OPERATOR(pg_catalog.=) 'public'
      LEFT JOIN pg_catalog.pg_attribute installed_attribute
        ON installed_attribute.attrelid OPERATOR(pg_catalog.=)
          installed_table.oid
       AND installed_namespace.oid IS NOT NULL
       AND installed_attribute.attname OPERATOR(pg_catalog.=)
          required_default.column_name
       AND installed_attribute.attnum OPERATOR(pg_catalog.>) 0
       AND NOT installed_attribute.attisdropped
      LEFT JOIN pg_catalog.pg_attrdef installed_default
        ON installed_default.adrelid OPERATOR(pg_catalog.=)
          installed_attribute.attrelid
       AND installed_default.adnum OPERATOR(pg_catalog.=)
          installed_attribute.attnum
    )
    SELECT CASE
      WHEN EXISTS (
        SELECT 1
        FROM public.schema_migrations
        WHERE filename OPERATOR(pg_catalog.=)
          '0298_operations_commerce_store_sync_controls.sql'
          AND checksum OPERATOR(pg_catalog.=)
            'e3eb479cc613479a09081bb6f22d2344ce74540f86595a020dfdbd711cfb1abd'
      )
        AND store_sync_health.function_healthy
        AND store_sync_health.rewritten_function_healthy
        AND store_sync_health.structure_healthy
        AND authority_default_catalog.installed_column_count
              OPERATOR(pg_catalog.=) 3
        AND authority_default_catalog.installed_default_count
              OPERATOR(pg_catalog.=) 3
        AND authority_default_catalog.exact_automatic_defaults
        AND NOT EXISTS (
          SELECT 1
          FROM public.schema_migrations
          WHERE filename OPERATOR(pg_catalog.=)
            '0305_operations_commerce_rollout_contract.sql'
        )
        THEN 'legacy-writer-compatible'
      WHEN EXISTS (
        SELECT 1
        FROM public.schema_migrations
        WHERE filename OPERATOR(pg_catalog.=)
          '0305_operations_commerce_rollout_contract.sql'
          AND checksum OPERATOR(pg_catalog.=)
            'e5ad3008d637149bc5e1d86f6d4345c6aa42d50420f0af09afae312f32f8145b'
      )
        AND store_sync_health.function_healthy
        AND store_sync_health.rewritten_function_healthy
        AND store_sync_health.structure_healthy
        AND authority_default_catalog.installed_column_count
              OPERATOR(pg_catalog.=) 3
        AND authority_default_catalog.installed_default_count
              OPERATOR(pg_catalog.=) 0
        THEN 'strict-explicit'
      ELSE 'invalid'
    END
    FROM store_sync_health
    CROSS JOIN authority_default_catalog
  )
`
