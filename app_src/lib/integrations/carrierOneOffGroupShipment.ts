import { createHash } from 'node:crypto'
import {
  CarrierCredentialClientError,
  requestCarrierAccessToken,
  type CarrierRuntimeCredential,
} from '@/lib/integrations/carrierCredentialClient'
import {
  CarrierSandboxLabelError,
  carrierLabelAdapterInternals,
  type CarrierLabelOutputFormat,
  type CarrierSandboxLabelOutputOption,
  type CarrierSandboxLabelShipmentFixture,
  type CarrierSandboxLabelRuntime,
  type SandboxBillingRelationship,
} from '@/lib/integrations/carrierSandboxLabel'

export const CARRIER_ONE_OFF_GROUP_ADAPTER_VERSION = 'direct-rest-mps-v1'
export const CARRIER_ONE_OFF_GROUP_MAX_PACKAGES = 40

type Provider = 'ups_rest' | 'fedex_rest'
type Environment = 'sandbox' | 'production'
type JsonObject = Record<string, unknown>
export type CarrierOneOffGroupLifecycleMode = 'carrier_void' | 'close_sample'

const SHIP_ENDPOINTS: Record<Environment, Record<Provider, string>> = {
  sandbox: {
    ups_rest: 'https://wwwcie.ups.com/api/shipments/v2409/ship',
    fedex_rest: 'https://apis-sandbox.fedex.com/ship/v1/shipments',
  },
  production: {
    ups_rest: 'https://onlinetools.ups.com/api/shipments/v2409/ship',
    fedex_rest: 'https://apis.fedex.com/ship/v1/shipments',
  },
}

const VOID_ENDPOINTS: Record<Environment, Record<Provider, string>> = {
  sandbox: {
    ups_rest: 'https://wwwcie.ups.com/api/shipments/v2409/void/cancel',
    fedex_rest: 'https://apis-sandbox.fedex.com/ship/v1/shipments/cancel',
  },
  production: {
    ups_rest: 'https://onlinetools.ups.com/api/shipments/v2409/void/cancel',
    fedex_rest: 'https://apis.fedex.com/ship/v1/shipments/cancel',
  },
}

export type CarrierOneOffGroupParcel = CarrierSandboxLabelShipmentFixture['parcel'] & {
  packageKey: string
  packageNumber: number
}

export type CarrierOneOffGroupShipmentFixture = Omit<
  CarrierSandboxLabelShipmentFixture,
  'parcel'
> & {
  parcels: CarrierOneOffGroupParcel[]
}

export type CarrierOneOffGroupRuntime = CarrierRuntimeCredential & {
  provider: Provider
  environment: Environment
  credential: CarrierRuntimeCredential['credential'] & { accountNumber: string }
  integrationAccountGlobalId: string
  carrierAccountGlobalId: string
  credentialVersion: number
  credentialFingerprint: string
  accountNumberFingerprint: string
  billingRelationship: SandboxBillingRelationship
  billingSelectionSnapshot: JsonObject
}

type CarrierOneOffGroupRuntimeBinding = {
  integrationAccountGlobalId: string
  carrierAccountGlobalId: string
  credentialVersion: number
  credentialFingerprint: string
  accountNumberFingerprint: string
  billingRelationship: SandboxBillingRelationship
  billingSelectionHash: string
}

export type PreparedCarrierOneOffGroupRequest = {
  adapterVersion: typeof CARRIER_ONE_OFF_GROUP_ADAPTER_VERSION
  provider: Provider
  environment: Environment
  serviceCode: string
  output: CarrierSandboxLabelOutputOption
  shipDate: string
  correlationId: string
  providerEndpoint: string
  providerMethod: 'POST'
  providerBody: JsonObject
  providerBodyHash: string
  requestHash: string
  redactedRequest: JsonObject
  packageKeys: string[]
  runtimeBinding: CarrierOneOffGroupRuntimeBinding
}

export type PreparedCarrierOneOffGroupVoidRequest = {
  adapterVersion: typeof CARRIER_ONE_OFF_GROUP_ADAPTER_VERSION
  provider: Provider
  environment: Environment
  correlationId: string
  providerShipmentId: string
  masterTrackingNumber: string
  packageTrackingNumbers: string[]
  providerEndpoint: string
  providerMethod: 'DELETE' | 'PUT'
  providerBody: JsonObject | null
  providerBodyHash: string
  redactedRequest: JsonObject
  requestHash: string
  runtimeBinding: CarrierOneOffGroupRuntimeBinding
}

export type CarrierOneOffGroupPackageLabel = {
  packageKey: string
  packageNumber: number
  trackingNumber: string
  providerPackageReference: string
  providerLabelId: string
  format: CarrierLabelOutputFormat
  labelPayload: string
  payloadEncoding: 'utf8' | 'base64'
  labelByteLength: number
  labelContentSha256: string
  providerImageType: string
  providerStockType: string
}

export type CarrierOneOffGroupShipmentResult = {
  provider: Provider
  environment: Environment
  masterTrackingNumber: string
  providerShipmentId: string
  lifecycleMode: CarrierOneOffGroupLifecycleMode
  labels: CarrierOneOffGroupPackageLabel[]
  quotedCharge: {
    amountMinor: number
    currency: string
    rateType: string
  } | null
  evidence: {
    requestHash: string
    redactedRequest: JsonObject
    redactedResponse: JsonObject
    providerReference: string
    requestedAt: string
    completedAt: string
  }
}

