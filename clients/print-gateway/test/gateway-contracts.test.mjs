import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  normalizedPrintAgentIdentity,
  assertPrintAgentPairingRecovery,
  createPrintAgentPairingRecovery,
  printAgentPairingCodeHash,
  redeemPrintAgentPairingGrant,
} from '../../../scripts/lib/print-agent-pairing-credential.mjs'
import { pairGatewayInstance } from '../src/lib/pair-instance.mjs'
import {
  abandonInstanceCleanupRequest,
  archiveResolvedInstance,
  assertInstanceLedgerCanBeRemoved,
  commitInstanceCleanupResolution,
  instanceCleanupEntries,
  prepareInstanceCleanupRequest,
  readInstanceCleanupResolution,
} from '../src/lib/instance-removal.mjs'
import {
  assertCleanupStatusRemovalSafe,
  requestInstanceCleanupStatus,
} from '../src/lib/cleanup-status.mjs'
import { normalizedLoginItemStatus } from '../src/lib/login-item-status.mjs'
import {
  assertStableGatewayInstall,
  gatewayInstallLocationStatus,
} from '../src/lib/install-location.mjs'
import {
  assertTrustedRendererIpc,
  rendererNavigationIsTrusted,
} from '../src/lib/renderer-security.mjs'
import { runProtectedGatewayStartup } from '../src/lib/startup-guard.mjs'
import { GatewayStateStore } from '../src/lib/state-store.mjs'
import { probeRawPrinter } from '../src/lib/printer-probe.mjs'
import {
  assertPairingGrant,
  normalizeBaseUrl,
  normalizePrinterHost,
  normalizedPairingInput,
} from '../src/lib/validation.mjs'

const repositoryRoot = path.resolve(import.meta.dirname, '../../..')
const runtimeCredentialFor = (id, character = 'A') => `cpprint.v1.${id}.${character.repeat(43)}`
const runtimeCredential = runtimeCredentialFor('00000000-0000-4000-8000-000000000003')
const pairingCode = `cppair.v1.00000000-0000-4000-8000-000000000002.${'B'.repeat(43)}`
const pairingVector = JSON.parse(readFileSync(
  path.join(import.meta.dirname, 'pairing-v2-vector.json'),
  'utf8',
))
const serverAgent = Object.freeze({
  id: '00000000-0000-4000-8000-000000000003',
  globalId: 'gpa_test_agent_001',
  name: 'Warehouse A Zebra Agent',
  warehouseId: '00000000-0000-4000-8000-000000000005',
  warehouseGlobalId: 'gwh_test_warehouse_001',
  warehouseName: 'Warehouse A',
})

function safeStorageMock() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`protected:${Buffer.from(value).toString('base64')}`),
    decryptString: (value) => {
      const protectedValue = value.toString()
      if (!protectedValue.startsWith('protected:')) {
        throw new Error('protected value failed authentication')
      }
      return Buffer.from(
        protectedValue.slice('protected:'.length),
        'base64',
      ).toString('utf8')
    },
  }
}

function instanceInput(overrides = {}) {
  return {
    baseUrl: 'https://aiapp.eigenracing.com',
    displayName: serverAgent.name,
    localName: 'Packing station Mac',
    serverAgentId: serverAgent.id,
    serverAgentGlobalId: serverAgent.globalId,
    serverAgentName: serverAgent.name,
    warehouseId: serverAgent.warehouseId,
    warehouseGlobalId: serverAgent.warehouseGlobalId,
    warehouseName: serverAgent.warehouseName,
    printerHost: '192.168.4.146',
    printerPort: 9_100,
    ...overrides,
  }
}

function spawnWorker({
  apiUrl,
  temporary,
  printerHost = '127.0.0.1',
  printerPort = 9_100,
  ledgerPath = path.join(temporary, 'ledger.json'),
}) {
  const child = spawn(process.execPath, [
    path.join(repositoryRoot, 'scripts/run-local-print-agent.mjs'),
    '--once',
  ], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      CLAWPILOT_GATEWAY_TEST_MODE: '1',
      CLAWPILOT_PRINT_AGENT_ALLOW_LOOPBACK: '1',
      CLAWPILOT_PRINT_AGENT_URL: apiUrl,
      CLAWPILOT_PRINT_AGENT_CREDENTIAL_FD: '3',
      CLAWPILOT_PRINTER_HOST: printerHost,
      CLAWPILOT_PRINTER_PORT: String(printerPort),
      CLAWPILOT_PRINT_AGENT_LEDGER: ledgerPath,
      CLAWPILOT_PRINT_AGENT_DEVICE_KEY: path.join(temporary, 'device.key'),
      CLAWPILOT_PRINT_AGENT_DEVICE_LOCK_DIRECTORY: path.join(temporary, 'locks'),
    },
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
  })
  const stdout = []
  const stderr = []
  child.stdout.on('data', (chunk) => stdout.push(chunk))
  child.stderr.on('data', (chunk) => stderr.push(chunk))
  child.stdio[3].end(`${runtimeCredential}\n`)
  return {
    child,
    stdout,
    stderr,
    async outcome() {
      const [code] = await once(child, 'exit')
      return {
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      }
    },
  }
}

