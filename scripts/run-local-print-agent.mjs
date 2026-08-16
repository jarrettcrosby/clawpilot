#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { promises as fs, readFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  opaqueLocalDeviceReference,
  readOrCreateLocalDeviceKey,
  runWithLocalPrinterKernelLock,
  normalizedLocalPrinterEndpoint,
} from './lib/local-print-device.mjs'
import { rawPrintFailureDisposition } from './lib/submit-raw-print.mjs'

const args = new Set(process.argv.slice(2))
const once = args.has('--once')
const probeOnly = args.has('--probe')
const help = args.has('--help') || args.has('-h')
const pollIntervalMs = positiveInteger(process.env.CLAWPILOT_PRINT_AGENT_POLL_MS, 2_000)
const printerPort = positiveInteger(process.env.CLAWPILOT_PRINTER_PORT, 9_100)
const printerHost = String(process.env.CLAWPILOT_PRINTER_HOST || '').trim()
const bundledLabelMedia = Object.freeze([
  'label_2x1',
  'label_3x1',
  'label_4x2',
  'label_4x6',
  'label_4x8',
])
const workerCapabilities = Object.freeze({
  formats: ['ZPL'],
  media: bundledLabelMedia,
  documentTypes: ['shipping_label', 'product_label', 'location_label'],
})
const legacyWorkerCapabilities = Object.freeze({
  formats: ['ZPL'],
  media: ['label_4x6'],
  documentTypes: ['shipping_label'],
})
let activeWorkerCapabilities = workerCapabilities
const ledgerPath = expandHome(
  process.env.CLAWPILOT_PRINT_AGENT_LEDGER
    || '~/.clawpilot/print-agent-ledger.json',
)
const deviceKeyPath = expandHome(
  process.env.CLAWPILOT_PRINT_AGENT_DEVICE_KEY
    || path.join(path.dirname(ledgerPath), 'device-reference.key'),
)
const deviceLockDirectory = expandHome(
  process.env.CLAWPILOT_PRINT_AGENT_DEVICE_LOCK_DIRECTORY
    || '~/Library/Application Support/ClawPilot/print-agent/device-locks',
)
const rawDeliveryHelperPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'lib',
  'submit-raw-print.mjs',
)
const MINIMUM_RAW_DELIVERY_LEASE_MS = 25_000
const CLAIM_MONOTONIC_DEADLINE = Symbol('claimMonotonicDeadline')
const REQUEST_ROUND_TRIP_MS = Symbol('requestRoundTripMs')
let testMonotonicOffsetNs = 0n

if (help) {
  process.stdout.write(`ClawPilot local print agent

Required environment:
  CLAWPILOT_PRINT_AGENT_URL          ClawPilot deployment base URL
  CLAWPILOT_PRINT_AGENT_CREDENTIAL   Runtime cpprint credential (valid until revoked)
  CLAWPILOT_PRINTER_HOST             Printer hostname or IP address

Optional environment:
  CLAWPILOT_PRINT_AGENT_CREDENTIAL_FD
                                      Inherited descriptor containing the runtime credential
  CLAWPILOT_PRINTER_PORT             Raw printer port (default 9100)
  CLAWPILOT_PRINT_AGENT_LEDGER       Local duplicate fence ledger
  CLAWPILOT_PRINT_AGENT_DEVICE_KEY   Local opaque device-reference key
  CLAWPILOT_PRINT_AGENT_DEVICE_LOCK_DIRECTORY
  CLAWPILOT_PRINT_AGENT_POLL_MS      Poll interval (default 2000)
  CLAWPILOT_PRINT_AGENT_KEYCHAIN_SERVICE
  CLAWPILOT_PRINT_AGENT_KEYCHAIN_ACCOUNT

Options:
  --once    Claim at most one job and exit
  --probe   Test the raw printer connection without claiming work

Runtime capability:
  Raw UTF-8 ZPL carrier labels on 4 x 6 or 4 x 8 media, plus product and
  location barcode labels on 2 x 1, 3 x 1, 4 x 2, 4 x 6, or 4 x 8 media
`)
  process.exit(0)
}

function positiveInteger(value, fallback) {
  const number = Number(value || fallback)
  if (!Number.isSafeInteger(number) || number < 1 || number > 65_535) {
    throw new Error('A positive integer configuration value is invalid')
  }
  return number
}

function expandHome(value) {
  return value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value
}

function endpointUrl() {
  const configured = String(process.env.CLAWPILOT_PRINT_AGENT_URL || '').trim()
  if (!configured) throw new Error('CLAWPILOT_PRINT_AGENT_URL is required')
  const base = new URL(configured)
  if (!['http:', 'https:'].includes(base.protocol)) {
    throw new Error('CLAWPILOT_PRINT_AGENT_URL must use HTTP or HTTPS')
  }
  return new URL('/api/operations/print-agent/jobs', base).toString()
}

