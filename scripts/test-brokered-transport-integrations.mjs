#!/usr/bin/env node
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const nodeRequire = createRequire(import.meta.url)
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')

const organizationId = '11111111-1111-4111-8111-111111111111'
const otherOrganizationId = '22222222-2222-4222-8222-222222222222'
const actorEmail = 'transport-operator@example.test'
const firstSecret = 'placeholder-wwex-secret-alpha-0001'
const secondSecret = 'placeholder-wwex-secret-bravo-0002'

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function plain(value) {
  return JSON.parse(JSON.stringify(value))
}

function loadTypeScriptModule(path, { mocks = {}, globals = {} } = {}) {
  const result = ts.transpileModule(read(path), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
    reportDiagnostics: true,
  })
  const errors = (result.diagnostics || []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  )
  assert.deepEqual(errors, [], `${path} must transpile`)
  const module = { exports: {} }
  const sandbox = {
    AbortController,
    AbortSignal,
    Buffer,
    Date,
    Error,
    Headers,
    JSON,
    Map,
    Object,
    Promise,
    Request,
    Response,
    Set,
    String,
    URL,
    URLSearchParams,
    clearTimeout,
    console,
    crypto,
    exports: module.exports,
    fetch,
    module,
    process,
    setTimeout,
    ...globals,
    require(specifier) {
      if (Object.prototype.hasOwnProperty.call(mocks, specifier)) {
        return mocks[specifier]
      }
      return nodeRequire(specifier)
    },
  }
  vm.runInNewContext(result.outputText, sandbox, { filename: path })
  return module.exports
}

function databaseCredentialFingerprint(version, ciphertext, iv, tag) {
  const encodedVersion = Buffer.alloc(4)
  encodedVersion.writeInt32BE(version)
  return crypto.createHash('sha256')
    .update(Buffer.concat([encodedVersion, ciphertext, iv, tag]))
    .digest('hex')
}

const originalEncryptionKey = process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY
process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY =
  'placeholder-transport-integration-test-key-0123456789abcdef'

const credentialCrypto = loadTypeScriptModule(
  'app_src/lib/integrations/brokeredTransportCredentialCrypto.ts',
)

const database = {
  account: null,
  credential: null,
  commandReceipts: [],
}
const auditEvents = []
const advisoryLocks = []
const credentialWrites = []
const verificationCalls = []
const activationLockQueries = []
let timestampSequence = 0

function timestamp() {
  timestampSequence += 1
  return new Date(Date.UTC(2026, 7, 11, 12, 0, timestampSequence))
}

function result(rows = []) {
  return { rows, rowCount: rows.length }
}

function selectedConnectionRow() {
  const account = database.account
  if (!account) return null
  const credential = database.credential
  return {
    id: account.id,
    global_id: account.globalId,
    provider: account.provider,
    environment: account.environment,
    display_name: account.displayName,
    status: account.status,
    configuration: account.configuration,
    credential_ciphertext: credential?.ciphertext ?? null,
    credential_iv: credential?.iv ?? null,
    credential_tag: credential?.tag ?? null,
    credential_version: credential?.version ?? null,
    credential_fingerprint: credential?.fingerprint ?? null,
    credential_kind: credential?.kind ?? null,
    credential_identifier_last_four: credential?.identifierLastFour ?? null,
    verification_status: credential?.verificationStatus ?? null,
    verified_at: credential?.verifiedAt ?? null,
    last_error_code: credential?.lastErrorCode ?? null,
    updated_at: credential?.updatedAt ?? account.updatedAt,
  }
}

