import { createHash, randomUUID } from 'node:crypto'
import {
  CarrierCredentialClientError,
  requestCarrierAccessToken,
  type CarrierRuntimeCredential,
} from '@/lib/integrations/carrierCredentialClient'
import { CARRIER_SANDBOX_RATE_FIXTURE } from '@/lib/integrations/carrierSandboxRate'

export const CARRIER_SANDBOX_LABEL_ADAPTER_VERSION = 'direct-rest-sandbox-v1'

const LABEL_ENDPOINTS = {
  ups_rest: 'https://wwwcie.ups.com/api/shipments/v2409/ship',
  fedex_rest: 'https://apis-sandbox.fedex.com/ship/v1/shipments',
} as const

const VOID_ENDPOINTS = {
  ups_rest: 'https://wwwcie.ups.com/api/shipments/v2409/void/cancel',
  fedex_rest: 'https://apis-sandbox.fedex.com/ship/v1/shipments/cancel',
} as const

type SandboxLabelProvider = keyof typeof LABEL_ENDPOINTS
type SandboxBillingRelationship = 'sender' | 'recipient' | 'third_party'
type SandboxAddress = {
  name: string
  street: string
  city: string
  state: string
  postalCode: string
  countryCode: string
}
type CarrierSandboxLabelRuntime = CarrierRuntimeCredential & {
  billingRelationship?: SandboxBillingRelationship
  billingSelectionSnapshot?: Record<string, unknown>
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
  format: 'ZPL' | 'PDF'
  labelPayload: string
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

export class CarrierSandboxLabelError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly uncertain: boolean,
  ) {
    super(message)
    this.name = 'CarrierSandboxLabelError'
  }
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

function providerHttpError(status: number, action: 'create' | 'void') {
  if ([400, 401, 403, 404, 409, 422].includes(status)) {
    return new CarrierSandboxLabelError(
      `The carrier rejected the sandbox label ${action} request`,
      409,
      `CARRIER_SANDBOX_LABEL_${action.toUpperCase()}_REJECTED`,
      false,
    )
  }
  if (status === 429) {
    return new CarrierSandboxLabelError(
      'The carrier temporarily rate limited sandbox label execution',
      503,
      'CARRIER_PROVIDER_RATE_LIMITED',
      false,
    )
  }
  return new CarrierSandboxLabelError(
    'The carrier sandbox label service returned an uncertain result',
    503,
    'CARRIER_PROVIDER_RESULT_UNKNOWN',
    true,
  )
}

function credentialError(error: unknown) {
  if (error instanceof CarrierSandboxLabelError) return error
  if (error instanceof CarrierCredentialClientError) {
    return new CarrierSandboxLabelError(error.message, error.status, error.code, false)
  }
  return new CarrierSandboxLabelError(
    'The carrier sandbox credential request failed',
    503,
    'CARRIER_PROVIDER_UNAVAILABLE',
    false,
  )
}

function operationError(error: unknown) {
  if (error instanceof CarrierSandboxLabelError) return error
  if (error instanceof Error && error.name === 'AbortError') {
    return new CarrierSandboxLabelError(
      'The carrier sandbox label request timed out with an uncertain result',
      504,
      'CARRIER_PROVIDER_RESULT_UNKNOWN',
      true,
    )
  }
  return new CarrierSandboxLabelError(
    'The carrier sandbox label request ended with an uncertain result',
    503,
    'CARRIER_PROVIDER_RESULT_UNKNOWN',
    true,
  )
}

function fixtureParty(address: SandboxAddress, phoneNumber: string) {
  return {
    Name: address.name,
    AttentionName: address.name,
    Phone: { Number: phoneNumber },
    Address: {
      AddressLine: [address.street],
      City: address.city,
      StateProvinceCode: address.state,
      PostalCode: address.postalCode,
      CountryCode: address.countryCode,
    },
  }
}

function runtimeBillingRelationship(input: CarrierSandboxLabelRuntime) {
  return input.billingRelationship || 'sender'
}

