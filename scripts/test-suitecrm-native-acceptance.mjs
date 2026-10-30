#!/usr/bin/env node
// Real checksum-pinned SuiteCRM + MariaDB acceptance. No production data/env,
// no host ports, no provider access. Dependency preparation is a separate step.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { createDisposablePostgresRuntime, DISPOSABLE_POSTGRES_LABEL, DISPOSABLE_POSTGRES_OWNER_LABEL } from './lib/disposable-postgres-docker.mjs'
import { runStorageGuard } from './local-storage-guard.mjs'

const VERSION = '8.10.1'
const ZIP_SHA = 'b72da32ca7702452537cdd11e1157bc41a283accdadca66ef88f42684a571ef7'
const RUNTIME = 'clawpilot-suitecrm-native-acceptance:8.10.1-php83'
const DATABASE = 'mariadb:11.4.13'
const LABEL = 'com.clawpilot.native-email-acceptance'
const options = Object.fromEntries(process.argv.slice(2).map(argument => {
  const match = argument.match(/^--(source-zip|output)=(.+)$/)
  if (match) return [match[1], match[2]]
  if (argument === '--golden-only') return ['golden-only', true]
  if (argument === '--remediation-candidate') return ['remediation-candidate', true]
  throw new Error('Use --source-zip=/absolute/SuiteCRM-8.10.1.zip [--output=/absolute/result.json] [--golden-only | --remediation-candidate]')
}))
assert.ok(!(options['golden-only'] && options['remediation-candidate']), 'Remediation requires the complete unchanged baseline first')
assert.ok(isAbsolute(options['source-zip'] || ''), 'An explicit downloaded pinned release ZIP is required; this runner never downloads')
const archive = realpathSync(options['source-zip'])
const archiveStat = lstatSync(archive)
assert.ok(archiveStat.isFile() && archiveStat.uid === process.getuid() && archiveStat.size < 180_000_000,
  'Source archive must be a bounded regular file owned by the current user')
assert.equal(createHash('sha256').update(readFileSync(archive)).digest('hex'), ZIP_SHA, 'Only the pinned official 8.10.1 release is admitted')
if (options.output) {
  assert.ok(isAbsolute(options.output) && options.output.endsWith('.json'))
  const parent = lstatSync(dirname(options.output))
  assert.ok(parent.isDirectory() && !parent.isSymbolicLink() && parent.uid === process.getuid())
}
const localEnvironment = { ...process.env, CI: '', VERCEL: '', VERCEL_ENV: '' }
for (const key of ['RAILWAY_PROJECT_ID', 'RAILWAY_ENVIRONMENT_ID', 'RAILWAY_ENVIRONMENT_NAME', 'RAILWAY_SERVICE_ID']) delete localEnvironment[key]
assert.equal(runStorageGuard({ argv: ['--preflight'], environment: localEnvironment }), 0, 'Disk floor must pass without hosted-environment bypass')

const execute = (command, args, extra = {}) => execFileSync(command, args, {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, maxBuffer: 4 * 1024 * 1024, ...extra,
})
const image = tag => {
  const metadata = JSON.parse(execute('docker', ['image', 'inspect', tag]))[0]
  assert.match(metadata.Id, /^sha256:[a-f0-9]{64}$/)
  return { id: metadata.Id, volumes: Object.keys(metadata.Config.Volumes || {}),
    phpVersion: metadata.Config.Env?.find(value => value.startsWith('PHP_VERSION='))?.slice(12) || null,
    bytes: metadata.Size }
}
const appImage = image(RUNTIME), dbImage = image(DATABASE)
assert.equal(appImage.phpVersion, '8.3.35', 'Prepare the runtime image from exact PHP 8.3.35, not a mutable latest patch')
assert.deepEqual(appImage.volumes, [], 'PHP image must declare no anonymous volumes')
assert.deepEqual(dbImage.volumes, ['/var/lib/mysql'], 'Every database image volume must be explicitly covered by tmpfs')
const root = mkdtempSync(join(tmpdir(), 'clawpilot-suitecrm-native-run.'))
const token = randomUUID()
const name = `clawpilot-native-email-${process.pid}-${token.slice(0, 8)}`
const dbName = `${name}-db`, appName = `${name}-app`, network = `${name}-net`
writeFileSync(join(root, 'owner.json'), JSON.stringify({ token, pid: process.pid }), { flag: 'wx', mode: 0o600 })
// Reuse the product's owner-checked disk/DB admission lease. This fixture's SQL
// engine is MariaDB; its lease is shared with PostgreSQL to avoid concurrent DBs.
const lease = createDisposablePostgresRuntime({ environment: localEnvironment })
let admitted = false, networkStarted = false, appStarted = false, cleaning = false
const fixture = resolve('scripts/fixtures/native-email-audience-real')
const verifier = resolve('services/suitecrm/email-audience')
const fixtureHashes = Object.fromEntries(readdirSync(fixture).filter(path => /\.(php|sh)$/.test(path)).sort().map(path =>
  [path, createHash('sha256').update(readFileSync(join(fixture, path))).digest('hex')]))
