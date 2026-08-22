import { createHash, randomUUID } from 'node:crypto'
import {
  CarrierCredentialClientError,
  requestCarrierAccessToken,
  type CarrierRuntimeCredential,
} from '@/lib/integrations/carrierCredentialClient'
import {
  CARRIER_SANDBOX_RATE_FIXTURE,
  carrierSandboxPartyFingerprint,
  normalizeCarrierSandboxParty,
  type CarrierSandboxRateFixture,
} from '@/lib/integrations/carrierSandboxRate'

export const CARRIER_SANDBOX_LABEL_ADAPTER_VERSION = 'direct-rest-sandbox-v3'

const LABEL_ENDPOINTS = {
  ups_rest: 'https://wwwcie.ups.com/api/shipments/v2409/ship',
  fedex_rest: 'https://apis-sandbox.fedex.com/ship/v1/shipments',
} as const

const VOID_ENDPOINTS = {
  ups_rest: 'https://wwwcie.ups.com/api/shipments/v2409/void/cancel',
  fedex_rest: 'https://apis-sandbox.fedex.com/ship/v1/shipments/cancel',
} as const

export type SandboxLabelProvider = keyof typeof LABEL_ENDPOINTS
export type SandboxBillingRelationship = 'sender' | 'recipient' | 'third_party'
export type CarrierLabelOutputFormat = 'ZPL' | 'PDF' | 'PNG'
export type CarrierSandboxLabelOutputOption = {
  format: CarrierLabelOutputFormat
  mediaSize: 'label_4x6'
  sourceKind: 'provider_native'
  providerImageType: 'ZPL' | 'ZPLII' | 'PDF' | 'PNG'
  providerStockType: 'HEIGHT_6_WIDTH_4' | 'STOCK_4X6' | 'PAPER_4X6'
}
export type CarrierSandboxLabelShipmentFixture = Omit<
  CarrierSandboxRateFixture,
  'destination'
> & {
  destination: CarrierSandboxRateFixture['destination'] & {
    // Legacy sandbox diagnostics predate address-type selection. New one-off
    // shipment inputs require this explicitly before reaching the adapter.
    residential?: boolean
  }
}
export type CarrierSandboxLabelRuntime = CarrierRuntimeCredential & {
  billingRelationship?: SandboxBillingRelationship
  billingSelectionSnapshot?: Record<string, unknown>
  shipmentFixture?: CarrierSandboxLabelShipmentFixture
}

export type CarrierSandboxLabelEvidence = {
  requestHash: string
  redactedRequest: Record<string, unknown>
  redactedResponse: Record<string, unknown>
  providerReference: string | null
  requestedAt: string
  completedAt: string
}

export type CarrierSandboxLabelResult = {
  provider: SandboxLabelProvider
  environment: 'sandbox'
  trackingNumber: string
  providerLabelId: string
  format: CarrierLabelOutputFormat
  mediaSize: 'label_4x6'
  sourceKind: 'provider_native'
  providerImageType: CarrierSandboxLabelOutputOption['providerImageType']
  providerStockType: CarrierSandboxLabelOutputOption['providerStockType']
  labelPayload: string
  payloadEncoding: 'utf8' | 'base64'
  labelByteLength: number
  labelContentSha256: string
  evidence: CarrierSandboxLabelEvidence
}

export type CarrierSandboxVoidResult = {
  provider: SandboxLabelProvider
  environment: 'sandbox'
  trackingNumber: string
  providerReference: string
  voided: true
  evidence: CarrierSandboxLabelEvidence
}

export type CarrierSandboxLabelLifecycleMode = 'carrier_void' | 'close_sample'

export function carrierSandboxLabelLifecycleMode(
  provider: SandboxLabelProvider,
  trackingNumber: string,
): CarrierSandboxLabelLifecycleMode {
  return (
    provider === 'ups_rest'
    && /^1Z[X]{16}$/i.test(String(trackingNumber || '').trim())
  ) ? 'close_sample' : 'carrier_void'
}

export class CarrierSandboxLabelError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly uncertain: boolean,
    readonly redactedResponse?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'CarrierSandboxLabelError'
  }
}

type CarrierSandboxOperationStage =
  | 'oauth'
  | 'shipment_request_build'
  | 'shipment_request_dispatch'
  | 'provider_response_read'
  | 'provider_response_parse'
  | 'provider_response_status'
  | 'provider_response_validate'

type CarrierSandboxOperationContext = {
  operationStage: CarrierSandboxOperationStage
  providerRequestDispatchAttempted: boolean
  providerResponseReceived: boolean
  providerHttpStatus?: number
}

const PROVIDER_LABEL_OUTPUTS: Record<
  SandboxLabelProvider,
  readonly CarrierSandboxLabelOutputOption[]
> = {
  ups_rest: [{
    format: 'ZPL',
    mediaSize: 'label_4x6',
    sourceKind: 'provider_native',
    providerImageType: 'ZPL',
    providerStockType: 'HEIGHT_6_WIDTH_4',
  }],
  fedex_rest: [
    {
      format: 'ZPL',
      mediaSize: 'label_4x6',
      sourceKind: 'provider_native',
      providerImageType: 'ZPLII',
      providerStockType: 'STOCK_4X6',
    },
    {
      format: 'PDF',
      mediaSize: 'label_4x6',
      sourceKind: 'provider_native',
      providerImageType: 'PDF',
      providerStockType: 'PAPER_4X6',
    },
    {
      format: 'PNG',
      mediaSize: 'label_4x6',
      sourceKind: 'provider_native',
      providerImageType: 'PNG',
      providerStockType: 'PAPER_4X6',
    },
  ],
}

