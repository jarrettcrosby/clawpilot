import {
  normalizeBrokeredTransportCredential,
  type WwexSpeedshipCredential,
} from '@/lib/integrations/brokeredTransportCredentialCrypto'
import {
  parseWwexLtlShopResponse,
  parseWwexLtlTenderResponse,
  parseWwexSmallpackSchedulePickupResponse,
  parseWwexSmallpackShopResponse,
  parseWwexSmallpackTenderResponse,
  sealPreparedWwexSmallpackSchedulePickupRequest,
  sealPreparedWwexSpeedshipShopRequest,
  sealPreparedWwexSpeedshipTenderRequest,
  WwexSpeedshipPartialTenderOutcomeError,
  type ParsedWwexSmallpackSchedulePickupResponse,
  type ParsedWwexSpeedshipShopResponse,
  type ParsedWwexSpeedshipTenderResponse,
  type PreparedWwexSmallpackSchedulePickupRequest,
  type PreparedWwexSpeedshipShopRequest,
  type PreparedWwexSpeedshipTenderRequest,
  type WwexSpeedshipPartialTenderReconciliation,
} from '@/lib/integrations/wwexSpeedshipFoundation'

export const WWEX_SPEEDSHIP_RUNTIME_ENDPOINTS = Object.freeze({
  sandbox: Object.freeze({
    token: 'https://auth.staging-wwex.com/oauth/token',
    apiBase: 'https://speedship.staging-wwex.com',
    audience: 'staging-wwex-apig',
  }),
  // WWEX issues the production host and audience only after platform review.
  // A staging-derived guess must never become a production shipment endpoint.
  production: null,
})

const DEFAULT_TIMEOUT_MS = 15_000
const MIN_TIMEOUT_MS = 1_000
const MAX_TIMEOUT_MS = 30_000
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024
const MAX_FLOW_RESPONSE_BYTES = 4 * 1024 * 1024

export type WwexSpeedshipProviderOutcome = 'failed' | 'unknown'

export class WwexSpeedshipClientError extends Error {
  readonly status: number
  readonly code: string
  readonly providerOutcome: WwexSpeedshipProviderOutcome
  readonly reconciliation: WwexSpeedshipPartialTenderReconciliation | null

  constructor(
    message: string,
    status: number,
    code: string,
    providerOutcome: WwexSpeedshipProviderOutcome,
    reconciliation: WwexSpeedshipPartialTenderReconciliation | null = null,
  ) {
    super(message)
    this.name = 'WwexSpeedshipClientError'
    this.status = status
    this.code = code
    this.providerOutcome = providerOutcome
    this.reconciliation = reconciliation
  }
}

export type WwexSpeedshipRuntimeCredential = {
  provider: 'wwex_speedship'
  environment: 'sandbox' | 'production'
  credentialVersion: number
  credentialFingerprint: string
  credential: WwexSpeedshipCredential
}

type CommonExecutionOptions = {
  runtimeCredential: WwexSpeedshipRuntimeCredential
  fetchImpl?: typeof fetch
  timeoutMs?: number
  signal?: AbortSignal
}

export type WwexSpeedshipExecution<Result> = {
  result: Result
  requestHash: string
  credentialVersion: number
  credentialFingerprint: string
  requestedAt: string
  completedAt: string
  providerHttpStatus: number
}

export type WwexSpeedshipCredentialVerification = Readonly<{
  provider: 'wwex_speedship'
  environment: 'sandbox'
  credentialVersion: number
  credentialFingerprint: string
  verificationType: 'oauth_client_credentials'
  requestedAt: string
  completedAt: string
  providerHttpStatus: number
}>

function clientError(
  message: string,
  status: number,
  code: string,
  mutationStarted = false,
) {
  return new WwexSpeedshipClientError(
    message,
    status,
    code,
    mutationStarted ? 'unknown' : 'failed',
  )
}

function timeoutMs(value: number | undefined) {
  const normalized = value ?? DEFAULT_TIMEOUT_MS
  if (
    !Number.isInteger(normalized)
    || normalized < MIN_TIMEOUT_MS
    || normalized > MAX_TIMEOUT_MS
  ) {
    throw clientError(
      `Worldwide Express timeout must be ${MIN_TIMEOUT_MS}-${MAX_TIMEOUT_MS} milliseconds`,
      400,
      'WWEX_TIMEOUT_INVALID',
    )
  }
  return normalized
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested)
  }
  return Object.freeze(value)
}

