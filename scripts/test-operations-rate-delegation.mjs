#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const nodeRequire = createRequire(import.meta.url)
const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = requireFromApp('typescript')

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function compactSql(source) {
  return source
    .replace(/--.*$/gm, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .trim()
}

function loadDomain() {
  const path = 'app_src/lib/operations/domain.ts'
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
    BigInt,
    Date,
    Error,
    Map,
    Set,
    console,
    exports: module.exports,
    module,
    require: nodeRequire,
  }, { filename: path })
  return module.exports
}

const {
  assignCarrierBillingShipper,
  groupCarrierBillingStatements,
  priceCarrierRatePath,
  reconcileCarrierBilling,
  selectCarrierBillingRelationship,
} = loadDomain()

const triangle = {
  entityType: 'workspace_organization',
  entityId: 'org-owner',
  globalId: 'ga1000001',
  displayName: 'Platform operator',
  role: 'platform_operator',
}
const square = {
  entityType: 'workspace_organization',
  entityId: 'org-reseller',
  globalId: 'ga1000002',
  displayName: 'Reseller',
  role: 'reseller',
}
const circle = {
  entityType: 'crm_customer',
  entityId: 'crm-shipper',
  globalId: 'ga1000003',
  displayName: 'Shipping customer',
  role: 'shipper',
}

const result = priceCarrierRatePath({
  currency: 'usd',
  carrierAccountGlobalId: 'gci1000001',
  carrierAccountOwnerGlobalId: square.globalId,
  carrierPayeeReference: 'carrier:ups:reseller-account',
  carrierCostMinor: 1_000n,
  parties: [triangle, square, circle],
  grants: [
    {
      grantGlobalId: 'grg1000001',
      grantorGlobalId: triangle.globalId,
      granteeGlobalId: square.globalId,
      directives: [
        {
          globalId: 'gmd1000002',
          priority: 20,
          type: 'fixed_amount',
          amountMinor: 100n,
        },
        {
          globalId: 'gmd1000001',
          priority: 10,
          type: 'percent_markup',
          basisPoints: 1_000,
        },
      ],
    },
    {
      grantGlobalId: 'grg1000002',
      grantorGlobalId: square.globalId,
      granteeGlobalId: circle.globalId,
      directives: [{
        globalId: 'gmd1000003',
        priority: 10,
        type: 'cost_plus_percent',
        basisPoints: 2_000,
      }],
    },
  ],
})

assert.equal(result.currency, 'USD')
assert.equal(result.carrierCostMinor, 1_000n)
assert.equal(result.hops[0].upstreamBuyMinor, 1_000n)
assert.equal(result.hops[0].markupMinor, 200n)
assert.equal(result.hops[0].downstreamSellMinor, 1_200n)
assert.deepEqual(
  Array.from(result.hops[0].directiveGlobalIds),
  ['gmd1000001', 'gmd1000002'],
)
assert.equal(result.hops[1].upstreamBuyMinor, 1_200n)
assert.equal(result.hops[1].markupMinor, 240n)
assert.equal(result.customerChargeMinor, 1_440n)
assert.equal(result.carrierAccountOwnerGlobalId, square.globalId)
assert.equal(result.settlements.length, 4)
assert.equal(result.settlements[0].amountMinor, 1_000n)
assert.equal(result.settlements[0].payerGlobalId, square.globalId)
assert.equal(result.settlements[1].type, 'carrier_cost_reimbursement')
assert.equal(result.settlements[1].payerGlobalId, circle.globalId)
assert.equal(result.settlements[1].payeeGlobalId, square.globalId)
assert.equal(result.settlements[1].amountMinor, 1_000n)
assert.equal(result.settlements[2].type, 'platform_fee')
assert.equal(result.settlements[2].payerGlobalId, circle.globalId)
assert.equal(result.settlements[2].payeeGlobalId, triangle.globalId)
assert.equal(result.settlements[2].amountMinor, 200n)
assert.equal(result.settlements[3].type, 'reseller_fee')
assert.equal(result.settlements[3].payerGlobalId, circle.globalId)
assert.equal(result.settlements[3].payeeGlobalId, square.globalId)
assert.equal(result.settlements[3].amountMinor, 240n)
assert.equal(result.margins[0].partyGlobalId, triangle.globalId)
assert.equal(result.margins[0].marginMinor, 200n)
assert.equal(result.margins[1].partyGlobalId, square.globalId)
assert.equal(result.margins[1].marginMinor, 240n)

