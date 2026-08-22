#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function section(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker)
  assert.notEqual(start, -1, `${label} is missing ${startMarker}`)
  const end = endMarker
    ? source.indexOf(endMarker, start + startMarker.length)
    : source.length
  assert.notEqual(end, -1, `${label} is missing ${endMarker}`)
  return source.slice(start, end)
}

function assertIncludes(source, fragments, label) {
  for (const fragment of fragments) {
    assert.ok(source.includes(fragment), `${label} is missing ${fragment}`)
  }
}

function loadPersistence() {
  const path = 'app_src/lib/persistence/cartonizationRateEvidence.ts'
  const output = ts.transpileModule(read(path), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
  }).outputText
  const module = { exports: {} }
  const requireModule = (specifier) => {
    if (specifier === '@/lib/auditWriter') {
      return { recordAuditEvent: async () => {} }
    }
    if (specifier === '@/lib/integrations/commerceCredentialCrypto') {
      return {
        decryptCommerceCandidateSnapshot: () => {
          throw new Error('not used by the hash contract')
        },
      }
    }
    if (specifier === '@/lib/integrations/carrierSandboxRate') {
      return {
        carrierSandboxPartyFingerprint: () => {
          throw new Error('not used by the hash contract')
        },
        normalizeCarrierSandboxParty: (value) => value,
      }
    }
    if (specifier === '@/lib/operations/fulfillmentOptimizerContract') {
      return fulfillmentOptimizerContract
    }
    if (specifier === '@/lib/operations/orderShipTo') {
      return { orderShipToStorageValue: (value) => value }
    }
    if (
      specifier
        === '@/lib/persistence/operationsOrderShipmentAddress'
    ) {
      return {
        readOperationsOrderShipmentAddressInPostgres: async () => {
          throw new Error('not used by the hash contract')
        },
      }
    }
    if (specifier === '@/lib/persistence/postgres') {
      return {
        acquireTransactionAdvisoryLock: async () => {},
        getPostgresPool: () => {
          throw new Error('not used by the hash contract')
        },
        withTransaction: async () => {
          throw new Error('not used by the hash contract')
        },
      }
    }
    return requireFromApp(specifier)
  }
  vm.runInNewContext(output, {
    Array,
    Boolean,
    Buffer,
    Date,
    Error,
    Map,
    Math,
    Number,
    Object,
    Promise,
    RegExp,
    Set,
    String,
    console,
    exports: module.exports,
    module,
    require: requireModule,
  }, { filename: path })
  return module.exports
}

function loadSandboxGeometryRatePlan() {
  const path =
    'app_src/lib/operations/sandboxCartonizationRatePlan.ts'
  const output = ts.transpileModule(read(path), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(output, {
    Array,
    Boolean,
    Error,
    Map,
    Math,
    Number,
    Object,
    Promise,
    RegExp,
    Set,
    String,
    console,
    exports: module.exports,
    module,
    require: requireFromApp,
  }, { filename: path })
  return module.exports
}

function loadFulfillmentOptimizerContract() {
  const path = 'app_src/lib/operations/fulfillmentOptimizerContract.ts'
  const output = ts.transpileModule(read(path), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(output, {
    Array,
    BigInt,
    Boolean,
    Buffer,
    Date,
    Error,
    Map,
    Math,
    Number,
    Object,
    RegExp,
    Set,
    String,
    console,
    exports: module.exports,
    module,
    require: requireFromApp,
  }, { filename: path })
  return module.exports
}

const fulfillmentOptimizerContract = loadFulfillmentOptimizerContract()

function loadOperationalGeometryRatePlan() {
  const path =
    'app_src/lib/operations/operationalGeometryCartonization.ts'
  const output = ts.transpileModule(read(path), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(output, {
    Array,
    Boolean,
    Date,
    Error,
    Map,
    Math,
    Number,
    Object,
    Promise,
    RegExp,
    Set,
    String,
    console,
    exports: module.exports,
    module,
    require(specifier) {
      if (specifier === '@/lib/operations/fulfillmentOptimizerContract') {
        return fulfillmentOptimizerContract
      }
      return requireFromApp(specifier)
    },
  }, { filename: path })
  return module.exports
}

function loadOperationalFaireRoute(
  observed,
  {
    activationState = 'shadow',
    providers = ['ups_rest', 'fedex_rest'],
    operationalGeometry = false,
    sandboxGeometry = false,
    planTransform = null,
    shadowTraining = false,
    sourceProvider = 'faire',
    zeroMaterialStock = false,
  } = {},
) {
  const path =
    'app_src/app/api/integrations/commerce/intake/cartonization-rate-evidence/route.ts'
  const output = ts.transpileModule(read(path), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
  }).outputText
  const module = { exports: {} }
  class PersistenceError extends Error {
    constructor(message, status = 409, code = 'PERSISTENCE_ERROR') {
      super(message)
      this.status = status
      this.code = code
    }
  }
  class IntegrationError extends Error {}
  const canonicalEvidenceValue = (value) => {
    if (Array.isArray(value)) return value.map(canonicalEvidenceValue)
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, canonicalEvidenceValue(item)]),
      )
    }
    return value
  }
  const evidenceHash = (value) => createHash('sha256')
    .update(JSON.stringify(canonicalEvidenceValue(value)))
    .digest('hex')
  const cartonizationRead = {
    organizationGlobalId: 'ga0000001',
    activationState,
    readAt: '2026-08-02T20:00:00.000Z',
    account: {
      globalId: 'gia0000001',
      provider: sourceProvider,
      status: 'active',
    },
    candidate: {
      globalId: 'gcoc0000001',
      orderNumber: 'FAIRE-TEST-1',
      rowVersion: 1,
      sourceHash: 'c'.repeat(64),
      workflowState: 'promoted',
      currency: 'USD',
    },
    warehouse: {
      globalId: 'gwh0000001',
      name: 'Faire local inventory warehouse',
    },
    inventory: {
      syncRunGlobalId: null,
      providerFetchedAt: null,
      completedAt: null,
      lines: [{
        lineGlobalId: 'gcol0000001',
        productGlobalId: 'gpr0000001',
        requiredQuantity: 1,
        assumedCommittedQuantity: 0,
      }],
      products: [{
        productGlobalId: 'gpr0000001',
        requiredQuantity: 1,
        availabilityAuthority: 'operational_available',
        operationalAvailableQuantity: shadowTraining ? 0 : 3,
        providerCommittedQuantity: 0,
        activeReservedQuantity: 0,
        assumedCommittedQuantity: 0,
        effectiveAvailableQuantity: shadowTraining ? 0 : 3,
        sourceLevelGlobalIds: [],
        sourcePositionGlobalIds: shadowTraining ? [] : ['giv0000001'],
        sourceProjectionStates: shadowTraining ? [] : ['projected'],
      }],
    },
    materialEvidence: [],
    recipeEvidence: [],
    lineEvidence: [],
    input: sandboxGeometry ? {
      mode: 'sandbox_demo',
      lines: [{
        lineGlobalId: 'gcol0000001',
        productGlobalId: 'gpr0000001',
        title: 'Sandbox mapped product',
        quantity: 1,
        unitWeightGrams: 400,
        profile: {
          versionGlobalId: 'gppv0000001',
          capturedRowVersion: 3,
          currentRowVersion: 3,
          isCurrent: true,
          lifecycleState: 'customer_confirmed',
          fitModel: 'rigid_3d',
          evidenceType: 'customer_confirmed',
          evidenceReference: 'sandbox-product-pack-proof',
          confirmedAt: '2026-08-02T19:00:00.000Z',
          outerDimensionsMm: {
            length: 180,
            width: 120,
            height: 80,
          },
        },
      }],
      recipes: [],
      materials: [{
        materialGlobalId: 'gmat0000001',
        capturedRowVersion: 2,
        currentRowVersion: 2,
        isCurrent: true,
        status: 'draft',
        innerDimensionsMm: {
          length: 200,
          width: 150,
          height: 100,
        },
        dimensionBasis: 'unconfirmed',
        dimensionEvidenceType: 'customer_confirmed',
        dimensionEvidenceReference: 'sandbox-material-proof',
        dimensionConfirmedAt: '2026-08-02T19:00:00.000Z',
        tareWeightGrams: null,
        maximumGrossWeightGrams: 2_000,
        availableQuantity: 0,
        ratedOuterDimensionsMm: null,
      }],
    } : {
      mode: 'production',
      lines: [{
        lineGlobalId: 'gcol0000001',
        quantity: 1,
      }],
      recipes: [],
      materials: [{
        materialGlobalId: 'gmat0000001',
        materialType: 'carton',
        capturedRowVersion: 2,
        currentRowVersion: 2,
        isCurrent: true,
        status: 'active',
        innerDimensionsMm: {
          length: 270,
          width: 220,
          height: 170,
        },
        ratedOuterDimensionsMm: {
          length: 280,
          width: 230,
          height: 180,
        },
        tareWeightGrams: 120,
        maximumGrossWeightGrams: 5000,
        unitCostMinor: 50,
        currency: 'USD',
        stockRowVersion: shadowTraining || zeroMaterialStock ? null : 1,
        stockOnHandQuantity: shadowTraining || zeroMaterialStock ? 0 : 5,
        activeClaimedQuantity: 0,
        availableQuantity: shadowTraining || zeroMaterialStock ? 0 : 5,
      }],
    },
  }
  let plan = sandboxGeometry || operationalGeometry ? {
    policyVersion: 'hybrid-cartonization-policy-v1',
    algorithmVersion: 'approved-recipe-v1',
    inputHash: 'a'.repeat(64),
    resultHash: 'b'.repeat(64),
    status: 'ready',
    selfPackages: [],
    recipePackages: [],
    geometryFallbackLines: [{
      lineGlobalId: 'gcol0000001',
      productGlobalId: 'gpr0000001',
      quantity: 1,
      fitModel: 'rigid_3d',
    }],
    assumptions: [],
    blockers: [],
  } : {
    policyVersion: 'hybrid-cartonization-policy-v1',
    algorithmVersion: 'approved-recipe-v1',
    inputHash: 'a'.repeat(64),
    resultHash: 'b'.repeat(64),
    status: 'ready',
    selfPackages: [],
    recipePackages: [{
      packageKey: 'package-1',
      sequence: 1,
      planningMethod: 'approved_recipe',
      packagingMaterialGlobalId: 'gmat0000001',
      packagingMaterialRowVersion: 2,
      materialEvidence: {
        innerDimensionsMm: {
          length: 270,
          width: 220,
          height: 170,
        },
      },
      contentWeightGrams: 170,
      rateReadiness: {
        status: 'ready',
        ratedOuterDimensionsMm: {
          length: 280,
          width: 230,
          height: 180,
        },
        tareWeightGrams: 120,
        ratedWeightGrams: 290,
      },
      lineAllocations: [{
        lineGlobalId: 'gcol0000001',
        productGlobalId: 'gpr0000001',
        title: 'Faire test product',
        quantity: 1,
        recipeGlobalId: 'gpkrc0000001',
        recipeRowVersion: 1,
        profileVersionGlobalId: 'gppv0000001',
        profileVersionRowVersion: 1,
      }],
    }],
    geometryFallbackLines: [],
    assumptions: [],
    blockers: [],
  }
  if (planTransform) plan = planTransform(plan)
  const carrierAccounts = providers.map((provider) => ({
    provider,
    environment: 'sandbox',
    status: 'active',
    configured: true,
    verificationStatus: 'verified',
    senderOriginWarehouseGlobalId: 'gwh0000001',
    carrierAccounts: [{
      globalId: provider === 'ups_rest'
        ? 'gca0000001'
        : 'gca0000002',
      status: 'active',
      allowSenderBilling: true,
    }],
  }))
  const mocks = {
    'next/server': {
      NextRequest: Request,
      NextResponse: {
        json(payload, options = {}) {
          return new Response(JSON.stringify(payload), {
            ...options,
            headers: options.headers,
          })
        },
      },
    },
    '@/lib/integrations/carrierIntegrations': {
      CarrierIntegrationRequestError: IntegrationError,
      getCarrierIntegrationsState: async () => ({
        accounts: carrierAccounts,
      }),
      sanitizedCarrierIntegrationError: (error) => error,
      testCarrierSandboxShipmentRate: async (input) => {
        if (!observed.sequence) observed.sequence = []
        observed.sequence.push(`carrier:${input.provider}`)
        observed.carrierReads.push(input)
        return {
          evidenceGlobalId: input.provider === 'ups_rest'
            ? 'grq0000001'
            : 'grq0000002',
        }
      },
    },
    '@/lib/integrations/carrierSandboxRate': {
      normalizeCarrierSandboxParcel: (input) => ({
        description: input.description,
        length: input.exteriorInches.length,
        width: input.exteriorInches.width,
        height: input.exteriorInches.height,
        dimensionUnit: 'IN',
        weight: input.grossPounds,
        weightUnit: 'LB',
      }),
    },
    '@/lib/integrations/commerceIntake': {
      assertCommerceIntakeRuntime() {},
    },
    '@/lib/integrations/commerceIntegrations': {
      CommerceIntegrationRequestError: IntegrationError,
      sanitizedCommerceIntegrationError: (error) => error,
    },
    '@/lib/integrations/shopifyOrderPlanningAuthority': {
      ShopifyOrderPlanningAuthorityError: IntegrationError,
      inspectShopifyOrderPlanningAuthority: async () => {
        observed.shopifyAuthorityCalls = (observed.shopifyAuthorityCalls || 0) + 1
        throw new Error(
          shadowTraining
            ? 'Exact Shadow training must not read Shopify planning authority'
            : 'Faire operational evidence must not read Shopify authority',
        )
      },
    },
    '@/lib/operations/authorization': {
      activeOperationsOrganizationId: () => (
        '00000000-0000-4000-8000-000000000001'
      ),
      operationsCapabilities: () => ({ canManage: true, canView: true, canExecute: true }),
    },
    '@/lib/operations/hybridCartonization': {
      planHybridCartonization: () => plan,
    },
    '@/lib/operations/operationalGeometryCartonization': {
      planOperationalGeometryRatePackages: async () => {
        if (operationalGeometry) {
          observed.geometryCalls = (observed.geometryCalls || 0) + 1
          return {
            status: 'ready',
            packages: [{
              packageKey: 'geometry-package-1',
              packageSequence: 1,
              planningMethod: 'or_tools',
              packagingMaterialGlobalId: 'gmat0000001',
              materialRowVersion: 2,
              recipes: [],
              orToolsProfiles: [],
              innerDimensionsMm: {
                length: 270,
                width: 220,
                height: 170,
              },
              ratedOuterDimensionsMm: {
                length: 280,
                width: 230,
                height: 180,
              },
              contentWeightGrams: 400,
              tareWeightGrams: 120,
              ratedGrossWeightGrams: 520,
              maxWeightGrams: 5000,
              allocations: [{
                lineGlobalId: 'gcol0000001',
                productGlobalId: 'gpr0000001',
                title: 'Shopify training product',
                quantity: 1,
              }],
            }],
          }
        }
        throw new Error(
          'The recipe and sandbox route fixtures must not use operational geometry',
        )
      },
    },
    '@/lib/operations/orToolsFulfillmentOptimizer': {
      configuredOrToolsFulfillmentOptimizer: () => null,
    },
    '@/lib/operations/sandboxCartonizationRatePlan': {
      planSandboxGeometryRatePackages: sandboxGeometry
        ? loadSandboxGeometryRatePlan()
          .planSandboxGeometryRatePackages
        : () => {
            throw new Error(
              'The operational Faire acceptance must not use sandbox geometry',
            )
          },
    },
    '@/lib/operations/shadowTraining': {
      OperationsShadowTrainingError: PersistenceError,
    },
    '@/lib/persistence/config': {
      isPostgresStorageEnabled: () => true,
    },
    '@/lib/persistence/cartonizationRateEvidence': {
      CARTONIZATION_RATE_EVIDENCE_CARRIER_PROVIDERS: [
        'ups_rest',
        'fedex_rest',
      ],
      cartonizationRateEvidenceHash: evidenceHash,
      CartonizationRateEvidencePersistenceError: PersistenceError,
      claimCartonizationRateEvidenceCommandInPostgres: async () => ({
        state: (observed.sequence || (observed.sequence = [])).push('claim') && 'created',
      }),
      failCartonizationRateEvidenceCommandInPostgres: async (input) => {
        if (!observed.commandFailures) observed.commandFailures = []
        observed.commandFailures.push(input)
      },
      MAX_CARTONIZATION_RATE_EVIDENCE_PACKAGES: 50,
      readCartonizationRateCandidateContext: async () => ({
        candidateSourceHash: cartonizationRead.candidate.sourceHash,
        destinationFingerprint: 'd'.repeat(64),
        destination: {
          name: 'Faire test customer',
          addressLine1: '35 Saxony Drive',
          city: 'Trumbull',
          stateOrProvinceCode: 'CT',
          postalCode: '06611',
          countryCode: 'US',
        },
      }),
      readCartonizationRateEvidenceByGlobalId: async () => null,
      writeCartonizationRateEvidenceInPostgres: async (input) => {
        if (!observed.sequence) observed.sequence = []
        observed.sequence.push('write')
        observed.write = input
        return { globalId: 'gcte0000001' }
      },
    },
    '@/lib/persistence/hybridCartonization': {
      HybridCartonizationPersistenceError: PersistenceError,
      readHybridCartonizationInputFromPostgres: async (input) => {
        if (!observed.sequence) observed.sequence = []
        observed.sequence.push('read')
        observed.readInput = input
        return cartonizationRead
      },
    },
    '@/lib/persistence/shopifyOrderPlanningAuthority': {
      ShopifyOrderPlanningAuthorityPersistenceError: PersistenceError,
      readOperationalOrderPlanningProviderFromPostgres: async () => sourceProvider,
    },
    '@/lib/persistence/shopifyTestStoreCanonicalE2e': {
      ShopifyTestStoreCanonicalE2ePersistenceError: PersistenceError,
      assertShopifyTestStoreCanonicalPlanningEvidenceAccessInPostgres: async () => {
        throw new Error('Unexpected Shopify test-store planning authorization')
      },
    },
    '@/lib/persistence/operationShadowTraining': {
      assertOperationsShadowTrainingEvidenceRequestInPostgres: async (input) => {
        if (!shadowTraining) {
          throw new Error(
            'Ordinary operational evidence must not authorize Shadow training',
          )
        }
        if (!observed.sequence) observed.sequence = []
        observed.sequence.push('training-auth')
        observed.trainingAuthorization = input
        return {
          runGlobalId: input.runGlobalId,
          runRowVersion: input.expectedRunRowVersion,
        }
      },
    },
    '@/lib/requestUser': {
      requireRequestUser: async () => ({ email: 'operator@example.com' }),
    },
  }
  vm.runInNewContext(output, {
    Array,
    BigInt,
    Boolean,
    Buffer,
    Date,
    Error,
    Headers,
    JSON,
    Map,
    Math,
    Number,
    Object,
    Promise,
    RegExp,
    Request,
    Response,
    Set,
    String,
    TextDecoder,
    TextEncoder,
    URL,
    console,
    exports: module.exports,
    module,
    process,
    require(specifier) {
      if (Object.prototype.hasOwnProperty.call(mocks, specifier)) {
        return mocks[specifier]
      }
      return requireFromApp(specifier)
    },
  }, { filename: path })
  return module.exports
}

