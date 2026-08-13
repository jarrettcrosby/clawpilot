#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

import * as globalIds from '../app_src/lib/globalIds.mjs'
import * as commerceOrderRevisionEvidenceKeyConfig from '../app_src/lib/integrations/commerceOrderRevisionEvidenceKeyConfig.mjs'

const root = process.cwd()
const nodeRequire = createRequire(import.meta.url)
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')
const path = 'app_src/lib/integrations/commerceCredentialCrypto.ts'
const output = ts.transpileModule(readFileSync(resolve(root, path), 'utf8'), {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
  },
  fileName: path,
}).outputText
const module = { exports: {} }
const processMock = {
  ...process,
  env: {
    ...process.env,
    INTEGRATION_CREDENTIAL_ENCRYPTION_KEY:
      'test-only-carrier-service-callback-secret-2026',
  },
}
const sandbox = {
  Buffer,
  Date,
  Error,
  JSON,
  Math,
  Number,
  Object,
  Set,
  String,
  Uint8Array,
  module,
  exports: module.exports,
  process: processMock,
  require(specifier) {
    if (specifier === '@/lib/globalIds.mjs') {
      return globalIds
    }
    if (specifier === '@/lib/persistence/config') {
      return { isHostedRuntime: () => false }
    }
    if (specifier === '@/lib/integrations/commerceOrderRevisionEvidenceKeyConfig.mjs') {
      return commerceOrderRevisionEvidenceKeyConfig
    }
    return nodeRequire(specifier)
  },
}
vm.runInNewContext(output, sandbox, { filename: path })
const {
  shopifyCarrierServiceCallbackToken,
  shopifyCarrierServiceCallbackTokenMatches,
  shopifyCheckoutDestinationFingerprint,
} = module.exports

const identity = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  accountGlobalId: 'gia0000001',
  credentialGeneration: 3,
  callbackTokenVersion: 1,
}
const token = shopifyCarrierServiceCallbackToken(identity)
assert.match(token, /^[A-Za-z0-9_-]{43}$/)
assert.equal(shopifyCarrierServiceCallbackToken(identity), token)
assert.equal(shopifyCarrierServiceCallbackTokenMatches(identity, token), true)
assert.equal(
  shopifyCarrierServiceCallbackTokenMatches(identity, `${token.slice(0, -1)}A`),
  false,
)
assert.equal(
  shopifyCarrierServiceCallbackTokenMatches(
    { ...identity, credentialGeneration: 4 },
    token,
  ),
  false,
)
assert.equal(
  shopifyCarrierServiceCallbackTokenMatches(
    { ...identity, callbackTokenVersion: 2 },
    token,
  ),
  false,
)
assert.notEqual(
  shopifyCarrierServiceCallbackToken({
    ...identity,
    accountGlobalId: 'gia0000002',
  }),
  token,
)
assert.equal(token.includes('11111111'), false)
assert.equal(token.includes('gia0000001'), false)

const partialDestinationFingerprint = shopifyCheckoutDestinationFingerprint({
  countryCode: 'us',
  postalCode: ' 06103 ',
  provinceCode: null,
  city: null,
  address1: null,
  address2: null,
})
assert.match(partialDestinationFingerprint, /^[a-f0-9]{64}$/)
assert.equal(
  shopifyCheckoutDestinationFingerprint({
    countryCode: 'US',
    postalCode: '06103',
    provinceCode: 'CA',
    city: 'Hartford',
    address1: '1 Test Street',
    address2: 'Suite 2',
  }),
  partialDestinationFingerprint,
  'the checkout callback and later complete order must share one rate-zone fingerprint',
)
assert.notEqual(
  shopifyCheckoutDestinationFingerprint({
    countryCode: 'US',
    postalCode: '06104',
    provinceCode: 'CT',
  }),
  partialDestinationFingerprint,
  'a different ZIP must not reconcile to the same checkout destination',
)
assert.throws(
  () => shopifyCheckoutDestinationFingerprint({
    countryCode: 'US',
    postalCode: null,
  }),
  /requires country and postal code/,
  'a rate-zone fingerprint must fail closed without the ZIP',
)

console.log('Shopify CarrierService callback-token tests passed')