async function databaseQuery(source, params = []) {
  if (source.includes('FOR UPDATE OF account, credential')) {
    const normalizedSource = source.replace(/\s+/g, ' ').trim()
    if (
      normalizedSource.includes(
        'LEFT JOIN operations_carrier_credentials credential',
      )
    ) {
      const error = new Error(
        'FOR UPDATE cannot be applied to the nullable side of an outer join',
      )
      error.code = '0A000'
      throw error
    }
    assert.match(
      normalizedSource,
      /FROM operations_integration_accounts account (?:INNER )?JOIN operations_carrier_credentials credential ON/,
      'Rate activation must use an inner credential join before locking both rows',
    )
    activationLockQueries.push(normalizedSource)
  }

  if (
    source.includes('FROM operations_command_receipts')
    && source.includes("command_type = 'update_brokered_transport_credential'")
  ) {
    const receipt = database.commandReceipts.find((entry) => (
      entry.organizationId === params[0]
      && entry.idempotencyKey === params[1]
    ))
    return receipt ? result([{
      id: receipt.id,
      request_hash: receipt.requestHash,
      status: receipt.status,
    }]) : result()
  }

  if (source.includes('INSERT INTO operations_command_receipts')) {
    const receipt = {
      id: `00000000-0000-4000-8000-${String(
        database.commandReceipts.length + 1,
      ).padStart(12, '0')}`,
      organizationId: params[0],
      idempotencyKey: params[1],
      requestHash: params[2],
      actorEmail: params[3],
      status: 'processing',
      resultGlobalId: null,
      resultPayload: null,
    }
    database.commandReceipts.push(receipt)
    return result([{ id: receipt.id }])
  }

  if (
    source.includes('UPDATE operations_command_receipts')
    && source.includes("SET status = 'succeeded'")
  ) {
    const receipt = database.commandReceipts.find((entry) => entry.id === params[0])
    assert.ok(receipt)
    receipt.status = 'succeeded'
    receipt.resultGlobalId = params[1]
    receipt.resultPayload = JSON.parse(params[2])
    return result()
  }

  if (source.includes('INSERT INTO operations_integration_accounts')) {
    const [organization, provider, environment, displayName, configuration] = params
    if (!database.account) {
      database.account = {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        globalId: 'gia0000001',
        organizationId: organization,
        provider,
        environment,
        displayName,
        status: 'disabled',
        configuration: JSON.parse(configuration),
        credentialReference: null,
        updatedAt: timestamp(),
      }
    } else {
      assert.equal(database.account.organizationId, organization)
      assert.equal(database.account.provider, provider)
      assert.equal(database.account.environment, environment)
      Object.assign(database.account, {
        displayName,
        status: 'disabled',
        configuration: JSON.parse(configuration),
        credentialReference: null,
        updatedAt: timestamp(),
      })
    }
    return result([{
      id: database.account.id,
      global_id: database.account.globalId,
    }])
  }

  if (source.includes('SELECT credential_version')) {
    if (
      database.credential
      && database.credential.organizationId === params[0]
      && database.credential.integrationAccountId === params[1]
    ) {
      return result([{ credential_version: database.credential.version }])
    }
    return result()
  }

  if (source.includes('INSERT INTO operations_carrier_credentials')) {
    credentialWrites.push({ source, params: [...params] })
    const [
      organization,
      integrationAccountId,
      ciphertext,
      iv,
      tag,
      version,
      identifierLastFour,
      kind,
    ] = params
    const fingerprint = databaseCredentialFingerprint(
      version,
      ciphertext,
      iv,
      tag,
    )
    database.credential = {
      organizationId: organization,
      integrationAccountId,
      ciphertext,
      iv,
      tag,
      version,
      fingerprint,
      kind,
      identifierLastFour,
      verificationStatus: 'unverified',
      verifiedAt: null,
      lastErrorCode: null,
      updatedAt: timestamp(),
    }
    return result()
  }

  if (source.includes('SET credential_reference = $3')) {
    assert.equal(database.account?.organizationId, params[0])
    assert.equal(database.account?.id, params[1])
    database.account.credentialReference = params[2]
    database.account.updatedAt = timestamp()
    return result()
  }

  if (
    source.includes("SET verification_status = 'verified'")
    && source.includes('operations_carrier_credentials')
  ) {
    assert.equal(database.credential?.organizationId, params[0])
    assert.equal(database.credential?.integrationAccountId, params[1])
    database.credential.verificationStatus = 'verified'
    database.credential.verifiedAt = new Date(params[2])
    database.credential.lastErrorCode = null
    database.credential.updatedAt = timestamp()
    return result()
  }

  if (
    source.includes("SET status = 'active', configuration = $3::jsonb")
    && source.includes('operations_integration_accounts')
  ) {
    assert.equal(database.account?.organizationId, params[0])
    assert.equal(database.account?.id, params[1])
    database.account.status = 'active'
    database.account.configuration = JSON.parse(params[2])
    database.account.updatedAt = timestamp()
    return result()
  }

  if (
    source.includes('SELECT id::text, global_id')
    && source.includes('FROM operations_integration_accounts')
    && source.includes('FOR UPDATE')
  ) {
    const account = database.account
    return account
      && account.organizationId === params[0]
      && account.provider === params[1]
      && account.environment === params[2]
      ? result([{ id: account.id, global_id: account.globalId }])
      : result()
  }

  if (source.includes('DELETE FROM operations_carrier_credentials')) {
    if (
      database.credential?.organizationId === params[0]
      && database.credential?.integrationAccountId === params[1]
    ) {
      database.credential = null
    }
    return result()
  }

  if (
    source.includes('UPDATE operations_integration_accounts')
    && source.includes("activationStatus\":\"pre_activation")
  ) {
    assert.equal(database.account?.organizationId, params[0])
    assert.equal(database.account?.id, params[1])
    Object.assign(database.account, {
      status: 'disabled',
      credentialReference: null,
      configuration: {
        ...database.account.configuration,
        allowedCapabilities: [],
        transportActivation: {
          small_parcel: { ratingEnabled: false, tenderEnabled: false },
          ltl: { ratingEnabled: false, tenderEnabled: false },
        },
        activationStatus: 'pre_activation',
      },
      updatedAt: timestamp(),
    })
    return result()
  }

  if (source.includes('FROM operations_integration_accounts account')) {
    const account = database.account
    if (!account || account.organizationId !== params[0]) return result()
    if (params.length >= 3) {
      if (account.provider !== params[1] || account.environment !== params[2]) {
        return result()
      }
      if (source.includes("account.status = 'active'") && account.status !== 'active') {
        return result()
      }
      if (
        source.includes("credential.verification_status = 'verified'")
        && database.credential?.verificationStatus !== 'verified'
      ) {
        return result()
      }
    }
    const row = selectedConnectionRow()
    return row ? result([row]) : result()
  }

  throw new Error(`Unexpected transport integration SQL: ${source}`)
}