const migration = read(
  'db/migrations/0137_operations_cartonization_rate_evidence.sql',
)
const integrityMigration = read(
  'db/migrations/0138_operations_cartonization_rate_evidence_integrity.sql',
)
const scaleMigration = read(
  'db/migrations/0142_operations_cartonization_evidence_scale.sql',
)
const shipmentRateMigration = read(
  'db/migrations/0143_operations_cartonization_shipment_rates.sql',
)
const shipmentRateConstraintRepairMigration = read(
  'db/migrations/0144_operations_cartonization_shipment_rate_constraint_repair.sql',
)
const enabledCarrierMigration = read(
  'db/migrations/0259_operations_cartonization_enabled_carriers.sql',
)
const sandboxFixedAxisMigration = read(
  'db/migrations/0260_operations_cartonization_sandbox_fixed_axis.sql',
)
const orToolsProfileMigration = read(
  'db/migrations/0261_operations_cartonization_or_tools_profile_evidence.sql',
)
const persistence = read(
  'app_src/lib/persistence/cartonizationRateEvidence.ts',
)
const route = read(
  'app_src/app/api/integrations/commerce/intake/cartonization-rate-evidence/route.ts',
)
const workflow = read(
  'app_src/components/settings/CommerceIntakeWorkflow.tsx',
)
const operationsPersistence = read(
  'app_src/lib/persistence/operations.ts',
)

assertIncludes(migration, [
  'request_hash text NOT NULL',
  'write_token_hash text NOT NULL',
  'sealed_at timestamptz',
  'UNIQUE (organization_id, idempotency_key)',
  'operations_cartonization_dimensions_mm_valid',
  'operations_cartonization_allocations_valid',
  "jsonb_typeof(value) IS DISTINCT FROM 'object'",
  ") IS DISTINCT FROM\n      ARRAY['height', 'length', 'width']::text[]",
  "jsonb_typeof(item) IS DISTINCT FROM 'object'",
  'FOREIGN KEY (organization_id, integration_account_id)',
  'FOREIGN KEY (\n      organization_id, integration_account_id, order_candidate_id',
  'organization_id, integration_account_id, warehouse_id,\n      inventory_sync_run_id',
  'UNIQUE (organization_id, id)',
], 'Evidence header database authority')

const packageTable = section(
  migration,
  'CREATE TABLE IF NOT EXISTS operations_cartonization_rate_evidence_packages',
  'CREATE TABLE IF NOT EXISTS operations_cartonization_rate_evidence_quotes',
  'Evidence package table',
)
assertIncludes(packageTable, [
  'organization_id uuid NOT NULL',
  'PRIMARY KEY (organization_id, evidence_id, package_key)',
  'FOREIGN KEY (organization_id, evidence_id)',
  'FOREIGN KEY (organization_id, packaging_material_id)',
  'organization_id, packaging_material_id, approved_pack_recipe_id',
  'UNIQUE (organization_id, evidence_id, package_sequence)',
  'rated_gross_weight_grams = content_weight_grams + tare_weight_grams',
], 'Tenant-scoped package evidence')

const quoteTable = section(
  migration,
  'CREATE TABLE IF NOT EXISTS operations_cartonization_rate_evidence_quotes',
  'CREATE OR REPLACE FUNCTION\n  validate_operations_cartonization_rate_evidence_child_insert()',
  'Evidence quote table',
)
assertIncludes(quoteTable, [
  "provider text NOT NULL CHECK (provider IN ('ups_rest', 'fedex_rest'))",
  "rate_purpose text NOT NULL DEFAULT 'cartonization_package_rate'",
  "CHECK (rate_purpose = 'cartonization_package_rate')",
  'PRIMARY KEY (organization_id, evidence_id, package_key, provider)',
  'organization_id, provider, rate_purpose, carrier_rate_request_id',
  'organization_id, provider, purpose, id',
], 'Carrier quote evidence')

