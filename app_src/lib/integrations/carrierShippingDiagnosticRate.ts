import {
  carrierProductionLabelAuthorizationAllowed,
  resolveCarrierProductionRatingRuntime,
  sanitizedCarrierIntegrationError,
  type CarrierProductionRatingRuntime,
} from '@/lib/integrations/carrierIntegrations'
import {
  CarrierWholeShipmentRateClientError,
  executeCarrierWholeShipmentRateRequest,
} from '@/lib/integrations/carrierWholeShipmentRateClient'
import {
  prepareCarrierWholeShipmentRateRequest,
  type CarrierWholeShipmentRateDestination,
  type CarrierWholeShipmentRateParcel,
} from '@/lib/integrations/carrierWholeShipmentRateFoundation'
import { writeCarrierProductionRateEvidenceInPostgres } from '@/lib/persistence/carrierIntegrations'
import { OperationsRequestError } from '@/lib/persistence/operations'
import {
  isIntegrationCredentialRuntimeGateError,
} from '@/lib/integrations/integrationCredentialRuntimeGate.mjs'

export type CarrierShippingDiagnosticDestination = {
  name: string
  line1: string
  line2: string | null
  city: string
  region: string
  postalCode: string
  countryCode: 'US'
  residential: boolean
}

export type CarrierShippingDiagnosticParcel = {
  description: string
  length: number
  width: number
  height: number
  dimensionUnit: 'IN'
  weight: number
  weightUnit: 'LB'
}

export type CarrierProductionShippingDiagnosticRate = {
  provider: 'ups_rest' | 'fedex_rest'
  environment: 'production'
  fixture: {
    origin: CarrierProductionRatingRuntime['registeredAddress'] & { name: string }
    destination: CarrierShippingDiagnosticDestination
    parcel: CarrierShippingDiagnosticParcel
  }
  destinationFingerprint: string
  rates: Array<{
    serviceCode: string
    serviceName: string
    amount: string
    currency: string
    rateType: string | null
    transitDays: number | null
    deliveryDate: string | null
  }>
  testedAt: string
  carrierAccountGlobalId: string
  billingRelationship: 'sender'
  evidenceGlobalId: string
}

function diagnosticError(error: unknown) {
  if (error instanceof OperationsRequestError) return error
  if (error instanceof CarrierWholeShipmentRateClientError) {
    return new OperationsRequestError(error.code, error.message, error.status)
  }
  const sanitized = sanitizedCarrierIntegrationError(error)
  return new OperationsRequestError(
    sanitized.code,
    sanitized.message,
    sanitized.status,
  )
}

function foundationDestination(
  destination: CarrierShippingDiagnosticDestination,
): CarrierWholeShipmentRateDestination {
  return {
    name: destination.name,
    line1: destination.line1,
    line2: destination.line2,
    city: destination.city,
    region: destination.region,
    postalCode: destination.postalCode,
    countryCode: destination.countryCode,
    residential: destination.residential,
  }
}

function foundationParcel(
  provider: 'ups_rest' | 'fedex_rest',
  parcel: CarrierShippingDiagnosticParcel,
): CarrierWholeShipmentRateParcel {
  return {
    ...parcel,
    packageCode: provider === 'ups_rest' ? '02' : 'YOUR_PACKAGING',
  }
}

