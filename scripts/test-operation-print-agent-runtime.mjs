#!/usr/bin/env node
import assert from 'node:assert/strict'
import {
  createDecipheriv,
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  randomUUID,
} from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
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

function loadTypeScript(path, mocks = {}) {
  const output = ts.transpileModule(read(path), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(output, {
    Array,
    BigInt,
    Buffer,
    Date,
    Error,
    Map,
    Number,
    Object,
    Promise,
    RegExp,
    Set,
    String,
    URL,
    clearTimeout,
    console,
    exports: module.exports,
    module,
    process,
    setTimeout,
    structuredClone,
    require(specifier) {
      if (Object.prototype.hasOwnProperty.call(mocks, specifier)) return mocks[specifier]
      return requireFromApp(specifier)
    },
  }, { filename: path })
  return module.exports
}

async function insertReturning(pool, sql, params = []) {
  const result = await pool.query(sql, params)
  assert.equal(result.rowCount, 1)
  return result.rows[0]
}

function postgresAdapter(pool) {
  return {
    query: (sql, params) => pool.query(sql, params),
    async withTransaction(work) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const result = await work(client)
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    },
    async acquireTransactionAdvisoryLock(client, key) {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key])
    },
  }
}

function profileAdapter() {
  return {
    async listOperationsPrinterProfilesInPostgres(organizationId, client) {
      const result = await client.query(
        `SELECT
           printer.id::text,
           printer.global_id,
           printer.warehouse_id::text,
           warehouse.global_id AS warehouse_global_id,
           warehouse.name AS warehouse_name,
           printer.code,
           printer.name,
           printer.station_type,
           printer.printer_type,
           printer.connection_mode,
           printer.supported_formats,
           printer.supported_media,
           printer.supported_document_types,
           printer.default_document_types,
           fallback.global_id AS fallback_printer_global_id,
           fallback.name AS fallback_printer_name,
           agent.global_id AS local_print_agent_global_id,
           agent.name AS local_print_agent_name,
           agent.status AS local_print_agent_status,
           agent.last_seen_at AS local_print_agent_last_seen_at,
           printer.priority,
           printer.status,
           printer.row_version,
           printer.last_seen_at,
           printer.updated_at
         FROM operations_printers printer
         JOIN operations_warehouses warehouse
           ON warehouse.organization_id = printer.organization_id
          AND warehouse.id = printer.warehouse_id
         LEFT JOIN operations_printers fallback
           ON fallback.organization_id = printer.organization_id
          AND fallback.id = printer.fallback_printer_id
         LEFT JOIN operations_print_agents agent
           ON agent.organization_id = printer.organization_id
          AND agent.warehouse_id = printer.warehouse_id
          AND agent.id = printer.local_print_agent_id
         WHERE printer.organization_id = $1::uuid
         ORDER BY printer.priority, printer.name`,
        [organizationId],
      )
      return result.rows.map((row) => ({
        id: row.id,
        globalId: row.global_id,
        warehouseId: row.warehouse_id,
        warehouseGlobalId: row.warehouse_global_id,
        warehouseName: row.warehouse_name,
        code: row.code,
        name: row.name,
        stationType: row.station_type,
        printerType: row.printer_type,
        connectionMode: row.connection_mode,
        supportedFormats: row.supported_formats,
        supportedMedia: row.supported_media,
        supportedDocumentTypes: row.supported_document_types,
        defaultDocumentTypes: row.default_document_types,
        fallbackPrinterGlobalId: row.fallback_printer_global_id,
        fallbackPrinterName: row.fallback_printer_name,
        localPrintAgentGlobalId: row.local_print_agent_global_id,
        localPrintAgentName: row.local_print_agent_name,
        localPrintAgentStatus: row.local_print_agent_status,
        localPrintAgentLastSeenAt: row.local_print_agent_last_seen_at
          ? new Date(row.local_print_agent_last_seen_at).toISOString()
          : null,
        priority: row.priority,
        status: row.status,
        rowVersion: row.row_version,
        lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at).toISOString() : null,
        updatedAt: new Date(row.updated_at).toISOString(),
      }))
    },
  }
}

function auditAdapter(auditCalls) {
  return {
    async recordAuditEvent(input, client) {
      auditCalls.push(structuredClone(input))
      await client.query(
        `INSERT INTO audit_events (
           actor, event_type, aggregate_type, aggregate_id, payload,
           event_key, subject, organization_id, is_system
         ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::uuid, $9)
         ON CONFLICT (event_key) WHERE event_key IS NOT NULL DO NOTHING`,
        [
          input.actor || null,
          input.eventType,
          input.aggregateType || null,
          input.aggregateId || null,
          JSON.stringify(input.payload || {}),
          input.eventKey || null,
          input.subject || null,
          input.organizationId || null,
          input.isSystem === true,
        ],
      )
    },
  }
}

function requestErrorAdapter() {
  class RequestError extends Error {
    constructor(code, message, status = 400) {
      super(message)
      this.code = code
      this.status = status
    }
  }
  return { OperationsRequestError: RequestError }
}

function pairingRecoveryClient() {
  const keyPair = generateKeyPairSync('x25519')
  const publicKey = Buffer.from(keyPair.publicKey.export({
    format: 'der',
    type: 'spki',
  }))
  return {
    privateKey: keyPair.privateKey,
    request: {
      schemaVersion: 2,
      installationId: randomUUID(),
      clientPublicKey: publicKey.toString('base64url'),
      clientKeyFingerprint: createHash('sha256')
        .update(publicKey)
        .digest('base64url'),
    },
  }
}

function decryptPairingEnrollment({
  result,
  client,
  pairingCode,
  idempotencyKey,
}) {
  assert.equal(result.installationId, client.request.installationId)
  assert.equal(
    result.clientKeyFingerprint,
    client.request.clientKeyFingerprint,
  )
  const sealed = result.sealedEnrollment
  assert.deepEqual({
    schemaVersion: sealed.schemaVersion,
    keyAgreement: sealed.keyAgreement,
    keyDerivation: sealed.keyDerivation,
    contentEncryption: sealed.contentEncryption,
  }, {
    schemaVersion: 1,
    keyAgreement: 'X25519',
    keyDerivation: 'HKDF-SHA256',
    contentEncryption: 'A256GCM',
  })
  const context = Buffer.from(sealed.authenticatedContext, 'base64url')
  const sharedSecret = diffieHellman({
    privateKey: client.privateKey,
    publicKey: createPublicKey({
      key: Buffer.from(sealed.serverPublicKey, 'base64url'),
      format: 'der',
      type: 'spki',
    }),
  })
  const key = Buffer.from(hkdfSync(
    'sha256',
    sharedSecret,
    Buffer.from(sealed.salt, 'base64url'),
    context,
    32,
  ))
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(sealed.iv, 'base64url'),
    )
    decipher.setAAD(context)
    decipher.setAuthTag(Buffer.from(sealed.authTag, 'base64url'))
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(sealed.ciphertext, 'base64url')),
      decipher.final(),
    ])
    const enrollment = JSON.parse(plaintext.toString('utf8'))
    plaintext.fill(0)
    assert.equal(enrollment.schemaVersion, 1)
    assert.equal(
      enrollment.binding.pairingGrantId,
      pairingCode.split('.')[2].toLowerCase(),
    )
    assert.equal(
      enrollment.binding.installationId,
      client.request.installationId,
    )
    assert.equal(
      enrollment.binding.clientKeyFingerprint,
      client.request.clientKeyFingerprint,
    )
    assert.equal(enrollment.binding.idempotencyKey, idempotencyKey)
    assert.equal(enrollment.agent.id, result.agent.id)
    assert.equal(enrollment.agent.globalId, result.agent.globalId)
    assert.equal(enrollment.agent.name, result.agent.name)
    assert.equal(
      enrollment.agent.warehouseGlobalId,
      result.agent.warehouseGlobalId,
    )
    return enrollment
  } finally {
    sharedSecret.fill(0)
    key.fill(0)
  }
}

const managedSandboxFulfillmentConfiguration = {
  managedBy: 'ag-alchemy-episcs-sandbox-rating-delegation',
  authorizationScope: 'sandbox_fulfillment_diagnostic',
  credentialRevealAllowed: false,
  senderOriginWarehouseGlobalId: 'gwh5366613',
  allowedCapabilities: ['sandbox_rate', 'sandbox_label'],
}

const managedSandboxRatingOnlyConfiguration = {
  managedBy: 'ag-alchemy-episcs-sandbox-rating-delegation',
  authorizationScope: 'sandbox_rating_only',
  credentialRevealAllowed: false,
  senderOriginWarehouseGlobalId: 'gwh5366613',
  allowedCapabilities: ['sandbox_rate'],
}

async function seedBase(pool) {
  const suffix = randomBytes(4).toString('hex')
  const actorEmail = `print-agent-runtime-${suffix}@example.com`
  await pool.query(
    `INSERT INTO app_users (email, role, status, display_name)
     VALUES ($1, 'owner', 'active', 'Print Agent Runtime Owner')`,
    [actorEmail],
  )
  const organization = await insertReturning(
    pool,
    `INSERT INTO workspace_organizations (
       name, organization_type, created_by, updated_by
     ) VALUES ($1, 'root', $2, $2)
     RETURNING id`,
    [`Print Agent Runtime ${suffix}`, actorEmail],
  )
  await pool.query(
    `UPDATE app_users
     SET organization_id = $2, organization_name = $3
     WHERE email = $1`,
    [actorEmail, organization.id, `Print Agent Runtime ${suffix}`],
  )
  const warehouse = await insertReturning(
    pool,
    `INSERT INTO operations_warehouses (
       organization_id, code, name, created_by, updated_by
     ) VALUES ($1, $2, 'Print runtime warehouse', $3, $3)
     RETURNING id`,
    [organization.id, `PR-${suffix}`, actorEmail],
  )
  return {
    suffix,
    actorEmail,
    organizationId: organization.id,
    warehouseId: warehouse.id,
  }
}