function immutableShopSnapshot(prepared: PreparedWwexSpeedshipShopRequest) {
  try {
    sealPreparedWwexSpeedshipShopRequest(prepared)
    const snapshot = JSON.parse(JSON.stringify(prepared)) as PreparedWwexSpeedshipShopRequest
    sealPreparedWwexSpeedshipShopRequest(snapshot)
    return deepFreeze(snapshot)
  } catch {
    throw clientError(
      'Prepared Worldwide Express shop request failed its integrity check',
      400,
      'WWEX_PREPARED_REQUEST_INVALID',
    )
  }
}

function immutableTenderSnapshot(prepared: PreparedWwexSpeedshipTenderRequest) {
  try {
    sealPreparedWwexSpeedshipTenderRequest(prepared)
    const snapshot = JSON.parse(JSON.stringify(prepared)) as PreparedWwexSpeedshipTenderRequest
    sealPreparedWwexSpeedshipTenderRequest(snapshot)
    return deepFreeze(snapshot)
  } catch {
    throw clientError(
      'Prepared Worldwide Express tender request failed its integrity check',
      400,
      'WWEX_PREPARED_REQUEST_INVALID',
    )
  }
}

function immutablePickupSnapshot(
  prepared: PreparedWwexSmallpackSchedulePickupRequest,
) {
  try {
    sealPreparedWwexSmallpackSchedulePickupRequest(prepared)
    const snapshot = JSON.parse(JSON.stringify(
      prepared,
    )) as PreparedWwexSmallpackSchedulePickupRequest
    sealPreparedWwexSmallpackSchedulePickupRequest(snapshot)
    return deepFreeze(snapshot)
  } catch {
    throw clientError(
      'Prepared Worldwide Express pickup request failed its integrity check',
      400,
      'WWEX_PREPARED_REQUEST_INVALID',
    )
  }
}

async function readBoundedResponse(
  response: Response,
  limit: number,
  mutationStarted: boolean,
) {
  const header = response.headers.get('content-length')
  if (header !== null && (!/^\d+$/.test(header) || Number(header) > limit)) {
    throw clientError(
      'Worldwide Express returned an invalid response',
      502,
      'WWEX_RESPONSE_INVALID',
      mutationStarted,
    )
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      total += chunk.value.byteLength
      if (total > limit) {
        await reader.cancel().catch(() => undefined)
        throw clientError(
          'Worldwide Express returned an invalid response',
          502,
          'WWEX_RESPONSE_INVALID',
          mutationStarted,
        )
      }
      chunks.push(Buffer.from(chunk.value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, total).toString('utf8')
}

function jsonResponse(raw: string, mutationStarted: boolean) {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    throw clientError(
      'Worldwide Express returned an invalid response',
      502,
      'WWEX_RESPONSE_INVALID',
      mutationStarted,
    )
  }
}

function httpError(status: number, mutationStarted: boolean) {
  if ([400, 401, 403, 404, 422].includes(status)) {
    return clientError(
      'Worldwide Express rejected the request',
      409,
      'WWEX_REQUEST_REJECTED',
      false,
    )
  }
  if (status === 409) {
    return clientError(
      mutationStarted
        ? 'Worldwide Express returned a conflict that requires reconciliation'
        : 'Worldwide Express rejected the request',
      409,
      mutationStarted
        ? 'WWEX_CONFLICT_RECONCILIATION_REQUIRED'
        : 'WWEX_REQUEST_REJECTED',
      mutationStarted,
    )
  }
  if (status === 429) {
    return clientError(
      'Worldwide Express temporarily rate limited the request',
      503,
      'WWEX_PROVIDER_RATE_LIMITED',
      mutationStarted,
    )
  }
  return clientError(
    'Worldwide Express is temporarily unavailable',
    503,
    'WWEX_PROVIDER_UNAVAILABLE',
    mutationStarted,
  )
}

function normalizedCredential(
  credentialValue: WwexSpeedshipCredential,
  environment: 'sandbox' | 'production',
) {
  if (environment !== 'sandbox') {
    throw clientError(
      'Worldwide Express production endpoints require provider platform review and configuration',
      409,
      'WWEX_PRODUCTION_CONFIGURATION_REQUIRED',
    )
  }
  let credential: WwexSpeedshipCredential
  try {
    credential = normalizeBrokeredTransportCredential(
      'wwex_speedship',
      credentialValue,
    ) as WwexSpeedshipCredential
  } catch {
    throw clientError(
      'Valid Worldwide Express credentials are required',
      409,
      'WWEX_CREDENTIAL_INVALID',
    )
  }
  if (credential.audience !== WWEX_SPEEDSHIP_RUNTIME_ENDPOINTS.sandbox.audience) {
    throw clientError(
      'Worldwide Express sandbox audience does not match the reviewed endpoint',
      409,
      'WWEX_CREDENTIAL_BINDING_MISMATCH',
    )
  }
  return credential
}

function normalizedRuntimeCredential(value: WwexSpeedshipRuntimeCredential) {
  if (
    !value
    || value.provider !== 'wwex_speedship'
    || !Number.isSafeInteger(value.credentialVersion)
    || value.credentialVersion < 1
    || !/^[a-f0-9]{64}$/.test(value.credentialFingerprint)
  ) {
    throw clientError(
      'Worldwide Express runtime credential binding is invalid',
      409,
      'WWEX_CREDENTIAL_BINDING_MISMATCH',
    )
  }
  return {
    ...value,
    credential: normalizedCredential(value.credential, value.environment),
  }
}

function abortState(signal: AbortSignal | undefined, duration: number) {
  const controller = new AbortController()
  let externalAbort = false
  const abortFromExternal = () => {
    externalAbort = true
    controller.abort(signal?.reason)
  }
  if (signal?.aborted) abortFromExternal()
  else signal?.addEventListener('abort', abortFromExternal, { once: true })
  const timer = setTimeout(() => controller.abort(), duration)
  return {
    controller,
    externalAbort: () => externalAbort,
    close() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abortFromExternal)
    },
  }
}

