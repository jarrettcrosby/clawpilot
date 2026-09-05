#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const releaseACompatibilityMarker = readFileSync(
  resolve(
    root,
    'db/migrations/0300_operations_order_training_independent_control.sql',
  ),
  'utf8',
)
const releaseACompatibilityMarkerChecksum =
  '1369a29d818c56f8bfdfa1ee1340c2e6902af9445ca8f00c8dc184b9685d4b84'
assert.equal(
  createHash('sha256').update(releaseACompatibilityMarker).digest('hex'),
  releaseACompatibilityMarkerChecksum,
  'The executable Release A 0300 compatibility marker must remain byte-exact',
)
const futureIndependentControlContract = readFileSync(
  resolve(
    root,
    'scripts/fixtures/0306_operations_order_training_independent_control_contract.sql',
  ),
  'utf8',
)
const futureIndependentControlChecksum =
  '0f7bb5f6e2b82569f5ba42822d41e4f42772366fdd572e772c12bfc5d413a4e1'
assert.equal(
  createHash('sha256').update(futureIndependentControlContract).digest('hex'),
  futureIndependentControlChecksum,
  'The frozen 0306 independent-control contract must remain byte-exact',
)
assert.equal(
  existsSync(
    resolve(
      root,
      'db/migrations/0306_operations_order_training_independent_control_contract.sql',
    ),
  ),
  false,
  'Release A must not contain the executable 0306 migration',
)
const healthSource = readFileSync(
  resolve(root, 'app_src/app/api/health/route.ts'),
  'utf8',
)
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const { Pool } = requireFromApp('pg')

const sqlMatch = healthSource.match(
  /const OPERATIONS_SHADOW_TRAINING_HEALTH_SQL = String\.raw`([\s\S]*?)`\n/u,
)
assert.ok(sqlMatch, 'Health route must contain the exact 0290 attestation SQL')
const attestationSql = sqlMatch[1]
const authorityContractMatch = healthSource.match(
  /const OPERATIONS_SHADOW_TRAINING_AUTHORITY_CONTRACT_SQL = String\.raw`([\s\S]*?)`\n/u,
)
assert.ok(
  authorityContractMatch,
  'Health route must contain the shadow training rollout-phase SQL',
)
const authorityContractSql = authorityContractMatch[1].replaceAll(
  '${OPERATIONS_SHADOW_TRAINING_HEALTH_SQL}',
  attestationSql,
)

