import { createHash } from 'node:crypto'

export const FULFILLMENT_OPTIMIZER_SCHEMA_VERSION = 1 as const
export const FULFILLMENT_OBJECTIVE_SEQUENCE = [
  'minimize_warehouses',
  'minimize_shipments_and_cartons',
  'minimize_estimated_total_cost_minor',
  'minimize_unused_volume_mm3',
  'stable_global_id_ties',
] as const
export const ASSORTMENT_OBJECTIVE_SEQUENCE = [
  'minimize_weighted_landed_cost_minor',
  'minimize_material_sku_count',
  'minimize_weighted_waste_volume_mm3',
  'stable_global_id_ties',
] as const

const MAX_SAFE_MINOR = 1_000_000_000_000
const MAX_RESPONSE_BYTES = 1_048_576
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9._:#-]{0,127}$/

export type OptimizerDimensionsMm = {
  length: number
  width: number
  height: number
}

export type FulfillmentOrderLineRequirement = {
  lineGlobalId: string
  productGlobalId: string
  quantity: number
  unitWeightGrams: number
  unitDimensionsMm: OptimizerDimensionsMm
  rotationAllowed: boolean
  allowedWarehouseGlobalIds: readonly string[]
  allowedCartonGlobalIds: readonly string[]
}

export type FulfillmentInventoryCandidate = {
  positionGlobalId: string
  warehouseGlobalId: string
  productGlobalId: string
  availableQuantity: number
  unitHandlingCostMinor: number
}

export type FulfillmentWarehouseCandidate = {
  warehouseGlobalId: string
  active: boolean
  handlingCostMinor: number
}

export type FulfillmentCartonCandidate = {
  cartonGlobalId: string
  warehouseGlobalId: string
  materialType: 'box' | 'poly_mailer'
  innerDimensionsMm: OptimizerDimensionsMm
  maxWeightGrams: number
  emptyWeightGrams: number
  availableQuantity: number
  materialCostMinor: number
  estimatedTransportCostMinor: number
}

export type FulfillmentOptimizationInputV1 = {
  schemaVersion: 1
  inputSnapshotGlobalId: string
  organizationGlobalId: string
  orderGlobalId: string
  orderRevision: number
  evaluatedAtUtc: string
  currency: string
  lines: readonly FulfillmentOrderLineRequirement[]
  eligiblePositions: readonly FulfillmentInventoryCandidate[]
  warehouses: readonly FulfillmentWarehouseCandidate[]
  cartons: readonly FulfillmentCartonCandidate[]
  constraints: {
    schemaVersion: 1
    maxPackages: number
    maxPackageWeightGrams: number | null
    allowedWarehouseGlobalIds: readonly string[]
    allowedCartonGlobalIds: readonly string[]
  }
  objectivePolicy: {
    schemaVersion: 1
    policyGlobalId: string
    sequence: typeof FULFILLMENT_OBJECTIVE_SEQUENCE
  }
  splitPolicy: {
    allowed: boolean
    maxWarehouses: number
  }
}

export type FulfillmentOptimizationOptions = {
  deadlineMs: number
  maxCandidates: number
}

export type FulfillmentPlacement = {
  unitKey: string
  lineGlobalId: string
  productGlobalId: string
  positionGlobalId: string
  dimensionsMm: OptimizerDimensionsMm
  coordinatesMm: { x: number; y: number; z: number }
}

export type FulfillmentPackageAllocation = {
  lineGlobalId: string
  productGlobalId: string
  positionGlobalId: string
  quantity: number
}

export type FulfillmentPackagePlan = {
  packageKey: string
  warehouseGlobalId: string
  cartonGlobalId: string
  innerDimensionsMm: OptimizerDimensionsMm
  maxWeightGrams: number
  emptyWeightGrams: number
  totalWeightGrams: number
  usedVolumeMm3: number
  unusedVolumeMm3: number
  estimatedCostMinor: number
  allocations: readonly FulfillmentPackageAllocation[]
  placements: readonly FulfillmentPlacement[]
}

export type FulfillmentCandidatePlanV1 = {
  planId: string
  warehouseGlobalIds: readonly string[]
  warehouseCount: number
  shipmentCount: number
  cartonCount: number
  estimatedTotalCostMinor: number
  unusedVolumeMm3: number
  packages: readonly FulfillmentPackagePlan[]
}

export type FulfillmentOptimizationResultV1 = {
  schemaVersion: 1
  status: 'optimal' | 'feasible' | 'infeasible' | 'timeout' | 'error'
  method: 'or_tools' | 'deterministic_fallback'
  algorithmVersion: string
  inputHash: string
  durationMs: number
  selectedPlan: FulfillmentCandidatePlanV1 | null
  candidates: readonly FulfillmentCandidatePlanV1[]
  rejectedAlternatives: readonly Record<string, unknown>[]
  fallbackReason: string | null
  explanation: readonly Record<string, unknown>[]
}

export interface FulfillmentOptimizerV1 {
  optimize(
    input: FulfillmentOptimizationInputV1,
    options: FulfillmentOptimizationOptions,
  ): Promise<FulfillmentOptimizationResultV1>
}

export type PackagingMaterialCandidate = {
  materialGlobalId: string
  materialType: 'box' | 'poly_mailer'
  innerDimensionsMm: OptimizerDimensionsMm
  maxWeightGrams: number
  materialCostMinor: number
}

export type HistoricalPackagingDemandSample = {
  sampleGlobalId: string
  frequency: number
  packedWeightGrams: number
  packedVolumeMm3: number
}

export type FeasiblePackagingLandedCost = {
  sampleGlobalId: string
  materialGlobalId: string
  landedCostMinor: number
  wasteVolumeMm3: number
}

export type PackagingAssortmentOptimizationInputV1 = {
  schemaVersion: 1
  inputSnapshotGlobalId: string
  organizationGlobalId: string
  evaluatedAtUtc: string
  currency: string
  materials: readonly PackagingMaterialCandidate[]
  demandSamples: readonly HistoricalPackagingDemandSample[]
  feasibleLandedCosts: readonly FeasiblePackagingLandedCost[]
  policy: {
    schemaVersion: 1
    policyGlobalId: string
    maxAssortmentSize: number
    hardCoverAll: boolean
    minimumCoverageBasisPoints: number
  }
  objectivePolicy: {
    schemaVersion: 1
    policyGlobalId: string
    sequence: typeof ASSORTMENT_OBJECTIVE_SEQUENCE
  }
}

export type PackagingAssortmentResultV1 = {
  schemaVersion: 1
  status: 'optimal' | 'feasible' | 'infeasible' | 'timeout' | 'error'
  method: 'or_tools'
  algorithmVersion: string
  inputHash: string
  durationMs: number
  selectedAssortment: {
    selectedMaterialGlobalIds: readonly string[]
    assignments: ReadonlyArray<{
      sampleGlobalId: string
      materialGlobalId: string
      frequency: number
      landedCostMinor: number
      wasteVolumeMm3: number
    }>
    uncoveredSampleGlobalIds: readonly string[]
    coveredFrequency: number
    totalFrequency: number
    coverageBasisPoints: number
    weightedLandedCostMinor: number
    weightedWasteVolumeMm3: number
  } | null
  fallbackReason: null
  explanation: readonly Record<string, unknown>[]
}

export class OptimizerContractError extends Error {
  readonly code: string

  constructor(code: string, message = code) {
    super(message)
    this.name = 'OptimizerContractError'
    this.code = code
  }
}

function fail(code: string, message?: string): never {
  throw new OptimizerContractError(code, message)
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code)
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], code: string): void {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((item, index) => item !== expected[index])) {
    fail(code)
  }
}

function identifier(value: unknown, code: string): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) fail(code)
  return value
}

