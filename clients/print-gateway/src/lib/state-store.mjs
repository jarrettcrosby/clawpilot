import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statfsSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import path from 'node:path'
import {
  normalizeBaseUrl,
  normalizeInstanceName,
  normalizePrinterHost,
  normalizePrinterPort,
} from './validation.mjs'

const SCHEMA_VERSION = 3
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SAFE_GLOBAL_ID = /^[A-Za-z0-9._:-]{3,200}$/
const RUNTIME_CREDENTIAL = /^cpprint\.v1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/i
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/
const PAIRING_PHASES = new Set(['prepared', 'request_sent'])

function writeAllSync(descriptor, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8')
  let offset = 0
  while (offset < bytes.byteLength) {
    const written = writeSync(descriptor, bytes, offset, bytes.byteLength - offset)
    if (!Number.isSafeInteger(written) || written < 1) {
      throw new Error('The durable local-state write did not make forward progress')
    }
    offset += written
  }
}

function emptyState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    autoStart: false,
    instances: [],
    pendingPairings: [],
  }
}

function assertStoredInstance(instance) {
  if (
    !instance
    || typeof instance.id !== 'string'
    || !UUID.test(instance.id)
    || typeof instance.encryptedEnvelope !== 'string'
    || !BASE64.test(instance.encryptedEnvelope)
    || typeof instance.enabled !== 'boolean'
    || !Number.isFinite(Date.parse(instance.createdAt))
    || (
      instance.updatedAt !== undefined
      && !Number.isFinite(Date.parse(instance.updatedAt))
    )
  ) throw new Error('The protected local gateway state has an unsupported instance')
}

function assertPendingPairingEntry(entry) {
  if (
    !entry
    || typeof entry.pairingCodeHash !== 'string'
    || !/^[a-f0-9]{64}$/.test(entry.pairingCodeHash)
    || typeof entry.encryptedRecovery !== 'string'
    || !BASE64.test(entry.encryptedRecovery)
    || !Number.isFinite(Date.parse(entry.createdAt))
  ) throw new Error('The protected local pairing-recovery state is invalid')
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`The protected local ${label} is invalid`)
  }
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`The protected local ${label} has an unsupported shape`)
  }
}

function assertRecoveryShape(recovery, pairingCodeHash) {
  exactKeys(recovery, [
    'schemaVersion',
    'installationId',
    'clientPublicKey',
    'clientKeyFingerprint',
    'privateKeyPkcs8',
    'idempotencyKey',
    'pairingCodeHash',
  ], 'pairing-recovery envelope')
  if (
    recovery.schemaVersion !== 2
    || !UUID.test(recovery.installationId)
    || !/^[A-Za-z0-9_-]{59}$/.test(recovery.clientPublicKey)
    || !/^[A-Za-z0-9_-]{43}$/.test(recovery.clientKeyFingerprint)
    || !/^[A-Za-z0-9_-]{64}$/.test(recovery.privateKeyPkcs8)
    || !/^[A-Za-z0-9._:-]{8,200}$/.test(recovery.idempotencyKey)
    || recovery.pairingCodeHash !== pairingCodeHash
  ) throw new Error('The protected local pairing-recovery identity is invalid')
}

