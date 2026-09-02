#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import {
  actorEmail,
  applyMigration,
  command,
  migrations,
  waitForPostgres,
} from './test-commerce-order-revisions-postgres.mjs'

const root = process.cwd()
const disposablePostgresImage = String(
  process.env.CLAWPILOT_TEST_POSTGRES_IMAGE || 'pgvector/pgvector:pg16',
).trim()
assert.ok(
  [
    'pgvector/pgvector:pg16',
    'pgvector/pgvector:pg18',
  ].includes(disposablePostgresImage),
  'CLAWPILOT_TEST_POSTGRES_IMAGE must select the exact pg16 or pg18 image',
)
const futureCommerceRolloutContractMigration = readFileSync(
  resolve(
    root,
    'scripts/fixtures/0305_operations_commerce_rollout_contract.sql',
  ),
  'utf8',
)
const futureCommerceRolloutContractChecksum =
  createHash('sha256')
    .update(futureCommerceRolloutContractMigration)
    .digest('hex')
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const { Pool } = requireFromApp('pg')
const ts = requireFromApp('typescript')

const {
  OPERATIONS_COMMERCE_STORE_SYNC_AUTHORITY_CONTRACT_SQL,
  OPERATIONS_COMMERCE_STORE_SYNC_FUNCTION_HEALTH_SQL,
  OPERATIONS_COMMERCE_STORE_SYNC_REWRITTEN_FUNCTION_HEALTH_SQL,
  OPERATIONS_COMMERCE_STORE_SYNC_STRUCTURE_HEALTH_SQL,
} = loadTypeScript(
  'app_src/lib/persistence/commerceStoreSyncHealth.ts',
)

function loadTypeScript(path, mocks = {}) {
  const output = ts.transpileModule(
    readFileSync(resolve(root, path), 'utf8'),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
      fileName: path,
    },
  ).outputText
  const module = { exports: {} }
  vm.runInNewContext(output, {
    Buffer,
    Date,
    Error,
    JSON,
    Map,
    Math,
    Number,
    Object,
    Promise,
    RegExp,
    Set,
    String,
    URL,
    console,
    exports: module.exports,
    module,
    process,
    setInterval,
    clearInterval,
    require(specifier) {
      if (Object.prototype.hasOwnProperty.call(mocks, specifier)) {
        return mocks[specifier]
      }
      return requireFromApp(specifier)
    },
  }, { filename: path })
  return module.exports
}

function postgresAdapter(pool) {
  return {
    query(text, values = []) {
      return pool.query(text, values)
    },
    async withTransaction(work) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const result = await work(client)
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    },
    async acquireTransactionAdvisoryLock(client, key) {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
        [key],
      )
    },
  }
}

async function storeSyncFunctionHealth(client) {
  const result = await client.query(
    `SELECT ${OPERATIONS_COMMERCE_STORE_SYNC_FUNCTION_HEALTH_SQL} AS healthy`,
  )
  return result.rows[0]?.healthy === true
}

async function storeSyncStructureHealth(client) {
  const result = await client.query(
    `SELECT ${OPERATIONS_COMMERCE_STORE_SYNC_STRUCTURE_HEALTH_SQL} AS healthy`,
  )
  return result.rows[0]?.healthy === true
}

async function storeSyncRewrittenFunctionHealth(client) {
  const result = await client.query(
    `SELECT ${OPERATIONS_COMMERCE_STORE_SYNC_REWRITTEN_FUNCTION_HEALTH_SQL}
       AS healthy`,
  )
  return result.rows[0]?.healthy === true
}

async function storeSyncAuthorityContract(client) {
  const result = await client.query(
    `SELECT ${OPERATIONS_COMMERCE_STORE_SYNC_AUTHORITY_CONTRACT_SQL}
       AS phase`,
  )
  return result.rows[0]?.phase
}

async function readStoreSyncOperatorBindingCatalog(client) {
  const result = await client.query(
    `SELECT pg_catalog.count(*)::integer AS binding_count,
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
                        left_type_namespace.nspname || '.'
                          || left_type.typname,
                        '<none>'
                      ),
                      COALESCE(
                        right_type_namespace.nspname || '.'
                          || right_type.typname,
                        '<none>'
                      ),
                      result_type_namespace.nspname || '.'
                        || result_type.typname,
                      procedure_namespace.nspname || '.'
                        || installed_procedure.proname,
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
            ) AS binding_hash
     FROM pg_catalog.pg_constraint installed_constraint
     JOIN pg_catalog.pg_class installed_table
       ON installed_table.oid = installed_constraint.conrelid
     JOIN pg_catalog.pg_namespace installed_namespace
       ON installed_namespace.oid = installed_table.relnamespace
     CROSS JOIN LATERAL pg_catalog.regexp_matches(
       installed_constraint.conbin::pg_catalog.text,
       ':opno ([0-9]+)',
       'g'
     ) WITH ORDINALITY AS bound_operator(oid_match, binding_ordinal)
     JOIN pg_catalog.pg_operator installed_operator
       ON installed_operator.oid =
            bound_operator.oid_match[1]::pg_catalog.oid
     JOIN pg_catalog.pg_namespace operator_namespace
       ON operator_namespace.oid = installed_operator.oprnamespace
     LEFT JOIN pg_catalog.pg_type left_type
       ON left_type.oid = installed_operator.oprleft
      AND installed_operator.oprleft <> 0
     LEFT JOIN pg_catalog.pg_namespace left_type_namespace
       ON left_type_namespace.oid = left_type.typnamespace
     LEFT JOIN pg_catalog.pg_type right_type
       ON right_type.oid = installed_operator.oprright
      AND installed_operator.oprright <> 0
     LEFT JOIN pg_catalog.pg_namespace right_type_namespace
       ON right_type_namespace.oid = right_type.typnamespace
     JOIN pg_catalog.pg_type result_type
       ON result_type.oid = installed_operator.oprresult
     JOIN pg_catalog.pg_namespace result_type_namespace
       ON result_type_namespace.oid = result_type.typnamespace
     JOIN pg_catalog.pg_proc installed_procedure
       ON installed_procedure.oid = installed_operator.oprcode
     JOIN pg_catalog.pg_namespace procedure_namespace
       ON procedure_namespace.oid = installed_procedure.pronamespace
     WHERE installed_namespace.nspname = 'public'
       AND installed_constraint.contype = 'c'
       AND (
         installed_constraint.conrelid IN (
           pg_catalog.to_regclass(
             'public.operations_commerce_store_sync_controls'
           ),
           pg_catalog.to_regclass(
             'public.operations_commerce_store_sync_change_receipts'
           ),
           pg_catalog.to_regclass(
             'public.operations_commerce_store_sync_read_leases'
           )
         )
         OR (
           installed_constraint.conrelid IN (
             pg_catalog.to_regclass(
               'public.operations_commerce_intake_read_intents'
             ),
             pg_catalog.to_regclass(
               'public.operations_commerce_product_image_observation_sets'
             ),
             pg_catalog.to_regclass(
               'public.operations_commerce_product_image_import_jobs'
             )
           )
           AND pg_catalog.strpos(
                 pg_catalog.pg_get_constraintdef(
                   installed_constraint.oid
                 ),
                 'provider_read_authority'
               ) > 0
         )
       )`,
  )
  return result.rows[0]
}

async function readStoreSyncHealthCatalog(client) {
  const signatures = [
    'public.operations_commerce_store_sync_effective_reason(uuid,uuid)',
    'public.operations_commerce_store_sync_is_running(uuid,uuid)',
    'public.operations_commerce_provider_read_authority_is_current(uuid,uuid,text)',
    'public.operations_commerce_product_image_read_authority_is_current(uuid,uuid,text,integer,text)',
    'public.guard_operations_commerce_product_image_read_authority()',
    'public.guard_operations_commerce_store_sync_read_lease()',
    'public.seed_operations_commerce_store_sync_control()',
    'public.protect_commerce_order_sync_session_lineage()',
    'public.protect_commerce_order_observation_lineage()',
    'public.commerce_order_observation_accepts_children(uuid,uuid)',
    'public.protect_shopify_order_webhook_read()',
    'public.protect_shopify_order_webhook_target()',
    'public.guard_operations_commerce_product_image_binding()',
    'public.protect_operations_commerce_store_sync_receipt()',
    'public.validate_operations_commerce_store_sync_identity()',
    'public.operations_shopify_inventory_read_config_is_ready(uuid,uuid)',
    'public.operations_commerce_product_image_account_is_current(uuid,uuid,text,integer)',
    'public.operations_commerce_product_image_account_lineage_is_current(uuid,uuid,text,integer)',
    'public.operations_commerce_product_image_mapping_targets(uuid,uuid,text,text)',
    'public.operations_commerce_product_image_job_fences_are_current(uuid,uuid)',
    'public.operations_commerce_product_image_projection_fences_are_current(uuid,uuid)',
  ]
  const functionRows = await client.query(
    `WITH required(signature) AS (
       SELECT unnest($1::text[])
     )
     SELECT required.signature,
            encode(digest(convert_to(btrim(regexp_replace(
              installed.prosrc, '[[:space:]]+', ' ', 'g'
            )), 'UTF8'), 'sha256'), 'hex') AS body_sha256,
            language.lanname,
            installed.provolatile,
            installed.proisstrict,
            installed.prosecdef,
            installed.proleakproof,
            installed.proparallel,
            installed.proconfig,
            pg_get_function_result(installed.oid) AS result_type
     FROM required
     JOIN pg_proc installed
       ON installed.oid = to_regprocedure(required.signature)
     JOIN pg_language language ON language.oid = installed.prolang
     ORDER BY required.signature`,
    [signatures],
  )
  const rewrittenHash = await client.query(
    `WITH required(signature) AS (
       SELECT unnest($1::text[])
     )
     SELECT encode(digest(convert_to(string_agg(concat_ws(
       '|', required.signature,
       btrim(regexp_replace(installed.prosrc, '[[:space:]]+', ' ', 'g')),
       language.lanname, installed.provolatile::text,
       installed.proisstrict::text, installed.prosecdef::text,
       installed.proleakproof::text, installed.proparallel::text,
       COALESCE(array_to_string(installed.proconfig, ','), ''),
       pg_get_function_result(installed.oid)
     ), chr(10) ORDER BY required.signature), 'UTF8'), 'sha256'), 'hex')
       AS value
     FROM required
     JOIN pg_proc installed
       ON installed.oid = to_regprocedure(required.signature)
     JOIN pg_language language ON language.oid = installed.prolang`,
    [signatures],
  )
  const structure = await client.query(
    `SELECT
       (SELECT encode(digest(convert_to(string_agg(concat_ws(
         '|', installed_table.relname, installed_constraint.conname,
         installed_constraint.contype::text,
         installed_constraint.convalidated::text,
         installed_constraint.confdeltype::text,
         installed_constraint.confupdtype::text,
         pg_get_constraintdef(installed_constraint.oid)
       ), chr(10) ORDER BY installed_table.relname,
          installed_constraint.conname), 'UTF8'), 'sha256'), 'hex')
        FROM pg_constraint installed_constraint
        JOIN pg_class installed_table
          ON installed_table.oid = installed_constraint.conrelid
        JOIN pg_namespace installed_namespace
          ON installed_namespace.oid = installed_table.relnamespace
        WHERE installed_namespace.nspname = 'public'
          AND (
            installed_constraint.conrelid IN (
              to_regclass('public.operations_commerce_store_sync_controls'),
              to_regclass(
                'public.operations_commerce_store_sync_change_receipts'
              ),
              to_regclass(
                'public.operations_commerce_store_sync_read_leases'
              )
            )
            OR (
              installed_constraint.conrelid IN (
                to_regclass(
                  'public.operations_commerce_intake_read_intents'
                ),
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
          )) AS constraint_hash,
       (SELECT encode(digest(convert_to(string_agg(concat_ws(
         '|', installed_table.relname, installed_index_class.relname,
         installed_index.indisprimary::text,
         installed_index.indisunique::text,
         installed_index.indisvalid::text,
         installed_index.indisready::text,
         installed_index.indkey::text,
         pg_get_indexdef(installed_index.indexrelid)
       ), chr(10) ORDER BY installed_table.relname,
          installed_index_class.relname), 'UTF8'), 'sha256'), 'hex')
        FROM pg_index installed_index
        JOIN pg_class installed_table
          ON installed_table.oid = installed_index.indrelid
        JOIN pg_class installed_index_class
          ON installed_index_class.oid = installed_index.indexrelid
        WHERE installed_index.indrelid IN (
          to_regclass('operations_commerce_store_sync_controls'),
          to_regclass('operations_commerce_store_sync_change_receipts'),
          to_regclass('operations_commerce_store_sync_read_leases')
        )) AS index_hash,
       (SELECT encode(digest(convert_to(string_agg(concat_ws(
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
                WHERE installed_default.adrelid = pg_catalog.to_regclass(
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
       ), chr(10) ORDER BY table_name, column_name), 'UTF8'), 'sha256'), 'hex')
        FROM information_schema.columns
        WHERE table_schema = 'public' AND (
          table_name IN (
            'operations_commerce_store_sync_controls',
            'operations_commerce_store_sync_change_receipts',
            'operations_commerce_store_sync_read_leases'
          )
          OR (table_name IN (
            'operations_commerce_intake_read_intents',
            'operations_commerce_product_image_observation_sets',
            'operations_commerce_product_image_import_jobs'
          ) AND column_name = 'provider_read_authority')
        )) AS column_hash`,
  )
  return {
    functions: functionRows.rows,
    rewrittenHash: rewrittenHash.rows[0]?.value,
    ...structure.rows[0],
  }
}

