#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = requireFromApp('typescript')
const paths = {
  panel: 'app_src/components/operations/ShopifyOrderManagementPanel.tsx',
  section: 'app_src/components/operations/OperationsSection.tsx',
}
const source = Object.fromEntries(
  Object.entries(paths).map(([key, path]) => [key, readFileSync(resolve(root, path), 'utf8')]),
)

for (const [key, path] of Object.entries(paths)) {
  const output = ts.transpileModule(source[key], {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
    fileName: path,
    reportDiagnostics: true,
  })
  const errors = (output.diagnostics || []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  )
  assert.deepEqual(errors, [], `${path} must transpile without syntax errors`)
}

assert.match(source.section, /import ShopifyOrderManagementPanel from/)
assert.match(
  source.section,
  /order\.sourceProvider === 'shopify'[\s\S]{0,250}<ShopifyOrderManagementPanel/,
  'Shopify order detail must mount the real provider-write panel',
)
assert.match(source.section, /orderGlobalId=\{order\.globalId\}/)
assert.match(source.section, /orderRowVersion=\{order\.rowVersion\}/)
assert.match(source.section, /canExecute=\{canExecute\}/)
assert.match(source.section, /canActivate=\{canActivate\}/)
assert.match(source.section, /onOrderChanged=\{onOrderRevisionChanged\}/)

