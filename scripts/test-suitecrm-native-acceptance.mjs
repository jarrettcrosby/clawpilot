#!/usr/bin/env node
// Real checksum-pinned SuiteCRM + MariaDB acceptance. No production data/env,
// no host ports, no provider access. Dependency preparation is a separate step.
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { createDisposablePostgresRuntime, disposablePostgresDockerArgs, DISPOSABLE_POSTGRES_LABEL, DISPOSABLE_POSTGRES_OWNER_LABEL } from './lib/disposable-postgres-docker.mjs'
import { runNativeAppPostgresAcceptance, assertCombinedNativeScaleHandoff, nativeFixtureScaleEmailCount } from './lib/native-app-postgres-acceptance.mjs'
import { runStorageGuard } from './local-storage-guard.mjs'
import { nativeRuntimeFixtureProfile } from './lib/native-runtime-fixture-profile.mjs'

const VERSION = '8.10.1'
const ZIP_SHA = 'b72da32ca7702452537cdd11e1157bc41a283accdadca66ef88f42684a571ef7'
const DATABASE = 'mariadb:11.4.13'
const LABEL = 'com.clawpilot.native-email-acceptance'
const options = Object.fromEntries(process.argv.slice(2).map(argument => {
  const match = argument.match(/^--(source-zip|output)=(.+)$/)
  if (match) return [match[1], match[2]]
  const runtime=argument.match(/^--runtime-php=(8\.3\.(?:35|36))$/)
  if(runtime)return ['runtime-php',runtime[1]]
  const scale=argument.match(/^--scale-email-count=(318|334)$/)
  if(scale)return ['scale-email-count',Number(scale[1])]
  if (argument === '--golden-only') return ['golden-only', true]
  if (argument === '--shared-email-only') return ['shared-email-only', true]
  if (argument === '--remediation-candidate') return ['remediation-candidate', true]
  if (argument === '--require-authority-scale') return ['require-authority-scale', true]
  if (argument === '--app-postgres') return ['app-postgres', true]
  throw new Error('Use --source-zip=/absolute/SuiteCRM-8.10.1.zip [--runtime-php=8.3.35|8.3.36] [--output=/absolute/result.json] [--shared-email-only | --golden-only | --remediation-candidate [--scale-email-count=318|334] [--require-authority-scale] [--app-postgres]]')
}))
const runtimeProfile=nativeRuntimeFixtureProfile(options['runtime-php']),RUNTIME=runtimeProfile.image
const scaleEmailCount=nativeFixtureScaleEmailCount(options['scale-email-count'])
assert.ok(!(options['shared-email-only'] && (options['golden-only'] || options['remediation-candidate'])), 'Shared Email runs on a fresh stock install only')
assert.ok(!(options['golden-only'] && options['remediation-candidate']), 'Remediation requires the complete unchanged baseline first')
assert.ok(!options['require-authority-scale'] || options['remediation-candidate'], 'Scale release gate requires the full remediation candidate')
assert.ok(!options['app-postgres'] || options['remediation-candidate'], 'Combined application/PostgreSQL proof requires the full native candidate')
assert.ok(!options['scale-email-count'] || options['remediation-candidate'], 'A selected synthetic scale profile requires the full remediation candidate')
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
assert.equal(appImage.phpVersion, runtimeProfile.phpVersion, 'Prepare the exact selected PHP fixture; a mutable latest patch is not a runtime proof')
assert.deepEqual(appImage.volumes, [], 'PHP image must declare no anonymous volumes')
assert.deepEqual(dbImage.volumes, ['/var/lib/mysql'], 'Every database image volume must be explicitly covered by tmpfs')
const root = mkdtempSync(join(tmpdir(), 'clawpilot-suitecrm-native-run.'))
const token = randomUUID()
const name = `clawpilot-native-email-${process.pid}-${token.slice(0, 8)}`
const dbName = `${name}-db`, pgName = `${name}-pg`, appName = `${name}-app`, network = `${name}-net`
writeFileSync(join(root, 'owner.json'), JSON.stringify({ token, pid: process.pid }), { flag: 'wx', mode: 0o600 })
// Reuse the product's owner-checked disk/DB admission lease. This fixture's SQL
// engine is MariaDB; its lease is shared with PostgreSQL to avoid concurrent DBs.
const lease = createDisposablePostgresRuntime({ environment: localEnvironment })
let admitted = false, networkStarted = false, appStarted = false, nativeDbStarted = false, cleaning = false
const combinedKeys = options['app-postgres'] ? generateKeyPairSync('rsa',{modulusLength:3072}) : null
if(combinedKeys)writeFileSync(join(root,'combined-public.pem'),combinedKeys.publicKey.export({type:'spki',format:'pem'}),{flag:'wx',mode:0o600})
const fixture = resolve('scripts/fixtures/native-email-audience-real')
const verifier = resolve('services/suitecrm/email-audience')
const scopePackage = resolve('services/suitecrm/native-email-scope')
const scopeInstaller = resolve('services/suitecrm/install-native-email-scope.php')
const scopeInstallerFixture = resolve('scripts/fixtures/native-email-scope-installer.php')
if(options['remediation-candidate'])assert.deepEqual(
  readFileSync(join(scopePackage,'Scope.php')),readFileSync(join(fixture,'remediation-read-scope.php')),
  'Production scope and independent fixture helper must have identical bytes before native startup')
