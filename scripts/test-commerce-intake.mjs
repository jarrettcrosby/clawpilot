#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const nodeRequire = createRequire(import.meta.url)
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function includes(source, fragments, label) {
  for (const fragment of fragments) {
    assert.ok(source.includes(fragment), `${label} missing ${fragment}`)
  }
}

function loadTypeScriptModule(path, { mocks = {}, globals = {} } = {}) {
  const result = ts.transpileModule(read(path), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
    reportDiagnostics: true,
  })
  const errors = (result.diagnostics || []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  )
  assert.equal(
    errors.length,
    0,
    errors.map((diagnostic) => (
      ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
    )).join('\n'),
  )

  const loadedModule = { exports: {} }
  const sandbox = {
    AbortController,
    AbortSignal,
    BigInt,
    Buffer,
    Date,
    Error,
    Headers,
    Map,
    Math,
    Number,
    Object,
    Promise,
    RangeError,
    RegExp,
    Request,
    Response,
    Set,
    String,
    TextDecoder,
    TextEncoder,
    TypeError,
    URL,
    URLSearchParams,
    Uint8Array,
    clearTimeout,
    console,
    crypto,
    exports: loadedModule.exports,
    fetch,
    module: loadedModule,
    process,
    setTimeout,
    ...globals,
    require(specifier) {
      if (Object.prototype.hasOwnProperty.call(mocks, specifier)) {
        return mocks[specifier]
      }
      return nodeRequire(specifier)
    },
  }
  vm.runInNewContext(result.outputText, sandbox, { filename: path })
  return loadedModule.exports
}

const migration = read('db/migrations/0114_operations_commerce_normalization.sql')
includes(migration, [
  "CHECK (provider IN ('shopify', 'faire'))",
  "CHECK (provider_access_mode = 'read_only')",
  'provider_write_count integer NOT NULL DEFAULT 0',
  'CHECK (provider_write_count = 0)',
  'sync_cursor_advanced boolean NOT NULL DEFAULT false',
  'CHECK (sync_cursor_advanced = false)',
  'inventory_write_count integer NOT NULL DEFAULT 0',
  'reservation_write_count integer NOT NULL DEFAULT 0',
  'fulfillment_write_count integer NOT NULL DEFAULT 0',
  'shipment_write_count integer NOT NULL DEFAULT 0',
  'commerce_export_write_count integer NOT NULL DEFAULT 0',
], 'Commerce intake migration')
const continuationMigration = read(
  'db/migrations/0115_operations_commerce_intake_continuations.sql',
)
includes(continuationMigration, [
  'CREATE TABLE IF NOT EXISTS operations_commerce_intake_continuations',
  "cursor_state IN (\n      'available', 'consumed', 'exhausted'",
  'cursor_ciphertext bytea',
  'cursor_iv bytea',
  'cursor_tag bytea',
  'consumed_by_run_id uuid',
  'Commerce intake continuation batch lineage is invalid',
  'never a durable provider sync cursor',
], 'Commerce intake continuation migration')

const serviceSource = read('app_src/lib/integrations/commerceIntake.ts')
const shopifyQuerySource = serviceSource.slice(
  serviceSource.indexOf('const SHOPIFY_LINE_ITEM_FIELDS'),
  serviceSource.indexOf('type IntakeCommandAction'),
)
includes(shopifyQuerySource, [
  'query ClawPilotCommerceOrders',
  'query ClawPilotCommerceOrder($id: ID!)',
  'query ClawPilotCommerceOrderLines',
  'query ClawPilotCommerceProductVariants',
  'orders(',
  'first: ${SHOPIFY_ORDER_PAGE_SIZE}',
  'after: $after',
  'endCursor',
  'currentQuantity',
  'unfulfilledQuantity',
  'unfulfilledOriginalTotalSet',
  'unfulfilledDiscountedTotalSet',
  'totalDiscountSet',
  'taxLines(first: 50)',
  'returnStatus',
  'email',
  'phone',
  'shippingAddress',
  'shippingLine',
  'customer {',
  'purchasingEntity {',
  'taxable',
  'selectedOptions {',
  'inventoryItem {',
  'requiresShipping',
  'measurement {',
  'weight {',
], 'Shopify intake query')
includes(serviceSource, [
  "grant.grantedScopes.includes('read_customers')",
  'shopifyOrderQuery(includeCustomerIdentity)',
  'shopifyOrdersQuery(includeCustomerIdentity)',
], 'Shopify protected customer-data query gating')
assert.doesNotMatch(
  shopifyQuerySource,
  /\bmutation\b/i,
  'Shopify intake GraphQL must remain read-only',
)

includes(serviceSource, [
  'getFaireOrder',
  'listFaireOrders',
  'listFaireProducts',
  'listFaireInventory',
  'SHOPIFY_ORDER_PAGE_SIZE = 25',
  'FAIRE_ORDER_PAGE_SIZE = 50',
  'FAIRE_INVENTORY_SELECTOR_LIMIT = 50',
  'FAIRE_MAX_INVENTORY_REQUESTS = 20',
  'SHOPIFY_MAX_NESTED_LINE_REQUESTS',
  'COMMERCE_ORDER_LINE_PAGINATION_LIMIT',
  "targetExternalOrderId ? 'current' : 'stale'",
  'readCommerceIntakeRefreshTargetFromPostgres',
  'readCommerceIntakeStageReplayFromPostgres',
  'prepareCommerceIntakeReadIntentInPostgres',
  'reserveCommerceIntakeProviderReadInPostgres',
  'captureCommerceIntakeProviderReadInPostgres',
  'markCommerceIntakeProviderReadUncertainInPostgres',
  'readCommerceIntakeRejectionTargetFromPostgres',
  'excludeCommerceIntakeRejectionInPostgres',
  'readOnly: true',
  'providerWrites: 0',
  'syncCursorAdvanced: false',
  "commandAction === 'fetch'",
  "commandAction === 'fetch-next'",
  "commandAction === 'fetch-products'",
  "commandAction === 'fetch-next-products'",
  "commandAction === 'retry-rejection'",
  "commandAction === 'exclude-rejection'",
  "commandAction === 'resolve-catalog-product'",
  "commandAction === 'resolve-product'",
  "commandAction === 'resolve-customer'",
  "commandAction === 'resolve-delivery'",
  "commandAction === 'resolve-package'",
  "commandAction === 'validate'",
  "commandAction === 'promote'",
  'confirmProviderWriteOff',
], 'Commerce intake service')
for (const providerWrite of [
  'moveFaireOrderToProcessing',
  'cancelFaireOrder',
  'addFaireOrderShipment',
  'addFaireOrderShipments',
  'advanceCommerceSyncCursor',
  'updateCommerceSyncCursor',
  'writeCommerceSyncCursor',
]) {
  assert.ok(
    !serviceSource.includes(providerWrite),
    `Commerce intake service must not call ${providerWrite}`,
  )
}

