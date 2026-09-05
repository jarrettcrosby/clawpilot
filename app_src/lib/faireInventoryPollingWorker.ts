import { createHash } from 'node:crypto'
import {
  decryptCommerceCredential,
} from '@/lib/integrations/commerceCredentialCrypto'
import {
  assertIntegrationCredentialProviderIoReady,
  isIntegrationCredentialRuntimeGateError,
} from '@/lib/integrations/integrationCredentialRuntimeGate.mjs'
import {
  CommerceIntegrationRequestError,
} from '@/lib/integrations/commerceIntegrations'
import {
  commerceReadCredentialEligible,
  commerceReadRuntimeAvailable,
} from '@/lib/integrations/commerceReadRuntime'
import {
  listFaireInventory,
  probeFaireBrandProfile,
  type FaireInventoryLevel,
} from '@/lib/integrations/faireCommerceClient'
import {
  claimFaireInventoryPollJobsInPostgres,
  completeFaireInventoryPollPageInPostgres,
  failFaireInventoryPollJobInPostgres,
  parkFaireInventoryPollForStoreSyncPauseInPostgres,
  parkFaireInventoryPollForRuntimeMaintenanceInPostgres,
  queueAutomaticFaireInventoryPollsInPostgres,
  readFaireInventoryPollSelectorsInPostgres,
  recordFaireInventoryPollWorkerHeartbeatInPostgres,
  withFaireInventoryPollProviderReadFenceInPostgres,
  type FaireInventoryObservation,
  type FaireInventoryPollSelector,
  type FaireInventoryPollTarget,
  type FaireInventoryQuantityState,
} from '@/lib/persistence/faireInventoryPolling'
import {
  readCommerceRuntimeCredentialFromPostgres,
} from '@/lib/persistence/commerceIntegrations'

const PROVIDER_READ_TIMEOUT_MS = 4_000

export function faireInventoryPollingRuntimeAvailable() {
  return commerceReadRuntimeAvailable()
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function inventoryError(code: string, message: string, status = 409): never {
  throw new CommerceIntegrationRequestError(message, status, code)
}

function isStoreSyncReadPause(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code || '')
    : ''
  return code === 'COMMERCE_STORE_SYNC_PROVIDER_READ_PAUSED'
    || code === 'COMMERCE_STORE_SYNC_PROVIDER_READ_LEASE_LOST'
}

function exactBrandIdentity(value: unknown, expectedBrandId: string) {
  const profile = record(value)
  const identifiers = profile
    ? [profile.id, profile.brand_id, profile.brandId]
        .filter((candidate) => candidate !== undefined && candidate !== null)
    : []
  if (
    identifiers.length < 1
    || identifiers.some((candidate) => (
      typeof candidate !== 'string'
      || candidate !== candidate.trim()
      || candidate.length < 1
      || candidate.length > 512
      || /[\u0000-\u001f\u007f]/u.test(candidate)
      || candidate !== expectedBrandId
    ))
  ) {
    inventoryError(
      'FAIRE_INVENTORY_ACCOUNT_CHANGED',
      'Faire returned a different brand identity during inventory polling',
    )
  }
}

function quantity(value: unknown): {
  state: FaireInventoryQuantityState
  quantity: number | null
} {
  if (value === undefined) return { state: 'missing', quantity: null }
  const candidate = record(value)
  if (candidate?.type === 'UNTRACKED') {
    return { state: 'untracked', quantity: null }
  }
  if (
    candidate?.type === 'QUANTITY'
    && Number.isSafeInteger(candidate.quantity)
  ) {
    return { state: 'quantity', quantity: Number(candidate.quantity) }
  }
  inventoryError(
    'FAIRE_INVENTORY_RESPONSE_INVALID',
    'Faire returned invalid inventory quantity evidence',
    502,
  )
}

