import {
  normalizeBrokeredTransportCredential,
  type RlCarriersCredential,
} from '@/lib/integrations/brokeredTransportCredentialCrypto'
import {
  RL_CARRIERS_FREIGHT_ENDPOINTS,
  parseRlCarriersBillOfLadingResponse,
  parseRlCarriersQuotedPickupResponse,
  parseRlCarriersRateQuoteResponse,
  RlCarriersPartialMutationOutcomeError,
  sealPreparedRlCarriersFreightRequest,
  type ParsedRlCarriersBillOfLadingResponse,
  type ParsedRlCarriersQuotedPickupResponse,
  type ParsedRlCarriersRateQuoteResponse,
  type PreparedRlCarriersBillOfLadingRequest,
  type PreparedRlCarriersFreightRequest,
  type PreparedRlCarriersQuotedPickupRequest,
  type PreparedRlCarriersRateQuoteRequest,
  type RlCarriersFreightOperation,
  type RlCarriersPartialMutationReconciliation,
} from '@/lib/integrations/rlCarriersFreightFoundation'

const DEFAULT_TIMEOUT_MS = 15_000
const MIN_TIMEOUT_MS = 1_000
const MAX_TIMEOUT_MS = 30_000
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

export type RlCarriersFreightOutcome = 'failed' | 'unknown'

export class RlCarriersFreightClientError extends Error {
  readonly status: number
  readonly code: string
  readonly providerOutcome: RlCarriersFreightOutcome
  readonly reconciliation: RlCarriersPartialMutationReconciliation | null

  constructor(
    message: string,
    status: number,
    code: string,
    providerOutcome: RlCarriersFreightOutcome,
    reconciliation: RlCarriersPartialMutationReconciliation | null = null,
  ) {
    super(message)
    this.name = 'RlCarriersFreightClientError'
    this.status = status
    this.code = code
    this.providerOutcome = providerOutcome
    this.reconciliation = reconciliation
  }
}

export type RlCarriersFreightRuntimeCredential = {
  provider: 'rl_carriers'
  environment: 'production'
  credentialVersion: number
  credentialFingerprint: string
  credential: RlCarriersCredential
}

type ExecutionOptions<Prepared extends PreparedRlCarriersFreightRequest> = {
  preparedRequest: Prepared
  runtimeCredential: RlCarriersFreightRuntimeCredential
  fetchImpl?: typeof fetch
  timeoutMs?: number
  signal?: AbortSignal
}

export type RlCarriersFreightExecution<Result> = {
  result: Result
  requestHash: string
  operation: RlCarriersFreightOperation
  credentialVersion: number
  credentialFingerprint: string
  requestedAt: string
  completedAt: string
  providerHttpStatus: number
}

export type RlCarriersCredentialVerification = Readonly<{
  provider: 'rl_carriers'
  environment: 'production'
  credentialVersion: number
  credentialFingerprint: string
  verificationType: 'service_point'
  servicePointCount: number
  requestedAt: string
  completedAt: string
  providerHttpStatus: number
}>

function isMutation(operation: RlCarriersFreightOperation) {
  return operation !== 'rate_quote'
}

function failure(
  operation: RlCarriersFreightOperation,
  message: string,
  status: number,
  code: string,
  ambiguous = false,
) {
  return new RlCarriersFreightClientError(
    message,
    status,
    code,
    ambiguous && isMutation(operation) ? 'unknown' : 'failed',
  )
}

