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

class RequestError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

function requestErrorAdapter() {
  return { OperationsRequestError: RequestError }
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

async function insertReturning(pool, sql, params = []) {
  const result = await pool.query(sql, params)
  assert.equal(result.rowCount, 1)
  return result.rows[0]
}

async function expectRequestError(work, code, status = undefined) {
  let caught
  try {
    await work()
  } catch (error) {
    caught = error
  }
  assert.ok(caught, `Expected ${code}`)
  assert.equal(caught.code, code)
  if (status !== undefined) assert.equal(caught.status, status)
  return caught
}

async function seedBase(pool) {
  const suffix = randomBytes(4).toString('hex')
  const actorEmail = `print-cleanup-${suffix}@example.com`
  await pool.query(
    `INSERT INTO app_users (email, role, status, display_name)
     VALUES ($1, 'owner', 'active', 'Print Cleanup Owner')`,
    [actorEmail],
  )
  const organization = await insertReturning(
    pool,
    `INSERT INTO workspace_organizations (
       name, organization_type, created_by, updated_by
     ) VALUES ($1, 'root', $2, $2)
     RETURNING id`,
    [`Print cleanup ${suffix}`, actorEmail],
  )
  await pool.query(
    `UPDATE app_users
     SET organization_id = $2, organization_name = $3
     WHERE email = $1`,
    [actorEmail, organization.id, `Print cleanup ${suffix}`],
  )
  const warehouse = await insertReturning(
    pool,
    `INSERT INTO operations_warehouses (
       organization_id, code, name, created_by, updated_by
     ) VALUES ($1, $2, 'Cleanup warehouse', $3, $3)
     RETURNING id`,
    [organization.id, `PC-${suffix}`, actorEmail],
  )
  return {
    suffix,
    actorEmail,
    organizationId: organization.id,
    warehouseId: warehouse.id,
  }
}

async function createPrinter(pool, fixture, agentId) {
  await pool.query(
    `UPDATE operations_print_agents
     SET last_seen_at = clock_timestamp()
     WHERE organization_id = $1::uuid
       AND id = $2::uuid`,
    [fixture.organizationId, agentId],
  )
  return insertReturning(
    pool,
    `INSERT INTO operations_printers (
       organization_id, warehouse_id, code, name, station_type,
       supports_zpl, priority, status, created_by,
       printer_type, connection_mode, supported_formats, supported_media,
       supported_document_types, default_document_types,
       local_print_agent_id
     ) VALUES (
       $1, $2, $3, 'Cleanup office printer', 'office',
       false, 10, 'online', $4,
       'nonthermal', 'local_agent', ARRAY['PDF']::text[], ARRAY['letter']::text[],
       ARRAY['packing_slip']::text[], ARRAY['packing_slip']::text[],
       $5::uuid
     )
     RETURNING id, global_id`,
    [
      fixture.organizationId,
      fixture.warehouseId,
      `CLEANUP-${fixture.suffix}`,
      fixture.actorEmail,
      agentId,
    ],
  )
}

function cleanupEntry(job, claim) {
  return {
    jobGlobalId: job.globalId,
    claimToken: claim.claimToken,
    documentGlobalId: claim.document.globalId,
    contentSha256: claim.document.contentSha256,
  }
}

async function verifyRouteContract() {
  const calls = []
  const cleanupResult = {
    resolution: 'delivered',
    removalSafe: true,
    reasonCode: 'SERVER_DELIVERY_CONFIRMED',
  }
  const route = loadTypeScript(
    'app_src/app/api/operations/print-agent/cleanup-status/route.ts',
    {
      'next/server': {
        NextRequest: class {},
        NextResponse: {
          json(payload, options = {}) {
            return { payload, status: options.status || 200, headers: options.headers }
          },
        },
      },
      '@/lib/persistence/config': { isPostgresStorageEnabled: () => true },
      '@/lib/persistence/operations': requestErrorAdapter(),
      '@/lib/persistence/operationPrintDelivery': {
        async authenticateOperationsPrintAgentForCleanupInPostgres(credential) {
          calls.push({ action: 'authenticate', credential })
          return credential === 'credential' ? { id: randomUUID() } : null
        },
        async resolveOperationsPrintAgentCleanupStatusInPostgres(input) {
          calls.push({ action: 'resolve', input })
          return [cleanupResult]
        },
      },
    },
  )
  const entry = {
    jobGlobalId: 'gpj0000001',
    claimToken: '00000000-0000-4000-8000-000000000001',
    documentGlobalId: 'gpf0000001',
    contentSha256: 'a'.repeat(64),
  }
  const request = (body, headers = {}) => ({
    headers: {
      get(name) {
        return {
          authorization: 'Bearer credential',
          'content-type': 'application/json',
          'idempotency-key': 'cleanup-route-0001',
          ...headers,
        }[name.toLowerCase()] || null
      },
    },
    text: async () => JSON.stringify(body),
  })
  const response = await route.POST(request({ entries: [entry] }))
  assert.equal(response.status, 200)
  assert.deepEqual(structuredClone(response.payload), {
    ok: true,
    entries: [cleanupResult],
  })
  assert.deepEqual(structuredClone(Object.keys(response.payload).sort()), ['entries', 'ok'])
  assert.deepEqual(structuredClone(Object.keys(response.payload.entries[0])), [
    'resolution', 'removalSafe', 'reasonCode',
  ])
  assert.equal(JSON.stringify(response.payload).includes('jobGlobalId'), false)
  assert.equal(JSON.stringify(response.payload).includes('agent'), false)
  assert.equal(response.headers['Cache-Control'], 'no-store')
  const beforeInvalid = calls.filter((call) => call.action === 'resolve').length
  const extraField = await route.POST(request({ entries: [entry], agentGlobalId: 'gpt0000001' }))
  assert.equal(extraField.status, 400)
  const duplicate = await route.POST(request({ entries: [entry, entry] }))
  assert.equal(duplicate.status, 400)
  const tooMany = await route.POST(request({
    entries: Array.from({ length: 129 }, (_, index) => ({
      ...entry,
      jobGlobalId: `gpj${String(index + 1).padStart(7, '0')}`,
      claimToken: randomUUID(),
    })),
  }))
  assert.equal(tooMany.status, 400)
  const extraEntryField = await route.POST(request({
    entries: [{ ...entry, printerHost: '192.168.1.10' }],
  }))
  assert.equal(extraEntryField.status, 400)
  const missingIdempotencyKey = await route.POST(request({ entries: [entry] }, {
    'idempotency-key': '',
  }))
  assert.equal(missingIdempotencyKey.status, 400)
  assert.equal(
    calls.filter((call) => call.action === 'resolve').length,
    beforeInvalid,
  )
  const unauthorized = await route.POST(request({ entries: [entry] }, {
    authorization: 'Bearer wrong',
  }))
  assert.equal(unauthorized.status, 401)

  const routeSource = read('app_src/app/api/operations/print-agent/cleanup-status/route.ts')
  assert.ok(routeSource.includes("return json({ ok: true, entries: resolved })"))
  assert.equal(routeSource.includes('agentGlobalId'), false)
  assert.equal(routeSource.includes('currentClaimCount'), false)
  assert.equal(routeSource.includes('checkedAt'), false)
  assert.equal(routeSource.includes('storageReference'), false)
}

async function verifyPostgresContract(connectionString) {
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
        '@/lib/auditWriter': {
          async recordAuditEvent(input) {
            auditCalls.push(structuredClone(input))
          },
        },
        '@/lib/integrations/carrierManagedDelegation': carrierManagedDelegation,
        '@/lib/operations/printing': printing,
        '@/lib/persistence/operations': requestErrorAdapter(),
        '@/lib/persistence/operationPrinting': profileAdapter(),
        '@/lib/persistence/postgres': postgresAdapter(pool),
      },
    )
    const fixture = await seedBase(pool)
    const capabilities = {
      supportedFormats: ['PDF'],
      supportedMedia: ['letter'],
      supportedDocumentTypes: ['packing_slip'],
    }
    const enrollment = await persistence.enrollOperationsPrintAgentInPostgres({
      organizationId: fixture.organizationId,
      warehouseId: fixture.warehouseId,
      name: 'Cleanup print agent',
      actorEmail: fixture.actorEmail,
      idempotencyKey: `cleanup-agent-${fixture.suffix}`,
      ...capabilities,
    })
    const printer = await createPrinter(pool, fixture, enrollment.agent.id)
    const activeAgent = await persistence.authenticateOperationsPrintAgentInPostgres(
      enrollment.credential,
    )
    const cleanupAgent = await persistence
      .authenticateOperationsPrintAgentForCleanupInPostgres(enrollment.credential)
    assert.equal(cleanupAgent.id, activeAgent.id)

    let sequence = 0
    async function enqueueAndClaim(label) {
      sequence += 1
      const content = Buffer.from(`cleanup-${label}-${fixture.suffix}-${sequence}`)
      const job = await persistence.enqueueOperationsPrintJobInPostgres({
        organizationId: fixture.organizationId,
        actorEmail: fixture.actorEmail,
        idempotencyKey: `cleanup-enqueue-${label}-${sequence}`,
        warehouseId: fixture.warehouseId,
        preferredPrinterGlobalId: printer.global_id,
        maxAttempts: 3,
        document: {
          type: 'packing_slip',
          format: 'PDF',
          media: 'letter',
          contentSha256: createHash('sha256').update(content).digest('hex'),
          byteLength: content.byteLength,
          storageReference: `clawpilot-document:cleanup-${label}-${sequence}`,
        },
      })
      const claimed = await persistence.claimOperationsPrintJobsInPostgres({
        agent: activeAgent,
        idempotencyKey: `cleanup-claim-${label}-${sequence}`,
        limit: 1,
        leaseSeconds: 120,
        runtimeCapabilities: capabilities,
      })
      assert.equal(claimed.length, 1)
      assert.equal(claimed[0].globalId, job.globalId)
      return { job, claim: claimed[0], entry: cleanupEntry(job, claimed[0]) }
    }

    const delivered = await enqueueAndClaim('delivered')
    await persistence.acknowledgeOperationsPrintJobInPostgres({
      agent: activeAgent,
      jobGlobalId: delivered.job.globalId,
      claimToken: delivered.claim.claimToken,
      idempotencyKey: `cleanup-ack-${fixture.suffix}`,
    })
    const zeroByte = await enqueueAndClaim('zero-byte')
    await persistence.failOperationsPrintJobInPostgres({
      agent: activeAgent,
      jobGlobalId: zeroByte.job.globalId,
      claimToken: zeroByte.claim.claimToken,
      idempotencyKey: `cleanup-zero-${fixture.suffix}`,
      errorCode: 'PRINT_DELIVERY_STOPPED',
      errorMessage: 'The local worker stopped before raw delivery began',
      retryable: false,
      printerUnavailable: false,
      retryAfterSeconds: 0,
    })
    const expired = await enqueueAndClaim('expired')
    await pool.query('BEGIN')
    try {
      await pool.query(
        `ALTER TABLE operations_print_delivery_attempts
         DISABLE TRIGGER protect_operations_print_delivery_attempt_write`,
      )
      await pool.query(
        `UPDATE operations_print_delivery_attempts
         SET occurred_at = clock_timestamp() - interval '3 minutes',
             claim_expires_at = clock_timestamp() - interval '2 minutes'
         WHERE organization_id = $1::uuid
           AND id = $2::uuid`,
        [fixture.organizationId, expired.claim.claimToken],
      )
      await pool.query(
        `ALTER TABLE operations_print_delivery_attempts
         ENABLE TRIGGER protect_operations_print_delivery_attempt_write`,
      )
      await pool.query(
        `UPDATE operations_print_jobs
         SET claim_expires_at = clock_timestamp() - interval '2 minutes'
         WHERE organization_id = $1::uuid
           AND global_id = $2`,
        [fixture.organizationId, expired.job.globalId],
      )
      await pool.query('COMMIT')
    } catch (error) {
      await pool.query('ROLLBACK')
      throw error
    }

    const evidenceMismatchCases = [
      {
        label: 'digest',
        entry: {
          ...delivered.entry,
          contentSha256: delivered.entry.contentSha256 === 'f'.repeat(64)
            ? 'e'.repeat(64)
            : 'f'.repeat(64),
        },
      },
      {
        label: 'artifact',
        entry: {
          ...delivered.entry,
          documentGlobalId: delivered.entry.documentGlobalId === 'gpf9999999'
            ? 'gpf9999998'
            : 'gpf9999999',
        },
      },
      {
        label: 'claim',
        entry: { ...delivered.entry, claimToken: randomUUID() },
      },
      {
        label: 'job',
        entry: {
          ...delivered.entry,
          jobGlobalId: delivered.entry.jobGlobalId === 'gpj9999999'
            ? 'gpj9999998'
            : 'gpj9999999',
        },
      },
    ]
    let mismatch
    for (const mismatchCase of evidenceMismatchCases) {
      const idempotencyKey = `cleanup-mismatch-${mismatchCase.label}-${fixture.suffix}`
      const caught = await expectRequestError(
        () => persistence.resolveOperationsPrintAgentCleanupStatusInPostgres({
          agent: cleanupAgent,
          entries: [expired.entry, mismatchCase.entry],
          idempotencyKey,
        }),
        'OPERATIONS_PRINT_AGENT_CLEANUP_EVIDENCE_MISMATCH',
        409,
      )
      mismatch ||= caught
      assert.equal(caught.message, 'Print-agent cleanup evidence could not be verified')
      const afterMismatch = await pool.query(
        `SELECT status, current_claim_attempt_id::text
         FROM operations_print_jobs
         WHERE organization_id = $1::uuid
           AND global_id = $2`,
        [fixture.organizationId, expired.job.globalId],
      )
      assert.deepEqual(afterMismatch.rows[0], {
        status: 'claimed',
        current_claim_attempt_id: expired.claim.claimToken,
      })
      assert.equal(
        (await pool.query(
          `SELECT count(*)::integer AS count
           FROM operations_print_agent_cleanup_receipts
           WHERE organization_id = $1::uuid
             AND idempotency_key = $2`,
          [fixture.organizationId, idempotencyKey],
        )).rows[0].count,
        0,
      )
    }

    const raceResults = await Promise.all([
      persistence.resolveOperationsPrintAgentCleanupStatusInPostgres({
        agent: cleanupAgent,
        entries: [expired.entry],
        idempotencyKey: `cleanup-race-a-${fixture.suffix}`,
      }),
      persistence.resolveOperationsPrintAgentCleanupStatusInPostgres({
        agent: cleanupAgent,
        entries: [expired.entry],
        idempotencyKey: `cleanup-race-b-${fixture.suffix}`,
      }),
    ])
    for (const result of raceResults) {
      assert.deepEqual(structuredClone(result), [{
        resolution: 'outcome_uncertain_terminal',
        removalSafe: true,
        reasonCode: 'SERVER_OUTCOME_UNCERTAIN_TERMINAL',
      }])
    }
    const uncertainAttempts = await pool.query(
      `SELECT count(*)::integer AS count
       FROM operations_print_delivery_attempts
       WHERE organization_id = $1::uuid
         AND print_job_id = (
           SELECT id
           FROM operations_print_jobs
           WHERE organization_id = $1::uuid
             AND global_id = $2
         )
         AND claim_attempt_id = $3::uuid
         AND state = 'failed'
         AND actor_type = 'system'
         AND error_code = 'PRINT_OUTCOME_UNCERTAIN'`,
      [fixture.organizationId, expired.job.globalId, expired.claim.claimToken],
    )
    assert.equal(uncertainAttempts.rows[0].count, 1)
    const replay = await persistence.resolveOperationsPrintAgentCleanupStatusInPostgres({
      agent: cleanupAgent,
      entries: [expired.entry],
      idempotencyKey: `cleanup-race-a-${fixture.suffix}`,
    })
    assert.equal(JSON.stringify(replay), JSON.stringify(raceResults[0]))
    assert.equal(
      (await pool.query(
        `SELECT count(*)::integer AS count
         FROM operations_print_agent_cleanup_receipts
         WHERE organization_id = $1::uuid
           AND print_agent_id = $2::uuid
           AND idempotency_key = $3`,
        [
          fixture.organizationId,
          enrollment.agent.id,
          `cleanup-race-a-${fixture.suffix}`,
        ],
      )).rows[0].count,
      1,
    )
    await expectRequestError(
      () => persistence.resolveOperationsPrintAgentCleanupStatusInPostgres({
        agent: cleanupAgent,
        entries: [delivered.entry],
        idempotencyKey: `cleanup-race-a-${fixture.suffix}`,
      }),
      'OPERATIONS_PRINT_IDEMPOTENCY_REUSED',
      409,
    )

    const inFlight = await enqueueAndClaim('in-flight')
    const inFlightResult = await persistence
      .resolveOperationsPrintAgentCleanupStatusInPostgres({
        agent: cleanupAgent,
        entries: [inFlight.entry],
        idempotencyKey: `cleanup-in-flight-${fixture.suffix}`,
      })
    assert.deepEqual(structuredClone(inFlightResult), [{
      resolution: 'in_flight',
      removalSafe: false,
      reasonCode: 'SERVER_CLAIM_IN_FLIGHT',
    }])
    await persistence.failOperationsPrintJobInPostgres({
      agent: activeAgent,
      jobGlobalId: inFlight.job.globalId,
      claimToken: inFlight.claim.claimToken,
      idempotencyKey: `cleanup-in-flight-resolved-${fixture.suffix}`,
      errorCode: 'PRINTER_UNAVAILABLE',
      errorMessage: 'No printer bytes were accepted during the in-flight test',
      retryable: false,
      printerUnavailable: false,
      retryAfterSeconds: 0,
    })
    assert.equal(
      JSON.stringify(await persistence.resolveOperationsPrintAgentCleanupStatusInPostgres({
        agent: cleanupAgent,
        entries: [inFlight.entry],
        idempotencyKey: `cleanup-in-flight-${fixture.suffix}`,
      })),
      JSON.stringify(inFlightResult),
    )
    assert.deepEqual(structuredClone(
      await persistence.resolveOperationsPrintAgentCleanupStatusInPostgres({
        agent: cleanupAgent,
        entries: [inFlight.entry],
        idempotencyKey: `cleanup-in-flight-resolved-status-${fixture.suffix}`,
      }),
    ), [{
      resolution: 'failed_zero_byte_confirmed',
      removalSafe: true,
      reasonCode: 'SERVER_ZERO_BYTE_FAILURE_CONFIRMED',
    }])

    const beforePreservation = await pool.query(
      `SELECT print_job_id::text, count(*)::integer AS count
       FROM operations_print_delivery_attempts
       WHERE organization_id = $1::uuid
         AND print_job_id = ANY(ARRAY[
           (SELECT id FROM operations_print_jobs WHERE global_id = $2),
           (SELECT id FROM operations_print_jobs WHERE global_id = $3)
         ]::uuid[])
       GROUP BY print_job_id
       ORDER BY print_job_id`,
      [fixture.organizationId, delivered.job.globalId, zeroByte.job.globalId],
    )
    const preserved = await persistence.resolveOperationsPrintAgentCleanupStatusInPostgres({
      agent: cleanupAgent,
      entries: [delivered.entry, zeroByte.entry],
      idempotencyKey: `cleanup-preserved-${fixture.suffix}`,
    })
    assert.deepEqual(structuredClone(preserved), [
      {
        resolution: 'delivered',
        removalSafe: true,
        reasonCode: 'SERVER_DELIVERY_CONFIRMED',
      },
      {
        resolution: 'failed_zero_byte_confirmed',
        removalSafe: true,
        reasonCode: 'SERVER_ZERO_BYTE_FAILURE_CONFIRMED',
      },
    ])
    const afterPreservation = await pool.query(
      `SELECT print_job_id::text, count(*)::integer AS count
       FROM operations_print_delivery_attempts
       WHERE organization_id = $1::uuid
         AND print_job_id = ANY(ARRAY[
           (SELECT id FROM operations_print_jobs WHERE global_id = $2),
           (SELECT id FROM operations_print_jobs WHERE global_id = $3)
         ]::uuid[])
       GROUP BY print_job_id
       ORDER BY print_job_id`,
      [fixture.organizationId, delivered.job.globalId, zeroByte.job.globalId],
    )
    assert.deepEqual(afterPreservation.rows, beforePreservation.rows)

    const oldCredential = enrollment.credential
    const firstRotation = await persistence.rotateOperationsPrintAgentCredentialInPostgres({
      organizationId: fixture.organizationId,
      printAgentGlobalId: enrollment.agent.globalId,
      actorEmail: fixture.actorEmail,
      idempotencyKey: `cleanup-rotation-first-${fixture.suffix}`,
    })
    assert.ok(firstRotation.credential)
    assert.equal(await persistence.authenticateOperationsPrintAgentInPostgres(oldCredential), null)
    const oldestCleanupAgent = await persistence
      .authenticateOperationsPrintAgentForCleanupInPostgres(oldCredential)
    assert.equal(oldestCleanupAgent.id, enrollment.agent.id)
    assert.equal(
      (await persistence.authenticateOperationsPrintAgentInPostgres(
        firstRotation.credential,
      )).id,
      enrollment.agent.id,
    )
    assert.deepEqual(structuredClone(
      await persistence.resolveOperationsPrintAgentCleanupStatusInPostgres({
        agent: oldestCleanupAgent,
        entries: [delivered.entry],
        idempotencyKey: `cleanup-old-credential-${fixture.suffix}`,
      }),
    ), [{
      resolution: 'delivered',
      removalSafe: true,
      reasonCode: 'SERVER_DELIVERY_CONFIRMED',
    }])
    const secondRotation = await persistence.rotateOperationsPrintAgentCredentialInPostgres({
      organizationId: fixture.organizationId,
      printAgentGlobalId: enrollment.agent.globalId,
      actorEmail: fixture.actorEmail,
      idempotencyKey: `cleanup-rotation-second-${fixture.suffix}`,
    })
    assert.ok(secondRotation.credential)
    assert.equal(await persistence.authenticateOperationsPrintAgentInPostgres(oldCredential), null)
    assert.equal(
      await persistence.authenticateOperationsPrintAgentInPostgres(firstRotation.credential),
      null,
    )
    const oldestCleanupAgentAfterTwoRotations = await persistence
      .authenticateOperationsPrintAgentForCleanupInPostgres(oldCredential)
    const priorCleanupAgent = await persistence
      .authenticateOperationsPrintAgentForCleanupInPostgres(firstRotation.credential)
    const currentCleanupAgent = await persistence
      .authenticateOperationsPrintAgentForCleanupInPostgres(secondRotation.credential)
    assert.equal(oldestCleanupAgentAfterTwoRotations.id, enrollment.agent.id)
    assert.equal(priorCleanupAgent.id, enrollment.agent.id)
    assert.equal(currentCleanupAgent.id, enrollment.agent.id)
    for (const [label, retainedAgent] of [
      ['oldest', oldestCleanupAgentAfterTwoRotations],
      ['prior', priorCleanupAgent],
    ]) {
      assert.deepEqual(structuredClone(
        await persistence.resolveOperationsPrintAgentCleanupStatusInPostgres({
          agent: retainedAgent,
          entries: [delivered.entry],
          idempotencyKey: `cleanup-${label}-after-two-rotations-${fixture.suffix}`,
        }),
      ), [{
        resolution: 'delivered',
        removalSafe: true,
        reasonCode: 'SERVER_DELIVERY_CONFIRMED',
      }])
    }
    const retained = await pool.query(
      `SELECT credential_version, secret_hash
       FROM operations_print_agent_cleanup_credentials
       WHERE organization_id = $1::uuid
         AND print_agent_id = $2::uuid
       ORDER BY credential_version`,
      [fixture.organizationId, enrollment.agent.id],
    )
    assert.equal(retained.rows.length, 2)
    assert.deepEqual(retained.rows.map((row) => row.credential_version), [1, 2])
    for (const row of retained.rows) {
      assert.match(row.secret_hash, /^[a-f0-9]{64}$/)
    }
    assert.equal(JSON.stringify(retained.rows).includes(oldCredential), false)
    assert.equal(JSON.stringify(retained.rows).includes(firstRotation.credential), false)

    const otherEnrollment = await persistence.enrollOperationsPrintAgentInPostgres({
      organizationId: fixture.organizationId,
      warehouseId: fixture.warehouseId,
      name: 'Other cleanup print agent',
      actorEmail: fixture.actorEmail,
      idempotencyKey: `cleanup-other-agent-${fixture.suffix}`,
      ...capabilities,
    })
    const otherCleanupAgent = await persistence
      .authenticateOperationsPrintAgentForCleanupInPostgres(otherEnrollment.credential)
    const wrongOwner = await expectRequestError(
      () => persistence.resolveOperationsPrintAgentCleanupStatusInPostgres({
        agent: otherCleanupAgent,
        entries: [delivered.entry],
        idempotencyKey: `cleanup-wrong-owner-${fixture.suffix}`,
      }),
      'OPERATIONS_PRINT_AGENT_CLEANUP_EVIDENCE_MISMATCH',
      409,
    )
    assert.equal(wrongOwner.message, mismatch.message)

    const rotatedRuntimeAgent = await persistence
      .authenticateOperationsPrintAgentInPostgres(secondRotation.credential)
    const unsafe = await enqueueAndClaim('unsafe-legacy')
    await persistence.failOperationsPrintJobInPostgres({
      agent: rotatedRuntimeAgent,
      jobGlobalId: unsafe.job.globalId,
      claimToken: unsafe.claim.claimToken,
      idempotencyKey: `cleanup-unsafe-fail-${fixture.suffix}`,
      errorCode: 'PRINT_OUTCOME_UNCERTAIN',
      errorMessage: 'Printer delivery may have begun',
      retryable: false,
      printerUnavailable: false,
      retryAfterSeconds: 0,
    })
    const uncertainRetryTrigger = await pool.query(
      `SELECT 1
       FROM pg_trigger
       WHERE tgrelid = to_regclass('operations_print_delivery_attempts')
         AND tgname = 'prevent_operations_uncertain_print_retry_write'
         AND NOT tgisinternal`,
    )
    if (uncertainRetryTrigger.rowCount) {
      await pool.query(
        `ALTER TABLE operations_print_delivery_attempts
         DISABLE TRIGGER prevent_operations_uncertain_print_retry_write`,
      )
    }
    try {
      await pool.query(
        `INSERT INTO operations_print_delivery_attempts (
           organization_id, print_job_id, printer_id,
           state, actor_type, idempotency_key, request_fingerprint, detail
         ) SELECT
           job.organization_id, job.id, job.printer_id,
           'queued', 'system', $3, $4,
           'Legacy unsafe uncertain retry fixture'
         FROM operations_print_jobs job
         WHERE job.organization_id = $1::uuid
           AND job.global_id = $2`,
        [
          fixture.organizationId,
          unsafe.job.globalId,
          `cleanup-unsafe-queue-${fixture.suffix}`,
          persistence.operationsPrintDeliveryFingerprint({
            unsafeLegacyRetry: unsafe.job.globalId,
          }),
        ],
      )
    } finally {
      if (uncertainRetryTrigger.rowCount) {
        await pool.query(
          `ALTER TABLE operations_print_delivery_attempts
           ENABLE TRIGGER prevent_operations_uncertain_print_retry_write`,
        )
      }
    }
    assert.deepEqual(structuredClone(
      await persistence.resolveOperationsPrintAgentCleanupStatusInPostgres({
        agent: currentCleanupAgent,
        entries: [unsafe.entry],
        idempotencyKey: `cleanup-unsafe-status-${fixture.suffix}`,
      }),
    ), [{
      resolution: 'unresolved',
      removalSafe: false,
      reasonCode: 'SERVER_CLAIM_UNRESOLVED',
    }])
    const unsafeHealth = await pool.query(
      `SELECT NOT EXISTS (
         SELECT 1
         FROM operations_print_delivery_attempts uncertain
         JOIN operations_print_delivery_attempts requeued
           ON requeued.organization_id = uncertain.organization_id
          AND requeued.print_job_id = uncertain.print_job_id
          AND requeued.sequence_number > uncertain.sequence_number
          AND requeued.state = 'queued'
         WHERE uncertain.state = 'failed'
           AND uncertain.error_code = 'PRINT_OUTCOME_UNCERTAIN'
       ) AS cleanup_ledger_safe`,
    )
    assert.equal(unsafeHealth.rows[0].cleanup_ledger_safe, false)
    assert.ok(read('app_src/app/api/health/route.ts').includes(
      "uncertain.error_code = 'PRINT_OUTCOME_UNCERTAIN'",
    ))
    await persistence.cancelOperationsPrintJobInPostgres({
      organizationId: fixture.organizationId,
      jobGlobalId: unsafe.job.globalId,
      actorEmail: fixture.actorEmail,
      idempotencyKey: `cleanup-unsafe-cancel-${fixture.suffix}`,
      reason: 'Stop the deliberately unsafe legacy fixture from being claimed',
    })

    const revokedCurrent = await enqueueAndClaim('revoked-current')
    assert.deepEqual(structuredClone(
      await persistence.resolveOperationsPrintAgentCleanupStatusInPostgres({
        agent: currentCleanupAgent,
        entries: [revokedCurrent.entry],
        idempotencyKey: `cleanup-before-revoke-${fixture.suffix}`,
      }),
    ), [{
      resolution: 'in_flight',
      removalSafe: false,
      reasonCode: 'SERVER_CLAIM_IN_FLIGHT',
    }])
    await persistence.revokeOperationsPrintAgentInPostgres({
      organizationId: fixture.organizationId,
      printAgentGlobalId: enrollment.agent.globalId,
      actorEmail: fixture.actorEmail,
    })
    assert.equal(
      await persistence.authenticateOperationsPrintAgentInPostgres(secondRotation.credential),
      null,
    )
    const revokedCleanupAgent = await persistence
      .authenticateOperationsPrintAgentForCleanupInPostgres(secondRotation.credential)
    assert.equal(revokedCleanupAgent.id, enrollment.agent.id)
    assert.deepEqual(structuredClone(
      await persistence.resolveOperationsPrintAgentCleanupStatusInPostgres({
        agent: revokedCleanupAgent,
        entries: [revokedCurrent.entry],
        idempotencyKey: `cleanup-revoked-current-${fixture.suffix}`,
      }),
    ), [{
      resolution: 'outcome_uncertain_terminal',
      removalSafe: true,
      reasonCode: 'SERVER_OUTCOME_UNCERTAIN_TERMINAL',
    }])
    const revokedClaimProjection = await insertReturning(
      pool,
      `SELECT
         status,
         claimed_by_print_agent_id::text,
         current_claim_attempt_id::text,
         claim_expires_at
       FROM operations_print_jobs
       WHERE organization_id = $1::uuid
         AND global_id = $2`,
      [fixture.organizationId, revokedCurrent.job.globalId],
    )
    assert.deepEqual(revokedClaimProjection, {
      status: 'failed',
      claimed_by_print_agent_id: null,
      current_claim_attempt_id: null,
      claim_expires_at: null,
    })
    const lingeringRevokedClaims = await pool.query(
      `SELECT count(*)::integer AS count
       FROM operations_print_jobs
       WHERE organization_id = $1::uuid
         AND status = 'claimed'
         AND claimed_by_print_agent_id = $2::uuid`,
      [fixture.organizationId, enrollment.agent.id],
    )
    assert.equal(lingeringRevokedClaims.rows[0].count, 0)
    assert.equal(
      (await persistence.authenticateOperationsPrintAgentForCleanupInPostgres(
        oldCredential,
      )).id,
      enrollment.agent.id,
    )

    assert.equal(
      auditCalls.filter((event) => (
        event.payload?.errorCode === 'PRINT_OUTCOME_UNCERTAIN'
        && event.payload?.automaticRetryBlocked === true
        && event.aggregateId === expired.job.globalId
      )).length,
      1,
      JSON.stringify(auditCalls.map((event) => ({
        aggregateId: event.aggregateId,
        eventKey: event.eventKey,
        payload: event.payload,
      }))),
    )
    const structural = await pool.query(
      `SELECT
         to_regclass('operations_print_agent_cleanup_credentials') IS NOT NULL
           AS credentials_present,
         to_regclass('operations_print_agent_cleanup_receipts') IS NOT NULL
           AS receipts_present,
         EXISTS (
           SELECT 1 FROM pg_trigger
           WHERE tgname = 'retain_operations_print_agent_cleanup_credential_write'
             AND tgenabled = 'O'
             AND NOT tgisinternal
         ) AS retention_enabled,
         (
           SELECT count(*) = 2 FROM pg_trigger
           WHERE tgname = ANY (ARRAY[
             'protect_operations_print_agent_cleanup_credential_write',
             'protect_operations_print_agent_cleanup_receipt_write'
           ])
             AND tgenabled = 'O'
             AND NOT tgisinternal
         ) AS append_only_guards_enabled`,
    )
    assert.deepEqual(structural.rows[0], {
      credentials_present: true,
      receipts_present: true,
      retention_enabled: true,
      append_only_guards_enabled: true,
    })
    await assert.rejects(
      pool.query(
        `UPDATE operations_print_agent_cleanup_credentials
         SET secret_hash = $3
         WHERE organization_id = $1::uuid
           AND print_agent_id = $2::uuid`,
        [fixture.organizationId, enrollment.agent.id, '0'.repeat(64)],
      ),
      /append-only/i,
    )
    await assert.rejects(
      pool.query(
        `DELETE FROM operations_print_agent_cleanup_receipts
         WHERE organization_id = $1::uuid
           AND print_agent_id = $2::uuid`,
        [fixture.organizationId, enrollment.agent.id],
      ),
      /append-only/i,
    )
  } finally {
    await pool.end()
  }
}

async function main() {
  await verifyRouteContract()
  command('docker', ['info'], { timeout: 30_000 })
  const container = `clawpilot-print-cleanup-${process.pid}-${randomUUID().slice(0, 8)}`
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=clawpilot_print_cleanup',
      '-e', 'POSTGRES_DB=clawpilot_print_cleanup',
      '-p', '127.0.0.1::5432',
      'pgvector/pgvector:pg16',
    ], { timeout: 180_000 })
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/)?.[1])
    assert.ok(port > 0, `Unable to resolve disposable PostgreSQL port from ${portOutput}`)
    const connectionString =
      `postgresql://postgres:clawpilot_print_cleanup@127.0.0.1:${port}/clawpilot_print_cleanup`
    await waitForPostgres(connectionString)
    command('node', ['scripts/db-migrate.mjs'], {
      env: { DATABASE_URL: connectionString, PGSSLMODE: 'disable' },
      timeout: 240_000,
    })
    await verifyPostgresContract(connectionString)
  } finally {
    spawnSync('docker', ['stop', '-t', '1', container], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000,
    })
  }
  console.log('Operations print-agent cleanup-status tests passed.')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
