import { createHash } from 'node:crypto'
import type { PoolClient, QueryResultRow } from 'pg'
import {
  OPERATIONS_REGRESSION_REPLAY_SCHEMA_VERSION,
  type OperationsRegressionCustomerMode,
  type OperationsRegressionMarketplaceEstimateStage,
  type OperationsRegressionPackage,
  type OperationsRegressionPackRateStage,
  type OperationsRegressionRateChoice,
  type OperationsRegressionRun,
  type OperationsRegressionScenario,
  type OperationsRegressionWalkthrough,
} from '@/lib/operations/regressionReplay'
import {
  HYBRID_CARTONIZATION_ALGORITHM_VERSION,
  HYBRID_CARTONIZATION_POLICY_VERSION,
  planHybridCartonization,
  type HybridCartonizationInput,
} from '@/lib/operations/hybridCartonization'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import {
  acquireTransactionAdvisoryLock,
  getPostgresPool,
  withTransaction,
} from '@/lib/persistence/postgres'
import { persistOperationsRegressionPackingSlipArtifactWithClient } from '@/lib/persistence/operationsRegressionArtifacts'

const TRUSTED_RAILWAY_PROJECT_ID = 'b5169ebd-8166-4b96-9a81-7cc8adaa9270'
const TRUSTED_RAILWAY_DEV_ENVIRONMENT_ID =
  'e4abd95f-825c-4242-b37b-825a92597e98'
const RECORDED_FACT_VERSION = 'sanitized-development-replay-2026-07-29'
const CURRENCY = 'USD'
const PRICING_SEMANTICS_VERSION = 2 as const

type AllocationDefinition = {
  lineKey: string
  quantity: number
}

type PackageDefinition = {
  packageKey: string
  materialCode: string
  materialName: string
  dimensionsMm: { length: number; width: number; height: number }
  tareWeightGrams: number
  allocations: AllocationDefinition[]
}

type PassDefinition = {
  packages: PackageDefinition[]
  rates: Array<Omit<OperationsRegressionRateChoice, 'selected' | 'currency' | 'recordedFactVersion'>>
  selectedProvider: OperationsRegressionRateChoice['provider']
  selectedServiceCode: string
  checkoutShippingChargeMinor: number
}

type ScenarioDefinition = OperationsRegressionScenario & {
  finalized: boolean
  expectedBlocker: string | null
  capturedMarketplaceEstimateMinor: number | null
  checkout: PassDefinition | null
  fulfillment: PassDefinition | null
}

const AG12V2 = {
  materialCode: 'AG12V2',
  materialName: 'AG12V2 shipping carton',
  dimensionsMm: { length: 279, width: 229, height: 178 },
  tareWeightGrams: 250,
}
const TWENTY_POUND_CARTON = {
  materialCode: '20LB-BOX',
  materialName: '20 lb shipping carton',
  dimensionsMm: { length: 432, width: 279, height: 178 },
  tareWeightGrams: 390,
}
const CARTON_2OZ = {
  materialCode: 'CARTON-2OZ',
  materialName: '2 oz display-carton shipping box',
  dimensionsMm: { length: 356, width: 279, height: 203 },
  tareWeightGrams: 310,
}

function packageDefinition(
  packageKey: string,
  material: Omit<PackageDefinition, 'packageKey' | 'allocations'>,
  allocations: AllocationDefinition[],
): PackageDefinition {
  return { packageKey, ...material, allocations }
}

function rates(base: number) {
  return [
    {
      provider: 'ups_rest' as const,
      serviceCode: '03',
      serviceName: 'UPS Ground',
      carrierCostMinor: base,
    },
    {
      provider: 'fedex_rest' as const,
      serviceCode: 'FEDEX_GROUND',
      serviceName: 'FedEx Ground',
      carrierCostMinor: base + 135,
    },
    {
      provider: 'ups_rest' as const,
      serviceCode: '02',
      serviceName: 'UPS 2nd Day Air',
      carrierCostMinor: base + 2140,
    },
    {
      provider: 'fedex_rest' as const,
      serviceCode: 'FEDEX_2_DAY',
      serviceName: 'FedEx 2Day',
      carrierCostMinor: base + 2265,
    },
  ]
}

const scenarioDefinitions: ScenarioDefinition[] = [
  {
    id: 'shopify-finalized-multi-package',
    title: 'Shopify finalized mixed multi-package order',
    description:
      'Replays an immutable Shopify checkout quote, CRM reuse, fulfillment rerating, and one tracked packing slip for every package.',
    provider: 'shopify',
    checkoutSource: 'live_callback_recorded',
    sourceReference: 'recorded-shopify-order-1042',
    customerMode: 'reuse',
    expectedCheckoutPackages: 4,
    expectedFulfillmentPackages: 4,
    lines: [
      {
        productKey: 'recorded-ag-6oz-bag',
        title: 'Recorded apple crisp 6 oz bag',
        checkoutQuantity: 24,
        fulfillmentQuantity: 24,
        unitWeightGrams: 170,
      },
      {
        productKey: 'recorded-ag-2oz-bag',
        title: 'Recorded apple crisp 2 oz bag',
        checkoutQuantity: 36,
        fulfillmentQuantity: 36,
        unitWeightGrams: 57,
      },
      {
        productKey: 'recorded-ag-20lb-bulk',
        title: 'Recorded apple crisp 20 lb bulk',
        checkoutQuantity: 1,
        fulfillmentQuantity: 1,
        unitWeightGrams: 9072,
      },
    ],
    regressionFocus: [
      'customer_neutral_checkout',
      'multi_package',
      'one_service_all_packages',
      'tracked_package_documents',
    ],
    finalized: true,
    expectedBlocker: null,
    capturedMarketplaceEstimateMinor: null,
    checkout: {
      packages: [
        packageDefinition('checkout-package-1', AG12V2, [{ lineKey: 'line-1', quantity: 12 }]),
        packageDefinition('checkout-package-2', AG12V2, [{ lineKey: 'line-1', quantity: 12 }]),
        packageDefinition('checkout-package-3', AG12V2, [{ lineKey: 'line-2', quantity: 36 }]),
        packageDefinition('checkout-package-4', TWENTY_POUND_CARTON, [{ lineKey: 'line-3', quantity: 1 }]),
      ],
      rates: rates(4285),
      selectedProvider: 'ups_rest',
      selectedServiceCode: '03',
      checkoutShippingChargeMinor: 5125,
    },
    fulfillment: {
      packages: [
        packageDefinition('fulfillment-package-1', AG12V2, [{ lineKey: 'line-1', quantity: 12 }]),
        packageDefinition('fulfillment-package-2', AG12V2, [{ lineKey: 'line-1', quantity: 12 }]),
        packageDefinition('fulfillment-package-3', AG12V2, [{ lineKey: 'line-2', quantity: 36 }]),
        packageDefinition('fulfillment-package-4', TWENTY_POUND_CARTON, [{ lineKey: 'line-3', quantity: 1 }]),
      ],
      rates: rates(4510),
      selectedProvider: 'ups_rest',
      selectedServiceCode: '03',
      checkoutShippingChargeMinor: 5125,
    },
  },
  {
    id: 'shopify-successful-pre-label',
    title: 'Shopify successful pre-label fulfillment',
    description:
      'Proves a new CRM customer and a completed two-package rerate while final packing slips remain blocked until tracking exists.',
    provider: 'shopify',
    checkoutSource: 'live_callback_recorded',
    sourceReference: 'recorded-shopify-order-1057',
    customerMode: 'new',
    expectedCheckoutPackages: 2,
    expectedFulfillmentPackages: 2,
    lines: [
      {
        productKey: 'recorded-ag-6oz-bag',
        title: 'Recorded apple crisp 6 oz bag',
        checkoutQuantity: 12,
        fulfillmentQuantity: 12,
        unitWeightGrams: 170,
      },
      {
        productKey: 'recorded-ag-2oz-carton',
        title: 'Recorded 2 oz display carton',
        checkoutQuantity: 6,
        fulfillmentQuantity: 6,
        unitWeightGrams: 342,
      },
    ],
    regressionFocus: [
      'crm_create_after_intake',
      'pre_label_gate',
      'one_service_all_packages',
    ],
    finalized: false,
    expectedBlocker: null,
    capturedMarketplaceEstimateMinor: null,
    checkout: {
      packages: [
        packageDefinition('checkout-package-1', AG12V2, [{ lineKey: 'line-1', quantity: 12 }]),
        packageDefinition('checkout-package-2', CARTON_2OZ, [{ lineKey: 'line-2', quantity: 6 }]),
      ],
      rates: rates(2140),
      selectedProvider: 'ups_rest',
      selectedServiceCode: '03',
      checkoutShippingChargeMinor: 2640,
    },
    fulfillment: {
      packages: [
        packageDefinition('fulfillment-package-1', AG12V2, [{ lineKey: 'line-1', quantity: 12 }]),
        packageDefinition('fulfillment-package-2', CARTON_2OZ, [{ lineKey: 'line-2', quantity: 6 }]),
      ],
      rates: rates(2215),
      selectedProvider: 'ups_rest',
      selectedServiceCode: '03',
      checkoutShippingChargeMinor: 2640,
    },
  },
  {
    id: 'faire-captured-estimate',
    title: 'Faire captured estimate then post-intake rating',
    description:
      'Preserves only Faire marketplace estimate evidence at checkout; ClawPilot cartonization and UPS/FedEx comparison begin after order intake.',
    provider: 'faire',
    checkoutSource: 'faire_checkout_estimate_captured',
    sourceReference: 'recorded-faire-order-208',
    customerMode: 'new',
    expectedCheckoutPackages: 0,
    expectedFulfillmentPackages: 1,
    lines: [
      {
        productKey: 'recorded-ag-6oz-bag',
        title: 'Recorded apple crisp 6 oz bag',
        checkoutQuantity: 12,
        fulfillmentQuantity: 12,
        unitWeightGrams: 170,
      },
    ],
    regressionFocus: [
      'faire_no_checkout_callback',
      'captured_marketplace_estimate',
      'post_intake_pack_and_rate',
    ],
    finalized: false,
    expectedBlocker: null,
    capturedMarketplaceEstimateMinor: 1895,
    checkout: null,
    fulfillment: {
      packages: [
        packageDefinition('fulfillment-package-1', AG12V2, [{ lineKey: 'line-1', quantity: 12 }]),
      ],
      rates: rates(1575),
      selectedProvider: 'ups_rest',
      selectedServiceCode: '03',
      checkoutShippingChargeMinor: 1895,
    },
  },
  {
    id: 'shopify-ambiguous-crm',
    title: 'Shopify ambiguous CRM customer blocker',
    description:
      'Retains a valid customer-neutral checkout quote, then proves that two actual CRM candidates stop fulfillment before any package or provider action.',
    provider: 'shopify',
    checkoutSource: 'live_callback_recorded',
    sourceReference: 'recorded-shopify-order-1099',
    customerMode: 'ambiguous',
    expectedCheckoutPackages: 1,
    expectedFulfillmentPackages: 0,
    lines: [
      {
        productKey: 'recorded-ag-10lb-bulk',
        title: 'Recorded apple crisp 10 lb bulk',
        checkoutQuantity: 1,
        fulfillmentQuantity: 1,
        unitWeightGrams: 4536,
      },
    ],
    regressionFocus: [
      'customer_neutral_checkout',
      'actual_crm_ambiguity',
      'fail_closed_before_fulfillment',
    ],
    finalized: false,
    expectedBlocker: 'CRM_CUSTOMER_AMBIGUOUS',
    capturedMarketplaceEstimateMinor: null,
    checkout: {
      packages: [
        packageDefinition('checkout-package-1', AG12V2, [{ lineKey: 'line-1', quantity: 1 }]),
      ],
      rates: rates(1640),
      selectedProvider: 'ups_rest',
      selectedServiceCode: '03',
      checkoutShippingChargeMinor: 1980,
    },
    fulfillment: null,
  },
]