export function normalizeFaireInventoryObservation(
  selector: FaireInventoryPollSelector,
  value: FaireInventoryLevel | undefined,
): FaireInventoryObservation {
  const level = value === undefined ? null : record(value)
  if (value !== undefined && !level) {
    inventoryError(
      'FAIRE_INVENTORY_RESPONSE_INVALID',
      'Faire returned invalid inventory evidence',
      502,
    )
  }
  const onHand = quantity(level?.on_hand_quantity)
  const committed = quantity(level?.committed_quantity)
  const available = quantity(level?.available_quantity)
  const providerRecordState: 'present' | 'missing' = level
    ? 'present'
    : 'missing'
  if (
    committed.state === 'quantity'
    && Number(committed.quantity) < 0
  ) {
    inventoryError(
      'FAIRE_INVENTORY_RESPONSE_INVALID',
      'Faire returned invalid committed inventory evidence',
      502,
    )
  }
  const canonical = {
    authority: 'faire_channel_listing_observation',
    externalVariantId: selector.externalVariantId,
    providerRecordState,
    onHand,
    committed,
    available,
    wmsProjectionApplied: false,
    providerWrites: 0,
  }
  return {
    ...selector,
    providerRecordState: canonical.providerRecordState,
    onHandState: onHand.state,
    onHandQuantity: onHand.quantity,
    committedState: committed.state,
    committedQuantity: committed.quantity,
    availableState: available.state,
    availableQuantity: available.quantity,
    sourceHash: createHash('sha256')
      .update(JSON.stringify(canonical))
      .digest('hex'),
  }
}

async function faireRuntime(target: FaireInventoryPollTarget) {
  const runtime = await readCommerceRuntimeCredentialFromPostgres({
    organizationId: target.organizationId,
    accountGlobalId: target.accountGlobalId,
  })
  if (
    !runtime
    || runtime.provider !== 'faire'
    || runtime.integrationAccountId !== target.integrationAccountId
    || runtime.externalAccountId !== target.externalAccountId
    || runtime.credentialVersion !== target.credentialVersion
    || !commerceReadCredentialEligible(runtime, {
      developmentRequiresActive: true,
      capability: 'inventory',
    })
  ) {
    inventoryError(
      'FAIRE_INVENTORY_POLL_FENCE_CHANGED',
      'Faire inventory polling authority changed',
    )
  }
  const credential = decryptCommerceCredential(
    runtime.encrypted,
    runtime.organizationId,
    runtime.provider,
    runtime.environment,
    runtime.externalAccountId,
  )
  if (credential.provider !== 'faire') {
    inventoryError(
      'FAIRE_INVENTORY_CREDENTIAL_INVALID',
      'Stored Faire credentials could not be decrypted',
    )
  }
  if (
    credential.authMode === 'faire_oauth'
    && !credential.scopes.includes('READ_INVENTORIES')
  ) {
    inventoryError(
      'FAIRE_READ_INVENTORIES_SCOPE_REQUIRED',
      'Faire OAuth must request READ_INVENTORIES for inventory observation polling',
    )
  }
  // The stored OAuth scope list records what ClawPilot requested. It is a
  // scheduling hint, not proof of a provider grant. The selector GET below is
  // the fail-closed authorization test for every page.
  return {
    externalAccountId: runtime.externalAccountId,
    options: credential.authMode === 'faire_oauth'
      ? {
          accessToken: credential.accessToken,
          applicationId: credential.applicationId,
          applicationSecret: credential.applicationSecret,
          timeoutMs: PROVIDER_READ_TIMEOUT_MS,
        }
      : {
          accessToken: credential.accessToken,
          timeoutMs: PROVIDER_READ_TIMEOUT_MS,
        },
  }
}

