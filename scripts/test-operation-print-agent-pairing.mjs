#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')
const read = (path) => readFileSync(resolve(root, path), 'utf8')

const migrationPath =
  'db/migrations/0287_operations_print_agent_pairing_grants.sql'
const recoveryMigrationPath =
  'db/migrations/0295_operations_print_agent_pairing_recovery_envelopes.sql'
const persistencePath =
  'app_src/lib/persistence/operationPrintDelivery.ts'
const operatorRoutePath =
  'app_src/app/api/operations/print-agents/route.ts'
const pairingRoutePath =
  'app_src/app/api/operations/print-agent/pair/route.ts'

const migration = read(migrationPath)
const recoveryMigration = read(recoveryMigrationPath)
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
  `${migration}\n${recoveryMigration}`,
  /pairing_code\s+text|credential\s+text/i,
  'The pairing table must not persist plaintext cppair or cpprint secrets',
)

for (const fragment of [
  'client_installation_id uuid',
  'client_public_key_spki text',
  'client_key_fingerprint text',
  'credential_envelope jsonb',
  'credential_envelope_sha256 text',
  'recovery_expires_at timestamptz',
  "recovery_expires_at <= redeemed_at + interval '10 minutes'",
  'operations_print_agent_pairing_grants_envelope_shape_valid',
]) {
  assert.ok(
    recoveryMigration.includes(fragment),
    `Recovery migration missing: ${fragment}`,
  )
}
assert.doesNotMatch(
  recoveryMigration,
  /private_key|cpprint_secret|plaintext_credential/i,
  'Recovery persistence must not store private keys or plaintext credentials',
)

