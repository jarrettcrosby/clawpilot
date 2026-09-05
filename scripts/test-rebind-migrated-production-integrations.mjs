#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  closeSync,
  constants,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  WORKSPACES,
  canonicalJson,
  carrierAddressFingerprint,
  createProviderVerifier,
  databaseEndpointFingerprint,
  digest,
  managedSourceAuthorityApprovalToken,
  parseArguments,
  plannedHistoryPolicyEvidence,
  readBoundedSecretJsonFd,
  sha256,
  writePrivateJson,
} from './rebind-migrated-production-integrations.mjs'

const callback = 'https://aiapp.eigenracing.com/api/integrations/commerce/shopify/webhooks/gia1234567'
const shopDomain = 'fixture-shop.myshopify.com'
const shopId = 'gid://shopify/Shop/123456789'
const webhookState = []
let providerWrites = 0
let carrierRateReads = 0
let fedexRateReads = 0

async function readSecretPayloadThroughPipe(payload) {
  const directory = mkdtempSync(path.join(tmpdir(), 'clawpilot-managed-secret-pipe-'))
  const fifo = path.join(directory, 'input.fifo')
  execFileSync('mkfifo', [fifo])
  const reader = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK)
  const writer = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK)
  try {
    writeFileSync(writer, typeof payload === 'string' ? payload : JSON.stringify(payload))
    closeSync(writer)
    return readBoundedSecretJsonFd(reader)
  } finally {
    try { closeSync(writer) } catch {}
    try { closeSync(reader) } catch {}
    rmSync(directory, { recursive: true, force: true })
  }
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const fakeFetch = async (url, init = {}) => {
  if (url === `https://${shopDomain}/admin/oauth/access_token`) {
    assert.equal(init.method, 'POST')
    assert.match(String(init.body), /grant_type=client_credentials/u)
    return json({ access_token: 'fake-access-token-value' })
  }
  if (url === `https://${shopDomain}/admin/api/2026-07/graphql.json`) {
    const request = JSON.parse(init.body)
    if (request.operationName === 'ClawPilotMigrationIdentityProbe') {
      return json({ data: {
        shop: { id: shopId, myshopifyDomain: shopDomain, name: 'Fixture shop' },
        currentAppInstallation: {
          accessScopes: [
            { handle: 'read_inventory' }, { handle: 'read_locations' },
            { handle: 'read_orders' }, { handle: 'read_products' },
          ],
        },
      } })
    }
    if (request.operationName === 'ClawPilotMigrationOrderWebhookProbe') {
      return json({ data: { webhookSubscriptions: {
        nodes: webhookState.map((item) => ({ ...item })),
        pageInfo: { hasNextPage: false, endCursor: null },
      } } })
    }
    if (request.operationName === 'ClawPilotMigrationOrderWebhookCreate') {
      providerWrites += 1
      const topic = request.variables.topic
      const created = {
        id: `gid://shopify/WebhookSubscription/${providerWrites}`,
        topic,
        uri: request.variables.subscription.uri,
        format: 'JSON',
        includeFields: [...request.variables.subscription.includeFields],
      }
      webhookState.push(created)
      return json({ data: { webhookSubscriptionCreate: {
        webhookSubscription: created,
        userErrors: [],
      } } })
    }
  }
  if (url === 'https://fake.faire.test/brands/profile') {
    assert.equal(init.headers['X-FAIRE-ACCESS-TOKEN'], 'faire-fixture-access-token')
    return json({ id: 'brand-fixture', name: 'Fixture brand' })
  }
  if (url === 'https://fake.faire.test/orders?limit=1') {
    assert.equal(init.method, 'GET')
    return json({ orders: [] })
  }
  if (url === 'https://fake.ups.test/token') {
    assert.match(init.headers.Authorization, /^Basic /u)
    return json({ access_token: 'fake-ups-access-token', token_type: 'Bearer' })
  }
  if (url === 'https://fake.ups.test/rate') {
    carrierRateReads += 1
    assert.equal(init.method, 'POST')
    assert.equal(init.headers.Authorization, 'Bearer fake-ups-access-token')
    const body = JSON.parse(init.body)
    assert.equal(body.RateRequest.Shipment.Shipper.ShipperNumber, 'UPS-ACCOUNT-1234')
    assert.equal(body.RateRequest.Shipment.Shipper.Address.AddressLine[0], '101 Jegs Place')
    return json({ RateResponse: { RatedShipment: [{ Service: { Code: '03' } }] } })
  }
  if (url === 'https://fake.fedex.test/token') {
    assert.equal(init.method, 'POST')
    assert.match(String(init.body), /client_id=fixture-fedex-client-9088/u)
    return json({ access_token: 'fake-fedex-access-token', token_type: 'Bearer' })
  }
  if (url === 'https://fake.fedex.test/rate') {
    fedexRateReads += 1
    assert.equal(init.method, 'POST')
    assert.equal(init.headers.Authorization, 'Bearer fake-fedex-access-token')
    const body = JSON.parse(init.body)
    assert.equal(body.accountNumber.value, 'FEDEX-ACCOUNT-1073')
    assert.equal(body.requestedShipment.shipper.address.streetLines[0], '101 Jegs Place')
    return json({ output: { rateReplyDetails: [{ serviceType: 'FEDEX_GROUND' }] } })
  }
  throw new Error('Unexpected fake-provider request')
}