export type CarrierOneOffGroupVoidResult = {
  provider: Provider
  environment: Environment
  masterTrackingNumber: string
  providerShipmentId: string
  voided: true
  evidence: CarrierOneOffGroupShipmentResult['evidence']
}

export class CarrierOneOffGroupError extends Error {
  readonly status: number
  readonly code: string
  readonly uncertain: boolean
  readonly redactedResponse: JsonObject

  constructor(
    message: string,
    status: number,
    code: string,
    uncertain: boolean,
    redactedResponse: JsonObject = {},
  ) {
    super(message)
    this.name = 'CarrierOneOffGroupError'
    this.status = status
    this.code = code
    this.uncertain = uncertain
    this.redactedResponse = redactedResponse
  }
}

function record(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : {}
}

function list(value: unknown): unknown[] {
  return Array.isArray(value)
    ? value
    : value === null || value === undefined
      ? []
      : [value]
}

function text(value: unknown) {
  return typeof value === 'string'
    ? value.trim()
    : typeof value === 'number'
      ? String(value)
      : ''
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as JsonObject)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function hash(value: unknown) {
  return createHash('sha256').update(stable(value)).digest('hex')
}

function runtimeBinding(
  runtime: CarrierOneOffGroupRuntime,
): CarrierOneOffGroupRuntimeBinding {
  return {
    integrationAccountGlobalId: runtime.integrationAccountGlobalId,
    carrierAccountGlobalId: runtime.carrierAccountGlobalId,
    credentialVersion: runtime.credentialVersion,
    credentialFingerprint: runtime.credentialFingerprint,
    accountNumberFingerprint: runtime.accountNumberFingerprint,
    billingRelationship: runtime.billingRelationship,
    billingSelectionHash: hash(runtime.billingSelectionSnapshot),
  }
}

function hasExactRuntimeBinding(
  runtime: CarrierOneOffGroupRuntime,
  preparedBinding: CarrierOneOffGroupRuntimeBinding,
) {
  return stable(runtimeBinding(runtime)) === stable(preparedBinding)
}

function redactedRuntimeBindingIsExact(
  redactedRequest: JsonObject,
  preparedBinding: CarrierOneOffGroupRuntimeBinding,
) {
  return text(redactedRequest.runtimeBindingHash) === hash(preparedBinding)
}

export function carrierOneOffGroupLifecycleMode(input: {
  provider: Provider
  environment: Environment
  masterTrackingNumber: string
  providerShipmentId: string
  packageTrackingNumbers: string[]
}): CarrierOneOffGroupLifecycleMode {
  const sampleTracking = /^1Z[X]{16}$/i
  const isUpsCieSample = input.provider === 'ups_rest'
    && input.environment === 'sandbox'
    && sampleTracking.test(input.masterTrackingNumber)
    && sampleTracking.test(input.providerShipmentId)
    && input.packageTrackingNumbers.length > 0
    && input.packageTrackingNumbers.every(
      (trackingNumber) => sampleTracking.test(trackingNumber),
    )
  return isUpsCieSample ? 'close_sample' : 'carrier_void'
}

function stableCorrelationId(attemptCorrelationKey: string) {
  const source = createHash('sha256')
    .update(attemptCorrelationKey)
    .digest('hex')
    .slice(0, 32)
  return [
    source.slice(0, 8),
    source.slice(8, 12),
    `4${source.slice(13, 16)}`,
    `a${source.slice(17, 20)}`,
    source.slice(20, 32),
  ].join('-')
}

function normalizedPhone(value: string, label: string) {
  const digits = String(value || '').replace(/[^0-9]/g, '')
  if (digits.length < 7 || digits.length > 15) {
    throw new CarrierOneOffGroupError(
      `${label} is invalid`,
      400,
      'CARRIER_ONE_OFF_GROUP_REQUEST_INVALID',
      false,
    )
  }
  return digits
}

function packageForUps(parcel: CarrierOneOffGroupParcel) {
  return {
    Description: parcel.description,
    Packaging: { Code: '02', Description: 'Customer supplied package' },
    Dimensions: {
      UnitOfMeasurement: { Code: parcel.dimensionUnit },
      Length: String(parcel.length),
      Width: String(parcel.width),
      Height: String(parcel.height),
    },
    PackageWeight: {
      UnitOfMeasurement: { Code: 'LBS' },
      Weight: String(parcel.weight),
    },
  }
}

function packageForFedex(
  parcel: CarrierOneOffGroupParcel,
  groupPackageCount: number,
) {
  return {
    sequenceNumber: parcel.packageNumber,
    groupPackageCount,
    itemDescription: parcel.description,
    weight: { units: parcel.weightUnit, value: parcel.weight },
    dimensions: {
      length: parcel.length,
      width: parcel.width,
      height: parcel.height,
      units: parcel.dimensionUnit,
    },
  }
}

