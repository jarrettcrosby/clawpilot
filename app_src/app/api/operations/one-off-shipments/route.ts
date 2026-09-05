import { NextRequest, NextResponse } from 'next/server'
import {
  activeOperationsOrganizationId,
  shippingCapabilities,
} from '@/lib/operations/authorization'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import {
  createAndPlanOneOffShipmentInPostgres,
  OneOffShipmentPersistenceError,
  quoteOneOffShipmentInPostgres,
  readOneOffShipmentQuoteExecutionModeFromPostgres,
  readOneOffShipmentWorkspaceFromPostgres,
} from '@/lib/persistence/oneOffShipments'
import {
  createOperationsOneOffCarrierGroupInPostgres,
  readOneOffCarrierGroupExecutionModeInPostgres,
  readOneOffShipmentExecutionStateFromPostgres,
  recoverOperationsOneOffLabelPrintInPostgres,
  refreshOperationsOneOffPackedRatesInPostgres,
  voidOperationsOneOffCarrierGroupInPostgres,
} from '@/lib/persistence/operationOneOffShipping'
import { requireRequestUser } from '@/lib/requestUser'
import { ONE_OFF_LIVE_POSTAGE_CONFIRMATION } from '@/lib/operations/oneOffShipments'
import {
  packShippingOneOffShipmentInPostgres,
} from '@/lib/persistence/shippingOneOffPack'
import {
  integrationCredentialRuntimeMaintenanceResponse,
} from '@/lib/integrations/integrationCredentialRuntimeHttp'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const MAX_REQUEST_BYTES = 256 * 1024

function json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      Vary: 'Cookie',
    },
  })
}

function errorResponse(error: unknown) {
  const maintenance = integrationCredentialRuntimeMaintenanceResponse(error)
  if (maintenance) return maintenance
  if (error instanceof OneOffShipmentPersistenceError) {
    return json({
      ok: false,
      error: error.message,
      code: error.code,
    }, error.status)
  }
  if (
    error
    && typeof error === 'object'
    && 'code' in error
    && 'status' in error
    && typeof error.code === 'string'
    && typeof error.status === 'number'
  ) {
    return json({
      ok: false,
      error: error instanceof Error ? error.message : error.code,
      code: error.code,
    }, error.status)
  }
  const code = error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)
    ? error.message
    : 'OPERATIONS_ONE_OFF_REQUEST_FAILED'
  const status = code === 'OPERATIONS_ONE_OFF_REQUEST_FAILED' ? 500 : 400
  if (status === 500) {
    console.error('[operations-one-off-shipments] request failure', {
      name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
    })
  }
  return json({
    ok: false,
    error: status === 500 ? 'One-off shipment request failed' : code,
    code,
  }, status)
}

function requirePostgres() {
  if (!isPostgresStorageEnabled()) {
    throw new OneOffShipmentPersistenceError(
      'OPERATIONS_POSTGRES_REQUIRED',
      'One-off shipments require Postgres storage',
      503,
    )
  }
}