function stringValue(value: unknown, code: string, maximum = 256): string {
  if (typeof value !== 'string' || !value || value.length > maximum) fail(code)
  return value
}

function integer(
  value: unknown,
  code: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) fail(code)
  return Number(value)
}

function booleanValue(value: unknown, code: string): boolean {
  if (typeof value !== 'boolean') fail(code)
  return value
}

function array(value: unknown, code: string, maximum = 10_000): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) fail(code)
  return value
}

function unique(values: readonly string[], code: string): void {
  if (new Set(values).size !== values.length) fail(code)
}

function dimensions(value: unknown, code: string): OptimizerDimensionsMm {
  const source = record(value, code)
  exactKeys(source, ['length', 'width', 'height'], code)
  return {
    length: integer(source.length, code, 1, 2_000_000),
    width: integer(source.width, code, 1, 2_000_000),
    height: integer(source.height, code, 1, 2_000_000),
  }
}

function dimensionsVolume(value: OptimizerDimensionsMm): number {
  const result = value.length * value.width * value.height
  if (!Number.isSafeInteger(result) || result > 1_000_000_000_000_000) {
    fail('OPTIMIZER_DIMENSIONS_VOLUME_INVALID')
  }
  return result
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) fail('OPTIMIZER_CANONICAL_INTEGER_REQUIRED')
    return value
  }
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key]
      if (item === undefined) fail('OPTIMIZER_CANONICAL_UNDEFINED_FORBIDDEN')
      result[key] = canonicalValue(item)
    }
    return result
  }
  fail('OPTIMIZER_CANONICAL_VALUE_INVALID')
}

export function canonicalOptimizerJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value))
}

export function canonicalOptimizerHash(value: unknown): string {
  return createHash('sha256').update(canonicalOptimizerJson(value)).digest('hex')
}

export function validateFulfillmentOptimizationOptions(
  options: FulfillmentOptimizationOptions,
): void {
  const source = record(options, 'OPTIMIZER_OPTIONS_INVALID')
  exactKeys(source, ['deadlineMs', 'maxCandidates'], 'OPTIMIZER_OPTIONS_INVALID')
  integer(source.deadlineMs, 'OPTIMIZER_DEADLINE_INVALID', 50, 30_000)
  integer(source.maxCandidates, 'OPTIMIZER_MAX_CANDIDATES_INVALID', 1, 16)
}

