#!/usr/bin/env node
// Explicit local Homebrew MariaDB fixture, not a production connection or CI substitute.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { runStorageGuard } from './local-storage-guard.mjs'

assert.equal(process.platform, 'darwin', 'Use the explicit installed Homebrew MariaDB fixture')
assert.equal(process.argv.length, 2, 'This fixture accepts no connection or path overrides')
assert.ok(process.geteuid() > 0, 'Do not run the local fixture as root')
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))
assert.equal(runStorageGuard({ argv: ['--preflight'], repositoryRoot, environment: {
  PATH: '/usr/bin:/bin', USER: process.env.USER, CI: '', VERCEL: '', VERCEL_ENV: '',
} }), 0)

const prefix = '/opt/homebrew/opt/mariadb@11.4'
const bin = name => join(prefix, 'bin', name)
const environment = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }
assert.match(execFileSync(bin('mariadbd'), ['--no-defaults', '--version'], {
  encoding: 'utf8', env: environment, timeout: 5_000,
}), /11\.4\.13-MariaDB/u, 'Exact pinned MariaDB local fixture version is required')

const require = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = require('typescript'), modules = new Map()
function load(name) {
  if (modules.has(name)) return modules.get(name)
  const source = readFileSync(new URL(`../app_src/lib/crm/${name}.ts`, import.meta.url), 'utf8')
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const result = { exports: {} }
  new Function('require', 'module', 'exports', js)(dependency => {
    if (dependency === 'server-only') return {}
    if (dependency.startsWith('node:')) return require(dependency)
    assert.match(dependency, /^\.\/[A-Za-z0-9]+$/u)
    return load(dependency.slice(2))
  }, result, result.exports)
  modules.set(name, result.exports)
  return result.exports
}
const { createLegacyEmailTerminalHoldStockNativeObserver: create } = load('legacyEmailTerminalHoldStockNativeObserver')
const { nativeEmailDigest } = load('nativeEmailPublication')
const { nativeEmailMariaStoreFingerprint } = load('nativeEmailRecoveryStoreBinding')

const root = mkdtempSync(join(realpathSync('/tmp'), 'clawpilot-stock-maria-')), owner = randomUUID()
const marker = join(root, 'owner'), data = join(root, 'data'), socket = join(root, 'm.sock'), pidfile = join(root, 'm.pid')
writeFileSync(marker, owner, { flag: 'wx', mode: 0o600 })
const database = 'fixture_stock'
const signal = new AbortController()
let server, serverEnded
function abort() { signal.abort() }
process.once('SIGINT', abort)
process.once('SIGTERM', abort)
const defaults = ['--no-defaults', '--protocol=SOCKET', `--socket=${socket}`, '--connect-timeout=2', '--skip-auto-rehash']
const admin = (sql, db) => execFileSync(bin('mariadb'), [...defaults, '--user=root', '--batch', '--raw',
  '--skip-column-names', ...(db ? [`--database=${db}`] : []), '--execute', sql], {
  cwd: root, env: environment, encoding: 'utf8', timeout: 6_000, stdio: ['ignore', 'pipe', 'pipe'],
})
const sqlValue = value => {
  assert.equal(typeof value, 'string')
  assert.ok(Buffer.byteLength(value, 'utf8') <= 1024)
  return `CONVERT(X'${Buffer.from(value, 'utf8').toString('hex')}' USING utf8mb4)`
}
const bind = (sql, values = []) => {
  let index = 0
  const result = sql.replace(/\?/g, () => sqlValue(values[index++]))
  assert.equal(index, values.length, 'Fixture SQL bind count mismatch')
  return result
}
async function bounded(pending, milliseconds) {
  let timer
  try {
    return await Promise.race([pending, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('Owned Maria fixture did not exit in time')), milliseconds)
    })])
  } finally { clearTimeout(timer) }
}

/** All reader commands use one owned client and socket. In --batch mode a
 * SQL error exits the client; no error or visibility failure becomes no rows. */