const persistenceSource = read('app_src/lib/persistence/commerceIntake.ts')
for (const exportName of [
  'captureCommerceIntakeProviderReadInPostgres',
  'confirmCommerceCandidateAddressInPostgres',
  'markCommerceCandidateUnsupportedInPostgres',
  'promoteCommerceCandidateInPostgres',
  'readCommerceIntakeStateFromPostgres',
  'readCommerceIntakeContinuationFromPostgres',
  'readCommerceIntakeRefreshTargetFromPostgres',
  'readCommerceIntakeStageReplayFromPostgres',
  'prepareCommerceIntakeReadIntentInPostgres',
  'reserveCommerceIntakeProviderReadInPostgres',
  'markCommerceIntakeProviderReadUncertainInPostgres',
  'resolveCommerceProductCandidateInPostgres',
  'resolveCommerceCandidateCustomerInPostgres',
  'resolveCommerceCandidateDeliveryInPostgres',
  'resolveCommerceCandidatePackageInPostgres',
  'resolveCommerceCandidateProductInPostgres',
  'stageCommerceNormalizationEnvelopeInPostgres',
  'validateCommerceCandidateInPostgres',
]) {
  assert.ok(
    new RegExp(
      `export\\s+(?:async\\s+function|const)\\s+${exportName}\\b`,
    ).test(persistenceSource),
    `Commerce intake persistence must export ${exportName}`,
  )
}
const commandResultSource = persistenceSource.slice(
  persistenceSource.indexOf('function commandResult'),
)
includes(commandResultSource, [
  'providerWrites: 0',
  'syncCursorAdvanced: false',
], 'Commerce intake command result')
includes(persistenceSource, [
  'JOIN operations_commerce_intake_read_intents intent',
  'intent.staged_run_id = run.id',
  "intent.intent_state = 'staged'",
  'intent.target_kind',
  'intent.target_global_id',
  'row.target_kind !== input.target.kind',
  'row.target_global_id !== input.target.globalId',
  'COMMERCE_INTAKE_IDEMPOTENCY_CONFLICT',
], 'Target-bound staged read replay')
assert.doesNotMatch(
  persistenceSource,
  /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+operations_commerce_sync_cursors\b/i,
  'Commerce intake persistence must not advance commerce provider cursors',
)
includes(persistenceSource, [
  'activation.state AS activation_state',
  'FOR UPDATE OF account, activation',
  "'COMMERCE_INTAKE_ACTIVATION_REQUIRED'",
  "['shadow', 'active'].includes(account.activation_state)",
  'canonicalExternalOrderIds',
  'latestCandidateByExternalOrder',
  '&& !input.refreshCandidateGlobalId',
  "candidate.workflow_state = 'promoted'",
  "['held', 'resolving', 'ready'].includes(",
  'ordersSkippedCanonical',
  'ordersPreserved',
  'SELECT DISTINCT ON (candidate.external_order_id)',
  'line.order_candidate_id = ANY($3::uuid[])',
  "'COMMERCE_INTAKE_REFRESH_TARGET_MISSING'",
  'INSERT INTO operations_commerce_intake_continuations',
  "cursor_state = 'consumed'",
  "cursor_state = 'superseded'",
  'encryptCommerceIntakeContinuation',
  'continuationRunGlobalId',
  'action: input.stageAction',
  "stage.payload->>'recordsRejected'",
  'clawpilot:commerce:crm-customer-identity:v1',
  'candidate.organization_id',
  'candidate.integration_account_id',
  'identityKeyOverride: customerIdentityKey',
  'createOnly: true',
  "'provider_account_customer_identity_reused'",
  'line.current_quantity::text',
  'line.cancelled_quantity::text',
  'line.fulfilled_quantity::text',
  'line.unfulfilled_quantity::text',
  'shopifyPartialFulfillmentIsExact(order)',
  'shopifyCandidateQuantitiesAreExact(lines)',
  'current + cancelled === ordered',
  'canonicalMerchandiseTotalMinor',
  'lineQuantityEvidence',
  'removedOrRefundedQuantity',
  "candidate.provider === 'shopify'\n            ? null",
  "'promoted_remaining_quantity'",
  "'excluded_no_unfulfilled_quantity'",
  'line.unfulfilled_quantity,',
  "'no_unfulfilled_quantity'",
  'PRODUCT_CANDIDATE_SELECT',
  'SELECT DISTINCT ON (selected.external_variant_id)',
  'latest_unexpired_per_account_provider_variant',
  'productCandidates: mappedProductCandidates',
  'candidate.vendor_snapshot',
  'candidate.product_type_snapshot',
  'candidate.normalized_options',
  'compare_at_price_minor',
  'variant.inventoryItemIdentity',
  'variant.selectedOptions',
  'variant.taxable',
  'variant.requiresShipping',
  'variant.weightGrams',
  "'commerce.intake.resolve_product_candidate'",
  "'commerce-catalog'",
  "'COMMERCE_INTAKE_PRODUCT_SOURCE_CONFLICT'",
  'productWasCreated',
  'candidate.external_variant_id',
  "targetType: 'product_candidate'",
  "'commerce.intake.product_candidate.resolved'",
  "'commerce.intake.product_candidate.excluded'",
  'canonical_products_created',
], 'Commerce intake continuity')
const crmPersistenceSource = read('app_src/lib/persistence/crm.ts')
includes(crmPersistenceSource, [
  'identityKeyOverride?: string',
  'createOnly?: boolean',
  "input.createOnly\n    ? 'DO NOTHING'",
  'A custom CRM organization identity requires create-only persistence',
  'CRM organization identity already exists; select the existing organization',
], 'Commerce customer create-only CRM persistence')
assert.ok(
  persistenceSource.indexOf('identityKeyOverride: customerIdentityKey')
    < persistenceSource.indexOf('customerResolutionMethod = \'created\''),
  'Commerce customer creation must bind its scoped identity before reporting creation',
)
assert.ok(
  !persistenceSource.includes('records_failed AS records_rejected'),
  'Normalization rejection counts must come from stage audit evidence',
)
const credentialCryptoSource = read(
  'app_src/lib/integrations/commerceCredentialCrypto.ts',
)
const candidateSnapshotCryptoSource = credentialCryptoSource.slice(
  credentialCryptoSource.indexOf(
    'export function encryptCommerceCandidateSnapshot',
  ),
  credentialCryptoSource.indexOf(
    'export function decryptCommerceCandidateSnapshot',
  ),
)
includes(candidateSnapshotCryptoSource, [
  "crypto.createHmac('sha256', key)",
  'clawpilot:commerce:candidate-snapshot-digest:v1',
  '.update(authenticatedData)',
  '.update(payload)',
], 'Protected commerce snapshot digest')
assert.ok(
  !candidateSnapshotCryptoSource.includes(
    "hash: crypto.createHash('sha256').update(payload).digest('hex')",
  ),
  'Protected party and address snapshots must not expose an unkeyed plaintext digest',
)
includes(credentialCryptoSource, [
  'encryptCommerceIntakeReadResult',
  'decryptCommerceIntakeReadResult',
  'clawpilot:commerce:intake-read-result-digest:v1',
  "crypto.createHmac('sha256', key)",
  "typeof item === 'bigint'",
  '8_388_608',
], 'Encrypted commerce read replay evidence')
const workflowSource = read(
  'app_src/components/settings/CommerceIntakeWorkflow.tsx',
)
includes(workflowSource, [
  'operatorCommandsAllowed',
  'provider_cursor_live',
  'initializeShadowActivation',
  "'initialize-shadow'",
  'confirmShadowActivation: true',
  'Enable Shadow',
  'Review Operations',
  'Every staged',
  'href="#operations"',
], 'Commerce intake activation recovery')
const intakeRouteSource = read(
  'app_src/app/api/integrations/commerce/intake/route.ts',
)
includes(intakeRouteSource, [
  "body.action === 'initialize-shadow'",
  'assertCommerceIntakeRuntime()',
  'requireActivator(user)',
  'confirmShadowActivation',
  "state: 'shadow'",
  'expectedActivationState',
  'expectedActivationRevision',
  'expectedCurrentState',
  'expectedCurrentRevision',
  'getCommerceIntake',
], 'Authenticated in-place Shadow activation recovery')
includes(persistenceSource, [
  "'COMMERCE_INTAKE_ACTIVATION_REQUIRED'",
  'Initialize Operations in Shadow mode',
], 'Missing activation recovery')
const operationsPersistenceSource = read(
  'app_src/lib/persistence/operations.ts',
)
includes(operationsPersistenceSource, [
  'input.expectedCurrentState',
  "input.expectedCurrentState === 'missing'",
  'row.revision === input.expectedCurrentRevision',
  "'OPERATIONS_ACTIVATION_STATE_CONFLICT'",
], 'Activation recovery state fencing')
includes(workflowSource, [
  "'fetch-products'",
  "'fetch-next-products'",
  "'retry-rejection'",
  "'exclude-rejection'",
  "'resolve-catalog-product'",
  'Retry exact order',
  'Exclusion audit reason',
  'Map existing product',
  'Create and map product',
  'Catalog exclusion reason',
], 'Commerce intake executable recovery and catalog workflow')
includes(workflowSource, [
  "requestError.code === 'COMMERCE_INTAKE_READ_RESTART_REQUIRED'",
  "'COMMERCE_INTAKE_CONTINUATION_RESTART_REQUIRED'",
  'retryKeys.current.delete(retryKey)',
  'await loadIntake().catch(() => undefined)',
  'workflow.pagination?.restartRequired',
], 'Commerce intake executable read restart')
includes(workflowSource, [
  'candidate.externalInventoryItemId',
  'candidate.selectedOptions',
  'candidate.vendor',
  'candidate.productType',
  'candidate.compareAtPriceMinor',
  'candidate.taxable',
  'candidate.requiresShipping',
  'candidate.inventoryQuantity',
  'candidate.weightGrams',
], 'Commerce product candidate fidelity evidence')
assert.ok(
  !workflowSource.includes('providerAccessToken'),
  'Commerce intake workflow must not expose provider access tokens',
)