function normalizeFixture(value: CarrierOneOffGroupShipmentFixture) {
  if (
    !Array.isArray(value.parcels)
    || value.parcels.length < 1
    || value.parcels.length > CARRIER_ONE_OFF_GROUP_MAX_PACKAGES
  ) {
    throw new CarrierOneOffGroupError(
      `Synchronous one-off shipment purchase requires 1-${CARRIER_ONE_OFF_GROUP_MAX_PACKAGES} parcels`,
      409,
      'CARRIER_ONE_OFF_GROUP_PACKAGE_COUNT_UNSUPPORTED',
      false,
    )
  }
  const normalized = value.parcels.map((parcel, index) => {
    const expectedNumber = index + 1
    if (
      parcel.packageNumber !== expectedNumber
      || !String(parcel.packageKey || '').trim()
      || String(parcel.packageKey).length > 80
    ) {
      throw new CarrierOneOffGroupError(
        'One-off parcels must retain unique contiguous canonical package order',
        409,
        'CARRIER_ONE_OFF_GROUP_PACKAGE_ORDER_INVALID',
        false,
      )
    }
    const fixture = carrierLabelAdapterInternals.normalizeShipmentFixture({
      origin: value.origin,
      destination: value.destination,
      parcel,
    })
    return {
      ...fixture.parcel,
      packageKey: String(parcel.packageKey).trim(),
      packageNumber: expectedNumber,
    }
  })
  if (new Set(normalized.map((parcel) => parcel.packageKey)).size !== normalized.length) {
    throw new CarrierOneOffGroupError(
      'One-off parcel keys must be unique',
      409,
      'CARRIER_ONE_OFF_GROUP_PACKAGE_ORDER_INVALID',
      false,
    )
  }
  const parties = carrierLabelAdapterInternals.normalizeShipmentFixture({
    origin: value.origin,
    destination: value.destination,
    parcel: normalized[0],
  })
  return { origin: parties.origin, destination: parties.destination, parcels: normalized }
}