async function assertFunctionTamperDetected(pool, tamperSql) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    assert.equal(await storeSyncFunctionHealth(client), true)
    assert.equal(
      await storeSyncAuthorityContract(client),
      'legacy-writer-compatible',
    )
    await client.query(tamperSql)
    assert.equal(await storeSyncFunctionHealth(client), false)
    assert.equal(await storeSyncAuthorityContract(client), 'invalid')
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
  }
  assert.equal(await storeSyncFunctionHealth(pool), true)
  assert.equal(
    await storeSyncAuthorityContract(pool),
    'legacy-writer-compatible',
  )
}

async function assertStructureTamperDetected(pool, tamperSql) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    assert.equal(await storeSyncStructureHealth(client), true)
    assert.equal(
      await storeSyncAuthorityContract(client),
      'legacy-writer-compatible',
    )
    await client.query(tamperSql)
    assert.equal(await storeSyncStructureHealth(client), false)
    assert.equal(await storeSyncAuthorityContract(client), 'invalid')
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
  }
  assert.equal(await storeSyncStructureHealth(pool), true)
  assert.equal(
    await storeSyncAuthorityContract(pool),
    'legacy-writer-compatible',
  )
}

async function assertRewrittenFunctionTamperDetected(pool, tamperSql) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    assert.equal(await storeSyncRewrittenFunctionHealth(client), true)
    assert.equal(
      await storeSyncAuthorityContract(client),
      'legacy-writer-compatible',
    )
    await client.query(tamperSql)
    assert.equal(await storeSyncRewrittenFunctionHealth(client), false)
    assert.equal(await storeSyncAuthorityContract(client), 'invalid')
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
  }
  assert.equal(await storeSyncRewrittenFunctionHealth(pool), true)
  assert.equal(
    await storeSyncAuthorityContract(pool),
    'legacy-writer-compatible',
  )
}

async function assertAuthorityContractTamperDetected(pool, tamperSql) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    assert.equal(
      await storeSyncAuthorityContract(client),
      'legacy-writer-compatible',
    )
    await client.query(tamperSql)
    assert.equal(await storeSyncAuthorityContract(client), 'invalid')
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
  }
  assert.equal(
    await storeSyncAuthorityContract(pool),
    'legacy-writer-compatible',
  )
}

async function withReplicaFixture(pool, work) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SET LOCAL session_replication_role = replica')
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

function fixture(index, state) {
  return {
    organizationId: randomUUID(),
    pipelineId: randomUUID(),
    accountId: randomUUID(),
    globalId: `gia00098${String(index).padStart(2, '0')}`,
    organizationGlobalId: `ga00098${String(index).padStart(2, '0')}`,
    state,
  }
}

async function seedAccount(client, value) {
  const allocated = await client.query(
    `SELECT allocate_global_reference('gia') AS global_id`,
  )
  value.globalId = allocated.rows[0].global_id
  await client.query(
    `INSERT INTO workspace_organizations (
       id, name, organization_type, reference_code
     ) VALUES ($1::uuid, $2, 'member', $3)`,
    [value.organizationId, `Store sync ${value.state}`, value.organizationGlobalId],
  )
  await client.query(
    `INSERT INTO pipeline_spaces (
       id, name, owner_email, is_default, workspace_organization_id
     ) VALUES ($1::uuid, $2, $3, true, $4::uuid)`,
    [value.pipelineId, `Store sync ${value.state}`, actorEmail, value.organizationId],
  )
  await client.query(
    `INSERT INTO operations_activation_scopes (
       organization_id, data_pipeline_id, state, revision
     ) VALUES ($1::uuid, $2::uuid, $3, 1)`,
    [value.organizationId, value.pipelineId, value.state],
  )
  await client.query(
    `INSERT INTO operations_integration_accounts (
       id, global_id, organization_id, provider, integration_type,
       environment, display_name, status, configuration,
       external_account_id, commerce_credential_generation,
       created_by, updated_by
     ) VALUES (
       $1::uuid, $2, $3::uuid, 'shopify', 'commerce', 'sandbox',
       $4, 'active', jsonb_build_object('shopDomain', $5::text),
       $6, 1, $7, $7
     )`,
    [
      value.accountId,
      value.globalId,
      value.organizationId,
      `Store sync ${value.state}`,
      `${value.state.replace('_', '-')}.myshopify.com`,
      `gid://shopify/Shop/98${String(value.globalId).slice(-2)}`,
      actorEmail,
    ],
  )
  await client.query(
    `INSERT INTO operations_commerce_credentials (
       organization_id, integration_account_id, external_account_id,
       auth_mode, credential_ciphertext, credential_iv, credential_tag,
       credential_version, credential_identifier_last_four,
       verification_status, verified_at, webhook_verification_status,
       created_by, updated_by
     )
     SELECT account.organization_id, account.id, account.external_account_id,
            'shopify_client_credentials', decode('01', 'hex'),
            decode(repeat('00', 12), 'hex'), decode(repeat('00', 16), 'hex'),
            1, right(account.global_id, 4), 'verified', now(), 'unverified',
            $3, $3
     FROM operations_integration_accounts account
     WHERE account.organization_id = $1::uuid
       AND account.id = $2::uuid`,
    [value.organizationId, value.accountId, actorEmail],
  )
}