assert.match(source.panel, />Manage in Shopify</)
assert.match(source.panel, /This panel performs real Shopify provider writes/)
assert.match(source.panel, /Shopify test flag: FALSE/)
assert.match(source.panel, /exact order \{management\.order\.name\}/)
assert.match(source.panel, /\{management\.shopDomain\}/)
assert.match(source.panel, /\{management\.accountLabel\}/)
assert.match(source.panel, /Add Shopify tag/)
assert.match(source.panel, /#6600/)
assert.match(source.panel, /Decrease Shopify line quantity/)
assert.match(source.panel, /Cancel Shopify order/)
assert.match(source.panel, /if \(!canManage \|\| !canExecute \|\| !canActivate\) return/)
assert.match(source.panel, /Only an organization owner or administrator with activation authority/)

for (const disclosure of [
  'sends no customer notification',
  'issues no refund',
  'does not restock inventory',
]) {
  assert.match(
    source.panel,
    new RegExp(disclosure),
    `provider-write review must disclose that it ${disclosure}`,
  )
}

assert.match(
  source.panel,
  /fetch\(\s*`\/api\/operations\/shopify-order-management\?\$\{query\.toString\(\)\}`/,
  'authority must load from the isolated order-management route',
)
assert.equal(
  (source.panel.match(/fetch\('\/api\/operations\/shopify-order-management'/g) || []).length,
  3,
  'prepare, execute, and reconcile must all use the isolated route',
)
assert.doesNotMatch(
  source.panel,
  /fetch\('\/api\/operations'/,
  'provider writes must never use the generic Operations route',
)
assert.equal(
  (source.panel.match(/'Idempotency-Key': key/g) || []).length,
  3,
  'every POST must carry an idempotency key',
)
assert.match(source.panel, /shopify-order-management:\$\{action\}:\$\{exactId\}:\$\{nonce\}/)
assert.match(source.panel, /const prepareAttempt = useRef<IdempotencyAttempt \| null>/)
assert.match(source.panel, /const executeAttempt = useRef<IdempotencyAttempt \| null>/)
assert.match(source.panel, /const reconcileAttempt = useRef<IdempotencyAttempt \| null>/)

for (const prepareField of [
  "action: 'prepare' as const",
  'orderGlobalId,',
  'expectedRowVersion: requestRowVersion',
  'mutation,',
  'reason: reason.trim()',
]) {
  assert.ok(source.panel.includes(prepareField), `prepare payload is missing ${prepareField}`)
}
for (const executionField of [
  "action: 'execute' as const",
  'authorizationGlobalId: pending.authorization.authorizationGlobalId',
  'intentHash: pending.authorization.intentHash',
  'confirmationStatement: confirmation',
  'mutation: pending.mutation',
  'reason: pending.reason',
]) {
  assert.ok(source.panel.includes(executionField), `execute payload is missing ${executionField}`)
}
assert.match(source.panel, /action: 'reconcile' as const/)
assert.match(source.panel, /attemptGlobalId: attempt\.attemptGlobalId/)

for (const exactField of [
  'authorizationGlobalId',
  'intentHash',
  'expiresAt',
  'confirmationStatement',
  'providerReads',
  'providerWrites',
  'attemptGlobalId',
  'providerReference',
]) {
  assert.match(source.panel, new RegExp(`\\b${exactField}\\b`), `audit UI is missing ${exactField}`)
}
assert.match(source.panel, /candidate\.providerWrites !== 0/)
assert.match(source.panel, /candidate\.providerWrites <= 3/)
assert.match(source.panel, /candidate\.providerWrites === null/)
assert.match(source.panel, /providerWrites === null[\s\S]{0,80}\? 'Unknown'/)
assert.ok(source.panel.includes('const AUTHORIZATION_GLOBAL_ID = /^gsom'))
assert.ok(source.panel.includes('const ATTEMPT_GLOBAL_ID = /^gsoa'))
assert.ok(source.panel.includes('const SHA256 = /^[a-f0-9]{64}$/'))
assert.match(source.panel, /candidate\.authorizationGlobalId !== expectedAuthorizationGlobalId/)
assert.match(source.panel, /result\.attemptGlobalId !== attempt\.attemptGlobalId/)
assert.match(source.panel, /result\.state === 'unknown'/)

assert.match(source.panel, /Type the exact confirmation statement/)
assert.match(
  source.panel,
  /confirmation !== pending\.authorization\.confirmationStatement/,
  'execution must require the server-provided exact statement',
)
assert.match(source.panel, />\s*Close without writing\s*</)
assert.match(source.panel, />\s*Execute exact Shopify write\s*</)
assert.match(source.panel, /Prepare is read-only/)

assert.match(
  source.panel,
  /openAttempt\?\.state === 'processing' \|\| openAttempt\?\.state === 'unknown'/,
  'processing and unknown attempts must block every new preparation',
)
assert.match(
  source.panel,
  /attempt\.state !== 'unknown'/,
  'reconciliation must fail closed for every state except unknown',
)
assert.match(source.panel, /Reconciliation is the only available action/)
assert.match(source.panel, /attempt\.state !== 'processing' && attempt\.state !== 'unknown'/)
assert.match(source.panel, /Check provider outcome/)
assert.match(source.panel, /Reconcile unknown outcome/)
assert.match(source.panel, /does not authorize a second provider write/)
assert.doesNotMatch(
  source.panel,
  />\s*(?:Retry execute|Execute again|Retry Shopify write)\s*</i,
  'unknown outcomes must not expose an execution retry control',
)
assert.doesNotMatch(source.panel, /openAttempt\.(?:tag|mutation|staffNote)/)

assert.match(source.panel, /Disabled: \{value\}/)
assert.match(source.panel, /management\.eligibility\.addTag\.reason/)
assert.match(source.panel, /management\.eligibility\.cancel\.reason/)
assert.match(source.panel, /eligibility\.reason \|\| 'Shopify did not allow this line edit\.'/)
assert.match(source.panel, /!management\.eligibility\.addTag\.allowed/)
assert.match(source.panel, /!management\.eligibility\.cancel\.allowed/)

const mobileColumns = source.panel.match(/gridTemplateColumns: \{ xs: 'minmax\(0, 1fr\)'/g) || []
assert.ok(mobileColumns.length >= 4, 'management layouts must collapse to one safe mobile column')
assert.ok(
  (source.panel.match(/minHeight: 44/g) || []).length >= 7,
  'all provider-write controls must retain mobile touch targets',
)
assert.match(source.panel, /direction=\{\{ xs: 'column', sm: 'row' \}\}/)
assert.match(source.panel, /alignSelf: \{ xs: 'stretch', sm: 'flex-start' \}/)
assert.match(source.panel, /DialogActions sx=\{\{ flexWrap: 'wrap'/)
assert.match(source.panel, /overflowWrap: 'anywhere'/)
assert.ok(
  (source.panel.match(/component="span" sx=\{\{ display: 'block' \}\}/g) || []).length >= 3,
  'tooltip wrappers must not collapse full-width mobile actions',
)

console.log('Shopify order management UI checks passed.')
