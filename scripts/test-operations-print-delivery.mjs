#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const { Pool } = requireFromApp('pg')
const ts = requireFromApp('typescript')

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function compactSql(source) {
  return source
    .replace(/--.*$/gm, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .trim()
}

function command(commandName, args, options = {}) {
  const result = spawnSync(commandName, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: options.timeout || 30_000,
    env: { ...process.env, ...options.env },
  })
  if (result.error || result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    throw result.error || new Error(
      `${commandName} ${args.join(' ')} failed${detail ? `:\n${detail}` : ''}`,
    )
  }
  return String(result.stdout || '').trim()
}

async function waitForPostgres(connectionString) {
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 2_000 })
  const deadline = Date.now() + 60_000
  let lastError
  try {
    while (Date.now() < deadline) {
      try {
        await pool.query('SELECT 1')
        return
      } catch (error) {
        lastError = error
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 500))
      }
    }
  } finally {
    await pool.end().catch(() => undefined)
  }
  throw lastError || new Error('Disposable PostgreSQL did not become ready')
}

async function expectRejected(work, pattern, message) {
  let error
  try {
    await work()
  } catch (caught) {
    error = caught
  }
  assert.ok(error, message)
  if (pattern) assert.match(String(error.message || error), pattern, message)
}

function loadPersistenceHelpers() {
  const path = 'app_src/lib/persistence/operationPrintDelivery.ts'
  const output = ts.transpileModule(read(path), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
  }).outputText
  const module = { exports: {} }
  class RequestError extends Error {
    constructor(code, message, status = 400) {
      super(message)
      this.code = code
      this.status = status
    }
  }
  const localRequire = (specifier) => {
    if (specifier === 'crypto' || specifier === 'node:crypto') {
      return requireFromApp(specifier)
    }
    if (specifier === '@/lib/auditWriter') {
      return { recordAuditEvent: async () => undefined }
    }
    if (specifier === '@/lib/integrations/carrierManagedDelegation') {
      return {
        carrierConfigurationAllowsSandboxLabel: () => true,
        isSourceManagedCarrierConfiguration: () => false,
        managedCarrierDelegationProfile: () => null,
      }
    }
    if (specifier === '@/lib/operations/printing') return {}
    if (specifier === '@/lib/persistence/operationPrinting') return {}
    if (specifier === '@/lib/persistence/operations') {
      return { OperationsRequestError: RequestError }
    }
    if (specifier === '@/lib/persistence/postgres') {
      return {
        acquireTransactionAdvisoryLock: async () => undefined,
        query: async () => ({ rows: [] }),
        withTransaction: async (work) => work({ query: async () => ({ rows: [] }) }),
      }
    }
    throw new Error(`Unexpected persistence test import: ${specifier}`)
  }
  vm.runInNewContext(output, {
    Buffer,
    URL,
    console,
    exports: module.exports,
    module,
    require: localRequire,
  }, { filename: path })
  return module.exports
}