const verifier = createProviderVerifier({
  fetchImpl: fakeFetch,
  allowTestProviderEndpoints: true,
  providerEndpoints: {
    faire: 'https://fake.faire.test',
    ups_rest: {
      sandbox: { token: 'https://fake.ups.test/token', rate: 'https://fake.ups.test/rate' },
      production: { token: 'https://fake.ups.test/token', rate: 'https://fake.ups.test/rate' },
    },
    fedex_rest: {
      sandbox: { token: 'https://fake.fedex.test/token', rate: 'https://fake.fedex.test/rate' },
      production: { token: 'https://fake.fedex.test/token', rate: 'https://fake.fedex.test/rate' },
    },
  },
})

const shopifyAccount = { provider: 'shopify', environment: 'production' }
const shopify = await verifier.commerce(shopifyAccount, {
  provider: 'shopify',
  authMode: 'shopify_client_credentials',
  clientId: 'fixture-client-id',
  clientSecret: 'fixture-client-secret-value',
}, { shopDomain }, 'gia1234567')
assert.equal(shopify.externalAccountId, shopId)
assert.equal(shopify.identitySha256, sha256(shopId))
assert.equal(shopify.desiredUri, callback)
assert.equal(shopify.webhooks.actions.length, 7)
assert.equal(providerWrites, 0, 'plan probes must be read-only')

const reconciled = await verifier.reconcileShopify(shopify, shopify.webhooks.actions)
assert.equal(reconciled.ready, true)
assert.equal(providerWrites, 7)
assert.equal(webhookState.length, 7)
await assert.rejects(
  verifier.reconcileShopify(shopify, shopify.webhooks.actions),
  /webhook state changed after the reviewed rebind plan/u,
  'a plan cannot silently reuse stale pre-crash provider state',
)
const replannedShopify = await verifier.commerce(shopifyAccount, {
  provider: 'shopify',
  authMode: 'shopify_client_credentials',
  clientId: 'fixture-client-id',
  clientSecret: 'fixture-client-secret-value',
}, { shopDomain }, 'gia1234567')
assert.deepEqual(replannedShopify.webhooks.actions, [])
const resumed = await verifier.reconcileShopify(replannedShopify, [])
assert.equal(resumed.ready, true)
assert.equal(providerWrites, 7, 'provider reconciliation recovery must be idempotent')

const faire = await verifier.commerce({ provider: 'faire', environment: 'production' }, {
  provider: 'faire', authMode: 'faire_brand_token', accessToken: 'faire-fixture-access-token',
}, {}, 'gia7654321')
assert.equal(faire.externalAccountId, 'brand-fixture')
assert.equal(faire.operationalProbe, 'orders_read_only')

