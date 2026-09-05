import { createHash } from 'node:crypto'
import {
  resolveCarrierProductionRatingRuntime,
} from '@/lib/integrations/carrierIntegrations'
import {
  carrierWholeShipmentRateDestinationFingerprint,
  prepareCarrierWholeShipmentRateRequest,
  type PreparedCarrierWholeShipmentRateRequest,
} from '@/lib/integrations/carrierWholeShipmentRateFoundation'
import {
  executeCarrierWholeShipmentRateRequest,
} from '@/lib/integrations/carrierWholeShipmentRateClient'
import type {
  CheckoutRateCarrierParcel,
  CheckoutRateCarrierProvider,
  CheckoutRateDestination,
  CheckoutRateProviderResult,
} from '@/lib/integrations/carrierCheckoutRate'
import {
  writeCarrierProductionRateEvidenceInPostgres,
} from '@/lib/persistence/carrierIntegrations'
import {
  shopifyCheckoutCarrierSelectionKey,
} from '@/lib/integrations/shopifyCheckoutCarrierSelection'
import {
  isIntegrationCredentialRuntimeGateError,
} from '@/lib/integrations/integrationCredentialRuntimeGate.mjs'

const SHA256 = /^[a-f0-9]{64}$/

function failureCode(error: unknown) {
  const candidate = error && typeof error === 'object'
    ? (error as { code?: unknown }).code
    : null
  return typeof candidate === 'string'
    && /^[A-Z][A-Z0-9_]{2,127}$/.test(candidate)
    ? candidate
    : 'CARRIER_PRODUCTION_RATE_EXECUTION_FAILED'
}

function safeFailureRequest(input: {
  provider: CheckoutRateCarrierProvider
  carrierAccountGlobalId: string
  destination: CheckoutRateDestination
  packageCount: number
  parcels: CheckoutRateCarrierParcel[]
}) {
  const destinationFingerprint =
    carrierWholeShipmentRateDestinationFingerprint({
      ...input.destination,
      residential: null,
    })
  const redacted = {
    adapterVersion: 'carrier-whole-shipment-rate-v1',
    accessMode: 'rate_read_only',
    providerMutationCount: 0,
    provider: input.provider,
    environment: 'production',
    purpose: 'shopify_checkout',
    carrierAccountGlobalId: input.carrierAccountGlobalId,
    shipment: {
      rateScope: 'multi_package_shipment',
      destinationFingerprint,
      packageCount: input.packageCount,
      destination: {
        region: input.destination.region,
        countryCode: input.destination.countryCode,
        residential: null,
      },
      parcels: input.parcels.map((parcel) => ({
        description: parcel.description,
        length: parcel.exteriorInches.length,
        width: parcel.exteriorInches.width,
        height: parcel.exteriorInches.height,
        dimensionUnit: 'IN',
        weight: parcel.grossPounds,
        weightUnit: 'LB',
      })),
    },
  }
  return {
    redacted,
    requestHash: createHash('sha256')
      .update(JSON.stringify(redacted))
      .digest('hex'),
  }
}

export type ShopifyProductionCheckoutCarrierBinding = {
  provider: CheckoutRateCarrierProvider
  carrierIntegrationAccountGlobalId: string
  carrierAccountId: string
  carrierAccountGlobalId: string
  credentialVersion: number
  registeredAddressFingerprint: string
}

/**
 * Executes one explicitly production-bound, read-only carrier rate request.
 * It cannot buy postage, create a shipment, create a label, or mutate Shopify.
 */