const integrationService = loadTypeScriptModule(
  'app_src/lib/integrations/brokeredTransportIntegrations.ts',
  {
    mocks: {
      '@/lib/auditWriter': {
        async recordAuditEvent(event) {
          auditEvents.push(plain(event))
        },
      },
      '@/lib/integrations/brokeredTransportCredentialCrypto': credentialCrypto,
      '@/lib/integrations/wwexSpeedshipClient': {
        WwexSpeedshipClientError: class WwexSpeedshipClientError extends Error {},
        async verifyWwexSpeedshipRuntimeCredential(options) {
          verificationCalls.push({
            provider: 'wwex_speedship',
            credentialVersion: options.runtimeCredential.credentialVersion,
          })
          return {
            verificationType: 'oauth_client_credentials',
            completedAt: '2026-08-11T12:30:00.000Z',
            providerHttpStatus: 200,
          }
        },
      },
      '@/lib/integrations/rlCarriersFreightClient': {
        RlCarriersFreightClientError: class RlCarriersFreightClientError extends Error {},
        async verifyRlCarriersRuntimeCredential() {
          throw new Error('Unexpected R+L verification in WWEX fixture')
        },
      },
      '@/lib/persistence/postgres': {
        async acquireTransactionAdvisoryLock(_client, lockKey) {
          advisoryLocks.push(lockKey)
        },
        query: databaseQuery,
        async withTransaction(callback) {
          return callback({ query: databaseQuery })
        },
      },
    },
  },
)

const route = loadTypeScriptModule(
  'app_src/app/api/integrations/brokered-transport/route.ts',
  {
    mocks: {
      'next/server': {
        NextResponse: {
          json(payload, init) {
            return new Response(JSON.stringify(payload), {
              status: init.status,
              headers: {
                ...init.headers,
                'Content-Type': 'application/json',
              },
            })
          },
        },
      },
      '@/lib/integrations/brokeredTransportIntegrations': integrationService,
      '@/lib/operations/authorization': {
        operationsCapabilities() {
          return { canManage: true, canActivate: true }
        },
      },
      '@/lib/persistence/config': {
        isPostgresStorageEnabled() {
          return true
        },
      },
      '@/lib/requestUser': {
        async requireRequestUser() {
          return { email: actorEmail, organizationId }
        },
      },
      '@/lib/users': {},
    },
  },
)

