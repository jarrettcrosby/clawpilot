#!/usr/bin/env node
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const nodeRequire = createRequire(import.meta.url)
const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = requireFromApp('typescript')
const { Pool } = requireFromApp('pg')

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function loadTypeScriptModule(path, mocks = {}) {
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
    Buffer,
    console,
    Date,
    Error,
    URL,
    exports: module.exports,
    module,
    process,
    require(specifier) {
      if (Object.prototype.hasOwnProperty.call(mocks, specifier)) return mocks[specifier]
      try { return requireFromApp(specifier) } catch { return nodeRequire(specifier) }
    },
  }, { filename: path })
  return module.exports
}

const notificationSource = read('app_src/lib/persistence/posAccountingNotifications.ts')
for (const fragment of [
  'pos_accounting_issue_states',
  'pos_accounting_notification_outbox',
  'FOR UPDATE OF outbox SKIP LOCKED',
  'issueFingerprint',
  'JSON.stringify(input.issues)',
  "ON CONFLICT (issue_state_id, occurrence, recipient_email) DO NOTHING",
  "membership.organization_id = $1::uuid",
  "membership.permissions @> '{\"viewAccounting\":true,\"manageUserAccess\":true}'::jsonb",
  'email_notifications_enabled = true',
  'organization.is_demo = false',
  "recipient_email = 'demo-system@clawpilot.example'",
  "status = 'cancelled'",
  'sendPosAccountingIssueEmail',
  'reconcilePosAccountingIssueForQuickBooksRequestInPostgres',
  'pos_accounting_posting_batches',
  'batch.sales_receipt_request_id = $2::uuid',
  'batch.journal_entry_request_id = $2::uuid',
  'toast_accounting_export_drafts draft',
  'draft.updated_at > issue.last_seen_at',
]) {
  assert.ok(notificationSource.includes(fragment), `POS accounting notification adapter missing ${fragment}`)
}

const notificationDefaultsMigration = read('db/migrations/0361_pos_accounting_alerts_default_on.sql')
for (const fragment of [
  'ALTER COLUMN email_notifications_enabled SET DEFAULT true',
  'ALTER COLUMN email_notifications_enabled_at SET DEFAULT now()',
  'Do not rewrite existing false/null preferences',
]) {
  assert.ok(
    notificationDefaultsMigration.includes(fragment),
    `POS accounting notification defaults migration missing ${fragment}`,
  )
}
assert.doesNotMatch(
  notificationDefaultsMigration,
  /UPDATE\s+pos_accounting_profiles/i,
  'Default-on rollout must not silently re-enable existing profile opt-outs',
)

const notifications = loadTypeScriptModule('app_src/lib/persistence/posAccountingNotifications.ts', {
  '@/lib/auditWriter': { recordAuditEvent: async () => {} },
  '@/lib/demoMode': { DEMO_SYSTEM_EMAIL: 'demo-system@clawpilot.example' },
  '@/lib/matonMail': { sendPosAccountingIssueEmail: async () => ({ messageId: null }) },
  '@/lib/persistence/posAccounting': { readPosAccountingWorkspaceFromPostgres: async () => ({}) },
  '@/lib/persistence/postgres': {
    acquireTransactionAdvisoryLock: async () => {},
    query: async () => ({ rows: [] }),
    withTransaction: async () => { throw new Error('database access is not expected in focused issue derivation tests') },
  },
})