async function requestBody(req: NextRequest): Promise<Record<string, unknown>> {
  const bodyText = await req.text()
  if (Buffer.byteLength(bodyText, 'utf8') > MAX_REQUEST_BYTES) {
    throw new OneOffShipmentPersistenceError(
      'OPERATIONS_ONE_OFF_REQUEST_TOO_LARGE',
      'One-off shipment request is too large',
      413,
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(bodyText)
  } catch {
    throw new OneOffShipmentPersistenceError(
      'OPERATIONS_ONE_OFF_REQUEST_INVALID',
      'One-off shipment request must be valid JSON',
    )
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new OneOffShipmentPersistenceError(
      'OPERATIONS_ONE_OFF_REQUEST_INVALID',
      'One-off shipment request is invalid',
    )
  }
  return parsed as Record<string, unknown>
}

function idempotencyKey(req: NextRequest) {
  return String(req.headers.get('idempotency-key') || '').trim()
}

function forbidden(message: string, code: string) {
  return json({ ok: false, error: message, code }, 403)
}

export async function GET(req: NextRequest) {
  try {
    requirePostgres()
    const actor = await requireRequestUser(req)
    const capabilities = shippingCapabilities(actor)
    if (!capabilities.canCreate) {
      return forbidden(
        'You need Shipping creation permission to use one-off shipments',
        'SHIPPING_CREATE_REQUIRED',
      )
    }
    const organizationId = activeOperationsOrganizationId(actor)
    const orderGlobalId = String(req.nextUrl.searchParams.get('orderGlobalId') || '').trim()
    if (orderGlobalId) {
      const state = await readOneOffShipmentExecutionStateFromPostgres({
        organizationId,
        orderGlobalId,
      })
      return json({ ok: true, state })
    }
    const workspace = await readOneOffShipmentWorkspaceFromPostgres({
      organizationId,
      actorEmail: actor.email,
      canPurchaseLivePostage: capabilities.canPurchaseLivePostage,
    })
    return json({ ok: true, workspace })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function POST(req: NextRequest) {
  try {
    requirePostgres()
    const actor = await requireRequestUser(req)
    const capabilities = shippingCapabilities(actor)
    if (!capabilities.canCreate) {
      return forbidden(
        'You need Shipping creation permission to use one-off shipments',
        'SHIPPING_CREATE_REQUIRED',
      )
    }
    const body = await requestBody(req)
    const action = String(body.action || '').trim()
    const organizationId = activeOperationsOrganizationId(actor)
    if (action === 'quote') {
      const unsupported = Object.keys(body).find((key) => !['action', 'quote'].includes(key))
      if (unsupported || !('quote' in body)) {
        throw new OneOffShipmentPersistenceError(
          'OPERATIONS_ONE_OFF_REQUEST_INVALID',
          'One-off quote command is invalid',
        )
      }
      const requestedQuote = body.quote as Record<string, unknown>
      if (requestedQuote?.executionMode === 'live' && !capabilities.canPurchaseLivePostage) {
        return forbidden(
          'Live carrier rating requires live-postage permission',
          'SHIPPING_LIVE_POSTAGE_PERMISSION_REQUIRED',
        )
      }
      const quote = await quoteOneOffShipmentInPostgres({
        organizationId,
        actorEmail: actor.email,
        idempotencyKey: idempotencyKey(req),
        quote: body.quote,
      })
      return json({ ok: true, quote }, 201)
    }
    if (action === 'create-and-plan') {
      const unsupported = Object.keys(body).find((key) => ![
        'action', 'quoteGlobalId', 'selectedOfferGlobalId', 'reason',
      ].includes(key))
      if (unsupported) {
        throw new OneOffShipmentPersistenceError(
          'OPERATIONS_ONE_OFF_REQUEST_INVALID',
          'One-off create-and-plan command is invalid',
        )
      }
      const quoteGlobalId = String(body.quoteGlobalId || '')
      const executionMode = await readOneOffShipmentQuoteExecutionModeFromPostgres({
        organizationId,
        quoteGlobalId,
      })
      if (executionMode === 'live' && !capabilities.canPurchaseLivePostage) {
        return forbidden(
          'Live one-off planning requires live-postage permission',
          'SHIPPING_LIVE_POSTAGE_PERMISSION_REQUIRED',
        )
      }
      const result = await createAndPlanOneOffShipmentInPostgres({
        organizationId,
        actorEmail: actor.email,
        idempotencyKey: idempotencyKey(req),
        quoteGlobalId,
        selectedOfferGlobalId: String(body.selectedOfferGlobalId || ''),
        reason: String(body.reason || ''),
      })
      return json({ ok: true, result }, result.replayed ? 200 : 201)
    }
    if (action === 'confirm-pack') {
      const unsupported = Object.keys(body).find((key) => ![
        'action', 'orderGlobalId', 'expectedRowVersion',
        'expectedReviewSnapshotHash', 'confirmation', 'reason',
      ].includes(key))
      if (unsupported) {
        throw new OneOffShipmentPersistenceError(
          'OPERATIONS_ONE_OFF_REQUEST_INVALID',
          'Shipping pack confirmation command is invalid',
        )
      }
      const result = await packShippingOneOffShipmentInPostgres({
        organizationId,
        actorEmail: actor.email,
        idempotencyKey: idempotencyKey(req),
        orderGlobalId: String(body.orderGlobalId || ''),
        expectedRowVersion: Number(body.expectedRowVersion),
        expectedReviewSnapshotHash: String(
          body.expectedReviewSnapshotHash || '',
        ),
        confirmation: String(body.confirmation || ''),
        reason: String(body.reason || ''),
      })
      return json({ ok: true, result }, result.replayed ? 200 : 201)
    }
    if (action === 'refresh-packed-rates') {
      const unsupported = Object.keys(body).find((key) => ![
        'action', 'orderGlobalId', 'expectedRowVersion',
      ].includes(key))
      if (unsupported) {
        throw new OneOffShipmentPersistenceError(
          'OPERATIONS_ONE_OFF_REQUEST_INVALID',
          'Packed-rate refresh command is invalid',
        )
      }
      const orderGlobalId = String(body.orderGlobalId || '')
      const executionMode = await readOneOffCarrierGroupExecutionModeInPostgres({
        organizationId,
        orderGlobalId,
      })
      if (executionMode === 'live' && !capabilities.canPurchaseLivePostage) {
        return forbidden(
          'Live packed carrier rating requires live-postage permission',
          'SHIPPING_LIVE_POSTAGE_PERMISSION_REQUIRED',
        )
      }
      const result = await refreshOperationsOneOffPackedRatesInPostgres({
        organizationId,
        actorEmail: actor.email,
        idempotencyKey: idempotencyKey(req),
        orderGlobalId,
        expectedRowVersion: Number(body.expectedRowVersion),
      })
      return json({ ok: true, result }, 201)
    }
    if (action === 'purchase-group') {
      const unsupported = Object.keys(body).find((key) => ![
        'action', 'orderGlobalId', 'purchaseQuoteGlobalId',
        'selectedOfferGlobalId', 'expectedRowVersion', 'reason',
        'preferredPrinterGlobalId', 'confirmation',
      ].includes(key))
      if (unsupported) {
        throw new OneOffShipmentPersistenceError(
          'OPERATIONS_ONE_OFF_REQUEST_INVALID',
          'Whole-shipment postage purchase command is invalid',
        )
      }
      const orderGlobalId = String(body.orderGlobalId || '')
      const executionMode = await readOneOffCarrierGroupExecutionModeInPostgres({
        organizationId,
        orderGlobalId,
      })
      if (executionMode === 'live' && !capabilities.canPurchaseLivePostage) {
        return forbidden(
          'Live postage purchase requires live-postage permission',
          'SHIPPING_LIVE_POSTAGE_PERMISSION_REQUIRED',
        )
      }
      if (
        executionMode === 'live'
        && body.confirmation !== ONE_OFF_LIVE_POSTAGE_CONFIRMATION
      ) {
        throw new OneOffShipmentPersistenceError(
          'OPERATIONS_ONE_OFF_LIVE_PURCHASE_CONFIRMATION_REQUIRED',
          'Explicit confirmation is required before buying live postage',
          400,
        )
      }
      const result = await createOperationsOneOffCarrierGroupInPostgres({
        organizationId,
        actorEmail: actor.email,
        idempotencyKey: idempotencyKey(req),
        orderGlobalId,
        purchaseQuoteGlobalId: String(body.purchaseQuoteGlobalId || ''),
        selectedOfferGlobalId: String(body.selectedOfferGlobalId || ''),
        expectedRowVersion: Number(body.expectedRowVersion),
        reason: String(body.reason || ''),
        preferredPrinterGlobalId: body.preferredPrinterGlobalId === null
          || body.preferredPrinterGlobalId === undefined
          ? null
          : String(body.preferredPrinterGlobalId),
      })
      return json({ ok: true, result }, result.replayed ? 200 : 201)
    }
    if (action === 'recover-label-print') {
      const unsupported = Object.keys(body).find((key) => ![
        'action', 'orderGlobalId', 'expectedRowVersion',
        'packageGlobalId', 'labelGlobalId', 'expectedPrintJobGlobalId',
        'expectedPrintJobStatus', 'expectedPrintArtifactGlobalId',
        'expectedRecoveryAction', 'expectedPrintAttempts',
        'expectedPrintMaxAttempts', 'expectedLatestAttemptSequenceNumber',
        'expectedLatestErrorCode', 'reason',
      ].includes(key))
      const expectedPrintJobStatus = body.expectedPrintJobStatus
      const expectedRecoveryAction = body.expectedRecoveryAction
      if (
        unsupported
        || !['enqueue', 'retry', 'new_print'].includes(
          expectedRecoveryAction as string,
        )
        || ![
          null, 'queued', 'claimed', 'delivered', 'failed', 'cancelled',
          'printed', 'rerouted',
        ].includes(expectedPrintJobStatus as null | string)
      ) {
        throw new OneOffShipmentPersistenceError(
          'OPERATIONS_ONE_OFF_REQUEST_INVALID',
          'Shipping label print-recovery command is invalid',
        )
      }
      const result = await recoverOperationsOneOffLabelPrintInPostgres({
        organizationId,
        actorEmail: actor.email,
        idempotencyKey: idempotencyKey(req),
        orderGlobalId: String(body.orderGlobalId || ''),
        expectedRowVersion: Number(body.expectedRowVersion),
        packageGlobalId: String(body.packageGlobalId || ''),
        labelGlobalId: String(body.labelGlobalId || ''),
        expectedRecoveryAction: expectedRecoveryAction as
          | 'enqueue' | 'retry' | 'new_print',
        expectedPrintJobGlobalId: body.expectedPrintJobGlobalId === null
          ? null
          : String(body.expectedPrintJobGlobalId || ''),
        expectedPrintJobStatus: expectedPrintJobStatus as
          | 'queued' | 'claimed' | 'delivered' | 'failed' | 'cancelled'
          | 'printed' | 'rerouted' | null,
        expectedPrintArtifactGlobalId:
          body.expectedPrintArtifactGlobalId === null
            ? null
            : String(body.expectedPrintArtifactGlobalId || ''),
        expectedPrintAttempts: body.expectedPrintAttempts === null
          ? null
          : Number(body.expectedPrintAttempts),
        expectedPrintMaxAttempts: body.expectedPrintMaxAttempts === null
          ? null
          : Number(body.expectedPrintMaxAttempts),
        expectedLatestAttemptSequenceNumber:
          body.expectedLatestAttemptSequenceNumber === null
            ? null
            : Number(body.expectedLatestAttemptSequenceNumber),
        expectedLatestErrorCode: body.expectedLatestErrorCode === null
          ? null
          : String(body.expectedLatestErrorCode || ''),
        reason: String(body.reason || ''),
      })
      return json({ ok: true, result }, result.replayed ? 200 : 201)
    }
    if (action === 'void-group') {
      const unsupported = Object.keys(body).find((key) => ![
        'action', 'orderGlobalId', 'expectedRowVersion', 'reason',
      ].includes(key))
      if (unsupported) {
        throw new OneOffShipmentPersistenceError(
          'OPERATIONS_ONE_OFF_REQUEST_INVALID',
          'Whole-shipment carrier cancellation command is invalid',
        )
      }
      const orderGlobalId = String(body.orderGlobalId || '')
      const executionMode = await readOneOffCarrierGroupExecutionModeInPostgres({
        organizationId,
        orderGlobalId,
      })
      if (executionMode === 'live' && !capabilities.canPurchaseLivePostage) {
        return forbidden(
          'Live carrier cancellation requires live-postage permission',
          'SHIPPING_LIVE_POSTAGE_PERMISSION_REQUIRED',
        )
      }
      const result = await voidOperationsOneOffCarrierGroupInPostgres({
        organizationId,
        actorEmail: actor.email,
        canPurchaseLivePostage: capabilities.canPurchaseLivePostage,
        idempotencyKey: idempotencyKey(req),
        orderGlobalId,
        expectedRowVersion: Number(body.expectedRowVersion),
        reason: String(body.reason || ''),
      })
      return json({ ok: true, result })
    }
    throw new OneOffShipmentPersistenceError(
      'OPERATIONS_ONE_OFF_ACTION_INVALID',
      'One-off shipment action is invalid',
    )
  } catch (error) {
    return errorResponse(error)
  }
}