export function carrierSandboxLabelOutputOptions(
  provider: SandboxLabelProvider,
): CarrierSandboxLabelOutputOption[] {
  return PROVIDER_LABEL_OUTPUTS[provider].map((entry) => ({ ...entry }))
}

function labelOutputOption(
  provider: SandboxLabelProvider,
  format: CarrierLabelOutputFormat = 'ZPL',
) {
  const option = PROVIDER_LABEL_OUTPUTS[provider]
    .find((entry) => entry.format === format)
  if (!option) {
    throw new CarrierSandboxLabelError(
      `${provider === 'ups_rest' ? 'UPS' : 'FedEx'} does not provide ${format} as a native 4 x 6 label in this diagnostic`,
      409,
      'CARRIER_LABEL_OUTPUT_UNSUPPORTED',
      false,
    )
  }
  return option
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]
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
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function hash(value: unknown) {
  return createHash('sha256').update(stable(value)).digest('hex')
}

function contentHash(value: Uint8Array) {
  return createHash('sha256').update(value).digest('hex')
}

function requireSandboxRuntime(input: CarrierRuntimeCredential): asserts input is CarrierRuntimeCredential & {
  provider: SandboxLabelProvider
  environment: 'sandbox'
} {
  if (input.environment !== 'sandbox') {
    throw new CarrierSandboxLabelError(
      'Label execution is limited to carrier sandbox accounts',
      409,
      'CARRIER_SANDBOX_REQUIRED',
      false,
    )
  }
  if (input.provider !== 'ups_rest' && input.provider !== 'fedex_rest') {
    throw new CarrierSandboxLabelError(
      'Sandbox label execution is not available for this carrier yet',
      409,
      'CARRIER_SANDBOX_LABEL_UNSUPPORTED',
      false,
    )
  }
  if (!input.credential.accountNumber) {
    throw new CarrierSandboxLabelError(
      'A carrier account number is required for sandbox label execution',
      409,
      'CARRIER_ACCOUNT_REQUIRED',
      false,
    )
  }
}

function serviceCode(provider: SandboxLabelProvider, value: string) {
  const normalized = String(value || '').trim().toUpperCase()
  if (!/^[A-Z0-9_]{1,40}$/.test(normalized)) {
    throw new CarrierSandboxLabelError(
      'The selected carrier service is invalid',
      409,
      'CARRIER_SERVICE_INVALID',
      false,
    )
  }
  if (provider === 'ups_rest') {
    return {
      GROUND: '03',
      UPS_GROUND: '03',
      NEXT_DAY_AIR: '01',
      SECOND_DAY_AIR: '02',
      '2ND_DAY_AIR': '02',
      THREE_DAY_SELECT: '12',
      '3_DAY_SELECT': '12',
      NEXT_DAY_AIR_SAVER: '13',
    }[normalized] || normalized
  }
  return normalized
}

function providerFailureDetails(payload: Record<string, unknown>) {
  const response = record(payload.response)
  const output = record(payload.output)
  const errors = [
    ...list(payload.errors),
    ...list(response.errors),
    ...list(output.errors),
  ]
    .map((entry) => record(entry))
    .map((entry) => text(entry.code || entry.errorCode))
    .filter(Boolean)
    .slice(0, 3)
  return errors.length ? { providerErrorCodes: errors } : {}
}

function providerHttpError(
  status: number,
  action: 'create' | 'void',
  payload: Record<string, unknown> = {},
  correlation: Record<string, string | null> = {},
) {
  const redactedResponse = {
    httpStatus: status,
    ...providerFailureDetails(payload),
    ...correlation,
  }
  if ([400, 401, 403, 404, 409, 422].includes(status)) {
    return new CarrierSandboxLabelError(
      `The carrier rejected the sandbox label ${action} request`,
      409,
      `CARRIER_SANDBOX_LABEL_${action.toUpperCase()}_REJECTED`,
      false,
      redactedResponse,
    )
  }
  if (status === 429) {
    return new CarrierSandboxLabelError(
      'The carrier temporarily rate limited sandbox label execution',
      503,
      'CARRIER_PROVIDER_RATE_LIMITED',
      false,
      redactedResponse,
    )
  }
  return new CarrierSandboxLabelError(
    'The carrier sandbox label service returned an uncertain result',
    503,
    'CARRIER_PROVIDER_RESULT_UNKNOWN',
    true,
    redactedResponse,
  )
}

const SAFE_TRANSPORT_ERROR_CODES = new Set([
  'ABORT_ERR',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETDOWN',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ETIMEDOUT',
  'ERR_INVALID_STATE',
  'ERR_STREAM_PREMATURE_CLOSE',
  'UND_ERR_ABORTED',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
])

