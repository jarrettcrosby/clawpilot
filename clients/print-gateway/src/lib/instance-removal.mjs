import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs'
import path from 'node:path'

const JOB_GLOBAL_ID = /^gpj(?:[0-9]{7}|[0-9a-v]{12})$/
const DOCUMENT_GLOBAL_ID = /^gpf(?:[0-9]{7}|[0-9a-v]{12})$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA256 = /^[a-f0-9]{64}$/
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,200}$/
const SAFE_CLEANUP_RESULTS = Object.freeze({
  delivered: 'SERVER_DELIVERY_CONFIRMED',
  failed_zero_byte_confirmed: 'SERVER_ZERO_BYTE_FAILURE_CONFIRMED',
  outcome_uncertain_terminal: 'SERVER_OUTCOME_UNCERTAIN_TERMINAL',
})

function readLedger(instanceDirectory) {
  const ledgerPath = path.join(instanceDirectory, 'claim-ledger.json')
  if (!existsSync(ledgerPath)) return null
  let ledger
  try {
    ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'))
  } catch {
    throw new Error('Local delivery history is unreadable; removal is blocked to prevent a duplicate print')
  }
  if (
    ledger?.version !== 1
    || !ledger.claims
    || typeof ledger.claims !== 'object'
    || Array.isArray(ledger.claims)
    || !ledger.deliveries
    || typeof ledger.deliveries !== 'object'
    || Array.isArray(ledger.deliveries)
    || !ledger.pendingResults
    || typeof ledger.pendingResults !== 'object'
    || Array.isArray(ledger.pendingResults)
  ) {
    throw new Error('Local delivery-result history is invalid; removal is blocked to preserve server recovery evidence')
  }
  return { ledgerPath, ledger }
}

function writeAll(descriptor, bytes, failureMessage) {
  let offset = 0
  while (offset < bytes.byteLength) {
    const written = writeSync(descriptor, bytes, offset, bytes.byteLength - offset)
    if (!Number.isSafeInteger(written) || written < 1) throw new Error(failureMessage)
    offset += written
  }
}

function syncDirectory(directory) {
  if (process.platform === 'win32') return
  const descriptor = openSync(directory, 'r')
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

function durableReplace(pathname, bytes) {
  const temporary = `${pathname}.${process.pid}.${randomUUID()}.tmp`
  let descriptor
  try {
    descriptor = openSync(temporary, 'wx', 0o600)
    writeAll(descriptor, bytes, 'The cleanup ledger write did not make forward progress')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temporary, pathname)
    descriptor = openSync(pathname, 'r+')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    syncDirectory(path.dirname(pathname))
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor) } catch { /* preserve original failure */ }
    }
    try { rmSync(temporary, { force: true }) } catch { /* preserve original failure */ }
    throw error
  }
}

function durableWriteLedger(loaded) {
  durableReplace(
    loaded.ledgerPath,
    Buffer.from(`${JSON.stringify(loaded.ledger, null, 2)}\n`, 'utf8'),
  )
}

function artifactIdentity(record) {
  const entry = {
    jobGlobalId: String(record?.jobGlobalId || '').toLowerCase(),
    claimToken: String(record?.claimToken || '').toLowerCase(),
    documentGlobalId: String(record?.documentGlobalId || '').toLowerCase(),
    contentSha256: String(record?.contentSha256 || '').toLowerCase(),
  }
  if (
    !JOB_GLOBAL_ID.test(entry.jobGlobalId)
    || !UUID.test(entry.claimToken)
    || !DOCUMENT_GLOBAL_ID.test(entry.documentGlobalId)
    || !SHA256.test(entry.contentSha256)
  ) {
    throw new Error('Local claim artifact identity is invalid; removal is blocked to preserve server recovery evidence')
  }
  return entry
}

function exactEntry(value) {
  if (
    !value
    || Object.keys(value).sort().join(',') !== 'claimToken,contentSha256,documentGlobalId,jobGlobalId'
  ) throw new Error('The durable cleanup request is invalid')
  return artifactIdentity(value)
}

function entryIdentity(entry) {
  return `${entry.jobGlobalId}:${entry.claimToken}`
}

function artifactKey(entry) {
  return `${entry.jobGlobalId}:${entry.documentGlobalId}:${entry.contentSha256}`
}