function registeredBillingAddress(input: CarrierSandboxLabelRuntime) {
  const address = record(record(input.billingSelectionSnapshot).registeredAddress)
  const line1 = text(address.line1)
  const city = text(address.city)
  const state = text(address.region)
  const postalCode = text(address.postalCode)
  const countryCode = text(address.countryCode)
  if (!line1 || !city || !state || !postalCode || !countryCode) {
    return CARRIER_SANDBOX_RATE_FIXTURE.origin
  }
  return {
    name: input.credential.accountNumber || 'Carrier account payer',
    street: line1,
    city,
    state,
    postalCode,
    countryCode,
  }
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
    ? CARRIER_SANDBOX_RATE_FIXTURE.destination
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

function upsCreateRequest(input: CarrierSandboxLabelRuntime, selectedServiceCode: string) {
  const fixture = CARRIER_SANDBOX_RATE_FIXTURE
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
        LabelImageFormat: { Code: 'ZPL' },
        LabelStockSize: { Height: '6', Width: '4' },
        HTTPUserAgent: 'ClawPilot',
      },
    },
  }
}

function fedexContact(name: string, phoneNumber: string) {
  return {
    personName: name,
    companyName: 'ClawPilot Sandbox',
    phoneNumber,
  }
}

function fedexAddress(address: SandboxAddress) {
  return {
    streetLines: [address.street],
    city: address.city,
    stateOrProvinceCode: address.state,
    postalCode: address.postalCode,
    countryCode: address.countryCode,
    residential: false,
  }
}

