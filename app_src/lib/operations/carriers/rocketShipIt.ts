const ROCKETSHIPIT_CLOUD_ENDPOINT = 'https://api.rocketship.it/v1'
const ROCKETSHIPIT_HEALTH_ENDPOINT = `${ROCKETSHIPIT_CLOUD_ENDPOINT}/health`
const DEFAULT_TIMEOUT_MS = 20_000
const MAX_TIMEOUT_MS = 25_000
const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024

export const rocketShipItCarriers = ['UPS-REST', 'FedEx-REST', 'USPS', 'USPS-eVS'] as const

export const rocketShipItActions = [
  'Authenticate',
  'Track',
  'GetAllRates',
  'SubmitShipment',
  'AddressValidate',
  'VoidShipment',
  'TimeInTransit',
  'PickupRate',
  'CreatePickup',
  'PickupStatus',
  'CancelPickup',
  'CreateManifest',
  'UploadDocument',
  'LinkDocument',
  'GetTrackingDocuments',
] as const

export type RocketShipItCarrier = typeof rocketShipItCarriers[number]
export type RocketShipItAction = typeof rocketShipItActions[number]

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

type RocketShipItResponse<T> = {
  meta?: {
    code?: number | string
    error_message?: string
    debug_information?: unknown
  }
  data?: T & { errors?: unknown[] }
}

export type RocketShipItResult<T> = {
  data: T
  meta: { code: number | null }
}

export class RocketShipItRequestError extends Error {
  readonly code: string
  readonly status: number
  readonly retryable: boolean
  readonly carrier: string | null
  readonly action: string | null
  readonly providerErrorCount: number

  constructor(input: {
    code: string
    message: string
    status?: number
    retryable?: boolean
    carrier?: string | null
    action?: string | null
    providerErrorCount?: number
  }) {
    super(input.message)
    this.name = 'RocketShipItRequestError'
    this.code = input.code
    this.status = input.status ?? 502
    this.retryable = input.retryable ?? false
    this.carrier = input.carrier ?? null
    this.action = input.action ?? null
    this.providerErrorCount = input.providerErrorCount ?? 0
  }
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value <= 0 || value > maximum) {
    throw new RocketShipItRequestError({
      code: 'ROCKETSHIPIT_CONFIGURATION_INVALID',
      message: 'RocketShipIt transport limits are invalid',
      status: 500,
    })
  }
  return value
}

function containsDebug(value: unknown, seen = new Set<object>()): boolean {
  if (!value || typeof value !== 'object') return false
  const object = value as Record<string, unknown>
  if (seen.has(object)) return false
  seen.add(object)
  if (Object.keys(object).some((key) => key.toLowerCase() === 'debug')) return true
  return Object.values(object).some((item) => containsDebug(item, seen))
}

function isAllowed<T extends readonly string[]>(values: T, value: string): value is T[number] {
  return values.includes(value as T[number])
}

function responseByteLength(value: string) {
  return new TextEncoder().encode(value).byteLength
}

function parseResponse<T>(body: string, input: {
  carrier: string
  action: string
  status: number
  ok: boolean
}): RocketShipItResult<T> {
  let payload: RocketShipItResponse<T>
  try {
    payload = JSON.parse(body) as RocketShipItResponse<T>
  } catch {
    throw new RocketShipItRequestError({
      code: 'ROCKETSHIPIT_RESPONSE_INVALID',
      message: 'RocketShipIt returned an invalid response',
      status: 502,
      retryable: input.status >= 500,
      carrier: input.carrier,
      action: input.action,
    })
  }

  const metaCode = Number(payload.meta?.code)
  const providerErrors = Array.isArray(payload.data?.errors) ? payload.data.errors : []
  if (!input.ok) {
    throw new RocketShipItRequestError({
      code: 'ROCKETSHIPIT_HTTP_ERROR',
      message: 'RocketShipIt request failed',
      status: 502,
      retryable: input.status === 408 || input.status === 429 || input.status >= 500,
      carrier: input.carrier,
      action: input.action,
      providerErrorCount: providerErrors.length,
    })
  }
  if ((Number.isFinite(metaCode) && metaCode >= 400) || payload.meta?.error_message) {
    throw new RocketShipItRequestError({
      code: 'ROCKETSHIPIT_API_ERROR',
      message: 'RocketShipIt rejected the request',
      status: 502,
      carrier: input.carrier,
      action: input.action,
      providerErrorCount: providerErrors.length,
    })
  }
  if (providerErrors.length > 0) {
    throw new RocketShipItRequestError({
      code: 'ROCKETSHIPIT_CARRIER_ERROR',
      message: 'The carrier rejected the RocketShipIt request',
      status: 422,
      carrier: input.carrier,
      action: input.action,
      providerErrorCount: providerErrors.length,
    })
  }
  if (payload.data === undefined) {
    throw new RocketShipItRequestError({
      code: 'ROCKETSHIPIT_RESPONSE_INVALID',
      message: 'RocketShipIt response did not include data',
      status: 502,
      carrier: input.carrier,
      action: input.action,
    })
  }
  return {
    data: payload.data,
    meta: { code: Number.isFinite(metaCode) ? metaCode : null },
  }
}