const inspectContainer = candidate => {
  try { return JSON.parse(execute('docker', ['container', 'inspect', candidate]))[0] }
  catch (error) { if (/No such (?:object|container)/i.test(String(error.stderr))) return null; throw error }
}
function removeOwnedContainer(candidate) {
  const current = inspectContainer(candidate)
  if (!current) return
  assert.equal(current.Config.Labels?.[LABEL], 'true')
  assert.equal(current.Config.Labels?.[`${LABEL}.owner`], token, 'Never remove an unidentified or replacement container')
  execute('docker', ['rm', '--force', '--volumes', current.Id])
  assert.equal(inspectContainer(current.Id), null)
}
function cleanup() {
  if (cleaning) return
  cleaning = true
  const failures = []
  const attempt = (resource, action) => {
    try { action() } catch (error) { failures.push(new Error(`${resource}: ${error.message}`, { cause: error })) }
  }
  if (appStarted) attempt('application container', () => removeOwnedContainer(appName))
  if (admitted) attempt('database container and shared lease', () => {
    assert.equal(lease.cleanup(), true, 'Owner-checked database/lease cleanup must finish')
  })
  if (networkStarted) attempt('private network', () => {
    const owned = JSON.parse(execute('docker', ['network', 'inspect', network]))[0]
    assert.equal(owned.Labels?.[`${LABEL}.owner`], token)
    assert.equal(Object.keys(owned.Containers || {}).length, 0)
    execute('docker', ['network', 'rm', owned.Id])
  })
  attempt('private extracted source', () => {
    const owner = JSON.parse(readFileSync(join(root, 'owner.json'), 'utf8'))
    assert.equal(owner.token, token)
    assert.match(root, /\/clawpilot-suitecrm-native-run\.[A-Za-z0-9]+$/)
    rmSync(root, { recursive: true }) // Exact freshly created, owner-marked fixture only.
  })
  if (failures.length) throw new AggregateError(failures, `Native fixture cleanup failed: ${failures.map(error => error.message).join('; ')}`)
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  try { cleanup() } finally { process.exit(signal === 'SIGINT' ? 130 : 143) }
})
const limits = (memory, cpus) => ['--memory', memory, '--memory-swap', memory, '--cpus', cpus,
  '--pids-limit', '128', '--log-driver', 'json-file', '--log-opt', 'max-size=2m', '--log-opt', 'max-file=1',
  '--label', `${LABEL}=true`, '--label', `${LABEL}.owner=${token}`]