function fedexPayment(input: CarrierSandboxLabelRuntime) {
  const relationship = runtimeBillingRelationship(input)
  if (relationship === 'sender') return { paymentType: 'SENDER' }
  const payerAddress = relationship === 'recipient'
    ? CARRIER_SANDBOX_RATE_FIXTURE.destination
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

function fedexCreateRequest(input: CarrierSandboxLabelRuntime, selectedServiceCode: string) {
  const fixture = CARRIER_SANDBOX_RATE_FIXTURE
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
        imageType: 'PDF',
        labelStockType: 'PAPER_4X6',
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
) {
  const effectiveServiceCode = serviceCode(provider, selectedServiceCode)
  const value = {
    provider,
    environment: 'sandbox',
    purpose: 'sandbox_label_create',
    serviceCode: effectiveServiceCode,
    origin: CARRIER_SANDBOX_RATE_FIXTURE.origin,
    destination: CARRIER_SANDBOX_RATE_FIXTURE.destination,
    parcel: CARRIER_SANDBOX_RATE_FIXTURE.parcel,
    billingRelationship,
  }
  return { requestHash: hash(value), redactedRequest: value }
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

function parseUpsCreate(payload: Record<string, unknown>) {
  const response = record(payload.ShipmentResponse)
  const shipment = record(response.ShipmentResults)
  const packageResult = record(list(shipment.PackageResults)[0])
  const shippingLabel = record(packageResult.ShippingLabel)
  const imageFormat = text(record(shippingLabel.ImageFormat).Code).toUpperCase()
  const trackingNumber = text(packageResult.TrackingNumber)
  const providerLabelId = text(shipment.ShipmentIdentificationNumber) || trackingNumber
  const labelPayload = text(shippingLabel.GraphicImage).replace(/\s+/g, '')
  if (!trackingNumber || !providerLabelId || !labelPayload || imageFormat !== 'ZPL') {
    throw new CarrierSandboxLabelError(
      'UPS returned an invalid sandbox label response',
      502,
      'CARRIER_PROVIDER_RESPONSE_INVALID',
      true,
    )
  }
  return { trackingNumber, providerLabelId, labelPayload, format: 'ZPL' as const }
}

function firstFedexPiece(payload: Record<string, unknown>) {
  const output = record(payload.output)
  const shipment = record(list(output.transactionShipments)[0])
  const piece = record(list(shipment.pieceResponses)[0])
  const packageDocument = record(list(piece.packageDocuments)[0])
  const documentPart = record(list(packageDocument.parts)[0])
  const completed = record(shipment.completedShipmentDetail)
  const completedPackage = record(list(completed.completedPackageDetails)[0])
  const completedLabel = record(completedPackage.label)
  const completedPart = record(list(completedLabel.parts)[0])
  return {
    shipment,
    piece,
    labelPayload: text(
      packageDocument.encodedLabel
      || documentPart.image
      || completedPart.image,
    ).replace(/\s+/g, ''),
  }
}

function parseFedexCreate(payload: Record<string, unknown>) {
  const { shipment, piece, labelPayload } = firstFedexPiece(payload)
  const trackingNumber = text(piece.trackingNumber || shipment.masterTrackingNumber)
  const providerLabelId = text(shipment.masterTrackingNumber) || trackingNumber
  if (!trackingNumber || !providerLabelId || !labelPayload) {
    throw new CarrierSandboxLabelError(
      'FedEx returned an invalid sandbox label response',
      502,
      'CARRIER_PROVIDER_RESPONSE_INVALID',
      true,
    )
  }
  return { trackingNumber, providerLabelId, labelPayload, format: 'PDF' as const }
}

async function readProviderPayload(response: Response) {
  const limit = 2 * 1024 * 1024
  const contentLength = Number(response.headers.get('content-length') || 0)
  if (Number.isFinite(contentLength) && contentLength > limit) {
    throw new CarrierSandboxLabelError(
      'The carrier returned an oversized label response',
      502,
      'CARRIER_PROVIDER_RESPONSE_INVALID',
      true,
    )
  }
  const raw = await response.text()
  if (Buffer.byteLength(raw, 'utf8') > limit) {
    throw new CarrierSandboxLabelError(
      'The carrier returned an oversized label response',
      502,
      'CARRIER_PROVIDER_RESPONSE_INVALID',
      true,
    )
  }
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
  input: CarrierSandboxLabelRuntime & { serviceCode: string },
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<CarrierSandboxLabelResult> {
  requireSandboxRuntime(input)
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
  const transactionId = randomUUID()
  const controller = new AbortController()
  const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs || 15_000, 20_000))
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const body = input.provider === 'ups_rest'
      ? upsCreateRequest(input, selectedServiceCode)
      : fedexCreateRequest(input, selectedServiceCode)
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
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!response.ok) throw providerHttpError(response.status, 'create')
    const payload = await readProviderPayload(response)
    const parsed = input.provider === 'ups_rest'
      ? parseUpsCreate(payload)
      : parseFedexCreate(payload)
    const completedAt = new Date().toISOString()
    const safeRequest = carrierSandboxLabelRequestEvidence(
      input.provider,
      selectedServiceCode,
      runtimeBillingRelationship(input),
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
          labelByteLength: Buffer.byteLength(parsed.labelPayload, 'utf8'),
        },
        providerReference,
        requestedAt,
        completedAt,
      },
    }
  } catch (error) {
    throw operationError(error)
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
  const transactionId = randomUUID()
  const controller = new AbortController()
  const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs || 15_000, 20_000))
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const isUps = input.provider === 'ups_rest'
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
          body: JSON.stringify({
            accountNumber: { value: input.credential.accountNumber },
            trackingNumber,
            deletionControl: 'DELETE_ALL_PACKAGES',
          }),
        }),
        signal: controller.signal,
      },
    )
    if (!response.ok) throw providerHttpError(response.status, 'void')
    const payload = await readProviderPayload(response)
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
        redactedResponse: { trackingNumber, providerReference, voided: true },
        providerReference: response.headers.get('transaction-id')
          || response.headers.get('x-customer-transaction-id')
          || providerReference,
        requestedAt,
        completedAt,
      },
    }
  } catch (error) {
    throw operationError(error)
  } finally {
    clearTimeout(timeout)
  }
}

export function carrierSandboxLabelEndpoints() {
  return { create: LABEL_ENDPOINTS, void: VOID_ENDPOINTS }
}