function credential() {
  const direct = String(process.env.CLAWPILOT_PRINT_AGENT_CREDENTIAL || '').trim()
  if (direct) return direct
  const descriptorValue = String(process.env.CLAWPILOT_PRINT_AGENT_CREDENTIAL_FD || '').trim()
  const descriptor = Number(descriptorValue)
  if (
    descriptorValue
    && Number.isSafeInteger(descriptor)
    && (descriptor === 0 || (descriptor >= 3 && descriptor <= 255))
  ) {
    const piped = readFileSync(descriptor, { encoding: 'utf8' }).trim()
    if (piped) return piped
  }
  const service = String(
    process.env.CLAWPILOT_PRINT_AGENT_KEYCHAIN_SERVICE || '',
  ).trim()
  const account = String(
    process.env.CLAWPILOT_PRINT_AGENT_KEYCHAIN_ACCOUNT || '',
  ).trim()
  if (!service || !account) {
    throw new Error('CLAWPILOT_PRINT_AGENT_CREDENTIAL is required')
  }
  return execFileSync(
    '/usr/bin/security',
    ['find-generic-password', '-s', service, '-a', account, '-w'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  ).trim()
}

function assertConfiguration() {
  if (!printerHost) throw new Error('CLAWPILOT_PRINTER_HOST is required')
  normalizedLocalPrinterEndpoint(printerHost, printerPort)
  const token = credential()
  if (!/^cpprint\.v1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/i.test(token)) {
    throw new Error('The local print-agent credential has an invalid shape')
  }
  return { endpoint: endpointUrl(), token }
}

function log(event, detail = {}) {
  process.stdout.write(`${JSON.stringify({
    at: new Date().toISOString(),
    event,
    ...detail,
  })}\n`)
}

async function readLedger() {
  try {
    const parsed = JSON.parse(await fs.readFile(ledgerPath, 'utf8'))
    if (parsed?.version !== 1 || !parsed.claims || typeof parsed.claims !== 'object') {
      throw new Error('Local print ledger has an unsupported shape')
    }
    if (!parsed.deliveries || typeof parsed.deliveries !== 'object') {
      parsed.deliveries = {}
    }
    if (!parsed.pendingResults || typeof parsed.pendingResults !== 'object') {
      parsed.pendingResults = {}
    }
    return parsed
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { version: 1, claims: {}, deliveries: {}, pendingResults: {} }
    }
    throw error
  }
}

async function writeLedger(ledger) {
  await fs.mkdir(path.dirname(ledgerPath), { recursive: true, mode: 0o700 })
  const temporary = `${ledgerPath}.${process.pid}.tmp`
  let handle
  try {
    handle = await fs.open(temporary, 'w', 0o600)
    await handle.writeFile(`${JSON.stringify(ledger, null, 2)}\n`, { encoding: 'utf8' })
    await handle.sync()
    await handle.close()
    handle = null
    await fs.rename(temporary, ledgerPath)

    // FlushFileBuffers on the renamed destination is the Windows durability
    // barrier. POSIX additionally requires the parent-directory metadata sync.
    handle = await fs.open(ledgerPath, 'r+')
    await handle.sync()
    await handle.close()
    handle = null
    if (process.platform !== 'win32') {
      handle = await fs.open(path.dirname(ledgerPath), 'r')
      await handle.sync()
      await handle.close()
      handle = null
    }
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await fs.unlink(temporary).catch((unlinkError) => {
      if (unlinkError?.code !== 'ENOENT') throw unlinkError
    })
    throw error
  }
}

async function agentRequest(config, action, payload, key) {
  const requestStarted = process.hrtime.bigint()
  const response = await fetch(config.endpoint, {
    method: 'POST',
    redirect: 'error',
    headers: {
      authorization: `Bearer ${config.token}`,
      'content-type': 'application/json',
      'idempotency-key': key,
    },
    body: JSON.stringify({ action, ...payload }),
    signal: AbortSignal.timeout(20_000),
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok || result.ok !== true) {
    const code = String(result.code || `HTTP_${response.status}`)
    const error = new Error(`Print-agent ${action} failed (${code})`)
    error.code = code
    throw error
  }
  Object.defineProperty(result, REQUEST_ROUND_TRIP_MS, {
    value: Number(process.hrtime.bigint() - requestStarted) / 1_000_000,
    enumerable: false,
  })
  return result
}

function documentMediaIsSupported(document) {
  if (document?.type === 'shipping_label') {
    return document.media === 'label_4x6' || document.media === 'label_4x8'
  }
  if (document?.type === 'product_label' || document?.type === 'location_label') {
    return bundledLabelMedia.includes(document.media)
  }
  return false
}

function decodeAndVerify(job) {
  const document = job?.document
  if (
    !job?.globalId
    || !job?.claimToken
    || !document?.globalId
    || document?.format !== 'ZPL'
    || document?.encoding !== 'utf8'
    || typeof document?.inlinePayload !== 'string'
    || !documentMediaIsSupported(document)
  ) {
    throw new Error(
      'This Zebra worker only accepts supported inline UTF-8 ZPL carrier or barcode label artifacts',
    )
  }
  const payload = Buffer.from(document.inlinePayload, 'utf8')
  const digest = createHash('sha256').update(payload).digest('hex')
  if (payload.byteLength !== Number(document.byteLength)) {
    throw new Error('Print artifact byte length does not match its immutable metadata')
  }
  if (digest !== String(document.contentSha256 || '').toLowerCase()) {
    throw new Error('Print artifact digest does not match its immutable metadata')
  }
  return payload
}

async function probePrinter(timeoutMs = 3_000) {
  await new Promise((resolvePromise, reject) => {
    const socket = net.createConnection({ host: printerHost, port: printerPort })
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => {
      socket.destroy()
      resolvePromise()
    })
    socket.once('timeout', () => {
      socket.destroy()
      reject(new Error('Printer connection timed out'))
    })
    socket.once('error', reject)
  })
}