function credential(secret) {
  return {
    authKind: 'oauth_client_credentials',
    clientId: 'placeholder-wwex-client-1234',
    clientSecret: secret,
    audience: 'placeholder-speedship-audience',
  }
}

function patchRequest(body, idempotencyKey) {
  return new Request(
    'https://clawpilot.example/api/integrations/brokered-transport',
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      body: JSON.stringify(body),
    },
  )
}

function assertSerializedStateIsSanitized(serialized, label, forbiddenValues = []) {
  for (const field of [
    'credentialCiphertext',
    'credential_ciphertext',
    'credentialFingerprint',
    'credential_fingerprint',
    'clientSecret',
    'apiKey',
  ]) {
    assert.ok(!serialized.includes(field), `${label} must not expose ${field}`)
  }
  for (const value of forbiddenValues) {
    assert.ok(!serialized.includes(value), `${label} must not expose a credential value`)
  }
}

const firstState = await integrationService.updateBrokeredTransportCredential({
  organizationId,
  provider: 'wwex_speedship',
  environment: 'sandbox',
  displayName: 'Worldwide Express sandbox',
  credential: credential(firstSecret),
  idempotencyKey: 'brokered-credential:first-write',
  actorEmail,
})
assert.equal(firstState.accounts.length, 1)
assert.equal(firstState.accounts[0].configured, true)
assert.equal(firstState.accounts[0].credentialVersion, 1)
assert.equal(firstState.accounts[0].status, 'disabled')
assert.equal(firstState.accounts[0].verificationStatus, 'unverified')
assert.deepEqual(plain(firstState.accounts[0].allowedCapabilities), [])
assert.ok(firstState.accounts[0].activationBlockers.includes(
  'credential_verification_required',
))
assert.equal(credentialWrites.length, 1)
assert.equal(
  credentialWrites[0].params.length,
  9,
  'The application write must not supply a credential fingerprint parameter',
)
assert.equal(
  database.credential.fingerprint,
  databaseCredentialFingerprint(
    1,
    database.credential.ciphertext,
    database.credential.iv,
    database.credential.tag,
  ),
  'The persisted fingerprint must be derived from the version and encrypted bytes',
)
const firstFingerprint = database.credential.fingerprint
assertSerializedStateIsSanitized(
  JSON.stringify(firstState),
  'Service update state',
  [firstSecret, firstFingerprint, database.credential.ciphertext.toString('hex')],
)

assert.equal(
  await integrationService.readActiveBrokeredTransportRuntimeCredential({
    organizationId,
    provider: 'wwex_speedship',
    environment: 'sandbox',
    capability: 'small_parcel_rate',
  }),
  null,
  'A disabled and unverified connection must not yield a runtime credential',
)

const missingIdempotencyResponse = await route.PATCH(patchRequest({
  action: 'update-credential',
  provider: 'wwex_speedship',
  environment: 'sandbox',
  displayName: 'Worldwide Express sandbox',
  credential: credential(secondSecret),
}))
assert.equal(missingIdempotencyResponse.status, 400)
assert.equal(
  (await missingIdempotencyResponse.json()).code,
  'TRANSPORT_IDEMPOTENCY_KEY_REQUIRED',
)
assert.equal(database.credential.version, 1)
assert.equal(credentialWrites.length, 1)