async function withReadOnlySession(user, abortSignal, run) {
  assert.ok(['fixture_reader', 'fixture_table_reader', 'fixture_pattern_reader'].includes(user))
  assert.ok(!abortSignal.aborted)
  const client = spawn(bin('mariadb'), [...defaults, `--user=${user}`, `--database=${database}`, '--batch',
    '--raw', '--column-names', '--unbuffered'], { cwd: root, env: environment, stdio: ['pipe', 'pipe', 'pipe'] })
  let pending, buffer = '', outputBytes = 0, ended = false, closing = false
  const finish = (error) => {
    if (pending) {
      const p = pending
      pending = undefined
      clearTimeout(p.timer)
      p.reject(error)
    }
  }
  const exited = new Promise(resolve => {
    const done = () => { ended = true; finish(Error('Owned Maria fixture client closed before a complete response')); resolve() }
    client.once('close', done)
    client.once('error', done)
  })
  const cancelled = () => {
    finish(Error('Owned Maria fixture query aborted'))
    if (!ended) client.kill('SIGTERM')
  }
  abortSignal.addEventListener('abort', cancelled, { once: true })
  // Never display native error payloads, which can include connection details.
  client.stderr.on('data', () => {})
  client.stdin.on('error', () => { if (!closing) finish(Error('Owned Maria fixture client pipe closed')) })
  client.stdout.setEncoding('utf8')
  client.stdout.on('data', chunk => {
    outputBytes += Buffer.byteLength(chunk, 'utf8')
    if (outputBytes > 128 * 1024) {
      finish(Error('Owned Maria fixture response exceeded its limit'))
      client.kill('SIGTERM')
      return
    }
    buffer += chunk
    while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n'), line = buffer.slice(0, index).replace(/\r$/u, '')
      buffer = buffer.slice(index + 1)
      if (!pending) continue
      if (line !== pending.marker) { pending.lines.push(line); continue }
      const p = pending
      pending = undefined
      clearTimeout(p.timer)
      try {
        assert.equal(p.lines.pop(), 'fixture_boundary')
        const header = p.lines.shift()
        const columns = header?.split('\t') ?? []
        assert.equal(new Set(columns).size, columns.length)
        const rows = p.lines.map(value => {
          const fields = value.split('\t')
          assert.equal(fields.length, columns.length)
          return Object.fromEntries(columns.map((key, i) => [key, fields[i] === 'NULL' ? null : fields[i]]))
        })
        p.resolve({ rows })
      } catch { p.reject(Error('Owned Maria fixture response framing changed')) }
    }
  })
  const ask = (sql, values) => {
    assert.ok(!pending && !ended && !abortSignal.aborted)
    const statement = bind(sql, values)
    const boundary = 'fixture_' + randomUUID().replaceAll('-', '')
    return new Promise((resolve, reject) => {
      pending = { marker: boundary, lines: [], resolve, reject, timer: setTimeout(() => {
        finish(Error('Owned Maria fixture query timed out'))
        client.kill('SIGTERM')
      }, 5_000) }
      client.stdin.write(`${statement};\nSELECT '${boundary}' AS fixture_boundary;\n`)
    })
  }
  try {
    await ask('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ')
    await ask('SET SESSION TRANSACTION READ ONLY')
    await ask('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
    const result = await run({ query(sql, values) {
      assert.match(sql, /^SELECT /u, 'Stock observer may issue only SELECT')
      assert.doesNotMatch(sql, /;|INTO OUTFILE|FOR UPDATE/iu)
      return ask(sql, values)
    } })
    await ask('ROLLBACK')
    return result
  } finally {
    abortSignal.removeEventListener('abort', cancelled)
    closing = true
    if (!ended) client.stdin.end()
    try { await bounded(exited, 3_000) }
    catch (error) { if (!ended) client.kill('SIGTERM'); await bounded(exited, 3_000).catch(() => {}); throw error }
  }
}