async function submitRaw(payload, job, timeoutMs = 10_000) {
  const execution = await runWithLocalPrinterKernelLock({
    directory: deviceLockDirectory,
    host: printerHost,
    port: printerPort,
    timeoutMs,
    command: process.execPath,
    args: [rawDeliveryHelperPath],
    env: {
      CLAWPILOT_PRINTER_HOST: printerHost,
      CLAWPILOT_PRINTER_PORT: String(printerPort),
      CLAWPILOT_PRINT_CLAIM_EXPIRES_AT: claimExpiry(job),
      CLAWPILOT_PRINT_CLAIM_MONOTONIC_DEADLINE_NS: String(
        claimMonotonicDeadline(job),
      ),
    },
    stdin: payload,
  })
  if (execution.lockTimedOut) {
    const error = new Error('The configured local printer is busy')
    error.code = 'LOCAL_PRINTER_BUSY'
    error.acceptedBytes = 0
    error.deliveryStarted = false
    throw error
  }
  let result = null
  try {
    result = JSON.parse(execution.stdout)
  } catch {
    // A helper that exits without evidence may have delivered bytes.
  }
  if (
    execution.code === 0
    && result?.ok === true
    && Number(result.acceptedBytes) === payload.byteLength
  ) {
    return { acceptedBytes: payload.byteLength }
  }
  const error = new Error('The configured local printer did not complete delivery')
  const disposition = rawPrintFailureDisposition({
    acceptedBytes: Number.isSafeInteger(Number(result?.acceptedBytes))
      ? Number(result.acceptedBytes)
      : payload.byteLength,
    deliveryStarted: result?.deliveryStarted,
  })
  error.code = String(result?.code || disposition.code)
  error.acceptedBytes = disposition.acceptedBytes
  error.deliveryStarted = disposition.deliveryStarted
  throw error
}

function claimKey(job) {
  return `${job.globalId}:${job.claimToken}`
}

function deliveryKey(job) {
  if (
    !job?.globalId
    || !job?.claimToken
    || !job?.document?.globalId
    || !/^[a-f0-9]{64}$/i.test(String(job.document.contentSha256 || ''))
  ) {
    throw new Error('The print job is missing its immutable artifact identity')
  }
  const identity = [
    'clawpilot:local-print-delivery:v1',
    job.globalId,
    job.document.globalId,
    String(job.document.contentSha256 || '').toLowerCase(),
  ].join('\n')
  return `delivery.v1.${createHash('sha256').update(identity).digest('hex')}`
}

function priorDelivery(ledger, job, key) {
  const candidates = [
    ledger.deliveries[key],
    ...Object.values(ledger.claims).filter((claim) => (
      claim?.jobGlobalId === job.globalId
      && claim?.documentGlobalId === job.document.globalId
      && (
        !claim?.contentSha256
        || claim.contentSha256 === String(job.document.contentSha256).toLowerCase()
      )
    )),
  ].filter(Boolean)
  const priority = (candidate) => {
    if (candidate.state === 'acknowledged' || candidate.state === 'delivered') return 3
    if (
      candidate.state === 'sending'
      || candidate.state === 'outcome_uncertain'
      || candidate.state === 'server_recovery_required'
    ) return 2
    if (candidate.state === 'delivery_failed') return 1
    return 0
  }
  const highest = Math.max(0, ...candidates.map(priority))
  if (!highest) return null
  const strongest = candidates.filter((candidate) => priority(candidate) === highest)
  const state = highest === 3
    ? strongest.some((candidate) => candidate.state === 'acknowledged')
      ? 'acknowledged'
      : 'delivered'
    : highest === 2
      ? 'outcome_uncertain'
      : 'delivery_failed'
  return {
    ...strongest[0],
    state,
    startedAt: strongest.find((candidate) => candidate.startedAt)?.startedAt,
    deliveredAt: strongest.find((candidate) => candidate.deliveredAt)?.deliveredAt,
    acknowledgedAt: strongest.find((candidate) => candidate.acknowledgedAt)?.acknowledgedAt,
    acceptedBytes: strongest.find((candidate) => (
      candidate.acceptedBytes !== null
      && candidate.acceptedBytes !== undefined
      && Number.isSafeInteger(Number(candidate.acceptedBytes))
    ))?.acceptedBytes,
  }
}