export function prepareCarrierOneOffGroupRequest(input: {
  runtime: CarrierOneOffGroupRuntime
  serviceCode: string
  shipmentFixture: CarrierOneOffGroupShipmentFixture
  outputFormat?: CarrierLabelOutputFormat
  shipFromPhone: string
  shipToPhone: string
  shipDate: string
  attemptCorrelationKey: string
}) : PreparedCarrierOneOffGroupRequest {
  if (
    input.runtime.provider !== 'ups_rest'
    && input.runtime.provider !== 'fedex_rest'
  ) {
    throw new CarrierOneOffGroupError(
      'One-off shipment purchase supports UPS and FedEx only',
      409,
      'CARRIER_ONE_OFF_GROUP_PROVIDER_UNSUPPORTED',
      false,
    )
  }
  if (!input.runtime.credential.accountNumber?.trim()) {
    throw new CarrierOneOffGroupError(
      'An exact sender-billing account is required',
      409,
      'CARRIER_ACCOUNT_REQUIRED',
      false,
    )
  }
  if (input.runtime.billingRelationship !== 'sender') {
    throw new CarrierOneOffGroupError(
      'One-off shipment purchase currently requires sender billing',
      409,
      'CARRIER_ACCOUNT_BILLING_NOT_ALLOWED',
      false,
    )
  }
  const attemptCorrelationKey = String(input.attemptCorrelationKey || '').trim()
  if (!/^[A-Za-z0-9:_-]{8,128}$/.test(attemptCorrelationKey)) {
    throw new CarrierOneOffGroupError(
      'A stable shipment-attempt correlation key is required',
      400,
      'CARRIER_ONE_OFF_GROUP_CORRELATION_INVALID',
      false,
    )
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.shipDate)) {
    throw new CarrierOneOffGroupError(
      'A deterministic ship date is required before preparing the carrier call',
      400,
      'CARRIER_ONE_OFF_GROUP_SHIP_DATE_INVALID',
      false,
    )
  }
  const fixture = normalizeFixture(input.shipmentFixture)
  const output = carrierLabelAdapterInternals.labelOutputOption(
    input.runtime.provider,
    input.outputFormat,
  )
  const serviceCode = carrierLabelAdapterInternals.serviceCode(
    input.runtime.provider,
    input.serviceCode,
  )
  const shipFromPhone = normalizedPhone(input.shipFromPhone, 'Sender phone')
  const shipToPhone = normalizedPhone(input.shipToPhone, 'Recipient phone')
  const firstFixture: CarrierSandboxLabelShipmentFixture = {
    origin: fixture.origin,
    destination: fixture.destination,
    parcel: fixture.parcels[0],
  }
  const runtimeForRequest: CarrierSandboxLabelRuntime = {
    ...input.runtime,
    shipmentFixture: firstFixture,
  }
  const providerBody = input.runtime.provider === 'ups_rest'
    ? carrierLabelAdapterInternals.upsCreateRequest(
        runtimeForRequest,
        serviceCode,
        firstFixture,
        output,
      )
    : carrierLabelAdapterInternals.fedexCreateRequest(
        runtimeForRequest,
        serviceCode,
        firstFixture,
        output,
      )
  if (input.runtime.provider === 'ups_rest') {
    const shipmentRequest = record(record(providerBody).ShipmentRequest)
    const request = record(shipmentRequest.Request)
    request.TransactionReference = {
      CustomerContext: input.runtime.environment === 'production'
        ? 'ClawPilot one-off shipment'
        : 'ClawPilot one-off test shipment',
    }
    const shipment = record(shipmentRequest.Shipment)
    for (const key of ['Shipper', 'ShipFrom']) {
      record(shipment[key]).Phone = { Number: shipFromPhone }
    }
    record(shipment.ShipTo).Phone = { Number: shipToPhone }
    shipment.Package = fixture.parcels.map(packageForUps)
    shipment.Description = `ClawPilot one-off shipment (${fixture.parcels.length} parcels)`
    shipment.ShipmentRatingOptions = {
      ...record(shipment.ShipmentRatingOptions),
      NegotiatedRatesIndicator: '',
    }
  } else {
    const requestedShipment = record(record(providerBody).requestedShipment)
    requestedShipment.shipDatestamp = input.shipDate
    requestedShipment.totalPackageCount = fixture.parcels.length
    requestedShipment.oneLabelAtATime = false
    requestedShipment.processingOptionType = 'SYNCHRONOUS_ONLY'
    requestedShipment.requestedPackageLineItems = fixture.parcels.map(
      (parcel) => packageForFedex(parcel, fixture.parcels.length),
    )
    requestedShipment.totalWeight = Number(
      fixture.parcels.reduce((sum, parcel) => sum + parcel.weight, 0).toFixed(3),
    )
    record(record(requestedShipment.shipper).contact).phoneNumber = shipFromPhone
    const recipient = record(list(requestedShipment.recipients)[0])
    record(recipient.contact).phoneNumber = shipToPhone
  }
  const correlationId = stableCorrelationId(attemptCorrelationKey)
  const providerEndpoint = SHIP_ENDPOINTS[input.runtime.environment][input.runtime.provider]
  const providerMethod = 'POST' as const
  const providerBodyHash = hash(providerBody)
  const preparedRuntimeBinding = runtimeBinding(input.runtime)
  const redactedRequest = {
    adapterVersion: CARRIER_ONE_OFF_GROUP_ADAPTER_VERSION,
    provider: input.runtime.provider,
    environment: input.runtime.environment,
    purpose: 'one_off_multi_package_shipment_purchase',
    serviceCode,
    shipDate: input.shipDate,
    correlationId,
    providerEndpoint,
    providerMethod,
    providerBodyHash,
    runtimeBindingHash: hash(preparedRuntimeBinding),
    packageCount: fixture.parcels.length,
    packageKeys: fixture.parcels.map((parcel) => parcel.packageKey),
    packages: fixture.parcels.map((parcel) => ({
      packageKey: parcel.packageKey,
      packageNumber: parcel.packageNumber,
      description: parcel.description,
      length: parcel.length,
      width: parcel.width,
      height: parcel.height,
      dimensionUnit: parcel.dimensionUnit,
      weight: parcel.weight,
      weightUnit: parcel.weightUnit,
    })),
    destination: {
      region: fixture.destination.region,
      postalCode: fixture.destination.postalCode,
      countryCode: fixture.destination.countryCode,
      residential: fixture.destination.residential,
    },
    output: {
      format: output.format,
      mediaSize: output.mediaSize,
      sourceKind: output.sourceKind,
      providerImageType: output.providerImageType,
      providerStockType: output.providerStockType,
    },
    binding: {
      ...preparedRuntimeBinding,
      shipFromPhoneHash: hash({ correlationId, phone: shipFromPhone }),
      shipToPhoneHash: hash({ correlationId, phone: shipToPhone }),
    },
  }
  return {
    adapterVersion: CARRIER_ONE_OFF_GROUP_ADAPTER_VERSION,
    provider: input.runtime.provider,
    environment: input.runtime.environment,
    serviceCode,
    output,
    shipDate: input.shipDate,
    correlationId,
    providerEndpoint,
    providerMethod,
    providerBody,
    providerBodyHash,
    requestHash: hash(redactedRequest),
    redactedRequest,
    packageKeys: fixture.parcels.map((parcel) => parcel.packageKey),
    runtimeBinding: preparedRuntimeBinding,
  }
}

function providerFailure(
  status: number,
  correlationId: string,
  action: 'create' | 'void',
) {
  const evidence = { httpStatus: status, correlationId }
  const knownNoMutation = action === 'create'
    ? [400, 401, 403, 404, 422]
    : [400, 401, 403, 422]
  if (knownNoMutation.includes(status)) {
    return new CarrierOneOffGroupError(
      'The carrier rejected the shipment purchase',
      409,
      'CARRIER_ONE_OFF_GROUP_REJECTED',
      false,
      evidence,
    )
  }
  return new CarrierOneOffGroupError(
    'The carrier shipment result is unknown and requires reconciliation',
    status === 429 ? 503 : 502,
    status === 429
      ? 'CARRIER_PROVIDER_RATE_LIMITED'
      : 'CARRIER_PROVIDER_RESULT_UNKNOWN',
    true,
    evidence,
  )
}

function mappedError(error: unknown, correlationId: string) {
  if (error instanceof CarrierOneOffGroupError) return error
  if (error instanceof CarrierCredentialClientError) {
    return new CarrierOneOffGroupError(error.message, error.status, error.code, false)
  }
  if (error instanceof CarrierSandboxLabelError) {
    return new CarrierOneOffGroupError(
      error.message,
      error.status,
      error.code,
      error.uncertain,
      { ...error.redactedResponse, correlationId },
    )
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return new CarrierOneOffGroupError(
      'The carrier shipment request timed out; reconcile before retrying',
      504,
      'CARRIER_PROVIDER_RESULT_UNKNOWN',
      true,
      { correlationId },
    )
  }
  return new CarrierOneOffGroupError(
    'The carrier shipment result is unknown and requires reconciliation',
    503,
    'CARRIER_PROVIDER_RESULT_UNKNOWN',
    true,
    { correlationId },
  )
}