const workspace = {
  profile: { quickBooksBindingStatus: 'unbound', openCheckPolicy: 'hold' },
  preview: {
    available: true,
    readiness: {
      allocationComplete: false,
      openChecks: 2,
      missingMappings: [{
        sourceKind: 'sales_item',
        sourceId: 'toast-item-1',
        sourceName: 'Breakfast sandwich',
        targetType: 'item',
      }],
    },
    journal: { balanced: false, balance: -3.25 },
    salesReceipt: { unallocatedSubtotal: 12.5 },
  },
}
const issues = notifications.derivePosAccountingIssues(workspace)
assert.deepEqual(
  [...issues.map((issue) => issue.code)],
  [...issues.map((issue) => issue.code)].sort(),
  'Issue fingerprints require deterministic code ordering',
)
for (const expected of [
  'journal_unbalanced',
  'missing_mapping:sales_item:toast-item-1:item',
  'open_checks',
  'quickbooks_company_unbound',
  'sales_unallocated',
]) {
  assert.ok(issues.some((issue) => issue.code === expected), `Expected accounting blocker ${expected}`)
}
const firstFingerprint = notifications.posAccountingIssueFingerprint(issues)
const secondFingerprint = notifications.posAccountingIssueFingerprint([...issues].reverse())
assert.match(firstFingerprint, /^[0-9a-f]{64}$/)
assert.equal(firstFingerprint, secondFingerprint, 'Issue ordering must not cause duplicate notification occurrences')
assert.equal(
  firstFingerprint,
  notifications.posAccountingIssueFingerprint(issues.map((issue) => ({
    ...issue,
    title: `${issue.title} changed`,
    detail: `${issue.detail} changed`,
    action: issue.action ? `${issue.action} changed` : undefined,
  }))),
  'Display-only issue changes must not create another notification occurrence',
)
assert.notEqual(firstFingerprint, notifications.posAccountingIssueFingerprint(issues.slice(1)))
assert.equal(notifications.derivePosAccountingIssues({ ...workspace, preview: { available: false } }).length, 0)
const canonicalIssues = notifications.derivePosAccountingIssues({
  profile: { quickBooksBindingStatus: 'verified', openCheckPolicy: 'hold' },
  draft: null,
  preview: {
    available: true,
    readiness: {
      blockers: [{
        code: 'payment_exception_mapping_required',
        title: 'Map Payment Exceptions',
        detail: '2 prepaid checks require a QuickBooks Payment Exceptions account.',
        action: 'Map account',
      }],
    },
  },
})
assert.deepEqual(Array.from(canonicalIssues, (issue) => issue.code), ['payment_exception_mapping_required'])
assert.equal(canonicalIssues[0].action, 'Map account')
const failedDraftIssues = notifications.derivePosAccountingIssues({
  draft: { status: 'failed', lastError: 'QuickBooks account is inactive' },
  preview: { available: false, readiness: { blockers: [] } },
})
assert.equal(failedDraftIssues[0].code, 'provider_failure')
assert.match(failedDraftIssues[0].detail, /inactive/)
assert.equal(notifications.isDeliverablePosAccountingRecipient('owner@notifications.clawpilot.dev'), true)
for (const reserved of [
  'demo-system@clawpilot.example',
  'owner@tenant.example',
  'owner@example.com',
  'owner@example.org',
  'owner@example.net',
  'owner@tenant.invalid',
  'owner@tenant.test',
  'owner@localhost',
]) {
  assert.equal(
    notifications.isDeliverablePosAccountingRecipient(reserved),
    false,
    `${reserved} must not be treated as a deliverable accounting recipient`,
  )
}

const mailSource = read('app_src/lib/matonMail.ts')
for (const fragment of [
  'buildPosAccountingIssueEmail',
  'sendPosAccountingIssueEmail',
  "actionUrl.searchParams.set('organizationId', organizationId)",
  "actionUrl.searchParams.set('posView', 'accounting')",
  "actionUrl.searchParams.set('date', businessDate)",
  "actionUrl.searchParams.set('location', restaurantGuid)",
  'Repeated checks do not create duplicate alerts',
]) {
  assert.ok(mailSource.includes(fragment), `POS accounting email missing ${fragment}`)
}

