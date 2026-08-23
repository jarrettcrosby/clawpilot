import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import test, { mock } from 'node:test'

const appSourceUrl = new URL('../../', import.meta.url)

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) {
      const appPath = specifier.slice(2)
      return nextResolve(
        new URL(appPath.endsWith('.mjs') ? appPath : `${appPath}.ts`, appSourceUrl).href,
        context,
      )
    }
    return nextResolve(specifier, context)
  },
})

type ReceiptState = {
  id: string
  commandType: string
  idempotencyKey: string
  request_hash: string
  target_global_id: string | null
  actor_email: string
  status: 'processing' | 'succeeded' | 'failed'
  correlation_id: string
  result_global_id: string | null
  result_payload: Record<string, unknown> | null
  attempts: number
  updated_at: Date
  error_code: string | null
}

type TaskState = {
  id: string
  global_id: string
  wave_id: string
  status: string
  assigned_to: string | null
  assigned_at: Date | null
  picked_quantity: string | null
  picked_at: Date | null
}

type WearableScanEvidenceState = {
  id: string
  organization_id: string
  command_receipt_id: string
  order_id: string
  order_row_version: number
  recorded_by: string
  server_observed_at: Date
}

const ids = {
  organization: '11111111-1111-4111-8111-111111111111',
  order: '22222222-2222-4222-8222-222222222222',
  plan: '33333333-3333-4333-8333-333333333333',
  wave: '44444444-4444-4444-8444-444444444444',
  task1: '55555555-5555-4555-8555-555555555551',
  task2: '55555555-5555-4555-8555-555555555552',
  package: '66666666-6666-4666-8666-666666666666',
} as const

class FakeOperationsDatabase {
  order = {
    id: ids.order,
    global_id: 'gor0000001',
    status: 'released',
    row_version: 7,
  }
  plan = {
    id: ids.plan,
    global_id: 'gfp0000001',
    status: 'released',
  }
  wave = {
    id: ids.wave,
    global_id: 'gwv0000001',
    status: 'released',
  }
  tasks: TaskState[] = [
    {
      id: ids.task1,
      global_id: 'gpk0000001',
      wave_id: ids.wave,
      status: 'ready',
      assigned_to: 'picker@example.test',
      assigned_at: new Date('2026-08-12T12:00:00Z'),
      picked_quantity: null,
      picked_at: null,
    },
    {
      id: ids.task2,
      global_id: 'gpk0000002',
      wave_id: ids.wave,
      status: 'ready',
      assigned_to: 'picker@example.test',
      assigned_at: new Date('2026-08-12T12:00:00Z'),
      picked_quantity: '0',
      picked_at: null,
    },
  ]
  packages = [{ id: ids.package, status: 'planned', packed_at: null as Date | null }]
  labels: Array<{ id: string }> = []
  labelAttempts: Array<{ id: string }> = []
  wearableScanEvidence: WearableScanEvidenceState[] = []
  inventory = [{ id: 'position-1', onHand: 20, reserved: 2 }]
  reservations = [{ id: 'reservation-1', status: 'active', quantity: 2 }]
  receipts = new Map<string, ReceiptState>()
  exceptions: Array<Record<string, unknown>> = []
  domainEvents: Array<Record<string, unknown>> = []
  auditEvents: Array<Record<string, unknown>> = []
  sql: string[] = []
  locks: string[] = []
  receiptSequence = 0

  receiptKey(commandType: string, idempotencyKey: string) {
    return `${commandType}:${idempotencyKey}`
  }

  addBlockedConfirmation(overrides: Partial<ReceiptState> = {}) {
    const receipt: ReceiptState = {
      id: '77777777-7777-4777-8777-777777777777',
      commandType: 'confirm_operations_order_picks',
      idempotencyKey: 'wearable-pick:blocked-0001',
      request_hash: 'a'.repeat(64),
      target_global_id: this.order.global_id,
      actor_email: 'picker@example.test',
      status: 'failed',
      correlation_id: '88888888-8888-4888-8888-888888888888',
      result_global_id: null,
      result_payload: null,
      attempts: 1,
      updated_at: new Date('2026-08-12T12:05:00Z'),
      error_code: 'OPERATIONS_SHOPIFY_EXTERNAL_FULFILLMENT_RECONCILIATION_REQUIRED',
      ...overrides,
    }
    this.receipts.set(
      this.receiptKey(receipt.commandType, receipt.idempotencyKey),
      receipt,
    )
  }