function verifySourceContracts() {
  const migrationSource = read('db/migrations/0094_operations_print_delivery.sql')
  const migration = compactSql(migrationSource)
  for (const fragment of [
    'ALTER TABLE operations_printers',
    'ALTER TABLE operations_print_jobs',
    'CREATE TABLE IF NOT EXISTS operations_print_agents',
    'secret_hash text NOT NULL',
    "CHECK (secret_hash ~ '^[a-f0-9]{64}$')",
    'CREATE TABLE IF NOT EXISTS operations_print_artifacts',
    "document_type IN ('shipping_label', 'packing_slip')",
    "media_size IN ('label_4x6', 'label_4x8', 'letter', 'a4')",
    'source_order_id uuid',
    'source_shipment_id uuid',
    'operations_print_artifacts_source_order_fkey',
    'operations_print_artifacts_source_shipment_fkey',
    'Rendered print artifacts are immutable',
    'CREATE TABLE IF NOT EXISTS operations_print_delivery_attempts',
    "state IN ('queued', 'claimed', 'delivered', 'failed', 'cancelled', 'rerouted')",
    'idx_operations_print_jobs_original_label_unique',
    'request_fingerprint text NOT NULL',
    'validate_operations_print_delivery_transition',
    'protect_operations_print_delivery_attempt_write',
    'local_agent_acknowledgement',
    'physical_output_verified = false',
    'browser printing is not delivery evidence',
    'fallback must have compatible document, media, and format capabilities',
    "printer_type IN ('thermal', 'nonthermal')",
  ]) {
    assert.ok(
      migration.includes(fragment),
      `Missing print-delivery SQL contract: ${fragment}`,
    )
  }

  const privacyMigrationSource = read(
    'db/migrations/0284_operations_print_device_reference_privacy.sql',
  )
  const privacyMigration = compactSql(privacyMigrationSource)
  for (const fragment of [
    'normalize_operations_print_delivery_device_reference()',
    'normalize_operations_print_delivery_device_reference_write',
    "NEW.device_job_reference := 'local-device.legacy.v1.redacted'",
    "'^local-device[.]v1[.][A-Za-z0-9_-]{43}$'",
    'DISABLE TRIGGER protect_operations_print_delivery_attempt_write',
    "SET device_job_reference = 'local-device.legacy.v1.redacted'",
    'WHERE device_job_reference IS NOT NULL AND NOT',
    'ENABLE TRIGGER protect_operations_print_delivery_attempt_write',
    "to_regprocedure('protect_operations_append_only()')",
    "trigger_row.tgenabled = 'O'",
    'trigger_row.tgtype = 27',
    'trigger_row.tgtype = 7',
    'legacy raw local printer references remain after privacy remediation',
  ]) {
    assert.ok(
      privacyMigration.includes(fragment),
      `Missing print-device privacy migration contract: ${fragment}`,
    )
  }
  assert.doesNotMatch(
    privacyMigrationSource,
    /(?:DROP\s+TRIGGER\s+protect_operations_print_delivery_attempt_write|DISABLE\s+TRIGGER\s+(?:ALL|USER))/i,
    'Privacy migration must disable only the exact append-only guard',
  )
  const privacyUpdate = privacyMigration.match(
    /UPDATE operations_print_delivery_attempts SET (.*?) WHERE device_job_reference/,
  )
  assert.equal(
    privacyUpdate?.[1],
    "device_job_reference = 'local-device.legacy.v1.redacted'",
    'Privacy migration must update only device_job_reference',
  )

  const healthRoute = read('app_src/app/api/health/route.ts')
  for (const fragment of [
    '0284_operations_print_device_reference_privacy.sql',
    'operations_print_device_reference_privacy_applied',
    'protect_operations_print_delivery_attempt_write',
    "to_regprocedure('protect_operations_append_only()')",
    "print_delivery_guard.tgenabled = 'O'",
    'print_delivery_guard.tgtype = 27',
    "'normalize_operations_print_delivery_device_reference()'",
    'normalize_operations_print_delivery_device_reference_write',
    "print_device_reference_guard.tgenabled = 'O'",
    'print_device_reference_guard.tgtype = 7',
    '&& row?.operations_print_device_reference_privacy_applied',
    '|| !row?.operations_print_device_reference_privacy_applied',
  ]) {
    assert.ok(
      healthRoute.includes(fragment),
      `Missing print-device privacy health contract: ${fragment}`,
    )
  }
  assert.ok(
    (healthRoute.match(/operations_print_device_reference_privacy_applied/g) || [])
      .length >= 4,
    'Privacy migration must gate query typing, SQL, migrationsCurrent, and health errors',
  )
  assert.ok(
    read('scripts/verify-predeploy.mjs').includes(
      'db/migrations/0284_operations_print_device_reference_privacy.sql',
    ),
    'Predeploy must require the print-device privacy migration',
  )
  assert.ok(
    !/CREATE TABLE(?: IF NOT EXISTS)? operations_printer_profiles/i.test(migrationSource),
    'Migration must extend operations_printers rather than duplicate printer profiles',
  )
  assert.ok(
    !/CREATE TABLE(?: IF NOT EXISTS)? operations_print_jobs/i.test(migrationSource),
    'Migration must extend operations_print_jobs rather than duplicate print jobs',
  )
  assert.ok(
    !/\b(?:plaintext_secret|secret_plaintext|enrollment_secret)\b/i.test(migrationSource),
    'Migration must not persist a plaintext enrollment secret',
  )
  const capabilityMigration = compactSql(
    read('db/migrations/0117_operations_print_agent_capabilities.sql'),
  )
  for (const fragment of [
    "supported_formats text[] NOT NULL DEFAULT ARRAY['ZPL']::text[]",
    "supported_media text[] NOT NULL DEFAULT ARRAY['label_4x6']::text[]",
    "supported_document_types text[] NOT NULL DEFAULT ARRAY['shipping_label']::text[]",
    'enforce_operations_print_agent_capabilities',
    'Printer capabilities must be a subset of its local print agent capabilities',
    "supported_formats = ARRAY['ZPL']::text[]",
    "supported_media = ARRAY['label_4x6']::text[]",
    "supported_document_types = ARRAY['shipping_label']::text[]",
    "printer_type = 'thermal'",
  ]) {
    assert.ok(
      capabilityMigration.includes(fragment),
      `Missing print-agent capability SQL contract: ${fragment}`,
    )
  }

  const persistence = read('app_src/lib/persistence/operationPrintDelivery.ts')
  for (const fragment of [
    'createOperationsPrintAgentCredential',
    'hashOperationsPrintAgentSecret',
    'timingSafeEqual',
    'enrollOperationsPrintAgentInPostgres',
    'authenticateOperationsPrintAgentInPostgres',
    'enqueueOperationsPrintJobInPostgres',
    'claimOperationsPrintJobsInPostgres',
    'acknowledgeOperationsPrintJobInPostgres',
    'failOperationsPrintJobInPostgres',
    'retryOperationsPrintJobInPostgres',
    'cancelOperationsPrintJobInPostgres',
    'reprintOperationsPrintJobInPostgres',
    'assertShippingLabelCanBeEnqueued',
    'rerouteUnavailableQueuedJobs',
    'OPERATIONS_PRINT_LABEL_ALREADY_ENQUEUED',
    'PRINT_ROUTE_UNAVAILABLE',
    'operations:print-attempt:',
    'operations:print-agent-rotation:',
    'OPERATIONS_PRINT_REPRINT_LABEL_INACTIVE',
    'request_fingerprint',
    'FOR UPDATE OF job SKIP LOCKED',
    'LEASE_EXPIRED',
    'physicalOutputVerified: false',
    'artifact.content_sha256 AS artifact_content_sha256',
    'COALESCE(source_label.environment, rate_test_label.environment)',
    'source_package.length_mm AS package_length_mm',
    "NULLIF(source_order.ship_to->>'name', '') AS ship_to_name",
    'warehouse.name AS warehouse_name',
    "type: 'rate_test_label'",
    'sourceRateTestLabelGlobalId',
    'decodeStoredOperationsLabelPayload',
    'strictBase64Bytes',
    'rate_test_label.label_payload AS rate_test_label_payload',
    'cancelVoidedRateTestLabelJobs',
    'cancelUnauthorizedRateTestLabelJobs',
    'assertRateTestLabelPrintCapability',
    'carrierConfigurationAllowsSandboxLabel',
    'sandbox_label_revoked',
    "jsonb_typeof(connection.configuration->'allowedCapabilities')",
    'rate_test_label.integration_account_id::text',
    "'sandbox_label'",
    'artifact.source_rate_test_label_id IS NULL',
    'original.rate_test_label_id',
    'OPERATIONS_PRINT_ARTIFACT_CORRUPT',
    'OPERATIONS_PRINT_AGENT_CAPABILITIES_MISMATCH',
    'artifact.format = ANY($5::text[])',
    'runtimeSupportedFormats',
    "type: 'packing_slip_artifact'",
    'sourceArtifactGlobalId',
    'assertPackingSlipArtifactCanBeEnqueued',
    'OPERATIONS_PRINT_PACKING_SLIP_ALREADY_ENQUEUED',
    'Pack Work Instruction content failed integrity validation',
  ]) {
    assert.ok(
      persistence.includes(fragment),
      `Missing print-delivery persistence contract: ${fragment}`,
    )
  }
  assert.ok(
    (persistence.match(/assertRateTestLabelPrintCapability\(/g) || []).length >= 5,
    'Enqueue, claim, claim replay, retry, and reprint must recheck sandbox-label capability',
  )
  assert.ok(
    !/\b(?:createLabel|purchaseLabel|buyLabel|carrierClient)\s*\(/.test(persistence),
    'Print delivery persistence must not purchase labels or call carrier APIs',
  )

  const agentRoute = read('app_src/app/api/operations/print-agent/jobs/route.ts')
  for (const fragment of [
    "action === 'claim'",
    "action === 'acknowledge'",
    'failOperationsPrintJobInPostgres',
    'authenticateOperationsPrintAgentInPostgres',
    'Idempotency-Key',
    'Cache-Control',
    'runtimeCapabilities',
  ]) {
    assert.ok(agentRoute.includes(fragment), `Missing print-agent route contract: ${fragment}`)
  }
  const operatorRoute = read('app_src/app/api/operations/print-jobs/route.ts')
  for (const fragment of [
    "command.action === 'retry-job'",
    "command.action === 'cancel-job'",
    "command.action === 'reprint-job'",
    'requireRequestUser',
    'Idempotency-Key',
    'private, no-store',
    "command.action === 'enqueue-packing-slip-artifact'",
    "type: 'packing_slip_artifact'",
  ]) {
    assert.ok(operatorRoute.includes(fragment), `Missing print-job route contract: ${fragment}`)
  }
  const panel = read('app_src/components/operations/PrinterConfigurationPanel.tsx')
  for (const fragment of [
    'Print job details',
    'Agent heartbeat',
    'Last device delivery',
    'Destination and package',
    'Routing and device',
    'Document integrity',
    'Lifecycle and lineage',
    'Delivery history',
  ]) {
    assert.ok(panel.includes(fragment), `Missing print-job detail contract: ${fragment}`)
  }
  const managementRoute = read('app_src/app/api/operations/print-agents/route.ts')
  for (const fragment of [
    "command.action === 'enroll-agent'",
    "command.action === 'rotate-credential'",
    "command.action === 'revoke-agent'",
    'requireRequestUser',
    'supportedFormats',
    'supportedMedia',
    'supportedDocumentTypes',
    'DEFAULT_PRINT_AGENT_CAPABILITIES',
  ]) {
    assert.ok(managementRoute.includes(fragment), `Missing print-agent management contract: ${fragment}`)
  }

  const helpers = loadPersistenceHelpers()
  const first = helpers.createOperationsPrintAgentCredential()
  const second = helpers.createOperationsPrintAgentCredential()
  assert.match(
    first.credential,
    /^cpprint\.v1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/i,
  )
  assert.match(first.secretHash, /^[a-f0-9]{64}$/)
  assert.notEqual(first.credential, second.credential)
  const credentialParts = first.credential.split('.')
  assert.equal(
    helpers.hashOperationsPrintAgentSecret(first.agentId, credentialParts[3]),
    first.secretHash,
  )
  assert.equal(
    helpers.operationsPrintDeliveryFingerprint({ b: 2, a: 1 }),
    helpers.operationsPrintDeliveryFingerprint({ a: 1, b: 2 }),
    'Request fingerprints must be independent of object key order',
  )
  const opaqueDeviceReference = `local-device.v1.${'A'.repeat(43)}`
  assert.equal(
    helpers.normalizeOperationsLocalDeviceReference(
      opaqueDeviceReference,
    ),
    opaqueDeviceReference,
    'Current opaque local-device references must remain stable',
  )
  const legacyDeviceReference = helpers.normalizeOperationsLocalDeviceReference(
    '192.168.4.146:9100',
  )
  assert.equal(legacyDeviceReference, 'local-device.legacy.v1.redacted')
  assert.doesNotMatch(legacyDeviceReference, /192\.168\.4\.146|9100/)
  assert.equal(
    legacyDeviceReference,
    helpers.normalizeOperationsLocalDeviceReference(
      '192.168.4.146:9100',
    ),
    'Legacy endpoint redaction must never retain a correlatable endpoint fingerprint',
  )
  assert.equal(
    legacyDeviceReference,
    helpers.normalizeOperationsLocalDeviceReference(
      '192.168.4.146:9100',
    ),
    'Legacy endpoint redaction must be constant across agents',
  )

  const rawZpl = '^XA\n^FO20,20^FDClawPilot^FS\n^XZ'
  const legacyBase64Zpl = Buffer.from(rawZpl, 'utf8').toString('base64')
  assert.equal(
    Buffer.from(helpers.decodeStoredOperationsLabelPayload({
      format: 'ZPL',
      payload: rawZpl,
    })).toString('utf8'),
    rawZpl,
    'Canonical UTF-8 ZPL must remain unchanged',
  )
  assert.equal(
    Buffer.from(helpers.decodeStoredOperationsLabelPayload({
      format: 'ZPL',
      payload: legacyBase64Zpl,
    })).toString('utf8'),
    rawZpl,
    'Legacy base64-encoded ZPL must decode before artifact hashing and delivery',
  )

  const pdf = Buffer.from('%PDF-1.7\nClawPilot\n%%EOF\n', 'ascii')
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('ClawPilot', 'ascii'),
  ])
  for (const [format, bytes] of [['PDF', pdf], ['PNG', png]]) {
    const decoded = helpers.decodeStoredOperationsLabelPayload({
      format,
      payload: bytes.toString('base64'),
    })
    assert.equal(Buffer.from(decoded).toString('hex'), bytes.toString('hex'))
    const claim = helpers.encodeOperationsPrintClaimPayload({
      format,
      rateTestLabelPayload: bytes,
      labelPayload: null,
      artifactPayload: null,
    })
    assert.equal(claim.encoding, 'base64')
    assert.equal(claim.inlinePayload, bytes.toString('base64'))
  }
  const zplClaim = helpers.encodeOperationsPrintClaimPayload({
    format: 'ZPL',
    rateTestLabelPayload: Buffer.from(rawZpl, 'utf8'),
    labelPayload: null,
    artifactPayload: null,
  })
  assert.equal(zplClaim.encoding, 'utf8')
  assert.equal(zplClaim.inlinePayload, rawZpl)

  assert.throws(
    () => helpers.decodeStoredOperationsLabelPayload({
      format: 'ZPL',
      payload: Buffer.from('not-zpl', 'utf8').toString('base64'),
    }),
    /declared format/,
    'Base64 text that does not decode to a ZPL envelope must fail closed',
  )
  assert.throws(
    () => helpers.decodeStoredOperationsLabelPayload({
      format: 'PDF',
      payload: legacyBase64Zpl,
    }),
    /declared format/,
    'A payload signature mismatch must fail closed',
  )
  assert.throws(
    () => helpers.encodeOperationsPrintClaimPayload({
      format: 'PNG',
      rateTestLabelPayload: pdf,
      labelPayload: null,
      artifactPayload: null,
    }),
    /declared format/,
    'Stored rate-test bytes must match the declared format before delivery',
  )
}

