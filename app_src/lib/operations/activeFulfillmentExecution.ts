import { createHash } from 'node:crypto'

export type ActiveCarrierProvider = 'ups_rest' | 'fedex_rest'
export type ActiveCarrierGroupAttemptState =
  | 'prepared'
  | 'succeeded'
  | 'failed'
  | 'unknown'

export class ActiveFulfillmentExecutionError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ActiveFulfillmentExecutionError'
    this.code = code
  }
}

export interface ActiveExecutionPackageInput {
  packageId: string
  packageKey: string
  packageNumber: number
}

export interface ActiveShipmentGroupSelection {
  provider: ActiveCarrierProvider
  serviceCode: string
  serviceName: string
  currency: string
  carrierCostMinor: number
}

export interface PrepareActiveFulfillmentExecutionInput {
  activationState: string
  activationRevision: number
  shadowExecutionId: string
  orderId: string
  planId: string
  warehouseId: string
  idempotencyKey: string
  selection: ActiveShipmentGroupSelection
  packages: ActiveExecutionPackageInput[]
}

export interface PreparedActiveFulfillmentExecution {
  authorityMode: 'active'
  state: 'prepared'
  activationRevision: number
  shadowExecutionId: string
  orderId: string
  planId: string
  warehouseId: string
  idempotencyKey: string
  selection: ActiveShipmentGroupSelection
  packages: ActiveExecutionPackageInput[]
  packageCount: number
  requestHash: string
}

export interface PersistedActiveCarrierGroupAttempt {
  attemptId: string
  attemptNumber: number
  persistedAt: string
  state: ActiveCarrierGroupAttemptState
  activeExecutionRequestHash: string
  provider: ActiveCarrierProvider
  serviceCode: string
  serviceName: string
  idempotencyKey: string
  requestHash: string
  packageIds: string[]
  packageCount: number
  dispatchedAt: string | null
  completedAt: string | null
  providerReference: string | null
  errorCode: string | null
  packageResults: ActiveCarrierPackageResult[]
}

export interface ActiveCarrierPackageResult {
  packageId: string
  packageNumber: number
  labelId: string
  shipmentId: string
  trackingNumber: string
  providerPackageReference: string
}

export type ActiveCarrierGroupOutcome =
  | {
      state: 'succeeded'
      dispatchedAt: string
      completedAt: string
      providerReference: string
      packageResults: ActiveCarrierPackageResult[]
    }
  | {
      state: 'failed' | 'unknown'
      dispatchedAt: string
      completedAt: string
      errorCode: string
    }

function fail(code: string, message: string): never {
  throw new ActiveFulfillmentExecutionError(code, message)
}

function requireText(value: string, field: string, maxLength = 200): string {
  const normalized = value.trim()
  if (
    normalized.length === 0
    || normalized.length > maxLength
    || /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    fail(
      'OPERATIONS_ACTIVE_EXECUTION_INPUT_INVALID',
      `${field} must be present and contain no control characters`,
    )
  }
  return normalized
}

function requireInstant(value: string, field: string): string {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) {
    fail(
      'OPERATIONS_ACTIVE_EXECUTION_INPUT_INVALID',
      `${field} must be an ISO-8601 instant`,
    )
  }
  return new Date(timestamp).toISOString()
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    )
  }
  return value
}

export function hashActiveExecutionEvidence(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex')
}

function freezeExecution(
  execution: PreparedActiveFulfillmentExecution,
): PreparedActiveFulfillmentExecution {
  Object.freeze(execution.selection)
  for (const packageRow of execution.packages) Object.freeze(packageRow)
  Object.freeze(execution.packages)
  return Object.freeze(execution)
}