  addAcknowledgedWearableScanEvidence(input: {
    receipt?: Partial<ReceiptState>
    evidence?: Partial<WearableScanEvidenceState>
  } = {}) {
    const receipt: ReceiptState = {
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      commandType: 'record_wearable_pick_scan_evidence',
      idempotencyKey: 'wearable-scan:acknowledged-0001',
      request_hash: 'b'.repeat(64),
      target_global_id: this.order.global_id,
      actor_email: 'picker@example.test',
      status: 'succeeded',
      correlation_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      result_global_id: this.order.global_id,
      result_payload: {
        orderGlobalId: this.order.global_id,
        orderRowVersion: this.order.row_version,
        evidenceCount: 1,
        serverObservedAt: '2026-08-12T12:04:00.000Z',
      },
      attempts: 1,
      updated_at: new Date('2026-08-12T12:04:00Z'),
      error_code: null,
      ...input.receipt,
    }
    this.receipts.set(
      this.receiptKey(receipt.commandType, receipt.idempotencyKey),
      receipt,
    )
    this.wearableScanEvidence.push({
      id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      organization_id: ids.organization,
      command_receipt_id: receipt.id,
      order_id: this.order.id,
      order_row_version: this.order.row_version,
      recorded_by: receipt.actor_email,
      server_observed_at: new Date('2026-08-12T12:04:00Z'),
      ...input.evidence,
    })
  }

  result(rows: Array<Record<string, unknown>> = [], rowCount = rows.length) {
    return { rows, rowCount }
  }