async function accessToken(input: {
  credential: WwexSpeedshipCredential
  fetchImpl: typeof fetch
  signal: AbortSignal
  externalAbort: () => boolean
}) {
  let response: Response
  try {
    response = await input.fetchImpl(WWEX_SPEEDSHIP_RUNTIME_ENDPOINTS.sandbox.token, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: input.credential.clientId,
        client_secret: input.credential.clientSecret,
        audience: input.credential.audience,
      }).toString(),
      cache: 'no-store',
      redirect: 'error',
      signal: input.signal,
    })
  } catch {
    const timedOut = input.signal.aborted && !input.externalAbort()
    throw clientError(
      timedOut
        ? 'Worldwide Express authentication timed out'
        : input.externalAbort()
          ? 'Worldwide Express request was cancelled'
          : 'Worldwide Express authentication could not be reached',
      timedOut ? 504 : 503,
      timedOut
        ? 'WWEX_AUTH_TIMEOUT'
        : input.externalAbort()
          ? 'WWEX_REQUEST_ABORTED'
          : 'WWEX_AUTH_UNAVAILABLE',
    )
  }
  let raw: string
  try {
    raw = await readBoundedResponse(
      response,
      MAX_TOKEN_RESPONSE_BYTES,
      false,
    )
  } catch (error) {
    if (error instanceof WwexSpeedshipClientError) throw error
    const timedOut = input.signal.aborted && !input.externalAbort()
    throw clientError(
      timedOut
        ? 'Worldwide Express authentication response timed out'
        : input.externalAbort()
          ? 'Worldwide Express request was cancelled'
          : 'Worldwide Express authentication response could not be read',
      timedOut ? 504 : 503,
      timedOut
        ? 'WWEX_AUTH_TIMEOUT'
        : input.externalAbort()
          ? 'WWEX_REQUEST_ABORTED'
          : 'WWEX_AUTH_UNAVAILABLE',
    )
  }
  if (!response.ok) throw httpError(response.status, false)
  const payload = jsonResponse(raw, false)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw clientError(
      'Worldwide Express returned an invalid authentication response',
      502,
      'WWEX_AUTH_RESPONSE_INVALID',
    )
  }
  const record = payload as Record<string, unknown>
  const token = typeof record.access_token === 'string'
    ? record.access_token.trim()
    : ''
  const tokenType = typeof record.token_type === 'string'
    ? record.token_type.trim().toLowerCase()
    : 'bearer'
  if (token.length < 16 || token.length > 8192 || tokenType !== 'bearer') {
    throw clientError(
      'Worldwide Express returned an invalid authentication response',
      502,
      'WWEX_AUTH_RESPONSE_INVALID',
    )
  }
  return { token, providerHttpStatus: response.status }
}

