#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')
const read = (path) => readFileSync(resolve(root, path), 'utf8')

const migrationPath =
  'db/migrations/0287_operations_print_agent_pairing_grants.sql'
const persistencePath =
  'app_src/lib/persistence/operationPrintDelivery.ts'
const operatorRoutePath =
  'app_src/app/api/operations/print-agents/route.ts'
const pairingRoutePath =
  'app_src/app/api/operations/print-agent/pair/route.ts'

const migration = read(migrationPath)
const persistence = read(persistencePath)
const operatorRoute = read(operatorRoutePath)
const pairingRoute = read(pairingRoutePath)
const proxy = read('app_src/proxy.ts')
const health = read('app_src/app/api/health/route.ts')
const predeploy = read('scripts/verify-predeploy.mjs')

for (const fragment of [
  'CREATE TABLE IF NOT EXISTS operations_print_agent_pairing_grants',
  "status IN ('pending', 'redeemed', 'expired', 'revoked')",
  'expires_at <= created_at + interval \'10 minutes\'',
  'secret_hash ~ \'^[a-f0-9]{64}$\'',
  'UNIQUE (organization_id, idempotency_key)',
  'protect_operations_print_agent_pairing_grant_write',
  'Terminal print-agent pairing grants are immutable',
]) {
  assert.ok(migration.includes(fragment), `Migration missing: ${fragment}`)
}
assert.doesNotMatch(
  migration,
  /pairing_code\s+text|credential\s+text/i,
  'The pairing table must not persist plaintext cppair or cpprint secrets',
)

for (const fragment of [
  'createOperationsPrintAgentPairingCode',
  'hashOperationsPrintAgentPairingSecret',
  'createOperationsPrintAgentPairingGrantInPostgres',
  'redeemOperationsPrintAgentPairingGrantInPostgres',
  'FOR UPDATE',
  "status = 'redeemed'",
  'credential: generated.credential',
]) {
  assert.ok(persistence.includes(fragment), `Persistence missing: ${fragment}`)
}
assert.match(
  persistence,
  /pairingGrant:\s*pairingGrantProjection\(replay\.rows\[0\], null\)/,
  'Idempotent operator replays must not recover a plaintext pairing code',
)
assert.doesNotMatch(
  `${migration}\n${persistence}`,
  /failed_attempts|locked_at|PAIRING_CODE_LOCKED/,
  'Unauthenticated wrong-secret requests must not create an operator lockout DoS',
)

for (const [path, source] of [
  [persistencePath, persistence],
  [operatorRoutePath, operatorRoute],
  [pairingRoutePath, pairingRoute],
]) {
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
    reportDiagnostics: true,
  })
  const errors = (output.diagnostics || []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  )
  assert.deepEqual(errors, [], `${path} must transpile`)
}

assert.ok(
  operatorRoute.includes("'create-pairing-grant'"),
  'The authenticated operator route must issue pairing grants',
)
assert.ok(
  operatorRoute.includes('createOperationsPrintAgentPairingGrantInPostgres'),
  'The operator route must use durable pairing-grant issuance',
)
assert.ok(
  !operatorRoute
    .slice(
      operatorRoute.indexOf("command.action === 'create-pairing-grant'"),
      operatorRoute.indexOf("command.action === 'upgrade-bundled-capabilities'"),
    )
    .includes('credential'),
  'The browser pairing action must never return a cpprint credential',
)
for (const forbidden of [
  "command.action === 'enroll-agent'",
  "command.action === 'rotate-credential'",
  'enrollOperationsPrintAgentInPostgres',
  'rotateOperationsPrintAgentCredentialInPostgres',
]) {
  assert.ok(
    !operatorRoute.includes(forbidden),
    `Browser management route exposes legacy cpprint issuance: ${forbidden}`,
  )
}

for (const fragment of [
  'secureTransport(req)',
  'installerRequest(req)',
  "req.headers.get('origin')",
  "req.headers.get('sec-fetch-site')",
  'redeemOperationsPrintAgentPairingGrantInPostgres',
  "'Cache-Control': 'no-store, max-age=0'",
  "'Referrer-Policy': 'no-referrer'",
]) {
  assert.ok(pairingRoute.includes(fragment), `Pairing route missing: ${fragment}`)
}
assert.ok(
  proxy.includes("normalizedPath === '/api/operations/print-agent/pair'"),
  'The installer redemption route must bypass browser-session authentication',
)

assert.ok(
  health.includes('0287_operations_print_agent_pairing_grants.sql'),
  'Health must require the applied pairing migration',
)
assert.ok(
  predeploy.includes(migrationPath),
  `${migrationPath} must be predeploy-gated`,
)
assert.ok(
  (health.match(/operations_print_agent_pairing_grants_applied/g) || [])
    .length >= 4,
  'Pairing migration readiness must gate health typing, SQL, status, and errors',
)

console.log('Operation print-agent pairing contracts passed.')