  async execute(sql: string, values: unknown[] = []) {
    const normalized = sql.replace(/\s+/g, ' ').trim()
    this.sql.push(normalized)

    if (
      normalized.startsWith('SELECT id::text, request_hash, target_global_id,')
      && normalized.includes('command_type = $2')
    ) {
      const receipt = this.receipts.get(
        this.receiptKey(String(values[1]), String(values[2])),
      )
      return this.result(receipt ? [receipt] : [])
    }
    if (normalized.startsWith('INSERT INTO operations_command_receipts')) {
      const receipt: ReceiptState = {
        id: `99999999-9999-4999-8999-${String(++this.receiptSequence).padStart(12, '0')}`,
        commandType: String(values[1]),
        idempotencyKey: String(values[2]),
        request_hash: String(values[3]),
        actor_email: String(values[4]),
        status: 'processing',
        correlation_id: String(values[5]),
        target_global_id: values[6] === null ? null : String(values[6]),
        result_global_id: null,
        result_payload: null,
        attempts: 1,
        updated_at: new Date(),
        error_code: null,
      }
      this.receipts.set(
        this.receiptKey(receipt.commandType, receipt.idempotencyKey),
        receipt,
      )
      return this.result([receipt], 1)
    }
    if (normalized.startsWith("UPDATE operations_command_receipts SET status = 'processing'")) {
      const receipt = [...this.receipts.values()].find((item) => item.id === values[0])!
      receipt.status = 'processing'
      receipt.actor_email = String(values[1])
      receipt.attempts += 1
      receipt.error_code = null
      receipt.updated_at = new Date()
      return this.result([receipt], 1)
    }
    if (normalized.startsWith("UPDATE operations_command_receipts SET status = 'succeeded'")) {
      const receipt = [...this.receipts.values()].find((item) => item.id === values[0])!
      receipt.status = 'succeeded'
      receipt.result_global_id = String(values[1])
      receipt.result_payload = JSON.parse(String(values[2])) as Record<string, unknown>
      receipt.error_code = null
      receipt.updated_at = new Date()
      return this.result([], 1)
    }
    if (normalized.startsWith("UPDATE operations_command_receipts SET status = 'failed'")) {
      const receipt = [...this.receipts.values()].find((item) => item.id === values[0])
      if (receipt && receipt.status === 'processing') {
        receipt.status = 'failed'
        receipt.error_code = String(values[1])
        receipt.updated_at = new Date()
      }
      return this.result([], receipt ? 1 : 0)
    }
    if (
      normalized.startsWith('SELECT id::text, global_id, status, row_version::text')
      && normalized.includes('FROM operations_orders')
    ) {
      return this.result([{
        id: this.order.id,
        global_id: this.order.global_id,
        status: this.order.status,
        row_version: String(this.order.row_version),
      }])
    }
    if (normalized.startsWith('SELECT activation.data_pipeline_id::text')) {
      return this.result([{
        data_pipeline_id: '12121212-1212-4212-8212-121212121212',
        pipeline_name: 'Test pipeline',
        pipeline_owner_email: 'owner@example.test',
        state: 'active',
        revision: 1,
        reason: 'Test activation',
        updated_at: new Date('2026-08-12T12:00:00Z'),
      }])
    }
    if (normalized.includes('FROM operations_fulfillment_plans')) {
      return this.result([this.plan])
    }
    if (normalized.includes('FROM operations_waves wave')) {
      return this.result([this.wave])
    }
    if (
      normalized.startsWith('SELECT pick.id::text, pick.global_id,')
      && normalized.includes('FROM operations_pick_tasks pick')
    ) {
      return this.result(this.tasks.map((task) => ({
        ...task,
        assigned_to: task.assigned_to?.toLowerCase() ?? null,
      })))
    }
    if (normalized.includes('FROM operations_packages package') && !normalized.includes('JOIN')) {
      return this.result(this.packages)
    }
    if (normalized.includes('FROM operations_labels label')) {
      return this.result(this.labels)
    }
    if (normalized.includes('FROM operations_label_attempts attempt')) {
      return this.result(this.labelAttempts)
    }
    if (
      normalized.startsWith('SELECT evidence.id::text')
      && normalized.includes('FROM operations_wearable_pick_scan_evidence evidence')
    ) {
      const [organizationId, orderId, rowVersion, actorEmail, orderGlobalId] = values
      const matches = this.wearableScanEvidence.filter((evidence) => {
        const receipt = [...this.receipts.values()].find(
          (candidate) => candidate.id === evidence.command_receipt_id,
        )
        return evidence.organization_id === organizationId
          && evidence.order_id === orderId
          && evidence.order_row_version === Number(rowVersion)
          && evidence.recorded_by.toLowerCase() === String(actorEmail)
          && receipt?.commandType === 'record_wearable_pick_scan_evidence'
          && receipt.status === 'succeeded'
          && receipt.actor_email.toLowerCase() === String(actorEmail)
          && receipt.target_global_id === orderGlobalId
      })
      return this.result(matches.slice(0, 1))
    }
    if (
      normalized.includes('FROM operations_command_receipts')
      && normalized.includes("command_type = 'confirm_operations_order_picks'")
    ) {
      const receipt = this.receipts.get(
        this.receiptKey('confirm_operations_order_picks', String(values[1])),
      )
      return this.result(receipt ? [receipt] : [])
    }
    if (normalized.startsWith('UPDATE operations_pick_tasks SET assigned_to = NULL')) {
      const taskIds = values[1] as string[]
      const actor = String(values[2])
      const matches = this.tasks.filter((task) => (
        taskIds.includes(task.id)
        && task.status === 'ready'
        && Number(task.picked_quantity || 0) === 0
        && task.picked_at === null
        && task.assigned_to?.toLowerCase() === actor
      ))
      for (const task of matches) {
        task.assigned_to = null
        task.assigned_at = null
      }
      return this.result(matches.map((task) => ({ id: task.id })), matches.length)
    }
    if (normalized.startsWith('UPDATE operations_orders SET updated_by = $4')) {
      if (
        this.order.id !== values[1]
        || this.order.status !== 'released'
        || this.order.row_version !== Number(values[2])
      ) return this.result([], 0)
      this.order.row_version += 1
      return this.result([{
        id: this.order.id,
        global_id: this.order.global_id,
        status: this.order.status,
        row_version: String(this.order.row_version),
      }], 1)
    }
    if (normalized.startsWith('INSERT INTO operations_exceptions')) {
      const exception = {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        global_id: 'gex0000001',
        organizationId: values[0],
        orderId: values[1],
        title: values[2],
        details: JSON.parse(String(values[3])) as Record<string, unknown>,
        exceptionType: 'picker_handoff_requested',
        severity: 'high',
        status: 'open',
        assignedTo: null,
      }
      this.exceptions.push(exception)
      return this.result([exception], 1)
    }
    if (normalized.startsWith('INSERT INTO operations_domain_events')) {
      this.domainEvents.push({
        organizationId: values[0],
        aggregateType: values[1],
        aggregateId: values[2],
        aggregateGlobalId: values[3],
        eventType: values[4],
        payload: JSON.parse(String(values[5])) as Record<string, unknown>,
        actorEmail: values[6],
        correlationId: values[7],
        idempotencyKey: values[8],
      })
      return this.result([], 1)
    }
    throw new Error(`Unexpected picker handoff SQL: ${normalized}`)
  }
}