export function validateFulfillmentOptimizationInput(
  input: FulfillmentOptimizationInputV1,
): void {
  const source = record(input, 'OPTIMIZER_INPUT_INVALID')
  exactKeys(source, [
    'schemaVersion',
    'inputSnapshotGlobalId',
    'organizationGlobalId',
    'orderGlobalId',
    'orderRevision',
    'evaluatedAtUtc',
    'currency',
    'lines',
    'eligiblePositions',
    'warehouses',
    'cartons',
    'constraints',
    'objectivePolicy',
    'splitPolicy',
  ], 'OPTIMIZER_INPUT_INVALID')
  if (source.schemaVersion !== 1) fail('OPTIMIZER_SCHEMA_VERSION_UNSUPPORTED')
  identifier(source.inputSnapshotGlobalId, 'OPTIMIZER_INPUT_SNAPSHOT_INVALID')
  identifier(source.organizationGlobalId, 'OPTIMIZER_ORGANIZATION_INVALID')
  identifier(source.orderGlobalId, 'OPTIMIZER_ORDER_INVALID')
  integer(source.orderRevision, 'OPTIMIZER_ORDER_REVISION_INVALID', 1)
  const evaluatedAt = stringValue(source.evaluatedAtUtc, 'OPTIMIZER_EVALUATED_AT_INVALID')
  if (!Number.isFinite(Date.parse(evaluatedAt)) || !/(?:Z|[+-]\d\d:\d\d)$/.test(evaluatedAt)) {
    fail('OPTIMIZER_EVALUATED_AT_INVALID')
  }
  if (typeof source.currency !== 'string' || !/^[A-Z]{3}$/.test(source.currency)) {
    fail('OPTIMIZER_CURRENCY_INVALID')
  }

  const warehouseIds: string[] = []
  for (const item of array(source.warehouses, 'OPTIMIZER_WAREHOUSES_INVALID', 16)) {
    const candidate = record(item, 'OPTIMIZER_WAREHOUSE_INVALID')
    exactKeys(candidate, ['warehouseGlobalId', 'active', 'handlingCostMinor'], 'OPTIMIZER_WAREHOUSE_INVALID')
    warehouseIds.push(identifier(candidate.warehouseGlobalId, 'OPTIMIZER_WAREHOUSE_INVALID'))
    booleanValue(candidate.active, 'OPTIMIZER_WAREHOUSE_INVALID')
    integer(candidate.handlingCostMinor, 'OPTIMIZER_WAREHOUSE_COST_INVALID', 0, MAX_SAFE_MINOR)
  }
  unique(warehouseIds, 'OPTIMIZER_WAREHOUSE_DUPLICATE')
  const warehouseSet = new Set(warehouseIds)

  const cartonIds: string[] = []
  for (const item of array(source.cartons, 'OPTIMIZER_CARTONS_INVALID', 64)) {
    const carton = record(item, 'OPTIMIZER_CARTON_INVALID')
    exactKeys(carton, [
      'cartonGlobalId',
      'warehouseGlobalId',
      'materialType',
      'innerDimensionsMm',
      'maxWeightGrams',
      'emptyWeightGrams',
      'availableQuantity',
      'materialCostMinor',
      'estimatedTransportCostMinor',
    ], 'OPTIMIZER_CARTON_INVALID')
    cartonIds.push(identifier(carton.cartonGlobalId, 'OPTIMIZER_CARTON_INVALID'))
    const warehouseGlobalId = identifier(carton.warehouseGlobalId, 'OPTIMIZER_CARTON_WAREHOUSE_INVALID')
    if (!warehouseSet.has(warehouseGlobalId)) fail('OPTIMIZER_CARTON_WAREHOUSE_INVALID')
    if (carton.materialType !== 'box' && carton.materialType !== 'poly_mailer') {
      fail('OPTIMIZER_CARTON_MATERIAL_TYPE_INVALID')
    }
    dimensionsVolume(dimensions(carton.innerDimensionsMm, 'OPTIMIZER_CARTON_DIMENSIONS_INVALID'))
    integer(carton.maxWeightGrams, 'OPTIMIZER_CARTON_WEIGHT_INVALID', 1)
    integer(carton.emptyWeightGrams, 'OPTIMIZER_CARTON_WEIGHT_INVALID')
    integer(carton.availableQuantity, 'OPTIMIZER_CARTON_AVAILABILITY_INVALID', 1)
    integer(carton.materialCostMinor, 'OPTIMIZER_CARTON_COST_INVALID', 0, MAX_SAFE_MINOR)
    integer(carton.estimatedTransportCostMinor, 'OPTIMIZER_CARTON_COST_INVALID', 0, MAX_SAFE_MINOR)
  }
  unique(cartonIds, 'OPTIMIZER_CARTON_DUPLICATE')
  const cartonSet = new Set(cartonIds)

  const lines = array(source.lines, 'OPTIMIZER_LINES_INVALID', 100)
  if (!lines.length) fail('OPTIMIZER_LINES_REQUIRED')
  const lineIds: string[] = []
  const productIds = new Set<string>()
  let unitCount = 0
  for (const item of lines) {
    const line = record(item, 'OPTIMIZER_LINE_INVALID')
    exactKeys(line, [
      'lineGlobalId',
      'productGlobalId',
      'quantity',
      'unitWeightGrams',
      'unitDimensionsMm',
      'rotationAllowed',
      'allowedWarehouseGlobalIds',
      'allowedCartonGlobalIds',
    ], 'OPTIMIZER_LINE_INVALID')
    lineIds.push(identifier(line.lineGlobalId, 'OPTIMIZER_LINE_INVALID'))
    productIds.add(identifier(line.productGlobalId, 'OPTIMIZER_PRODUCT_INVALID'))
    unitCount += integer(line.quantity, 'OPTIMIZER_LINE_QUANTITY_INVALID', 1)
    integer(line.unitWeightGrams, 'OPTIMIZER_LINE_WEIGHT_INVALID', 1)
    dimensionsVolume(dimensions(line.unitDimensionsMm, 'OPTIMIZER_LINE_DIMENSIONS_INVALID'))
    booleanValue(line.rotationAllowed, 'OPTIMIZER_LINE_ROTATION_INVALID')
    const allowedWarehouses = array(
      line.allowedWarehouseGlobalIds,
      'OPTIMIZER_LINE_WAREHOUSE_INVALID',
      16,
    ).map((value) => identifier(value, 'OPTIMIZER_LINE_WAREHOUSE_INVALID'))
    const allowedCartons = array(
      line.allowedCartonGlobalIds,
      'OPTIMIZER_LINE_CARTON_INVALID',
      64,
    ).map((value) => identifier(value, 'OPTIMIZER_LINE_CARTON_INVALID'))
    unique(allowedWarehouses, 'OPTIMIZER_LINE_WAREHOUSE_DUPLICATE')
    unique(allowedCartons, 'OPTIMIZER_LINE_CARTON_DUPLICATE')
    if (allowedWarehouses.some((value) => !warehouseSet.has(value))) {
      fail('OPTIMIZER_LINE_WAREHOUSE_INVALID')
    }
    if (allowedCartons.some((value) => !cartonSet.has(value))) {
      fail('OPTIMIZER_LINE_CARTON_INVALID')
    }
  }
  unique(lineIds, 'OPTIMIZER_LINE_DUPLICATE')
  if (unitCount > 80) fail('OPTIMIZER_UNIT_BOUND_EXCEEDED')

  const positionIds: string[] = []
  for (const item of array(source.eligiblePositions, 'OPTIMIZER_POSITIONS_INVALID', 256)) {
    const position = record(item, 'OPTIMIZER_POSITION_INVALID')
    exactKeys(position, [
      'positionGlobalId',
      'warehouseGlobalId',
      'productGlobalId',
      'availableQuantity',
      'unitHandlingCostMinor',
    ], 'OPTIMIZER_POSITION_INVALID')
    positionIds.push(identifier(position.positionGlobalId, 'OPTIMIZER_POSITION_INVALID'))
    const warehouseGlobalId = identifier(position.warehouseGlobalId, 'OPTIMIZER_POSITION_WAREHOUSE_INVALID')
    const productGlobalId = identifier(position.productGlobalId, 'OPTIMIZER_POSITION_PRODUCT_INVALID')
    if (!warehouseSet.has(warehouseGlobalId)) fail('OPTIMIZER_POSITION_WAREHOUSE_INVALID')
    if (!productIds.has(productGlobalId)) fail('OPTIMIZER_POSITION_PRODUCT_INVALID')
    integer(position.availableQuantity, 'OPTIMIZER_POSITION_QUANTITY_INVALID')
    integer(position.unitHandlingCostMinor, 'OPTIMIZER_POSITION_COST_INVALID', 0, MAX_SAFE_MINOR)
  }
  unique(positionIds, 'OPTIMIZER_POSITION_DUPLICATE')

  const constraints = record(source.constraints, 'OPTIMIZER_CONSTRAINTS_INVALID')
  exactKeys(constraints, [
    'schemaVersion',
    'maxPackages',
    'maxPackageWeightGrams',
    'allowedWarehouseGlobalIds',
    'allowedCartonGlobalIds',
  ], 'OPTIMIZER_CONSTRAINTS_INVALID')
  if (constraints.schemaVersion !== 1) fail('OPTIMIZER_CONSTRAINTS_VERSION_UNSUPPORTED')
  integer(constraints.maxPackages, 'OPTIMIZER_MAX_PACKAGES_INVALID', 1, 64)
  if (constraints.maxPackageWeightGrams !== null) {
    integer(constraints.maxPackageWeightGrams, 'OPTIMIZER_MAX_PACKAGE_WEIGHT_INVALID', 1)
  }
  const allowedWarehouses = array(
    constraints.allowedWarehouseGlobalIds,
    'OPTIMIZER_ALLOWED_WAREHOUSES_INVALID',
    16,
  ).map((value) => identifier(value, 'OPTIMIZER_ALLOWED_WAREHOUSES_INVALID'))
  const allowedCartons = array(
    constraints.allowedCartonGlobalIds,
    'OPTIMIZER_ALLOWED_CARTONS_INVALID',
    64,
  ).map((value) => identifier(value, 'OPTIMIZER_ALLOWED_CARTONS_INVALID'))
  unique(allowedWarehouses, 'OPTIMIZER_ALLOWED_WAREHOUSE_DUPLICATE')
  unique(allowedCartons, 'OPTIMIZER_ALLOWED_CARTON_DUPLICATE')
  if (allowedWarehouses.some((value) => !warehouseSet.has(value))) {
    fail('OPTIMIZER_ALLOWED_WAREHOUSES_INVALID')
  }
  if (allowedCartons.some((value) => !cartonSet.has(value))) {
    fail('OPTIMIZER_ALLOWED_CARTONS_INVALID')
  }

  const policy = record(source.objectivePolicy, 'OPTIMIZER_OBJECTIVE_POLICY_INVALID')
  exactKeys(policy, ['schemaVersion', 'policyGlobalId', 'sequence'], 'OPTIMIZER_OBJECTIVE_POLICY_INVALID')
  if (policy.schemaVersion !== 1) fail('OPTIMIZER_OBJECTIVE_VERSION_UNSUPPORTED')
  identifier(policy.policyGlobalId, 'OPTIMIZER_OBJECTIVE_POLICY_INVALID')
  const sequence = array(policy.sequence, 'OPTIMIZER_OBJECTIVE_POLICY_INVALID', 5)
  if (
    sequence.length !== FULFILLMENT_OBJECTIVE_SEQUENCE.length
    || sequence.some((value, index) => value !== FULFILLMENT_OBJECTIVE_SEQUENCE[index])
  ) {
    fail('OPTIMIZER_OBJECTIVE_POLICY_UNSUPPORTED')
  }

  const split = record(source.splitPolicy, 'OPTIMIZER_SPLIT_POLICY_INVALID')
  exactKeys(split, ['allowed', 'maxWarehouses'], 'OPTIMIZER_SPLIT_POLICY_INVALID')
  const splitAllowed = booleanValue(split.allowed, 'OPTIMIZER_SPLIT_POLICY_INVALID')
  const maxWarehouses = integer(split.maxWarehouses, 'OPTIMIZER_SPLIT_POLICY_INVALID', 1, 16)
  if (!splitAllowed && maxWarehouses !== 1) fail('OPTIMIZER_SPLIT_POLICY_INVALID')
  if (warehouseIds.length === 1 && maxWarehouses !== 1) {
    fail('OPTIMIZER_SINGLE_WAREHOUSE_SPLIT_INVALID')
  }
}

function rotations(value: OptimizerDimensionsMm, allowed: boolean): OptimizerDimensionsMm[] {
  const tuples = allowed
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
  return tuples.flatMap(([length, width, height]) => {
    const key = `${length}:${width}:${height}`
    if (seen.has(key)) return []
    seen.add(key)
    return [{ length, width, height }]
  })
}