async function createPrinter(pool, fixture, input) {
  const formats = input.formats || ['PDF']
  const media = input.media || ['letter']
  const documents = input.documents || ['packing_slip']
  const printerType = input.printerType || 'nonthermal'
  if (input.agentId && input.agentConnected !== false) {
    await pool.query(
      `UPDATE operations_print_agents
       SET last_seen_at = clock_timestamp()
       WHERE organization_id = $1::uuid
         AND id = $2::uuid`,
      [fixture.organizationId, input.agentId],
    )
  }
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
       $10, 'local_agent', $11::text[],
       $12::text[], $13::text[],
       $14::text[], $15::uuid, $16::uuid
     )
     RETURNING id, global_id`,
    [
      fixture.organizationId,
      fixture.warehouseId,
      input.code,
      input.name,
      input.stationType || (printerType === 'thermal' ? 'shipping' : 'office'),
      formats.includes('ZPL'),
      input.priority,
      input.status || 'online',
      fixture.actorEmail,
      printerType,
      formats,
      media,
      documents,
      input.isDefault ? documents : [],
      input.fallbackId || null,
      input.agentId,
    ],
  )
}

async function seedRateTestConnection(pool, fixture, input) {
  const integration = await insertReturning(
    pool,
    `INSERT INTO operations_integration_accounts (
       organization_id, provider, integration_type, environment,
       display_name, status, configuration, created_by, updated_by
     ) VALUES (
       $1::uuid, $2, 'carrier', 'sandbox',
       $3, 'active', $4::jsonb, $5, $5
     )
     RETURNING id, global_id`,
    [
      fixture.organizationId,
      input.provider,
      `${input.name} ${fixture.suffix}`,
      JSON.stringify(input.configuration),
      fixture.actorEmail,
    ],
  )
  const accountFingerprint = createHash('sha256')
    .update(`${input.provider}:account:${fixture.suffix}`)
    .digest('hex')
  const addressFingerprint = createHash('sha256')
    .update(`${input.provider}:address:${fixture.suffix}`)
    .digest('hex')
  const carrierAccount = await insertReturning(
    pool,
    `INSERT INTO operations_carrier_accounts (
       organization_id, integration_account_id, display_name, sender_name,
       account_number_ciphertext, account_number_iv, account_number_tag,
       account_number_last_four, account_number_fingerprint,
       registered_address, registered_address_fingerprint,
       address_verification, allow_sender_billing,
       allow_recipient_billing, allow_third_party_billing,
       status, created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, $3, 'Print runtime sender',
       'ciphertext', 'iv', 'tag',
       $4, $5, $6::jsonb, $7,
       'operator_attested', true, false, false,
       'active', $8, $8
     )
     RETURNING id, global_id, account_number_fingerprint`,
    [
      fixture.organizationId,
      integration.id,
      `${input.name} account`,
      input.provider === 'ups_rest' ? '1001' : '2002',
      accountFingerprint,
      JSON.stringify({
        line1: '101 Carrier Way',
        city: 'Delaware',
        region: 'OH',
        postalCode: '43015',
        countryCode: 'US',
      }),
      addressFingerprint,
      fixture.actorEmail,
    ],
  )
  const requestHash = createHash('sha256')
    .update(`${input.provider}:rate-request:${fixture.suffix}`)
    .digest('hex')
  const rateRequest = await insertReturning(
    pool,
    `INSERT INTO operations_carrier_rate_requests (
       organization_id, integration_account_id, carrier_account_id,
       provider, environment, purpose, adapter_version,
       credential_version, request_hash, redacted_request,
       redacted_response, status, provider_reference, actor_email,
       requested_at, completed_at
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid,
       $4, 'sandbox', 'sandbox_rate_test', 'print-runtime-v1',
       1, $5, '{}'::jsonb,
       $6::jsonb, 'succeeded', $7, $8,
       now() - interval '1 second', now()
     )
     RETURNING id, global_id, request_hash`,
    [
      fixture.organizationId,
      integration.id,
      carrierAccount.id,
      input.provider,
      requestHash,
      JSON.stringify({
        rates: [{
          serviceCode: 'GROUND',
          serviceName: `${input.name} Ground`,
          amount: '12.50',
          currency: 'USD',
        }],
      }),
      `${input.provider}-rate-${fixture.suffix}`,
      fixture.actorEmail,
    ],
  )
  return { integration, carrierAccount, rateRequest, provider: input.provider }
}

async function seedRateTestLabel(pool, fixture, connection, discriminator) {
  const serviceCode = `GROUND_${discriminator.toUpperCase()}`
    .replace(/[^A-Z0-9_]/g, '_')
    .slice(0, 80)
  const destinationFingerprint = createHash('sha256')
    .update(`destination:${discriminator}:${fixture.suffix}`)
    .digest('hex')
  const requestHash = createHash('sha256')
    .update(`label-request:${discriminator}:${fixture.suffix}`)
    .digest('hex')
  const payload = Buffer.from(
    `^XA^FO30,30^FD${discriminator}-${fixture.suffix}^FS^XZ`,
    'utf8',
  )
  const contentSha256 = createHash('sha256').update(payload).digest('hex')
  const attempt = await insertReturning(
    pool,
    `INSERT INTO operations_carrier_rate_test_label_attempts (
       organization_id, rate_request_id, integration_account_id,
       carrier_account_id, action, state, provider, environment,
       credential_version, service_code, rate_type, selected_rate,
       destination_fingerprint, adapter_version, reason,
       idempotency_key, request_hash, redacted_request, actor_email
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid,
       $4::uuid, 'create', 'prepared', $5, 'sandbox',
       1, $6, 'account', $7::jsonb,
       $8, 'print-runtime-v1', $9,
       $10, $11, '{}'::jsonb, $12
     )
     RETURNING id, global_id`,
    [
      fixture.organizationId,
      connection.rateRequest.id,
      connection.integration.id,
      connection.carrierAccount.id,
      connection.provider,
      serviceCode,
      JSON.stringify({
        serviceCode,
        serviceName: `${connection.provider} ${discriminator}`,
        amount: '12.50',
        currency: 'USD',
        rateType: 'account',
      }),
      destinationFingerprint,
      `Print authorization regression ${discriminator}`,
      `rate-test-label-${discriminator}-${fixture.suffix}`,
      requestHash,
      fixture.actorEmail,
    ],
  )
  const label = await insertReturning(
    pool,
    `INSERT INTO operations_carrier_rate_test_labels (
       organization_id, rate_request_id, integration_account_id,
       carrier_account_id, provider, environment, credential_version,
       account_number_fingerprint, rate_request_hash,
       destination_fingerprint, service_code, service_name, rate_type,
       rated_amount, rated_currency, provider_label_id, tracking_number,
       format, media_size, source_kind, provider_image_type,
       provider_stock_type, label_payload, content_sha256,
       provider_reference, redacted_provider_evidence,
       create_attempt_id, status, created_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid,
       $4::uuid, $5, 'sandbox', 1,
       $6, $7, $8, $9, $10, 'account',
       '12.50', 'USD', $11, $12,
       'ZPL', 'label_4x6', 'provider_native', $13, $14, $15, $16,
       $17, '{}'::jsonb,
       $18::uuid, 'created', $19
     )
     RETURNING id, global_id`,
    [
      fixture.organizationId,
      connection.rateRequest.id,
      connection.integration.id,
      connection.carrierAccount.id,
      connection.provider,
      connection.carrierAccount.account_number_fingerprint,
      connection.rateRequest.request_hash,
      destinationFingerprint,
      serviceCode,
      `${connection.provider} ${discriminator}`,
      `${connection.provider}-label-${discriminator}-${fixture.suffix}`,
      `${connection.provider}-tracking-${discriminator}-${fixture.suffix}`,
      connection.provider === 'ups_rest' ? 'ZPL' : 'ZPLII',
      connection.provider === 'ups_rest' ? 'HEIGHT_6_WIDTH_4' : 'STOCK_4X6',
      payload,
      contentSha256,
      `${connection.provider}-reference-${discriminator}-${fixture.suffix}`,
      attempt.id,
      fixture.actorEmail,
    ],
  )
  await pool.query(
    `UPDATE operations_carrier_rate_test_label_attempts
     SET state = 'succeeded', label_id = $3::uuid,
         redacted_response = '{}'::jsonb,
         provider_reference = $4,
         completed_at = now()
     WHERE organization_id = $1::uuid
       AND id = $2::uuid`,
    [
      fixture.organizationId,
      attempt.id,
      label.id,
      `${connection.provider}-reference-${discriminator}-${fixture.suffix}`,
    ],
  )
  return { ...label, payload }
}

async function seedBarcodeLabelArtifact(pool, fixture, input) {
  const payload = Buffer.from(
    `^XA\n^CI28\n^PW${input.media === 'label_3x1' ? 609 : 812}`
      + `\n^FD${input.documentType}-${input.media}-${fixture.suffix}^FS\n^XZ`,
    'utf8',
  )
  const contentSha256 = createHash('sha256').update(payload).digest('hex')
  const targetType = input.documentType === 'product_label' ? 'product' : 'location'
  const batch = await insertReturning(
    pool,
    `INSERT INTO operations_barcode_label_batches (
       organization_id, warehouse_id, target_type, media_size,
       label_count, items_snapshot, template_version, request_hash,
       idempotency_key, created_by
     ) VALUES (
       $1::uuid, $2::uuid, $3, $4,
       1, $5::jsonb, 'print-runtime-v1', $6,
       $7, $8
     )
     RETURNING id, global_id, target_type, media_size`,
    [
      fixture.organizationId,
      fixture.warehouseId,
      targetType,
      input.media,
      JSON.stringify([{
        displayName: `${targetType} ${input.media}`,
        barcodeValue: `PRINT-${fixture.suffix}`,
        copies: 1,
      }]),
      createHash('sha256')
        .update(`${input.documentType}:${input.media}:${fixture.suffix}`)
        .digest('hex'),
      `barcode-${input.documentType}-${input.media}-${fixture.suffix}`,
      fixture.actorEmail,
    ],
  )
  const artifact = await insertReturning(
    pool,
    `INSERT INTO operations_print_artifacts (
       organization_id, source_barcode_label_batch_id, document_type,
       format, media_size, content_sha256, byte_length,
       storage_reference, created_by
     ) VALUES (
       $1::uuid, $2::uuid, $3,
       'ZPL', $4, $5, $6,
       $7, $8
     )
     RETURNING id, global_id, document_type, media_size,
       content_sha256, byte_length::text`,
    [
      fixture.organizationId,
      batch.id,
      input.documentType,
      input.media,
      contentSha256,
      payload.byteLength,
      `clawpilot-document:barcode-label/${batch.global_id}`,
      fixture.actorEmail,
    ],
  )
  await pool.query(
    `INSERT INTO operations_print_artifact_payloads (
       artifact_id, organization_id, mime_type, filename, payload,
       template_version, render_snapshot
     ) VALUES (
       $1::uuid, $2::uuid, 'application/vnd.zebra-zpl', $3, $4,
       'print-runtime-v1', $5::jsonb
     )`,
    [
      artifact.id,
      fixture.organizationId,
      `${targetType}-${input.media}.zpl`,
      payload,
      JSON.stringify({ targetType, media: input.media, items: [{}] }),
    ],
  )
  return { artifact, batch, contentSha256, payload }
}

async function seedPrintSource(pool, fixture) {
  const pipeline = await insertReturning(
    pool,
    `INSERT INTO pipeline_spaces (
       name, owner_email, workspace_organization_id
     ) VALUES ($1, $2, $3)
     RETURNING id`,
    [`Print runtime ${fixture.suffix}`, fixture.actorEmail, fixture.organizationId],
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
      `print-runtime-customer-${fixture.suffix}`,
      'Print Runtime Customer',
      '2'.repeat(64),
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
      `print-runtime-${fixture.suffix}`,
      'Print runtime commerce fixture',
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
    [fixture.organizationId, order.id, fixture.warehouseId, fixture.actorEmail],
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

async function seedExternalFulfillmentSource(pool, fixture) {
  const source = await insertReturning(
    pool,
    `SELECT orders.pipeline_id::text, orders.customer_id::text
     FROM operations_orders orders
     WHERE orders.organization_id = $1::uuid
     ORDER BY orders.created_at DESC, orders.id DESC
     LIMIT 1`,
    [fixture.organizationId],
  )
  const integration = await insertReturning(
    pool,
    `INSERT INTO operations_integration_accounts (
       organization_id, provider, integration_type, environment,
       display_name, created_by, updated_by
     ) VALUES ($1, 'shopify', 'commerce', 'sandbox', $2, $3, $3)
     RETURNING id`,
    [
      fixture.organizationId,
      `External fulfillment ${fixture.suffix}`,
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
       $1, $2, $3, $4, 'shopify', $5, $6, 'cancelled',
       '{}'::jsonb, $7, $7
     ) RETURNING id, global_id, order_number, row_version::text`,
    [
      fixture.organizationId,
      source.pipeline_id,
      source.customer_id,
      integration.id,
      `gid://shopify/Order/${fixture.suffix}`,
      `EXTERNAL-${fixture.suffix}`,
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
     ) RETURNING id`,
    [fixture.organizationId, order.id, fixture.warehouseId, fixture.actorEmail],
  )
  const wave = await insertReturning(
    pool,
    `INSERT INTO operations_waves (
       organization_id, warehouse_id, name, status, optimization_method,
       released_by, released_at, completed_at
     ) VALUES (
       $1, $2, $3, 'cancelled', 'deterministic_fallback', $4, now(), now()
     ) RETURNING id`,
    [
      fixture.organizationId,
      fixture.warehouseId,
      `External fulfillment ${fixture.suffix}`,
      fixture.actorEmail,
    ],
  )
  const receipt = await insertReturning(
    pool,
    `INSERT INTO operations_command_receipts (
       organization_id, command_type, idempotency_key, request_hash,
       actor_email, status, correlation_id, target_global_id,
       result_payload, completed_at
     ) VALUES (
       $1, 'shopify_external_fulfillment_reconciliation', $2,
       repeat('7', 64), $3, 'succeeded', $4::uuid, $5,
       '{}'::jsonb, now()
     ) RETURNING id`,
    [
      fixture.organizationId,
      `external-reconciliation-${fixture.suffix}`,
      fixture.actorEmail,
      randomUUID(),
      order.global_id,
    ],
  )
  const trackingNumber = `1ZEXTERNAL${fixture.suffix.toUpperCase()}`
  const fulfillmentId = `gid://shopify/Fulfillment/${fixture.suffix}`
  const fulfilledAt = new Date(Date.now() - 120_000).toISOString()
  const updatedAt = new Date(Date.now() - 60_000).toISOString()
  const evidenceSnapshot = {
    version: 'shopify-external-fulfillment-reconciliation-v2',
    order: { id: `gid://shopify/Order/${fixture.suffix}` },
    fulfillment: {
      id: fulfillmentId,
      createdAt: fulfilledAt,
      updatedAt,
      status: 'SUCCESS',
      displayStatus: 'FULFILLED',
      tracking: [{
        company: 'UPS',
        number: trackingNumber,
        url: `https://www.ups.com/track?tracknum=${trackingNumber}`,
      }],
    },
  }
  const reconciliation = await insertReturning(
    pool,
    `INSERT INTO operations_shopify_external_fulfillment_reconciliations (
       organization_id, command_receipt_id, order_id,
       integration_account_id, plan_id, wave_id, external_order_id,
       provider_order_name, provider_order_updated_at,
       provider_fulfillment_id, provider_fulfillment_name,
       provider_fulfillment_created_at, provider_fulfillment_updated_at,
       provider_location_id, provider_fulfillment_order_ids,
       evidence_hash, evidence_snapshot, provider_read_count,
       provider_write_count, reason, reconciled_by
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7,
       $8, $9::timestamptz, $10, $11, $12::timestamptz,
       $9::timestamptz, $13, $14::text[], repeat('8', 64), $15::jsonb,
       2, 0, $16, $17
     ) RETURNING id, global_id`,
    [
      fixture.organizationId,
      receipt.id,
      order.id,
      integration.id,
      plan.id,
      wave.id,
      `gid://shopify/Order/${fixture.suffix}`,
      order.order_number,
      updatedAt,
      fulfillmentId,
      order.order_number,
      fulfilledAt,
      'gid://shopify/Location/1',
      ['gid://shopify/FulfillmentOrder/1'],
      JSON.stringify(evidenceSnapshot),
      'Retain exact external fulfillment evidence for print acceptance',
      fixture.actorEmail,
    ],
  )
  return {
    order,
    reconciliation,
    trackingNumber,
  }
}

async function expectRejected(work, pattern) {
  let error
  try {
    await work()
  } catch (caught) {
    error = caught
  }
  assert.ok(error, 'Expected operation to reject')
  assert.match(String(error.message || error), pattern)
}

async function verifyLegacyPrinterNormalization(connectionString) {
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 5_000 })
  try {
    const fixture = await seedBase(pool)
    await pool.query(
      `ALTER TABLE operations_printers
         DROP CONSTRAINT IF EXISTS operations_printers_printer_type_valid,
         DROP CONSTRAINT IF EXISTS operations_printers_type_capabilities_valid`,
    )
    const legacy = await insertReturning(
      pool,
      `INSERT INTO operations_printers (
         organization_id, warehouse_id, code, name, station_type,
         supports_zpl, priority, status, created_by,
         printer_type, connection_mode, supported_formats, supported_media,
         supported_document_types, default_document_types
       ) VALUES (
         $1, $2, $3, 'Legacy office printer', 'office',
         true, 100, 'offline', $4,
         'office', 'browser', ARRAY['ZPL']::text[], ARRAY['label_4x6']::text[],
         ARRAY['packing_slip']::text[], ARRAY[]::text[]
       )
       RETURNING id`,
      [
        fixture.organizationId,
        fixture.warehouseId,
        `LEGACY-${fixture.suffix}`,
        fixture.actorEmail,
      ],
    )
    const migration = read('db/migrations/0094_operations_print_delivery.sql')
    const start = migration.indexOf('ALTER TABLE operations_printers\n  DROP CONSTRAINT')
    const end = migration.indexOf('CREATE TABLE IF NOT EXISTS operations_print_agents')
    assert.ok(start >= 0 && end > start, 'Unable to isolate printer capability migration')
    await pool.query(migration.slice(start, end))
    const normalized = await pool.query(
      `SELECT printer_type, supports_zpl, supported_formats, supported_media
       FROM operations_printers
       WHERE id = $1`,
      [legacy.id],
    )
    assert.deepEqual(normalized.rows[0], {
      printer_type: 'nonthermal',
      supports_zpl: false,
      supported_formats: ['PDF'],
      supported_media: ['letter'],
    })
  } finally {
    await pool.end()
  }
}

