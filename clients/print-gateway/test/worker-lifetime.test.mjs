import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter, once } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { WorkerManager } from '../src/lib/worker-manager.mjs'
import {
  assertLegacyMacMigrationComplete,
  legacyMacPrintAgentInstances,
} from '../src/lib/legacy-macos-agent.mjs'

const repositoryRoot = path.resolve(import.meta.dirname, '../../..')
const runtimeCredential = `cpprint.v1.00000000-0000-4000-8000-000000000001.${'A'.repeat(43)}`

test('legacy mac LaunchAgent blocks pairing/start before any worker or printer bytes', () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'clawpilot-legacy-agent-block-'))
  const launchAgents = path.join(temporary, 'Library', 'LaunchAgents')
  const legacyRuntime = path.join(temporary, 'Library', 'Application Support', 'ClawPilot', 'print-agent', 'ag-alchemy')
  mkdirSync(launchAgents, { recursive: true })
  mkdirSync(legacyRuntime, { recursive: true })
  writeFileSync(
    path.join(launchAgents, 'com.clawpilot.print-agent.ag-alchemy.plist'),
    '<plist><dict><key>Label</key><string>com.clawpilot.print-agent.ag-alchemy</string></dict></plist>',
  )
  writeFileSync(
    path.join(legacyRuntime, 'run-local-print-agent.mjs'),
    '// historical fixture intentionally has no kernel endpoint lock or immutable delivery ledger\n',
  )
  const legacy = legacyMacPrintAgentInstances({ platform: 'darwin', homeDirectory: temporary })
  assert.deepEqual(legacy, ['ag-alchemy'])
  let migrationError
  try {
    assertLegacyMacMigrationComplete(legacy)
  } catch (error) {
    migrationError = error
  }
  assert.ok(migrationError instanceof Error)
  assert.match(migrationError.message, /does not share.*duplicate-print fences/i)
  assert.match(migrationError.message, /3\. Stop and uninstall an instance/)
  assert.match(migrationError.message, /retaining its Keychain credential, device key, and delivery ledger for rollback/)
  assert.match(migrationError.message, /same Zebra private LAN IP and port.*no-print connection test.*one controlled UPS sandbox label/i)
  assert.match(migrationError.message, /Do not revoke the old server enrollment until the native app.*acknowledged/i)
  assert.doesNotMatch(migrationError.message, /stop and disable/i)
  const instance = {
    id: '00000000-0000-4000-8000-000000000008',
    slug: 'instance-00000000-0000-4000-8000-000000000008',
    enabled: true,
  }
  let spawns = 0
  const manager = new WorkerManager({
    store: {
      instanceFor: () => instance,
      publicState: () => ({ instances: [instance] }),
      credentialFor: () => runtimeCredential,
    },
    dataDirectory: temporary,
    runtimePath: path.join(repositoryRoot, 'scripts/run-local-print-agent.mjs'),
    sharedLockDirectory: path.join(temporary, 'shared-locks'),
    startGuard: () => assertLegacyMacMigrationComplete(legacy),
    spawnImplementation: () => { spawns += 1 },
  })
  try {
    manager.startEnabled()
    assert.equal(spawns, 0)
    assert.equal(manager.statusFor(instance.id).state, 'stopped')
    assert.match(manager.statusFor(instance.id).lastError, /Legacy Mac print-agent/)
  } finally {
    manager.shutdown()
    rmSync(temporary, { recursive: true, force: true })
  }
})

test('durable cleanup fence survives restart and starts zero workers or claims', async () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'clawpilot-cleanup-start-fence-'))
  const instance = {
    id: '00000000-0000-4000-8000-000000000039',
    slug: 'instance-00000000-0000-4000-8000-000000000039',
    enabled: true,
  }
  const instanceDirectory = path.join(temporary, 'instances', instance.slug)
  mkdirSync(instanceDirectory, { recursive: true })
  writeFileSync(path.join(instanceDirectory, 'claim-ledger.json'), `${JSON.stringify({
    version: 1,
    claims: {},
    deliveries: {},
    pendingResults: {},
    cleanupResolution: {
      version: 1,
      idempotencyKey: 'cleanup:00000000-0000-4000-8000-000000000040',
      entries: [{
        jobGlobalId: 'gpj0000001',
        claimToken: '00000000-0000-4000-8000-000000000041',
        documentGlobalId: 'gpf0000001',
        contentSha256: '4'.repeat(64),
        resolution: 'outcome_uncertain_terminal',
        removalSafe: true,
        reasonCode: 'SERVER_OUTCOME_UNCERTAIN_TERMINAL',
      }],
      resolvedAt: new Date().toISOString(),
    },
  })}\n`)
  let spawns = 0
  let enableWrites = 0
  const manager = new WorkerManager({
    store: {
      instanceFor: () => instance,
      publicState: () => ({ instances: [instance] }),
      credentialFor: () => runtimeCredential,
      setEnabled: () => { enableWrites += 1 },
    },
    dataDirectory: temporary,
    runtimePath: path.join(repositoryRoot, 'scripts/run-local-print-agent.mjs'),
    sharedLockDirectory: path.join(temporary, 'shared-locks'),
    spawnImplementation: () => { spawns += 1 },
  })
  try {
    manager.startEnabled()
    assert.equal(spawns, 0)
    assert.match(manager.statusFor(instance.id).lastError, /removal reconciliation is pending/)
    await assert.rejects(manager.setEnabled(instance.id, true), /removal reconciliation is pending/)
    assert.equal(enableWrites, 0)
    assert.equal(spawns, 0)
  } finally {
    manager.shutdown()
    rmSync(temporary, { recursive: true, force: true })
  }
})

