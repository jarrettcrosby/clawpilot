import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relativePath) => fs.readFileSync(
  path.join(root, relativePath),
  'utf8',
)

const migration = read(
  'db/migrations/0131_crm_product_identity_aliases.sql',
)
const adapter = read('app_src/lib/persistence/productIdentity.ts')
const crmAdapter = read('app_src/lib/persistence/crm.ts')
const route = read(
  'app_src/app/api/crm/product-identities/route.ts',
)
const dialog = read(
  'app_src/components/crm/ProductIdentityDialog.tsx',
)
const crmUi = read('app_src/components/crm/CrmSection.tsx')
const contract = read('docs/modules/distributed-operations.md')

assert.match(
  migration,
  /CREATE TABLE IF NOT EXISTS crm_product_identity_aliases/,
  'product identity aliases must be durable',
)
assert.match(
  migration,
  /alias_product_id <> canonical_product_id/,
  'an alias cannot point to itself',
)
assert.match(
  migration,
  /UNIQUE \(pipeline_id, alias_product_id\)/,
  'an old product identity can have only one canonical target',
)
assert.match(
  migration,
  /CREATE TRIGGER validate_crm_product_identity_alias/,
  'alias writes must reject chains and cycles',
)
assert.match(
  migration,
  /CREATE OR REPLACE FUNCTION resolve_crm_product_identity/,
  'consumers must have one canonical product resolver contract',
)
assert.match(
  migration,
  /ON DELETE RESTRICT/,
  'product aliases must retain historical product identities',
)
assert.match(
  adapter,
  /duplicate_has_operational_references/,
  'automatic reconciliation must block operationally referenced duplicates',
)
assert.match(
  adapter,
  /SET active = false/,
  'the historical provider mapping must be retained but deactivated',
)
assert.match(
  adapter,
  /INSERT INTO operations_product_mappings/,
  'the exact provider variant must receive a new canonical mapping',
)
assert.match(
  adapter,
  /UPDATE operations_product_channel_states/,
  'the current channel projection must follow the canonical mapping',
)
assert.match(
  adapter,
  /product_mapping_id = \$9::uuid[\s\S]*RETURNING id/,
  'channel projection transfer must fence the reviewed mapping',
)
assert.match(
  adapter,
  /channelState\.rowCount !== 1/,
  'a missing channel projection must fail closed',
)
assert.match(
  adapter,
  /archivedSource: 'product_identity_reconciliation'/,
  'the duplicate CRM product must be retained as an archived alias',
)
assert.match(
  adapter,
  /archivedProductIdentityName/,
  'the duplicate must receive a unique archived name before canonical rename',
)
assert.match(
  adapter,
  /expectedCanonicalMappingGlobalIds/,
  'apply must fence the exact reviewed active mapping set',
)
assert.match(
  adapter,
  /knownIdentifiersConflict\(canonicalBarcodes, duplicateBarcodes\)/,
  'matching SKUs with conflicting current barcodes must fail closed',
)
assert.match(
  adapter,
  /exactIdentityGroups/,
  'safe exact Shopify and Faire identifiers must be considered independently of display name',
)
assert.match(
  adapter,
  /ambiguous_exact_identifier/,
  'an identifier shared by multiple products must remain blocked for explicit review',
)
assert.match(
  adapter,
  /input\.evidenceType === 'operator_confirmed'[\s\S]*normalizedDisplayName\(requestedCanonical\)/,
  'name equality must gate name-only reconciliation without blocking exact identifier evidence',
)
assert.match(
  adapter,
  /currentCandidateEvidence/,
  'the committed alias must retain current candidate revisions and hashes',
)
assert.match(
  adapter,
  /matchingIdentifiers: verifiedMatchingIdentifiers/,
  'the committed alias must retain the actual matching identifier value',
)
assert.match(
  adapter,
  /dropdownSync: 'deferred'/,
  'post-commit dropdown failures must return committed-with-warning state',
)
assert.match(
  adapter,
  /replayed: true/,
  'a retry must replay the durable alias result',
)
assert.doesNotMatch(
  adapter,
  /DELETE FROM sync_outbox/,
  'reconciliation must never erase outbox history',
)
assert.match(
  adapter,
  /status IN \('queued', 'failed'\)/,
  'only actionable outbox rows may be cancelled or retried',
)
assert.match(
  adapter,
  /historicalRowsRewritten: 0/,
  'reconciliation must preserve historical candidate and order evidence',
)
assert.doesNotMatch(
  adapter,
  /DELETE FROM crm_products/,
  'product identity reconciliation must never delete CRM products',
)
assert.match(
  adapter,
  /aggregate_id = \$1\s/,
  'SuiteCRM outbox cleanup must compare its text aggregate ID as text',
)
assert.doesNotMatch(
  adapter,
  /aggregate_id = \$1::uuid/,
  'SuiteCRM outbox cleanup must not compare text to uuid',
)
assert.doesNotMatch(
  adapter,
  /'crm_products', \$1::uuid, 'delete_record'/,
  'SuiteCRM outbox insertion must keep aggregate IDs as text',
)
assert.match(
  crmAdapter,
  /JOIN crm_product_identity_aliases product_identity/,
  'historical Product Global IDs must resolve to the canonical Product',
)
assert.match(
  crmAdapter,
  /product_identity\.canonical_product_id = product\.id[\s\S]*alias_product\.reference_code ILIKE/,
  'list search by a retired Product Global ID must return its canonical Product',
)
assert.match(
  route,
  /operationsCapabilities\(actor\)\.canManage/,
  'product identity changes require operations-management permission',
)
assert.match(
  route,
  /confirmBatch/,
  'bulk reconciliation requires an explicit batch confirmation',
)
assert.match(
  route,
  /'exact_gtin'/,
  'the HTTP contract must accept the database exact-GTIN evidence type',
)
assert.match(
  route,
  /expectedCanonicalMappingGlobalIds/,
  'the HTTP contract must require the reviewed mapping set',
)
assert.match(
  dialog,
  /same sellable product and the same pack level/,
  'name-only matches require an explicit pack-identity confirmation',
)
assert.match(
  dialog,
  /Pack level, quantity, and dimensions are unknown/,
  'name-only review must expose explicit unknown pack evidence',
)
assert.doesNotMatch(
  dialog,
  /I reviewed all .* exact-name suggestions/,
  'one checkbox must never confirm multiple unreviewed name-only pairs',
)
assert.match(
  adapter,
  /Name-only product identities must be reviewed and confirmed one pair at a time/,
  'the server must reject bulk name-only confirmation',
)
assert.match(
  dialog,
  /Retain as historical alias/,
  'the UI must explain what happens to the duplicate Global ID',
)
assert.match(
  crmUi,
  /Resolve duplicate sales-channel product identities/,
  'CRM products must expose the real reconciliation workflow',
)
assert.match(
  contract,
  /salesChannels/,
  'the owning Operations contract must define sales channels as fields',
)

