import {
  DeterministicFulfillmentOptimizer,
} from '@/lib/operations/domain'
import type {
  OptimizationRequest,
  WarehouseCandidate,
} from '@/lib/operations/types'
import {
  assertOptimizerResponseSize,
  canonicalOptimizerHash,
  canonicalOptimizerJson,
  OptimizerContractError,
  parseFulfillmentOptimizationResult,
  parsePackagingAssortmentResult,
  validateFulfillmentOptimizationInput,
  validateFulfillmentOptimizationOptions,
  validatePackagingAssortmentInput,
} from '@/lib/operations/fulfillmentOptimizerContract'
import type {
  FulfillmentCandidatePlanV1,
  FulfillmentCartonCandidate,
  FulfillmentOptimizationInputV1,
  FulfillmentOptimizationOptions,
  FulfillmentOptimizationResultV1,
  FulfillmentOptimizerV1,
  OptimizerDimensionsMm,
  PackagingAssortmentOptimizationInputV1,
  PackagingAssortmentResultV1,
} from '@/lib/operations/fulfillmentOptimizerContract'

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
const DETERMINISTIC_ALGORITHM_VERSION = 'clawpilot-deterministic-one-unit-carton-v1'

type FetchImplementation = typeof fetch

export type OrToolsFulfillmentOptimizerConfig = {
  baseUrl: string
  secret: string
  requestTimeoutMs?: number
  fetchImplementation?: FetchImplementation
}

export class PackagingAssortmentOptimizerUnavailableError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'PackagingAssortmentOptimizerUnavailableError'
    this.code = code
  }
}

function safeInteger(value: number, code: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new OptimizerContractError(code)
  }
  return value
}

function dimensionsVolume(value: OptimizerDimensionsMm): number {
  return safeInteger(
    value.length * value.width * value.height,
    'OPTIMIZER_DIMENSIONS_VOLUME_INVALID',
    1,
    1_000_000_000_000_000,
  )
}

function rotations(
  value: OptimizerDimensionsMm,
  allowed: boolean,
): OptimizerDimensionsMm[] {
  const candidates = allowed
    ? [
        [value.length, value.width, value.height],
        [value.length, value.height, value.width],
        [value.width, value.length, value.height],
        [value.width, value.height, value.length],
        [value.height, value.length, value.width],
        [value.height, value.width, value.length],
      ]
    : [[value.length, value.width, value.height]]
  const seen = new Set<string>()
  return candidates.flatMap(([length, width, height]) => {
    const key = `${length}:${width}:${height}`
    if (seen.has(key)) return []
    seen.add(key)
    return [{ length, width, height }]
  }).sort((left, right) => (
    left.length - right.length
    || left.width - right.width
    || left.height - right.height
  ))
}

function fittingRotation(
  dimensions: OptimizerDimensionsMm,
  rotationAllowed: boolean,
  carton: FulfillmentCartonCandidate,
): OptimizerDimensionsMm | null {
  return rotations(dimensions, rotationAllowed).find((candidate) => (
    candidate.length <= carton.innerDimensionsMm.length
    && candidate.width <= carton.innerDimensionsMm.width
    && candidate.height <= carton.innerDimensionsMm.height
  )) || null
}

function serviceFailureCode(error: unknown): string {
  if (error instanceof OptimizerContractError) return error.code
  if (error instanceof Error && error.name === 'AbortError') return 'ORTOOLS_TIMEOUT'
  return 'ORTOOLS_UNAVAILABLE'
}

function fulfillmentRequest(
  input: FulfillmentOptimizationInputV1,
): OptimizationRequest {
  const allowedWarehouses = new Set(
    input.constraints.allowedWarehouseGlobalIds.length
      ? input.constraints.allowedWarehouseGlobalIds
      : input.warehouses.map((item) => item.warehouseGlobalId),
  )
  const demandByProduct = new Map<string, number>()
  for (const line of input.lines) {
    demandByProduct.set(
      line.productGlobalId,
      (demandByProduct.get(line.productGlobalId) || 0) + line.quantity,
    )
  }
  const candidates: WarehouseCandidate[] = input.warehouses
    .filter((warehouse) => warehouse.active && allowedWarehouses.has(warehouse.warehouseGlobalId))
    .map((warehouse) => {
      const availableByProductId = new Map<string, number>()
      for (const position of input.eligiblePositions) {
        if (position.warehouseGlobalId !== warehouse.warehouseGlobalId) continue
        availableByProductId.set(
          position.productGlobalId,
          (availableByProductId.get(position.productGlobalId) || 0) + position.availableQuantity,
        )
      }
      return {
        warehouseId: warehouse.warehouseGlobalId,
        warehouseGlobalId: warehouse.warehouseGlobalId,
        warehouseName: warehouse.warehouseGlobalId,
        availableByProductId,
        handlingCostMinor: BigInt(warehouse.handlingCostMinor),
      }
    })
  return {
    orderGlobalId: input.orderGlobalId,
    demand: [...demandByProduct.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([productId, quantity]) => ({ productId, quantity })),
    candidates,
    allowMultiWarehouse: input.splitPolicy.allowed,
  }
}