const carrierAccount = {
  carrierAccountGlobalId: 'gac1000001',
  accountOwnerGlobalId: square.globalId,
  accountAddressVerification: 'operator_attested',
  accountAddress: {
    name: 'Test Warehouse',
    line1: '101 JEGS Place',
    line2: null,
    city: 'Delaware',
    region: 'OH',
    postalCode: '43015',
    country: 'US',
  },
}
const jegsAddress = {
  name: 'John Doe',
  line1: '101 Jegs Place',
  city: 'Delaware',
  region: 'Ohio',
  postalCode: '43015',
  country: 'US',
}
const maritimeAddress = {
  name: 'John Doe',
  line1: '101 Academy Drive',
  city: 'Buzzards Bay',
  region: 'MA',
  postalCode: '02532',
  country: 'US',
}

assert.equal(
  selectCarrierBillingRelationship({
    carrierAccount,
    sender: jegsAddress,
    recipient: maritimeAddress,
  }).relationship,
  'sender',
)
assert.equal(
  selectCarrierBillingRelationship({
    carrierAccount: { ...carrierAccount, accountAddress: maritimeAddress },
    sender: jegsAddress,
    recipient: maritimeAddress,
  }).relationship,
  'recipient',
)
assert.equal(
  selectCarrierBillingRelationship({
    carrierAccount: {
      ...carrierAccount,
      accountAddress: { ...carrierAccount.accountAddress, line1: '500 Other Street' },
    },
    sender: jegsAddress,
    recipient: maritimeAddress,
  }).relationship,
  'third_party',
)
assert.equal(
  selectCarrierBillingRelationship({
    carrierAccount,
    sender: jegsAddress,
    recipient: jegsAddress,
  }).relationship,
  'sender',
)

const groupedStatements = groupCarrierBillingStatements([
  {
    externalChargeId: 'charge-a-2',
    externalStatementId: 'statement-a',
    billedAccountMaskedReference: '******1111',
    billedAccountFingerprint: 'a'.repeat(64),
  },
  {
    externalChargeId: 'charge-b-1',
    externalStatementId: 'statement-b',
    billedAccountMaskedReference: '******2222',
    billedAccountFingerprint: 'b'.repeat(64),
  },
  {
    externalChargeId: 'charge-a-1',
    externalStatementId: 'statement-a',
    billedAccountMaskedReference: '******1111',
    billedAccountFingerprint: 'a'.repeat(64),
  },
])
assert.equal(groupedStatements.length, 2)
assert.deepEqual(Array.from(groupedStatements[0].externalChargeIds), ['charge-a-1', 'charge-a-2'])
assert.deepEqual(Array.from(groupedStatements[1].externalChargeIds), ['charge-b-1'])

const manualAssignment = assignCarrierBillingShipper({
  shipmentMatchStatus: 'unmatched',
  shipmentGlobalId: null,
  manualShipperGlobalId: circle.globalId,
  actorEmail: 'operator@example.com',
  reason: 'Confirmed sender address belongs to this shipper.',
})
assert.equal(manualAssignment.shipmentMatchStatus, 'unmatched')
assert.equal(manualAssignment.shipmentGlobalId, null)
assert.equal(manualAssignment.assignedShipperGlobalId, circle.globalId)
assert.equal(manualAssignment.source, 'manual')

const routingAssignment = assignCarrierBillingShipper({
  shipmentMatchStatus: 'unmatched',
  shipmentGlobalId: null,
  routingRuleShipperGlobalId: circle.globalId,
  routingRuleGlobalId: 'gbr1000001',
})
assert.equal(routingAssignment.source, 'routing_rule')
assert.equal(routingAssignment.ruleGlobalId, 'gbr1000001')

assert.throws(
  () => priceCarrierRatePath({
    currency: 'USD',
    carrierAccountGlobalId: 'gci1000001',
    carrierAccountOwnerGlobalId: triangle.globalId,
    carrierPayeeReference: 'carrier:ups:platform-account',
    carrierCostMinor: 1_000n,
    parties: [triangle, { ...triangle, role: 'shipper' }],
    grants: [{
      grantGlobalId: 'grg-cycle',
      grantorGlobalId: triangle.globalId,
      granteeGlobalId: triangle.globalId,
      directives: [],
    }],
  }),
  /OPERATIONS_RATE_PATH_CYCLE/,
)

assert.throws(
  () => priceCarrierRatePath({
    currency: 'USD',
    carrierAccountGlobalId: 'gci1000001',
    carrierAccountOwnerGlobalId: triangle.globalId,
    carrierPayeeReference: 'carrier:ups:platform-account',
    carrierCostMinor: 1_000n,
    parties: [triangle, { ...square, role: 'shipper' }],
    grants: [{
      grantGlobalId: 'grg-negative-margin',
      grantorGlobalId: triangle.globalId,
      granteeGlobalId: square.globalId,
      directives: [{
        globalId: 'gmd-cap',
        priority: 10,
        type: 'maximum_charge',
        amountMinor: 900n,
      }],
    }],
  }),
  /OPERATIONS_RATE_PATH_NEGATIVE_MARGIN/,
)