export function prepareActiveFulfillmentExecution(
  input: PrepareActiveFulfillmentExecutionInput,
): PreparedActiveFulfillmentExecution {
  if (!Number.isInteger(input.activationRevision) || input.activationRevision < 1) {
    fail(
      'OPERATIONS_ACTIVE_EXECUTION_INPUT_INVALID',
      'activationRevision must be a positive integer',
    )
  }
  if (input.packages.length < 1 || input.packages.length > 50) {
    fail(
      'OPERATIONS_ACTIVE_PACKAGE_COUNT_INVALID',
      'An Active shipment group requires between 1 and 50 packages',
    )
  }

  const selection: ActiveShipmentGroupSelection = {
    provider: input.selection.provider,
    serviceCode: requireText(input.selection.serviceCode, 'serviceCode', 80),
    serviceName: requireText(input.selection.serviceName, 'serviceName', 160),
    currency: requireText(input.selection.currency, 'currency', 3).toUpperCase(),
    carrierCostMinor: input.selection.carrierCostMinor,
  }
  if (!['ups_rest', 'fedex_rest'].includes(selection.provider)) {
    fail(
      'OPERATIONS_ACTIVE_EXECUTION_INPUT_INVALID',
      'provider must be ups_rest or fedex_rest',
    )
  }
  if (!/^[A-Z]{3}$/u.test(selection.currency)) {
    fail(
      'OPERATIONS_ACTIVE_EXECUTION_INPUT_INVALID',
      'currency must be a three-letter ISO code',
    )
  }
  if (
    !Number.isSafeInteger(selection.carrierCostMinor)
    || selection.carrierCostMinor < 0
  ) {
    fail(
      'OPERATIONS_ACTIVE_EXECUTION_INPUT_INVALID',
      'carrierCostMinor must be a non-negative safe integer',
    )
  }

  const seenIds = new Set<string>()
  const seenKeys = new Set<string>()
  const seenNumbers = new Set<number>()
  const packages = input.packages.map((sourcePackage) => {
    const packageId = requireText(sourcePackage.packageId, 'packageId')
    const packageKey = requireText(sourcePackage.packageKey, 'packageKey', 160)
    if (
      !Number.isInteger(sourcePackage.packageNumber)
      || sourcePackage.packageNumber < 1
    ) {
      fail(
        'OPERATIONS_ACTIVE_PACKAGE_IDENTITY_INVALID',
        'packageNumber must be a positive integer',
      )
    }
    if (
      seenIds.has(packageId)
      || seenKeys.has(packageKey)
      || seenNumbers.has(sourcePackage.packageNumber)
    ) {
      fail(
        'OPERATIONS_ACTIVE_PACKAGE_IDENTITY_INVALID',
        'Active shipment packages require unique IDs, keys, and numbers',
      )
    }
    seenIds.add(packageId)
    seenKeys.add(packageKey)
    seenNumbers.add(sourcePackage.packageNumber)
    return { packageId, packageKey, packageNumber: sourcePackage.packageNumber }
  }).sort((left, right) => left.packageNumber - right.packageNumber)

  const evidence = {
    activationRevision: input.activationRevision,
    shadowExecutionId: requireText(input.shadowExecutionId, 'shadowExecutionId'),
    orderId: requireText(input.orderId, 'orderId'),
    planId: requireText(input.planId, 'planId'),
    warehouseId: requireText(input.warehouseId, 'warehouseId'),
    idempotencyKey: requireText(input.idempotencyKey, 'idempotencyKey'),
    selection,
    packages,
  }
  return freezeExecution({
    authorityMode: 'active',
    state: 'prepared',
    ...evidence,
    packageCount: packages.length,
    requestHash: hashActiveExecutionEvidence(evidence),
  })
}

export function recordPersistedActiveCarrierGroupAttempt(input: {
  attemptId: string
  persistedAt: string
  idempotencyKey: string
  execution: PreparedActiveFulfillmentExecution
  previousAttempt?: PersistedActiveCarrierGroupAttempt
}): PersistedActiveCarrierGroupAttempt {
  const packageIds = Object.freeze(
    input.execution.packages.map((entry) => entry.packageId),
  ) as unknown as string[]
  const previousAttempt = input.previousAttempt
  if (previousAttempt) {
    if (previousAttempt.state === 'unknown') {
      fail(
        'OPERATIONS_ACTIVE_CARRIER_OUTCOME_UNKNOWN_RECONCILIATION_REQUIRED',
        'An unknown whole-shipment carrier outcome must be reconciled and cannot be retried',
      )
    }
    if (previousAttempt.state !== 'failed') {
      fail(
        'OPERATIONS_ACTIVE_CARRIER_ATTEMPT_TERMINAL',
        'Only a known failed whole-shipment attempt may be retried',
      )
    }
    if (
      previousAttempt.activeExecutionRequestHash !== input.execution.requestHash
      || previousAttempt.provider !== input.execution.selection.provider
      || previousAttempt.serviceCode !== input.execution.selection.serviceCode
      || previousAttempt.serviceName !== input.execution.selection.serviceName
      || previousAttempt.packageIds.length !== packageIds.length
      || previousAttempt.packageIds.some((packageId, index) => (
        packageId !== packageIds[index]
      ))
    ) {
      fail(
        'OPERATIONS_ACTIVE_RETRY_LINEAGE_CHANGED',
        'A known-failure retry must retain the exact execution, service, and packages',
      )
    }
  }
  const requestEvidence = {
    activeExecutionRequestHash: input.execution.requestHash,
    provider: input.execution.selection.provider,
    serviceCode: input.execution.selection.serviceCode,
    serviceName: input.execution.selection.serviceName,
    idempotencyKey: requireText(input.idempotencyKey, 'idempotencyKey'),
    packageIds,
  }
  return Object.freeze({
    attemptId: requireText(input.attemptId, 'attemptId'),
    attemptNumber: previousAttempt ? previousAttempt.attemptNumber + 1 : 1,
    persistedAt: requireInstant(input.persistedAt, 'persistedAt'),
    state: 'prepared',
    ...requestEvidence,
    requestHash: hashActiveExecutionEvidence(requestEvidence),
    packageCount: packageIds.length,
    dispatchedAt: null,
    completedAt: null,
    providerReference: null,
    errorCode: null,
    packageResults: Object.freeze([]) as unknown as ActiveCarrierPackageResult[],
  })
}

