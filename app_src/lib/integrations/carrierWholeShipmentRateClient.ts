import {
  CarrierCredentialClientError,
  requestCarrierAccessToken,
  type CarrierRuntimeCredential,
} from '@/lib/integrations/carrierCredentialClient'
import {
  assertIntegrationCredentialProviderIoReady,
  isIntegrationCredentialRuntimeGateError,
} from '@/lib/integrations/integrationCredentialRuntimeGate.mjs'
import {
  parseCarrierWholeShipmentRateResponse,
  sealPreparedCarrierWholeShipmentRateRequest,
  type ParsedCarrierWholeShipmentRateResponse,
  type PreparedCarrierWholeShipmentRateRequest,
} from '@/lib/integrations/carrierWholeShipmentRateFoundation'

const DEFAULT_TIMEOUT_MS = 12_000
const MIN_TIMEOUT_MS = 1_000
const MAX_TIMEOUT_MS = 15_000
const BASE_RESPONSE_LIMIT_BYTES = 128 * 1024
const RESPONSE_BYTES_PER_ADDITIONAL_PACKAGE = 32 * 1024
const HARD_RESPONSE_LIMIT_BYTES = 2 * 1024 * 1024

export class CarrierWholeShipmentRateClientError extends Error {
  readonly status: number
  readonly code: string

  constructor(message: string, status: number, code: string) {
    super(message)
    this.name = 'CarrierWholeShipmentRateClientError'
    this.status = status
    this.code = code
  }
}

export type ExecuteCarrierWholeShipmentRateRequestOptions = {
  preparedRequest: PreparedCarrierWholeShipmentRateRequest
  runtimeCredential: CarrierRuntimeCredential
  fetchImpl?: typeof fetch
  timeoutMs?: number
  signal?: AbortSignal
}

function responseLimitBytes(packageCount: number) {
  return Math.min(
    HARD_RESPONSE_LIMIT_BYTES,
    BASE_RESPONSE_LIMIT_BYTES
      + Math.max(0, packageCount - 1) * RESPONSE_BYTES_PER_ADDITIONAL_PACKAGE,
  )
}

function providerHttpError(status: number) {
  if ([400, 401, 403, 404, 409, 422].includes(status)) {
    return new CarrierWholeShipmentRateClientError(
      'The carrier rejected the production rate request',
      409,
      'CARRIER_PRODUCTION_RATE_REJECTED',
    )
  }
  if (status === 429) {
    return new CarrierWholeShipmentRateClientError(
      'The carrier temporarily rate limited production rating',
      503,
      'CARRIER_PROVIDER_RATE_LIMITED',
    )
  }
  return new CarrierWholeShipmentRateClientError(
    'The carrier production rating service is temporarily unavailable',
    503,
    'CARRIER_PROVIDER_UNAVAILABLE',
  )
}

function invalidResponse() {
  return new CarrierWholeShipmentRateClientError(
    'The carrier returned an invalid production rate response',
    502,
    'CARRIER_PROVIDER_RESPONSE_INVALID',
  )
}

function assertResponseContentLength(response: Response, limitBytes: number) {
  const header = response.headers.get('content-length')
  if (header === null) return
  if (!/^\d+$/.test(header)) throw invalidResponse()
  const contentLength = Number(header)
  if (!Number.isSafeInteger(contentLength) || contentLength > limitBytes) {
    throw invalidResponse()
  }
}

async function readBoundedResponse(response: Response, limitBytes: number) {
  assertResponseContentLength(response, limitBytes)
  if (!response.body) return ''

  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let totalBytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      totalBytes += chunk.value.byteLength
      if (totalBytes > limitBytes) {
        await reader.cancel().catch(() => undefined)
        throw invalidResponse()
      }
      chunks.push(Buffer.from(chunk.value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, totalBytes).toString('utf8')
}

function providerReference(response: Response) {
  return response.headers.get('transaction-id')
    || response.headers.get('x-customer-transaction-id')
    || null
}

function mapCredentialError(error: CarrierCredentialClientError) {
  return new CarrierWholeShipmentRateClientError(
    error.message,
    error.status,
    error.code,
  )
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested)
  }
  return Object.freeze(value)
}

function immutablePreparedRequestSnapshot(
  preparedRequest: PreparedCarrierWholeShipmentRateRequest,
) {
  try {
    sealPreparedCarrierWholeShipmentRateRequest(preparedRequest)
    const snapshot = JSON.parse(
      JSON.stringify(preparedRequest),
    ) as PreparedCarrierWholeShipmentRateRequest
    sealPreparedCarrierWholeShipmentRateRequest(snapshot)
    return deepFreeze(snapshot)
  } catch {
    throw new CarrierWholeShipmentRateClientError(
      'Prepared carrier rate request failed its rate-only integrity check',
      400,
      'CARRIER_RATE_REQUEST_INVALID',
    )
  }
}

function preparedAccountNumber(
  preparedRequest: PreparedCarrierWholeShipmentRateRequest,
) {
  if (preparedRequest.provider === 'fedex_rest') {
    const account = record(preparedRequest.body.accountNumber)
    return typeof account.value === 'string' ? account.value.trim() : ''
  }
  const rateRequest = record(preparedRequest.body.RateRequest)
  const shipment = record(rateRequest.Shipment)
  const shipper = record(shipment.Shipper)
  return typeof shipper.ShipperNumber === 'string'
    ? shipper.ShipperNumber.trim()
    : ''
}