const requiredStructure = [
  '0290_operations_shadow_training_runs.sql',
  '86ca66773b0a64e2b78aabfc35b5419ddc022123f96ab402204bbf0724e8aef0',
  '0300_operations_order_training_independent_control.sql',
  releaseACompatibilityMarkerChecksum,
  '0306_operations_order_training_independent_control_contract.sql',
  futureIndependentControlChecksum,
  '0314_operations_local_work_independent_activation.sql',
  '2c69fa93d265ced3a0019cc5f5b6770ae2890146e4bc00d213d9b67ae18d7d3c',
  'operations_shadow_training_runs',
  'operations_shadow_training_packages',
  'operations_shadow_training_pick_tasks',
  'operations_shadow_training_label_links',
  'operations_shadow_training_events',
  '94b2140dfccc4cbe4be93f7a012209f62c42e843571e98478eaed8138f184ca4',
  '901e43b88b31a4b9351fcfd47922662d4279521cee47565dc58acbf316097286',
  '2135b70fd76d308d4f20e57343a507fa0d7ddbc20b9d1ebb6f357b537a522c83',
  'c22cef6f8aa8f8fb01e82a154d6c4e93e8ed79eda97a2539ff91c6bdcd4ec834',
  '16a6e0621dc8e4baa112f231a094243cfd222230f73ecba4b842ba3006f2dba4',
  '6898d7e22abcb3963c55bac7f3eb30cef0eda6dd8ca030d36e1bf99d3f683cd0',
  '340ca4ea1323121e8316f852e9240f21cc99fb23bf53eb312d923617347c3bce',
  '1ec65dc17177ce3d53776ebb035f175f0d7ba10900d2dc5de88bfb31aafd5ea0',
  '9a033b6182465d99682fc1ecee2dca0302ac95f726b1f2b3d1ef6c7bc932371a',
  '0c8485310e1dade3adfd8b38128b7ea288975456f2ff796fa9160a5757881dad',
  '4d0a836345d3bc310ad27d9ae4f74a25b0bc2bf246e10712b3e2427bd168cf93',
  '8425b26ae132be23ef0b835fc03b5ac35bf0b42b2728a098ff1184f62f4fa1fc',
  'c1fa92771860f78c76184fae9ffa538cb772d25efd0fadc23d2f72192f106e21',
  'e15f2304f2daa3d4ec1238374d052368f57c68bf6df030bbdd21735e245bf230',
  '786a373981688256f1f83b94208b405a2b6446d04a21678a2a76a4110005d14e',
  'eac242f228f3865c002e492a3e451a519d63c642794ca4c102ac0a7f34e710a3',
  'ddceac2ff8a9ed2b03757c6111059c78aeba3dcbedd2060315166cf1b0ffda65',
  'a5b376395ea46576c38bcd3dabb9e1a57b97aeeb37bef308afdec3ce4fa0e053',
  'b6f80a886cf6d6218b714c8588219464a07c801991fa727de219db515861855f',
  'operations_shadow_training_runs_one_open_order',
  "(state <> ''reset''::text)",
  'validate_operations_shadow_training_package_fact()',
  'validate_operations_shadow_training_pick_fact()',
  'validate_operations_shadow_training_plan_coverage()',
  'protect_operations_shadow_training_run()',
  'validate_operations_shadow_training_run_identity()',
  'protect_operations_shadow_training_package()',
  'protect_operations_shadow_training_pick_task()',
  'protect_operations_shadow_training_event()',
  'validate_operations_shadow_training_label_link()',
  'guard_shadow_commerce_canonical_write()',
  'guard_shadow_training_activation_change()',
  'validate_operations_shadow_training_package_fact_commit',
  'validate_operations_shadow_training_pick_fact_commit',
  'validate_operations_shadow_training_plan_coverage_update',
  'validate_operations_shadow_training_run_identity_mutation',
  'protect_operations_shadow_training_run_mutation',
  'protect_operations_shadow_training_package_mutation',
  'protect_operations_shadow_training_pick_task_mutation',
  'protect_operations_shadow_training_event_mutation',
  'validate_operations_shadow_training_label_link_mutation',
  'guard_shadow_commerce_canonical_plan_insert',
  'guard_shadow_commerce_canonical_reservation_insert',
  'guard_shadow_commerce_canonical_shipment_insert',
  'guard_shadow_commerce_canonical_export_insert',
  'guard_shadow_training_activation_change_insert',
  'guard_shadow_training_activation_change_update',
  'guard_shadow_training_activation_change_delete',
  'FROM public.schema_migrations',
  "('public.operations_shadow_training_runs')",
  'FROM public.global_reference_entity_types',
  'FROM pg_catalog.pg_trigger installed_trigger',
  ') = 16',
  'search_path=pg_catalog, public, pg_temp',
  'installed_index.indisunique',
  'installed_index.indisvalid',
  'installed_index.indisready',
  "installed_trigger.tgenabled = 'O'",
  'installed_trigger.tgqual IS NULL',
  'installed_trigger.tgdeferrable',
  'installed_trigger.tginitdeferred',
  'installed_trigger.tgattr',
  "THEN ARRAY['state']::name[]",
  'gtrn',
  'gtpk',
  'gtpt',
  'gtll',
  'gtev',
]
for (const fragment of requiredStructure) {
  assert.ok(
    attestationSql.includes(fragment),
    `0290 health attestation missing ${fragment}`,
  )
}
for (const unsafeResolution of [
  /FROM schema_migrations/u,
  /FROM global_reference_entity_types/u,
  /FROM pg_(?:class|attribute|attrdef|constraint|index|proc|language|namespace|trigger)\b/u,
  /(?<![.])to_reg(?:class|procedure)\(/u,
]) {
  assert.doesNotMatch(
    attestationSql,
    unsafeResolution,
    `Shadow training health must reject unsafe resolution ${unsafeResolution}`,
  )
}
for (const phase of [
  'profile-bound-compatible',
  'independent-strict',
  'local-work-independent',
]) {
  assert.ok(
    healthSource.includes(`'${phase}'`),
    `Shadow training health must expose the ${phase} phase`,
  )
}

assert.ok(
  (healthSource.match(/row\?\.operations_shadow_training_applied/gu) || [])
    .length >= 3,
  '0290 structural drift must fail migrationsCurrent and global health',
)
assert.match(
  healthSource,
  /&& row\?\.operations_shadow_training_applied/u,
  '0290 attestation must participate in migrationsCurrent',
)
assert.match(
  healthSource,
  /\|\| !row\?\.operations_shadow_training_applied/u,
  '0290 attestation failure must append the global migration health error',
)
assert.match(
  healthSource,
  /shadowTraining: \{[\s\S]*?operations_shadow_training_applied[\s\S]*?'migration-or-structure-pending'/u,
  '0290 attestation must be visible in the health response',
)
assert.match(
  healthSource,
  /shadowTraining: \{[\s\S]*?authorityContract:[\s\S]*?operations_shadow_training_authority_contract/u,
  'Shadow training health must expose the active rolling authority contract',
)
assert.match(
  healthSource,
  /status:\s*errors\.length > 0\s*\?\s*503\s*:\s*200/u,
  'Any global health error, including 0290 drift during key adoption, must return HTTP 503',
)

function command(file, args, options = {}) {
  return execFileSync(file, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  }).trim()
}

async function waitForPostgres(databaseUrl) {
  const deadline = Date.now() + 45_000
  let lastError = null
  while (Date.now() < deadline) {
    const pool = new Pool({
      connectionString: databaseUrl,
      connectionTimeoutMillis: 1_000,
      max: 1,
    })
    try {
      await pool.query('SELECT 1')
      await pool.end()
      return
    } catch (error) {
      lastError = error
      await pool.end().catch(() => undefined)
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
    }
  }
  throw lastError || new Error('Disposable PostgreSQL did not become ready')
}

async function attest(pool) {
  const result = await pool.query(`SELECT (${attestationSql}) AS applied`)
  return result.rows[0]?.applied === true
}

async function authorityContract(pool) {
  const result = await pool.query(
    `SELECT (${authorityContractSql}) AS authority_contract`,
  )
  return result.rows[0]?.authority_contract
}

async function futureLedgerCount(queryable) {
  const result = await queryable.query(
    `SELECT count(*)::integer AS ledger_count
     FROM public.schema_migrations
     WHERE filename =
       '0306_operations_order_training_independent_control_contract.sql'`,
  )
  return Number(result.rows[0]?.ledger_count || 0)
}

async function assertProfileBoundGreen(queryable, label) {
  assert.equal(
    await futureLedgerCount(queryable),
    0,
    `${label}: the 0306 ledger must remain absent`,
  )
  assert.equal(
    await attest(queryable),
    true,
    `${label}: rollback must restore green Release A health`,
  )
  assert.equal(
    await authorityContract(queryable),
    'profile-bound-compatible',
    `${label}: rollback must restore the profile-bound phase`,
  )
}

async function rejectFutureContractForPredecessor(
  pool,
  { setupSql, expectedError, label, expectHealthRed = false },
) {
  await assertProfileBoundGreen(pool, `${label} precondition`)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(setupSql)
    assert.equal(
      await futureLedgerCount(client),
      0,
      `${label}: predecessor drift must be tested without a 0306 ledger`,
    )
    if (expectHealthRed) {
      assert.equal(
        await attest(client),
        false,
        `${label}: the extra binding must make health red before 0306`,
      )
      assert.equal(
        await authorityContract(client),
        'invalid',
        `${label}: the extra binding must invalidate the rollout phase`,
      )
    }
    await assert.rejects(
      client.query(futureIndependentControlContract),
      (error) => {
        assert.match(String(error?.message || error), expectedError, label)
        return true
      },
      label,
    )
  } finally {
    await client.query('ROLLBACK').catch(() => undefined)
    client.release()
  }
  await assertProfileBoundGreen(pool, `${label} rollback`)
}

const functionCatalogTampers = [
  {
    label: 'SECURITY DEFINER',
    sql: `ALTER FUNCTION
            public.validate_operations_shadow_training_run_identity()
          SECURITY DEFINER`,
  },
  {
    label: "SET search_path='pg_catalog'",
    sql: `ALTER FUNCTION
            public.validate_operations_shadow_training_run_identity()
          SET search_path = 'pg_catalog'`,
  },
  {
    label: 'LEAKPROOF',
    sql: `ALTER FUNCTION
            public.validate_operations_shadow_training_run_identity()
          LEAKPROOF`,
  },
]

async function exerciseFunctionCatalogTampers(pool, phase) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    if (phase === 'independent-strict') {
      await client.query(futureIndependentControlContract)
      await client.query(
        `INSERT INTO schema_migrations (filename, checksum)
         VALUES (
           '0306_operations_order_training_independent_control_contract.sql',
           $1
         )`,
        [futureIndependentControlChecksum],
      )
    }
    assert.equal(
      await attest(client),
      true,
      `${phase}: exact function metadata must start green`,
    )
    assert.equal(
      await authorityContract(client),
      phase,
      `${phase}: the requested rollout phase must be active`,
    )

    for (const tamper of functionCatalogTampers) {
      let savepointStarted = false
      try {
        await client.query('SAVEPOINT shadow_training_function_catalog_tamper')
        savepointStarted = true
        await client.query(tamper.sql)
        assert.equal(
          await attest(client),
          false,
          `${phase}: ${tamper.label} must make health red`,
        )
      } finally {
        if (savepointStarted) {
          await client.query(
            'ROLLBACK TO SAVEPOINT shadow_training_function_catalog_tamper',
          ).catch(() => undefined)
          await client.query(
            'RELEASE SAVEPOINT shadow_training_function_catalog_tamper',
          ).catch(() => undefined)
        }
      }
      assert.equal(
        await attest(client),
        true,
        `${phase}: rolling back ${tamper.label} must restore green health`,
      )
      assert.equal(
        await authorityContract(client),
        phase,
        `${phase}: rolling back ${tamper.label} must preserve the phase`,
      )
    }
  } finally {
    await client.query('ROLLBACK').catch(() => undefined)
    client.release()
  }
  await assertProfileBoundGreen(pool, `${phase} catalog-tamper suite`)
}

