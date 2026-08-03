#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const scriptUrl = new URL(
  './prove-ag-alchemy-carrier-sandbox-rating.mjs',
  import.meta.url,
)
const source = readFileSync(scriptUrl, 'utf8')
const packageJson = JSON.parse(readFileSync(
  new URL('../package.json', import.meta.url),
  'utf8',
))
const predeploy = readFileSync(
  new URL('./verify-predeploy.mjs', import.meta.url),
  'utf8',
)

for (const fragment of [
  "EXECUTION_CONFIRMATION =\n  'prove-ag-alchemy-carrier-sandbox-rating-v1'",
  "TRUSTED_PUBLIC_ORIGIN = 'https://dev.aiapp.eigenracing.com'",
  "TRUSTED_DEVELOPMENT_DATABASE_FINGERPRINT =\n  '750aa268-0e31-4065-a99c-4016e4d4fab1'",
  "TARGET_ORGANIZATION_NAME = 'AG Alchemy, LLC'",
  "TARGET_WAREHOUSE_GLOBAL_ID = 'gwh5366613'",
  "EXPECTED_PROVIDERS = Object.freeze(['fedex_rest', 'ups_rest'])",
  'requireTrustedDevelopmentEnvironment()',
  "environmentValue('RAILWAY_ENVIRONMENT_NAME') !== 'development'",
  'assertTrustedDatabase(client)',
  'PROOF_DATABASE_IDENTITY_MISMATCH',
  "requiredEnvironmentValue('CLAWPILOT_PUBLIC_URL'",
  "requiredEnvironmentValue('APP_LOGIN_EMAIL'",
  "requiredEnvironmentValue('APP_LOGIN_PASSWORD'",
  "'PIPELINE_OUTBOX_WORKER_SECRET'",
  "requiredEnvironmentValue('DATABASE_URL'",
  "url.protocol !== 'https:'",
  "url.origin !== TRUSTED_PUBLIC_ORIGIN",
  '!ALLOWED_API_PATHS.has(url.pathname)',
  "path: '/api/auth/login'",
  "'x-clawpilot-operator-secret': configuration.operatorSecret",
  "path: '/api/auth/session'",
  "path: '/api/auth/workspace'",
  "path: '/api/integrations/carriers'",
  "method: 'PATCH'",
  "action: 'test-sandbox-rate'",
  "environment: 'sandbox'",
  'carrierAccountGlobalId',
  'destination: SAFE_DESTINATION',
  "configuration?.authorizationScope === 'sandbox_rating_only'",
  "configuration?.authorizationScope === 'sandbox_fulfillment_diagnostic'",
  "configuration.allowedCapabilities[0] === 'sandbox_rate'",
  "configuration.allowedCapabilities[1] === 'sandbox_label'",
  'configuration?.credentialRevealAllowed === false',
  'configuration?.senderOriginWarehouseGlobalId',
  'carrier_account.sender_name',
  'carrier_account.registered_address',
  'carrier_account.registered_address_fingerprint',
  'warehouse.address AS warehouse_address',
  'carrierAccount.sender_name !== warehouse.warehouse_name',
  'carrierAddressFingerprint',
  '!exactManagedRatingConfiguration(connection)',
  '=== TARGET_WAREHOUSE_GLOBAL_ID',
  "'SELECT pg_try_advisory_lock(hashtext($1)) AS acquired'",
  "'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'",
  'operations_carrier_rate_requests',
  'operations_carrier_rate_test_labels',
  'operations_carrier_rate_test_label_attempts',
  'operations_labels',
  'operations_label_attempts',
  'operations_shipments',
  'operations_print_artifacts',
  'operations_print_jobs',
  "'carrier.sandbox_rate.succeeded'",
  "'carrier.sandbox_rate.failed'",
  "event_type LIKE 'carrier.rate_test_label.%'",
  "row.status === 'succeeded'",
  "row.billing_relationship === 'sender'",
  'after.rateRequests === before.rateRequests + EXPECTED_PROVIDERS.length',
  'await logout(configuration, cookieJar)',
  'cookieJar.clear()',
  "mode: 'plan'",
  "mode: 'self-test'",
  "mode: 'execute'",
  'providerMutations: 0',
]) {
  assert.ok(
    source.includes(fragment),
    `AG sandbox-rating proof is missing ${fragment}`,
  )
}

assert.ok(
  source.indexOf('requireTrustedDevelopmentEnvironment()')
    < source.indexOf("requiredEnvironmentValue('APP_LOGIN_PASSWORD'"),
  'Trusted Railway development identity must be checked before secrets are loaded',
)
assert.ok(
  source.indexOf('const before = await captureCounts')
    < source.indexOf('proofRates.push(await requestOneProviderRate'),
  'Pre-counts must be captured before either carrier rate request',
)
assert.ok(
  source.indexOf('const assertions = await assertPostconditions')
    > source.indexOf('proofRates.push(await requestOneProviderRate'),
  'Postconditions must be checked after carrier rate requests',
)
assert.ok(
  source.indexOf('await logout(configuration, cookieJar)')
    > source.indexOf('} finally {'),
  'Logout must remain in the execution finally block',
)
assert.ok(
  source.includes('input.sendCookie !== false'),
  'Login must absorb its first HttpOnly cookie without trying to send one',
)
assert.ok(
  source.includes('requestJson(configuration, {'),
  'All proof HTTP calls must use the bounded JSON request helper',
)
assert.equal(
  (source.match(/path: '\/api\/auth\/login'/g) || []).length,
  1,
  'Proof must create exactly one login session',
)
assert.equal(
  (source.match(/action: 'test-sandbox-rate'/g) || []).length,
  1,
  'The provider loop must issue one bounded rate action per provider',
)