function safeExceptionEvidence(error: unknown) {
  const errorRecord = record(error)
  const causeRecord = record(errorRecord.cause)
  const candidateCode = text(errorRecord.code || causeRecord.code).toUpperCase()
  const safeCode = SAFE_TRANSPORT_ERROR_CODES.has(candidateCode)
    ? candidateCode
    : null
  const candidateName = error instanceof Error ? error.name : ''
  const safeName = ['AbortError', 'Error', 'TypeError'].includes(candidateName)
    ? candidateName
    : 'Error'
  return {
    exceptionName: safeName,
    ...(safeCode ? { exceptionCode: safeCode } : {}),
  }
}

function credentialError(error: unknown) {
  if (error instanceof CarrierSandboxLabelError) return error
  const redactedResponse = {
    operationStage: 'oauth',
    providerRequestDispatchAttempted: false,
    providerResponseReceived: false,
    ...safeExceptionEvidence(error),
  }
  if (error instanceof CarrierCredentialClientError) {
    return new CarrierSandboxLabelError(
      error.message,
      error.status,
      error.code,
      false,
      redactedResponse,
    )
  }
  return new CarrierSandboxLabelError(
    'The carrier sandbox credential request failed',
    503,
    'CARRIER_PROVIDER_UNAVAILABLE',
    false,
    redactedResponse,
  )
}

function operationError(
  error: unknown,
  clientTransactionId: string,
  context: CarrierSandboxOperationContext,
) {
  const operationEvidence = {
    clientTransactionId,
    operationStage: context.operationStage,
    providerRequestDispatchAttempted: context.providerRequestDispatchAttempted,
    providerResponseReceived: context.providerResponseReceived,
    ...(context.providerHttpStatus
      ? { httpStatus: context.providerHttpStatus }
      : {}),
  }
  if (error instanceof CarrierSandboxLabelError) {
    return new CarrierSandboxLabelError(
      error.message,
      error.status,
      error.code,
      error.uncertain,
      {
        ...error.redactedResponse,
        ...operationEvidence,
      },
    )
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return new CarrierSandboxLabelError(
      'The carrier sandbox label request timed out with an uncertain result',
      504,
      'CARRIER_PROVIDER_RESULT_UNKNOWN',
      true,
      { ...operationEvidence, ...safeExceptionEvidence(error) },
    )
  }
  return new CarrierSandboxLabelError(
    'The carrier sandbox label request ended with an uncertain result',
    503,
    'CARRIER_PROVIDER_RESULT_UNKNOWN',
    true,
    { ...operationEvidence, ...safeExceptionEvidence(error) },
  )
}

function fixtureAddress(
  value: unknown,
  label: string,
): CarrierSandboxRateFixture['origin'] {
  const address = record(value)
  try {
    return normalizeCarrierSandboxParty({
      name: address.name,
      line1: address.line1 || address.street,
      line2: address.line2 ?? null,
      city: address.city,
      region: address.region || address.state,
      postalCode: address.postalCode,
      countryCode: address.countryCode,
    })
  } catch {
    throw new CarrierSandboxLabelError(
      `${label} is invalid`,
      409,
      'CARRIER_SANDBOX_FIXTURE_INVALID',
      false,
    )
  }
}

function fixtureParcel(value: unknown): CarrierSandboxRateFixture['parcel'] {
  const parcel = record(value)
  const description = text(parcel.description)
  const length = Number(parcel.length)
  const width = Number(parcel.width)
  const height = Number(parcel.height)
  const weight = Number(parcel.weight)
  if (
    !description
    || description.length > 200
    || /[\u0000-\u001f\u007f]/.test(description)
    || ![length, width, height, weight].every((entry) => Number.isFinite(entry) && entry > 0)
    || length > 999
    || width > 999
    || height > 999
    || weight > 10_000
    || parcel.dimensionUnit !== 'IN'
    || parcel.weightUnit !== 'LB'
  ) {
    throw new CarrierSandboxLabelError(
      'The sandbox parcel fixture is invalid',
      409,
      'CARRIER_SANDBOX_FIXTURE_INVALID',
      false,
    )
  }
  return {
    description,
    length,
    width,
    height,
    dimensionUnit: 'IN',
    weight,
    weightUnit: 'LB',
  }
}

function normalizeShipmentFixture(
  value: unknown,
): CarrierSandboxLabelShipmentFixture {
  const fixture = record(value)
  return {
    origin: fixtureAddress(fixture.origin, 'The sandbox origin'),
    destination: {
      ...fixtureAddress(fixture.destination, 'The sandbox destination'),
      // Legacy sandbox fixtures predate the explicit address-type contract.
      // They remain commercial; every new one-off quote supplies this field.
      residential: record(fixture.destination).residential === true,
    },
    parcel: fixtureParcel(fixture.parcel),
  }
}

function fixtureParty(
  address: CarrierSandboxRateFixture['origin'] & { residential?: boolean },
  phoneNumber: string,
) {
  return {
    Name: address.name,
    AttentionName: address.name,
    Phone: { Number: phoneNumber },
    Address: {
      AddressLine: [address.line1, ...(address.line2 ? [address.line2] : [])],
      City: address.city,
      StateProvinceCode: address.region,
      PostalCode: address.postalCode,
      CountryCode: address.countryCode,
      ...(address.residential ? { ResidentialAddressIndicator: '' } : {}),
    },
  }
}