const carrier = await verifier.carrier({ provider: 'ups_rest', environment: 'sandbox' }, {
  clientId: 'fixture-ups-client-1234', clientSecret: 'fixture-ups-secret-value',
}, 'UPS-ACCOUNT-1234', {
  line1: '101 Jegs Place', city: 'Delaware', region: 'OH', postalCode: '43015', countryCode: 'US',
})
assert.equal(carrier.clientIdLastFour, '1234')
assert.equal(carrier.accountNumberLastFour, '1234')
assert.equal(carrier.operationalProbe, 'rate_read_only')
assert.equal(carrier.providerMutationCount, 0)
assert.equal(carrierRateReads, 1)
await assert.rejects(
  verifier.carrier({ provider: 'ups_rest', environment: 'sandbox' }, {
    clientId: 'fixture-ups-client-1234', clientSecret: 'fixture-ups-secrét-value',
  }, 'UPS-ACCOUNT-1234', {
    line1: '101 Jegs Place', city: 'Delaware', region: 'OH', postalCode: '43015', countryCode: 'US',
  }),
  /Carrier client secret is invalid/u,
)
await assert.rejects(
  verifier.carrier({ provider: 'ups_rest', environment: 'sandbox' }, {
    clientId: 'fixture-ups-client-1234', clientSecret: 'fixture-ups-secret-value',
  }, 'UPS-ACCOUNT-1234', {
    line1: 'x'.repeat(161), city: 'Delaware', region: 'OH', postalCode: '43015', countryCode: 'US',
  }),
  /registered address is invalid/u,
)

const fedex = await verifier.carrier({ provider: 'fedex_rest', environment: 'sandbox' }, {
  clientId: 'fixture-fedex-client-9088', clientSecret: 'fixture-fedex-secret-value',
}, 'FEDEX-ACCOUNT-1073', {
  line1: '101 Jegs Place', city: 'Delaware', region: 'OH', postalCode: '43015', countryCode: 'US',
})
assert.equal(fedex.clientIdLastFour, '9088')
assert.equal(fedex.accountNumberLastFour, '1073')
assert.equal(fedex.operationalProbe, 'rate_read_only')
assert.equal(fedex.providerMutationCount, 0)
assert.equal(fedexRateReads, 1)