const sealingContract = section(
  migration,
  'CREATE OR REPLACE FUNCTION\n  validate_operations_cartonization_rate_evidence_child_insert()',
  'COMMENT ON TABLE operations_cartonization_rate_evidence',
  'Evidence sealing contract',
)
assertIncludes(sealingContract, [
  "current_setting(\n    'clawpilot.cartonization_evidence_write_token'",
  "encode(digest(supplied_token, 'sha256'), 'hex')",
  'evidence_sealed_at IS NOT NULL',
  "(to_jsonb(NEW) - 'sealed_at') = (to_jsonb(OLD) - 'sealed_at')",
  'package_count NOT BETWEEN 1 AND 8',
  'count(quote.provider) <> 2',
  "quote.provider = 'ups_rest'",
  "quote.provider = 'fedex_rest'",
  'quote.quote_status IS DISTINCT FROM rate.status',
  'quote.error_code IS DISTINCT FROM rate.error_code',
  'evidence_status = \'partial\'',
  'DEFERRABLE INITIALLY DEFERRED',
  'BEFORE UPDATE OR DELETE ON operations_cartonization_rate_evidence_packages',
  'BEFORE UPDATE OR DELETE ON operations_cartonization_rate_evidence_quotes',
], 'Sealed immutable aggregate')
assertIncludes(scaleMigration, [
  'validate_operations_cartonization_rate_evidence_complete()',
  'package_count NOT BETWEEN 1 AND 64',
  'one UPS and one FedEx quote per package',
], 'Legacy scaled physical-package evidence contract')
assertIncludes(shipmentRateMigration, [
  "'cartonization_shipment_rate'",
  "SET DEFAULT 'cartonization_shipment_rate'",
  'package_count NOT BETWEEN 1 AND 50',
  'jsonb_agg(',
  'ORDER BY package.package_sequence, package.package_key',
  "rate.redacted_request #> '{shipment,parcels}'",
  'IS DISTINCT FROM ordered_parcels',
  'count(DISTINCT (\n        quote.provider, quote.carrier_rate_request_id',
  'count(DISTINCT quote.carrier_rate_request_id) <> 1',
  'count(DISTINCT quote.package_rate_context_hash) <> 1',
  "'multi_package_shipment'",
  'Cartonization evidence cannot mix package and shipment rate purposes',
], 'Whole-shipment carrier evidence migration')
assertIncludes(shipmentRateConstraintRepairMigration, [
  'DROP CONSTRAINT IF EXISTS',
  'operations_cartonization_rate_evidence_quote_rate_purpose_check',
], 'Whole-shipment quote-purpose constraint repair')
assertIncludes(enabledCarrierMigration, [
  'required_carrier_providers text[] NOT NULL',
  "ARRAY['ups_rest']::text[]",
  "ARRAY['fedex_rest']::text[]",
  "ARRAY['ups_rest', 'fedex_rest']::text[]",
  'cardinality(required_carrier_providers)',
  'quote.provider = ANY(required_carrier_providers)',
  'one supporting edge from every retained carrier per package',
], 'Enabled-carrier cartonization evidence migration')
assertIncludes(sandboxFixedAxisMigration, [
  "'sandbox_fixed_axis'",
  'pg_get_constraintdef(constraint_record.oid)',
  'matching_constraint_count <> 1',
  'ops_cart_rate_pkg_planning_method_check',
  "planning_method IN ('or_tools', 'sandbox_fixed_axis')",
  'validate_operations_cartonization_sandbox_fixed_axis_recipe_edges()',
  'DEFERRABLE INITIALLY DEFERRED',
  "evidence.evidence_mode = 'assumption_backed_sandbox'",
  'Sandbox fixed-axis packages require assumption-backed sandbox evidence',
  'Sandbox fixed-axis cartonization packages cannot retain approved recipe edges',
], 'Sandbox fixed-axis planner provenance migration')
assertIncludes(orToolsProfileMigration, [
  'operations_cartonization_rate_evidence_package_profiles',
  'input_pack_profile_version_id',
  "fit_model = 'rigid_3d'",
  'validate_operations_cartonization_rate_evidence_child_insert()',
  'protect_operations_append_only()',
  'validate_operations_cartonization_rate_profile_evidence_complete()',
  'DEFERRABLE INITIALLY DEFERRED',
  "evidence.evidence_mode <> 'operational'",
  "package.planning_method = 'or_tools'",
  'jsonb_array_length(package.allocations)',
  "profile_version.dimension_basis = 'outer'",
  "profile_version.lifecycle_state = 'active'",
  'profile_version.is_current = true',
], 'Operational OR-Tools profile evidence migration')