function verifyOwnedTypeContracts() {
  const configPath = resolve(root, 'app_src', 'tsconfig.json')
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  assert.equal(config.error, undefined, 'Unable to read app TypeScript configuration')
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    resolve(root, 'app_src'),
    { incremental: false, noEmit: true },
    configPath,
  )
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
  })
  const ownedSuffixes = [
    '/app_src/lib/operations/printing.ts',
    '/app_src/lib/persistence/operationPrinting.ts',
    '/app_src/lib/persistence/operationPrintDelivery.ts',
    '/app_src/components/operations/PrinterConfigurationPanel.tsx',
    '/app_src/app/api/operations/printers/route.ts',
    '/app_src/app/api/operations/print-agent/jobs/route.ts',
    '/app_src/app/api/operations/print-agents/route.ts',
    '/app_src/app/api/operations/print-jobs/route.ts',
  ]
  const diagnostics = ts.getPreEmitDiagnostics(program).filter((diagnostic) => (
    diagnostic.file
    && ownedSuffixes.some((suffix) => diagnostic.file.fileName.endsWith(suffix))
  ))
  assert.equal(
    diagnostics.length,
    0,
    diagnostics.map((diagnostic) => (
      ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
    )).join('\n'),
  )
  assert.equal(
    existsSync(resolve(root, 'app_src/lib/persistence/operationsPrintDelivery.ts')),
    false,
    'Superseded plural print-delivery persistence must be removed',
  )
  assert.equal(
    existsSync(resolve(root, 'app_src/app/api/operations/print-delivery/route.ts')),
    false,
    'Superseded aggregate print-delivery route must be removed',
  )
}

