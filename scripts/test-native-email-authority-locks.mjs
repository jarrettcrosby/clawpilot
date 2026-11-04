#!/usr/bin/env node
// Pure by default; --postgres uses one guarded disposable local database.
// Never loads application credentials or changes live/native permissions.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { disposablePostgresDockerArgs, disposablePostgresDockerCleanupArgs } from './lib/disposable-postgres-docker.mjs'
const require = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = require('typescript')
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const args = process.argv.slice(2)
assert.ok(args.length === 0 || args.length === 1 && args[0] === '--postgres', 'Use no arguments or --postgres')
const checks = []
async function check(name, callback) { await callback(); checks.push(name); console.log(`PASS ${name}`) }
const migration = read('db/migrations/0375_crm_native_email_publication_admission.sql')
const helperSource = read('app_src/lib/persistence/crmNativeEmailAuthority.ts')
const helperModule = { exports: {} }
new Function('exports', ts.transpileModule(helperSource, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
} }).outputText)(helperModule.exports)
const lock = helperModule.exports.lockCrmNativeEmailAuthorityWithClient
const protectedKeys = {
  pipeline_spaces: ['id','owner_email','workspace_organization_id','reference_access_disabled'],
  pipeline_space_members: ['pipeline_id','user_email','access_role'],
  app_user_organization_memberships: ['user_email','organization_id','status','role','permissions','trashed_at'],
  app_users: ['email','status','suitecrm_user_id','role','permissions','organization_id'],
}
await check('statement UPDATE locks cover exactly protected keys; lifecycle and actual-value guards remain', () => {
  for (const [table, keys] of Object.entries(protectedKeys)) {
    const update = migration.match(new RegExp(`BEFORE UPDATE OF ([^;]+?) ON ${table}\\s+FOR EACH STATEMENT`))
    assert.ok(update, table)
    assert.deepEqual(update[1].split(',').map(value => value.trim()), keys)
    assert.match(migration, new RegExp(`BEFORE INSERT OR DELETE OR TRUNCATE ON ${table}\\s+FOR EACH STATEMENT`))
    assert.match(migration, new RegExp(`AFTER INSERT OR UPDATE OR DELETE ON ${table}\\s+FOR EACH ROW`))
  }
  assert.match(migration, /IF NOT changed THEN RETURN NEW; END IF/)
  assert.match(migration, /Native Email authority is frozen pending native-first policy transition/)
})
await check('explicit authority helper is control-first and refuses missing or malformed singleton', async () => {
  const queries = []
  await lock({ query: async sql => { queries.push(sql); return { rows: [{ singleton: true }] } } })
  assert.deepEqual(queries, ['SELECT singleton FROM crm_native_email_publication_control WHERE singleton FOR UPDATE'])
  for (const rows of [[], [{ singleton: false }], [{ singleton: true }, { singleton: true }]]) {
    await assert.rejects(lock({ query: async () => ({ rows }) }), /missing or inconsistent/)
  }
})
function functionSource(path, name) {
  const source = read(path), parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
  assert.equal(parsed.parseDiagnostics.length, 0, `Syntax ${path}`)
  const node = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)
  assert.ok(node, `${path}:${name}`)
  return node.getText(parsed)
}
await check('genuine prelocking mutations obtain authority control before their first authority-row lock', () => {
  for (const [path, names] of [
    ['app_src/lib/users.ts', ['addAppUserOrganizationMemberships','inviteAppUser','setAppUserTrashed','updateAppUserCrmEmployee','syncAppUserSuiteCrmIdentity']],
    ['app_src/lib/organizations.ts', ['ensurePrimaryWorkspaceOrganization','retireUnusedWorkspaceOrganization','updateWorkspaceOrganizationParent']],
    ['app_src/lib/workspaceMemberships.ts', ['ensureDemoWorkspaceMembership','createIndependentRootWorkspace']],
    ['app_src/lib/tenancy.ts', ['ensureDefaultResourcesForUser']],
    ['app_src/lib/invitations.ts', ['rollbackInvitation']],
    ['app_src/lib/crm/boardProjection.ts', ['resolveCrmBoardBinding']],
  ]) for (const name of names) {
    const source = functionSource(path, name)
    const control = source.indexOf('await lockCrmNativeEmailAuthorityWithClient(client)')
    const rowLock = source.search(/FOR (UPDATE|SHARE)/)
    assert.ok(control >= 0 && rowLock > control, `${name}: explicit control before prelock`)
  }
  const primary = functionSource('app_src/lib/organizations.ts', 'ensurePrimaryWorkspaceOrganization')
  assert.equal(primary.match(/await lockCrmNativeEmailAuthorityWithClient\(client\)/g)?.length, 2,
    'Both independently committed primary-organization assignment branches are fenced')
})
await check('normal login/profile, existing board binding and existing shipping scope avoid authority serialization', () => {
  const auth = functionSource('app_src/lib/authMagicCode.ts', 'verifyAuthMagicCode')
  assert.match(auth, /let needsAuthority = purpose\.rows\[0\]\?\.purpose === 'invitation'/)
  assert.match(auth, /if \(needsAuthority\) await lockCrmNativeEmailAuthorityWithClient\(client\)/)
  assert.ok(auth.indexOf('lockCrmNativeEmailAuthorityWithClient') < auth.indexOf('FOR UPDATE'))
  assert.match(auth, /if \(!needsAuthority\) throw new Error\(AUTHORITY_PROBE_CHANGED\)/)
  assert.match(auth, /AUTHORITY_PROBE_CHANGED && authorityAttempt === 0/)
  assert.equal(auth.match(/lockCrmNativeEmailAuthorityWithClient/g)?.length, 1)
  assert.doesNotMatch(functionSource('app_src/lib/users.ts', 'updateAppUserProfile'), /lockCrmNativeEmailAuthority/)
  const board = functionSource('app_src/lib/crm/boardProjection.ts', 'resolveCrmBoardBinding')
  assert.ok(board.indexOf('return binding') < board.indexOf('lockCrmNativeEmailAuthorityWithClient'))
  const scope = functionSource('app_src/lib/persistence/oneOffShipments.ts', 'shippingScope')
  assert.ok(scope.indexOf('if (existing.rows[0]) return existing.rows[0]') < scope.indexOf('lockCrmNativeEmailAuthorityWithClient'))
  assert.ok(scope.indexOf('lockCrmNativeEmailAuthorityWithClient') < scope.indexOf('await acquireTransactionAdvisoryLock'))
})