async function flowRequest<Result>(input: {
  path: string
  body: Record<string, unknown>
  requestHash: string
  mutation: boolean
  runtimeCredential: WwexSpeedshipRuntimeCredential
  fetchImpl?: typeof fetch
  timeoutMs?: number
  signal?: AbortSignal
  parse: (payload: unknown) => Result
}): Promise<WwexSpeedshipExecution<Result>> {
  const runtimeCredential = normalizedRuntimeCredential(input.runtimeCredential)
  const abort = abortState(input.signal, timeoutMs(input.timeoutMs))
  const fetchImpl = input.fetchImpl || fetch
  const requestedAt = new Date().toISOString()
  let mutationStarted = false
  try {
    const authentication = await accessToken({
      credential: runtimeCredential.credential,
      fetchImpl,
      signal: abort.controller.signal,
      externalAbort: abort.externalAbort,
    })
    const endpoint = new URL(
      input.path,
      WWEX_SPEEDSHIP_RUNTIME_ENDPOINTS.sandbox.apiBase,
    ).toString()
    let response: Response
    try {
      mutationStarted = input.mutation
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${authentication.token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(input.body),
        cache: 'no-store',
        redirect: 'error',
        signal: abort.controller.signal,
      })
    } catch {
      const timedOut = abort.controller.signal.aborted && !abort.externalAbort()
      throw clientError(
        timedOut
          ? 'Worldwide Express request timed out'
          : abort.externalAbort()
            ? 'Worldwide Express request was cancelled'
            : 'Worldwide Express could not be reached',
        timedOut ? 504 : 503,
        timedOut
          ? 'WWEX_PROVIDER_TIMEOUT'
          : abort.externalAbort()
            ? 'WWEX_REQUEST_ABORTED'
            : 'WWEX_PROVIDER_UNAVAILABLE',
        mutationStarted,
      )
    }
    let raw: string
    try {
      raw = await readBoundedResponse(
        response,
        MAX_FLOW_RESPONSE_BYTES,
        mutationStarted,
      )
    } catch (error) {
      if (error instanceof WwexSpeedshipClientError) throw error
      const timedOut = abort.controller.signal.aborted && !abort.externalAbort()
      throw clientError(
        timedOut
          ? 'Worldwide Express response timed out'
          : abort.externalAbort()
            ? 'Worldwide Express request was cancelled'
            : 'Worldwide Express response could not be read',
        timedOut ? 504 : 503,
        timedOut
          ? 'WWEX_PROVIDER_TIMEOUT'
          : abort.externalAbort()
            ? 'WWEX_REQUEST_ABORTED'
            : 'WWEX_PROVIDER_UNAVAILABLE',
        mutationStarted,
      )
    }
    if (!response.ok) throw httpError(response.status, mutationStarted)
    const payload = jsonResponse(raw, mutationStarted)
    let result: Result
    try {
      result = input.parse(payload)
    } catch (error) {
      if (error instanceof WwexSpeedshipPartialTenderOutcomeError) {
        throw new WwexSpeedshipClientError(
          'Worldwide Express returned a partial tender outcome that requires reconciliation',
          502,
          'WWEX_PARTIAL_OUTCOME_RECONCILIATION_REQUIRED',
          'unknown',
          error.reconciliation,
        )
      }
      throw clientError(
        'Worldwide Express returned an invalid response',
        502,
        'WWEX_RESPONSE_INVALID',
        mutationStarted,
      )
    }
    return deepFreeze({
      result,
      requestHash: input.requestHash,
      credentialVersion: runtimeCredential.credentialVersion,
      credentialFingerprint: runtimeCredential.credentialFingerprint,
      requestedAt,
      completedAt: new Date().toISOString(),
      providerHttpStatus: response.status,
    })
  } finally {
    abort.close()
  }
}

