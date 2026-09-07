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
  'ON CONFLICT (issue_state_id, recipient_email) DO UPDATE SET',
  "WHERE pos_accounting_notification_outbox.status IN ('pending', 'cancelled')",
  "membership.organization_id = $1::uuid",
  "membership.permissions @> '{\"viewAccounting\":true,\"manageUserAccess\":true}'::jsonb",
  'email_notifications_enabled = true',
  'organization.is_demo = false',
  "recipient_email = 'demo-system@clawpilot.example'",
  "status = 'cancelled'",
  'sendPosAccountingIssueEmail',
  'reconcilePosAccountingIssueForQuickBooksRequestInPostgres',
  'reconcileOpenPosAccountingIssuesForMappedItemInPostgres',
  'pos_accounting_posting_batches',
  'LEFT JOIN pos_accounting_posting_batches batch',
  'FOR SHARE OF draft',
  'batch.sales_receipt_request_id = $2::uuid',
  'batch.journal_entry_request_id = $2::uuid',
  'toast_accounting_export_drafts draft',
  'draft.updated_at > issue.last_seen_at',
  'delivery_reserved_at = now()',
  "WHERE outbox.status = 'pending'",
  "status = 'dead'",
  'deliverClaimedPosAccountingNotificationInPostgres',
  "COALESCE(receipt.status, '') NOT IN ('succeeded', 'dead', 'cancelled')",
  "COALESCE(journal.status, '') NOT IN ('succeeded', 'dead', 'cancelled')",
]) {
  assert.ok(notificationSource.includes(fragment), `POS accounting notification adapter missing ${fragment}`)
}
assert.doesNotMatch(notificationSource, /MAX_DELIVERY_ATTEMPTS/)
assert.doesNotMatch(notificationSource, /status\s+IN\s*\('pending',\s*'failed'\)/)