const fixtureHashes = Object.fromEntries(readdirSync(fixture).filter(path => /\.(php|sh)$/.test(path)).sort().map(path =>
  [path, createHash('sha256').update(readFileSync(join(fixture, path))).digest('hex')]))
// Bind acceptance to production-source candidates too, not just test adapters.
const candidateFiles = [
  resolve('scripts/test-suitecrm-native-acceptance.mjs'),resolve('scripts/lib/native-runtime-fixture-profile.mjs'),
  ...readdirSync(verifier).filter(path => /\.(php|sql)$/.test(path)).sort().map(path => join(verifier, path)),
  ...(options['shared-email-only'] ? [join(scopePackage, 'Patch.php')] : []),
  ...(options['remediation-candidate'] ? [scopeInstaller, scopeInstallerFixture,
    ...['app_src/lib/crm/nativeEmailAuthorityApproval.ts','app_src/lib/crm/nativeEmailAuthorityTransition.ts',
      'app_src/lib/crm/nativeEmailPublication.ts','app_src/lib/crm/nativeEmailPublicationTransport.ts','app_src/lib/crm/nativeEmailCapabilityContract.ts',
      'scripts/test-native-email-authority-approval.mjs','scripts/test-native-email-authority-transition.mjs',
      'scripts/test-native-email-capability-contract.mjs','scripts/verify-native-email-publication-receipt-parity.mjs',
      'scripts/verify-native-email-authority-receipt-parity.mjs'].map(path => resolve(path)),
    ...readdirSync(scopePackage).filter(path => path.endsWith('.php')).sort().map(path => join(scopePackage, path))] : []),
]
if(options['app-postgres'])candidateFiles.push(
  resolve('scripts/lib/native-app-postgres-acceptance.mjs'),resolve('app_src/lib/persistence/crmNativeEmailAuthority.ts'),
  resolve('app_src/lib/persistence/crmRootEmployeeAccess.ts'),resolve('app_src/lib/crm/rootEmployeeCrmAccess.ts'),
  resolve('app_src/lib/persistence/crmRootEmployeeRegistryPreview.ts'),resolve('app_src/lib/crm/rootEmployeeCrmRegistryChange.ts'),
  resolve('app_src/app/api/crm/root-access/route.ts'),resolve('app_src/lib/persistence/crmRootEmployeeSettings.ts'),
  resolve('app_src/lib/crm/rootEmployeeCrmSettings.ts'),resolve('app_src/lib/browserSameOrigin.ts'),resolve('app_src/lib/publicOriginRouting.mjs'),
  resolve('app_src/lib/crm/suiteCrmNativeEmailProjection.ts'),
  resolve('app_src/lib/users.ts'),resolve('app_src/lib/demoMode.ts'),
  ...readdirSync(resolve('app_src/lib/crm')).filter(p=>p.startsWith('nativeEmail')&&p.endsWith('.ts')).map(p=>resolve('app_src/lib/crm',p)),
  ...readdirSync(resolve('db/migrations')).filter(p=>/^0(?:37[5-9]|38[0-7]|39[124567])_.*\.sql$/.test(p)).map(p=>resolve('db/migrations',p)))