async function deterministicFallback(
  input: FulfillmentOptimizationInputV1,
  inputHash: string,
  reasonCode: string,
): Promise<FulfillmentOptimizationResultV1> {
  const fallback = new DeterministicFulfillmentOptimizer()
  const selection = await fallback.plan(fulfillmentRequest(input))
  const warehouseGlobalId = selection.warehouseIds[0] || null
  const fallbackReason = [
    reasonCode,
    selection.fallbackReason,
  ].filter(Boolean).join(': ').slice(0, 512)
  if (selection.solverStatus === 'infeasible' || !warehouseGlobalId) {
    return {
      schemaVersion: 1,
      status: 'infeasible',
      method: 'deterministic_fallback',
      algorithmVersion: DETERMINISTIC_ALGORITHM_VERSION,
      inputHash,
      durationMs: 0,
      selectedPlan: null,
      candidates: [],
      rejectedAlternatives: [{
        code: 'DETERMINISTIC_SINGLE_WAREHOUSE_INFEASIBLE',
        warehouseGlobalId,
      }],
      fallbackReason,
      explanation: [selection.explanation],
    }
  }

  const warehouse = input.warehouses.find(
    (item) => item.warehouseGlobalId === warehouseGlobalId && item.active,
  )
  if (!warehouse) {
    throw new OptimizerContractError('DETERMINISTIC_WAREHOUSE_REFERENCE_INVALID')
  }
  const allowedCartons = new Set(
    input.constraints.allowedCartonGlobalIds.length
      ? input.constraints.allowedCartonGlobalIds
      : input.cartons.map((item) => item.cartonGlobalId),
  )
  const cartons = input.cartons
    .filter((item) => (
      item.warehouseGlobalId === warehouseGlobalId
      && allowedCartons.has(item.cartonGlobalId)
    ))
    .sort((left, right) => (
      left.materialCostMinor + left.estimatedTransportCostMinor
        - right.materialCostMinor - right.estimatedTransportCostMinor
      || dimensionsVolume(left.innerDimensionsMm) - dimensionsVolume(right.innerDimensionsMm)
      || left.cartonGlobalId.localeCompare(right.cartonGlobalId)
    ))
  const positions = input.eligiblePositions
    .filter((item) => (
      item.warehouseGlobalId === warehouseGlobalId
      && item.availableQuantity > 0
    ))
    .sort((left, right) => left.positionGlobalId.localeCompare(right.positionGlobalId))
  const positionRemaining = new Map(
    positions.map((item) => [item.positionGlobalId, item.availableQuantity]),
  )
  const cartonUse = new Map<string, number>()
  const packages: FulfillmentCandidatePlanV1['packages'][number][] = []
  let deterministicFailure: string | null = null

  for (const line of [...input.lines].sort(
    (left, right) => left.lineGlobalId.localeCompare(right.lineGlobalId),
  )) {
    if (
      line.allowedWarehouseGlobalIds.length
      && !line.allowedWarehouseGlobalIds.includes(warehouseGlobalId)
    ) {
      deterministicFailure = 'DETERMINISTIC_LINE_WAREHOUSE_FORBIDDEN'
      break
    }
    for (let unitNumber = 1; unitNumber <= line.quantity; unitNumber += 1) {
      const position = positions.find((item) => (
        item.productGlobalId === line.productGlobalId
        && (positionRemaining.get(item.positionGlobalId) || 0) > 0
      ))
      if (!position) {
        deterministicFailure = 'DETERMINISTIC_INVENTORY_INSUFFICIENT'
        break
      }
      const cartonSelection = cartons
        .map((carton) => ({
          carton,
          orientation: fittingRotation(
            line.unitDimensionsMm,
            line.rotationAllowed,
            carton,
          ),
        }))
        .find(({ carton, orientation }) => (
          orientation !== null
          && (
            !line.allowedCartonGlobalIds.length
            || line.allowedCartonGlobalIds.includes(carton.cartonGlobalId)
          )
          && (cartonUse.get(carton.cartonGlobalId) || 0) < carton.availableQuantity
          && carton.emptyWeightGrams + line.unitWeightGrams <= Math.min(
            carton.maxWeightGrams,
            input.constraints.maxPackageWeightGrams ?? carton.maxWeightGrams,
          )
        ))
      if (!cartonSelection?.orientation) {
        deterministicFailure = 'DETERMINISTIC_CARTON_UNAVAILABLE'
        break
      }
      if (packages.length >= input.constraints.maxPackages) {
        deterministicFailure = 'DETERMINISTIC_PACKAGE_LIMIT_EXCEEDED'
        break
      }
      const { carton, orientation } = cartonSelection
      const cartonNumber = (cartonUse.get(carton.cartonGlobalId) || 0) + 1
      cartonUse.set(carton.cartonGlobalId, cartonNumber)
      positionRemaining.set(
        position.positionGlobalId,
        (positionRemaining.get(position.positionGlobalId) || 0) - 1,
      )
      const cartonVolume = dimensionsVolume(carton.innerDimensionsMm)
      const unitVolume = dimensionsVolume(line.unitDimensionsMm)
      packages.push({
        packageKey: `${carton.cartonGlobalId}#fallback-${String(cartonNumber).padStart(4, '0')}`,
        warehouseGlobalId,
        cartonGlobalId: carton.cartonGlobalId,
        innerDimensionsMm: carton.innerDimensionsMm,
        maxWeightGrams: Math.min(
          carton.maxWeightGrams,
          input.constraints.maxPackageWeightGrams ?? carton.maxWeightGrams,
        ),
        emptyWeightGrams: carton.emptyWeightGrams,
        totalWeightGrams: carton.emptyWeightGrams + line.unitWeightGrams,
        usedVolumeMm3: unitVolume,
        unusedVolumeMm3: cartonVolume - unitVolume,
        estimatedCostMinor: (
          carton.materialCostMinor
          + carton.estimatedTransportCostMinor
          + position.unitHandlingCostMinor
        ),
        allocations: [{
          lineGlobalId: line.lineGlobalId,
          productGlobalId: line.productGlobalId,
          positionGlobalId: position.positionGlobalId,
          quantity: 1,
        }],
        placements: [{
          unitKey: `${line.lineGlobalId}#${String(unitNumber).padStart(6, '0')}`,
          lineGlobalId: line.lineGlobalId,
          productGlobalId: line.productGlobalId,
          positionGlobalId: position.positionGlobalId,
          dimensionsMm: orientation,
          coordinatesMm: { x: 0, y: 0, z: 0 },
        }],
      })
    }
    if (deterministicFailure) break
  }

  if (deterministicFailure) {
    return {
      schemaVersion: 1,
      status: 'infeasible',
      method: 'deterministic_fallback',
      algorithmVersion: DETERMINISTIC_ALGORITHM_VERSION,
      inputHash,
      durationMs: 0,
      selectedPlan: null,
      candidates: [],
      rejectedAlternatives: [{
        code: deterministicFailure,
        warehouseGlobalId,
      }],
      fallbackReason: `${fallbackReason}: ${deterministicFailure}`.slice(0, 512),
      explanation: [selection.explanation],
    }
  }
  const warehouseGlobalIds = [warehouseGlobalId]
  const rawPlan = {
    warehouseGlobalIds,
    warehouseCount: warehouseGlobalIds.length,
    shipmentCount: warehouseGlobalIds.length,
    cartonCount: packages.length,
    estimatedTotalCostMinor: (
      warehouse.handlingCostMinor
      + packages.reduce((sum, item) => sum + item.estimatedCostMinor, 0)
    ),
    unusedVolumeMm3: packages.reduce((sum, item) => sum + item.unusedVolumeMm3, 0),
    packages,
  }
  const selectedPlan: FulfillmentCandidatePlanV1 = {
    planId: `plan-${canonicalOptimizerHash(rawPlan).slice(0, 20)}`,
    ...rawPlan,
  }
  const rawResult: FulfillmentOptimizationResultV1 = {
    schemaVersion: 1,
    status: 'feasible',
    method: 'deterministic_fallback',
    algorithmVersion: DETERMINISTIC_ALGORITHM_VERSION,
    inputHash,
    durationMs: 0,
    selectedPlan,
    candidates: [selectedPlan],
    rejectedAlternatives: [],
    fallbackReason,
    explanation: [{
      ...selection.explanation,
      cartonization: 'one_unit_per_carton_safe_fallback',
    }],
  }
  return parseFulfillmentOptimizationResult(
    rawResult,
    input,
    { deadlineMs: 50, maxCandidates: 1 },
    inputHash,
    'deterministic_fallback',
  )
}