async function exerciseForeignFirstNamespaceSafety(pool) {
  const spoofClient = await pool.connect()
  try {
    await spoofClient.query('BEGIN')
    await spoofClient.query(
      `CREATE SCHEMA shadow_training_spoof;
       SET LOCAL search_path =
         shadow_training_spoof, public`,
    )
    for (const [label, sql] of [
      [
        'ledger',
        `CREATE TABLE shadow_training_spoof.schema_migrations AS
           TABLE public.schema_migrations`,
      ],
      [
        'reference registry',
        `CREATE TABLE
           shadow_training_spoof.global_reference_entity_types AS
           TABLE public.global_reference_entity_types`,
      ],
      [
        'training table',
        `CREATE TABLE
           shadow_training_spoof.operations_shadow_training_runs (
             organization_id uuid,
             state text
           )`,
      ],
      [
        'pg_proc catalog',
        'CREATE TABLE shadow_training_spoof.pg_proc (oid oid)',
      ],
      [
        'pg_trigger catalog',
        'CREATE TABLE shadow_training_spoof.pg_trigger (tgfoid oid)',
      ],
      [
        'to_regclass resolver',
        `CREATE FUNCTION shadow_training_spoof.to_regclass(text)
         RETURNS regclass LANGUAGE sql IMMUTABLE AS
           'SELECT NULL::regclass'`,
      ],
      [
        'to_regprocedure resolver',
        `CREATE FUNCTION shadow_training_spoof.to_regprocedure(text)
         RETURNS regprocedure LANGUAGE sql IMMUTABLE AS
           'SELECT NULL::regprocedure'`,
      ],
      [
        'digest resolver',
        `CREATE FUNCTION shadow_training_spoof.digest(bytea, text)
         RETURNS bytea LANGUAGE sql IMMUTABLE AS
           'SELECT decode(repeat(''00'', 32), ''hex'')'`,
      ],
    ]) {
      await spoofClient.query(sql)
      assert.equal(
        await attest(spoofClient),
        true,
        `Foreign-first ${label} lookalike must not affect health`,
      )
    }
    await spoofClient.query(
      `UPDATE public.schema_migrations
       SET checksum = repeat('0', 64)
       WHERE filename = '0290_operations_shadow_training_runs.sql'`,
    )
    assert.equal(
      await attest(spoofClient),
      false,
      'Foreign-first exact-looking ledgers must not mask public ledger drift',
    )
    assert.equal(
      await authorityContract(spoofClient),
      'invalid',
      'Foreign-first lookalikes must not create a healthy rollout phase',
    )
  } finally {
    await spoofClient.query('ROLLBACK').catch(() => undefined)
    spoofClient.release()
  }
  await assertProfileBoundGreen(pool, 'foreign-first health rollback')

  const runtimeClient = await pool.connect()
  const probeOrganizationId = randomUUID()
  try {
    await runtimeClient.query('BEGIN')
    await runtimeClient.query(futureIndependentControlContract)
    await runtimeClient.query(
      `INSERT INTO public.schema_migrations (filename, checksum)
       VALUES (
         '0306_operations_order_training_independent_control_contract.sql',
         $1
       )`,
      [futureIndependentControlChecksum],
    )
    const pinnedFunctions = await runtimeClient.query(
      `SELECT pg_catalog.count(*)::integer AS pinned_count
       FROM (VALUES
         ('public.validate_operations_shadow_training_package_fact()'),
         ('public.validate_operations_shadow_training_pick_fact()'),
         ('public.validate_operations_shadow_training_plan_coverage()'),
         ('public.protect_operations_shadow_training_run()'),
         ('public.validate_operations_shadow_training_run_identity()'),
         ('public.protect_operations_shadow_training_package()'),
         ('public.protect_operations_shadow_training_pick_task()'),
         ('public.protect_operations_shadow_training_event()'),
         ('public.validate_operations_shadow_training_label_link()'),
         ('public.guard_shadow_commerce_canonical_write()'),
         ('public.guard_shadow_training_activation_change()')
       ) AS required(signature)
       JOIN pg_catalog.pg_proc installed
         ON installed.oid =
              pg_catalog.to_regprocedure(required.signature)
       WHERE pg_catalog.array_to_string(installed.proconfig, ',') =
             'search_path=pg_catalog, public, pg_temp'`,
    )
    assert.equal(
      pinnedFunctions.rows[0]?.pinned_count,
      11,
      'Strict 0306 must pin all 11 trigger functions to the safe search path',
    )
    await runtimeClient.query(
      `CREATE SCHEMA shadow_training_runtime_spoof;
       CREATE TABLE
         shadow_training_runtime_spoof.operations_shadow_training_runs (
           organization_id uuid,
           state text
         );
       CREATE TEMP TABLE shadow_training_runtime_probe (
         organization_id uuid PRIMARY KEY
       );
       CREATE TRIGGER shadow_training_runtime_probe_delete
       BEFORE DELETE ON shadow_training_runtime_probe
       FOR EACH ROW EXECUTE FUNCTION
         public.guard_shadow_training_activation_change()`,
    )
    await runtimeClient.query(
      `INSERT INTO
         shadow_training_runtime_spoof.operations_shadow_training_runs (
           organization_id,
           state
         ) VALUES ($1::uuid, 'enabled')`,
      [probeOrganizationId],
    )
    await runtimeClient.query(
      `INSERT INTO shadow_training_runtime_probe (organization_id)
       VALUES ($1::uuid)`,
      [probeOrganizationId],
    )
    await runtimeClient.query(
      `SET LOCAL search_path = shadow_training_runtime_spoof, public`,
    )
    const deletedProbe = await runtimeClient.query(
      `DELETE FROM pg_temp.shadow_training_runtime_probe
       WHERE organization_id = $1::uuid
       RETURNING organization_id::text`,
      [probeOrganizationId],
    )
    assert.equal(
      deletedProbe.rows[0]?.organization_id,
      probeOrganizationId,
      'Strict runtime must ignore a foreign-first training-run lookalike',
    )
  } finally {
    await runtimeClient.query('ROLLBACK').catch(() => undefined)
    runtimeClient.release()
  }
  await assertProfileBoundGreen(pool, 'foreign-first runtime rollback')
}