test('pairing accepts only exact trusted origins and literal private LAN IPv4', () => {
  assert.equal(
    normalizeBaseUrl('https://aiapp.eigenracing.com/'),
    'https://aiapp.eigenracing.com',
  )
  assert.equal(
    normalizeBaseUrl('https://dev.aiapp.eigenracing.com'),
    'https://dev.aiapp.eigenracing.com',
  )
  assert.equal(
    normalizeBaseUrl('http://localhost:4002', { allowLocalDevelopment: true }),
    'http://localhost:4002',
  )
  for (const value of [
    'https://evil.example',
    'https://evil.aiapp.eigenracing.com',
    'https://aiapp.eigenracing.com.evil.example',
    'https://user@aiapp.eigenracing.com',
    'https://aiapp.eigenracing.com:443',
    'https://aiapp.eigenracing.com/path',
    'http://aiapp.eigenracing.com',
    'https://aıapp.eigenracing.com',
    'http://localhost:4002',
  ]) assert.throws(() => normalizeBaseUrl(value), /trusted|deployment|origin|port/)

  for (const value of ['10.1.2.3', '172.16.0.1', '172.31.255.254', '192.168.4.146', '169.254.5.6']) {
    assert.equal(normalizePrinterHost(value), value)
  }
  for (const value of [
    '8.8.8.8',
    '127.0.0.1',
    '0.0.0.0',
    '224.0.0.1',
    'printer.local',
    '::ffff:192.168.1.4',
    '0xc0.0xa8.0x01.0x04',
    '0300.0250.0001.0004',
    '192.168.001.004',
  ]) assert.throws(() => normalizePrinterHost(value), /literal|private/)
  assert.equal(
    normalizePrinterHost('127.0.0.1', { allowLocalDevelopment: true }),
    '127.0.0.1',
  )
  assert.equal(assertPairingGrant(pairingCode), pairingCode)
  assert.throws(() => assertPairingGrant(runtimeCredential), /cppair/)
  assert.deepEqual(normalizedPairingInput({
    baseUrl: 'https://aiapp.eigenracing.com',
    instanceName: 'Packing station Mac',
    printerHost: ' 192.168.4.146 ',
    printerPort: '9100',
    pairingCode,
  }), {
    baseUrl: 'https://aiapp.eigenracing.com',
    localName: 'Packing station Mac',
    printerHost: '192.168.4.146',
    printerPort: 9_100,
    pairingCode,
  })
})

