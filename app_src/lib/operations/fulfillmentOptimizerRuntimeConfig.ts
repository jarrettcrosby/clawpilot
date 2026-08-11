import { isIP } from 'node:net'

export const FULFILLMENT_OPTIMIZER_RAILWAY_PRIVATE_HOSTNAME =
  'fulfillment-optimizer.railway.internal'
export const DEFAULT_FULFILLMENT_OPTIMIZER_TIMEOUT_MS = 10_000

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>

export type FulfillmentOptimizerRuntimeConfiguration = {
  baseUrl: string
  secret: string
  requestTimeoutMs: number
}

export type FulfillmentOptimizerRuntimeHealth = {
  enabled: boolean
  configurationReady: boolean
  configurationStatus: 'disabled' | 'ready' | 'invalid'
  reason: string | null
  endpoint: null | {
    hostname: string
    port: number | null
    transport: 'https' | 'railway_private_http'
  }
  requestTimeoutMs: number | null
  connectivity: 'not-probed'
}

export class FulfillmentOptimizerRuntimeConfigError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'FulfillmentOptimizerRuntimeConfigError'
    this.code = code
  }
}

function reject(code: string): never {
  throw new FulfillmentOptimizerRuntimeConfigError(code)
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split('.').map(Number)
  if (
    parts.length !== 4
    || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return true
  }

  const [first, second] = parts
  return (
    first === 0
    || first === 10
    || first === 127
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 198 && (second === 18 || second === 19))
    || first >= 224
  )
}

function isPrivateIpv6(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return (
    normalized === '::'
    || normalized === '::1'
    || normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || /^fe[89ab]/.test(normalized)
    || normalized.startsWith('::ffff:')
  )
}

function isPrivateHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.+$/, '')
  const ipVersion = isIP(normalized.replace(/^\[|\]$/g, ''))
  if (ipVersion === 4) return isPrivateIpv4(normalized)
  if (ipVersion === 6) return isPrivateIpv6(normalized)
  return (
    normalized === 'localhost'
    || normalized.endsWith('.localhost')
    || normalized.endsWith('.internal')
    || normalized.endsWith('.local')
    || normalized.endsWith('.lan')
    || normalized.endsWith('.home.arpa')
    || !normalized.includes('.')
  )
}

function validPort(parsed: URL): boolean {
  if (!parsed.port) return true
  const port = Number(parsed.port)
  return Number.isInteger(port) && port >= 1 && port <= 65_535
}

export function normalizeFulfillmentOptimizerBaseUrl(value: string): string {
  const candidate = String(value || '').trim()
  if (!candidate || candidate.includes('?') || candidate.includes('#')) {
    reject('ORTOOLS_URL_INVALID')
  }

  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    reject('ORTOOLS_URL_INVALID')
  }

  if (
    parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || !validPort(parsed)
  ) {
    reject('ORTOOLS_URL_INVALID')
  }

  const hostname = parsed.hostname.toLowerCase()
  const railwayPrivate = hostname === FULFILLMENT_OPTIMIZER_RAILWAY_PRIVATE_HOSTNAME
  if (parsed.protocol === 'http:') {
    if (!railwayPrivate) reject('ORTOOLS_TLS_REQUIRED')
  } else if (parsed.protocol === 'https:') {
    if (!railwayPrivate && isPrivateHostname(hostname)) {
      reject('ORTOOLS_PRIVATE_URL_REJECTED')
    }
  } else {
    reject('ORTOOLS_TLS_REQUIRED')
  }

  return parsed.toString().replace(/\/$/, '')
}

function parseTimeout(value: string | undefined): number {
  const candidate = String(value || '').trim()
  const parsed = candidate
    ? Number(candidate)
    : DEFAULT_FULFILLMENT_OPTIMIZER_TIMEOUT_MS
  if (!Number.isSafeInteger(parsed) || parsed < 100 || parsed > 30_000) {
    reject('ORTOOLS_TIMEOUT_INVALID')
  }
  return parsed
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

export function resolveFulfillmentOptimizerRuntimeConfiguration(
  environment: RuntimeEnvironment = process.env,
): FulfillmentOptimizerRuntimeConfiguration | null {
  const enableValue = String(
    environment.CLAWPILOT_FULFILLMENT_OPTIMIZER_ENABLED || '',
  ).trim()
  if (enableValue !== '' && enableValue !== '0' && enableValue !== '1') {
    reject('ORTOOLS_ENABLED_INVALID')
  }
  if (enableValue !== '1') return null

  const baseUrl = normalizeFulfillmentOptimizerBaseUrl(
    String(environment.CLAWPILOT_FULFILLMENT_OPTIMIZER_URL || ''),
  )
  const secret = String(
    environment.CLAWPILOT_FULFILLMENT_OPTIMIZER_SECRET || '',
  )
  if (utf8ByteLength(secret) < 32) reject('ORTOOLS_SECRET_INVALID')

  return {
    baseUrl,
    secret,
    requestTimeoutMs: parseTimeout(
      environment.CLAWPILOT_FULFILLMENT_OPTIMIZER_TIMEOUT_MS,
    ),
  }
}

export function fulfillmentOptimizerRuntimeHealth(
  environment: RuntimeEnvironment = process.env,
): FulfillmentOptimizerRuntimeHealth {
  try {
    const configuration = resolveFulfillmentOptimizerRuntimeConfiguration(environment)
    if (!configuration) {
      return {
        enabled: false,
        configurationReady: false,
        configurationStatus: 'disabled',
        reason: null,
        endpoint: null,
        requestTimeoutMs: null,
        connectivity: 'not-probed',
      }
    }

    const parsed = new URL(configuration.baseUrl)
    return {
      enabled: true,
      configurationReady: true,
      configurationStatus: 'ready',
      reason: null,
      endpoint: {
        hostname: parsed.hostname,
        port: parsed.port ? Number(parsed.port) : null,
        transport: parsed.protocol === 'http:'
          ? 'railway_private_http'
          : 'https',
      },
      requestTimeoutMs: configuration.requestTimeoutMs,
      connectivity: 'not-probed',
    }
  } catch (error) {
    return {
      enabled: String(
        environment.CLAWPILOT_FULFILLMENT_OPTIMIZER_ENABLED || '',
      ).trim() === '1',
      configurationReady: false,
      configurationStatus: 'invalid',
      reason: error instanceof FulfillmentOptimizerRuntimeConfigError
        ? error.code
        : 'ORTOOLS_CONFIGURATION_INVALID',
      endpoint: null,
      requestTimeoutMs: null,
      connectivity: 'not-probed',
    }
  }
}