export async function testCarrierProductionShippingDiagnosticRate(input: {
  organizationId: string
  actorEmail: string
  provider: 'ups_rest' | 'fedex_rest'
  integrationAccountGlobalId: string
  carrierAccountGlobalId: string
  destination: CarrierShippingDiagnosticDestination
  parcel: CarrierShippingDiagnosticParcel
}) : Promise<CarrierProductionShippingDiagnosticRate> {
  const requestedAt = new Date().toISOString()
  let runtime: CarrierProductionRatingRuntime | null = null
  let prepared: ReturnType<typeof prepareCarrierWholeShipmentRateRequest> | null = null
  try {
    if (!carrierProductionLabelAuthorizationAllowed()) {
      throw new OperationsRequestError(
        'CARRIER_PRODUCTION_LABEL_ENVIRONMENT_FORBIDDEN',
        'LIVE production diagnostics are available only in the trusted Railway production service',
        403,
      )
    }
    runtime = await resolveCarrierProductionRatingRuntime({
      organizationId: input.organizationId,
      provider: input.provider,
      integrationAccountGlobalId: input.integrationAccountGlobalId,
      carrierAccountGlobalId: input.carrierAccountGlobalId,
    })
    prepared = prepareCarrierWholeShipmentRateRequest({
      binding: {
        organizationId: runtime.organizationId,
        integrationAccountId: runtime.integrationAccountId,
        carrierAccountId: runtime.carrierAccountId,
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
        countryCode: 'US',
        residential: null,
      },
      destination: foundationDestination(input.destination),
      parcels: [foundationParcel(runtime.provider, input.parcel)],
      billing: {
        relationship: 'sender',
        payerAccountNumber: runtime.credential.accountNumber,
        payerAccountNumberFingerprint: runtime.accountNumberFingerprint,
        payerPostalCode: runtime.registeredAddress.postalCode,
        payerCountryCode: 'US',
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
    })
    const billingSelectionSnapshot = {
      mode: 'explicit_shipping_account_diagnostic',
      integrationAccountGlobalId: runtime.integrationGlobalId,
      carrierAccountGlobalId: runtime.carrierAccountGlobalId,
      carrierAccountDisplayName: runtime.carrierAccountDisplayName,
      accountNumberLastFour: runtime.accountNumberLastFour,
      accountNumberFingerprint: runtime.accountNumberFingerprint,
      credentialFingerprint: runtime.credentialFingerprint,
      registeredAddressFingerprint: runtime.registeredAddressFingerprint,
      senderName: runtime.senderName,
      billingRelationship: 'sender',
    }
    const evidenceGlobalId = await writeCarrierProductionRateEvidenceInPostgres({
      organizationId: runtime.organizationId,
      integrationAccountId: runtime.integrationAccountId,
      integrationGlobalId: runtime.integrationGlobalId,
      carrierAccountId: runtime.carrierAccountId,
      carrierAccountGlobalId: runtime.carrierAccountGlobalId,
      billingRelationship: 'sender',
      billingSelectionSnapshot,
      provider: runtime.provider,
      purpose: 'shipping_account_diagnostic',
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
    })
    return {
      provider: runtime.provider,
      environment: 'production',
      fixture: {
        origin: { name: runtime.senderName, ...runtime.registeredAddress },
        destination: input.destination,
        parcel: input.parcel,
      },
      destinationFingerprint:
        result.evidence.redactedRequest.shipment.destinationFingerprint,
      rates: result.rates,
      testedAt: result.evidence.completedAt,
      carrierAccountGlobalId: runtime.carrierAccountGlobalId,
      billingRelationship: 'sender',
      evidenceGlobalId,
    }
  } catch (error) {
    if (isIntegrationCredentialRuntimeGateError(error)) throw error
    const safe = diagnosticError(error)
    if (runtime && prepared) {
      await writeCarrierProductionRateEvidenceInPostgres({
        organizationId: runtime.organizationId,
        integrationAccountId: runtime.integrationAccountId,
        integrationGlobalId: runtime.integrationGlobalId,
        carrierAccountId: runtime.carrierAccountId,
        carrierAccountGlobalId: runtime.carrierAccountGlobalId,
        billingRelationship: 'sender',
        billingSelectionSnapshot: {
          mode: 'explicit_shipping_account_diagnostic',
          integrationAccountGlobalId: runtime.integrationGlobalId,
          carrierAccountGlobalId: runtime.carrierAccountGlobalId,
          accountNumberLastFour: runtime.accountNumberLastFour,
          accountNumberFingerprint: runtime.accountNumberFingerprint,
          credentialFingerprint: runtime.credentialFingerprint,
          registeredAddressFingerprint: runtime.registeredAddressFingerprint,
          senderName: runtime.senderName,
          billingRelationship: 'sender',
        },
        provider: runtime.provider,
        purpose: 'shipping_account_diagnostic',
        credentialVersion: runtime.credentialVersion,
        adapterVersion: prepared.adapterVersion,
        requestHash: prepared.requestHash,
        redactedRequest: prepared.redactedRequest,
        redactedResponse: { errorCode: safe.code },
        status: 'failed',
        providerReference: null,
        errorCode: safe.code,
        actorEmail: input.actorEmail,
        requestedAt,
        completedAt: new Date().toISOString(),
      }).catch(() => undefined)
    }
    throw safe
  }
}
