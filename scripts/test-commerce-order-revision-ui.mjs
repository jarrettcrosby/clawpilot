#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = requireFromApp('typescript')

const paths = {
  panel: 'app_src/components/operations/CommerceOrderRevisionManagerPanel.tsx',
  section: 'app_src/components/operations/OperationsSection.tsx',
  fixture: 'app_src/components/operations/CommerceOrderRevisionDevelopmentFixture.tsx',
  page: 'app_src/app/dev/commerce-order-revisions/page.tsx',
  devStart: 'scripts/dev-start.sh',
}
const source = Object.fromEntries(
  Object.entries(paths).map(([key, path]) => [key, readFileSync(resolve(root, path), 'utf8')]),
)

for (const [key, path] of Object.entries(paths)) {
  if (!path.endsWith('.tsx')) continue
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

assert.match(
  source.section,
  /order\.sourceProvider === 'shopify' \|\| order\.sourceProvider === 'faire'/,
  'every Shopify/Faire detail must render the revision panel independent of exception state',
)
assert.match(source.section, /orderGlobalId=\{order\.globalId\}/)
assert.match(source.section, /orderRowVersion=\{order\.rowVersion\}/)
assert.match(source.section, /onBusyChange=\{onOrderRevisionBusyChange\}/)
assert.match(source.section, /onReviewRecovery=\{onReviewOrderRevisionRecovery\}/)
assert.match(source.section, /\|\| orderRevisionBusy/)

assert.match(source.panel, /Refresh from \$\{label\}/)
assert.match(source.panel, />\s*Update ClawPilot\s*</)
assert.match(source.panel, /Reconcile external fulfillment/)
assert.match(source.panel, /Checked \$\{capturedLabel\}/)
assert.match(source.panel, />\s*Audit details\s*</)
assert.match(source.panel, /component="details"/)
assert.match(source.panel, /\/api\/operations\/order-revisions\?/)
assert.match(source.panel, /fetch\('\/api\/operations\/order-revisions'/)
assert.doesNotMatch(
  source.panel,
  /fetch\('\/api\/operations'/,
  'revision actions must use the isolated route, not the generic Operations route',
)

for (const exactField of [
  'observationGlobalId',
  'readGlobalId',
  'expectedSourceHash',
  'expectedRevisionHash',
  'expectedRowVersion',
]) {
  assert.match(
    source.panel,
    new RegExp(`\\b${exactField}\\b`),
    `exact mutation payload must carry ${exactField}`,
  )
}
assert.match(source.panel, /const exactBindingCurrent = revision\?\.orderRowVersion === orderRowVersion/)
assert.equal(
  (source.panel.match(/canExecute\s*&& !recoveryOnly\s*&& exactBindingCurrent/g) || []).length,
  2,
  'Apply and cancellation must both fail closed in recovery-only state',
)
assert.match(source.panel, /exactState\.applyEligible/)
assert.match(source.panel, /exactState\.cancellationEligible/)
assert.match(source.panel, /exceptionGlobalId: string \| null/)
assert.match(
  source.panel,
  /const reviewRecoveryExceptionGlobalId = exactBindingCurrent[\s\S]{0,100}exactState\?\.changed[\s\S]{0,100}exactState\.exceptionGlobalId/,
  'recovery must require the exact current order binding, a material change, and an exact exception id',
)
assert.match(
  source.panel,
  /recoveryOnly[\s\S]{0,100}materialState !== 'provider_fulfilled'/,
  'external fulfillment must keep its dedicated reconciliation path',
)
assert.match(source.panel, />\s*Review recovery\s*</)
assert.match(
  source.panel,
  /onReviewRecovery\(reviewRecoveryExceptionGlobalId\)/,
  'recovery must hand the exact exception id to its parent',
)
assert.match(
  source.section,
  /item\.globalId === exceptionGlobalId[\s\S]{0,180}item\.orderGlobalId === orderGlobalId[\s\S]{0,180}item\.exceptionType === 'commerce_order_revision_required'[\s\S]{0,180}item\.status === 'open' \|\| item\.status === 'acknowledged'/,
  'the parent must validate the exact active recovery exception for the selected order',
)
assert.match(
  source.section,
  /search: exceptionGlobalId,[\s\S]{0,80}order: orderGlobalId/,
  'a filtered workspace must retrieve the exact exception rather than opening a generic recovery record',
)
assert.match(source.section, /chooseException\(exactException\)/)
assert.match(source.panel, /payload\.result\.newRowVersion !== requestRowVersion \+ 1/)
assert.match(source.panel, /payload\.result\.orderGlobalId !== orderGlobalId/)
assert.match(source.panel, /payload\.result\.observationGlobalId !== exactState\?\.observationGlobalId/)
assert.match(source.panel, /payload\.result\.readGlobalId !== exactState\?\.readGlobalId/)
assert.match(source.panel, /payload\.result\.sourceHash !== exactState\?\.sourceHash/)
assert.match(source.panel, /payload\.result\.revisionHash !== exactState\?\.revisionHash/)
assert.match(source.panel, /payload\.result\.providerWrites !== 0/)
assert.match(source.panel, /!payload\.result\.applicationGlobalId/)
assert.match(source.panel, /!payload\.result\.dispositionGlobalId/)
assert.match(source.panel, /payload\.result\.previousStatus !== 'imported'/)
assert.match(source.panel, /payload\.result\.status !== 'cancelled'/)
assert.match(source.panel, /operations-order-revision:\$\{action\}:\$\{readGlobalId\}:\$\{nonce\}/)
assert.match(
  source.panel,
  /nextAction === 'refresh-from-provider'[\s\S]{0,180}commerceOrderRevisionRefreshNeedsNewIdempotencyKey\(payload\)[\s\S]{0,400}refreshIdempotencyAttempt\.current = null/u,
  'A confirmed terminal refresh receipt must release its idempotency key so the visible retry can issue a new read',
)
assert.doesNotMatch(
  source.panel,
  /(?:SHOPIFY|FAIRE)_ORDER_REVISION_PROVIDER_READ_FAILED/u,
  'the shared panel must honor the terminal-receipt contract instead of hard-coding provider error codes',
)
assert.match(source.panel, /const exactIdempotencyAttempt = useRef</)
assert.match(source.panel, /const refreshIdempotencyAttempt = useRef</)
assert.match(source.panel, /const fingerprint = JSON\.stringify\(body\)/)
assert.match(source.panel, /exactIdempotencyAttempt\.current\?\.fingerprint !== fingerprint/)
assert.match(source.panel, /return exactIdempotencyAttempt\.current\.key/)
assert.match(source.panel, /return refreshIdempotencyAttempt\.current\.key/)
assert.match(source.panel, /exactIdempotencyAttempt\.current = null/)
assert.match(source.panel, /refreshIdempotencyAttempt\.current = null/)
assert.doesNotMatch(
  source.panel,
  /if \(!response\.ok[\s\S]{0,300}exactIdempotencyAttempt\.current = null/,
  'ambiguous HTTP failures must retain the exact retry identity',
)

assert.match(source.panel, /FAIRE_ORDER_REVISION_LINE_QUANTITY_INCOMPLETE/)
assert.match(source.panel, /COMMERCE_ORDER_REVISION_APPLY_DISABLED/)
assert.match(source.panel, /Updating ClawPilot is temporarily disabled/)
assert.match(source.panel, /Faire did not return a complete set of line items and quantities/)
assert.match(source.panel, /started, partial, or has downstream evidence/)
assert.match(source.panel, /provider_fulfilled/)
assert.match(source.panel, /Use Reconcile external fulfillment/)
assert.match(source.panel, /0 sales-channel writes/)
assert.doesNotMatch(
  source.panel,
  /Read the exact sales-channel order, then review any local-only change/,
  'the panel must not repeat an explanatory subtitle under every order authority heading',
)
assert.doesNotMatch(
  source.panel,
  /Refresh is provider read-only\. Apply and cancellation update ClawPilot only/,
  'the panel must not repeat a universal explanatory footer',
)
assert.doesNotMatch(
  source.panel,
  /Provider revision|provider revision|Apply to ClawPilot|exact provider revision|order authority/,
  'customer copy must use plain sales-channel refresh and ClawPilot update language',
)
assert.equal(
  (source.panel.match(/matches this ClawPilot order\./g) || []).length,
  1,
  'current provider state must render one success message',
)
assert.match(
  source.panel,
  /exactState\.materialState === 'provider_cancelled'[\s\S]{0,220}&& !canAcceptCancellation[\s\S]{0,80}&& !recoveryOnly/,
  'started cancellation must not render a second cancellation warning',
)
assert.match(
  source.panel,
  /exactState\.materialState === 'provider_cancelled'[\s\S]{0,250}Automatic cancellation is blocked; use manager recovery/,
  'the recovery warning must explain why a started cancellation is blocked',
)

const touchTargets = source.panel.match(/minHeight: 44/g) || []
assert.ok(touchTargets.length >= 5, 'all revision actions must retain at least 44px touch targets')
assert.match(source.panel, /direction=\{\{ xs: 'column', sm: 'row' \}\}/)
assert.match(source.panel, /DialogActions sx=\{\{ flexWrap: 'wrap'/)

assert.match(
  source.panel,
  /const fixtureRevision = process\.env\.NEXT_PUBLIC_LOCAL_UI_FIXTURES === '1'\s*\? developmentFixture\s*: undefined/,
  'in-memory fixture injection must require an explicit local build flag',
)
assert.match(
  source.page,
  /process\.env\.RUNTIME_LANE === 'dev'[\s\S]*process\.env\.APP_AUTH_REQUIRED === '0'[\s\S]*!process\.env\.RAILWAY_PROJECT_ID[\s\S]*!process\.env\.VERCEL[\s\S]*process\.env\.LOCAL_UI_FIXTURES === '1'/,
  'the browser walkthrough must require the supported local unauthenticated dev runtime and explicit fixture flag',
)
assert.match(source.page, /if \(!localFixtureRuntime\) notFound\(\)/)
assert.match(source.devStart, /LOCAL_UI_FIXTURES="1"/)
assert.match(source.devStart, /NEXT_PUBLIC_LOCAL_UI_FIXTURES="1"/)
assert.match(
  source.devStart,
  /LOCAL_UI_FIXTURES="1" NEXT_PUBLIC_LOCAL_UI_FIXTURES="1" npm run build/,
  'the supported local build must explicitly compile the fixture seam',
)
assert.doesNotMatch(source.fixture, /\bfetch\s*\(/, 'the deterministic fixture must perform no request')
assert.match(source.page, /No API, database, Shopify, or Faire calls/)
assert.match(source.fixture, /Shopify matches/)
assert.match(source.fixture, /Shopify update available/)
assert.match(source.fixture, /Started Shopify order/)
assert.match(source.fixture, /Faire update blocked/)
assert.match(source.fixture, /Shopify cancellation/)
assert.match(source.fixture, /Started cancellation/)
assert.match(source.fixture, /Shopify fulfilled/)
assert.match(source.fixture, /developmentFixture=\{scenario\.value\}/)
assert.match(source.fixture, /exceptionGlobalId: 'gex9000003'/)
assert.match(source.fixture, /onReviewRecovery=\{setReviewedExceptionGlobalId\}/)
assert.match(source.fixture, /Recovery selection:/)
assert.match(source.fixture, /const originalFetch = window\.fetch/)
assert.match(source.fixture, /window\.fetch = async/)
assert.match(source.fixture, /Network requests:/)
assert.doesNotMatch(source.fixture, /description:/)
assert.match(source.page, /Sales channel order refresh test/)
assert.doesNotMatch(source.page, /Provider revision UI walkthrough/)

console.log('Commerce order revision manager UI checks passed.')