const providerAttemptSource = read(
  'app_src/lib/persistence/commerceIntegrations.ts',
)
includes(providerAttemptSource, [
  "'commerce-provider-attempt'",
  'ORDER BY attempt_number DESC',
  "if (latest?.state === 'succeeded') return latest.global_id",
  '(latest?.attempt_number || 0) + 1',
], 'Commerce provider retry attempts')

const routeSource = read(
  'app_src/app/api/integrations/commerce/intake/route.ts',
)
includes(routeSource, [
  "export const dynamic = 'force-dynamic'",
  "export const runtime = 'nodejs'",
  'requireRequestUser(req)',
  'isPostgresStorageEnabled()',
  'operationsCapabilities(actor).canManage',
  'export async function GET',
  'export async function POST',
  'const user = await actor(req)',
  "'COMMERCE_POSTGRES_REQUIRED'",
  "'COMMERCE_MANAGER_REQUIRED'",
], 'Commerce intake route')
const actorSource = routeSource.slice(
  routeSource.indexOf('async function actor'),
  routeSource.indexOf('export async function GET'),
)
assert.ok(
  actorSource.indexOf('requireRequestUser(req)')
    < actorSource.indexOf('requirePostgres()'),
  'Commerce intake must authenticate before checking storage',
)
assert.ok(
  actorSource.indexOf('requirePostgres()')
    < actorSource.indexOf('requireManager(value)'),
  'Commerce intake must fail closed on Postgres before manager authorization',
)

class MockCommerceIntegrationRequestError extends Error {
  constructor(message, status, code) {
    super(message)
    this.name = 'CommerceIntegrationRequestError'
    this.status = status
    this.code = code
  }
}

class MockOperationsRequestError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'OperationsRequestError'
    this.status = status
    this.code = code
  }
}

function sanitizeCommerceError(error) {
  if (error instanceof MockCommerceIntegrationRequestError) return error
  return new MockCommerceIntegrationRequestError(
    'Commerce provider request failed',
    502,
    'COMMERCE_UPSTREAM_FAILED',
  )
}

const customerIdentityPersistence = loadTypeScriptModule(
  'app_src/lib/persistence/commerceIntake.ts',
  {
    mocks: {
      '@/lib/auditWriter': { recordAuditEvent() {} },
      '@/lib/integrations/commerceCredentialCrypto': {
        decryptCommerceCandidateSnapshot() {},
        decryptCommerceIntakeContinuation() {},
        encryptCommerceCandidateSnapshot() {},
        encryptCommerceIntakeContinuation() {},
      },
      '@/lib/integrations/commerceIntegrations': {
        CommerceIntegrationRequestError: MockCommerceIntegrationRequestError,
      },
      '@/lib/operations/commerceNormalization': {
        commerceCurrencyMinorUnit() { return 2 },
      },
      '@/lib/persistence/crm': { stageCrmRecordWithClient() {} },
      '@/lib/persistence/postgres': {
        acquireTransactionAdvisoryLock() {},
        withTransaction() {},
      },
    },
  },
)
const customerIdentityInput = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  integrationAccountId: '22222222-2222-4222-8222-222222222222',
  provider: 'shopify',
  candidateGlobalId: 'gcoc0000001',
  externalCustomerId: 'gid://shopify/Customer/123',
}
const customerIdentity = customerIdentityPersistence
  .commerceCustomerIdentityKey(customerIdentityInput)
assert.match(customerIdentity, /^commerce:customer:v1:[a-f0-9]{64}$/)
assert.equal(
  customerIdentityPersistence.commerceCustomerIdentityKey(
    customerIdentityInput,
  ),
  customerIdentity,
  'The same provider-account identity must be deterministic',
)
assert.notEqual(
  customerIdentityPersistence.commerceCustomerIdentityKey({
    ...customerIdentityInput,
    integrationAccountId: '33333333-3333-4333-8333-333333333333',
  }),
  customerIdentity,
  'Two same-provider accounts must not share a CRM customer identity',
)
assert.notEqual(
  customerIdentityPersistence.commerceCustomerIdentityKey({
    ...customerIdentityInput,
    provider: 'faire',
  }),
  customerIdentity,
  'Provider identities must remain distinct',
)
assert.notEqual(
  customerIdentityPersistence.commerceCustomerIdentityKey({
    ...customerIdentityInput,
    externalCustomerId: null,
  }),
  customerIdentity,
  'A candidate-scoped fallback must not collide with a provider customer ID',
)

