#!/usr/bin/env node
// Exercise the exact migration runner and custody CLI on a fresh synthetic DB.
// No inherited connection strings, application provider credentials or seed.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createIntegrationCredentialKeyAttestation } from '../app_src/lib/integrations/integrationCredentialKeyAttestation.mjs'
import { createDisposablePostgresRuntime, disposablePostgresDockerArgs } from './lib/disposable-postgres-docker.mjs'
import { readExpectedMigrations, splitPostgresCustody, verifySplitPostgresCustody } from './verify-postgres-custody.mjs'

const env = {
  CLAWPILOT_POSTGRES_CUSTODY: 'split-v1',
  CLAWPILOT_POSTGRES_RUNTIME_ROLE: 'fixture_custody_app',
  CLAWPILOT_POSTGRES_OPERATOR_ROLE: 'fixture_custody_operator',
}
const roles = splitPostgresCustody(env)
assert.equal(splitPostgresCustody({}), null)
for (const overrides of [
  { CLAWPILOT_POSTGRES_CUSTODY: '' },
  { CLAWPILOT_POSTGRES_CUSTODY: 'true' },
  { CLAWPILOT_POSTGRES_OPERATOR_ROLE: roles.runtime },
  { CLAWPILOT_POSTGRES_OPERATOR_ROLE: 'invalid-role' },
  { INTEGRATION_CREDENTIAL_ATTESTATION_MODE: 'adoption' },
]) assert.throws(() => splitPostgresCustody({ ...env, ...overrides }), /postgres_custody_/u)

// Verify shell routing without running provider checks, migrations or seeds.
const stub = mkdtempSync(join(tmpdir(), 'clawpilot-custody-shell-'))
try {
  writeFileSync(join(stub, 'node'), '#!/bin/sh\nprintf "node:%s\\n" "$*"\nexit "${FIXTURE_NODE_EXIT:-0}"\n', { mode: 0o700 })
  writeFileSync(join(stub, 'npm'), '#!/bin/sh\nprintf "npm:%s\\n" "$*"\n', { mode: 0o700 })
  const shell = (settings) => spawnSync('/bin/bash', ['scripts/predeploy-railway.sh'], {
    encoding: 'utf8', timeout: 4000, env: { PATH: `${stub}:/usr/bin:/bin`, ...settings },
  })
  const split = shell(env)
  assert.equal(split.status, 0)
  assert.match(split.stdout, /^node:scripts\/verify-postgres-custody\.mjs\n/u)
  assert.doesNotMatch(split.stdout, /db:migrate|demo:seed/u)
  for (const check of ['mail:verify', 'db:preflight:commerce-storage', 'verify:commerce-order-revision-evidence-keys', 'demo:verify']) {
    assert.ok(split.stdout.includes(`npm:run ${check}\n`))
  }
  const legacy = shell({})
  assert.equal(legacy.status, 0)
  assert.match(legacy.stdout, /db:migrate[\s\S]*demo:seed/u)
  assert.doesNotMatch(legacy.stdout, /verify-postgres-custody/u)
  assert.equal(shell({ ...env, CLAWPILOT_POSTGRES_CUSTODY: 'bad' }).stdout, '')
  const refused = shell({ ...env, FIXTURE_NODE_EXIT: '1' })
  assert.equal(refused.status, 1)
  assert.doesNotMatch(refused.stdout, /npm:/u)
} finally {
  rmSync(stub, { recursive: true })
}