function timeoutMs(value: number | undefined) {
  const normalized = value ?? DEFAULT_TIMEOUT_MS
  if (
    !Number.isInteger(normalized)
    || normalized < MIN_TIMEOUT_MS
    || normalized > MAX_TIMEOUT_MS
  ) {
    throw new RlCarriersFreightClientError(
      `R+L timeout must be ${MIN_TIMEOUT_MS}-${MAX_TIMEOUT_MS} milliseconds`,
      400,
      'RL_TIMEOUT_INVALID',
      'failed',
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

function immutablePreparedSnapshot<Prepared extends PreparedRlCarriersFreightRequest>(
  prepared: Prepared,
) {
  try {
    sealPreparedRlCarriersFreightRequest(prepared)
    const snapshot = JSON.parse(JSON.stringify(prepared)) as Prepared
    sealPreparedRlCarriersFreightRequest(snapshot)
    return deepFreeze(snapshot)
  } catch {
    throw new RlCarriersFreightClientError(
      'Prepared R+L request failed its integrity check',
      400,
      'RL_PREPARED_REQUEST_INVALID',
      'failed',
    )
  }
}

function responseTooLarge(operation: RlCarriersFreightOperation) {
  return failure(
    operation,
    'R+L returned an invalid freight response',
    502,
    'RL_RESPONSE_INVALID',
    true,
  )
}

async function readBoundedResponse(
  response: Response,
  operation: RlCarriersFreightOperation,
) {
  const header = response.headers.get('content-length')
  if (header !== null) {
    if (!/^\d+$/.test(header) || Number(header) > MAX_RESPONSE_BYTES) {
      throw responseTooLarge(operation)
    }
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
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw responseTooLarge(operation)
      }
      chunks.push(Buffer.from(chunk.value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, total).toString('utf8')
}

function parseJson(
  value: string,
  operation: RlCarriersFreightOperation,
) {
  try {
    return JSON.parse(value)
  } catch {
    throw failure(
      operation,
      'R+L returned an invalid freight response',
      502,
      'RL_RESPONSE_INVALID',
      true,
    )
  }
}

function httpError(
  operation: RlCarriersFreightOperation,
  status: number,
) {
  if ([400, 401, 403, 404, 422].includes(status)) {
    return failure(
      operation,
      'R+L rejected the freight request',
      409,
      'RL_REQUEST_REJECTED',
      false,
    )
  }
  if (status === 409) {
    return failure(
      operation,
      isMutation(operation)
        ? 'R+L returned a freight conflict that requires reconciliation'
        : 'R+L rejected the freight request',
      409,
      isMutation(operation)
        ? 'RL_CONFLICT_RECONCILIATION_REQUIRED'
        : 'RL_REQUEST_REJECTED',
      isMutation(operation),
    )
  }
  if (status === 429) {
    return failure(
      operation,
      'R+L temporarily rate limited the freight request',
      503,
      'RL_PROVIDER_RATE_LIMITED',
      isMutation(operation),
    )
  }
  return failure(
    operation,
    'R+L freight service is temporarily unavailable',
    503,
    'RL_PROVIDER_UNAVAILABLE',
    true,
  )
}

function normalizedRuntimeCredential(
  value: RlCarriersFreightRuntimeCredential,
  operation: RlCarriersFreightOperation,
) {
  if (
    !value
    || value.provider !== 'rl_carriers'
    || value.environment !== 'production'
    || !Number.isSafeInteger(value.credentialVersion)
    || value.credentialVersion < 1
    || !/^[a-f0-9]{64}$/.test(value.credentialFingerprint)
  ) {
    throw failure(
      operation,
      'R+L runtime credential binding is invalid',
      409,
      'RL_CREDENTIAL_BINDING_MISMATCH',
    )
  }
  let credential: RlCarriersCredential
  try {
    credential = normalizeBrokeredTransportCredential(
      'rl_carriers',
      value.credential,
    ) as RlCarriersCredential
  } catch {
    throw failure(
      operation,
      'A valid R+L production API key is required',
      409,
      'RL_CREDENTIAL_INVALID',
    )
  }
  return { ...value, credential }
}

async function execute<
  Prepared extends PreparedRlCarriersFreightRequest,
  Result,
>(
  options: ExecutionOptions<Prepared>,
  parse: (prepared: Prepared, payload: unknown) => Result,
): Promise<RlCarriersFreightExecution<Result>> {
  const prepared = immutablePreparedSnapshot(options.preparedRequest)
  const operation = prepared.operation
  const runtimeCredential = normalizedRuntimeCredential(
    options.runtimeCredential,
    operation,
  )
  if (
    prepared.redactedRequest.credentialVersion
      !== runtimeCredential.credentialVersion
    || prepared.redactedRequest.credentialFingerprint
      !== runtimeCredential.credentialFingerprint
  ) {
    throw failure(
      operation,
      'R+L request credential does not match the prepared request',
      409,
      'RL_CREDENTIAL_BINDING_MISMATCH',
    )
  }
  const duration = timeoutMs(options.timeoutMs)
  const controller = new AbortController()
  let externalAbort = false
  const abortFromExternal = () => {
    externalAbort = true
    controller.abort(options.signal?.reason)
  }
  if (options.signal?.aborted) abortFromExternal()
  else options.signal?.addEventListener('abort', abortFromExternal, { once: true })
  const timer = setTimeout(() => controller.abort(), duration)
  const requestedAt = new Date().toISOString()
  let response: Response
  try {
    response = await (options.fetchImpl || fetch)(prepared.endpoint, {
      method: prepared.method,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        apiKey: runtimeCredential.credential.apiKey,
      },
      body: JSON.stringify(prepared.body),
      cache: 'no-store',
      redirect: 'error',
      signal: controller.signal,
    })
  } catch (error) {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abortFromExternal)
    if (error instanceof RlCarriersFreightClientError) throw error
    const timedOut = controller.signal.aborted && !externalAbort
    throw failure(
      operation,
      timedOut
        ? 'R+L freight request timed out'
        : externalAbort
          ? 'R+L freight request was cancelled'
          : 'R+L freight service could not be reached',
      timedOut ? 504 : 503,
      timedOut
        ? 'RL_PROVIDER_TIMEOUT'
        : externalAbort
          ? 'RL_REQUEST_ABORTED'
          : 'RL_PROVIDER_UNAVAILABLE',
      true,
    )
  }
  try {
    let raw: string
    try {
      raw = await readBoundedResponse(response, operation)
    } catch (error) {
      if (error instanceof RlCarriersFreightClientError) throw error
      const timedOut = controller.signal.aborted && !externalAbort
      throw failure(
        operation,
        timedOut
          ? 'R+L freight response timed out'
          : externalAbort
            ? 'R+L freight request was cancelled'
            : 'R+L freight response could not be read',
        timedOut ? 504 : 503,
        timedOut
          ? 'RL_PROVIDER_TIMEOUT'
          : externalAbort
            ? 'RL_REQUEST_ABORTED'
            : 'RL_PROVIDER_UNAVAILABLE',
        true,
      )
    }
    if (!response.ok) throw httpError(operation, response.status)
    const payload = parseJson(raw, operation)
    let result: Result
    try {
      result = parse(prepared, payload)
    } catch (error) {
      if (error instanceof RlCarriersPartialMutationOutcomeError) {
        throw new RlCarriersFreightClientError(
          'R+L returned a partial mutation outcome that requires reconciliation',
          502,
          'RL_PARTIAL_OUTCOME_RECONCILIATION_REQUIRED',
          'unknown',
          error.reconciliation,
        )
      }
      throw failure(
        operation,
        'R+L returned an invalid freight response',
        502,
        'RL_RESPONSE_INVALID',
        true,
      )
    }
    return deepFreeze({
      result,
      requestHash: prepared.requestHash,
      operation,
      credentialVersion: runtimeCredential.credentialVersion,
      credentialFingerprint: runtimeCredential.credentialFingerprint,
      requestedAt,
      completedAt: new Date().toISOString(),
      providerHttpStatus: response.status,
    })
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abortFromExternal)
  }
}

export function executeRlCarriersRateQuoteRequest(
  options: ExecutionOptions<PreparedRlCarriersRateQuoteRequest>,
) {
  return execute<
    PreparedRlCarriersRateQuoteRequest,
    ParsedRlCarriersRateQuoteResponse
  >(options, parseRlCarriersRateQuoteResponse)
}

export async function verifyRlCarriersRuntimeCredential(options: {
  runtimeCredential: RlCarriersFreightRuntimeCredential
  zipOrPostalCode: string
  countryCode: 'USA' | 'CAN'
  fetchImpl?: typeof fetch
  timeoutMs?: number
  signal?: AbortSignal
}): Promise<RlCarriersCredentialVerification> {
  const operation: RlCarriersFreightOperation = 'rate_quote'
  const runtimeCredential = normalizedRuntimeCredential(
    options.runtimeCredential,
    operation,
  )
  const zipOrPostalCode = String(options.zipOrPostalCode || '')
    .trim()
    .toUpperCase()
  if (!/^(?:\d{5}(?:-\d{4})?|[A-Z]\d[A-Z][ -]?\d[A-Z]\d)$/.test(zipOrPostalCode)) {
    throw failure(
      operation,
      'A valid US or Canadian postal code is required for R+L verification',
      400,
      'RL_VERIFICATION_POSTAL_CODE_INVALID',
    )
  }
  if (options.countryCode !== 'USA' && options.countryCode !== 'CAN') {
    throw failure(
      operation,
      'R+L verification country must be USA or CAN',
      400,
      'RL_VERIFICATION_COUNTRY_INVALID',
    )
  }
  const duration = timeoutMs(options.timeoutMs)
  const controller = new AbortController()
  let externalAbort = false
  const abortFromExternal = () => {
    externalAbort = true
    controller.abort(options.signal?.reason)
  }
  if (options.signal?.aborted) abortFromExternal()
  else options.signal?.addEventListener('abort', abortFromExternal, { once: true })
  const timer = setTimeout(() => controller.abort(), duration)
  const requestedAt = new Date().toISOString()
  try {
    const endpoint = new URL(RL_CARRIERS_FREIGHT_ENDPOINTS.servicePoint)
    endpoint.searchParams.set('ZipOrPostalCode', zipOrPostalCode)
    endpoint.searchParams.set('CountryCode', options.countryCode)
    let response: Response
    try {
      response = await (options.fetchImpl || fetch)(endpoint, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          apiKey: runtimeCredential.credential.apiKey,
        },
        cache: 'no-store',
        redirect: 'error',
        signal: controller.signal,
      })
    } catch {
      const timedOut = controller.signal.aborted && !externalAbort
      throw failure(
        operation,
        timedOut
          ? 'R+L credential verification timed out'
          : externalAbort
            ? 'R+L credential verification was cancelled'
            : 'R+L credential verification could not be reached',
        timedOut ? 504 : 503,
        timedOut
          ? 'RL_PROVIDER_TIMEOUT'
          : externalAbort
            ? 'RL_REQUEST_ABORTED'
            : 'RL_PROVIDER_UNAVAILABLE',
      )
    }
    let raw: string
    try {
      raw = await readBoundedResponse(response, operation)
    } catch (error) {
      if (error instanceof RlCarriersFreightClientError) throw error
      const timedOut = controller.signal.aborted && !externalAbort
      throw failure(
        operation,
        timedOut
          ? 'R+L credential verification response timed out'
          : externalAbort
            ? 'R+L credential verification was cancelled'
            : 'R+L credential verification response could not be read',
        timedOut ? 504 : 503,
        timedOut
          ? 'RL_PROVIDER_TIMEOUT'
          : externalAbort
            ? 'RL_REQUEST_ABORTED'
            : 'RL_PROVIDER_UNAVAILABLE',
      )
    }
    if (!response.ok) throw httpError(operation, response.status)
    const payload = parseJson(raw, operation)
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw failure(
        operation,
        'R+L returned an invalid credential verification response',
        502,
        'RL_RESPONSE_INVALID',
      )
    }
    const servicePoints = (payload as Record<string, unknown>).ServicePoints
    if (!Array.isArray(servicePoints) || servicePoints.length < 1) {
      throw failure(
        operation,
        'R+L returned no service point for the verification postal code',
        409,
        'RL_VERIFICATION_SERVICE_POINT_NOT_FOUND',
      )
    }
    return deepFreeze({
      provider: 'rl_carriers' as const,
      environment: 'production' as const,
      credentialVersion: runtimeCredential.credentialVersion,
      credentialFingerprint: runtimeCredential.credentialFingerprint,
      verificationType: 'service_point' as const,
      servicePointCount: servicePoints.length,
      requestedAt,
      completedAt: new Date().toISOString(),
      providerHttpStatus: response.status,
    })
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abortFromExternal)
  }
}

export function executeRlCarriersBillOfLadingRequest(
  options: ExecutionOptions<PreparedRlCarriersBillOfLadingRequest>,
) {
  return execute<
    PreparedRlCarriersBillOfLadingRequest,
    ParsedRlCarriersBillOfLadingResponse
  >(options, parseRlCarriersBillOfLadingResponse)
}

export function executeRlCarriersQuotedPickupRequest(
  options: ExecutionOptions<PreparedRlCarriersQuotedPickupRequest>,
) {
  return execute<
    PreparedRlCarriersQuotedPickupRequest,
    ParsedRlCarriersQuotedPickupResponse
  >(options, parseRlCarriersQuotedPickupResponse)
}