export async function rateShopifyProductionCheckoutShipment(input: {
  organizationId: string
  receiptGlobalId: string
  binding: ShopifyProductionCheckoutCarrierBinding
  destination: CheckoutRateDestination
  parcels: CheckoutRateCarrierParcel[]
  currency: string
  actorEmail: string
  timeoutMs: number
  signal: AbortSignal
}): Promise<CheckoutRateProviderResult> {
  const requestedAt = new Date().toISOString()
  const carrierSelectionKey = shopifyCheckoutCarrierSelectionKey({
    receiptGlobalId: input.receiptGlobalId,
    carrierAccountGlobalId: input.binding.carrierAccountGlobalId,
  })
  let runtime: Awaited<
    ReturnType<typeof resolveCarrierProductionRatingRuntime>
  > | null = null
  let prepared: PreparedCarrierWholeShipmentRateRequest | null = null
  try {
    if (input.currency !== 'USD') {
      const error = new Error(
        'Production checkout rating currently requires USD',
      )
      Object.assign(error, { code: 'CARRIER_PRODUCTION_RATE_CURRENCY_UNSUPPORTED' })
      throw error
    }
    runtime = await resolveCarrierProductionRatingRuntime({
      organizationId: input.organizationId,
      provider: input.binding.provider,
      integrationAccountGlobalId:
        input.binding.carrierIntegrationAccountGlobalId,
      carrierAccountGlobalId: input.binding.carrierAccountGlobalId,
    })
    if (
      runtime.carrierAccountId !== input.binding.carrierAccountId
      || runtime.credentialVersion !== input.binding.credentialVersion
      || runtime.registeredAddressFingerprint
        !== input.binding.registeredAddressFingerprint
    ) {
      const error = new Error(
        'Production checkout carrier binding changed before rating',
      )
      Object.assign(error, { code: 'CARRIER_PRODUCTION_RATE_BINDING_STALE' })
      throw error
    }
    if (runtime.registeredAddress.countryCode !== 'US') {
      const error = new Error(
        'Production checkout rating requires a U.S. carrier origin',
      )
      Object.assign(error, { code: 'CARRIER_PRODUCTION_ORIGIN_UNSUPPORTED' })
      throw error
    }
    prepared = prepareCarrierWholeShipmentRateRequest({
      binding: {
        organizationId: runtime.organizationId,
        carrierAccountId: runtime.carrierAccountId,
        integrationAccountId: runtime.integrationAccountId,
        credentialRevision: runtime.credentialVersion,
        credentialFingerprint: runtime.credentialFingerprint,
        accountNumber: runtime.credential.accountNumber,
        accountNumberFingerprint: runtime.accountNumberFingerprint,
        provider: runtime.provider,
        environment: 'production',
      },
      origin: {
        name: runtime.senderName,
        phone: null,
        ...runtime.registeredAddress,
        countryCode: 'US' as const,
        residential: null,
      },
      destination: {
        name: input.destination.name,
        line1: input.destination.line1,
        line2: input.destination.line2,
        city: input.destination.city,
        region: input.destination.region,
        postalCode: input.destination.postalCode,
        countryCode: 'US' as const,
        residential: null,
      },
      parcels: input.parcels.map((parcel) => ({
        description: parcel.description,
        length: parcel.exteriorInches.length,
        width: parcel.exteriorInches.width,
        height: parcel.exteriorInches.height,
        dimensionUnit: 'IN',
        weight: parcel.grossPounds,
        weightUnit: 'LB',
      })),
      billing: {
        relationship: 'sender',
        payerAccountNumber: runtime.credential.accountNumber,
        payerAccountNumberFingerprint: runtime.accountNumberFingerprint,
        payerPostalCode: runtime.registeredAddress.postalCode,
        payerCountryCode: runtime.registeredAddress.countryCode,
      },
      expectedCurrency: 'USD',
      fedexPickupType: runtime.provider === 'fedex_rest'
        ? 'DROPOFF_AT_FEDEX_LOCATION'
        : null,
    })
    const result = await executeCarrierWholeShipmentRateRequest({
      preparedRequest: prepared,
      runtimeCredential: {
        provider: runtime.provider,
        environment: 'production',
        credential: runtime.credential,
      },
      timeoutMs: input.timeoutMs,
      signal: input.signal,
    })
    const evidenceGlobalId =
      await writeCarrierProductionRateEvidenceInPostgres({
        organizationId: runtime.organizationId,
        integrationAccountId: runtime.integrationAccountId,
        integrationGlobalId: runtime.integrationGlobalId,
        carrierAccountId: runtime.carrierAccountId,
        carrierAccountGlobalId: runtime.carrierAccountGlobalId,
        billingRelationship: 'sender',
        billingSelectionSnapshot: {
          relationship: 'sender',
          carrierAccountGlobalId: runtime.carrierAccountGlobalId,
          accountNumberLastFour: runtime.accountNumberLastFour,
          registeredAddressFingerprint:
            runtime.registeredAddressFingerprint,
        },
        provider: runtime.provider,
        purpose: 'cartonization_shipment_rate',
        credentialVersion: runtime.credentialVersion,
        adapterVersion: prepared.adapterVersion,
        requestHash: result.evidence.requestHash,
        redactedRequest: result.evidence.redactedRequest,
        redactedResponse: result.evidence.redactedResponse,
        status: 'succeeded',
        providerReference: result.evidence.providerReference,
        errorCode: null,
        actorEmail: input.actorEmail,
        requestedAt: result.evidence.requestedAt,
        completedAt: result.evidence.completedAt,
        carrierSelectionKey,
      })
    return {
      provider: runtime.provider,
      carrierAccountGlobalId: runtime.carrierAccountGlobalId,
      packageCount: input.parcels.length,
      rateScope: 'multi_package_shipment',
      rates: result.rates.map((rate) => ({
        serviceCode: rate.serviceCode,
        serviceName: rate.serviceName,
        amount: rate.amount,
        currency: rate.currency,
        transitDays: rate.transitDays,
        deliveryDate: rate.deliveryDate,
        evidenceGlobalId,
      })),
    }
  } catch (error) {
    if (isIntegrationCredentialRuntimeGateError(error)) throw error
    if (runtime) {
      const fallback = safeFailureRequest({
        provider: input.binding.provider,
        carrierAccountGlobalId: input.binding.carrierAccountGlobalId,
        destination: input.destination,
        packageCount: input.parcels.length,
        parcels: input.parcels,
      })
      const redactedRequest = prepared?.redactedRequest ?? fallback.redacted
      const requestHash = prepared?.requestHash ?? fallback.requestHash
      if (!SHA256.test(requestHash)) throw error
      const code = failureCode(error)
      const evidenceGlobalId =
        await writeCarrierProductionRateEvidenceInPostgres({
          organizationId: runtime.organizationId,
          integrationAccountId: runtime.integrationAccountId,
          integrationGlobalId: runtime.integrationGlobalId,
          carrierAccountId: runtime.carrierAccountId,
          carrierAccountGlobalId: runtime.carrierAccountGlobalId,
          billingRelationship: 'sender',
          billingSelectionSnapshot: {
            relationship: 'sender',
            carrierAccountGlobalId: runtime.carrierAccountGlobalId,
            accountNumberLastFour: runtime.accountNumberLastFour,
            registeredAddressFingerprint:
              runtime.registeredAddressFingerprint,
          },
          provider: runtime.provider,
          purpose: 'cartonization_shipment_rate',
          credentialVersion: runtime.credentialVersion,
          adapterVersion: prepared?.adapterVersion
            ?? 'carrier-whole-shipment-rate-v1',
          requestHash,
          redactedRequest,
          redactedResponse: {
            provider: runtime.provider,
            environment: 'production',
            requestHash,
            rateScope: 'multi_package_shipment',
            packageCount: input.parcels.length,
            errorCode: code,
          },
          status: 'failed',
          providerReference: null,
          errorCode: code,
          actorEmail: input.actorEmail,
          requestedAt,
          completedAt: new Date().toISOString(),
          carrierSelectionKey,
        })
      if (error && typeof error === 'object') {
        Object.assign(error, { rateEvidenceGlobalId: evidenceGlobalId })
      }
    }
    throw error
  }
}