function deliveryRecord(job, state, detail = {}) {
  return {
    jobGlobalId: job.globalId,
    documentGlobalId: job.document.globalId,
    contentSha256: String(job.document.contentSha256).toLowerCase(),
    state,
    ...detail,
  }
}

function claimExpiry(job) {
  const expiresAt = String(job?.claimExpiresAt || '')
  if (!Number.isFinite(Date.parse(expiresAt))) {
    throw new Error('The print job is missing its authoritative claim expiration')
  }
  return expiresAt
}

function monotonicNowNs() {
  return process.hrtime.bigint() + testMonotonicOffsetNs
}

function registerClaimLease(job, requestRoundTripMs, requestedLeaseSeconds = 120) {
  const serverNow = Date.parse(String(job?.serverNow || ''))
  const expiresAt = Date.parse(claimExpiry(job))
  if (
    !Number.isFinite(serverNow)
    || expiresAt <= serverNow
    || !Number.isFinite(requestRoundTripMs)
    || requestRoundTripMs < 0
    || requestRoundTripMs > 20_500
  ) throw new Error('The print claim is missing trustworthy server lease timing')
  const transitAndClockSafetyMs = requestRoundTripMs + 2_000
  const serverBudgetMs = expiresAt - serverNow - transitAndClockSafetyMs
  const requestedBudgetMs = requestedLeaseSeconds * 1_000 - transitAndClockSafetyMs
  const remainingMs = Math.max(0, Math.min(serverBudgetMs, requestedBudgetMs))
  Object.defineProperty(job, CLAIM_MONOTONIC_DEADLINE, {
    value: process.hrtime.bigint() + BigInt(Math.floor(remainingMs * 1_000_000)),
    enumerable: false,
  })
}

function claimMonotonicDeadline(job) {
  const deadline = job?.[CLAIM_MONOTONIC_DEADLINE]
  if (typeof deadline !== 'bigint' || deadline <= 0n) {
    throw new Error('The print claim is missing its monotonic delivery deadline')
  }
  return deadline
}

function assertClaimLease(job, minimumRemainingMs = MINIMUM_RAW_DELIVERY_LEASE_MS) {
  const remainingNs = claimMonotonicDeadline(job) - monotonicNowNs()
  if (remainingNs < BigInt(minimumRemainingMs) * 1_000_000n) {
    const error = new Error('The print claim lease is too close to expiration for safe raw delivery')
    error.code = 'PRINT_CLAIM_LEASE_TOO_SHORT'
    throw error
  }
  return claimExpiry(job)
}

function applyTestClockAdvanceBeforeRaw() {
  if (
    process.env.CLAWPILOT_GATEWAY_TEST_MODE !== '1'
    || process.env.CLAWPILOT_PRINT_AGENT_ALLOW_LOOPBACK !== '1'
  ) return
  const offset = Number(process.env.CLAWPILOT_PRINT_AGENT_TEST_PRE_RAW_CLOCK_ADVANCE_MS || 0)
  if (Number.isSafeInteger(offset) && offset > 0 && offset <= 24 * 60 * 60 * 1_000) {
    testMonotonicOffsetNs = BigInt(offset) * 1_000_000n
  }
}

function failurePayload(job, input) {
  return {
    jobGlobalId: job.globalId,
    claimToken: job.claimToken,
    errorCode: input.errorCode,
    errorMessage: input.errorMessage.slice(0, 1_000),
    retryable: input.retryable,
    printerUnavailable: input.printerUnavailable,
    retryAfterSeconds: input.retryAfterSeconds || 0,
  }
}

function acknowledgementPayload(job, deviceReference) {
  return {
    jobGlobalId: job.globalId,
    claimToken: job.claimToken,
    deviceJobReference: deviceReference,
  }
}

function pendingResultIdentifier(action, job) {
  return `${action}:${job.globalId}:${job.claimToken}`
}