let database = new FakeOperationsDatabase()
let providerCalls = 0

const providerCall = () => {
  providerCalls += 1
  throw new Error('Picker handoff must not call a provider')
}

class MockProviderError extends Error {}

mock.module('@/lib/auditWriter', {
  namedExports: {
    async recordAuditEvent(input: Record<string, unknown>) {
      database.auditEvents.push(input)
    },
  },
})

mock.module('@/lib/persistence/postgres', {
  namedExports: {
    async acquireTransactionAdvisoryLock(_client: unknown, key: string) {
      database.locks.push(key)
    },
    getPostgresPool() {
      throw new Error('Picker handoff test must not acquire a standalone pool')
    },
    async query(sql: string, values?: unknown[]) {
      return database.execute(sql, values)
    },
    async withTransaction<T>(callback: (client: { query: typeof database.execute }) => Promise<T>) {
      return callback({ query: database.execute.bind(database) })
    },
  },
})

mock.module('@/lib/integrations/shopifyFulfillmentWriteback', {
  namedExports: {
    executeShopifyFulfillmentWriteback: providerCall,
    prepareShopifyFulfillmentWriteback: providerCall,
    reconcileShopifyFulfillmentWriteback: providerCall,
    shopifyFulfillmentAttemptSignatureHashCandidates: providerCall,
  },
})

mock.module('@/lib/integrations/shopifyOrderPlanningAuthority', {
  namedExports: {
    assertShopifyOrderPlanningAuthorityHash: providerCall,
    inspectShopifyOrderPlanningAuthority: providerCall,
    normalizeShopifyOrderPlanningAuthoritySnapshot: providerCall,
    shopifyOrderPlanningAuthorityHash: providerCall,
    ShopifyOrderPlanningAuthorityError: MockProviderError,
  },
})

mock.module('@/lib/integrations/shopifyExternalFulfillmentReconciliation', {
  namedExports: {
    inspectShopifyExternalFulfillment: providerCall,
    ShopifyExternalFulfillmentReconciliationError: MockProviderError,
  },
})

mock.module('@/lib/integrations/faireFulfillmentRuntime', {
  namedExports: {
    executeCurrentFaireFulfillmentWriteback: providerCall,
    prepareCurrentFaireFulfillmentAuthority: providerCall,
  },
})

const {
  OperationsRequestError,
  recordWearablePickScanEvidenceFromPostgres,
  requestOperationsPickHandoffFromPostgres,
} = await import('../../lib/persistence/operations.ts')
const { canRequestOperationsPickHandoff } =
  await import('../../lib/operations/types.ts')

