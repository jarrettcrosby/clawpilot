import {
  FULFILLMENT_OBJECTIVE_SEQUENCE,
  canonicalOptimizerHash,
  validateFulfillmentOptimizationInput,
  type FulfillmentOptimizationInputV1,
  type FulfillmentOptimizationResultV1,
  type FulfillmentOptimizerV1,
  type OptimizerDimensionsMm,
} from '@/lib/operations/fulfillmentOptimizerContract'

export const CARTONIZATION_PREVIEW_POLICY_VERSION =
  'commerce-cartonization-preview-v1'
export const CARTONIZATION_INVENTORY_POLICY_VERSION =
  'shopify-atp-plus-bounded-candidate-committed-v1'

const ACCOUNT_GLOBAL_ID = /^gia(?:[0-9]{7}|[0-9a-v]{12})$/
const CANDIDATE_GLOBAL_ID = /^gcoc(?:[0-9]{7}|[0-9a-v]{12})$/
const WAREHOUSE_GLOBAL_ID = /^gwh(?:[0-9]{7}|[0-9a-v]{12})$/
const LINE_GLOBAL_ID = /^(?:gcol|gcal)(?:[0-9]{7}|[0-9a-v]{12})$/
const MATERIAL_GLOBAL_ID = /^gmat(?:[0-9]{7}|[0-9a-v]{12})$/
const MAX_SELECTED_MATERIALS = 8
const MAX_OPTIMIZER_UNITS = 80
const MAX_OPTIMIZER_PACKAGES = 64
const MAX_SAFE_MINOR = 1_000_000_000_000
const INVENTORY_MAX_AGE_MS = 24 * 60 * 60 * 1_000

export type CartonizationAssumedCommittedLine = {
  lineGlobalId: string
  quantity: number
}

export type CartonizationPreviewRequest = {
  accountGlobalId: string
  candidateGlobalId: string
  expectedCandidateRowVersion: number
  warehouseGlobalId: string
  materialGlobalIds: string[]
  assumedCommittedByLine: CartonizationAssumedCommittedLine[]
}

export type CartonizationPreviewBlocker = {
  code: string
  title: string
  detail: string
  action: string
  entityType:
    | 'account'
    | 'candidate'
    | 'line'
    | 'inventory'
    | 'warehouse'
    | 'material'
    | 'optimizer'
  entityGlobalId?: string
}

export type CartonizationPreviewSnapshot = {
  readAtUtc: string
  organization: {
    globalId: string
  }
  account: {
    globalId: string
    provider: 'shopify' | 'faire'
    status: 'active' | 'disabled' | 'error'
    activationState:
      | 'disabled'
      | 'shadow'
      | 'read_only'
      | 'active'
      | 'frozen'
      | null
  }
  candidate: {
    globalId: string
    orderNumber: string
    sourceHash: string
    rowVersion: number
    workflowState:
      | 'held'
      | 'resolving'
      | 'ready'
      | 'promoted'
      | 'failed'
      | 'expired'
    currency: string
    requiresShipping: boolean
    expiresAt: string
  }
  lines: Array<{
    globalId: string
    title: string
    requiresShipping: boolean
    quantity: number
    mappingState: string
    packagingState: string
    productGlobalId: string | null
    weightGrams: number | null
    dimensionsMm: OptimizerDimensionsMm | null
    packEvidence: {
      mappingGlobalId: string
      mappingRowVersion: number
      profileVersionGlobalId: string
      profileVersionRowVersion: number
      packageLevel: string
      baseEachQuantity: number
      packagingSource: string
      weightSource: string | null
    } | null
  }>
  activeWarehouses: Array<{
    globalId: string
    name: string
  }>
  latestInventoryRun: {
    globalId: string
    warehouseGlobalId: string
    providerFetchedAt: string
    completedAt: string
  } | null
  inventoryPositions: Array<{
    positionGlobalId: string
    warehouseGlobalId: string
    productGlobalId: string
    atpQuantity: number
    providerCommittedQuantity: number
    sourceLevelGlobalIds: string[]
  }>
  selectedMaterials: Array<{
    globalId: string
    name: string
    materialType: 'carton' | 'poly_mailer' | 'padded_mailer'
    status: 'draft' | 'active'
    innerDimensionsMm: OptimizerDimensionsMm
    tareWeightGrams: number
    maxWeightGrams: number
    unitCostMinor: number | null
    currency: string | null
    rowVersion: number
    stock: Array<{
      warehouseGlobalId: string
      warehouseStatus: 'active' | 'inactive'
      isAvailable: boolean
      onHandQuantity: number | null
      rowVersion: number | null
    }>
  }>
}