for (const forbidden of [
  'console.log(configuration',
  'console.log(config',
  'console.log(session',
  'console.log(payload',
  'console.log(response',
  'console.log(rateTest',
  'console.error(error.stack',
  'console.error(String(error',
  'writeFileSync',
  'appendFileSync',
  'operations_carrier_rate_test_labels SET',
  'operations_labels SET',
  'operations_shipments SET',
  'create-rate-test-label',
  'print-rate-test-label',
  'void-rate-test-label',
]) {
  assert.ok(
    !source.includes(forbidden),
    `AG sandbox-rating proof contains forbidden fragment ${forbidden}`,
  )
}

const carrierTestCommand = String(packageJson.scripts?.['test:carriers'] || '')
for (const required of [
  'node scripts/test-prove-ag-alchemy-carrier-sandbox-rating.mjs',
  'node scripts/prove-ag-alchemy-carrier-sandbox-rating.mjs --self-test',
]) {
  assert.ok(
    carrierTestCommand.includes(required),
    `test:carriers must include ${required}`,
  )
}

for (const requiredPath of [
  'scripts/prove-ag-alchemy-carrier-sandbox-rating.mjs',
  'scripts/test-prove-ag-alchemy-carrier-sandbox-rating.mjs',
]) {
  assert.ok(
    predeploy.includes(`'${requiredPath}'`),
    `verify-predeploy required files must include ${requiredPath}`,
  )
}

function run(args, environment = {}) {
  return spawnSync(process.execPath, [scriptUrl.pathname, ...args], {
    cwd: new URL('..', import.meta.url).pathname,
    encoding: 'utf8',
    env: {
      NODE_ENV: 'test',
      ...environment,
    },
  })
}

function parsedOutput(result) {
  const raw = `${result.stdout || ''}${result.stderr || ''}`.trim()
  assert.ok(raw, 'Proof command must return one safe JSON result')
  return { raw, payload: JSON.parse(raw) }
}

const planResult = run([])
assert.equal(planResult.status, 0, planResult.stderr)
const plan = parsedOutput(planResult)
assert.equal(plan.payload.ok, true)
assert.equal(plan.payload.mode, 'plan')
assert.equal(plan.payload.defaultModeUsesNetwork, false)
assert.equal(plan.payload.defaultModeUsesDatabase, false)
assert.equal(plan.payload.providerMutationsPlanned, 0)

const selfTestResult = run(['--self-test'])
assert.equal(selfTestResult.status, 0, selfTestResult.stderr)
const selfTest = parsedOutput(selfTestResult)
assert.equal(selfTest.payload.ok, true)
assert.equal(selfTest.payload.mode, 'self-test')
assert.deepEqual(
  selfTest.payload.expectedProviders,
  ['fedex_rest', 'ups_rest'],
)
assert.equal(selfTest.payload.targetWarehouseGlobalId, 'gwh5366613')

const missingConfirmation = run(['--execute'])
assert.notEqual(missingConfirmation.status, 0)
const missingConfirmationOutput = parsedOutput(missingConfirmation)
assert.equal(
  missingConfirmationOutput.payload.code,
  'PROOF_CONFIRMATION_REQUIRED',
)

const canaries = {
  url: 'http://address-canary.invalid',
  email: 'customer-canary@example.invalid',
  password: 'password-canary-value',
  operator: 'operator-secret-canary-value-1234567890',
  database: 'postgresql://database-canary:secret@invalid/db',
}
const invalidTrustedUrl = run([
  '--execute',
  '--confirm=prove-ag-alchemy-carrier-sandbox-rating-v1',
], {
  RAILWAY_PROJECT_ID: 'b5169ebd-8166-4b96-9a81-7cc8adaa9270',
  RAILWAY_ENVIRONMENT_ID: 'e4abd95f-825c-4242-b37b-825a92597e98',
  RAILWAY_ENVIRONMENT_NAME: 'development',
  CLAWPILOT_PUBLIC_URL: canaries.url,
  APP_LOGIN_EMAIL: canaries.email,
  APP_LOGIN_PASSWORD: canaries.password,
  PIPELINE_OUTBOX_WORKER_SECRET: canaries.operator,
  DATABASE_URL: canaries.database,
})
assert.notEqual(invalidTrustedUrl.status, 0)
const invalidUrlOutput = parsedOutput(invalidTrustedUrl)
assert.equal(invalidUrlOutput.payload.code, 'PROOF_PUBLIC_URL_INVALID')

for (const output of [
  plan.raw,
  selfTest.raw,
  missingConfirmationOutput.raw,
  invalidUrlOutput.raw,
]) {
  for (const forbiddenValue of [
    '101 Academy Drive',
    'Buzzards Bay',
    ...Object.values(canaries),
  ]) {
    assert.ok(
      !output.includes(forbiddenValue),
      'Proof output must not expose protected execution data',
    )
  }
}

console.log('Carrier sandbox-rating proof contract checks passed.')