function runtimeBillingRelationship(input: CarrierSandboxLabelRuntime) {
  return input.billingRelationship || 'sender'
}

function runtimeSenderName(input: CarrierSandboxLabelRuntime) {
  return text(record(input.billingSelectionSnapshot).senderName)
    || CARRIER_SANDBOX_RATE_FIXTURE.origin.name
}

function runtimeFixture(input: CarrierSandboxLabelRuntime) {
  if (input.shipmentFixture) return normalizeShipmentFixture(input.shipmentFixture)
  const fixture = normalizeShipmentFixture(CARRIER_SANDBOX_RATE_FIXTURE)
  return {
    ...fixture,
    origin: { ...fixture.origin, name: runtimeSenderName(input) },
  }
}

function registeredBillingAddress(input: CarrierSandboxLabelRuntime) {
  const address = record(record(input.billingSelectionSnapshot).registeredAddress)
  const line1 = text(address.line1)
  const city = text(address.city)
  const state = text(address.region)
  const postalCode = text(address.postalCode)
  const countryCode = text(address.countryCode)
  if (!line1 || !city || !state || !postalCode || !countryCode) {
    return normalizeShipmentFixture(CARRIER_SANDBOX_RATE_FIXTURE).origin
  }
  return fixtureAddress({
    name: runtimeSenderName(input),
    line1,
    line2: text(address.line2) || null,
    city,
    region: state,
    postalCode,
    countryCode,
  }, 'The registered carrier billing address')
}

function upsPaymentInformation(input: CarrierSandboxLabelRuntime) {
  const accountNumber = input.credential.accountNumber!
  const relationship = runtimeBillingRelationship(input)
  if (relationship === 'sender') {
    return {
      ShipmentCharge: [{ Type: '01', BillShipper: { AccountNumber: accountNumber } }],
    }
  }
  const payerAddress = relationship === 'recipient'
    ? runtimeFixture(input).destination
    : registeredBillingAddress(input)
  const payer = {
    AccountNumber: accountNumber,
    Address: {
      PostalCode: payerAddress.postalCode,
      CountryCode: payerAddress.countryCode,
    },
  }
  return {
    ShipmentCharge: [{
      Type: '01',
      ...(relationship === 'recipient'
        ? { BillReceiver: payer }
        : { BillThirdParty: payer }),
    }],
  }
}

function upsCreateRequest(
  input: CarrierSandboxLabelRuntime,
  selectedServiceCode: string,
  fixture: CarrierSandboxLabelShipmentFixture,
  output: CarrierSandboxLabelOutputOption,
) {
  const accountNumber = input.credential.accountNumber!
  return {
    ShipmentRequest: {
      Request: {
        RequestOption: 'nonvalidate',
        TransactionReference: { CustomerContext: 'ClawPilot sandbox Test Product' },
      },
      Shipment: {
        Description: fixture.parcel.description,
        Shipper: {
          ...fixtureParty(fixture.origin, '7405550100'),
          ShipperNumber: accountNumber,
        },
        ShipFrom: fixtureParty(fixture.origin, '7405550100'),
        ShipTo: fixtureParty(fixture.destination, '5085550100'),
        PaymentInformation: upsPaymentInformation(input),
        Service: { Code: selectedServiceCode },
        Package: [{
          Description: fixture.parcel.description,
          Packaging: { Code: '02', Description: 'Customer supplied package' },
          Dimensions: {
            UnitOfMeasurement: { Code: fixture.parcel.dimensionUnit },
            Length: String(fixture.parcel.length),
            Width: String(fixture.parcel.width),
            Height: String(fixture.parcel.height),
          },
          PackageWeight: {
            UnitOfMeasurement: { Code: 'LBS' },
            Weight: String(fixture.parcel.weight),
          },
        }],
      },
      LabelSpecification: {
        LabelImageFormat: { Code: output.providerImageType },
        LabelStockSize: { Height: '6', Width: '4' },
        HTTPUserAgent: 'Mozilla/4.5',
      },
    },
  }
}

function fedexContact(name: string, phoneNumber: string) {
  return {
    personName: name,
    companyName: name,
    phoneNumber,
  }
}

function fedexAddress(
  address: CarrierSandboxRateFixture['origin'] & { residential?: boolean },
) {
  return {
    streetLines: [address.line1, ...(address.line2 ? [address.line2] : [])],
    city: address.city,
    stateOrProvinceCode: address.region,
    postalCode: address.postalCode,
    countryCode: address.countryCode,
    residential: address.residential === true,
  }
}

function fedexPayment(input: CarrierSandboxLabelRuntime) {
  const relationship = runtimeBillingRelationship(input)
  if (relationship === 'sender') return { paymentType: 'SENDER' }
  const payerAddress = relationship === 'recipient'
    ? runtimeFixture(input).destination
    : registeredBillingAddress(input)
  return {
    paymentType: relationship === 'recipient' ? 'RECIPIENT' : 'THIRD_PARTY',
    payor: {
      responsibleParty: {
        accountNumber: { value: input.credential.accountNumber },
        contact: fedexContact(payerAddress.name, '7405550100'),
        address: fedexAddress(payerAddress),
      },
    },
  }
}