export type CartonizationPreviewResult = {
  status: 'ready' | 'blocked' | 'infeasible'
  readOnly: true
  policyVersion: typeof CARTONIZATION_PREVIEW_POLICY_VERSION
  accountGlobalId: string
  candidateGlobalId: string
  candidateRowVersion: number
  warehouse: {
    globalId: string
    name: string
  } | null
  selectedMaterialGlobalIds: string[]
  inventoryEvidence: {
    policyVersion: typeof CARTONIZATION_INVENTORY_POLICY_VERSION
    syncRunGlobalId: string | null
    providerFetchedAt: string | null
    completedAt: string | null
    assumedCommittedByLine: CartonizationAssumedCommittedLine[]
    products: Array<{
      productGlobalId: string
      demandQuantity: number
      assumedCommittedQuantity: number
      eligibleQuantity: number | null
      positionCount: number
    }>
    positions: Array<{
      productGlobalId: string
      positionGlobalId: string
      atpQuantity: number
      providerCommittedQuantity: number
    }>
  }
  blockers: CartonizationPreviewBlocker[]
  optimizer: {
    method: 'or_tools'
    status: FulfillmentOptimizationResultV1['status']
    algorithmVersion: string
    inputHash: string
    durationMs: number
    selectedPlan: FulfillmentOptimizationResultV1['selectedPlan']
    candidates: FulfillmentOptimizationResultV1['candidates']
    rejectedAlternatives:
      FulfillmentOptimizationResultV1['rejectedAlternatives']
    explanation: FulfillmentOptimizationResultV1['explanation']
  } | null
  evidence: {
    databaseWrites: 0
    providerWrites: 0
    rateCalls: 0
    labelCalls: 0
    shipmentWrites: 0
    transportCostBasis: 'excluded_from_read_only_preview'
    warehouseHandlingCostBasis: 'excluded_from_read_only_preview'
    inventoryHandlingCostBasis: 'excluded_from_read_only_preview'
    rotationPolicy: 'fixed_axes_conservative'
  }
}

export class CartonizationPreviewRequestError extends Error {
  readonly status: number
  readonly code: string

  constructor(message: string, status = 400, code = 'CARTONIZATION_PREVIEW_REQUEST_INVALID') {
    super(message)
    this.name = 'CartonizationPreviewRequestError'
    this.status = status
    this.code = code
  }
}

function requestError(message: string, code: string): never {
  throw new CartonizationPreviewRequestError(message, 400, code)
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  code: string,
) {
  const actual = Object.keys(value).sort()
  const keys = [...expected].sort()
  if (
    actual.length !== keys.length
    || actual.some((key, index) => key !== keys[index])
  ) requestError('Cartonization preview request contains unsupported fields', code)
}

function object(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    requestError('Cartonization preview request must be a JSON object', code)
  }
  return value as Record<string, unknown>
}

function globalId(
  value: unknown,
  pattern: RegExp,
  label: string,
  code: string,
) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!pattern.test(normalized)) requestError(`${label} is invalid`, code)
  return normalized
}

function safeInteger(
  value: unknown,
  label: string,
  code: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
) {
  const parsed = typeof value === 'number' ? value : Number.NaN
  if (
    !Number.isSafeInteger(parsed)
    || parsed < minimum
    || parsed > maximum
  ) requestError(`${label} is invalid`, code)
  return parsed
}

export function normalizeCartonizationPreviewRequest(
  value: unknown,
): CartonizationPreviewRequest {
  const source = object(value, 'CARTONIZATION_PREVIEW_REQUEST_INVALID')
  exactKeys(source, [
    'accountGlobalId',
    'candidateGlobalId',
    'expectedCandidateRowVersion',
    'warehouseGlobalId',
    'materialGlobalIds',
    'assumedCommittedByLine',
  ], 'CARTONIZATION_PREVIEW_REQUEST_INVALID')
  if (
    !Array.isArray(source.materialGlobalIds)
    || source.materialGlobalIds.length < 1
    || source.materialGlobalIds.length > MAX_SELECTED_MATERIALS
  ) {
    requestError(
      'Select between one and eight packaging materials',
      'CARTONIZATION_PREVIEW_MATERIAL_SELECTION_INVALID',
    )
  }
  const materialGlobalIds = source.materialGlobalIds.map((value) => globalId(
    value,
    MATERIAL_GLOBAL_ID,
    'Packaging material Global ID',
    'CARTONIZATION_PREVIEW_MATERIAL_ID_INVALID',
  ))
  if (new Set(materialGlobalIds).size !== materialGlobalIds.length) {
    requestError(
      'Packaging material selections must be unique',
      'CARTONIZATION_PREVIEW_MATERIAL_DUPLICATE',
    )
  }
  if (!Array.isArray(source.assumedCommittedByLine)) {
    requestError(
      'Assumed committed quantities must be supplied as an array; use an empty array for ATP only',
      'CARTONIZATION_PREVIEW_ASSUMED_COMMITTED_INVALID',
    )
  }
  const assumedCommittedByLine = source.assumedCommittedByLine.map(
    (value, index) => {
      const item = object(
        value,
        'CARTONIZATION_PREVIEW_ASSUMED_COMMITTED_INVALID',
      )
      exactKeys(
        item,
        ['lineGlobalId', 'quantity'],
        'CARTONIZATION_PREVIEW_ASSUMED_COMMITTED_INVALID',
      )
      return {
        lineGlobalId: globalId(
          item.lineGlobalId,
          LINE_GLOBAL_ID,
          `Assumed committed line ${index + 1}`,
          'CARTONIZATION_PREVIEW_ASSUMED_COMMITTED_LINE_INVALID',
        ),
        quantity: safeInteger(
          item.quantity,
          `Assumed committed quantity ${index + 1}`,
          'CARTONIZATION_PREVIEW_ASSUMED_COMMITTED_QUANTITY_INVALID',
          0,
          MAX_OPTIMIZER_UNITS,
        ),
      }
    },
  )
  if (
    new Set(assumedCommittedByLine.map((item) => item.lineGlobalId)).size
    !== assumedCommittedByLine.length
  ) {
    requestError(
      'Each candidate line may have only one assumed committed quantity',
      'CARTONIZATION_PREVIEW_ASSUMED_COMMITTED_DUPLICATE',
    )
  }
  return {
    accountGlobalId: globalId(
      source.accountGlobalId,
      ACCOUNT_GLOBAL_ID,
      'Commerce account Global ID',
      'CARTONIZATION_PREVIEW_ACCOUNT_ID_INVALID',
    ),
    candidateGlobalId: globalId(
      source.candidateGlobalId,
      CANDIDATE_GLOBAL_ID,
      'Order candidate Global ID',
      'CARTONIZATION_PREVIEW_CANDIDATE_ID_INVALID',
    ),
    expectedCandidateRowVersion: safeInteger(
      source.expectedCandidateRowVersion,
      'Expected candidate row version',
      'CARTONIZATION_PREVIEW_CANDIDATE_REVISION_INVALID',
    ),
    warehouseGlobalId: globalId(
      source.warehouseGlobalId,
      WAREHOUSE_GLOBAL_ID,
      'Warehouse Global ID',
      'CARTONIZATION_PREVIEW_WAREHOUSE_ID_INVALID',
    ),
    materialGlobalIds,
    assumedCommittedByLine,
  }
}