const rotateIdempotencyKey = 'brokered-credential:second-write'
const rotateResponse = await route.PATCH(patchRequest({
  action: 'update-credential',
  provider: 'wwex_speedship',
  environment: 'sandbox',
  displayName: 'Worldwide Express sandbox',
  credential: credential(secondSecret),
}, rotateIdempotencyKey))
assert.equal(rotateResponse.status, 200)
assert.equal(rotateResponse.headers.get('cache-control'), 'no-store, max-age=0')
const rotateSerialized = await rotateResponse.text()
const rotatePayload = JSON.parse(rotateSerialized)
assert.equal(rotatePayload.integrations.accounts[0].credentialVersion, 2)
assert.equal(database.credential.version, 2)
assert.match(database.credential.fingerprint, /^[a-f0-9]{64}$/)
assert.notEqual(database.credential.fingerprint, firstFingerprint)
assert.equal(
  database.credential.fingerprint,
  databaseCredentialFingerprint(
    2,
    database.credential.ciphertext,
    database.credential.iv,
    database.credential.tag,
  ),
  'Rotation must use the database-derived fingerprint for the new version',
)
assert.equal(credentialWrites.length, 2)
assert.equal(credentialWrites[1].params.length, 9)
assert.match(
  credentialWrites[1].source,
  /credential_fingerprint\s*=\s*EXCLUDED\.credential_fingerprint/,
  'Rotation must carry the BEFORE INSERT derived fingerprint into the update row',
)
assert.deepEqual(
  auditEvents.map((event) => event.eventType),
  ['transport.credential.connected', 'transport.credential.rotated'],
)
assertSerializedStateIsSanitized(
  rotateSerialized,
  'Route rotation response',
  [
    firstSecret,
    secondSecret,
    firstFingerprint,
    database.credential.fingerprint,
    database.credential.ciphertext.toString('hex'),
  ],
)

const replayResponse = await route.PATCH(patchRequest({
  action: 'update-credential',
  provider: 'wwex_speedship',
  environment: 'sandbox',
  displayName: 'Worldwide Express sandbox',
  credential: credential(secondSecret),
}, rotateIdempotencyKey))
assert.equal(replayResponse.status, 200)
assert.equal((await replayResponse.json()).integrations.accounts[0].credentialVersion, 2)
assert.equal(database.credential.version, 2)
assert.equal(credentialWrites.length, 2)
assert.deepEqual(
  auditEvents.map((event) => event.eventType),
  ['transport.credential.connected', 'transport.credential.rotated'],
)

const conflictResponse = await route.PATCH(patchRequest({
  action: 'update-credential',
  provider: 'wwex_speedship',
  environment: 'sandbox',
  displayName: 'Worldwide Express sandbox',
  credential: credential('different-command-secret-value'),
}, rotateIdempotencyKey))
assert.equal(conflictResponse.status, 409)
assert.equal((await conflictResponse.json()).code, 'TRANSPORT_IDEMPOTENCY_CONFLICT')
assert.equal(database.credential.version, 2)
assert.equal(credentialWrites.length, 2)

// Model an LTL activation committed by another capability tab. The stale
// Small Parcel command below intentionally submits only its target mode; the
// locked server row must preserve LTL instead of trusting browser state.
database.account.status = 'active'
database.credential.verificationStatus = 'verified'
database.credential.verifiedAt = timestamp()
database.account.configuration.allowedCapabilities = ['ltl_rate']
database.account.configuration.transportActivation = {
  small_parcel: { ratingEnabled: false, tenderEnabled: false },
  ltl: { ratingEnabled: true, tenderEnabled: false },
}
database.account.configuration.activationStatus = 'active'
database.account.configuration.activationBlockers = []

const activationResponse = await route.PATCH(patchRequest({
  action: 'verify-and-activate-rates',
  provider: 'wwex_speedship',
  environment: 'sandbox',
  ratingModes: ['small_parcel'],
}))
assert.equal(activationResponse.status, 200)
assert.equal(
  activationLockQueries.length,
  1,
  'Successful rate activation must execute one PostgreSQL-safe account and credential lock',
)
const activationSerialized = await activationResponse.text()
const activationPayload = JSON.parse(activationSerialized)
assert.equal(verificationCalls.length, 1)
assert.deepEqual(verificationCalls[0], {
  provider: 'wwex_speedship',
  credentialVersion: 2,
})
assert.equal(activationPayload.integrations.accounts[0].status, 'active')
assert.equal(activationPayload.integrations.accounts[0].verificationStatus, 'verified')
assert.deepEqual(
  activationPayload.integrations.accounts[0].ratingActivation,
  { smallParcel: true, ltl: true },
)
assert.deepEqual(
  activationPayload.integrations.accounts[0].allowedCapabilities,
  ['small_parcel_rate', 'ltl_rate'],
)
assert.deepEqual(activationPayload.integrations.accounts[0].activationBlockers, [])
const activationAudit = auditEvents.at(-1)
assert.deepEqual(plain(activationAudit.payload.requestedRatingModes), ['small_parcel'])
assert.deepEqual(
  plain(activationAudit.payload.ratingModes),
  ['small_parcel', 'ltl'],
  'Server-side activation must monotonically preserve the other locked WWEX mode',
)
assert.ok(
  activationPayload.integrations.accounts[0].tenderActivationBlockers
    .includes('one_off_tender_orchestration_required'),
)
assertSerializedStateIsSanitized(
  activationSerialized,
  'Rate activation response',
  [secondSecret, database.credential.fingerprint],
)

