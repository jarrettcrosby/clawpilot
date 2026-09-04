import {
  inspectFaireCanonicalOrderRevision,
  FaireOrderRevisionError,
} from '@/lib/integrations/faireOrderRevision'
import {
  inspectShopifyCanonicalOrderRevision,
  ShopifyOrderRevisionError,
} from '@/lib/integrations/shopifyOrderRevision'
import {
  captureCommerceOrderRevisionObservationInPostgres,
  CommerceOrderRevisionDispositionError,
  failManagerCommerceOrderRevisionRefreshInPostgres,
  prepareManagerCommerceOrderRevisionRefreshInPostgres,
  readManagerCommerceOrderRevisionStateFromPostgres,
  type CommerceOrderRevisionCaptureResult,
} from '@/lib/persistence/commerceOrderRevisions'
import {
  CommerceStoreSyncProviderReadFenceError,
  withCommerceStoreSyncProviderReadFenceInPostgres,
} from '@/lib/persistence/commerceStoreSync'

function providerErrorCode(error: unknown) {
  if (
    (error instanceof ShopifyOrderRevisionError
      || error instanceof FaireOrderRevisionError)
    && /^[A-Z][A-Z0-9_]{2,127}$/u.test(error.code)
  ) return error.code
  if (error instanceof CommerceStoreSyncProviderReadFenceError) {
    return error.code
  }
  return 'COMMERCE_ORDER_REVISION_REFRESH_FAILED'
}

/**
 * Manager-triggered exact provider read. This command has a hard provider-write
 * fence: adapters may only read and all durable writes are local ClawPilot
 * evidence/receipts.
 */
export async function refreshCommerceOrderRevisionFromProvider(input: {
  organizationId: string
  actorEmail: string
  orderGlobalId: string
  expectedRowVersion: number
  idempotencyKey: string
}) {
  const prepared = await prepareManagerCommerceOrderRevisionRefreshInPostgres(input)
  if (prepared.replayed) {
    if (!prepared.replayedCapture) {
      throw new CommerceOrderRevisionDispositionError(
        'COMMERCE_ORDER_REVISION_REFRESH_RESULT_INVALID',
        'The retained provider refresh result is invalid',
        500,
      )
    }
    return {
      replayed: true,
      capture: prepared.replayedCapture,
      revision: await readManagerCommerceOrderRevisionStateFromPostgres({
        organizationId: input.organizationId,
        orderGlobalId: input.orderGlobalId,
      }),
    }
  }
  const claim = prepared.claim
  if (!claim) {
    throw new CommerceOrderRevisionDispositionError(
      'COMMERCE_ORDER_REVISION_REFRESH_PREPARATION_INVALID',
      'The exact provider refresh preparation is invalid',
      500,
    )
  }
  try {
    let retainedCapture: CommerceOrderRevisionCaptureResult | null = null
    const readFence = {
      organizationId: claim.organizationId,
      integrationAccountId: claim.integrationAccountId,
      authorityKind: 'manual_read_only' as const,
      readKind: 'order_revision' as const,
      intentKey: `${prepared.commandReceiptId}:${claim.targetId}:${claim.leaseToken}`,
      acquiredBy: input.actorEmail,
    }
    const capture = async (providerReadLease: Parameters<
      typeof captureCommerceOrderRevisionObservationInPostgres
    >[0]['providerReadLease']) => {
      const evidence = claim.provider === 'shopify'
        ? await inspectShopifyCanonicalOrderRevision(claim)
        : await inspectFaireCanonicalOrderRevision(claim)
      if (evidence.providerWrites !== 0) {
        throw new Error('Provider refresh crossed its provider-write fence')
      }
      retainedCapture = await captureCommerceOrderRevisionObservationInPostgres({
        claim,
        providerReadLease,
        sourceRevision: evidence.sourceRevision,
        sourceHash: evidence.sourceHash,
        revisionHash: evidence.revisionHash,
        normalizedSnapshot: JSON.parse(
          JSON.stringify(evidence.snapshot),
        ) as Record<string, unknown>,
        protectedParty: evidence.protectedParty,
        protectedShipTo: evidence.protectedShipTo,
        trigger: {
          kind: 'manager',
          commandReceiptId: prepared.commandReceiptId,
          actorEmail: input.actorEmail,
        },
        providerReads: evidence.providerReads,
        providerWrites: 0,
        observedAt: evidence.snapshot.observedAt,
      })
    }
    await (claim.provider === 'shopify'
      ? await withCommerceStoreSyncProviderReadFenceInPostgres({
          ...readFence,
          read: capture,
        })
      : await withCommerceStoreSyncProviderReadFenceInPostgres({
          ...readFence,
          read: capture,
        })
    )
    if (!retainedCapture) {
      throw new CommerceOrderRevisionDispositionError(
        'COMMERCE_ORDER_REVISION_REFRESH_RESULT_INVALID',
        'The exact provider refresh result was not retained',
        500,
      )
    }
    return {
      replayed: false,
      capture: retainedCapture,
      revision: await readManagerCommerceOrderRevisionStateFromPostgres({
        organizationId: input.organizationId,
        orderGlobalId: input.orderGlobalId,
      }),
    }
  } catch (error) {
    const errorCode = providerErrorCode(error)
    const retryWithNewIdempotencyKey = await failManagerCommerceOrderRevisionRefreshInPostgres({
      claim,
      commandReceiptId: prepared.commandReceiptId,
      errorCode,
    })
    if (error instanceof CommerceOrderRevisionDispositionError) {
      throw new CommerceOrderRevisionDispositionError(
        error.code,
        error.message,
        error.status,
        retryWithNewIdempotencyKey,
      )
    }
    throw new CommerceOrderRevisionDispositionError(
      errorCode,
      `The exact ${claim.provider === 'shopify' ? 'Shopify' : 'Faire'} order refresh failed`,
      502,
      retryWithNewIdempotencyKey,
    )
  }
}