function parseUpsGroup(
  payload: JsonObject,
  prepared: PreparedCarrierOneOffGroupRequest,
) {
  const shipmentResults = record(record(payload.ShipmentResponse).ShipmentResults)
  const packageResults = list(shipmentResults.PackageResults)
  const providerShipmentId = text(shipmentResults.ShipmentIdentificationNumber)
  if (!providerShipmentId || packageResults.length !== prepared.packageKeys.length) {
    throw new CarrierOneOffGroupError(
      'UPS returned an incomplete multi-package shipment result',
      502,
      'CARRIER_PROVIDER_RESPONSE_INVALID',
      true,
    )
  }
  const labels = packageResults.map((packageResult, index) => {
    const synthetic = {
      ShipmentResponse: {
        ShipmentResults: {
          ShipmentIdentificationNumber: providerShipmentId,
          PackageResults: [packageResult],
        },
      },
    }
    const parsed = carrierLabelAdapterInternals.parseUpsCreate(
      synthetic,
      prepared.output,
    )
    return {
      packageKey: prepared.packageKeys[index],
      packageNumber: index + 1,
      ...parsed,
      providerLabelId: parsed.trackingNumber,
      providerPackageReference: parsed.trackingNumber,
    }
  })
  if (labels[0]?.trackingNumber !== providerShipmentId) {
    throw new CarrierOneOffGroupError(
      'UPS shipment identity did not match the first package tracking number',
      502,
      'CARRIER_PROVIDER_RESPONSE_INVALID',
      true,
    )
  }
  return {
    providerShipmentId,
    masterTrackingNumber: providerShipmentId,
    labels,
    quotedCharge: parseUpsCharge(shipmentResults),
  }
}

function parseUpsCharge(shipmentResults: JsonObject) {
  const candidates = [
    {
      rateType: 'negotiated',
      total: record(record(shipmentResults.NegotiatedRateCharges).TotalCharge),
    },
    {
      rateType: 'published',
      total: record(record(shipmentResults.ShipmentCharges).TotalCharges),
    },
  ]
  for (const candidate of candidates) {
    const currency = text(candidate.total.CurrencyCode).toUpperCase()
    const amount = Number(candidate.total.MonetaryValue)
    if (/^[A-Z]{3}$/.test(currency) && Number.isFinite(amount) && amount >= 0) {
      return {
        amountMinor: Math.round(amount * 100),
        currency,
        rateType: candidate.rateType,
      }
    }
  }
  return null
}

function parseFedexGroup(
  payload: JsonObject,
  prepared: PreparedCarrierOneOffGroupRequest,
) {
  const shipment = record(list(record(payload.output).transactionShipments)[0])
  const pieces = list(shipment.pieceResponses).map(record)
  const providerShipmentId = text(shipment.masterTrackingNumber)
  if (!providerShipmentId || pieces.length !== prepared.packageKeys.length) {
    throw new CarrierOneOffGroupError(
      'FedEx returned an incomplete multi-package shipment result',
      502,
      'CARRIER_PROVIDER_RESPONSE_INVALID',
      true,
    )
  }
  const orderedPieces = pieces.map((piece) => {
    const rawSequence = text(
      piece.packageSequenceNumber ?? piece.sequenceNumber,
    )
    return {
      piece,
      sequence: /^[1-9][0-9]*$/.test(rawSequence)
        ? Number(rawSequence)
        : Number.NaN,
    }
  }).sort((left, right) => left.sequence - right.sequence)
  if (orderedPieces.some((entry, index) => entry.sequence !== index + 1)) {
    throw new CarrierOneOffGroupError(
      'FedEx package label sequence did not match the prepared shipment',
      502,
      'CARRIER_PROVIDER_RESPONSE_INVALID',
      true,
    )
  }
  const labels = orderedPieces.map(({ piece }, index) => {
    const synthetic = {
      output: {
        transactionShipments: [{
          ...shipment,
          pieceResponses: [piece],
        }],
      },
    }
    const parsed = carrierLabelAdapterInternals.parseFedexCreate(
      synthetic,
      prepared.output,
    )
    return {
      packageKey: prepared.packageKeys[index],
      packageNumber: index + 1,
      ...parsed,
      providerLabelId: parsed.trackingNumber,
      providerPackageReference: parsed.trackingNumber,
    }
  })
  return {
    providerShipmentId,
    masterTrackingNumber: providerShipmentId,
    labels,
    quotedCharge: parseFedexCharge(shipment),
  }
}

function parseFedexCharge(shipment: JsonObject) {
  const rating = record(list(shipment.shipmentRating).find(Boolean))
  const detail = record(list(rating.shipmentRateDetails).find(Boolean))
  const total = record(detail.totalNetCharge)
  const currency = text(total.currency).toUpperCase()
  const amount = Number(total.amount)
  return /^[A-Z]{3}$/.test(currency) && Number.isFinite(amount) && amount >= 0
    ? {
        amountMinor: Math.round(amount * 100),
        currency,
        rateType: text(detail.rateType).toLowerCase() || 'provider_returned',
      }
    : null
}