assert.equal(
  databaseEndpointFingerprint('postgresql://operator:secret@db.example.test:5432/clawpilot'),
  databaseEndpointFingerprint('postgresql://operator:different@db.example.test:5432/clawpilot'),
  'endpoint binding must exclude passwords',
)
assert.notEqual(
  databaseEndpointFingerprint('postgresql://operator:secret@db.example.test:5432/clawpilot'),
  databaseEndpointFingerprint('postgresql://operator:secret@db.example.test:5432/other'),
)
assert.equal(carrierAddressFingerprint({
  line1: ' 101 Jegs Place ', city: 'Delaware', region: 'OH', postalCode: '43015-1234', countryCode: 'us',
}), carrierAddressFingerprint({
  line1: '101 Jegs Place', city: 'delaware', region: 'oh', postalCode: '430151234', countryCode: 'US',
}))
assert.equal(carrierAddressFingerprint({
  line1: '101 Jegs Place', line2: null, city: 'Delaware', region: 'OH',
  postalCode: '43015', countryCode: 'US',
}), sha256(JSON.stringify({
  line1: '101 jegs place', line2: null, city: 'delaware', region: 'oh',
  postalCode: '43015', countryCode: 'US',
})), 'carrier address fingerprints must match the application JSON field-order contract')
assert.equal(WORKSPACES.length, 3)
assert.equal(WORKSPACES.flatMap((workspace) => workspace.accounts).length, 8)
assert.equal(new Set(WORKSPACES.map((workspace) => workspace.targetOrganizationId)).size, 3)
assert.equal(canonicalJson({ b: 1, a: [2] }), '{"a":[2],"b":1}')
assert.match(digest({ fixed: true }), /^[a-f0-9]{64}$/u)
const parsedHistoryPlan = parseArguments([
  'plan',
  '--actor', 'operator@example.com',
  '--manifest', '/secure/manifest.json',
  '--mapping', '/secure/mapping.json',
  '--source-account-global-id', 'gia1234567',
  '--history-mode', 'last_30_days',
  '--output', '/secure/plan.json',
])
assert.equal(parsedHistoryPlan.historyMode, 'last_30_days')
assert.throws(
  () => parseArguments([
    'apply',
    '--actor', 'operator@example.com',
    '--manifest', '/secure/manifest.json',
    '--mapping', '/secure/mapping.json',
    '--source-account-global-id', 'gia1234567',
    '--history-mode', 'last_30_days',
    '--plan', '/secure/plan.json',
    '--confirm-digest', 'a'.repeat(64),
    '--receipt-output', '/secure/receipt.json',
  ]),
  /accepted only when planning/u,
)
assert.throws(
  () => parseArguments([
    'plan',
    '--actor', 'operator@example.com',
    '--manifest', '/secure/manifest.json',
    '--mapping', '/secure/mapping.json',
    '--source-account-global-id', 'gia1234567',
    '--managed-rebind-material', '/tmp/plaintext.json',
    '--output', '/secure/plan.json',
  ]),
  /Unsupported option/u,
)
for (const rawSecretFlag of ['--client-id', '--client-secret', '--account-number']) {
  assert.throws(
    () => parseArguments([
      'plan',
      '--actor', 'operator@example.com',
      '--manifest', '/secure/manifest.json',
      '--mapping', '/secure/mapping.json',
      '--source-account-global-id', 'gia1234567',
      rawSecretFlag, 'must-never-be-an-argument',
      '--output', '/secure/plan.json',
    ]),
    /Unsupported option/u,
  )
}
const parsedManagedPlan = parseArguments([
  'plan',
  '--actor', 'operator@example.com',
  '--manifest', '/secure/manifest.json',
  '--mapping', '/secure/mapping.json',
  '--source-account-global-id', 'gia3106288',
  '--managed-rebind-secrets-fd', '3',
  '--confirm-managed-source-authority',
  'approve:gia3106288:ga5122758:gia7335302:gac2368052:*1073',
  '--output', '/secure/plan.json',
])
assert.equal(parsedManagedPlan.managedRebindSecretsFd, 3)
assert.throws(
  () => parseArguments([
    'export-receipt',
    '--actor', 'operator@example.com',
    '--manifest', '/secure/manifest.json',
    '--mapping', '/secure/mapping.json',
    '--source-account-global-id', 'gia3106288',
    '--managed-rebind-secrets-fd', '3',
    '--plan', '/secure/plan.json',
    '--confirm-digest', 'a'.repeat(64),
    '--receipt-output', '/secure/receipt.json',
  ]),
  /not accepted when exporting/u,
)
assert.deepEqual(plannedHistoryPolicyEvidence({
  account: {
    sourceGlobalId: 'gia1234567',
    provider: 'shopify',
    integrationType: 'commerce',
  },
  actor: 'operator@example.com',
  historyMode: 'last_30_days',
  frozenAt: '2026-09-05T12:00:00.000Z',
}), {
  provider: 'shopify',
  historyMode: 'last_30_days',
  ingestionFloor: '2026-08-06T12:00:00.000Z',
  frozenAt: '2026-09-05T12:00:00.000Z',
  configuredBy: 'operator@example.com',
})
const managedAccounts = WORKSPACES
  .flatMap((workspace) => workspace.accounts)
  .filter((account) => account.rebindMode === 'source_authority')