function fedexCreateRequest(
  input: CarrierSandboxLabelRuntime,
  selectedServiceCode: string,
  fixture: CarrierSandboxLabelShipmentFixture,
  output: CarrierSandboxLabelOutputOption,
) {
  const accountNumber = input.credential.accountNumber!
  return {
    labelResponseOptions: 'LABEL',
    accountNumber: { value: accountNumber },
    requestedShipment: {
      shipDatestamp: new Date().toISOString().slice(0, 10),
      pickupType: 'DROPOFF_AT_FEDEX_LOCATION',
      serviceType: selectedServiceCode,
      packagingType: 'YOUR_PACKAGING',
      totalPackageCount: 1,
      shipper: {
        contact: fedexContact(fixture.origin.name, '7405550100'),
        address: fedexAddress(fixture.origin),
      },
      recipients: [{
        contact: fedexContact(fixture.destination.name, '5085550100'),
        address: fedexAddress(fixture.destination),
      }],
      shippingChargesPayment: fedexPayment(input),
      labelSpecification: {
        labelFormatType: 'COMMON2D',
        imageType: output.providerImageType,
        labelStockType: output.providerStockType,
      },
      requestedPackageLineItems: [{
        sequenceNumber: 1,
        itemDescription: fixture.parcel.description,
        weight: { units: fixture.parcel.weightUnit, value: fixture.parcel.weight },
        dimensions: {
          length: fixture.parcel.length,
          width: fixture.parcel.width,
          height: fixture.parcel.height,
          units: fixture.parcel.dimensionUnit,
        },
      }],
      totalWeight: fixture.parcel.weight,
    },
  }
}

export function carrierSandboxLabelRequestEvidence(
  provider: SandboxLabelProvider,
  selectedServiceCode: string,
  billingRelationship: SandboxBillingRelationship = 'sender',
  senderName?: string,
  shipmentFixture?: CarrierSandboxLabelShipmentFixture,
  outputFormat: CarrierLabelOutputFormat = 'ZPL',
) {
  const output = labelOutputOption(provider, outputFormat)
  const effectiveServiceCode = serviceCode(provider, selectedServiceCode)
  const fixture = shipmentFixture
    ? normalizeShipmentFixture(shipmentFixture)
    : normalizeShipmentFixture(CARRIER_SANDBOX_RATE_FIXTURE)
  const origin = {
    ...fixture.origin,
    name: shipmentFixture
      ? fixture.origin.name
      : String(senderName || '').trim() || fixture.origin.name,
  }
  const destinationParty: CarrierSandboxRateFixture['destination'] = {
    name: fixture.destination.name,
    line1: fixture.destination.line1,
    line2: fixture.destination.line2,
    city: fixture.destination.city,
    region: fixture.destination.region,
    postalCode: fixture.destination.postalCode,
    countryCode: fixture.destination.countryCode,
  }
  const value = {
    provider,
    environment: 'sandbox',
    purpose: 'sandbox_label_create',
    serviceCode: effectiveServiceCode,
    origin,
    destination: fixture.destination,
    parcel: fixture.parcel,
    billingRelationship,
    label: {
      format: output.format,
      providerImageType: output.providerImageType,
      providerStockType: output.providerStockType,
      mediaSize: output.mediaSize,
      sourceKind: output.sourceKind,
    },
  }
  return {
    requestHash: hash(value),
    redactedRequest: {
      provider,
      environment: 'sandbox',
      purpose: 'sandbox_label_create',
      serviceCode: effectiveServiceCode,
      billingRelationship,
      label: value.label,
      shipment: {
        originFingerprint: carrierSandboxPartyFingerprint(origin),
        destinationFingerprint: carrierSandboxPartyFingerprint(destinationParty),
        origin: {
          region: origin.region,
          countryCode: origin.countryCode,
        },
        destination: {
          region: fixture.destination.region,
          countryCode: fixture.destination.countryCode,
        },
        parcel: fixture.parcel,
      },
    },
  }
}

export function carrierSandboxVoidRequestEvidence(
  provider: SandboxLabelProvider,
  trackingNumber: string,
  providerReference: string,
) {
  const value = {
    provider,
    environment: 'sandbox',
    purpose: 'sandbox_label_void',
    trackingNumber,
    providerReference,
  }
  return { requestHash: hash(value), redactedRequest: value }
}

function invalidLabelResponse(provider: 'UPS' | 'FedEx'): never {
  throw new CarrierSandboxLabelError(
    `${provider} returned an invalid sandbox label response`,
    502,
    'CARRIER_PROVIDER_RESPONSE_INVALID',
    true,
  )
}

function decodeProviderLabel(value: unknown, provider: 'UPS' | 'FedEx') {
  const encoded = text(value).replace(/\s+/g, '')
  const unpadded = encoded.replace(/=+$/, '')
  if (
    !encoded
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
    || encoded.length % 4 === 1
    || (encoded.includes('=') && encoded.length % 4 !== 0)
  ) {
    return invalidLabelResponse(provider)
  }
  const padded = unpadded.padEnd(Math.ceil(unpadded.length / 4) * 4, '=')
  const bytes = Buffer.from(padded, 'base64')
  if (
    !bytes.length
    || bytes.toString('base64').replace(/=+$/, '') !== unpadded
  ) {
    return invalidLabelResponse(provider)
  }
  return bytes
}