test('worker credential pipe contains fast EPIPE and reports other errors without secrets', async () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'clawpilot-worker-stdin-'))
  const instance = {
    id: '00000000-0000-4000-8000-000000000009',
    displayName: 'Pipe test',
    localName: null,
    slug: 'instance-00000000-0000-4000-8000-000000000009',
    serverAgentGlobalId: 'gpa_pipe_test',
    baseUrl: 'https://aiapp.eigenracing.com',
    printerHost: '192.168.4.146',
    printerPort: 9_100,
    enabled: true,
  }
  const child = new EventEmitter()
  child.pid = 41_001
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = new EventEmitter()
  child.stdin.end = () => {
    queueMicrotask(() => {
      const error = new Error(`broken pipe ${runtimeCredential}`)
      error.code = 'EPIPE'
      child.stdin.emit('error', error)
    })
  }
  const manager = new WorkerManager({
    store: {
      instanceFor: () => instance,
      credentialFor: () => runtimeCredential,
      publicState: () => ({ instances: [instance] }),
    },
    dataDirectory: temporary,
    runtimePath: path.join(repositoryRoot, 'scripts/run-local-print-agent.mjs'),
    executablePath: process.execPath,
    sharedLockDirectory: path.join(temporary, 'shared-locks'),
    spawnImplementation: () => child,
  })
  try {
    manager.start(instance.id)
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    assert.equal(manager.statusFor(instance.id).lastError, null)
    const other = new Error(`credential pipe failed ${runtimeCredential}`)
    other.code = 'EIO'
    child.stdin.emit('error', other)
    assert.match(manager.statusFor(instance.id).lastError, /credential pipe failed \[secret redacted\]/)
    assert.doesNotMatch(manager.statusFor(instance.id).lastError, /cpprint\.v1/)
  } finally {
    manager.shutdown()
    child.emit('exit', 0, null)
    rmSync(temporary, { recursive: true, force: true })
  }
})

function processExists(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    throw error
  }
}

async function waitFor(predicate, message, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
  }
  throw new Error(message)
}

test('stop signals nested worker while lifetime-lock supervisor remains until worker exit', {
  skip: !['darwin', 'linux'].includes(process.platform),
}, async () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'clawpilot-worker-lifetime-'))
  let claims = 0
  const api = http.createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      claims += 1
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, jobs: [] }))
    })
  })
  api.listen(0, '127.0.0.1')
  await once(api, 'listening')
  const instance = {
    id: '00000000-0000-4000-8000-000000000010',
    displayName: 'Worker lifetime test',
    localName: null,
    slug: 'instance-00000000-0000-4000-8000-000000000010',
    serverAgentGlobalId: 'gpa_lifetime_test',
    baseUrl: `http://127.0.0.1:${api.address().port}`,
    printerHost: '127.0.0.1',
    printerPort: 9_100,
    enabled: true,
  }
  const store = {
    instanceFor: (id) => (id === instance.id ? instance : null),
    credentialFor: () => runtimeCredential,
    publicState: () => ({ instances: [instance] }),
  }
  const manager = new WorkerManager({
    store,
    dataDirectory: temporary,
    runtimePath: path.join(repositoryRoot, 'scripts/run-local-print-agent.mjs'),
    executablePath: process.execPath,
    allowLocalDevelopment: true,
    sharedLockDirectory: path.join(temporary, 'shared-locks'),
  })
  try {
    manager.start(instance.id)
    const state = await waitFor(
      () => manager.workers.get(instance.id)?.runtimePid
        ? manager.workers.get(instance.id)
        : null,
      'Nested worker never reported its PID',
    )
    const runtimePid = state.runtimePid
    const supervisorPid = state.child.pid
    assert.equal(processExists(runtimePid), true)
    assert.equal(processExists(supervisorPid), true)
    if (process.platform === 'darwin') {
      assert.notEqual(runtimePid, supervisorPid, 'macOS lockf must be treated as a separate supervisor')
    }
    await waitFor(() => claims >= 1, 'Nested worker never completed its first claim request')
    await manager.stopAndWait(instance.id, 10_000)
    assert.equal(processExists(runtimePid), false)
    assert.equal(processExists(supervisorPid), false)
    assert.ok(claims >= 1)
  } finally {
    manager.shutdown()
    api.close()
    await once(api, 'close')
    rmSync(temporary, { recursive: true, force: true })
  }
})