const dailyAlertFenceMigration = read('db/migrations/0363_pos_accounting_daily_alert_delivery_fence.sql')
for (const fragment of [
  'ADD COLUMN IF NOT EXISTS delivery_reserved_at timestamptz',
  'UNIQUE (issue_state_id, recipient_email)',
  'pos_accounting_notification_single_attempt_valid',
  'preserve_pos_accounting_daily_issue_occurrence',
  'protect_pos_accounting_notification_delivery_fence',
  'BEFORE INSERT OR UPDATE ON pos_accounting_notification_outbox',
  'A newer accounting issue occurrence replaced this delivery',
  "status IN ('pending', 'cancelled')",
  "status IN ('processing', 'succeeded', 'dead', 'suppressed')",
  "status IN ('pending', 'processing', 'failed', 'succeeded', 'dead', 'cancelled', 'suppressed')",
]) {
  assert.ok(
    dailyAlertFenceMigration.includes(fragment),
    `POS accounting daily alert fence migration missing ${fragment}`,
  )
}
assert.doesNotMatch(dailyAlertFenceMigration, /CHECK\s*\(occurrence\s*=\s*1\)/)

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
  'ClawPilot sends at most one alert per location and business date',
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
  'reconcileOpenPosAccountingIssuesForMappedItemInPostgres',
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
  {
    id: '99999999-9999-4999-8999-999999999999',
    organizationId: emailScope.organizationId,
    ownerEmail: emailScope.to,
    connectionId: 'connection-1',
    operationKind: 'item.create',
    requestPayload: { name: 'Mapped item' },
    providerRequestId: 'cp-item-success',
    requestFingerprint: 'f'.repeat(64),
    attemptCount: 1,
    maxAttempts: 5,
    lockToken: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    writeMode: 'sandbox',
  },
]
const completedQuickBooksJobs = []
const failedQuickBooksJobs = []
const reconciledQuickBooksRequests = []
const reconciledMappedItems = []
const quickBooksWorker = loadTypeScriptModule('app_src/lib/quickBooksWriteWorker.ts', {
  '@/lib/integrations/quickBooksClient': {
    QuickBooksProviderWriteError: class extends Error {},
    createQuickBooksEntity: async (input) => {
      if (input.providerRequestId === 'cp-failure') throw new Error('QuickBooks provider failure')
      return { entityType: 'JournalEntry', entityId: 'qb-journal-1', syncToken: '0' }
    },
  },
  '@/lib/persistence/quickBooksWrites': {
    QuickBooksWriteRequestError: class extends Error {},
    claimQuickBooksWriteJobsInPostgres: async () => quickBooksWriteJobs,
    completeQuickBooksWriteJobInPostgres: async ({ job }) => {
      completedQuickBooksJobs.push(job.id)
      return {
        posAccountingMapping: job.operationKind === 'item.create'
          ? {
              active: true,
              sourceRestaurantGuid: emailScope.restaurantGuid,
              mappingScope: 'organization_default',
            }
          : null,
      }
    },
    failQuickBooksWriteJobInPostgres: async ({ job }) => { failedQuickBooksJobs.push(job.id); return false },
    validateQuickBooksWriteJobBeforeProviderInPostgres: async () => ({ posAccountingSource: null }),
  },
  '@/lib/persistence/quickBooksIntegrations': { queueQuickBooksCatalogSyncInPostgres: async () => undefined },
  '@/lib/persistence/posAccountingNotifications': {
    reconcileOpenPosAccountingIssuesForMappedItemInPostgres: async (input) => {
      reconciledMappedItems.push(input)
      return { checked: 2, reconciled: 1, failed: 1 }
    },
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
      allowedOperations: ['journal_entry.create', 'customer.create', 'item.create'],
    }),
  },
})
const quickBooksWorkerResult = await quickBooksWorker.processQuickBooksWriteOutbox({ workerId: 'notification-test' })
assert.equal(quickBooksWorkerResult.succeeded, 3)
assert.equal(quickBooksWorkerResult.failed, 1)
assert.equal(quickBooksWorkerResult.dead, 0)
assert.equal(quickBooksWorkerResult.accountingNotificationWarnings, 2)
assert.deepEqual(completedQuickBooksJobs, [quickBooksWriteJobs[0].id, quickBooksWriteJobs[2].id, quickBooksWriteJobs[3].id])
assert.deepEqual(failedQuickBooksJobs, [quickBooksWriteJobs[1].id])
assert.deepEqual(
  reconciledQuickBooksRequests.map((input) => `${input.organizationId}:${input.requestId}`),
  quickBooksWriteJobs.slice(0, 2).map((job) => `${job.organizationId}:${job.id}`),
)
assert.deepEqual(JSON.parse(JSON.stringify(reconciledMappedItems)), [{
  organizationId: emailScope.organizationId,
  restaurantGuid: emailScope.restaurantGuid,
  mappingScope: 'organization_default',
}])

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
    let forcedWorkspaceFailureDate = null
    const auditEvents = []
    const sentMessages = []
    let failNextMailAfterAccept = false
    let mailDeliveryPause = null
    const transactionClientsWithAdvisoryLock = new WeakSet()
    const databaseNotifications = loadTypeScriptModule('app_src/lib/persistence/posAccountingNotifications.ts', {
      '@/lib/auditWriter': {
        recordAuditEvent: async (event) => { auditEvents.push(event) },
      },
      '@/lib/demoMode': { DEMO_SYSTEM_EMAIL: 'demo-system@clawpilot.example' },
      '@/lib/matonMail': {
        sendPosAccountingIssueEmail: async (message) => {
          if (mailDeliveryPause) {
            const pause = mailDeliveryPause
            mailDeliveryPause = null
            pause.entered()
            await pause.release
          }
          sentMessages.push(message)
          if (failNextMailAfterAccept) {
            failNextMailAfterAccept = false
            throw new Error('Provider acknowledgement was lost after accepting the message')
          }
          return { messageId: `test-message-${sentMessages.length}` }
        },
      },
      '@/lib/persistence/posAccounting': {
        readPosAccountingWorkspaceFromPostgres: async (input) => {
          assert.ok(
            input.client && transactionClientsWithAdvisoryLock.has(input.client),
            'The workspace must be read with the same transaction client after its advisory lock is acquired',
          )
          if (input.businessDate === forcedWorkspaceFailureDate) {
            throw new Error('Forced mapped-item reconciliation failure')
          }
          return databaseWorkspace
        },
      },
      '@/lib/persistence/postgres': {
        acquireTransactionAdvisoryLock: async (client, key) => {
          await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key])
          transactionClientsWithAdvisoryLock.add(client)
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
    await assert.rejects(
      pool.query(
        `INSERT INTO pos_accounting_notification_outbox (
           issue_state_id, occurrence, recipient_email, issue_fingerprint, issues
         ) VALUES ($1::uuid, 2, $2, $3, '[]'::jsonb)`,
        [issueState.rows[0].id, actorEmail, '4'.repeat(64)],
      ),
      /pos_accounting_notification_(?:daily_)?delivery_unique/,
      'A different occurrence cannot create a second daily delivery slot for the same recipient',
    )
    const secondRecipient = 'accounting-admin@notifications.clawpilot.dev'
    const legacySuccessRecipient = 'accounting-success@notifications.clawpilot.dev'
    await pool.query(
      `INSERT INTO pos_accounting_notification_outbox (
         issue_state_id, occurrence, recipient_email, issue_fingerprint, issues
       ) VALUES
         ($1::uuid, 1, $2, $4, '[]'::jsonb),
         ($1::uuid, 1, $3, $5, '[]'::jsonb)`,
      [
        issueState.rows[0].id,
        secondRecipient,
        legacySuccessRecipient,
        '5'.repeat(64),
        '6'.repeat(64),
      ],
    )
    const recipientSlots = await pool.query(
      `SELECT recipient_email
       FROM pos_accounting_notification_outbox
       WHERE issue_state_id = $1::uuid
       ORDER BY recipient_email`,
      [issueState.rows[0].id],
    )
    assert.deepEqual(
      recipientSlots.rows.map((row) => row.recipient_email),
      [secondRecipient, legacySuccessRecipient, actorEmail].sort(),
      'Each authorized recipient may have one independent daily delivery slot',
    )
    const deliveryConstraints = await pool.query(
      `SELECT conname
       FROM pg_constraint
       WHERE conrelid = 'pos_accounting_notification_outbox'::regclass
         AND conname IN (
           'pos_accounting_notification_delivery_unique',
           'pos_accounting_notification_daily_delivery_unique'
         )
       ORDER BY conname`,
    )
    assert.deepEqual(
      deliveryConstraints.rows.map((row) => row.conname),
      [
        'pos_accounting_notification_daily_delivery_unique',
        'pos_accounting_notification_delivery_unique',
      ],
      'The old and new delivery constraints must coexist during a rolling deployment',
    )
    const legacyFailureToken = crypto.randomUUID()
    const legacyFailureClaim = await pool.query(
      `UPDATE pos_accounting_notification_outbox SET
         status = 'processing', attempt_count = attempt_count + 1,
         locked_at = now(), locked_by = 'legacy-worker', lock_token = $3::uuid,
         updated_at = now()
       WHERE issue_state_id = $1::uuid AND recipient_email = $2
       RETURNING status, attempt_count, delivery_reserved_at IS NOT NULL AS reserved`,
      [issueState.rows[0].id, secondRecipient, legacyFailureToken],
    )
    assert.deepEqual(
      legacyFailureClaim.rows[0],
      { status: 'processing', attempt_count: 1, reserved: true },
      'A rolling legacy claim must be translated into the irreversible daily delivery reservation',
    )
    const legacyFailure = await pool.query(
      `UPDATE pos_accounting_notification_outbox SET
         status = 'failed', available_at = now() + interval '1 minute',
         locked_at = NULL, locked_by = NULL, lock_token = NULL,
         last_error = 'Legacy provider failure', updated_at = now()
       WHERE issue_state_id = $1::uuid AND recipient_email = $2
       RETURNING status, attempt_count, delivery_reserved_at IS NOT NULL AS reserved`,
      [issueState.rows[0].id, secondRecipient],
    )
    assert.deepEqual(
      legacyFailure.rows[0],
      { status: 'dead', attempt_count: 1, reserved: true },
      'A legacy retry request must be terminalized instead of reopening the daily delivery slot',
    )
    const legacySuccessToken = crypto.randomUUID()
    await pool.query(
      `UPDATE pos_accounting_notification_outbox SET
         status = 'processing', attempt_count = attempt_count + 1,
         locked_at = now(), locked_by = 'legacy-worker', lock_token = $3::uuid,
         updated_at = now()
       WHERE issue_state_id = $1::uuid AND recipient_email = $2`,
      [issueState.rows[0].id, legacySuccessRecipient, legacySuccessToken],
    )
    const legacySuccess = await pool.query(
      `UPDATE pos_accounting_notification_outbox SET
         status = 'succeeded', sent_at = now(), provider_message_id = 'legacy-message',
         locked_at = NULL, locked_by = NULL, lock_token = NULL, updated_at = now()
       WHERE issue_state_id = $1::uuid AND recipient_email = $2
       RETURNING status, attempt_count, delivery_reserved_at IS NOT NULL AS reserved`,
      [issueState.rows[0].id, legacySuccessRecipient],
    )
    assert.deepEqual(
      legacySuccess.rows[0],
      { status: 'succeeded', attempt_count: 1, reserved: true },
      'A legacy completion must remain a valid terminal success',
    )
    await assert.rejects(
      pool.query(
        `UPDATE pos_accounting_notification_outbox SET
           status = 'processing', locked_at = now(), locked_by = 'legacy-worker',
           lock_token = gen_random_uuid(), updated_at = now()
         WHERE issue_state_id = $1::uuid AND recipient_email = $2`,
        [issueState.rows[0].id, legacySuccessRecipient],
      ),
      /terminal POS accounting notification delivery is immutable/,
      'A terminal daily delivery must not be reclaimable by a rolling worker',
    )
    await pool.query(
      `DELETE FROM pos_accounting_notification_outbox
       WHERE issue_state_id = $1::uuid AND recipient_email = ANY($2::text[])`,
      [issueState.rows[0].id, [secondRecipient, legacySuccessRecipient]],
    )

    const beforeLegacyReconcile = await pool.query(
      'SELECT issues FROM pos_accounting_issue_states WHERE id = $1::uuid',
      [issueState.rows[0].id],
    )
    const legacyReconcileIssues = [
      ...beforeLegacyReconcile.rows[0].issues,
      {
        code: 'rolling_replica_detail_change',
        title: 'Rolling replica changed this date',
        detail: 'Compatibility coverage for the previous production reconciler.',
      },
    ]
    const legacyReconcileFingerprint = databaseNotifications.posAccountingIssueFingerprint(
      legacyReconcileIssues,
    )
    const legacyStateUpdate = await pool.query(
      `INSERT INTO pos_accounting_issue_states (
         organization_id, restaurant_guid, business_date, status, issue_fingerprint,
         issues, occurrence, opened_at, last_seen_at, resolved_at, created_at, updated_at
       ) VALUES ($1::uuid, $2::uuid, $3::date, 'open', $4, $5::jsonb, 2,
         now(), now(), NULL, now(), now())
       ON CONFLICT (organization_id, restaurant_guid, business_date) DO UPDATE SET
         status = 'open', issue_fingerprint = EXCLUDED.issue_fingerprint,
         issues = EXCLUDED.issues, occurrence = EXCLUDED.occurrence,
         opened_at = now(), last_seen_at = now(), resolved_at = NULL, updated_at = now()
       RETURNING id::text, occurrence`,
      [
        organizationId,
        restaurantGuid,
        scope.businessDate,
        legacyReconcileFingerprint,
        JSON.stringify(legacyReconcileIssues),
      ],
    )
    assert.equal(
      legacyStateUpdate.rows[0].occurrence,
      1,
      'The previous production reconciler must not increment the daily occurrence during rollout',
    )
    await pool.query(
      `UPDATE pos_accounting_notification_outbox SET
         status = 'cancelled',
         last_error = 'A newer accounting issue occurrence replaced this delivery',
         updated_at = now()
       WHERE issue_state_id = $1::uuid AND occurrence <> 2
         AND status IN ('pending', 'failed')`,
      [issueState.rows[0].id],
    )
    await pool.query(
      `INSERT INTO pos_accounting_notification_outbox (
         issue_state_id, occurrence, issue_fingerprint, issues, recipient_email,
         status, available_at, created_at, updated_at
       ) VALUES ($1::uuid, 2, $2, $3::jsonb, $4, 'pending', now(), now(), now())
       ON CONFLICT (issue_state_id, occurrence, recipient_email) DO NOTHING`,
      [issueState.rows[0].id, legacyReconcileFingerprint, JSON.stringify(legacyReconcileIssues), actorEmail],
    )
    const afterLegacyReconcile = await pool.query(
      `SELECT issue.occurrence AS issue_occurrence,
         count(outbox.id)::integer AS slot_count,
         min(outbox.occurrence) AS outbox_occurrence,
         min(outbox.status) AS outbox_status,
         bool_and(outbox.issues = $2::jsonb) AS details_refreshed
       FROM pos_accounting_issue_states issue
       JOIN pos_accounting_notification_outbox outbox ON outbox.issue_state_id = issue.id
       WHERE issue.id = $1::uuid
       GROUP BY issue.occurrence`,
      [issueState.rows[0].id, JSON.stringify(legacyReconcileIssues)],
    )
    assert.deepEqual(
      afterLegacyReconcile.rows[0],
      {
        issue_occurrence: 1,
        slot_count: 1,
        outbox_occurrence: 1,
        outbox_status: 'pending',
        details_refreshed: true,
      },
      'The exact old reconcile sequence must refresh one pending daily slot without a unique violation',
    )

    databaseWorkspace = {
      ...workspace,
      location,
      preview: {
        ...workspace.preview,
        journal: { ...workspace.preview.journal, balance: -9.5 },
        salesReceipt: { ...workspace.preview.salesReceipt, unallocatedSubtotal: 99 },
      },
    }
    const pendingDetailRefresh = await databaseNotifications.reconcilePosAccountingIssueForDateInPostgres(scope)
    assert.equal(pendingDetailRefresh.changed, false)
    const pendingDelivery = await pool.query(
      `SELECT status, occurrence, issues
       FROM pos_accounting_notification_outbox
       WHERE issue_state_id = $1::uuid`,
      [issueState.rows[0].id],
    )
    assert.equal(pendingDelivery.rows[0].status, 'pending')
    assert.equal(pendingDelivery.rows[0].occurrence, 1)
    assert.match(
      pendingDelivery.rows[0].issues.find((issue) => issue.code === 'journal_unbalanced').detail,
      /9\.50/,
      'A pending notification must refresh its issue details without creating a new occurrence',
    )

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
    assert.match(
      sentMessages[0].issues.find((issue) => issue.code === 'journal_unbalanced').detail,
      /9\.50/,
      'The delivered email must use the latest same-occurrence issue details',
    )
    await assert.rejects(
      pool.query(
        `UPDATE pos_accounting_notification_outbox SET
           status = 'pending', attempt_count = 0, delivery_reserved_at = NULL,
           sent_at = NULL, provider_message_id = NULL
         WHERE issue_state_id = $1::uuid AND recipient_email = $2`,
        [issueState.rows[0].id, actorEmail],
      ),
      /reserved POS accounting notification delivery cannot be rearmed or reassigned/,
      'A delivered daily slot must not be rearmed',
    )

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

    databaseWorkspace = {
      profile: { quickBooksBindingStatus: 'verified', openCheckPolicy: 'ignore' },
      location,
      preview: {
        available: true,
        readiness: {
          allocationComplete: true,
          openChecks: 0,
          missingMappings: [{
            sourceKind: 'sales_item',
            sourceId: 'toast-item-1',
            sourceName: 'Breakfast sandwich',
            targetType: 'item',
          }],
        },
        journal: { balanced: true, balance: 0 },
        salesReceipt: { unallocatedSubtotal: 0 },
      },
    }
    const shrunkIssueSet = await databaseNotifications.reconcilePosAccountingIssueForDateInPostgres(scope)
    assert.equal(shrunkIssueSet.changed, false, 'Removing same-day blockers must not create another alert occurrence')
    assert.equal(shrunkIssueSet.issueCount, 1)
    assert.equal(sentMessages.length, 1)
    deliveries = await pool.query('SELECT occurrence, status FROM pos_accounting_notification_outbox ORDER BY occurrence')
    assert.deepEqual(deliveries.rows, [{ occurrence: 1, status: 'succeeded' }])

    databaseWorkspace = { ...workspace, location, preview: { available: false } }
    const resolved = await databaseNotifications.reconcilePosAccountingIssueForDateInPostgres(scope)
    assert.equal(resolved.status, 'resolved')
    assert.equal(resolved.changed, true)

    databaseWorkspace = { ...workspace, location }
    const reopened = await databaseNotifications.reconcilePosAccountingIssueForDateInPostgres(scope)
    assert.equal(reopened.status, 'open')
    assert.equal(reopened.occurrence, 1)
    deliveries = await pool.query('SELECT occurrence, status FROM pos_accounting_notification_outbox ORDER BY occurrence')
    assert.deepEqual(deliveries.rows, [{ occurrence: 1, status: 'succeeded' }])
    state = await pool.query('SELECT status, occurrence, notification_count FROM pos_accounting_issue_states')
    assert.deepEqual(state.rows[0], { status: 'open', occurrence: 1, notification_count: 1 })

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
    forcedWorkspaceFailureDate = scope.businessDate
    const failedStaleDraftReconciliation = await databaseNotifications.reconcileStaleOpenPosAccountingIssuesInPostgres({ limit: 4 })
    assert.deepEqual(
      JSON.parse(JSON.stringify(failedStaleDraftReconciliation)),
      { checked: 1, reconciled: 0, failed: 1 },
      'A transient read failure must be persisted for retry instead of losing the newer draft candidate',
    )
    state = await pool.query('SELECT status, occurrence, notification_count, issues FROM pos_accounting_issue_states')
    assert.equal(state.rows[0].status, 'open')
    assert.equal(state.rows[0].occurrence, 1)
    assert.equal(state.rows[0].notification_count, 1)
    assert.equal(state.rows[0].issues[0].code, 'reconciliation_failed')
    forcedWorkspaceFailureDate = null
    await pool.query(
      `UPDATE pos_accounting_issue_states
       SET last_seen_at = now() - interval '1 hour'
       WHERE organization_id = $1::uuid AND restaurant_guid = $2::uuid AND business_date = $3::date`,
      [organizationId, restaurantGuid, scope.businessDate],
    )
    const staleDraftReconciliation = await databaseNotifications.reconcileStaleOpenPosAccountingIssuesInPostgres({ limit: 4 })
    assert.deepEqual(
      JSON.parse(JSON.stringify(staleDraftReconciliation)),
      { checked: 1, reconciled: 1, failed: 0 },
    )
    state = await pool.query('SELECT status, occurrence, notification_count FROM pos_accounting_issue_states')
    assert.deepEqual(state.rows[0], { status: 'open', occurrence: 1, notification_count: 1 })

    const postingRequestId = crypto.randomUUID()
    await pool.query(
      `INSERT INTO quickbooks_write_requests (
         id, organization_id, operation_kind, status, client_request_id,
         provider_request_id, request_payload, request_fingerprint,
         requested_by, reviewed_maton_connection_id
       ) VALUES (
         $1::uuid, $2::uuid, 'journal_entry.create', 'dead', $3::uuid,
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
    assert.equal(requestReconciliation.changed, true)
    state = await pool.query('SELECT issues FROM pos_accounting_issue_states WHERE id = $1::uuid', [issueState.rows[0].id])
    assert.deepEqual(
      state.rows[0].issues.map((issue) => issue.code),
      ['journal_entry_provider_failure'],
      'A journal-only terminal failure must identify the failed accounting document',
    )
    assert.equal(sentMessages.length, 1, 'A later same-day posting failure must not send a second email')
    assert.deepEqual(auditEvents.map((event) => event.eventType), [
      'pos.accounting.issue.opened',
      'pos.accounting.issue.resolved',
      'pos.accounting.issue.opened',
      'pos.accounting.issue.resolved',
      'pos.accounting.issue.opened',
      'pos.accounting.issue.opened',
    ])

    const batchRestaurantGuid = crypto.randomUUID()
    await pool.query(
      `INSERT INTO toast_locations (
         organization_id, restaurant_guid, restaurant_name, location_name,
         active, standard_access, selected, last_verified_at
       ) VALUES ($1::uuid, $2::uuid, 'Acceptance Restaurant', 'Combined Failure', true, true, false, now())`,
      [organizationId, batchRestaurantGuid],
    )
    const batchDraft = await pool.query(
      `INSERT INTO toast_accounting_export_drafts (
         organization_id, restaurant_guid, business_date, idempotency_key,
         status, reconciliation_status, last_error, updated_at
       ) VALUES ($1::uuid, $2::uuid, $3::date, $4, 'failed', 'ready', $5, now())
       RETURNING id::text`,
      [
        organizationId,
        batchRestaurantGuid,
        scope.businessDate,
        `notification-combined-draft:${organizationId}:${scope.businessDate}`,
        'One or more QuickBooks documents did not post.',
      ],
    )
    const receiptRequestId = crypto.randomUUID()
    const journalRequestId = crypto.randomUUID()
    await pool.query(
      `INSERT INTO quickbooks_write_requests (
         id, organization_id, operation_kind, status, client_request_id,
         provider_request_id, request_payload, request_fingerprint,
         requested_by, reviewed_maton_connection_id, last_error_message
       ) VALUES
       ($1::uuid, $3::uuid, 'sales_receipt.create', 'dead', $4::uuid,
        $6, '{}'::jsonb, $8, $10, 'notification-test-connection', 'Sales Receipt rejected'),
       ($2::uuid, $3::uuid, 'journal_entry.create', 'processing', $5::uuid,
        $7, '{}'::jsonb, $9, $10, 'notification-test-connection', NULL)`,
      [
        receiptRequestId,
        journalRequestId,
        organizationId,
        crypto.randomUUID(),
        crypto.randomUUID(),
        `batch-r-${receiptRequestId.slice(0, 32)}`,
        `batch-j-${journalRequestId.slice(0, 32)}`,
        '1'.repeat(64),
        '2'.repeat(64),
        actorEmail,
      ],
    )
    await pool.query(
      `INSERT INTO pos_accounting_posting_batches (
         organization_id, draft_id, restaurant_guid, business_date, status,
         request_fingerprint, sales_receipt_request_id, journal_entry_request_id, requested_by
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, 'posting', $5, $6::uuid, $7::uuid, $8)`,
      [
        organizationId,
        batchDraft.rows[0].id,
        batchRestaurantGuid,
        scope.businessDate,
        '3'.repeat(64),
        receiptRequestId,
        journalRequestId,
        actorEmail,
      ],
    )
    databaseWorkspace = {
      profile: { quickBooksBindingStatus: 'verified', openCheckPolicy: 'ignore' },
      location: { restaurantName: 'Acceptance Restaurant', locationName: 'Combined Failure' },
      draft: { status: 'failed', lastError: 'One or more QuickBooks documents did not post.' },
      preview: { available: false, readiness: { blockers: [] } },
    }
    const receiptFinishedFirst = await databaseNotifications.reconcilePosAccountingIssueForDateInPostgres({
      organizationId,
      restaurantGuid: batchRestaurantGuid,
      businessDate: scope.businessDate,
    })
    assert.equal(receiptFinishedFirst.status, 'resolved')
    const prematureRows = await pool.query(
      `SELECT count(*)::integer AS count
       FROM pos_accounting_notification_outbox outbox
       JOIN pos_accounting_issue_states issue ON issue.id = outbox.issue_state_id
       WHERE issue.organization_id = $1::uuid AND issue.restaurant_guid = $2::uuid`,
      [organizationId, batchRestaurantGuid],
    )
    assert.equal(prematureRows.rows[0].count, 0, 'No email may queue before both required documents settle')
    const prematureDelivery = await databaseNotifications.processPosAccountingNotificationOutbox({
      limit: 1,
      workerId: 'notification-combined-early',
    })
    assert.equal(prematureDelivery.claimed, 0)
    assert.equal(sentMessages.length, 1)

    await pool.query(
      `UPDATE quickbooks_write_requests
       SET status = 'dead', last_error_message = 'Journal Entry rejected', updated_at = now()
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [organizationId, journalRequestId],
    )
    const bothFinished = await databaseNotifications.reconcilePosAccountingIssueForDateInPostgres({
      organizationId,
      restaurantGuid: batchRestaurantGuid,
      businessDate: scope.businessDate,
    })
    assert.equal(bothFinished.status, 'open')
    assert.equal(bothFinished.issueCount, 2)
    const combinedDelivery = await databaseNotifications.processPosAccountingNotificationOutbox({
      limit: 2,
      workerId: 'notification-combined-final',
    })
    assert.deepEqual(
      JSON.parse(JSON.stringify(combinedDelivery)),
      { claimed: 1, succeeded: 1, failed: 0, dead: 0 },
    )
    assert.equal(sentMessages.length, 2)
    assert.deepEqual(
      JSON.parse(JSON.stringify(sentMessages[1].issues.map((issue) => issue.code).sort())),
      ['journal_entry_provider_failure', 'sales_receipt_provider_failure'],
      'Receipt and journal failures for one location/date must share one email',
    )
    const noSecondCombinedDelivery = await databaseNotifications.processPosAccountingNotificationOutbox({
      limit: 2,
      workerId: 'notification-combined-repeat',
    })
    assert.equal(noSecondCombinedDelivery.claimed, 0)
    assert.equal(sentMessages.length, 2)

    const ambiguousRestaurantGuid = crypto.randomUUID()
    await pool.query(
      `INSERT INTO toast_locations (
         organization_id, restaurant_guid, restaurant_name, location_name,
         active, standard_access, selected, last_verified_at
       ) VALUES ($1::uuid, $2::uuid, 'Acceptance Restaurant', 'Ambiguous Delivery', true, true, false, now())`,
      [organizationId, ambiguousRestaurantGuid],
    )
    databaseWorkspace = {
      ...workspace,
      location: { restaurantName: 'Acceptance Restaurant', locationName: 'Ambiguous Delivery' },
    }
    const ambiguousScope = {
      organizationId,
      restaurantGuid: ambiguousRestaurantGuid,
      businessDate: scope.businessDate,
    }
    await databaseNotifications.reconcilePosAccountingIssueForDateInPostgres(ambiguousScope)
    failNextMailAfterAccept = true
    const ambiguousDelivery = await databaseNotifications.processPosAccountingNotificationOutbox({
      limit: 1,
      workerId: 'notification-ambiguous',
    })
    assert.deepEqual(
      JSON.parse(JSON.stringify(ambiguousDelivery)),
      { claimed: 1, succeeded: 0, failed: 1, dead: 1 },
    )
    assert.equal(sentMessages.length, 3, 'The provider mock records the potentially accepted message')
    const ambiguousRetry = await databaseNotifications.processPosAccountingNotificationOutbox({
      limit: 1,
      workerId: 'notification-ambiguous-retry',
    })
    assert.equal(ambiguousRetry.claimed, 0, 'An ambiguous provider outcome must never be retried')
    assert.equal(sentMessages.length, 3)
    const ambiguousRow = await pool.query(
      `SELECT outbox.status, outbox.attempt_count,
         outbox.delivery_reserved_at IS NOT NULL AS reserved
       FROM pos_accounting_notification_outbox outbox
       JOIN pos_accounting_issue_states issue ON issue.id = outbox.issue_state_id
       WHERE issue.organization_id = $1::uuid AND issue.restaurant_guid = $2::uuid`,
      [organizationId, ambiguousRestaurantGuid],
    )
    assert.deepEqual(ambiguousRow.rows[0], { status: 'dead', attempt_count: 1, reserved: true })

    const staleRestaurantGuid = crypto.randomUUID()
    await pool.query(
      `INSERT INTO toast_locations (
         organization_id, restaurant_guid, restaurant_name, location_name,
         active, standard_access, selected, last_verified_at
       ) VALUES ($1::uuid, $2::uuid, 'Acceptance Restaurant', 'Stale Delivery', true, true, false, now())`,
      [organizationId, staleRestaurantGuid],
    )
    databaseWorkspace = {
      ...workspace,
      location: { restaurantName: 'Acceptance Restaurant', locationName: 'Stale Delivery' },
    }
    const staleScope = {
      organizationId,
      restaurantGuid: staleRestaurantGuid,
      businessDate: scope.businessDate,
    }
    await databaseNotifications.reconcilePosAccountingIssueForDateInPostgres(staleScope)
    const staleClaim = await databaseNotifications.claimPosAccountingNotificationsInPostgres({
      limit: 1,
      workerId: 'notification-stale-first',
    })
    assert.equal(staleClaim.length, 1)
    await pool.query(
      `UPDATE pos_accounting_notification_outbox
       SET locked_at = now() - interval '16 minutes', updated_at = now()
       WHERE id = $1::uuid`,
      [staleClaim[0].outboxId],
    )
    const staleReclaim = await databaseNotifications.claimPosAccountingNotificationsInPostgres({
      limit: 1,
      workerId: 'notification-stale-second',
    })
    assert.equal(staleReclaim.length, 0, 'An expired delivery reservation must not become retryable')
    const staleRow = await pool.query(
      'SELECT status, attempt_count FROM pos_accounting_notification_outbox WHERE id = $1::uuid',
      [staleClaim[0].outboxId],
    )
    assert.deepEqual(staleRow.rows[0], { status: 'dead', attempt_count: 1 })
    assert.equal(sentMessages.length, 3)

    const resolvedRestaurantGuid = crypto.randomUUID()
    await pool.query(
      `INSERT INTO toast_locations (
         organization_id, restaurant_guid, restaurant_name, location_name,
         active, standard_access, selected, last_verified_at
       ) VALUES ($1::uuid, $2::uuid, 'Acceptance Restaurant', 'Resolved Delivery', true, true, false, now())`,
      [organizationId, resolvedRestaurantGuid],
    )
    databaseWorkspace = {
      ...workspace,
      location: { restaurantName: 'Acceptance Restaurant', locationName: 'Resolved Delivery' },
    }
    const resolvedScope = {
      organizationId,
      restaurantGuid: resolvedRestaurantGuid,
      businessDate: scope.businessDate,
    }
    await databaseNotifications.reconcilePosAccountingIssueForDateInPostgres(resolvedScope)
    const resolvedClaim = await databaseNotifications.claimPosAccountingNotificationsInPostgres({
      limit: 1,
      workerId: 'notification-resolved-first',
    })
    assert.equal(resolvedClaim.length, 1)
    databaseWorkspace = {
      ...workspace,
      location: { restaurantName: 'Acceptance Restaurant', locationName: 'Resolved Delivery' },
      preview: { available: false },
    }
    await databaseNotifications.reconcilePosAccountingIssueForDateInPostgres(resolvedScope)
    const resolvedDelivery = await databaseNotifications.deliverClaimedPosAccountingNotificationInPostgres(
      resolvedClaim[0],
    )
    assert.deepEqual(
      JSON.parse(JSON.stringify(resolvedDelivery)),
      { status: 'suppressed', attempted: false },
      'Resolution after claim but before provider delivery must suppress the email',
    )
    assert.equal(sentMessages.length, 3)

    async function createTerminalPostingScenario(locationName) {
      const scenarioRestaurantGuid = crypto.randomUUID()
      await pool.query(
        `INSERT INTO toast_locations (
           organization_id, restaurant_guid, restaurant_name, location_name,
           active, standard_access, selected, last_verified_at
         ) VALUES ($1::uuid, $2::uuid, 'Acceptance Restaurant', $3, true, true, false, now())`,
        [organizationId, scenarioRestaurantGuid, locationName],
      )
      const scenarioDraft = await pool.query(
        `INSERT INTO toast_accounting_export_drafts (
           organization_id, restaurant_guid, business_date, idempotency_key,
           status, reconciliation_status, last_error, updated_at
         ) VALUES (
           $1::uuid, $2::uuid, $3::date, $4,
           'failed', 'ready', 'Both QuickBooks documents failed.', now()
         )
         RETURNING id::text`,
        [
          organizationId,
          scenarioRestaurantGuid,
          scope.businessDate,
          `notification-race-draft:${crypto.randomUUID()}`,
        ],
      )
      const scenarioReceiptRequestId = crypto.randomUUID()
      const scenarioJournalRequestId = crypto.randomUUID()
      await pool.query(
        `INSERT INTO quickbooks_write_requests (
           id, organization_id, operation_kind, status, client_request_id,
           provider_request_id, request_payload, request_fingerprint,
           requested_by, reviewed_maton_connection_id, last_error_message
         ) VALUES
         ($1::uuid, $3::uuid, 'sales_receipt.create', 'dead', $4::uuid,
          $6, '{}'::jsonb, $8, $10, 'notification-test-connection', 'Sales Receipt rejected'),
         ($2::uuid, $3::uuid, 'journal_entry.create', 'dead', $5::uuid,
          $7, '{}'::jsonb, $9, $10, 'notification-test-connection', 'Journal Entry rejected')`,
        [
          scenarioReceiptRequestId,
          scenarioJournalRequestId,
          organizationId,
          crypto.randomUUID(),
          crypto.randomUUID(),
          `race-r-${scenarioReceiptRequestId.slice(0, 32)}`,
          `race-j-${scenarioJournalRequestId.slice(0, 32)}`,
          crypto.randomBytes(32).toString('hex'),
          crypto.randomBytes(32).toString('hex'),
          actorEmail,
        ],
      )
      const scenarioBatch = await pool.query(
        `INSERT INTO pos_accounting_posting_batches (
           organization_id, draft_id, restaurant_guid, business_date, status,
           request_fingerprint, sales_receipt_request_id, journal_entry_request_id, requested_by
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::date, 'failed',
           $5, $6::uuid, $7::uuid, $8
         )
         RETURNING id::text`,
        [
          organizationId,
          scenarioDraft.rows[0].id,
          scenarioRestaurantGuid,
          scope.businessDate,
          crypto.randomBytes(32).toString('hex'),
          scenarioReceiptRequestId,
          scenarioJournalRequestId,
          actorEmail,
        ],
      )
      databaseWorkspace = {
        ...workspace,
        location: { restaurantName: 'Acceptance Restaurant', locationName },
        draft: { status: 'failed', lastError: 'Both QuickBooks documents failed.' },
        preview: { available: false, readiness: { blockers: [] } },
      }
      return {
        scope: {
          organizationId,
          restaurantGuid: scenarioRestaurantGuid,
          businessDate: scope.businessDate,
        },
        batchId: scenarioBatch.rows[0].id,
        draftId: scenarioDraft.rows[0].id,
        receiptRequestId: scenarioReceiptRequestId,
        journalRequestId: scenarioJournalRequestId,
      }
    }

    const recoveredBeforeDelivery = await createTerminalPostingScenario('Recovered Before Delivery')
    const recoveredIssue = await databaseNotifications.reconcilePosAccountingIssueForDateInPostgres(
      recoveredBeforeDelivery.scope,
    )
    assert.equal(recoveredIssue.issueCount, 2)
    const recoveredClaim = await databaseNotifications.claimPosAccountingNotificationsInPostgres({
      limit: 1,
      workerId: 'notification-recovered-before-delivery',
    })
    assert.equal(recoveredClaim.length, 1)
    await pool.query(
      `UPDATE quickbooks_write_requests SET
         status = 'succeeded', last_error_message = NULL,
         result_payload = '{"recovered":true}'::jsonb, updated_at = now()
       WHERE organization_id = $1::uuid AND id = ANY($2::uuid[])`,
      [
        organizationId,
        [recoveredBeforeDelivery.receiptRequestId, recoveredBeforeDelivery.journalRequestId],
      ],
    )
    const recoveredDelivery = await databaseNotifications.deliverClaimedPosAccountingNotificationInPostgres(
      recoveredClaim[0],
    )
    assert.deepEqual(
      JSON.parse(JSON.stringify(recoveredDelivery)),
      { status: 'suppressed', attempted: false },
      'A successful receipt and journal detected after claim must suppress the stale failure email',
    )
    assert.equal(sentMessages.length, 3)
    const recoveredReconciliation = await databaseNotifications.reconcilePosAccountingIssueForDateInPostgres(
      recoveredBeforeDelivery.scope,
    )
    assert.equal(recoveredReconciliation.status, 'resolved')

    const partialRecovery = await createTerminalPostingScenario('Partial Recovery')
    await databaseNotifications.reconcilePosAccountingIssueForDateInPostgres(partialRecovery.scope)
    const partialClaim = await databaseNotifications.claimPosAccountingNotificationsInPostgres({
      limit: 1,
      workerId: 'notification-partial-recovery',
    })
    assert.equal(partialClaim.length, 1)
    await pool.query(
      `UPDATE quickbooks_write_requests SET
         status = 'succeeded', last_error_message = NULL,
         result_payload = '{"recovered":true}'::jsonb, updated_at = now()
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [organizationId, partialRecovery.receiptRequestId],
    )
    const partialDelivery = await databaseNotifications.deliverClaimedPosAccountingNotificationInPostgres(
      partialClaim[0],
    )
    assert.deepEqual(
      JSON.parse(JSON.stringify(partialDelivery)),
      { status: 'succeeded', attempted: true },
      'A remaining journal failure must still produce the one daily email',
    )
    assert.equal(sentMessages.length, 4)
    assert.deepEqual(
      JSON.parse(JSON.stringify(sentMessages[3].issues.map((issue) => issue.code))),
      ['journal_entry_provider_failure'],
      'Delivery must recompute the latest document outcome instead of sending a stale receipt failure',
    )

    const cancelledBeforeDelivery = await createTerminalPostingScenario('Cancelled Before Delivery')
    await databaseNotifications.reconcilePosAccountingIssueForDateInPostgres(cancelledBeforeDelivery.scope)
    const cancelledClaim = await databaseNotifications.claimPosAccountingNotificationsInPostgres({
      limit: 1,
      workerId: 'notification-cancelled-before-delivery',
    })
    assert.equal(cancelledClaim.length, 1)
    await pool.query(
      `UPDATE pos_accounting_posting_batches SET
         status = 'cancelled', cancelled_at = now(), cancelled_by = $3, updated_at = now()
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [organizationId, cancelledBeforeDelivery.batchId, actorEmail],
    )
    const cancelledDelivery = await databaseNotifications.deliverClaimedPosAccountingNotificationInPostgres(
      cancelledClaim[0],
    )
    assert.deepEqual(
      JSON.parse(JSON.stringify(cancelledDelivery)),
      { status: 'suppressed', attempted: false },
      'A posting batch cancelled after claim must suppress the stale failure email',
    )
    assert.equal(sentMessages.length, 4)
    const rejectedSuppressedFailure = await databaseNotifications.failPosAccountingNotificationInPostgres({
      job: cancelledClaim[0],
      error: 'A stale worker must not relabel a suppressed notification as dead',
    })
    assert.deepEqual(
      JSON.parse(JSON.stringify(rejectedSuppressedFailure)),
      { accepted: false, dead: false },
      'A rejected stale failure must not be counted as a dead delivery',
    )

    const externallyPosted = await createTerminalPostingScenario('Externally Posted')
    await pool.query(
      `UPDATE pos_accounting_posting_batches SET
         status = 'cancelled', cancelled_at = now(), cancelled_by = $3, updated_at = now()
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [organizationId, externallyPosted.batchId, actorEmail],
    )
    await pool.query(
      `UPDATE toast_accounting_export_drafts SET
         status = 'posted', review_outcome = 'externally_posted', posting_origin = 'external',
         external_posting_provider = 'External POS', reviewed_at = now(), reviewed_by = $3,
         quickbooks_sales_receipt_id = 'external-receipt',
         quickbooks_journal_entry_id = 'external-journal', posted_at = now(), last_error = NULL,
         updated_at = now()
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [organizationId, externallyPosted.draftId, actorEmail],
    )
    const externallyPostedReconciliation = await databaseNotifications.reconcilePosAccountingIssueForDateInPostgres(
      externallyPosted.scope,
    )
    assert.equal(externallyPostedReconciliation.status, 'resolved')
    const externallyPostedOutbox = await pool.query(
      `SELECT count(*)::integer AS count
       FROM pos_accounting_notification_outbox outbox
       JOIN pos_accounting_issue_states issue ON issue.id = outbox.issue_state_id
       WHERE issue.organization_id = $1::uuid AND issue.restaurant_guid = $2::uuid`,
      [organizationId, externallyPosted.scope.restaurantGuid],
    )
    assert.equal(
      externallyPostedOutbox.rows[0].count,
      0,
      'An externally posted date must resolve without creating a notification slot',
    )
    assert.equal(sentMessages.length, 4)

    async function createNoBatchExternalScenario(locationName) {
      const scenarioRestaurantGuid = crypto.randomUUID()
      await pool.query(
        `INSERT INTO toast_locations (
           organization_id, restaurant_guid, restaurant_name, location_name,
           active, standard_access, selected, last_verified_at
         ) VALUES ($1::uuid, $2::uuid, 'Acceptance Restaurant', $3, true, true, false, now())`,
        [organizationId, scenarioRestaurantGuid, locationName],
      )
      const scenarioDraft = await pool.query(
        `INSERT INTO toast_accounting_export_drafts (
           organization_id, restaurant_guid, business_date, idempotency_key,
           status, reconciliation_status, last_error, updated_at
         ) VALUES (
           $1::uuid, $2::uuid, $3::date, $4,
           'failed', 'ready', 'Posting requires review.', now()
         )
         RETURNING id::text`,
        [
          organizationId,
          scenarioRestaurantGuid,
          scope.businessDate,
          `notification-no-batch-draft:${crypto.randomUUID()}`,
        ],
      )
      databaseWorkspace = {
        ...workspace,
        location: { restaurantName: 'Acceptance Restaurant', locationName },
        draft: { status: 'failed', lastError: 'Posting requires review.' },
        preview: {
          available: false,
          readiness: {
            blockers: [{
              code: 'update_hold',
              title: 'Refresh the accounting date',
              detail: 'The date changed after review.',
              action: 'Refresh accounting',
            }],
          },
        },
      }
      return {
        scope: {
          organizationId,
          restaurantGuid: scenarioRestaurantGuid,
          businessDate: scope.businessDate,
        },
        draftId: scenarioDraft.rows[0].id,
      }
    }

    async function markNoBatchDraftExternallyPosted(scenario) {
      await pool.query(
        `UPDATE toast_accounting_export_drafts SET
           status = 'posted', review_outcome = 'externally_posted', posting_origin = 'external',
           external_posting_provider = 'External POS', reviewed_at = now(), reviewed_by = $3,
           quickbooks_sales_receipt_id = 'external-receipt',
           quickbooks_journal_entry_id = 'external-journal', posted_at = now(), last_error = NULL,
           updated_at = now()
         WHERE organization_id = $1::uuid AND id = $2::uuid`,
        [organizationId, scenario.draftId, actorEmail],
      )
    }

    const noBatchExternalBeforeQueue = await createNoBatchExternalScenario('No Batch External Before Queue')
    await markNoBatchDraftExternallyPosted(noBatchExternalBeforeQueue)
    const noBatchExternalBeforeQueueResult = await databaseNotifications.reconcilePosAccountingIssueForDateInPostgres(
      noBatchExternalBeforeQueue.scope,
    )
    assert.equal(noBatchExternalBeforeQueueResult.status, 'resolved')
    const noBatchExternalBeforeQueueRows = await pool.query(
      `SELECT count(*)::integer AS count
       FROM pos_accounting_notification_outbox outbox
       JOIN pos_accounting_issue_states issue ON issue.id = outbox.issue_state_id
       WHERE issue.organization_id = $1::uuid AND issue.restaurant_guid = $2::uuid`,
      [organizationId, noBatchExternalBeforeQueue.scope.restaurantGuid],
    )
    assert.equal(
      noBatchExternalBeforeQueueRows.rows[0].count,
      0,
      'An externally posted current draft without a ClawPilot batch must never create a daily email slot',
    )

    const noBatchExternalAfterClaim = await createNoBatchExternalScenario('No Batch External After Claim')
    const noBatchIssue = await databaseNotifications.reconcilePosAccountingIssueForDateInPostgres(
      noBatchExternalAfterClaim.scope,
    )
    assert.equal(noBatchIssue.status, 'open')
    const noBatchClaim = await databaseNotifications.claimPosAccountingNotificationsInPostgres({
      limit: 1,
      workerId: 'notification-no-batch-external-after-claim',
    })
    assert.equal(noBatchClaim.length, 1)
    await markNoBatchDraftExternallyPosted(noBatchExternalAfterClaim)
    const noBatchDelivery = await databaseNotifications.deliverClaimedPosAccountingNotificationInPostgres(
      noBatchClaim[0],
    )
    assert.deepEqual(
      JSON.parse(JSON.stringify(noBatchDelivery)),
      { status: 'suppressed', attempted: false },
      'External posting without a ClawPilot batch after claim must suppress provider delivery',
    )
    const noBatchStaleFailure = await databaseNotifications.failPosAccountingNotificationInPostgres({
      job: noBatchClaim[0],
      error: 'A stale no-batch worker must not overwrite suppression',
    })
    assert.deepEqual(JSON.parse(JSON.stringify(noBatchStaleFailure)), { accepted: false, dead: false })
    const noBatchSuppressedRow = await pool.query(
      `SELECT outbox.status
       FROM pos_accounting_notification_outbox outbox
       JOIN pos_accounting_issue_states issue ON issue.id = outbox.issue_state_id
       WHERE issue.organization_id = $1::uuid AND issue.restaurant_guid = $2::uuid`,
      [organizationId, noBatchExternalAfterClaim.scope.restaurantGuid],
    )
    assert.deepEqual(noBatchSuppressedRow.rows, [{ status: 'suppressed' }])
    const noBatchResolvedAfterSuppression = await databaseNotifications.reconcilePosAccountingIssueForDateInPostgres(
      noBatchExternalAfterClaim.scope,
    )
    assert.equal(noBatchResolvedAfterSuppression.status, 'resolved')
    assert.equal(sentMessages.length, 4)

    const concurrentFence = await createTerminalPostingScenario('Concurrent Delivery Fence')
    await databaseNotifications.reconcilePosAccountingIssueForDateInPostgres(concurrentFence.scope)
    const concurrentFenceClaim = await databaseNotifications.claimPosAccountingNotificationsInPostgres({
      limit: 1,
      workerId: 'notification-concurrent-fence',
    })
    assert.equal(concurrentFenceClaim.length, 1)
    let signalMailEntered
    let releaseMail
    const mailEntered = new Promise((resolvePromise) => { signalMailEntered = resolvePromise })
    const mailRelease = new Promise((resolvePromise) => { releaseMail = resolvePromise })
    mailDeliveryPause = { entered: signalMailEntered, release: mailRelease }
    const fencedDeliveryPromise = databaseNotifications.deliverClaimedPosAccountingNotificationInPostgres(
      concurrentFenceClaim[0],
    )
    await mailEntered
    let childMutationCommitted = false
    const fencedChildMutationPromise = (async () => {
      const childClient = await pool.connect()
      try {
        await childClient.query('BEGIN')
        await childClient.query(
          'SELECT pg_advisory_xact_lock(hashtext($1))',
          [`quickbooks-binding:${organizationId}`],
        )
        await childClient.query(
          `UPDATE quickbooks_write_requests SET
             status = 'approved', attempt_count = 0,
             last_error_code = NULL, last_error_message = NULL, updated_at = now()
           WHERE organization_id = $1::uuid AND id = $2::uuid`,
          [organizationId, concurrentFence.receiptRequestId],
        )
        await childClient.query('COMMIT')
        childMutationCommitted = true
      } catch (error) {
        await childClient.query('ROLLBACK')
        throw error
      } finally {
        childClient.release()
      }
    })()
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
    assert.equal(
      childMutationCommitted,
      false,
      'A child retry/cancellation must wait while the final outcome is fenced for provider delivery',
    )
    releaseMail()
    const fencedDelivery = await fencedDeliveryPromise
    await fencedChildMutationPromise
    assert.deepEqual(
      JSON.parse(JSON.stringify(fencedDelivery)),
      { status: 'succeeded', attempted: true },
    )
    assert.equal(childMutationCommitted, true)
    assert.equal(sentMessages.length, 5)
    const noConcurrentDuplicate = await databaseNotifications.processPosAccountingNotificationOutbox({
      limit: 1,
      workerId: 'notification-concurrent-fence-repeat',
    })
    assert.equal(noConcurrentDuplicate.claimed, 0)

    const bulkRestaurantGuid = crypto.randomUUID()
    await pool.query(
      `INSERT INTO toast_locations (
         organization_id, restaurant_guid, restaurant_name, location_name,
         active, standard_access, selected, last_verified_at
       ) VALUES ($1::uuid, $2::uuid, 'Acceptance Restaurant', 'Bulk Location', true, true, false, now())`,
      [organizationId, bulkRestaurantGuid],
    )
    await pool.query(
      `INSERT INTO pos_accounting_issue_states (
         organization_id, restaurant_guid, business_date, status, issue_fingerprint,
         issues, occurrence, opened_at, last_seen_at, created_at, updated_at
       )
       SELECT $1::uuid, $2::uuid, current_date - sequence.day, 'open', $3,
         $4::jsonb, 1, now(), now() - interval '1 hour', now(), now()
       FROM generate_series(1, 125) AS sequence(day)`,
      [
        organizationId,
        bulkRestaurantGuid,
        'e'.repeat(64),
        JSON.stringify([{
          code: 'missing_mapping:sales_item:bulk:item',
          title: 'Map bulk item',
          detail: 'Bulk item needs a QuickBooks item mapping.',
        }]),
      ],
    )
    await pool.query(
      `INSERT INTO pos_accounting_notification_outbox (
         issue_state_id, occurrence, issue_fingerprint, issues, recipient_email, status
       )
       SELECT issue.id, issue.occurrence, issue.issue_fingerprint, issue.issues, $3, 'pending'
       FROM pos_accounting_issue_states issue
       WHERE issue.organization_id = $1::uuid AND issue.restaurant_guid = $2::uuid`,
      [organizationId, bulkRestaurantGuid, actorEmail],
    )
    const oldestBulkDate = await pool.query(
      `SELECT min(business_date)::text AS business_date
       FROM pos_accounting_issue_states
       WHERE organization_id = $1::uuid AND restaurant_guid = $2::uuid`,
      [organizationId, bulkRestaurantGuid],
    )
    forcedWorkspaceFailureDate = oldestBulkDate.rows[0].business_date
    databaseWorkspace = { ...workspace, location: { ...location, locationName: 'Bulk Location' }, preview: { available: false } }
    const bulkReconciliation = await databaseNotifications.reconcileOpenPosAccountingIssuesForMappedItemInPostgres({
      organizationId,
      restaurantGuid: bulkRestaurantGuid,
      mappingScope: 'location_override',
    })
    assert.deepEqual(
      JSON.parse(JSON.stringify(bulkReconciliation)),
      { checked: 125, reconciled: 124, failed: 1 },
      'Mapped-item completion must attempt every affected open date, including more than 100',
    )
    forcedWorkspaceFailureDate = null
    const bulkRetry = await databaseNotifications.reconcileStaleOpenPosAccountingIssuesInPostgres({ limit: 4 })
    assert.deepEqual(
      JSON.parse(JSON.stringify(bulkRetry)),
      { checked: 1, reconciled: 1, failed: 0 },
      'A failed historical mapped-item reconciliation must remain eligible for the durable stale-state retry path',
    )
    const bulkState = await pool.query(
      `SELECT count(*) FILTER (WHERE status = 'open')::integer AS open_count,
         count(*) FILTER (WHERE status = 'resolved')::integer AS resolved_count
       FROM pos_accounting_issue_states
       WHERE organization_id = $1::uuid AND restaurant_guid = $2::uuid`,
      [organizationId, bulkRestaurantGuid],
    )
    assert.deepEqual(bulkState.rows[0], { open_count: 0, resolved_count: 125 })
    const bulkDeliveries = await pool.query(
      `SELECT count(*) FILTER (WHERE outbox.status IN ('pending', 'failed'))::integer AS deliverable_count,
         count(*) FILTER (WHERE outbox.status = 'cancelled')::integer AS cancelled_count
       FROM pos_accounting_notification_outbox outbox
       JOIN pos_accounting_issue_states issue ON issue.id = outbox.issue_state_id
       WHERE issue.organization_id = $1::uuid AND issue.restaurant_guid = $2::uuid`,
      [organizationId, bulkRestaurantGuid],
    )
    assert.deepEqual(bulkDeliveries.rows[0], { deliverable_count: 0, cancelled_count: 125 })
    console.log('POS accounting notification disposable PostgreSQL acceptance passed')
  } finally {
    await pool?.end().catch(() => undefined)
    spawnSync('docker', ['rm', '-f', container], { cwd: root, encoding: 'utf8', timeout: 30_000 })
  }
}

await runPostgresNotificationAcceptance()

console.log('PASS test-pos-accounting-notifications')