async function seedLegacyProviderReadAuthorityEvidence(client, value) {
  value.legacyReadIntentId = randomUUID()
  value.legacyObservationSetId = randomUUID()
  value.legacyObservationId = randomUUID()
  value.legacyImageJobId = randomUUID()
  const externalProductId = `legacy-store-sync-${value.globalId}`
  const providerImageId = `legacy-image-${value.globalId}`
  const identity = await client.query(
    `SELECT encode(
       digest(convert_to('provider-id:' || $1::text, 'UTF8'), 'sha256'),
       'hex'
     ) AS value`,
    [providerImageId],
  )
  value.legacyImageIdentity = identity.rows[0].value

  await client.query(
    `INSERT INTO operations_commerce_intake_read_intents (
       id, organization_id, integration_account_id, pipeline_id,
       provider, resource, intake_action, idempotency_key, request_hash,
       credential_version, target_kind, session_id, batch_number,
       window_end, query_hash, created_by, updated_by, expires_at
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid,
       'shopify', 'orders', 'fetch', $5, repeat('1', 64),
       1, 'none', $6::uuid, 1,
       clock_timestamp(), repeat('2', 64), $7, $7,
       clock_timestamp() + interval '1 day'
     )`,
    [
      value.legacyReadIntentId,
      value.organizationId,
      value.accountId,
      value.pipelineId,
      `legacy-store-sync-intent:${value.globalId}`,
      randomUUID(),
      actorEmail,
    ],
  )
  await client.query('BEGIN')
  try {
    await client.query(
      `INSERT INTO operations_commerce_product_image_observation_sets (
         id, organization_id, integration_account_id, provider,
         credential_generation, external_product_id, product_source_hash,
         image_set_complete, image_identity_count,
         image_identity_set_sha256, snapshot_sha256, observed_at, created_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'shopify',
         1, $4, repeat('3', 64), true, 1,
         encode(digest(convert_to(
           'commerce-product-image-identity-set-v1' || chr(31) || $5::text,
           'UTF8'
         ), 'sha256'), 'hex'),
         repeat('5', 64), clock_timestamp(), $6
       )`,
      [
        value.legacyObservationSetId,
        value.organizationId,
        value.accountId,
        externalProductId,
        value.legacyImageIdentity,
        actorEmail,
      ],
    )
    await client.query(
      `INSERT INTO operations_commerce_product_image_observations (
         id, organization_id, integration_account_id, provider,
         credential_generation, observation_set_id, external_product_id,
         provider_image_id, locator_sha256, image_identity_sha256,
         image_sequence, lifecycle_state, source_hash, observation_revision,
         observed_at, created_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'shopify',
         1, $4::uuid, $5, $6, repeat('6', 64), $7,
         0, 'active', repeat('7', 64), 1, clock_timestamp(), $8
       )`,
      [
        value.legacyObservationId,
        value.organizationId,
        value.accountId,
        value.legacyObservationSetId,
        externalProductId,
        providerImageId,
        value.legacyImageIdentity,
        actorEmail,
      ],
    )
    await client.query(
      `INSERT INTO operations_commerce_product_image_observation_set_memberships (
         organization_id, integration_account_id, provider,
         credential_generation, external_product_id, observation_set_id,
         image_identity_sha256, observation_id, observation_revision,
         locator_sha256, observation_source_hash
       ) VALUES (
         $1::uuid, $2::uuid, 'shopify', 1, $3, $4::uuid,
         $5, $6::uuid, 1, repeat('6', 64), repeat('7', 64)
       )`,
      [
        value.organizationId,
        value.accountId,
        externalProductId,
        value.legacyObservationSetId,
        value.legacyImageIdentity,
        value.legacyObservationId,
      ],
    )
    await client.query(
      `INSERT INTO operations_commerce_product_image_import_jobs (
         id, organization_id, integration_account_id, provider,
         credential_generation, observation_id, observation_revision,
         external_product_id, image_identity_sha256, locator_sha256,
         observation_source_hash, state, wait_reason, created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'shopify',
         1, $4::uuid, 1,
         $5, $6, repeat('6', 64),
         repeat('7', 64), 'waiting_mapping', 'unmapped', $7, $7
       )`,
      [
        value.legacyImageJobId,
        value.organizationId,
        value.accountId,
        value.legacyObservationId,
        externalProductId,
        value.legacyImageIdentity,
        actorEmail,
      ],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }

  const snapshots = await client.query(
    `SELECT
       (SELECT to_jsonb(intent) - 'provider_read_authority'
        FROM operations_commerce_intake_read_intents intent
        WHERE intent.id = $1::uuid) AS read_intent,
       (SELECT to_jsonb(observation_set) - 'provider_read_authority'
        FROM operations_commerce_product_image_observation_sets observation_set
        WHERE observation_set.id = $2::uuid) AS observation_set,
       (SELECT to_jsonb(job) - 'provider_read_authority'
        FROM operations_commerce_product_image_import_jobs job
        WHERE job.id = $3::uuid) AS image_job`,
    [
      value.legacyReadIntentId,
      value.legacyObservationSetId,
      value.legacyImageJobId,
    ],
  )
  value.legacyReadIntentSnapshot = snapshots.rows[0].read_intent
  value.legacyObservationSetSnapshot = snapshots.rows[0].observation_set
  value.legacyImageJobSnapshot = snapshots.rows[0].image_job
}

async function verify(databaseUrl, fixtures) {
  const pool = new Pool({ connectionString: databaseUrl, max: 6 })
  const domain = loadTypeScript(
    'app_src/lib/operations/commerceStoreSync.ts',
  )
  const persistence = loadTypeScript(
    'app_src/lib/persistence/commerceStoreSync.ts',
    {
      '@/lib/operations/commerceStoreSync': domain,
      '@/lib/auditWriter': { async recordAuditEvent() {} },
      '@/lib/persistence/postgres': postgresAdapter(pool),
    },
  )
  try {
    const notNullConstraintCatalog = await pool.query(
      `SELECT current_setting('server_version_num')::integer
                AS server_version_num,
              (
                SELECT count(*)::integer
                FROM pg_catalog.pg_constraint installed_constraint
                JOIN pg_catalog.pg_class installed_table
                  ON installed_table.oid = installed_constraint.conrelid
                JOIN pg_catalog.pg_namespace installed_namespace
                  ON installed_namespace.oid = installed_table.relnamespace
                WHERE installed_namespace.nspname = 'public'
                  AND installed_constraint.contype = 'n'
                  AND installed_constraint.conrelid IN (
                    pg_catalog.to_regclass(
                      'public.operations_commerce_store_sync_controls'
                    ),
                    pg_catalog.to_regclass(
                      'public.operations_commerce_store_sync_change_receipts'
                    ),
                    pg_catalog.to_regclass(
                      'public.operations_commerce_store_sync_read_leases'
                    )
                  )
              ) AS not_null_constraint_count`,
    )
    const serverVersionNum = Number(
      notNullConstraintCatalog.rows[0]?.server_version_num,
    )
    const notNullConstraintCount = Number(
      notNullConstraintCatalog.rows[0]?.not_null_constraint_count,
    )
    assert.equal(
      notNullConstraintCount > 0,
      serverVersionNum >= 180_000,
      'Only PostgreSQL 18+ should expose NOT NULL rows in this constraint catalog',
    )
    assert.equal(
      await storeSyncStructureHealth(pool),
      true,
      'Store sync health must exclude PostgreSQL 18 NOT NULL catalog rows',
    )
    const controls = await pool.query(
      `SELECT account.global_id, activation.state, control.desired_state,
              control.explicit_choice, control.revision
       FROM operations_commerce_store_sync_controls control
       JOIN operations_integration_accounts account
         ON account.organization_id = control.organization_id
        AND account.id = control.integration_account_id
       JOIN operations_activation_scopes activation
         ON activation.organization_id = control.organization_id
       ORDER BY account.global_id`,
    )
    assert.equal(controls.rowCount, fixtures.length)
    for (const row of controls.rows) {
      assert.equal(
        row.desired_state,
        ['shadow', 'active'].includes(row.state) ? 'running' : 'paused',
      )
      assert.equal(row.explicit_choice, false)
      assert.equal(Number(row.revision), 1)
    }

    const legacyFixtures = fixtures.filter((value) => value.legacyReadIntentId)
    assert.equal(legacyFixtures.length, 2)
    for (const legacy of legacyFixtures) {
      const legacyEvidence = await pool.query(
        `SELECT
         (SELECT intent.provider_read_authority
          FROM operations_commerce_intake_read_intents intent
          WHERE intent.id = $1::uuid) AS read_intent_authority,
         (SELECT to_jsonb(intent) - 'provider_read_authority'
          FROM operations_commerce_intake_read_intents intent
          WHERE intent.id = $1::uuid) AS read_intent_snapshot,
         (SELECT observation_set.provider_read_authority
          FROM operations_commerce_product_image_observation_sets observation_set
          WHERE observation_set.id = $2::uuid) AS observation_set_authority,
         (SELECT to_jsonb(observation_set) - 'provider_read_authority'
          FROM operations_commerce_product_image_observation_sets observation_set
          WHERE observation_set.id = $2::uuid) AS observation_set_snapshot,
         (SELECT job.provider_read_authority
          FROM operations_commerce_product_image_import_jobs job
          WHERE job.id = $3::uuid) AS image_job_authority,
         (SELECT to_jsonb(job) - 'provider_read_authority'
          FROM operations_commerce_product_image_import_jobs job
          WHERE job.id = $3::uuid) AS image_job_snapshot,
         EXISTS (
           SELECT 1 FROM schema_migrations
           WHERE filename = '0298_operations_commerce_store_sync_controls.sql'
         ) AS migration_recorded`,
        [
          legacy.legacyReadIntentId,
          legacy.legacyObservationSetId,
          legacy.legacyImageJobId,
        ],
      )
      assert.deepEqual(legacyEvidence.rows[0], {
        read_intent_authority: 'automatic',
        read_intent_snapshot: legacy.legacyReadIntentSnapshot,
        observation_set_authority: 'automatic',
        observation_set_snapshot: legacy.legacyObservationSetSnapshot,
        image_job_authority: 'automatic',
        image_job_snapshot: legacy.legacyImageJobSnapshot,
        migration_recorded: true,
      })
    }

    const active = fixtures.find((value) => value.state === 'active')
    assert.ok(active)
    let releaseProviderRead
    let markProviderReadStarted
    const providerReadStarted = new Promise((resolvePromise) => {
      markProviderReadStarted = resolvePromise
    })
    const providerReadRelease = new Promise((resolvePromise) => {
      releaseProviderRead = resolvePromise
    })
    const inFlightProviderRead =
      persistence.withCommerceStoreSyncProviderReadFenceInPostgres({
        organizationId: active.organizationId,
        integrationAccountId: active.accountId,
        authorityKind: 'automatic',
        readKind: 'order_history',
        intentKey: 'acceptance:active:order-history:1',
        acquiredBy: actorEmail,
        read: async () => {
          markProviderReadStarted()
          await providerReadRelease
          return 'provider-read-finished-before-pause'
        },
      })
    await providerReadStarted
    const pauseCommand =
      persistence.updateCommerceStoreSyncControlInPostgres({
        organizationId: active.organizationId,
        accountGlobalId: active.globalId,
        desiredState: 'paused',
        expectedDesiredState: 'running',
        expectedRevision: 1,
        reason: 'Pause while a precommitted provider read drains',
        actorEmail,
        idempotencyKey: 'store-sync:acceptance:provider-read-pause',
      })
    let pauseCommitDeadline
    const pauseCommitOutcome = await Promise.race([
      pauseCommand.then(() => 'committed'),
      new Promise((resolvePromise) => {
        pauseCommitDeadline = setTimeout(
          () => resolvePromise('waiting-for-read'),
          5_000,
        )
      }),
    ])
    clearTimeout(pauseCommitDeadline)
    if (pauseCommitOutcome !== 'committed') {
      releaseProviderRead()
      await Promise.allSettled([pauseCommand, inFlightProviderRead])
    }
    assert.equal(pauseCommitOutcome, 'committed')
    const paused = await pauseCommand
    assert.equal(paused.control.effectiveState, 'paused')
    assert.equal(
      paused.control.effectiveReason,
      'STORE_SYNC_EXPLICIT_PAUSED_DRAINING',
    )
    releaseProviderRead()
    await assert.rejects(
      inFlightProviderRead,
      (error) => error?.code === 'COMMERCE_STORE_SYNC_PROVIDER_READ_LEASE_LOST',
    )
    const settledPaused = (
      await persistence.readCommerceStoreSyncControlsFromPostgres(
        active.organizationId,
      )
    ).find((control) => control.accountGlobalId === active.globalId)
    assert.equal(settledPaused?.effectiveReason, 'STORE_SYNC_EXPLICIT_PAUSED')

    let postPauseProviderCalls = 0
    await assert.rejects(
      persistence.withCommerceStoreSyncProviderReadFenceInPostgres({
        organizationId: active.organizationId,
        integrationAccountId: active.accountId,
        authorityKind: 'automatic',
        readKind: 'order_history',
        intentKey: 'acceptance:active:order-history:post-pause',
        acquiredBy: actorEmail,
        async read() {
          postPauseProviderCalls += 1
          return 'must-not-run'
        },
      }),
      (error) => (
        error?.code === 'COMMERCE_STORE_SYNC_PROVIDER_READ_PAUSED'
      ),
    )
    assert.equal(postPauseProviderCalls, 0)
    await assert.rejects(
      pool.query(
        `INSERT INTO operations_commerce_store_sync_read_leases (
           id, organization_id, integration_account_id, authority_kind,
           read_kind, intent_fingerprint_sha256,
           control_revision, activation_revision, acquired_by,
           acquired_at, heartbeat_at, expires_at
         ) VALUES (
           gen_random_uuid(), $1::uuid, $2::uuid, 'automatic',
           'order_history', repeat('e', 64),
           (SELECT revision FROM operations_commerce_store_sync_controls
            WHERE organization_id = $1::uuid
              AND integration_account_id = $2::uuid),
           (SELECT revision FROM operations_activation_scopes
            WHERE organization_id = $1::uuid),
           $3,
           date_trunc('milliseconds', statement_timestamp()),
           date_trunc('milliseconds', statement_timestamp()),
           date_trunc('milliseconds', statement_timestamp())
             + interval '60 seconds'
         )`,
        [active.organizationId, active.accountId, actorEmail],
      ),
      /requires current exact authority/u,
    )
    let manualProviderCalls = 0
    assert.equal(
      await persistence.withCommerceStoreSyncProviderReadFenceInPostgres({
        organizationId: active.organizationId,
        integrationAccountId: active.accountId,
        authorityKind: 'manual_read_only',
        readKind: 'order_revision',
        intentKey: 'acceptance:active:manual-order-refresh:1',
        acquiredBy: actorEmail,
        async read() {
          manualProviderCalls += 1
          return 'manual-read-completed-under-pause'
        },
      }),
      'manual-read-completed-under-pause',
    )
    assert.equal(manualProviderCalls, 1)
    let emergencyProviderCalls = 0
    for (const emergencyState of ['disabled', 'frozen']) {
      const emergency = fixtures.find((value) => value.state === emergencyState)
      assert.ok(emergency)
      await assert.rejects(
        persistence.withCommerceStoreSyncProviderReadFenceInPostgres({
          organizationId: emergency.organizationId,
          integrationAccountId: emergency.accountId,
          authorityKind: 'manual_read_only',
          readKind: 'order_revision',
          intentKey: `acceptance:${emergencyState}:manual-order-refresh:1`,
          acquiredBy: actorEmail,
          async read() {
            emergencyProviderCalls += 1
            return 'must-not-run'
          },
        }),
        (error) => error?.code === 'COMMERCE_STORE_SYNC_PROVIDER_READ_PAUSED',
      )
    }
    assert.equal(emergencyProviderCalls, 0)
    await assert.rejects(
      persistence.withCommerceStoreSyncProviderReadFenceInPostgres({
        organizationId: active.organizationId,
        integrationAccountId: active.accountId,
        authorityKind: 'manual_read_only',
        readKind: 'order_revision',
        intentKey: 'acceptance:active:manual-order-refresh:1',
        acquiredBy: actorEmail,
        async read() {
          manualProviderCalls += 1
          return 'duplicate-intent-must-not-run'
        },
      }),
      (error) => (
        error?.code === 'COMMERCE_STORE_SYNC_PROVIDER_READ_LEASE_LOST'
      ),
    )
    assert.equal(manualProviderCalls, 1)
    const resumed =
      await persistence.updateCommerceStoreSyncControlInPostgres({
        organizationId: active.organizationId,
        accountGlobalId: active.globalId,
        desiredState: 'running',
        expectedDesiredState: 'paused',
        expectedRevision: 2,
        reason: 'Resume after bounded provider read acceptance',
        actorEmail,
        idempotencyKey: 'store-sync:acceptance:provider-read-resume',
      })
    assert.equal(resumed.control.effectiveState, 'running')

    let releaseCapturedRead
    let markCapturedRead
    const capturedReadCommitted = new Promise((resolvePromise) => {
      markCapturedRead = resolvePromise
    })
    const capturedReadRelease = new Promise((resolvePromise) => {
      releaseCapturedRead = resolvePromise
    })
    let capturedLeaseId = null
    const captureBeforePause =
      persistence.withCommerceStoreSyncProviderReadFenceInPostgres({
        organizationId: active.organizationId,
        integrationAccountId: active.accountId,
        authorityKind: 'automatic',
        readKind: 'order_history',
        intentKey: 'acceptance:active:capture-before-pause',
        acquiredBy: actorEmail,
        read: async (providerReadLease) => {
          capturedLeaseId = providerReadLease.id
          const client = await pool.connect()
          try {
            await client.query('BEGIN')
            await persistence
              .assertCommerceStoreSyncProviderReadLeaseCurrentWithClient(
                client,
                {
                  organizationId: active.organizationId,
                  integrationAccountId: active.accountId,
                  lease: providerReadLease,
                  authorityKind: 'automatic',
                  readKind: 'order_history',
                },
              )
            await client.query('COMMIT')
          } catch (error) {
            await client.query('ROLLBACK')
            throw error
          } finally {
            client.release()
          }
          markCapturedRead()
          await capturedReadRelease
          return 'captured-before-pause'
        },
      })
    await capturedReadCommitted
    const pausedAfterCapture =
      await persistence.updateCommerceStoreSyncControlInPostgres({
        organizationId: active.organizationId,
        accountGlobalId: active.globalId,
        desiredState: 'paused',
        expectedDesiredState: 'running',
        expectedRevision: 3,
        reason: 'Pause after exact provider evidence capture committed',
        actorEmail,
        idempotencyKey: 'store-sync:acceptance:pause-after-capture',
      })
    assert.equal(pausedAfterCapture.control.desiredState, 'paused')
    releaseCapturedRead()
    assert.equal(await captureBeforePause, 'captured-before-pause')
    const capturedLease = await pool.query(
      `SELECT captured_at IS NOT NULL AS captured,
              release_reason
       FROM operations_commerce_store_sync_read_leases
       WHERE id = $1::uuid`,
      [capturedLeaseId],
    )
    assert.equal(capturedLease.rows[0].captured, true)
    assert.equal(capturedLease.rows[0].release_reason, 'completed')
    await persistence.updateCommerceStoreSyncControlInPostgres({
      organizationId: active.organizationId,
      accountGlobalId: active.globalId,
      desiredState: 'running',
      expectedDesiredState: 'paused',
      expectedRevision: 4,
      reason: 'Resume after capture-before-pause proof',
      actorEmail,
      idempotencyKey: 'store-sync:acceptance:resume-after-capture',
    })

    let releaseStaleCapture
    let markStaleReadStarted
    const staleReadStarted = new Promise((resolvePromise) => {
      markStaleReadStarted = resolvePromise
    })
    const staleCaptureRelease = new Promise((resolvePromise) => {
      releaseStaleCapture = resolvePromise
    })
    let staleLeaseId = null
    let staleCaptureCommitted = false
    const pauseBeforeCapture =
      persistence.withCommerceStoreSyncProviderReadFenceInPostgres({
        organizationId: active.organizationId,
        integrationAccountId: active.accountId,
        authorityKind: 'automatic',
        readKind: 'order_history',
        intentKey: 'acceptance:active:pause-resume-before-capture',
        acquiredBy: actorEmail,
        read: async (providerReadLease) => {
          staleLeaseId = providerReadLease.id
          markStaleReadStarted()
          await staleCaptureRelease
          const client = await pool.connect()
          try {
            await client.query('BEGIN')
            await persistence
              .assertCommerceStoreSyncProviderReadLeaseCurrentWithClient(
                client,
                {
                  organizationId: active.organizationId,
                  integrationAccountId: active.accountId,
                  lease: providerReadLease,
                  authorityKind: 'automatic',
                  readKind: 'order_history',
                },
              )
            await client.query('COMMIT')
            staleCaptureCommitted = true
          } catch (error) {
            await client.query('ROLLBACK')
            throw error
          } finally {
            client.release()
          }
          return 'must-not-commit'
        },
      })
    await staleReadStarted
    await persistence.updateCommerceStoreSyncControlInPostgres({
      organizationId: active.organizationId,
      accountGlobalId: active.globalId,
      desiredState: 'paused',
      expectedDesiredState: 'running',
      expectedRevision: 5,
      reason: 'Pause before stale provider response capture',
      actorEmail,
      idempotencyKey: 'store-sync:acceptance:pause-before-capture',
    })
    await persistence.updateCommerceStoreSyncControlInPostgres({
      organizationId: active.organizationId,
      accountGlobalId: active.globalId,
      desiredState: 'running',
      expectedDesiredState: 'paused',
      expectedRevision: 6,
      reason: 'Resume with a new Store sync generation',
      actorEmail,
      idempotencyKey: 'store-sync:acceptance:resume-before-stale-capture',
    })
    releaseStaleCapture()
    await assert.rejects(
      pauseBeforeCapture,
      (error) => error?.code === 'COMMERCE_STORE_SYNC_PROVIDER_READ_LEASE_LOST',
    )
    assert.equal(staleCaptureCommitted, false)
    const staleLease = await pool.query(
      `SELECT captured_at, release_reason
       FROM operations_commerce_store_sync_read_leases
       WHERE id = $1::uuid`,
      [staleLeaseId],
    )
    assert.equal(staleLease.rows[0].captured_at, null)
    assert.equal(staleLease.rows[0].release_reason, 'failed')

    const shadow = fixtures.find((value) => value.state === 'shadow')
    assert.ok(shadow)
    const commandInput = {
      organizationId: shadow.organizationId,
      accountGlobalId: shadow.globalId,
      desiredState: 'running',
      expectedDesiredState: 'running',
      expectedRevision: 1,
      reason: 'Confirm Running as an independent Store sync choice',
      actorEmail,
      idempotencyKey: 'store-sync:acceptance:adopt-running',
    }
    const adopted = await persistence
      .updateCommerceStoreSyncControlInPostgres(commandInput)
    assert.equal(adopted.control.desiredState, 'running')
    assert.equal(adopted.control.explicitChoice, true)
    assert.equal(adopted.control.revision, 2)

    await pool.query(
      `UPDATE operations_activation_scopes
       SET state = 'read_only', revision = revision + 1
       WHERE organization_id = $1::uuid`,
      [shadow.organizationId],
    )
    const replay = await persistence
      .updateCommerceStoreSyncControlInPostgres(commandInput)
    assert.equal(
      JSON.stringify(replay),
      JSON.stringify(adopted),
      'same key/request replay remains byte-stable after effective-state changes',
    )
    const projected = await persistence
      .readCommerceStoreSyncControlsFromPostgres(shadow.organizationId)
    assert.equal(projected[0].effectiveState, 'running')
    assert.equal(projected[0].effectiveReason, 'STORE_SYNC_EXPLICIT_RUNNING')

    const inventoryWarehouseId = randomUUID()
    const inventoryWarehouseGlobalId = (
      await pool.query(`SELECT allocate_global_reference('gwh') AS global_id`)
    ).rows[0].global_id
    await pool.query(
      `INSERT INTO operations_warehouses (
         id, global_id, organization_id, code, name, status
       ) VALUES (
         $1::uuid, $2, $3::uuid, 'STORE-SYNC',
         'Store sync inventory fixture', 'active'
       )`,
      [
        inventoryWarehouseId,
        inventoryWarehouseGlobalId,
        shadow.organizationId,
      ],
    )
    const inventoryConfigId = randomUUID()
    const inventoryConfigGlobalId = (
      await pool.query(`SELECT allocate_global_reference('gscf') AS global_id`)
    ).rows[0].global_id
    const inventoryActivationRevision = Number((
      await pool.query(
        `SELECT revision FROM operations_activation_scopes
         WHERE organization_id = $1::uuid`,
        [shadow.organizationId],
      )
    ).rows[0].revision)
    await withReplicaFixture(pool, (client) => client.query(
      `INSERT INTO operations_shopify_carrier_service_configs (
         id, global_id, organization_id, integration_account_id,
         warehouse_id, registration_state, credential_generation,
         activation_revision, callback_token_version, callback_token_hash,
         policy_revision, policy_hash, policy_snapshot,
         inventory_max_age_seconds, quote_ttl_seconds,
         order_reconciliation_window_seconds, algorithm_version,
         created_by, updated_by
       ) VALUES (
         $1::uuid, $2, $3::uuid, $4::uuid, $5::uuid,
         'shadow_simulated', 1, $7::integer, 1, repeat('a', 64),
         1, repeat('b', 64), '{
           "planRateOptimization": {
             "version": "shopify-checkout-plan-rate-objective-v2",
             "maxCandidates": 4,
             "objectivePriority": [
               "landed_price", "package_count", "unused_cube"
             ],
             "handlingCostMinorPerPackage": 0,
             "handlingCostCurrency": "USD"
           },
           "checkoutRateWarm": {
             "version": "shopify-checkout-rate-warm-v1",
             "enabled": false,
             "mode": "hosted_ajax",
             "zoneScope": "all_saved_rate_zones",
             "concurrency": 2,
             "debounceMs": 350,
             "minIntervalMs": 1000,
             "supportedCountries": ["US"],
             "staleCartAbort": true
           }
         }'::jsonb,
         900, 120, 3600, 'store-sync-acceptance-v1', $6, $6
       )`,
      [
        inventoryConfigId,
        inventoryConfigGlobalId,
        shadow.organizationId,
        shadow.accountId,
        inventoryWarehouseId,
        actorEmail,
        inventoryActivationRevision,
      ],
    ))
    const inventoryReadReady = async () => (
      await pool.query(
        `SELECT operations_shopify_inventory_read_config_is_ready(
           $1::uuid, $2::uuid
         ) AS ready`,
        [shadow.organizationId, inventoryConfigId],
      )
    ).rows[0].ready
    assert.equal(
      await inventoryReadReady(),
      true,
      'shadow-simulated inventory reads remain eligible after Read only',
    )
    await withReplicaFixture(pool, (client) => client.query(
      `UPDATE operations_shopify_carrier_service_configs
       SET registration_state = 'registered',
           service_gid = 'gid://shopify/DeliveryCarrierService/9801',
           row_version = row_version + 1,
           updated_at = clock_timestamp()
       WHERE organization_id = $1::uuid
         AND id = $2::uuid`,
      [shadow.organizationId, inventoryConfigId],
    ))
    assert.equal(
      await inventoryReadReady(),
      true,
      'registered inventory reads remain eligible after Read only',
    )

    await pool.query(
      `UPDATE operations_activation_scopes
       SET state = 'disabled', revision = revision + 1
       WHERE organization_id = $1::uuid`,
      [shadow.organizationId],
    )
    assert.equal(
      (await persistence.readCommerceStoreSyncControlsFromPostgres(
        shadow.organizationId,
      ))[0].effectiveReason,
      'OPERATIONS_DISABLED_OVERRIDE',
    )
    assert.equal(await inventoryReadReady(), false)
    await pool.query(
      `UPDATE operations_activation_scopes
       SET state = 'frozen', revision = revision + 1
       WHERE organization_id = $1::uuid`,
      [shadow.organizationId],
    )
    assert.equal(
      (await persistence.readCommerceStoreSyncControlsFromPostgres(
        shadow.organizationId,
      ))[0].effectiveReason,
      'OPERATIONS_FROZEN_OVERRIDE',
    )
    assert.equal(await inventoryReadReady(), false)
    await pool.query(
      `UPDATE operations_activation_scopes
       SET state = 'read_only', revision = revision + 1
       WHERE organization_id = $1::uuid`,
      [shadow.organizationId],
    )

    await assert.rejects(
      persistence.updateCommerceStoreSyncControlInPostgres({
        ...commandInput,
        reason: 'Different request under the retained key',
      }),
      (error) => error?.code === 'COMMERCE_STORE_SYNC_IDEMPOTENCY_CONFLICT',
    )
    await assert.rejects(
      persistence.updateCommerceStoreSyncControlInPostgres({
        ...commandInput,
        idempotencyKey: 'store-sync:acceptance:stale-cas',
      }),
      (error) => error?.code === 'COMMERCE_STORE_SYNC_REVISION_CONFLICT',
    )

    const races = await Promise.allSettled([
      persistence.updateCommerceStoreSyncControlInPostgres({
        ...commandInput,
        desiredState: 'paused',
        expectedRevision: 2,
        idempotencyKey: 'store-sync:acceptance:race-a',
        reason: 'Pause from concurrent acceptance command A',
      }),
      persistence.updateCommerceStoreSyncControlInPostgres({
        ...commandInput,
        desiredState: 'paused',
        expectedRevision: 2,
        idempotencyKey: 'store-sync:acceptance:race-b',
        reason: 'Pause from concurrent acceptance command B',
      }),
    ])
    assert.equal(races.filter((value) => value.status === 'fulfilled').length, 1)
    assert.equal(races.filter((value) => value.status === 'rejected').length, 1)
    assert.equal(
      await inventoryReadReady(),
      false,
      'an explicit Paused Store sync blocks inventory readiness',
    )

    const secondAccountId = randomUUID()
    const secondAccountGlobalId = (
      await pool.query(`SELECT allocate_global_reference('gia') AS global_id`)
    ).rows[0].global_id
    await pool.query(
      `INSERT INTO operations_integration_accounts (
         id, global_id, organization_id, provider, integration_type,
         environment, display_name, status, configuration,
         external_account_id, commerce_credential_generation,
         created_by, updated_by
       ) VALUES (
         $1::uuid, $4, $2::uuid, 'faire', 'commerce', 'production',
         'Isolated Faire', 'active', '{}'::jsonb, 'brand_store_sync_99', 1,
         $3, $3
       )`,
      [
        secondAccountId,
        shadow.organizationId,
        actorEmail,
        secondAccountGlobalId,
      ],
    )
    const isolated = await pool.query(
      `SELECT desired_state, explicit_choice, revision
       FROM operations_commerce_store_sync_controls
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid`,
      [shadow.organizationId, secondAccountId],
    )
    assert.deepEqual(
      {
        desiredState: isolated.rows[0].desired_state,
        explicitChoice: isolated.rows[0].explicit_choice,
        revision: Number(isolated.rows[0].revision),
      },
      { desiredState: 'paused', explicitChoice: false, revision: 1 },
    )

    await assert.rejects(
      pool.query(
        `UPDATE operations_commerce_store_sync_controls
         SET integration_account_id = $3::uuid,
             revision = revision + 1,
             explicit_choice = true
         WHERE organization_id = $1::uuid
           AND integration_account_id = $2::uuid`,
        [shadow.organizationId, shadow.accountId, secondAccountId],
      ),
      /identity and creation evidence are immutable/i,
    )
    await assert.rejects(
      pool.query(
        `UPDATE operations_commerce_store_sync_controls
         SET revision = revision + 2,
             explicit_choice = true
         WHERE organization_id = $1::uuid
           AND integration_account_id = $2::uuid`,
        [shadow.organizationId, shadow.accountId],
      ),
      /revision must advance by exactly one/i,
    )
    await assert.rejects(
      pool.query(
        `UPDATE operations_commerce_store_sync_change_receipts
         SET reason = 'tampered'
         WHERE organization_id = $1::uuid`,
        [shadow.organizationId],
      ),
      /append-only/i,
    )

    assert.deepEqual(
      await readStoreSyncOperatorBindingCatalog(pool),
      {
        binding_count: 37,
        binding_hash:
          '724e0c8f03f49d3f9664948070f811a28a9dbeea2b6a60bd6c12d28d8c33b3bc',
      },
    )
    assert.equal(
      await storeSyncFunctionHealth(pool),
      true,
      'Store sync function health starts exact',
    )
    assert.equal(
      await storeSyncRewrittenFunctionHealth(pool),
      true,
      'Store sync rewritten-function health starts exact',
    )
    assert.equal(
      await storeSyncStructureHealth(pool),
      true,
      'Store sync structure health starts exact',
    )
    assert.equal(
      await storeSyncAuthorityContract(pool),
      'legacy-writer-compatible',
      'Store sync authority phase starts legacy-writer-compatible',
    )

    const functionBodyTampers = [
      `CREATE OR REPLACE FUNCTION
         operations_commerce_store_sync_effective_reason(
           requested_organization_id uuid,
           requested_integration_account_id uuid
         )
       RETURNS text LANGUAGE sql STABLE
       AS $$ SELECT 'STORE_SYNC_EXPLICIT_RUNNING'::text $$`,
      `CREATE OR REPLACE FUNCTION
         operations_commerce_store_sync_is_running(
           requested_organization_id uuid,
           requested_integration_account_id uuid
         )
       RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$`,
      `CREATE OR REPLACE FUNCTION
         seed_operations_commerce_store_sync_control()
       RETURNS trigger LANGUAGE plpgsql
       AS $$ BEGIN RETURN NEW; END $$`,
      `CREATE OR REPLACE FUNCTION
         protect_operations_commerce_store_sync_receipt()
       RETURNS trigger LANGUAGE plpgsql
       AS $$ BEGIN RETURN OLD; END $$`,
      `CREATE OR REPLACE FUNCTION
         validate_operations_commerce_store_sync_identity()
       RETURNS trigger LANGUAGE plpgsql
       AS $$ BEGIN RETURN NEW; END $$`,
      `CREATE OR REPLACE FUNCTION
         operations_shopify_inventory_read_config_is_ready(
           requested_organization_id uuid,
           requested_config_id uuid
         )
       RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$`,
      `CREATE OR REPLACE FUNCTION
         operations_commerce_provider_read_authority_is_current(
           requested_organization_id uuid,
           requested_integration_account_id uuid,
           requested_authority text
         )
       RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$`,
      `CREATE OR REPLACE FUNCTION
         operations_commerce_product_image_read_authority_is_current(
           requested_organization_id uuid,
           requested_integration_account_id uuid,
           requested_provider text,
           requested_credential_generation integer,
           requested_authority text
         )
       RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$`,
      `CREATE OR REPLACE FUNCTION
         guard_operations_commerce_product_image_read_authority()
       RETURNS trigger LANGUAGE plpgsql
       AS $$ BEGIN RETURN NEW; END $$`,
      `CREATE OR REPLACE FUNCTION
         guard_operations_commerce_store_sync_read_lease()
       RETURNS trigger LANGUAGE plpgsql
       AS $$ BEGIN RETURN NEW; END $$`,
    ]
    for (const tamperSql of functionBodyTampers) {
      await assertFunctionTamperDetected(pool, tamperSql)
    }
    await assertFunctionTamperDetected(
      pool,
      `ALTER FUNCTION
         operations_commerce_store_sync_effective_reason(uuid, uuid)
       RESET ALL`,
    )

    await assertRewrittenFunctionTamperDetected(
      pool,
      `CREATE OR REPLACE FUNCTION
         protect_commerce_order_sync_session_lineage()
       RETURNS trigger LANGUAGE plpgsql
       AS $$ BEGIN RETURN NEW; END $$`,
    )
    await assertRewrittenFunctionTamperDetected(
      pool,
      `CREATE OR REPLACE FUNCTION
         operations_commerce_product_image_projection_fences_are_current(
           requested_organization_id uuid,
           requested_job_id uuid
         )
       RETURNS boolean LANGUAGE plpgsql STABLE SECURITY INVOKER
       SET search_path = pg_catalog, public
       AS $$ BEGIN RETURN true; END $$`,
    )

    await assertStructureTamperDetected(
      pool,
      `ALTER TABLE operations_commerce_store_sync_controls
         DROP CONSTRAINT
           operations_commerce_store_sync_controls_desired_state_check;
       ALTER TABLE operations_commerce_store_sync_controls
         ADD CONSTRAINT
           operations_commerce_store_sync_controls_desired_state_check
         CHECK (true)`,
    )
    await assertStructureTamperDetected(
      pool,
      `ALTER TABLE operations_commerce_store_sync_read_leases
         DROP CONSTRAINT
           operations_commerce_store_sync_read_leases_authority_valid;
       ALTER TABLE operations_commerce_store_sync_read_leases
         ADD CONSTRAINT
           operations_commerce_store_sync_read_leases_authority_valid
         CHECK (true)`,
    )
    await assertStructureTamperDetected(
      pool,
      `ALTER TABLE operations_commerce_intake_read_intents
         ADD CONSTRAINT store_sync_test_extra_authority_check
         CHECK (provider_read_authority = 'automatic')`,
    )
    const contractClient = await pool.connect()
    try {
      await contractClient.query('BEGIN')
      await contractClient.query(
        `INSERT INTO schema_migrations (filename, checksum)
         VALUES (
           '0305_operations_commerce_rollout_contract.sql',
           $1
         )`,
        [futureCommerceRolloutContractChecksum],
      )
      for (const table of [
        'operations_commerce_intake_read_intents',
        'operations_commerce_product_image_observation_sets',
        'operations_commerce_product_image_import_jobs',
      ]) {
        await contractClient.query(
          `ALTER TABLE ${table}
             ALTER COLUMN provider_read_authority DROP DEFAULT`,
        )
      }
      assert.equal(await storeSyncStructureHealth(contractClient), true)
      assert.equal(
        await storeSyncAuthorityContract(contractClient),
        'strict-explicit',
      )
      await contractClient.query('SAVEPOINT strict_ledger_tamper')
      await contractClient.query(
        `UPDATE schema_migrations
         SET checksum = repeat('0', 64)
         WHERE filename =
           '0305_operations_commerce_rollout_contract.sql'`,
      )
      assert.equal(await storeSyncStructureHealth(contractClient), false)
      assert.equal(await storeSyncAuthorityContract(contractClient), 'invalid')
      await contractClient.query('ROLLBACK TO SAVEPOINT strict_ledger_tamper')
      assert.equal(
        await storeSyncAuthorityContract(contractClient),
        'strict-explicit',
      )
    } finally {
      await contractClient.query('ROLLBACK').catch(() => {})
      contractClient.release()
    }
    assert.equal(await storeSyncStructureHealth(pool), true)
    assert.equal(
      await storeSyncAuthorityContract(pool),
      'legacy-writer-compatible',
    )
    await assertAuthorityContractTamperDetected(
      pool,
      `UPDATE schema_migrations
       SET checksum = repeat('0', 64)
       WHERE filename =
         '0298_operations_commerce_store_sync_controls.sql'`,
    )
    const foreignFirstClient = await pool.connect()
    try {
      await foreignFirstClient.query('BEGIN')
      await foreignFirstClient.query(
        `CREATE SCHEMA store_sync_health_shadow;
         CREATE TABLE store_sync_health_shadow.schema_migrations (
           filename text PRIMARY KEY,
           checksum text NOT NULL
         );
         CREATE TABLE
           store_sync_health_shadow.operations_integration_accounts (
             organization_id uuid,
             id uuid
           );
         CREATE TABLE
           store_sync_health_shadow.operations_commerce_store_sync_controls (
             organization_id uuid,
             integration_account_id uuid
           );
         CREATE FUNCTION store_sync_health_shadow.digest(bytea, text)
         RETURNS bytea LANGUAGE sql IMMUTABLE
         AS $shadow$ SELECT $1 $shadow$;
         CREATE FUNCTION store_sync_health_shadow.encode(bytea, text)
         RETURNS text LANGUAGE sql IMMUTABLE
         AS $shadow$ SELECT 'spoofed'::text $shadow$;
         CREATE FUNCTION store_sync_health_shadow.convert_to(text, name)
         RETURNS bytea LANGUAGE sql IMMUTABLE
         AS $shadow$ SELECT ''::bytea $shadow$;
         CREATE FUNCTION store_sync_health_shadow.to_regprocedure(text)
         RETURNS pg_catalog.regprocedure LANGUAGE sql STABLE
         AS $shadow$ SELECT NULL::pg_catalog.regprocedure $shadow$;
         CREATE FUNCTION store_sync_health_shadow.to_regclass(text)
         RETURNS pg_catalog.regclass LANGUAGE sql STABLE
         AS $shadow$ SELECT NULL::pg_catalog.regclass $shadow$;
         CREATE FUNCTION
           store_sync_health_shadow.pg_get_function_result(pg_catalog.oid)
         RETURNS text LANGUAGE sql STABLE
         AS $shadow$ SELECT 'spoofed'::text $shadow$;
         CREATE FUNCTION
           store_sync_health_shadow.pg_get_constraintdef(pg_catalog.oid)
         RETURNS text LANGUAGE sql STABLE
         AS $shadow$ SELECT 'CHECK (true)'::text $shadow$;
         CREATE FUNCTION
           store_sync_health_shadow.pg_get_indexdef(pg_catalog.oid)
         RETURNS text LANGUAGE sql STABLE
         AS $shadow$ SELECT 'CREATE INDEX spoofed'::text $shadow$;
         CREATE FUNCTION store_sync_health_shadow.btrim(text)
         RETURNS text LANGUAGE sql IMMUTABLE
         AS $shadow$ SELECT $1 $shadow$;
         CREATE FUNCTION store_sync_health_shadow.length(text)
         RETURNS integer LANGUAGE sql IMMUTABLE
         AS $shadow$ SELECT 0 $shadow$;
         CREATE FUNCTION store_sync_health_shadow.jsonb_typeof(jsonb)
         RETURNS text LANGUAGE sql IMMUTABLE
         AS $shadow$ SELECT 'object'::text $shadow$;
         CREATE FUNCTION store_sync_health_shadow.now()
         RETURNS timestamptz LANGUAGE sql STABLE
         AS $shadow$ SELECT '2000-01-01Z'::timestamptz $shadow$;
         CREATE FUNCTION store_sync_health_shadow.gen_random_uuid()
         RETURNS uuid LANGUAGE sql VOLATILE
         AS $shadow$ SELECT NULL::uuid $shadow$;
         CREATE FUNCTION
           store_sync_health_shadow.regexp_replace(text, text, text, text)
         RETURNS text LANGUAGE sql IMMUTABLE
         AS $shadow$ SELECT $1 $shadow$;
         CREATE FUNCTION
           store_sync_health_shadow.array_to_string(text[], text)
         RETURNS text LANGUAGE sql IMMUTABLE
         AS $shadow$ SELECT 'spoofed'::text $shadow$;
         CREATE FUNCTION store_sync_health_shadow.chr(integer)
         RETURNS text LANGUAGE sql IMMUTABLE
         AS $shadow$ SELECT ''::text $shadow$;
         CREATE FUNCTION store_sync_health_shadow.replace(text, text, text)
         RETURNS text LANGUAGE sql IMMUTABLE
         AS $shadow$ SELECT $1 $shadow$;
         CREATE FUNCTION store_sync_health_shadow.strpos(text, text)
         RETURNS integer LANGUAGE sql IMMUTABLE
         AS $shadow$ SELECT 0 $shadow$;
         INSERT INTO store_sync_health_shadow.schema_migrations (
           filename, checksum
         ) VALUES (
           '0298_operations_commerce_store_sync_controls.sql',
           repeat('0', 64)
         );
         SET LOCAL search_path =
           store_sync_health_shadow, public, pg_catalog, pg_temp`,
      )
      assert.equal(await storeSyncFunctionHealth(foreignFirstClient), true)
      assert.equal(
        await storeSyncRewrittenFunctionHealth(foreignFirstClient),
        true,
      )
      assert.equal(await storeSyncStructureHealth(foreignFirstClient), true)
      assert.equal(
        await storeSyncAuthorityContract(foreignFirstClient),
        'legacy-writer-compatible',
      )
    } finally {
      await foreignFirstClient.query('ROLLBACK').catch(() => {})
      foreignFirstClient.release()
    }
    const spoofedDigestClient = await pool.connect()
    try {
      await spoofedDigestClient.query('BEGIN')
      await spoofedDigestClient.query(
        `CREATE SCHEMA store_sync_digest_shadow;
         CREATE FUNCTION store_sync_digest_shadow.digest(bytea, text)
         RETURNS bytea LANGUAGE sql IMMUTABLE
         AS $spoof$
           SELECT CASE
             WHEN pg_catalog.convert_from($1, 'UTF8') LIKE
                    '%public.protect_commerce_order_sync_session_lineage()%'
               THEN pg_catalog.decode(
                 'bb66159fdec700a84c7dccd76088b9052f107f78cf604bb43dbd95163513e2b6',
                 'hex'
               )
             ELSE public.digest($1, $2)
           END
         $spoof$;
         CREATE OR REPLACE FUNCTION
           public.protect_commerce_order_sync_session_lineage()
         RETURNS trigger LANGUAGE plpgsql
         AS $weakened$
         BEGIN
           RETURN NEW;
         END
         $weakened$;
         SET LOCAL search_path =
           store_sync_digest_shadow, public, pg_catalog, pg_temp`,
      )
      assert.equal(await storeSyncFunctionHealth(spoofedDigestClient), true)
      assert.equal(
        await storeSyncStructureHealth(spoofedDigestClient),
        true,
      )
      assert.equal(
        await storeSyncRewrittenFunctionHealth(spoofedDigestClient),
        false,
      )
      assert.equal(
        await storeSyncAuthorityContract(spoofedDigestClient),
        'invalid',
      )
    } finally {
      await spoofedDigestClient.query('ROLLBACK').catch(() => {})
      spoofedDigestClient.release()
    }
    assert.equal(await storeSyncRewrittenFunctionHealth(pool), true)
    assert.equal(
      await storeSyncAuthorityContract(pool),
      'legacy-writer-compatible',
    )
    await assertStructureTamperDetected(
      pool,
      `ALTER TABLE operations_commerce_intake_read_intents
         ALTER COLUMN provider_read_authority DROP DEFAULT`,
    )
    await assertStructureTamperDetected(
      pool,
      `ALTER TABLE operations_commerce_intake_read_intents
         ALTER COLUMN provider_read_authority SET DEFAULT 'manual_read_only'`,
    )
    await assertStructureTamperDetected(
      pool,
      `CREATE SCHEMA store_sync_default_shadow;
       CREATE FUNCTION store_sync_default_shadow.now()
       RETURNS timestamptz LANGUAGE sql STABLE
       AS $shadow$ SELECT pg_catalog.now() $shadow$;
       SET LOCAL search_path =
         store_sync_default_shadow, public, pg_catalog, pg_temp;
       ALTER TABLE public.operations_commerce_store_sync_controls
         ALTER COLUMN created_at SET DEFAULT now()`,
    )
    await assertStructureTamperDetected(
      pool,
      `CREATE SCHEMA store_sync_constraint_shadow;
       CREATE FUNCTION store_sync_constraint_shadow.btrim(text)
       RETURNS text LANGUAGE sql IMMUTABLE
       AS $shadow$ SELECT pg_catalog.btrim($1) $shadow$;
       CREATE FUNCTION store_sync_constraint_shadow.length(text)
       RETURNS integer LANGUAGE sql IMMUTABLE
       AS $shadow$ SELECT pg_catalog.length($1) $shadow$;
       SET LOCAL search_path =
         store_sync_constraint_shadow, public, pg_catalog, pg_temp;
       ALTER TABLE public.operations_commerce_store_sync_controls
         DROP CONSTRAINT
           operations_commerce_store_sync_controls_reason_check;
       ALTER TABLE public.operations_commerce_store_sync_controls
         ADD CONSTRAINT
           operations_commerce_store_sync_controls_reason_check
         CHECK (
           length(btrim(reason)) BETWEEN 1 AND 500
           AND reason !~ '[[:cntrl:]]'
         )`,
    )
    await assertStructureTamperDetected(
      pool,
      `CREATE SCHEMA store_sync_operator_shadow;
       CREATE FUNCTION store_sync_operator_shadow.text_eq(text, text)
       RETURNS boolean LANGUAGE sql IMMUTABLE
       AS $shadow$ SELECT true $shadow$;
       CREATE OPERATOR store_sync_operator_shadow.= (
         LEFTARG = text,
         RIGHTARG = text,
         FUNCTION = store_sync_operator_shadow.text_eq
       );
       SET LOCAL search_path =
         store_sync_operator_shadow, public, pg_catalog, pg_temp;
       ALTER TABLE public.operations_commerce_store_sync_controls
         DROP CONSTRAINT
           operations_commerce_store_sync_controls_desired_state_check;
       ALTER TABLE public.operations_commerce_store_sync_controls
         ADD CONSTRAINT
           operations_commerce_store_sync_controls_desired_state_check
         CHECK (desired_state IN ('running', 'paused'))`,
    )
    await assertStructureTamperDetected(
      pool,
      `CREATE SCHEMA store_sync_reference_shadow;
       CREATE TABLE
         store_sync_reference_shadow.operations_integration_accounts (
           organization_id uuid NOT NULL,
           id uuid NOT NULL,
           UNIQUE (organization_id, id)
         );
       INSERT INTO
         store_sync_reference_shadow.operations_integration_accounts (
           organization_id, id
         )
       SELECT organization_id, id
       FROM public.operations_integration_accounts;
       SET LOCAL search_path =
         store_sync_reference_shadow, public, pg_catalog, pg_temp;
       ALTER TABLE public.operations_commerce_store_sync_controls
         DROP CONSTRAINT
           operations_commerce_store_sync_controls_account_fkey;
       ALTER TABLE public.operations_commerce_store_sync_controls
         ADD CONSTRAINT
           operations_commerce_store_sync_controls_account_fkey
         FOREIGN KEY (organization_id, integration_account_id)
         REFERENCES operations_integration_accounts(organization_id, id)
         ON DELETE RESTRICT`,
    )
    await assertStructureTamperDetected(
      pool,
      `ALTER TABLE operations_commerce_store_sync_controls
         ALTER COLUMN explicit_choice DROP NOT NULL`,
    )
    await assertStructureTamperDetected(
      pool,
      `ALTER TABLE operations_commerce_store_sync_change_receipts
         ALTER COLUMN response_json TYPE varchar(8192)`,
    )
    await assertStructureTamperDetected(
      pool,
      `ALTER TABLE operations_commerce_store_sync_read_leases
         DISABLE TRIGGER
           guard_operations_commerce_store_sync_read_lease_write`,
    )
    await assertStructureTamperDetected(
      pool,
      `CREATE TRIGGER store_sync_test_extra_receipt_guard
         BEFORE UPDATE
         ON operations_commerce_store_sync_change_receipts
         FOR EACH ROW EXECUTE FUNCTION
           protect_operations_commerce_store_sync_receipt()`,
    )
    await assertStructureTamperDetected(
      pool,
      `DROP TRIGGER commerce_order_sync_session_lineage_guard
         ON operations_commerce_order_backfill_sessions;
       CREATE TRIGGER commerce_order_sync_session_lineage_guard
         BEFORE INSERT OR UPDATE
         ON operations_commerce_order_backfill_sessions
         FOR EACH ROW EXECUTE FUNCTION
           protect_commerce_order_sync_session_lineage()`,
    )
    await assertStructureTamperDetected(
      pool,
      `DROP TRIGGER guard_operations_commerce_image_job_authority_write
         ON operations_commerce_product_image_import_jobs;
       CREATE TRIGGER guard_operations_commerce_image_job_authority_write
         BEFORE UPDATE ON operations_commerce_product_image_import_jobs
         FOR EACH ROW EXECUTE FUNCTION
           validate_operations_commerce_store_sync_identity()`,
    )
    await assertStructureTamperDetected(
      pool,
      `DROP TRIGGER protect_operations_commerce_store_sync_receipt_write
         ON operations_commerce_store_sync_change_receipts;
       CREATE TRIGGER protect_operations_commerce_store_sync_receipt_write
         BEFORE UPDATE OR DELETE
         ON operations_commerce_store_sync_change_receipts
         FOR EACH ROW WHEN (false)
         EXECUTE FUNCTION protect_operations_commerce_store_sync_receipt()`,
    )
    await assertStructureTamperDetected(
      pool,
      `DROP TRIGGER validate_operations_commerce_store_sync_identity_write
         ON operations_commerce_store_sync_controls;
       CREATE TRIGGER validate_operations_commerce_store_sync_identity_write
         BEFORE INSERT OR UPDATE
         ON operations_commerce_store_sync_controls
         FOR EACH ROW WHEN (false)
         EXECUTE FUNCTION validate_operations_commerce_store_sync_identity()`,
    )
    await assertStructureTamperDetected(
      pool,
      `DROP TRIGGER seed_operations_commerce_store_sync_control_write
         ON operations_integration_accounts;
       CREATE TRIGGER seed_operations_commerce_store_sync_control_write
         AFTER INSERT ON operations_integration_accounts
         FOR EACH ROW WHEN (false)
         EXECUTE FUNCTION seed_operations_commerce_store_sync_control()`,
    )
    await assertStructureTamperDetected(
      pool,
      `CREATE SCHEMA store_sync_lookalike;
       CREATE TABLE store_sync_lookalike.operations_commerce_intake_read_intents (
         provider_read_authority text,
         CONSTRAINT commerce_intake_read_intents_authority_valid CHECK (true)
       );
       ALTER TABLE public.operations_commerce_intake_read_intents
         DROP CONSTRAINT commerce_intake_read_intents_authority_valid`,
    )
    await assertStructureTamperDetected(
      pool,
      `CREATE SCHEMA store_sync_lookalike;
       CREATE TABLE store_sync_lookalike.operations_commerce_store_sync_read_leases (
         provider_read_authority text
       );
       CREATE TRIGGER guard_operations_commerce_store_sync_read_lease_write
         BEFORE INSERT OR UPDATE OR DELETE
         ON store_sync_lookalike.operations_commerce_store_sync_read_leases
         FOR EACH ROW EXECUTE FUNCTION
           guard_operations_commerce_store_sync_read_lease();
       DROP TRIGGER guard_operations_commerce_store_sync_read_lease_write
         ON public.operations_commerce_store_sync_read_leases`,
    )
    const expiredLeaseClient = await pool.connect()
    try {
      await expiredLeaseClient.query('BEGIN')
      await expiredLeaseClient.query(
        'SET LOCAL session_replication_role = replica',
      )
      await expiredLeaseClient.query(
        `INSERT INTO operations_commerce_store_sync_read_leases (
           id, organization_id, integration_account_id, authority_kind,
           read_kind, intent_fingerprint_sha256,
           control_revision, activation_revision, acquired_by,
           acquired_at, heartbeat_at, expires_at
         ) VALUES (
           gen_random_uuid(), $1::uuid, $2::uuid, 'automatic',
           'order_history', repeat('f', 64),
           (SELECT revision FROM operations_commerce_store_sync_controls
            WHERE organization_id = $1::uuid
              AND integration_account_id = $2::uuid),
           (SELECT revision FROM operations_activation_scopes
            WHERE organization_id = $1::uuid),
           $3,
           clock_timestamp() - interval '61 seconds',
           clock_timestamp() - interval '61 seconds',
           clock_timestamp() - interval '1 second'
         )`,
        [active.organizationId, active.accountId, actorEmail],
      )
      await expiredLeaseClient.query('COMMIT')
      assert.equal(await storeSyncStructureHealth(pool), false)
      const reconciled = await persistence
        .reconcileExpiredCommerceStoreSyncProviderReadLeasesInPostgres()
      assert.equal(reconciled.reconciled, 1)
      assert.equal(await storeSyncStructureHealth(pool), true)
    } finally {
      await expiredLeaseClient.query('ROLLBACK').catch(() => {})
      expiredLeaseClient.release()
    }
    assert.equal(await storeSyncStructureHealth(pool), true)

    const structural = await pool.query(
      `SELECT
         (SELECT count(*) = 1 FROM pg_constraint
          WHERE conrelid = to_regclass(
            'operations_commerce_store_sync_controls'
          ) AND contype = 'p') AS control_pk,
         EXISTS (
           SELECT 1 FROM pg_constraint
           WHERE conname =
             'operations_commerce_store_sync_controls_account_fkey'
             AND contype = 'f' AND convalidated
         ) AS control_fk,
         EXISTS (
           SELECT 1 FROM pg_constraint
           WHERE conname =
             'operations_commerce_store_sync_receipts_idempotency_unique'
             AND contype = 'u'
         ) AS receipt_unique,
         EXISTS (
           SELECT 1 FROM pg_trigger
           WHERE tgname =
             'validate_operations_commerce_store_sync_identity_write'
             AND tgtype = 23 AND tgenabled = 'O' AND NOT tgisinternal
         ) AS control_guard,
         EXISTS (
           SELECT 1 FROM pg_trigger
           WHERE tgname =
             'protect_operations_commerce_store_sync_receipt_write'
             AND tgtype = 27 AND tgenabled = 'O' AND NOT tgisinternal
         ) AS receipt_guard`,
    )
    assert.deepEqual(structural.rows[0], {
      control_pk: true,
      control_fk: true,
      receipt_unique: true,
      control_guard: true,
      receipt_guard: true,
    })

    const post0314Client = await pool.connect()
    try {
      await applyMigration(
        post0314Client,
        '0314_operations_local_work_independent_activation.sql',
      )
    } finally {
      post0314Client.release()
    }
    let post0314ManualProviderCalls = 0
    let post0314AutomaticProviderCalls = 0
    for (const activationState of ['disabled', 'frozen']) {
      const account = fixtures.find((value) => value.state === activationState)
      assert.ok(account)
      await assert.rejects(
        persistence.withCommerceStoreSyncProviderReadFenceInPostgres({
          organizationId: account.organizationId,
          integrationAccountId: account.accountId,
          authorityKind: 'automatic',
          readKind: 'order_history',
          intentKey: `acceptance:${activationState}:post-0314-automatic:1`,
          acquiredBy: actorEmail,
          async read() {
            post0314AutomaticProviderCalls += 1
            return 'must-not-run'
          },
        }),
        (error) => (
          error?.code === 'COMMERCE_STORE_SYNC_PROVIDER_READ_PAUSED'
        ),
      )
      assert.equal(
        await persistence.withCommerceStoreSyncProviderReadFenceInPostgres({
          organizationId: account.organizationId,
          integrationAccountId: account.accountId,
          authorityKind: 'manual_read_only',
          readKind: 'order_revision',
          intentKey: `acceptance:${activationState}:post-0314-manual-refresh:1`,
          acquiredBy: actorEmail,
          async read() {
            post0314ManualProviderCalls += 1
            return `manual-read-completed-after-0314:${activationState}`
          },
        }),
        `manual-read-completed-after-0314:${activationState}`,
      )
    }
    assert.equal(post0314AutomaticProviderCalls, 0)
    assert.equal(post0314ManualProviderCalls, 2)

    const post0340Client = await pool.connect()
    try {
      await applyMigration(
        post0340Client,
        '0340_operations_order_workbench_exact_history.sql',
      )
    } finally {
      post0340Client.release()
    }
    assert.equal(
      await storeSyncRewrittenFunctionHealth(pool),
      true,
      'Exact order-history migration must preserve rewritten-function health',
    )
    assert.equal(
      await storeSyncAuthorityContract(pool),
      'legacy-writer-compatible',
      'Exact order-history migration must preserve Store sync authority',
    )
    await assertRewrittenFunctionTamperDetected(
      pool,
      `ALTER FUNCTION protect_commerce_order_observation_lineage()
       RESET ALL`,
    )
    const checksumTamperClient = await pool.connect()
    try {
      await checksumTamperClient.query('BEGIN')
      await checksumTamperClient.query(
        `UPDATE public.schema_migrations
         SET checksum = repeat('0', 64)
         WHERE filename =
           '0340_operations_order_workbench_exact_history.sql'`,
      )
      assert.equal(
        await storeSyncRewrittenFunctionHealth(checksumTamperClient),
        false,
        'Exact order-history migration checksum drift must fail health',
      )
    } finally {
      await checksumTamperClient.query('ROLLBACK').catch(() => {})
      checksumTamperClient.release()
    }
    assert.equal(await storeSyncRewrittenFunctionHealth(pool), true)

    const post0341Client = await pool.connect()
    try {
      await applyMigration(
        post0341Client,
        '0341_operations_faire_order_workbench_exact_history.sql',
      )
    } finally {
      post0341Client.release()
    }
    const post0341Catalog = await readStoreSyncHealthCatalog(pool)
    if (process.argv.includes('--print-fingerprints')) {
      console.log(JSON.stringify(post0341Catalog, null, 2))
    }
    assert.equal(
      post0341Catalog.rewrittenHash,
      '354a02eca72636fc7f298f7a7438bbd043340072507503a11dd12e949185304e',
      'Faire exact-history migration must produce the reviewed function hash',
    )
    assert.equal(
      await storeSyncRewrittenFunctionHealth(pool),
      true,
      'Faire exact-history migration must preserve rewritten-function health',
    )
    assert.equal(
      await storeSyncAuthorityContract(pool),
      'legacy-writer-compatible',
      'Faire exact-history migration must preserve Store sync authority',
    )
    await assertRewrittenFunctionTamperDetected(
      pool,
      `ALTER FUNCTION commerce_order_observation_accepts_children(uuid, uuid)
       RESET ALL`,
    )
    const faireChecksumTamperClient = await pool.connect()
    try {
      await faireChecksumTamperClient.query('BEGIN')
      await faireChecksumTamperClient.query(
        `UPDATE public.schema_migrations
         SET checksum = repeat('0', 64)
         WHERE filename =
           '0341_operations_faire_order_workbench_exact_history.sql'`,
      )
      assert.equal(
        await storeSyncRewrittenFunctionHealth(faireChecksumTamperClient),
        false,
        'Faire exact-history migration checksum drift must fail health',
      )
    } finally {
      await faireChecksumTamperClient.query('ROLLBACK').catch(() => {})
      faireChecksumTamperClient.release()
    }
    assert.equal(await storeSyncRewrittenFunctionHealth(pool), true)
  } finally {
    await pool.end()
  }
}

async function main() {
  const migrationSource = readFileSync(
    resolve(root, 'db/migrations/0298_operations_commerce_store_sync_controls.sql'),
    'utf8',
  )
  const migrationSha256 = createHash('sha256')
    .update(migrationSource)
    .digest('hex')
  const storeSyncPersistenceSource = readFileSync(
    resolve(root, 'app_src/lib/persistence/commerceStoreSync.ts'),
    'utf8',
  )
  assert.match(
    storeSyncPersistenceSource,
    /AND operations_commerce_provider_read_authority_is_current\(\s*account\.organization_id,\s*account\.id,\s*\$3\s*\)\s*LIMIT 1\s*FOR SHARE OF account, control, activation/u,
    'Provider-read preflight must use the same exact authority as its insert trigger',
  )
  assert.doesNotMatch(
    storeSyncPersistenceSource,
    /\$3 = 'manual_read_only'\s*OR operations_commerce_store_sync_is_running/u,
    'Provider-read preflight must not bypass exact manual-read authority',
  )
  const storeSyncHealthSource = readFileSync(
    resolve(root, 'app_src/lib/persistence/commerceStoreSyncHealth.ts'),
    'utf8',
  )
  const exactHistoryMigrationSource = readFileSync(
    resolve(
      root,
      'db/migrations/0340_operations_order_workbench_exact_history.sql',
    ),
    'utf8',
  )
  const exactHistoryMigrationChecksum = createHash('sha256')
    .update(exactHistoryMigrationSource)
    .digest('hex')
  const faireExactHistoryMigrationSource = readFileSync(
    resolve(
      root,
      'db/migrations/0341_operations_faire_order_workbench_exact_history.sql',
    ),
    'utf8',
  )
  const faireExactHistoryMigrationChecksum = createHash('sha256')
    .update(faireExactHistoryMigrationSource)
    .digest('hex')
  const healthRouteSource = readFileSync(
    resolve(root, 'app_src/app/api/health/route.ts'),
    'utf8',
  )
  const outerHealthFilename = healthRouteSource.indexOf(
    "'0298_operations_commerce_store_sync_controls.sql'",
  )
  const outerHealthStart = healthRouteSource.lastIndexOf(
    'EXISTS (',
    outerHealthFilename,
  )
  const outerHealthEnd = healthRouteSource.indexOf(
    ') AS operations_commerce_store_sync_controls_applied',
    outerHealthStart,
  )
  assert.ok(
    outerHealthStart >= 0 && outerHealthEnd > outerHealthStart,
    'The runtime health route must expose the Store sync applied gate',
  )
  const outerHealthSql = healthRouteSource.slice(
    outerHealthStart,
    outerHealthEnd,
  )
  for (const requiredFragment of [
    'FROM public.schema_migrations',
    "pg_catalog.to_regclass(\n                'public.operations_commerce_store_sync_controls'",
    'FROM public.operations_integration_accounts account',
    'LEFT JOIN public.operations_commerce_store_sync_controls control',
    'public.operations_commerce_store_sync_effective_reason(',
  ]) {
    assert.ok(
      outerHealthSql.includes(requiredFragment),
      `The outer Store sync health gate must bind ${requiredFragment}`,
    )
  }
  assert.doesNotMatch(
    outerHealthSql,
    /FROM\s+schema_migrations\b/u,
    'The outer Store sync health gate must not resolve a caller-schema ledger',
  )
  assert.ok(
    storeSyncHealthSource.includes(`'${migrationSha256}'`),
    'Store sync health must pin the exact 0298 migration bytes',
  )
  assert.ok(
    storeSyncHealthSource.includes(`'${exactHistoryMigrationChecksum}'`),
    'Store sync health must pin the exact 0340 migration bytes',
  )
  assert.ok(
    storeSyncHealthSource.includes(`'${faireExactHistoryMigrationChecksum}'`),
    'Store sync health must pin the exact 0341 migration bytes',
  )
  for (const contract of [
    'legacy-writer-compatible',
    'strict-explicit',
  ]) {
    assert.ok(
      storeSyncHealthSource.includes(`'${contract}'`),
      `Store sync health must expose the ${contract} rollout phase`,
    )
  }
  assert.ok(
    storeSyncHealthSource.includes(`'${futureCommerceRolloutContractChecksum}'`),
    'Release 1 health must recognize only the frozen 0305 contract migration',
  )
  assert.equal(
    (
      storeSyncHealthSource.match(
        /installed_constraint\.contype OPERATOR\(pg_catalog\.<>\) 'n'/gu,
      ) || []
    ).length,
    1,
    'Store sync health must exclude PostgreSQL 18 NOT NULL constraint rows exactly once',
  )
  assert.equal(
    (
      futureCommerceRolloutContractMigration.match(
        /installed_constraint\.contype <> 'n'/gu,
      ) || []
    ).length,
    2,
    'The frozen 0305 precondition and postcondition must both exclude PostgreSQL 18 NOT NULL rows',
  )
  assert.equal(
    migrationSource.match(
      /ADD COLUMN IF NOT EXISTS provider_read_authority text\s+NOT NULL DEFAULT 'automatic'/gu,
    )?.length,
    3,
    '0298 must metadata-backfill all three legacy authority columns',
  )
  assert.equal(
    migrationSource.match(
      /ALTER COLUMN provider_read_authority DROP DEFAULT/gu,
    )?.length || 0,
    0,
    '0298 must retain the automatic compatibility defaults for the first rollout',
  )
  for (const table of [
    'operations_commerce_intake_read_intents',
    'operations_commerce_product_image_observation_sets',
    'operations_commerce_product_image_import_jobs',
  ]) {
    assert.doesNotMatch(
      migrationSource,
      new RegExp(`UPDATE\\s+(?:public\\.)?${table}\\b`, 'u'),
      `0298 must not fire legacy row-update guards while backfilling ${table}`,
    )
  }
  command('docker', ['info'], { timeout: 30_000 })
  const container =
    `clawpilot-store-sync-${process.pid}-${randomUUID().slice(0, 8)}`
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=clawpilot_store_sync',
      '-e', 'POSTGRES_DB=clawpilot_store_sync',
      '-p', '127.0.0.1::5432',
      disposablePostgresImage,
    ], { timeout: 180_000 })
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
    assert.ok(port > 0, `Unable to resolve PostgreSQL port: ${portOutput}`)
    const databaseUrl = (
      'postgresql://postgres:clawpilot_store_sync@127.0.0.1:'
      + `${port}/clawpilot_store_sync`
    )
    await waitForPostgres(databaseUrl)
    const pool = new Pool({ connectionString: databaseUrl, max: 1 })
    const client = await pool.connect()
    const files = migrations()
    assert.equal(
      files.includes('0305_operations_commerce_rollout_contract.sql'),
      false,
      'The 0305 contract must ship only after Release 1 is live',
    )
    const migration = '0298_operations_commerce_store_sync_controls.sql'
    const migrationIndex = files.indexOf(migration)
    assert.ok(migrationIndex > 0, '0298 Store sync migration is missing')
    const fixtures = [
      fixture(1, 'shadow'),
      fixture(2, 'active'),
      fixture(3, 'read_only'),
      fixture(4, 'disabled'),
      fixture(5, 'frozen'),
    ]
    try {
      for (const file of files.slice(0, migrationIndex)) {
        await applyMigration(client, file)
      }
      await client.query(
        `INSERT INTO app_users (email, role, status)
         VALUES ($1, 'owner', 'active')`,
        [actorEmail],
      )
      for (const value of fixtures) await seedAccount(client, value)
      const legacyFixture = fixtures.find((value) => value.state === 'active')
      assert.ok(legacyFixture)
      await seedLegacyProviderReadAuthorityEvidence(client, legacyFixture)
      await applyMigration(client, migration)
      const oldRuntimeCompatibilityFixture = fixtures.find(
        (value) => value.state === 'shadow',
      )
      assert.ok(oldRuntimeCompatibilityFixture)
      await seedLegacyProviderReadAuthorityEvidence(
        client,
        oldRuntimeCompatibilityFixture,
      )
    } finally {
      client.release()
      await pool.end()
    }
    await verify(databaseUrl, fixtures)
  } finally {
    spawnSync('docker', ['stop', '-t', '1', container], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000,
    })
  }
  console.log('Commerce Store sync disposable-PostgreSQL acceptance passed')
}

if (resolve(process.argv[1] || '') === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