assertIncludes(persistence, [
  'export function cartonizationRateEvidenceHash',
  'MAX_CARTONIZATION_RATE_EVIDENCE_PACKAGES = 50',
  'CartonizationRateEvidenceMaterialRateAssumption',
  'CARTONIZATION_RATE_EVIDENCE_CARRIER_PROVIDERS',
  'assertCartonizationRateEvidenceCarrierCoverage',
  'assertCartonizationRateEvidenceOrToolsProfiles',
  'assertCartonizationRateEvidenceOperationalGeometryProvenance',
  'CARTONIZATION_RATE_EVIDENCE_OR_TOOLS_PROVENANCE_INVALID',
  'canonicalOptimizerHash(optimizerInput)',
  'parseFulfillmentOptimizationResult(',
  'requiredCarrierProviders',
  'assertCartonizationRateEvidenceMaterialAssumptions',
  'materialRateAssumptions',
  'CARTONIZATION_RATE_EVIDENCE_OPERATIONAL_ASSUMPTIONS_FORBIDDEN',
  'CARTONIZATION_RATE_EVIDENCE_OPERATIONAL_RATE_ENVIRONMENT_INVALID',
  'CARTONIZATION_RATE_EVIDENCE_OPERATIONAL_MATERIAL_STALE',
  'CARTONIZATION_RATE_EVIDENCE_OPERATIONAL_MATERIAL_STOCK_STALE',
  'CARTONIZATION_RATE_EVIDENCE_MATERIAL_ASSUMPTION_MISMATCH',
  "planningMethod === 'sandbox_fixed_axis'",
  "packageInput.planningMethod !== 'approved_recipe'",
  'CARTONIZATION_RATE_EVIDENCE_SANDBOX_GEOMETRY_EVIDENCE_INVALID',
  'rateContextsByEvidence',
  'export function cartonizationRateEvidenceRequestHash',
  'const packages = [...input.packages].sort(',
  'export function cartonizationPackageRateContextHash',
  'export function cartonizationShipmentRateContextHash',
  "carrierRatePurpose: 'cartonization_shipment_rate'",
  "AND purpose = 'cartonization_shipment_rate'",
  'const orderedShipmentParcels = [...input.packages]',
  'rateEvidenceByProvider',
  'one whole-shipment carrier result for every package',
  "rateScope !== 'multi_package_shipment'",
  "rateScope: 'multi_package_shipment'",
  "shipmentRates",
  'claimCartonizationRateEvidenceCommandInPostgres',
  'failCartonizationRateEvidenceCommandInPostgres',
  'semantic_request_hash',
  'carrier_request_hash',
  'redacted_request',
  'const inputPlanResultHash = cartonizationRateEvidenceHash(input.planSnapshot)',
  'cartonizationRateEvidenceHash({',
  'CARTONIZATION_RATE_EVIDENCE_IDEMPOTENCY_CONFLICT',
  'CARTONIZATION_RATE_DESTINATION_INVALID',
  'The confirmed ship-to address is not carrier-ready',
  'product.reference_code AS product_global_id',
  'AND product.reference_code = $5',
  'primaryRecipe?.recipeRowVersion ?? null',
  'evidence.sealed_at IS NOT NULL',
  'inventory_run.warehouse_id = warehouse.id',
  'recipe.packaging_material_id = $2::uuid',
  "'clawpilot.cartonization_evidence_write_token'",
  'SET sealed_at = now()',
  'Evidence status must be ${expectedStatus}',
], 'Persistence integrity contract')
assert.doesNotMatch(
  persistence,
  /\bcanonicalHash\(/,
  'The retired hash helper must not remain referenced',
)
const warehousePlanningBoundary = section(
  operationsPersistence,
  'export async function planOperationsOrderFromPostgres(',
  'export async function releaseOperationsOrderFromPostgres(',
  'Warehouse planning evidence boundary',
)
assertIncludes(warehousePlanningBoundary, [
  "item.planningMethod === 'sandbox_fixed_axis'",
  "package.planning_method,",
  "item.planning_method === 'sandbox_fixed_axis'",
  'OPERATIONS_CARTONIZATION_SANDBOX_PACKAGE_FORBIDDEN',
  'Assumption-backed sandbox fixed-axis packages cannot become warehouse work',
  'operations_cartonization_rate_evidence_package_profiles',
  'operations_commerce_current_planning_lines candidate_line',
  'candidate_line.pack_profile_version_id',
  'candidate_line.pack_profile_version_row_version',
  "candidate_line.mapping_state AS candidate_line_mapping_state",
  'FOR UPDATE OF profile_version',
  'OPERATIONS_CARTONIZATION_PROFILE_EVIDENCE_STALE',
  'AND position_id = $2::uuid',
  "AND reservation_authority = 'provider_commitment'",
], 'Warehouse planning must reject sandbox fixed-axis evidence before stock work')
assert.doesNotMatch(
  persistence,
  /product\.global_id/,
  'Cartonization evidence must use the CRM product reference_code column',
)
assert.doesNotMatch(
  persistence,
  /primaryRecipe\?\.recipeRowVersion \|\| null/,
  'A valid zero recipe row version must not be coerced to null',
)

assertIncludes(route, [
  'export async function POST(req: NextRequest)',
  "version: 'cartonization-rate-evidence-command-v1'",
  'function cartonizationRateEvidenceCommandHash(',
  "error.message === 'ACTIVE_ORGANIZATION_REQUIRED'",
  'MAX_SELECTED_MATERIALS = 8',
  'selected.length < 1',
  'selected.length > MAX_SELECTED_MATERIALS',
  'sandboxRateAssumptions',
  'sandboxMaterialRateAssumptions(request)',
  "request.evidenceMode === 'operational'",
  "carrierReadEnvironment: 'sandbox'",
  'operatorSuppliedAssumptions: false',
  'operationalMaterialFacts',
  "'shopify_provider_commitment_preflight'",
  "'transactional_provider_commitment_lock'",
  'rateAssumptionsByMaterial',
  'readHybridCartonizationInputFromPostgres',
  'readCartonizationRateCandidateContext',
  'planHybridCartonization',
  'claimCartonizationRateEvidenceCommandInPostgres',
  'semanticRequestHash',
  'const orderedParcels = [...packageInputs]',
  'left.packageSequence - right.packageSequence',
  'CARTONIZATION_RATE_EVIDENCE_CARRIER_PROVIDERS.filter(',
  "account.verificationStatus === 'verified'",
  'testCarrierSandboxShipmentRate',
  'parcels: orderedParcels',
  'shipmentRateEvidenceByProvider',
  'carrierQuoteEdges: quotes.length',
  'carrierRateReads: 0',
  'policyVersion: plan.policyVersion',
  'lineEvidence: read.lineEvidence',
  'writeCartonizationRateEvidenceInPostgres',
  'inventoryWrites: 0',
  'shipmentWrites: 0',
  'labelCalls: 0',
  'postagePurchases: 0',
  'providerWrites: 0',
  'planSandboxGeometryRatePackages',
  "request.evidenceMode === 'operational'",
  'sandboxGeometryRatePlan',
  'packagePlan.planningMethod',
  'CARTONIZATION_RATE_EVIDENCE_SELF_PACKAGE_UNSUPPORTED',
  'CARTONIZATION_RATE_EVIDENCE_ALLOCATION_COVERAGE_INVALID',
], 'Executable package-and-rate workflow')
const operationalGeometryFence = section(
  route,
  "request.evidenceMode === 'operational'\n      && plan.geometryFallbackLines.length > 0",
  'const sandboxGeometryRatePlan =',
  'Operational geometry fence',
)
assertIncludes(operationalGeometryFence, [
  'configuredOrToolsFulfillmentOptimizer()',
  'planOperationalGeometryRatePackages({',
  'optimizer,',
  "operationalGeometryRatePlan.status === 'blocked'",
], 'Operational geometry must use one fail-closed OR-Tools plan')
assert.doesNotMatch(
  operationalGeometryFence,
  /activationState|CARTONIZATION_RATE_EVIDENCE_SHADOW_REQUIRED/u,
  'Operational read-only rating must not depend on workspace activation',
)
const sandboxGeometrySection = section(
  route,
  'const sandboxGeometryRatePlan =',
  'const packagePlanCount =',
  'Sandbox geometry package construction',
)
assertIncludes(sandboxGeometrySection, [
  "request.evidenceMode === 'assumption_backed_sandbox'",
  'planSandboxGeometryRatePackages({',
  'lines: read.input.lines',
  'materialAssumptions: selectedMaterialRateAssumptions',
  'MAX_CARTONIZATION_RATE_EVIDENCE_PACKAGES',
], 'Sandbox geometry package construction')
assert.ok(
  route.indexOf('claimCartonizationRateEvidenceCommandInPostgres({')
    < route.indexOf('readHybridCartonizationInputFromPostgres({'),
  'The durable idempotency claim must precede database planning and carrier reads',
)
const commandHashSection = section(
  route,
  'function cartonizationRateEvidenceCommandHash(',
  'function errorResponse(',
  'Stable cartonization command hash',
)
assert.doesNotMatch(
  commandHashSection,
  /readAt|planSnapshot|carrierReadEnvironment/,
  'The durable command identity must exclude volatile read and plan output',
)
assertIncludes(workflow, [
  'canManage: boolean',
  'readonly preserveIdempotencyKey = false',
  "evidenceMode: 'operational'",
  "evidenceMode: 'assumption_backed_sandbox'",
  '`cartonization-rate-evidence:${JSON.stringify(command)}`',
  "'CARTONIZATION_RATE_EVIDENCE_IN_PROGRESS'",
  'response.status >= 500',
  '!explicitApplicationFailure',
  '&& !caught.preserveIdempotencyKey',
  'createOperationalCartonizationRateEvidence',
  'operationalRateEvidenceReady',
  'Save operational pack facts',
  'Save sandbox comparison',
  'READ-ONLY SANDBOX CARRIER ESTIMATES',
], 'Operator evidence-mode workflow')
assert.equal(
  workflow.includes(
    'Faire account-bound inventory reconciliation is not implemented yet.',
  ),
  false,
  'Faire candidates must expose the implemented local-inventory cartonization workflow',
)
assertIncludes(workflow, [
  'candidate.requiresShipping !== false ? (',
  'void openCartonizationPreview(candidate)',
  'Pack & compare rates',
], 'Provider-neutral candidate cartonization action')
assert.equal(
  workflow.match(/response\.status >= 500/g)?.length,
  2,
  'Both evidence modes must preserve retry identity after 5xx responses',
)
assert.equal(
  workflow.match(/&& !caught\.preserveIdempotencyKey/g)?.length,
  2,
  'Both evidence modes must rotate retry identity only after terminal responses',
)
const packPlanningLock = section(
  workflow,
  'const packPlanningLocked = (',
  'const address = candidate.shipTo?.address',
  'Promoted-order pack-planning lock',
)
assert.doesNotMatch(
  packPlanningLock,
  /candidate\.state === 'promoted'/,
  'Promotion must not lock the factual warehouse-planning workflow',
)
const promotedMaterialDefault = section(
  workflow,
  'const operationalMaterials = activeWarehouseGlobalId',
  'setCartonizationMaterials(materials)',
  'Promoted-order material default',
)
assertIncludes(promotedMaterialDefault, [
  'operationalPackagingMaterialBlockers(',
  "candidate.state === 'promoted'",
  'operationalAg12v2Material',
  'operationalMaterials[0]',
  'eligible[0]',
], 'Promoted-order operational material preference')
assert.ok(
  promotedMaterialDefault.indexOf('operationalMaterials[0]')
    < promotedMaterialDefault.lastIndexOf('eligible[0]'),
  'Promoted-order defaults must prefer operational material before a generic optimizer-ready fallback',
)
const fitPreviewHandler = section(
  workflow,
  'async function runCartonizationPreview()',
  'async function createCartonizationRateEvidence()',
  'Fit-only preview handler',
)
assertIncludes(fitPreviewHandler, [
  "candidate?.state === 'promoted'",
  'Fit-only preview is unavailable after an order is added to ClawPilot.',
  'Save operational pack facts for warehouse planning.',
], 'Promoted-order fit-preview guard')
const assumptionBackedHandler = section(
  workflow,
  'async function createCartonizationRateEvidence()',
  'async function createOperationalCartonizationRateEvidence()',
  'Assumption-backed comparison handler',
)
assertIncludes(assumptionBackedHandler, [
  "candidate?.state === 'promoted'",
  'Assumption-backed sandbox comparison is unavailable after an order is added to ClawPilot.',
  'Correct the warehouse, product packing profile, or packaging material master data',
], 'Promoted-order sandbox-comparison guard')
assertIncludes(workflow, [
  "cartonizationCandidate?.state === 'promoted'",
  'Step 2 · Save warehouse planning evidence',
  'Warehouse planning must use the',
  'current provider inventory, product packing profiles, and',
  'factual packaging master data.',
], 'Promoted-order warehouse-planning UI')
const dialogActions = section(
  workflow,
  'aria-labelledby="cartonization-preview-title"',
  '</DialogActions>',
  'Pack-and-rate dialog actions',
)
assertIncludes(dialogActions, [
  'title={promotedWarehousePlanning',
  'disabled={\n              promotedWarehousePlanning',
  'Run fit-only preview',
  'Save sandbox comparison',
  'Save operational pack facts',
], 'Promoted-order action visibility')
assert.doesNotMatch(
  route,
  /CARTONIZATION_RATE_EVIDENCE_ONE_MATERIAL_REQUIRED/,
  'Carrier evidence must not retain the retired one-material restriction',
)

assertIncludes(integrityMigration, [
  'operations_cartonization_rate_evidence_package_recipes',
  'operations_cartonization_rate_evidence_commands',
  'destination_fingerprint',
  'carrier_parcel_snapshot',
  'carrier_request_hash',
  'package_rate_context_hash',
  'operations_cartonization_carrier_parcel_valid',
  "rate.redacted_request #>>\n          '{shipment,destinationFingerprint}'",
  "rate.redacted_request #> '{shipment,parcel}'",
  'FOR EACH ROW EXECUTE FUNCTION\n  validate_operations_cartonization_rate_evidence_child_insert()',
], 'Additive evidence integrity migration')
assert.doesNotMatch(
  section(
    integrityMigration,
    'ALTER TABLE operations_cartonization_rate_evidence_packages\n  ALTER COLUMN carrier_parcel_snapshot',
    'ALTER TABLE operations_cartonization_rate_evidence_quotes',
    'Parcel table check',
  ),
  /\bSELECT\b/,
  'CHECK constraints must not contain PostgreSQL-forbidden subqueries',
)
assert.doesNotMatch(
  route,
  /createCarrierSandboxRateTestLabel|createOperationShipment|queuePrintJob/,
  'Package-and-rate evidence must not call label, shipment, or print paths',
)

const {
  assertCartonizationRateEvidenceCarrierCoverage,
  assertCartonizationRateEvidenceMaterialAssumptions,
  assertCartonizationRateEvidenceOperationalGeometryProvenance,
  assertCartonizationRateEvidenceOrToolsProfiles,
  cartonizationRateEvidenceHash,
  cartonizationRateEvidenceRequestHash,
  cartonizationShipmentRateContextHash,
  CartonizationRateEvidencePersistenceError,
} = loadPersistence()

const {
  SANDBOX_GEOMETRY_RATE_POLICY_VERSION,
  planSandboxGeometryRatePackages,
} = loadSandboxGeometryRatePlan()

const sandboxLine = {
  lineGlobalId: 'gcol0000001',
  productGlobalId: 'gp0000001',
  title: 'Mapped test product',
  quantity: 2,
  unitWeightGrams: 400,
  profile: {
    versionGlobalId: 'gppv0000001',
    capturedRowVersion: 3,
    currentRowVersion: 3,
    isCurrent: true,
    lifecycleState: 'customer_confirmed',
    fitModel: 'rigid_3d',
    evidenceType: 'customer_confirmed',
    evidenceReference: 'customer-pack-proof',
    confirmedAt: '2026-08-10T12:00:00.000Z',
    outerDimensionsMm: { length: 180, width: 120, height: 80 },
  },
}
const sandboxMaterials = [
  {
    materialGlobalId: 'gmat0000002',
    capturedRowVersion: 4,
    currentRowVersion: 4,
    isCurrent: true,
    status: 'draft',
    innerDimensionsMm: { length: 300, width: 250, height: 200 },
    dimensionBasis: 'inner',
    dimensionEvidenceType: 'customer_confirmed',
    dimensionEvidenceReference: 'customer-box-proof-large',
    dimensionConfirmedAt: '2026-08-10T12:00:00.000Z',
    tareWeightGrams: null,
    maximumGrossWeightGrams: null,
    availableQuantity: null,
    ratedOuterDimensionsMm: null,
  },
  {
    materialGlobalId: 'gmat0000001',
    capturedRowVersion: 2,
    currentRowVersion: 2,
    isCurrent: true,
    status: 'draft',
    innerDimensionsMm: { length: 200, width: 150, height: 100 },
    dimensionBasis: 'unconfirmed',
    dimensionEvidenceType: 'measured',
    dimensionEvidenceReference: null,
    dimensionConfirmedAt: '2026-08-10T12:00:00.000Z',
    tareWeightGrams: null,
    maximumGrossWeightGrams: 2_000,
    availableQuantity: 0,
    ratedOuterDimensionsMm: null,
  },
]
const sandboxMaterialAssumptions = [
  {
    materialGlobalId: 'gmat0000002',
    expectedRowVersion: 4,
    ratedOuterDimensionsMm: { length: 310, width: 260, height: 210 },
    tareWeightGrams: 150,
  },
  {
    materialGlobalId: 'gmat0000001',
    expectedRowVersion: 2,
    ratedOuterDimensionsMm: { length: 210, width: 160, height: 110 },
    tareWeightGrams: 100,
  },
]
const sandboxGeometryPlan = planSandboxGeometryRatePackages({
  lines: [sandboxLine],
  fallbackLines: [{
    lineGlobalId: sandboxLine.lineGlobalId,
    productGlobalId: sandboxLine.productGlobalId,
    quantity: 2,
    fitModel: 'rigid_3d',
  }],
  materials: sandboxMaterials,
  materialAssumptions: sandboxMaterialAssumptions,
  startingSequence: 1,
  maximumPackages: 50,
})
assert.equal(sandboxGeometryPlan.status, 'ready')
assert.equal(sandboxGeometryPlan.packages.length, 2)
assert.equal(
  sandboxGeometryPlan.packages[0].packagingMaterialGlobalId,
  'gmat0000001',
  'Sandbox geometry must choose the smallest exact fixed-axis fit deterministically',
)
assert.equal(sandboxGeometryPlan.packages[0].allocations[0].quantity, 1)
assert.equal(sandboxGeometryPlan.packages[0].contentWeightGrams, 400)
assert.equal(sandboxGeometryPlan.packages[0].tareWeightGrams, 100)
assert.equal(sandboxGeometryPlan.packages[0].ratedGrossWeightGrams, 500)
assert.equal(
  sandboxGeometryPlan.packages[0].planningMethod,
  'sandbox_fixed_axis',
)
assert.equal(
  sandboxGeometryPlan.packages[0].geometryEvidence.policyVersion,
  SANDBOX_GEOMETRY_RATE_POLICY_VERSION,
)
assert.equal(
  sandboxGeometryPlan.packages[0].geometryEvidence.materialDimensionBasis,
  'unconfirmed',
  'Sandbox geometry must retain the actual material dimension basis without upgrading it to inner evidence',
)
assert.equal(
  sandboxGeometryPlan.packages[0].geometryEvidence
    .materialDimensionEvidenceReference,
  null,
  'Sandbox rate evidence must preserve a measured null reference truthfully',
)
assert.equal(
  sandboxGeometryPlan.evidence.materialStockAuthority,
  'not_used_for_sandbox_comparison',
  'Draft/zero-stock material must remain a comparison assumption, not operational stock authority',
)
const reorderedSandboxGeometryPlan = planSandboxGeometryRatePackages({
  lines: [sandboxLine],
  fallbackLines: [{
    lineGlobalId: sandboxLine.lineGlobalId,
    productGlobalId: sandboxLine.productGlobalId,
    quantity: 2,
    fitModel: 'rigid_3d',
  }],
  materials: [...sandboxMaterials].reverse(),
  materialAssumptions: [...sandboxMaterialAssumptions].reverse(),
  startingSequence: 1,
  maximumPackages: 50,
})
assert.deepEqual(
  JSON.parse(JSON.stringify(reorderedSandboxGeometryPlan)),
  JSON.parse(JSON.stringify(sandboxGeometryPlan)),
  'Sandbox geometry must not depend on selected-material request order',
)
const sandboxNoFit = planSandboxGeometryRatePackages({
  lines: [sandboxLine],
  fallbackLines: [{
    lineGlobalId: sandboxLine.lineGlobalId,
    productGlobalId: sandboxLine.productGlobalId,
    quantity: 1,
    fitModel: 'rigid_3d',
  }],
  materials: [{
    ...sandboxMaterials[1],
    innerDimensionsMm: { length: 179, width: 150, height: 100 },
  }],
  materialAssumptions: [{
    ...sandboxMaterialAssumptions[1],
    ratedOuterDimensionsMm: { length: 210, width: 160, height: 110 },
  }],
  startingSequence: 1,
  maximumPackages: 50,
})
assert.equal(sandboxNoFit.status, 'blocked')
assert.equal(
  sandboxNoFit.blocker.code,
  'CARTONIZATION_RATE_EVIDENCE_SANDBOX_GEOMETRY_NO_FIT',
)
const sandboxOuterSmallerThanFit = planSandboxGeometryRatePackages({
  lines: [sandboxLine],
  fallbackLines: [{
    lineGlobalId: sandboxLine.lineGlobalId,
    productGlobalId: sandboxLine.productGlobalId,
    quantity: 1,
    fitModel: 'rigid_3d',
  }],
  materials: [sandboxMaterials[1]],
  materialAssumptions: [{
    ...sandboxMaterialAssumptions[1],
    ratedOuterDimensionsMm: { length: 199, width: 150, height: 100 },
  }],
  startingSequence: 1,
  maximumPackages: 50,
})
assert.equal(sandboxOuterSmallerThanFit.status, 'blocked')
assert.equal(
  sandboxOuterSmallerThanFit.blocker.code,
  'CARTONIZATION_RATE_EVIDENCE_MATERIAL_ASSUMPTIONS_MISSING',
  'A rated exterior assumption cannot be smaller than retained fit dimensions',
)
const sandboxMissingPackDimensions = planSandboxGeometryRatePackages({
  lines: [{
    ...sandboxLine,
    profile: { ...sandboxLine.profile, outerDimensionsMm: null },
  }],
  fallbackLines: [{
    lineGlobalId: sandboxLine.lineGlobalId,
    productGlobalId: sandboxLine.productGlobalId,
    quantity: 1,
    fitModel: 'rigid_3d',
  }],
  materials: sandboxMaterials,
  materialAssumptions: sandboxMaterialAssumptions,
  startingSequence: 1,
  maximumPackages: 50,
})
assert.equal(sandboxMissingPackDimensions.status, 'blocked')
assert.equal(
  sandboxMissingPackDimensions.blocker.code,
  'CARTONIZATION_RATE_EVIDENCE_SANDBOX_LINE_PACK_REQUIRED',
  'Sandbox assumptions must never replace the current exact product pack profile',
)

const { planOperationalGeometryRatePackages } =
  loadOperationalGeometryRatePlan()
const operationalGeometryInput = {
  organizationGlobalId: 'go0000001',
  provider: 'shopify',
  candidateGlobalId: 'gcoc0000001',
  candidateRowVersion: 3,
  currency: 'USD',
  readAt: '2026-08-02T20:00:00.000Z',
  warehouseGlobalId: 'gwh0000001',
  lines: [{
    lineGlobalId: 'gcol0000001',
    productGlobalId: 'gp0000001',
    title: 'Exact measured product',
    quantity: 2,
    unitWeightGrams: 200,
    profile: {
      versionGlobalId: 'gppv0000001',
      capturedRowVersion: 3,
      currentRowVersion: 3,
      isCurrent: true,
      lifecycleState: 'active',
      fitModel: 'rigid_3d',
      outerDimensionsMm: { length: 100, width: 80, height: 40 },
      grossWeightGrams: 200,
    },
  }],
  fallbackLines: [{
    lineGlobalId: 'gcol0000001',
    productGlobalId: 'gp0000001',
    quantity: 2,
    fitModel: 'rigid_3d',
  }],
  recipePackages: [],
  materials: [{
    materialGlobalId: 'gmat0000001',
    materialType: 'carton',
    capturedRowVersion: 2,
    currentRowVersion: 2,
    isCurrent: true,
    status: 'active',
    innerDimensionsMm: { length: 250, width: 200, height: 150 },
    ratedOuterDimensionsMm: { length: 260, width: 210, height: 160 },
    tareWeightGrams: 120,
    maximumGrossWeightGrams: 10_000,
    unitCostMinor: 55,
    currency: 'USD',
    stockRowVersion: 4,
    stockOnHandQuantity: 5,
    activeClaimedQuantity: 1,
    availableQuantity: 4,
  }],
  inventoryProducts: [{
    productGlobalId: 'gp0000001',
    availabilityAuthority: 'shopify_provider_commitment',
    providerCommittedQuantity: 3,
    activeReservedQuantity: 1,
    effectiveAvailableQuantity: 2,
    sourceLevelGlobalIds: ['giil0000001'],
    sourcePositionGlobalIds: ['giv0000001'],
    sourcePositionVersion: 4,
  }],
  startingSequence: 1,
  maximumPackages: 50,
}
function validOperationalOptimizerResult(input, options, method = 'or_tools') {
  const selectedPlan = {
    planId: 'plan-operational-1',
    warehouseGlobalIds: ['gwh0000001'],
    warehouseCount: 1,
    shipmentCount: 1,
    cartonCount: 1,
    estimatedTotalCostMinor: 55,
    unusedVolumeMm3: 6_860_000,
    packages: [{
      packageKey: 'package-operational-1',
      warehouseGlobalId: 'gwh0000001',
      cartonGlobalId: 'gmat0000001',
      innerDimensionsMm: { length: 250, width: 200, height: 150 },
      maxWeightGrams: 10_000,
      emptyWeightGrams: 120,
      totalWeightGrams: 520,
      usedVolumeMm3: 640_000,
      unusedVolumeMm3: 6_860_000,
      estimatedCostMinor: 55,
      allocations: [{
        lineGlobalId: 'gcol0000001',
        productGlobalId: 'gp0000001',
        positionGlobalId: 'giv0000001',
        quantity: 2,
      }],
      placements: [{
        unitKey: 'unit-operational-1',
        lineGlobalId: 'gcol0000001',
        productGlobalId: 'gp0000001',
        positionGlobalId: 'giv0000001',
        dimensionsMm: { length: 100, width: 80, height: 40 },
        coordinatesMm: { x: 0, y: 0, z: 0 },
      }, {
        unitKey: 'unit-operational-2',
        lineGlobalId: 'gcol0000001',
        productGlobalId: 'gp0000001',
        positionGlobalId: 'giv0000001',
        dimensionsMm: { length: 100, width: 80, height: 40 },
        coordinatesMm: { x: 100, y: 0, z: 0 },
      }],
    }],
  }
  const inputHash = fulfillmentOptimizerContract.canonicalOptimizerHash(input)
  return fulfillmentOptimizerContract.parseFulfillmentOptimizationResult({
    schemaVersion: 1,
    status: 'optimal',
    method,
    algorithmVersion: 'test-or-tools-v1',
    inputHash,
    durationMs: 1,
    selectedPlan,
    candidates: [selectedPlan],
    rejectedAlternatives: [],
    fallbackReason: method === 'or_tools' ? null : 'test-only fallback',
    explanation: [],
  }, input, options, inputHash)
}
let operationalOptimizerCalls = 0
const operationalGeometryReady = await planOperationalGeometryRatePackages({
  ...operationalGeometryInput,
  optimizer: {
    async optimize(input, options) {
      operationalOptimizerCalls += 1
      return validOperationalOptimizerResult(input, options)
    },
  },
})
assert.equal(operationalOptimizerCalls, 1)
assert.equal(operationalGeometryReady.status, 'ready')
assert.equal(
  operationalGeometryReady.optimizerInput.eligiblePositions[0]
    .availableQuantity,
  2,
  'Operational optimizer inventory must subtract active reservations',
)
assert.equal(
  operationalGeometryReady.optimizerInput.cartons[0].availableQuantity,
  4,
  'Operational optimizer material stock must subtract active package claims',
)
const fullyRecipeConsumedMaterial = {
  ...operationalGeometryInput.materials[0],
  materialGlobalId: 'gmat0000002',
  stockOnHandQuantity: 1,
  activeClaimedQuantity: 0,
  availableQuantity: 1,
}
const mixedRecipeGeometryReady = await planOperationalGeometryRatePackages({
  ...operationalGeometryInput,
  materials: [
    ...operationalGeometryInput.materials,
    fullyRecipeConsumedMaterial,
  ],
  recipePackages: [{
    packageKey: 'package-recipe-1',
    packagingMaterialGlobalId: 'gmat0000002',
    lineAllocations: [{
      productGlobalId: 'gp0000002',
      quantity: 1,
    }],
  }],
  startingSequence: 2,
  optimizer: {
    async optimize(input, options) {
      return validOperationalOptimizerResult(input, options)
    },
  },
})
assert.equal(mixedRecipeGeometryReady.status, 'ready')
assert.deepEqual(
  JSON.parse(JSON.stringify(
    mixedRecipeGeometryReady.optimizerInput.cartons.map(
      (carton) => carton.cartonGlobalId,
    ),
  )),
  ['gmat0000001'],
  'A valid material fully consumed by recipe packages must be excluded without blocking residual geometry',
)
assert.equal(operationalGeometryReady.packages[0].planningMethod, 'or_tools')
assert.deepEqual(
  JSON.parse(JSON.stringify(
    operationalGeometryReady.packages[0].orToolsProfiles,
  )),
  [{
    lineGlobalId: 'gcol0000001',
    productGlobalId: 'gp0000001',
    inputProfileVersionGlobalId: 'gppv0000001',
    inputProfileVersionRowVersion: 3,
    fitModel: 'rigid_3d',
    unitDimensionsMm: { length: 100, width: 80, height: 40 },
    unitWeightGrams: 200,
    quantity: 2,
  }],
  'Operational package evidence must retain the exact allocation profile edge',
)
const operationalWritePackages = operationalGeometryReady.packages.map(
  (packagePlan) => {
    const snapshot = {
      ...packagePlan,
      carrierParcel: {
        description: 'Operational provenance test',
        length: 10.236,
        width: 8.268,
        height: 6.299,
        dimensionUnit: 'IN',
        weight: 1.147,
        weightUnit: 'LB',
      },
    }
    return {
      ...snapshot,
      packageHash: cartonizationRateEvidenceHash(snapshot),
    }
  },
)
const operationalGeometryPlanSnapshot = {
  operationalGeometryRatePlan: {
    evidence: operationalGeometryReady.evidence,
    optimizerInput: operationalGeometryReady.optimizerInput,
    optimizerResult: operationalGeometryReady.optimizerResult,
    packages: operationalGeometryReady.packages,
  },
}
assert.doesNotThrow(
  () => assertCartonizationRateEvidenceOperationalGeometryProvenance({
    evidenceMode: 'operational',
    packages: operationalWritePackages,
    planSnapshot: operationalGeometryPlanSnapshot,
  }),
  'Write-time evidence must accept exact optimizer and transformation provenance',
)
assert.throws(
  () => assertCartonizationRateEvidenceOperationalGeometryProvenance({
    evidenceMode: 'operational',
    packages: operationalWritePackages,
    planSnapshot: {
      operationalGeometryRatePlan: {
        ...operationalGeometryPlanSnapshot.operationalGeometryRatePlan,
        evidence: {
          ...operationalGeometryReady.evidence,
          transformationHash: 'f'.repeat(64),
        },
      },
    },
  }),
  (error) => (
    error instanceof CartonizationRateEvidencePersistenceError
    && error.code
      === 'CARTONIZATION_RATE_EVIDENCE_OR_TOOLS_PROVENANCE_INVALID'
  ),
  'Write-time evidence must reject transformed-package provenance tampering',
)
const tamperedOptimizerInput = {
  ...operationalGeometryReady.optimizerInput,
  lines: operationalGeometryReady.optimizerInput.lines.map((line) => ({
    ...line,
    unitWeightGrams: line.unitWeightGrams - 1,
  })),
}
const tamperedSelectedPlan = {
  ...operationalGeometryReady.optimizerResult.selectedPlan,
  packages: operationalGeometryReady.optimizerResult.selectedPlan.packages.map(
    (packagePlan) => ({
      ...packagePlan,
      totalWeightGrams: packagePlan.totalWeightGrams - 2,
    }),
  ),
}
const tamperedOptimizerInputHash =
  fulfillmentOptimizerContract.canonicalOptimizerHash(tamperedOptimizerInput)
assert.throws(
  () => assertCartonizationRateEvidenceOperationalGeometryProvenance({
    evidenceMode: 'operational',
    packages: operationalWritePackages,
    planSnapshot: {
      operationalGeometryRatePlan: {
        ...operationalGeometryPlanSnapshot.operationalGeometryRatePlan,
        evidence: {
          ...operationalGeometryReady.evidence,
          optimizerInputHash: tamperedOptimizerInputHash,
        },
        optimizerInput: tamperedOptimizerInput,
        optimizerResult: {
          ...operationalGeometryReady.optimizerResult,
          inputHash: tamperedOptimizerInputHash,
          selectedPlan: tamperedSelectedPlan,
          candidates: [tamperedSelectedPlan],
        },
      },
    },
  }),
  (error) => (
    error instanceof CartonizationRateEvidencePersistenceError
    && error.code
      === 'CARTONIZATION_RATE_EVIDENCE_OR_TOOLS_PROVENANCE_INVALID'
  ),
  'Optimizer demand weight cannot drift from exact retained product profiles',
)
assert.throws(
  () => assertCartonizationRateEvidenceOperationalGeometryProvenance({
    evidenceMode: 'operational',
    packages: operationalWritePackages.map((packageInput) => ({
      ...packageInput,
      maxWeightGrams: packageInput.maxWeightGrams - 1,
    })),
    planSnapshot: operationalGeometryPlanSnapshot,
  }),
  (error) => (
    error instanceof CartonizationRateEvidencePersistenceError
    && error.code
      === 'CARTONIZATION_RATE_EVIDENCE_OR_TOOLS_PROVENANCE_INVALID'
  ),
  'Write-time evidence must reject a package capacity drift from the optimizer transformation',
)
const operationalGeometryFallback =
  await planOperationalGeometryRatePackages({
    ...operationalGeometryInput,
    optimizer: {
      async optimize(input, options) {
        return validOperationalOptimizerResult(
          input,
          options,
          'deterministic_fallback',
        )
      },
    },
  })
assert.equal(operationalGeometryFallback.status, 'blocked')
assert.equal(
  operationalGeometryFallback.blocker.code,
  'CARTONIZATION_RATE_EVIDENCE_OR_TOOLS_RESULT_REQUIRED',
  'Deterministic fallback must never become operational evidence',
)

assert.equal(
  cartonizationRateEvidenceHash({
    z: [3, { b: true, a: 'value' }],
    a: 1,
  }),
  cartonizationRateEvidenceHash({
    a: 1,
    z: [3, { a: 'value', b: true }],
  }),
  'Canonical hashing must ignore object-key insertion order',
)
assert.equal(
  cartonizationRateEvidenceHash({ value: -0 }),
  cartonizationRateEvidenceHash({ value: 0 }),
  'Canonical hashing must normalize negative zero',
)
assert.throws(
  () => cartonizationRateEvidenceHash({ value: Number.POSITIVE_INFINITY }),
  (error) => (
    error instanceof CartonizationRateEvidencePersistenceError
    && error.status === 400
  ),
  'Canonical hashing must reject non-finite numbers',
)
assert.throws(
  () => cartonizationRateEvidenceHash({ value: undefined }),
  /undefined value/,
  'Canonical hashing must reject undefined values',
)

const planSnapshot = {
  carrierReadEnvironment: 'sandbox',
  requiredCarrierProviders: ['ups_rest', 'fedex_rest'],
  warehouseGlobalId: 'gwh0000001',
  packages: [{ packageKey: 'package-1' }],
}
const packageOne = {
  packageKey: 'package-1',
  packageSequence: 1,
  planningMethod: 'or_tools',
  packagingMaterialGlobalId: 'gmat0000001',
  materialRowVersion: 2,
  recipes: [],
  orToolsProfiles: [{
    lineGlobalId: 'gcol0000001',
    productGlobalId: 'gp0000001',
    inputProfileVersionGlobalId: 'gppv0000001',
    inputProfileVersionRowVersion: 3,
    fitModel: 'rigid_3d',
    unitDimensionsMm: { length: 120, width: 80, height: 40 },
    unitWeightGrams: 400,
    quantity: 2,
  }],
  innerDimensionsMm: { length: 250, width: 200, height: 150 },
  ratedOuterDimensionsMm: { length: 260, width: 210, height: 160 },
  contentWeightGrams: 800,
  tareWeightGrams: 120,
  ratedGrossWeightGrams: 920,
  maxWeightGrams: 10_000,
  allocations: [{
    lineGlobalId: 'gcol0000001',
    productGlobalId: 'gp0000001',
    title: 'Measured product',
    quantity: 2,
  }],
  carrierParcel: {
    description: 'Exact package one',
    length: 10.236,
    width: 8.268,
    height: 6.299,
    dimensionUnit: 'IN',
    weight: 2.028,
    weightUnit: 'LB',
  },
}
const packageTwo = {
  ...packageOne,
  packageKey: 'package-2',
  packageSequence: 2,
  packagingMaterialGlobalId: 'gmat0000002',
}
const packages = [packageOne, packageTwo].map((value) => ({
  ...value,
  packageHash: cartonizationRateEvidenceHash(value),
}))
const materialRateAssumptions = [
  {
    materialGlobalId: 'gmat0000001',
    expectedRowVersion: 2,
    ratedOuterDimensionsMm: packageOne.ratedOuterDimensionsMm,
    tareWeightGrams: packageOne.tareWeightGrams,
    operationalFacts: {
      materialType: 'carton',
      innerDimensionsMm: packageOne.innerDimensionsMm,
      maximumGrossWeightGrams: packageOne.maxWeightGrams,
      unitCostMinor: 50,
      currency: 'USD',
      stock: {
        rowVersion: 1,
        onHandQuantity: 5,
        activeClaimedQuantity: 0,
        availableQuantity: 5,
      },
    },
  },
  {
    materialGlobalId: 'gmat0000002',
    expectedRowVersion: 2,
    ratedOuterDimensionsMm: packageTwo.ratedOuterDimensionsMm,
    tareWeightGrams: packageTwo.tareWeightGrams,
    operationalFacts: {
      materialType: 'carton',
      innerDimensionsMm: packageTwo.innerDimensionsMm,
      maximumGrossWeightGrams: packageTwo.maxWeightGrams,
      unitCostMinor: 60,
      currency: 'USD',
      stock: {
        rowVersion: 1,
        onHandQuantity: 5,
        activeClaimedQuantity: 0,
        availableQuantity: 5,
      },
    },
  },
]
const sandboxMaterialRateAssumptions = materialRateAssumptions.map(
  (assumption) => ({ ...assumption, operationalFacts: null }),
)
const quotes = packages.flatMap((item) => ([
  {
    packageKey: item.packageKey,
    provider: 'ups_rest',
    rateEvidenceGlobalId: 'grq0000001',
  },
  {
    packageKey: item.packageKey,
    provider: 'fedex_rest',
    rateEvidenceGlobalId: 'grq0000002',
  },
]))
const request = {
  organizationId: '00000000-0000-4000-8000-000000000001',
  accountGlobalId: 'gia0000001',
  candidateGlobalId: 'gcoc0000001',
  candidateRowVersion: 4,
  destinationFingerprint: 'd'.repeat(64),
  warehouseGlobalId: 'gwh0000001',
  inventorySyncRunGlobalId: 'gisr0000001',
  evidenceMode: 'operational',
  requiredCarrierProviders: ['ups_rest', 'fedex_rest'],
  policyVersion: 'cartonization-rate-v1',
  algorithmVersion: 'or-tools-v1',
  planInputHash: 'a'.repeat(64),
  planResultHash: cartonizationRateEvidenceHash(planSnapshot),
  planSnapshot,
  assumptionSnapshot: {
    operationalMaterialFacts: materialRateAssumptions,
  },
  status: 'succeeded',
  idempotencyKey: 'cartonization-demo-1',
  actorEmail: 'operator@example.com',
  materialRateAssumptions,
  packages,
  quotes,
}
assert.doesNotThrow(
  () => assertCartonizationRateEvidenceCarrierCoverage(request),
  'Dual-carrier evidence must retain exactly one quote edge per provider and package',
)
assert.doesNotThrow(
  () => assertCartonizationRateEvidenceOrToolsProfiles(request),
  'Every operational OR-Tools allocation must retain one exact rigid profile edge',
)
assert.throws(
  () => assertCartonizationRateEvidenceOrToolsProfiles({
    ...request,
    packages: [{ ...packages[0], orToolsProfiles: [] }],
  }),
  (error) => (
    error instanceof CartonizationRateEvidencePersistenceError
    && error.code
      === 'CARTONIZATION_RATE_EVIDENCE_OR_TOOLS_PROFILE_INVALID'
  ),
  'Operational OR-Tools evidence must reject a missing allocation profile edge',
)
assert.doesNotThrow(
  () => assertCartonizationRateEvidenceCarrierCoverage({
    ...request,
    requiredCarrierProviders: ['ups_rest'],
    quotes: quotes.filter((quote) => quote.provider === 'ups_rest'),
  }),
  'A single enabled carrier must be sufficient for complete evidence',
)
assert.throws(
  () => assertCartonizationRateEvidenceCarrierCoverage({
    ...request,
    requiredCarrierProviders: ['ups_rest'],
  }),
  (error) => (
    error instanceof CartonizationRateEvidencePersistenceError
    && error.code
      === 'CARTONIZATION_RATE_EVIDENCE_CARRIER_COVERAGE_INVALID'
  ),
  'Evidence must reject quote edges outside the retained carrier set',
)
assert.doesNotThrow(
  () => assertCartonizationRateEvidenceMaterialAssumptions(request),
  'Every operational package must match its retained factual material inputs',
)
assert.throws(
  () => assertCartonizationRateEvidenceMaterialAssumptions({
    ...request,
    packages: packages.map((item, index) => (
      index === 0
        ? {
            ...item,
            innerDimensionsMm: {
              ...item.innerDimensionsMm,
              length: item.innerDimensionsMm.length + 1,
            },
          }
        : item
    )),
  }),
  (error) => (
    error instanceof CartonizationRateEvidencePersistenceError
    && error.code
      === 'CARTONIZATION_RATE_EVIDENCE_MATERIAL_ASSUMPTION_MISMATCH'
  ),
  'Operational package fit dimensions cannot drift from exact material facts',
)
assert.throws(
  () => assertCartonizationRateEvidenceMaterialAssumptions({
    ...request,
    packages: packages.map((item, index) => (
      index === 0
        ? { ...item, maxWeightGrams: item.maxWeightGrams - 1 }
        : item
    )),
  }),
  (error) => (
    error instanceof CartonizationRateEvidencePersistenceError
    && error.code
      === 'CARTONIZATION_RATE_EVIDENCE_MATERIAL_ASSUMPTION_MISMATCH'
  ),
  'Operational package capacity cannot drift from exact material facts',
)
assert.throws(
  () => assertCartonizationRateEvidenceMaterialAssumptions({
    ...request,
    assumptionSnapshot: {
      operationalMaterialFacts: materialRateAssumptions,
      materialRateAssumptions,
    },
  }),
  (error) => (
    error instanceof CartonizationRateEvidencePersistenceError
    && error.code
      === 'CARTONIZATION_RATE_EVIDENCE_OPERATIONAL_ASSUMPTIONS_FORBIDDEN'
  ),
  'Operational evidence must reject a retained sandbox-assumption payload',
)
assert.throws(
  () => assertCartonizationRateEvidenceMaterialAssumptions({
    ...request,
    planSnapshot: {
      ...request.planSnapshot,
      carrierReadEnvironment: 'production',
    },
  }),
  (error) => (
    error instanceof CartonizationRateEvidencePersistenceError
    && error.code
      === 'CARTONIZATION_RATE_EVIDENCE_OPERATIONAL_RATE_ENVIRONMENT_INVALID'
  ),
  'Development operational evidence must retain its sandbox carrier environment',
)
assert.doesNotThrow(
  () => assertCartonizationRateEvidenceMaterialAssumptions({
    ...request,
    evidenceMode: 'assumption_backed_sandbox',
    assumptionSnapshot: {
      materialRateAssumptions: sandboxMaterialRateAssumptions,
    },
    materialRateAssumptions: sandboxMaterialRateAssumptions,
  }),
  'The explicit assumption-backed sandbox path must remain supported',
)
const sandboxFixedAxisPackage = {
  ...packages[0],
  planningMethod: 'sandbox_fixed_axis',
  orToolsProfiles: [],
}
assert.doesNotThrow(
  () => assertCartonizationRateEvidenceOrToolsProfiles({
    ...request,
    evidenceMode: 'assumption_backed_sandbox',
    packages: [sandboxFixedAxisPackage],
  }),
  'Sandbox fixed-axis packages must explicitly retain no OR-Tools profile edges',
)
const sandboxFixedAxisEvidence = {
  policyVersion: 'sandbox-fixed-axis-one-unit-per-parcel-v1',
  fitEnvelopeBasis: 'retained_material_fit_dimensions',
  rotationAllowed: false,
  unitsPerPackage: 1,
  materialStockAuthority: 'not_used_for_sandbox_comparison',
}
const sandboxFixedAxisRequest = {
  ...request,
  evidenceMode: 'assumption_backed_sandbox',
  packages: [sandboxFixedAxisPackage],
  materialRateAssumptions: sandboxMaterialRateAssumptions,
  planSnapshot: {
    ...request.planSnapshot,
    sandboxGeometryRatePlan: {
      evidence: sandboxFixedAxisEvidence,
      packages: [{ packageKey: sandboxFixedAxisPackage.packageKey }],
    },
  },
  assumptionSnapshot: {
    watermark:
      'ASSUMPTION-BACKED SANDBOX EVIDENCE - NOT EXECUTABLE OR ACTUAL BILLED COST',
    materialRateAssumptions: sandboxMaterialRateAssumptions,
    sandboxGeometryRatePlan: {
      ...sandboxFixedAxisEvidence,
      packageKeys: [sandboxFixedAxisPackage.packageKey],
    },
  },
}
assert.doesNotThrow(
  () => assertCartonizationRateEvidenceMaterialAssumptions(
    sandboxFixedAxisRequest,
  ),
  'Watermarked sandbox fixed-axis provenance must support recipe-free comparison packages',
)
assert.throws(
  () => assertCartonizationRateEvidenceMaterialAssumptions({
    ...sandboxFixedAxisRequest,
    evidenceMode: 'operational',
  }),
  (error) => (
    error instanceof CartonizationRateEvidencePersistenceError
    && error.code
      === 'CARTONIZATION_RATE_EVIDENCE_OPERATIONAL_ASSUMPTIONS_FORBIDDEN'
  ),
  'Operational evidence must reject sandbox fixed-axis package provenance',
)
assert.equal(
  quotes.length,
  4,
  'Two physical packages must retain one UPS and one FedEx quote edge each',
)
assert.equal(
  new Set(quotes.map((quote) => quote.rateEvidenceGlobalId)).size,
  2,
  'Every package edge must share exactly one immutable shipment read per provider',
)
assert.doesNotMatch(
  quoteTable,
  /UNIQUE\s*\([^)]*carrier_rate_request_id/,
  'One immutable whole-shipment read must support every package edge',
)
const orderedContextParcels = [
  packages[0].carrierParcel,
  { ...packages[1].carrierParcel, weight: 3.25 },
]
const shipmentContextHash = cartonizationShipmentRateContextHash({
  provider: 'ups_rest',
  destinationFingerprint: request.destinationFingerprint,
  parcels: orderedContextParcels,
})
assert.notEqual(
  shipmentContextHash,
  cartonizationShipmentRateContextHash({
    provider: 'ups_rest',
    destinationFingerprint: request.destinationFingerprint,
    parcels: [...orderedContextParcels].reverse(),
  }),
  'Whole-shipment context hashing must preserve physical package order',
)
assert.throws(
  () => assertCartonizationRateEvidenceMaterialAssumptions({
    ...request,
    packages: packages.map((item, index) => (
      index === 0
        ? { ...item, tareWeightGrams: item.tareWeightGrams + 1 }
        : item
    )),
  }),
  (error) => (
    error instanceof CartonizationRateEvidencePersistenceError
    && error.code
      === 'CARTONIZATION_RATE_EVIDENCE_MATERIAL_ASSUMPTION_MISMATCH'
  ),
  'A package cannot drift from its selected material tare assumption',
)
const requestHash = cartonizationRateEvidenceRequestHash(request)
assert.equal(
  requestHash,
  cartonizationRateEvidenceRequestHash({
    ...request,
    actorEmail: 'retrying-operator@example.com',
    idempotencyKey: 'another-command-key',
    materialRateAssumptions: [...materialRateAssumptions].reverse(),
    packages: [...packages].reverse(),
    quotes: [...quotes].reverse(),
  }),
  'Exact evidence request hashing must ignore actor, command key, material order, and edge ordering',
)
assert.notEqual(
  requestHash,
  cartonizationRateEvidenceRequestHash({
    ...request,
    requiredCarrierProviders: ['ups_rest'],
  }),
  'Semantic request hashing must change with the retained carrier set',
)
assert.notEqual(
  requestHash,
  cartonizationRateEvidenceRequestHash({
    ...request,
    packages: packages.map((item, index) => (
      index === 0
        ? { ...item, ratedGrossWeightGrams: item.ratedGrossWeightGrams + 1 }
        : item
    )),
  }),
  'Semantic request hashing must change when retained package evidence changes',
)
assert.notEqual(
  requestHash,
  cartonizationRateEvidenceRequestHash({
    ...request,
    materialRateAssumptions: materialRateAssumptions.map(
      (assumption, index) => (
        index === 0
          ? {
              ...assumption,
              tareWeightGrams: assumption.tareWeightGrams + 1,
            }
          : assumption
      ),
    ),
  }),
  'Semantic request hashing must change when a material rate assumption changes',
)

const faireRouteObserved = {
  carrierReads: [],
  readInput: null,
  write: null,
}
const faireRoute = loadOperationalFaireRoute(faireRouteObserved)
const faireRouteResponse = await faireRoute.POST(new Request(
  'http://localhost/api/integrations/commerce/intake/cartonization-rate-evidence',
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      accountGlobalId: 'gia0000001',
      candidateGlobalId: 'gcoc0000001',
      expectedCandidateRowVersion: 1,
      warehouseGlobalId: 'gwh0000001',
      idempotencyKey: 'faire-operational-route-acceptance',
      evidenceMode: 'operational',
      selectedMaterials: [{
        materialGlobalId: 'gmat0000001',
        expectedRowVersion: 2,
      }],
    }),
  },
))
assert.equal(faireRouteResponse.status, 200)
assert.deepEqual(
  await faireRouteResponse.json(),
  {
    ok: true,
    evidence: { globalId: 'gcte0000001' },
    effects: {
      databaseEvidenceWrites: true,
      inventoryWrites: 0,
      shipmentWrites: 0,
      labelCalls: 0,
      postagePurchases: 0,
      providerWrites: 0,
      providerOrderReads: 0,
      carrierRateReads: 2,
      carrierQuoteEdges: 2,
    },
  },
)
assert.equal(faireRouteObserved.readInput.mode, 'production')
assert.equal(
  faireRouteObserved.readInput.assumedCommittedQuantities.length,
  0,
)
assert.equal(faireRouteObserved.carrierReads.length, 2)
assert.deepEqual(
  Array.from(faireRouteObserved.write.requiredCarrierProviders),
  ['ups_rest', 'fedex_rest'],
)
assert.equal(faireRouteObserved.write.inventorySyncRunGlobalId, null)
assert.equal(faireRouteObserved.write.evidenceMode, 'operational')
assert.equal(
  faireRouteObserved.write.assumptionSnapshot.inventoryAuthority,
  'projected_atp_only',
)
assert.equal(
  faireRouteObserved.write.assumptionSnapshot.planClaimAuthority,
  'transactional_local_balance_lock',
)
assert.equal(
  faireRouteObserved.write.assumptionSnapshot
    .inventoryProducts[0].sourcePositionGlobalIds[0],
  'giv0000001',
)
assert.equal(faireRouteObserved.write.packages[0].contentWeightGrams, 170)
assert.equal(faireRouteObserved.write.packages[0].tareWeightGrams, 120)
assert.equal(faireRouteObserved.write.packages[0].ratedGrossWeightGrams, 290)