for (const fragment of [
  'createOperationsPrintAgentPairingCode',
  'hashOperationsPrintAgentPairingSecret',
  'createOperationsPrintAgentPairingGrantInPostgres',
  'redeemOperationsPrintAgentPairingGrantInPostgres',
  'FOR UPDATE',
  "status = 'redeemed'",
  'createPairingCredentialEnvelope',
  'client_public_key_spki',
  'credential_envelope_sha256',
  'replayed: true',
  'OPERATIONS_PRINT_AGENT_PAIRING_CLIENT_MISMATCH',
  'OPERATIONS_PRINT_AGENT_PAIRING_REPLAY_MISMATCH',
  'OPERATIONS_PRINT_AGENT_PAIRING_RECOVERY_EXPIRED',
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
  'schemaVersion',
  'installationId',
  'clientPublicKey',
  'clientKeyFingerprint',
  'OPERATIONS_PRINT_AGENT_PAIRING_PROTOCOL_REQUIRED',
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
  health.includes('0295_operations_print_agent_pairing_recovery_envelopes.sql'),
  'Health must require the recovery-envelope migration',
)
assert.ok(
  predeploy.includes(migrationPath),
  `${migrationPath} must be predeploy-gated`,
)
assert.ok(
  predeploy.includes(recoveryMigrationPath),
  `${recoveryMigrationPath} must be predeploy-gated`,
)
assert.ok(
  (health.match(/operations_print_agent_pairing_grants_applied/g) || [])
    .length >= 4,
  'Pairing migration readiness must gate health typing, SQL, status, and errors',
)
assert.ok(
  (health.match(/operations_print_agent_pairing_recovery_applied/g) || [])
    .length >= 5,
  'Recovery migration readiness must gate health typing, SQL, status, and errors',
)

class RequestError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

class TestNextResponse extends Response {
  static json(value, init = {}) {
    const headers = new Headers(init.headers)
    headers.set('Content-Type', 'application/json')
    return new TestNextResponse(JSON.stringify(value), { ...init, headers })
  }
}

function loadPairingRoute(redeemCalls) {
  const output = ts.transpileModule(pairingRoute, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: pairingRoutePath,
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(output, {
    Array,
    Boolean,
    Buffer,
    Error,
    Headers,
    JSON,
    Map,
    Number,
    Object,
    Promise,
    RegExp,
    Response,
    Set,
    String,
    URL,
    console,
    exports: module.exports,
    module,
    process,
    require(specifier) {
      if (specifier === 'next/server') {
        return { NextRequest: class {}, NextResponse: TestNextResponse }
      }
      if (specifier === '@/lib/persistence/config') {
        return {
          isHostedRuntime: () => true,
          isPostgresStorageEnabled: () => true,
        }
      }
      if (specifier === '@/lib/persistence/operationPrintDelivery') {
        return {
          OPERATIONS_PRINT_AGENT_PAIRING_REDEMPTION_SCHEMA_VERSION: 2,
          async redeemOperationsPrintAgentPairingGrantInPostgres(input) {
            redeemCalls.push(structuredClone(input))
            return {
              replayed: false,
              installationId: input.client.installationId,
              clientKeyFingerprint: input.client.clientKeyFingerprint,
              recoveryExpiresAt: '2026-08-15T12:10:00.000Z',
              agent: {
                id: '00000000-0000-4000-8000-000000000002',
                globalId: 'gpt0000001',
                name: 'Warehouse agent',
              },
              sealedEnrollment: {
                schemaVersion: 1,
                keyAgreement: 'X25519',
                keyDerivation: 'HKDF-SHA256',
                contentEncryption: 'A256GCM',
              },
            }
          },
        }
      }
      if (specifier === '@/lib/persistence/operations') {
        return { OperationsRequestError: RequestError }
      }
      return requireFromApp(specifier)
    },
  }, { filename: pairingRoutePath })
  return module.exports
}

function pairingRequest(payload, headers = {}) {
  const raw = JSON.stringify(payload)
  return {
    headers: new Headers({
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(raw)),
      'idempotency-key': 'pairing-route-test-0001',
      'x-forwarded-proto': 'https',
      ...headers,
    }),
    nextUrl: new URL('https://dev.aiapp.eigenracing.com/api/operations/print-agent/pair'),
    text: async () => raw,
  }
}

const redeemCalls = []
const route = loadPairingRoute(redeemCalls)
const validRequest = {
  schemaVersion: 2,
  pairingCode: `cppair.v1.00000000-0000-4000-8000-000000000001.${'a'.repeat(43)}`,
  installationId: '00000000-0000-4000-8000-000000000003',
  clientPublicKey: 'A'.repeat(59),
  clientKeyFingerprint: 'B'.repeat(43),
}
const success = await route.POST(pairingRequest(validRequest))
assert.equal(success.status, 200)
assert.equal(success.headers.get('cache-control'), 'no-store, max-age=0')
const successPayload = await success.json()
assert.equal(successPayload.ok, true)
assert.equal(successPayload.schemaVersion, 2)
assert.equal(Object.hasOwn(successPayload, 'credential'), false)
assert.deepEqual(redeemCalls, [{
  pairingCode: validRequest.pairingCode,
  idempotencyKey: 'pairing-route-test-0001',
  client: {
    schemaVersion: 2,
    installationId: validRequest.installationId,
    clientPublicKey: validRequest.clientPublicKey,
    clientKeyFingerprint: validRequest.clientKeyFingerprint,
  },
}])

const legacy = await route.POST(pairingRequest({
  pairingCode: validRequest.pairingCode,
}))
assert.equal(legacy.status, 426)
assert.equal(
  (await legacy.json()).code,
  'OPERATIONS_PRINT_AGENT_PAIRING_PROTOCOL_REQUIRED',
)
assert.equal(redeemCalls.length, 1)

const malformedKey = await route.POST(pairingRequest({
  ...validRequest,
  clientPublicKey: 'A'.repeat(58),
}))
assert.equal(malformedKey.status, 400)
assert.equal(
  (await malformedKey.json()).code,
  'OPERATIONS_PRINT_AGENT_PAIRING_CLIENT_INVALID',
)
assert.equal(redeemCalls.length, 1)

const browser = await route.POST(pairingRequest(validRequest, {
  origin: 'https://dev.aiapp.eigenracing.com',
  'sec-fetch-site': 'same-origin',
}))
assert.equal(browser.status, 403)
assert.equal(
  (await browser.json()).code,
  'OPERATIONS_PRINT_AGENT_INSTALLER_REQUIRED',
)
assert.equal(redeemCalls.length, 1)

console.log('Operation print-agent pairing contracts passed.')