const candidateHashes = Object.fromEntries(candidateFiles.map(path =>
  [path, createHash('sha256').update(readFileSync(path)).digest('hex')]))
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
  let auxiliariesClean=true
  if (appStarted) attempt('application container', () => {try{removeOwnedContainer(appName)}catch(error){auxiliariesClean=false;throw error}})
  // In the combined workload PostgreSQL owns the single shared DB lease;
  // MariaDB/PHP are bounded auxiliaries. Remove MariaDB before releasing it.
  if (options['app-postgres'] && nativeDbStarted) attempt('native database auxiliary', () => {try{removeOwnedContainer(dbName)}catch(error){auxiliariesClean=false;throw error}})
  if (admitted && (!options['app-postgres'] || auxiliariesClean)) attempt('database container and shared lease', () => {
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
let combinedAppPostgres = null
try {
  let leaseToken
  if(options['app-postgres']){
    // Reviewed metadata-only lower profile: PG 512 MiB + native MariaDB 640
    // MiB + PHP 1152 MiB, with a combined 2 CPU ceiling and no extra swap.
    // Acquire the normal guarded PG lease FIRST; no second DB admission or
    // busy-lease bypass is used for this one integrated test workload.
    const profile={...localEnvironment,CLAWPILOT_TEST_POSTGRES_TMPFS_SIZE:'256m',CLAWPILOT_TEST_POSTGRES_MEMORY:'512m',CLAWPILOT_TEST_POSTGRES_CPUS:'0.5'}
    const args=disposablePostgresDockerArgs(['run','--rm','--detach','--name',pgName,'--pull','never',
      '-e','POSTGRES_PASSWORD=combined_fixture_only','-e','POSTGRES_DB=combined_fixture','-p','127.0.0.1::5432','pgvector/pgvector:pg16'],
    {environment:profile,runtime:lease})
    admitted=true;leaseToken=args.find(value=>value.startsWith(DISPOSABLE_POSTGRES_OWNER_LABEL+'=')).slice(DISPOSABLE_POSTGRES_OWNER_LABEL.length+1)
    execute('docker', ['network', 'create', '--internal', '--label', `${LABEL}.owner=${token}`, network]); networkStarted = true
    execute('docker',args,{timeout:60000})
    // Docker does not publish ports on an --internal network. PG uses the
    // established test bridge with an ephemeral 127.0.0.1-only binding; native
    // MariaDB/PHP remain on their fully internal, unpublished network.
    assert.match(execute('docker',['port',pgName,'5432/tcp']),/^127\.0\.0\.1:\d+\s*$/)
    const pg=inspectContainer(pgName)
    assert.equal(pg.HostConfig.PortBindings['5432/tcp'].length,1)
    assert.equal(pg.HostConfig.PortBindings['5432/tcp'][0].HostIp,'127.0.0.1')
  }else{leaseToken = lease.admit(dbName); admitted = true}
  execute('unzip', ['-q', archive, '-d', join(root, 'suitecrm')], { timeout: 60_000 })
  const sourceHashes = Object.fromEntries([
    'public/legacy/modules/Emails/Email.php', 'public/legacy/data/SugarBean.php',
    'public/legacy/modules/SecurityGroups/SecurityGroup.php', 'public/legacy/modules/ACLActions/ACLAction.php',
    'public/legacy/Api/V8/Service/ModuleService.php', 'public/legacy/Api/V8/Service/RelationshipService.php',
    'public/legacy/modules/Emails/EmailUIAjax.php', 'public/legacy/include/SugarFolders/SugarFolders.php',
  ].map(path => [path, createHash('sha256').update(readFileSync(join(root, 'suitecrm', path))).digest('hex')]))
  if(!networkStarted){execute('docker', ['network', 'create', '--internal', '--label', `${LABEL}.owner=${token}`, network]); networkStarted = true}
  execute('docker', ['run', '--rm', '--detach', '--pull=never', '--name', dbName,
    '--network', network, '--network-alias', 'db', '--read-only',
    ...limits('640m', '0.5'), '--label', `${DISPOSABLE_POSTGRES_LABEL}=true`, '--label', `${DISPOSABLE_POSTGRES_OWNER_LABEL}=${leaseToken}`,
    '--tmpfs', '/var/lib/mysql:rw,nosuid,size=320m', '--tmpfs', '/run/mysqld:rw,nosuid,size=8m', '--tmpfs', '/tmp:rw,nosuid,size=32m',
    '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'FOWNER', '--cap-add', 'SETGID', '--cap-add', 'SETUID',
    '--security-opt', 'no-new-privileges',
    '--env', 'MARIADB_ROOT_PASSWORD=Synthetic-native-root-password-only', '--env', 'MARIADB_DATABASE=suitecrm_native_test',
    '--env', 'MARIADB_USER=fixture', '--env', 'MARIADB_PASSWORD=Synthetic-native-db-password-only', dbImage.id,
    '--skip-log-bin', '--innodb-buffer-pool-size=64M', '--max-connections=20', '--performance-schema=OFF'])
  nativeDbStarted = true
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
  let issuerFixtureHash = null, capabilityFixtureHash = null
  if (options['remediation-candidate']) {
    // Synthetic public proof only. The test creates its RSA private key in
    // memory and never emits it; no production key/config is used or persisted.
    const issuerFixture = execute(process.execPath, ['scripts/test-native-email-authority-approval.mjs', '--emit-fixture'])
    const parsed = JSON.parse(issuerFixture)
    assert.equal(parsed.syntheticOnly, true)
    assert.ok(!issuerFixture.includes('PRIVATE KEY'))
    issuerFixtureHash = createHash('sha256').update(issuerFixture).digest('hex')
    writeFileSync(join(root, 'authority-issuer.json'), issuerFixture, { flag:'wx', mode:0o600 })
    const capabilityOutput = execute(process.execPath, ['scripts/test-native-email-capability-contract.mjs','--emit-fixture'])
    const prefix = 'CLAWPILOT_NATIVE_CAPABILITY_FIXTURE='
    const lines = capabilityOutput.split('\n').filter(line => line.startsWith(prefix))
    assert.equal(lines.length, 1)
    const capabilityFixture = lines[0].slice(prefix.length)
    const capabilities = JSON.parse(capabilityFixture)
    assert.equal(capabilities.version, 1)
    assert.ok(capabilities.vectors.length >= 32 && capabilities.vectors.length === capabilities.expected.length)
    capabilityFixtureHash = createHash('sha256').update(capabilityFixture).digest('hex')
    writeFileSync(join(root,'capability-contract.json'),capabilityFixture,{flag:'wx',mode:0o600})
  }
  execute('docker', ['create', '--rm', '--pull=never', '--name', appName, '--network', network, '--read-only',
    ...limits('1152m', '1'), '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--tmpfs', '/app:rw,nosuid,size=640m', '--tmpfs', '/tmp:rw,nosuid,size=32m',
    '--mount', `type=bind,source=${join(root, 'suitecrm')},target=/source/suitecrm,readonly`,
    '--mount', `type=bind,source=${fixture},target=/fixture,readonly`, '--mount', `type=bind,source=${verifier},target=/source/email-audience,readonly`,
    ...(options['shared-email-only'] ? ['--env', 'CLAWPILOT_NATIVE_FIXTURE_SHARED_EMAIL_ONLY=1',
      '--mount', `type=bind,source=${scopePackage},target=/source/native-email-scope,readonly`] : []),
    ...(options['remediation-candidate'] ? [
      '--mount', `type=bind,source=${join(root, 'authority-issuer.json')},target=/fixture-authority-issuer.json,readonly`,
      '--mount', `type=bind,source=${join(root, 'capability-contract.json')},target=/fixture-capability-contract.json,readonly`,
      '--mount', `type=bind,source=${scopePackage},target=/source/native-email-scope,readonly`,
      '--mount', `type=bind,source=${scopeInstaller},target=/source/install-native-email-scope.php,readonly`,
      '--mount', `type=bind,source=${scopeInstallerFixture},target=/fixture-scope-installer.php,readonly`,
    ] : []),
    ...(options['app-postgres'] ? ['--env','CLAWPILOT_NATIVE_FIXTURE_APP_PG=1',
      '--mount',`type=bind,source=${join(root,'combined-public.pem')},target=/fixture-combined-public.pem,readonly`] : []),
    ...(options['golden-only'] ? ['--env', 'CLAWPILOT_NATIVE_FIXTURE_GOLDEN_ONLY=1'] : []),
    ...(options['remediation-candidate'] ? ['--env', 'CLAWPILOT_NATIVE_FIXTURE_REMEDIATION=1'] : []),
    ...(options['remediation-candidate'] ? ['--env', `CLAWPILOT_NATIVE_FIXTURE_SCALE_EMAIL_COUNT=${scaleEmailCount}`] : []),
    '--entrypoint', '/bin/sh', appImage.id, '/fixture/bootstrap.sh']); appStarted = true
  try {
    if(!options['app-postgres'])output = execute('docker', ['start', '--attach', appName], { timeout: 240_000 })
    else{
      let terminal=null,bootstrapOutput=''
      const attach=promisify(execFile)('docker',['start','--attach',appName],{encoding:'utf8',timeout:600000,maxBuffer:4*1024*1024})
        .then(result=>terminal={output:result.stdout},error=>terminal={error})
      try{
        const deadline=Date.now()+300000
        while(true){
          if(terminal){if(terminal.error)throw terminal.error;throw new Error('Combined native fixture ended before its ready handoff')}
          let ready=false
          try{execute('docker',['exec',appName,'test','-f','/tmp/native-app-pg-ready'],{timeout:3000});ready=true}catch{}
          if(ready)break
          if(Date.now()>deadline)throw new Error('Combined native readiness deadline exceeded')
          await new Promise(resolve=>setTimeout(resolve,500))
        }
        bootstrapOutput=execute('docker',['logs',appName])
        if(options['require-authority-scale'])assertCombinedNativeScaleHandoff(bootstrapOutput,scaleEmailCount)
        combinedAppPostgres=await runNativeAppPostgresAcceptance({appName,pgName,keys:combinedKeys,root:process.cwd()})
        execute('docker',['exec',appName,'touch','/tmp/native-app-pg-done'])
        await attach;if(terminal.error)throw terminal.error;output=terminal.output
      }catch(error){
        if(!error.stdout)error.stdout=(terminal?.output??terminal?.error?.stdout??bootstrapOutput)+'\n'+String(error.stack??error)
        throw error
      }
    }
  }
  catch (error) {
    output = `${error.stdout || ''}\n${error.stderr || ''}`
    // Preserve the complete isolated diagnostic privately, but do not let stock
    // PHP deprecation noise hide the actual failure in a bounded tool response.
    if (options.output) writeFileSync(options.output.replace(/\.json$/, '.failed.json'), `${JSON.stringify({
      version: 1, mode: 'failed-native-acceptance', sourceVersion: VERSION, sourceZipSha256: ZIP_SHA,
      scaleEmailCount: options['remediation-candidate'] ? scaleEmailCount : null,
      fixtureHashes, candidateHashes, isolatedNetwork: true, hostPorts: 0,
      capturedAt: new Date().toISOString(), output,
    }, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    const diagnostic = output.split('\n').filter(line => line.trim() && !/^Deprecated:/.test(line)).slice(-24).join('\n')
    throw new Error(`Real SuiteCRM acceptance failed:\n${diagnostic.slice(-8_000)}`)
  }
  // Full output (including the synthetic wire receipt) remains in the private
  // result artifact. Console output is a compact stage-by-stage result only.
  process.stdout.write(output.split('\n').filter(line => /^(?:PASS |[A-Z_]+PASSED=)/.test(line)).join('\n') + '\n')
  if (options['shared-email-only']) {
    assert.match(output, /^NATIVE_SHARED_EMAIL_ACCEPTANCE_PASSED=1$/m, 'Stock write, relationship histories, permissions and retry must all pass')
  } else {
    assert.match(output, /CLAWPILOT_NATIVE_EMAIL_GOLDEN=/, 'Actual native save/readback golden must execute')
    if (!options['golden-only']) assert.match(output, /REAL_SUITECRM_ACCEPTANCE_PASSED=/, 'No mocked or partial run counts as native acceptance')
  }
  if (options['remediation-candidate']) {
    assert.match(output, /NATIVE_SCOPE_INSTALLER_TEST_PASSED=/, 'Candidate needs offline installation and exact recovery acceptance')
    assert.match(output, /NATIVE_REMEDIATION_CANDIDATE_PASSED=/, 'A passing baseline is not a passing remediation candidate')
    assert.match(output, /NATIVE_MANAGED_ROLE_EXECUTION_PASSED=1/, 'Retained viewer/editor roles require actual native ACL and future-publication acceptance')
    assert.match(output, /NATIVE_MANAGED_READ_ACCESS_GRANT_PASSED=1/, 'Read-only access grants require actual native denial before app proof, historical/future readback and V8 write refusal')
    assert.match(output, /NATIVE_HTTP_ACCEPTANCE_PASSED=/, 'Candidate needs actual authenticated HTTP acceptance, not just service calls')
    assert.match(output, /NATIVE_MANAGED_EMAIL_LIFECYCLE_PASSED=/, 'Candidate needs actual native historical and future lifecycle acceptance')
    assert.match(output, /NATIVE_FUTURE_EMAIL_DEFAULTS_PASSED=/, 'Candidate must test safe defaults for future native users')
    assert.match(output, /NATIVE_POLICY_FENCE_PASSED=/, 'Candidate needs independent native policy-writer contention acceptance')
    assert.match(output, /NATIVE_EMAIL_GROUP_DELTA_PASSED=/, 'Candidate must admit only the exact reviewed native Email-group insert')
    assert.match(output, /NATIVE_EMAIL_PROJECTION_PASSED=/, 'Candidate requires actual raw native projection fidelity')
    assert.match(output, /NATIVE_TRANSACTIONAL_PUBLISHER_PASSED=/, 'Candidate needs actual transactional publisher and timeout reconciliation acceptance')
    assert.match(output, /NATIVE_PUBLISHER_RACE_PASSED=/, 'Candidate requires overlapping independent publish/cancel outcomes')
    assert.match(output, /NATIVE_PUBLISHER_AUTHORIZATION_PASSED=/, 'Candidate must revalidate native callers after taking transactional locks')
    assert.match(output, /NATIVE_PUBLISHER_STORAGE_PASSED=/, 'Candidate must reject native triggers and registry identity-index drift')
    assert.match(output, /NATIVE_PUBLISHER_HTTP_PASSED=/, 'Candidate needs actual authenticated HTTP publication, cancellation and denial proof')
    assert.match(output, /NATIVE_AUTHORITY_CONTRACT_PASSED=/, 'Candidate needs exact native authority contract and delta checks')
    assert.match(output, /NATIVE_AUTHORITY_TRANSITION_PASSED=/, 'Candidate needs actual native membership phase capability and receipt proof')
    assert.match(output, /NATIVE_AUTHORITY_ISSUER_PASSED=/, 'Candidate must verify actual TypeScript-issued proof signatures in PHP')
    assert.match(output, /NATIVE_AUTHORITY_HTTP_PASSED=/, 'Candidate needs authenticated approval and authority phase HTTP acceptance')
    assert.match(output, /NATIVE_EMAIL_CAPABILITY_CONTRACT_PASSED=/, 'Candidate must verify TS and PHP capability-contract parity')
    assert.match(output, /NATIVE_PUBLICATION_V2_PASSED=/, 'Candidate needs actual v2 publication preserving explicit native editor rights')
    assert.match(output, /CLAWPILOT_NATIVE_PUBLICATION_V2_RECEIPTS=/, 'Candidate needs actual v2 receipt and preparation handoff')
    assert.match(output, /NATIVE_AUTHORITY_V2_PASSED=/, 'Candidate needs actual v2 membership and historical capability transition proof')
    assert.match(output, /NATIVE_IDENTITY_LINK_METADATA_PASSED=1/, 'Candidate needs real fenced existing-account identity metadata and duplicate-writer refusal')
    if(options['app-postgres'])assert.match(output,/NATIVE_FIRST_IDENTITY_MANAGED_SCOPE_PASSED=1/,
      'First-account release gate requires actual fresh managed-scope enrollment and historical/future viewer rights')
    assert.match(output, /CLAWPILOT_NATIVE_AUTHORITY_V2_RECEIPTS=/, 'Candidate needs actual v2 authority receipt handoff')
    if(options['require-authority-scale'])assertCombinedNativeScaleHandoff(output,scaleEmailCount)
  }
  // Bind the receipt to the executed fixture too, not only the upstream release.
  for (const [path, hash] of Object.entries(fixtureHashes)) {
    assert.equal(createHash('sha256').update(readFileSync(join(fixture, path))).digest('hex'), hash,
      'Fixture changed during acceptance; do not certify a mixed candidate')
  }
  for (const [path, hash] of Object.entries(candidateHashes)) {
    assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), hash,
      'Runtime candidate changed during acceptance; do not certify mixed source')
  }
  const receipt = { version: 1, sourceVersion: VERSION, sourceZipSha256: ZIP_SHA, sourceHashes, fixtureHashes, candidateHashes, issuerFixtureHash, capabilityFixtureHash,
    runtimeImage: appImage.id, databaseImage: dbImage.id, phpVersion: appImage.phpVersion, databaseVersion: dbVersion,
    isolatedNetwork: !options['app-postgres'],nativeNetworkIsolated:true,hostPorts: options['app-postgres'] ? 1 : 0,
    postgresEndpoint: options['app-postgres'] ? 'ephemeral-loopback-only-default-docker-bridge' : null,
    combinedAppPostgres,requiredAuthorityScale: Boolean(options['require-authority-scale']),
    scaleEmailCount: options['remediation-candidate'] ? scaleEmailCount : null,
    mode: options['shared-email-only'] ? 'shared-email-only' : options['remediation-candidate'] ? 'remediation-candidate' : options['golden-only'] ? 'golden-only' : 'acceptance',
    capturedAt: new Date().toISOString(), output }
  if (options.output) writeFileSync(options.output, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  console.log(`Real SuiteCRM ${VERSION} ${receipt.mode} completed; exact images/source recorded, no production access`)
} finally { cleanup() }