async function verifyAgentCapabilityBackfill(connectionString) {
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 5_000 })
  try {
    const fixture = await seedBase(pool)
    const agent = await insertReturning(
      pool,
      `INSERT INTO operations_print_agents (
         organization_id, warehouse_id, name, secret_hash,
         request_fingerprint, idempotency_key, enrolled_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        fixture.organizationId,
        fixture.warehouseId,
        'Pre-capability bundled Zebra agent',
        '5'.repeat(64),
        '6'.repeat(64),
        `legacy-agent-${fixture.suffix}`,
        fixture.actorEmail,
      ],
    )
    await pool.query(
      `DROP TRIGGER IF EXISTS enforce_operations_printer_agent_capabilities_write
         ON operations_printers`,
    )
    const printer = await createPrinter(pool, fixture, {
      code: `LEGACY-ZEBRA-${fixture.suffix}`,
      name: 'Legacy broad Zebra profile',
      priority: 10,
      printerType: 'thermal',
      formats: ['ZPL', 'PDF'],
      media: ['label_4x6', 'label_4x8'],
      documents: ['shipping_label', 'return_label'],
      agentId: agent.id,
      isDefault: true,
    })
    await pool.query(
      read('db/migrations/0117_operations_print_agent_capabilities.sql'),
    )
    const backfilled = await pool.query(
      `SELECT
         supports_zpl,
         supported_formats,
         supported_media,
         supported_document_types,
         default_document_types,
         status,
         local_print_agent_id::text
       FROM operations_printers
       WHERE organization_id = $1::uuid
         AND id = $2::uuid`,
      [fixture.organizationId, printer.id],
    )
    assert.deepEqual(backfilled.rows[0], {
      supports_zpl: true,
      supported_formats: ['ZPL'],
      supported_media: ['label_4x6'],
      supported_document_types: ['shipping_label'],
      default_document_types: ['shipping_label'],
      status: 'online',
      local_print_agent_id: agent.id,
    })
    await expectRejected(
      () => pool.query(
        `UPDATE operations_printers
         SET supported_formats = ARRAY['ZPL', 'PDF']::text[]
         WHERE organization_id = $1::uuid
           AND id = $2::uuid`,
        [fixture.organizationId, printer.id],
      ),
      /subset of its local print agent capabilities/,
    )
    await pool.query(read('db/migrations/0262_operations_barcode_label_printing.sql'))
    // This backfill check deliberately reapplies a historical migration on the
    // shared disposable database. Restore the later external-label source
    // shape before the runtime acceptance begins.
    const externalLabelMigration = read(
      'db/migrations/0324_operations_external_fulfillment_label_artifacts.sql',
    )
    const sourceConstraintStart = externalLabelMigration.indexOf(
      'DROP CONSTRAINT IF EXISTS operations_print_artifacts_source_valid',
    )
    const sourceConstraintEnd = externalLabelMigration.indexOf(
      '\n\nCREATE UNIQUE INDEX',
      sourceConstraintStart,
    )
    assert.ok(
      sourceConstraintStart >= 0 && sourceConstraintEnd > sourceConstraintStart,
      'Unable to isolate the current print-artifact source constraint',
    )
    await pool.query(
      'ALTER TABLE operations_print_artifacts\n  '
      + externalLabelMigration.slice(sourceConstraintStart, sourceConstraintEnd),
    )
  } finally {
    await pool.end()
  }
}

async function verifyRuntime(connectionString) {
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 5_000 })
  const auditCalls = []
  try {
    const printing = loadTypeScript('app_src/lib/operations/printing.ts')
    const physicalOutputHealth = loadTypeScript(
      'app_src/lib/persistence/operationsPrintPhysicalOutputHealth.ts',
    )
    const carrierManagedDelegation = loadTypeScript(
      'app_src/lib/integrations/carrierManagedDelegation.ts',
    )
    const persistence = loadTypeScript(
      'app_src/lib/persistence/operationPrintDelivery.ts',
      {
        '@/lib/auditWriter': auditAdapter(auditCalls),
        '@/lib/integrations/carrierManagedDelegation': carrierManagedDelegation,
        '@/lib/operations/printing': printing,
        '@/lib/persistence/operations': requestErrorAdapter(),
        '@/lib/persistence/operationPrinting': profileAdapter(),
        '@/lib/persistence/postgres': postgresAdapter(pool),
      },
    )
    const externalLabels = loadTypeScript(
      'app_src/lib/persistence/operationExternalFulfillmentLabels.ts',
      {
        '@/lib/auditWriter': auditAdapter(auditCalls),
        '@/lib/persistence/operations': requestErrorAdapter(),
        '@/lib/persistence/postgres': postgresAdapter(pool),
      },
    )
    const fixture = await seedBase(pool)
    const pairingInput = {
      organizationId: fixture.organizationId,
      warehouseId: fixture.warehouseId,
      name: 'Pairing-grant Zebra agent',
      actorEmail: fixture.actorEmail,
      idempotencyKey: `pairing-grant-${fixture.suffix}`,
      ...printing.DEFAULT_PRINT_AGENT_CAPABILITIES,
    }
    const pairingIssue = await persistence
      .createOperationsPrintAgentPairingGrantInPostgres(pairingInput)
    assert.match(
      pairingIssue.pairingGrant.pairingCode,
      /^cppair\.v1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/i,
    )
    assert.ok(
      Date.parse(pairingIssue.pairingGrant.expiresAt) > Date.now(),
      'Pairing grants must expire in the future',
    )
    const persistedPairingSecret = await pool.query(
      `SELECT secret_hash, status, print_agent_id
       FROM operations_print_agent_pairing_grants
       WHERE organization_id = $1::uuid
         AND id = $2::uuid`,
      [fixture.organizationId, pairingIssue.pairingGrant.id],
    )
    assert.match(persistedPairingSecret.rows[0].secret_hash, /^[a-f0-9]{64}$/)
    assert.equal(
      JSON.stringify(persistedPairingSecret.rows[0]).includes(
        pairingIssue.pairingGrant.pairingCode,
      ),
      false,
      'Plaintext cppair grants must never be persisted',
    )
    assert.equal(persistedPairingSecret.rows[0].status, 'pending')
    assert.equal(persistedPairingSecret.rows[0].print_agent_id, null)

    const pairingIssueReplay = await persistence
      .createOperationsPrintAgentPairingGrantInPostgres(pairingInput)
    assert.equal(
      pairingIssueReplay.pairingGrant.id,
      pairingIssue.pairingGrant.id,
    )
    assert.equal(
      pairingIssueReplay.pairingGrant.pairingCode,
      null,
      'Idempotent browser replays must not recover plaintext cppair grants',
    )
    await expectRejected(
      () => persistence.createOperationsPrintAgentPairingGrantInPostgres({
        ...pairingInput,
        name: 'Different pairing plan',
      }),
      /different print-agent pairing request/,
    )

    const pairingClient = pairingRecoveryClient()
    const pairingRedemptionKey = `redeem-pairing-${fixture.suffix}`
    const pairingRedemption = await persistence
      .redeemOperationsPrintAgentPairingGrantInPostgres({
        pairingCode: pairingIssue.pairingGrant.pairingCode,
        idempotencyKey: pairingRedemptionKey,
        client: pairingClient.request,
      })
    assert.equal(pairingRedemption.replayed, false)
    assert.equal(
      Object.prototype.hasOwnProperty.call(pairingRedemption, 'credential'),
      false,
      'The API-facing persistence result must never expose plaintext cpprint',
    )
    const decryptedPairing = decryptPairingEnrollment({
      result: pairingRedemption,
      client: pairingClient,
      pairingCode: pairingIssue.pairingGrant.pairingCode,
      idempotencyKey: pairingRedemptionKey,
    })
    assert.match(
      decryptedPairing.credential,
      /^cpprint\.v1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/i,
    )
    assert.equal(
      decryptedPairing.binding.organizationId,
      fixture.organizationId,
      'The sealed enrollment must be bound to the grant organization',
    )
    assert.equal(
      pairingRedemption.agent.id,
      decryptedPairing.credential.split('.')[2],
      'Redeemed credential must use the grant-reserved agent identity',
    )
    assert.ok(
      await persistence.authenticateOperationsPrintAgentInPostgres(
        decryptedPairing.credential,
      ),
      'A redeemed credential must authenticate immediately',
    )
    assert.equal(
      JSON.stringify(auditCalls).includes(decryptedPairing.credential),
      false,
      'Audit events must never log a plaintext cpprint credential',
    )
    const redeemedGrant = await pool.query(
      `SELECT
         status,
         print_agent_id::text,
         redemption_idempotency_key,
         redemption_protocol,
         client_installation_id::text,
         client_public_key_spki,
         client_key_fingerprint,
         credential_envelope,
         credential_envelope_sha256,
         recovery_expires_at > redeemed_at AS bounded_recovery,
         recovery_expires_at <= redeemed_at + interval '10 minutes'
           AS recovery_within_ten_minutes
       FROM operations_print_agent_pairing_grants
       WHERE id = $1::uuid`,
      [pairingIssue.pairingGrant.id],
    )
    assert.deepEqual({
      status: redeemedGrant.rows[0].status,
      print_agent_id: redeemedGrant.rows[0].print_agent_id,
      redemption_idempotency_key:
        redeemedGrant.rows[0].redemption_idempotency_key,
      redemption_protocol: redeemedGrant.rows[0].redemption_protocol,
      client_installation_id: redeemedGrant.rows[0].client_installation_id,
      client_public_key_spki: redeemedGrant.rows[0].client_public_key_spki,
      client_key_fingerprint: redeemedGrant.rows[0].client_key_fingerprint,
      bounded_recovery: redeemedGrant.rows[0].bounded_recovery,
      recovery_within_ten_minutes:
        redeemedGrant.rows[0].recovery_within_ten_minutes,
    }, {
      status: 'redeemed',
      print_agent_id: pairingRedemption.agent.id,
      redemption_idempotency_key: pairingRedemptionKey,
      redemption_protocol: 'x25519-hkdf-sha256-aes-256-gcm-v1',
      client_installation_id: pairingClient.request.installationId,
      client_public_key_spki: pairingClient.request.clientPublicKey,
      client_key_fingerprint: pairingClient.request.clientKeyFingerprint,
      bounded_recovery: true,
      recovery_within_ten_minutes: true,
    })
    assert.match(
      redeemedGrant.rows[0].credential_envelope_sha256,
      /^[a-f0-9]{64}$/,
    )
    assert.doesNotMatch(
      JSON.stringify(redeemedGrant.rows[0]),
      /cpprint[.]v1[.]/,
      'The grant row must contain only a sealed credential envelope',
    )
    await expectRejected(
      () => pool.query(
        `UPDATE operations_print_agent_pairing_grants
         SET credential_envelope = credential_envelope
           || '{"ciphertext":"tampered"}'::jsonb
         WHERE id = $1::uuid`,
        [pairingIssue.pairingGrant.id],
      ),
      /Terminal print-agent pairing grants are immutable/,
    )

    // Simulate a committed database transaction whose HTTPS response was lost.
    // The exact same installation key and Idempotency-Key recover the same
    // envelope and authoritative agent without creating another agent.
    const recoveredPairing = await persistence
      .redeemOperationsPrintAgentPairingGrantInPostgres({
        pairingCode: pairingIssue.pairingGrant.pairingCode,
        idempotencyKey: pairingRedemptionKey,
        client: pairingClient.request,
      })
    assert.equal(recoveredPairing.replayed, true)
    assert.deepEqual(
      structuredClone(recoveredPairing.sealedEnrollment),
      structuredClone(pairingRedemption.sealedEnrollment),
    )
    assert.equal(recoveredPairing.agent.id, pairingRedemption.agent.id)
    assert.equal(recoveredPairing.agent.globalId, pairingRedemption.agent.globalId)
    assert.equal(
      (await pool.query(
        `SELECT count(*)::int AS count
         FROM operations_print_agents
         WHERE organization_id = $1::uuid
           AND id = $2::uuid`,
        [fixture.organizationId, pairingRedemption.agent.id],
      )).rows[0].count,
      1,
    )
    await expectRejected(
      () => persistence.redeemOperationsPrintAgentPairingGrantInPostgres({
        pairingCode: pairingIssue.pairingGrant.pairingCode,
        idempotencyKey: `redeem-replay-${fixture.suffix}`,
        client: pairingClient.request,
      }),
      /original installation and Idempotency-Key/,
    )
    const differentPairingClient = pairingRecoveryClient()
    await expectRejected(
      () => persistence.redeemOperationsPrintAgentPairingGrantInPostgres({
        pairingCode: pairingIssue.pairingGrant.pairingCode,
        idempotencyKey: pairingRedemptionKey,
        client: differentPairingClient.request,
      }),
      /different print-agent installation key/,
    )

    const concurrentIssue = await persistence
      .createOperationsPrintAgentPairingGrantInPostgres({
        ...pairingInput,
        name: 'Concurrent pairing agent',
        idempotencyKey: `pairing-concurrent-${fixture.suffix}`,
      })
    const concurrentPairingClient = pairingRecoveryClient()
    const concurrentRedemptionKey = `pairing-concurrent-${fixture.suffix}`
    const concurrentRedemptions = await Promise.allSettled([
      persistence.redeemOperationsPrintAgentPairingGrantInPostgres({
        pairingCode: concurrentIssue.pairingGrant.pairingCode,
        idempotencyKey: concurrentRedemptionKey,
        client: concurrentPairingClient.request,
      }),
      persistence.redeemOperationsPrintAgentPairingGrantInPostgres({
        pairingCode: concurrentIssue.pairingGrant.pairingCode,
        idempotencyKey: concurrentRedemptionKey,
        client: concurrentPairingClient.request,
      }),
    ])
    assert.equal(
      concurrentRedemptions.filter((result) => result.status === 'fulfilled').length,
      2,
      'Exact concurrent retries must recover one sealed enrollment',
    )
    assert.equal(
      concurrentRedemptions.filter((result) => result.status === 'rejected').length,
      0,
    )
    const concurrentValues = concurrentRedemptions.map((result) => result.value)
    assert.equal(new Set(concurrentValues.map((result) => result.agent.id)).size, 1)
    assert.deepEqual(
      structuredClone(concurrentValues[0].sealedEnrollment),
      structuredClone(concurrentValues[1].sealedEnrollment),
    )

    const invalidSecretIssue = await persistence
      .createOperationsPrintAgentPairingGrantInPostgres({
        ...pairingInput,
        name: 'Wrong-secret pairing agent',
        idempotencyKey: `pairing-wrong-secret-${fixture.suffix}`,
      })
    const correctPairingCode = invalidSecretIssue.pairingGrant.pairingCode
    const finalCharacter = correctPairingCode.at(-1)
    const wrongPairingCode = `${correctPairingCode.slice(0, -1)}${
      finalCharacter === 'A' ? 'B' : 'A'
    }`
    const invalidSecretClient = pairingRecoveryClient()
    await expectRejected(
      () => persistence.redeemOperationsPrintAgentPairingGrantInPostgres({
        pairingCode: wrongPairingCode,
        idempotencyKey: `pairing-wrong-${fixture.suffix}`,
        client: invalidSecretClient.request,
      }),
      /pairing code is invalid/i,
    )
    const stillPendingGrant = await pool.query(
      `SELECT status, print_agent_id
       FROM operations_print_agent_pairing_grants
       WHERE id = $1::uuid`,
      [invalidSecretIssue.pairingGrant.id],
    )
    assert.deepEqual(stillPendingGrant.rows[0], {
      status: 'pending',
      print_agent_id: null,
    })
    const validAfterWrongSecret = await persistence
      .redeemOperationsPrintAgentPairingGrantInPostgres({
        pairingCode: correctPairingCode,
        idempotencyKey: `pairing-valid-after-wrong-${fixture.suffix}`,
        client: invalidSecretClient.request,
      })
    assert.ok(validAfterWrongSecret.sealedEnrollment)

    const expiredMaterial = persistence.createOperationsPrintAgentPairingCode()
    const expiredReservedAgentId = randomUUID()
    await pool.query(
      `INSERT INTO operations_print_agent_pairing_grants (
         id, organization_id, warehouse_id, reserved_agent_id, name,
         secret_hash, supported_formats, supported_media,
         supported_document_types, request_fingerprint, idempotency_key,
         created_by, created_at, expires_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5,
         $6, $7::text[], $8::text[], $9::text[], $10, $11, $12,
         clock_timestamp() - interval '11 minutes',
         clock_timestamp() - interval '2 minutes'
       )`,
      [
        expiredMaterial.pairingGrantId,
        fixture.organizationId,
        fixture.warehouseId,
        expiredReservedAgentId,
        'Expired pairing agent',
        expiredMaterial.secretHash,
        printing.DEFAULT_PRINT_AGENT_CAPABILITIES.supportedFormats,
        printing.DEFAULT_PRINT_AGENT_CAPABILITIES.supportedMedia,
        printing.DEFAULT_PRINT_AGENT_CAPABILITIES.supportedDocumentTypes,
        persistence.operationsPrintDeliveryFingerprint({ expired: true }),
        `pairing-expired-${fixture.suffix}`,
        fixture.actorEmail,
      ],
    )
    await expectRejected(
      () => persistence.redeemOperationsPrintAgentPairingGrantInPostgres({
        pairingCode: expiredMaterial.pairingCode,
        idempotencyKey: `redeem-expired-${fixture.suffix}`,
        client: pairingRecoveryClient().request,
      }),
      /expired/,
    )
    const expiredGrant = await pool.query(
      `SELECT status, expired_at IS NOT NULL AS expired
       FROM operations_print_agent_pairing_grants
       WHERE id = $1::uuid`,
      [expiredMaterial.pairingGrantId],
    )
    assert.deepEqual(expiredGrant.rows[0], {
      status: 'expired',
      expired: true,
    })

    const legacyConsumedAgent = await persistence.enrollOperationsPrintAgentInPostgres({
      organizationId: fixture.organizationId,
      warehouseId: fixture.warehouseId,
      name: 'Pre-recovery pairing agent',
      actorEmail: fixture.actorEmail,
      idempotencyKey: `pre-recovery-agent-${fixture.suffix}`,
      ...printing.DEFAULT_PRINT_AGENT_CAPABILITIES,
    })
    const legacyConsumedMaterial = persistence
      .createOperationsPrintAgentPairingCode()
    await pool.query(
      `INSERT INTO operations_print_agent_pairing_grants (
         id, organization_id, warehouse_id, reserved_agent_id, name,
         secret_hash, supported_formats, supported_media,
         supported_document_types, status, request_fingerprint,
         idempotency_key, created_by, created_at, expires_at,
         redeemed_at, print_agent_id, redemption_idempotency_key,
         redemption_request_fingerprint
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5,
         $6, $7::text[], $8::text[],
         $9::text[], 'redeemed', $10,
         $11, $12, clock_timestamp() - interval '2 minutes',
         clock_timestamp() + interval '7 minutes 59 seconds',
         clock_timestamp() - interval '1 minute', $4::uuid, $13, $14
       )`,
      [
        legacyConsumedMaterial.pairingGrantId,
        fixture.organizationId,
        fixture.warehouseId,
        legacyConsumedAgent.agent.id,
        'Pre-recovery pairing agent',
        legacyConsumedMaterial.secretHash,
        printing.DEFAULT_PRINT_AGENT_CAPABILITIES.supportedFormats,
        printing.DEFAULT_PRINT_AGENT_CAPABILITIES.supportedMedia,
        printing.DEFAULT_PRINT_AGENT_CAPABILITIES.supportedDocumentTypes,
        persistence.operationsPrintDeliveryFingerprint({ legacy: true }),
        `pre-recovery-grant-${fixture.suffix}`,
        fixture.actorEmail,
        `pre-recovery-redeem-${fixture.suffix}`,
        persistence.operationsPrintDeliveryFingerprint({
          legacyRedemption: true,
        }),
      ],
    )
    await expectRejected(
      () => persistence.redeemOperationsPrintAgentPairingGrantInPostgres({
        pairingCode: legacyConsumedMaterial.pairingCode,
        idempotencyKey: `pre-recovery-redeem-${fixture.suffix}`,
        client: pairingRecoveryClient().request,
      }),
      /redeemed by an older client/,
    )

    const recoveryExpiredAgent = await persistence.enrollOperationsPrintAgentInPostgres({
      organizationId: fixture.organizationId,
      warehouseId: fixture.warehouseId,
      name: 'Expired recovery-window agent',
      actorEmail: fixture.actorEmail,
      idempotencyKey: `expired-recovery-agent-${fixture.suffix}`,
      ...printing.DEFAULT_PRINT_AGENT_CAPABILITIES,
    })
    const recoveryExpiredMaterial = persistence
      .createOperationsPrintAgentPairingCode()
    const recoveryExpiredClient = pairingRecoveryClient()
    const recoveryExpiredKey = `expired-recovery-redeem-${fixture.suffix}`
    const recoveryExpiredFingerprint = persistence
      .operationsPrintDeliveryFingerprint({
        action: 'redeem-print-agent-pairing-grant-v2',
        protocol: 'x25519-hkdf-sha256-aes-256-gcm-v1',
        pairingGrantId: recoveryExpiredMaterial.pairingGrantId,
        organizationId: fixture.organizationId,
        reservedAgentId: recoveryExpiredAgent.agent.id,
        warehouseId: fixture.warehouseId,
        name: 'Expired recovery-window agent',
        supportedFormats: printing.DEFAULT_PRINT_AGENT_CAPABILITIES.supportedFormats,
        supportedMedia: printing.DEFAULT_PRINT_AGENT_CAPABILITIES.supportedMedia,
        supportedDocumentTypes:
          printing.DEFAULT_PRINT_AGENT_CAPABILITIES.supportedDocumentTypes,
        installationId: recoveryExpiredClient.request.installationId,
        clientKeyFingerprint:
          recoveryExpiredClient.request.clientKeyFingerprint,
        idempotencyKey: recoveryExpiredKey,
      })
    await pool.query(
      `INSERT INTO operations_print_agent_pairing_grants (
         id, organization_id, warehouse_id, reserved_agent_id, name,
         secret_hash, supported_formats, supported_media,
         supported_document_types, status, request_fingerprint,
         idempotency_key, created_by, created_at, expires_at,
         redeemed_at, print_agent_id, redemption_idempotency_key,
         redemption_request_fingerprint, redemption_protocol,
         client_installation_id, client_public_key_spki,
         client_key_fingerprint, credential_envelope,
         credential_envelope_sha256, recovery_expires_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5,
         $6, $7::text[], $8::text[],
         $9::text[], 'redeemed', $10,
         $11, $12, clock_timestamp() - interval '4 minutes',
         clock_timestamp() + interval '5 minutes',
         clock_timestamp() - interval '2 minutes', $4::uuid, $13,
         $14, 'x25519-hkdf-sha256-aes-256-gcm-v1',
         $15::uuid, $16, $17, $18::jsonb, $19,
         clock_timestamp() - interval '1 minute'
       )`,
      [
        recoveryExpiredMaterial.pairingGrantId,
        fixture.organizationId,
        fixture.warehouseId,
        recoveryExpiredAgent.agent.id,
        'Expired recovery-window agent',
        recoveryExpiredMaterial.secretHash,
        printing.DEFAULT_PRINT_AGENT_CAPABILITIES.supportedFormats,
        printing.DEFAULT_PRINT_AGENT_CAPABILITIES.supportedMedia,
        printing.DEFAULT_PRINT_AGENT_CAPABILITIES.supportedDocumentTypes,
        persistence.operationsPrintDeliveryFingerprint({
          expiredRecoveryGrant: true,
        }),
        `expired-recovery-grant-${fixture.suffix}`,
        fixture.actorEmail,
        recoveryExpiredKey,
        recoveryExpiredFingerprint,
        recoveryExpiredClient.request.installationId,
        recoveryExpiredClient.request.clientPublicKey,
        recoveryExpiredClient.request.clientKeyFingerprint,
        JSON.stringify({
          schemaVersion: 1,
          keyAgreement: 'X25519',
          keyDerivation: 'HKDF-SHA256',
          contentEncryption: 'A256GCM',
          serverPublicKey: 'A'.repeat(59),
          salt: 'B'.repeat(43),
          iv: 'C'.repeat(16),
          ciphertext: 'D',
          authTag: 'E'.repeat(22),
          authenticatedContext: 'F',
        }),
        'd'.repeat(64),
      ],
    )
    await expectRejected(
      () => persistence.redeemOperationsPrintAgentPairingGrantInPostgres({
        pairingCode: recoveryExpiredMaterial.pairingCode,
        idempotencyKey: recoveryExpiredKey,
        client: recoveryExpiredClient.request,
      }),
      /pairing recovery window expired/i,
    )

    const legacyBundledEnrollment = await persistence.enrollOperationsPrintAgentInPostgres({
      organizationId: fixture.organizationId,
      warehouseId: fixture.warehouseId,
      name: 'Legacy bundled Zebra agent',
      actorEmail: fixture.actorEmail,
      idempotencyKey: `legacy-bundled-agent-${fixture.suffix}`,
      ...printing.LEGACY_BUNDLED_PRINT_AGENT_CAPABILITIES,
    })
    const upgradedBundledAgent = await persistence
      .upgradeOperationsPrintAgentToBundledCapabilitiesInPostgres({
        organizationId: fixture.organizationId,
        printAgentGlobalId: legacyBundledEnrollment.agent.globalId,
        actorEmail: fixture.actorEmail,
        idempotencyKey: `upgrade-bundled-agent-${fixture.suffix}`,
      })
    assert.deepEqual(
      structuredClone(upgradedBundledAgent.supportedFormats),
      structuredClone(printing.DEFAULT_PRINT_AGENT_CAPABILITIES.supportedFormats),
    )
    assert.deepEqual(
      structuredClone(upgradedBundledAgent.supportedMedia),
      structuredClone(printing.DEFAULT_PRINT_AGENT_CAPABILITIES.supportedMedia),
    )
    assert.deepEqual(
      structuredClone(upgradedBundledAgent.supportedDocumentTypes),
      structuredClone(printing.DEFAULT_PRINT_AGENT_CAPABILITIES.supportedDocumentTypes),
    )
    const replayedBundledUpgrade = await persistence
      .upgradeOperationsPrintAgentToBundledCapabilitiesInPostgres({
        organizationId: fixture.organizationId,
        printAgentGlobalId: legacyBundledEnrollment.agent.globalId,
        actorEmail: fixture.actorEmail,
        idempotencyKey: `upgrade-bundled-agent-replay-${fixture.suffix}`,
      })
    assert.equal(replayedBundledUpgrade.globalId, upgradedBundledAgent.globalId)
    assert.ok(await persistence.authenticateOperationsPrintAgentInPostgres(
      legacyBundledEnrollment.credential,
    ))
    const packingCapabilities = {
      supportedFormats: ['PDF'],
      supportedMedia: ['letter', 'a4'],
      supportedDocumentTypes: ['packing_slip'],
    }
    const labelCapabilities = {
      supportedFormats: ['ZPL'],
      supportedMedia: ['label_4x6'],
      supportedDocumentTypes: ['shipping_label'],
    }
    const primaryAgentCapabilities = {
      supportedFormats: ['ZPL', 'PDF'],
      supportedMedia: ['label_4x6', 'letter', 'a4'],
      supportedDocumentTypes: ['shipping_label', 'packing_slip'],
    }
    const primaryEnrollment = await persistence.enrollOperationsPrintAgentInPostgres({
      organizationId: fixture.organizationId,
      warehouseId: fixture.warehouseId,
      name: 'Primary print agent',
      actorEmail: fixture.actorEmail,
      idempotencyKey: `primary-agent-${fixture.suffix}`,
      ...primaryAgentCapabilities,
    })
    const fallbackEnrollment = await persistence.enrollOperationsPrintAgentInPostgres({
      organizationId: fixture.organizationId,
      warehouseId: fixture.warehouseId,
      name: 'Fallback print agent',
      actorEmail: fixture.actorEmail,
      idempotencyKey: `fallback-agent-${fixture.suffix}`,
      ...packingCapabilities,
    })
    assert.ok(primaryEnrollment.credential)
    assert.ok(fallbackEnrollment.credential)
    assert.match(
      primaryEnrollment.credential,
      /^cpprint\.v1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/i,
    )
    assert.deepEqual(
      structuredClone(primaryEnrollment.agent.supportedFormats),
      primaryAgentCapabilities.supportedFormats,
    )
    assert.deepEqual(
      structuredClone(fallbackEnrollment.agent.supportedMedia),
      packingCapabilities.supportedMedia,
    )
    await expectRejected(
      () => persistence.upgradeOperationsPrintAgentToBundledCapabilitiesInPostgres({
        organizationId: fixture.organizationId,
        printAgentGlobalId: fallbackEnrollment.agent.globalId,
        actorEmail: fixture.actorEmail,
        idempotencyKey: `reject-custom-agent-upgrade-${fixture.suffix}`,
      }),
      /Only the exact legacy bundled Zebra capability profile/,
    )

    const printSource = await seedPrintSource(pool, fixture)
    const neverConnectedPrinter = await createPrinter(pool, fixture, {
      code: `NEVER-CONNECTED-${fixture.suffix}`,
      name: 'Configured printer whose agent never connected',
      priority: 1,
      agentId: primaryEnrollment.agent.id,
      agentConnected: false,
      isDefault: false,
    })
    const neverConnectedContent = `never-connected-${fixture.suffix}`
    await assert.rejects(
      () => persistence.enqueueOperationsPrintJobInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.actorEmail,
        idempotencyKey: `never-connected-${fixture.suffix}`,
        warehouseId: fixture.warehouseId,
        preferredPrinterGlobalId: neverConnectedPrinter.global_id,
        document: {
          type: 'packing_slip',
          format: 'PDF',
          media: 'letter',
          contentSha256: createHash('sha256').update(neverConnectedContent).digest('hex'),
          byteLength: Buffer.byteLength(neverConnectedContent),
          storageReference: `clawpilot-document:never-connected-${fixture.suffix}`,
          sourceOrderGlobalId: printSource.order.global_id,
        },
      }),
      (error) => (
        error.code === 'OPERATIONS_PRINT_AGENT_NEVER_CONNECTED'
        && error.status === 409
      ),
      'Durable enqueue must fail closed until the configured agent first connects',
    )

    const fallback = await createPrinter(pool, fixture, {
      code: `FALLBACK-${fixture.suffix}`,
      name: 'Fallback packing-slip printer',
      priority: 20,
      agentId: fallbackEnrollment.agent.id,
      isDefault: false,
    })
    const primary = await createPrinter(pool, fixture, {
      code: `PRIMARY-${fixture.suffix}`,
      name: 'Primary packing-slip printer',
      priority: 10,
      agentId: primaryEnrollment.agent.id,
      isDefault: true,
      fallbackId: fallback.id,
    })
    const content = `packing-slip-${fixture.suffix}`
    const queued = await persistence.enqueueOperationsPrintJobInPostgres({
      organizationId: fixture.organizationId,
      actorEmail: fixture.actorEmail,
      idempotencyKey: `packing-slip-${fixture.suffix}`,
      warehouseId: fixture.warehouseId,
      maxAttempts: 3,
      document: {
        type: 'packing_slip',
        format: 'PDF',
        media: 'letter',
        contentSha256: createHash('sha256').update(content).digest('hex'),
        byteLength: Buffer.byteLength(content),
        storageReference: `clawpilot-document:packing-slip-${fixture.suffix}`,
        sourceOrderGlobalId: printSource.order.global_id,
        sourceShipmentGlobalId: printSource.shipment.global_id,
      },
    })
    assert.equal(queued.status, 'queued')
    assert.equal(queued.printerGlobalId, primary.global_id)
    assert.equal(queued.fallbackPrinterGlobalId, fallback.global_id)
    assert.equal(queued.attempts, 1)
    assert.equal(queued.sourceOrderGlobalId, printSource.order.global_id)
    assert.equal(queued.sourceShipmentGlobalId, printSource.shipment.global_id)
    assert.equal(queued.trackingNumber, printSource.shipment.tracking_number)

    const primaryAgent = await persistence.authenticateOperationsPrintAgentInPostgres(
      primaryEnrollment.credential,
    )
    assert.equal(primaryAgent.globalId, primaryEnrollment.agent.globalId)
    await expectRejected(
      () => persistence.claimOperationsPrintJobsInPostgres({
        agent: primaryAgent,
        idempotencyKey: `primary-invalid-capability-${fixture.suffix}`,
        limit: 1,
        leaseSeconds: 120,
        runtimeCapabilities: {
          supportedFormats: ['PNG'],
          supportedMedia: ['letter'],
          supportedDocumentTypes: ['packing_slip'],
        },
      }),
      /subset of the enrolled print-agent capabilities/,
    )
    const narrowNoMatch = await persistence.claimOperationsPrintJobsInPostgres({
      agent: primaryAgent,
      idempotencyKey: `primary-narrow-no-match-${fixture.suffix}`,
      limit: 1,
      leaseSeconds: 120,
      runtimeCapabilities: labelCapabilities,
    })
    assert.equal(narrowNoMatch.length, 0)
    const primaryClaim = await persistence.claimOperationsPrintJobsInPostgres({
      agent: primaryAgent,
      idempotencyKey: `primary-claim-${fixture.suffix}`,
      limit: 1,
      leaseSeconds: 120,
      runtimeCapabilities: packingCapabilities,
    })
    assert.equal(primaryClaim.length, 1)
    assert.equal(primaryClaim[0].globalId, queued.globalId)
    assert.equal(primaryClaim[0].document.media, 'letter')
    assert.ok(Number.isFinite(Date.parse(primaryClaim[0].serverNow)))
    assert.ok(Date.parse(primaryClaim[0].claimExpiresAt) > Date.parse(primaryClaim[0].serverNow))
    const duplicatePrimaryClaim = await persistence.claimOperationsPrintJobsInPostgres({
      agent: primaryAgent,
      idempotencyKey: `primary-claim-${fixture.suffix}`,
      limit: 1,
      leaseSeconds: 120,
      runtimeCapabilities: packingCapabilities,
    })
    assert.equal(duplicatePrimaryClaim.length, 1)
    assert.equal(
      duplicatePrimaryClaim[0].claimToken,
      primaryClaim[0].claimToken,
    )

    await expectRejected(
      () => persistence.failOperationsPrintJobInPostgres({
        agent: primaryAgent,
        jobGlobalId: queued.globalId,
        claimToken: primaryClaim[0].claimToken,
        idempotencyKey: `invalid-uncertain-retry-${fixture.suffix}`,
        errorCode: 'PRINT_OUTCOME_UNCERTAIN',
        errorMessage: 'A buggy agent asked to retry an uncertain physical result',
        retryable: true,
        printerUnavailable: true,
        retryAfterSeconds: 30,
      }),
      /terminal and may not be retried automatically/,
    )
    const failed = await persistence.failOperationsPrintJobInPostgres({
      agent: primaryAgent,
      jobGlobalId: queued.globalId,
      claimToken: primaryClaim[0].claimToken,
      idempotencyKey: `primary-failure-${fixture.suffix}`,
      errorCode: 'PRINTER_OFFLINE',
      errorMessage: 'Primary printer did not accept the job',
      retryable: true,
      printerUnavailable: true,
      retryAfterSeconds: 0,
    })
    assert.equal(failed.status, 'queued')
    assert.equal(failed.printerGlobalId, fallback.global_id)
    assert.equal(failed.attempts, 2)

    await expectRejected(
      () => persistence.acknowledgeOperationsPrintJobInPostgres({
        agent: primaryAgent,
        jobGlobalId: queued.globalId,
        claimToken: primaryClaim[0].claimToken,
        idempotencyKey: `stale-ack-${fixture.suffix}`,
      }),
      /no longer current/,
    )

    const fallbackAgent = await persistence.authenticateOperationsPrintAgentInPostgres(
      fallbackEnrollment.credential,
    )
    const fallbackClaim = await persistence.claimOperationsPrintJobsInPostgres({
      agent: fallbackAgent,
      idempotencyKey: `fallback-claim-${fixture.suffix}`,
      limit: 1,
      leaseSeconds: 120,
      runtimeCapabilities: packingCapabilities,
    })
    assert.equal(fallbackClaim.length, 1)
    assert.equal(fallbackClaim[0].printer.globalId, fallback.global_id)
    const [delivered, duplicateAck] = await Promise.all([
      persistence.acknowledgeOperationsPrintJobInPostgres({
        agent: fallbackAgent,
        jobGlobalId: queued.globalId,
        claimToken: fallbackClaim[0].claimToken,
        idempotencyKey: `fallback-ack-${fixture.suffix}`,
        deviceJobReference: `device-${fixture.suffix}`,
      }),
      persistence.acknowledgeOperationsPrintJobInPostgres({
        agent: fallbackAgent,
        jobGlobalId: queued.globalId,
        claimToken: fallbackClaim[0].claimToken,
        idempotencyKey: `fallback-ack-${fixture.suffix}`,
        deviceJobReference: `device-${fixture.suffix}`,
      }),
    ])
    assert.equal(delivered.status, 'delivered')
    assert.ok(delivered.deliveredAt)
    assert.equal(duplicateAck.status, 'delivered')
    const deliveredReference = delivered.attemptHistory.find((attempt) => (
      attempt.state === 'delivered'
    ))?.deviceJobReference
    assert.match(
      deliveredReference,
      /^local-device\.legacy\.v1\.redacted$/,
    )
    assert.doesNotMatch(deliveredReference, new RegExp(`device-${fixture.suffix}`))
    const storedReference = await pool.query(
      `SELECT attempt.device_job_reference
       FROM operations_print_delivery_attempts attempt
       JOIN operations_print_jobs job
         ON job.organization_id = attempt.organization_id
        AND job.id = attempt.print_job_id
       WHERE job.organization_id = $1::uuid
         AND job.global_id = $2
         AND attempt.state = 'delivered'
       LIMIT 1`,
      [fixture.organizationId, queued.globalId],
    )
    assert.equal(storedReference.rows[0].device_job_reference, deliveredReference)

    assert.ok(delivered.deliveredAttemptId)
    assert.ok(delivered.deliveredAttemptSequenceNumber > 0)
    assert.equal(delivered.physicalOutputAttestation, null)
    const verifierEmail = `print-output-verifier-${fixture.suffix}@example.com`
    await pool.query(
      `INSERT INTO app_users (email, role, status, display_name)
       VALUES ($1, 'member', 'active', 'Print Output Verifier')`,
      [verifierEmail],
    )
    await pool.query(
      `INSERT INTO app_user_organization_memberships (
         user_email, organization_id, role, permissions, status,
         is_default, created_by, updated_by
       ) VALUES (
         $1, $2::uuid, 'member', '{"executeWarehouse":false}'::jsonb,
         'active', false, $3, $3
       )`,
      [verifierEmail, fixture.organizationId, fixture.actorEmail],
    )
    const attestationInput = {
      organizationId: fixture.organizationId,
      jobGlobalId: queued.globalId,
      expectedDeliveryAttemptId: delivered.deliveredAttemptId,
      expectedDeliveryAttemptSequenceNumber:
        delivered.deliveredAttemptSequenceNumber,
      actorEmail: verifierEmail,
      idempotencyKey: `physical-output-${fixture.suffix}`,
      reason: [
        'Observed one complete, legible packing slip exit the printer.',
        '\tSecond line confirms the page was not torn or clipped.',
      ].join('\n'),
    }
    await expectRejected(
      () => persistence.attestOperationsPrintJobPhysicalOutputInPostgres(
        attestationInput,
      ),
      /requires active warehouse execution access/,
    )
    await pool.query(
      `UPDATE app_user_organization_memberships
       SET permissions = permissions || '{"executeWarehouse":true}'::jsonb,
           updated_by = $3,
           updated_at = clock_timestamp()
       WHERE user_email = $1
         AND organization_id = $2::uuid`,
      [verifierEmail, fixture.organizationId, fixture.actorEmail],
    )
    await expectRejected(
      () => persistence.attestOperationsPrintJobPhysicalOutputInPostgres({
        ...attestationInput,
        expectedDeliveryAttemptSequenceNumber:
          delivered.deliveredAttemptSequenceNumber + 1,
        idempotencyKey: `physical-output-stale-${fixture.suffix}`,
      }),
      /exact delivered print-job version changed/,
    )
    await expectRejected(
      () => persistence.attestOperationsPrintJobPhysicalOutputInPostgres({
        ...attestationInput,
        organizationId: randomUUID(),
        idempotencyKey: `physical-output-cross-tenant-${fixture.suffix}`,
      }),
      /Print job was not found/,
    )
    const [attested, attestationReplay] = await Promise.all([
      persistence.attestOperationsPrintJobPhysicalOutputInPostgres(
        attestationInput,
      ),
      persistence.attestOperationsPrintJobPhysicalOutputInPostgres(
        attestationInput,
      ),
    ])
    assert.equal(attested.globalId, queued.globalId)
    assert.equal(attestationReplay.globalId, queued.globalId)
    assert.equal(
      attested.physicalOutputAttestation.deliveryAttemptId,
      delivered.deliveredAttemptId,
    )
    assert.equal(
      attested.physicalOutputAttestation.deliveryAttemptSequenceNumber,
      delivered.deliveredAttemptSequenceNumber,
    )
    assert.equal(attested.physicalOutputAttestation.deliveredAt, delivered.deliveredAt)
    assert.equal(
      attested.physicalOutputAttestation.verifiedAt,
      attestationReplay.physicalOutputAttestation.verifiedAt,
    )
    assert.equal(attested.physicalOutputAttestation.verifiedBy, verifierEmail)
    assert.equal(attested.physicalOutputAttestation.reason, attestationInput.reason)
    await expectRejected(
      () => persistence.attestOperationsPrintJobPhysicalOutputInPostgres({
        ...attestationInput,
        reason: 'A different statement cannot reuse the same command key',
      }),
      /Idempotency-Key was already used/,
    )
    await expectRejected(
      () => persistence.attestOperationsPrintJobPhysicalOutputInPostgres({
        ...attestationInput,
        idempotencyKey: `physical-output-duplicate-${fixture.suffix}`,
      }),
      /already confirmed/,
    )
    const physicalOutputEvidence = await insertReturning(
      pool,
      `SELECT
         attestation.id::text,
         attestation.verified_by,
         attestation.reason,
         attempt.physical_output_verified AS agent_asserted_physical_output
       FROM operations_print_physical_output_attestations attestation
       JOIN operations_print_delivery_attempts attempt
         ON attempt.organization_id = attestation.organization_id
        AND attempt.print_job_id = attestation.print_job_id
        AND attempt.id = attestation.delivery_attempt_id
       WHERE attestation.organization_id = $1::uuid
         AND attestation.print_job_id = (
           SELECT id FROM operations_print_jobs
           WHERE organization_id = $1::uuid AND global_id = $2
         )`,
      [fixture.organizationId, queued.globalId],
    )
    assert.deepEqual(physicalOutputEvidence, {
      id: physicalOutputEvidence.id,
      verified_by: verifierEmail,
      reason: attestationInput.reason,
      agent_asserted_physical_output: false,
    })
    await expectRejected(
      () => pool.query(
        `UPDATE operations_print_physical_output_attestations
         SET reason = 'must not change'
         WHERE id = $1::uuid`,
        [physicalOutputEvidence.id],
      ),
      /append-only/i,
    )
    await expectRejected(
      () => pool.query(
        `DELETE FROM operations_print_physical_output_attestations
         WHERE id = $1::uuid`,
        [physicalOutputEvidence.id],
      ),
      /append-only/i,
    )
    const attestationPersistenceHealth = await insertReturning(
      pool,
      `SELECT
         (
           ${physicalOutputHealth.OPERATIONS_PRINT_PHYSICAL_OUTPUT_HEALTH_SQL}
         ) AS exact_health_ready,
         EXISTS (
           SELECT 1 FROM schema_migrations
           WHERE filename =
             '0338_operations_print_physical_output_attestation.sql'
             AND checksum ~ '^[a-f0-9]{64}$'
         ) AS migration_recorded,
         to_regclass(
           'public.operations_print_physical_output_attestations'
         ) IS NOT NULL AS table_present,
         EXISTS (
           SELECT 1 FROM pg_trigger trigger
           WHERE trigger.tgrelid = to_regclass(
             'public.operations_print_physical_output_attestations'
           )
             AND trigger.tgname =
               'validate_operations_print_physical_output_attestation_write'
             AND trigger.tgenabled = 'O'
             AND NOT trigger.tgisinternal
         ) AS validation_guard_enabled,
         EXISTS (
           SELECT 1 FROM pg_trigger trigger
           WHERE trigger.tgrelid = to_regclass(
             'public.operations_print_physical_output_attestations'
           )
             AND trigger.tgname =
               'protect_operations_print_physical_output_attestation_write'
             AND trigger.tgenabled = 'O'
             AND NOT trigger.tgisinternal
         ) AS append_only_guard_enabled`,
    )
    assert.deepEqual(attestationPersistenceHealth, {
      exact_health_ready: true,
      migration_recorded: true,
      table_present: true,
      validation_guard_enabled: true,
      append_only_guard_enabled: true,
    })

    const exactPhysicalOutputHealth = async () => {
      const result = await insertReturning(
        pool,
        `SELECT (
           ${physicalOutputHealth.OPERATIONS_PRINT_PHYSICAL_OUTPUT_HEALTH_SQL}
         ) AS ready`,
      )
      return result.ready
    }
    const assertPhysicalOutputCatalogTamperDetected = async (tamper) => {
      await pool.query('BEGIN')
      try {
        await tamper()
        assert.equal(await exactPhysicalOutputHealth(), false)
      } finally {
        await pool.query('ROLLBACK')
      }
      assert.equal(await exactPhysicalOutputHealth(), true)
    }
    await assertPhysicalOutputCatalogTamperDetected(() => pool.query(
      `CREATE OR REPLACE FUNCTION
         validate_operations_print_physical_output_attestation()
       RETURNS trigger
       LANGUAGE plpgsql
       AS $tamper$
       BEGIN
         RETURN NEW;
       END;
       $tamper$`,
    ))
    await assertPhysicalOutputCatalogTamperDetected(() => pool.query(
      `CREATE OR REPLACE FUNCTION protect_operations_append_only()
       RETURNS trigger
       LANGUAGE plpgsql
       AS $tamper$
       BEGIN
         RETURN OLD;
       END;
       $tamper$`,
    ))
    await assertPhysicalOutputCatalogTamperDetected(async () => {
      await pool.query(
        `ALTER TABLE operations_print_physical_output_attestations
         DROP CONSTRAINT operations_print_physical_output_reason_valid`,
      )
      await pool.query(
        `ALTER TABLE operations_print_physical_output_attestations
         ADD CONSTRAINT operations_print_physical_output_reason_valid
         CHECK (true)`,
      )
    })

    const reprint = await persistence.reprintOperationsPrintJobInPostgres({
      organizationId: fixture.organizationId,
      jobGlobalId: queued.globalId,
      actorEmail: fixture.actorEmail,
      idempotencyKey: `reprint-${fixture.suffix}`,
      reason: 'Original packing slip was damaged during carton close',
    })
    assert.equal(reprint.status, 'queued')
    assert.equal(reprint.reprintOfJobGlobalId, queued.globalId)
    assert.equal(reprint.printerGlobalId, fallback.global_id)
    assert.equal(reprint.sourceLabelGlobalId, null)
    const [cancelledReprint, duplicateCancellation] = await Promise.all([
      persistence.cancelOperationsPrintJobInPostgres({
        organizationId: fixture.organizationId,
        jobGlobalId: reprint.globalId,
        actorEmail: fixture.actorEmail,
        idempotencyKey: `cancel-reprint-${fixture.suffix}`,
        reason: 'Duplicate paper copy is no longer required',
      }),
      persistence.cancelOperationsPrintJobInPostgres({
        organizationId: fixture.organizationId,
        jobGlobalId: reprint.globalId,
        actorEmail: fixture.actorEmail,
        idempotencyKey: `cancel-reprint-${fixture.suffix}`,
        reason: 'Duplicate paper copy is no longer required',
      }),
    ])
    assert.equal(cancelledReprint.status, 'cancelled')
    assert.equal(duplicateCancellation.status, 'cancelled')

    const deliveredReprint = await persistence.reprintOperationsPrintJobInPostgres({
      organizationId: fixture.organizationId,
      jobGlobalId: queued.globalId,
      actorEmail: fixture.actorEmail,
      idempotencyKey: `delivered-reprint-${fixture.suffix}`,
      reason: 'Create a second physical copy for the receiving desk',
    })
    const deliveredReprintClaim = await persistence.claimOperationsPrintJobsInPostgres({
      agent: fallbackAgent,
      idempotencyKey: `delivered-reprint-claim-${fixture.suffix}`,
      limit: 1,
      leaseSeconds: 120,
      runtimeCapabilities: packingCapabilities,
    })
    assert.equal(deliveredReprintClaim[0].globalId, deliveredReprint.globalId)
    const acknowledgedReprint = await persistence.acknowledgeOperationsPrintJobInPostgres({
      agent: fallbackAgent,
      jobGlobalId: deliveredReprint.globalId,
      claimToken: deliveredReprintClaim[0].claimToken,
      idempotencyKey: `delivered-reprint-ack-${fixture.suffix}`,
    })
    await expectRejected(
      () => persistence.attestOperationsPrintJobPhysicalOutputInPostgres({
        ...attestationInput,
        jobGlobalId: deliveredReprint.globalId,
        expectedDeliveryAttemptId: acknowledgedReprint.deliveredAttemptId,
        expectedDeliveryAttemptSequenceNumber:
          acknowledgedReprint.deliveredAttemptSequenceNumber,
      }),
      /Idempotency-Key was already used/,
    )
    const attestedReprint = await persistence
      .attestOperationsPrintJobPhysicalOutputInPostgres({
        organizationId: fixture.organizationId,
        jobGlobalId: deliveredReprint.globalId,
        expectedDeliveryAttemptId: acknowledgedReprint.deliveredAttemptId,
        expectedDeliveryAttemptSequenceNumber:
          acknowledgedReprint.deliveredAttemptSequenceNumber,
        actorEmail: verifierEmail,
        idempotencyKey: `delivered-reprint-output-${fixture.suffix}`,
        reason: 'Observed the receiving-desk reprint exit on one complete sheet',
      })
    assert.equal(attestedReprint.reprintOfJobGlobalId, queued.globalId)
    assert.equal(
      attestedReprint.physicalOutputAttestation.deliveryAttemptId,
      acknowledgedReprint.deliveredAttemptId,
    )

    const uncertainSource = await persistence.reprintOperationsPrintJobInPostgres({
      organizationId: fixture.organizationId,
      jobGlobalId: queued.globalId,
      actorEmail: fixture.actorEmail,
      idempotencyKey: `uncertain-source-${fixture.suffix}`,
      reason: 'Create an isolated uncertain-outcome recovery fixture',
    })
    const uncertainClaim = await persistence.claimOperationsPrintJobsInPostgres({
      agent: fallbackAgent,
      idempotencyKey: `uncertain-claim-${fixture.suffix}`,
      limit: 1,
      leaseSeconds: 120,
      runtimeCapabilities: packingCapabilities,
    })
    assert.equal(uncertainClaim.length, 1)
    assert.equal(uncertainClaim[0].globalId, uncertainSource.globalId)
    const uncertainFailure = await persistence.failOperationsPrintJobInPostgres({
      agent: fallbackAgent,
      jobGlobalId: uncertainSource.globalId,
      claimToken: uncertainClaim[0].claimToken,
      idempotencyKey: `uncertain-failure-${fixture.suffix}`,
      errorCode: 'PRINT_OUTCOME_UNCERTAIN',
      errorMessage: 'The raw socket accepted delivery but completion was not proven',
      retryable: false,
      printerUnavailable: false,
      retryAfterSeconds: 0,
    })
    assert.equal(uncertainFailure.status, 'failed')
    assert.equal(uncertainFailure.attemptHistory.at(-1).errorCode, 'PRINT_OUTCOME_UNCERTAIN')
    await expectRejected(
      () => persistence.retryOperationsPrintJobInPostgres({
        organizationId: fixture.organizationId,
        jobGlobalId: uncertainSource.globalId,
        actorEmail: fixture.actorEmail,
        idempotencyKey: `uncertain-retry-denied-${fixture.suffix}`,
        reason: 'A same-job retry must never cross an uncertain delivery fence',
      }),
      /may already have occurred/,
    )
    const uncertainRecoveryInput = {
      organizationId: fixture.organizationId,
      jobGlobalId: uncertainSource.globalId,
      actorEmail: fixture.actorEmail,
      idempotencyKey: `uncertain-new-print-${fixture.suffix}`,
      reason: 'Operator inspected the printer and confirmed no physical label was present',
    }
    const [uncertainRecovery, uncertainRecoveryReplay] = await Promise.all([
      persistence.reprintOperationsPrintJobInPostgres(uncertainRecoveryInput),
      persistence.reprintOperationsPrintJobInPostgres(uncertainRecoveryInput),
    ])
    assert.equal(uncertainRecovery.status, 'queued')
    assert.equal(uncertainRecoveryReplay.globalId, uncertainRecovery.globalId)
    assert.notEqual(uncertainRecovery.globalId, uncertainSource.globalId)
    assert.equal(uncertainRecovery.reprintOfJobGlobalId, uncertainSource.globalId)
    assert.match(uncertainRecovery.routingReason, /new print after uncertain outcome/i)
    const cancelledUncertainRecovery = await persistence.cancelOperationsPrintJobInPostgres({
      organizationId: fixture.organizationId,
      jobGlobalId: uncertainRecovery.globalId,
      actorEmail: fixture.actorEmail,
      idempotencyKey: `cancel-uncertain-recovery-${fixture.suffix}`,
      reason: 'Recovery contract was proven without physical output',
    })
    assert.equal(cancelledUncertainRecovery.status, 'cancelled')

    const expiredLeaseSource = await persistence.reprintOperationsPrintJobInPostgres({
      organizationId: fixture.organizationId,
      jobGlobalId: queued.globalId,
      actorEmail: fixture.actorEmail,
      idempotencyKey: `expired-lease-source-${fixture.suffix}`,
      reason: 'Create an isolated expired-lease uncertainty fixture',
    })
    const expiredLeaseClaim = await persistence.claimOperationsPrintJobsInPostgres({
      agent: fallbackAgent,
      idempotencyKey: `expired-lease-claim-${fixture.suffix}`,
      limit: 1,
      leaseSeconds: 120,
      runtimeCapabilities: packingCapabilities,
    })
    assert.equal(expiredLeaseClaim.length, 1)
    assert.equal(expiredLeaseClaim[0].globalId, expiredLeaseSource.globalId)
    await pool.query(
      `ALTER TABLE operations_print_delivery_attempts
       DISABLE TRIGGER protect_operations_print_delivery_attempt_write`,
    )
    try {
      await pool.query(
        `UPDATE operations_print_delivery_attempts
         SET occurred_at = clock_timestamp() - interval '2 seconds',
             claim_expires_at = clock_timestamp() - interval '1 second'
         WHERE organization_id = $1::uuid
           AND id = $2::uuid
           AND state = 'claimed'`,
        [fixture.organizationId, expiredLeaseClaim[0].claimToken],
      )
    } finally {
      await pool.query(
        `ALTER TABLE operations_print_delivery_attempts
         ENABLE TRIGGER protect_operations_print_delivery_attempt_write`,
      )
    }
    await pool.query(
      `UPDATE operations_print_jobs
       SET claim_expires_at = clock_timestamp() - interval '1 second'
       WHERE organization_id = $1::uuid
         AND global_id = $2`,
      [fixture.organizationId, expiredLeaseSource.globalId],
    )
    const expiredLeaseRecoveryClaim = await persistence.claimOperationsPrintJobsInPostgres({
      agent: fallbackAgent,
      idempotencyKey: `expired-lease-recovery-${fixture.suffix}`,
      limit: 1,
      leaseSeconds: 120,
      runtimeCapabilities: packingCapabilities,
    })
    assert.equal(expiredLeaseRecoveryClaim.length, 0)
    const expiredLeaseWorkspace = await persistence.readOperationsPrintJobWorkspaceFromPostgres({
      organizationId: fixture.organizationId,
      canView: true,
      canManage: true,
      canExecute: true,
    })
    const expiredLeaseJob = expiredLeaseWorkspace.jobs.find(
      (job) => job.globalId === expiredLeaseSource.globalId,
    )
    assert.equal(expiredLeaseJob?.status, 'failed')
    assert.equal(expiredLeaseJob?.attemptHistory.at(-1).actorType, 'system')
    assert.equal(expiredLeaseJob?.attemptHistory.at(-1).errorCode, 'PRINT_OUTCOME_UNCERTAIN')
    await expectRejected(
      () => persistence.retryOperationsPrintJobInPostgres({
        organizationId: fixture.organizationId,
        jobGlobalId: expiredLeaseSource.globalId,
        actorEmail: fixture.actorEmail,
        idempotencyKey: `expired-lease-retry-denied-${fixture.suffix}`,
        reason: 'An expired claim must never be automatically or manually resent as the same job',
      }),
      /may already have occurred/,
    )
    const expiredLeaseAuthorizedPrint = await persistence.reprintOperationsPrintJobInPostgres({
      organizationId: fixture.organizationId,
      jobGlobalId: expiredLeaseSource.globalId,
      actorEmail: fixture.actorEmail,
      idempotencyKey: `expired-lease-new-print-${fixture.suffix}`,
      reason: 'Operator inspected the printer after lease expiry and authorized a distinct job',
    })
    assert.equal(expiredLeaseAuthorizedPrint.status, 'queued')
    assert.notEqual(expiredLeaseAuthorizedPrint.globalId, expiredLeaseSource.globalId)
    assert.equal(expiredLeaseAuthorizedPrint.reprintOfJobGlobalId, expiredLeaseSource.globalId)
    const cancelledExpiredLeasePrint = await persistence.cancelOperationsPrintJobInPostgres({
      organizationId: fixture.organizationId,
      jobGlobalId: expiredLeaseAuthorizedPrint.globalId,
      actorEmail: fixture.actorEmail,
      idempotencyKey: `cancel-expired-lease-new-print-${fixture.suffix}`,
      reason: 'Expired-lease recovery contract was proven without physical output',
    })
    assert.equal(cancelledExpiredLeasePrint.status, 'cancelled')

    const labelPrinter = await createPrinter(pool, fixture, {
      code: `LABEL-${fixture.suffix}`,
      name: 'Primary carrier-label printer',
      priority: 5,
      printerType: 'thermal',
      formats: ['ZPL'],
      media: ['label_4x6'],
      documents: ['shipping_label'],
      agentId: primaryEnrollment.agent.id,
      isDefault: true,
    })
    const labelEnqueueInput = {
      organizationId: fixture.organizationId,
      actorEmail: fixture.actorEmail,
      idempotencyKey: `label-original-${fixture.suffix}`,
      warehouseId: fixture.warehouseId,
      preferredPrinterGlobalId: labelPrinter.global_id,
      maxAttempts: 3,
      document: {
        type: 'shipping_label',
        sourceLabelGlobalId: printSource.label.global_id,
        media: 'label_4x6',
      },
    }
    const [labelJob, labelReplay] = await Promise.all([
      persistence.enqueueOperationsPrintJobInPostgres(labelEnqueueInput),
      persistence.enqueueOperationsPrintJobInPostgres(labelEnqueueInput),
    ])
    assert.equal(labelReplay.globalId, labelJob.globalId)
    assert.equal(labelJob.sourceLabelGlobalId, printSource.label.global_id)
    assert.equal(labelJob.sourceOrderGlobalId, printSource.order.global_id)
    assert.equal(labelJob.sourceShipmentGlobalId, printSource.shipment.global_id)
    await expectRejected(
      () => persistence.enqueueOperationsPrintJobInPostgres({
        ...labelEnqueueInput,
        idempotencyKey: `label-duplicate-${fixture.suffix}`,
      }),
      /already has original print job/,
    )
    const labelClaim = await persistence.claimOperationsPrintJobsInPostgres({
      agent: primaryAgent,
      idempotencyKey: `label-claim-${fixture.suffix}`,
      limit: 1,
      leaseSeconds: 120,
      runtimeCapabilities: labelCapabilities,
    })
    assert.equal(labelClaim.length, 1)
    assert.equal(labelClaim[0].globalId, labelJob.globalId)
    assert.equal(labelClaim[0].printer.globalId, labelPrinter.global_id)
    const deliveredLabel = await persistence.acknowledgeOperationsPrintJobInPostgres({
      agent: primaryAgent,
      jobGlobalId: labelJob.globalId,
      claimToken: labelClaim[0].claimToken,
      idempotencyKey: `label-ack-${fixture.suffix}`,
      deviceJobReference: `label-device-${fixture.suffix}`,
    })
    assert.equal(deliveredLabel.status, 'delivered')
    const labelReprint = await persistence.reprintOperationsPrintJobInPostgres({
      organizationId: fixture.organizationId,
      jobGlobalId: labelJob.globalId,
      actorEmail: fixture.actorEmail,
      idempotencyKey: `label-reprint-${fixture.suffix}`,
      reason: 'Carrier label was damaged before parcel handoff',
    })
    assert.equal(labelReprint.status, 'queued')
    assert.equal(labelReprint.reprintOfJobGlobalId, labelJob.globalId)
    assert.equal(labelReprint.sourceLabelGlobalId, printSource.label.global_id)
    await persistence.cancelOperationsPrintJobInPostgres({
      organizationId: fixture.organizationId,
      jobGlobalId: labelReprint.globalId,
      actorEmail: fixture.actorEmail,
      idempotencyKey: `cancel-label-reprint-${fixture.suffix}`,
      reason: 'Controlled label reprint proof completed without physical output',
    })

    const externalSource = await seedExternalFulfillmentSource(pool, fixture)
    const externalZpl = Buffer.from(
      `^XA\n^FO24,24^FDExternal ${fixture.suffix}^FS\n^XZ`,
      'utf8',
    )
    const externalImportInput = {
      organizationId: fixture.organizationId,
      actorEmail: fixture.actorEmail,
      idempotencyKey: `external-label-import-${fixture.suffix}`,
      orderGlobalId: externalSource.order.global_id,
      expectedOrderRowVersion: Number(externalSource.order.row_version),
      reconciliationGlobalId: externalSource.reconciliation.global_id,
      trackingNumber: externalSource.trackingNumber,
      format: 'ZPL',
      media: 'label_4x6',
      filename: '../../unsafe original label.zpl',
      payload: externalZpl,
      reason: 'Retain the exact original external carrier label for audited reprint',
    }
    const importedExternal = await externalLabels
      .importOperationsExternalFulfillmentLabelInPostgres(externalImportInput)
    assert.equal(importedExternal.replayed, false)
    assert.equal(
      importedExternal.contentSha256,
      createHash('sha256').update(externalZpl).digest('hex'),
    )
    const replayedExternal = await externalLabels
      .importOperationsExternalFulfillmentLabelInPostgres(externalImportInput)
    assert.equal(replayedExternal.replayed, true)
    assert.equal(replayedExternal.artifactGlobalId, importedExternal.artifactGlobalId)
    await assert.rejects(
      externalLabels.importOperationsExternalFulfillmentLabelInPostgres({
        ...externalImportInput,
        idempotencyKey: `external-label-tracking-mismatch-${fixture.suffix}`,
        trackingNumber: `MISMATCH-${fixture.suffix}`,
      }),
      (error) => error?.code === 'OPERATIONS_EXTERNAL_LABEL_TRACKING_MISMATCH',
    )
    await assert.rejects(
      externalLabels.importOperationsExternalFulfillmentLabelInPostgres({
        ...externalImportInput,
        idempotencyKey: `external-label-order-mismatch-${fixture.suffix}`,
        orderGlobalId: printSource.order.global_id,
      }),
      (error) => error?.code === 'OPERATIONS_EXTERNAL_LABEL_RECONCILIATION_NOT_FOUND',
    )
    await assert.rejects(
      externalLabels.importOperationsExternalFulfillmentLabelInPostgres({
        ...externalImportInput,
        idempotencyKey: `external-label-format-mismatch-${fixture.suffix}`,
        format: 'PDF',
      }),
      (error) => error?.code === 'OPERATIONS_EXTERNAL_LABEL_PAYLOAD_INVALID',
    )
    await assert.rejects(
      externalLabels.importOperationsExternalFulfillmentLabelInPostgres({
        ...externalImportInput,
        idempotencyKey: `external-label-content-conflict-${fixture.suffix}`,
        payload: Buffer.from(
          `^XA\n^FO24,24^FDDifferent ${fixture.suffix}^FS\n^XZ`,
          'utf8',
        ),
      }),
      (error) => error?.code === 'OPERATIONS_EXTERNAL_LABEL_CONFLICT',
    )
    const retainedExternal = await insertReturning(
      pool,
      `SELECT artifact.global_id,
              artifact.content_sha256,
              artifact.byte_length::text,
              payload.filename,
              payload.payload,
              reconciliation.global_id AS reconciliation_global_id
       FROM operations_print_artifacts artifact
       JOIN operations_print_artifact_payloads payload
         ON payload.organization_id = artifact.organization_id
        AND payload.artifact_id = artifact.id
       JOIN operations_shopify_external_fulfillment_reconciliations reconciliation
         ON reconciliation.organization_id = artifact.organization_id
        AND reconciliation.id = artifact.source_external_fulfillment_reconciliation_id
       WHERE artifact.organization_id = $1::uuid
         AND artifact.global_id = $2`,
      [fixture.organizationId, importedExternal.artifactGlobalId],
    )
    assert.equal(retainedExternal.reconciliation_global_id, externalSource.reconciliation.global_id)
    assert.equal(retainedExternal.filename, 'unsafe-original-label.zpl')
    assert.equal(Number(retainedExternal.byte_length), externalZpl.byteLength)
    assert.deepEqual(retainedExternal.payload, externalZpl)

    const externalJob = await persistence.enqueueOperationsPrintJobInPostgres({
      organizationId: fixture.organizationId,
      actorEmail: fixture.actorEmail,
      idempotencyKey: `external-label-print-${fixture.suffix}`,
      warehouseId: fixture.warehouseId,
      preferredPrinterGlobalId: labelPrinter.global_id,
      document: {
        type: 'external_shipping_label_artifact',
        sourceArtifactGlobalId: importedExternal.artifactGlobalId,
      },
    })
    assert.equal(externalJob.artifactGlobalId, importedExternal.artifactGlobalId)
    assert.equal(externalJob.sourceOrderGlobalId, externalSource.order.global_id)
    assert.equal(externalJob.trackingNumber, externalSource.trackingNumber)
    const externalClaim = await persistence.claimOperationsPrintJobsInPostgres({
      agent: primaryAgent,
      idempotencyKey: `external-label-claim-${fixture.suffix}`,
      limit: 1,
      leaseSeconds: 120,
      runtimeCapabilities: labelCapabilities,
    })
    assert.equal(externalClaim.length, 1)
    assert.equal(externalClaim[0].globalId, externalJob.globalId)
    assert.equal(externalClaim[0].document.encoding, 'utf8')
    assert.equal(externalClaim[0].document.inlinePayload, externalZpl.toString('utf8'))
    assert.equal(
      createHash('sha256').update(
        externalClaim[0].document.inlinePayload,
        'utf8',
      ).digest('hex'),
      retainedExternal.content_sha256,
    )
    const deliveredExternal = await persistence.acknowledgeOperationsPrintJobInPostgres({
      agent: primaryAgent,
      jobGlobalId: externalJob.globalId,
      claimToken: externalClaim[0].claimToken,
      idempotencyKey: `external-label-ack-${fixture.suffix}`,
      deviceJobReference: `external-label-device-${fixture.suffix}`,
    })
    assert.equal(deliveredExternal.status, 'delivered')
    const externalReprint = await persistence.reprintOperationsPrintJobInPostgres({
      organizationId: fixture.organizationId,
      jobGlobalId: externalJob.globalId,
      actorEmail: fixture.actorEmail,
      idempotencyKey: `external-label-reprint-${fixture.suffix}`,
      reason: 'External label was damaged before carrier handoff',
    })
    assert.equal(externalReprint.status, 'queued')
    assert.equal(externalReprint.reprintOfJobGlobalId, externalJob.globalId)
    assert.equal(externalReprint.artifactGlobalId, importedExternal.artifactGlobalId)
    const externalReprintAudit = auditCalls.find((event) => (
      event.eventType === 'operations.print_job.reprinted'
      && event.aggregateId === externalReprint.globalId
    ))
    assert.equal(
      externalReprintAudit?.payload.reason,
      'External label was damaged before carrier handoff',
    )
    await persistence.cancelOperationsPrintJobInPostgres({
      organizationId: fixture.organizationId,
      jobGlobalId: externalReprint.globalId,
      actorEmail: fixture.actorEmail,
      idempotencyKey: `cancel-external-label-reprint-${fixture.suffix}`,
      reason: 'Audited external-label reprint acceptance completed',
    })

    const barcodeAgent = await persistence.authenticateOperationsPrintAgentInPostgres(
      legacyBundledEnrollment.credential,
    )
    const barcodePrinter = await createPrinter(pool, fixture, {
      code: `BARCODE-${fixture.suffix}`,
      name: 'Product and location barcode printer',
      priority: 4,
      printerType: 'thermal',
      formats: ['ZPL'],
      media: ['label_3x1', 'label_4x6'],
      documents: ['product_label', 'location_label'],
      agentId: barcodeAgent.id,
      isDefault: true,
    })
    const barcodeCases = [
      { documentType: 'product_label', media: 'label_3x1' },
      { documentType: 'product_label', media: 'label_4x6' },
      { documentType: 'location_label', media: 'label_3x1' },
      { documentType: 'location_label', media: 'label_4x6' },
    ]
    const barcodeEvidence = []
    for (const barcodeCase of barcodeCases) {
      const seeded = await seedBarcodeLabelArtifact(pool, fixture, barcodeCase)
      assert.equal(seeded.batch.media_size, barcodeCase.media)
      assert.equal(seeded.artifact.document_type, barcodeCase.documentType)
      assert.equal(seeded.artifact.media_size, barcodeCase.media)
      assert.equal(seeded.artifact.content_sha256, seeded.contentSha256)
      assert.equal(Number(seeded.artifact.byte_length), seeded.payload.byteLength)
      const job = await persistence.enqueueOperationsPrintJobInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.actorEmail,
        idempotencyKey:
          `barcode-job-${barcodeCase.documentType}-${barcodeCase.media}-${fixture.suffix}`,
        warehouseId: fixture.warehouseId,
        preferredPrinterGlobalId: barcodePrinter.global_id,
        maxAttempts: 3,
        document: {
          type: 'barcode_label_artifact',
          sourceArtifactGlobalId: seeded.artifact.global_id,
        },
      })
      assert.equal(job.documentType, barcodeCase.documentType)
      assert.equal(job.media, barcodeCase.media)
      assert.equal(job.artifactContentSha256, seeded.contentSha256)
      assert.equal(job.artifactByteLength, seeded.payload.byteLength)
      barcodeEvidence.push({ ...seeded, ...barcodeCase, job })
    }
    const barcodeClaims = await persistence.claimOperationsPrintJobsInPostgres({
      agent: barcodeAgent,
      idempotencyKey: `barcode-claims-${fixture.suffix}`,
      limit: barcodeCases.length,
      leaseSeconds: 120,
      runtimeCapabilities: {
        supportedFormats: ['ZPL'],
        supportedMedia: ['label_3x1', 'label_4x6'],
        supportedDocumentTypes: ['product_label', 'location_label'],
      },
    })
    assert.equal(barcodeClaims.length, barcodeCases.length)
    for (const evidence of barcodeEvidence) {
      const claim = barcodeClaims.find((candidate) => (
        candidate.globalId === evidence.job.globalId
      ))
      assert.ok(claim)
      assert.equal(claim.document.type, evidence.documentType)
      assert.equal(claim.document.media, evidence.media)
      assert.equal(claim.document.encoding, 'utf8')
      assert.equal(claim.document.inlinePayload, evidence.payload.toString('utf8'))
      assert.equal(claim.document.contentSha256, evidence.contentSha256)
      assert.equal(claim.document.byteLength, evidence.payload.byteLength)
      assert.equal(
        createHash('sha256').update(claim.document.inlinePayload, 'utf8').digest('hex'),
        claim.document.contentSha256,
      )
    }

    const managedRateTestConnection = await seedRateTestConnection(
      pool,
      fixture,
      {
        provider: 'ups_rest',
        name: 'Managed UPS sandbox',
        configuration: managedSandboxFulfillmentConfiguration,
      },
    )
    const updateManagedConnection = async (fields) => {
      const assignments = []
      const params = [fixture.organizationId, managedRateTestConnection.integration.id]
      for (const [column, value] of Object.entries(fields)) {
        params.push(column === 'configuration' ? JSON.stringify(value) : value)
        assignments.push(
          `${column} = $${params.length}${column === 'configuration' ? '::jsonb' : ''}`,
        )
      }
      await pool.query(
        `UPDATE operations_integration_accounts
         SET ${assignments.join(', ')}, updated_at = clock_timestamp()
         WHERE organization_id = $1::uuid
           AND id = $2::uuid`,
        params,
      )
    }
    const restoreManagedConnection = () => updateManagedConnection({
      provider: 'ups_rest',
      integration_type: 'carrier',
      environment: 'sandbox',
      configuration: managedSandboxFulfillmentConfiguration,
    })
    const enqueueRateTestLabel = (label, discriminator) => (
      persistence.enqueueOperationsPrintJobInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.actorEmail,
        idempotencyKey: `rate-test-${discriminator}-${fixture.suffix}`,
        warehouseId: fixture.warehouseId,
        preferredPrinterGlobalId: labelPrinter.global_id,
        maxAttempts: 5,
        document: {
          type: 'rate_test_label',
          sourceRateTestLabelGlobalId: label.global_id,
          media: 'label_4x6',
        },
      })
    )
    const printJobStatus = async (globalId) => {
      const result = await pool.query(
        `SELECT status
         FROM operations_print_jobs
         WHERE organization_id = $1::uuid
           AND global_id = $2`,
        [fixture.organizationId, globalId],
      )
      return result.rows[0]?.status || null
    }
    const assertFreshManagedClaimCancelled = async ({
      discriminator,
      mutation,
    }) => {
      await restoreManagedConnection()
      const label = await seedRateTestLabel(
        pool,
        fixture,
        managedRateTestConnection,
        discriminator,
      )
      const job = await enqueueRateTestLabel(label, discriminator)
      await updateManagedConnection(mutation)
      const claim = await persistence.claimOperationsPrintJobsInPostgres({
        agent: primaryAgent,
        idempotencyKey: `managed-denied-${discriminator}-${fixture.suffix}`,
        limit: 1,
        leaseSeconds: 120,
        runtimeCapabilities: labelCapabilities,
      })
      assert.equal(claim.length, 0)
      assert.equal(await printJobStatus(job.globalId), 'cancelled')
      await restoreManagedConnection()
    }

    await assertFreshManagedClaimCancelled({
      discriminator: 'rating-only',
      mutation: { configuration: managedSandboxRatingOnlyConfiguration },
    })
    await assertFreshManagedClaimCancelled({
      discriminator: 'drifted',
      mutation: {
        configuration: {
          ...managedSandboxFulfillmentConfiguration,
          senderOriginWarehouseGlobalId: 'gwh0000001',
        },
      },
    })
    await assertFreshManagedClaimCancelled({
      discriminator: 'provider-mismatch',
      mutation: { provider: 'usps_rest' },
    })
    await assertFreshManagedClaimCancelled({
      discriminator: 'production-environment',
      mutation: { environment: 'production' },
    })
    await assertFreshManagedClaimCancelled({
      discriminator: 'missing-exact-carrier-origin',
      mutation: { integration_type: 'printing' },
    })

    const replayLabel = await seedRateTestLabel(
      pool,
      fixture,
      managedRateTestConnection,
      'managed-claim-replay',
    )
    const replayJob = await enqueueRateTestLabel(replayLabel, 'managed-claim-replay')
    const managedClaimInput = {
      agent: primaryAgent,
      idempotencyKey: `managed-claim-replay-${fixture.suffix}`,
      limit: 1,
      leaseSeconds: 120,
      runtimeCapabilities: labelCapabilities,
    }
    const managedClaim = await persistence.claimOperationsPrintJobsInPostgres(
      managedClaimInput,
    )
    assert.equal(managedClaim.length, 1)
    assert.equal(managedClaim[0].globalId, replayJob.globalId)
    assert.equal(
      Buffer.from(managedClaim[0].document.inlinePayload, 'utf8').toString('utf8'),
      replayLabel.payload.toString('utf8'),
    )
    await updateManagedConnection({
      configuration: managedSandboxRatingOnlyConfiguration,
    })
    await expectRejected(
      () => persistence.claimOperationsPrintJobsInPostgres(managedClaimInput),
      /not authorized to release sandbox label bytes/,
    )
    await restoreManagedConnection()
    await expectRejected(
      () => persistence.rotateOperationsPrintAgentCredentialInPostgres({
        organizationId: fixture.organizationId,
        printAgentGlobalId: primaryEnrollment.agent.globalId,
        actorEmail: fixture.actorEmail,
        idempotencyKey: `rotate-with-active-claim-${fixture.suffix}`,
      }),
      /current print claim to finish or resolve it before rotating/,
    )
    const resolvedManagedClaim = await persistence.failOperationsPrintJobInPostgres({
      agent: primaryAgent,
      jobGlobalId: managedClaim[0].globalId,
      claimToken: managedClaim[0].claimToken,
      idempotencyKey: `managed-claim-resolved-before-rotation-${fixture.suffix}`,
      errorCode: 'TEST_FAILURE',
      errorMessage: 'No bytes were sent during the authorization drift test',
      retryable: false,
      printerUnavailable: false,
      retryAfterSeconds: 0,
    })
    assert.equal(resolvedManagedClaim.status, 'failed')

    const retryLabel = await seedRateTestLabel(
      pool,
      fixture,
      managedRateTestConnection,
      'managed-retry',
    )
    const retryJob = await enqueueRateTestLabel(retryLabel, 'managed-retry')
    const retryClaim = await persistence.claimOperationsPrintJobsInPostgres({
      agent: primaryAgent,
      idempotencyKey: `managed-retry-claim-${fixture.suffix}`,
      limit: 1,
      leaseSeconds: 120,
      runtimeCapabilities: labelCapabilities,
    })
    assert.equal(retryClaim[0].globalId, retryJob.globalId)
    const terminalManagedFailure = await persistence.failOperationsPrintJobInPostgres({
      agent: primaryAgent,
      jobGlobalId: retryJob.globalId,
      claimToken: retryClaim[0].claimToken,
      idempotencyKey: `managed-retry-fail-${fixture.suffix}`,
      errorCode: 'TEST_FAILURE',
      errorMessage: 'Intentional managed authorization retry boundary test',
      retryable: false,
    })
    assert.equal(terminalManagedFailure.status, 'failed')
    await updateManagedConnection({
      configuration: managedSandboxRatingOnlyConfiguration,
    })
    await expectRejected(
      () => persistence.retryOperationsPrintJobInPostgres({
        organizationId: fixture.organizationId,
        jobGlobalId: retryJob.globalId,
        actorEmail: fixture.actorEmail,
        idempotencyKey: `managed-operator-retry-${fixture.suffix}`,
        reason: 'Authorization downgrade must prevent retry',
      }),
      /not authorized to release sandbox label bytes/,
    )
    await restoreManagedConnection()

    const reprintLabel = await seedRateTestLabel(
      pool,
      fixture,
      managedRateTestConnection,
      'managed-reprint',
    )
    const reprintSourceJob = await enqueueRateTestLabel(
      reprintLabel,
      'managed-reprint',
    )
    const reprintSourceClaim = await persistence.claimOperationsPrintJobsInPostgres({
      agent: primaryAgent,
      idempotencyKey: `managed-reprint-claim-${fixture.suffix}`,
      limit: 1,
      leaseSeconds: 120,
      runtimeCapabilities: labelCapabilities,
    })
    assert.equal(reprintSourceClaim[0].globalId, reprintSourceJob.globalId)
    await persistence.acknowledgeOperationsPrintJobInPostgres({
      agent: primaryAgent,
      jobGlobalId: reprintSourceJob.globalId,
      claimToken: reprintSourceClaim[0].claimToken,
      idempotencyKey: `managed-reprint-ack-${fixture.suffix}`,
    })
    await updateManagedConnection({
      configuration: managedSandboxRatingOnlyConfiguration,
    })
    await expectRejected(
      () => persistence.reprintOperationsPrintJobInPostgres({
        organizationId: fixture.organizationId,
        jobGlobalId: reprintSourceJob.globalId,
        actorEmail: fixture.actorEmail,
        idempotencyKey: `managed-reprint-denied-${fixture.suffix}`,
        reason: 'Authorization downgrade must prevent reprint',
      }),
      /not authorized to release sandbox label bytes/,
    )
    await restoreManagedConnection()
    const userManagedRateTestConnection = await seedRateTestConnection(
      pool,
      fixture,
      {
        provider: 'fedex_rest',
        name: 'User-managed FedEx sandbox',
        configuration: {},
      },
    )
    const deferredUserManagedJobs = []
    for (let index = 1; index <= 26; index += 1) {
      const discriminator = `user-managed-deferred-${String(index).padStart(2, '0')}`
      const label = await seedRateTestLabel(
        pool,
        fixture,
        userManagedRateTestConnection,
        discriminator,
      )
      deferredUserManagedJobs.push(
        await enqueueRateTestLabel(label, discriminator),
      )
    }
    await pool.query(
      `UPDATE operations_print_jobs
       SET available_at = now() + interval '1 hour'
       WHERE organization_id = $1::uuid
         AND global_id = ANY($2::text[])`,
      [
        fixture.organizationId,
        deferredUserManagedJobs.map((job) => job.globalId),
      ],
    )
    const managedHeadOfLineJob = await persistence.reprintOperationsPrintJobInPostgres({
      organizationId: fixture.organizationId,
      jobGlobalId: reprintSourceJob.globalId,
      actorEmail: fixture.actorEmail,
      idempotencyKey: `managed-reprint-head-${fixture.suffix}`,
      reason: 'Create a queued managed job for head-of-line authorization proof',
    })
    await updateManagedConnection({
      configuration: managedSandboxRatingOnlyConfiguration,
    })
    await expectRejected(
      () => persistence.reprintOperationsPrintJobInPostgres({
        organizationId: fixture.organizationId,
        jobGlobalId: reprintSourceJob.globalId,
        actorEmail: fixture.actorEmail,
        idempotencyKey: `managed-reprint-head-${fixture.suffix}`,
        reason: 'Create a queued managed job for head-of-line authorization proof',
      }),
      /not authorized to release sandbox label bytes/,
    )
    const userManagedLabel = await seedRateTestLabel(
      pool,
      fixture,
      userManagedRateTestConnection,
      'user-managed-lifecycle',
    )
    const userManagedJob = await enqueueRateTestLabel(
      userManagedLabel,
      'user-managed-lifecycle',
    )
    const userManagedClaimInput = {
      agent: primaryAgent,
      idempotencyKey: `user-managed-claim-${fixture.suffix}`,
      limit: 1,
      leaseSeconds: 120,
      runtimeCapabilities: labelCapabilities,
    }
    const userManagedClaim = await persistence.claimOperationsPrintJobsInPostgres(
      userManagedClaimInput,
    )
    assert.equal(userManagedClaim.length, 1)
    assert.equal(userManagedClaim[0].globalId, userManagedJob.globalId)
    assert.equal(await printJobStatus(managedHeadOfLineJob.globalId), 'cancelled')
    const userManagedReplay = await persistence.claimOperationsPrintJobsInPostgres(
      userManagedClaimInput,
    )
    assert.equal(userManagedReplay[0].claimToken, userManagedClaim[0].claimToken)
    const userManagedFailure = await persistence.failOperationsPrintJobInPostgres({
      agent: primaryAgent,
      jobGlobalId: userManagedJob.globalId,
      claimToken: userManagedClaim[0].claimToken,
      idempotencyKey: `user-managed-fail-${fixture.suffix}`,
      errorCode: 'TEST_FAILURE',
      errorMessage: 'Intentional user-managed retry lifecycle test',
      retryable: false,
    })
    assert.equal(userManagedFailure.status, 'failed')
    const userManagedRetry = await persistence.retryOperationsPrintJobInPostgres({
      organizationId: fixture.organizationId,
      jobGlobalId: userManagedJob.globalId,
      actorEmail: fixture.actorEmail,
      idempotencyKey: `user-managed-retry-${fixture.suffix}`,
      reason: 'User-managed sandbox connections retain operator retry',
    })
    assert.equal(userManagedRetry.status, 'queued')
    const userManagedRetryClaim = await persistence.claimOperationsPrintJobsInPostgres({
      agent: primaryAgent,
      idempotencyKey: `user-managed-retry-claim-${fixture.suffix}`,
      limit: 1,
      leaseSeconds: 120,
      runtimeCapabilities: labelCapabilities,
    })
    assert.equal(userManagedRetryClaim[0].globalId, userManagedJob.globalId)
    const userManagedDelivered = await persistence.acknowledgeOperationsPrintJobInPostgres({
      agent: primaryAgent,
      jobGlobalId: userManagedJob.globalId,
      claimToken: userManagedRetryClaim[0].claimToken,
      idempotencyKey: `user-managed-ack-${fixture.suffix}`,
    })
    assert.equal(userManagedDelivered.status, 'delivered')
    const userManagedReprint = await persistence.reprintOperationsPrintJobInPostgres({
      organizationId: fixture.organizationId,
      jobGlobalId: userManagedJob.globalId,
      actorEmail: fixture.actorEmail,
      idempotencyKey: `user-managed-reprint-${fixture.suffix}`,
      reason: 'User-managed sandbox connections retain controlled reprint',
    })
    assert.equal(userManagedReprint.status, 'queued')
    await persistence.cancelOperationsPrintJobInPostgres({
      organizationId: fixture.organizationId,
      jobGlobalId: userManagedReprint.globalId,
      actorEmail: fixture.actorEmail,
      idempotencyKey: `cancel-user-managed-reprint-${fixture.suffix}`,
      reason: 'User-managed lifecycle proof completed without physical output',
    })
    await restoreManagedConnection()

    const offlinePrimaryEnrollment =
      await persistence.enrollOperationsPrintAgentInPostgres({
        organizationId: fixture.organizationId,
        warehouseId: fixture.warehouseId,
        name: 'Offline-route primary agent',
        actorEmail: fixture.actorEmail,
        idempotencyKey: `offline-primary-agent-${fixture.suffix}`,
        ...packingCapabilities,
      })
    const offlineFallbackEnrollment =
      await persistence.enrollOperationsPrintAgentInPostgres({
        organizationId: fixture.organizationId,
        warehouseId: fixture.warehouseId,
        name: 'Offline-route fallback agent',
        actorEmail: fixture.actorEmail,
        idempotencyKey: `offline-fallback-agent-${fixture.suffix}`,
        ...packingCapabilities,
      })
    const offlineFallback = await createPrinter(pool, fixture, {
      code: `OFFLINE-FALLBACK-${fixture.suffix}`,
      name: 'Offline-route fallback printer',
      priority: 60,
      agentId: offlineFallbackEnrollment.agent.id,
      isDefault: false,
    })
    const offlinePrimary = await createPrinter(pool, fixture, {
      code: `OFFLINE-PRIMARY-${fixture.suffix}`,
      name: 'Printer that goes offline before claim',
      priority: 50,
      agentId: offlinePrimaryEnrollment.agent.id,
      fallbackId: offlineFallback.id,
      isDefault: false,
    })
    const offlineContent = `offline-route-${fixture.suffix}`
    const offlineJob = await persistence.enqueueOperationsPrintJobInPostgres({
      organizationId: fixture.organizationId,
      actorEmail: fixture.actorEmail,
      idempotencyKey: `offline-route-${fixture.suffix}`,
      warehouseId: fixture.warehouseId,
      preferredPrinterGlobalId: offlinePrimary.global_id,
      maxAttempts: 3,
      document: {
        type: 'packing_slip',
        format: 'PDF',
        media: 'letter',
        contentSha256: createHash('sha256').update(offlineContent).digest('hex'),
        byteLength: Buffer.byteLength(offlineContent),
        storageReference: `clawpilot-document:offline-route-${fixture.suffix}`,
        sourceOrderGlobalId: printSource.order.global_id,
        sourceShipmentGlobalId: printSource.shipment.global_id,
      },
    })
    assert.equal(offlineJob.printerGlobalId, offlinePrimary.global_id)
    await pool.query(
      `UPDATE operations_printers
       SET status = 'offline'
       WHERE organization_id = $1::uuid
         AND id = $2::uuid`,
      [fixture.organizationId, offlinePrimary.id],
    )
    const offlineFallbackAgent =
      await persistence.authenticateOperationsPrintAgentInPostgres(
        offlineFallbackEnrollment.credential,
      )
    const reroutedClaim = await persistence.claimOperationsPrintJobsInPostgres({
      agent: offlineFallbackAgent,
      idempotencyKey: `offline-fallback-claim-${fixture.suffix}`,
      limit: 1,
      leaseSeconds: 120,
      runtimeCapabilities: packingCapabilities,
    })
    assert.equal(reroutedClaim.length, 1)
    assert.equal(reroutedClaim[0].globalId, offlineJob.globalId)
    assert.equal(reroutedClaim[0].printer.globalId, offlineFallback.global_id)
    await persistence.acknowledgeOperationsPrintJobInPostgres({
      agent: offlineFallbackAgent,
      jobGlobalId: offlineJob.globalId,
      claimToken: reroutedClaim[0].claimToken,
      idempotencyKey: `offline-fallback-ack-${fixture.suffix}`,
    })

    const revokedEnrollment = await persistence.enrollOperationsPrintAgentInPostgres({
      organizationId: fixture.organizationId,
      warehouseId: fixture.warehouseId,
      name: 'Revoked-route print agent',
      actorEmail: fixture.actorEmail,
      idempotencyKey: `revoked-agent-${fixture.suffix}`,
      ...packingCapabilities,
    })
    const revokedPrinter = await createPrinter(pool, fixture, {
      code: `REVOKED-${fixture.suffix}`,
      name: 'Printer without approved fallback',
      priority: 70,
      agentId: revokedEnrollment.agent.id,
      isDefault: false,
    })
    const revokedContent = `revoked-route-${fixture.suffix}`
    const revokedJob = await persistence.enqueueOperationsPrintJobInPostgres({
      organizationId: fixture.organizationId,
      actorEmail: fixture.actorEmail,
      idempotencyKey: `revoked-route-${fixture.suffix}`,
      warehouseId: fixture.warehouseId,
      preferredPrinterGlobalId: revokedPrinter.global_id,
      maxAttempts: 3,
      document: {
        type: 'packing_slip',
        format: 'PDF',
        media: 'letter',
        contentSha256: createHash('sha256').update(revokedContent).digest('hex'),
        byteLength: Buffer.byteLength(revokedContent),
        storageReference: `clawpilot-document:revoked-route-${fixture.suffix}`,
        sourceOrderGlobalId: printSource.order.global_id,
      },
    })
    assert.equal(revokedJob.status, 'queued')
    const revokedAgentContext = await persistence.authenticateOperationsPrintAgentInPostgres(
      revokedEnrollment.credential,
    )
    const revokedClaim = await persistence.claimOperationsPrintJobsInPostgres({
      agent: revokedAgentContext,
      idempotencyKey: `revoked-route-claim-${fixture.suffix}`,
      limit: 1,
      leaseSeconds: 120,
      runtimeCapabilities: packingCapabilities,
    })
    assert.equal(revokedClaim.length, 1)
    assert.equal(revokedClaim[0].globalId, revokedJob.globalId)
    await persistence.revokeOperationsPrintAgentInPostgres({
      organizationId: fixture.organizationId,
      printAgentGlobalId: revokedEnrollment.agent.globalId,
      actorEmail: fixture.actorEmail,
    })
    assert.equal(
      await persistence.authenticateOperationsPrintAgentInPostgres(
        revokedEnrollment.credential,
      ),
      null,
    )

    const legacyRevokedEnrollment = await persistence.enrollOperationsPrintAgentInPostgres({
      organizationId: fixture.organizationId,
      warehouseId: fixture.warehouseId,
      name: 'Rolling-upgrade revoked print agent',
      actorEmail: fixture.actorEmail,
      idempotencyKey: `legacy-revoked-agent-${fixture.suffix}`,
      ...packingCapabilities,
    })
    const legacyRevokedPrinter = await createPrinter(pool, fixture, {
      code: `LEGACY-REVOKED-${fixture.suffix}`,
      name: 'Rolling-upgrade revoked printer',
      priority: 71,
      agentId: legacyRevokedEnrollment.agent.id,
      isDefault: false,
    })
    const legacyRevokedContent = `legacy-revoked-route-${fixture.suffix}`
    const legacyRevokedJob = await persistence.enqueueOperationsPrintJobInPostgres({
      organizationId: fixture.organizationId,
      actorEmail: fixture.actorEmail,
      idempotencyKey: `legacy-revoked-route-${fixture.suffix}`,
      warehouseId: fixture.warehouseId,
      preferredPrinterGlobalId: legacyRevokedPrinter.global_id,
      maxAttempts: 3,
      document: {
        type: 'packing_slip',
        format: 'PDF',
        media: 'letter',
        contentSha256: createHash('sha256').update(legacyRevokedContent).digest('hex'),
        byteLength: Buffer.byteLength(legacyRevokedContent),
        storageReference: `clawpilot-document:legacy-revoked-route-${fixture.suffix}`,
        sourceOrderGlobalId: printSource.order.global_id,
      },
    })
    const legacyRevokedAgentContext =
      await persistence.authenticateOperationsPrintAgentInPostgres(
        legacyRevokedEnrollment.credential,
      )
    const legacyRevokedClaim = await persistence.claimOperationsPrintJobsInPostgres({
      agent: legacyRevokedAgentContext,
      idempotencyKey: `legacy-revoked-route-claim-${fixture.suffix}`,
      limit: 1,
      leaseSeconds: 120,
      runtimeCapabilities: packingCapabilities,
    })
    assert.equal(legacyRevokedClaim.length, 1)
    assert.equal(legacyRevokedClaim[0].globalId, legacyRevokedJob.globalId)
    // Reproduce a pre-fix/rolling-upgrade state: the agent and printer were
    // revoked/unbound but the job projection was left claimed.
    await pool.query(
      `UPDATE operations_printers
       SET local_print_agent_id = NULL,
           status = 'offline',
           row_version = row_version + 1,
           updated_at = clock_timestamp()
       WHERE organization_id = $1::uuid
         AND id = $2::uuid`,
      [fixture.organizationId, legacyRevokedPrinter.id],
    )
    await pool.query(
      `UPDATE operations_print_agents
       SET status = 'revoked',
           revoked_by = $3,
           revoked_at = clock_timestamp()
       WHERE organization_id = $1::uuid
         AND id = $2::uuid`,
      [fixture.organizationId, legacyRevokedEnrollment.agent.id, fixture.actorEmail],
    )
    const repairedLegacyRevocation =
      await persistence.revokeOperationsPrintAgentInPostgres({
        organizationId: fixture.organizationId,
        printAgentGlobalId: legacyRevokedEnrollment.agent.globalId,
        actorEmail: fixture.actorEmail,
      })
    assert.equal(repairedLegacyRevocation.status, 'revoked')
    const replayedLegacyRevocation =
      await persistence.revokeOperationsPrintAgentInPostgres({
        organizationId: fixture.organizationId,
        printAgentGlobalId: legacyRevokedEnrollment.agent.globalId,
        actorEmail: fixture.actorEmail,
      })
    assert.equal(replayedLegacyRevocation.status, 'revoked')
    const repairedLegacyClaim = await insertReturning(
      pool,
      `SELECT
         job.status,
         job.claimed_by_print_agent_id::text,
         job.current_claim_attempt_id::text,
         job.claim_expires_at,
         latest.error_code,
         count(*) FILTER (
           WHERE attempt.error_code = 'PRINT_OUTCOME_UNCERTAIN'
         )::integer AS uncertain_attempts
       FROM operations_print_jobs job
       JOIN LATERAL (
         SELECT latest_attempt.error_code
         FROM operations_print_delivery_attempts latest_attempt
         WHERE latest_attempt.organization_id = job.organization_id
           AND latest_attempt.print_job_id = job.id
         ORDER BY latest_attempt.sequence_number DESC
         LIMIT 1
       ) latest ON true
       JOIN operations_print_delivery_attempts attempt
         ON attempt.organization_id = job.organization_id
        AND attempt.print_job_id = job.id
       WHERE job.organization_id = $1::uuid
         AND job.global_id = $2
       GROUP BY job.id, latest.error_code`,
      [fixture.organizationId, legacyRevokedJob.globalId],
    )
    assert.deepEqual(repairedLegacyClaim, {
      status: 'failed',
      claimed_by_print_agent_id: null,
      current_claim_attempt_id: null,
      claim_expires_at: null,
      error_code: 'PRINT_OUTCOME_UNCERTAIN',
      uncertain_attempts: 1,
    })

    const workspace = await persistence.readOperationsPrintJobWorkspaceFromPostgres({
      organizationId: fixture.organizationId,
      canView: true,
      canManage: true,
      canExecute: true,
      limit: 100,
    })
    const persistedOfflineJob = workspace.jobs.find(
      (job) => job.globalId === offlineJob.globalId,
    )
    assert.ok(persistedOfflineJob)
    assert.equal(persistedOfflineJob.status, 'delivered')
    assert.equal(persistedOfflineJob.printerGlobalId, offlineFallback.global_id)
    assert.deepEqual(
      persistedOfflineJob.attemptHistory.map((attempt) => attempt.state),
      ['queued', 'rerouted', 'queued', 'claimed', 'delivered'],
    )
    assert.equal(
      persistedOfflineJob.sourceOrderGlobalId,
      printSource.order.global_id,
    )
    assert.equal(
      persistedOfflineJob.sourceShipmentGlobalId,
      printSource.shipment.global_id,
    )
    const persistedRevokedJob = workspace.jobs.find(
      (job) => job.globalId === revokedJob.globalId,
    )
    assert.ok(persistedRevokedJob)
    assert.equal(persistedRevokedJob.status, 'failed')
    assert.equal(
      persistedRevokedJob.attemptHistory.at(-1).errorCode,
      'PRINT_OUTCOME_UNCERTAIN',
    )
    assert.equal(persistedRevokedJob.claimExpiresAt, null)
    assert.deepEqual(
      persistedRevokedJob.attemptHistory.map((attempt) => attempt.state),
      ['queued', 'claimed', 'failed'],
    )
    const lingeringRevokedClaims = await pool.query(
      `SELECT count(*)::integer AS count
       FROM operations_print_jobs
       WHERE organization_id = $1::uuid
         AND status = 'claimed'
         AND claimed_by_print_agent_id = $2::uuid`,
      [fixture.organizationId, revokedEnrollment.agent.id],
    )
    assert.equal(lingeringRevokedClaims.rows[0].count, 0)
    const revokedPrinterState = await insertReturning(
      pool,
      `SELECT status, local_print_agent_id
       FROM operations_printers
       WHERE organization_id = $1::uuid
         AND id = $2::uuid`,
      [fixture.organizationId, revokedPrinter.id],
    )
    assert.deepEqual(revokedPrinterState, {
      status: 'offline',
      local_print_agent_id: null,
    })

    const rotations = await Promise.all([
      persistence.rotateOperationsPrintAgentCredentialInPostgres({
        organizationId: fixture.organizationId,
        printAgentGlobalId: primaryEnrollment.agent.globalId,
        actorEmail: fixture.actorEmail,
        idempotencyKey: `rotate-${fixture.suffix}`,
      }),
      persistence.rotateOperationsPrintAgentCredentialInPostgres({
        organizationId: fixture.organizationId,
        printAgentGlobalId: primaryEnrollment.agent.globalId,
        actorEmail: fixture.actorEmail,
        idempotencyKey: `rotate-${fixture.suffix}`,
      }),
    ])
    assert.equal(rotations.filter((result) => result.credential).length, 1)
    const rotated = rotations.find((result) => result.credential)
    assert.ok(rotated.credential)
    assert.equal(
      await persistence.authenticateOperationsPrintAgentInPostgres(
        primaryEnrollment.credential,
      ),
      null,
    )
    assert.equal(
      (await persistence.authenticateOperationsPrintAgentInPostgres(
        rotated.credential,
      )).credentialVersion,
      2,
    )

    const partialFallback = await createPrinter(pool, fixture, {
      code: `PARTIAL-FALLBACK-${fixture.suffix}`,
      name: 'A4-only fallback printer',
      priority: 40,
      media: ['a4'],
      agentId: fallbackEnrollment.agent.id,
      isDefault: false,
    })
    await expectRejected(
      () => createPrinter(pool, fixture, {
        code: `PARTIAL-PRIMARY-${fixture.suffix}`,
        name: 'Letter primary printer',
        priority: 30,
        media: ['letter', 'a4'],
        agentId: primaryEnrollment.agent.id,
        fallbackId: partialFallback.id,
        isDefault: false,
      }),
      /fallback must have compatible document, media, and format capabilities/,
    )

    const reprintAudit = auditCalls.find((event) => (
      event.eventType === 'operations.print_job.reprinted'
    ))
    assert.equal(
      reprintAudit.payload.reason,
      'Original packing slip was damaged during carton close',
    )
    const physicalOutputAudits = auditCalls.filter((event) => (
      event.eventType === 'operations.print_job.physical_output_verified'
    ))
    assert.equal(physicalOutputAudits.length, 2)
    assert.equal(physicalOutputAudits[0].actor, verifierEmail)
    assert.equal(
      physicalOutputAudits[0].payload.verificationMethod,
      'operator_visual_confirmation',
    )
    assert.equal(physicalOutputAudits[0].payload.physicalOutputVerified, true)
    const rerouteAudit = auditCalls.find((event) => (
      event.eventType === 'operations.print_job.rerouted'
      && event.aggregateId === offlineJob.globalId
    ))
    assert.equal(
      rerouteAudit.payload.sourceShipmentGlobalId,
      printSource.shipment.global_id,
    )
    const revokedOutcomeAudit = auditCalls.find((event) => (
      event.eventType === 'operations.print_job.outcome_uncertain'
      && event.aggregateId === revokedJob.globalId
    ))
    assert.equal(revokedOutcomeAudit.payload.errorCode, 'PRINT_OUTCOME_UNCERTAIN')
    assert.equal(revokedOutcomeAudit.payload.automaticRetryBlocked, true)
    assert.ok(!JSON.stringify(auditCalls).includes(content))
  } finally {
    await pool.end()
  }
}

async function verifyDeviceReferencePrivacyMigration(connectionString) {
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 5_000 })
  try {
    const oldWriterTarget = await insertReturning(
      pool,
      `SELECT
         job.organization_id::text,
         job.id::text AS print_job_id,
         job.printer_id::text,
         job.claimed_by_print_agent_id::text AS print_agent_id,
         job.current_claim_attempt_id::text AS claim_attempt_id
       FROM operations_print_jobs job
       WHERE job.status = 'claimed'
         AND job.claimed_by_print_agent_id IS NOT NULL
         AND job.current_claim_attempt_id IS NOT NULL
       ORDER BY job.updated_at DESC, job.id
       LIMIT 1`,
    )
    const oldWriterAttempt = await insertReturning(
      pool,
      `INSERT INTO operations_print_delivery_attempts (
         organization_id, print_job_id, printer_id,
         state, actor_type, print_agent_id, claim_attempt_id,
         idempotency_key, request_fingerprint,
         device_job_reference, delivery_evidence
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid,
         'delivered', 'local_print_agent', $4::uuid, $5::uuid,
         $6, $7, '192.168.4.199:9100', 'local_agent_acknowledgement'
       )
       RETURNING id::text, device_job_reference`,
      [
        oldWriterTarget.organization_id,
        oldWriterTarget.print_job_id,
        oldWriterTarget.printer_id,
        oldWriterTarget.print_agent_id,
        oldWriterTarget.claim_attempt_id,
        `old-writer-device-reference-${randomUUID()}`,
        createHash('sha256')
          .update(`old-writer-device-reference:${randomUUID()}`)
          .digest('hex'),
      ],
    )
    assert.equal(
      oldWriterAttempt.device_job_reference,
      'local-device.legacy.v1.redacted',
      'Migration guard must normalize a rolling-deploy old-writer insert',
    )

    const candidates = await pool.query(
      `SELECT id::text
       FROM operations_print_delivery_attempts
       WHERE state = 'delivered'
         AND device_job_reference IS NOT NULL
       ORDER BY occurred_at, id
       LIMIT 3`,
    )
    assert.equal(candidates.rowCount, 3)
    const rawAttemptId = candidates.rows[0].id
    const opaqueAttemptId = candidates.rows[1].id
    const malformedOpaqueAttemptId = candidates.rows[2].id
    const opaqueReference = `local-device.v1.${'A'.repeat(43)}`

    await pool.query('BEGIN')
    try {
      await pool.query(
        `ALTER TABLE operations_print_delivery_attempts
           DISABLE TRIGGER protect_operations_print_delivery_attempt_write`,
      )
      await pool.query(
        `UPDATE operations_print_delivery_attempts
         SET device_job_reference = CASE id
           WHEN $1::uuid THEN '192.168.4.146:9100'
           WHEN $2::uuid THEN $4
           WHEN $3::uuid THEN 'local-device.v1.not-valid'
           ELSE device_job_reference
         END
         WHERE id IN ($1::uuid, $2::uuid, $3::uuid)`,
        [rawAttemptId, opaqueAttemptId, malformedOpaqueAttemptId, opaqueReference],
      )
      await pool.query(
        `ALTER TABLE operations_print_delivery_attempts
           ENABLE TRIGGER protect_operations_print_delivery_attempt_write`,
      )
      await pool.query('COMMIT')
    } catch (error) {
      await pool.query('ROLLBACK')
      throw error
    }

    const before = await pool.query(
      `SELECT id::text, to_jsonb(attempt) - 'device_job_reference' AS invariant
       FROM operations_print_delivery_attempts attempt
       WHERE id IN ($1::uuid, $2::uuid, $3::uuid)
       ORDER BY id`,
      [rawAttemptId, opaqueAttemptId, malformedOpaqueAttemptId],
    )
    await pool.query('BEGIN')
    try {
      await pool.query(
        read('db/migrations/0284_operations_print_device_reference_privacy.sql'),
      )
      await pool.query('COMMIT')
    } catch (error) {
      await pool.query('ROLLBACK')
      throw error
    }
    const after = await pool.query(
      `SELECT
         id::text,
         device_job_reference,
         to_jsonb(attempt) - 'device_job_reference' AS invariant
       FROM operations_print_delivery_attempts attempt
       WHERE id IN ($1::uuid, $2::uuid, $3::uuid)
       ORDER BY id`,
      [rawAttemptId, opaqueAttemptId, malformedOpaqueAttemptId],
    )
    assert.deepEqual(
      after.rows.map((row) => ({ id: row.id, invariant: row.invariant })),
      before.rows,
      'Privacy migration must preserve every attempt fact except the local device reference',
    )
    const byId = new Map(after.rows.map((row) => [row.id, row.device_job_reference]))
    assert.equal(byId.get(rawAttemptId), 'local-device.legacy.v1.redacted')
    assert.equal(byId.get(opaqueAttemptId), opaqueReference)
    assert.equal(
      byId.get(malformedOpaqueAttemptId),
      'local-device.legacy.v1.redacted',
    )

    const privacyEvidence = await pool.query(
      `SELECT
         NOT EXISTS (
           SELECT 1
           FROM operations_print_delivery_attempts
           WHERE device_job_reference IS NOT NULL
             AND NOT (
               device_job_reference ~
                 '^local-device[.]v1[.][A-Za-z0-9_-]{43}$'
               OR device_job_reference = 'local-device.legacy.v1.redacted'
             )
         ) AS no_raw_references,
         EXISTS (
           SELECT 1
           FROM schema_migrations
           WHERE filename =
             '0284_operations_print_device_reference_privacy.sql'
             AND checksum ~ '^[0-9a-f]{64}$'
         ) AS migration_recorded,
         EXISTS (
           SELECT 1
           FROM pg_trigger guard
           WHERE guard.tgrelid =
             to_regclass('operations_print_delivery_attempts')
             AND guard.tgname =
               'protect_operations_print_delivery_attempt_write'
             AND guard.tgfoid =
               to_regprocedure('protect_operations_append_only()')
             AND NOT guard.tgisinternal
             AND guard.tgenabled = 'O'
             AND guard.tgtype = 27
         ) AS guard_enabled,
         EXISTS (
           SELECT 1
           FROM pg_trigger normalization_guard
           WHERE normalization_guard.tgrelid =
             to_regclass('operations_print_delivery_attempts')
             AND normalization_guard.tgname =
               'normalize_operations_print_delivery_device_reference_write'
             AND normalization_guard.tgfoid = to_regprocedure(
               'normalize_operations_print_delivery_device_reference()'
             )
             AND NOT normalization_guard.tgisinternal
             AND normalization_guard.tgenabled = 'O'
             AND normalization_guard.tgtype = 7
         ) AS normalization_guard_enabled`,
    )
    assert.deepEqual(privacyEvidence.rows[0], {
      no_raw_references: true,
      migration_recorded: true,
      guard_enabled: true,
      normalization_guard_enabled: true,
    })
    await expectRejected(
      () => pool.query(
        `UPDATE operations_print_delivery_attempts
         SET device_job_reference = 'must-not-write'
         WHERE id = $1::uuid`,
        [rawAttemptId],
      ),
      /append-only/i,
    )
  } finally {
    await pool.end()
  }
}

async function main() {
  command('docker', ['info'], { timeout: 30_000 })
  const container = `clawpilot-print-agent-runtime-${process.pid}-${randomUUID().slice(0, 8)}`
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=clawpilot_print_agent',
      '-e', 'POSTGRES_DB=clawpilot_print_agent',
      '-p', '127.0.0.1::5432',
      'pgvector/pgvector:pg16',
    ], { timeout: 180_000 })
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/)?.[1])
    assert.ok(port > 0, `Unable to resolve disposable PostgreSQL port from ${portOutput}`)
    const connectionString =
      `postgresql://postgres:clawpilot_print_agent@127.0.0.1:${port}/clawpilot_print_agent`
    await waitForPostgres(connectionString)
    command('node', ['scripts/db-migrate.mjs'], {
      env: { DATABASE_URL: connectionString, PGSSLMODE: 'disable' },
      timeout: 240_000,
    })
    await verifyLegacyPrinterNormalization(connectionString)
    await verifyAgentCapabilityBackfill(connectionString)
    await verifyRuntime(connectionString)
    await verifyDeviceReferencePrivacyMigration(connectionString)
  } finally {
    spawnSync('docker', ['stop', '-t', '1', container], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000,
    })
  }
  console.log('Operations local print-agent runtime tests passed.')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