const trainingRouteObserved = {
  carrierReads: [],
  readInput: null,
  write: null,
  sequence: [],
  shopifyAuthorityCalls: 0,
  trainingAuthorization: null,
}
const trainingRoute = loadOperationalFaireRoute(
  trainingRouteObserved,
  {
    providers: ['ups_rest'],
    shadowTraining: true,
    sourceProvider: 'shopify',
    zeroMaterialStock: true,
  },
)
const trainingRouteResponse = await trainingRoute.POST(new Request(
  'http://localhost/api/integrations/commerce/intake/cartonization-rate-evidence',
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      accountGlobalId: 'gia0000001',
      candidateGlobalId: 'gcoc0000001',
      expectedCandidateRowVersion: 1,
      warehouseGlobalId: 'gwh0000001',
      idempotencyKey: 'shopify-shadow-training-no-stock-route',
      evidenceMode: 'operational',
      selectedMaterials: [{
        materialGlobalId: 'gmat0000001',
        expectedRowVersion: 2,
      }],
      shadowTraining: {
        runGlobalId: 'gtrn0000001',
        expectedRowVersion: 0,
      },
    }),
  },
))
assert.equal(trainingRouteResponse.status, 200)
const trainingRoutePayload = await trainingRouteResponse.json()
assert.equal(trainingRoutePayload.effects.providerWrites, 0)
assert.equal(trainingRoutePayload.effects.providerOrderReads, 0)
assert.equal(trainingRoutePayload.effects.inventoryWrites, 0)
assert.equal(trainingRoutePayload.effects.postagePurchases, 0)
assert.deepEqual(JSON.parse(JSON.stringify(
  trainingRouteObserved.trainingAuthorization,
)), {
  organizationId: '00000000-0000-4000-8000-000000000001',
  runGlobalId: 'gtrn0000001',
  expectedRunRowVersion: 0,
  accountGlobalId: 'gia0000001',
  candidateGlobalId: 'gcoc0000001',
  expectedCandidateRowVersion: 1,
  warehouseGlobalId: 'gwh0000001',
})
assert.deepEqual(
  trainingRouteObserved.sequence,
  ['training-auth', 'claim', 'read', 'carrier:ups_rest', 'write'],
  'Exact run authorization must finish before claim, local facts, or carrier I/O',
)
assert.equal(trainingRouteObserved.shopifyAuthorityCalls, 0)
assert.equal(trainingRouteObserved.readInput.mode, 'shadow_training_simulated')
assert.equal(trainingRouteObserved.write.inventorySyncRunGlobalId, null)
assert.equal(trainingRouteObserved.write.requiredCarrierProviders.length, 1)
assert.equal(trainingRouteObserved.carrierReads.length, 1)
assert.equal(trainingRouteObserved.carrierReads[0].environment, 'sandbox')
assert.equal(
  trainingRouteObserved.write.materialRateAssumptions[0]
    .operationalFacts.stock,
  null,
)
assert.equal(
  trainingRouteObserved.write.assumptionSnapshot.inventoryAuthority,
  'shadow_training_simulated_order_and_material_availability',
)
assert.equal(
  trainingRouteObserved.write.planSnapshot.shadowTraining.version,
  'shadow-training-evidence-v1',
)
assert.equal(
  trainingRouteObserved.write.planSnapshot.shadowTraining.runGlobalId,
  'gtrn0000001',
)
assert.equal(
  trainingRouteObserved.write.planSnapshot.shadowTraining.commerceProviderWrites,
  0,
)

