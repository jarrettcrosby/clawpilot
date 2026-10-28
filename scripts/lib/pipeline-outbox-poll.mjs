const MAX_LOG_COUNTER = 1_000_000

const ACTION_COUNTERS = ['claimed', 'processed', 'succeeded', 'failed', 'dead', 'cancelled']
const INGESTION_COUNTERS = [
  'activeMailboxes', 'mailboxesPolled', 'pendingMailboxes', 'messagesListed',
  'messagesFetched', 'authMessagesSkipped', 'messagesStored', 'duplicateMessages',
  'markerReferences', 'invalidReferences', 'senderMatches', 'archiveMessages',
  'archiveMatches', 'unmatchedMessages', 'interactions', 'links', 'errors',
]

function safeCounter(value) {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0
    ? Math.min(value, MAX_LOG_COUNTER)
    : 0
}

function counters(value, fields) {
  return Object.fromEntries(fields.map(field => [field, safeCounter(value?.[field])]))
}

function crmSummary(result) {
  return {
    actions: counters(result?.actions, ACTION_COUNTERS),
    ingestion: counters(result?.ingestion, INGESTION_COUNTERS),
  }
}

/** Keep the real request/logging path testable without starting worker loops. */
export function createPipelineOutboxPoll({ baseUrl, secret, fetchImpl = globalThis.fetch, logger = console }) {
  return async function poll(name, path, limit) {
    const isCrmIntegration = name === 'crm-integrations'
    let status = 0
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secret}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ limit }),
      })
      status = safeCounter(response.status)
      const text = await response.text()
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`)
      const result = text ? JSON.parse(text) : {}
      const claimed = Number(result.claimed || result.actions?.claimed || 0)
        + Number(result.mail?.claimed || 0)
      const ingested = Number(result.ingested || result.ingestion?.messagesStored || 0)
      if (isCrmIntegration) {
        // Never include response text, identities, provider errors, or endpoints
        // in CRM diagnostics, including when a partial failure also did work.
        const summary = crmSummary(result)
        if (summary.ingestion.errors > 0) {
          logger.warn(`[crm-integrations] ingestion errors: ${JSON.stringify(summary)}`)
        } else if (summary.actions.claimed > 0 || summary.ingestion.messagesStored > 0) {
          logger.log(`[crm-integrations] ${JSON.stringify(summary)}`)
        }
      } else if (claimed > 0 || ingested > 0) {
        logger.log(`[${name}] ${JSON.stringify(result)}`)
      }
      return true
    } catch (error) {
      if (isCrmIntegration) {
        logger.warn(`[crm-integrations] poll failed: ${JSON.stringify({ status })}`)
      } else {
        logger.warn(`[${name}] poll failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      return false
    }
  }
}