async function insertReturning(pool, sql, params = []) {
  const result = await pool.query(sql, params)
  assert.equal(result.rowCount, 1)
  return result.rows[0]
}

async function createPrinter(pool, fixture, input) {
  return insertReturning(
    pool,
    `INSERT INTO operations_printers (
       organization_id, warehouse_id, code, name, station_type,
       supports_zpl, priority, status, created_by,
       printer_type, connection_mode, supported_formats, supported_media,
       supported_document_types, default_document_types,
       fallback_printer_id, local_print_agent_id
     ) VALUES (
       $1, $2, $3, $4, $5,
       $6, $7, $8, $9,
       $10, $11, $12::text[], $13::text[],
       $14::text[], $15::text[],
       $16, $17
     )
     RETURNING id, global_id`,
    [
      fixture.organizationId,
      fixture.warehouseId,
      input.code,
      input.name,
      input.stationType,
      input.formats.includes('ZPL'),
      input.priority || 100,
      input.status || 'online',
      fixture.actorEmail,
      input.printerType,
      input.connectionMode || 'local_agent',
      input.formats,
      input.media,
      input.documents,
      input.defaults || [],
      input.fallbackId || null,
      input.agentId === undefined ? fixture.agentId : input.agentId,
    ],
  )
}

async function seedPrintSource(pool, fixture) {
  const pipeline = await insertReturning(
    pool,
    `INSERT INTO pipeline_spaces (
       name, owner_email, workspace_organization_id
     ) VALUES ($1, $2, $3)
     RETURNING id`,
    [`Print delivery ${fixture.suffix}`, fixture.actorEmail, fixture.organizationId],
  )
  const customer = await insertReturning(
    pool,
    `INSERT INTO crm_organizations (
       pipeline_id, source_key, identity_key, name,
       source_hash, created_by, updated_by
     ) VALUES ($1, $2, $2, $3, $4, $5, $5)
     RETURNING id`,
    [
      pipeline.id,
      `print-delivery-customer-${fixture.suffix}`,
      'Print Delivery Customer',
      '1'.repeat(64),
      fixture.actorEmail,
    ],
  )
  const integration = await insertReturning(
    pool,
    `INSERT INTO operations_integration_accounts (
       organization_id, provider, integration_type, environment,
       display_name, created_by, updated_by
     ) VALUES ($1, $2, 'commerce', 'mock', $3, $4, $4)
     RETURNING id`,
    [
      fixture.organizationId,
      `print-delivery-${fixture.suffix}`,
      'Print delivery commerce fixture',
      fixture.actorEmail,
    ],
  )
  const order = await insertReturning(
    pool,
    `INSERT INTO operations_orders (
       organization_id, pipeline_id, customer_id, integration_account_id,
       source_provider, external_order_id, order_number, status,
       ship_to, created_by, updated_by
     ) VALUES (
       $1, $2, $3, $4,
       'mock', $5, $6, 'planned',
       $7::jsonb, $8, $8
     )
     RETURNING id, global_id, order_number`,
    [
      fixture.organizationId,
      pipeline.id,
      customer.id,
      integration.id,
      `external-${fixture.suffix}`,
      `ORDER-${fixture.suffix}`,
      JSON.stringify({
        name: 'John Doe',
        address1: '101 Jegs Place',
        city: 'Delaware',
        state: 'OH',
        postalCode: '43015',
        country: 'US',
      }),
      fixture.actorEmail,
    ],
  )
  const plan = await insertReturning(
    pool,
    `INSERT INTO operations_fulfillment_plans (
       organization_id, order_id, warehouse_id, status, method,
       promised_delivery_at, created_by
     ) VALUES (
       $1, $2, $3, 'released', 'deterministic_fallback',
       now() + interval '2 days', $4
     )
     RETURNING id`,
    [
      fixture.organizationId,
      order.id,
      fixture.warehouseId,
      fixture.actorEmail,
    ],
  )
  const rate = await insertReturning(
    pool,
    `INSERT INTO operations_carrier_rates (
       organization_id, plan_id, carrier, service_code, service_name,
       internal_cost_minor, customer_charge_minor, transit_days,
       estimated_delivery_at, meets_promise, selected
     ) VALUES (
       $1, $2, 'mock', 'GROUND', 'Mock Ground',
       1000, 1250, 2, now() + interval '2 days', true, true
     )
     RETURNING id`,
    [fixture.organizationId, plan.id],
  )
  const packageRecord = await insertReturning(
    pool,
    `INSERT INTO operations_packages (
       organization_id, plan_id, package_number,
       length_mm, width_mm, height_mm, weight_grams,
       status, packed_by, packed_at
     ) VALUES (
       $1, $2, 1, 300, 200, 150, 1000,
       'labeled', $3, now()
     )
     RETURNING id`,
    [fixture.organizationId, plan.id, fixture.actorEmail],
  )
  const label = await insertReturning(
    pool,
    `INSERT INTO operations_labels (
       organization_id, package_id, carrier_rate_id,
       carrier, service_code, tracking_number, format,
       label_payload, provider_label_id, idempotency_key
     ) VALUES (
       $1, $2, $3,
       'mock', 'GROUND', $4, 'ZPL',
       '^XA^XZ', $5, $6
     )
     RETURNING id, global_id`,
    [
      fixture.organizationId,
      packageRecord.id,
      rate.id,
      `TRACK-${fixture.suffix}`,
      `provider-${fixture.suffix}`,
      `label-${fixture.suffix}`,
    ],
  )
  const shipment = await insertReturning(
    pool,
    `INSERT INTO operations_shipments (
       organization_id, order_id, plan_id, package_id, label_id,
       tracking_number, quoted_carrier_cost_minor, confirmed_by
     ) VALUES ($1, $2, $3, $4, $5, $6, 1000, $7)
     RETURNING id, global_id, tracking_number`,
    [
      fixture.organizationId,
      order.id,
      plan.id,
      packageRecord.id,
      label.id,
      `TRACK-${fixture.suffix}`,
      fixture.actorEmail,
    ],
  )
  return { order, label, shipment }
}