function assertCompleteLabels(
  labels: CarrierOneOffGroupPackageLabel[],
  prepared: PreparedCarrierOneOffGroupRequest,
  providerShipmentId: string,
) {
  const tracking = labels.map((label) => label.trackingNumber)
  const keys = labels.map((label) => label.packageKey)
  const lifecycleMode = carrierOneOffGroupLifecycleMode({
    provider: prepared.provider,
    environment: prepared.environment,
    masterTrackingNumber: providerShipmentId,
    providerShipmentId,
    packageTrackingNumbers: tracking,
  })
  if (
    (new Set(tracking).size !== labels.length && lifecycleMode !== 'close_sample')
    || new Set(keys).size !== labels.length
    || labels.some((label) => !label.labelPayload || !label.labelContentSha256)
  ) {
    throw new CarrierOneOffGroupError(
      'The carrier returned duplicate or incomplete package labels',
      502,
      'CARRIER_PROVIDER_RESPONSE_INVALID',
      true,
    )
  }
}

export async function executeCarrierOneOffGroupShipment(
  input: {
    runtime: CarrierOneOffGroupRuntime
    prepared: PreparedCarrierOneOffGroupRequest
  },
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<CarrierOneOffGroupShipmentResult> {
  const { runtime, prepared } = input
  const redactedRequest = record(prepared.redactedRequest)
  if (
    prepared.adapterVersion !== CARRIER_ONE_OFF_GROUP_ADAPTER_VERSION
    || runtime.provider !== prepared.provider
    || runtime.environment !== prepared.environment
    || text(redactedRequest.adapterVersion) !== prepared.adapterVersion
    || text(redactedRequest.provider) !== prepared.provider
    || text(redactedRequest.environment) !== prepared.environment
    || text(redactedRequest.serviceCode) !== prepared.serviceCode
    || text(redactedRequest.shipDate) !== prepared.shipDate
    || text(redactedRequest.correlationId) !== prepared.correlationId
    || prepared.providerMethod !== 'POST'
    || prepared.providerEndpoint
      !== SHIP_ENDPOINTS[prepared.environment]?.[prepared.provider]
    || text(redactedRequest.providerEndpoint) !== prepared.providerEndpoint
    || text(redactedRequest.providerMethod) !== prepared.providerMethod
    || hash(prepared.providerBody) !== prepared.providerBodyHash
    || text(redactedRequest.providerBodyHash) !== prepared.providerBodyHash
    || stable(redactedRequest.packageKeys) !== stable(prepared.packageKeys)
    || stable(redactedRequest.output) !== stable(prepared.output)
    || hash(prepared.redactedRequest) !== prepared.requestHash
    || !redactedRuntimeBindingIsExact(redactedRequest, prepared.runtimeBinding)
    || !hasExactRuntimeBinding(runtime, prepared.runtimeBinding)
  ) {
    throw new CarrierOneOffGroupError(
      'Prepared carrier shipment evidence changed before execution',
      409,
      'CARRIER_ONE_OFF_GROUP_PREPARED_EVIDENCE_INVALID',
      false,
    )
  }
  const fetchImpl = options.fetchImpl || fetch
  const requestedAt = new Date().toISOString()
  const controller = new AbortController()
  const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs || 15_000, 20_000))
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const token = await requestCarrierAccessToken(runtime, {
      fetchImpl,
      timeoutMs,
      signal: controller.signal,
    })
    const response = await fetchImpl(
      prepared.providerEndpoint,
      {
        method: prepared.providerMethod,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token.accessToken}`,
          'Content-Type': 'application/json',
          ...(prepared.provider === 'ups_rest'
            ? {
                transId: prepared.correlationId.replace(/-/g, ''),
                transactionSrc: 'clawpilot',
              }
            : {
                'x-customer-transaction-id': prepared.correlationId,
                'x-locale': 'en_US',
              }),
        },
        body: JSON.stringify(prepared.providerBody),
        signal: controller.signal,
        redirect: 'error',
      },
    )
    // One synchronous MPS response contains every provider-native ZPL label.
    // Bound it by package count instead of applying the single-label 2 MiB cap.
    const payload = await carrierLabelAdapterInternals.readProviderPayload(
      response,
      (256 * 1024) + (prepared.packageKeys.length * 512 * 1024),
    )
    if (!response.ok) {
      throw providerFailure(response.status, prepared.correlationId, 'create')
    }
    const parsed = prepared.provider === 'ups_rest'
      ? parseUpsGroup(payload, prepared)
      : parseFedexGroup(payload, prepared)
    assertCompleteLabels(parsed.labels, prepared, parsed.providerShipmentId)
    const lifecycleMode = carrierOneOffGroupLifecycleMode({
      provider: prepared.provider,
      environment: prepared.environment,
      masterTrackingNumber: parsed.masterTrackingNumber,
      providerShipmentId: parsed.providerShipmentId,
      packageTrackingNumbers: parsed.labels.map((label) => label.trackingNumber),
    })
    const completedAt = new Date().toISOString()
    const redactedResponse = {
      providerShipmentId: parsed.providerShipmentId,
      masterTrackingNumber: parsed.masterTrackingNumber,
      packageCount: parsed.labels.length,
      packages: parsed.labels.map((label) => ({
        packageKey: label.packageKey,
        packageNumber: label.packageNumber,
        trackingNumber: label.trackingNumber,
        providerPackageReference: label.providerPackageReference,
        labelContentSha256: label.labelContentSha256,
        labelByteLength: label.labelByteLength,
      })),
      quotedCharge: parsed.quotedCharge,
      lifecycleMode,
      httpTransactionReference: response.headers.get('transaction-id')
        || response.headers.get('x-customer-transaction-id')
        || prepared.correlationId,
    }
    return {
      provider: prepared.provider,
      environment: prepared.environment,
      ...parsed,
      lifecycleMode,
      evidence: {
        requestHash: prepared.requestHash,
        redactedRequest: prepared.redactedRequest,
        redactedResponse,
        providerReference: parsed.providerShipmentId,
        requestedAt,
        completedAt,
      },
    }
  } catch (error) {
    throw mappedError(error, prepared.correlationId)
  } finally {
    clearTimeout(timeout)
  }
}

export function prepareCarrierOneOffGroupVoidRequest(input: {
  runtime: CarrierOneOffGroupRuntime
  masterTrackingNumber: string
  providerShipmentId: string
  packageTrackingNumbers: string[]
  attemptCorrelationKey: string
}): PreparedCarrierOneOffGroupVoidRequest {
  const masterTrackingNumber = text(input.masterTrackingNumber)
  const providerShipmentId = text(input.providerShipmentId)
  const packageTrackingNumbers = input.packageTrackingNumbers.map(text)
  const attemptCorrelationKey = text(input.attemptCorrelationKey)
  if (
    !masterTrackingNumber
    || !providerShipmentId
    || packageTrackingNumbers.length < 1
    || packageTrackingNumbers.length > CARRIER_ONE_OFF_GROUP_MAX_PACKAGES
    || packageTrackingNumbers.some((value) => !value)
    || !/^[A-Za-z0-9:_-]{8,128}$/.test(attemptCorrelationKey)
  ) {
    throw new CarrierOneOffGroupError(
      'The complete provider shipment is required for whole-shipment void',
      400,
      'CARRIER_ONE_OFF_GROUP_VOID_INVALID',
      false,
    )
  }
  const lifecycleMode = carrierOneOffGroupLifecycleMode({
    provider: input.runtime.provider,
    environment: input.runtime.environment,
    masterTrackingNumber,
    providerShipmentId,
    packageTrackingNumbers,
  })
  if (lifecycleMode === 'close_sample') {
    throw new CarrierOneOffGroupError(
      'UPS CIE sample shipment groups must be closed locally without a carrier void call',
      409,
      'CARRIER_ONE_OFF_GROUP_SAMPLE_CLOSE_REQUIRED',
      false,
    )
  }
  if (new Set(packageTrackingNumbers).size !== packageTrackingNumbers.length) {
    throw new CarrierOneOffGroupError(
      'Provider package tracking numbers must be unique for carrier void',
      409,
      'CARRIER_ONE_OFF_GROUP_VOID_INVALID',
      false,
    )
  }
  const correlationId = stableCorrelationId(attemptCorrelationKey)
  const isUps = input.runtime.provider === 'ups_rest'
  const providerEndpoint = isUps
    ? `${VOID_ENDPOINTS[input.runtime.environment].ups_rest}/${encodeURIComponent(providerShipmentId)}`
    : VOID_ENDPOINTS[input.runtime.environment].fedex_rest
  const providerMethod = isUps ? 'DELETE' as const : 'PUT' as const
  const providerBody = isUps
    ? null
    : {
        accountNumber: { value: input.runtime.credential.accountNumber },
        trackingNumber: masterTrackingNumber,
        deletionControl: 'DELETE_ALL_PACKAGES',
      }
  const providerBodyHash = hash(providerBody)
  const preparedRuntimeBinding = runtimeBinding(input.runtime)
  const redactedRequest = {
    adapterVersion: CARRIER_ONE_OFF_GROUP_ADAPTER_VERSION,
    provider: input.runtime.provider,
    environment: input.runtime.environment,
    purpose: 'one_off_multi_package_shipment_void',
    correlationId,
    providerShipmentId,
    masterTrackingNumber,
    packageTrackingNumbers,
    providerEndpoint,
    providerMethod,
    providerBodyHash,
    runtimeBindingHash: hash(preparedRuntimeBinding),
    binding: preparedRuntimeBinding,
  }
  return {
    adapterVersion: CARRIER_ONE_OFF_GROUP_ADAPTER_VERSION,
    provider: input.runtime.provider,
    environment: input.runtime.environment,
    correlationId,
    providerShipmentId,
    masterTrackingNumber,
    packageTrackingNumbers,
    providerEndpoint,
    providerMethod,
    providerBody,
    providerBodyHash,
    redactedRequest,
    requestHash: hash(redactedRequest),
    runtimeBinding: preparedRuntimeBinding,
  }
}

export async function executeCarrierOneOffGroupVoid(
  input: {
    runtime: CarrierOneOffGroupRuntime
    prepared: PreparedCarrierOneOffGroupVoidRequest
  },
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<CarrierOneOffGroupVoidResult> {
  const { runtime, prepared } = input
  const redactedRequest = record(prepared.redactedRequest)
  if (
    prepared.adapterVersion !== CARRIER_ONE_OFF_GROUP_ADAPTER_VERSION
    || runtime.provider !== prepared.provider
    || runtime.environment !== prepared.environment
    || text(redactedRequest.adapterVersion) !== prepared.adapterVersion
    || text(redactedRequest.provider) !== prepared.provider
    || text(redactedRequest.environment) !== prepared.environment
    || text(redactedRequest.correlationId) !== prepared.correlationId
    || text(redactedRequest.providerShipmentId) !== prepared.providerShipmentId
    || text(redactedRequest.masterTrackingNumber) !== prepared.masterTrackingNumber
    || stable(redactedRequest.packageTrackingNumbers)
      !== stable(prepared.packageTrackingNumbers)
    || prepared.providerMethod !== (prepared.provider === 'ups_rest' ? 'DELETE' : 'PUT')
    || prepared.providerEndpoint !== (
      prepared.provider === 'ups_rest'
        ? `${VOID_ENDPOINTS[prepared.environment].ups_rest}/${encodeURIComponent(prepared.providerShipmentId)}`
        : VOID_ENDPOINTS[prepared.environment].fedex_rest
    )
    || text(redactedRequest.providerEndpoint) !== prepared.providerEndpoint
    || text(redactedRequest.providerMethod) !== prepared.providerMethod
    || hash(prepared.providerBody) !== prepared.providerBodyHash
    || text(redactedRequest.providerBodyHash) !== prepared.providerBodyHash
    || hash(prepared.redactedRequest) !== prepared.requestHash
    || !redactedRuntimeBindingIsExact(redactedRequest, prepared.runtimeBinding)
    || !hasExactRuntimeBinding(runtime, prepared.runtimeBinding)
  ) {
    throw new CarrierOneOffGroupError(
      'Prepared carrier void evidence changed before execution',
      409,
      'CARRIER_ONE_OFF_GROUP_PREPARED_EVIDENCE_INVALID',
      false,
    )
  }
  const fetchImpl = options.fetchImpl || fetch
  const requestedAt = new Date().toISOString()
  const controller = new AbortController()
  const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs || 15_000, 20_000))
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const token = await requestCarrierAccessToken(runtime, {
      fetchImpl,
      timeoutMs,
      signal: controller.signal,
    })
    const isUps = prepared.provider === 'ups_rest'
    const response = await fetchImpl(
      prepared.providerEndpoint,
      {
        method: prepared.providerMethod,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token.accessToken}`,
          'Content-Type': 'application/json',
          ...(isUps
            ? {
                transId: prepared.correlationId.replace(/-/g, ''),
                transactionSrc: 'clawpilot',
              }
            : {
                'x-customer-transaction-id': prepared.correlationId,
                'x-locale': 'en_US',
              }),
        },
        ...(prepared.providerBody === null
          ? {}
          : { body: JSON.stringify(prepared.providerBody) }),
        signal: controller.signal,
        redirect: 'error',
      },
    )
    const payload = await carrierLabelAdapterInternals.readProviderPayload(response)
    if (!response.ok) {
      throw providerFailure(response.status, prepared.correlationId, 'void')
    }
    if (isUps) {
      const source = record(payload.VoidShipmentResponse)
      const status = record(record(source.SummaryResult).Status)
      const responseStatus = record(record(source.Response).ResponseStatus)
      const packageResults = list(source.PackageLevelResults).map(record)
      const expectedTracking = [...prepared.packageTrackingNumbers].sort()
      const returnedTracking = packageResults
        .map((value) => text(value.TrackingNumber))
        .sort()
      const packageStatuses = packageResults
        .map((value) => text(record(value.Status).Code))
      if (
        text(status.Code || responseStatus.Code) !== '1'
        || packageResults.length !== prepared.packageTrackingNumbers.length
        || stable(returnedTracking) !== stable(expectedTracking)
        || packageStatuses.some((code) => code !== '1')
      ) {
        throw new CarrierOneOffGroupError(
          'UPS did not confirm the whole-shipment void',
          502,
          'CARRIER_PROVIDER_RESPONSE_INVALID',
          true,
        )
      }
    } else if (record(payload.output).cancelledShipment !== true) {
      throw new CarrierOneOffGroupError(
        'FedEx did not confirm the whole-shipment cancellation',
        502,
        'CARRIER_PROVIDER_RESPONSE_INVALID',
        true,
      )
    }
    const completedAt = new Date().toISOString()
    const redactedResponse = {
      providerShipmentId: prepared.providerShipmentId,
      masterTrackingNumber: prepared.masterTrackingNumber,
      packageTrackingNumbers: prepared.packageTrackingNumbers,
      voided: true,
      httpTransactionReference: response.headers.get('transaction-id')
        || response.headers.get('x-customer-transaction-id')
        || prepared.correlationId,
    }
    return {
      provider: prepared.provider,
      environment: prepared.environment,
      providerShipmentId: prepared.providerShipmentId,
      masterTrackingNumber: prepared.masterTrackingNumber,
      voided: true,
      evidence: {
        requestHash: prepared.requestHash,
        redactedRequest: prepared.redactedRequest,
        redactedResponse,
        providerReference: prepared.providerShipmentId,
        requestedAt,
        completedAt,
      },
    }
  } catch (error) {
    throw mappedError(error, prepared.correlationId)
  } finally {
    clearTimeout(timeout)
  }
}

export function carrierOneOffGroupEndpoints() {
  return { ship: SHIP_ENDPOINTS, void: VOID_ENDPOINTS }
}