/**
 * Execute exactly one production, read-only whole-shipment rate request.
 *
 * The prepared request is sealed before credential acquisition. This adapter
 * performs one OAuth exchange and one request to the sealed rating endpoint;
 * it never retries and has no provider shipment, label, void, or inventory
 * mutation surface.
 */
export async function executeCarrierWholeShipmentRateRequest(
  options: ExecuteCarrierWholeShipmentRateRequestOptions,
): Promise<ParsedCarrierWholeShipmentRateResponse> {
  const { preparedRequest, runtimeCredential } = options
  if (
    preparedRequest.environment !== 'production'
    || runtimeCredential.environment !== 'production'
  ) {
    throw new CarrierWholeShipmentRateClientError(
      'Whole-shipment carrier execution requires production credentials and a production request',
      409,
      'CARRIER_PRODUCTION_REQUIRED',
    )
  }
  if (
    runtimeCredential.provider !== preparedRequest.provider
    || (
      runtimeCredential.provider !== 'ups_rest'
      && runtimeCredential.provider !== 'fedex_rest'
    )
  ) {
    throw new CarrierWholeShipmentRateClientError(
      'Carrier credential provider does not match the prepared rate request',
      409,
      'CARRIER_RATE_BINDING_MISMATCH',
    )
  }
  if (!runtimeCredential.credential.accountNumber?.trim()) {
    throw new CarrierWholeShipmentRateClientError(
      'A production carrier account number is required for rating',
      409,
      'CARRIER_ACCOUNT_REQUIRED',
    )
  }

  const executableRequest = immutablePreparedRequestSnapshot(preparedRequest)
  const sealed = sealPreparedCarrierWholeShipmentRateRequest(executableRequest)
  if (
    sealed.provider !== runtimeCredential.provider
    || sealed.environment !== 'production'
    || sealed.accessMode !== 'rate_read_only'
    || sealed.providerMutationCount !== 0
  ) {
    throw new CarrierWholeShipmentRateClientError(
      'Prepared carrier rate request failed its rate-only integrity check',
      400,
      'CARRIER_RATE_REQUEST_INVALID',
    )
  }
  if (
    preparedAccountNumber(executableRequest)
      !== runtimeCredential.credential.accountNumber.trim()
  ) {
    throw new CarrierWholeShipmentRateClientError(
      'Carrier credential account does not match the prepared rate request',
      409,
      'CARRIER_RATE_BINDING_MISMATCH',
    )
  }

  const fetchImpl = options.fetchImpl || fetch
  const timeoutMs = Math.max(
    MIN_TIMEOUT_MS,
    Math.min(options.timeoutMs || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
  )
  const controller = new AbortController()
  const abortFromCaller = () => controller.abort()
  if (options.signal?.aborted) controller.abort()
  else options.signal?.addEventListener('abort', abortFromCaller, { once: true })
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const requestedAt = new Date().toISOString()

  try {
    const token = await requestCarrierAccessToken(runtimeCredential, {
      fetchImpl,
      timeoutMs,
      signal: controller.signal,
    })
    if (
      token.provider !== executableRequest.provider
      || token.environment !== 'production'
    ) {
      throw new CarrierWholeShipmentRateClientError(
        'Carrier access token does not match the prepared rate request',
        409,
        'CARRIER_RATE_BINDING_MISMATCH',
      )
    }

    assertIntegrationCredentialProviderIoReady()
    const response = await fetchImpl(executableRequest.endpoint, {
      method: executableRequest.method,
      headers: {
        ...executableRequest.headers,
        Authorization: `Bearer ${token.accessToken}`,
      },
      body: JSON.stringify(executableRequest.body),
      redirect: 'error',
      signal: controller.signal,
    })
    const limitBytes = responseLimitBytes(
      executableRequest.redactedRequest.packageCount,
    )
    assertResponseContentLength(response, limitBytes)
    if (!response.ok) throw providerHttpError(response.status)

    const rawPayload = await readBoundedResponse(response, limitBytes)
    let payload: unknown
    try {
      payload = JSON.parse(rawPayload)
    } catch {
      throw invalidResponse()
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw invalidResponse()
    }

    try {
      return parseCarrierWholeShipmentRateResponse(executableRequest, {
        payload,
        providerReference: providerReference(response),
        requestedAt,
        completedAt: new Date().toISOString(),
      })
    } catch (error) {
      if (
        error instanceof Error
        && error.message === 'Carrier rate response did not contain a usable rate'
      ) {
        throw new CarrierWholeShipmentRateClientError(
          'The carrier returned no usable production rates',
          502,
          'CARRIER_PRODUCTION_RATE_EMPTY',
        )
      }
      throw invalidResponse()
    }
  } catch (error) {
    if (isIntegrationCredentialRuntimeGateError(error)) throw error
    if (error instanceof CarrierWholeShipmentRateClientError) throw error
    if (error instanceof CarrierCredentialClientError) {
      throw mapCredentialError(error)
    }
    if (error instanceof Error && error.name === 'AbortError') {
      throw new CarrierWholeShipmentRateClientError(
        'Carrier production rating timed out',
        504,
        'CARRIER_PROVIDER_TIMEOUT',
      )
    }
    throw new CarrierWholeShipmentRateClientError(
      'The carrier production rating service is temporarily unavailable',
      503,
      'CARRIER_PROVIDER_UNAVAILABLE',
    )
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', abortFromCaller)
  }
}