test('platform-neutral v2 helper decrypts the frozen server interoperability vector', async () => {
  let captured
  const vectorRecovery = {
    schemaVersion: 2,
    installationId: pairingVector.request.installationId,
    clientPublicKey: pairingVector.request.clientPublicKey,
    clientKeyFingerprint: pairingVector.request.clientKeyFingerprint,
    privateKeyPkcs8: pairingVector.clientPrivateKeyPkcs8,
    idempotencyKey: pairingVector.idempotencyKey,
    pairingCodeHash: printAgentPairingCodeHash(pairingVector.request.pairingCode),
  }
  assert.deepEqual(
    assertPrintAgentPairingRecovery(vectorRecovery, pairingVector.request.pairingCode),
    vectorRecovery,
  )
  const enrollment = await redeemPrintAgentPairingGrant({
    baseUrl: 'https://aiapp.eigenracing.com',
    pairingCode: pairingVector.request.pairingCode,
    recovery: vectorRecovery,
    async fetchImplementation(url, options) {
      captured = {
        url: String(url),
        redirect: options.redirect,
        headers: options.headers,
        body: JSON.parse(options.body),
      }
      return new Response(JSON.stringify({ ok: true, ...pairingVector.response }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  })
  assert.deepEqual(enrollment, {
    credential: pairingVector.expected.credential,
    agent: pairingVector.expected.agent,
    replayed: false,
    recoveryExpiresAt: pairingVector.response.recoveryExpiresAt,
  })
  assert.equal(
    captured.url,
    'https://aiapp.eigenracing.com/api/operations/print-agent/pair',
  )
  assert.equal(captured.redirect, 'error')
  assert.equal(captured.headers['idempotency-key'], pairingVector.idempotencyKey)
  assert.deepEqual(captured.body, pairingVector.request)
  assert.doesNotMatch(JSON.stringify(captured), /192\.168\.|printerHost|printerPort/)
  assert.throws(
    () => normalizedPrintAgentIdentity({ ...pairingVector.expected.agent, globalId: '../../agent' }),
    /global identity/,
  )
})

test('generated recovery self-validates and ambiguous/truncated responses reuse it', async () => {
  const recovery = createPrintAgentPairingRecovery(pairingCode)
  assert.deepEqual(assertPrintAgentPairingRecovery(recovery, pairingCode), recovery)
  assert.throws(
    () => assertPrintAgentPairingRecovery({
      ...recovery,
      clientKeyFingerprint: `${recovery.clientKeyFingerprint.startsWith('A') ? 'B' : 'A'}${recovery.clientKeyFingerprint.slice(1)}`,
    }, pairingCode),
    /fingerprint|public key/,
  )
  const mismatchedPrivate = createPrintAgentPairingRecovery(pairingCode)
  let mismatchedFetches = 0
  await assert.rejects(
    redeemPrintAgentPairingGrant({
      baseUrl: 'https://aiapp.eigenracing.com',
      pairingCode,
      recovery: {
        ...recovery,
        privateKeyPkcs8: mismatchedPrivate.privateKeyPkcs8,
      },
      async fetchImplementation() {
        mismatchedFetches += 1
        throw new Error('must not fetch')
      },
    }),
    /keypair does not match/,
  )
  assert.equal(mismatchedFetches, 0)
  await assert.rejects(
    redeemPrintAgentPairingGrant({
      baseUrl: 'https://aiapp.eigenracing.com',
      pairingCode,
      recovery,
      async fetchImplementation() {
        throw new Error('socket closed after POST')
      },
    }),
    (error) => error.outcomeUnknown === true && error.retryableRecovery === true,
  )
  await assert.rejects(
    redeemPrintAgentPairingGrant({
      baseUrl: 'https://aiapp.eigenracing.com',
      pairingCode,
      recovery,
      async fetchImplementation() {
        return new Response('{"ok":true,"schemaVersion":', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      },
    }),
    (error) => error.outcomeUnknown === true && error.retryableRecovery === true,
  )

  const calls = []
  await assert.rejects(
    pairGatewayInstance({
      input: {
        baseUrl: 'https://aiapp.eigenracing.com',
        printerHost: '192.168.4.146',
        printerPort: '9100',
        pairingCode,
      },
      store: {
        preflightPairingPersistence() { calls.push('preflight') },
        preparePairingRecovery() {
          calls.push('prepare')
          return { phase: 'prepared', recovery }
        },
        markPairingRecoveryRequestSent() { calls.push('mark') },
        createInstance() { calls.push('create') },
      },
      createRecovery: () => recovery,
      pairingCodeHash: () => recovery.pairingCodeHash,
      async probe() { calls.push('probe') },
      async redeem() {
        calls.push('redeem')
        const error = new Error('response lost')
        error.outcomeUnknown = true
        error.retryableRecovery = true
        throw error
      },
    }),
    /Keep this exact pairing code.*same encrypted installation key/i,
  )
  assert.deepEqual(calls, ['preflight', 'prepare', 'probe', 'mark', 'redeem'])
})

test('request-sent pairing survives restart and commits the exact recovered enrollment atomically', async () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'clawpilot-gateway-pair-restart-'))
  const secureStorage = safeStorageMock()
  const vectorRecovery = {
    schemaVersion: 2,
    installationId: pairingVector.request.installationId,
    clientPublicKey: pairingVector.request.clientPublicKey,
    clientKeyFingerprint: pairingVector.request.clientKeyFingerprint,
    privateKeyPkcs8: pairingVector.clientPrivateKeyPkcs8,
    idempotencyKey: pairingVector.idempotencyKey,
    pairingCodeHash: printAgentPairingCodeHash(pairingVector.request.pairingCode),
  }
  const input = {
    baseUrl: 'https://aiapp.eigenracing.com',
    instanceName: 'Restart recovery station',
    printerHost: '192.168.4.146',
    printerPort: '9100',
    pairingCode: pairingVector.request.pairingCode,
  }
  const observedRequests = []
  const sequence = []
  try {
    const initialStore = new GatewayStateStore({
      dataDirectory: temporary,
      safeStorage: secureStorage,
    })
    await assert.rejects(pairGatewayInstance({
      input,
      store: initialStore,
      createRecovery: () => vectorRecovery,
      pairingCodeHash: printAgentPairingCodeHash,
      async probe() { sequence.push('initial-probe') },
      redeem: (pairing, recovery) => redeemPrintAgentPairingGrant({
        baseUrl: pairing.baseUrl,
        pairingCode: pairing.pairingCode,
        recovery,
        async fetchImplementation(_url, options) {
          sequence.push('initial-redeem')
          const rawState = readFileSync(initialStore.statePath, 'utf8')
          const persisted = JSON.parse(rawState)
          assert.equal(persisted.pendingPairings.length, 1)
          assert.equal(initialStore.pendingRecoveryFor(persisted.pendingPairings[0]).phase, 'request_sent')
          for (const secret of [
            pairingVector.request.pairingCode,
            vectorRecovery.privateKeyPkcs8,
            pairingVector.expected.credential,
          ]) assert.equal(rawState.includes(secret), false)
          observedRequests.push({
            headers: options.headers,
            body: JSON.parse(options.body),
          })
          return new Response('{"ok":true,"schemaVersion":', { status: 200 })
        },
      }),
    }), /Keep this exact pairing code.*same encrypted installation key/i)

    const restartedStore = new GatewayStateStore({
      dataDirectory: temporary,
      safeStorage: secureStorage,
    })
    const recovered = await pairGatewayInstance({
      input,
      store: restartedStore,
      createRecovery: () => assert.fail('restart must reuse the protected pending key'),
      pairingCodeHash: printAgentPairingCodeHash,
      async probe() {
        sequence.push('recovery-probe')
        throw new Error('printer is temporarily offline')
      },
      redeem: (pairing, recovery) => redeemPrintAgentPairingGrant({
        baseUrl: pairing.baseUrl,
        pairingCode: pairing.pairingCode,
        recovery,
        async fetchImplementation(_url, options) {
          sequence.push('recovery-redeem')
          observedRequests.push({
            headers: options.headers,
            body: JSON.parse(options.body),
          })
          return new Response(JSON.stringify({
            ok: true,
            ...pairingVector.response,
            replayed: true,
          }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        },
      }),
    })
    assert.equal(recovered.enabled, false)
    assert.match(recovered.pairingWarning, /recovered safely.*not reachable/i)
    assert.deepEqual(sequence, [
      'initial-probe',
      'initial-redeem',
      'recovery-redeem',
      'recovery-probe',
    ])
    assert.equal(observedRequests.length, 2)
    assert.deepEqual(observedRequests[0], observedRequests[1])
    assert.deepEqual(observedRequests[0].body, pairingVector.request)
    assert.equal(observedRequests[0].headers['idempotency-key'], pairingVector.idempotencyKey)
    const finalStateText = readFileSync(restartedStore.statePath, 'utf8')
    const finalState = JSON.parse(finalStateText)
    assert.equal(finalState.pendingPairings.length, 0)
    assert.equal(finalState.instances.length, 1)
    assert.equal(finalState.instances[0].enabled, false)
    assert.equal(finalStateText.includes(pairingVector.expected.credential), false)
    assert.equal(restartedStore.credentialFor(recovered.id), pairingVector.expected.credential)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
})

test('encrypted state binds credential, routing, and authoritative server identity', () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'clawpilot-gateway-store-'))
  const statePath = path.join(temporary, 'gateway-state.v3.json')
  const secureStorage = safeStorageMock()
  try {
    const store = new GatewayStateStore({
      dataDirectory: temporary,
      safeStorage: secureStorage,
    })
    const recovery = createPrintAgentPairingRecovery(pairingCode)
    const prepared = store.preparePairingRecovery({
      baseUrl: 'https://aiapp.eigenracing.com',
      pairingCodeHash: recovery.pairingCodeHash,
      createRecovery: () => recovery,
    })
    assert.deepEqual(prepared, { phase: 'prepared', recovery })
    const recoveredAfterRestart = new GatewayStateStore({
      dataDirectory: temporary,
      safeStorage: secureStorage,
    }).preparePairingRecovery({
      baseUrl: 'https://aiapp.eigenracing.com',
      pairingCodeHash: recovery.pairingCodeHash,
      createRecovery: () => assert.fail('must reuse the durable recovery key'),
    })
    assert.deepEqual(recoveredAfterRestart, { phase: 'prepared', recovery })

    const instance = store.createInstance(instanceInput(), runtimeCredential, {
      completedPairingCodeHash: recovery.pairingCodeHash,
    })
    assert.equal(instance.displayName, serverAgent.name)
    assert.equal(instance.serverAgentGlobalId, serverAgent.globalId)
    assert.equal(instance.serverAgentId, undefined)
    assert.equal(store.credentialFor(instance.id), runtimeCredential)
    const stateBytes = readFileSync(statePath, 'utf8')
    assert.doesNotMatch(
      stateBytes,
      /cpprint\.v1|192\.168\.4\.146|aiapp\.eigenracing\.com|Warehouse A|privateKeyPkcs8/,
    )
    const original = JSON.parse(stateBytes)
    assert.deepEqual(original.pendingPairings, [])
    assert.match(
      Buffer.from(original.instances[0].encryptedEnvelope, 'base64').toString(),
      /^protected:/,
    )

    const restarted = new GatewayStateStore({
      dataDirectory: temporary,
      safeStorage: secureStorage,
    })
    assert.equal(restarted.credentialFor(instance.id), runtimeCredential)
    const secondAgent = {
      ...serverAgent,
      id: '00000000-0000-4000-8000-000000000004',
      globalId: 'gpa_test_agent_002',
      name: 'Warehouse A Second Agent',
    }
    const second = restarted.createInstance(instanceInput({
      displayName: secondAgent.name,
      localName: null,
      serverAgentId: secondAgent.id,
      serverAgentGlobalId: secondAgent.globalId,
      serverAgentName: secondAgent.name,
    }), runtimeCredentialFor(secondAgent.id, 'C'))
    assert.equal(second.printerHost, instance.printerHost)
    assert.throws(
      () => restarted.createInstance(instanceInput({ localName: null }), runtimeCredential),
      /already exists/,
    )

    for (const mutation of [
      (stored) => { stored.instances.push(structuredClone(stored.instances[0])) },
      (stored) => {
        const protectedBytes = Buffer.from(stored.instances[0].encryptedEnvelope, 'base64')
        const envelope = JSON.parse(secureStorage.decryptString(protectedBytes))
        envelope.slug = '../../escape'
        stored.instances[0].encryptedEnvelope = secureStorage
          .encryptString(JSON.stringify(envelope)).toString('base64')
      },
      (stored) => {
        const protectedBytes = Buffer.from(stored.instances[0].encryptedEnvelope, 'base64')
        const envelope = JSON.parse(secureStorage.decryptString(protectedBytes))
        envelope.serverAgentId = '00000000-0000-4000-8000-000000000099'
        stored.instances[0].encryptedEnvelope = secureStorage
          .encryptString(JSON.stringify(envelope)).toString('base64')
      },
      (stored) => {
        stored.instances[0].encryptedEnvelope = `A${stored.instances[0].encryptedEnvelope.slice(1)}`
      },
    ]) {
      const tampered = structuredClone(original)
      mutation(tampered)
      writeFileSync(statePath, `${JSON.stringify(tampered)}\n`)
      assert.throws(() => new GatewayStateStore({
        dataDirectory: temporary,
        safeStorage: secureStorage,
      }), /security validation|duplicate protected identities|could not be verified/)
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
})

test('unpackaged local-development state survives restart but remains opt-in', () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'clawpilot-gateway-local-store-'))
  try {
    const input = instanceInput({
      baseUrl: 'http://localhost:4002',
      printerHost: '127.0.0.1',
    })
    const store = new GatewayStateStore({
      dataDirectory: temporary,
      safeStorage: safeStorageMock(),
      allowLocalDevelopment: true,
    })
    const instance = store.createInstance(input, runtimeCredential)
    const restarted = new GatewayStateStore({
      dataDirectory: temporary,
      safeStorage: safeStorageMock(),
      allowLocalDevelopment: true,
    })
    assert.equal(restarted.credentialFor(instance.id), runtimeCredential)
    assert.throws(() => new GatewayStateStore({
      dataDirectory: temporary,
      safeStorage: safeStorageMock(),
    }), /trusted|private/)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
})

test('post-response state failure reuses exact recovery key and commits atomically on retry', async () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'clawpilot-gateway-write-fail-'))
  try {
    const store = new GatewayStateStore({
      dataDirectory: temporary,
      safeStorage: safeStorageMock(),
    })
    const recovery = createPrintAgentPairingRecovery(pairingCode)
    store.preparePairingRecovery({
      baseUrl: 'https://aiapp.eigenracing.com',
      pairingCodeHash: recovery.pairingCodeHash,
      createRecovery: () => recovery,
    })
    store.markPairingRecoveryRequestSent(recovery.pairingCodeHash)
    const originalWrite = store.write.bind(store)
    store.write = () => {
      const error = new Error('disk full after verified response')
      error.code = 'ENOSPC'
      throw error
    }
    const observedRecoveries = []
    const input = {
      baseUrl: 'https://aiapp.eigenracing.com',
      instanceName: '',
      printerHost: '192.168.4.146',
      printerPort: 9_100,
      pairingCode,
    }
    const dependencies = {
      input,
      store,
      createRecovery: () => assert.fail('must reuse durable pending recovery'),
      pairingCodeHash: printAgentPairingCodeHash,
      async probe() {},
      async redeem(_pairing, recovered) {
        observedRecoveries.push(structuredClone(recovered))
        return { credential: runtimeCredential, agent: serverAgent }
      },
    }
    await assert.rejects(pairGatewayInstance({
      ...dependencies,
    }), /retry the exact same pairing code.*same credential/i)
    assert.equal(store.publicState().instances.length, 0)
    store.write = originalWrite
    const instance = await pairGatewayInstance({ ...dependencies })
    assert.equal(instance.serverAgentGlobalId, serverAgent.globalId)
    assert.deepEqual(observedRecoveries, [recovery, recovery])
    const state = JSON.parse(readFileSync(store.statePath, 'utf8'))
    assert.deepEqual(state.pendingPairings, [])
    assert.equal(state.instances.length, 1)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
})