function queuePendingResult(ledger, job, action, payload, {
  claimLedgerKey = null,
  deliveryLedgerKey = null,
} = {}) {
  if (!['acknowledge', 'fail'].includes(action)) {
    throw new Error('The pending print result action is invalid')
  }
  const idempotencyKey = `${action === 'acknowledge' ? 'ack' : 'fail'}:${job.globalId}:${job.claimToken}`
  const identifier = pendingResultIdentifier(action, job)
  ledger.pendingResults[identifier] = {
    version: 1,
    action,
    jobGlobalId: job.globalId,
    claimToken: job.claimToken,
    claimExpiresAt: claimExpiry(job),
    idempotencyKey,
    payload,
    claimLedgerKey,
    deliveryLedgerKey,
    queuedAt: new Date().toISOString(),
  }
  return identifier
}

function assertPendingResult(identifier, pending) {
  if (
    !pending
    || pending.version !== 1
    || !['acknowledge', 'fail'].includes(pending.action)
    || pending.jobGlobalId !== pending.payload?.jobGlobalId
    || pending.claimToken !== pending.payload?.claimToken
    || identifier !== `${pending.action}:${pending.jobGlobalId}:${pending.claimToken}`
    || pending.idempotencyKey !== `${pending.action === 'acknowledge' ? 'ack' : 'fail'}:${pending.jobGlobalId}:${pending.claimToken}`
    || !Number.isFinite(Date.parse(pending.claimExpiresAt))
    || !Number.isFinite(Date.parse(pending.queuedAt))
  ) throw new Error('The durable pending print result is invalid')
  if (pending.action === 'acknowledge') {
    if (
      Object.keys(pending.payload).sort().join(',') !== [
        'claimToken',
        'deviceJobReference',
        'jobGlobalId',
      ].sort().join(',')
      || !/^local-device\.v1\.[A-Za-z0-9_-]{43}$/.test(
        String(pending.payload.deviceJobReference || ''),
      )
    ) throw new Error('The durable pending acknowledgement is invalid')
  } else if (
    Object.keys(pending.payload).sort().join(',') !== [
      'claimToken',
      'errorCode',
      'errorMessage',
      'jobGlobalId',
      'printerUnavailable',
      'retryAfterSeconds',
      'retryable',
    ].sort().join(',')
    || !/^[A-Z][A-Z0-9_]{1,63}$/.test(String(pending.payload.errorCode || ''))
    || typeof pending.payload.errorMessage !== 'string'
    || !pending.payload.errorMessage
    || pending.payload.errorMessage.length > 1_000
    || typeof pending.payload.retryable !== 'boolean'
    || typeof pending.payload.printerUnavailable !== 'boolean'
    || !Number.isSafeInteger(pending.payload.retryAfterSeconds)
    || pending.payload.retryAfterSeconds < 0
    || pending.payload.retryAfterSeconds > 300
  ) throw new Error('The durable pending failure result is invalid')
  return pending
}

async function submitPendingResult(config, ledger, identifier, { replayed = false } = {}) {
  const pending = assertPendingResult(identifier, ledger.pendingResults[identifier])
  try {
    await agentRequest(
      config,
      pending.action,
      pending.payload,
      pending.idempotencyKey,
    )
  } catch (error) {
    if (error?.code !== 'OPERATIONS_PRINT_CLAIM_EXPIRED') throw error
    const resolutionRequiredAt = new Date().toISOString()
    if (pending.claimLedgerKey && ledger.claims[pending.claimLedgerKey]) {
      ledger.claims[pending.claimLedgerKey] = {
        ...ledger.claims[pending.claimLedgerKey],
        state: 'server_recovery_required',
        resolutionRequiredAt,
        serverResultConfirmed: false,
      }
    }
    if (pending.deliveryLedgerKey && ledger.deliveries[pending.deliveryLedgerKey]) {
      ledger.deliveries[pending.deliveryLedgerKey] = {
        ...ledger.deliveries[pending.deliveryLedgerKey],
        state: 'server_recovery_required',
        resolutionRequiredAt,
        serverResultConfirmed: false,
      }
    }
    delete ledger.pendingResults[identifier]
    await writeLedger(ledger)
    log('result_replay_expired', {
      action: pending.action,
      jobGlobalId: pending.jobGlobalId,
      serverRejectedUncommittedResult: true,
      resent: false,
    })
    return false
  }
  const completedAt = new Date().toISOString()
  if (pending.action === 'acknowledge') {
    if (pending.claimLedgerKey && ledger.claims[pending.claimLedgerKey]) {
      ledger.claims[pending.claimLedgerKey] = {
        ...ledger.claims[pending.claimLedgerKey],
        state: 'acknowledged',
        acknowledgedAt: completedAt,
      }
    }
    if (pending.deliveryLedgerKey && ledger.deliveries[pending.deliveryLedgerKey]) {
      ledger.deliveries[pending.deliveryLedgerKey] = {
        ...ledger.deliveries[pending.deliveryLedgerKey],
        state: 'acknowledged',
        acknowledgedAt: completedAt,
      }
    }
  } else {
    if (pending.claimLedgerKey && ledger.claims[pending.claimLedgerKey]) {
      ledger.claims[pending.claimLedgerKey] = {
        ...ledger.claims[pending.claimLedgerKey],
        serverResultConfirmed: true,
        serverResultConfirmedAt: completedAt,
      }
    }
    if (pending.deliveryLedgerKey && ledger.deliveries[pending.deliveryLedgerKey]) {
      ledger.deliveries[pending.deliveryLedgerKey] = {
        ...ledger.deliveries[pending.deliveryLedgerKey],
        serverResultConfirmed: true,
        serverResultConfirmedAt: completedAt,
      }
    }
  }
  delete ledger.pendingResults[identifier]
  await writeLedger(ledger)
  log('job_result_submitted', {
    action: pending.action,
    jobGlobalId: pending.jobGlobalId,
    replayed,
    resent: false,
  })
  return true
}