export function assertActiveCarrierGroupAttemptDispatchable(
  attempt: PersistedActiveCarrierGroupAttempt,
): void {
  requireText(attempt.attemptId, 'attemptId')
  requireInstant(attempt.persistedAt, 'persistedAt')
  if (attempt.state === 'unknown') {
    fail(
      'OPERATIONS_ACTIVE_CARRIER_OUTCOME_UNKNOWN_RECONCILIATION_REQUIRED',
      'An unknown whole-shipment carrier outcome must be reconciled and cannot be retried',
    )
  }
  if (attempt.state !== 'prepared') {
    fail(
      'OPERATIONS_ACTIVE_CARRIER_ATTEMPT_TERMINAL',
      'A terminal whole-shipment carrier attempt cannot be dispatched again',
    )
  }
}

function validateSucceededPackageResults(
  attempt: PersistedActiveCarrierGroupAttempt,
  results: ActiveCarrierPackageResult[],
): ActiveCarrierPackageResult[] {
  if (results.length !== attempt.packageCount) {
    fail(
      'OPERATIONS_ACTIVE_PACKAGE_RESULTS_INCOMPLETE',
      'A succeeded group attempt requires one label and shipment for every package',
    )
  }
  const expectedIds = new Set(attempt.packageIds)
  const seenIds = new Set<string>()
  const seenNumbers = new Set<number>()
  return results.map((result) => {
    const packageId = requireText(result.packageId, 'packageId')
    if (
      !expectedIds.has(packageId)
      || seenIds.has(packageId)
      || !Number.isInteger(result.packageNumber)
      || result.packageNumber < 1
      || seenNumbers.has(result.packageNumber)
    ) {
      fail(
        'OPERATIONS_ACTIVE_PACKAGE_RESULTS_INVALID',
        'Package results must cover the exact prepared package set once',
      )
    }
    seenIds.add(packageId)
    seenNumbers.add(result.packageNumber)
    return {
      packageId,
      packageNumber: result.packageNumber,
      labelId: requireText(result.labelId, 'labelId'),
      shipmentId: requireText(result.shipmentId, 'shipmentId'),
      trackingNumber: requireText(result.trackingNumber, 'trackingNumber', 160),
      providerPackageReference: requireText(
        result.providerPackageReference,
        'providerPackageReference',
      ),
    }
  }).sort((left, right) => left.packageNumber - right.packageNumber)
}

export function finalizeActiveCarrierGroupAttempt(
  attempt: PersistedActiveCarrierGroupAttempt,
  outcome: ActiveCarrierGroupOutcome,
): PersistedActiveCarrierGroupAttempt {
  assertActiveCarrierGroupAttemptDispatchable(attempt)
  const dispatchedAt = requireInstant(outcome.dispatchedAt, 'dispatchedAt')
  const completedAt = requireInstant(outcome.completedAt, 'completedAt')
  if (Date.parse(completedAt) < Date.parse(dispatchedAt)) {
    fail(
      'OPERATIONS_ACTIVE_EXECUTION_INPUT_INVALID',
      'completedAt cannot precede dispatchedAt',
    )
  }

  if (outcome.state === 'succeeded') {
    const packageResults = validateSucceededPackageResults(
      attempt,
      outcome.packageResults,
    )
    for (const result of packageResults) Object.freeze(result)
    Object.freeze(packageResults)
    return Object.freeze({
      ...attempt,
      state: 'succeeded',
      dispatchedAt,
      completedAt,
      providerReference: requireText(
        outcome.providerReference,
        'providerReference',
      ),
      errorCode: null,
      packageResults,
    })
  }

  const errorCode = requireText(outcome.errorCode, 'errorCode', 128)
  if (!/^[A-Z0-9_]+$/u.test(errorCode)) {
    fail(
      'OPERATIONS_ACTIVE_EXECUTION_INPUT_INVALID',
      'errorCode must be an uppercase machine-readable code',
    )
  }
  return Object.freeze({
    ...attempt,
    state: outcome.state,
    dispatchedAt,
    completedAt,
    providerReference: null,
    errorCode,
    packageResults: Object.freeze([]) as unknown as ActiveCarrierPackageResult[],
  })
}
