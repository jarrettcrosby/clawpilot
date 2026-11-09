#!/usr/bin/env node
// Lightweight shared Email component fixture. No stock image install, live provider, or host port.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { createDisposablePostgresRuntime, DISPOSABLE_POSTGRES_LABEL, DISPOSABLE_POSTGRES_OWNER_LABEL } from './lib/disposable-postgres-docker.mjs'
import { runStorageGuard } from './local-storage-guard.mjs'

const [kind = 'receipt', ...extra] = process.argv.slice(2)
assert.ok(['receipt', 'absence'].includes(kind) && !extra.length, 'Use receipt or absence')
const root = fileURLToPath(new URL('../', import.meta.url))
const database = kind === 'receipt' ? 'clawpilot_receipt_fixture' : 'suitecrm_absence_test'
const fixture = `test-shared-bpo-email-${kind === 'receipt' ? 'receipt' : 'native-absence'}.php`
const dbImage = 'sha256:d1891ede5a559f1086f55053bb8cc1569b0298338c4d72d71725a7f74f6ba620'
const phpImage = 'sha256:104df566d62640d45618b1e70be6a2c83239caffe6c7badcd57b1c2f0090f3ea'
const environment = { ...process.env, CI: '', VERCEL: '', VERCEL_ENV: '' }
for (const key of ['RAILWAY_PROJECT_ID','RAILWAY_ENVIRONMENT_ID','RAILWAY_ENVIRONMENT_NAME','RAILWAY_SERVICE_ID']) delete environment[key]
assert.equal(runStorageGuard({ argv:['--preflight'], environment }), 0, 'Local disk headroom must pass')
const docker = (args, options = {}) => execFileSync('docker', args, {
  encoding:'utf8', stdio:['ignore','pipe','pipe'], timeout:30_000, maxBuffer:128*1024, ...options,
})
const inspect = (type, id) => {
  try { return JSON.parse(docker([type,'inspect',id]))[0] }
  catch (error) { if (/No such (?:object|container|network)/i.test(String(error.stderr))) return null; throw error }
}
assert.deepEqual(Object.keys(inspect('image', dbImage).Config.Volumes ?? {}), ['/var/lib/mysql'])
assert.deepEqual(Object.keys(inspect('image', phpImage).Config.Volumes ?? {}), [])
const token = randomUUID(), prefix = `cp-shared-email-${process.pid}-${token.slice(0,8)}`
const db = `${prefix}-db`, php = `${prefix}-php`, network = `${prefix}-net`
const ownership = 'com.clawpilot.shared-email-fixture.owner'
const lease = createDisposablePostgresRuntime({ environment })
let admitted = false, networkCreated = false, phpCreated = false
const limits = (memory, cpus) => ['--memory',memory,'--memory-swap',memory,'--cpus',cpus,'--pids-limit','128',
  '--log-driver','json-file','--log-opt','max-size=2m','--log-opt','max-file=1','--label',`${ownership}=${token}`]
function cleanup() {
  const errors = []
  const attempt = action => { try { action() } catch (error) { errors.push(error) } }
  if (phpCreated) attempt(() => {
    const current = inspect('container',php)
    if (!current) return
    assert.equal(current.Config.Labels?.[ownership],token)
    docker(['rm','--force','--volumes',current.Id])
    assert.equal(inspect('container',current.Id),null)
  })
  if (admitted) attempt(() => assert.equal(lease.cleanup(),true,'Owner-checked database cleanup must finish'))
  if (networkCreated) attempt(() => {
    const current = inspect('network',network)
    if (!current) return
    assert.equal(current.Labels?.[ownership],token)
    assert.equal(Object.keys(current.Containers ?? {}).length,0)
    docker(['network','rm',current.Id])
  })
  if (errors.length) throw new AggregateError(errors,'Shared Email fixture cleanup failed')
}
for (const [signal,code] of [['SIGINT',130],['SIGTERM',143]]) {
  process.once(signal, () => { try { cleanup() } finally { process.exit(code) } })
}
try {
  const leaseToken = lease.admit(db); admitted = true
  docker(['network','create','--internal','--label',`${ownership}=${token}`,network]); networkCreated = true
  docker(['run','--rm','--detach','--pull=never','--name',db,'--network',network,'--network-alias','db','--read-only',
    ...limits('640m','0.5'),'--label',`${DISPOSABLE_POSTGRES_LABEL}=true`,'--label',`${DISPOSABLE_POSTGRES_OWNER_LABEL}=${leaseToken}`,
    '--tmpfs','/var/lib/mysql:rw,nosuid,size=320m','--tmpfs','/run/mysqld:rw,nosuid,size=8m','--tmpfs','/tmp:rw,nosuid,size=32m',
    '--cap-drop','ALL','--cap-add','CHOWN','--cap-add','DAC_OVERRIDE','--cap-add','FOWNER','--cap-add','SETGID','--cap-add','SETUID',
    '--security-opt','no-new-privileges','--env','MARIADB_ROOT_PASSWORD=Synthetic-native-root-password-only',
    '--env',`MARIADB_DATABASE=${database}`,'--env','MARIADB_USER=fixture','--env','MARIADB_PASSWORD=Synthetic-native-db-password-only',
    dbImage,'--skip-log-bin','--innodb-buffer-pool-size=64M','--max-connections=20','--performance-schema=OFF'])
  const current = inspect('container',db)
  assert.ok(current.Mounts.every(mount => mount.Type !== 'volume'))
  assert.equal(Object.keys(current.HostConfig.PortBindings ?? {}).length,0)
  assert.equal(inspect('network',network).Internal,true)
  const deadline = Date.now() + 35_000
  while (true) {
    try {
      assert.match(docker(['exec','--env','MYSQL_PWD=Synthetic-native-db-password-only',db,
        'mariadb','--user=fixture',`--database=${database}`,'--batch','--skip-column-names','--execute=SELECT VERSION()'],{ timeout:3000 }),/^11\.4\.13-MariaDB/)
      break
    } catch (error) {
      if (Date.now() > deadline) throw error
      await new Promise(resolveWait => setTimeout(resolveWait, 250))
    }
  }
  docker(['create','--rm','--pull=never','--name',php,'--network',network,'--read-only',...limits('320m','0.5'),
    '--tmpfs','/tmp:rw,nosuid,size=16m','--cap-drop','ALL','--security-opt','no-new-privileges',
    '--env',kind === 'receipt' ? 'CLAWPILOT_SYNTHETIC_RECEIPT_FIXTURE=1' : 'CLAWPILOT_SHARED_EMAIL_SYNTHETIC_ONLY=1',
    '--mount',`type=bind,source=${resolve(root,'services/suitecrm/email-audience')},target=/source/services/suitecrm/email-audience,readonly`,
    '--mount',`type=bind,source=${resolve(root,'services/suitecrm/native-email-scope')},target=/source/services/suitecrm/native-email-scope,readonly`,
    '--mount',`type=bind,source=${resolve(root,'scripts',fixture)},target=/source/scripts/${fixture},readonly`,
    '--entrypoint','php',phpImage,`/source/scripts/${fixture}`,'db',...(kind === 'absence' ? ['synthetic-only'] : [])]); phpCreated = true
  process.stdout.write(docker(['start','--attach',php]))
} finally { cleanup() }