const mail = loadTypeScriptModule('app_src/lib/matonMail.ts', {
  '@/lib/maton': {
    matonAuthMailFetch: async () => { throw new Error('Mail delivery is not expected in content tests') },
    matonPlatformMailFetch: async () => { throw new Error('Mail delivery is not expected in content tests') },
  },
  '@/lib/publicUrl': { appPublicUrl: () => 'https://clawpilot.example.test' },
  '@/lib/persistence/config': { isHostedRuntime: () => false },
})
const emailScope = {
  to: 'accounting-owner@notifications.clawpilot.dev',
  recipientName: 'Accounting Owner',
  organizationId: '11111111-1111-4111-8111-111111111111',
  organizationName: 'Test Organization',
  restaurantName: 'Downtown',
  restaurantGuid: '22222222-2222-4222-8222-222222222222',
  businessDate: '2026-09-05',
}
const mappingEmail = mail.buildPosAccountingIssueEmail({
  ...emailScope,
  issues: [{
    code: 'missing_mapping:sales_item:toast-item-1:item',
    title: 'Map Breakfast sandwich',
    detail: 'sales item needs a QuickBooks item mapping.',
    action: 'Map product',
  }],
})
assert.equal(mappingEmail.subject, 'Mapping required: Downtown accounting for 2026-09-05')
assert.match(mappingEmail.text, /^QuickBooks mapping required for Downtown/)
assert.match(mappingEmail.text, /Fix mapping: https:\/\/clawpilot\.example\.test\//)
assert.match(mappingEmail.html, /<h1[^>]*>QuickBooks mapping required<\/h1>/)
assert.match(mappingEmail.html, />Fix mapping<\/a>/)
const mappingActionUrl = new URL(mappingEmail.text.match(/Fix mapping: (https:\/\/\S+)/)?.[1] || '')
assert.equal(mappingActionUrl.searchParams.get('organizationId'), emailScope.organizationId)
assert.equal(mappingActionUrl.searchParams.get('posView'), 'accounting')
assert.equal(mappingActionUrl.searchParams.get('date'), emailScope.businessDate)
assert.equal(mappingActionUrl.searchParams.get('location'), emailScope.restaurantGuid)
assert.equal(mappingActionUrl.hash, '#pos')

const workspaceSwitcherSource = read('app_src/components/workspaces/ActiveWorkspaceSwitcher.tsx')
for (const fragment of [
  "new URLSearchParams(window.location.search).get('organizationId')",
  "body: JSON.stringify({ action: 'switch', organizationId })",
  'window.location.reload()',
]) {
  assert.ok(workspaceSwitcherSource.includes(fragment), `Accounting deep link workspace switch missing ${fragment}`)
}

const providerFailureEmail = mail.buildPosAccountingIssueEmail({
  ...emailScope,
  issues: [{
    code: 'provider_failure',
    title: 'Retry the failed accounting post',
    detail: 'QuickBooks rejected the accounting post.',
  }],
})
assert.equal(providerFailureEmail.subject, 'Action required: Downtown accounting for 2026-09-05')
assert.match(providerFailureEmail.html, /<h1[^>]*>Accounting action required<\/h1>/)
assert.match(providerFailureEmail.html, />Review POS accounting<\/a>/)

const quickBooksWorkerSource = read('app_src/lib/quickBooksWriteWorker.ts')
for (const fragment of [
  'reconcilePosAccountingIssueForQuickBooksRequestInPostgres',
  'accountingNotificationWarnings',
  "job.operationKind === 'sales_receipt.create' || job.operationKind === 'journal_entry.create'",
  'The QuickBooks result is already committed',
]) {
  assert.ok(quickBooksWorkerSource.includes(fragment), `QuickBooks write worker missing ${fragment}`)
}

const quickBooksWriteJobs = [
  {
    id: '33333333-3333-4333-8333-333333333333',
    organizationId: emailScope.organizationId,
    ownerEmail: emailScope.to,
    connectionId: 'connection-1',
    operationKind: 'journal_entry.create',
    requestPayload: { transactionDate: emailScope.businessDate },
    providerRequestId: 'cp-success',
    requestFingerprint: 'a'.repeat(64),
    attemptCount: 1,
    maxAttempts: 5,
    lockToken: '44444444-4444-4444-8444-444444444444',
    writeMode: 'sandbox',
  },
  {
    id: '55555555-5555-4555-8555-555555555555',
    organizationId: emailScope.organizationId,
    ownerEmail: emailScope.to,
    connectionId: 'connection-1',
    operationKind: 'journal_entry.create',
    requestPayload: { transactionDate: emailScope.businessDate },
    providerRequestId: 'cp-failure',
    requestFingerprint: 'b'.repeat(64),
    attemptCount: 1,
    maxAttempts: 5,
    lockToken: '66666666-6666-4666-8666-666666666666',
    writeMode: 'sandbox',
  },
  {
    id: '77777777-7777-4777-8777-777777777777',
    organizationId: emailScope.organizationId,
    ownerEmail: emailScope.to,
    connectionId: 'connection-1',
    operationKind: 'customer.create',
    requestPayload: { displayName: 'Not a POS posting' },
    providerRequestId: 'cp-customer-success',
    requestFingerprint: 'e'.repeat(64),
    attemptCount: 1,
    maxAttempts: 5,
    lockToken: '88888888-8888-4888-8888-888888888888',
    writeMode: 'sandbox',
  },
]
const completedQuickBooksJobs = []
const failedQuickBooksJobs = []
const reconciledQuickBooksRequests = []
const quickBooksWorker = loadTypeScriptModule('app_src/lib/quickBooksWriteWorker.ts', {
  '@/lib/integrations/quickBooksClient': {
    QuickBooksProviderWriteError: class extends Error {},
    createQuickBooksEntity: async (input) => {
      if (input.providerRequestId === 'cp-failure') throw new Error('QuickBooks provider failure')
      return { entityType: 'JournalEntry', entityId: 'qb-journal-1', syncToken: '0' }
    },
  },
  '@/lib/persistence/quickBooksWrites': {
    claimQuickBooksWriteJobsInPostgres: async () => quickBooksWriteJobs,
    completeQuickBooksWriteJobInPostgres: async ({ job }) => { completedQuickBooksJobs.push(job.id) },
    failQuickBooksWriteJobInPostgres: async ({ job }) => { failedQuickBooksJobs.push(job.id); return false },
  },
  '@/lib/persistence/quickBooksIntegrations': { queueQuickBooksCatalogSyncInPostgres: async () => undefined },
  '@/lib/persistence/posAccountingNotifications': {
    reconcilePosAccountingIssueForQuickBooksRequestInPostgres: async (input) => {
      reconciledQuickBooksRequests.push(input)
      if (input.requestId === quickBooksWriteJobs[0].id) throw new Error('Temporary alert reconciliation failure')
      return { status: 'open' }
    },
  },
  '@/lib/quickBooksWritePolicy': {
    configuredQuickBooksWritePolicy: () => ({
      enabled: true,
      mode: 'sandbox',
      allowedOperations: ['journal_entry.create', 'customer.create'],
    }),
  },
})
const quickBooksWorkerResult = await quickBooksWorker.processQuickBooksWriteOutbox({ workerId: 'notification-test' })
assert.equal(quickBooksWorkerResult.succeeded, 2)
assert.equal(quickBooksWorkerResult.failed, 1)
assert.equal(quickBooksWorkerResult.dead, 0)
assert.equal(quickBooksWorkerResult.accountingNotificationWarnings, 1)
assert.deepEqual(completedQuickBooksJobs, [quickBooksWriteJobs[0].id, quickBooksWriteJobs[2].id])
assert.deepEqual(failedQuickBooksJobs, [quickBooksWriteJobs[1].id])
assert.deepEqual(
  reconciledQuickBooksRequests.map((input) => `${input.organizationId}:${input.requestId}`),
  quickBooksWriteJobs.slice(0, 2).map((job) => `${job.organizationId}:${job.id}`),
)

function command(commandName, args, options = {}) {
  const result = spawnSync(commandName, args, {
    cwd: root,
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
    timeout: options.timeout || 120_000,
  })
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    throw new Error(`${commandName} ${args.join(' ')} failed${detail ? `:\n${detail}` : ''}`)
  }
  return String(result.stdout || '').trim()
}