function sameDimensions(left: OptimizerDimensionsMm, right: OptimizerDimensionsMm): boolean {
  return left.length === right.length && left.width === right.width && left.height === right.height
}

function overlap(
  left: FulfillmentPlacement,
  right: FulfillmentPlacement,
): boolean {
  return !(
    left.coordinatesMm.x + left.dimensionsMm.length <= right.coordinatesMm.x
    || right.coordinatesMm.x + right.dimensionsMm.length <= left.coordinatesMm.x
    || left.coordinatesMm.y + left.dimensionsMm.width <= right.coordinatesMm.y
    || right.coordinatesMm.y + right.dimensionsMm.width <= left.coordinatesMm.y
    || left.coordinatesMm.z + left.dimensionsMm.height <= right.coordinatesMm.z
    || right.coordinatesMm.z + right.dimensionsMm.height <= left.coordinatesMm.z
  )
}

function parsePlacement(value: unknown): FulfillmentPlacement {
  const source = record(value, 'OPTIMIZER_RESULT_PLACEMENT_INVALID')
  exactKeys(source, [
    'unitKey',
    'lineGlobalId',
    'productGlobalId',
    'positionGlobalId',
    'dimensionsMm',
    'coordinatesMm',
  ], 'OPTIMIZER_RESULT_PLACEMENT_INVALID')
  const coordinates = record(source.coordinatesMm, 'OPTIMIZER_RESULT_COORDINATES_INVALID')
  exactKeys(coordinates, ['x', 'y', 'z'], 'OPTIMIZER_RESULT_COORDINATES_INVALID')
  return {
    unitKey: identifier(source.unitKey, 'OPTIMIZER_RESULT_UNIT_KEY_INVALID'),
    lineGlobalId: identifier(source.lineGlobalId, 'OPTIMIZER_RESULT_LINE_INVALID'),
    productGlobalId: identifier(source.productGlobalId, 'OPTIMIZER_RESULT_PRODUCT_INVALID'),
    positionGlobalId: identifier(source.positionGlobalId, 'OPTIMIZER_RESULT_POSITION_INVALID'),
    dimensionsMm: dimensions(source.dimensionsMm, 'OPTIMIZER_RESULT_DIMENSIONS_INVALID'),
    coordinatesMm: {
      x: integer(coordinates.x, 'OPTIMIZER_RESULT_COORDINATES_INVALID'),
      y: integer(coordinates.y, 'OPTIMIZER_RESULT_COORDINATES_INVALID'),
      z: integer(coordinates.z, 'OPTIMIZER_RESULT_COORDINATES_INVALID'),
    },
  }
}

function parseAllocation(value: unknown): FulfillmentPackageAllocation {
  const source = record(value, 'OPTIMIZER_RESULT_ALLOCATION_INVALID')
  exactKeys(source, [
    'lineGlobalId',
    'productGlobalId',
    'positionGlobalId',
    'quantity',
  ], 'OPTIMIZER_RESULT_ALLOCATION_INVALID')
  return {
    lineGlobalId: identifier(source.lineGlobalId, 'OPTIMIZER_RESULT_LINE_INVALID'),
    productGlobalId: identifier(source.productGlobalId, 'OPTIMIZER_RESULT_PRODUCT_INVALID'),
    positionGlobalId: identifier(source.positionGlobalId, 'OPTIMIZER_RESULT_POSITION_INVALID'),
    quantity: integer(source.quantity, 'OPTIMIZER_RESULT_QUANTITY_INVALID', 1),
  }
}