const uuid = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`
const managed = ['clawpilot_email_authority_approvals', 'clawpilot_email_authority_operations',
  'clawpilot_email_bindings', 'clawpilot_email_identities', 'clawpilot_email_initial_enrollments',
  'clawpilot_email_operations', 'clawpilot_email_write_permissions', 'clawpilot_email_write_scopes']
const stock = ['emails', 'emails_beans', 'emails_cstm', 'emails_email_addr_rel', 'emails_text', 'securitygroups_records']
let checks = 0
const check = async (name, run) => { assert.ok(!signal.signal.aborted); await run(); checks++; console.log('PASS ' + name) }
const code = suffix => error => error?.code === `legacy_terminal_hold_stock_observer_${suffix}`

try {
  execFileSync(bin('mariadb-install-db'), ['--no-defaults', `--basedir=${prefix}`, `--datadir=${data}`,
    '--auth-root-authentication-method=normal', '--skip-test-db', '--skip-name-resolve'], {
    cwd: root, env: environment, encoding: 'utf8', timeout: 45_000, stdio: ['ignore', 'pipe', 'pipe'],
  })
  // Only the fresh owner-private socket is reachable; no shared service/TCP.
  server = spawn(bin('mariadbd'), ['--no-defaults', `--basedir=${prefix}`, `--datadir=${data}`,
    `--socket=${socket}`, `--pid-file=${pidfile}`, `--log-error=${join(root, 'm.log')}`, '--skip-networking',
    '--skip-name-resolve', '--event-scheduler=OFF', '--innodb-buffer-pool-size=32M', '--max-connections=10',
    '--server-id=481'], { cwd: root, env: environment, stdio: 'ignore' })
  serverEnded = new Promise(resolve => { server.once('close', resolve); server.once('error', resolve) })
  const until = Date.now() + 18_000
  while (true) {
    assert.ok(!signal.signal.aborted && server.exitCode === null && Date.now() < until, 'Owned Maria fixture startup did not complete')
    let ready = false
    try { ready = lstatSync(socket).isSocket() && admin('SELECT @@GLOBAL.skip_networking=1') === '1\n' }
    catch { /* Wait only on this fixture socket. */ }
    if (ready) break
    await delay(100)
  }
  assert.equal(Number(readFileSync(pidfile, 'utf8').trim()), server.pid)
  assert.equal(lstatSync(root).mode & 0o777, 0o700)
  admin(`CREATE DATABASE ${database};
    CREATE TABLE ${database}.emails (id CHAR(36) PRIMARY KEY, deleted TINYINT NOT NULL) ENGINE=InnoDB;
    CREATE TABLE ${database}.emails_cstm (id_c CHAR(36) PRIMARY KEY, global_id_c VARCHAR(32)) ENGINE=InnoDB;
    CREATE TABLE ${database}.emails_text (email_id CHAR(36), deleted TINYINT NOT NULL) ENGINE=InnoDB;
    CREATE TABLE ${database}.emails_beans (email_id CHAR(36), deleted TINYINT NOT NULL) ENGINE=InnoDB;
    CREATE TABLE ${database}.emails_email_addr_rel (email_id CHAR(36), deleted TINYINT NOT NULL) ENGINE=InnoDB;
    CREATE TABLE ${database}.securitygroups_records (record_id CHAR(36), deleted TINYINT NOT NULL) ENGINE=InnoDB;
    CREATE USER 'fixture_reader'@'localhost';
    CREATE USER 'fixture_table_reader'@'localhost';
    CREATE USER 'fixture_pattern_reader'@'localhost';
    GRANT SELECT ON \`fixture\\_stock\`.* TO 'fixture_reader'@'localhost';
    GRANT SELECT ON \`fixture_stock\`.* TO 'fixture_pattern_reader'@'localhost';
    ${stock.map(table => `GRANT SELECT ON ${database}.${table} TO 'fixture_table_reader'@'localhost';`).join('\n')}`)
  const [name, hostname, serverId, serverVersion, serverUid] = admin(
    'SELECT DATABASE(),@@GLOBAL.hostname,@@GLOBAL.server_id,VERSION(),@@GLOBAL.server_uid', database).trim().split('\t')
  const store = { database: name, hostname, serverId, serverVersion, serverUid }
  assert.equal(name, database)
  const nativeDatabaseFingerprint = nativeEmailMariaStoreFingerprint(store)
  const scope = { projectId: uuid(100), environmentId: uuid(101), postgresDatabaseFingerprint: 'e'.repeat(64),
    appCommit: 'a'.repeat(40), nativeDeploymentId: uuid(102), nativeReplicaId: uuid(103), nativeCommit: 'b'.repeat(40),
    nativeDatabaseFingerprint, nativeAuthorityInstanceId: 'native-fixture' }
  const identities = [1, 2].map(i => ({ outboxId: uuid(i), localId: uuid(10 + i),
    nativeId: `abcdef00-0000-4000-8000-${String(20 + i).padStart(12, '0')}`, globalId: `gi100000${i}` }))
  function observe(user = 'fixture_reader') {
    const adapter = create({ target: { scope, store, observer: { user, host: 'localhost' } },
      withReadOnlySession: (abortSignal, run) => withReadOnlySession(user, abortSignal, run) })
    const target = { operationId: uuid(7), scope, actorEmail: 'fixture@example.invalid', operatorAccountId: uuid(8),
      rootWorkspaceId: uuid(91), fenceEpoch: uuid(92), outboxIds: identities.map(row => row.outboxId),
      postgresObserverFingerprint: 'f'.repeat(64), nativeObserverFingerprint: adapter.observerFingerprint }
    return adapter.observeNative({ phase: 'nativeAbsence', observationId: randomUUID(), target, identities,
      candidateFingerprint: nativeEmailDigest({ version: 1, purpose: 'clawpilot-legacy-terminal-hold-preview-target-v1', target }),
    }, signal.signal)
  }
  await check('actual direct DB-wide SELECT grant, physical identity, transaction and stock schema prove exact absence', async () => {
    const output = await observe()
    assert.equal(output.storeFingerprint, nativeDatabaseFingerprint)
    assert.match(output.stockSchemaAbsenceFingerprint, /^[0-9a-f]{64}$/u)
    assert.equal(output.rows.length, 2)
    assert.ok(output.rows.every(row => Object.values(row.counts).every(value => value === 0)))
  })
  await check('actual per-table grants and wildcard schema pattern are not full exact visibility', async () => {
    await assert.rejects(observe('fixture_table_reader'), code('query_rows'))
    await assert.rejects(observe('fixture_pattern_reader'), code('query_rows'))
  })
  await check('deleted case-variant orphan and duplicate Global ID each prevent absence', async () => {
    admin(bind('INSERT INTO emails_beans(email_id,deleted) VALUES(?,1)', [identities[0].nativeId.toUpperCase()]), database)
    await assert.rejects(observe(), code('native_not_absent'))
    admin(bind('DELETE FROM emails_beans WHERE email_id=?', [identities[0].nativeId.toUpperCase()]), database)
    admin(bind('INSERT INTO emails_cstm(id_c,global_id_c) VALUES(?,?)', [uuid(25), identities[1].globalId]), database)
    await assert.rejects(observe(), code('native_not_absent'))
    admin(bind('DELETE FROM emails_cstm WHERE id_c=?', [uuid(25)]), database)
  })
  await check('one present managed table and a completely installed inventory both refuse stock path', async () => {
    const table = name => `CREATE TABLE ${name} (id INT PRIMARY KEY) ENGINE=InnoDB`
    admin(table(managed[0]), database)
    await assert.rejects(observe(), code('not_stock_schema'))
    admin(managed.slice(1).map(table).join(';'), database)
    await assert.rejects(observe(), code('not_stock_schema'))
  })
  console.log(`PASS ${checks} local MariaDB stock observer groups; no production, network listener, managed install or live data`)
} finally {
  process.removeListener('SIGINT', abort)
  process.removeListener('SIGTERM', abort)
  if (server && server.exitCode === null && server.signalCode === null) {
    // ChildProcess ownership is exact. Never signal any discovered process.
    server.kill('SIGTERM')
    await bounded(serverEnded, 8_000)
  }
  const directory = lstatSync(root), ownership = lstatSync(marker)
  assert.ok(directory.isDirectory() && directory.uid === process.geteuid() && realpathSync(root) === root
    && (directory.mode & 0o777) === 0o700 && ownership.isFile() && ownership.uid === process.geteuid()
    && ownership.nlink === 1 && (ownership.mode & 0o777) === 0o600 && readFileSync(marker, 'utf8') === owner,
  'Fixture ownership changed; refusing cleanup')
  rmSync(root, { recursive: true })
}
