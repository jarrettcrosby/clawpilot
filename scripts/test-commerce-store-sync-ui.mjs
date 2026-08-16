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
assert.match(shopify, /pendingStoreSyncCommand/u)
assert.match(shopify, /The exact command is retained for retry/u)
assert.match(domain, /commerceStoreSyncControlMatchesCommand/u)
assert.match(domain, /control\.revision === command\.expectedRevision \+ 1/u)

assert.match(intake, /data-testid="commerce-intake-store-sync-editor"/u)
assert.match(intake, /Desired\{' '\}/u)
assert.match(intake, /Effective\{' '\}/u)
assert.match(intake, /View only · an Operations administrator can change Store sync/u)
assert.match(intake, /disabled=\{!canActivate \|\| Boolean\(pendingAction\)\}/u)
assert.match(intake, /pendingStoreSyncCommand/u)
assert.match(
  intake,
  /async function createAllNewCatalogProducts\(\) \{[\s\S]{0,180}!operatorCommandsAllowed/u,
  'bulk local product creation remains gated by the legacy local decision authority',
)
assert.doesNotMatch(
  intake,
  /async function createAllNewCatalogProducts\(\) \{[\s\S]{0,180}!providerMirrorAllowed/u,
)

console.log('Commerce Store sync responsive UI contract passed')