function validateCandidatePlan(
  value: unknown,
  input: FulfillmentOptimizationInputV1,
): FulfillmentCandidatePlanV1 {
  const source = record(value, 'OPTIMIZER_RESULT_PLAN_INVALID')
  exactKeys(source, [
    'planId',
    'warehouseGlobalIds',
    'warehouseCount',
    'shipmentCount',
    'cartonCount',
    'estimatedTotalCostMinor',
    'unusedVolumeMm3',
    'packages',
  ], 'OPTIMIZER_RESULT_PLAN_INVALID')
  const planId = identifier(source.planId, 'OPTIMIZER_RESULT_PLAN_ID_INVALID')
  const warehouses = input.warehouses.filter((item) => item.active)
  const warehouseById = new Map(warehouses.map((item) => [item.warehouseGlobalId, item]))
  const cartonById = new Map(input.cartons.map((item) => [item.cartonGlobalId, item]))
  const lineById = new Map(input.lines.map((item) => [item.lineGlobalId, item]))
  const positionById = new Map(input.eligiblePositions.map((item) => [item.positionGlobalId, item]))
  const selectedWarehouseIds = array(
    source.warehouseGlobalIds,
    'OPTIMIZER_RESULT_WAREHOUSES_INVALID',
    16,
  ).map((item) => identifier(item, 'OPTIMIZER_RESULT_WAREHOUSES_INVALID'))
  unique(selectedWarehouseIds, 'OPTIMIZER_RESULT_WAREHOUSE_DUPLICATE')
  if (canonicalOptimizerJson(selectedWarehouseIds) !== canonicalOptimizerJson([...selectedWarehouseIds].sort())) {
    fail('OPTIMIZER_RESULT_WAREHOUSE_ORDER_INVALID')
  }
  if (selectedWarehouseIds.some((item) => !warehouseById.has(item))) {
    fail('OPTIMIZER_RESULT_WAREHOUSE_UNKNOWN')
  }
  if (
    input.constraints.allowedWarehouseGlobalIds.length
    && selectedWarehouseIds.some((item) => !input.constraints.allowedWarehouseGlobalIds.includes(item))
  ) {
    fail('OPTIMIZER_RESULT_WAREHOUSE_FORBIDDEN')
  }
  if (!input.splitPolicy.allowed && selectedWarehouseIds.length > 1) {
    fail('OPTIMIZER_RESULT_SPLIT_FORBIDDEN')
  }
  if (selectedWarehouseIds.length > input.splitPolicy.maxWarehouses) {
    fail('OPTIMIZER_RESULT_SPLIT_LIMIT_EXCEEDED')
  }
  if (input.warehouses.length === 1 && selectedWarehouseIds.some(
    (item) => item !== input.warehouses[0].warehouseGlobalId
  )) {
    fail('OPTIMIZER_RESULT_WAREHOUSE_INVENTED')
  }

  const packages = array(source.packages, 'OPTIMIZER_RESULT_PACKAGES_INVALID', 64)
    .map((item) => {
      const itemSource = record(item, 'OPTIMIZER_RESULT_PACKAGE_INVALID')
      exactKeys(itemSource, [
        'packageKey',
        'warehouseGlobalId',
        'cartonGlobalId',
        'innerDimensionsMm',
        'maxWeightGrams',
        'emptyWeightGrams',
        'totalWeightGrams',
        'usedVolumeMm3',
        'unusedVolumeMm3',
        'estimatedCostMinor',
        'allocations',
        'placements',
      ], 'OPTIMIZER_RESULT_PACKAGE_INVALID')
      return {
        packageKey: identifier(itemSource.packageKey, 'OPTIMIZER_RESULT_PACKAGE_KEY_INVALID'),
        warehouseGlobalId: identifier(
          itemSource.warehouseGlobalId,
          'OPTIMIZER_RESULT_PACKAGE_WAREHOUSE_INVALID',
        ),
        cartonGlobalId: identifier(itemSource.cartonGlobalId, 'OPTIMIZER_RESULT_CARTON_INVALID'),
        innerDimensionsMm: dimensions(
          itemSource.innerDimensionsMm,
          'OPTIMIZER_RESULT_CARTON_DIMENSIONS_INVALID',
        ),
        maxWeightGrams: integer(itemSource.maxWeightGrams, 'OPTIMIZER_RESULT_PACKAGE_WEIGHT_INVALID', 1),
        emptyWeightGrams: integer(itemSource.emptyWeightGrams, 'OPTIMIZER_RESULT_PACKAGE_WEIGHT_INVALID'),
        totalWeightGrams: integer(itemSource.totalWeightGrams, 'OPTIMIZER_RESULT_PACKAGE_WEIGHT_INVALID', 1),
        usedVolumeMm3: integer(itemSource.usedVolumeMm3, 'OPTIMIZER_RESULT_PACKAGE_VOLUME_INVALID'),
        unusedVolumeMm3: integer(itemSource.unusedVolumeMm3, 'OPTIMIZER_RESULT_PACKAGE_VOLUME_INVALID'),
        estimatedCostMinor: integer(
          itemSource.estimatedCostMinor,
          'OPTIMIZER_RESULT_PACKAGE_COST_INVALID',
          0,
          MAX_SAFE_MINOR,
        ),
        allocations: array(
          itemSource.allocations,
          'OPTIMIZER_RESULT_ALLOCATIONS_INVALID',
          256,
        ).map(parseAllocation),
        placements: array(
          itemSource.placements,
          'OPTIMIZER_RESULT_PLACEMENTS_INVALID',
          80,
        ).map(parsePlacement),
      } satisfies FulfillmentPackagePlan
    })
  unique(packages.map((item) => item.packageKey), 'OPTIMIZER_RESULT_PACKAGE_DUPLICATE')
  if (packages.length > input.constraints.maxPackages) fail('OPTIMIZER_RESULT_PACKAGE_LIMIT_EXCEEDED')

  const cartonCounts = new Map<string, number>()
  const lineCounts = new Map<string, number>()
  const positionCounts = new Map<string, number>()
  const unitKeys: string[] = []
  let computedUnusedVolume = 0
  let computedCost = 0
  for (const packagePlan of packages) {
    if (
      !selectedWarehouseIds.includes(packagePlan.warehouseGlobalId)
      || !warehouseById.has(packagePlan.warehouseGlobalId)
    ) {
      fail('OPTIMIZER_RESULT_PACKAGE_WAREHOUSE_INVALID')
    }
    const carton = cartonById.get(packagePlan.cartonGlobalId)
    if (!carton || carton.warehouseGlobalId !== packagePlan.warehouseGlobalId) {
      fail('OPTIMIZER_RESULT_CARTON_INVALID')
    }
    if (
      input.constraints.allowedCartonGlobalIds.length
      && !input.constraints.allowedCartonGlobalIds.includes(carton.cartonGlobalId)
    ) {
      fail('OPTIMIZER_RESULT_CARTON_FORBIDDEN')
    }
    if (!sameDimensions(packagePlan.innerDimensionsMm, carton.innerDimensionsMm)) {
      fail('OPTIMIZER_RESULT_CARTON_DIMENSIONS_MISMATCH')
    }
    const expectedMaxWeight = input.constraints.maxPackageWeightGrams === null
      ? carton.maxWeightGrams
      : Math.min(carton.maxWeightGrams, input.constraints.maxPackageWeightGrams)
    if (
      packagePlan.maxWeightGrams !== expectedMaxWeight
      || packagePlan.emptyWeightGrams !== carton.emptyWeightGrams
    ) {
      fail('OPTIMIZER_RESULT_CARTON_WEIGHT_MISMATCH')
    }
    cartonCounts.set(carton.cartonGlobalId, (cartonCounts.get(carton.cartonGlobalId) || 0) + 1)
    let itemWeight = 0
    let usedVolume = 0
    let positionCost = 0
    const placementAllocations = new Map<string, number>()
    for (const placement of packagePlan.placements) {
      unitKeys.push(placement.unitKey)
      const line = lineById.get(placement.lineGlobalId)
      const position = positionById.get(placement.positionGlobalId)
      if (
        !line
        || placement.productGlobalId !== line.productGlobalId
        || !position
        || position.productGlobalId !== line.productGlobalId
        || position.warehouseGlobalId !== packagePlan.warehouseGlobalId
      ) {
        fail('OPTIMIZER_RESULT_PLACEMENT_REFERENCE_INVALID')
      }
      if (
        line.allowedWarehouseGlobalIds.length
        && !line.allowedWarehouseGlobalIds.includes(packagePlan.warehouseGlobalId)
      ) {
        fail('OPTIMIZER_RESULT_PLACEMENT_WAREHOUSE_FORBIDDEN')
      }
      if (
        line.allowedCartonGlobalIds.length
        && !line.allowedCartonGlobalIds.includes(packagePlan.cartonGlobalId)
      ) {
        fail('OPTIMIZER_RESULT_PLACEMENT_CARTON_FORBIDDEN')
      }
      if (!rotations(line.unitDimensionsMm, line.rotationAllowed).some(
        (item) => sameDimensions(item, placement.dimensionsMm),
      )) {
        fail('OPTIMIZER_RESULT_ROTATION_INVALID')
      }
      if (
        placement.coordinatesMm.x + placement.dimensionsMm.length > carton.innerDimensionsMm.length
        || placement.coordinatesMm.y + placement.dimensionsMm.width > carton.innerDimensionsMm.width
        || placement.coordinatesMm.z + placement.dimensionsMm.height > carton.innerDimensionsMm.height
      ) {
        fail('OPTIMIZER_RESULT_PLACEMENT_OUT_OF_BOUNDS')
      }
      itemWeight += line.unitWeightGrams
      usedVolume += dimensionsVolume(line.unitDimensionsMm)
      positionCost += position.unitHandlingCostMinor
      lineCounts.set(line.lineGlobalId, (lineCounts.get(line.lineGlobalId) || 0) + 1)
      positionCounts.set(position.positionGlobalId, (positionCounts.get(position.positionGlobalId) || 0) + 1)
      const key = `${line.lineGlobalId}:${line.productGlobalId}:${position.positionGlobalId}`
      placementAllocations.set(key, (placementAllocations.get(key) || 0) + 1)
    }
    for (let left = 0; left < packagePlan.placements.length; left += 1) {
      for (let right = left + 1; right < packagePlan.placements.length; right += 1) {
        if (overlap(packagePlan.placements[left], packagePlan.placements[right])) {
          fail('OPTIMIZER_RESULT_PLACEMENT_OVERLAP')
        }
      }
    }
    const declaredAllocations = new Map(packagePlan.allocations.map((item) => [
      `${item.lineGlobalId}:${item.productGlobalId}:${item.positionGlobalId}`,
      item.quantity,
    ]))
    if (
      declaredAllocations.size !== packagePlan.allocations.length
      || canonicalOptimizerJson([...declaredAllocations.entries()].sort())
        !== canonicalOptimizerJson([...placementAllocations.entries()].sort())
    ) {
      fail('OPTIMIZER_RESULT_ALLOCATION_MISMATCH')
    }
    const cartonVolume = dimensionsVolume(carton.innerDimensionsMm)
    const expectedUnused = cartonVolume - usedVolume
    const expectedWeight = carton.emptyWeightGrams + itemWeight
    const expectedPackageCost = (
      carton.materialCostMinor
      + carton.estimatedTransportCostMinor
      + positionCost
    )
    if (
      expectedUnused < 0
      || packagePlan.usedVolumeMm3 !== usedVolume
      || packagePlan.unusedVolumeMm3 !== expectedUnused
      || packagePlan.totalWeightGrams !== expectedWeight
      || packagePlan.totalWeightGrams > packagePlan.maxWeightGrams
      || packagePlan.estimatedCostMinor !== expectedPackageCost
    ) {
      fail('OPTIMIZER_RESULT_PACKAGE_TOTAL_INVALID')
    }
    computedUnusedVolume += expectedUnused
    computedCost += expectedPackageCost
  }
  unique(unitKeys, 'OPTIMIZER_RESULT_UNIT_DUPLICATE')
  for (const [cartonGlobalId, count] of cartonCounts) {
    if (count > (cartonById.get(cartonGlobalId)?.availableQuantity || 0)) {
      fail('OPTIMIZER_RESULT_CARTON_AVAILABILITY_EXCEEDED')
    }
  }
  for (const line of input.lines) {
    if ((lineCounts.get(line.lineGlobalId) || 0) !== line.quantity) {
      fail('OPTIMIZER_RESULT_LINE_QUANTITY_IMBALANCE')
    }
  }
  for (const position of input.eligiblePositions) {
    if ((positionCounts.get(position.positionGlobalId) || 0) > position.availableQuantity) {
      fail('OPTIMIZER_RESULT_INVENTORY_EXCEEDED')
    }
  }
  for (const warehouseGlobalId of selectedWarehouseIds) {
    computedCost += warehouseById.get(warehouseGlobalId)?.handlingCostMinor || 0
  }
  const warehouseCount = integer(source.warehouseCount, 'OPTIMIZER_RESULT_WAREHOUSE_COUNT_INVALID')
  const shipmentCount = integer(source.shipmentCount, 'OPTIMIZER_RESULT_SHIPMENT_COUNT_INVALID')
  const cartonCount = integer(source.cartonCount, 'OPTIMIZER_RESULT_CARTON_COUNT_INVALID')
  const totalCost = integer(
    source.estimatedTotalCostMinor,
    'OPTIMIZER_RESULT_TOTAL_COST_INVALID',
    0,
    MAX_SAFE_MINOR,
  )
  const unusedVolume = integer(source.unusedVolumeMm3, 'OPTIMIZER_RESULT_UNUSED_VOLUME_INVALID')
  if (
    warehouseCount !== selectedWarehouseIds.length
    || shipmentCount !== packages.length
    || cartonCount !== packages.length
    || totalCost !== computedCost
    || unusedVolume !== computedUnusedVolume
  ) {
    fail('OPTIMIZER_RESULT_PLAN_TOTAL_INVALID')
  }
  return {
    planId,
    warehouseGlobalIds: selectedWarehouseIds,
    warehouseCount,
    shipmentCount,
    cartonCount,
    estimatedTotalCostMinor: totalCost,
    unusedVolumeMm3: unusedVolume,
    packages,
  }
}

