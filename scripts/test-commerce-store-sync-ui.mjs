#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (path) => readFileSync(resolve(process.cwd(), path), 'utf8')

const operations = read('app_src/components/operations/OperationsSection.tsx')
const intake = read('app_src/components/settings/CommerceIntakeWorkflow.tsx')
const shopify = read(
  'app_src/components/settings/ShopifyCarrierServiceSetupPanel.tsx',
)
const domain = read('app_src/lib/operations/commerceStoreSync.ts')

const section = (source, start, end) => {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex + start.length)
  assert.ok(startIndex >= 0, `Missing section start: ${start}`)
  assert.ok(endIndex > startIndex, `Missing section end: ${end}`)
  return source.slice(startIndex, endIndex)
}

assert.ok(
  operations.indexOf('data-testid="commerce-store-sync-summary"')
    < operations.indexOf('data-testid="operations-advanced-safety"'),
  'Desired/Effective Store sync must precede the advanced legacy safety mode',
)
assert.match(
  operations,
  /Advanced safety · legacy execution profile/u,
)
assert.match(
  operations,
  /Shadow, Read only,[\s\S]*Active no longer determine Store sync/u,
)
assert.match(
  operations,
  /direction=\{\{ xs: 'column', sm: 'row' \}\}/u,
)
assert.match(operations, /pendingStoreSyncCommands/u)
assert.match(operations, /The exact command is retained for retry/u)
assert.match(operations, /commerceStoreSyncPendingResolution/u)
assert.match(operations, /resolution === 'definitive_rejection'[\s\S]{0,180}pendingStoreSyncCommands\.current\.delete\(accountGlobalId\)/u)
assert.match(shopify, /pendingStoreSyncCommand/u)
assert.match(shopify, /The exact command is retained for retry/u)
assert.match(shopify, /commerceStoreSyncPendingResolution/u)
assert.match(shopify, /resolution === 'definitive_rejection'[\s\S]{0,180}pendingStoreSyncCommand\.current = null/u)
assert.match(domain, /commerceStoreSyncControlMatchesCommand/u)
assert.match(domain, /control\.revision === command\.expectedRevision \+ 1/u)
assert.match(domain, /control\.reason === command\.reason/u)
assert.match(domain, /status !== 408/u)
assert.match(domain, /status !== 425/u)
assert.match(domain, /status !== 429/u)

assert.match(intake, /data-testid="commerce-intake-store-sync-editor"/u)
assert.match(intake, /Desired\{' '\}/u)
assert.match(intake, /Effective\{' '\}/u)
assert.match(intake, /View only · an Operations administrator can change Store sync/u)
assert.match(intake, /disabled=\{!canActivate \|\| Boolean\(pendingAction\)\}/u)
assert.match(intake, /pendingStoreSyncCommand/u)
assert.match(intake, /commerceStoreSyncPendingResolution/u)
assert.match(intake, /resolution === 'definitive_rejection'[\s\S]{0,180}pendingStoreSyncCommand\.current = null/u)
assert.match(intake, /manualProviderReadsAllowed\?: boolean/u)
assert.match(intake, /localReviewCommandsAllowed\?: boolean/u)

const bulkProductCreate = section(
  intake,
  'async function createAllNewCatalogProducts()',
  'function updateProductDraft',
)
assert.match(bulkProductCreate, /!localReviewCommandsAllowed/u)
assert.doesNotMatch(bulkProductCreate, /!operatorCommandsAllowed/u)
assert.doesNotMatch(bulkProductCreate, /!providerMirrorAllowed/u)

const exactOrderRetry = section(
  intake,
  'async function retryOrderMoneyRejectionGroup',
  'function catalogProductDraft',
)
assert.match(exactOrderRetry, /!manualProviderReadsAllowed/u)
assert.doesNotMatch(exactOrderRetry, /!providerMirrorAllowed/u)

const autoCreatePolicy = section(
  intake,
  'async function saveAutomaticProductCreationPolicy',
  'async function resetTerminalProductCatalogSync',
)
assert.match(autoCreatePolicy, /!canManage/u)
assert.match(autoCreatePolicy, /!localReviewCommandsAllowed/u)
assert.doesNotMatch(autoCreatePolicy, /!providerMirrorAllowed/u)

assert.match(
  intake,
  /const candidateLocked = Boolean\(unavailableReason\)[\s\S]{0,80}!operatorCommandsAllowed[\s\S]{0,120}const localReviewLocked = Boolean\(unavailableReason\)[\s\S]{0,80}!localReviewCommandsAllowed/u,
  'canonical execution and local review must retain distinct candidate gates',
)
assert.match(
  intake,
  /const refreshLocked = \([\s\S]{0,80}!manualProviderReadsAllowed/u,
)
assert.match(
  intake,
  /Permissioned one-off read-only checks and refreshes remain available; they do not resume automatic mirroring/u,
)
assert.match(
  intake,
  /While Store sync is Paused, no automatic catalog[\s\S]{0,160}permissioned one-off/u,
)
assert.match(
  intake,
  /candidate\.state !== 'ready'[\s\S]{0,220}!operatorCommandsAllowed|!operatorCommandsAllowed[\s\S]{0,220}candidate\.state !== 'ready'/u,
  'canonical order promotion remains on the legacy execution gate',
)

console.log('Commerce Store sync responsive UI contract passed')