const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const { Client } = requireFromApp('pg')
const major = process.argv[2] ?? '18'
assert.match(major, /^(16|18)$/u)
assert.ok(process.argv.length <= 3)
const fixture = `clawpilot-postgres-custody-${randomUUID()}`
const database = 'fixture_custody'
const [adminSecret, operatorSecret, runtimeSecret] = Array.from({ length: 3 }, randomUUID)
const guard = createDisposablePostgresRuntime()
const clients = []
const docker = (args) => execFileSync('docker', args, {
  encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'],
}).trim()
const rejected = (promise, code) => assert.rejects(promise, (error) => error.message === code)
const denied = (promise) => assert.rejects(promise, (error) => error.code === '42501')
let launched = false
try {
  const args = disposablePostgresDockerArgs(['run', '-d', '--pull', 'never', '--name', fixture,
    '-e', `POSTGRES_PASSWORD=${adminSecret}`, '-e', `POSTGRES_DB=${database}`,
    '-p', '127.0.0.1::5432', `pgvector/pgvector:pg${major}`], { runtime: guard })
  launched = true
  docker(args)
  const binding = docker(['port', fixture, '5432/tcp'])
  assert.match(binding, /^127\.0\.0\.1:\d+$/u)
  const url = (role, password) => `postgresql://${role}:${password}@${binding}/${database}`
  const connect = async (connectionString) => {
    const client = new Client({ connectionString, connectionTimeoutMillis: 1000, query_timeout: 10000 })
    try { await client.connect() } catch (error) { await client.end().catch(() => undefined); throw error }
    clients.push(client)
    return client
  }
  let admin
  for (let i = 0; !admin && i < 75; i++) {
    admin = await connect(url('postgres', adminSecret)).catch(() => null)
    if (!admin) await delay(200)
  }
  assert.ok(admin, 'disposable PostgreSQL did not become ready')
  await admin.query(`
    CREATE ROLE ${roles.operator} LOGIN NOINHERIT PASSWORD '${operatorSecret}';
    CREATE ROLE ${roles.runtime} LOGIN NOINHERIT PASSWORD '${runtimeSecret}';
    ALTER DATABASE ${database} OWNER TO ${roles.operator};
    CREATE EXTENSION vector;
    CREATE EXTENSION pgcrypto;
    REVOKE CREATE ON SCHEMA public FROM PUBLIC;
  `)
  const run = (script, connectionString, additions = {}) => spawnSync(process.execPath, [script], {
    env: { PATH: process.env.PATH, NODE_PATH: process.env.NODE_PATH, DATABASE_URL: connectionString,
      PGSSLMODE: 'disable', ...additions },
    encoding: 'utf8', timeout: 120000, maxBuffer: 500000,
  })
  const operatorUrl = url(roles.operator, operatorSecret)
  const runtimeUrl = url(roles.runtime, runtimeSecret)
  const migrated = run('scripts/db-migrate.mjs', operatorUrl)
  assert.equal(migrated.status, 0, `fixture migration failed after ${migrated.stdout?.trim().split('\n').at(-1)} (${migrated.stderr?.match(/code: '([A-Z0-9]+)'/u)?.[1] ?? 'no code'})`)
  const operator = await connect(operatorUrl)
  const app = await connect(runtimeUrl)
  await operator.query(`GRANT USAGE ON SCHEMA public TO ${roles.runtime};
    GRANT SELECT ON public.schema_migrations, public.app_settings,
      public.operations_integration_credential_key_attestations TO ${roles.runtime}`)
  const expected = readExpectedMigrations()
  await verifySplitPostgresCustody(app, roles, expected)
  assert.equal(run('scripts/verify-postgres-custody.mjs', runtimeUrl, env).status, 0)
  assert.equal(run('scripts/verify-postgres-custody.mjs', operatorUrl, env).status, 1)
  await denied(app.query('DELETE FROM public.schema_migrations'))

  // Exercise the actual startup proof command against the full migrated
  // catalog, using only fixture credentials and a synthetic empty sentinel.
  const { rows: [{ id: databaseIdentity }] } = await operator.query(
    "SELECT value->>'id' AS id FROM public.app_settings WHERE key = 'deployment.database.identity'",
  )
  const keyId = 'fixture-custody-v1'
  const keyMaterial = randomUUID() + randomUUID()
  const actor = 'fixture-custody@example.test'
  const sentinel = createIntegrationCredentialKeyAttestation({ databaseIdentity, keyId, keyMaterial })
  await operator.query("INSERT INTO public.app_users (email, role, status) VALUES ($1, 'owner', 'active')", [actor])
  await operator.query(`INSERT INTO public.operations_integration_credential_key_attestations (
    singleton_id, attestation_version, database_identity, key_id, sentinel_ciphertext,
    sentinel_iv, sentinel_tag, bootstrap_mode, created_by
  ) VALUES (1, $1, $2, $3, $4, $5, $6, 'empty', $7)`, [sentinel.attestationVersion,
    databaseIdentity, keyId, sentinel.sentinelCiphertext, sentinel.sentinelIv, sentinel.sentinelTag, actor])
  const startup = { ...env, RAILWAY_ENVIRONMENT_NAME: 'custody-fixture', RAILWAY_DEPLOYMENT_ID: 'custody-fixture',
    INTEGRATION_CREDENTIAL_ENCRYPTION_KEY: keyMaterial, INTEGRATION_CREDENTIAL_ENCRYPTION_KEY_ID: keyId }
  const proof = run('scripts/verify-integration-credential-runtime.mjs', runtimeUrl, startup)
  assert.equal(proof.status, 0, proof.stderr?.match(/INTEGRATION_CREDENTIAL_RUNTIME_[A-Z_]+/u)?.[0])
  assert.match(proof.stdout, /^[A-Za-z0-9_-]{40,4096}\.[A-Za-z0-9_-]{43}$/u)
  assert.equal(run('scripts/verify-integration-credential-runtime.mjs', operatorUrl, startup).status, 1)
  await denied(app.query('DELETE FROM public.operations_integration_credential_key_attestations'))

  const rejectAndRestore = async (add, remove, expectedError = 'postgres_custody_unverified', actor = operator) => {
    await actor.query(add)
    try { await rejected(verifySplitPostgresCustody(app, roles, expected), expectedError) }
    finally { await actor.query(remove) }
    await verifySplitPostgresCustody(app, roles, expected)
  }
  await rejectAndRestore(`GRANT UPDATE (checksum) ON public.schema_migrations TO ${roles.runtime}`,
    `REVOKE UPDATE (checksum) ON public.schema_migrations FROM ${roles.runtime}`)
  await rejectAndRestore(`GRANT SELECT ON public.schema_migrations TO ${roles.runtime} WITH GRANT OPTION`,
    `REVOKE GRANT OPTION FOR SELECT ON public.schema_migrations FROM ${roles.runtime}`)
  await rejectAndRestore(`GRANT USAGE ON SCHEMA clawpilot_crm_maintenance TO ${roles.runtime}`,
    `REVOKE USAGE ON SCHEMA clawpilot_crm_maintenance FROM ${roles.runtime}`)
  await rejectAndRestore(`GRANT TRIGGER ON public.crm_interactions TO ${roles.runtime}`,
    `REVOKE TRIGGER ON public.crm_interactions FROM ${roles.runtime}`)
  await rejectAndRestore(`GRANT ${roles.operator} TO ${roles.runtime}`,
    `REVOKE ${roles.operator} FROM ${roles.runtime}`, 'postgres_custody_unverified', admin)
  await rejectAndRestore(`ALTER ROLE ${roles.runtime} SUPERUSER`,
    `ALTER ROLE ${roles.runtime} NOSUPERUSER`, 'postgres_custody_unverified', admin)
  const filename = '0418_crm_maintenance_write_fence.sql'
  const checksum = expected.get(filename)
  const mismatch = 'postgres_custody_migration_ledger_mismatch'
  await rejectAndRestore(`UPDATE public.schema_migrations SET checksum = 'wrong' WHERE filename = '${filename}'`,
    `UPDATE public.schema_migrations SET checksum = '${checksum}' WHERE filename = '${filename}'`, mismatch)
  await rejectAndRestore(`DELETE FROM public.schema_migrations WHERE filename = '${filename}'`,
    `INSERT INTO public.schema_migrations (filename,checksum) VALUES ('${filename}','${checksum}')`, mismatch)
  await rejectAndRestore("INSERT INTO public.schema_migrations (filename,checksum) VALUES ('unexpected.sql','x')",
    "DELETE FROM public.schema_migrations WHERE filename = 'unexpected.sql'", mismatch)
  console.log(`PostgreSQL ${major}: exact operator migration, restricted app ledger and startup proof, and denied custody drift passed`)
} finally {
  await Promise.allSettled(clients.map((client) => client.end()))
  if (launched) guard.cleanup(fixture)
}
