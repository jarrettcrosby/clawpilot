import {
  CareerSiteMailConfigurationError,
  CareerSiteMailRequestError,
  parseCareerSiteMailRequest,
  resolveCareerSiteMailConfiguration,
} from '@/lib/careerSiteMailContract'
import {
  CareerSiteMailProviderError,
  createCareerSiteMailDraft,
  findSentCareerSiteMail,
  sendCareerSiteMailDraft,
  verifyCareerSiteMailSender,
} from '@/lib/careerSiteMailDelivery'
import {
  claimCareerSiteMailOutboxInPostgres,
  completeCareerSiteMailOutboxInPostgres,
  failCareerSiteMailOutboxInPostgres,
  renewCareerSiteMailOutboxLeaseInPostgres,
  saveCareerSiteMailDraftInPostgres,
  type CareerSiteMailOutboxItem,
} from '@/lib/persistence/careerSiteMailOutbox'

function safeErrorMessage(error: unknown) {
  if (
    error instanceof CareerSiteMailProviderError
    || error instanceof CareerSiteMailRequestError
    || error instanceof CareerSiteMailConfigurationError
  ) {
    return `${error.name}: ${error.message}`.slice(0, 1000)
  }
  return 'CareerSiteMailOutboxError: email delivery failed'
}

async function findAlreadySent(item: CareerSiteMailOutboxItem) {
  await renewCareerSiteMailOutboxLeaseInPostgres(item)
  return findSentCareerSiteMail(item.rfcMessageId)
}

export async function processCareerSiteMailOutbox(input: {
  maxAttempts?: number
} = {}) {
  const configuration = resolveCareerSiteMailConfiguration()
  if (!configuration.enabled || !configuration.ownerEmail) {
    return { claimed: 0, succeeded: 0, failed: 0, dead: 0, items: [] }
  }
  await verifyCareerSiteMailSender(configuration)
  const maxAttempts = Math.max(1, Math.min(Math.trunc(Number(input.maxAttempts) || 8), 20))
  const items = await claimCareerSiteMailOutboxInPostgres({
    sourceApp: configuration.sourceApp,
    ownerEmail: configuration.ownerEmail,
    maxAttempts,
    leaseSeconds: 900,
  })
  const item = items[0]
  if (!item) return { claimed: 0, succeeded: 0, failed: 0, dead: 0, items: [] }

  try {
    item.request = parseCareerSiteMailRequest(item.request)
    const existingMessageId = await findAlreadySent(item)
    if (existingMessageId) {
      await completeCareerSiteMailOutboxInPostgres({ item, providerMessageId: existingMessageId })
      return {
        claimed: 1,
        succeeded: 1,
        failed: 0,
        dead: 0,
        items: [{ id: item.id, status: 'succeeded' as const }],
      }
    }

    let draftId = item.draftId
    if (!draftId) {
      await renewCareerSiteMailOutboxLeaseInPostgres(item)
      const draft = await createCareerSiteMailDraft({
        configuration,
        request: item.request,
        rfcMessageId: item.rfcMessageId,
      })
      draftId = await saveCareerSiteMailDraftInPostgres({ item, draftId: draft.draftId })
    }

    await renewCareerSiteMailOutboxLeaseInPostgres(item)
    let providerMessageId: string
    try {
      providerMessageId = await sendCareerSiteMailDraft(draftId)
    } catch (error) {
      if (
        error instanceof CareerSiteMailProviderError
        && (error.ambiguous || error.status === 404 || (error.status !== null && error.status >= 500))
      ) {
        const recoveredMessageId = await findAlreadySent(item)
        if (recoveredMessageId) {
          await completeCareerSiteMailOutboxInPostgres({ item, providerMessageId: recoveredMessageId })
          return {
            claimed: 1,
            succeeded: 1,
            failed: 0,
            dead: 0,
            items: [{ id: item.id, status: 'succeeded' as const, recovered: true }],
          }
        }
      }
      throw error
    }

    await completeCareerSiteMailOutboxInPostgres({ item, providerMessageId })
    return {
      claimed: 1,
      succeeded: 1,
      failed: 0,
      dead: 0,
      items: [{ id: item.id, status: 'succeeded' as const }],
    }
  } catch (error) {
    const status = await failCareerSiteMailOutboxInPostgres({
      item,
      error: safeErrorMessage(error),
      maxAttempts,
    })
    return {
      claimed: 1,
      succeeded: 0,
      failed: status === 'failed' ? 1 : 0,
      dead: status === 'dead' ? 1 : 0,
      items: [{ id: item.id, status }],
    }
  }
}