const activatedRuntime = await integrationService
  .readActiveBrokeredTransportRuntimeCredential({
    organizationId,
    provider: 'wwex_speedship',
    environment: 'sandbox',
    capability: 'small_parcel_rate',
  })
assert.equal(activatedRuntime.credentialVersion, 2)

database.account.status = 'active'
database.credential.verificationStatus = 'unverified'
database.account.configuration.allowedCapabilities = []
database.account.configuration.transportActivation = {
  small_parcel: { ratingEnabled: false, tenderEnabled: false },
  ltl: { ratingEnabled: false, tenderEnabled: false },
}
database.account.configuration.activationStatus = 'pre_activation'
database.account.configuration.activationBlockers = ['credential_verification_required']

database.account.status = 'active'
assert.equal(
  await integrationService.readActiveBrokeredTransportRuntimeCredential({
    organizationId,
    provider: 'wwex_speedship',
    environment: 'sandbox',
    capability: 'small_parcel_rate',
  }),
  null,
  'An unverified credential must be denied even when the account is active',
)

database.credential.verificationStatus = 'verified'
database.credential.verifiedAt = timestamp()
assert.equal(
  await integrationService.readActiveBrokeredTransportRuntimeCredential({
    organizationId,
    provider: 'wwex_speedship',
    environment: 'sandbox',
    capability: 'small_parcel_rate',
  }),
  null,
  'A missing capability grant must deny runtime access',
)

database.account.configuration.allowedCapabilities = ['small_parcel_rate']
assert.equal(
  await integrationService.readActiveBrokeredTransportRuntimeCredential({
    organizationId,
    provider: 'wwex_speedship',
    environment: 'sandbox',
    capability: 'small_parcel_rate',
  }),
  null,
  'A disabled mode activation must deny runtime access',
)

database.account.configuration.transportActivation.small_parcel.ratingEnabled = true
assert.equal(
  await integrationService.readActiveBrokeredTransportRuntimeCredential({
    organizationId,
    provider: 'wwex_speedship',
    environment: 'sandbox',
    capability: 'small_parcel_rate',
  }),
  null,
  'Pre-activation status must deny runtime access',
)

database.account.configuration.activationStatus = 'active'
database.account.configuration.activationBlockers = ['operator_release_required']
assert.equal(
  await integrationService.readActiveBrokeredTransportRuntimeCredential({
    organizationId,
    provider: 'wwex_speedship',
    environment: 'sandbox',
    capability: 'small_parcel_rate',
  }),
  null,
  'Any activation blocker must deny runtime access',
)

database.account.configuration.activationBlockers = []
const activeRuntime = await integrationService
  .readActiveBrokeredTransportRuntimeCredential({
    organizationId,
    provider: 'wwex_speedship',
    environment: 'sandbox',
    capability: 'small_parcel_rate',
  })
assert.equal(activeRuntime.credentialVersion, 2)
assert.equal(activeRuntime.credentialFingerprint, database.credential.fingerprint)
assert.deepEqual(plain(activeRuntime.credential), credential(secondSecret))

database.account.configuration.allowedCapabilities.push('ltl_bol')
database.account.configuration.transportActivation.ltl.tenderEnabled = true
assert.equal(
  await integrationService.readActiveBrokeredTransportRuntimeCredential({
    organizationId,
    provider: 'wwex_speedship',
    environment: 'sandbox',
    capability: 'ltl_bol',
  }),
  null,
  'Configuration must not grant a capability unsupported by the provider',
)