function blocker(
  code: string,
  title: string,
  detail: string,
  action: string,
  entityType: CartonizationPreviewBlocker['entityType'],
  entityGlobalId?: string,
): CartonizationPreviewBlocker {
  return {
    code,
    title,
    detail,
    action,
    entityType,
    ...(entityGlobalId ? { entityGlobalId } : {}),
  }
}

function canonicalPositiveInteger(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) > 0
}

function canonicalNonnegativeInteger(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function canonicalDimensions(value: OptimizerDimensionsMm | null) {
  return Boolean(
    value
    && canonicalPositiveInteger(value.length)
    && canonicalPositiveInteger(value.width)
    && canonicalPositiveInteger(value.height),
  )
}

function baseResult(
  request: CartonizationPreviewRequest,
  snapshot: CartonizationPreviewSnapshot,
  blockers: CartonizationPreviewBlocker[],
): CartonizationPreviewResult {
  const requestedWarehouses = snapshot.activeWarehouses.filter(
    (warehouse) => warehouse.globalId === request.warehouseGlobalId,
  )
  const warehouse = requestedWarehouses.length === 1
    ? requestedWarehouses[0]
    : null
  const assumedByLine = new Map(request.assumedCommittedByLine.map(
    (item) => [item.lineGlobalId, item.quantity],
  ))
  const demandByProduct = new Map<string, number>()
  const assumedByProduct = new Map<string, number>()
  for (const line of snapshot.lines) {
    if (!line.requiresShipping || !line.productGlobalId || line.quantity <= 0) {
      continue
    }
    demandByProduct.set(
      line.productGlobalId,
      (demandByProduct.get(line.productGlobalId) || 0) + line.quantity,
    )
    assumedByProduct.set(
      line.productGlobalId,
      (assumedByProduct.get(line.productGlobalId) || 0)
        + (assumedByLine.get(line.globalId) || 0),
    )
  }
  const positionsByProduct = new Map<
    string,
    CartonizationPreviewSnapshot['inventoryPositions']
  >()
  for (const position of snapshot.inventoryPositions) {
    const positions = positionsByProduct.get(position.productGlobalId) || []
    positions.push(position)
    positionsByProduct.set(position.productGlobalId, positions)
  }
  return {
    status: blockers.length ? 'blocked' : 'ready',
    readOnly: true,
    policyVersion: CARTONIZATION_PREVIEW_POLICY_VERSION,
    accountGlobalId: request.accountGlobalId,
    candidateGlobalId: request.candidateGlobalId,
    candidateRowVersion: snapshot.candidate.rowVersion,
    warehouse,
    selectedMaterialGlobalIds: [...request.materialGlobalIds],
    inventoryEvidence: {
      policyVersion: CARTONIZATION_INVENTORY_POLICY_VERSION,
      syncRunGlobalId: snapshot.latestInventoryRun?.globalId || null,
      providerFetchedAt:
        snapshot.latestInventoryRun?.providerFetchedAt || null,
      completedAt: snapshot.latestInventoryRun?.completedAt || null,
      assumedCommittedByLine: request.assumedCommittedByLine.map(
        (item) => ({ ...item }),
      ),
      products: [...demandByProduct.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([productGlobalId, demandQuantity]) => {
          const positions = positionsByProduct.get(productGlobalId) || []
          const assumedCommittedQuantity =
            assumedByProduct.get(productGlobalId) || 0
          return {
            productGlobalId,
            demandQuantity,
            assumedCommittedQuantity,
            eligibleQuantity: positions.length === 1
              ? sumSafe([
                  positions[0].atpQuantity,
                  assumedCommittedQuantity,
                ])
              : null,
            positionCount: positions.length,
          }
        }),
      positions: snapshot.inventoryPositions.map((position) => ({
        productGlobalId: position.productGlobalId,
        positionGlobalId: position.positionGlobalId,
        atpQuantity: position.atpQuantity,
        providerCommittedQuantity: position.providerCommittedQuantity,
      })),
    },
    blockers,
    optimizer: null,
    evidence: {
      databaseWrites: 0,
      providerWrites: 0,
      rateCalls: 0,
      labelCalls: 0,
      shipmentWrites: 0,
      transportCostBasis: 'excluded_from_read_only_preview',
      warehouseHandlingCostBasis: 'excluded_from_read_only_preview',
      inventoryHandlingCostBasis: 'excluded_from_read_only_preview',
      rotationPolicy: 'fixed_axes_conservative',
    },
  }
}

function materialFamily(
  type: CartonizationPreviewSnapshot['selectedMaterials'][number]['materialType'],
): 'box' | 'poly_mailer' {
  return type === 'carton' ? 'box' : 'poly_mailer'
}

function sumSafe(values: number[]) {
  const total = values.reduce((sum, value) => sum + value, 0)
  return Number.isSafeInteger(total) ? total : null
}

function optimizerInput(input: {
  request: CartonizationPreviewRequest
  snapshot: CartonizationPreviewSnapshot
  lines: Array<CartonizationPreviewSnapshot['lines'][number]>
  inventoryQuantityByProduct: Map<string, {
    positionGlobalId: string
    quantity: number
  }>
  materials: CartonizationPreviewSnapshot['selectedMaterials']
  warehouse: CartonizationPreviewSnapshot['activeWarehouses'][number]
}): FulfillmentOptimizationInputV1 {
  const snapshotHash = canonicalOptimizerHash({
    policyVersion: CARTONIZATION_PREVIEW_POLICY_VERSION,
    organizationGlobalId: input.snapshot.organization.globalId,
    accountGlobalId: input.snapshot.account.globalId,
    candidateGlobalId: input.snapshot.candidate.globalId,
    candidateRowVersion: input.snapshot.candidate.rowVersion,
    warehouseGlobalId: input.request.warehouseGlobalId,
    inventoryRunGlobalId: input.snapshot.latestInventoryRun?.globalId,
    materialGlobalIds: input.request.materialGlobalIds,
    assumedCommittedByLine: input.request.assumedCommittedByLine,
    linePackEvidence: input.lines.map((line) => ({
      lineGlobalId: line.globalId,
      packEvidence: line.packEvidence,
    })),
    readAtUtc: input.snapshot.readAtUtc,
  })
  const allowedCartonGlobalIds = input.materials
    .map((material) => material.globalId)
    .sort()
  const totalUnits = sumSafe(input.lines.map((line) => line.quantity)) || 1
  const optimizationInput: FulfillmentOptimizationInputV1 = {
    schemaVersion: 1,
    inputSnapshotGlobalId: `preview-${snapshotHash.slice(0, 24)}`,
    organizationGlobalId: input.snapshot.organization.globalId,
    orderGlobalId: input.snapshot.candidate.globalId,
    // The optimizer contract is one-based while commerce candidate row_version
    // is zero-based. The exact source row version remains in the snapshot hash
    // and response; this transport revision is therefore row_version + 1.
    orderRevision: input.snapshot.candidate.rowVersion + 1,
    evaluatedAtUtc: input.snapshot.readAtUtc,
    currency: input.snapshot.candidate.currency,
    lines: input.lines.map((line) => ({
      lineGlobalId: line.globalId,
      productGlobalId: line.productGlobalId as string,
      quantity: line.quantity,
      unitWeightGrams: line.weightGrams as number,
      unitDimensionsMm: line.dimensionsMm as OptimizerDimensionsMm,
      rotationAllowed: false,
      allowedWarehouseGlobalIds: [input.warehouse.globalId],
      allowedCartonGlobalIds,
    })),
    eligiblePositions: [...input.inventoryQuantityByProduct.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([productGlobalId, position]) => ({
        positionGlobalId: position.positionGlobalId,
        warehouseGlobalId: input.warehouse.globalId,
        productGlobalId,
        availableQuantity: position.quantity,
        unitHandlingCostMinor: 0,
      })),
    warehouses: [{
      warehouseGlobalId: input.warehouse.globalId,
      active: true,
      handlingCostMinor: 0,
    }],
    cartons: input.materials.map((material) => {
      const stock = material.stock.find(
        (item) => item.warehouseGlobalId === input.warehouse.globalId,
      )
      return {
        cartonGlobalId: material.globalId,
        warehouseGlobalId: input.warehouse.globalId,
        materialType: materialFamily(material.materialType),
        innerDimensionsMm: material.innerDimensionsMm,
        maxWeightGrams: material.maxWeightGrams,
        emptyWeightGrams: material.tareWeightGrams,
        availableQuantity: stock?.onHandQuantity as number,
        materialCostMinor: material.unitCostMinor as number,
        estimatedTransportCostMinor: 0,
      }
    }),
    constraints: {
      schemaVersion: 1,
      maxPackages: Math.max(
        1,
        Math.min(MAX_OPTIMIZER_PACKAGES, totalUnits),
      ),
      maxPackageWeightGrams: null,
      allowedWarehouseGlobalIds: [input.warehouse.globalId],
      allowedCartonGlobalIds,
    },
    objectivePolicy: {
      schemaVersion: 1,
      policyGlobalId: 'cartonization-preview-material-cost-v1',
      sequence: FULFILLMENT_OBJECTIVE_SEQUENCE,
    },
    splitPolicy: {
      allowed: false,
      maxWarehouses: 1,
    },
  }
  validateFulfillmentOptimizationInput(optimizationInput)
  return optimizationInput
}

export async function createCartonizationPreview(input: {
  request: CartonizationPreviewRequest
  snapshot: CartonizationPreviewSnapshot
  optimizer: FulfillmentOptimizerV1 | null
  options?: {
    deadlineMs?: number
    maxCandidates?: number
  }
}): Promise<CartonizationPreviewResult> {
  const { request, snapshot } = input
  if (
    snapshot.account.globalId !== request.accountGlobalId
    || snapshot.candidate.globalId !== request.candidateGlobalId
  ) {
    throw new CartonizationPreviewRequestError(
      'The preview snapshot does not match the requested account and candidate',
      409,
      'CARTONIZATION_PREVIEW_SCOPE_CONFLICT',
    )
  }
  if (
    snapshot.candidate.rowVersion
    !== request.expectedCandidateRowVersion
  ) {
    throw new CartonizationPreviewRequestError(
      'The order candidate changed; reload it before previewing cartonization',
      409,
      'CARTONIZATION_PREVIEW_CANDIDATE_REVISION_CONFLICT',
    )
  }
  const blockers: CartonizationPreviewBlocker[] = []
  if (snapshot.account.status !== 'active') {
    blockers.push(blocker(
      'CARTONIZATION_ACCOUNT_INACTIVE',
      'Sales channel is not active',
      `The ${snapshot.account.provider} connection is ${snapshot.account.status}.`,
      'Reconnect or reactivate the sales channel before previewing cartonization.',
      'account',
      snapshot.account.globalId,
    ))
  }
  const accountInventorySupported = snapshot.account.provider === 'shopify'
  if (!accountInventorySupported) {
    blockers.push(blocker(
      'CARTONIZATION_PROVIDER_INVENTORY_UNSUPPORTED',
      'Faire pack preview is waiting on account-bound inventory',
      'ClawPilot does not yet reconcile Faire inventory into the warehouse ledger.',
      'Use the Shopify pack preview or wait until Faire inventory reconciliation is available; no inventory is inferred.',
      'account',
      snapshot.account.globalId,
    ))
  }
  if (
    !['held', 'resolving', 'ready'].includes(
      snapshot.candidate.workflowState,
    )
    || Date.parse(snapshot.candidate.expiresAt) <= Date.parse(snapshot.readAtUtc)
  ) {
    blockers.push(blocker(
      'CARTONIZATION_CANDIDATE_NOT_PREVIEWABLE',
      'Order candidate is no longer previewable',
      `Candidate state is ${snapshot.candidate.workflowState}.`,
      'Refresh or fetch the order again before running cartonization.',
      'candidate',
      snapshot.candidate.globalId,
    ))
  }
  if (!snapshot.candidate.requiresShipping) {
    blockers.push(blocker(
      'CARTONIZATION_SHIPPING_NOT_REQUIRED',
      'Order does not require shipping',
      'The provider order has no physical shipping demand.',
      'Review the order without creating a carton plan.',
      'candidate',
      snapshot.candidate.globalId,
    ))
  }
  const requestedWarehouses = snapshot.activeWarehouses.filter(
    (warehouse) => warehouse.globalId === request.warehouseGlobalId,
  )
  if (requestedWarehouses.length !== 1) {
    blockers.push(blocker(
      'CARTONIZATION_SELECTED_WAREHOUSE_UNAVAILABLE',
      'The selected warehouse is unavailable',
      `Warehouse ${request.warehouseGlobalId} did not resolve to exactly one active warehouse in this preview.`,
      'Select the active warehouse mapped to this sales channel and retry.',
      'warehouse',
      request.warehouseGlobalId,
    ))
  }
  const warehouse = requestedWarehouses.length === 1
    ? requestedWarehouses[0]
    : null
  if (accountInventorySupported && !snapshot.latestInventoryRun) {
    blockers.push(blocker(
      'CARTONIZATION_INVENTORY_EVIDENCE_REQUIRED',
      'Current account inventory evidence is required',
      'No completed inventory reconciliation exists for this sales channel.',
      'Run the read-only inventory reconciliation for this exact account, then retry.',
      'inventory',
      snapshot.account.globalId,
    ))
  } else if (
    accountInventorySupported
    &&
    snapshot.latestInventoryRun
    &&
    warehouse
    && snapshot.latestInventoryRun.warehouseGlobalId !== warehouse.globalId
  ) {
    blockers.push(blocker(
      'CARTONIZATION_INVENTORY_WAREHOUSE_MISMATCH',
      'Inventory evidence belongs to another warehouse',
      `Latest inventory evidence is bound to ${snapshot.latestInventoryRun.warehouseGlobalId}.`,
      'Reconcile inventory against the active development warehouse before retrying.',
      'inventory',
      snapshot.latestInventoryRun.globalId,
    ))
  } else if (
    accountInventorySupported
    && snapshot.latestInventoryRun
    && (
      Date.parse(snapshot.readAtUtc)
      - Date.parse(snapshot.latestInventoryRun.providerFetchedAt)
    ) > INVENTORY_MAX_AGE_MS
  ) {
    blockers.push(blocker(
      'CARTONIZATION_INVENTORY_EVIDENCE_STALE',
      'Inventory evidence is older than 24 hours',
      `The latest account-bound inventory snapshot was captured from the provider at ${snapshot.latestInventoryRun.providerFetchedAt} and completed at ${snapshot.latestInventoryRun.completedAt}.`,
      'Run Shopify inventory reconciliation and retry with the refreshed point-in-time evidence.',
      'inventory',
      snapshot.latestInventoryRun.globalId,
    ))
  }

  const shippingLines = snapshot.lines.filter(
    (line) => line.requiresShipping && line.quantity > 0,
  )
  if (!shippingLines.length) {
    blockers.push(blocker(
      'CARTONIZATION_SHIPPING_LINES_REQUIRED',
      'No shippable order lines are available',
      'The candidate contains no positive shipping quantity for cartonization.',
      'Refresh the candidate and review its provider fulfillment quantities.',
      'candidate',
      snapshot.candidate.globalId,
    ))
  }
  const knownLineIds = new Set(shippingLines.map((line) => line.globalId))
  for (const assumption of request.assumedCommittedByLine) {
    if (!knownLineIds.has(assumption.lineGlobalId)) {
      blockers.push(blocker(
        'CARTONIZATION_ASSUMED_COMMITTED_LINE_UNKNOWN',
        'Assumed committed quantity references an unavailable line',
        `${assumption.lineGlobalId} is not a positive shippable line on this candidate.`,
        'Reload the candidate and submit assumptions only for its current shipping lines.',
        'line',
        assumption.lineGlobalId,
      ))
    }
  }
  const assumptionByLine = new Map(
    request.assumedCommittedByLine.map(
      (item) => [item.lineGlobalId, item.quantity],
    ),
  )
  let totalUnits = 0
  for (const line of shippingLines) {
    if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0) {
      blockers.push(blocker(
        'CARTONIZATION_LINE_QUANTITY_INVALID',
        'Line quantity is not an exact whole unit',
        `${line.title} has quantity ${line.quantity}.`,
        'Correct the provider mapping so the remaining fulfillment quantity is a positive integer.',
        'line',
        line.globalId,
      ))
    } else {
      totalUnits += line.quantity
    }
    if (
      line.mappingState !== 'resolved'
      || !line.productGlobalId
    ) {
      blockers.push(blocker(
        'CARTONIZATION_PRODUCT_MAPPING_REQUIRED',
        'Map the order line to a product',
        `${line.title} has no exact active ClawPilot product mapping.`,
        'Resolve this line to a product before previewing cartonization.',
        'line',
        line.globalId,
      ))
    }
    if (
      line.packagingState !== 'resolved'
      || !canonicalPositiveInteger(line.weightGrams)
      || !canonicalDimensions(line.dimensionsMm)
    ) {
      blockers.push(blocker(
        'CARTONIZATION_CANONICAL_PACKAGE_REQUIRED',
        'Complete product measurements',
        `${line.title} needs exact positive dimensions and weight.`,
        'Select an active package profile or enter exact dimensions and weight in your preferred units.',
        'line',
        line.globalId,
      ))
    }
    const assumed = assumptionByLine.get(line.globalId) || 0
    if (
      Number.isSafeInteger(line.quantity)
      && line.quantity > 0
      && assumed > line.quantity
    ) {
      blockers.push(blocker(
        'CARTONIZATION_ASSUMED_COMMITTED_EXCEEDS_LINE',
        'Assumed committed quantity exceeds line demand',
        `${line.globalId} assumes ${assumed}, but only ${line.quantity} units remain.`,
        'Reduce the assumed committed quantity to the candidate line demand or use zero for ATP only.',
        'line',
        line.globalId,
      ))
    }
  }
  if (totalUnits > MAX_OPTIMIZER_UNITS) {
    blockers.push(blocker(
      'CARTONIZATION_UNIT_BOUND_EXCEEDED',
      'Order exceeds the preview unit bound',
      `The order contains ${totalUnits} shippable units; this preview supports at most ${MAX_OPTIMIZER_UNITS}.`,
      'Split or reduce the development test order before running the strict optimizer.',
      'candidate',
      snapshot.candidate.globalId,
    ))
  }

  const positionsByProduct = new Map<string, typeof snapshot.inventoryPositions>()
  for (const position of snapshot.inventoryPositions) {
    const current = positionsByProduct.get(position.productGlobalId) || []
    current.push(position)
    positionsByProduct.set(position.productGlobalId, current)
  }
  const demandByProduct = new Map<string, number>()
  const assumedByProduct = new Map<string, number>()
  for (const line of shippingLines) {
    if (!line.productGlobalId || !Number.isSafeInteger(line.quantity)) continue
    demandByProduct.set(
      line.productGlobalId,
      (demandByProduct.get(line.productGlobalId) || 0) + line.quantity,
    )
    assumedByProduct.set(
      line.productGlobalId,
      (assumedByProduct.get(line.productGlobalId) || 0)
        + (assumptionByLine.get(line.globalId) || 0),
    )
  }
  const inventoryQuantityByProduct = new Map<string, {
    positionGlobalId: string
    quantity: number
  }>()
  for (const [productGlobalId, demand] of (
    accountInventorySupported ? demandByProduct : new Map<string, number>()
  )) {
    const positions = positionsByProduct.get(productGlobalId) || []
    if (positions.length !== 1) {
      blockers.push(blocker(
        positions.length
          ? 'CARTONIZATION_INVENTORY_POSITION_AMBIGUOUS'
          : 'CARTONIZATION_INVENTORY_PRODUCT_MISSING',
        positions.length
          ? 'Inventory position is ambiguous'
          : 'Mapped product has no current ATP evidence',
        positions.length
          ? `${productGlobalId} resolves to ${positions.length} current inventory positions.`
          : `${productGlobalId} is absent from the latest account-bound projected inventory evidence.`,
        positions.length
          ? 'Reconcile the account to one warehouse inventory position before retrying.'
          : 'Map and reconcile this provider inventory item before retrying.',
        'inventory',
        productGlobalId,
      ))
      continue
    }
    const position = positions[0]
    if (
      warehouse
      && position.warehouseGlobalId !== warehouse.globalId
    ) {
      blockers.push(blocker(
        'CARTONIZATION_INVENTORY_POSITION_WAREHOUSE_MISMATCH',
        'Product inventory belongs to another warehouse',
        `${position.positionGlobalId} belongs to ${position.warehouseGlobalId}, not ${warehouse.globalId}.`,
        'Reconcile this account and product against the single active warehouse before retrying.',
        'inventory',
        position.positionGlobalId,
      ))
      continue
    }
    if (
      !canonicalNonnegativeInteger(position.atpQuantity)
      || !canonicalNonnegativeInteger(position.providerCommittedQuantity)
    ) {
      blockers.push(blocker(
        'CARTONIZATION_INVENTORY_QUANTITY_INVALID',
        'Inventory evidence is not a whole-unit ATP balance',
        `${productGlobalId} has non-integer or negative inventory evidence.`,
        'Refresh provider inventory and resolve the quantity-state exception.',
        'inventory',
        position.positionGlobalId,
      ))
      continue
    }
    const assumed = assumedByProduct.get(productGlobalId) || 0
    if (assumed > position.providerCommittedQuantity) {
      blockers.push(blocker(
        'CARTONIZATION_ASSUMED_COMMITTED_EXCEEDS_EVIDENCE',
        'Assumed committed quantity exceeds provider evidence',
        `${productGlobalId} assumes ${assumed}, but the latest provider evidence contains ${position.providerCommittedQuantity} committed units.`,
        'Reduce the assumption or refresh the account-bound inventory evidence.',
        'inventory',
        position.positionGlobalId,
      ))
      continue
    }
    const eligibleQuantity = sumSafe([position.atpQuantity, assumed])
    if (eligibleQuantity === null) {
      blockers.push(blocker(
        'CARTONIZATION_INVENTORY_QUANTITY_INVALID',
        'Inventory quantity exceeds the safe computation bound',
        `${productGlobalId} cannot be represented as an exact optimizer quantity.`,
        'Correct the inventory evidence before retrying.',
        'inventory',
        position.positionGlobalId,
      ))
      continue
    }
    if (eligibleQuantity < demand) {
      blockers.push(blocker(
        'CARTONIZATION_INVENTORY_INSUFFICIENT',
        'ATP plus bounded candidate commitment is insufficient',
        `${productGlobalId} needs ${demand}; ATP ${position.atpQuantity} plus assumed candidate commitment ${assumed} provides ${eligibleQuantity}.`,
        'Refresh inventory or explicitly attribute only supported committed units to this candidate.',
        'inventory',
        position.positionGlobalId,
      ))
      continue
    }
    inventoryQuantityByProduct.set(productGlobalId, {
      positionGlobalId: position.positionGlobalId,
      quantity: eligibleQuantity,
    })
  }

  const materialById = new Map(
    snapshot.selectedMaterials.map((material) => [
      material.globalId,
      material,
    ]),
  )
  const eligibleMaterials: CartonizationPreviewSnapshot['selectedMaterials'] =
    []
  for (const materialGlobalId of request.materialGlobalIds) {
    const material = materialById.get(materialGlobalId)
    if (!material) {
      blockers.push(blocker(
        'CARTONIZATION_MATERIAL_NOT_FOUND',
        'Selected packaging material is unavailable',
        `${materialGlobalId} was not found in the active organization.`,
        'Reload Packaging materials and select an existing record.',
        'material',
        materialGlobalId,
      ))
      continue
    }
    let eligible = true
    if (material.status !== 'active') {
      eligible = false
      blockers.push(blocker(
        'CARTONIZATION_MATERIAL_NOT_ACTIVE',
        'Selected packaging material is not active',
        `${material.name} is ${material.status}.`,
        'Complete its physical, cost, and stock facts, then activate it.',
        'material',
        material.globalId,
      ))
    }
    if (
      !canonicalDimensions(material.innerDimensionsMm)
      || !canonicalPositiveInteger(material.tareWeightGrams)
      || !canonicalPositiveInteger(material.maxWeightGrams)
      || material.maxWeightGrams <= material.tareWeightGrams
    ) {
      eligible = false
      blockers.push(blocker(
        'CARTONIZATION_MATERIAL_MEASUREMENTS_INVALID',
        'Packaging material measurements are invalid',
        `${material.name} needs exact positive dimensions and weights, with maximum weight above tare.`,
        'Correct the material dimensions and weights in your preferred units before retrying.',
        'material',
        material.globalId,
      ))
    }
    if (
      !canonicalPositiveInteger(material.unitCostMinor)
      || Number(material.unitCostMinor) > MAX_SAFE_MINOR
      || material.currency !== snapshot.candidate.currency
    ) {
      eligible = false
      blockers.push(blocker(
        material.currency
          && material.currency !== snapshot.candidate.currency
          ? 'CARTONIZATION_MATERIAL_CURRENCY_MISMATCH'
          : 'CARTONIZATION_MATERIAL_COST_REQUIRED',
        material.currency
          && material.currency !== snapshot.candidate.currency
          ? 'Packaging material currency does not match the order'
          : 'Packaging material cost is required',
        material.currency
          && material.currency !== snapshot.candidate.currency
          ? `${material.name} is ${material.currency}; the order is ${snapshot.candidate.currency}.`
          : `${material.name} has no exact positive unit cost.`,
        'Record an exact material cost in the order currency before retrying.',
        'material',
        material.globalId,
      ))
    }
    const stock = warehouse
      ? material.stock.find(
          (item) => item.warehouseGlobalId === warehouse.globalId,
        )
      : null
    if (
      !stock
      || stock.warehouseStatus !== 'active'
      || !stock.isAvailable
      || !canonicalPositiveInteger(stock.onHandQuantity)
    ) {
      eligible = false
      blockers.push(blocker(
        'CARTONIZATION_MATERIAL_STOCK_REQUIRED',
        'Available packaging stock is required',
        `${material.name} has no exact positive available stock at the preview warehouse.`,
        'Record on-hand stock and mark it available at the active warehouse.',
        'material',
        material.globalId,
      ))
    }
    if (eligible) eligibleMaterials.push(material)
  }

  const result = baseResult(request, snapshot, blockers)
  if (blockers.length || !warehouse) return result
  if (!input.optimizer) {
    result.status = 'blocked'
    result.blockers.push(blocker(
      'CARTONIZATION_STRICT_OPTIMIZER_NOT_CONFIGURED',
      'Strict cartonization optimizer is not configured',
      'The read-only preview requires the authenticated OR-Tools service.',
      'Enable and configure the OR-Tools fulfillment optimizer in development.',
      'optimizer',
    ))
    return result
  }

  let optimization: FulfillmentOptimizationResultV1
  try {
    const requestInput = optimizerInput({
      request,
      snapshot,
      lines: shippingLines,
      inventoryQuantityByProduct,
      materials: eligibleMaterials,
      warehouse,
    })
    optimization = await input.optimizer.optimize(requestInput, {
      deadlineMs: input.options?.deadlineMs || 10_000,
      maxCandidates: input.options?.maxCandidates || 8,
    })
  } catch {
    result.status = 'blocked'
    result.blockers.push(blocker(
      'CARTONIZATION_STRICT_OPTIMIZER_UNAVAILABLE',
      'Strict cartonization optimizer is unavailable',
      'The OR-Tools request failed or returned evidence that did not pass the optimizer contract.',
      'Check the optimizer health and configuration, then retry this unchanged candidate revision.',
      'optimizer',
    ))
    return result
  }
  if (optimization.method !== 'or_tools') {
    result.status = 'blocked'
    result.blockers.push(blocker(
      'CARTONIZATION_DETERMINISTIC_FALLBACK_REJECTED',
      'Fallback cartonization was rejected',
      'This preview accepts only a validated OR-Tools result; no fallback plan is shown.',
      'Restore the OR-Tools service and retry this unchanged candidate revision.',
      'optimizer',
    ))
    return result
  }
  result.optimizer = {
    method: 'or_tools',
    status: optimization.status,
    algorithmVersion: optimization.algorithmVersion,
    inputHash: optimization.inputHash,
    durationMs: optimization.durationMs,
    selectedPlan: optimization.selectedPlan,
    candidates: optimization.candidates,
    rejectedAlternatives: optimization.rejectedAlternatives,
    explanation: optimization.explanation,
  }
  if (optimization.status === 'infeasible') {
    result.status = 'infeasible'
    result.blockers.push(blocker(
      'CARTONIZATION_NO_FEASIBLE_PLAN',
      'No feasible carton plan was found',
      'The selected materials, stock, inventory, dimensions, and weight limits cannot satisfy this candidate.',
      'Select another active material or correct the exact physical and inventory facts before retrying.',
      'optimizer',
    ))
    return result
  }
  if (
    !['optimal', 'feasible'].includes(optimization.status)
    || !optimization.selectedPlan
  ) {
    result.status = 'blocked'
    result.blockers.push(blocker(
      'CARTONIZATION_STRICT_OPTIMIZER_INCOMPLETE',
      'Strict cartonization did not complete',
      `The OR-Tools result ended with ${optimization.status} and no usable plan.`,
      'Check optimizer capacity and health, then retry this unchanged candidate revision.',
      'optimizer',
    ))
    return result
  }
  result.status = 'ready'
  return result
}