if (!args.length) { console.log(`Native Email authority locks: ${checks.length} pure checks passed; PostgreSQL not run`); process.exit(0) }
const { Pool } = require('pg')
const container = `clawpilot-native-authority-${process.pid}-${randomUUID().slice(0,8)}`
const image = process.env.CLAWPILOT_TEST_POSTGRES_IMAGE || 'pgvector/pgvector:pg16'
assert.match(image, /^pgvector\/pgvector:pg(?:16|18)$/u)
let pool, started = false, a, b
try {
  execFileSync('docker', disposablePostgresDockerArgs(['run','--rm','-d','--name',container,'--pull','never',
    '-e','POSTGRES_PASSWORD=authority_fixture','-e','POSTGRES_DB=authority_fixture','-p','127.0.0.1::5432',image]),
  { timeout: 60000, stdio: 'pipe' }); started = true
  const port = execFileSync('docker',['port',container,'5432/tcp'],{encoding:'utf8',timeout:10000}).match(/^127\.0\.0\.1:(\d+)\s*$/u)?.[1]
  assert.ok(port)
  pool = new Pool({ host:'127.0.0.1',port:Number(port),user:'postgres',password:'authority_fixture',database:'authority_fixture',
    ssl:false,max:3,connectionTimeoutMillis:1000,statement_timeout:3000 })
  const deadline = Date.now()+30000
  while (true) { try { await pool.query('SELECT 1'); break } catch (error) {
    if (Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve,100))
  } }
  assert.equal((await pool.query("SELECT count(*) FROM pg_tables WHERE schemaname='public'")).rows[0].count,'0')
  await pool.query(`CREATE TABLE app_users(email text PRIMARY KEY,status text,suitecrm_user_id text,role text,permissions jsonb,organization_id uuid,display_name text,last_login_at timestamptz);
    CREATE TABLE pipeline_spaces(id uuid PRIMARY KEY,owner_email text,workspace_organization_id uuid,reference_access_disabled boolean,crm_last_synced_at timestamptz,provisioning_status text);
    CREATE TABLE pipeline_space_members(pipeline_id uuid,user_email text,access_role text,updated_at timestamptz);
    CREATE TABLE app_user_organization_memberships(user_email text,organization_id uuid,status text,role text,permissions jsonb,trashed_at timestamptz,updated_at timestamptz);
    INSERT INTO app_users(email,status,role,permissions) VALUES ('fixture@example.test','active','member','{}');
    INSERT INTO pipeline_spaces(id,owner_email,reference_access_disabled) VALUES ('00000000-0000-4000-8000-000000000001','fixture@example.test',false);`)
  await pool.query(migration)
  a = await pool.connect(); b = await pool.connect()
  await check('actual disabled control does not block prelocked profile or pipeline timestamp/provisioning writes', async () => {
    await b.query('BEGIN'); await lock(b)
    await a.query('BEGIN'); await a.query("SET LOCAL lock_timeout='150ms'")
    await a.query("SELECT email FROM app_users WHERE email='fixture@example.test' FOR UPDATE")
    await a.query("UPDATE app_users SET display_name='Profile only',last_login_at=now() WHERE email='fixture@example.test'")
    await a.query("UPDATE pipeline_spaces SET crm_last_synced_at=now(),provisioning_status='ready'")
    await a.query('COMMIT')
    assert.equal((await pool.query('SELECT generation FROM crm_native_email_publication_control')).rows[0].generation,'1')
  })
  await check('actual protected change waits at control; properly ordered writer holds no user lock while waiting', async () => {
    await a.query('BEGIN'); await a.query("SET LOCAL lock_timeout='150ms'")
    await assert.rejects(a.query("UPDATE app_users SET permissions='{\"viewCrm\":false}' WHERE email='fixture@example.test'"), error => error.code === '55P03')
    await a.query('ROLLBACK'); await a.query('BEGIN')
    const pid = (await a.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
    const waiting = lock(a)
    const stop = Date.now()+1000
    while (true) {
      const blocked = (await pool.query('SELECT cardinality(pg_blocking_pids($1)) AS n',[pid])).rows[0].n
      if (blocked > 0) break
      assert.ok(Date.now()<stop,'Authority writer should wait on held control'); await new Promise(resolve=>setTimeout(resolve,10))
    }
    await pool.query("UPDATE app_users SET display_name='Not prelocked' WHERE email='fixture@example.test'")
    await b.query('COMMIT'); await waiting
    await a.query("SELECT email FROM app_users WHERE email='fixture@example.test' FOR UPDATE")
    await a.query("UPDATE app_users SET permissions='{\"viewCrm\":false}' WHERE email='fixture@example.test'")
    await a.query('COMMIT')
    assert.equal((await pool.query('SELECT generation FROM crm_native_email_publication_control')).rows[0].generation,'2')
  })
  await check('enabled policy still rejects authority changes while metadata writes remain permitted', async () => {
    await pool.query(`UPDATE crm_native_email_publication_control SET enabled=true,verified_generation=generation,
      native_policy_fingerprint=repeat('a',64),activation_receipt_hash=repeat('b',64)`)
    await pool.query("UPDATE app_users SET last_login_at=now(),display_name='Allowed metadata'")
    await assert.rejects(pool.query("UPDATE app_users SET status='disabled' WHERE email='fixture@example.test'"),error=>error.code==='55000')
    assert.equal((await pool.query("SELECT status FROM app_users WHERE email='fixture@example.test'")).rows[0].status,'active')
  })
} finally {
  for (const client of [a,b]) if (client) { await client.query('ROLLBACK').catch(()=>{}); client.release() }
  if (pool) await pool.end()
  if (started) execFileSync('docker',disposablePostgresDockerCleanupArgs(container),{timeout:30000,stdio:'pipe'})
}
console.log(`Native Email authority locks: ${checks.length} checks passed, including disposable PostgreSQL only`)