async function seedFixture(pool) {
  const suffix = randomBytes(4).toString('hex')
  const actorEmail = `print-delivery-${suffix}@example.com`
  await pool.query(
    `INSERT INTO app_users (email, role, status, display_name)
     VALUES ($1, 'owner', 'active', 'Print Delivery Owner')`,
    [actorEmail],
  )
  const organization = await insertReturning(
    pool,
    `INSERT INTO workspace_organizations (
       name, organization_type, created_by, updated_by
     ) VALUES ($1, 'root', $2, $2)
     RETURNING id`,
    [`Print Delivery ${suffix}`, actorEmail],
  )
  await pool.query(
    `UPDATE app_users
        SET organization_id = $2,
            organization_name = $3
      WHERE email = $1`,
    [actorEmail, organization.id, `Print Delivery ${suffix}`],
  )
  const warehouse = await insertReturning(
    pool,
    `INSERT INTO operations_warehouses (
       organization_id, code, name, created_by, updated_by
     ) VALUES ($1, $2, $3, $4, $4)
     RETURNING id`,
    [organization.id, `PD-${suffix}`, 'Print delivery warehouse', actorEmail],
  )
  const plainSecret = `one-time-${randomBytes(24).toString('base64url')}`
  const secretHash = createHash('sha256').update(plainSecret).digest('hex')
  const agent = await insertReturning(
    pool,
    `INSERT INTO operations_print_agents (
       organization_id, warehouse_id, name, secret_hash,
       request_fingerprint, idempotency_key, enrolled_by,
       supported_formats, supported_media, supported_document_types
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7,
       ARRAY['ZPL', 'PDF', 'PNG']::text[],
       ARRAY['label_4x6', 'label_4x8', 'letter', 'a4']::text[],
       ARRAY['shipping_label', 'packing_slip']::text[]
     )
     RETURNING id, global_id`,
    [
      organization.id,
      warehouse.id,
      'Warehouse print agent',
      secretHash,
      '1'.repeat(64),
      `enroll-${suffix}`,
      actorEmail,
    ],
  )
  const fixture = {
    suffix,
    actorEmail,
    organizationId: organization.id,
    warehouseId: warehouse.id,
    agentId: agent.id,
    agentGlobalId: agent.global_id,
    plainSecret,
    secretHash,
  }
  return {
    ...fixture,
    printSource: await seedPrintSource(pool, fixture),
  }
}

async function createArtifact(pool, fixture, input) {
  return insertReturning(
    pool,
    `INSERT INTO operations_print_artifacts (
       organization_id, source_label_id, source_order_id, source_shipment_id,
       document_type, format, media_size,
       content_sha256, byte_length, storage_reference, created_by
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id, global_id`,
    [
      fixture.organizationId,
      input.sourceLabelId || null,
      input.sourceOrderId || null,
      input.sourceShipmentId || null,
      input.documentType,
      input.format,
      input.media,
      input.hash,
      input.byteLength || 1024,
      input.storageReference,
      fixture.actorEmail,
    ],
  )
}