function labelMetadata(labelBytes: Uint8Array) {
  return {
    labelByteLength: labelBytes.byteLength,
    labelContentSha256: contentHash(labelBytes),
  }
}

function printableZpl(bytes: Buffer, provider: 'UPS' | 'FedEx') {
  const payload = bytes.toString('utf8')
  const normalized = payload.trim()
  const startCount = normalized.match(/\^XA/g)?.length || 0
  const endCount = normalized.match(/\^XZ/g)?.length || 0
  const copyCounts = [...normalized.matchAll(/\^PQ(\d{1,5})(?=[,^\s]|$)/g)]
    .map((match) => Number(match[1]))
  if (
    !Buffer.from(payload, 'utf8').equals(bytes)
    || !normalized.startsWith('^XA')
    || !normalized.endsWith('^XZ')
    || startCount !== 1
    || endCount !== 1
    || copyCounts.some((count) => count !== 1)
    || /(?:\^PH|~PH|\^PF\d)/.test(normalized)
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(payload)
  ) {
    return invalidLabelResponse(provider)
  }
  return payload
}

function printablePdf(bytes: Buffer, provider: 'UPS' | 'FedEx') {
  const tail = bytes
    .subarray(Math.max(0, bytes.byteLength - 2048))
    .toString('latin1')
  if (
    bytes.subarray(0, 5).toString('ascii') !== '%PDF-'
    || !/%%EOF[\u0000\t\n\f\r ]*$/.test(tail)
  ) {
    return invalidLabelResponse(provider)
  }
  return bytes.toString('base64')
}

function printablePng(bytes: Buffer, provider: 'UPS' | 'FedEx') {
  const signature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ])
  const ihdr = bytes.subarray(12, 16).toString('ascii')
  const width = bytes.byteLength >= 24 ? bytes.readUInt32BE(16) : 0
  const height = bytes.byteLength >= 24 ? bytes.readUInt32BE(20) : 0
  const tail = bytes.subarray(Math.max(0, bytes.byteLength - 32))
  if (
    bytes.byteLength < 45
    || !bytes.subarray(0, 8).equals(signature)
    || ihdr !== 'IHDR'
    || width !== 800
    || height !== 1200
    || !tail.includes(Buffer.from('IEND', 'ascii'))
  ) {
    return invalidLabelResponse(provider)
  }
  return bytes.toString('base64')
}

function parseUpsCreate(
  payload: Record<string, unknown>,
  output: CarrierSandboxLabelOutputOption,
) {
  const response = record(payload.ShipmentResponse)
  const shipment = record(response.ShipmentResults)
  const packageResult = record(list(shipment.PackageResults)[0])
  const shippingLabel = record(packageResult.ShippingLabel)
  const imageFormat = text(record(shippingLabel.ImageFormat).Code).toUpperCase()
  const trackingNumber = text(packageResult.TrackingNumber)
  const providerLabelId = text(shipment.ShipmentIdentificationNumber) || trackingNumber
  if (
    !trackingNumber
    || !providerLabelId
    || output.format !== 'ZPL'
    || imageFormat !== output.providerImageType
  ) {
    return invalidLabelResponse('UPS')
  }
  const labelBytes = decodeProviderLabel(shippingLabel.GraphicImage, 'UPS')
  const labelPayload = printableZpl(labelBytes, 'UPS')
  return {
    trackingNumber,
    providerLabelId,
    labelPayload,
    payloadEncoding: 'utf8' as const,
    ...output,
    ...labelMetadata(labelBytes),
  }
}

function firstFedexPiece(
  payload: Record<string, unknown>,
  output: CarrierSandboxLabelOutputOption,
) {
  const responseOutput = record(payload.output)
  const shipment = record(list(responseOutput.transactionShipments)[0])
  const piece = record(list(shipment.pieceResponses)[0])
  const packageDocument = list(piece.packageDocuments)
    .map((value) => record(value))
    .find((document) => (
      text(document.contentType).toUpperCase() === 'LABEL'
      && (
        !text(document.docType || document.documentType || document.imageType)
        || text(document.docType || document.documentType || document.imageType)
          .toUpperCase() === output.providerImageType
      )
    )) || {}
  const documentPart = record(list(packageDocument.parts)[0])
  return {
    shipment,
    piece,
    labelPayload: text(
      packageDocument.encodedLabel
      || documentPart.image,
    ).replace(/\s+/g, ''),
  }
}

function parseFedexCreate(
  payload: Record<string, unknown>,
  output: CarrierSandboxLabelOutputOption,
) {
  const {
    shipment,
    piece,
    labelPayload: encodedLabel,
  } = firstFedexPiece(payload, output)
  const trackingNumber = text(piece.trackingNumber || shipment.masterTrackingNumber)
  const providerLabelId = text(shipment.masterTrackingNumber) || trackingNumber
  if (!trackingNumber || !providerLabelId) {
    return invalidLabelResponse('FedEx')
  }
  const labelBytes = decodeProviderLabel(encodedLabel, 'FedEx')
  const labelPayload = output.format === 'ZPL'
    ? printableZpl(labelBytes, 'FedEx')
    : output.format === 'PDF'
      ? printablePdf(labelBytes, 'FedEx')
      : printablePng(labelBytes, 'FedEx')
  return {
    trackingNumber,
    providerLabelId,
    labelPayload,
    payloadEncoding: output.format === 'ZPL'
      ? 'utf8' as const
      : 'base64' as const,
    ...output,
    ...labelMetadata(labelBytes),
  }
}