async function waitForPostgres(pool) {
  const deadline = Date.now() + 45_000
  let lastError
  while (Date.now() < deadline) {
    try {
      await pool.query('SELECT 1')
      return
    } catch (error) {
      lastError = error
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500))
    }
  }
  throw lastError || new Error('PostgreSQL did not become ready')
}

async function runPostgresNotificationAcceptance() {
  const dockerInfo = spawnSync('docker', ['info'], { cwd: root, encoding: 'utf8', timeout: 30_000 })
  if (dockerInfo.status !== 0) {
    console.log('POS accounting notification PostgreSQL acceptance skipped: Docker is unavailable')
    return
  }
  const container = `clawpilot-pos-notifications-${process.pid}-${crypto.randomBytes(3).toString('hex')}`
  const organizationId = crypto.randomUUID()
  const restaurantGuid = crypto.randomUUID()
  const actorEmail = 'accounting-owner@notifications.clawpilot.dev'
  const reservedOwnerEmail = 'reserved-owner@tenant.example'
  let pool
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=clawpilot_notifications',
      '-e', 'POSTGRES_DB=clawpilot_notifications',
      '-p', '127.0.0.1::5432',
      'pgvector/pgvector:pg16',
    ], { timeout: 180_000 })
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const postgresPort = Number(portOutput.match(/:(\d+)\s*$/)?.[1])
    assert.ok(postgresPort > 0, `Unable to resolve disposable PostgreSQL port from ${portOutput}`)
    const databaseUrl = `postgresql://postgres:clawpilot_notifications@127.0.0.1:${postgresPort}/clawpilot_notifications`
    pool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 2000 })
    await waitForPostgres(pool)
    command('node', ['scripts/db-migrate.mjs'], {
      env: { DATABASE_URL: databaseUrl, PGSSLMODE: 'disable' },
      timeout: 180_000,
    })

    const permissions = {
      manageUserAccess: true,
      viewAccounting: true,
    }
    await pool.query(
      `INSERT INTO app_users (email, role, status, display_name, permissions)
       VALUES ($1, 'owner', 'active', 'Accounting Owner', $2::jsonb)`,
      [actorEmail, JSON.stringify(permissions)],
    )
    await pool.query(
      `INSERT INTO app_users (email, role, status, display_name, permissions)
       VALUES ($1, 'owner', 'active', 'Reserved Owner', $2::jsonb)
       ON CONFLICT (email) DO UPDATE SET status = 'active'`,
      [reservedOwnerEmail, JSON.stringify(permissions)],
    )
    await pool.query(
      `INSERT INTO workspace_organizations (id, name, organization_type, created_by)
       VALUES ($1::uuid, 'POS Notification Acceptance', 'root', $2)`,
      [organizationId, actorEmail],
    )
    await pool.query(
      `UPDATE app_users SET organization_id = $2::uuid, organization_name = 'POS Notification Acceptance'
       WHERE email = $1`,
      [actorEmail, organizationId],
    )
    await pool.query(
      `INSERT INTO app_user_organization_memberships (
         user_email, organization_id, role, permissions, status, is_default, created_by, updated_by
       ) VALUES ($1, $2::uuid, 'owner', $3::jsonb, 'active', true, $1, $1)`,
      [actorEmail, organizationId, JSON.stringify(permissions)],
    )
    await pool.query(
      `INSERT INTO app_user_organization_memberships (
         user_email, organization_id, role, permissions, status, is_default, created_by, updated_by
       ) VALUES ($1, $2::uuid, 'owner', $3::jsonb, 'active', false, $4, $4)`,
      [reservedOwnerEmail, organizationId, JSON.stringify(permissions), actorEmail],
    )
    await pool.query(
      `INSERT INTO toast_locations (
         organization_id, restaurant_guid, restaurant_name, location_name,
         active, standard_access, selected, last_verified_at
       ) VALUES ($1::uuid, $2::uuid, 'Acceptance Restaurant', 'Downtown', true, true, true, now())`,
      [organizationId, restaurantGuid],
    )
    const legacyOptOut = await pool.query(
      `INSERT INTO pos_accounting_profiles (
         organization_id, restaurant_guid, profile_revision,
         email_notifications_enabled, email_notifications_enabled_at, created_by
       ) VALUES ($1::uuid, NULL, 1, false, NULL, $2)
       RETURNING id::text`,
      [organizationId, actorEmail],
    )
    await pool.query(notificationDefaultsMigration)
    const preservedOptOut = await pool.query(
      `SELECT email_notifications_enabled, email_notifications_enabled_at
       FROM pos_accounting_profiles
       WHERE id = $1::uuid`,
      [legacyOptOut.rows[0].id],
    )
    assert.deepEqual(preservedOptOut.rows[0], {
      email_notifications_enabled: false,
      email_notifications_enabled_at: null,
    }, 'Reapplying the default-on migration must preserve an existing opt-out')

    const defaultOnRestaurantGuid = crypto.randomUUID()
    await pool.query(
      `INSERT INTO toast_locations (
         organization_id, restaurant_guid, restaurant_name, location_name,
         active, standard_access, selected, last_verified_at
       ) VALUES ($1::uuid, $2::uuid, 'Acceptance Restaurant', 'Uptown', true, true, false, now())`,
      [organizationId, defaultOnRestaurantGuid],
    )
    const defaultOnProfile = await pool.query(
      `INSERT INTO pos_accounting_profiles (
         organization_id, restaurant_guid, profile_revision, created_by
       ) VALUES ($1::uuid, $2::uuid, 1, $3)
       RETURNING email_notifications_enabled, email_notifications_enabled_at`,
      [organizationId, defaultOnRestaurantGuid, actorEmail],
    )
    assert.equal(defaultOnProfile.rows[0].email_notifications_enabled, true)
    assert.ok(
      defaultOnProfile.rows[0].email_notifications_enabled_at instanceof Date,
      'A new profile must receive a notification start timestamp with its default-on preference',
    )

    const location = { restaurantName: 'Acceptance Restaurant', locationName: 'Downtown' }
    let databaseWorkspace = { ...workspace, location }
    const auditEvents = []
    const sentMessages = []
    const databaseNotifications = loadTypeScriptModule('app_src/lib/persistence/posAccountingNotifications.ts', {
      '@/lib/auditWriter': {
        recordAuditEvent: async (event) => { auditEvents.push(event) },
      },
      '@/lib/demoMode': { DEMO_SYSTEM_EMAIL: 'demo-system@clawpilot.example' },
      '@/lib/matonMail': {
        sendPosAccountingIssueEmail: async (message) => {
          sentMessages.push(message)
          return { messageId: `test-message-${sentMessages.length}` }
        },
      },
      '@/lib/persistence/posAccounting': {
        readPosAccountingWorkspaceFromPostgres: async () => databaseWorkspace,
      },
      '@/lib/persistence/postgres': {
        acquireTransactionAdvisoryLock: async (client, key) => {
          await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key])
        },
        query: (sql, params) => pool.query(sql, params),
        withTransaction: async (work) => {
          const client = await pool.connect()
          try {
            await client.query('BEGIN')
            const value = await work(client)
            await client.query('COMMIT')
            return value
          } catch (error) {
            await client.query('ROLLBACK')
            throw error
          } finally {
            client.release()
          }
        },
      },
    })

    const scope = { organizationId, restaurantGuid, businessDate: new Date().toISOString().slice(0, 10) }
    const first = await databaseNotifications.reconcilePosAccountingIssueForDateInPostgres(scope)
    const duplicate = await databaseNotifications.reconcilePosAccountingIssueForDateInPostgres(scope)
    assert.equal(first.status, 'open')
    assert.equal(first.changed, true)
    assert.equal(duplicate.changed, false)
    let state = await pool.query(
      `SELECT status, occurrence, notification_count FROM pos_accounting_issue_states
       WHERE organization_id = $1::uuid AND restaurant_guid = $2::uuid AND business_date = $3::date`,
      [organizationId, restaurantGuid, scope.businessDate],
    )
    assert.deepEqual(state.rows[0], { status: 'open', occurrence: 1, notification_count: 0 })
    let deliveries = await pool.query('SELECT occurrence, status FROM pos_accounting_notification_outbox ORDER BY occurrence')
    assert.deepEqual(deliveries.rows, [], 'Email delivery must remain off until an administrator opts in')
    const issueState = await pool.query(
      `SELECT id::text FROM pos_accounting_issue_states
       WHERE organization_id = $1::uuid AND restaurant_guid = $2::uuid AND business_date = $3::date`,
      [organizationId, restaurantGuid, scope.businessDate],
    )
    await assert.rejects(
      pool.query(
        `INSERT INTO pos_accounting_notification_outbox (
           issue_state_id, occurrence, recipient_email, issue_fingerprint, issues
         ) VALUES (
           $1::uuid, 1, 'demo-system@clawpilot.example',
           '0000000000000000000000000000000000000000000000000000000000000000',
           '[]'::jsonb
         )`,
        [issueState.rows[0].id],
      ),
      /pos_accounting_notification_recipient_deliverable/,
      'The database must reject a reserved recipient even when application filtering is bypassed',
    )

    await pool.query(
      `WITH closed_profile AS (
         UPDATE pos_accounting_profiles
         SET effective_to = now()
         WHERE organization_id = $1::uuid
           AND restaurant_guid IS NULL
           AND effective_to IS NULL
         RETURNING organization_id
       )
       INSERT INTO pos_accounting_profiles (
         organization_id, restaurant_guid, profile_revision,
         email_notifications_enabled, email_notifications_enabled_at, created_by
       )
       SELECT organization_id, NULL, 2, true, now(), $2
       FROM closed_profile`,
      [organizationId, actorEmail],
    )
    const enabled = await databaseNotifications.reconcilePosAccountingIssueForDateInPostgres(scope)
    assert.equal(enabled.changed, false)
    assert.equal(enabled.recipients, 1, 'Reserved owners must not enter the delivery queue')
    deliveries = await pool.query(
      'SELECT occurrence, status, recipient_email FROM pos_accounting_notification_outbox ORDER BY occurrence',
    )
    assert.deepEqual(deliveries.rows, [{
      occurrence: 1,
      status: 'pending',
      recipient_email: actorEmail,
    }])

    const delivered = await databaseNotifications.processPosAccountingNotificationOutbox({
      workerId: 'notification-acceptance',
    })
    assert.deepEqual(
      JSON.parse(JSON.stringify(delivered)),
      { claimed: 1, succeeded: 1, failed: 0, dead: 0 },
    )
    assert.equal(sentMessages.length, 1)
    assert.equal(sentMessages[0].to, actorEmail)
    assert.equal(sentMessages[0].organizationId, organizationId)
    assert.equal(sentMessages[0].restaurantGuid, restaurantGuid)
    assert.equal(sentMessages[0].businessDate, scope.businessDate)

    databaseWorkspace = {
      ...workspace,
      location,
      preview: {
        ...workspace.preview,
        journal: { ...workspace.preview.journal, balance: -9.5 },
        salesReceipt: { ...workspace.preview.salesReceipt, unallocatedSubtotal: 99 },
      },
    }
    const updatedDetails = await databaseNotifications.reconcilePosAccountingIssueForDateInPostgres(scope)
    assert.equal(updatedDetails.changed, false, 'Changing issue amounts must not reopen or renotify the issue')
    state = await pool.query(
      `SELECT status, occurrence, notification_count, issues
       FROM pos_accounting_issue_states
       WHERE organization_id = $1::uuid AND restaurant_guid = $2::uuid AND business_date = $3::date`,
      [organizationId, restaurantGuid, scope.businessDate],
    )
    assert.equal(state.rows[0].status, 'open')
    assert.equal(state.rows[0].occurrence, 1)
    assert.equal(state.rows[0].notification_count, 1)
    assert.match(
      state.rows[0].issues.find((issue) => issue.code === 'journal_unbalanced').detail,
      /9\.50/,
      'The persisted issue detail must still refresh without sending another email',
    )
    deliveries = await pool.query('SELECT occurrence, status FROM pos_accounting_notification_outbox ORDER BY occurrence')
    assert.deepEqual(deliveries.rows, [{ occurrence: 1, status: 'succeeded' }])

    databaseWorkspace = { ...workspace, location, preview: { available: false } }
    const resolved = await databaseNotifications.reconcilePosAccountingIssueForDateInPostgres(scope)
    assert.equal(resolved.status, 'resolved')
    assert.equal(resolved.changed, true)

    databaseWorkspace = { ...workspace, location }
    const reopened = await databaseNotifications.reconcilePosAccountingIssueForDateInPostgres(scope)
    assert.equal(reopened.status, 'open')
    assert.equal(reopened.occurrence, 2)
    deliveries = await pool.query('SELECT occurrence, status FROM pos_accounting_notification_outbox ORDER BY occurrence')
    assert.deepEqual(deliveries.rows, [
      { occurrence: 1, status: 'succeeded' },
      { occurrence: 2, status: 'pending' },
    ])
    state = await pool.query('SELECT status, occurrence, notification_count FROM pos_accounting_issue_states')
    assert.deepEqual(state.rows[0], { status: 'open', occurrence: 2, notification_count: 1 })

    databaseWorkspace = { ...workspace, location, preview: { available: false } }
    const resolvedBeforeDraftUpdate = await databaseNotifications.reconcilePosAccountingIssueForDateInPostgres(scope)
    assert.equal(resolvedBeforeDraftUpdate.status, 'resolved')
    await pool.query(
      `UPDATE pos_accounting_issue_states
       SET last_seen_at = now() - interval '1 hour'
       WHERE organization_id = $1::uuid AND restaurant_guid = $2::uuid AND business_date = $3::date`,
      [organizationId, restaurantGuid, scope.businessDate],
    )
    const staleDraft = await pool.query(
      `INSERT INTO toast_accounting_export_drafts (
         organization_id, restaurant_guid, business_date, idempotency_key,
         status, reconciliation_status, updated_at
       ) VALUES ($1::uuid, $2::uuid, $3::date, $4, 'failed', 'ready', now())
       RETURNING id::text`,
      [organizationId, restaurantGuid, scope.businessDate, `notification-stale-draft:${organizationId}:${scope.businessDate}`],
    )
    databaseWorkspace = {
      ...workspace,
      location,
      draft: { status: 'failed', lastError: 'QuickBooks account is inactive' },
      preview: { available: false, readiness: { blockers: [] } },
    }
    const staleDraftReconciliation = await databaseNotifications.reconcileStaleOpenPosAccountingIssuesInPostgres({ limit: 4 })
    assert.deepEqual(
      JSON.parse(JSON.stringify(staleDraftReconciliation)),
      { checked: 1, reconciled: 1, failed: 0 },
    )
    state = await pool.query('SELECT status, occurrence, notification_count FROM pos_accounting_issue_states')
    assert.deepEqual(state.rows[0], { status: 'open', occurrence: 3, notification_count: 1 })

    const postingRequestId = crypto.randomUUID()
    await pool.query(
      `INSERT INTO quickbooks_write_requests (
         id, organization_id, operation_kind, status, client_request_id,
         provider_request_id, request_payload, request_fingerprint,
         requested_by, reviewed_maton_connection_id
       ) VALUES (
         $1::uuid, $2::uuid, 'journal_entry.create', 'failed', $3::uuid,
         $4, '{}'::jsonb, $5, $6, 'notification-test-connection'
       )`,
      [postingRequestId, organizationId, crypto.randomUUID(), `notification-${postingRequestId}`, 'c'.repeat(64), actorEmail],
    )
    await pool.query(
      `INSERT INTO pos_accounting_posting_batches (
         organization_id, draft_id, restaurant_guid, business_date, status,
         request_fingerprint, journal_entry_request_id, requested_by
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, 'failed', $5, $6::uuid, $7)`,
      [organizationId, staleDraft.rows[0].id, restaurantGuid, scope.businessDate, 'd'.repeat(64), postingRequestId, actorEmail],
    )
    const requestReconciliation = await databaseNotifications.reconcilePosAccountingIssueForQuickBooksRequestInPostgres({
      organizationId,
      requestId: postingRequestId,
    })
    assert.equal(requestReconciliation.status, 'open')
    assert.equal(requestReconciliation.changed, false)
    assert.deepEqual(auditEvents.map((event) => event.eventType), [
      'pos.accounting.issue.opened',
      'pos.accounting.issue.resolved',
      'pos.accounting.issue.opened',
      'pos.accounting.issue.resolved',
      'pos.accounting.issue.opened',
    ])
    console.log('POS accounting notification disposable PostgreSQL acceptance passed')
  } finally {
    await pool?.end().catch(() => undefined)
    spawnSync('docker', ['rm', '-f', container], { cwd: root, encoding: 'utf8', timeout: 30_000 })
  }
}

await runPostgresNotificationAcceptance()

console.log('PASS test-pos-accounting-notifications')
