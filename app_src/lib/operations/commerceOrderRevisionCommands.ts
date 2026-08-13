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
} from '@/lib/persistence/commerceOrderRevisions'

function providerErrorCode(error: unknown) {
  if (
    (error instanceof ShopifyOrderRevisionError
      || error instanceof FaireOrderRevisionError)
    && /^[A-Z][A-Z0-9_]{2,127}$/u.test(error.code)
  ) return error.code
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
    return {
      replayed: true,
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
    const evidence = claim.provider === 'shopify'
      ? await inspectShopifyCanonicalOrderRevision(claim)
      : await inspectFaireCanonicalOrderRevision(claim)
    if (evidence.providerWrites !== 0) {
      throw new Error('Provider refresh crossed its provider-write fence')
    }
    await captureCommerceOrderRevisionObservationInPostgres({
      claim,
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
    return {
      replayed: false,
      revision: await readManagerCommerceOrderRevisionStateFromPostgres({
        organizationId: input.organizationId,
        orderGlobalId: input.orderGlobalId,
      }),
    }
  } catch (error) {
    const errorCode = providerErrorCode(error)
    await failManagerCommerceOrderRevisionRefreshInPostgres({
      claim,
      commandReceiptId: prepared.commandReceiptId,
      errorCode,
    })
    if (error instanceof CommerceOrderRevisionDispositionError) throw error
    throw new CommerceOrderRevisionDispositionError(
      errorCode,
      `The exact ${claim.provider === 'shopify' ? 'Shopify' : 'Faire'} order refresh failed`,
      502,
    )
  }
}