async function exercise(pool) {
  if (await authorityContract(pool) === 'local-work-independent') {
    assert.equal(
      await attest(pool),
      true,
      'Fresh 0314 schema must preserve exact-order training isolation',
    )
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      for (const [label, tamperSql] of [
        [
          '0314 ledger checksum',
          `UPDATE public.schema_migrations
           SET checksum = repeat('0', 64)
           WHERE filename =
             '0314_operations_local_work_independent_activation.sql'`,
        ],
        [
          'exact-order canonical-write guard',
          `CREATE OR REPLACE FUNCTION
             public.guard_shadow_commerce_canonical_write()
           RETURNS trigger LANGUAGE plpgsql AS $$
           BEGIN RETURN NEW; END;
           $$`,
        ],
        [
          'canonical-plan trigger binding',
          `ALTER TABLE public.operations_fulfillment_plans
           DISABLE TRIGGER guard_shadow_commerce_canonical_plan_insert`,
        ],
      ]) {
        await client.query('SAVEPOINT local_work_health_tamper')
        try {
          await client.query(tamperSql)
          assert.equal(
            await attest(client),
            false,
            `${label} drift must make exact health red`,
          )
          assert.equal(
            await authorityContract(client),
            'invalid',
            `${label} drift must invalidate the rollout phase`,
          )
        } finally {
          await client.query('ROLLBACK TO SAVEPOINT local_work_health_tamper')
          await client.query('RELEASE SAVEPOINT local_work_health_tamper')
        }
        assert.equal(await attest(client), true)
        assert.equal(
          await authorityContract(client),
          'local-work-independent',
        )
      }
    } finally {
      await client.query('ROLLBACK').catch(() => undefined)
      client.release()
    }
    assert.equal(await attest(pool), true)
    assert.equal(await authorityContract(pool), 'local-work-independent')
    return
  }
  assert.equal(
    await attest(pool),
    true,
    'Fresh Release A schema must pass with the exact 0290 function bodies',
  )
  assert.equal(
    await authorityContract(pool),
    'profile-bound-compatible',
    'Release A must expose its temporary profile-bound compatibility phase',
  )

  await rejectFutureContractForPredecessor(pool, {
    setupSql: `CREATE OR REPLACE FUNCTION
                 guard_shadow_training_activation_change()
               RETURNS trigger LANGUAGE plpgsql AS $$
               BEGIN
                 IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
                 RETURN NEW;
               END;
               $$`,
    expectedError: /requires exact profile-bound predecessors/u,
    label: '0306 must reject a weakened profile-bound function',
  })
  await rejectFutureContractForPredecessor(pool, {
    setupSql: `ALTER TABLE operations_activation_scopes
               DISABLE TRIGGER
                 guard_shadow_training_activation_change_update`,
    expectedError: /requires exact predecessor trigger bindings/u,
    label: '0306 must reject a disabled affected trigger',
  })
  await rejectFutureContractForPredecessor(pool, {
    setupSql: `CREATE SCHEMA shadow_training_extra_binding;
               CREATE TABLE shadow_training_extra_binding.probe (
                 id integer
               );
               CREATE TRIGGER shadow_training_extra_binding_probe
               BEFORE INSERT ON shadow_training_extra_binding.probe
               FOR EACH ROW EXECUTE FUNCTION
                 public.protect_operations_shadow_training_event()`,
    expectedError: /requires exact predecessor trigger bindings/u,
    label: '0306 must reject an extra inherited-function binding in any schema',
    expectHealthRed: true,
  })
  await rejectFutureContractForPredecessor(pool, {
    setupSql: `CREATE OR REPLACE FUNCTION
                 public.protect_operations_shadow_training_event()
               RETURNS trigger LANGUAGE plpgsql AS $$
               BEGIN
                 RETURN NEW;
               END;
               $$`,
    expectedError: /requires exact profile-bound predecessors/u,
    label: '0306 must reject inherited function-source drift',
  })
  await rejectFutureContractForPredecessor(pool, {
    setupSql: `UPDATE schema_migrations
               SET checksum = repeat('0', 64)
               WHERE filename = '0290_operations_shadow_training_runs.sql'`,
    expectedError: /requires exact 0290 and 0300 predecessors/u,
    label: '0306 must reject a wrong 0290 checksum',
  })
  await rejectFutureContractForPredecessor(pool, {
    setupSql: `UPDATE schema_migrations
               SET checksum = repeat('0', 64)
               WHERE filename =
                 '0300_operations_order_training_independent_control.sql'`,
    expectedError: /requires exact 0290 and 0300 predecessors/u,
    label: '0306 must reject a wrong 0300 checksum',
  })

  await exerciseFunctionCatalogTampers(pool, 'profile-bound-compatible')
  await exerciseFunctionCatalogTampers(pool, 'independent-strict')
  await exerciseForeignFirstNamespaceSafety(pool)

  await pool.query('BEGIN')
  try {
    await pool.query(futureIndependentControlContract)
    assert.equal(
      await attest(pool),
      false,
      'Strict function bodies must not pass without the exact 0306 ledger',
    )
    assert.equal(
      await authorityContract(pool),
      'invalid',
      'Strict bytes without the exact ledger must invalidate the phase',
    )
    await pool.query(
      `INSERT INTO schema_migrations (filename, checksum)
       VALUES (
         '0306_operations_order_training_independent_control_contract.sql',
         $1
       )`,
      [futureIndependentControlChecksum],
    )
    assert.equal(
      await attest(pool),
      true,
      'The exact 0306 bytes and exact ledger must select strict health',
    )
    assert.equal(
      await authorityContract(pool),
      'independent-strict',
      'The exact 0306 ledger must expose the strict phase',
    )
    await pool.query(
      `CREATE OR REPLACE FUNCTION public.guard_shadow_training_activation_change()
       RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
         RETURN NEW;
       END;
       $$`,
    )
    assert.equal(
      await attest(pool),
      false,
      'Strict-phase function drift must fail health',
    )
  } finally {
    await pool.query('ROLLBACK')
  }

  await pool.query('BEGIN')
  try {
    await pool.query(
      `UPDATE schema_migrations
       SET checksum = repeat('0', 64)
       WHERE filename =
         '0300_operations_order_training_independent_control.sql'`,
    )
    assert.equal(
      await attest(pool),
      false,
      'A wrong Release A 0300 marker checksum must fail health',
    )
  } finally {
    await pool.query('ROLLBACK')
  }

  await pool.query('BEGIN')
  try {
    await pool.query(
      `INSERT INTO schema_migrations (filename, checksum)
       VALUES (
         '0306_operations_order_training_independent_control_contract.sql',
         repeat('0', 64)
       )`,
    )
    assert.equal(
      await attest(pool),
      false,
      'A same-name 0306 ledger with the wrong checksum must fail health',
    )
    assert.equal(
      await authorityContract(pool),
      'invalid',
      'A wrong 0306 checksum must expose an invalid rollout phase',
    )
  } finally {
    await pool.query('ROLLBACK')
  }

  await pool.query('BEGIN')
  try {
    await pool.query(
      `INSERT INTO schema_migrations (filename, checksum)
       VALUES (
         '0306_operations_order_training_independent_control_contract.sql',
         $1
       )`,
      [futureIndependentControlChecksum],
    )
    assert.equal(
      await attest(pool),
      false,
      'The exact 0306 ledger must not pass while old function bodies remain',
    )
  } finally {
    await pool.query('ROLLBACK')
  }

  await pool.query('BEGIN')
  try {
    await pool.query(
      `DELETE FROM schema_migrations
       WHERE filename = '0290_operations_shadow_training_runs.sql'`,
    )
    assert.equal(
      await attest(pool),
      false,
      'A missing 0290 migration record must fail health',
    )
  } finally {
    await pool.query('ROLLBACK')
  }

  await pool.query('BEGIN')
  try {
    await pool.query(
      `UPDATE schema_migrations
       SET checksum = repeat('0', 64)
       WHERE filename = '0290_operations_shadow_training_runs.sql'`,
    )
    assert.equal(
      await attest(pool),
      false,
      'A wrong 0290 migration checksum must fail health',
    )
    assert.equal(
      await authorityContract(pool),
      'invalid',
      'A wrong 0290 checksum must invalidate the exposed rollout phase',
    )
  } finally {
    await pool.query('ROLLBACK')
  }

  await pool.query('BEGIN')
  try {
    await pool.query(
      `DELETE FROM schema_migrations
       WHERE filename = '0300_operations_order_training_independent_control.sql'`,
    )
    assert.equal(
      await attest(pool),
      false,
      'A missing 0300 independent-control migration record must fail health',
    )
  } finally {
    await pool.query('ROLLBACK')
  }

  await pool.query('BEGIN')
  try {
    await pool.query(
      `ALTER TABLE operations_shadow_training_packages
       DROP CONSTRAINT operations_shadow_training_packages_sequence_unique`,
    )
    assert.equal(
      await attest(pool),
      false,
      'Removing package-sequence uniqueness must fail health',
    )
  } finally {
    await pool.query('ROLLBACK')
  }

  await pool.query('BEGIN')
  try {
    await pool.query('DROP TABLE operations_shadow_training_events')
    assert.equal(
      await attest(pool),
      false,
      'A missing training ledger must fail health',
    )
  } finally {
    await pool.query('ROLLBACK')
  }

  await pool.query('BEGIN')
  try {
    await pool.query(
      'DROP INDEX operations_shadow_training_runs_one_open_order',
    )
    assert.equal(
      await attest(pool),
      false,
      'Removing the one-open-run fence must fail health',
    )
  } finally {
    await pool.query('ROLLBACK')
  }

  await pool.query('BEGIN')
  try {
    await pool.query(
      `ALTER TABLE operations_shadow_training_runs
       DROP CONSTRAINT operations_shadow_training_runs_terminal_valid,
       ADD CONSTRAINT operations_shadow_training_runs_terminal_valid
         CHECK (state IS NOT NULL)`,
    )
    assert.equal(
      await attest(pool),
      false,
      'A same-named weakened terminal-state check must fail health',
    )
  } finally {
    await pool.query('ROLLBACK')
  }

  await pool.query('BEGIN')
  try {
    await pool.query(
      `ALTER TABLE operations_shadow_training_packages
       DROP CONSTRAINT operations_shadow_training_packages_run_fkey`,
    )
    assert.equal(
      await attest(pool),
      false,
      'Removing exact run-to-package ownership must fail health',
    )
  } finally {
    await pool.query('ROLLBACK')
  }

  await pool.query('BEGIN')
  try {
    await pool.query(
      `CREATE SCHEMA shadow_training_fk_spoof;
       CREATE TABLE
         shadow_training_fk_spoof.operations_shadow_training_runs (
           organization_id uuid NOT NULL,
           id uuid NOT NULL,
           UNIQUE (organization_id, id)
         );
       SET LOCAL search_path = shadow_training_fk_spoof, public;
       ALTER TABLE public.operations_shadow_training_packages
         DROP CONSTRAINT operations_shadow_training_packages_run_fkey;
       ALTER TABLE public.operations_shadow_training_packages
         ADD CONSTRAINT operations_shadow_training_packages_run_fkey
         FOREIGN KEY (organization_id, training_run_id)
         REFERENCES
           shadow_training_fk_spoof.operations_shadow_training_runs (
             organization_id,
             id
           )
         ON DELETE RESTRICT`,
    )
    assert.equal(
      await attest(pool),
      false,
      'A same-name foreign-schema training-run FK target must fail health',
    )
    assert.equal(
      await authorityContract(pool),
      'invalid',
      'A foreign-schema FK target must invalidate the rollout phase',
    )
  } finally {
    await pool.query('ROLLBACK')
  }
  await assertProfileBoundGreen(pool, 'foreign-schema FK rollback')

  await pool.query('BEGIN')
  try {
    await pool.query(
      `CREATE OR REPLACE FUNCTION guard_shadow_commerce_canonical_write()
       RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         RETURN NEW;
       END;
       $$`,
    )
    assert.equal(
      await attest(pool),
      false,
      'Weakening the canonical-write quarantine function must fail health',
    )
  } finally {
    await pool.query('ROLLBACK')
  }

  for (const [tableName, triggerName] of [
    [
      'operations_fulfillment_plans',
      'guard_shadow_commerce_canonical_plan_insert',
    ],
    [
      'operations_reservations',
      'guard_shadow_commerce_canonical_reservation_insert',
    ],
    [
      'operations_shipments',
      'guard_shadow_commerce_canonical_shipment_insert',
    ],
    [
      'operations_commerce_fulfillment_exports',
      'guard_shadow_commerce_canonical_export_insert',
    ],
  ]) {
    await pool.query('BEGIN')
    try {
      await pool.query(
        `ALTER TABLE ${tableName} DISABLE TRIGGER ${triggerName}`,
      )
      assert.equal(
        await attest(pool),
        false,
        `Disabling canonical-write quarantine ${triggerName} must fail health`,
      )
    } finally {
      await pool.query('ROLLBACK')
    }
  }

  await pool.query('BEGIN')
  try {
    await pool.query(
      `DROP TRIGGER guard_shadow_commerce_canonical_plan_insert
         ON operations_fulfillment_plans;
       CREATE TRIGGER guard_shadow_commerce_canonical_plan_insert
       BEFORE INSERT OR UPDATE ON operations_fulfillment_plans
       FOR EACH ROW WHEN (false)
       EXECUTE FUNCTION guard_shadow_commerce_canonical_write()`,
    )
    assert.equal(
      await attest(pool),
      false,
      'A same-function canonical trigger disabled by WHEN(false) must fail health',
    )
  } finally {
    await pool.query('ROLLBACK')
  }

  await pool.query('BEGIN')
  try {
    await pool.query(
      `CREATE OR REPLACE FUNCTION guard_shadow_training_activation_change()
       RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF TG_OP = 'DELETE' THEN
           RETURN OLD;
         END IF;
         RETURN NEW;
       END;
       $$`,
    )
    assert.equal(
      await attest(pool),
      false,
      'Weakening activation-change protection must fail health',
    )
  } finally {
    await pool.query('ROLLBACK')
  }

  for (const triggerName of [
    'guard_shadow_training_activation_change_insert',
    'guard_shadow_training_activation_change_update',
    'guard_shadow_training_activation_change_delete',
  ]) {
    await pool.query('BEGIN')
    try {
      await pool.query(
        `ALTER TABLE operations_activation_scopes
         DISABLE TRIGGER ${triggerName}`,
      )
      assert.equal(
        await attest(pool),
        false,
        `Disabling activation protection ${triggerName} must fail health`,
      )
    } finally {
      await pool.query('ROLLBACK')
    }
  }

  await pool.query('BEGIN')
  try {
    await pool.query(
      `DROP TRIGGER guard_shadow_training_activation_change_update
         ON operations_activation_scopes`,
    )
    await pool.query(
      `CREATE TRIGGER guard_shadow_training_activation_change_update
       BEFORE UPDATE OF reason ON operations_activation_scopes
       FOR EACH ROW
       EXECUTE FUNCTION guard_shadow_training_activation_change()`,
    )
    assert.equal(
      await attest(pool),
      false,
      'Rebinding activation protection away from state must fail health',
    )
  } finally {
    await pool.query('ROLLBACK')
  }

  await pool.query('BEGIN')
  try {
    await pool.query(
      `UPDATE global_reference_entity_types
       SET entity_type = 'operations.shadow_training_wrong'
       WHERE prefix = 'gtrn'`,
    )
    assert.equal(
      await attest(pool),
      false,
      'Changing the training-run reference owner must fail health',
    )
  } finally {
    await pool.query('ROLLBACK')
  }
}

