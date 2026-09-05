import { createHash } from 'node:crypto'
import {
  resolveCarrierProductionRatingRuntime,
} from '@/lib/integrations/carrierIntegrations'
import {
  CarrierWholeShipmentRateClientError,
  executeCarrierWholeShipmentRateRequest,
} from '@/lib/integrations/carrierWholeShipmentRateClient'
import {
  isIntegrationCredentialRuntimeGateError,
} from '@/lib/integrations/integrationCredentialRuntimeGate.mjs'
import {
  prepareCarrierWholeShipmentRateRequest,
  type CarrierWholeShipmentFedexPickupType,
  type CarrierWholeShipmentRateProvider,
} from '@/lib/integrations/carrierWholeShipmentRateFoundation'
import type { ActiveCarrierDispatchAddressSnapshot } from '@/lib/operations/activeCarrierDispatchSnapshot'
import {
  carrierRateDestinationFromActive,
  carrierRatePartyFromActiveOrigin,
  carrierWholeShipmentRateParcelsFromRunPackages,
  finalizeProductionFulfillmentRerateAttemptInPostgres,
  prepareProductionFulfillmentRerateAttemptInPostgres,
  prepareProductionFulfillmentRerateInPostgres,
  type ProductionFulfillmentRerateAttempt,
  type ProductionFulfillmentRerateResult,
  type ProductionFulfillmentRerateRun,
} from '@/lib/operations/productionFulfillmentRerates'

export class ProductionFulfillmentRerateExecutionError extends Error {
  readonly code: string
  readonly status: number
  readonly attemptGlobalId: string | null

  constructor(
    code: string,
    message: string,
    status = 409,
    attemptGlobalId: string | null = null,
  ) {
    super(message)
    this.name = 'ProductionFulfillmentRerateExecutionError'
    this.code = code
    this.status = status
    this.attemptGlobalId = attemptGlobalId
  }
}

export type ExecuteProductionFulfillmentRerateInput = {
  organizationId: unknown
  activeExecutionGlobalId: unknown
  activeShipmentGroupGlobalId: unknown
  expectedActivationRevision: unknown
  destination: ActiveCarrierDispatchAddressSnapshot
  currency: unknown
  provider: CarrierWholeShipmentRateProvider
  integrationAccountGlobalId: unknown
  carrierAccountGlobalId: unknown
  origin: ActiveCarrierDispatchAddressSnapshot
  fedexPickupType?: CarrierWholeShipmentFedexPickupType | null
  idempotencyKey: unknown
  actorEmail: unknown
  timeoutMs?: number
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}

export type ProductionFulfillmentRerateExecution = {
  run: ProductionFulfillmentRerateRun
  attempt: ProductionFulfillmentRerateAttempt
  result: ProductionFulfillmentRerateResult
}

function executionKey(value: unknown) {
  const source = typeof value === 'string' ? value.trim() : ''
  if (!source) {
    throw new ProductionFulfillmentRerateExecutionError(
      'OPERATIONS_PRODUCTION_RERATE_IDEMPOTENCY_INVALID',
      'A production rerate idempotency key is required',
      400,
    )
  }
  return createHash('sha256').update(source, 'utf8').digest('hex')
}

function safeFailure(error: unknown) {
  if (error instanceof CarrierWholeShipmentRateClientError) {
    return {
      code: error.code,
      status: error.status,
      message: error.message,
    }
  }
  return {
    code: 'CARRIER_PRODUCTION_RATE_EXECUTION_FAILED',
    status: 502,
    message: 'Production carrier rating failed',
  }
}

/**
 * Execute one read-only production whole-shipment rerate.
 *
 * The immutable run and provider attempt are committed before any token or
 * rating request. Replaying an already prepared attempt never calls the
 * provider again: an operator/worker must reconcile that exact attempt first.
 * This boundary neither selects a service nor creates, voids, or modifies a
 * shipment.
 */