export function parseFulfillmentOptimizationResult(
  value: unknown,
  input: FulfillmentOptimizationInputV1,
  options: FulfillmentOptimizationOptions,
  expectedHash: string,
  expectedMethod?: 'or_tools' | 'deterministic_fallback',
): FulfillmentOptimizationResultV1 {
  const source = record(value, 'OPTIMIZER_RESULT_INVALID')
  exactKeys(source, [
    'schemaVersion',
    'status',
    'method',
    'algorithmVersion',
    'inputHash',
    'durationMs',
    'selectedPlan',
    'candidates',
    'rejectedAlternatives',
    'fallbackReason',
    'explanation',
  ], 'OPTIMIZER_RESULT_INVALID')
  if (source.schemaVersion !== 1) fail('OPTIMIZER_RESULT_VERSION_UNSUPPORTED')
  if (
    source.status !== 'optimal'
    && source.status !== 'feasible'
    && source.status !== 'infeasible'
    && source.status !== 'timeout'
    && source.status !== 'error'
  ) {
    fail('OPTIMIZER_RESULT_STATUS_INVALID')
  }
  if (source.method !== 'or_tools' && source.method !== 'deterministic_fallback') {
    fail('OPTIMIZER_RESULT_METHOD_INVALID')
  }
  if (expectedMethod && source.method !== expectedMethod) fail('OPTIMIZER_RESULT_METHOD_INVALID')
  const inputHash = stringValue(source.inputHash, 'OPTIMIZER_RESULT_HASH_INVALID', 64)
  if (!/^[a-f0-9]{64}$/.test(inputHash) || inputHash !== expectedHash) {
    fail('OPTIMIZER_RESULT_HASH_MISMATCH')
  }
  const selectedPlan = source.selectedPlan === null
    ? null
    : validateCandidatePlan(source.selectedPlan, input)
  const candidates = array(
    source.candidates,
    'OPTIMIZER_RESULT_CANDIDATES_INVALID',
    options.maxCandidates,
  ).map((item) => validateCandidatePlan(item, input))
  if (
    (source.status === 'optimal' || source.status === 'feasible')
    && selectedPlan === null
  ) {
    fail('OPTIMIZER_RESULT_SELECTED_PLAN_REQUIRED')
  }
  if (
    (source.status === 'infeasible' || source.status === 'timeout' || source.status === 'error')
    && selectedPlan !== null
  ) {
    fail('OPTIMIZER_RESULT_SELECTED_PLAN_FORBIDDEN')
  }
  if (
    selectedPlan
    && !candidates.some((item) => (
      canonicalOptimizerJson(item) === canonicalOptimizerJson(selectedPlan)
    ))
  ) {
    fail('OPTIMIZER_RESULT_SELECTED_PLAN_NOT_CANDIDATE')
  }
  const rejectedAlternatives = array(
    source.rejectedAlternatives,
    'OPTIMIZER_RESULT_REJECTIONS_INVALID',
    256,
  ).map((item) => record(item, 'OPTIMIZER_RESULT_REJECTION_INVALID'))
  const explanation = array(
    source.explanation,
    'OPTIMIZER_RESULT_EXPLANATION_INVALID',
    64,
  ).map((item) => record(item, 'OPTIMIZER_RESULT_EXPLANATION_INVALID'))
  const fallbackReason = source.fallbackReason === null
    ? null
    : stringValue(source.fallbackReason, 'OPTIMIZER_RESULT_FALLBACK_REASON_INVALID', 512)
  if (source.method === 'or_tools' && fallbackReason !== null) {
    fail('OPTIMIZER_RESULT_FALLBACK_REASON_FORBIDDEN')
  }
  return {
    schemaVersion: 1,
    status: source.status,
    method: source.method,
    algorithmVersion: stringValue(source.algorithmVersion, 'OPTIMIZER_RESULT_ALGORITHM_INVALID', 160),
    inputHash,
    durationMs: integer(source.durationMs, 'OPTIMIZER_RESULT_DURATION_INVALID', 0, 120_000),
    selectedPlan,
    candidates,
    rejectedAlternatives,
    fallbackReason,
    explanation,
  }
}