function sameEntries(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function recordIsLocallyRemovable(record) {
  if (record?.state === 'acknowledged') return true
  if (record?.state === 'delivery_failed') return record.serverResultConfirmed === true
  return record?.state === 'outcome_uncertain'
    && record.serverResultConfirmed === true
    && record.cleanupRemovalSafe === true
    && record.cleanupResolution === 'outcome_uncertain_terminal'
    && record.cleanupReasonCode === 'SERVER_OUTCOME_UNCERTAIN_TERMINAL'
}

function cleanupEntriesFromLedger(ledger) {
  const entries = []
  const seen = new Set()
  for (const record of Object.values(ledger.claims)) {
    if (recordIsLocallyRemovable(record)) continue
    const entry = artifactIdentity(record)
    const identity = entryIdentity(entry)
    if (!seen.has(identity)) {
      seen.add(identity)
      entries.push(entry)
    }
  }
  const artifacts = new Set(entries.map(artifactKey))
  for (const record of Object.values(ledger.deliveries)) {
    if (recordIsLocallyRemovable(record)) continue
    const key = artifactKey({
      jobGlobalId: String(record?.jobGlobalId || '').toLowerCase(),
      documentGlobalId: String(record?.documentGlobalId || '').toLowerCase(),
      contentSha256: String(record?.contentSha256 || '').toLowerCase(),
    })
    if (!artifacts.has(key)) {
      throw new Error('Local delivery evidence has no exact claim identity; removal is blocked')
    }
  }
  for (const pending of Object.values(ledger.pendingResults)) {
    const identity = `${String(pending?.jobGlobalId || '').toLowerCase()}:${String(pending?.claimToken || '').toLowerCase()}`
    if (!seen.has(identity)) {
      throw new Error('A pending server result has no exact local artifact identity; removal is blocked')
    }
  }
  if (entries.length > 128) throw new Error('This instance has too much unresolved history for automatic cleanup; contact support')
  return entries.sort((left, right) => entryIdentity(left).localeCompare(entryIdentity(right), 'en'))
}

function assertCleanupRequest(value) {
  if (
    !value
    || value.version !== 1
    || Object.keys(value).sort().join(',') !== 'entries,idempotencyKey,preparedAt,version'
    || !IDEMPOTENCY_KEY.test(String(value.idempotencyKey || ''))
    || !Number.isFinite(Date.parse(value.preparedAt))
    || !Array.isArray(value.entries)
    || value.entries.length < 1
    || value.entries.length > 128
  ) throw new Error('The durable cleanup request is invalid')
  const entries = value.entries.map(exactEntry)
  if (new Set(entries.map(entryIdentity)).size !== entries.length) {
    throw new Error('The durable cleanup request contains duplicate claims')
  }
  return { ...value, entries }
}

function assertCleanupResolution(value) {
  if (
    !value
    || value.version !== 1
    || Object.keys(value).sort().join(',') !== 'entries,idempotencyKey,resolvedAt,version'
    || !IDEMPOTENCY_KEY.test(String(value.idempotencyKey || ''))
    || !Number.isFinite(Date.parse(value.resolvedAt))
    || !Array.isArray(value.entries)
    || value.entries.length < 1
    || value.entries.some((entry) => !cleanupResultIsSafeAndExact(entry))
  ) throw new Error('The durable server cleanup proof is invalid')
  return value
}

function cleanupResultIsSafeAndExact(entry) {
  return entry?.removalSafe === true
    && SAFE_CLEANUP_RESULTS[entry.resolution] === entry.reasonCode
    && Object.keys(entry).sort().join(',') === [
      'claimToken',
      'contentSha256',
      'documentGlobalId',
      'jobGlobalId',
      'reasonCode',
      'removalSafe',
      'resolution',
    ].join(',')
    && (() => {
      try {
        exactEntry({
          jobGlobalId: entry.jobGlobalId,
          claimToken: entry.claimToken,
          documentGlobalId: entry.documentGlobalId,
          contentSha256: entry.contentSha256,
        })
        return true
      } catch {
        return false
      }
    })()
}

export function instanceCleanupEntries(instanceDirectory) {
  const loaded = readLedger(instanceDirectory)
  return loaded ? cleanupEntriesFromLedger(loaded.ledger) : []
}

export function assertInstanceLedgerCanRun(instanceDirectory) {
  const loaded = readLedger(instanceDirectory)
  if (loaded?.ledger.cleanupRequest || loaded?.ledger.cleanupResolution) {
    throw new Error('Local removal reconciliation is pending; finish or retry removal before starting this instance')
  }
}

export function prepareInstanceCleanupRequest(instanceDirectory) {
  const loaded = readLedger(instanceDirectory)
  if (!loaded) throw new Error('Local delivery history is missing; cleanup cannot be proven')
  const entries = cleanupEntriesFromLedger(loaded.ledger)
  if (entries.length === 0) throw new Error('No exact unresolved local claim requires server cleanup')
  if (loaded.ledger.cleanupRequest) {
    const existing = assertCleanupRequest(loaded.ledger.cleanupRequest)
    if (!sameEntries(existing.entries, entries)) {
      throw new Error('Local delivery history changed after cleanup was prepared; removal is blocked')
    }
    return existing
  }
  const request = {
    version: 1,
    idempotencyKey: `cleanup:${randomUUID()}`,
    entries,
    preparedAt: new Date().toISOString(),
  }
  loaded.ledger.cleanupRequest = request
  durableWriteLedger(loaded)
  return request
}

export function abandonInstanceCleanupRequest(instanceDirectory, idempotencyKey) {
  const loaded = readLedger(instanceDirectory)
  if (!loaded?.ledger.cleanupRequest) return
  const current = assertCleanupRequest(loaded.ledger.cleanupRequest)
  if (current.idempotencyKey !== idempotencyKey) {
    throw new Error('The local cleanup request changed; removal is blocked')
  }
  delete loaded.ledger.cleanupRequest
  durableWriteLedger(loaded)
}

function reconciledRecord(record, result, resolvedAt) {
  const common = {
    ...record,
    serverResultConfirmed: true,
    serverResultConfirmedAt: resolvedAt,
    cleanupRemovalSafe: true,
    cleanupResolution: result.resolution,
    cleanupReasonCode: result.reasonCode,
    cleanupResolvedAt: resolvedAt,
  }
  if (result.resolution === 'delivered') {
    return { ...common, state: 'acknowledged', acknowledgedAt: resolvedAt }
  }
  if (result.resolution === 'failed_zero_byte_confirmed') {
    return {
      ...common,
      state: 'delivery_failed',
      acceptedBytes: 0,
      deliveryStarted: false,
    }
  }
  return { ...common, state: 'outcome_uncertain' }
}

export function commitInstanceCleanupResolution(instanceDirectory, cleanupStatus) {
  const loaded = readLedger(instanceDirectory)
  if (!loaded) throw new Error('Local delivery history is missing; cleanup cannot be committed')
  const request = assertCleanupRequest(loaded.ledger.cleanupRequest)
  if (
    cleanupStatus?.version !== 1
    || Object.keys(cleanupStatus).sort().join(',') !== 'entries,idempotencyKey,version'
    || cleanupStatus.idempotencyKey !== request.idempotencyKey
    || !Array.isArray(cleanupStatus.entries)
    || cleanupStatus.entries.length !== request.entries.length
    || cleanupStatus.entries.some((entry) => !cleanupResultIsSafeAndExact(entry))
    || !sameEntries(
      cleanupStatus.entries.map(({ jobGlobalId, claimToken, documentGlobalId, contentSha256 }) => ({
        jobGlobalId,
        claimToken,
        documentGlobalId,
        contentSha256,
      })),
      request.entries,
    )
  ) throw new Error('ClawPilot cleanup evidence does not match the durable local request')

  const resolvedAt = new Date().toISOString()
  for (const result of cleanupStatus.entries) {
    let claimMatches = 0
    for (const [key, record] of Object.entries(loaded.ledger.claims)) {
      if (
        String(record?.jobGlobalId || '').toLowerCase() === result.jobGlobalId
        && String(record?.claimToken || '').toLowerCase() === result.claimToken
        && String(record?.documentGlobalId || '').toLowerCase() === result.documentGlobalId
        && String(record?.contentSha256 || '').toLowerCase() === result.contentSha256
      ) {
        loaded.ledger.claims[key] = reconciledRecord(record, result, resolvedAt)
        claimMatches += 1
      }
    }
    let deliveryMatches = 0
    for (const [key, record] of Object.entries(loaded.ledger.deliveries)) {
      if (
        String(record?.jobGlobalId || '').toLowerCase() === result.jobGlobalId
        && String(record?.documentGlobalId || '').toLowerCase() === result.documentGlobalId
        && String(record?.contentSha256 || '').toLowerCase() === result.contentSha256
      ) {
        loaded.ledger.deliveries[key] = reconciledRecord(record, result, resolvedAt)
        deliveryMatches += 1
      }
    }
    if (claimMatches < 1 || deliveryMatches < 1) {
      throw new Error('ClawPilot cleanup evidence does not cover the exact local claim and delivery')
    }
    for (const [key, pending] of Object.entries(loaded.ledger.pendingResults)) {
      if (
        String(pending?.jobGlobalId || '').toLowerCase() === result.jobGlobalId
        && String(pending?.claimToken || '').toLowerCase() === result.claimToken
      ) delete loaded.ledger.pendingResults[key]
    }
  }
  loaded.ledger.cleanupResolution = {
    ...cleanupStatus,
    resolvedAt,
  }
  delete loaded.ledger.cleanupRequest
  durableWriteLedger(loaded)
  return loaded.ledger.cleanupResolution
}

export function readInstanceCleanupResolution(instanceDirectory) {
  const loaded = readLedger(instanceDirectory)
  if (!loaded?.ledger.cleanupResolution) return null
  return assertCleanupResolution(loaded.ledger.cleanupResolution)
}

export function assertInstanceLedgerCanBeRemoved(instanceDirectory) {
  const loaded = readLedger(instanceDirectory)
  if (!loaded) return
  const { ledger } = loaded
  if (Object.keys(ledger.pendingResults).length > 0) {
    throw new Error('This instance still has an unconfirmed server result; keep it paired until ClawPilot confirms the exact acknowledgement or failure')
  }
  for (const collection of [ledger.claims, ledger.deliveries]) {
    for (const record of Object.values(collection)) {
      if (!recordIsLocallyRemovable(record)) {
        throw new Error(
          'This instance has an in-flight or uncertain delivery. Resolve or revoke it in ClawPilot before removing local history.',
        )
      }
    }
  }
}

function durableWrite(pathname, bytes) {
  let descriptor
  try {
    descriptor = openSync(pathname, 'wx', 0o600)
    writeAll(descriptor, bytes, 'The cleanup archive write did not make forward progress')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor) } catch { /* preserve original failure */ }
    }
    throw error
  }
}