export class RocketShipItCloudClient {
  private readonly apiKey: string
  private readonly request: FetchLike
  private readonly timeoutMs: number
  private readonly maxResponseBytes: number

  constructor(input: {
    apiKey: string
    fetch?: FetchLike
    timeoutMs?: number
    maxResponseBytes?: number
  }) {
    const apiKey = input.apiKey.trim()
    if (apiKey.length < 8 || apiKey.length > 512 || /[\u0000-\u001f\u007f]/.test(apiKey)) {
      throw new RocketShipItRequestError({
        code: 'ROCKETSHIPIT_CONFIGURATION_INVALID',
        message: 'RocketShipIt API key is invalid',
        status: 500,
      })
    }
    this.apiKey = apiKey
    this.request = input.fetch ?? fetch
    this.timeoutMs = boundedInteger(input.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
    this.maxResponseBytes = boundedInteger(
      input.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      MAX_RESPONSE_BYTES,
    )
  }

  async health(): Promise<{ healthy: boolean; status: number }> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), Math.min(this.timeoutMs, 5_000))
    try {
      const response = await this.request(ROCKETSHIPIT_HEALTH_ENDPOINT, {
        method: 'GET',
        cache: 'no-store',
        signal: controller.signal,
      })
      return { healthy: response.ok, status: response.status }
    } catch {
      return { healthy: false, status: 0 }
    } finally {
      clearTimeout(timeout)
    }
  }

  async execute<T extends Record<string, unknown>>(input: {
    carrier: RocketShipItCarrier
    action: RocketShipItAction
    params: Record<string, unknown>
    signal?: AbortSignal
  }): Promise<RocketShipItResult<T>> {
    if (!isAllowed(rocketShipItCarriers, input.carrier)) {
      throw new RocketShipItRequestError({
        code: 'ROCKETSHIPIT_CARRIER_UNSUPPORTED',
        message: 'RocketShipIt carrier is not enabled',
        status: 400,
        carrier: String(input.carrier),
        action: String(input.action),
      })
    }
    if (!isAllowed(rocketShipItActions, input.action)) {
      throw new RocketShipItRequestError({
        code: 'ROCKETSHIPIT_ACTION_UNSUPPORTED',
        message: 'RocketShipIt action is not enabled',
        status: 400,
        carrier: String(input.carrier),
        action: String(input.action),
      })
    }
    if (containsDebug(input.params)) {
      throw new RocketShipItRequestError({
        code: 'ROCKETSHIPIT_DEBUG_FORBIDDEN',
        message: 'RocketShipIt debug payloads are disabled',
        status: 400,
        carrier: input.carrier,
        action: input.action,
      })
    }

    const controller = new AbortController()
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.timeoutMs)
    const abort = () => controller.abort()
    if (input.signal?.aborted) controller.abort()
    else input.signal?.addEventListener('abort', abort, { once: true })

    try {
      const response = await this.request(ROCKETSHIPIT_CLOUD_ENDPOINT, {
        method: 'POST',
        headers: {
          'Cache-Control': 'no-cache',
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
        },
        body: JSON.stringify({
          carrier: input.carrier,
          action: input.action,
          params: input.params,
        }),
        cache: 'no-store',
        signal: controller.signal,
      })
      const body = await response.text()
      if (responseByteLength(body) > this.maxResponseBytes) {
        throw new RocketShipItRequestError({
          code: 'ROCKETSHIPIT_RESPONSE_TOO_LARGE',
          message: 'RocketShipIt response exceeded the configured limit',
          status: 502,
          carrier: input.carrier,
          action: input.action,
        })
      }
      return parseResponse<T>(body, {
        carrier: input.carrier,
        action: input.action,
        status: response.status,
        ok: response.ok,
      })
    } catch (error) {
      if (error instanceof RocketShipItRequestError) throw error
      throw new RocketShipItRequestError({
        code: timedOut ? 'ROCKETSHIPIT_TIMEOUT' : 'ROCKETSHIPIT_NETWORK_ERROR',
        message: timedOut ? 'RocketShipIt request timed out' : 'RocketShipIt request failed',
        status: 502,
        retryable: true,
        carrier: input.carrier,
        action: input.action,
      })
    } finally {
      clearTimeout(timeout)
      input.signal?.removeEventListener('abort', abort)
    }
  }
}