test('local removal preserves every unconfirmed ACK or fail replay', () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'clawpilot-gateway-remove-ledger-'))
  const instanceDirectory = path.join(temporary, 'instance')
  const ledgerPath = path.join(instanceDirectory, 'claim-ledger.json')
  mkdirSync(instanceDirectory, { recursive: true })
  const terminal = {
    version: 1,
    claims: {
      'job:claim': { state: 'delivery_failed', serverResultConfirmed: true },
    },
    deliveries: {
      delivery: { state: 'delivery_failed', serverResultConfirmed: true },
    },
    pendingResults: {},
  }
  try {
    writeFileSync(ledgerPath, `${JSON.stringify({
      ...terminal,
      pendingResults: {
        'fail:job:claim': {
          action: 'fail',
          jobGlobalId: 'job',
        },
      },
    })}\n`)
    assert.throws(
      () => assertInstanceLedgerCanBeRemoved(instanceDirectory),
      /unconfirmed server result/,
    )
    const { pendingResults: _omitted, ...missingPendingResults } = terminal
    writeFileSync(ledgerPath, `${JSON.stringify(missingPendingResults)}\n`)
    assert.throws(
      () => assertInstanceLedgerCanBeRemoved(instanceDirectory),
      /delivery-result history is invalid/,
    )
    writeFileSync(ledgerPath, `${JSON.stringify(terminal)}\n`)
    assert.doesNotThrow(() => assertInstanceLedgerCanBeRemoved(instanceDirectory))
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
})