async function readProviderPayload(
  response: Response,
  maximumBytes = 2 * 1024 * 1024,
  onStage?: (stage: 'provider_response_read' | 'provider_response_parse') => void,
) {
  const limit = Math.max(
    64 * 1024,
    Math.min(maximumBytes, 24 * 1024 * 1024),
  )
  const contentLength = Number(response.headers.get('content-length') || 0)
  if (Number.isFinite(contentLength) && contentLength > limit) {
    throw new CarrierSandboxLabelError(
      'The carrier returned an oversized label response',
      502,
      'CARRIER_PROVIDER_RESPONSE_INVALID',
      true,
    )
  }
  onStage?.('provider_response_read')
  const raw = await response.text()
  if (Buffer.byteLength(raw, 'utf8') > limit) {
    throw new CarrierSandboxLabelError(
      'The carrier returned an oversized label response',
      502,
      'CARRIER_PROVIDER_RESPONSE_INVALID',
      true,
    )
  }
  onStage?.('provider_response_parse')
  try {
    return record(JSON.parse(raw))
  } catch {
    throw new CarrierSandboxLabelError(
      'The carrier returned an invalid label response',
      502,
      'CARRIER_PROVIDER_RESPONSE_INVALID',
      true,
    )
  }
}

export async function createCarrierSandboxLabel(
  input: CarrierSandboxLabelRuntime & {
    serviceCode: string
    outputFormat?: CarrierLabelOutputFormat
  },
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<CarrierSandboxLabelResult> {
  requireSandboxRuntime(input)
  const output = labelOutputOption(input.provider, input.outputFormat)
  const selectedServiceCode = serviceCode(input.provider, input.serviceCode)
  const fetchImpl = options.fetchImpl || fetch
  const requestedAt = new Date().toISOString()
  let accessToken: string
  try {
    accessToken = (await requestCarrierAccessToken(input, {
      fetchImpl,
      timeoutMs: options.timeoutMs,
    })).accessToken
  } catch (error) {
    throw credentialError(error)
  }
  const transactionId = randomUUID().replace(/-/g, '')
  const controller = new AbortController()
  const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs || 15_000, 20_000))
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const operationContext: CarrierSandboxOperationContext = {
    operationStage: 'shipment_request_build',
    providerRequestDispatchAttempted: false,
    providerResponseReceived: false,
  }
  try {
    const fixture = runtimeFixture(input)
    const body = input.provider === 'ups_rest'
      ? upsCreateRequest(input, selectedServiceCode, fixture, output)
      : fedexCreateRequest(input, selectedServiceCode, fixture, output)
    const serializedBody = JSON.stringify(body)
    operationContext.operationStage = 'shipment_request_dispatch'
    operationContext.providerRequestDispatchAttempted = true
    const response = await fetchImpl(LABEL_ENDPOINTS[input.provider], {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        ...(input.provider === 'ups_rest'
          ? { transId: transactionId, transactionSrc: 'clawpilot' }
          : {
              'x-customer-transaction-id': transactionId,
              'x-locale': 'en_US',
            }),
      },
      body: serializedBody,
      signal: controller.signal,
    })
    operationContext.providerResponseReceived = true
    operationContext.providerHttpStatus = response.status
    const payload = await readProviderPayload(response, undefined, (stage) => {
      operationContext.operationStage = stage
    })
    if (!response.ok) {
      operationContext.operationStage = 'provider_response_status'
      throw providerHttpError(response.status, 'create', payload, {
        clientTransactionId: transactionId,
        providerTransactionId: response.headers.get('transaction-id')
          || response.headers.get('x-customer-transaction-id'),
      })
    }
    operationContext.operationStage = 'provider_response_validate'
    const parsed = input.provider === 'ups_rest'
      ? parseUpsCreate(payload, output)
      : parseFedexCreate(payload, output)
    const completedAt = new Date().toISOString()
    const safeRequest = carrierSandboxLabelRequestEvidence(
      input.provider,
      selectedServiceCode,
      runtimeBillingRelationship(input),
      runtimeSenderName(input),
      fixture,
      output.format,
    )
    const providerReference = response.headers.get('transaction-id')
      || response.headers.get('x-customer-transaction-id')
      || parsed.providerLabelId
    return {
      provider: input.provider,
      environment: 'sandbox',
      ...parsed,
      evidence: {
        requestHash: safeRequest.requestHash,
        redactedRequest: safeRequest.redactedRequest,
        redactedResponse: {
          trackingNumber: parsed.trackingNumber,
          providerLabelId: parsed.providerLabelId,
          format: parsed.format,
          mediaSize: parsed.mediaSize,
          sourceKind: parsed.sourceKind,
          providerImageType: parsed.providerImageType,
          providerStockType: parsed.providerStockType,
          payloadEncoding: parsed.payloadEncoding,
          labelByteLength: parsed.labelByteLength,
          labelContentSha256: parsed.labelContentSha256,
        },
        providerReference,
        requestedAt,
        completedAt,
      },
    }
  } catch (error) {
    throw operationError(error, transactionId, operationContext)
  } finally {
    clearTimeout(timeout)
  }
}