assert.deepEqual(managedAccounts.map(managedSourceAuthorityApprovalToken), [
  'approve:gia3106288:ga5122758:gia7335302:gac2368052:*1073',
  'approve:gia5910262:ga5122758:gia2057284:gac5139730:*3574',
])
const pipeSecrets = await readSecretPayloadThroughPipe({
  clientId: 'pipe-client-1234',
  clientSecret: 'pipe-client-secret-canary',
  accountNumber: 'PIPE-ACCOUNT-1073',
})
assert.deepEqual(pipeSecrets, {
  clientId: 'pipe-client-1234',
  clientSecret: 'pipe-client-secret-canary',
  accountNumber: 'PIPE-ACCOUNT-1073',
})
await assert.rejects(
  readSecretPayloadThroughPipe({
    clientId: 'pipe-client-1234',
    clientSecret: 'pipe-client-secret-canary',
    accountNumber: 'PIPE-ACCOUNT-1073',
    unsupported: true,
  }),
  /missing or unsupported fields/u,
)
await assert.rejects(
  readSecretPayloadThroughPipe('not-json'),
  /not valid JSON/u,
)
assert.throws(
  () => readBoundedSecretJsonFd(2),
  /file descriptor is invalid/u,
)

const source = readFileSync(new URL('./rebind-migrated-production-integrations.mjs', import.meta.url), 'utf8')
for (const forbiddenSql of [
  'FROM operations_commerce_webhook_receipts',
  'FROM operations_commerce_provider_attempts',
  'FROM sync_outbox',
  'FROM operations_commerce_sync_cursors',
]) {
  assert.equal(source.includes(forbiddenSql), false, `must not read/copy forbidden source state: ${forbiddenSql}`)
}
assert.match(source, /BEGIN ISOLATION LEVEL SERIALIZABLE/u)
assert.match(source, /SOURCE_INTEGRATION_CREDENTIAL_ENCRYPTION_KEY/u)
assert.match(source, /TARGET_INTEGRATION_CREDENTIAL_ENCRYPTION_KEY/u)
assert.match(source, /operations_carrier_account_migration_placeholders/u)
assert.match(source, /operations_commerce_migration_provider_identity_fences/u)
assert.match(source, /providerCount: 1/u)
assert.match(source, /Exactly one selected provider must be validated per rebind plan/u)
assert.equal(source.includes('--managed-rebind-material'), false)
assert.match(source, /--managed-rebind-secrets-fd/u)
assert.match(source, /readBoundedSecretJsonFd/u)
assert.match(source, /target order-history policy must be absent before rebind/u)
assert.match(source, /reviewed order-history policy was not inserted atomically/u)
assert.match(source, /commerce_order_history_policy_guard/u)
const historyPolicyInsert = source.slice(
  source.indexOf('async function insertReviewedHistoryPolicy'),
  source.indexOf('export async function applyValidatedMaterials'),
)
assert.ok(historyPolicyInsert.length > 0)
assert.match(historyPolicyInsert, /INSERT INTO operations_commerce_order_history_policies/u)
assert.equal(historyPolicyInsert.includes('ON CONFLICT DO NOTHING'), false)
const authorityLoader = source.slice(
  source.indexOf('async function loadTargetAuthority'),
  source.indexOf('async function loadTargetPlaceholder'),
)
assert.ok(authorityLoader.length > 0)
assert.equal(/credential_ciphertext|account_number_ciphertext/u.test(authorityLoader), false)
assert.match(authorityLoader, /account_number_fingerprint/u)

const evidenceDirectory = mkdtempSync(path.join(tmpdir(), 'clawpilot-rebind-evidence-'))
try {
  const evidencePath = path.join(evidenceDirectory, 'receipt.json')
  writePrivateJson(evidencePath, { status: 'verified', count: 3 })
  assert.equal(statSync(evidencePath).mode & 0o077, 0)
  assert.deepEqual(JSON.parse(readFileSync(evidencePath, 'utf8')), {
    status: 'verified', count: 3,
  })
  assert.throws(
    () => readBoundedSecretJsonFd(openSync(evidencePath, 'r')),
    /must come from an anonymous or named pipe/u,
  )
  assert.throws(
    () => writePrivateJson(evidencePath, { status: 'must-not-overwrite' }),
    /Refusing to overwrite/u,
  )
  assert.deepEqual(readdirSync(evidenceDirectory), ['receipt.json'])
  assert.equal(existsSync(evidencePath), true)
} finally {
  rmSync(evidenceDirectory, { recursive: true, force: true })
}

console.log('Migrated provider rebind fake-provider/static tests passed')