test('cleanup replay is durable, gets a fresh key after unsafe evidence, and archives exact terminal proof', async () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'clawpilot-gateway-cleanup-proof-'))
  const slug = 'instance-00000000-0000-4000-8000-000000000031'
  const instanceDirectory = path.join(temporary, 'instances', slug)
  const artifacts = [
    {
      jobGlobalId: 'gpj0000001',
      claimToken: '00000000-0000-4000-8000-000000000032',
      documentGlobalId: 'gpf0000001',
      contentSha256: '1'.repeat(64),
    },
    {
      jobGlobalId: 'gpj0000002',
      claimToken: '00000000-0000-4000-8000-000000000033',
      documentGlobalId: 'gpf0000002',
      contentSha256: '2'.repeat(64),
    },
    {
      jobGlobalId: 'gpj0000003',
      claimToken: '00000000-0000-4000-8000-000000000034',
      documentGlobalId: 'gpf0000003',
      contentSha256: '3'.repeat(64),
    },
  ]
  const [delivered, zeroByte, uncertain] = artifacts
  mkdirSync(instanceDirectory, { recursive: true })
  writeFileSync(path.join(instanceDirectory, 'claim-ledger.json'), `${JSON.stringify({
    version: 1,
    claims: Object.fromEntries(artifacts.map((artifact) => [
      `${artifact.jobGlobalId}:${artifact.claimToken}`,
      {
        ...artifact,
        state: artifact === zeroByte ? 'delivery_failed' : 'sending',
        serverResultConfirmed: false,
      },
    ])),
    deliveries: Object.fromEntries(artifacts.map((artifact) => [
      `${artifact.jobGlobalId}:${artifact.documentGlobalId}:${artifact.contentSha256}`,
      {
        ...artifact,
        state: artifact === zeroByte ? 'delivery_failed' : 'sending',
        serverResultConfirmed: false,
      },
    ])),
    pendingResults: {
      [`fail:${zeroByte.jobGlobalId}:${zeroByte.claimToken}`]: {
        action: 'fail',
        ...zeroByte,
      },
      [`fail:${uncertain.jobGlobalId}:${uncertain.claimToken}`]: {
        action: 'fail',
        ...uncertain,
      },
    },
  })}\n`)
  const responseFor = (entries) => new Response(JSON.stringify({ ok: true, entries }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
  const safeResults = [
    {
      resolution: 'delivered',
      removalSafe: true,
      reasonCode: 'SERVER_DELIVERY_CONFIRMED',
    },
    {
      resolution: 'failed_zero_byte_confirmed',
      removalSafe: true,
      reasonCode: 'SERVER_ZERO_BYTE_FAILURE_CONFIRMED',
    },
    {
      resolution: 'outcome_uncertain_terminal',
      removalSafe: true,
      reasonCode: 'SERVER_OUTCOME_UNCERTAIN_TERMINAL',
    },
  ]
  try {
    assert.deepEqual(instanceCleanupEntries(instanceDirectory), artifacts)
    const firstRequest = prepareInstanceCleanupRequest(instanceDirectory)
    assert.deepEqual(firstRequest.entries, artifacts)
    assert.match(firstRequest.idempotencyKey, /^cleanup:/)
    const rawPreparedLedger = readFileSync(
      path.join(instanceDirectory, 'claim-ledger.json'),
      'utf8',
    )
    assert.match(rawPreparedLedger, new RegExp(firstRequest.idempotencyKey))
    assert.doesNotMatch(rawPreparedLedger, /cpprint|cppair|privateKey/i)

    await assert.rejects(requestInstanceCleanupStatus({
      baseUrl: 'https://aiapp.eigenracing.com',
      runtimeCredential,
      entries: firstRequest.entries,
      idempotencyKey: firstRequest.idempotencyKey,
      fetchImplementation: async () => { throw new Error('response lost') },
    }), /retry this exact request/)
    assert.deepEqual(prepareInstanceCleanupRequest(instanceDirectory), firstRequest)

    await assert.rejects(requestInstanceCleanupStatus({
      baseUrl: 'https://aiapp.eigenracing.com',
      runtimeCredential,
      entries: firstRequest.entries,
      idempotencyKey: firstRequest.idempotencyKey,
      fetchImplementation: async () => new Response('{"ok":true,"entries":', { status: 200 }),
    }), /invalid cleanup evidence/)
    assert.deepEqual(prepareInstanceCleanupRequest(instanceDirectory), firstRequest)

    const unsafeStatus = await requestInstanceCleanupStatus({
      baseUrl: 'https://aiapp.eigenracing.com',
      runtimeCredential,
      entries: firstRequest.entries,
      idempotencyKey: firstRequest.idempotencyKey,
      fetchImplementation: async () => responseFor([
        safeResults[0],
        {
          resolution: 'in_flight',
          removalSafe: false,
          reasonCode: 'SERVER_CLAIM_IN_FLIGHT',
        },
        safeResults[2],
      ]),
    })
    assert.throws(() => assertCleanupStatusRemovalSafe(unsafeStatus), /active exact print claim/)
    abandonInstanceCleanupRequest(instanceDirectory, firstRequest.idempotencyKey)
    const secondRequest = prepareInstanceCleanupRequest(instanceDirectory)
    assert.notEqual(secondRequest.idempotencyKey, firstRequest.idempotencyKey)
    assert.deepEqual(secondRequest.entries, firstRequest.entries)

    await assert.rejects(requestInstanceCleanupStatus({
      baseUrl: 'https://aiapp.eigenracing.com',
      runtimeCredential,
      entries: secondRequest.entries,
      idempotencyKey: secondRequest.idempotencyKey,
      fetchImplementation: async () => responseFor([
        safeResults[0],
        {
          ...safeResults[1],
          reasonCode: 'SERVER_OUTCOME_UNCERTAIN_TERMINAL',
        },
        safeResults[2],
      ]),
    }), /contradictory cleanup evidence/)
    assert.deepEqual(prepareInstanceCleanupRequest(instanceDirectory), secondRequest)

    const observedRequests = []
    const requestCleanup = async () => requestInstanceCleanupStatus({
      baseUrl: 'https://aiapp.eigenracing.com',
      runtimeCredential,
      entries: secondRequest.entries,
      idempotencyKey: secondRequest.idempotencyKey,
      fetchImplementation: async (url, options) => {
        observedRequests.push({
          url,
          body: options.body,
          key: options.headers['idempotency-key'],
          credential: options.headers.authorization,
          redirect: options.redirect,
        })
        return responseFor(safeResults)
      },
    })
    // Treat this as a crash after the safe server response but before its local
    // commit: a restarted app must replay byte-for-byte with the retained key.
    await requestCleanup()
    assert.deepEqual(prepareInstanceCleanupRequest(instanceDirectory), secondRequest)
    const cleanupStatus = await requestCleanup()
    assert.deepEqual(observedRequests[0], observedRequests[1])
    assert.equal(observedRequests[0].url, 'https://aiapp.eigenracing.com/api/operations/print-agent/cleanup-status')
    assert.equal(observedRequests[0].redirect, 'error')
    assert.equal(observedRequests[0].key, secondRequest.idempotencyKey)
    assert.equal(observedRequests[0].credential, `Bearer ${runtimeCredential}`)
    assert.deepEqual(JSON.parse(observedRequests[0].body), { entries: artifacts })
    assert.deepEqual(Object.keys(JSON.parse(observedRequests[0].body)), ['entries'])
    assertCleanupStatusRemovalSafe(cleanupStatus)

    const committed = commitInstanceCleanupResolution(instanceDirectory, cleanupStatus)
    assert.doesNotThrow(() => assertInstanceLedgerCanBeRemoved(instanceDirectory))
    assert.deepEqual(readInstanceCleanupResolution(instanceDirectory), committed)
    const reconciledLedger = JSON.parse(readFileSync(
      path.join(instanceDirectory, 'claim-ledger.json'),
      'utf8',
    ))
    assert.equal(reconciledLedger.cleanupRequest, undefined)
    assert.deepEqual(reconciledLedger.pendingResults, {})
    assert.equal(reconciledLedger.claims[`${delivered.jobGlobalId}:${delivered.claimToken}`].state, 'acknowledged')
    assert.equal(reconciledLedger.claims[`${zeroByte.jobGlobalId}:${zeroByte.claimToken}`].state, 'delivery_failed')
    assert.equal(reconciledLedger.claims[`${zeroByte.jobGlobalId}:${zeroByte.claimToken}`].acceptedBytes, 0)
    assert.equal(reconciledLedger.claims[`${uncertain.jobGlobalId}:${uncertain.claimToken}`].state, 'outcome_uncertain')

    // Treat this as a restart after the atomic commit but before archive/removal.
    const recoveredProof = readInstanceCleanupResolution(instanceDirectory)
    const archive = archiveResolvedInstance({
      dataDirectory: temporary,
      slug,
      cleanupStatus: recoveredProof,
    })
    assert.deepEqual(readdirSync(archive).sort(), [
      'claim-ledger.json',
      'server-cleanup-proof.json',
    ])
    const proof = JSON.parse(readFileSync(path.join(archive, 'server-cleanup-proof.json'), 'utf8'))
    assert.deepEqual(proof.cleanupStatus, recoveredProof)
    assert.match(proof.ledgerSha256, /^[a-f0-9]{64}$/)
    assert.doesNotMatch(JSON.stringify(proof), /cpprint|cppair|authorization|privateKey/i)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
})

test('startup corruption fails closed with a redacted native recovery message', async () => {
  const shown = []
  const exits = []
  const started = await runProtectedGatewayStartup({
    async initialize() {
      throw new Error(`corrupt protected state ${runtimeCredential}`)
    },
    showError: (title, message) => shown.push({ title, message }),
    exit: (code) => exits.push(code),
  })
  assert.equal(started, false)
  assert.deepEqual(exits, [1])
  assert.equal(shown.length, 1)
  assert.match(shown[0].title, /could not start safely/i)
  assert.match(shown[0].message, /duplicate-print fences.*support/i)
  assert.doesNotMatch(JSON.stringify(shown), /cpprint\.v1/)
})

test('renderer navigation and privileged IPC are pinned to the exact main frame', () => {
  const rendererUrl = 'file:///Applications/ClawPilot.app/Contents/Resources/app.asar/src/renderer/index.html'
  assert.equal(rendererNavigationIsTrusted(rendererUrl, rendererUrl), true)
  for (const hostile of [
    'file:///tmp/hostile.html',
    `${rendererUrl}?injected=1`,
    'https://aiapp.eigenracing.com',
    'javascript:alert(1)',
  ]) assert.equal(rendererNavigationIsTrusted(hostile, rendererUrl), false)

  const webContents = {}
  const mainWindow = { webContents }
  const mainFrame = { url: rendererUrl }
  mainFrame.top = mainFrame
  assert.doesNotThrow(() => assertTrustedRendererIpc({
    sender: webContents,
    senderFrame: mainFrame,
  }, mainWindow, rendererUrl))
  const hostileFrame = { url: 'file:///tmp/hostile.html' }
  hostileFrame.top = hostileFrame
  assert.throws(() => assertTrustedRendererIpc({
    sender: webContents,
    senderFrame: hostileFrame,
  }, mainWindow, rendererUrl), /only to the main packaged renderer/)
  const childFrame = { url: rendererUrl, top: mainFrame }
  assert.throws(() => assertTrustedRendererIpc({
    sender: webContents,
    senderFrame: childFrame,
  }, mainWindow, rendererUrl), /only to the main packaged renderer/)
  assert.throws(() => assertTrustedRendererIpc({
    sender: {},
    senderFrame: mainFrame,
  }, mainWindow, rendererUrl), /only to the main packaged renderer/)
})

test('autostart separates desired preference from effective OS registration', () => {
  assert.deepEqual(normalizedLoginItemStatus({
    desired: true,
    platform: 'darwin',
    settings: { openAtLogin: true, status: 'enabled' },
  }), {
    desired: true,
    effective: true,
    status: 'enabled',
    warning: null,
  })
  const approval = normalizedLoginItemStatus({
    desired: true,
    platform: 'darwin',
    settings: { openAtLogin: false, status: 'requires-approval' },
  })
  assert.equal(approval.effective, false)
  assert.match(approval.warning, /System Settings.*Login Items/)
  const windowsDrift = normalizedLoginItemStatus({
    desired: true,
    platform: 'win32',
    settings: { openAtLogin: true, executableWillLaunchAtLogin: false },
  })
  assert.equal(windowsDrift.effective, false)
  assert.match(windowsDrift.warning, /Startup Apps/)
})

test('mounted or translocated mac app blocks login registration, pairing, and workers', () => {
  for (const executablePath of [
    '/Volumes/ClawPilot Print Agent/ClawPilot Print Agent.app/Contents/MacOS/ClawPilot Print Agent',
    '/private/var/folders/AppTranslocation/ABC/d/ClawPilot Print Agent.app/Contents/MacOS/ClawPilot Print Agent',
  ]) {
    const status = gatewayInstallLocationStatus({
      platform: 'darwin',
      packaged: true,
      inApplicationsFolder: false,
      executablePath,
    })
    assert.equal(status.ready, false)
    assert.match(status.warning, /drag it to Applications.*eject.*reopen/i)
    assert.throws(() => assertStableGatewayInstall(status), /Applications/)
  }
  assert.equal(gatewayInstallLocationStatus({
    platform: 'darwin',
    packaged: true,
    inApplicationsFolder: true,
    executablePath: '/Applications/ClawPilot Print Agent.app/Contents/MacOS/ClawPilot Print Agent',
  }).ready, true)
  const mainSource = readFileSync(
    path.join(repositoryRoot, 'clients/print-gateway/src/main.mjs'),
    'utf8',
  )
  const rendererSource = readFileSync(
    path.join(repositoryRoot, 'clients/print-gateway/src/renderer/app.js'),
    'utf8',
  )
  const rendererHtml = readFileSync(
    path.join(repositoryRoot, 'clients/print-gateway/src/renderer/index.html'),
    'utf8',
  )
  const gatewayReadme = readFileSync(
    path.join(repositoryRoot, 'clients/print-gateway/README.md'),
    'utf8',
  )
  assert.match(mainSource, /if \(operationReady\) applyLoginItem/)
  assert.match(mainSource, /if \(operationReady\) workers\.startEnabled/)
  assert.match(mainSource, /if \(input\.enabled === true\) assertGatewayOperationReady/)
  assert.match(mainSource, /operationGuard: assertGatewayOperationReady/)
  assert.match(mainSource, /stopWorkers: \(\) => workers\.stopAllAndWait\(\)/)
  assert.match(mainSource, /legacyMacMigrationGuard\.start\(\)/)
  assert.match(mainSource, /showWindow[\s\S]*legacyMacMigrationGuard\?\.checkNow\(\)/)
  assert.match(rendererSource, /snapshot\?\.legacyMacMigrationBlocked === true/)
  assert.match(
    rendererSource,
    /elements\.autoStart\.disabled = operationBlocked\(\) && snapshot\.autoStart !== true/,
  )
  assert.match(rendererSource, /if \(update\.snapshot\)[\s\S]*render\(update\.snapshot\)/)
  assert.match(
    rendererHtml,
    /One physical Zebra may serve multiple organizations[\s\S]*one workspace instance per organization[\s\S]*credential, claim ledger, and acknowledgement stays isolated/,
  )
  assert.match(
    gatewayReadme,
    /pair each workspace[\s\S]*reusing the same printer IP and port[\s\S]*raw delivery is serialized/,
  )
  assert.match(
    gatewayReadme,
    /checks at startup, while running,[\s\S]*foreground[\s\S]*graceful shutdown path[\s\S]*before another claim/,
  )
  assert.equal(
    mainSource.indexOf('if (operationReady) applyLoginItem')
      < mainSource.indexOf('if (operationReady) workers.startEnabled'),
    true,
  )
})

test('printer probe opens TCP and sends no bytes', async () => {
  let receivedBytes = 0
  const server = net.createServer((socket) => {
    socket.on('data', (chunk) => { receivedBytes += chunk.byteLength })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const result = await probeRawPrinter('127.0.0.1', server.address().port)
    assert.equal(result.reachable, true)
    assert.equal(result.bytesSent, 0)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
    assert.equal(receivedBytes, 0)
  } finally {
    server.close()
    await once(server, 'close')
  }
})

test('exact worker reads inherited credential and rejects same-origin and cross-origin redirects', async () => {
  let authorization = ''
  const okServer = http.createServer((request, response) => {
    authorization = String(request.headers.authorization || '')
    request.resume()
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, jobs: [] }))
    })
  })
  okServer.listen(0, '127.0.0.1')
  await once(okServer, 'listening')
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'clawpilot-gateway-runtime-'))
  try {
    const success = spawnWorker({
      apiUrl: `http://127.0.0.1:${okServer.address().port}`,
      temporary,
    })
    assert.equal((await success.outcome()).code, 0)
    assert.equal(authorization, `Bearer ${runtimeCredential}`)

    let sameOriginTargetHits = 0
    let crossOriginTargetHits = 0
    const crossTarget = http.createServer((_request, response) => {
      crossOriginTargetHits += 1
      response.end(JSON.stringify({ ok: true, jobs: [] }))
    })
    crossTarget.listen(0, '127.0.0.1')
    await once(crossTarget, 'listening')
    const redirectServer = http.createServer((request, response) => {
      if (request.url === '/same-target') {
        sameOriginTargetHits += 1
        response.end(JSON.stringify({ ok: true, jobs: [] }))
        return
      }
      const cross = request.headers['x-test-cross'] === '1'
      response.writeHead(302, {
        location: cross
          ? `http://127.0.0.1:${crossTarget.address().port}/cross-target`
          : '/same-target',
      })
      response.end()
    })
    redirectServer.listen(0, '127.0.0.1')
    await once(redirectServer, 'listening')
    try {
      const same = spawnWorker({
        apiUrl: `http://127.0.0.1:${redirectServer.address().port}`,
        temporary: path.join(temporary, 'same'),
      })
      assert.notEqual((await same.outcome()).code, 0)
      assert.equal(sameOriginTargetHits, 0)

      redirectServer.removeAllListeners('request')
      redirectServer.on('request', (_request, response) => {
        response.writeHead(302, {
          location: `http://127.0.0.1:${crossTarget.address().port}/cross-target`,
        })
        response.end()
      })
      const cross = spawnWorker({
        apiUrl: `http://127.0.0.1:${redirectServer.address().port}`,
        temporary: path.join(temporary, 'cross'),
      })
      assert.notEqual((await cross.outcome()).code, 0)
      assert.equal(crossOriginTargetHits, 0)
    } finally {
      redirectServer.close()
      crossTarget.close()
      await Promise.all([once(redirectServer, 'close'), once(crossTarget, 'close')])
    }
  } finally {
    okServer.close()
    await once(okServer, 'close')
    rmSync(temporary, { recursive: true, force: true })
  }
})