export async function executeProductionFulfillmentRerate(
  input: ExecuteProductionFulfillmentRerateInput,
): Promise<ProductionFulfillmentRerateExecution> {
  const key = executionKey(input.idempotencyKey)
  const run = await prepareProductionFulfillmentRerateInPostgres({
    organizationId: input.organizationId,
    activeExecutionGlobalId: input.activeExecutionGlobalId,
    activeShipmentGroupGlobalId: input.activeShipmentGroupGlobalId,
    expectedActivationRevision: input.expectedActivationRevision,
    destination: input.destination,
    currency: input.currency,
    idempotencyKey: `production-rerate-run:${key}`,
    actorEmail: input.actorEmail,
  })
  const runtime = await resolveCarrierProductionRatingRuntime({
    organizationId: input.organizationId,
    provider: input.provider,
    integrationAccountGlobalId: input.integrationAccountGlobalId,
    carrierAccountGlobalId: input.carrierAccountGlobalId,
  })
  const origin = carrierRatePartyFromActiveOrigin(input.origin)
  const destination = carrierRateDestinationFromActive(run.destination)
  const accountNumber = runtime.credential.accountNumber
  const preparedRequest = prepareCarrierWholeShipmentRateRequest({
    binding: {
      organizationId: runtime.organizationId,
      carrierAccountId: runtime.carrierAccountId,
      integrationAccountId: runtime.integrationAccountId,
      credentialRevision: runtime.credentialVersion,
      credentialFingerprint: runtime.credentialFingerprint,
      accountNumber,
      accountNumberFingerprint: runtime.accountNumberFingerprint,
      provider: runtime.provider,
      environment: 'production',
    },
    origin,
    destination,
    parcels: [...carrierWholeShipmentRateParcelsFromRunPackages(run.packages)],
    billing: {
      relationship: 'sender',
      payerAccountNumber: accountNumber,
      payerAccountNumberFingerprint: runtime.accountNumberFingerprint,
      payerPostalCode: origin.postalCode,
      payerCountryCode: 'US',
    },
    expectedCurrency: 'USD',
    fedexPickupType: input.provider === 'fedex_rest'
      ? input.fedexPickupType || 'DROPOFF_AT_FEDEX_LOCATION'
      : null,
  })
  const attempt = await prepareProductionFulfillmentRerateAttemptInPostgres({
    organizationId: input.organizationId,
    rerateRunGlobalId: run.globalId,
    provider: input.provider,
    integrationAccountGlobalId: input.integrationAccountGlobalId,
    carrierAccountGlobalId: input.carrierAccountGlobalId,
    origin: input.origin,
    billing: {
      relationship: 'sender',
      payerAccountNumberFingerprint: runtime.accountNumberFingerprint,
      payerPostalCode: origin.postalCode,
      payerCountryCode: 'US',
    },
    preparedRequest,
    idempotencyKey: `production-rerate-attempt:${key}:${input.provider}`,
    actorEmail: input.actorEmail,
  })
  if (attempt.replayed) {
    throw new ProductionFulfillmentRerateExecutionError(
      'OPERATIONS_PRODUCTION_RERATE_RECONCILIATION_REQUIRED',
      'This durable production rerate attempt already exists; reconcile it before another provider call',
      409,
      attempt.globalId,
    )
  }

  let parsedResponse: Awaited<
    ReturnType<typeof executeCarrierWholeShipmentRateRequest>
  >
  try {
    parsedResponse = await executeCarrierWholeShipmentRateRequest({
      preparedRequest,
      runtimeCredential: {
        provider: runtime.provider,
        environment: runtime.environment,
        credential: runtime.credential,
      },
      fetchImpl: input.fetchImpl,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
    })
  } catch (error) {
    if (isIntegrationCredentialRuntimeGateError(error)) throw error
    const failure = safeFailure(error)
    const result = await finalizeProductionFulfillmentRerateAttemptInPostgres({
      organizationId: input.organizationId,
      attemptGlobalId: attempt.globalId,
      outcome: {
        state: 'failed',
        errorCode: failure.code,
        redactedResponse: {
          adapterVersion: preparedRequest.adapterVersion,
          accessMode: 'rate_read_only',
          providerMutationCount: 0,
          provider: preparedRequest.provider,
          environment: preparedRequest.environment,
          endpoint: preparedRequest.endpoint,
          endpointVersion: preparedRequest.endpointVersion,
          purpose: 'fulfillment_execution',
          rateScope: 'multi_package_shipment',
          packageCount: run.packageCount,
          errorCode: failure.code,
        },
      },
    })
    if (result.state !== 'failed') {
      throw new ProductionFulfillmentRerateExecutionError(
        'OPERATIONS_PRODUCTION_RERATE_RESULT_INVALID',
        'Production carrier rating did not persist a failed terminal outcome',
        500,
        attempt.globalId,
      )
    }
    throw new ProductionFulfillmentRerateExecutionError(
      failure.code,
      failure.message,
      failure.status,
      attempt.globalId,
    )
  }

  const result = await finalizeProductionFulfillmentRerateAttemptInPostgres({
    organizationId: input.organizationId,
    attemptGlobalId: attempt.globalId,
    outcome: { state: 'succeeded', parsedResponse },
  })
  return { run, attempt, result }
}