async function processTarget(target: FaireInventoryPollTarget) {
  const page = await readFaireInventoryPollSelectorsInPostgres({ target })
  if (page.selectors.length === 0) {
    return completeFaireInventoryPollPageInPostgres({
      target,
      selectors: [],
      observations: [],
      hasMore: false,
      nextSelectorAfter: null,
      observedAt: new Date().toISOString(),
    })
  }
  const runtime = await faireRuntime(target)
  return withFaireInventoryPollProviderReadFenceInPostgres({
    target,
    read: async (providerReadLease) => {
      exactBrandIdentity(
        await probeFaireBrandProfile(runtime.options),
        runtime.externalAccountId,
      )
      const response = await listFaireInventory(runtime.options, {
        productVariantIds: page.selectors.map(
          (selector) => selector.externalVariantId,
        ),
      })
      const expected = new Set(
        page.selectors.map((selector) => selector.externalVariantId),
      )
      if (
        Object.keys(response.inventories).some(
          (externalVariantId) => !expected.has(externalVariantId),
        )
      ) {
        inventoryError(
          'FAIRE_INVENTORY_RESPONSE_SCOPE_INVALID',
          'Faire returned inventory outside the requested selector scope',
          502,
        )
      }
      const observations = page.selectors.map((selector) => (
        normalizeFaireInventoryObservation(
          selector,
          response.inventories[selector.externalVariantId],
        )
      ))
      return completeFaireInventoryPollPageInPostgres({
        target,
        providerReadLease,
        selectors: page.selectors,
        observations,
        hasMore: page.hasMore,
        nextSelectorAfter: page.nextSelectorAfter,
        observedAt: new Date().toISOString(),
      })
    },
  })
}

export async function processFaireInventoryPollOutbox(input: {
  limit?: number
  workerId: string
}) {
  assertIntegrationCredentialProviderIoReady()
  const automatic = await queueAutomaticFaireInventoryPollsInPostgres()
  const requestedLimit = Math.max(1, Math.min(Number(input.limit || 2), 10))
  let claimed = 0
  let completed = 0
  let continued = 0
  let retried = 0
  let dead = 0
  let leaseLost = 0
  let parked = 0
  let recoveredLeases = 0
  let variantsObserved = 0
  let quantityFactsObserved = 0
  let untrackedFactsObserved = 0
  let missingVariantsObserved = 0
  for (let index = 0; index < requestedLimit; index += 1) {
    assertIntegrationCredentialProviderIoReady()
    const [target] = await claimFaireInventoryPollJobsInPostgres({
      limit: 1,
      workerId: input.workerId,
    })
    if (!target) break
    claimed += 1
    if (target.recoveredLease) recoveredLeases += 1
    await recordFaireInventoryPollWorkerHeartbeatInPostgres({
      phase: 'processing',
      jobId: target.id,
      accountGlobalId: target.accountGlobalId,
    })
    try {
      const result = await processTarget(target)
      if (result.leaseLost) {
        leaseLost += 1
        continue
      }
      if (result.completed) completed += 1
      if (result.continued) continued += 1
      variantsObserved += Number(result.variantsObserved || 0)
      quantityFactsObserved += Number(result.quantityCount || 0)
      untrackedFactsObserved += Number(result.untrackedCount || 0)
      missingVariantsObserved += Number(result.missingCount || 0)
    } catch (error) {
      if (isIntegrationCredentialRuntimeGateError(error)) {
        await Promise.allSettled([
          parkFaireInventoryPollForRuntimeMaintenanceInPostgres({
            target,
            errorCode: String((error as { code?: unknown }).code || ''),
          }),
        ])
        throw error
      }
      if (isStoreSyncReadPause(error)) {
        const disposition =
          await parkFaireInventoryPollForStoreSyncPauseInPostgres({ target })
        if (disposition.parked) parked += 1
        else leaseLost += 1
        continue
      }
      const failure = await failFaireInventoryPollJobInPostgres({
        target,
        error,
      })
      if (failure.leaseLost) leaseLost += 1
      else if (failure.dead) dead += 1
      else retried += 1
    }
  }
  return {
    autoQueued: automatic.queued,
    autoCancelled: automatic.cancelled,
    claimed,
    completed,
    continued,
    retried,
    dead,
    leaseLost,
    parked,
    recoveredLeases,
    variantsObserved,
    quantityFactsObserved,
    untrackedFactsObserved,
    missingVariantsObserved,
    provider: 'faire' as const,
    resource: 'inventory' as const,
    selectorReadMode: 'product_variant_ids' as const,
    eventTransport: 'scheduled_poll' as const,
    webhookSupported: false,
    authority: 'faire_channel_listing_observation' as const,
    wmsInventoryAuthoritySupported: false,
    wmsProjectionApplied: false,
    providerWrites: 0,
  }
}