async function replayPendingResults(config, ledger) {
  for (const identifier of Object.keys(ledger.pendingResults).sort()) {
    await submitPendingResult(config, ledger, identifier, { replayed: true })
  }
}

async function recordSafePreDeliveryFailure(
  config,
  ledger,
  job,
  key,
  immutableKey,
  {
    errorCode = 'PRINT_CLAIM_LEASE_TOO_SHORT',
    errorMessage = 'The authoritative claim lease was too close to expiration for safe raw delivery; zero bytes were sent',
    retryAfterSeconds = 0,
    event = 'job_lease_too_short',
  } = {},
) {
  const failedAt = new Date().toISOString()
  ledger.claims[key] = {
    ...(ledger.claims[key] || deliveryRecord(job, 'delivery_failed', {
      claimToken: job.claimToken,
      claimExpiresAt: claimExpiry(job),
    })),
    state: 'delivery_failed',
    failedAt,
    acceptedBytes: 0,
    deliveryStarted: false,
  }
  ledger.deliveries[immutableKey] = {
    ...(ledger.deliveries[immutableKey] || deliveryRecord(job, 'delivery_failed')),
    state: 'delivery_failed',
    failedAt,
    acceptedBytes: 0,
    deliveryStarted: false,
  }
  const failure = failurePayload(job, {
    errorCode,
    errorMessage,
    retryable: true,
    printerUnavailable: false,
    retryAfterSeconds,
  })
  const pending = queuePendingResult(
    ledger,
    job,
    'fail',
    failure,
    { claimLedgerKey: key, deliveryLedgerKey: immutableKey },
  )
  await writeLedger(ledger)
  await submitPendingResult(config, ledger, pending)
  log(event, {
    jobGlobalId: job.globalId,
    acceptedBytes: 0,
    deliveryStarted: false,
  })
}