async function main() {
  const existingDatabaseUrl = String(
    process.env.SHADOW_TRAINING_HEALTH_DATABASE_URL || '',
  ).trim()
  if (existingDatabaseUrl) {
    const pool = new Pool({ connectionString: existingDatabaseUrl, max: 2 })
    try {
      await exercise(pool)
    } finally {
      await pool.end()
    }
    console.log('Shadow training health attestation passed')
    return
  }

  command('docker', ['info'], { timeout: 30_000 })
  const container = (
    `clawpilot-shadow-training-health-${process.pid}-`
    + randomUUID().slice(0, 8)
  )
  let containerStarted = false
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=shadow_training_health',
      '-e', 'POSTGRES_DB=shadow_training_health',
      '-p', '127.0.0.1::5432',
      'pgvector/pgvector:pg16',
    ], { timeout: 180_000 })
    containerStarted = true
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
    assert.ok(port > 0, `Unable to resolve PostgreSQL port: ${portOutput}`)
    const databaseUrl = (
      'postgresql://postgres:shadow_training_health@127.0.0.1:'
      + `${port}/shadow_training_health`
    )
    await waitForPostgres(databaseUrl)
    command(process.execPath, ['scripts/db-migrate.mjs'], {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      timeout: 300_000,
    })
    const pool = new Pool({ connectionString: databaseUrl, max: 2 })
    try {
      await exercise(pool)
    } finally {
      await pool.end()
    }
  } finally {
    if (containerStarted) {
      command('docker', ['stop', container], { timeout: 30_000 })
    }
  }

  console.log('Shadow training health attestation passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
