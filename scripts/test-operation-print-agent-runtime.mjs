#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
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
  } finally {
    await pool.end()
  }
}

async function verifyRuntime(connectionString) {
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 5_000 })
  const auditCalls = []
  try {
    const printing = loadTypeScript('app_src/lib/operations/printing.ts')
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
    const fixture = await seedBase(pool)
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
    const printSource = await seedPrintSource(pool, fixture)

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
      'PRINT_ROUTE_UNAVAILABLE',
    )
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
    const rerouteAudit = auditCalls.find((event) => (
      event.eventType === 'operations.print_job.rerouted'
      && event.aggregateId === offlineJob.globalId
    ))
    assert.equal(
      rerouteAudit.payload.sourceShipmentGlobalId,
      printSource.shipment.global_id,
    )
    const routeUnavailableAudit = auditCalls.find((event) => (
      event.eventType === 'operations.print_job.route_unavailable'
      && event.aggregateId === revokedJob.globalId
    ))
    assert.equal(
      routeUnavailableAudit.payload.sourceOrderGlobalId,
      printSource.order.global_id,
    )
    assert.ok(!JSON.stringify(auditCalls).includes(content))
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