const reconciliation = reconcileCarrierBilling({
  shipmentGlobalId: 'gsh1000001',
  currency: 'USD',
  quotedCarrierCostMinor: 1_000n,
  statementFinalized: true,
  chargeLines: [
    {
      externalChargeId: 'invoice-1-line-1',
      statementGlobalId: 'gcb1000001',
      billedAccountFingerprint: 'a'.repeat(64),
      trackingNumber: '1ZTEST',
      shipmentGlobalId: 'gsh1000001',
      shipmentMatchStatus: 'matched',
      assignedShipperGlobalId: circle.globalId,
      shipperAssignmentStatus: 'assigned',
      shipperAssignmentSource: 'shipment_match',
      category: 'transportation',
      amountMinor: 950n,
      currency: 'USD',
    },
    {
      externalChargeId: 'invoice-1-line-2',
      statementGlobalId: 'gcb1000001',
      billedAccountFingerprint: 'a'.repeat(64),
      trackingNumber: '1ZTEST',
      shipmentGlobalId: 'gsh1000001',
      shipmentMatchStatus: 'matched',
      assignedShipperGlobalId: circle.globalId,
      shipperAssignmentStatus: 'assigned',
      shipperAssignmentSource: 'shipment_match',
      category: 'fuel_surcharge',
      amountMinor: 100n,
      currency: 'USD',
    },
    {
      externalChargeId: 'invoice-1-line-3',
      statementGlobalId: 'gcb1000001',
      billedAccountFingerprint: 'a'.repeat(64),
      trackingNumber: '1ZTEST',
      shipmentGlobalId: 'gsh1000001',
      shipmentMatchStatus: 'matched',
      assignedShipperGlobalId: circle.globalId,
      shipperAssignmentStatus: 'assigned',
      shipperAssignmentSource: 'shipment_match',
      category: 'address_correction',
      amountMinor: 50n,
      currency: 'USD',
    },
    {
      externalChargeId: 'invoice-1-line-4',
      statementGlobalId: 'gcb1000001',
      billedAccountFingerprint: 'a'.repeat(64),
      trackingNumber: '1ZTEST',
      shipmentGlobalId: 'gsh1000001',
      shipmentMatchStatus: 'matched',
      assignedShipperGlobalId: circle.globalId,
      shipperAssignmentStatus: 'assigned',
      shipperAssignmentSource: 'shipment_match',
      category: 'refund',
      amountMinor: -25n,
      currency: 'USD',
    },
  ],
})
assert.equal(reconciliation.status, 'reconciled')
assert.equal(reconciliation.actualCarrierCostMinor, 1_075n)
assert.equal(reconciliation.varianceMinor, 75n)
assert.equal(reconciliation.matchedChargeCount, 4)
assert.equal(reconciliation.chargeTotals.length, 4)

const needsReview = reconcileCarrierBilling({
  shipmentGlobalId: 'gsh1000001',
  currency: 'USD',
  quotedCarrierCostMinor: 1_000n,
  statementFinalized: false,
  chargeLines: [{
    externalChargeId: 'invoice-2-line-1',
    statementGlobalId: 'gcb1000002',
    billedAccountFingerprint: 'b'.repeat(64),
    trackingNumber: '1ZTEST',
    shipmentGlobalId: 'gsh1000001',
    shipmentMatchStatus: 'matched',
    assignedShipperGlobalId: null,
    shipperAssignmentStatus: 'ambiguous',
    shipperAssignmentSource: 'none',
    category: 'other',
    amountMinor: 50n,
    currency: 'USD',
  }],
})
assert.equal(needsReview.status, 'needs_review')
assert.equal(needsReview.actualCarrierCostMinor, 50n)
assert.equal(needsReview.assignmentExceptionCount, 1)