export class OperationsRegressionReplayError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status = 400) {
    super(message)
    this.name = 'OperationsRegressionReplayError'
    this.code = code
    this.status = status
  }
}

export function assertOperationsRegressionReplayRuntime(
  env: NodeJS.ProcessEnv = process.env,
) {
  const explicitLanes = [
    env.CLAWPILOT_ENV,
    env.RUNTIME_LANE,
    env.RAILWAY_ENVIRONMENT_NAME,
    env.VERCEL_ENV,
  ].map((value) => String(value || '').trim().toLowerCase()).filter(Boolean)
  if (explicitLanes.some((value) => ['prod', 'production'].includes(value))) {
    throw new OperationsRegressionReplayError(
      'OPERATIONS_REGRESSION_DEV_ONLY',
      'Pack-and-rate regression replays are available only in a development or preview lane; an authoritative runtime marker identifies production.',
      404,
    )
  }
  const lane = explicitLanes[0]
    || String(env.NODE_ENV || '').trim().toLowerCase()
  if (!['dev', 'development', 'local', 'preview'].includes(lane)) {
    throw new OperationsRegressionReplayError(
      'OPERATIONS_REGRESSION_DEV_ONLY',
      'Pack-and-rate regression replays are available only in a development or preview lane.',
      404,
    )
  }

  const hasRailwayMarker = Boolean(
    env.RAILWAY_PROJECT_ID
    || env.RAILWAY_ENVIRONMENT_ID
    || env.RAILWAY_ENVIRONMENT_NAME,
  )
  if (
    hasRailwayMarker
    && (
      env.RAILWAY_PROJECT_ID !== TRUSTED_RAILWAY_PROJECT_ID
      || env.RAILWAY_ENVIRONMENT_ID !== TRUSTED_RAILWAY_DEV_ENVIRONMENT_ID
    )
  ) {
    throw new OperationsRegressionReplayError(
      'OPERATIONS_REGRESSION_UNTRUSTED_RAILWAY_LANE',
      'The regression replay is restricted to the trusted ClawPilot Railway development environment.',
      404,
    )
  }
  if (!isPostgresStorageEnabled()) {
    throw new OperationsRegressionReplayError(
      'OPERATIONS_REGRESSION_POSTGRES_REQUIRED',
      'Pack-and-rate regression replay requires Postgres storage.',
      503,
    )
  }
}

export function operationsRegressionScenarios(): OperationsRegressionScenario[] {
  return scenarioDefinitions.map((scenario) => ({
    id: scenario.id,
    title: scenario.title,
    description: scenario.description,
    provider: scenario.provider,
    checkoutSource: scenario.checkoutSource,
    sourceReference: scenario.sourceReference,
    customerMode: scenario.customerMode,
    expectedCheckoutPackages: scenario.expectedCheckoutPackages,
    expectedFulfillmentPackages: scenario.expectedFulfillmentPackages,
    lines: scenario.lines.map((line) => ({ ...line })),
    regressionFocus: [...scenario.regressionFocus],
  }))
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    )
  }
  return value
}

function stableJson(value: unknown) {
  return JSON.stringify(canonicalize(value))
}