async function handleJob(config, ledger, job, deviceReference) {
  claimExpiry(job)
  let key
  let immutableKey
  try {
    key = claimKey(job)
    immutableKey = deliveryKey(job)
  } catch (error) {
    if (!job?.globalId || !job?.claimToken) throw error
    ledger.claims[key] = {
      jobGlobalId: job.globalId,
      claimToken: job.claimToken,
      state: 'delivery_failed',
      failedAt: new Date().toISOString(),
      acceptedBytes: 0,
      deliveryStarted: false,
      serverResultConfirmed: false,
    }
    const payload = failurePayload(job, {
      errorCode: 'PRINT_ARTIFACT_INVALID',
      errorMessage: error.message,
      retryable: false,
      printerUnavailable: false,
    })
    const pending = queuePendingResult(ledger, job, 'fail', payload, {
      claimLedgerKey: key,
    })
    await writeLedger(ledger)
    await submitPendingResult(config, ledger, pending)
    log('job_rejected', { jobGlobalId: job.globalId, reason: error.message })
    return
  }
  const currentClaim = ledger.claims[key]
  const previous = priorDelivery(ledger, job, immutableKey)
  if (currentClaim?.state === 'acknowledged') {
    log('claim_already_acknowledged', { jobGlobalId: job.globalId })
    return
  }
  if (previous?.state === 'delivered' || previous?.state === 'acknowledged') {
    ledger.claims[key] = {
      ...deliveryRecord(job, 'delivered', {
        claimToken: job.claimToken,
        claimExpiresAt: claimExpiry(job),
        recoveredWithoutResend: true,
      }),
    }
    ledger.deliveries[immutableKey] = {
      ...deliveryRecord(job, 'delivered', {
        deliveredAt: previous.deliveredAt,
        acceptedBytes: previous.acceptedBytes,
      }),
    }
    const pending = queuePendingResult(
      ledger,
      job,
      'acknowledge',
      acknowledgementPayload(job, deviceReference),
      { claimLedgerKey: key, deliveryLedgerKey: immutableKey },
    )
    await writeLedger(ledger)
    await submitPendingResult(config, ledger, pending)
    log('job_acknowledged', {
      jobGlobalId: job.globalId,
      recovered: true,
      resent: false,
    })
    return
  }
  if (previous?.state === 'sending' || previous?.state === 'outcome_uncertain') {
    const failedAt = new Date().toISOString()
    ledger.claims[key] = {
      ...deliveryRecord(job, 'outcome_uncertain', {
        claimToken: job.claimToken,
        failedAt,
        acceptedBytes: previous.acceptedBytes,
      }),
    }
    ledger.deliveries[immutableKey] = {
      ...deliveryRecord(job, 'outcome_uncertain', {
        startedAt: previous.startedAt,
        failedAt,
        acceptedBytes: previous.acceptedBytes,
      }),
    }
    const payload = failurePayload(job, {
      errorCode: 'PRINT_OUTCOME_UNCERTAIN',
      errorMessage: 'Delivery previously began for this immutable artifact; automatic resend was fenced',
      retryable: false,
      printerUnavailable: false,
    })
    const pending = queuePendingResult(
      ledger,
      job,
      'fail',
      payload,
      { claimLedgerKey: key, deliveryLedgerKey: immutableKey },
    )
    await writeLedger(ledger)
    await submitPendingResult(config, ledger, pending)
    log('job_outcome_uncertain', {
      jobGlobalId: job.globalId,
      recovered: true,
      resent: false,
    })
    return
  }

  let payload
  try {
    payload = decodeAndVerify(job)
  } catch (error) {
    const failedAt = new Date().toISOString()
    ledger.claims[key] = {
      ...deliveryRecord(job, 'delivery_failed', {
        claimToken: job.claimToken,
        claimExpiresAt: claimExpiry(job),
        failedAt,
        acceptedBytes: 0,
        deliveryStarted: false,
        serverResultConfirmed: false,
      }),
    }
    ledger.deliveries[immutableKey] = deliveryRecord(job, 'delivery_failed', {
      failedAt,
      acceptedBytes: 0,
      deliveryStarted: false,
      serverResultConfirmed: false,
    })
    const failure = failurePayload(job, {
      errorCode: 'PRINT_ARTIFACT_INVALID',
      errorMessage: error.message,
      retryable: false,
      printerUnavailable: false,
    })
    const pending = queuePendingResult(ledger, job, 'fail', failure, {
      claimLedgerKey: key,
      deliveryLedgerKey: immutableKey,
    })
    await writeLedger(ledger)
    await submitPendingResult(config, ledger, pending)
    log('job_rejected', { jobGlobalId: job.globalId, reason: error.message })
    return
  }

  try {
    assertClaimLease(job)
  } catch (error) {
    if (error?.code !== 'PRINT_CLAIM_LEASE_TOO_SHORT') throw error
    await recordSafePreDeliveryFailure(config, ledger, job, key, immutableKey)
    return
  }

  ledger.claims[key] = {
    ...deliveryRecord(job, 'sending', {
      claimToken: job.claimToken,
      claimExpiresAt: claimExpiry(job),
      startedAt: new Date().toISOString(),
    }),
  }
  ledger.deliveries[immutableKey] = deliveryRecord(job, 'sending', {
    startedAt: ledger.claims[key].startedAt,
  })
  await writeLedger(ledger)

  applyTestClockAdvanceBeforeRaw()
  try {
    assertClaimLease(job)
  } catch (error) {
    if (error?.code !== 'PRINT_CLAIM_LEASE_TOO_SHORT') throw error
    await recordSafePreDeliveryFailure(config, ledger, job, key, immutableKey)
    return
  }

  let result
  try {
    result = await submitRaw(payload, job)
  } catch (error) {
    const disposition = rawPrintFailureDisposition(error)
    if (
      error?.code === 'PRINT_CLAIM_LEASE_TOO_SHORT'
      && disposition.acceptedBytes === 0
      && disposition.deliveryStarted === false
    ) {
      await recordSafePreDeliveryFailure(config, ledger, job, key, immutableKey)
      return
    }
    if (
      error?.code === 'LOCAL_PRINTER_BUSY'
      && disposition.acceptedBytes === 0
      && disposition.deliveryStarted === false
    ) {
      await recordSafePreDeliveryFailure(config, ledger, job, key, immutableKey, {
        errorCode: 'LOCAL_PRINTER_BUSY',
        errorMessage: 'Another paired workspace is using this shared Zebra endpoint; zero bytes were sent',
        retryAfterSeconds: 2,
        event: 'job_printer_busy',
      })
      return
    }
    const { acceptedBytes, deliveryStarted, retryable } = disposition
    const state = retryable ? 'delivery_failed' : 'outcome_uncertain'
    const failedAt = new Date().toISOString()
    ledger.claims[key] = {
      ...ledger.claims[key],
      state,
      failedAt,
      acceptedBytes,
      deliveryStarted,
    }
    ledger.deliveries[immutableKey] = {
      ...ledger.deliveries[immutableKey],
      state,
      failedAt,
      acceptedBytes,
      deliveryStarted,
    }
    const failure = failurePayload(job, {
      errorCode: retryable ? 'PRINTER_UNAVAILABLE' : 'PRINT_OUTCOME_UNCERTAIN',
      errorMessage: retryable
        ? 'The configured local printer did not accept the artifact'
        : 'Printer delivery began but completion could not be proven; automatic resend was fenced',
      retryable,
      printerUnavailable: retryable,
      retryAfterSeconds: retryable ? 10 : 0,
    })
    const pending = queuePendingResult(
      ledger,
      job,
      'fail',
      failure,
      { claimLedgerKey: key, deliveryLedgerKey: immutableKey },
    )
    await writeLedger(ledger)
    await submitPendingResult(config, ledger, pending)
    log('job_failed', {
      jobGlobalId: job.globalId,
      retryable,
      acceptedBytes,
      deliveryStarted,
    })
    return
  }

  const deliveredAt = new Date().toISOString()
  ledger.claims[key] = {
    ...ledger.claims[key],
    state: 'delivered',
    deliveredAt,
    acceptedBytes: result.acceptedBytes,
  }
  ledger.deliveries[immutableKey] = {
    ...ledger.deliveries[immutableKey],
    state: 'delivered',
    deliveredAt,
    acceptedBytes: result.acceptedBytes,
  }
  const pending = queuePendingResult(
    ledger,
    job,
    'acknowledge',
    acknowledgementPayload(job, deviceReference),
    { claimLedgerKey: key, deliveryLedgerKey: immutableKey },
  )
  await writeLedger(ledger)
  try {
    const confirmed = await submitPendingResult(config, ledger, pending)
    if (!confirmed) {
      log('job_server_recovery_required', {
        jobGlobalId: job.globalId,
        delivered: true,
        resent: false,
      })
      return
    }
  } catch (error) {
    log('job_acknowledgement_pending', {
      jobGlobalId: job.globalId,
      delivered: true,
      resent: false,
    })
    throw error
  }
  log('job_acknowledged', {
    jobGlobalId: job.globalId,
    printerGlobalId: job.printer?.globalId,
    bytes: result.acceptedBytes,
  })
}