export async function verifyWwexSpeedshipRuntimeCredential(options: {
  runtimeCredential: WwexSpeedshipRuntimeCredential
  fetchImpl?: typeof fetch
  timeoutMs?: number
  signal?: AbortSignal
}): Promise<WwexSpeedshipCredentialVerification> {
  const runtimeCredential = normalizedRuntimeCredential(options.runtimeCredential)
  if (runtimeCredential.environment !== 'sandbox') {
    throw clientError(
      'Worldwide Express production endpoints require provider platform review and configuration',
      409,
      'WWEX_PRODUCTION_CONFIGURATION_REQUIRED',
    )
  }
  const abort = abortState(options.signal, timeoutMs(options.timeoutMs))
  const requestedAt = new Date().toISOString()
  try {
    const authentication = await accessToken({
      credential: runtimeCredential.credential,
      fetchImpl: options.fetchImpl || fetch,
      signal: abort.controller.signal,
      externalAbort: abort.externalAbort,
    })
    return deepFreeze({
      provider: 'wwex_speedship' as const,
      environment: 'sandbox' as const,
      credentialVersion: runtimeCredential.credentialVersion,
      credentialFingerprint: runtimeCredential.credentialFingerprint,
      verificationType: 'oauth_client_credentials' as const,
      requestedAt,
      completedAt: new Date().toISOString(),
      providerHttpStatus: authentication.providerHttpStatus,
    })
  } finally {
    abort.close()
  }
}

export function executeWwexSpeedshipShopRequest(options: CommonExecutionOptions & {
  preparedRequest: PreparedWwexSpeedshipShopRequest
}) {
  const prepared = immutableShopSnapshot(options.preparedRequest)
  const runtimeCredential = normalizedRuntimeCredential(options.runtimeCredential)
  if (
    prepared.evidence.credentialVersion !== runtimeCredential.credentialVersion
    || prepared.evidence.credentialFingerprint
      !== runtimeCredential.credentialFingerprint
  ) {
    throw clientError(
      'Worldwide Express shop credential does not match the prepared request',
      409,
      'WWEX_CREDENTIAL_BINDING_MISMATCH',
    )
  }
  return flowRequest<ParsedWwexSpeedshipShopResponse>({
    ...options,
    runtimeCredential,
    path: prepared.path,
    body: prepared.body,
    requestHash: prepared.requestHash,
    mutation: false,
    parse: prepared.transportMode === 'small_parcel'
      ? (payload) => parseWwexSmallpackShopResponse(prepared, payload)
      : (payload) => parseWwexLtlShopResponse(prepared, payload),
  })
}

export function executeWwexSmallpackSchedulePickupRequest(
  options: CommonExecutionOptions & {
    preparedRequest: PreparedWwexSmallpackSchedulePickupRequest
  },
) {
  const prepared = immutablePickupSnapshot(options.preparedRequest)
  const runtimeCredential = normalizedRuntimeCredential(options.runtimeCredential)
  if (
    prepared.evidence.credentialVersion !== runtimeCredential.credentialVersion
    || prepared.evidence.credentialFingerprint
      !== runtimeCredential.credentialFingerprint
  ) {
    throw clientError(
      'Worldwide Express pickup credential does not match the prepared request',
      409,
      'WWEX_CREDENTIAL_BINDING_MISMATCH',
    )
  }
  return flowRequest<ParsedWwexSmallpackSchedulePickupResponse>({
    ...options,
    runtimeCredential,
    path: prepared.path,
    body: prepared.body,
    requestHash: prepared.requestHash,
    // schedulePickupFlow creates transaction identities consumed by tender.
    // Its outcome is therefore reconciled rather than blindly retried.
    mutation: true,
    parse: (payload) => parseWwexSmallpackSchedulePickupResponse(
      prepared,
      payload,
    ),
  })
}

export function executeWwexSpeedshipTenderRequest(options: CommonExecutionOptions & {
  preparedRequest: PreparedWwexSpeedshipTenderRequest
}) {
  const prepared = immutableTenderSnapshot(options.preparedRequest)
  const runtimeCredential = normalizedRuntimeCredential(options.runtimeCredential)
  if (
    prepared.evidence.credentialVersion !== runtimeCredential.credentialVersion
    || prepared.evidence.credentialFingerprint
      !== runtimeCredential.credentialFingerprint
  ) {
    throw clientError(
      'Worldwide Express tender credential does not match the prepared request',
      409,
      'WWEX_CREDENTIAL_BINDING_MISMATCH',
    )
  }
  return flowRequest<ParsedWwexSpeedshipTenderResponse>({
    ...options,
    runtimeCredential,
    path: prepared.path,
    body: prepared.body,
    requestHash: prepared.requestHash,
    mutation: true,
    parse: prepared.transportMode === 'small_parcel'
      ? (payload) => parseWwexSmallpackTenderResponse(prepared, payload)
      : (payload) => parseWwexLtlTenderResponse(prepared, payload),
  })
}