assert.throws(
  () => reconcileCarrierBilling({
    shipmentGlobalId: 'gsh1000001',
    currency: 'USD',
    quotedCarrierCostMinor: 1_000n,
    statementFinalized: false,
    chargeLines: [
      {
        externalChargeId: 'duplicate-line',
        statementGlobalId: 'gcb1000003',
        billedAccountFingerprint: 'c'.repeat(64),
        trackingNumber: '1ZTEST',
        shipmentGlobalId: 'gsh1000001',
        shipmentMatchStatus: 'matched',
        assignedShipperGlobalId: circle.globalId,
        shipperAssignmentStatus: 'assigned',
        shipperAssignmentSource: 'shipment_match',
        category: 'transportation',
        amountMinor: 1_000n,
        currency: 'USD',
      },
      {
        externalChargeId: 'duplicate-line',
        statementGlobalId: 'gcb1000003',
        billedAccountFingerprint: 'c'.repeat(64),
        trackingNumber: '1ZTEST',
        shipmentGlobalId: 'gsh1000001',
        shipmentMatchStatus: 'matched',
        assignedShipperGlobalId: circle.globalId,
        shipperAssignmentStatus: 'assigned',
        shipperAssignmentSource: 'shipment_match',
        category: 'fuel_surcharge',
        amountMinor: 100n,
        currency: 'USD',
      },
    ],
  }),
  /OPERATIONS_CARRIER_CHARGE_DUPLICATE/,
)

const migration = compactSql(
  read('db/migrations/0090_operations_carrier_accounts_and_gl_coding.sql'),
)

for (const fragment of [
  'DROP CONSTRAINT IF EXISTS operations_carrier_account_authorizations_version_unique',
  'ON operations_carrier_account_authorizations (network_id, carrier_account_id, version_number)',
  'UNIQUE (network_id, id, account_owner_organization_id, integration_account_id, carrier_account_id)',
  'FOREIGN KEY (network_id, carrier_account_id, supersedes_authorization_id)',
  'UNIQUE (network_id, account_authorization_id, id)',
  'ON operations_carrier_rate_grants (network_id, account_authorization_id, grantor_party_id, grantee_party_id, version_number)',
  'FOREIGN KEY (network_id, account_authorization_id, supersedes_grant_id)',
  'FOREIGN KEY (network_id, account_authorization_id, account_owner_organization_id, integration_account_id, carrier_account_id)',
  'ADD COLUMN IF NOT EXISTS network_id uuid, ADD COLUMN IF NOT EXISTS account_authorization_id uuid',
  'CHECK (network_id IS NOT NULL AND account_authorization_id IS NOT NULL) NOT VALID',
  'FOREIGN KEY (network_id, account_authorization_id, organization_id, integration_account_id, carrier_account_id)',
  'FOREIGN KEY (network_id, account_authorization_id, account_owner_organization_id, integration_account_id, carrier_account_id, carrier_rate_request_id)',
  'FOREIGN KEY (network_id, executing_organization_id, account_authorization_id, carrier_account_id, quote_snapshot_id)',
  'FOREIGN KEY (network_id, executing_organization_id, account_authorization_id, carrier_account_id, reverses_entry_id)',
  'FOREIGN KEY (network_id, executing_organization_id, account_authorization_id, carrier_account_id, shipment_id, supersedes_reconciliation_id)',
  'CHECK (account_authorization_id IS NOT NULL AND carrier_account_id IS NOT NULL) NOT VALID',
]) {
  assert.ok(
    migration.includes(fragment),
    `Missing hardened rate delegation SQL contract: ${fragment}`,
  )
}

assert.ok(
  !migration.includes('UNIQUE (network_id, integration_account_id, version_number)'),
  'Authorization version uniqueness must not remain provider-connection scoped',
)

for (const fragment of [
  'protect_operations_carrier_account_identity',
  "IF TG_OP = 'DELETE' THEN",
  'RETURN OLD',
  'Carrier account ownership and record identity are immutable',
  'BEFORE UPDATE OR DELETE ON operations_carrier_accounts',
]) {
  assert.ok(
    migration.includes(fragment),
    `Missing immutable carrier account SQL contract: ${fragment}`,
  )
}

for (const fragment of [
  "party.entity_type = 'workspace_organization'",
  'party.workspace_organization_id = shipment.organization_id',
  "party.entity_type = 'crm_customer'",
  'party.crm_pipeline_id = shipment_order.pipeline_id',
  'party.crm_customer_id = shipment_order.customer_id',
  'party.network_id = NEW.network_id',
  "party.role = 'shipper'",
  'shipment_in_rate_network IS DISTINCT FROM true',
]) {
  assert.ok(
    migration.includes(fragment),
    `Missing shipment network-scope SQL contract: ${fragment}`,
  )
}

for (const fragment of [
  "IF NEW.assignment_source = 'manual'",
  "current_assignment_decision NOT IN ('unassigned', 'ambiguous')",
  'NEW.supersedes_assignment_id IS DISTINCT FROM current_assignment_id',
  'FOR UPDATE',
  'Manual shipper assignment may only replace the current unresolved decision',
]) {
  assert.ok(
    migration.includes(fragment),
    `Missing manual assignment SQL contract: ${fragment}`,
  )
}

console.log('Operations rate delegation contract tests passed.')