async function cycle(config, ledger, deviceReference) {
  await replayPendingResults(config, ledger)
  const claimId = `claim:${randomUUID()}`
  let response
  try {
    response = await agentRequest(config, 'claim', {
      limit: 1,
      leaseSeconds: 120,
      capabilities: activeWorkerCapabilities,
    }, `${claimId}:${activeWorkerCapabilities === workerCapabilities
      ? 'bundled-v2'
      : 'legacy-shipping'}`)
  } catch (error) {
    if (
      activeWorkerCapabilities !== workerCapabilities
      || error?.code !== 'OPERATIONS_PRINT_AGENT_CAPABILITIES_MISMATCH'
    ) throw error
    activeWorkerCapabilities = legacyWorkerCapabilities
    response = await agentRequest(config, 'claim', {
      limit: 1,
      leaseSeconds: 120,
      capabilities: activeWorkerCapabilities,
    }, `${claimId}:legacy-shipping`)
    log('legacy_enrollment_capability_fallback', {
      detail: 'Upgrade this enrolled agent in ClawPilot to claim bundled barcode-label jobs',
    })
  }
  const jobs = Array.isArray(response.jobs) ? response.jobs : []
  if (jobs[0]) {
    registerClaimLease(jobs[0], response[REQUEST_ROUND_TRIP_MS], 120)
    await handleJob(config, ledger, jobs[0], deviceReference)
  }
  return jobs.length
}

async function main() {
  log('worker_started', { pid: process.pid })
  if (probeOnly) {
    if (!printerHost) throw new Error('CLAWPILOT_PRINTER_HOST is required')
    normalizedLocalPrinterEndpoint(printerHost, printerPort)
    await probePrinter()
    log('printer_reachable')
    return
  }
  const config = assertConfiguration()
  const ledger = await readLedger()
  const deviceKey = await readOrCreateLocalDeviceKey(deviceKeyPath)
  const deviceReference = opaqueLocalDeviceReference({
    key: deviceKey,
    host: printerHost,
    port: printerPort,
  })
  let stopping = false
  process.once('SIGINT', () => { stopping = true })
  process.once('SIGTERM', () => { stopping = true })
  do {
    try {
      const count = await cycle(config, ledger, deviceReference)
      if (once) return
      await new Promise((resolvePromise) => setTimeout(
        resolvePromise,
        count ? 50 : pollIntervalMs,
      ))
    } catch (error) {
      log('poll_failed', { message: error.message })
      if (once) throw error
      await new Promise((resolvePromise) => setTimeout(resolvePromise, pollIntervalMs))
    }
  } while (!stopping)
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
})