let output = ''
try {
  const leaseToken = lease.admit(dbName); admitted = true
  execute('unzip', ['-q', archive, '-d', join(root, 'suitecrm')], { timeout: 60_000 })
  const sourceHashes = Object.fromEntries([
    'public/legacy/modules/Emails/Email.php', 'public/legacy/data/SugarBean.php',
    'public/legacy/modules/SecurityGroups/SecurityGroup.php', 'public/legacy/modules/ACLActions/ACLAction.php',
    'public/legacy/Api/V8/Service/ModuleService.php', 'public/legacy/Api/V8/Service/RelationshipService.php',
    'public/legacy/modules/Emails/EmailUIAjax.php', 'public/legacy/include/SugarFolders/SugarFolders.php',
  ].map(path => [path, createHash('sha256').update(readFileSync(join(root, 'suitecrm', path))).digest('hex')]))
  execute('docker', ['network', 'create', '--internal', '--label', `${LABEL}.owner=${token}`, network]); networkStarted = true
  execute('docker', ['run', '--rm', '--detach', '--pull=never', '--name', dbName,
    '--network', network, '--network-alias', 'db', '--read-only',
    ...limits('640m', '0.5'), '--label', `${DISPOSABLE_POSTGRES_LABEL}=true`, '--label', `${DISPOSABLE_POSTGRES_OWNER_LABEL}=${leaseToken}`,
    '--tmpfs', '/var/lib/mysql:rw,nosuid,size=320m', '--tmpfs', '/run/mysqld:rw,nosuid,size=8m', '--tmpfs', '/tmp:rw,nosuid,size=32m',
    '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'FOWNER', '--cap-add', 'SETGID', '--cap-add', 'SETUID',
    '--security-opt', 'no-new-privileges',
    '--env', 'MARIADB_ROOT_PASSWORD=Synthetic-native-root-password-only', '--env', 'MARIADB_DATABASE=suitecrm_native_test',
    '--env', 'MARIADB_USER=fixture', '--env', 'MARIADB_PASSWORD=Synthetic-native-db-password-only', dbImage.id,
    '--skip-log-bin', '--innodb-buffer-pool-size=64M', '--max-connections=20', '--performance-schema=OFF'])
  const deadline = Date.now() + 60_000
  while (true) {
    try {
      execute('docker', ['exec', '--env', 'MYSQL_PWD=Synthetic-native-db-password-only', dbName,
        'mariadb', '--user=fixture', '--database=suitecrm_native_test', '--batch', '--skip-column-names', '--execute=SELECT 1'])
      break
    } catch (error) {
      if (Date.now() > deadline) throw error
      await new Promise(resolve => setTimeout(resolve, 250))
    }
  }
  const dbVersion = execute('docker', ['exec', '--env', 'MYSQL_PWD=Synthetic-native-db-password-only', dbName,
    'mariadb', '--user=fixture', '--database=suitecrm_native_test', '--batch', '--skip-column-names', '--execute=SELECT VERSION()']).trim()
  assert.match(dbVersion, /^11\.4\.13-MariaDB/)
  const db = inspectContainer(dbName)
  assert.ok(db.Mounts.every(mount => mount.Type !== 'volume'), 'No anonymous database volume may exist')
  assert.equal(Object.keys(db.HostConfig.PortBindings || {}).length, 0)
  execute('docker', ['create', '--rm', '--pull=never', '--name', appName, '--network', network, '--read-only',
    ...limits('1152m', '1'), '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--tmpfs', '/app:rw,nosuid,size=640m', '--tmpfs', '/tmp:rw,nosuid,size=32m',
    '--mount', `type=bind,source=${join(root, 'suitecrm')},target=/source/suitecrm,readonly`,
    '--mount', `type=bind,source=${fixture},target=/fixture,readonly`, '--mount', `type=bind,source=${verifier},target=/source/email-audience,readonly`,
    ...(options['golden-only'] ? ['--env', 'CLAWPILOT_NATIVE_FIXTURE_GOLDEN_ONLY=1'] : []),
    ...(options['remediation-candidate'] ? ['--env', 'CLAWPILOT_NATIVE_FIXTURE_REMEDIATION=1'] : []),
    '--entrypoint', '/bin/sh', appImage.id, '/fixture/bootstrap.sh']); appStarted = true
  try { output = execute('docker', ['start', '--attach', appName], { timeout: 240_000 }) }
  catch (error) { output = `${error.stdout || ''}\n${error.stderr || ''}`; throw new Error(`Real SuiteCRM acceptance failed:\n${output.slice(-16_000)}`) }
  process.stdout.write(output)
  assert.match(output, /CLAWPILOT_NATIVE_EMAIL_GOLDEN=/, 'Actual native save/readback golden must execute')
  if (!options['golden-only']) assert.match(output, /REAL_SUITECRM_ACCEPTANCE_PASSED=/, 'No mocked or partial run counts as native acceptance')
  if (options['remediation-candidate']) {
    assert.match(output, /NATIVE_REMEDIATION_CANDIDATE_PASSED=/, 'A passing baseline is not a passing remediation candidate')
    assert.match(output, /NATIVE_HTTP_ACCEPTANCE_PASSED=/, 'Candidate needs actual authenticated HTTP acceptance, not just service calls')
    assert.match(output, /NATIVE_MANAGED_EMAIL_LIFECYCLE_PASSED=/, 'Candidate needs actual native historical and future lifecycle acceptance')
    assert.match(output, /NATIVE_FUTURE_EMAIL_DEFAULTS_PASSED=/, 'Candidate must test safe defaults for future native users')
  }
  // Bind the receipt to the executed fixture too, not only the upstream release.
  for (const [path, hash] of Object.entries(fixtureHashes)) {
    assert.equal(createHash('sha256').update(readFileSync(join(fixture, path))).digest('hex'), hash,
      'Fixture changed during acceptance; do not certify a mixed candidate')
  }
  const receipt = { version: 1, sourceVersion: VERSION, sourceZipSha256: ZIP_SHA, sourceHashes, fixtureHashes,
    runtimeImage: appImage.id, databaseImage: dbImage.id, phpVersion: appImage.phpVersion, databaseVersion: dbVersion,
    isolatedNetwork: true, hostPorts: 0, mode: options['remediation-candidate'] ? 'remediation-candidate' : options['golden-only'] ? 'golden-only' : 'acceptance',
    capturedAt: new Date().toISOString(), output }
  if (options.output) writeFileSync(options.output, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  console.log(`Real SuiteCRM ${VERSION} ${receipt.mode} completed; exact images/source recorded, no production access`)
} finally { cleanup() }