async function createDeliveryJob(pool, fixture, input) {
  return insertReturning(
    pool,
    `INSERT INTO operations_print_jobs (
       organization_id, artifact_id, requested_printer_id,
       printer_id, fallback_printer_id, status, routing_reason,
       attempts, idempotency_key, request_fingerprint, enqueued_by
     ) VALUES (
       $1, $2, $3, $4, $5, 'queued', $6,
       0, $7, $8, $9
     )
     RETURNING id, global_id`,
    [
      fixture.organizationId,
      input.artifactId,
      input.requestedPrinterId,
      input.printerId || input.requestedPrinterId,
      input.fallbackPrinterId || null,
      input.routingReason || 'Print-delivery acceptance route',
      input.idempotencyKey,
      input.requestFingerprint,
      fixture.actorEmail,
    ],
  )
}

async function appendAttempt(pool, fixture, input) {
  return insertReturning(
    pool,
    `INSERT INTO operations_print_delivery_attempts (
       organization_id, print_job_id, printer_id, state,
       actor_type, actor_email, print_agent_id, claim_attempt_id,
       claim_expires_at, idempotency_key, request_fingerprint,
       detail, error_code, error_message, delivery_evidence
     ) VALUES (
       $1, $2, $3, $4,
       $5, $6, $7, $8,
       $9, $10, $11,
       $12, $13, $14, $15
     )
     RETURNING id, attempt_number, sequence_number, state`,
    [
      fixture.organizationId,
      input.jobId,
      input.printerId,
      input.state,
      input.actorType,
      input.actorEmail || null,
      input.agentId || null,
      input.claimAttemptId || null,
      input.claimExpiresAt || null,
      input.idempotencyKey,
      input.requestFingerprint,
      input.detail || null,
      input.errorCode || null,
      input.errorMessage || null,
      input.deliveryEvidence || null,
    ],
  )
}