export async function voidCarrierSandboxLabel(
  input: CarrierRuntimeCredential & {
    trackingNumber: string
    providerReference: string
  },
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<CarrierSandboxVoidResult> {
  requireSandboxRuntime(input)
  const trackingNumber = String(input.trackingNumber || '').trim()
  const providerReference = String(input.providerReference || '').trim()
  if (!trackingNumber || !providerReference) {
    throw new CarrierSandboxLabelError(
      'Tracking and provider references are required to void a sandbox label',
      409,
      'CARRIER_LABEL_REFERENCE_REQUIRED',
      false,
    )
  }
  const fetchImpl = options.fetchImpl || fetch
  const requestedAt = new Date().toISOString()
  let accessToken: string
  try {
    accessToken = (await requestCarrierAccessToken(input, {
      fetchImpl,
      timeoutMs: options.timeoutMs,
    })).accessToken
  } catch (error) {
    throw credentialError(error)
  }
  const transactionId = randomUUID().replace(/-/g, '')
  const controller = new AbortController()
  const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs || 15_000, 20_000))
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const operationContext: CarrierSandboxOperationContext = {
    operationStage: 'shipment_request_build',
    providerRequestDispatchAttempted: false,
    providerResponseReceived: false,
  }
  try {
    const isUps = input.provider === 'ups_rest'
    const serializedBody = isUps
      ? undefined
      : JSON.stringify({
          accountNumber: { value: input.credential.accountNumber },
          trackingNumber,
          deletionControl: 'DELETE_ALL_PACKAGES',
        })
    operationContext.operationStage = 'shipment_request_dispatch'
    operationContext.providerRequestDispatchAttempted = true
    const response = await fetchImpl(
      isUps
        ? `${VOID_ENDPOINTS.ups_rest}/${encodeURIComponent(providerReference)}`
        : VOID_ENDPOINTS.fedex_rest,
      {
        method: isUps ? 'DELETE' : 'PUT',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          ...(isUps
            ? { transId: transactionId, transactionSrc: 'clawpilot' }
            : {
                'x-customer-transaction-id': transactionId,
                'x-locale': 'en_US',
              }),
        },
        ...(isUps ? {} : {
          body: serializedBody,
        }),
        signal: controller.signal,
      },
    )
    operationContext.providerResponseReceived = true
    operationContext.providerHttpStatus = response.status
    const payload = await readProviderPayload(response, undefined, (stage) => {
      operationContext.operationStage = stage
    })
    if (!response.ok) {
      operationContext.operationStage = 'provider_response_status'
      throw providerHttpError(response.status, 'void', payload, {
        clientTransactionId: transactionId,
        providerTransactionId: response.headers.get('transaction-id')
          || response.headers.get('x-customer-transaction-id'),
      })
    }
    operationContext.operationStage = 'provider_response_validate'
    if (isUps) {
      const voidResponse = record(payload.VoidShipmentResponse)
      const summary = record(record(voidResponse.SummaryResult).Status)
      const responseStatus = record(record(voidResponse.Response).ResponseStatus)
      const statusCode = text(summary.Code || responseStatus.Code)
      if (statusCode !== '1') {
        throw new CarrierSandboxLabelError(
          'UPS did not confirm the sandbox label void',
          502,
          'CARRIER_PROVIDER_RESPONSE_INVALID',
          true,
        )
      }
    } else if (record(payload.output).cancelledShipment !== true) {
      throw new CarrierSandboxLabelError(
        'FedEx did not confirm the sandbox label void',
        502,
        'CARRIER_PROVIDER_RESPONSE_INVALID',
        true,
      )
    }
    const completedAt = new Date().toISOString()
    const safeRequest = carrierSandboxVoidRequestEvidence(
      input.provider,
      trackingNumber,
      providerReference,
    )
    return {
      provider: input.provider,
      environment: 'sandbox',
      trackingNumber,
      providerReference,
      voided: true,
      evidence: {
        requestHash: safeRequest.requestHash,
        redactedRequest: safeRequest.redactedRequest,
        redactedResponse: {
          trackingNumber,
          providerReference,
          voided: true,
        },
        providerReference: response.headers.get('transaction-id')
          || response.headers.get('x-customer-transaction-id')
          || providerReference,
        requestedAt,
        completedAt,
      },
    }
  } catch (error) {
    throw operationError(error, transactionId, operationContext)
  } finally {
    clearTimeout(timeout)
  }
}

export function carrierSandboxLabelEndpoints() {
  return { create: LABEL_ENDPOINTS, void: VOID_ENDPOINTS }
}

/**
 * Request construction and response parsing are shared with the production
 * adapter.  They are intentionally auth-free; environment selection and
 * provider I/O remain in the two public executors.
 */
export const carrierLabelAdapterInternals = {
  labelOutputOption,
  serviceCode,
  normalizeShipmentFixture,
  upsCreateRequest,
  fedexCreateRequest,
  parseUpsCreate,
  parseFedexCreate,
  readProviderPayload,
}