export function archiveResolvedInstance({
  dataDirectory,
  slug,
  cleanupStatus,
}) {
  const instancesRoot = path.resolve(dataDirectory, 'instances')
  const source = path.resolve(instancesRoot, slug)
  if (path.dirname(source) !== instancesRoot || !slug) {
    throw new Error('The local instance directory is outside the managed gateway root')
  }
  const ledgerPath = path.join(source, 'claim-ledger.json')
  if (!existsSync(ledgerPath)) {
    throw new Error('The local delivery history required for cleanup proof is missing')
  }
  const ledgerBytes = readFileSync(ledgerPath)
  let ledger
  try { ledger = JSON.parse(ledgerBytes.toString('utf8')) } catch {
    throw new Error('The local delivery history required for cleanup proof is unreadable')
  }
  const durableResolution = assertCleanupResolution(ledger?.cleanupResolution)
  if (JSON.stringify(durableResolution) !== JSON.stringify(cleanupStatus)) {
    throw new Error('The cleanup archive does not match the durable server proof')
  }
  const archiveRoot = path.resolve(dataDirectory, 'retired-instances')
  mkdirSync(archiveRoot, { recursive: true, mode: 0o700 })
  const archive = path.join(archiveRoot, `${slug}-${randomUUID()}`)
  mkdirSync(archive, { recursive: false, mode: 0o700 })
  const proof = Buffer.from(`${JSON.stringify({
    version: 1,
    archivedAt: new Date().toISOString(),
    ledgerSha256: createHash('sha256').update(ledgerBytes).digest('hex'),
    cleanupStatus,
  }, null, 2)}\n`, 'utf8')
  durableWrite(path.join(archive, 'claim-ledger.json'), ledgerBytes)
  durableWrite(path.join(archive, 'server-cleanup-proof.json'), proof)
  syncDirectory(archive)
  syncDirectory(archiveRoot)
  return archive
}

export function removeInstanceDirectory({ dataDirectory, slug }) {
  const instancesRoot = path.resolve(dataDirectory, 'instances')
  const target = path.resolve(instancesRoot, slug)
  if (path.dirname(target) !== instancesRoot || !slug) {
    throw new Error('The local instance directory is outside the managed gateway root')
  }
  if (existsSync(target)) rmSync(target, { recursive: true, force: false })
}