const require = createRequire(import.meta.url)
const ts = require('../app_src/node_modules/typescript')
const compiled = ts.transpileModule(adapter, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
  },
}).outputText
const runtimeModule = { exports: {} }
const runtimeRequire = (specifier) => (
  specifier === 'node:crypto' ? require(specifier) : {}
)
new Function('require', 'module', 'exports', compiled)(
  runtimeRequire,
  runtimeModule,
  runtimeModule.exports,
)
const runtime = runtimeModule.exports

const identityRecord = (input) => ({
  id: input.id,
  globalId: `gp-${input.id}`,
  name: input.name,
  requestedName: input.name,
  sku: input.sku,
  sourceHash: `hash-${input.id}`,
  updatedAt: '2026-07-31T12:00:00.000Z',
  providers: [input.provider],
  mappingGlobalIds: [`gpm-${input.id}`],
  channelSkus: input.sku ? [input.sku] : [],
  barcodes: input.barcode ? [input.barcode] : [],
  packEvidence: { status: 'unknown', profiles: [] },
  operationalReferenceCount: 0,
})
const exactCrossProviderSuggestions =
  runtime.buildProductIdentitySuggestions({
    pipelineId: 'pipeline-1',
    records: [
      identityRecord({
        id: 'shopify',
        name: 'Shopify merchandising title',
        sku: 'AG-CASE-12',
        provider: 'shopify',
      }),
      identityRecord({
        id: 'faire',
        name: 'Faire wholesale title',
        sku: 'ag-case-12',
        provider: 'faire',
      }),
    ],
  })
assert.equal(
  exactCrossProviderSuggestions.length,
  1,
  'A unique cross-provider exact SKU must be exposed despite different names',
)
assert.equal(exactCrossProviderSuggestions[0].evidenceType, 'exact_sku')
assert.equal(exactCrossProviderSuggestions[0].canApply, true)
const ambiguousCrossProviderSuggestions =
  runtime.buildProductIdentitySuggestions({
    pipelineId: 'pipeline-1',
    records: [
      ...[
        ['shopify-a', 'Shopify A'],
        ['shopify-b', 'Shopify B'],
      ].map(([id, name]) => identityRecord({
        id,
        name,
        sku: 'AMBIGUOUS-SKU',
        provider: 'shopify',
      })),
      identityRecord({
        id: 'faire-ambiguous',
        name: 'Faire title',
        sku: 'AMBIGUOUS-SKU',
        provider: 'faire',
      }),
    ],
  })
assert.equal(
  ambiguousCrossProviderSuggestions.length,
  0,
  'An identifier owned by multiple provider products must never create an automatic merge suggestion',
)

assert.equal(
  runtime.archivedProductIdentityName({
    originalName: 'Apple Crisp 6 oz',
    duplicateGlobalId: 'gp1234567',
  }),
  'Apple Crisp 6 oz · Merged · gp1234567',
  'archived names must be deterministic and retain the duplicate Global ID',
)
assert.notEqual(
  runtime.archivedProductIdentityName({
    originalName: 'Apple Crisp 6 oz',
    duplicateGlobalId: 'gp1234567',
  }),
  runtime.archivedProductIdentityName({
    originalName: 'Apple Crisp 6 oz',
    duplicateGlobalId: 'gp7654321',
  }),
  'different duplicate identities must receive different archived names',
)

const committedWithWarning =
  await runtime.finalizeCommittedProductIdentityResult({
    result: { aliasGlobalId: 'gpid1234567' },
    refreshDropdown: true,
    syncDropdown: async () => {
      throw new Error('dropdown unavailable')
    },
  })
assert.equal(committedWithWarning.aliasGlobalId, 'gpid1234567')
assert.equal(committedWithWarning.dropdownSync, 'deferred')
assert.match(committedWithWarning.warning, /reconciliation committed/i)

const committedWithoutRefresh =
  await runtime.finalizeCommittedProductIdentityResult({
    result: { aliasGlobalId: 'gpid1234567' },
    refreshDropdown: false,
    syncDropdown: async () => {
      throw new Error('must not run')
    },
  })
assert.equal(committedWithoutRefresh.dropdownSync, 'not_requested')

console.log('Product identity reconciliation contracts passed.')