for (const activationState of [
  'disabled',
  'shadow',
  'read_only',
  'active',
  'frozen',
]) {
  const geometryTrainingObserved = {
    carrierReads: [],
    readInput: null,
    write: null,
    sequence: [],
    shopifyAuthorityCalls: 0,
    trainingAuthorization: null,
    geometryCalls: 0,
  }
  const geometryTrainingRoute = loadOperationalFaireRoute(
    geometryTrainingObserved,
    {
      activationState,
      providers: ['ups_rest'],
      operationalGeometry: true,
      shadowTraining: true,
      sourceProvider: 'shopify',
      zeroMaterialStock: true,
    },
  )
  const geometryTrainingResponse = await geometryTrainingRoute.POST(
    new Request(
      'http://localhost/api/integrations/commerce/intake/cartonization-rate-evidence',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          accountGlobalId: 'gia0000001',
          candidateGlobalId: 'gcoc0000001',
          expectedCandidateRowVersion: 1,
          warehouseGlobalId: 'gwh0000001',
          idempotencyKey:
            `order-training-geometry-${activationState}`,
          evidenceMode: 'operational',
          selectedMaterials: [{
            materialGlobalId: 'gmat0000001',
            expectedRowVersion: 2,
          }],
          shadowTraining: {
            runGlobalId: 'gtrn0000001',
            expectedRowVersion: 0,
          },
        }),
      },
    ),
  )
  assert.equal(
    geometryTrainingResponse.status,
    200,
    `${activationState} must permit exact local geometry training`,
  )
  assert.equal(geometryTrainingObserved.geometryCalls, 1)
  assert.equal(geometryTrainingObserved.shopifyAuthorityCalls, 0)
  assert.equal(geometryTrainingObserved.carrierReads.length, 1)
  assert.equal(
    geometryTrainingObserved.write.planSnapshot.shadowTraining.runGlobalId,
    'gtrn0000001',
  )
  assert.equal(
    geometryTrainingObserved.write.packages[0].planningMethod,
    'or_tools',
  )
  assert.equal(
    geometryTrainingObserved.write.packages[0].orToolsProfiles.length,
    0,
  )
}