const originalAccountScope = {
  organizationId: database.account.organizationId,
  provider: database.account.provider,
  environment: database.account.environment,
}
const originalCredentialOrganization = database.credential.organizationId
database.account.organizationId = otherOrganizationId
database.credential.organizationId = otherOrganizationId
await assert.rejects(
  integrationService.readActiveBrokeredTransportRuntimeCredential({
    organizationId: otherOrganizationId,
    provider: 'wwex_speedship',
    environment: 'sandbox',
    capability: 'small_parcel_rate',
  }),
  /could not be decrypted/,
  'Runtime decryption must remain bound to the credential organization',
)
database.account.organizationId = originalAccountScope.organizationId
database.credential.organizationId = originalCredentialOrganization

database.account.provider = 'wwex_speedship'
database.account.environment = 'production'
await assert.rejects(
  integrationService.readActiveBrokeredTransportRuntimeCredential({
    organizationId,
    provider: 'wwex_speedship',
    environment: 'production',
    capability: 'small_parcel_rate',
  }),
  /could not be decrypted/,
  'Runtime decryption must remain bound to the credential environment',
)
database.account.provider = originalAccountScope.provider
database.account.environment = originalAccountScope.environment

database.account.provider = 'rl_carriers'
database.account.environment = 'production'
database.account.configuration.allowedCapabilities = ['ltl_rate']
database.account.configuration.transportActivation.ltl.ratingEnabled = true
await assert.rejects(
  integrationService.readActiveBrokeredTransportRuntimeCredential({
    organizationId,
    provider: 'rl_carriers',
    environment: 'production',
    capability: 'ltl_rate',
  }),
  /could not be decrypted/,
  'Runtime decryption must remain bound to the credential provider',
)
database.account.provider = originalAccountScope.provider
database.account.environment = originalAccountScope.environment
database.account.configuration.allowedCapabilities = ['small_parcel_rate']
database.account.configuration.transportActivation.ltl.ratingEnabled = false

const getResponse = await route.GET(new Request(
  'https://clawpilot.example/api/integrations/brokered-transport',
))
assert.equal(getResponse.status, 200)
const getSerialized = await getResponse.text()
assertSerializedStateIsSanitized(
  getSerialized,
  'Route read response',
  [
    firstSecret,
    secondSecret,
    firstFingerprint,
    database.credential.fingerprint,
    database.credential.ciphertext.toString('hex'),
  ],
)

const disconnectResponse = await route.PATCH(patchRequest({
  action: 'disconnect',
  provider: 'wwex_speedship',
  environment: 'sandbox',
}))
assert.equal(disconnectResponse.status, 200)
const disconnectSerialized = await disconnectResponse.text()
const disconnectPayload = JSON.parse(disconnectSerialized)
assert.equal(disconnectPayload.integrations.accounts[0].configured, false)
assert.equal(disconnectPayload.integrations.accounts[0].credentialVersion, 0)
assert.equal(disconnectPayload.integrations.accounts[0].verificationStatus, 'unverified')
assert.ok(disconnectPayload.integrations.accounts[0].activationBlockers.includes(
  'credentials_required',
))
assert.equal(database.credential, null)
assert.equal(database.account.status, 'disabled')
assert.equal(database.account.credentialReference, null)
assert.deepEqual(
  auditEvents.map((event) => event.eventType),
  [
    'transport.credential.connected',
    'transport.credential.rotated',
    'transport.rating.activated',
    'transport.credential.disconnected',
  ],
)
assert.equal(
  await integrationService.readActiveBrokeredTransportRuntimeCredential({
    organizationId,
    provider: 'wwex_speedship',
    environment: 'sandbox',
    capability: 'small_parcel_rate',
  }),
  null,
)
assertSerializedStateIsSanitized(
  disconnectSerialized,
  'Route disconnect response',
  [firstSecret, secondSecret, firstFingerprint],
)
assert.deepEqual(advisoryLocks, [
  `brokered-transport:${organizationId}:wwex_speedship:sandbox`,
  `brokered-transport:${organizationId}:wwex_speedship:sandbox`,
  `brokered-transport:${organizationId}:wwex_speedship:sandbox`,
  `brokered-transport:${organizationId}:wwex_speedship:sandbox`,
  `brokered-transport:${organizationId}:wwex_speedship:sandbox`,
  `brokered-transport:${organizationId}:wwex_speedship:sandbox`,
])

if (originalEncryptionKey === undefined) {
  delete process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY
} else {
  process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY = originalEncryptionKey
}

console.log('Brokered transport integration credential tests passed')