function normalizedBaseUrl(value: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new OptimizerContractError('ORTOOLS_URL_INVALID')
  }
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1'
  if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) {
    throw new OptimizerContractError('ORTOOLS_TLS_REQUIRED')
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new OptimizerContractError('ORTOOLS_URL_INVALID')
  }
  return parsed.toString().replace(/\/$/, '')
}

export class OrToolsFulfillmentOptimizer implements FulfillmentOptimizerV1 {
  private readonly baseUrl: string
  private readonly secret: string
  private readonly requestTimeoutMs: number
  private readonly fetchImplementation: FetchImplementation

  constructor(config: OrToolsFulfillmentOptimizerConfig) {
    this.baseUrl = normalizedBaseUrl(config.baseUrl)
    if (Buffer.byteLength(config.secret || '', 'utf8') < 32) {
      throw new OptimizerContractError('ORTOOLS_SECRET_INVALID')
    }
    this.secret = config.secret
    this.requestTimeoutMs = safeInteger(
      config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      'ORTOOLS_TIMEOUT_INVALID',
      100,
      30_000,
    )
    this.fetchImplementation = config.fetchImplementation || fetch
  }

  async optimize(
    input: FulfillmentOptimizationInputV1,
    options: FulfillmentOptimizationOptions,
  ): Promise<FulfillmentOptimizationResultV1> {
    validateFulfillmentOptimizationInput(input)
    validateFulfillmentOptimizationOptions(options)
    const inputHash = canonicalOptimizerHash(input)
    try {
      const result = await this.call(
        '/v1/optimize',
        {
          schemaVersion: 1,
          inputHash,
          input,
          options,
        },
        Math.min(this.requestTimeoutMs, options.deadlineMs + 500),
      )
      const parsed = parseFulfillmentOptimizationResult(
        result,
        input,
        options,
        inputHash,
        'or_tools',
      )
      if (parsed.status === 'timeout' || parsed.status === 'error') {
        throw new OptimizerContractError(
          parsed.status === 'timeout' ? 'ORTOOLS_TIMEOUT' : 'ORTOOLS_ERROR',
        )
      }
      return parsed
    } catch (error) {
      return deterministicFallback(input, inputHash, serviceFailureCode(error))
    }
  }