function sha256(value: unknown) {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

function scenarioById(scenarioId: string) {
  const scenario = scenarioDefinitions.find((item) => item.id === scenarioId)
  if (!scenario) {
    throw new OperationsRegressionReplayError(
      'OPERATIONS_REGRESSION_SCENARIO_NOT_FOUND',
      'The selected regression scenario is unavailable.',
      404,
    )
  }
  return scenario
}

type ReplayContext = {
  pipelineId: string
  actorEmail: string
}

type CustomerResolution = {
  requestedMode: OperationsRegressionCustomerMode
  outcome: 'created' | 'reused' | 'ambiguous'
  customerId: string | null
  customerGlobalId: string | null
  identityKey: string
  candidateCount: number
  candidateGlobalIds: string[]
  detail: string
}

type InsertedRun = {
  id: string
  globalId: string
  createdAt: string
  expiresAt: string | null
}

type RunInsert = {
  organizationId: string
  scenario: ScenarioDefinition
  replayGroupKey: string
  purpose: 'checkout_quote' | 'fulfillment_execution'
  priorCheckoutRunId: string | null
  pipelineId: string | null
  customerId: string | null
  customerResolutionOutcome:
    | 'not_attempted'
    | 'created'
    | 'reused'
    | 'ambiguous'
  status: 'succeeded' | 'blocked'
  blockerCode: string | null
  pass: PassDefinition | null
  checkoutShippingChargeMinor: number | null
  inputSnapshot: Record<string, unknown>
  resultSnapshot: Record<string, unknown>
  stageSnapshot: Record<string, unknown>
  idempotencyKey: string
  actorEmail: string
}

async function resolveReplayContext(
  client: PoolClient,
  organizationId: string,
  requestedActorEmail: string,
): Promise<ReplayContext> {
  const result = await client.query<{
    pipeline_id: string
    actor_email: string
  }>(
    `SELECT
       activation.data_pipeline_id::text AS pipeline_id,
       actor.email AS actor_email
     FROM operations_activation_scopes activation
     JOIN pipeline_spaces pipeline
       ON pipeline.workspace_organization_id = activation.organization_id
      AND pipeline.id = activation.data_pipeline_id
     JOIN app_users actor
       ON lower(actor.email) = lower($2)
      AND actor.status = 'active'
     WHERE activation.organization_id = $1::uuid
     LIMIT 1`,
    [organizationId, requestedActorEmail],
  )
  if (!result.rows[0]) {
    throw new OperationsRegressionReplayError(
      'OPERATIONS_REGRESSION_CONTEXT_REQUIRED',
      'The active organization needs an Operations CRM pipeline and an active replay actor.',
      409,
    )
  }
  return {
    pipelineId: result.rows[0].pipeline_id,
    actorEmail: result.rows[0].actor_email,
  }
}

async function insertReplayCustomer(
  client: PoolClient,
  input: {
    pipelineId: string
    identityKey: string
    name: string
    matchKey: string
    scenarioId: string
    actorEmail: string
  },
) {
  const sourcePayload = {
    replayOnly: true,
    noExternalSync: true,
    regressionReplayMatchKey: input.matchKey,
    scenarioId: input.scenarioId,
  }
  const result = await client.query<{
    id: string
    reference_code: string
  }>(
    `INSERT INTO crm_organizations (
       pipeline_id, source_key, identity_key, name, account_type,
       relationship_type, description, source_payload, source_hash,
       sync_status, created_by, updated_by
     ) VALUES (
       $1::uuid, $2, $2, $3, 'customer', 'customer',
       'Sanitized development regression replay customer. No external sync.',
       $4::jsonb, $5, 'synced', $6, $6
     )
     ON CONFLICT (pipeline_id, identity_key) DO NOTHING
     RETURNING id::text, reference_code`,
    [
      input.pipelineId,
      input.identityKey,
      input.name,
      JSON.stringify(sourcePayload),
      sha256(sourcePayload),
      input.actorEmail,
    ],
  )
  return result.rows[0] || null
}

async function readReplayCustomers(
  client: PoolClient,
  pipelineId: string,
  matchKey: string,
) {
  const result = await client.query<{
    id: string
    reference_code: string
    identity_key: string
  }>(
    `SELECT id::text, reference_code, identity_key
     FROM crm_organizations
     WHERE pipeline_id = $1::uuid
       AND relationship_type = 'customer'
       AND source_payload->>'replayOnly' = 'true'
       AND source_payload->>'regressionReplayMatchKey' = $2
     ORDER BY reference_code`,
    [pipelineId, matchKey],
  )
  return result.rows
}

async function seedReusableReplayCustomerFixture(
  client: PoolClient,
  input: {
    organizationId: string
    pipelineId: string
    actorEmail: string
    scenario: ScenarioDefinition
  },
) {
  if (input.scenario.customerMode !== 'reuse') return
  const baseKey = `regression-replay:${input.organizationId}:${input.scenario.id}`
  await insertReplayCustomer(client, {
    pipelineId: input.pipelineId,
    identityKey: `${baseKey}:customer`,
    name: 'Recorded replay existing customer fixture',
    matchKey: `${baseKey}:customer-match`,
    scenarioId: input.scenario.id,
    actorEmail: input.actorEmail,
  })
}

/**
 * Deliberately runs after the customer-neutral checkout snapshot has been
 * inserted. This is the post-intake CRM create/reuse/ambiguity boundary.
 */
async function resolveReplayCustomerAfterIntake(
  client: PoolClient,
  input: {
    organizationId: string
    pipelineId: string
    actorEmail: string
    scenario: ScenarioDefinition
  },
): Promise<CustomerResolution> {
  const baseKey = `regression-replay:${input.organizationId}:${input.scenario.id}`
  const matchKey = `${baseKey}:customer-match`
  if (input.scenario.customerMode === 'ambiguous') {
    await insertReplayCustomer(client, {
      pipelineId: input.pipelineId,
      identityKey: `${baseKey}:candidate-a`,
      name: 'Recorded replay customer candidate A',
      matchKey,
      scenarioId: input.scenario.id,
      actorEmail: input.actorEmail,
    })
    await insertReplayCustomer(client, {
      pipelineId: input.pipelineId,
      identityKey: `${baseKey}:candidate-b`,
      name: 'Recorded replay customer candidate B',
      matchKey,
      scenarioId: input.scenario.id,
      actorEmail: input.actorEmail,
    })
    const candidates = await readReplayCustomers(client, input.pipelineId, matchKey)
    if (candidates.length !== 2) {
      throw new OperationsRegressionReplayError(
        'OPERATIONS_REGRESSION_AMBIGUITY_SEED_INVALID',
        'The replay could not establish exactly two CRM candidates.',
        409,
      )
    }
    return {
      requestedMode: 'ambiguous',
      outcome: 'ambiguous',
      customerId: null,
      customerGlobalId: null,
      identityKey: matchKey,
      candidateCount: candidates.length,
      candidateGlobalIds: candidates.map((candidate) => candidate.reference_code),
      detail:
        'Two actual replay-only CRM customer candidates matched after intake; fulfillment stopped before packing or rating.',
    }
  }

  const identityKey = `${baseKey}:customer`
  if (input.scenario.customerMode === 'reuse') {
    const candidates = await readReplayCustomers(client, input.pipelineId, matchKey)
    const exact = candidates.filter((candidate) => candidate.identity_key === identityKey)
    if (exact.length !== 1) {
      throw new OperationsRegressionReplayError(
        'OPERATIONS_REGRESSION_REUSE_INVALID',
        'The replay expected exactly one reusable CRM customer.',
        409,
      )
    }
    return {
      requestedMode: 'reuse',
      outcome: 'reused',
      customerId: exact[0].id,
      customerGlobalId: exact[0].reference_code,
      identityKey,
      candidateCount: 1,
      candidateGlobalIds: [exact[0].reference_code],
      detail:
        'One actual replay-only CRM organization was reused after order intake.',
    }
  }

  const inserted = await insertReplayCustomer(client, {
    pipelineId: input.pipelineId,
    identityKey,
    name: `Recorded replay customer for ${input.scenario.title}`,
    matchKey,
    scenarioId: input.scenario.id,
    actorEmail: input.actorEmail,
  })
  if (!inserted) {
    throw new OperationsRegressionReplayError(
      'OPERATIONS_REGRESSION_CREATE_CONFLICT',
      'The deterministic replay customer already exists without a persisted replay run.',
      409,
    )
  }
  return {
    requestedMode: 'new',
    outcome: 'created',
    customerId: inserted.id,
    customerGlobalId: inserted.reference_code,
    identityKey,
    candidateCount: 1,
    candidateGlobalIds: [inserted.reference_code],
    detail:
      'One actual replay-only CRM organization was created after order intake.',
  }
}

function selectedRate(pass: PassDefinition) {
  const selected = pass.rates.find((rate) => (
    rate.provider === pass.selectedProvider
    && rate.serviceCode === pass.selectedServiceCode
  ))
  if (!selected) {
    throw new Error('OPERATIONS_REGRESSION_SELECTED_RATE_INVALID')
  }
  return selected
}

async function insertRun(
  client: PoolClient,
  input: RunInsert,
): Promise<InsertedRun> {
  const selected = input.pass ? selectedRate(input.pass) : null
  const lineCount = input.status === 'succeeded' && input.pass
    ? input.scenario.lines.length
    : 0
  const packageCount = input.status === 'succeeded' && input.pass
    ? input.pass.packages.length
    : 0
  const estimatedShippingVarianceMinor =
    selected && input.checkoutShippingChargeMinor !== null
      ? input.checkoutShippingChargeMinor - selected.carrierCostMinor
    : null
  const result = await client.query<{
    id: string
    global_id: string
    created_at: Date
    expires_at: Date | null
  }>(
    `INSERT INTO operations_pack_rate_runs (
       organization_id, replay_group_key, scenario_id, source_kind,
       source_reference, provider, checkout_source, purpose,
       prior_checkout_run_id, pipeline_id, customer_id,
       customer_resolution_outcome, status, blocker_code, policy_version,
       algorithm_version, input_hash, result_hash, input_snapshot,
       result_snapshot, stage_snapshot, line_count, package_count,
       rate_choice_count, currency,
       selected_provider, selected_service_code, selected_service_name,
       selected_carrier_cost_minor, customer_charge_minor, mud_markup_minor,
       margin_minor, idempotency_key, actor_email, pricing_semantics_version,
       provider_write_count,
       postage_purchase_count, label_write_count, expires_at
     ) VALUES (
       $1::uuid, $2, $3, 'sanitized_historical_replay', $4, $5, $6, $7,
       $8::uuid, $9::uuid, $10::uuid, $11, $12, $13, $14, $15, $16, $17,
       $18::jsonb, $19::jsonb, $20::jsonb, $21, $22, $23, $24, $25, $26,
       $27, $28, $29, NULL, $30, $31, $32, $33, 0, 0, 0,
       CASE WHEN $7 = 'checkout_quote'
         THEN now() + interval '15 minutes'
         ELSE NULL
       END
     )
     RETURNING id::text, global_id, created_at, expires_at`,
    [
      input.organizationId,
      input.replayGroupKey,
      input.scenario.id,
      input.scenario.sourceReference,
      input.scenario.provider,
      input.scenario.checkoutSource,
      input.purpose,
      input.priorCheckoutRunId,
      input.pipelineId,
      input.customerId,
      input.customerResolutionOutcome,
      input.status,
      input.blockerCode,
      HYBRID_CARTONIZATION_POLICY_VERSION,
      HYBRID_CARTONIZATION_ALGORITHM_VERSION,
      sha256(input.inputSnapshot),
      sha256(input.resultSnapshot),
      JSON.stringify(input.inputSnapshot),
      JSON.stringify(input.resultSnapshot),
      JSON.stringify(input.stageSnapshot),
      lineCount,
      packageCount,
      input.status === 'succeeded' && input.pass
        ? input.pass.rates.length
        : 0,
      CURRENCY,
      selected?.provider || null,
      selected?.serviceCode || null,
      selected?.serviceName || null,
      selected?.carrierCostMinor ?? null,
      input.checkoutShippingChargeMinor,
      estimatedShippingVarianceMinor,
      input.idempotencyKey,
      input.actorEmail,
      PRICING_SEMANTICS_VERSION,
    ],
  )
  const row = result.rows[0]
  return {
    id: row.id,
    globalId: row.global_id,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at?.toISOString() || null,
  }
}

function requiredQuantity(
  scenario: ScenarioDefinition,
  lineIndex: number,
  purpose: 'checkout_quote' | 'fulfillment_execution',
) {
  const line = scenario.lines[lineIndex]
  return purpose === 'checkout_quote'
    ? line.checkoutQuantity
    : line.fulfillmentQuantity
}

function optimizerPass(
  scenario: ScenarioDefinition,
  pass: PassDefinition,
  purpose: 'checkout_quote' | 'fulfillment_execution',
) {
  const evidenceTimestamp = '2026-07-28T12:00:00.000Z'
  const materialDefinitions = new Map(
    pass.packages.map((item) => [
      `regression-material-${item.materialCode.toLowerCase()}`,
      item,
    ]),
  )
  const materials: HybridCartonizationInput['materials'] =
    [...materialDefinitions.entries()].map(([materialGlobalId, item]) => ({
      materialGlobalId,
      capturedRowVersion: 1,
      currentRowVersion: 1,
      isCurrent: true,
      status: 'active',
      innerDimensionsMm: { ...item.dimensionsMm },
      dimensionBasis: 'inner',
      dimensionEvidenceType: 'customer_confirmed',
      dimensionEvidenceReference: 'ag-customer-pack-facts-2026-07-29',
      dimensionConfirmedAt: evidenceTimestamp,
      tareWeightGrams: item.tareWeightGrams,
      ratedOuterDimensionsMm: { ...item.dimensionsMm },
    }))
  const lines: HybridCartonizationInput['lines'] = scenario.lines.map(
    (line, index) => ({
      lineGlobalId: `line-${index + 1}`,
      productGlobalId: line.productKey,
      title: line.title,
      quantity: requiredQuantity(scenario, index, purpose),
      unitWeightGrams: line.unitWeightGrams,
      profile: {
        versionGlobalId: `regression-profile-${index + 1}`,
        capturedRowVersion: 1,
        currentRowVersion: 1,
        isCurrent: true,
        lifecycleState: 'active',
        fitModel: 'approved_recipe_only',
        evidenceType: 'customer_confirmed',
        evidenceReference: 'ag-customer-product-pack-facts-2026-07-29',
        confirmedAt: evidenceTimestamp,
      },
    }),
  )
  const recipes: HybridCartonizationInput['recipes'] = lines.map(
    (line, index) => {
      const lineKey = `line-${index + 1}`
      const expectedPackages = pass.packages.filter((item) => (
        item.allocations.some((allocation) => allocation.lineKey === lineKey)
      ))
      const materialCodes = new Set(
        expectedPackages.map((item) => item.materialCode),
      )
      const capacities = expectedPackages.flatMap((item) => (
        item.allocations
          .filter((allocation) => allocation.lineKey === lineKey)
          .map((allocation) => allocation.quantity)
      ))
      if (
        expectedPackages.length < 1
        || materialCodes.size !== 1
        || capacities.length < 1
        || new Set(capacities).size !== 1
      ) {
        throw new Error(
          'OPERATIONS_REGRESSION_OPTIMIZER_FIXTURE_AMBIGUOUS',
        )
      }
      const materialCode = [...materialCodes][0]
      return {
        recipeGlobalId: `regression-recipe-${index + 1}`,
        productGlobalId: line.productGlobalId,
        inputPackProfileVersionGlobalId: line.profile.versionGlobalId,
        outputPackProfileVersionGlobalId:
          `regression-output-profile-${index + 1}`,
        packagingMaterialGlobalId:
          `regression-material-${materialCode.toLowerCase()}`,
        recipeType: 'exact_case',
        maximumInputQuantity: capacities[0],
        minimumInputQuantity: capacities[0],
        contentCompatibilityKey: null,
        allowsMixedProducts: false,
        exclusiveContents: true,
        capturedRowVersion: 1,
        currentRowVersion: 1,
        isCurrent: true,
        lifecycleState: 'active',
        fitEvidenceType: 'customer_confirmed',
        fitEvidenceReference: 'ag-customer-case-pack-facts-2026-07-29',
        confirmedAt: evidenceTimestamp,
      }
    },
  )
  const optimizerInput: HybridCartonizationInput = {
    mode: 'production',
    lines,
    recipes,
    materials,
  }
  const optimizerResult = planHybridCartonization(optimizerInput)
  if (
    optimizerResult.status !== 'ready'
    || optimizerResult.blockers.length > 0
    || optimizerResult.geometryFallbackLines.length > 0
    || optimizerResult.recipePackages.some(
      (item) => item.rateReadiness.status !== 'ready',
    )
  ) {
    throw new OperationsRegressionReplayError(
      'OPERATIONS_REGRESSION_OPTIMIZER_DIVERGED',
      'The current cartonization policy no longer reproduces the approved replay fixture.',
      409,
    )
  }
  const packages: OperationsRegressionPackage[] =
    optimizerResult.recipePackages.map((item) => {
      const material = materialDefinitions.get(
        item.packagingMaterialGlobalId,
      )
      const ratedDimensions = item.rateReadiness.ratedOuterDimensionsMm
      const tareWeightGrams = item.rateReadiness.tareWeightGrams
      const grossWeightGrams = item.rateReadiness.ratedWeightGrams
      if (
        !material
        || !ratedDimensions
        || tareWeightGrams === null
        || grossWeightGrams === null
      ) {
        throw new Error('OPERATIONS_REGRESSION_OPTIMIZER_RATE_FACTS_MISSING')
      }
      return {
        packageKey: item.packageKey,
        sequence: item.sequence,
        materialCode: material.materialCode,
        materialName: material.materialName,
        dimensionsMm: ratedDimensions,
        contentWeightGrams: item.contentWeightGrams,
        tareWeightGrams,
        grossWeightGrams,
        allocations: item.lineAllocations.map((allocation) => ({
          lineKey: allocation.lineGlobalId,
          productKey: allocation.productGlobalId,
          title: allocation.title,
          quantity: allocation.quantity,
        })),
      }
    }
  )
  const normalized = (items: Array<{
    materialCode: string
    allocations: Array<{ lineKey: string; quantity: number }>
  }>) => items.map((item) => ({
    materialCode: item.materialCode,
    allocations: [...item.allocations]
      .map(({ lineKey, quantity }) => ({ lineKey, quantity }))
      .sort((left, right) => left.lineKey.localeCompare(right.lineKey)),
  })).sort((left, right) => (
    left.materialCode.localeCompare(right.materialCode)
    || stableJson(left.allocations).localeCompare(stableJson(right.allocations))
  ))
  if (
    stableJson(normalized(packages))
    !== stableJson(normalized(pass.packages))
  ) {
    throw new OperationsRegressionReplayError(
      'OPERATIONS_REGRESSION_OPTIMIZER_DIVERGED',
      'The current cartonization result differs from the approved replay package oracle.',
      409,
    )
  }
  return { optimizerInput, optimizerResult, packages }
}

function passFacts(
  scenario: ScenarioDefinition,
  pass: PassDefinition,
  purpose: 'checkout_quote' | 'fulfillment_execution',
) {
  const optimization = optimizerPass(scenario, pass, purpose)
  const packages = optimization.packages
  const rateChoices: OperationsRegressionRateChoice[] = pass.rates.map((rate) => ({
    ...rate,
    currency: CURRENCY,
    selected: (
      rate.provider === pass.selectedProvider
      && rate.serviceCode === pass.selectedServiceCode
    ),
    recordedFactVersion: RECORDED_FACT_VERSION,
  }))
  const selected = rateChoices.find((rate) => rate.selected)
  if (!selected) throw new Error('OPERATIONS_REGRESSION_SELECTED_RATE_INVALID')
  const requiredLines = scenario.lines.map((line, index) => ({
    lineKey: `line-${index + 1}`,
    productKey: line.productKey,
    title: line.title,
    requiredQuantity: requiredQuantity(scenario, index, purpose),
    unitWeightGrams: line.unitWeightGrams,
  }))
  const allocationFacts = packages.flatMap((item) => item.allocations.map(
    (allocation) => ({
      packageKey: item.packageKey,
      lineKey: allocation.lineKey,
      productKey: allocation.productKey,
      quantity: allocation.quantity,
    }),
  ))
  const materialFacts = packages.map((item) => ({
    packageKey: item.packageKey,
    materialCode: item.materialCode,
    dimensionsMm: item.dimensionsMm,
  }))
  const packagePlanHash = sha256(packages.map((item) => ({
    packageKey: item.packageKey,
    sequence: item.sequence,
    materialCode: item.materialCode,
    dimensionsMm: item.dimensionsMm,
    grossWeightGrams: item.grossWeightGrams,
    allocations: item.allocations,
  })))
  return {
    packages,
    rateChoices,
    selected,
    requiredLines,
    allocationHash: sha256(allocationFacts),
    materialHash: sha256(materialFacts),
    serviceHash: sha256({
      provider: selected.provider,
      serviceCode: selected.serviceCode,
    }),
    packagePlanHash,
    optimizerInputHash: optimization.optimizerResult.inputHash,
    optimizerResultHash: optimization.optimizerResult.resultHash,
    optimizerPolicyVersion: optimization.optimizerResult.policyVersion,
    optimizerAlgorithmVersion: optimization.optimizerResult.algorithmVersion,
  }
}

export function verifyOperationsRegressionOptimizerFixtures() {
  return scenarioDefinitions.flatMap((scenario) => ([
    ...(scenario.checkout
      ? [{
        scenarioId: scenario.id,
        purpose: 'checkout_quote' as const,
        packageCount: passFacts(
          scenario,
          scenario.checkout,
          'checkout_quote',
        ).packages.length,
      }]
      : []),
    ...(scenario.fulfillment
      ? [{
        scenarioId: scenario.id,
        purpose: 'fulfillment_execution' as const,
        packageCount: passFacts(
          scenario,
          scenario.fulfillment,
          'fulfillment_execution',
        ).packages.length,
      }]
      : []),
  ]))
}

async function insertSucceededRunChildren(
  client: PoolClient,
  input: {
    organizationId: string
    runId: string
    scenario: ScenarioDefinition
    pass: PassDefinition
    purpose: 'checkout_quote' | 'fulfillment_execution'
  },
) {
  const facts = passFacts(input.scenario, input.pass, input.purpose)
  for (const line of facts.requiredLines) {
    const snapshot = {
      lineKey: line.lineKey,
      productKey: line.productKey,
      title: line.title,
      requiredQuantity: line.requiredQuantity,
      unitWeightGrams: line.unitWeightGrams,
    }
    await client.query(
      `INSERT INTO operations_pack_rate_run_lines (
         organization_id, run_id, line_key, product_key, title,
         required_quantity, unit_weight_grams, line_hash, line_snapshot
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9::jsonb
       )`,
      [
        input.organizationId,
        input.runId,
        line.lineKey,
        line.productKey,
        line.title,
        line.requiredQuantity,
        line.unitWeightGrams,
        sha256(snapshot),
        JSON.stringify(snapshot),
      ],
    )
  }
  for (const item of facts.packages) {
    const packageSnapshot = {
      packageKey: item.packageKey,
      sequence: item.sequence,
      materialCode: item.materialCode,
      materialName: item.materialName,
      dimensionsMm: item.dimensionsMm,
      contentWeightGrams: item.contentWeightGrams,
      tareWeightGrams: item.tareWeightGrams,
      grossWeightGrams: item.grossWeightGrams,
    }
    await client.query(
      `INSERT INTO operations_pack_rate_run_packages (
         organization_id, run_id, package_key, package_sequence,
         material_code, material_name, length_mm, width_mm, height_mm,
         content_weight_grams, tare_weight_grams, gross_weight_grams,
         allocation_count, package_hash, package_snapshot
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11,
         $12, $13, $14, $15::jsonb
       )`,
      [
        input.organizationId,
        input.runId,
        item.packageKey,
        item.sequence,
        item.materialCode,
        item.materialName,
        item.dimensionsMm.length,
        item.dimensionsMm.width,
        item.dimensionsMm.height,
        item.contentWeightGrams,
        item.tareWeightGrams,
        item.grossWeightGrams,
        item.allocations.length,
        sha256(packageSnapshot),
        JSON.stringify(packageSnapshot),
      ],
    )
    for (const allocation of item.allocations) {
      const allocationSnapshot = {
        packageKey: item.packageKey,
        lineKey: allocation.lineKey,
        productKey: allocation.productKey,
        comparisonProductKey: allocation.productKey,
        title: allocation.title,
        quantity: allocation.quantity,
      }
      await client.query(
        `INSERT INTO operations_pack_rate_run_allocations (
           organization_id, run_id, package_key, line_key, product_key,
           comparison_product_key, title, quantity, allocation_hash
         ) VALUES (
           $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9
         )`,
        [
          input.organizationId,
          input.runId,
          item.packageKey,
          allocation.lineKey,
          allocation.productKey,
          allocation.productKey,
          allocation.title,
          allocation.quantity,
          sha256(allocationSnapshot),
        ],
      )
    }
  }
  for (const rate of facts.rateChoices) {
    const normalizedResponse = {
      replayOnly: true,
      noProviderCall: true,
      packageCount: facts.packages.length,
      provider: rate.provider,
      serviceCode: rate.serviceCode,
      serviceName: rate.serviceName,
      carrierCostMinor: rate.carrierCostMinor,
      currency: rate.currency,
      recordedFactVersion: rate.recordedFactVersion,
      packagePlanHash: facts.packagePlanHash,
    }
    await client.query(
      `INSERT INTO operations_pack_rate_run_rate_choices (
         organization_id, run_id, provider, service_code, service_name,
         carrier_cost_minor, currency, selected, recorded_fact_version,
         normalized_response
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10::jsonb
       )`,
      [
        input.organizationId,
        input.runId,
        rate.provider,
        rate.serviceCode,
        rate.serviceName,
        rate.carrierCostMinor,
        rate.currency,
        rate.selected,
        rate.recordedFactVersion,
        JSON.stringify(normalizedResponse),
      ],
    )
  }
  return facts
}

function resultSnapshotForPass(
  scenario: ScenarioDefinition,
  pass: PassDefinition,
  purpose: 'checkout_quote' | 'fulfillment_execution',
) {
  const facts = passFacts(scenario, pass, purpose)
  return {
    kind: 'pack_rate',
    purpose,
    packages: facts.packages,
    rateChoices: facts.rateChoices,
    selectedRate: facts.selected,
    allocationHash: facts.allocationHash,
    materialHash: facts.materialHash,
    serviceHash: facts.serviceHash,
    packagePlanHash: facts.packagePlanHash,
    optimizerInputHash: facts.optimizerInputHash,
    optimizerResultHash: facts.optimizerResultHash,
    optimizerPolicyVersion: facts.optimizerPolicyVersion,
    optimizerAlgorithmVersion: facts.optimizerAlgorithmVersion,
    checkoutShippingChargeMinor: pass.checkoutShippingChargeMinor,
    estimatedShippingVarianceMinor:
      pass.checkoutShippingChargeMinor - facts.selected.carrierCostMinor,
    pricingSemanticsVersion: PRICING_SEMANTICS_VERSION,
    billingReconciliationStatus: 'pending_carrier_invoice',
    currency: CURRENCY,
    recordedFactsOnly: true,
    providerWriteCount: 0,
    postagePurchaseCount: 0,
  }
}

function crmSnapshot(resolution: CustomerResolution) {
  return {
    requestedMode: resolution.requestedMode,
    outcome: resolution.outcome,
    customerGlobalId: resolution.customerGlobalId,
    identityKey: resolution.identityKey,
    candidateCount: resolution.candidateCount,
    candidateGlobalIds: resolution.candidateGlobalIds,
    detail: resolution.detail,
  }
}

async function persistFinalizedPackageEvidence(
  client: PoolClient,
  input: {
    organizationId: string
    actorEmail: string
    scenario: ScenarioDefinition
    fulfillment: InsertedRun
    customer: CustomerResolution
    facts: ReturnType<typeof passFacts>
  },
) {
  if (!input.scenario.finalized) return
  if (!input.customer.customerGlobalId) {
    throw new Error('OPERATIONS_REGRESSION_FINALIZATION_CUSTOMER_REQUIRED')
  }
  for (const item of input.facts.packages) {
    const trackingNumber = `1ZREPLAY${String(item.sequence).padStart(10, '0')}`
    const recordedLabelReference =
      `recorded-label:${input.scenario.id}:${item.sequence}`
    const artifact = await persistOperationsRegressionPackingSlipArtifactWithClient(
      client,
      {
        organizationId: input.organizationId,
        actorEmail: input.actorEmail,
        runGlobalId: input.fulfillment.globalId,
        scenarioId: input.scenario.id,
        sourceReference: input.scenario.sourceReference,
        orderNumber: input.scenario.sourceReference,
        customerName: 'Recorded replay customer',
        customerGlobalId: input.customer.customerGlobalId,
        packageKey: item.packageKey,
        packageSequence: item.sequence,
        packageCount: input.facts.packages.length,
        trackingNumber,
        carrier: input.facts.selected.provider,
        serviceCode: input.facts.selected.serviceCode,
        recordedLabelReference,
        recordedAt: input.fulfillment.createdAt,
        shipTo: {
          name: 'Recorded replay recipient',
          line1: '100 Development Evidence Way',
          city: 'Hartford',
          region: 'CT',
          postalCode: '06103',
          country: 'US',
        },
        lines: item.allocations.map((allocation) => ({
          lineKey: allocation.lineKey,
          productKey: allocation.productKey,
          title: allocation.title,
          quantity: allocation.quantity,
        })),
      },
    )
    await client.query(
      `INSERT INTO operations_pack_rate_run_package_finalizations (
         organization_id, run_id, package_key, response_source, carrier,
         service_code, tracking_number, recorded_label_reference,
         packing_slip_artifact_id, provider_write_count,
         postage_purchase_count, finalized_at
       ) VALUES (
         $1::uuid, $2::uuid, $3, 'recorded_label_response', $4, $5, $6,
         $7, $8::uuid, 0, 0, $9::timestamptz
       )`,
      [
        input.organizationId,
        input.fulfillment.id,
        item.packageKey,
        input.facts.selected.provider,
        input.facts.selected.serviceCode,
        trackingNumber,
        recordedLabelReference,
        artifact.id,
        input.fulfillment.createdAt,
      ],
    )
  }
}

async function insertVariance(
  client: PoolClient,
  input: {
    organizationId: string
    checkout: InsertedRun
    fulfillment: InsertedRun
    checkoutPass: PassDefinition
    fulfillmentPass: PassDefinition
    scenario: ScenarioDefinition
  },
) {
  const checkoutFacts = passFacts(
    input.scenario,
    input.checkoutPass,
    'checkout_quote',
  )
  const fulfillmentFacts = passFacts(
    input.scenario,
    input.fulfillmentPass,
    'fulfillment_execution',
  )
  const allocationChanged =
    checkoutFacts.allocationHash !== fulfillmentFacts.allocationHash
  const materialChanged =
    checkoutFacts.materialHash !== fulfillmentFacts.materialHash
  const serviceChanged =
    checkoutFacts.serviceHash !== fulfillmentFacts.serviceHash
  const causes = [
    ...(allocationChanged ? ['allocation_changed'] : []),
    ...(materialChanged ? ['material_changed'] : []),
    ...(serviceChanged ? ['service_changed'] : []),
    ...(checkoutFacts.selected.carrierCostMinor
      !== fulfillmentFacts.selected.carrierCostMinor
      ? ['recorded_rate_changed']
      : []),
  ]
  const comparison = {
    checkoutRunGlobalId: input.checkout.globalId,
    fulfillmentRunGlobalId: input.fulfillment.globalId,
    allocationChanged,
    materialChanged,
    serviceChanged,
    causes,
  }
  await client.query(
    `INSERT INTO operations_pack_rate_variances (
       organization_id, checkout_run_id, fulfillment_run_id,
       package_count_delta, checkout_carrier_cost_minor,
       checkout_customer_charge_minor, fulfillment_carrier_cost_minor,
       carrier_cost_variance_minor, realized_margin_minor, currency,
       allocation_changed, material_changed, service_changed, causes,
       comparison_hash
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10,
       $11, $12, $13, $14::jsonb, $15
     )`,
    [
      input.organizationId,
      input.checkout.id,
      input.fulfillment.id,
      fulfillmentFacts.packages.length - checkoutFacts.packages.length,
      checkoutFacts.selected.carrierCostMinor,
      input.checkoutPass.checkoutShippingChargeMinor,
      fulfillmentFacts.selected.carrierCostMinor,
      fulfillmentFacts.selected.carrierCostMinor
        - checkoutFacts.selected.carrierCostMinor,
      input.checkoutPass.checkoutShippingChargeMinor
        - fulfillmentFacts.selected.carrierCostMinor,
      CURRENCY,
      allocationChanged,
      materialChanged,
      serviceChanged,
      JSON.stringify(causes),
      sha256(comparison),
    ],
  )
}

async function createReplayWithClient(
  client: PoolClient,
  input: {
    organizationId: string
    actorEmail: string
    scenario: ScenarioDefinition
    idempotencyKey: string
  },
) {
  const replayGroupKey =
    `operations-regression-replay:${input.scenario.id}:v1`
  await acquireTransactionAdvisoryLock(
    client,
    `operations-regression-replay:${input.organizationId}:${input.scenario.id}`,
  )
  const existing = await client.query<{ id: string }>(
    `SELECT id::text
     FROM operations_pack_rate_runs
     WHERE organization_id = $1::uuid
       AND replay_group_key = $2
       AND purpose = 'checkout_quote'
     LIMIT 1`,
    [input.organizationId, replayGroupKey],
  )
  if (existing.rows[0]) {
    const run = await readOperationsRegressionRunWithClient(
      client,
      input.organizationId,
      input.scenario.id,
    )
    if (!run) throw new Error('OPERATIONS_REGRESSION_REPLAY_READ_FAILED')
    return { ...run, replayed: true }
  }

  const context = await resolveReplayContext(
    client,
    input.organizationId,
    input.actorEmail,
  )
  // Reuse scenarios start with a clearly separate fixture seed. The lifecycle
  // resolution later only reads and reuses this row; it never calls a create.
  await seedReusableReplayCustomerFixture(client, {
    organizationId: input.organizationId,
    pipelineId: context.pipelineId,
    actorEmail: context.actorEmail,
    scenario: input.scenario,
  })
  const checkoutInputSnapshot = {
    schemaVersion: OPERATIONS_REGRESSION_REPLAY_SCHEMA_VERSION,
    scenarioId: input.scenario.id,
    sourceReference: input.scenario.sourceReference,
    checkoutSource: input.scenario.checkoutSource,
    customerNeutral: true,
    lines: input.scenario.provider === 'shopify'
      ? input.scenario.lines.map((line, index) => ({
        lineKey: `line-${index + 1}`,
        productKey: line.productKey,
        quantity: line.checkoutQuantity,
        unitWeightGrams: line.unitWeightGrams,
      }))
      : [],
  }
  const checkoutResultSnapshot = input.scenario.checkout
    ? resultSnapshotForPass(
      input.scenario,
      input.scenario.checkout,
      'checkout_quote',
    )
    : {
      kind: 'marketplace_estimate',
      source: 'faire_checkout_estimate_captured',
      capturedCheckoutShippingChargeMinor:
        input.scenario.capturedMarketplaceEstimateMinor,
      currency: CURRENCY,
      allocationHash: null,
      materialHash: null,
      serviceHash: null,
      noClawPilotCheckoutCallback: true,
      packageCount: 0,
      rateChoiceCount: 0,
    }
  const checkout = await insertRun(client, {
    organizationId: input.organizationId,
    scenario: input.scenario,
    replayGroupKey,
    purpose: 'checkout_quote',
    priorCheckoutRunId: null,
    pipelineId: null,
    customerId: null,
    customerResolutionOutcome: 'not_attempted',
    status: 'succeeded',
    blockerCode: null,
    pass: input.scenario.checkout,
    checkoutShippingChargeMinor: input.scenario.checkout
      ? input.scenario.checkout.checkoutShippingChargeMinor
      : input.scenario.capturedMarketplaceEstimateMinor,
    inputSnapshot: checkoutInputSnapshot,
    resultSnapshot: checkoutResultSnapshot,
    stageSnapshot: {
      checkoutCapture: input.scenario.provider === 'faire'
        ? 'marketplace_estimate_only'
        : 'recorded_live_callback',
      orderIntake: {
        sourceReference: input.scenario.sourceReference,
        customerNeutral: true,
        intakeEvidenceHash: sha256(checkoutInputSnapshot),
      },
      noProviderWrites: true,
    },
    idempotencyKey: `${input.idempotencyKey}:checkout`,
    actorEmail: context.actorEmail,
  })
  if (input.scenario.checkout) {
    await insertSucceededRunChildren(client, {
      organizationId: input.organizationId,
      runId: checkout.id,
      scenario: input.scenario,
      pass: input.scenario.checkout,
      purpose: 'checkout_quote',
    })
  }

  // The exact checkout/intake snapshot above exists before CRM is touched.
  const customer = await resolveReplayCustomerAfterIntake(client, {
    organizationId: input.organizationId,
    pipelineId: context.pipelineId,
    actorEmail: context.actorEmail,
    scenario: input.scenario,
  })

  let fulfillment: InsertedRun
  let fulfillmentFacts: ReturnType<typeof passFacts> | null = null
  if (input.scenario.expectedBlocker) {
    fulfillment = await insertRun(client, {
      organizationId: input.organizationId,
      scenario: input.scenario,
      replayGroupKey,
      purpose: 'fulfillment_execution',
      priorCheckoutRunId: checkout.id,
      pipelineId: null,
      customerId: null,
      customerResolutionOutcome: 'ambiguous',
      status: 'blocked',
      blockerCode: input.scenario.expectedBlocker,
      pass: null,
      checkoutShippingChargeMinor: null,
      inputSnapshot: {
        checkoutRunGlobalId: checkout.globalId,
        intakeCompleted: true,
        crmResolution: crmSnapshot(customer),
      },
      resultSnapshot: {
        status: 'blocked',
        blockerCode: input.scenario.expectedBlocker,
        allocationHash: null,
        materialHash: null,
        serviceHash: null,
        providerWriteCount: 0,
      },
      stageSnapshot: { crmResolution: crmSnapshot(customer) },
      idempotencyKey: `${input.idempotencyKey}:fulfillment`,
      actorEmail: context.actorEmail,
    })
  } else {
    if (!input.scenario.fulfillment || !customer.customerId) {
      throw new Error('OPERATIONS_REGRESSION_FULFILLMENT_INPUT_INVALID')
    }
    const fulfillmentResult = resultSnapshotForPass(
      input.scenario,
      input.scenario.fulfillment,
      'fulfillment_execution',
    )
    fulfillment = await insertRun(client, {
      organizationId: input.organizationId,
      scenario: input.scenario,
      replayGroupKey,
      purpose: 'fulfillment_execution',
      priorCheckoutRunId: checkout.id,
      pipelineId: context.pipelineId,
      customerId: customer.customerId,
      customerResolutionOutcome: customer.outcome,
      status: 'succeeded',
      blockerCode: null,
      pass: input.scenario.fulfillment,
      checkoutShippingChargeMinor: input.scenario.provider === 'faire'
        ? input.scenario.capturedMarketplaceEstimateMinor
        : input.scenario.checkout?.checkoutShippingChargeMinor ?? null,
      inputSnapshot: {
        checkoutRunGlobalId: checkout.globalId,
        intakeCompleted: true,
        crmResolution: crmSnapshot(customer),
        requiredLines: input.scenario.lines.map((line, index) => ({
          lineKey: `line-${index + 1}`,
          productKey: line.productKey,
          quantity: line.fulfillmentQuantity,
        })),
      },
      resultSnapshot: fulfillmentResult,
      stageSnapshot: { crmResolution: crmSnapshot(customer) },
      idempotencyKey: `${input.idempotencyKey}:fulfillment`,
      actorEmail: context.actorEmail,
    })
    fulfillmentFacts = await insertSucceededRunChildren(client, {
      organizationId: input.organizationId,
      runId: fulfillment.id,
      scenario: input.scenario,
      pass: input.scenario.fulfillment,
      purpose: 'fulfillment_execution',
    })
    if (input.scenario.checkout) {
      await insertVariance(client, {
        organizationId: input.organizationId,
        checkout,
        fulfillment,
        checkoutPass: input.scenario.checkout,
        fulfillmentPass: input.scenario.fulfillment,
        scenario: input.scenario,
      })
    }
    await persistFinalizedPackageEvidence(client, {
      organizationId: input.organizationId,
      actorEmail: context.actorEmail,
      scenario: input.scenario,
      fulfillment,
      customer,
      facts: fulfillmentFacts,
    })
  }

  const run = await readOperationsRegressionRunWithClient(
    client,
    input.organizationId,
    input.scenario.id,
  )
  if (!run) throw new Error('OPERATIONS_REGRESSION_REPLAY_READ_FAILED')
  return run
}

export async function runOperationsRegressionReplayInPostgres(input: {
  organizationId: string
  actorEmail: string
  scenarioId: string
  idempotencyKey: string
}) {
  assertOperationsRegressionReplayRuntime()
  const scenario = scenarioById(input.scenarioId)
  return withTransaction((client) => createReplayWithClient(client, {
    organizationId: input.organizationId,
    actorEmail: input.actorEmail,
    scenario,
    idempotencyKey: input.idempotencyKey,
  }))
}

type StoredRunRow = QueryResultRow & {
  id: string
  global_id: string
  replay_group_key: string
  scenario_id: string
  provider: 'shopify' | 'faire'
  checkout_source:
    | 'live_callback_recorded'
    | 'faire_checkout_estimate_captured'
  purpose: 'checkout_quote' | 'fulfillment_execution'
  status: 'succeeded' | 'blocked' | 'failed'
  blocker_code: string | null
  customer_resolution_outcome:
    | 'not_attempted'
    | 'created'
    | 'reused'
    | 'ambiguous'
  customer_global_id: string | null
  input_hash: string
  result_hash: string
  input_snapshot: Record<string, unknown>
  result_snapshot: Record<string, unknown>
  stage_snapshot: Record<string, unknown>
  line_count: number
  package_count: number
  rate_choice_count: number
  currency: string
  selected_provider: 'ups_rest' | 'fedex_rest' | null
  selected_service_code: string | null
  selected_service_name: string | null
  selected_carrier_cost_minor: string | null
  customer_charge_minor: string | null
  mud_markup_minor: string | null
  margin_minor: string | null
  pricing_semantics_version: 1 | 2
  expires_at: Date | null
  created_at: Date
  provider_write_count: number
  postage_purchase_count: number
  label_write_count: number
}

type StoredPackageRow = QueryResultRow & {
  package_key: string
  package_sequence: number
  material_code: string
  material_name: string
  length_mm: number
  width_mm: number
  height_mm: number
  content_weight_grams: number
  tare_weight_grams: number
  gross_weight_grams: number
}

type StoredAllocationRow = QueryResultRow & {
  package_key: string
  line_key: string
  product_key: string
  title: string
  quantity: number
}

type StoredRateRow = QueryResultRow & {
  provider: 'ups_rest' | 'fedex_rest'
  service_code: string
  service_name: string
  carrier_cost_minor: string
  currency: string
  selected: boolean
  recorded_fact_version: string
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function intValue(value: string | number | null | undefined) {
  if (value === null || value === undefined) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

async function readPackRateStage(
  client: PoolClient,
  organizationId: string,
  run: StoredRunRow,
): Promise<OperationsRegressionPackRateStage> {
  const [packageResult, allocationResult, rateResult] = await Promise.all([
    client.query<StoredPackageRow>(
      `SELECT
         package_key, package_sequence, material_code, material_name,
         length_mm, width_mm, height_mm, content_weight_grams,
         tare_weight_grams, gross_weight_grams
       FROM operations_pack_rate_run_packages
       WHERE organization_id = $1::uuid AND run_id = $2::uuid
       ORDER BY package_sequence`,
      [organizationId, run.id],
    ),
    client.query<StoredAllocationRow>(
      `SELECT package_key, line_key, product_key, title, quantity
       FROM operations_pack_rate_run_allocations
       WHERE organization_id = $1::uuid AND run_id = $2::uuid
       ORDER BY package_key, line_key, product_key`,
      [organizationId, run.id],
    ),
    client.query<StoredRateRow>(
      `SELECT
         provider, service_code, service_name, carrier_cost_minor::text,
         currency, selected, recorded_fact_version
       FROM operations_pack_rate_run_rate_choices
       WHERE organization_id = $1::uuid AND run_id = $2::uuid
       ORDER BY selected DESC, carrier_cost_minor, provider, service_code`,
      [organizationId, run.id],
    ),
  ])
  const packages = packageResult.rows.map((item) => ({
    packageKey: item.package_key,
    sequence: item.package_sequence,
    materialCode: item.material_code,
    materialName: item.material_name,
    dimensionsMm: {
      length: item.length_mm,
      width: item.width_mm,
      height: item.height_mm,
    },
    contentWeightGrams: item.content_weight_grams,
    tareWeightGrams: item.tare_weight_grams,
    grossWeightGrams: item.gross_weight_grams,
    allocations: allocationResult.rows
      .filter((allocation) => allocation.package_key === item.package_key)
      .map((allocation) => ({
        lineKey: allocation.line_key,
        productKey: allocation.product_key,
        title: allocation.title,
        quantity: allocation.quantity,
      })),
  }))
  const rateChoices = rateResult.rows.map((rate) => ({
    provider: rate.provider,
    serviceCode: rate.service_code,
    serviceName: rate.service_name,
    carrierCostMinor: Number(rate.carrier_cost_minor),
    currency: rate.currency,
    selected: rate.selected,
    recordedFactVersion: rate.recorded_fact_version,
  }))
  const selected = rateChoices.filter((rate) => rate.selected)
  if (
    packages.length !== run.package_count
    || rateChoices.length !== run.rate_choice_count
    || selected.length !== 1
  ) {
    throw new Error('OPERATIONS_REGRESSION_PERSISTED_STAGE_INCOMPLETE')
  }
  return {
    kind: 'pack_rate',
    status: 'passed',
    runGlobalId: run.global_id,
    purpose: run.purpose,
    packageCount: run.package_count,
    packages,
    rateChoices,
    selectedRate: selected[0],
    selectedCarrierCostMinor:
      intValue(run.selected_carrier_cost_minor) || 0,
    checkoutShippingChargeMinor: intValue(run.customer_charge_minor) || 0,
    estimatedShippingVarianceMinor: intValue(run.margin_minor) || 0,
    pricingSemanticsVersion: run.pricing_semantics_version,
    billingReconciliationStatus: 'pending_carrier_invoice',
    currency: run.currency,
    inputHash: run.input_hash,
    resultHash: run.result_hash,
    expiresAt: run.expires_at?.toISOString() || null,
  }
}

function marketplaceEstimateStage(
  run: StoredRunRow,
): OperationsRegressionMarketplaceEstimateStage {
  const result = recordValue(run.result_snapshot)
  return {
    kind: 'marketplace_estimate',
    status: 'warning',
    runGlobalId: run.global_id,
    purpose: 'checkout_quote',
    source: 'faire_checkout_estimate_captured',
    capturedCheckoutShippingChargeMinor: intValue(run.customer_charge_minor),
    currency: run.currency,
    inputHash: run.input_hash,
    resultHash: run.result_hash,
    capturedAt: run.created_at.toISOString(),
    detail: result.noClawPilotCheckoutCallback === true
      ? 'Faire supplied no ClawPilot checkout callback. This is the captured marketplace estimate only; package and carrier comparison begin after intake.'
      : 'Captured marketplace estimate evidence is incomplete.',
  }
}

async function readOperationsRegressionRunWithClient(
  client: PoolClient,
  organizationId: string,
  scenarioId: string,
): Promise<OperationsRegressionRun | null> {
  const runResult = await client.query<StoredRunRow>(
    `SELECT
       run.id::text, run.global_id, run.replay_group_key, run.scenario_id,
       run.provider, run.checkout_source, run.purpose, run.status,
       run.blocker_code, run.customer_resolution_outcome,
       customer.reference_code AS customer_global_id,
       run.input_hash, run.result_hash, run.input_snapshot,
       run.result_snapshot, run.stage_snapshot, run.line_count,
       run.package_count, run.rate_choice_count, run.currency,
       run.selected_provider, run.selected_service_code,
       run.selected_service_name, run.selected_carrier_cost_minor::text,
       run.customer_charge_minor::text, run.mud_markup_minor::text,
       run.margin_minor::text, run.pricing_semantics_version,
       run.expires_at, run.created_at,
       run.provider_write_count, run.postage_purchase_count,
       run.label_write_count
     FROM operations_pack_rate_runs run
     LEFT JOIN crm_organizations customer
       ON customer.pipeline_id = run.pipeline_id
      AND customer.id = run.customer_id
     WHERE run.organization_id = $1::uuid
       AND run.scenario_id = $2
     ORDER BY
       CASE run.purpose WHEN 'checkout_quote' THEN 0 ELSE 1 END`,
    [organizationId, scenarioId],
  )
  const checkout = runResult.rows.find(
    (row) => row.purpose === 'checkout_quote',
  )
  const fulfillment = runResult.rows.find(
    (row) => row.purpose === 'fulfillment_execution',
  )
  if (!checkout || !fulfillment) return null
  const scenario = scenarioById(scenarioId)
  const checkoutStage = checkout.provider === 'faire'
    ? marketplaceEstimateStage(checkout)
    : await readPackRateStage(client, organizationId, checkout)
  const fulfillmentStage = fulfillment.status === 'succeeded'
    ? await readPackRateStage(client, organizationId, fulfillment)
    : null
  const crm = recordValue(recordValue(fulfillment.stage_snapshot).crmResolution)
  const intake = recordValue(recordValue(checkout.stage_snapshot).orderIntake)

  const varianceResult = await client.query<{
    package_count_delta: number
    checkout_carrier_cost_minor: string
    checkout_customer_charge_minor: string
    fulfillment_carrier_cost_minor: string
    carrier_cost_variance_minor: string
    realized_margin_minor: string
    currency: string
    allocation_changed: boolean
    material_changed: boolean
    service_changed: boolean
    causes: string[]
  }>(
    `SELECT
       package_count_delta, checkout_carrier_cost_minor::text,
       checkout_customer_charge_minor::text,
       fulfillment_carrier_cost_minor::text,
       carrier_cost_variance_minor::text, realized_margin_minor::text,
       currency, allocation_changed, material_changed, service_changed,
       causes
     FROM operations_pack_rate_variances
     WHERE organization_id = $1::uuid
       AND checkout_run_id = $2::uuid
       AND fulfillment_run_id = $3::uuid`,
    [organizationId, checkout.id, fulfillment.id],
  )
  const variance = varianceResult.rows[0]

  const finalizationResult = fulfillmentStage
    ? await client.query<{
      package_key: string
      response_source: 'recorded_label_response'
      carrier: 'ups_rest' | 'fedex_rest'
      service_code: string
      tracking_number: string
      recorded_label_reference: string
      packing_slip_global_id: string
    }>(
      `SELECT
         finalization.package_key, finalization.response_source,
         finalization.carrier, finalization.service_code,
         finalization.tracking_number,
         finalization.recorded_label_reference,
         artifact.global_id AS packing_slip_global_id
       FROM operations_pack_rate_run_package_finalizations finalization
       JOIN operations_print_artifacts artifact
         ON artifact.organization_id = finalization.organization_id
        AND artifact.id = finalization.packing_slip_artifact_id
       WHERE finalization.organization_id = $1::uuid
         AND finalization.run_id = $2::uuid
       ORDER BY finalization.package_key`,
      [organizationId, fulfillment.id],
    )
    : { rows: [] }
  const finalizationByPackage = new Map(
    finalizationResult.rows.map((row) => [row.package_key, row]),
  )
  const packageRows = fulfillmentStage?.packages || []
  const allFinalized = packageRows.length > 0
    && finalizationResult.rows.length === packageRows.length
  const labelFinalization: OperationsRegressionRun['stages']['labelFinalization'] =
    allFinalized
      ? {
        status: 'passed',
        responseSource: 'recorded_label_response',
        noProviderWrites: true,
        noPostagePurchases: true,
        packages: packageRows.map((item) => {
          const evidence = finalizationByPackage.get(item.packageKey)
          if (!evidence) {
            throw new Error('OPERATIONS_REGRESSION_FINALIZATION_INCOMPLETE')
          }
          return {
            packageKey: item.packageKey,
            sequence: item.sequence,
            status: 'finalized',
            carrier: evidence.carrier,
            serviceCode: evidence.service_code,
            recordedLabelReference: evidence.recorded_label_reference,
            trackingNumber: evidence.tracking_number,
          }
        }),
        detail:
          'Every package has one unique recorded label response and immutable tracked packing slip.',
      }
      : {
        status: 'warning',
        responseSource: null,
        noProviderWrites: true,
        noPostagePurchases: true,
        packages: packageRows.map((item) => ({
          packageKey: item.packageKey,
          sequence: item.sequence,
          status: 'not_finalized',
          carrier: null,
          serviceCode: null,
          recordedLabelReference: null,
          trackingNumber: null,
        })),
        detail: fulfillment.status === 'blocked'
          ? 'Fulfillment stopped at CRM ambiguity; no label response exists.'
          : 'The successful pre-label state has no label response or tracking yet.',
      }
  const packageDocuments: OperationsRegressionRun['stages']['packageDocuments'] = {
    status: allFinalized ? 'passed' : 'warning',
    finalPackingSlipEligible: allFinalized,
    preLabelDocumentType: 'pack_work_instruction',
    packages: packageRows.map((item) => {
      const evidence = finalizationByPackage.get(item.packageKey)
      return {
        packageKey: item.packageKey,
        sequence: item.sequence,
        trackingRequired: true,
        trackingNumber: evidence?.tracking_number || null,
        finalPackingSlipStatus: evidence ? 'ready' : 'blocked_until_label',
        finalPackingSlipGlobalId: evidence?.packing_slip_global_id || null,
      }
    }),
    detail: allFinalized
      ? 'Each downloadable final packing slip is bound to one exact tracked package.'
      : 'Final packing slips remain blocked until that package has tracking evidence.',
  }

  return {
    globalId: fulfillment.global_id,
    checkoutRunGlobalId: checkout.global_id,
    fulfillmentRunGlobalId: fulfillment.global_id,
    replayGroupKey: checkout.replay_group_key,
    scenarioId: scenario.id,
    scenarioTitle: scenario.title,
    status: fulfillment.status === 'blocked' ? 'expected_blocked' : 'succeeded',
    replayed: false,
    createdAt: checkout.created_at.toISOString(),
    noProviderWrites: true,
    noPostagePurchases: true,
    stages: {
      checkoutQuote: checkoutStage,
      orderIntake: {
        status: 'passed',
        provider: scenario.provider,
        sourceReference: scenario.sourceReference,
        intakeEvidenceHash: String(
          intake.intakeEvidenceHash || checkout.input_hash,
        ),
        customerNeutral: true,
        detail:
          'Sanitized order facts were durably captured before any CRM customer was created, reused, or rejected as ambiguous.',
      },
      customerResolution: {
        status: fulfillment.status === 'blocked' ? 'warning' : 'passed',
        requestedMode: scenario.customerMode,
        outcome: fulfillment.customer_resolution_outcome === 'not_attempted'
          ? 'ambiguous'
          : fulfillment.customer_resolution_outcome,
        customerGlobalId: fulfillment.customer_global_id,
        identityKey: String(crm.identityKey || ''),
        candidateCount: Number(crm.candidateCount || 0),
        detail: String(crm.detail || 'CRM resolution evidence unavailable.'),
      },
      fulfillmentExecution: fulfillmentStage,
      variance: variance
        ? {
          status: (
            Number(variance.carrier_cost_variance_minor) !== 0
            || variance.package_count_delta !== 0
            || variance.allocation_changed
            || variance.material_changed
            || variance.service_changed
          ) ? 'warning' : 'passed',
          changed: (
            Number(variance.carrier_cost_variance_minor) !== 0
            || variance.package_count_delta !== 0
            || variance.allocation_changed
            || variance.material_changed
            || variance.service_changed
          ),
          packageCountDelta: variance.package_count_delta,
          checkoutCarrierCostMinor:
            Number(variance.checkout_carrier_cost_minor),
          checkoutShippingChargeMinor:
            Number(variance.checkout_customer_charge_minor),
          fulfillmentCarrierCostMinor:
            Number(variance.fulfillment_carrier_cost_minor),
          preLabelRateVarianceMinor:
            Number(variance.carrier_cost_variance_minor),
          estimatedShippingVarianceMinor:
            Number(variance.realized_margin_minor),
          billingReconciliationStatus: 'pending_carrier_invoice',
          currency: variance.currency,
          allocationChanged: variance.allocation_changed,
          materialChanged: variance.material_changed,
          serviceChanged: variance.service_changed,
          causes: variance.causes,
        }
        : null,
      labelFinalization,
      packageDocuments,
    },
  }
}

export async function readOperationsRegressionWalkthroughInPostgres(input: {
  organizationId: string
}): Promise<OperationsRegressionWalkthrough> {
  assertOperationsRegressionReplayRuntime()
  const client = await getPostgresPool().connect()
  try {
    const runs: OperationsRegressionRun[] = []
    for (const scenario of scenarioDefinitions) {
      const run = await readOperationsRegressionRunWithClient(
        client,
        input.organizationId,
        scenario.id,
      )
      if (run) runs.push(run)
    }
    return {
      schemaVersion: OPERATIONS_REGRESSION_REPLAY_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      scenarios: operationsRegressionScenarios(),
      runs: runs.sort((left, right) => (
        right.createdAt.localeCompare(left.createdAt)
      )),
    }
  } finally {
    client.release()
  }
}