const baseInput = {
  organizationId: ids.organization,
  actorEmail: 'picker@example.test',
  orderGlobalId: 'gor0000001',
  expectedRowVersion: 7,
  expectedAssignedTaskCount: 2,
  reason: 'Location is inaccessible; manager review requested.',
  idempotencyKey: 'picker-handoff:req-0001',
}

function reset() {
  database = new FakeOperationsDatabase()
  providerCalls = 0
}

function isCode(code: string) {
  return (error: unknown) => (
    error instanceof OperationsRequestError && error.code === code
  )
}

test('request-pick-handoff route requires picker execution permission and exact fields', () => {
  const route = readFileSync(
    new URL('../../app/api/operations/route.ts', import.meta.url),
    'utf8',
  )
  assert.match(route, /action === 'request-pick-handoff'/)
  assert.match(
    route,
    /action === 'request-pick-handoff'[\s\S]*?!canRequestOperationsPickHandoff\(capabilities\)[\s\S]*?OPERATIONS_EXECUTE_REQUIRED/,
  )
  assert.match(route, /requestOperationsPickHandoffFromPostgres\(\{[\s\S]*?activeOperationsOrganizationId\(actor\)[\s\S]*?actorEmail: actor\.email/)
  assert.match(route, /blockedConfirmationIdempotencyKey/)
  assert.match(route, /expectedAssignedTaskCount/)
  assert.match(route, /idempotencyKey: idempotencyKeyValue\(req\)/)
  assert.equal(canRequestOperationsPickHandoff({ canView: true, canExecute: true }), true)
  assert.equal(canRequestOperationsPickHandoff({ canView: true, canExecute: false }), false)
  assert.equal(canRequestOperationsPickHandoff({ canView: false, canExecute: true }), false)
  assert.equal(canRequestOperationsPickHandoff({ canView: false, canExecute: false }), false)
})

test('picker handoff atomically unassigns exact ready work and records manager-blocking evidence', async () => {
  reset()
  database.addBlockedConfirmation()
  database.addAcknowledgedWearableScanEvidence()
  const inventoryBefore = structuredClone(database.inventory)
  const reservationsBefore = structuredClone(database.reservations)

  const result = await requestOperationsPickHandoffFromPostgres({
    ...baseInput,
    blockedConfirmationIdempotencyKey: 'wearable-pick:blocked-0001',
  })

  assert.deepEqual(result, {
    orderGlobalId: 'gor0000001',
    orderStatus: 'released',
    previousRowVersion: 7,
    rowVersion: 8,
    exceptionGlobalId: 'gex0000001',
    assignedTaskCount: 2,
    blockedConfirmationIdempotencyKey: 'wearable-pick:blocked-0001',
    providerWrites: 0,
    replayed: false,
  })
  assert.equal(database.order.status, 'released')
  assert.equal(database.plan.status, 'released')
  assert.equal(database.wave.status, 'released')
  assert.equal(database.order.row_version, 8)
  assert.ok(database.tasks.every((task) => (
    task.status === 'ready'
    && task.assigned_to === null
    && task.assigned_at === null
    && Number(task.picked_quantity || 0) === 0
    && task.picked_at === null
  )))
  assert.deepEqual(database.inventory, inventoryBefore)
  assert.deepEqual(database.reservations, reservationsBefore)
  assert.equal(database.exceptions.length, 1)
  assert.equal(database.exceptions[0].exceptionType, 'picker_handoff_requested')
  assert.equal(database.exceptions[0].severity, 'high')
  assert.equal(database.exceptions[0].status, 'open')
  const details = database.exceptions[0].details as Record<string, unknown>
  assert.equal(details.previousRowVersion, 7)
  assert.equal(details.rowVersion, 8)
  assert.equal(details.assignedTaskCount, 2)
  assert.equal(
    details.blockedConfirmationErrorCode,
    'OPERATIONS_SHOPIFY_EXTERNAL_FULFILLMENT_RECONCILIATION_REQUIRED',
  )
  assert.equal(details.blockedConfirmationRequestHash, 'a'.repeat(64))
  assert.equal(
    details.blockedConfirmationScanEvidenceId,
    'ffffffff-ffff-4fff-8fff-ffffffffffff',
  )
  assert.equal(
    details.blockedConfirmationScanEvidenceReceiptId,
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  )
  assert.match(
    String(details.recommendedAction),
    /reassign every ready task to an eligible picker, then resolve this exception/,
  )
  assert.match(
    String(details.recommendedAction),
    /separate external-fulfillment reconciliation\/cancel path/,
  )
  assert.match(String(details.recommendedAction), /did not modify Shopify/)
  assert.match(
    String(details.recommendedAction),
    /resolving the exception alone does not reassign work/,
  )
  assert.equal(details.providerWrites, 0)
  assert.doesNotMatch(JSON.stringify(details), /barcode/i)
  assert.equal(database.domainEvents.length, 1)
  assert.equal(database.domainEvents[0].eventType, 'operations.pick.handoff_requested')
  assert.equal(database.auditEvents.length, 1)
  assert.equal(
    database.auditEvents[0].eventType,
    'operations.order.pick_handoff_requested',
  )
  assert.equal(providerCalls, 0)
  assert.ok(database.locks.includes(
    `operations:order:${ids.organization}:gor0000001`,
  ))
  assert.ok(database.sql.every((sql) => (
    !sql.startsWith('UPDATE operations_reservations')
    && !sql.startsWith('UPDATE operations_inventory_positions')
    && !sql.startsWith('UPDATE operations_fulfillment_plans')
    && !sql.startsWith('UPDATE operations_waves')
  )))
})

test('picker handoff supports a deliberate pre-confirmation abandon', async () => {
  reset()
  const result = await requestOperationsPickHandoffFromPostgres({
    ...baseInput,
    idempotencyKey: 'picker-handoff:req-0002',
  })
  assert.equal(result.blockedConfirmationIdempotencyKey, null)
  assert.equal(
    (database.exceptions[0].details as Record<string, unknown>)
      .blockedConfirmationIdempotencyKey,
    null,
  )
})

test('acknowledged wearable scans win the order lock and block a generic handoff', async () => {
  reset()
  database.addAcknowledgedWearableScanEvidence()

  await assert.rejects(
    requestOperationsPickHandoffFromPostgres({
      ...baseInput,
      idempotencyKey: 'picker-handoff:scan-first-0001',
    }),
    isCode('OPERATIONS_PICK_HANDOFF_ALREADY_STARTED'),
  )
  assert.equal(database.order.row_version, 7)
  assert.ok(database.tasks.every((task) => task.assigned_to === 'picker@example.test'))
  assert.equal(database.exceptions.length, 0)
  assert.ok(database.locks.includes(
    `operations:order:${ids.organization}:gor0000001`,
  ))

  database.addBlockedConfirmation()
  const terminalResult = await requestOperationsPickHandoffFromPostgres({
    ...baseInput,
    blockedConfirmationIdempotencyKey: 'wearable-pick:blocked-0001',
    idempotencyKey: 'picker-handoff:terminal-scan-0001',
  })
  assert.equal(
    terminalResult.blockedConfirmationIdempotencyKey,
    'wearable-pick:blocked-0001',
  )
  assert.equal(terminalResult.rowVersion, 8)
})

test('generic handoff wins the order lock and makes a later scan acknowledgement stale', async () => {
  reset()
  const result = await requestOperationsPickHandoffFromPostgres({
    ...baseInput,
    idempotencyKey: 'picker-handoff:handoff-first-0001',
  })
  assert.equal(result.rowVersion, 8)
  assert.ok(database.tasks.every((task) => task.assigned_to === null))

  await assert.rejects(
    recordWearablePickScanEvidenceFromPostgres({
      organizationId: ids.organization,
      actorEmail: 'picker@example.test',
      orderGlobalId: 'gor0000001',
      expectedRowVersion: 7,
      scanEvidence: [{
        pickTaskGlobalId: 'gpk0000001',
        policyRowVersion: 1,
        location: {
          barcode: 'CP1L-GWL0000001',
          capturedAt: '2026-08-12T12:03:00.000Z',
          source: 'iphone_camera',
        },
        product: {
          barcode: '012345678905',
          capturedAt: '2026-08-12T12:03:01.000Z',
          source: 'iphone_camera',
        },
      }],
      idempotencyKey: 'wearable-scan:handoff-lost-0001',
    }),
    isCode('OPERATIONS_WEARABLE_SCAN_EVIDENCE_STALE'),
  )
  assert.equal(database.wearableScanEvidence.length, 0)
  assert.equal(
    database.locks.filter(
      (key) => key === `operations:order:${ids.organization}:gor0000001`,
    ).length,
    2,
  )
})

test('picker handoff replays the exact result and rejects idempotency hash drift', async () => {
  reset()
  const first = await requestOperationsPickHandoffFromPostgres(baseInput)
  const replay = await requestOperationsPickHandoffFromPostgres(baseInput)
  assert.deepEqual(replay, { ...first, replayed: true })
  assert.equal(database.order.row_version, 8)
  assert.equal(database.exceptions.length, 1)
  assert.equal(database.domainEvents.length, 1)
  assert.equal(database.auditEvents.length, 1)

  await assert.rejects(
    requestOperationsPickHandoffFromPostgres({
      ...baseInput,
      reason: 'A different reason must not reuse the same key.',
    }),
    isCode('OPERATIONS_IDEMPOTENCY_CONFLICT'),
  )

  await assert.rejects(
    requestOperationsPickHandoffFromPostgres({
      ...baseInput,
      actorEmail: 'other-picker@example.test',
    }),
    isCode('OPERATIONS_IDEMPOTENCY_CONFLICT'),
  )
})

test('picker handoff rejects stale row versions and mixed or wrong assignments', async () => {
  reset()
  database.order.row_version = 8
  await assert.rejects(
    requestOperationsPickHandoffFromPostgres(baseInput),
    isCode('OPERATIONS_ORDER_VERSION_CONFLICT'),
  )
  assert.equal(database.tasks[0].assigned_to, 'picker@example.test')

  reset()
  await assert.rejects(
    requestOperationsPickHandoffFromPostgres({
      ...baseInput,
      expectedAssignedTaskCount: 1,
    }),
    isCode('OPERATIONS_PICK_HANDOFF_TASKS_CHANGED'),
  )
  assert.ok(database.tasks.every((task) => task.assigned_to !== null))

  reset()
  database.tasks[1].assigned_to = 'other-picker@example.test'
  await assert.rejects(
    requestOperationsPickHandoffFromPostgres(baseInput),
    isCode('OPERATIONS_PICK_HANDOFF_ACTOR_MISMATCH'),
  )
  assert.ok(database.tasks.every((task) => task.assigned_to !== null))
})

test('picker handoff fails closed for non-ready, partial, packed, or labeled work', async () => {
  const cases: Array<() => void> = [
    () => { database.tasks[0].status = 'in_progress' },
    () => { database.tasks[0].picked_quantity = '1' },
    () => { database.tasks[0].picked_at = new Date('2026-08-12T12:10:00Z') },
    () => { database.packages[0].status = 'packed' },
    () => { database.labels.push({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }) },
    () => { database.labelAttempts.push({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }) },
  ]
  for (const arrange of cases) {
    reset()
    arrange()
    await assert.rejects(
      requestOperationsPickHandoffFromPostgres(baseInput),
      isCode('OPERATIONS_PICK_HANDOFF_ALREADY_STARTED'),
    )
    assert.ok(database.tasks.every((task) => task.assigned_to !== null))
    assert.equal(database.exceptions.length, 0)
  }
})

test('blocked confirmation key must be a failed receipt for the same actor and order', async () => {
  const variants: Array<Partial<ReceiptState>> = [
    { target_global_id: 'gor0000002' },
    { actor_email: 'other-picker@example.test' },
    { status: 'succeeded', error_code: null },
    { error_code: 'OPERATIONS_ORDER_VERSION_CONFLICT' },
  ]
  for (const variant of variants) {
    reset()
    database.addAcknowledgedWearableScanEvidence()
    database.addBlockedConfirmation(variant)
    await assert.rejects(
      requestOperationsPickHandoffFromPostgres({
        ...baseInput,
        blockedConfirmationIdempotencyKey: 'wearable-pick:blocked-0001',
      }),
      isCode('OPERATIONS_PICK_HANDOFF_CONFIRMATION_INVALID'),
    )
    assert.ok(database.tasks.every((task) => task.assigned_to !== null))
    assert.equal(database.exceptions.length, 0)
  }
})

test('blocked confirmation handoff requires exact acknowledged scan evidence', async () => {
  const variants: Array<{
    name: string
    arrange: () => void
  }> = [
    {
      name: 'missing',
      arrange() {},
    },
    {
      name: 'foreign organization',
      arrange() {
        database.addAcknowledgedWearableScanEvidence({
          evidence: { organization_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
        })
      },
    },
    {
      name: 'foreign actor',
      arrange() {
        database.addAcknowledgedWearableScanEvidence({
          receipt: { actor_email: 'other-picker@example.test' },
          evidence: { recorded_by: 'other-picker@example.test' },
        })
      },
    },
    {
      name: 'stale row version',
      arrange() {
        database.addAcknowledgedWearableScanEvidence({
          evidence: { order_row_version: 6 },
        })
      },
    },
  ]

  for (const variant of variants) {
    reset()
    database.addBlockedConfirmation()
    variant.arrange()
    await assert.rejects(
      requestOperationsPickHandoffFromPostgres({
        ...baseInput,
        blockedConfirmationIdempotencyKey: 'wearable-pick:blocked-0001',
        idempotencyKey: `picker-handoff:terminal-${variant.name.replaceAll(' ', '-')}`,
      }),
      isCode('OPERATIONS_PICK_HANDOFF_CONFIRMATION_INVALID'),
      variant.name,
    )
    assert.equal(database.order.row_version, 7, variant.name)
    assert.ok(
      database.tasks.every((task) => task.assigned_to === 'picker@example.test'),
      variant.name,
    )
    assert.equal(database.exceptions.length, 0, variant.name)
  }

  reset()
  database.addBlockedConfirmation()
  database.addAcknowledgedWearableScanEvidence()
  const result = await requestOperationsPickHandoffFromPostgres({
    ...baseInput,
    blockedConfirmationIdempotencyKey: 'wearable-pick:blocked-0001',
    idempotencyKey: 'picker-handoff:terminal-exact-evidence',
  })
  assert.equal(result.rowVersion, 8)
  assert.equal(result.blockedConfirmationIdempotencyKey, 'wearable-pick:blocked-0001')
})

test('picker handoff is additive and never composes assignment or provider actions', () => {
  const persistence = readFileSync(
    new URL('../../lib/persistence/operations.ts', import.meta.url),
    'utf8',
  )
  const handoff = persistence.slice(
    persistence.indexOf('export async function requestOperationsPickHandoffFromPostgres'),
    persistence.indexOf('type WearablePickScanContextRow'),
  )
  assert.match(handoff, /commandType: 'request_operations_pick_handoff'/)
  assert.match(handoff, /requestHash: commandRequestHash\(\{[\s\S]*?actorEmail,/)
  assert.match(handoff, /'picker_handoff_requested', 'high', 'open'/)
  assert.match(handoff, /SET assigned_to = NULL, assigned_at = NULL/)
  assert.match(handoff, /row_version = row_version \+ 1/)
  assert.match(handoff, /providerWrites: 0/)
  assert.doesNotMatch(handoff, /assignOperationsOrderPicksFromPostgres/)
  assert.doesNotMatch(handoff, /inspectShopify|executeShopify|prepareShopify/)
  assert.doesNotMatch(handoff, /executeCurrentFaire|prepareCurrentFaire/)
  assert.doesNotMatch(handoff, /SET status = 'cancelled'/)
})