async function verifyPostgresAcceptance(connectionString) {
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 5_000 })
  try {
    const fixture = await seedFixture(pool)

    const secretColumns = await pool.query(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'operations_print_agents'
          AND column_name IN (
            'secret', 'plaintext_secret', 'secret_plaintext',
            'enrollment_secret', 'credential', 'token', 'api_key'
          )`,
    )
    assert.equal(secretColumns.rowCount, 0)
    const credentialRecord = await pool.query(
      `SELECT global_id, secret_hash, credential_version
         FROM operations_print_agents
        WHERE id = $1`,
      [fixture.agentId],
    )
    assert.match(credentialRecord.rows[0].global_id, /^gpt[0-9a-v]{12}$/)
    assert.equal(credentialRecord.rows[0].secret_hash, fixture.secretHash)
    assert.notEqual(credentialRecord.rows[0].secret_hash, fixture.plainSecret)
    assert.equal(credentialRecord.rows[0].credential_version, 1)
    const defaultCapabilityAgent = await pool.query(
      `INSERT INTO operations_print_agents (
         organization_id, warehouse_id, name, secret_hash,
         request_fingerprint, idempotency_key, enrolled_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING supported_formats, supported_media, supported_document_types`,
      [
        fixture.organizationId,
        fixture.warehouseId,
        'Bundled Zebra default agent',
        '3'.repeat(64),
        '4'.repeat(64),
        `default-capabilities-${fixture.suffix}`,
        fixture.actorEmail,
      ],
    )
    assert.deepEqual(defaultCapabilityAgent.rows[0], {
      supported_formats: ['ZPL'],
      supported_media: ['label_4x6'],
      supported_document_types: ['shipping_label'],
    })
    await expectRejected(
      () => pool.query(
        `UPDATE operations_print_agents
            SET secret_hash = $2
          WHERE id = $1`,
        [fixture.agentId, '2'.repeat(64)],
      ),
      /credential rotation must replace an active credential/,
      'Credential verifier changes must require an explicit one-time rotation',
    )

    const thermalFallback = await createPrinter(pool, fixture, {
      code: `TF-${fixture.suffix}`,
      name: 'Thermal fallback',
      stationType: 'shipping',
      printerType: 'thermal',
      formats: ['ZPL', 'PDF'],
      media: ['label_4x6'],
      documents: ['shipping_label'],
      priority: 20,
    })
    const thermalPrimary = await createPrinter(pool, fixture, {
      code: `TP-${fixture.suffix}`,
      name: 'Thermal primary',
      stationType: 'shipping',
      printerType: 'thermal',
      formats: ['ZPL', 'PDF'],
      media: ['label_4x6'],
      documents: ['shipping_label'],
      defaults: ['shipping_label'],
      fallbackId: thermalFallback.id,
      priority: 10,
    })
    const nonthermalFallback = await createPrinter(pool, fixture, {
      code: `NF-${fixture.suffix}`,
      name: 'Nonthermal fallback',
      stationType: 'office',
      printerType: 'nonthermal',
      formats: ['PDF', 'PNG'],
      media: ['letter', 'a4'],
      documents: ['packing_slip'],
      priority: 20,
    })
    const nonthermalPrimary = await createPrinter(pool, fixture, {
      code: `NP-${fixture.suffix}`,
      name: 'Nonthermal primary',
      stationType: 'office',
      printerType: 'nonthermal',
      formats: ['PDF', 'PNG'],
      media: ['letter', 'a4'],
      documents: ['packing_slip'],
      defaults: ['packing_slip'],
      fallbackId: nonthermalFallback.id,
      priority: 10,
    })
    const incompatiblePrimary = await createPrinter(pool, fixture, {
      code: `IP-${fixture.suffix}`,
      name: 'Fallback validation primary',
      stationType: 'shipping',
      printerType: 'thermal',
      formats: ['ZPL'],
      media: ['label_4x6'],
      documents: ['shipping_label'],
    })
    await expectRejected(
      () => pool.query(
        `UPDATE operations_printers
            SET fallback_printer_id = $3
          WHERE organization_id = $1
            AND id = $2`,
        [fixture.organizationId, incompatiblePrimary.id, nonthermalFallback.id],
      ),
      /fallback must have compatible document, media, and format capabilities/,
      'Incompatible explicit fallback must be rejected',
    )

    const browserPrinter = await createPrinter(pool, fixture, {
      code: `BR-${fixture.suffix}`,
      name: 'Browser-only office printer',
      stationType: 'office',
      printerType: 'nonthermal',
      connectionMode: 'browser',
      formats: ['PDF'],
      media: ['letter'],
      documents: ['packing_slip'],
      agentId: null,
    })

    const labelArtifact = await createArtifact(pool, fixture, {
      sourceLabelId: fixture.printSource.label.id,
      sourceOrderId: fixture.printSource.order.id,
      sourceShipmentId: fixture.printSource.shipment.id,
      documentType: 'shipping_label',
      format: 'ZPL',
      media: 'label_4x6',
      hash: 'a'.repeat(64),
      storageReference: `s3://print-delivery/${fixture.suffix}/label.zpl`,
    })
    const packingArtifact = await createArtifact(pool, fixture, {
      sourceOrderId: fixture.printSource.order.id,
      sourceShipmentId: fixture.printSource.shipment.id,
      documentType: 'packing_slip',
      format: 'PDF',
      media: 'letter',
      hash: 'b'.repeat(64),
      storageReference: `s3://print-delivery/${fixture.suffix}/packing.pdf`,
    })
    const a4Artifact = await createArtifact(pool, fixture, {
      sourceOrderId: fixture.printSource.order.id,
      sourceShipmentId: fixture.printSource.shipment.id,
      documentType: 'packing_slip',
      format: 'PNG',
      media: 'a4',
      hash: 'c'.repeat(64),
      storageReference: `s3://print-delivery/${fixture.suffix}/packing-a4.png`,
    })
    assert.match(labelArtifact.global_id, /^gpf[0-9a-v]{12}$/)
    assert.match(packingArtifact.global_id, /^gpf[0-9a-v]{12}$/)
    assert.match(a4Artifact.global_id, /^gpf[0-9a-v]{12}$/)
    await expectRejected(
      () => createArtifact(pool, fixture, {
        documentType: 'packing_slip',
        format: 'ZPL',
        media: 'label_4x6',
        hash: 'd'.repeat(64),
        storageReference: `s3://print-delivery/${fixture.suffix}/invalid.zpl`,
      }),
      /operations_print_artifacts_document_media_valid/,
      'Packing slips must use supported nonthermal media and format',
    )
    await expectRejected(
      () => pool.query(
        `UPDATE operations_print_artifacts
            SET storage_reference = $2
          WHERE id = $1`,
        [labelArtifact.id, `s3://print-delivery/${fixture.suffix}/changed.zpl`],
      ),
      /Rendered print artifacts are immutable/,
      'Rendered artifact metadata must be immutable',
    )

    await expectRejected(
      () => createDeliveryJob(pool, fixture, {
        artifactId: packingArtifact.id,
        requestedPrinterId: browserPrinter.id,
        idempotencyKey: `browser-${fixture.suffix}`,
        requestFingerprint: 'd'.repeat(64),
      }),
      /browser printing is not delivery evidence/,
      'Browser printing must not enter the durable delivery queue',
    )
    await expectRejected(
      () => createDeliveryJob(pool, fixture, {
        artifactId: packingArtifact.id,
        requestedPrinterId: thermalPrimary.id,
        fallbackPrinterId: thermalFallback.id,
        idempotencyKey: `capability-${fixture.suffix}`,
        requestFingerprint: 'e'.repeat(64),
      }),
      /must both support the artifact document, media, and format/,
      'Artifact and exact printer capabilities must match',
    )
    await expectRejected(
      () => createDeliveryJob(pool, fixture, {
        artifactId: labelArtifact.id,
        requestedPrinterId: thermalPrimary.id,
        idempotencyKey: `fallback-${fixture.suffix}`,
        requestFingerprint: 'f'.repeat(64),
      }),
      /fallback must match the requested printer route/,
      'A configured fallback must be represented explicitly on the job',
    )

    const labelJob = await createDeliveryJob(pool, fixture, {
      artifactId: labelArtifact.id,
      requestedPrinterId: thermalPrimary.id,
      fallbackPrinterId: thermalFallback.id,
      idempotencyKey: `label-job-${fixture.suffix}`,
      requestFingerprint: '3'.repeat(64),
    })
    const queued = await appendAttempt(pool, fixture, {
      jobId: labelJob.id,
      printerId: thermalPrimary.id,
      state: 'queued',
      actorType: 'user',
      actorEmail: fixture.actorEmail,
      idempotencyKey: `label-queued-${fixture.suffix}`,
      requestFingerprint: '4'.repeat(64),
    })
    assert.deepEqual(
      {
        attempt: queued.attempt_number,
        sequence: queued.sequence_number,
        state: queued.state,
      },
      { attempt: 1, sequence: 1, state: 'queued' },
    )
    const claimed = await appendAttempt(pool, fixture, {
      jobId: labelJob.id,
      printerId: thermalPrimary.id,
      state: 'claimed',
      actorType: 'local_print_agent',
      agentId: fixture.agentId,
      claimExpiresAt: new Date(Date.now() + 120_000),
      idempotencyKey: `label-claimed-${fixture.suffix}`,
      requestFingerprint: '5'.repeat(64),
    })
    const delivered = await appendAttempt(pool, fixture, {
      jobId: labelJob.id,
      printerId: thermalPrimary.id,
      state: 'delivered',
      actorType: 'local_print_agent',
      agentId: fixture.agentId,
      claimAttemptId: claimed.id,
      idempotencyKey: `label-delivered-${fixture.suffix}`,
      requestFingerprint: '6'.repeat(64),
      deliveryEvidence: 'local_agent_acknowledgement',
    })
    assert.equal(delivered.attempt_number, 1)
    assert.equal(delivered.sequence_number, 3)
    const deliveredProjection = await pool.query(
      `SELECT status, attempts, delivered_at, printed_at
         FROM operations_print_jobs
        WHERE id = $1`,
      [labelJob.id],
    )
    assert.equal(deliveredProjection.rows[0].status, 'delivered')
    assert.equal(deliveredProjection.rows[0].attempts, 1)
    assert.ok(deliveredProjection.rows[0].delivered_at)
    assert.equal(deliveredProjection.rows[0].printed_at, null)
    const deliveryEvidence = await pool.query(
      `SELECT actor_type, delivery_evidence, physical_output_verified
         FROM operations_print_delivery_attempts
        WHERE id = $1`,
      [delivered.id],
    )
    assert.deepEqual(deliveryEvidence.rows[0], {
      actor_type: 'local_print_agent',
      delivery_evidence: 'local_agent_acknowledgement',
      physical_output_verified: false,
    })
    await expectRejected(
      () => pool.query(
        `UPDATE operations_print_delivery_attempts
            SET detail = 'mutated'
          WHERE id = $1`,
        [queued.id],
      ),
      /append-only/,
      'Delivery attempts must be append-only',
    )
    await expectRejected(
      () => pool.query(
        `DELETE FROM operations_print_delivery_attempts WHERE id = $1`,
        [queued.id],
      ),
      /append-only/,
      'Delivery attempts must not be deleted',
    )
    await expectRejected(
      () => appendAttempt(pool, fixture, {
        jobId: labelJob.id,
        printerId: thermalPrimary.id,
        state: 'cancelled',
        actorType: 'user',
        actorEmail: fixture.actorEmail,
        idempotencyKey: `late-cancel-${fixture.suffix}`,
        requestFingerprint: '7'.repeat(64),
      }),
      /delivered or cancelled print delivery is terminal/,
      'Delivered jobs must be terminal',
    )
    await expectRejected(
      () => appendAttempt(pool, fixture, {
        jobId: labelJob.id,
        printerId: thermalPrimary.id,
        state: 'delivered',
        actorType: 'user',
        actorEmail: fixture.actorEmail,
        claimAttemptId: claimed.id,
        idempotencyKey: `browser-proof-${fixture.suffix}`,
        requestFingerprint: '8'.repeat(64),
        deliveryEvidence: 'local_agent_acknowledgement',
      }),
      null,
      'A user or browser acknowledgement must never be delivery evidence',
    )

    const packingJob = await createDeliveryJob(pool, fixture, {
      artifactId: packingArtifact.id,
      requestedPrinterId: nonthermalPrimary.id,
      fallbackPrinterId: nonthermalFallback.id,
      idempotencyKey: `packing-job-${fixture.suffix}`,
      requestFingerprint: '9'.repeat(64),
    })
    await appendAttempt(pool, fixture, {
      jobId: packingJob.id,
      printerId: nonthermalPrimary.id,
      state: 'queued',
      actorType: 'user',
      actorEmail: fixture.actorEmail,
      idempotencyKey: `packing-queued-${fixture.suffix}`,
      requestFingerprint: '0'.repeat(64),
    })
    const packingProjection = await pool.query(
      `SELECT job.status, artifact.document_type, artifact.media_size,
              requested.printer_type, fallback.global_id AS fallback_global_id
         FROM operations_print_jobs job
         JOIN operations_print_artifacts artifact
           ON artifact.id = job.artifact_id
         JOIN operations_printers requested
           ON requested.id = job.requested_printer_id
         JOIN operations_printers fallback
           ON fallback.id = job.fallback_printer_id
        WHERE job.id = $1`,
      [packingJob.id],
    )
    assert.deepEqual(packingProjection.rows[0], {
      status: 'queued',
      document_type: 'packing_slip',
      media_size: 'letter',
      printer_type: 'nonthermal',
      fallback_global_id: nonthermalFallback.global_id,
    })

    await expectRejected(
      () => createDeliveryJob(pool, fixture, {
        artifactId: a4Artifact.id,
        requestedPrinterId: nonthermalPrimary.id,
        fallbackPrinterId: nonthermalFallback.id,
        idempotencyKey: `duplicate-job-${fixture.suffix}`,
        requestFingerprint: 'a'.repeat(64),
      }).then(() => createDeliveryJob(pool, fixture, {
        artifactId: a4Artifact.id,
        requestedPrinterId: nonthermalPrimary.id,
        fallbackPrinterId: nonthermalFallback.id,
        idempotencyKey: `duplicate-job-${fixture.suffix}`,
        requestFingerprint: 'b'.repeat(64),
      })),
      /operations_print_jobs_idempotency_unique/,
      'Enqueue idempotency must be organization scoped',
    )
  } finally {
    await pool.end()
  }
}