const ordinaryZeroStockObserved = {
  carrierReads: [],
  readInput: null,
  write: null,
  sequence: [],
}
const ordinaryZeroStockRoute = loadOperationalFaireRoute(
  ordinaryZeroStockObserved,
  { providers: ['ups_rest'], zeroMaterialStock: true },
)
const ordinaryZeroStockResponse = await ordinaryZeroStockRoute.POST(new Request(
  'http://localhost/api/integrations/commerce/intake/cartonization-rate-evidence',
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      accountGlobalId: 'gia0000001',
      candidateGlobalId: 'gcoc0000001',
      expectedCandidateRowVersion: 1,
      warehouseGlobalId: 'gwh0000001',
      idempotencyKey: 'ordinary-operational-no-stock-rejected',
      evidenceMode: 'operational',
      selectedMaterials: [{
        materialGlobalId: 'gmat0000001',
        expectedRowVersion: 2,
      }],
    }),
  },
))
assert.equal(ordinaryZeroStockResponse.status, 422)
const ordinaryZeroStockPayload = await ordinaryZeroStockResponse.json()
assert.equal(
  ordinaryZeroStockPayload.code,
  'CARTONIZATION_RATE_EVIDENCE_OPERATIONAL_MATERIAL_FACTS_REQUIRED',
)
assert.equal(ordinaryZeroStockObserved.carrierReads.length, 0)
assert.equal(ordinaryZeroStockObserved.write, null)

