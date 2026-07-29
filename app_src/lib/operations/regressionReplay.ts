export const OPERATIONS_REGRESSION_REPLAY_SCHEMA_VERSION =
  'operations-regression-replay-v1' as const

export type OperationsRegressionStageStatus =
  | 'passed'
  | 'warning'
  | 'failed'

export type OperationsRegressionCustomerMode =
  | 'new'
  | 'reuse'
  | 'ambiguous'

export type OperationsRegressionScenarioLine = {
  productKey: string
  title: string
  checkoutQuantity: number
  fulfillmentQuantity: number
  unitWeightGrams: number
}

export type OperationsRegressionScenario = {
  id: string
  title: string
  description: string
  provider: 'shopify' | 'faire'
  checkoutSource:
    | 'live_callback_recorded'
    | 'faire_checkout_estimate_captured'
  sourceReference: string
  customerMode: OperationsRegressionCustomerMode
  expectedCheckoutPackages: number
  expectedFulfillmentPackages: number
  lines: OperationsRegressionScenarioLine[]
  regressionFocus: string[]
}

export type OperationsRegressionPackage = {
  packageKey: string
  sequence: number
  materialCode: string
  materialName: string
  dimensionsMm: {
    length: number
    width: number
    height: number
  }
  contentWeightGrams: number
  tareWeightGrams: number
  grossWeightGrams: number
  allocations: Array<{
    lineKey: string
    productKey: string
    title: string
    quantity: number
  }>
}

export type OperationsRegressionRateChoice = {
  provider: 'ups_rest' | 'fedex_rest'
  serviceCode: string
  serviceName: string
  carrierCostMinor: number
  currency: string
  selected: boolean
  recordedFactVersion: string
}

export type OperationsRegressionPackRateStage = {
  kind: 'pack_rate'
  status: OperationsRegressionStageStatus
  runGlobalId: string
  purpose: 'checkout_quote' | 'fulfillment_execution'
  packageCount: number
  packages: OperationsRegressionPackage[]
  rateChoices: OperationsRegressionRateChoice[]
  selectedRate: OperationsRegressionRateChoice
  selectedCarrierCostMinor: number
  customerChargeMinor: number
  mudMarkupMinor: number
  marginMinor: number
  currency: string
  inputHash: string
  resultHash: string
  expiresAt: string | null
}

/**
 * Faire does not expose a documented checkout callback to ClawPilot. This
 * stage preserves only the marketplace estimate captured with the historical
 * order. It intentionally cannot carry ClawPilot packages or carrier choices.
 */
export type OperationsRegressionMarketplaceEstimateStage = {
  kind: 'marketplace_estimate'
  status: OperationsRegressionStageStatus
  runGlobalId: string
  purpose: 'checkout_quote'
  source: 'faire_checkout_estimate_captured'
  capturedCustomerChargeMinor: number | null
  currency: string
  inputHash: string
  resultHash: string
  capturedAt: string
  detail: string
}

export type OperationsRegressionCustomerResolutionStage = {
  status: OperationsRegressionStageStatus
  requestedMode: OperationsRegressionCustomerMode
  outcome: 'created' | 'reused' | 'ambiguous'
  customerGlobalId: string | null
  identityKey: string
  candidateCount: number
  detail: string
}

export type OperationsRegressionOrderIntakeStage = {
  status: OperationsRegressionStageStatus
  provider: 'shopify' | 'faire'
  sourceReference: string
  intakeEvidenceHash: string
  customerNeutral: true
  detail: string
}

export type OperationsRegressionVarianceStage = {
  status: OperationsRegressionStageStatus
  changed: boolean
  packageCountDelta: number
  checkoutCarrierCostMinor: number
  checkoutCustomerChargeMinor: number
  fulfillmentCarrierCostMinor: number
  carrierCostVarianceMinor: number
  realizedMarginMinor: number
  currency: string
  allocationChanged: boolean
  materialChanged: boolean
  serviceChanged: boolean
  causes: string[]
}

type OperationsRegressionLabelFinalizationCommon = {
  noProviderWrites: true
  noPostagePurchases: true
  detail: string
}

export type OperationsRegressionLabelFinalizationStage =
  | OperationsRegressionLabelFinalizationCommon & {
    status: 'warning'
    responseSource: null
    packages: Array<{
      packageKey: string
      sequence: number
      status: 'not_finalized'
      carrier: null
      serviceCode: null
      recordedLabelReference: null
      trackingNumber: null
    }>
  }
  | OperationsRegressionLabelFinalizationCommon & {
    status: 'passed'
    responseSource: 'recorded_label_response'
    packages: Array<{
    packageKey: string
    sequence: number
    status: 'finalized'
    carrier: string
    serviceCode: string
    recordedLabelReference: string
    trackingNumber: string
  }>
  }

export type OperationsRegressionPackageDocumentsStage = {
  status: OperationsRegressionStageStatus
  finalPackingSlipEligible: boolean
  preLabelDocumentType: 'pack_work_instruction'
  packages: Array<{
    packageKey: string
    sequence: number
    trackingRequired: true
    trackingNumber: string | null
    finalPackingSlipStatus: 'blocked_until_label' | 'ready'
    finalPackingSlipGlobalId: string | null
  }>
  detail: string
}

export type OperationsRegressionRun = {
  globalId: string
  checkoutRunGlobalId: string
  fulfillmentRunGlobalId: string | null
  replayGroupKey: string
  scenarioId: string
  scenarioTitle: string
  status: 'succeeded' | 'expected_blocked' | 'failed'
  replayed: boolean
  createdAt: string
  noProviderWrites: true
  noPostagePurchases: true
  stages: {
    checkoutQuote:
      | OperationsRegressionPackRateStage
      | OperationsRegressionMarketplaceEstimateStage
    orderIntake: OperationsRegressionOrderIntakeStage
    customerResolution: OperationsRegressionCustomerResolutionStage
    fulfillmentExecution: OperationsRegressionPackRateStage | null
    variance: OperationsRegressionVarianceStage | null
    labelFinalization: OperationsRegressionLabelFinalizationStage
    packageDocuments: OperationsRegressionPackageDocumentsStage
  }
}

export type OperationsRegressionWalkthrough = {
  schemaVersion: typeof OPERATIONS_REGRESSION_REPLAY_SCHEMA_VERSION
  generatedAt: string
  scenarios: OperationsRegressionScenario[]
  runs: OperationsRegressionRun[]
}