test('two app generations sharing one instance allow exactly one raw delivery', {
  skip: !['darwin', 'linux'].includes(process.platform),
}, async () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'clawpilot-worker-overlap-'))
  const zpl = '^XA^FO20,20^FDOne lifetime owner^FS^XZ'
  const printerBytes = []
  const printer = net.createServer((socket) => {
    socket.on('data', (chunk) => printerBytes.push(chunk))
  })
  printer.listen(0, '127.0.0.1')
  await once(printer, 'listening')
  let claims = 0
  let acknowledgements = 0
  let releaseFirstClaim
  const firstClaimGate = new Promise((resolvePromise) => { releaseFirstClaim = resolvePromise })
  const api = http.createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', async () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (body.action === 'claim') {
        claims += 1
        if (claims === 1) await firstClaimGate
      }
      if (body.action === 'acknowledge') acknowledgements += 1
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body.action === 'claim' && acknowledgements === 0 ? {
        ok: true,
        jobs: [{
          globalId: 'gpj-lifetime-one',
          claimToken: 'claim-lifetime-one',
          serverNow: new Date().toISOString(),
          claimExpiresAt: new Date(Date.now() + 120_000).toISOString(),
          printer: { globalId: 'gpr-lifetime-one' },
          document: {
            globalId: 'gpd-lifetime-one',
            type: 'shipping_label',
            format: 'ZPL',
            encoding: 'utf8',
            media: 'label_4x6',
            inlinePayload: zpl,
            byteLength: Buffer.byteLength(zpl),
            contentSha256: createHash('sha256').update(zpl).digest('hex'),
          },
        }],
      } : { ok: true, jobs: [] }))
    })
  })
  api.listen(0, '127.0.0.1')
  await once(api, 'listening')
  const instance = {
    id: '00000000-0000-4000-8000-000000000011',
    displayName: 'Overlap test',
    localName: null,
    slug: 'instance-00000000-0000-4000-8000-000000000011',
    serverAgentGlobalId: 'gpa_overlap_test',
    baseUrl: `http://127.0.0.1:${api.address().port}`,
    printerHost: '127.0.0.1',
    printerPort: printer.address().port,
    enabled: true,
  }
  const store = {
    instanceFor: (id) => (id === instance.id ? instance : null),
    credentialFor: () => runtimeCredential,
    publicState: () => ({ instances: [instance] }),
  }
  const managerInput = {
    store,
    dataDirectory: temporary,
    runtimePath: path.join(repositoryRoot, 'scripts/run-local-print-agent.mjs'),
    executablePath: process.execPath,
    allowLocalDevelopment: true,
    sharedLockDirectory: path.join(temporary, 'shared-locks'),
  }
  const first = new WorkerManager(managerInput)
  const second = new WorkerManager(managerInput)
  try {
    first.start(instance.id)
    await waitFor(() => claims === 1, 'First generation never reached claim')
    second.start(instance.id)
    await waitFor(
      () => /Another ClawPilot process/.test(second.statusFor(instance.id).lastError || ''),
      'Second generation did not fail closed on the lifetime lock',
    )
    assert.equal(claims, 1)
    releaseFirstClaim()
    await waitFor(() => acknowledgements === 1, 'First generation never acknowledged delivery')
    await first.stopAndWait(instance.id, 10_000)
    await second.stopAndWait(instance.id, 10_000)
    assert.equal(Buffer.concat(printerBytes).toString('utf8'), zpl)
    assert.equal(acknowledgements, 1)
  } finally {
    releaseFirstClaim()
    first.shutdown()
    second.shutdown()
    api.close()
    printer.close()
    await Promise.all([once(api, 'close'), once(printer, 'close')])
    rmSync(temporary, { recursive: true, force: true })
  }
})