const organizationId = '11111111-1111-4111-8111-111111111111'
const actorEmail = 'manager@example.test'
const shopifyRuntime = {
  organizationId,
  integrationAccountId: '22222222-2222-4222-8222-222222222222',
  globalId: 'gcia0000001',
  provider: 'shopify',
  environment: 'sandbox',
  externalAccountId: 'gid://shopify/Shop/123',
  status: 'active',
  verificationStatus: 'verified',
  credentialVersion: 3,
  configuration: { shopDomain: 'example.myshopify.com' },
  encrypted: {},
}
const faireRuntime = {
  ...shopifyRuntime,
  integrationAccountId: '33333333-3333-4333-8333-333333333333',
  globalId: 'gcia0000002',
  provider: 'faire',
  externalAccountId: 'brand-123',
  configuration: {},
}
const runtimes = new Map([
  [shopifyRuntime.globalId, shopifyRuntime],
  [faireRuntime.globalId, faireRuntime],
])
const providerReads = {
  shopifyToken: 0,
  shopifyProbe: 0,
  shopifyGraphql: 0,
  faireProducts: 0,
  faireInventory: 0,
  faireOrders: 0,
  faireOrder: 0,
}
const providerAttempts = []
const providerReservations = []
const capturedReads = new Map()
const uncertainReads = []
const persistenceCommands = []
const stateReads = []
const stageReplays = new Map()
const continuations = new Map()
const readIntents = new Map()
const invalidContinuations = []
const stageAttempts = []
let failStageOnceForKey = null
const refreshTargets = new Map([
  ['gcoc0000001', {
    provider: 'shopify',
    external_order_id: 'gid://shopify/Order/999',
    source_hash: 'f'.repeat(64),
  }],
])
let runSequence = 0
const normalizedSources = {
  shopify: null,
  faire: null,
}
const hydratedFaireProductSources = []

function envelope(provider, orderIds) {
  return {
    provider,
    normalizerVersion: `commerce-normalization-${provider}-v1`,
    products: [],
    orders: orderIds.map((identity) => ({
      identity: { value: identity },
      canonicalStates: {
        lifecycle: 'open',
        fulfillment: 'unfulfilled',
      },
    })),
    rejections: [],
  }
}

function persistenceCommand(name) {
  return async (input) => {
    persistenceCommands.push({ name, input })
    return { action: name, replayed: false }
  }
}

