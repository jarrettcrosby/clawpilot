#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = requireFromApp('typescript')

const paths = {
  dialog: 'app_src/components/operations/OneOffShipmentDialog.tsx',
  fixture: 'app_src/components/shipping/ShippingWorkflowDevelopmentFixture.tsx',
  page: 'app_src/app/dev/shipping-workflow/page.tsx',
  operationsSection: 'app_src/components/operations/OperationsSection.tsx',
  shippingSection: 'app_src/components/shipping/ShippingSection.tsx',
  devStart: 'scripts/dev-start.sh',
}

const source = Object.fromEntries(
  Object.entries(paths).map(([key, path]) => [
    key,
    readFileSync(resolve(root, path), 'utf8'),
  ]),
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
  source.dialog,
  /const fixture = process\.env\.NEXT_PUBLIC_LOCAL_UI_FIXTURES === '1'\s*\? developmentFixture\s*: undefined/,
  'fixture injection must require the explicit public local build flag',
)
assert.match(source.dialog, /if \(fixture\) \{[\s\S]*setWorkspace\(nextWorkspace\)[\s\S]*setPackagingMaterials\(fixture\.packagingMaterials\)/)
assert.match(source.dialog, /developmentFixture\?: OneOffShipmentDevelopmentFixture/)

assert.match(
  source.page,
  /process\.env\.RUNTIME_LANE === 'dev'[\s\S]*process\.env\.APP_AUTH_REQUIRED === '0'[\s\S]*!process\.env\.RAILWAY_PROJECT_ID[\s\S]*!process\.env\.VERCEL[\s\S]*process\.env\.LOCAL_UI_FIXTURES === '1'/,
  'the walkthrough page must require the supported local unauthenticated dev runtime',
)
assert.match(source.page, /if \(!localFixtureRuntime\) notFound\(\)/)

assert.match(source.fixture, /initialStep: 1/)
assert.match(source.fixture, /provider: 'ups_rest'/)
assert.match(source.fixture, /provider: 'fedex_rest'/)
assert.match(source.fixture, /provider: 'wwex_speedship'/)
assert.match(source.fixture, /environment: 'sandbox'/)
assert.match(source.fixture, /AG Alchemy Mock Warehouse/)
assert.match(source.fixture, /AG medium carton/)
assert.match(source.fixture, /AG padded mailer/)
assert.match(source.fixture, /developmentFixture=\{developmentFixture\}/)
assert.match(source.fixture, /const originalFetch = window\.fetch/)
assert.match(source.fixture, /window\.fetch = async/)
assert.match(source.fixture, /blocked an unexpected request/)
assert.match(source.fixture, /Network requests: \{unexpectedFetchCount\}/)
assert.doesNotMatch(source.fixture, /\bfetch\s*\(/, 'the fixture must not initiate a request')

assert.doesNotMatch(
  source.operationsSection,
  /developmentFixture=/,
  'the Operations production call site must not receive the fixture seam',
)
assert.doesNotMatch(
  source.shippingSection,
  /developmentFixture=/,
  'the Shipping production call site must not receive the fixture seam',
)

assert.match(source.devStart, /LOCAL_UI_FIXTURES="1"/)
assert.match(source.devStart, /NEXT_PUBLIC_LOCAL_UI_FIXTURES="1"/)
assert.match(
  source.devStart,
  /LOCAL_UI_FIXTURES="1" NEXT_PUBLIC_LOCAL_UI_FIXTURES="1" npm run build/,
)

console.log('Local Shipping workflow fixture checks passed.')