test('durable ledger barrier failure sends zero raw printer bytes', async () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'clawpilot-ledger-barrier-'))
  let printerConnections = 0
  const printer = net.createServer(() => { printerConnections += 1 })
  printer.listen(0, '127.0.0.1')
  await once(printer, 'listening')
  const zpl = '^XA^FO20,20^FDDurable barrier^FS^XZ'
  const api = http.createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body.action === 'claim' ? {
        ok: true,
        jobs: [{
          globalId: 'gpj-barrier',
          claimToken: 'claim-token-barrier',
          document: {
            globalId: 'gpd-barrier',
            type: 'shipping_label',
            format: 'ZPL',
            encoding: 'utf8',
            media: 'label_4x6',
            inlinePayload: zpl,
            byteLength: Buffer.byteLength(zpl),
            contentSha256: globalThis.process.getBuiltinModule('node:crypto')
              .createHash('sha256').update(zpl).digest('hex'),
          },
        }],
      } : { ok: true }))
    })
  })
  api.listen(0, '127.0.0.1')
  await once(api, 'listening')
  try {
    const blockedParent = path.join(temporary, 'not-a-directory')
    writeFileSync(blockedParent, 'blocks mkdir')
    const worker = spawnWorker({
      apiUrl: `http://127.0.0.1:${api.address().port}`,
      temporary,
      printerPort: printer.address().port,
      ledgerPath: path.join(blockedParent, 'ledger.json'),
    })
    assert.notEqual((await worker.outcome()).code, 0)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
    assert.equal(printerConnections, 0)
  } finally {
    api.close()
    printer.close()
    await Promise.all([once(api, 'close'), once(printer, 'close')])
    rmSync(temporary, { recursive: true, force: true })
  }
})