export function validatePackagingAssortmentInput(
  input: PackagingAssortmentOptimizationInputV1,
): void {
  const source = record(input, 'ASSORTMENT_INPUT_INVALID')
  exactKeys(source, [
    'schemaVersion',
    'inputSnapshotGlobalId',
    'organizationGlobalId',
    'evaluatedAtUtc',
    'currency',
    'materials',
    'demandSamples',
    'feasibleLandedCosts',
    'policy',
    'objectivePolicy',
  ], 'ASSORTMENT_INPUT_INVALID')
  if (source.schemaVersion !== 1) fail('ASSORTMENT_SCHEMA_VERSION_UNSUPPORTED')
  identifier(source.inputSnapshotGlobalId, 'ASSORTMENT_SNAPSHOT_INVALID')
  identifier(source.organizationGlobalId, 'ASSORTMENT_ORGANIZATION_INVALID')
  const evaluatedAt = stringValue(source.evaluatedAtUtc, 'ASSORTMENT_EVALUATED_AT_INVALID')
  if (!Number.isFinite(Date.parse(evaluatedAt)) || !/(?:Z|[+-]\d\d:\d\d)$/.test(evaluatedAt)) {
    fail('ASSORTMENT_EVALUATED_AT_INVALID')
  }
  if (typeof source.currency !== 'string' || !/^[A-Z]{3}$/.test(source.currency)) {
    fail('ASSORTMENT_CURRENCY_INVALID')
  }
  const materialIds: string[] = []
  for (const item of array(source.materials, 'ASSORTMENT_MATERIALS_INVALID', 128)) {
    const material = record(item, 'ASSORTMENT_MATERIAL_INVALID')
    exactKeys(material, [
      'materialGlobalId',
      'materialType',
      'innerDimensionsMm',
      'maxWeightGrams',
      'materialCostMinor',
    ], 'ASSORTMENT_MATERIAL_INVALID')
    materialIds.push(identifier(material.materialGlobalId, 'ASSORTMENT_MATERIAL_INVALID'))
    if (material.materialType !== 'box' && material.materialType !== 'poly_mailer') {
      fail('ASSORTMENT_MATERIAL_TYPE_INVALID')
    }
    dimensionsVolume(dimensions(material.innerDimensionsMm, 'ASSORTMENT_DIMENSIONS_INVALID'))
    integer(material.maxWeightGrams, 'ASSORTMENT_WEIGHT_INVALID', 1)
    integer(material.materialCostMinor, 'ASSORTMENT_COST_INVALID', 0, MAX_SAFE_MINOR)
  }
  if (!materialIds.length) fail('ASSORTMENT_MATERIALS_REQUIRED')
  unique(materialIds, 'ASSORTMENT_MATERIAL_DUPLICATE')
  const materialSet = new Set(materialIds)
  const sampleIds: string[] = []
  for (const item of array(source.demandSamples, 'ASSORTMENT_SAMPLES_INVALID', 512)) {
    const sample = record(item, 'ASSORTMENT_SAMPLE_INVALID')
    exactKeys(sample, [
      'sampleGlobalId',
      'frequency',
      'packedWeightGrams',
      'packedVolumeMm3',
    ], 'ASSORTMENT_SAMPLE_INVALID')
    sampleIds.push(identifier(sample.sampleGlobalId, 'ASSORTMENT_SAMPLE_INVALID'))
    integer(sample.frequency, 'ASSORTMENT_FREQUENCY_INVALID', 1)
    integer(sample.packedWeightGrams, 'ASSORTMENT_WEIGHT_INVALID', 1)
    integer(sample.packedVolumeMm3, 'ASSORTMENT_VOLUME_INVALID', 1)
  }
  if (!sampleIds.length) fail('ASSORTMENT_SAMPLES_REQUIRED')
  unique(sampleIds, 'ASSORTMENT_SAMPLE_DUPLICATE')
  const sampleSet = new Set(sampleIds)
  const options: string[] = []
  for (const item of array(source.feasibleLandedCosts, 'ASSORTMENT_OPTIONS_INVALID', 16_384)) {
    const option = record(item, 'ASSORTMENT_OPTION_INVALID')
    exactKeys(option, [
      'sampleGlobalId',
      'materialGlobalId',
      'landedCostMinor',
      'wasteVolumeMm3',
    ], 'ASSORTMENT_OPTION_INVALID')
    const sampleGlobalId = identifier(option.sampleGlobalId, 'ASSORTMENT_OPTION_SAMPLE_INVALID')
    const materialGlobalId = identifier(option.materialGlobalId, 'ASSORTMENT_OPTION_MATERIAL_INVALID')
    if (!sampleSet.has(sampleGlobalId) || !materialSet.has(materialGlobalId)) {
      fail('ASSORTMENT_OPTION_REFERENCE_INVALID')
    }
    options.push(`${sampleGlobalId}:${materialGlobalId}`)
    integer(option.landedCostMinor, 'ASSORTMENT_OPTION_COST_INVALID', 0, MAX_SAFE_MINOR)
    integer(option.wasteVolumeMm3, 'ASSORTMENT_OPTION_WASTE_INVALID')
  }
  unique(options, 'ASSORTMENT_OPTION_DUPLICATE')
  const policy = record(source.policy, 'ASSORTMENT_POLICY_INVALID')
  exactKeys(policy, [
    'schemaVersion',
    'policyGlobalId',
    'maxAssortmentSize',
    'hardCoverAll',
    'minimumCoverageBasisPoints',
  ], 'ASSORTMENT_POLICY_INVALID')
  if (policy.schemaVersion !== 1) fail('ASSORTMENT_POLICY_VERSION_UNSUPPORTED')
  identifier(policy.policyGlobalId, 'ASSORTMENT_POLICY_INVALID')
  const maxAssortment = integer(
    policy.maxAssortmentSize,
    'ASSORTMENT_SIZE_INVALID',
    1,
    Math.min(64, materialIds.length),
  )
  if (maxAssortment > materialIds.length) fail('ASSORTMENT_SIZE_INVALID')
  const hardCoverAll = booleanValue(policy.hardCoverAll, 'ASSORTMENT_COVERAGE_INVALID')
  const threshold = integer(
    policy.minimumCoverageBasisPoints,
    'ASSORTMENT_COVERAGE_INVALID',
    1,
    10_000,
  )
  if (hardCoverAll && threshold !== 10_000) fail('ASSORTMENT_COVERAGE_INVALID')
  const objective = record(source.objectivePolicy, 'ASSORTMENT_OBJECTIVE_INVALID')
  exactKeys(objective, ['schemaVersion', 'policyGlobalId', 'sequence'], 'ASSORTMENT_OBJECTIVE_INVALID')
  if (objective.schemaVersion !== 1) fail('ASSORTMENT_OBJECTIVE_VERSION_UNSUPPORTED')
  identifier(objective.policyGlobalId, 'ASSORTMENT_OBJECTIVE_INVALID')
  const sequence = array(objective.sequence, 'ASSORTMENT_OBJECTIVE_INVALID', 4)
  if (
    sequence.length !== ASSORTMENT_OBJECTIVE_SEQUENCE.length
    || sequence.some((value, index) => value !== ASSORTMENT_OBJECTIVE_SEQUENCE[index])
  ) {
    fail('ASSORTMENT_OBJECTIVE_UNSUPPORTED')
  }
}

