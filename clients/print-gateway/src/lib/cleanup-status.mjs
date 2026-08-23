const JOB_GLOBAL_ID = /^gpj(?:[0-9]{7}|[0-9a-v]{12})$/
const DOCUMENT_GLOBAL_ID = /^gpf(?:[0-9]{7}|[0-9a-v]{12})$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA256 = /^[a-f0-9]{64}$/
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,200}$/
const RUNTIME_CREDENTIAL = /^cpprint\.v1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/i

const RESOLUTIONS = Object.freeze({
  delivered: Object.freeze({
    removalSafe: true,
    reasonCode: 'SERVER_DELIVERY_CONFIRMED',
  }),
  failed_zero_byte_confirmed: Object.freeze({
    removalSafe: true,
    reasonCode: 'SERVER_ZERO_BYTE_FAILURE_CONFIRMED',
  }),
  outcome_uncertain_terminal: Object.freeze({
    removalSafe: true,
    reasonCode: 'SERVER_OUTCOME_UNCERTAIN_TERMINAL',
  }),
  in_flight: Object.freeze({
    removalSafe: false,
    reasonCode: 'SERVER_CLAIM_IN_FLIGHT',
  }),
  unresolved: Object.freeze({
    removalSafe: false,
    reasonCode: 'SERVER_CLAIM_UNRESOLVED',
  }),
})

function assertCleanupEntry(entry) {
  if (
    !entry
    || Object.keys(entry).sort().join(',') !== [
      'claimToken',
      'contentSha256',
      'documentGlobalId',
      'jobGlobalId',
    ].join(',')
    || !JOB_GLOBAL_ID.test(entry.jobGlobalId)
    || !UUID.test(entry.claimToken)
    || !DOCUMENT_GLOBAL_ID.test(entry.documentGlobalId)
    || !SHA256.test(entry.contentSha256)
  ) throw new Error('The local cleanup artifact identity is invalid')
  return {
    jobGlobalId: entry.jobGlobalId.toLowerCase(),
    claimToken: entry.claimToken.toLowerCase(),
    documentGlobalId: entry.documentGlobalId.toLowerCase(),
    contentSha256: entry.contentSha256.toLowerCase(),
  }
}

function assertCleanupEntries(entries) {
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 128) {
    throw new Error('The local cleanup request must contain 1 to 128 exact artifacts')
  }
  const normalized = entries.map(assertCleanupEntry)
  const identities = normalized.map((entry) => `${entry.jobGlobalId}:${entry.claimToken}`)
  if (new Set(identities).size !== identities.length) {
    throw new Error('The local cleanup artifact identities are duplicated')
  }
  return normalized
}

function unsafeResolutionMessage(entry) {
  if (entry.reasonCode === 'SERVER_CLAIM_IN_FLIGHT') {
    return 'ClawPilot still has an active exact print claim. Nothing was removed; wait for it to finish or revoke the server agent, then retry.'
  }
  return 'ClawPilot could not prove an exact terminal result for every local claim. Nothing was removed; keep this instance and contact support with diagnostics.'
}

export function assertCleanupStatusRemovalSafe(cleanupStatus) {
  const unsafe = cleanupStatus?.entries?.find((entry) => entry.removalSafe !== true)
  if (unsafe) throw new Error(unsafeResolutionMessage(unsafe))
  if (!Array.isArray(cleanupStatus?.entries) || cleanupStatus.entries.length < 1) {
    throw new Error('ClawPilot returned no cleanup evidence; nothing was removed')
  }
  return cleanupStatus
}

export async function requestInstanceCleanupStatus({
  baseUrl,
  runtimeCredential,
  entries,
  idempotencyKey,
  fetchImplementation = fetch,
}) {
  const normalizedEntries = assertCleanupEntries(entries)
  if (!RUNTIME_CREDENTIAL.test(String(runtimeCredential || ''))) {
    throw new Error('The local cleanup credential is invalid')
  }
  if (!IDEMPOTENCY_KEY.test(String(idempotencyKey || ''))) {
    throw new Error('The local cleanup request identity is invalid')
  }
  let response
  try {
    response = await fetchImplementation(
      `${baseUrl}/api/operations/print-agent/cleanup-status`,
      {
        method: 'POST',
        redirect: 'error',
        headers: {
          authorization: `Bearer ${runtimeCredential}`,
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify({ entries: normalizedEntries }),
        signal: AbortSignal.timeout(20_000),
      },
    )
  } catch {
    throw new Error('ClawPilot could not verify server cleanup. Nothing was removed; reconnect and retry this exact request.')
  }
  let result
  try { result = await response.json() } catch { /* handled below */ }
  if (!response.ok) {
    throw new Error('ClawPilot did not authorize exact local cleanup. Nothing was removed; verify this agent in Operations > Printing > Agents.')
  }
  if (result?.ok !== true) {
    throw new Error('ClawPilot returned invalid cleanup evidence; nothing was removed')
  }
  if (
    Object.keys(result).sort().join(',') !== 'entries,ok'
    || !Array.isArray(result.entries)
    || result.entries.length !== normalizedEntries.length
  ) throw new Error('ClawPilot returned invalid cleanup evidence; nothing was removed')

  const resolved = result.entries.map((entry, index) => {
    const expected = RESOLUTIONS[entry?.resolution]
    if (
      !expected
      || Object.keys(entry).sort().join(',') !== 'reasonCode,removalSafe,resolution'
      || entry.removalSafe !== expected.removalSafe
      || entry.reasonCode !== expected.reasonCode
    ) throw new Error('ClawPilot returned contradictory cleanup evidence; nothing was removed')
    return { ...normalizedEntries[index], ...entry }
  })
  return {
    version: 1,
    idempotencyKey,
    entries: resolved,
  }
}