const service = loadTypeScriptModule(
  'app_src/lib/integrations/commerceIntake.ts',
  {
    mocks: {
      '@/lib/integrations/commerceCredentialCrypto': {
        decryptCommerceCredential(_encrypted, _organizationId, provider) {
          if (provider === 'shopify') {
            return {
              provider,
              authMode: 'shopify_client_credentials',
              clientId: 'client-id',
              clientSecret: 'client-secret',
            }
          }
          return {
            provider,
            authMode: 'faire_oauth',
            accessToken: 'faire-access-token',
            applicationId: 'faire-application-id',
            applicationSecret: 'faire-application-secret',
            scopes: ['READ_ORDERS', 'READ_PRODUCTS', 'READ_INVENTORIES'],
          }
        },
        normalizeCommerceAccountGlobalId: (value) => String(value),
        normalizeCommerceOrganizationId: (value) => String(value),
      },
      '@/lib/integrations/commerceIntegrations': {
        CommerceIntegrationRequestError: MockCommerceIntegrationRequestError,
        sanitizedCommerceIntegrationError: sanitizeCommerceError,
      },
      '@/lib/integrations/faireCommerceClient': {
        async listFaireProducts(_options, listOptions) {
          providerReads.faireProducts += 1
          return {
            products: [{
              id: listOptions.cursor
                ? 'faire-product-2'
                : 'faire-product-1',
              variants: listOptions.cursor
                ? [{ id: 'faire-variant-2' }]
                : Array.from({ length: 51 }, (_value, index) => ({
                    id: index === 0
                      ? 'faire-variant-1'
                      : `faire-variant-1-${index}`,
                  })),
            }],
            ...(!listOptions.cursor
              ? { next_cursor: 'faire-products-page-2' }
              : {}),
          }
        },
        async listFaireInventory(_options, query) {
          providerReads.faireInventory += 1
          assert.ok(query.productVariantIds.length <= 50)
          return {
            inventories: Object.fromEntries(
              query.productVariantIds.map((variantId) => [variantId, {
                available_quantity: {
                  type: 'QUANTITY',
                  quantity: variantId === 'faire-variant-2' ? -2 : 4,
                },
              }]),
            ),
          }
        },
        async listFaireOrders(_options, listOptions) {
          providerReads.faireOrders += 1
          assert.equal(listOptions.limit, 50)
          if (!listOptions.cursor) {
            return {
              orders: [{ id: 'faire-order-1' }],
              next_cursor: 'faire-orders-page-2',
            }
          }
          assert.equal(listOptions.cursor, 'faire-orders-page-2')
          return { orders: [{ id: 'faire-order-2' }] }
        },
        async getFaireOrder(_options, orderId) {
          providerReads.faireOrder += 1
          return { id: orderId }
        },
      },
      '@/lib/integrations/faireCommerceNormalizer': {
        normalizeFaireCommerce(source) {
          normalizedSources.faire = source
          if (source.inventories) {
            hydratedFaireProductSources.push(source)
          }
          const result = envelope(
            'faire',
            source.orders.orders.map((order) => order.id),
          )
          result.products = source.products.products.map((product) => ({
            identity: { value: product.id },
            variants: product.variants.map((variant) => ({
              identity: { value: variant.id },
            })),
          }))
          return result
        },
      },
      '@/lib/integrations/shopifyCommerceNormalizer': {
        normalizeShopifyCommerce(source) {
          normalizedSources.shopify = source
          const result = envelope(
            'shopify',
            source.data.orders.nodes.map((order) => order.id),
          )
          result.products = source.data.products.nodes.map((product) => ({
            identity: { value: product.id },
            variants: product.variants.nodes.map((variant) => ({
              identity: { value: variant.id },
            })),
          }))
          return result
        },
      },
      '@/lib/operations/commerceNormalization': {
        createCommerceNormalizationRejection(input) {
          return {
            resourceType: input.resourceType,
            externalId: input.externalId || 'unknown',
            sourceHash: 'a'.repeat(64),
            errorCode: input.errorCode,
            safeMessage: 'Provider record was rejected.',
          }
        },
      },
      '@/lib/integrations/shopifyCommerceClient': {
        normalizeShopifyShopDomain: (value) => String(value),
        async requestShopifyAccessToken() {
          providerReads.shopifyToken += 1
          return {
            accessToken: 'shopify-access-token',
            grantedScopes: [
              'read_all_orders',
              'read_orders',
              'read_products',
            ],
          }
        },
        async probeShopifyConnection() {
          providerReads.shopifyProbe += 1
          return { shopId: shopifyRuntime.externalAccountId }
        },
        async shopifyAdminGraphql(_credential, request) {
          providerReads.shopifyGraphql += 1
          assert.doesNotMatch(request.query, /\bmutation\b/i)
          if (request.operationName === 'ClawPilotCommerceOrders') {
            assert.match(request.variables.query, /test:false status:open/)
            if (!request.variables.after) {
              return {
                orders: {
                  nodes: [{
                    id: 'gid://shopify/Order/1',
                    lineItems: {
                      nodes: [{ id: 'gid://shopify/LineItem/1' }],
                      pageInfo: {
                        hasNextPage: true,
                        endCursor: 'lines-page-2',
                      },
                    },
                  }],
                  pageInfo: {
                    hasNextPage: true,
                    endCursor: 'orders-page-2',
                  },
                },
              }
            }
            assert.equal(request.variables.after, 'orders-page-2')
            return {
              orders: {
                nodes: [{
                  id: 'gid://shopify/Order/2',
                  lineItems: {
                    nodes: [],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            }
          }
          if (request.operationName === 'ClawPilotCommerceOrder') {
            return {
              order: {
                id: request.variables.id,
                lineItems: {
                  nodes: [],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            }
          }
          if (request.operationName === 'ClawPilotCommerceOrderLines') {
            assert.equal(request.variables.id, 'gid://shopify/Order/1')
            assert.equal(request.variables.after, 'lines-page-2')
            return {
              order: {
                id: request.variables.id,
                lineItems: {
                  nodes: [{ id: 'gid://shopify/LineItem/2' }],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            }
          }
          if (
            request.operationName === 'ClawPilotCommerceProductVariants'
          ) {
            const secondPage = Boolean(request.variables.after)
            if (secondPage) {
              assert.equal(
                request.variables.after,
                'shopify-products-page-2',
              )
            }
            return {
              shop: { currencyCode: 'USD' },
              productVariants: {
                nodes: [{
                  id: secondPage
                    ? 'gid://shopify/ProductVariant/2'
                    : 'gid://shopify/ProductVariant/1',
                  title: 'Default',
                  displayName: 'Example - Default',
                  sku: 'EXAMPLE-1',
                  price: '12.00',
                  updatedAt: '2026-07-26T00:00:00.000Z',
                  product: {
                    id: secondPage
                      ? 'gid://shopify/Product/2'
                      : 'gid://shopify/Product/1',
                    title: 'Example',
                    status: 'ACTIVE',
                    updatedAt: '2026-07-26T00:00:00.000Z',
                  },
                }],
                pageInfo: secondPage
                  ? { hasNextPage: false, endCursor: null }
                  : {
                      hasNextPage: true,
                      endCursor: 'shopify-products-page-2',
                    },
              },
            }
          }
          assert.fail(`Unexpected Shopify operation ${request.operationName}`)
        },
      },
      '@/lib/persistence/commerceIntegrations': {
        async readCommerceRuntimeCredentialFromPostgres(input) {
          return runtimes.get(input.accountGlobalId) || null
        },
      },
      '@/lib/persistence/commerceIntake': {
        confirmCommerceCandidateAddressInPostgres:
          persistenceCommand('confirm-address'),
        markCommerceCandidateUnsupportedInPostgres:
          persistenceCommand('mark-unsupported'),
        excludeCommerceIntakeRejectionInPostgres:
          persistenceCommand('exclude-rejection'),
        promoteCommerceCandidateInPostgres: persistenceCommand('promote'),
        async readCommerceIntakeStateFromPostgres(input) {
          stateReads.push(input)
          return { accountGlobalId: input.accountGlobalId, candidates: [] }
        },
        async readCommerceIntakeStageReplayFromPostgres(input) {
          const replay = stageReplays.get(
            `${input.accountGlobalId}:${input.action}:${input.idempotencyKey}`,
          ) || null
          if (
            replay
            && (
              replay.target.kind !== input.target.kind
              || replay.target.globalId !== input.target.globalId
            )
          ) {
            const error = new Error(
              'This idempotency key already completed a different intake action or target',
            )
            error.code = 'COMMERCE_INTAKE_IDEMPOTENCY_CONFLICT'
            throw error
          }
          return replay?.result || null
        },
        async prepareCommerceIntakeReadIntentInPostgres(input) {
          const existing = readIntents.get(input.idempotencyKey)
          if (existing) return existing
          let continuedPage = null
          if (input.continuationRunGlobalId) {
            if (input.continuationRunGlobalId === 'gcir9999999') {
              throw new Error('simulated encrypted continuation corruption')
            }
            continuedPage = continuations.get(input.continuationRunGlobalId)
            assert.ok(
              continuedPage,
              'Continuation handle must resolve while preparing its read intent',
            )
          }
          const prepared = {
            id: `44444444-4444-4444-8444-${String(
              readIntents.size + 1,
            ).padStart(12, '0')}`,
            ...(continuedPage || {
              mode: 'operational',
              resource: input.resource,
              sessionId: `55555555-5555-4555-8555-${String(
                readIntents.size + 1,
              ).padStart(12, '0')}`,
              batchNumber: 1,
              previousRunGlobalId: null,
              windowStart: null,
              windowEnd: '2026-07-26T12:00:00.000Z',
              queryHash: 'c'.repeat(64),
              orderCursor: null,
              cursorHash: null,
            }),
          }
          readIntents.set(input.idempotencyKey, prepared)
          return prepared
        },
        async reserveCommerceIntakeProviderReadInPostgres(input) {
          providerReservations.push(input)
          const prepared = readIntents.get(input.idempotencyKey)
          assert.equal(prepared.id, input.readIntentId)
          const captured = capturedReads.get(input.readIntentId)
          if (captured) {
            return {
              kind: 'captured',
              readIntentId: input.readIntentId,
              providerAttemptId: captured.providerAttemptId,
              responseHash: captured.responseHash,
              result: captured.result,
            }
          }
          const ordinal = providerAttempts.length + 1
          const attempt = {
            action: 'commerce.intake.read',
            ...input,
            providerAttemptId:
              `66666666-6666-4666-8666-${String(ordinal).padStart(12, '0')}`,
            leaseToken:
              `77777777-7777-4777-8777-${String(ordinal).padStart(12, '0')}`,
            requestHash: 'd'.repeat(64),
            redactedResponse: null,
          }
          providerAttempts.push(attempt)
          return {
            kind: 'lease',
            readIntentId: input.readIntentId,
            providerAttemptId: attempt.providerAttemptId,
            leaseToken: attempt.leaseToken,
            requestHash: attempt.requestHash,
          }
        },
        async captureCommerceIntakeProviderReadInPostgres(input) {
          const attempt = providerAttempts.find(
            (candidate) => (
              candidate.providerAttemptId === input.providerAttemptId
            ),
          )
          assert.ok(attempt, 'Captured response must use its reserved attempt')
          attempt.redactedResponse = input.redactedResponse
          const captured = {
            result: input.result,
            responseHash: 'e'.repeat(64),
            providerAttemptId: input.providerAttemptId,
          }
          capturedReads.set(input.readIntentId, captured)
          return captured
        },
        async markCommerceIntakeProviderReadUncertainInPostgres(input) {
          uncertainReads.push(input)
        },
        async readCommerceIntakeRejectionTargetFromPostgres() {
          return {
            provider: 'shopify',
            resource_type: 'order',
            external_id: 'gid://shopify/Order/999',
            source_hash: 'e'.repeat(64),
            row_version: 0,
          }
        },
        async readCommerceIntakeRefreshTargetFromPostgres(input) {
          return refreshTargets.get(input.candidateGlobalId)
        },
        async markCommerceIntakeContinuationInvalidInPostgres(input) {
          invalidContinuations.push(input)
        },
        resolveCommerceCandidateCustomerInPostgres:
          persistenceCommand('resolve-customer'),
        resolveCommerceCandidateDeliveryInPostgres:
          persistenceCommand('resolve-delivery'),
        resolveCommerceCandidatePackageInPostgres:
          persistenceCommand('resolve-package'),
        resolveCommerceCandidateProductInPostgres:
          persistenceCommand('resolve-product'),
        resolveCommerceProductCandidateInPostgres:
          persistenceCommand('resolve-catalog-product'),
        async stageCommerceNormalizationEnvelopeInPostgres(input) {
          stageAttempts.push(input)
          if (failStageOnceForKey === input.idempotencyKey) {
            failStageOnceForKey = null
            throw new Error('simulated crash after durable provider capture')
          }
          persistenceCommands.push({ name: 'stage-envelope', input })
          const action = input.stageAction
          const runGlobalId =
            `gcir${String(runSequence += 1).padStart(7, '0')}`
          const result = {
            action,
            replayed: false,
            runGlobalId,
            providerWrites: 0,
            syncCursorAdvanced: false,
          }
          if (input.page?.nextOrderCursor) {
            continuations.set(runGlobalId, {
              mode: input.page.mode,
              resource: input.page.resource,
              sessionId: input.page.sessionId,
              batchNumber: input.page.batchNumber + 1,
              previousRunGlobalId: runGlobalId,
              windowStart: input.page.windowStart,
              windowEnd: input.page.windowEnd,
              queryHash: input.page.queryHash,
              orderCursor: input.page.nextOrderCursor,
              cursorHash: 'b'.repeat(64),
            })
          }
          stageReplays.set(
            `${input.runtime.globalId}:${action}:${input.idempotencyKey}`,
            {
              target: action === 'refresh'
                ? {
                    kind: 'candidate',
                    globalId: input.refreshCandidateGlobalId,
                  }
                : action === 'retry-rejection'
                  ? {
                      kind: 'rejection',
                      globalId: input.retryRejectionGlobalId,
                    }
                  : (
                    action === 'fetch-next'
                    || action === 'fetch-next-products'
                  )
                    ? {
                        kind: 'continuation',
                        globalId: input.page?.previousRunGlobalId || null,
                      }
                    : { kind: 'none', globalId: null },
              result: { ...result, replayed: true },
            },
          )
          return result
        },
        validateCommerceCandidateInPostgres: persistenceCommand('validate'),
      },
    },
  },
)

const savedEnvironment = {
  enabled: process.env.CLAWPILOT_COMMERCE_INTAKE_ENABLED,
  lane: process.env.CLAWPILOT_ENV,
}
process.env.CLAWPILOT_COMMERCE_INTAKE_ENABLED = '1'
process.env.CLAWPILOT_ENV = 'development'

let keySequence = 0
function nextKey() {
  keySequence += 1
  return `00000000-0000-4000-8000-${String(keySequence).padStart(12, '0')}`
}

function commandBody(action, extra = {}) {
  return {
    action,
    accountGlobalId: shopifyRuntime.globalId,
    candidateGlobalId: 'gcoc0000001',
    idempotencyKey: nextKey(),
    rowVersion: 0,
    ...extra,
  }
}

try {
  const shopifyFetchKey = nextKey()
  failStageOnceForKey = shopifyFetchKey
  await assert.rejects(
    service.executeCommerceIntakeCommand({
      organizationId,
      actorEmail,
      body: {
        action: 'fetch',
        accountGlobalId: shopifyRuntime.globalId,
        confirmReadOnly: true,
        idempotencyKey: shopifyFetchKey,
      },
    }),
    /simulated crash after durable provider capture/,
  )
  const readsAfterDurableCapture = { ...providerReads }
  const firstShopify = await service.executeCommerceIntakeCommand({
    organizationId,
    actorEmail,
    body: {
      action: 'fetch',
      accountGlobalId: shopifyRuntime.globalId,
      confirmReadOnly: true,
      idempotencyKey: shopifyFetchKey,
    },
  })
  assert.deepEqual(
    providerReads,
    readsAfterDurableCapture,
    'Retry after durable capture must stage the identical response without another provider read',
  )
  await service.executeCommerceIntakeCommand({
    organizationId,
    actorEmail,
    body: {
      action: 'fetch-next',
      accountGlobalId: shopifyRuntime.globalId,
      continuationRunGlobalId: firstShopify.command.runGlobalId,
      confirmReadOnly: true,
      idempotencyKey: nextKey(),
    },
  })
  const firstShopifyProducts = await service.executeCommerceIntakeCommand({
    organizationId,
    actorEmail,
    body: {
      action: 'fetch-products',
      accountGlobalId: shopifyRuntime.globalId,
      confirmReadOnly: true,
      idempotencyKey: nextKey(),
    },
  })
  await service.executeCommerceIntakeCommand({
    organizationId,
    actorEmail,
    body: {
      action: 'fetch-next-products',
      accountGlobalId: shopifyRuntime.globalId,
      continuationRunGlobalId: firstShopifyProducts.command.runGlobalId,
      confirmReadOnly: true,
      idempotencyKey: nextKey(),
    },
  })
  const firstFaireProducts = await service.executeCommerceIntakeCommand({
    organizationId,
    actorEmail,
    body: {
      action: 'fetch-products',
      accountGlobalId: faireRuntime.globalId,
      confirmReadOnly: true,
      idempotencyKey: nextKey(),
    },
  })
  await service.executeCommerceIntakeCommand({
    organizationId,
    actorEmail,
    body: {
      action: 'fetch-next-products',
      accountGlobalId: faireRuntime.globalId,
      continuationRunGlobalId: firstFaireProducts.command.runGlobalId,
      confirmReadOnly: true,
      idempotencyKey: nextKey(),
    },
  })
  const firstFaire = await service.executeCommerceIntakeCommand({
    organizationId,
    actorEmail,
    body: {
      action: 'fetch',
      accountGlobalId: faireRuntime.globalId,
      confirmReadOnly: true,
      idempotencyKey: nextKey(),
    },
  })
  await service.executeCommerceIntakeCommand({
    organizationId,
    actorEmail,
    body: {
      action: 'fetch-next',
      accountGlobalId: faireRuntime.globalId,
      continuationRunGlobalId: firstFaire.command.runGlobalId,
      confirmReadOnly: true,
      idempotencyKey: nextKey(),
    },
  })
  const refreshKey = nextKey()
  await service.executeCommerceIntakeCommand({
    organizationId,
    actorEmail,
    body: {
      action: 'refresh',
      accountGlobalId: shopifyRuntime.globalId,
      candidateGlobalId: 'gcoc0000001',
      confirmReadOnly: true,
      idempotencyKey: refreshKey,
    },
  })
  await assert.rejects(
    service.executeCommerceIntakeCommand({
      organizationId,
      actorEmail,
      body: {
        action: 'refresh',
        accountGlobalId: shopifyRuntime.globalId,
        candidateGlobalId: 'gcoc0000002',
        confirmReadOnly: true,
        idempotencyKey: refreshKey,
      },
    }),
    (error) => error.code === 'COMMERCE_INTAKE_IDEMPOTENCY_CONFLICT',
  )
  await service.executeCommerceIntakeCommand({
    organizationId,
    actorEmail,
    body: {
      action: 'retry-rejection',
      accountGlobalId: shopifyRuntime.globalId,
      rejectionGlobalId: 'gcrj0000001',
      confirmReadOnly: true,
      idempotencyKey: nextKey(),
    },
  })
  const replayedFetch = await service.executeCommerceIntakeCommand({
    organizationId,
    actorEmail,
    body: {
      action: 'fetch',
      accountGlobalId: shopifyRuntime.globalId,
      confirmReadOnly: true,
      idempotencyKey: shopifyFetchKey,
    },
  })
  assert.equal(replayedFetch.command.replayed, true)
  await assert.rejects(
    service.executeCommerceIntakeCommand({
      organizationId,
      actorEmail,
      body: {
        action: 'fetch-next',
        accountGlobalId: shopifyRuntime.globalId,
        continuationRunGlobalId: 'gcir9999999',
        confirmReadOnly: true,
        idempotencyKey: nextKey(),
      },
    }),
    (error) => (
      error.code === 'COMMERCE_INTAKE_CONTINUATION_RESTART_REQUIRED'
    ),
  )
  assert.equal(invalidContinuations.length, 1)
  assert.equal(
    invalidContinuations[0].continuationRunGlobalId,
    'gcir9999999',
  )

  assert.deepEqual(providerReads, {
    shopifyToken: 6,
    shopifyProbe: 6,
    shopifyGraphql: 7,
    faireProducts: 2,
    faireInventory: 3,
    faireOrders: 2,
    faireOrder: 0,
  })
  assert.equal(normalizedSources.shopify.data.products.nodes.length, 0)
  assert.equal(normalizedSources.shopify.data.orders.nodes.length, 1)
  assert.equal(
    normalizedSources.shopify.data.orders.nodes[0].id,
    'gid://shopify/Order/999',
  )
  assert.equal(
    normalizedSources.shopify.data.orders.pageInfo.hasNextPage,
    false,
  )
  assert.equal(normalizedSources.faire.products.products.length, 0)
  assert.equal(normalizedSources.faire.orders.orders.length, 1)
  assert.equal(normalizedSources.faire.products.next_cursor, null)
  assert.equal(normalizedSources.faire.orders.next_cursor, null)
  assert.equal(hydratedFaireProductSources.length, 2)
  assert.equal(
    hydratedFaireProductSources[0].inventories['faire-variant-1']
      .available_quantity.quantity,
    4,
  )
  assert.equal(
    hydratedFaireProductSources[1].inventories['faire-variant-2']
      .available_quantity.quantity,
    -2,
  )
  assert.equal(providerAttempts.length, 10)
  assert.equal(providerReservations.length, 11)
  assert.equal(capturedReads.size, 10)
  assert.equal(uncertainReads.length, 0)
  assert.equal(stageAttempts.length, 11)
  for (const attempt of providerAttempts) {
    assert.equal(attempt.action, 'commerce.intake.read')
    assert.equal(attempt.redactedRequest.readOnly, true)
    assert.equal(attempt.redactedResponse.providerWrites, 0)
    assert.equal(attempt.redactedResponse.syncCursorAdvanced, false)
  }
  assert.equal(
    persistenceCommands.filter(({ name }) => name === 'stage-envelope').length,
    10,
  )
  const staged = persistenceCommands.filter(
    ({ name }) => name === 'stage-envelope',
  )
  for (const { input } of staged) {
    assert.match(input.readIntentId, /^[a-f0-9-]{36}$/)
    assert.match(input.capturedResponseHash, /^[a-f0-9]{64}$/)
  }
  assert.deepEqual(
    staged.map(({ input }) => input.stageAction),
    [
      'fetch',
      'fetch-next',
      'fetch-products',
      'fetch-next-products',
      'fetch-products',
      'fetch-next-products',
      'fetch',
      'fetch-next',
      'refresh',
      'retry-rejection',
    ],
  )
  assert.equal(staged[0].input.page.batchNumber, 1)
  assert.equal(staged[0].input.page.providerRowsSeen, 1)
  assert.equal(staged[1].input.page.batchNumber, 2)
  assert.equal(staged[1].input.page.nextOrderCursor, null)
  assert.equal(staged[2].input.page.resource, 'products')
  assert.equal(staged[3].input.page.resource, 'products')
  assert.equal(staged[8].input.page, null)
  assert.equal(staged[9].input.page, null)

  const localCommands = [
    commandBody('exclude-rejection', {
      rejectionGlobalId: 'gcrj0000002',
      reason: 'Provider revision is not usable for this catalog.',
    }),
    commandBody('resolve-catalog-product', {
      candidateGlobalId: 'gcpc0000001',
      resolution: {
        mode: 'existing',
        productGlobalId: 'gp0000001',
      },
    }),
    commandBody('resolve-catalog-product', {
      candidateGlobalId: 'gcpc0000001',
      resolution: {
        mode: 'create',
        name: 'Provider catalog product',
        sku: 'CATALOG-1',
        unitPriceMinor: 497,
        currency: 'USD',
      },
    }),
    commandBody('resolve-catalog-product', {
      candidateGlobalId: 'gcpc0000001',
      resolution: {
        mode: 'exclude',
        reasonCode: 'provider_catalog_unsupported',
        reason: 'This catalog revision is not operationally supported.',
      },
    }),
    commandBody('resolve-product', {
      lineGlobalId: 'gcol0000001',
      product: {
        mode: 'existing',
        productGlobalId: 'gp0000001',
        unitPriceMinor: 497,
        currency: 'USD',
      },
    }),
    commandBody('resolve-customer', {
      customer: {
        mode: 'existing',
        customerGlobalId: 'ga0000001',
      },
    }),
    commandBody('confirm-address', {
      address: {
        name: 'Example Buyer',
        line1: '10 Market Street',
        city: 'Brooklyn',
        region: 'NY',
        postalCode: '11201',
        country: 'US',
      },
    }),
    commandBody('resolve-delivery', {
      decision: {
        mode: 'manual',
        requestedDeliveryAt: '2026-08-01T15:00:00.000Z',
      },
    }),
    commandBody('resolve-package', {
      lineGlobalId: 'gcol0000001',
      package: {
        mode: 'manual',
        weightGrams: 125,
        dimensionsMm: { length: 200, width: 100, height: 50 },
      },
    }),
    commandBody('validate'),
    commandBody('mark-unsupported', {
      reasonCode: 'provider_state_unsupported',
      reason: 'The source state cannot be promoted safely',
    }),
    commandBody('promote', { confirmProviderWriteOff: true }),
  ]
  for (const body of localCommands) {
    await service.executeCommerceIntakeCommand({
      organizationId,
      actorEmail,
      body,
    })
  }

  const calledNames = persistenceCommands.map(({ name }) => name)
  for (const expected of [
    'exclude-rejection',
    'resolve-catalog-product',
    'resolve-product',
    'resolve-customer',
    'confirm-address',
    'resolve-delivery',
    'resolve-package',
    'validate',
    'mark-unsupported',
    'promote',
  ]) {
    assert.ok(calledNames.includes(expected), `Command path missing ${expected}`)
  }
  assert.deepEqual(providerReads, {
    shopifyToken: 6,
    shopifyProbe: 6,
    shopifyGraphql: 7,
    faireProducts: 2,
    faireInventory: 3,
    faireOrders: 2,
    faireOrder: 0,
  }, 'Resolution, validation, and promotion must not call providers')
  const promotion = persistenceCommands.find(({ name }) => name === 'promote')
  assert.match(promotion.input.requestHash, /^[a-f0-9]{64}$/)
  assert.ok(stateReads.length >= localCommands.length + 2)
} finally {
  if (savedEnvironment.enabled === undefined) {
    delete process.env.CLAWPILOT_COMMERCE_INTAKE_ENABLED
  } else {
    process.env.CLAWPILOT_COMMERCE_INTAKE_ENABLED = savedEnvironment.enabled
  }
  if (savedEnvironment.lane === undefined) {
    delete process.env.CLAWPILOT_ENV
  } else {
    process.env.CLAWPILOT_ENV = savedEnvironment.lane
  }
}

let authenticated = true
let postgresEnabled = true
let managerEnabled = true
let activatorEnabled = true
let intakeRuntimeEnabled = true
const routeTrace = []
const routeServiceCalls = []
const routeActor = {
  email: actorEmail,
  organizationId,
}
const route = loadTypeScriptModule(
  'app_src/app/api/integrations/commerce/intake/route.ts',
  {
    mocks: {
      'next/server': {
        NextResponse: {
          json(payload, init = {}) {
            return {
              payload,
              status: init.status || 200,
              headers: init.headers || {},
            }
          },
        },
      },
      '@/lib/integrations/commerceIntake': {
        assertCommerceIntakeRuntime() {
          routeTrace.push('runtime')
          if (!intakeRuntimeEnabled) {
            throw new MockCommerceIntegrationRequestError(
              'Commerce intake is not enabled in this environment',
              404,
              'COMMERCE_INTAKE_DISABLED',
            )
          }
        },
        async executeCommerceIntakeCommand(input) {
          routeTrace.push('service-post')
          routeServiceCalls.push({ method: 'POST', input })
          return { command: { action: input.body.action }, intake: {} }
        },
        async getCommerceIntake(input) {
          routeTrace.push('service-get')
          routeServiceCalls.push({ method: 'GET', input })
          return { accountGlobalId: input.accountGlobalId }
        },
      },
      '@/lib/integrations/commerceIntegrations': {
        CommerceIntegrationRequestError: MockCommerceIntegrationRequestError,
        async getCommerceIntegrationsState() {
          routeTrace.push('integration-state')
          return {
            accounts: [{
              globalId: shopifyRuntime.globalId,
              configured: true,
              verificationStatus: 'verified',
            }],
          }
        },
        sanitizedCommerceIntegrationError: sanitizeCommerceError,
      },
      '@/lib/operations/authorization': {
        operationsCapabilities() {
          routeTrace.push('manager')
          return {
            canManage: managerEnabled,
            canActivate: activatorEnabled,
          }
        },
      },
      '@/lib/persistence/config': {
        isPostgresStorageEnabled() {
          routeTrace.push('postgres')
          return postgresEnabled
        },
      },
      '@/lib/persistence/operations': {
        OperationsRequestError: MockOperationsRequestError,
        async updateOperationsActivationInPostgres(input) {
          routeTrace.push('activation-update')
          return {
            state: input.state,
            revision: 1,
          }
        },
      },
      '@/lib/requestUser': {
        async requireRequestUser() {
          routeTrace.push('auth')
          if (!authenticated) throw new Error('Unauthorized')
          return routeActor
        },
      },
    },
  },
)

function mockRequest(method, body) {
  const bytes = body === undefined
    ? Buffer.alloc(0)
    : Buffer.from(JSON.stringify(body))
  return {
    method,
    headers: new Headers(
      body === undefined ? {} : { 'content-length': String(bytes.byteLength) },
    ),
    nextUrl: new URL(
      `https://clawpilot.example/api/integrations/commerce/intake`
      + `?accountGlobalId=${shopifyRuntime.globalId}`,
    ),
    async arrayBuffer() {
      return bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      )
    },
  }
}

authenticated = false
routeTrace.length = 0
let response = await route.GET(mockRequest('GET'))
assert.equal(response.status, 401)
assert.deepEqual(routeTrace, ['auth'])
assert.equal(routeServiceCalls.length, 0)

authenticated = true
postgresEnabled = false
routeTrace.length = 0
response = await route.GET(mockRequest('GET'))
assert.equal(response.status, 503)
assert.deepEqual(routeTrace, ['auth', 'postgres'])
assert.equal(routeServiceCalls.length, 0)

postgresEnabled = true
managerEnabled = false
routeTrace.length = 0
response = await route.GET(mockRequest('GET'))
assert.equal(response.status, 403)
assert.deepEqual(routeTrace, ['auth', 'postgres', 'manager'])
assert.equal(routeServiceCalls.length, 0)

managerEnabled = true
routeTrace.length = 0
response = await route.GET(mockRequest('GET'))
assert.equal(response.status, 200)
assert.deepEqual(routeTrace, ['auth', 'postgres', 'manager', 'service-get'])
assert.equal(routeServiceCalls.at(-1).input.organizationId, organizationId)

routeTrace.length = 0
response = await route.POST(mockRequest('POST', {
  action: 'validate',
  accountGlobalId: shopifyRuntime.globalId,
}))
assert.equal(response.status, 200)
assert.deepEqual(routeTrace, ['auth', 'postgres', 'manager', 'service-post'])
assert.equal(routeServiceCalls.at(-1).input.actorEmail, actorEmail)

intakeRuntimeEnabled = false
routeTrace.length = 0
response = await route.POST(mockRequest('POST', {
  action: 'initialize-shadow',
  accountGlobalId: shopifyRuntime.globalId,
  confirmShadowActivation: true,
  expectedActivationState: 'missing',
  expectedActivationRevision: null,
}))
assert.equal(response.status, 404)
assert.deepEqual(routeTrace, ['auth', 'postgres', 'manager', 'runtime'])
assert.ok(!routeTrace.includes('activation-update'))

intakeRuntimeEnabled = true
activatorEnabled = false
routeTrace.length = 0
response = await route.POST(mockRequest('POST', {
  action: 'initialize-shadow',
  accountGlobalId: shopifyRuntime.globalId,
  confirmShadowActivation: true,
  expectedActivationState: 'missing',
  expectedActivationRevision: null,
}))
assert.equal(response.status, 403)
assert.deepEqual(routeTrace, [
  'auth',
  'postgres',
  'manager',
  'runtime',
  'manager',
])

activatorEnabled = true
routeTrace.length = 0
response = await route.POST(mockRequest('POST', {
  action: 'initialize-shadow',
  accountGlobalId: shopifyRuntime.globalId,
  confirmShadowActivation: true,
  expectedActivationState: 'missing',
  expectedActivationRevision: null,
}))
assert.equal(response.status, 200)
assert.deepEqual(routeTrace, [
  'auth',
  'postgres',
  'manager',
  'runtime',
  'manager',
  'integration-state',
  'activation-update',
  'service-get',
])
assert.equal(response.payload.intake.accountGlobalId, shopifyRuntime.globalId)

console.log('PASS test-commerce-intake')