export function parsePackagingAssortmentResult(
  value: unknown,
  input: PackagingAssortmentOptimizationInputV1,
  expectedHash: string,
): PackagingAssortmentResultV1 {
  const source = record(value, 'ASSORTMENT_RESULT_INVALID')
  exactKeys(source, [
    'schemaVersion',
    'status',
    'method',
    'algorithmVersion',
    'inputHash',
    'durationMs',
    'selectedAssortment',
    'fallbackReason',
    'explanation',
  ], 'ASSORTMENT_RESULT_INVALID')
  if (source.schemaVersion !== 1 || source.method !== 'or_tools') {
    fail('ASSORTMENT_RESULT_VERSION_INVALID')
  }
  if (
    source.status !== 'optimal'
    && source.status !== 'feasible'
    && source.status !== 'infeasible'
    && source.status !== 'timeout'
    && source.status !== 'error'
  ) {
    fail('ASSORTMENT_RESULT_STATUS_INVALID')
  }
  if (source.inputHash !== expectedHash) fail('ASSORTMENT_RESULT_HASH_MISMATCH')
  if (source.fallbackReason !== null) fail('ASSORTMENT_RESULT_FALLBACK_INVALID')
  let selectedAssortment: PackagingAssortmentResultV1['selectedAssortment'] = null
  if (source.selectedAssortment !== null) {
    const selection = record(source.selectedAssortment, 'ASSORTMENT_RESULT_SELECTION_INVALID')
    exactKeys(selection, [
      'selectedMaterialGlobalIds',
      'assignments',
      'uncoveredSampleGlobalIds',
      'coveredFrequency',
      'totalFrequency',
      'coverageBasisPoints',
      'weightedLandedCostMinor',
      'weightedWasteVolumeMm3',
    ], 'ASSORTMENT_RESULT_SELECTION_INVALID')
    const materialSet = new Set(input.materials.map((item) => item.materialGlobalId))
    const sampleById = new Map(input.demandSamples.map((item) => [item.sampleGlobalId, item]))
    const optionByKey = new Map(input.feasibleLandedCosts.map((item) => [
      `${item.sampleGlobalId}:${item.materialGlobalId}`,
      item,
    ]))
    const selectedIds = array(
      selection.selectedMaterialGlobalIds,
      'ASSORTMENT_RESULT_MATERIALS_INVALID',
      input.policy.maxAssortmentSize,
    ).map((item) => identifier(item, 'ASSORTMENT_RESULT_MATERIALS_INVALID'))
    unique(selectedIds, 'ASSORTMENT_RESULT_MATERIAL_DUPLICATE')
    if (selectedIds.some((item) => !materialSet.has(item))) fail('ASSORTMENT_RESULT_MATERIAL_UNKNOWN')
    const assignmentRows = array(
      selection.assignments,
      'ASSORTMENT_RESULT_ASSIGNMENTS_INVALID',
      input.demandSamples.length,
    ).map((item) => {
      const assignment = record(item, 'ASSORTMENT_RESULT_ASSIGNMENT_INVALID')
      exactKeys(assignment, [
        'sampleGlobalId',
        'materialGlobalId',
        'frequency',
        'landedCostMinor',
        'wasteVolumeMm3',
      ], 'ASSORTMENT_RESULT_ASSIGNMENT_INVALID')
      const sampleGlobalId = identifier(assignment.sampleGlobalId, 'ASSORTMENT_RESULT_SAMPLE_INVALID')
      const materialGlobalId = identifier(assignment.materialGlobalId, 'ASSORTMENT_RESULT_MATERIAL_INVALID')
      const sample = sampleById.get(sampleGlobalId)
      const option = optionByKey.get(`${sampleGlobalId}:${materialGlobalId}`)
      if (!sample || !option || !selectedIds.includes(materialGlobalId)) {
        fail('ASSORTMENT_RESULT_ASSIGNMENT_REFERENCE_INVALID')
      }
      const row = {
        sampleGlobalId,
        materialGlobalId,
        frequency: integer(assignment.frequency, 'ASSORTMENT_RESULT_FREQUENCY_INVALID', 1),
        landedCostMinor: integer(
          assignment.landedCostMinor,
          'ASSORTMENT_RESULT_COST_INVALID',
          0,
          MAX_SAFE_MINOR,
        ),
        wasteVolumeMm3: integer(assignment.wasteVolumeMm3, 'ASSORTMENT_RESULT_WASTE_INVALID'),
      }
      if (
        row.frequency !== sample.frequency
        || row.landedCostMinor !== option.landedCostMinor
        || row.wasteVolumeMm3 !== option.wasteVolumeMm3
      ) {
        fail('ASSORTMENT_RESULT_ASSIGNMENT_FACT_MISMATCH')
      }
      return row
    })
    unique(assignmentRows.map((item) => item.sampleGlobalId), 'ASSORTMENT_RESULT_SAMPLE_DUPLICATE')
    const usedMaterials = [...new Set(assignmentRows.map((item) => item.materialGlobalId))].sort()
    if (canonicalOptimizerJson(usedMaterials) !== canonicalOptimizerJson([...selectedIds].sort())) {
      fail('ASSORTMENT_RESULT_UNUSED_MATERIAL')
    }
    const uncoveredIds = array(
      selection.uncoveredSampleGlobalIds,
      'ASSORTMENT_RESULT_UNCOVERED_INVALID',
      input.demandSamples.length,
    ).map((item) => identifier(item, 'ASSORTMENT_RESULT_UNCOVERED_INVALID'))
    unique(uncoveredIds, 'ASSORTMENT_RESULT_UNCOVERED_DUPLICATE')
    const assignedSamples = new Set(assignmentRows.map((item) => item.sampleGlobalId))
    const expectedUncovered = input.demandSamples
      .map((item) => item.sampleGlobalId)
      .filter((item) => !assignedSamples.has(item))
      .sort()
    if (canonicalOptimizerJson([...uncoveredIds].sort()) !== canonicalOptimizerJson(expectedUncovered)) {
      fail('ASSORTMENT_RESULT_COVERAGE_MISMATCH')
    }
    if (input.policy.hardCoverAll && expectedUncovered.length) {
      fail('ASSORTMENT_RESULT_HARD_COVERAGE_VIOLATED')
    }
    const totalFrequency = input.demandSamples.reduce((sum, item) => sum + item.frequency, 0)
    const coveredFrequency = assignmentRows.reduce((sum, item) => sum + item.frequency, 0)
    const coverageBasisPoints = Math.floor((coveredFrequency * 10_000) / totalFrequency)
    const weightedCost = assignmentRows.reduce(
      (sum, item) => sum + item.frequency * item.landedCostMinor,
      0,
    )
    const weightedWaste = assignmentRows.reduce(
      (sum, item) => sum + item.frequency * item.wasteVolumeMm3,
      0,
    )
    if (
      integer(selection.totalFrequency, 'ASSORTMENT_RESULT_TOTAL_INVALID') !== totalFrequency
      || integer(selection.coveredFrequency, 'ASSORTMENT_RESULT_TOTAL_INVALID') !== coveredFrequency
      || integer(selection.coverageBasisPoints, 'ASSORTMENT_RESULT_TOTAL_INVALID', 0, 10_000)
        !== coverageBasisPoints
      || integer(selection.weightedLandedCostMinor, 'ASSORTMENT_RESULT_TOTAL_INVALID') !== weightedCost
      || integer(selection.weightedWasteVolumeMm3, 'ASSORTMENT_RESULT_TOTAL_INVALID') !== weightedWaste
      || coverageBasisPoints < input.policy.minimumCoverageBasisPoints
    ) {
      fail('ASSORTMENT_RESULT_TOTAL_INVALID')
    }
    selectedAssortment = {
      selectedMaterialGlobalIds: selectedIds,
      assignments: assignmentRows,
      uncoveredSampleGlobalIds: uncoveredIds,
      coveredFrequency,
      totalFrequency,
      coverageBasisPoints,
      weightedLandedCostMinor: weightedCost,
      weightedWasteVolumeMm3: weightedWaste,
    }
  }
  if (
    (source.status === 'optimal' || source.status === 'feasible')
    && selectedAssortment === null
  ) {
    fail('ASSORTMENT_RESULT_SELECTION_REQUIRED')
  }
  if (
    (source.status === 'infeasible' || source.status === 'timeout' || source.status === 'error')
    && selectedAssortment !== null
  ) {
    fail('ASSORTMENT_RESULT_SELECTION_FORBIDDEN')
  }
  return {
    schemaVersion: 1,
    status: source.status,
    method: 'or_tools',
    algorithmVersion: stringValue(source.algorithmVersion, 'ASSORTMENT_RESULT_ALGORITHM_INVALID', 160),
    inputHash: expectedHash,
    durationMs: integer(source.durationMs, 'ASSORTMENT_RESULT_DURATION_INVALID', 0, 120_000),
    selectedAssortment,
    fallbackReason: null,
    explanation: array(
      source.explanation,
      'ASSORTMENT_RESULT_EXPLANATION_INVALID',
      64,
    ).map((item) => record(item, 'ASSORTMENT_RESULT_EXPLANATION_INVALID')),
  }
}

export function assertOptimizerResponseSize(text: string): void {
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
    fail('OPTIMIZER_RESPONSE_TOO_LARGE')
  }
}