const upsOnlyObserved = {
  carrierReads: [],
  readInput: null,
  write: null,
}
const upsOnlyRoute = loadOperationalFaireRoute(
  upsOnlyObserved,
  { providers: ['ups_rest'] },
)
const upsOnlyResponse = await upsOnlyRoute.POST(new Request(
  'http://localhost/api/integrations/commerce/intake/cartonization-rate-evidence',
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      accountGlobalId: 'gia0000001',
      candidateGlobalId: 'gcoc0000001',
      expectedCandidateRowVersion: 1,
      warehouseGlobalId: 'gwh0000001',
      idempotencyKey: 'faire-ups-only-route-acceptance',
      evidenceMode: 'operational',
      selectedMaterials: [{
        materialGlobalId: 'gmat0000001',
        expectedRowVersion: 2,
      }],
    }),
  },
))
assert.equal(upsOnlyResponse.status, 200)
const upsOnlyPayload = await upsOnlyResponse.json()
assert.equal(upsOnlyPayload.effects.carrierRateReads, 1)
assert.equal(upsOnlyPayload.effects.carrierQuoteEdges, 1)
assert.deepEqual(
  Array.from(upsOnlyObserved.write.requiredCarrierProviders),
  ['ups_rest'],
)
assert.deepEqual(
  Array.from(upsOnlyObserved.write.planSnapshot.requiredCarrierProviders),
  ['ups_rest'],
)
assert.equal(upsOnlyObserved.write.quotes.length, 1)
assert.equal(upsOnlyObserved.write.quotes[0].provider, 'ups_rest')

const sandboxRouteObserved = {
  carrierReads: [],
  readInput: null,
  write: null,
}
const sandboxRoute = loadOperationalFaireRoute(
  sandboxRouteObserved,
  { providers: ['ups_rest'], sandboxGeometry: true },
)
const sandboxRouteBody = {
  accountGlobalId: 'gia0000001',
  candidateGlobalId: 'gcoc0000001',
  expectedCandidateRowVersion: 1,
  warehouseGlobalId: 'gwh0000001',
  idempotencyKey: 'sandbox-fixed-axis-route-acceptance',
  evidenceMode: 'assumption_backed_sandbox',
  selectedMaterials: [{
    materialGlobalId: 'gmat0000001',
    expectedRowVersion: 2,
    sandboxRateAssumptions: {
      ratedOuterDimensionsMm: {
        length: 220,
        width: 170,
        height: 120,
      },
      tareWeightGrams: 100,
    },
  }],
  assumedCommittedQuantities: [{
    lineGlobalId: 'gcol0000001',
    quantity: 1,
  }],
  sandboxAssumptions: {
    acknowledged: true,
    reason: 'Exact development comparison proof',
    allowUnderMinimum: false,
    assumedMinimumInputQuantity: null,
  },
}
const sandboxRouteResponse = await sandboxRoute.POST(new Request(
  'http://localhost/api/integrations/commerce/intake/cartonization-rate-evidence',
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(sandboxRouteBody),
  },
))
assert.equal(sandboxRouteResponse.status, 200)
assert.equal(sandboxRouteObserved.readInput.mode, 'sandbox_demo')
assert.equal(sandboxRouteObserved.carrierReads.length, 1)
assert.equal(sandboxRouteObserved.write.evidenceMode, 'assumption_backed_sandbox')
assert.equal(sandboxRouteObserved.write.packages.length, 1)
const sandboxWrittenPackage = sandboxRouteObserved.write.packages[0]
assert.equal(sandboxWrittenPackage.planningMethod, 'sandbox_fixed_axis')
assert.equal(sandboxWrittenPackage.recipes.length, 0)
assert.deepEqual(
  JSON.parse(JSON.stringify(sandboxWrittenPackage.innerDimensionsMm)),
  { length: 200, width: 150, height: 100 },
)
assert.deepEqual(
  JSON.parse(JSON.stringify(sandboxWrittenPackage.ratedOuterDimensionsMm)),
  { length: 220, width: 170, height: 120 },
)
assert.equal(sandboxWrittenPackage.contentWeightGrams, 400)
assert.equal(sandboxWrittenPackage.tareWeightGrams, 100)
assert.equal(sandboxWrittenPackage.ratedGrossWeightGrams, 500)
const { packageHash: writtenPackageHash, ...writtenPackageSnapshot } =
  sandboxWrittenPackage
assert.equal(
  writtenPackageHash,
  cartonizationRateEvidenceHash(writtenPackageSnapshot),
  'The route package hash must use exactly the canonical persistence fields',
)
assert.equal(
  sandboxRouteObserved.write.planSnapshot
    .sandboxGeometryRatePlan.evidence.fitEnvelopeBasis,
  'retained_material_fit_dimensions',
)
assert.equal(
  sandboxRouteObserved.write.assumptionSnapshot
    .sandboxGeometryRatePlan.packageKeys[0],
  sandboxWrittenPackage.packageKey,
)
assert.deepEqual(
  JSON.parse(JSON.stringify(sandboxRouteObserved.carrierReads[0].parcels)),
  [{
    description: sandboxWrittenPackage.carrierParcel.description,
    exteriorInches: {
      length: sandboxWrittenPackage.carrierParcel.length,
      width: sandboxWrittenPackage.carrierParcel.width,
      height: sandboxWrittenPackage.carrierParcel.height,
    },
    grossPounds: sandboxWrittenPackage.carrierParcel.weight,
  }],
)

const selfPackageObserved = { carrierReads: [], readInput: null, write: null }
const selfPackageRoute = loadOperationalFaireRoute(
  selfPackageObserved,
  {
    providers: ['ups_rest'],
    sandboxGeometry: true,
    planTransform: (value) => ({
      ...value,
      selfPackages: [{ packageKey: 'self-package-1' }],
    }),
  },
)
const selfPackageResponse = await selfPackageRoute.POST(new Request(
  'http://localhost/api/integrations/commerce/intake/cartonization-rate-evidence',
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...sandboxRouteBody,
      idempotencyKey: 'sandbox-self-package-rejection',
    }),
  },
))
assert.equal(selfPackageResponse.status, 422)
assert.equal(
  (await selfPackageResponse.json()).code,
  'CARTONIZATION_RATE_EVIDENCE_SELF_PACKAGE_UNSUPPORTED',
)
assert.equal(selfPackageObserved.carrierReads.length, 0)

const allocationObserved = { carrierReads: [], readInput: null, write: null }
const allocationRoute = loadOperationalFaireRoute(
  allocationObserved,
  {
    providers: ['ups_rest'],
    sandboxGeometry: true,
    planTransform: (value) => ({
      ...value,
      recipePackages: [{
        sequence: 1,
        lineAllocations: [{
          lineGlobalId: 'gcol0000001',
          quantity: 1,
        }],
      }],
    }),
  },
)
const allocationResponse = await allocationRoute.POST(new Request(
  'http://localhost/api/integrations/commerce/intake/cartonization-rate-evidence',
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...sandboxRouteBody,
      idempotencyKey: 'sandbox-allocation-coverage-rejection',
    }),
  },
))
assert.equal(allocationResponse.status, 422)
assert.equal(
  (await allocationResponse.json()).code,
  'CARTONIZATION_RATE_EVIDENCE_ALLOCATION_COVERAGE_INVALID',
)
assert.equal(allocationObserved.carrierReads.length, 0)

console.log('cartonization rate evidence contract tests passed')