async function main() {
  verifySourceContracts()
  verifyOwnedTypeContracts()
  if (process.argv.includes('--contracts-only')) {
    console.log('Operations print-delivery source and type contracts passed.')
    return
  }
  command('docker', ['info'], { timeout: 30_000 })

  const container = `clawpilot-print-delivery-${process.pid}-${randomUUID().slice(0, 8)}`
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=clawpilot_print_delivery',
      '-e', 'POSTGRES_DB=clawpilot_print_delivery',
      '-p', '127.0.0.1::5432',
      'pgvector/pgvector:pg16',
    ], { timeout: 180_000 })
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/)?.[1])
    assert.ok(port > 0, `Unable to resolve disposable PostgreSQL port from ${portOutput}`)
    const connectionString =
      `postgresql://postgres:clawpilot_print_delivery@127.0.0.1:${port}/clawpilot_print_delivery`
    await waitForPostgres(connectionString)
    command('node', ['scripts/db-migrate.mjs'], {
      env: { DATABASE_URL: connectionString, PGSSLMODE: 'disable' },
      timeout: 240_000,
    })
    await verifyPostgresAcceptance(connectionString)
  } finally {
    spawnSync('docker', ['stop', '-t', '1', container], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000,
    })
  }

  console.log('Operations print-delivery PostgreSQL and contract tests passed.')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
