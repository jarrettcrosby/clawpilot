#!/usr/bin/env node
// Disposable two-engine mechanism rehearsal. No host credentials, ports,
// release traffic or SuiteCRM schema. This does not certify a Railway fence.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { createDisposablePostgresRuntime, disposablePostgresDockerArgs,
} from './lib/disposable-postgres-docker.mjs'

const flag = process.argv[2] ?? '--postgres-major=18'
assert.ok(process.argv.length <= 3 && /^--postgres-major=(16|18)$/u.test(flag))
const pgMajor = flag.split('=')[1]
const owner = randomUUID()
const pgName = `clawpilot-fence-pg-${owner}`
const mariaName = `clawpilot-fence-maria-${owner}`
const label = 'com.clawpilot.crm-writer-fence-fixture'
const password = 'isolated-fence-fixture-only'
const pgRuntime = createDisposablePostgresRuntime()
const children = []
const checks = []
let stage = 'startup'
let pgAdmission = false
let mariaLaunch = false

function docker(args, input) {
  return execFileSync('docker', args, {
    input, encoding: 'utf8', timeout: 15_000, maxBuffer: 128 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim()
}
const pgArgs = user => ['exec', '-i', '-e', `PGPASSWORD=${password}`, pgName,
  'psql', '--no-psqlrc', '--no-password', '--host=127.0.0.1', `--username=${user}`, '--dbname=postgres',
  '--no-align', '--tuples-only', '--quiet', '--set=ON_ERROR_STOP=1', '--set=VERBOSITY=verbose']
const mariaArgs = user => ['exec', '-i', '-e', `MYSQL_PWD=${password}`, mariaName,
  'mariadb', '--no-defaults', '--protocol=tcp', '--host=127.0.0.1', `--user=${user}`,
  '--batch', '--skip-column-names']
const statement = (args, sql) => docker(args, sql)
const pg = sql => statement(pgArgs('postgres'), sql)
const maria = sql => statement(mariaArgs('root'), sql)
const deny = (args, pattern) => {
  let deniedError
  try { statement(args, 'SELECT 1;') } catch (error) { deniedError = error }
  assert.ok(Number.isInteger(deniedError?.status) && deniedError.status > 0, 'Ordinary fixture login unexpectedly succeeded')
  assert.match(String(deniedError.stderr), pattern)
}
const denied = () => {
  deny(pgArgs('ordinary_writer'), /FATAL:.*ordinary_writer.*not permitted to log in/u)
  deny(mariaArgs('ordinary_writer'), /ERROR 4151 .*account is locked/iu)
}
async function until(fn) {
  for (let i = 0; i < 40; i++) {
    try { if (fn()) return } catch { /* Only the bounded readiness probe retries. */ }
    await delay(200)
  }
  assert.fail('Fixture readiness deadline')
}
function runInFlight(args, sql) {
  const proc = spawn('docker', args, { stdio: ['pipe', 'ignore', 'ignore'] })
  const closed = once(proc, 'close')
  // A fixture teardown may already have closed the exec stream.
  proc.stdin.on('error', () => {})
  proc.stdin.end(sql)
  children.push({ proc, closed })
  return closed
}
function removeMaria() {
  let found
  try { found = docker(['container', 'inspect', '--format', `{{.Id}} {{index .Config.Labels "${label}"}}`, mariaName]) }
  catch (error) {
    if (/No such (?:object|container):/iu.test(String(error.stderr))) {
      mariaLaunch = false
      return
    }
    throw error
  }
  const [id, labelValue] = found.split(' ')
  assert.match(id, /^[a-f0-9]{64}$/u)
  assert.equal(labelValue, owner, 'Refuse cleanup of a different Docker container')
  docker(['rm', '--force', '--volumes', id])
  mariaLaunch = false
}
process.once('exit', () => { if (mariaLaunch) removeMaria() })

try {
  const pgLaunch = disposablePostgresDockerArgs(['run', '-d', '--pull', 'never', '--name', pgName, '--network', 'none',
    '-e', `POSTGRES_PASSWORD=${password}`, `pgvector/pgvector:pg${pgMajor}`,
    '-c', 'max_prepared_transactions=4'], { runtime: pgRuntime })
  pgAdmission = true
  docker(pgLaunch)
  mariaLaunch = true
  docker(['run', '--rm', '-d', '--pull', 'never', '--name', mariaName, '--network', 'none',
    '--label', `${label}=${owner}`, '--tmpfs', '/var/lib/mysql:rw,nosuid,size=320m',
    '--tmpfs', '/run/mysqld:rw,nosuid,size=8m', '--tmpfs', '/tmp:rw,nosuid,size=32m',
    '--memory', '768m', '--memory-swap', '768m', '--cpus', '1', '--pids-limit', '128',
    '--log-driver', 'local', '--log-opt', 'max-size=5m', '-e', `MARIADB_ROOT_PASSWORD=${password}`,
    'mariadb:11.4.13', '--event-scheduler=OFF', '--innodb-buffer-pool-size=64M'])
  await until(() => pg('SELECT 1;') === '1' && maria('SELECT 1;') === '1')

  stage = 'isolated-principals'
  pg(`CREATE TABLE public.fence_fixture(id text PRIMARY KEY);
    CREATE ROLE ordinary_writer LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEROLE;
    CREATE ROLE maintenance_writer LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEROLE;
    GRANT SELECT,INSERT ON public.fence_fixture TO ordinary_writer,maintenance_writer;`)
  maria(`CREATE DATABASE fence_fixture;
    CREATE TABLE fence_fixture.receipts(id varchar(32) PRIMARY KEY) ENGINE=InnoDB;
    CREATE USER 'ordinary_writer'@'%' IDENTIFIED BY '${password}';
    CREATE USER 'maintenance_writer'@'%' IDENTIFIED BY '${password}';
    GRANT SELECT,INSERT ON fence_fixture.receipts TO 'ordinary_writer'@'%','maintenance_writer'@'%';`)
  statement(pgArgs('ordinary_writer'), "INSERT INTO public.fence_fixture VALUES('before'); BEGIN; INSERT INTO public.fence_fixture VALUES('pg-prepared'); PREPARE TRANSACTION 'fence_fixture';")
  statement(mariaArgs('ordinary_writer'), "INSERT INTO fence_fixture.receipts VALUES('before'); XA START 'fence_fixture'; INSERT INTO fence_fixture.receipts VALUES('maria-prepared'); XA END 'fence_fixture'; XA PREPARE 'fence_fixture';")
  const pgFlight = runInFlight(pgArgs('ordinary_writer'), "BEGIN; INSERT INTO public.fence_fixture VALUES('pg-uncommitted'); SELECT pg_sleep(40); COMMIT;")
  const mariaFlight = runInFlight(mariaArgs('ordinary_writer'), "START TRANSACTION; INSERT INTO fence_fixture.receipts VALUES('maria-uncommitted'); SELECT SLEEP(40); COMMIT;")
  await until(() => pg("SELECT count(*) FROM pg_stat_activity WHERE usename='ordinary_writer' AND query LIKE '%pg_sleep(40)%';") === '1'
    && maria("SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE USER='ordinary_writer' AND INFO='SELECT SLEEP(40)';") === '1')

  stage = 'close-admission-before-drain'
  pg('ALTER ROLE ordinary_writer NOLOGIN;')
  maria("ALTER USER 'ordinary_writer'@'%' ACCOUNT LOCK;")
  denied()
  assert.equal(pg("SELECT count(*) FROM pg_stat_activity WHERE usename='ordinary_writer';"), '1')
  const nativeSession = maria("SELECT ID FROM information_schema.PROCESSLIST WHERE USER='ordinary_writer';")
  assert.match(nativeSession, /^\d+$/u)
  checks.push('new-writer-denied-before-old-session-drain')

  stage = 'drain-and-detect-prepared'
  assert.equal(pg("SELECT pg_terminate_backend(pid,5000) FROM pg_stat_activity WHERE usename='ordinary_writer';"), 't')
  maria(`KILL CONNECTION ${nativeSession};`)
  for (const result of await Promise.all([pgFlight, mariaFlight])) assert.notEqual(result[0], 0)
  denied()
  assert.equal(pg("SELECT count(*) FROM pg_stat_activity WHERE usename='ordinary_writer';"), '0')
  assert.equal(maria("SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE USER='ordinary_writer';"), '0')
  assert.equal(pg("SELECT gid FROM pg_prepared_xacts WHERE owner='ordinary_writer';"), 'fence_fixture')
  assert.match(maria('XA RECOVER;'), /fence_fixture/u)
  assert.equal(maria("SELECT @@event_scheduler;"), 'OFF')
  checks.push('zero-sessions-do-not-hide-prepared-writes')

  stage = 'fixture-prepared-rollback'
  // Only this test's known transactions are rolled back. Unknown production
  // transactions need separate evidence and cannot be settled by this script.
  pg("ROLLBACK PREPARED 'fence_fixture';")
  maria("XA ROLLBACK 'fence_fixture';")
  assert.equal(pg('SELECT count(*) FROM pg_prepared_xacts;'), '0')
  assert.equal(maria('XA RECOVER;'), '')
  denied()
  assert.equal(pg('SELECT id FROM public.fence_fixture ORDER BY id;'), 'before')
  assert.equal(maria('SELECT id FROM fence_fixture.receipts ORDER BY id;'), 'before')
  checks.push('uncommitted-and-prepared-fixture-writes-absent')

  stage = 'exclusive-maintenance-and-restore'
  assert.throws(() => statement(pgArgs('maintenance_writer'), 'ALTER ROLE ordinary_writer LOGIN;'),
    error => /42501:.*permission denied to alter role/iu.test(String(error.stderr)))
  assert.throws(() => statement(mariaArgs('maintenance_writer'), "ALTER USER 'ordinary_writer'@'%' ACCOUNT UNLOCK;"),
    error => /ERROR 1227 /u.test(String(error.stderr)))
  denied()
  checks.push('maintenance-principal-cannot-reopen-ordinary-login')
  statement(pgArgs('maintenance_writer'), "INSERT INTO public.fence_fixture VALUES('maintenance');")
  statement(mariaArgs('maintenance_writer'), "INSERT INTO fence_fixture.receipts VALUES('maintenance');")
  denied()
  assert.equal(pg('SELECT id FROM public.fence_fixture ORDER BY id;'), 'before\nmaintenance')
  assert.equal(maria('SELECT id FROM fence_fixture.receipts ORDER BY id;'), 'before\nmaintenance')
  checks.push('separate-maintenance-write-with-ordinary-admission-denied')
  pg('ALTER ROLE ordinary_writer LOGIN;')
  maria("ALTER USER 'ordinary_writer'@'%' ACCOUNT UNLOCK;")
  assert.equal(statement(pgArgs('ordinary_writer'), 'SELECT count(*) FROM public.fence_fixture;'), '2')
  assert.equal(statement(mariaArgs('ordinary_writer'), 'SELECT count(*) FROM fence_fixture.receipts;'), '2')
  checks.push('reopen-only-after-exact-readback')
} catch (error) {
  console.error(JSON.stringify({ passed: false, stage, error: String(error.message).split('\n').slice(0, 4).join(' ') }))
  process.exitCode = 1
} finally {
  for (const { proc } of children) if (proc.exitCode === null) proc.kill('SIGTERM')
  try { if (mariaLaunch) removeMaria() }
  finally { if (pgAdmission) assert.ok(pgRuntime.cleanup(), 'Guarded PostgreSQL cleanup was not verified') }
}
if (!process.exitCode) console.log(JSON.stringify({ kind: 'crm-writer-fence-db-role-fixture', passed: true,
  checks, engines: [`PostgreSQL ${pgMajor}`, 'MariaDB 11.4.13'], productionTouched: false, productionFenceProven: false,
  productionTransportProven: false, productionPreparedTransactionsSettled: false }))
