import type {
  CarrierCredentialPayload,
  CarrierEnvironment,
  DirectCarrierProvider,
} from '@/lib/integrations/carrierCredentialCrypto'

export type CarrierRuntimeCredential = {
  provider: DirectCarrierProvider
  environment: CarrierEnvironment
  credential: CarrierCredentialPayload
}

export type CarrierCredentialVerification = {
  provider: DirectCarrierProvider
  environment: CarrierEnvironment
  expiresInSeconds: number | null
  scope: string | null
}

export class CarrierCredentialClientError extends Error {
  readonly status: number
  readonly code: string

  constructor(message: string, status: number, code: string) {
    super(message)
    this.name = 'CarrierCredentialClientError'
    this.status = status
    this.code = code
  }
}

const TOKEN_ENDPOINTS: Record<DirectCarrierProvider, Record<CarrierEnvironment, string>> = {
  ups_rest: {
    sandbox: 'https://wwwcie.ups.com/security/v1/oauth/token',
    production: 'https://onlinetools.ups.com/security/v1/oauth/token',
  },
  fedex_rest: {
    sandbox: 'https://apis-sandbox.fedex.com/oauth/token',
    production: 'https://apis.fedex.com/oauth/token',
  },
  usps_rest: {
    sandbox: 'https://apis-tem.usps.com/oauth2/v3/token',
    production: 'https://apis.usps.com/oauth2/v3/token',
  },
}

function requestFor(input: CarrierRuntimeCredential): { url: string; init: RequestInit } {
  const { provider, environment, credential } = input
  const url = TOKEN_ENDPOINTS[provider][environment]
  if (provider === 'ups_rest') {
    const authorization = Buffer.from(`${credential.clientId}:${credential.clientSecret}`, 'utf8').toString('base64')
    return {
      url,
      init: {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `Basic ${authorization}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
      },
    }
  }
  if (provider === 'fedex_rest') {
    return {
      url,
      init: {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: credential.clientId,
          client_secret: credential.clientSecret,
        }).toString(),
      },
    }
  }
  return {
    url,
    init: {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: credential.clientId,
        client_secret: credential.clientSecret,
        grant_type: 'client_credentials',
      }),
    },
  }
}

function responseError(status: number) {
  if (status === 401 || status === 403 || status === 400) {
    return new CarrierCredentialClientError(
      'The carrier rejected these credentials',
      409,
      'CARRIER_CREDENTIAL_REJECTED',
    )
  }
  if (status === 429) {
    return new CarrierCredentialClientError(
      'The carrier temporarily rate limited verification',
      503,
      'CARRIER_PROVIDER_RATE_LIMITED',
    )
  }
  return new CarrierCredentialClientError(
    'The carrier verification service is temporarily unavailable',
    503,
    'CARRIER_PROVIDER_UNAVAILABLE',
  )
}

export async function verifyCarrierCredential(
  input: CarrierRuntimeCredential,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<CarrierCredentialVerification> {
  const fetchImpl = options.fetchImpl || fetch
  const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs || 8_000, 15_000))
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const request = requestFor(input)
    const response = await fetchImpl(request.url, { ...request.init, signal: controller.signal })
    if (!response.ok) throw responseError(response.status)
    const contentLength = Number(response.headers.get('content-length') || 0)
    if (Number.isFinite(contentLength) && contentLength > 64 * 1024) {
      throw new CarrierCredentialClientError(
        'The carrier returned an invalid verification response',
        502,
        'CARRIER_PROVIDER_RESPONSE_INVALID',
      )
    }
    const rawPayload = await response.text()
    if (Buffer.byteLength(rawPayload, 'utf8') > 64 * 1024) {
      throw new CarrierCredentialClientError(
        'The carrier returned an invalid verification response',
        502,
        'CARRIER_PROVIDER_RESPONSE_INVALID',
      )
    }
    const payload = (() => {
      try {
        return JSON.parse(rawPayload) as Record<string, unknown>
      } catch {
        return null
      }
    })()
    if (!payload || typeof payload.access_token !== 'string' || payload.access_token.length < 8) {
      throw new CarrierCredentialClientError(
        'The carrier returned an invalid verification response',
        502,
        'CARRIER_PROVIDER_RESPONSE_INVALID',
      )
    }
    const expiresIn = Number(payload.expires_in)
    return {
      provider: input.provider,
      environment: input.environment,
      expiresInSeconds: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : null,
      scope: typeof payload.scope === 'string' ? payload.scope.slice(0, 512) : null,
    }
  } catch (error) {
    if (error instanceof CarrierCredentialClientError) throw error
    if (error instanceof Error && error.name === 'AbortError') {
      throw new CarrierCredentialClientError(
        'Carrier verification timed out',
        504,
        'CARRIER_PROVIDER_TIMEOUT',
      )
    }
    throw new CarrierCredentialClientError(
      'The carrier verification service is temporarily unavailable',
      503,
      'CARRIER_PROVIDER_UNAVAILABLE',
    )
  } finally {
    clearTimeout(timeout)
  }
}

export function carrierTokenEndpoint(provider: DirectCarrierProvider, environment: CarrierEnvironment) {
  return TOKEN_ENDPOINTS[provider][environment]
}