  async optimizePackagingAssortment(
    input: PackagingAssortmentOptimizationInputV1,
    options: FulfillmentOptimizationOptions,
  ): Promise<PackagingAssortmentResultV1> {
    validatePackagingAssortmentInput(input)
    validateFulfillmentOptimizationOptions(options)
    const inputHash = canonicalOptimizerHash(input)
    try {
      const result = await this.call(
        '/v1/assortments/optimize',
        {
          schemaVersion: 1,
          inputHash,
          input,
          options,
        },
        Math.min(this.requestTimeoutMs, options.deadlineMs + 500),
      )
      const parsed = parsePackagingAssortmentResult(result, input, inputHash)
      if (parsed.status === 'timeout' || parsed.status === 'error') {
        throw new PackagingAssortmentOptimizerUnavailableError(
          parsed.status === 'timeout' ? 'ORTOOLS_TIMEOUT' : 'ORTOOLS_ERROR',
        )
      }
      return parsed
    } catch (error) {
      throw new PackagingAssortmentOptimizerUnavailableError(serviceFailureCode(error))
    }
  }

  private async call(
    path: string,
    body: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await this.fetchImplementation(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.secret}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: canonicalOptimizerJson(body),
        cache: 'no-store',
        redirect: 'error',
        signal: controller.signal,
      })
      if (!response.ok) throw new OptimizerContractError('ORTOOLS_HTTP_ERROR')
      const responseText = await response.text()
      assertOptimizerResponseSize(responseText)
      if (!/^application\/json\b/i.test(response.headers.get('content-type') || '')) {
        throw new OptimizerContractError('ORTOOLS_CONTENT_TYPE_INVALID')
      }
      try {
        return JSON.parse(responseText)
      } catch {
        throw new OptimizerContractError('ORTOOLS_JSON_INVALID')
      }
    } finally {
      clearTimeout(timeout)
    }
  }
}

export function configuredOrToolsFulfillmentOptimizer(
  fetchImplementation?: FetchImplementation,
): OrToolsFulfillmentOptimizer | null {
  if (process.env.CLAWPILOT_FULFILLMENT_OPTIMIZER_ENABLED !== '1') return null
  const baseUrl = String(process.env.CLAWPILOT_FULFILLMENT_OPTIMIZER_URL || '').trim()
  const secret = String(process.env.CLAWPILOT_FULFILLMENT_OPTIMIZER_SECRET || '')
  const timeoutValue = Number(
    process.env.CLAWPILOT_FULFILLMENT_OPTIMIZER_TIMEOUT_MS || DEFAULT_REQUEST_TIMEOUT_MS,
  )
  return new OrToolsFulfillmentOptimizer({
    baseUrl,
    secret,
    requestTimeoutMs: timeoutValue,
    fetchImplementation,
  })
}