export class GatewayStateStore {
  constructor({ dataDirectory, safeStorage, allowLocalDevelopment = false }) {
    this.dataDirectory = dataDirectory
    this.safeStorage = safeStorage
    this.allowLocalDevelopment = allowLocalDevelopment === true
    this.statePath = path.join(dataDirectory, 'gateway-state.v3.json')
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 })
    this.state = this.read()
  }

  assertSecureStorage() {
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error('Operating-system secure credential storage is unavailable')
    }
  }

  decrypt(encrypted, label) {
    this.assertSecureStorage()
    try {
      return JSON.parse(this.safeStorage.decryptString(Buffer.from(encrypted, 'base64')))
    } catch {
      throw new Error(`The protected local ${label} could not be verified`)
    }
  }

  encrypt(value) {
    this.assertSecureStorage()
    return this.safeStorage.encryptString(JSON.stringify(value)).toString('base64')
  }

  validateInstanceEnvelope(stored, envelope) {
    exactKeys(envelope, [
      'version',
      'id',
      'displayName',
      'localName',
      'slug',
      'baseUrl',
      'printerHost',
      'printerPort',
      'serverAgentId',
      'serverAgentGlobalId',
      'serverAgentName',
      'warehouseId',
      'warehouseGlobalId',
      'warehouseName',
      'runtimeCredential',
    ], 'gateway execution envelope')
    const normalizedName = normalizeInstanceName(envelope.displayName)
    const normalizedLocalName = envelope.localName === null
      ? null
      : normalizeInstanceName(envelope.localName).displayName
    if (
      envelope.version !== 2
      || envelope.id !== stored.id
      || normalizedName.displayName !== envelope.displayName
      || normalizedLocalName !== envelope.localName
      || envelope.slug !== `instance-${stored.id}`
      || !UUID.test(envelope.serverAgentId)
      || !SAFE_GLOBAL_ID.test(envelope.serverAgentGlobalId)
      || envelope.serverAgentName !== envelope.displayName
      || !UUID.test(envelope.warehouseId)
      || !SAFE_GLOBAL_ID.test(envelope.warehouseGlobalId)
      || typeof envelope.warehouseName !== 'string'
      || !envelope.warehouseName.trim()
      || envelope.warehouseName.length > 160
      || /[\u0000-\u001f\u007f]/.test(envelope.warehouseName)
      || normalizeBaseUrl(envelope.baseUrl, {
        allowLocalDevelopment: this.allowLocalDevelopment,
      }) !== envelope.baseUrl
      || normalizePrinterHost(envelope.printerHost, {
        allowLocalDevelopment: this.allowLocalDevelopment,
      }) !== envelope.printerHost
      || normalizePrinterPort(envelope.printerPort) !== envelope.printerPort
      || !RUNTIME_CREDENTIAL.test(envelope.runtimeCredential)
      || envelope.runtimeCredential.split('.')[2].toLowerCase()
        !== envelope.serverAgentId.toLowerCase()
    ) throw new Error('The protected local gateway execution envelope failed security validation')
    return envelope
  }

  envelopeFor(stored) {
    return this.validateInstanceEnvelope(
      stored,
      this.decrypt(stored.encryptedEnvelope, 'gateway execution envelope'),
    )
  }

  publicInstance(stored) {
    const {
      runtimeCredential,
      serverAgentId,
      warehouseId,
      version,
      ...visible
    } = this.envelopeFor(stored)
    return {
      ...visible,
      enabled: stored.enabled,
      createdAt: stored.createdAt,
      ...(stored.updatedAt ? { updatedAt: stored.updatedAt } : {}),
    }
  }

  pendingRecoveryFor(entry) {
    const envelope = this.decrypt(entry.encryptedRecovery, 'pairing-recovery envelope')
    exactKeys(envelope, ['version', 'baseUrl', 'phase', 'recovery'], 'pairing-recovery envelope')
    if (
      envelope.version !== 2
      || !PAIRING_PHASES.has(envelope.phase)
      || normalizeBaseUrl(envelope.baseUrl, {
        allowLocalDevelopment: this.allowLocalDevelopment,
      }) !== envelope.baseUrl
    ) throw new Error('The protected local pairing-recovery origin is invalid')
    assertRecoveryShape(envelope.recovery, entry.pairingCodeHash)
    return envelope
  }

  read() {
    if (!existsSync(this.statePath)) return emptyState()
    const parsed = JSON.parse(readFileSync(this.statePath, 'utf8'))
    if (
      parsed?.schemaVersion !== SCHEMA_VERSION
      || typeof parsed.autoStart !== 'boolean'
      || !Array.isArray(parsed.instances)
      || !Array.isArray(parsed.pendingPairings)
    ) throw new Error('The local gateway state has an unsupported schema')
    parsed.instances.forEach(assertStoredInstance)
    parsed.pendingPairings.forEach(assertPendingPairingEntry)
    const envelopes = parsed.instances.map((instance) => this.envelopeFor(instance))
    const ids = new Set(parsed.instances.map((instance) => instance.id))
    const slugs = new Set(envelopes.map((envelope) => envelope.slug))
    const serverAgents = new Set(envelopes.map((envelope) => envelope.serverAgentGlobalId))
    const pairingHashes = new Set(parsed.pendingPairings.map((entry) => entry.pairingCodeHash))
    if (
      ids.size !== parsed.instances.length
      || slugs.size !== parsed.instances.length
      || serverAgents.size !== parsed.instances.length
      || pairingHashes.size !== parsed.pendingPairings.length
    ) throw new Error('The local gateway state contains duplicate protected identities')
    for (const entry of parsed.pendingPairings) this.pendingRecoveryFor(entry)
    return parsed
  }

  write(nextState = this.state) {
    const temporary = `${this.statePath}.${process.pid}.tmp`
    let descriptor
    try {
      descriptor = openSync(temporary, 'w', 0o600)
      writeAllSync(descriptor, `${JSON.stringify(nextState, null, 2)}\n`)
      fsyncSync(descriptor)
      closeSync(descriptor)
      descriptor = undefined
      renameSync(temporary, this.statePath)
      descriptor = openSync(this.statePath, 'r+')
      fsyncSync(descriptor)
      closeSync(descriptor)
      descriptor = undefined
      if (process.platform !== 'win32') {
        descriptor = openSync(path.dirname(this.statePath), 'r')
        fsyncSync(descriptor)
        closeSync(descriptor)
        descriptor = undefined
      }
      this.state = nextState
    } catch (error) {
      if (descriptor !== undefined) {
        try { closeSync(descriptor) } catch { /* preserve original failure */ }
      }
      if (existsSync(temporary)) {
        try { unlinkSync(temporary) } catch { /* preserve original failure */ }
      }
      throw error
    }
  }

  preflightPairingPersistence() {
    this.assertSecureStorage()
    const filesystem = statfsSync(this.dataDirectory)
    const availableBytes = Number(filesystem.bavail) * Number(filesystem.bsize)
    if (!Number.isFinite(availableBytes) || availableBytes < 16 * 1024 * 1024) {
      throw new Error('At least 16 MB of free local disk space is required before pairing')
    }
    const protectedProbe = this.safeStorage.encryptString('clawpilot-pairing-preflight')
    if (this.safeStorage.decryptString(protectedProbe) !== 'clawpilot-pairing-preflight') {
      throw new Error('Operating-system secure credential storage failed its local verification')
    }
    const probePath = path.join(this.dataDirectory, `.pairing-preflight-${randomUUID()}.tmp`)
    let descriptor
    try {
      descriptor = openSync(probePath, 'wx', 0o600)
      writeAllSync(descriptor, 'clawpilot-pairing-preflight\n')
      fsyncSync(descriptor)
      closeSync(descriptor)
      descriptor = undefined
      unlinkSync(probePath)
      if (process.platform !== 'win32') {
        descriptor = openSync(this.dataDirectory, 'r')
        fsyncSync(descriptor)
        closeSync(descriptor)
        descriptor = undefined
      }
    } catch (error) {
      if (descriptor !== undefined) {
        try { closeSync(descriptor) } catch { /* preserve original failure */ }
      }
      if (existsSync(probePath)) {
        try { unlinkSync(probePath) } catch { /* preserve original failure */ }
      }
      throw new Error(`Local durable-state preflight failed: ${error.message}`)
    }
  }

  preparePairingRecovery({ baseUrl, pairingCodeHash, createRecovery }) {
    this.assertSecureStorage()
    if (!/^[a-f0-9]{64}$/.test(pairingCodeHash)) {
      throw new Error('The pairing-code recovery identity is invalid')
    }
    const normalizedBaseUrl = normalizeBaseUrl(baseUrl, {
      allowLocalDevelopment: this.allowLocalDevelopment,
    })
    const existing = this.state.pendingPairings.find(
      (entry) => entry.pairingCodeHash === pairingCodeHash,
    )
    if (existing) {
      const envelope = this.pendingRecoveryFor(existing)
      if (envelope.baseUrl !== normalizedBaseUrl) {
        throw new Error('This pairing code is already bound to a different trusted deployment')
      }
      return {
        phase: envelope.phase,
        recovery: envelope.recovery,
      }
    }
    const recovery = createRecovery()
    assertRecoveryShape(recovery, pairingCodeHash)
    const entry = {
      pairingCodeHash,
      encryptedRecovery: this.encrypt({
        version: 2,
        baseUrl: normalizedBaseUrl,
        phase: 'prepared',
        recovery,
      }),
      createdAt: new Date().toISOString(),
    }
    const nextState = structuredClone(this.state)
    nextState.pendingPairings.push(entry)
    this.write(nextState)
    return { phase: 'prepared', recovery }
  }

  markPairingRecoveryRequestSent(pairingCodeHash) {
    const nextState = structuredClone(this.state)
    const entry = nextState.pendingPairings.find(
      (candidate) => candidate.pairingCodeHash === pairingCodeHash,
    )
    if (!entry) throw new Error('The durable pairing-recovery state is missing')
    const envelope = this.pendingRecoveryFor(
      this.state.pendingPairings.find(
        (candidate) => candidate.pairingCodeHash === pairingCodeHash,
      ),
    )
    if (envelope.phase === 'request_sent') return envelope.recovery
    envelope.phase = 'request_sent'
    entry.encryptedRecovery = this.encrypt(envelope)
    this.write(nextState)
    return envelope.recovery
  }

  publicState() {
    return {
      schemaVersion: SCHEMA_VERSION,
      autoStart: this.state.autoStart,
      instances: this.state.instances.map((instance) => this.publicInstance(instance)),
    }
  }

  hasServerAgent(globalId) {
    return this.state.instances.some(
      (stored) => this.envelopeFor(stored).serverAgentGlobalId === globalId,
    )
  }

  createInstance(input, runtimeCredential, {
    completedPairingCodeHash = null,
    enabled = true,
  } = {}) {
    this.assertSecureStorage()
    if (this.hasServerAgent(input.serverAgentGlobalId)) {
      throw new Error('That ClawPilot server agent already exists on this computer')
    }
    if (!RUNTIME_CREDENTIAL.test(runtimeCredential)) {
      throw new Error('The runtime credential has an invalid shape')
    }
    const id = randomUUID()
    const envelope = {
      version: 2,
      id,
      displayName: input.displayName,
      localName: input.localName,
      slug: `instance-${id}`,
      baseUrl: input.baseUrl,
      printerHost: input.printerHost,
      printerPort: input.printerPort,
      serverAgentId: input.serverAgentId,
      serverAgentGlobalId: input.serverAgentGlobalId,
      serverAgentName: input.serverAgentName,
      warehouseId: input.warehouseId,
      warehouseGlobalId: input.warehouseGlobalId,
      warehouseName: input.warehouseName,
      runtimeCredential,
    }
    const stored = {
      id,
      enabled: enabled === true,
      createdAt: new Date().toISOString(),
      encryptedEnvelope: this.encrypt(envelope),
    }
    this.validateInstanceEnvelope(stored, envelope)
    const nextState = structuredClone(this.state)
    nextState.instances.push(stored)
    if (completedPairingCodeHash !== null) {
      const before = nextState.pendingPairings.length
      nextState.pendingPairings = nextState.pendingPairings.filter(
        (entry) => entry.pairingCodeHash !== completedPairingCodeHash,
      )
      if (nextState.pendingPairings.length !== before - 1) {
        throw new Error('The durable pairing-recovery state is missing')
      }
    }
    this.write(nextState)
    return this.publicInstance(stored)
  }

  credentialFor(id) {
    const stored = this.state.instances.find((candidate) => candidate.id === id)
    if (!stored) throw new Error('The local gateway instance was not found')
    return this.envelopeFor(stored).runtimeCredential
  }

  assertInstanceIntegrity(id) {
    const stored = this.state.instances.find((candidate) => candidate.id === id)
    if (!stored) throw new Error('The local gateway instance was not found')
    return this.publicInstance(stored)
  }

  instanceFor(id) {
    const stored = this.state.instances.find((candidate) => candidate.id === id)
    return stored ? this.publicInstance(stored) : null
  }

  setEnabled(id, enabled) {
    const nextState = structuredClone(this.state)
    const stored = nextState.instances.find((candidate) => candidate.id === id)
    if (!stored) throw new Error('The local gateway instance was not found')
    stored.enabled = enabled === true
    stored.updatedAt = new Date().toISOString()
    this.write(nextState)
    return this.publicInstance(stored)
  }

  setAutoStart(enabled) {
    const nextState = structuredClone(this.state)
    nextState.autoStart = enabled === true
    this.write(nextState)
    return nextState.autoStart
  }

  updatePrinterEndpoint(id, printerHost, printerPort) {
    const nextState = structuredClone(this.state)
    const stored = nextState.instances.find((candidate) => candidate.id === id)
    if (!stored) throw new Error('The local gateway instance was not found')
    const envelope = this.envelopeFor(
      this.state.instances.find((candidate) => candidate.id === id),
    )
    envelope.printerHost = printerHost
    envelope.printerPort = printerPort
    this.validateInstanceEnvelope(stored, envelope)
    stored.encryptedEnvelope = this.encrypt(envelope)
    stored.updatedAt = new Date().toISOString()
    this.write(nextState)
    return this.publicInstance(stored)
  }

  removeInstance(id) {
    const nextState = structuredClone(this.state)
    const index = nextState.instances.findIndex((candidate) => candidate.id === id)
    if (index === -1) throw new Error('The local gateway instance was not found')
    const removedPublic = this.publicInstance(this.state.instances[index])
    nextState.instances.splice(index, 1)
    this.write(nextState)
    return removedPublic
  }
}
