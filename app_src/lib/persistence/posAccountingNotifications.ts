import crypto from 'crypto'
import type { PoolClient } from 'pg'
import { recordAuditEvent } from '@/lib/auditWriter'
import { DEMO_SYSTEM_EMAIL } from '@/lib/demoMode'
import { sendPosAccountingIssueEmail } from '@/lib/matonMail'
import {
  readPosAccountingWorkspaceFromPostgres,
} from '@/lib/persistence/posAccounting'
import {
  acquireTransactionAdvisoryLock,
  query,
  withTransaction,
} from '@/lib/persistence/postgres'

const MAX_DELIVERY_ATTEMPTS = 6

type PosAccountingWorkspace = Awaited<ReturnType<typeof readPosAccountingWorkspaceFromPostgres>>

export type PosAccountingIssue = {
  code: string
  title: string
  detail: string
  action?: string
}

type IssueStateRow = {
  id: string
  status: 'open' | 'resolved'
  issue_fingerprint: string
  issues: PosAccountingIssue[]
  occurrence: number
}

type NotificationRecipientRow = {
  email: string
}

type NotificationJobRow = {
  outbox_id: string
  issue_state_id: string
  occurrence: number
  recipient_email: string
  recipient_name: string | null
  organization_id: string
  organization_name: string
  restaurant_guid: string
  restaurant_name: string
  business_date: string
  issues: PosAccountingIssue[]
  attempt_count: number
  lock_token: string
}

export type PosAccountingNotificationJob = {
  outboxId: string
  issueStateId: string
  occurrence: number
  recipientEmail: string
  recipientName: string | null
  organizationId: string
  organizationName: string
  restaurantGuid: string
  restaurantName: string
  businessDate: string
  issues: PosAccountingIssue[]
  attemptCount: number
  lockToken: string
}

function cleanText(value: unknown, fallback: string, maxLength = 240) {
  const normalized = String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  return (normalized || fallback).slice(0, maxLength)
}

function money(value: unknown) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : 0
}

export function derivePosAccountingIssues(workspace: PosAccountingWorkspace): PosAccountingIssue[] {
  const preview = workspace.preview
  const canonicalBlockers = Array.isArray(preview.readiness?.blockers)
    ? preview.readiness.blockers.map((value) => {
        const blocker = value && typeof value === 'object' && !Array.isArray(value)
          ? value as Record<string, unknown>
          : {}
        return {
          code: cleanText(blocker.code, 'accounting_hold', 600),
          title: cleanText(blocker.title, 'Accounting date is on hold'),
          detail: cleanText(blocker.detail, 'Resolve the accounting hold before posting.', 1_000),
          action: cleanText(blocker.action, 'Review accounting'),
        }
      })
    : []
  const draftFailure = workspace.draft?.status === 'failed' || workspace.draft?.lastError
    ? [{
        code: 'provider_failure',
        title: 'Retry the failed accounting post',
        detail: cleanText(workspace.draft?.lastError, 'QuickBooks rejected or failed the accounting post.', 1_000),
        action: 'Review failure',
      }]
    : []
  if (canonicalBlockers.length > 0 || draftFailure.length > 0) {
    return [...new Map(
      [...canonicalBlockers, ...draftFailure].map((issue) => [issue.code, issue]),
    ).values()].sort((left, right) => left.code.localeCompare(right.code))
  }
  if (!preview.available) return []

  const issues: PosAccountingIssue[] = []
  for (const missing of preview.readiness.missingMappings) {
    const sourceKind = cleanText(missing.sourceKind, 'source', 80)
    const sourceId = cleanText(missing.sourceId, 'unknown', 240)
    const targetType = cleanText(missing.targetType, 'destination', 80)
    const sourceName = cleanText(missing.sourceName, 'Unnamed POS value')
    issues.push({
      code: `missing_mapping:${sourceKind}:${sourceId}:${targetType}`.slice(0, 600),
      title: `Map ${sourceName}`,
      detail: `${sourceKind.replaceAll('_', ' ')} needs a QuickBooks ${targetType.replaceAll('_', ' ')} mapping.`,
    })
  }

  if (workspace.profile.quickBooksBindingStatus !== 'verified') {
    issues.push({
      code: 'quickbooks_company_unbound',
      title: 'Verify the QuickBooks company',
      detail: 'The accounting profile is not bound to the active organization QuickBooks company.',
    })
  }
  if (!preview.journal.balanced) {
    issues.push({
      code: 'journal_unbalanced',
      title: 'Review the unbalanced journal',
      detail: `The Payments Journal differs by ${Math.abs(money(preview.journal.balance)).toFixed(2)}.`,
    })
  }
  if (!preview.readiness.allocationComplete) {
    issues.push({
      code: 'sales_unallocated',
      title: 'Allocate all sales',
      detail: `${Math.abs(money(preview.salesReceipt.unallocatedSubtotal)).toFixed(2)} of sales is not allocated to mapped items.`,
    })
  }
  if (preview.readiness.openChecks > 0 && workspace.profile.openCheckPolicy === 'hold') {
    issues.push({
      code: 'open_checks',
      title: 'Close or exclude open checks',
      detail: `${preview.readiness.openChecks} open checks keep this business date on hold.`,
    })
  }

  return issues.sort((left, right) => left.code.localeCompare(right.code))
}

export function posAccountingIssueFingerprint(issues: PosAccountingIssue[]) {
  return crypto.createHash('sha256').update(JSON.stringify(
    [...issues].sort((left, right) => left.code.localeCompare(right.code)),
  )).digest('hex')
}

function issueCodes(issues: PosAccountingIssue[]) {
  return issues.map((issue) => issue.code).slice(0, 100)
}

function issueSummary(issues: PosAccountingIssue[]) {
  if (issues.length === 1) return issues[0].title
  return `${issues.length} accounting items require review`
}

const RESERVED_RECIPIENT_DOMAIN = /(?:^|\.)(?:example|invalid|test)$/i
const RESERVED_EXAMPLE_DOMAIN = /^example\.(?:com|org|net)$/i

export function isDeliverablePosAccountingRecipient(value: unknown) {
  const email = String(value || '').trim().toLowerCase()
  const parts = email.split('@')
  if (parts.length !== 2 || !parts[0] || !parts[1] || email.length > 254) return false
  const domain = parts[1]
  return email !== DEMO_SYSTEM_EMAIL
    && domain !== 'localhost'
    && !RESERVED_RECIPIENT_DOMAIN.test(domain)
    && !RESERVED_EXAMPLE_DOMAIN.test(domain)
}

async function authorizedRecipients(
  client: PoolClient,
  organizationId: string,
  restaurantGuid: string,
  businessDate: string,
) {
  const result = await client.query<NotificationRecipientRow>(
    `WITH effective_policy AS (
       SELECT profile.email_notifications_enabled, profile.email_notifications_enabled_at
       FROM pos_accounting_profiles profile
       WHERE profile.organization_id = $1::uuid
         AND profile.effective_to IS NULL
         AND (profile.restaurant_guid IS NULL OR profile.restaurant_guid = $2::uuid)
       ORDER BY (profile.restaurant_guid = $2::uuid) DESC NULLS LAST,
         profile.profile_revision DESC
       LIMIT 1
     )
     SELECT lower(app_user.email) AS email
     FROM app_user_organization_memberships membership
     JOIN app_users app_user ON app_user.email = membership.user_email
     JOIN workspace_organizations organization ON organization.id = membership.organization_id
     CROSS JOIN effective_policy policy
     WHERE membership.organization_id = $1::uuid
       AND organization.is_demo = false
       AND policy.email_notifications_enabled = true
       AND policy.email_notifications_enabled_at IS NOT NULL
       AND $3::date >= (policy.email_notifications_enabled_at AT TIME ZONE 'UTC')::date
       AND app_user.status = 'active'
       AND membership.status = 'active'
       AND membership.role IN ('owner', 'admin')
       AND (
         membership.role = 'owner'
         OR (
           membership.permissions @> '{"viewAccounting":true,"manageUserAccess":true}'::jsonb
         )
       )
     ORDER BY app_user.email`,
    [organizationId, restaurantGuid, businessDate],
  )
  return result.rows.filter((recipient) => isDeliverablePosAccountingRecipient(recipient.email))
}

async function queueRecipients(
  client: PoolClient,
  input: {
    issueStateId: string
    occurrence: number
    issueFingerprint: string
    issues: PosAccountingIssue[]
    recipients: NotificationRecipientRow[]
  },
) {
  for (const recipient of input.recipients) {
    await client.query(
      `INSERT INTO pos_accounting_notification_outbox (
         issue_state_id, occurrence, issue_fingerprint, issues, recipient_email,
         status, available_at, created_at, updated_at
       ) VALUES ($1::uuid, $2, $3, $4::jsonb, $5, 'pending', now(), now(), now())
       ON CONFLICT (issue_state_id, occurrence, recipient_email) DO NOTHING`,
      [
        input.issueStateId,
        input.occurrence,
        input.issueFingerprint,
        JSON.stringify(input.issues),
        recipient.email.toLowerCase(),
      ],
    )
  }
}

export async function reconcilePosAccountingIssueForDateInPostgres(input: {
  organizationId: string
  restaurantGuid: string
  businessDate: string
}) {
  const workspace = await readPosAccountingWorkspaceFromPostgres({
    organizationId: input.organizationId,
    restaurantGuid: input.restaurantGuid,
    businessDate: input.businessDate,
  })
  const issues = derivePosAccountingIssues(workspace)
  const fingerprint = issues.length > 0 ? posAccountingIssueFingerprint(issues) : null
  const clearFingerprint = posAccountingIssueFingerprint([])

  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `pos-accounting-issue:${input.organizationId}:${input.restaurantGuid}:${input.businessDate}`,
    )
    const currentResult = await client.query<IssueStateRow>(
      `SELECT id::text, status, issue_fingerprint, issues, occurrence
       FROM pos_accounting_issue_states
       WHERE organization_id = $1::uuid AND restaurant_guid = $2::uuid
         AND business_date = $3::date
       FOR UPDATE`,
      [input.organizationId, input.restaurantGuid, input.businessDate],
    )
    const current = currentResult.rows[0]
    const recipients = await authorizedRecipients(
      client,
      input.organizationId,
      input.restaurantGuid,
      input.businessDate,
    )
    const recipientEmails = recipients.map((recipient) => recipient.email.toLowerCase())

    if (!fingerprint) {
      if (!current) {
        await client.query(
          `INSERT INTO pos_accounting_issue_states (
             organization_id, restaurant_guid, business_date, status, issue_fingerprint,
             issues, occurrence, opened_at, last_seen_at, resolved_at, created_at, updated_at
           ) VALUES ($1::uuid, $2::uuid, $3::date, 'resolved', $4, '[]'::jsonb, 1,
             now(), now(), now(), now(), now())
           ON CONFLICT (organization_id, restaurant_guid, business_date) DO NOTHING`,
          [input.organizationId, input.restaurantGuid, input.businessDate, clearFingerprint],
        )
        return { status: 'resolved' as const, changed: false, issueCount: 0, recipients: 0 }
      }
      if (current.status === 'resolved') {
        await client.query(
          `UPDATE pos_accounting_issue_states SET last_seen_at = now(), updated_at = now()
           WHERE id = $1::uuid`,
          [current.id],
        )
        return { status: 'resolved' as const, changed: false, issueCount: 0, recipients: 0 }
      }
      await client.query(
        `UPDATE pos_accounting_issue_states SET
           status = 'resolved', last_seen_at = now(), resolved_at = now(), updated_at = now()
         WHERE id = $1::uuid`,
        [current.id],
      )
      await client.query(
        `UPDATE pos_accounting_notification_outbox SET
           status = 'cancelled', last_error = 'Accounting issue was resolved before delivery',
           updated_at = now()
         WHERE issue_state_id = $1::uuid AND status IN ('pending', 'failed')`,
        [current.id],
      )
      await recordAuditEvent({
        actor: 'system',
        eventType: 'pos.accounting.issue.resolved',
        aggregateType: 'pos_accounting_issue',
        aggregateId: current.id,
        organizationId: input.organizationId,
        isSystem: true,
        eventKey: `pos-accounting-issue:${current.id}:${current.occurrence}:resolved`,
        payload: {
          message: `${workspace.location.locationName || workspace.location.restaurantName} accounting issue for ${input.businessDate} was resolved`,
          restaurantGuid: input.restaurantGuid,
          restaurantName: workspace.location.locationName || workspace.location.restaurantName,
          businessDate: input.businessDate,
          issueCount: 0,
          issueCodes: [],
          recipientEmails,
        },
      }, client)
      return { status: 'resolved' as const, changed: true, issueCount: 0, recipients: recipientEmails.length }
    }

    const changed = !current || current.status !== 'open' || current.issue_fingerprint !== fingerprint
    const occurrence = changed ? Number(current?.occurrence || 0) + 1 : current.occurrence
    const stateResult = await client.query<{ id: string }>(
      `INSERT INTO pos_accounting_issue_states (
         organization_id, restaurant_guid, business_date, status, issue_fingerprint,
         issues, occurrence, opened_at, last_seen_at, resolved_at, created_at, updated_at
       ) VALUES ($1::uuid, $2::uuid, $3::date, 'open', $4, $5::jsonb, $6,
         now(), now(), NULL, now(), now())
       ON CONFLICT (organization_id, restaurant_guid, business_date) DO UPDATE SET
         status = 'open', issue_fingerprint = EXCLUDED.issue_fingerprint,
         issues = EXCLUDED.issues, occurrence = EXCLUDED.occurrence,
         opened_at = CASE
           WHEN pos_accounting_issue_states.status = 'open'
             AND pos_accounting_issue_states.issue_fingerprint = EXCLUDED.issue_fingerprint
             THEN pos_accounting_issue_states.opened_at
           ELSE now()
         END,
         last_seen_at = now(), resolved_at = NULL, updated_at = now()
       RETURNING id::text`,
      [input.organizationId, input.restaurantGuid, input.businessDate, fingerprint, JSON.stringify(issues), occurrence],
    )
    const issueStateId = stateResult.rows[0]?.id
    if (!issueStateId) throw new Error('POS accounting issue state could not be persisted')
    if (changed) {
      await client.query(
        `UPDATE pos_accounting_notification_outbox SET
           status = 'cancelled', last_error = 'A newer accounting issue occurrence replaced this delivery',
           updated_at = now()
         WHERE issue_state_id = $1::uuid AND occurrence <> $2
           AND status IN ('pending', 'failed')`,
        [issueStateId, occurrence],
      )
    }
    await queueRecipients(client, {
      issueStateId,
      occurrence,
      issueFingerprint: fingerprint,
      issues,
      recipients,
    })

    if (changed) {
      await recordAuditEvent({
        actor: 'system',
        eventType: 'pos.accounting.issue.opened',
        aggregateType: 'pos_accounting_issue',
        aggregateId: issueStateId,
        organizationId: input.organizationId,
        isSystem: true,
        eventKey: `pos-accounting-issue:${issueStateId}:${occurrence}:opened`,
        payload: {
          message: `${workspace.location.locationName || workspace.location.restaurantName} accounting for ${input.businessDate} needs review`,
          restaurantGuid: input.restaurantGuid,
          restaurantName: workspace.location.locationName || workspace.location.restaurantName,
          businessDate: input.businessDate,
          issueCount: issues.length,
          issueCodes: issueCodes(issues),
          issueSummary: issueSummary(issues),
          recipientEmails,
        },
      }, client)
    }
    return {
      status: 'open' as const,
      changed,
      issueCount: issues.length,
      recipients: recipientEmails.length,
      occurrence,
    }
  })
}

export async function reconcileStaleOpenPosAccountingIssuesInPostgres(input: { limit?: number } = {}) {
  const result = await query<{
    organization_id: string
    restaurant_guid: string
    business_date: string
  }>(
    `WITH candidates AS (
       SELECT issue.organization_id, issue.restaurant_guid, issue.business_date,
         issue.last_seen_at AS priority_at
       FROM pos_accounting_issue_states issue
       WHERE issue.status = 'open'
         AND issue.business_date >= current_date - interval '1 day'
         AND issue.last_seen_at < now() - interval '30 minutes'
       UNION ALL
       SELECT source.organization_id, source.restaurant_guid, source.business_date,
         MIN(source.updated_at) AS priority_at
       FROM toast_pos_orders source
       LEFT JOIN pos_accounting_issue_states issue
         ON issue.organization_id = source.organization_id
        AND issue.restaurant_guid = source.restaurant_guid
        AND issue.business_date = source.business_date
       WHERE source.deleted = false
         AND source.business_date >= current_date - interval '1 day'
         AND issue.id IS NULL
       GROUP BY source.organization_id, source.restaurant_guid, source.business_date
     )
     SELECT organization_id::text, restaurant_guid::text, business_date::text
     FROM candidates
     ORDER BY priority_at, organization_id, restaurant_guid, business_date
     LIMIT $1`,
    [Math.max(1, Math.min(input.limit || 1, 4))],
  )
  let reconciled = 0
  let failed = 0
  for (const row of result.rows) {
    try {
      await reconcilePosAccountingIssueForDateInPostgres({
        organizationId: row.organization_id,
        restaurantGuid: row.restaurant_guid,
        businessDate: row.business_date,
      })
      reconciled += 1
    } catch {
      failed += 1
    }
  }
  return { checked: result.rows.length, reconciled, failed }
}

function toNotificationJob(row: NotificationJobRow): PosAccountingNotificationJob {
  return {
    outboxId: row.outbox_id,
    issueStateId: row.issue_state_id,
    occurrence: row.occurrence,
    recipientEmail: row.recipient_email,
    recipientName: row.recipient_name,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    restaurantGuid: row.restaurant_guid,
    restaurantName: row.restaurant_name,
    businessDate: row.business_date,
    issues: Array.isArray(row.issues) ? row.issues : [],
    attemptCount: row.attempt_count,
    lockToken: row.lock_token,
  }
}

export async function claimPosAccountingNotificationsInPostgres(input: { limit: number; workerId: string }) {
  await query(
    `UPDATE pos_accounting_notification_outbox outbox SET
       status = 'failed', available_at = now(), locked_at = NULL, locked_by = NULL,
       lock_token = NULL, last_error = COALESCE(last_error, 'Notification worker lease expired'),
       updated_at = now()
     WHERE outbox.status = 'processing'
       AND outbox.locked_at < now() - interval '15 minutes'`,
  )
  await query(
    `UPDATE pos_accounting_notification_outbox outbox SET
       status = 'cancelled', locked_at = NULL, locked_by = NULL, lock_token = NULL,
       last_error = 'Recipient no longer has accounting administration access', updated_at = now()
     FROM pos_accounting_issue_states issue
     JOIN workspace_organizations organization ON organization.id = issue.organization_id
     WHERE issue.id = outbox.issue_state_id
       AND outbox.status IN ('pending', 'failed')
       AND (
         organization.is_demo = true
         OR outbox.recipient_email = 'demo-system@clawpilot.example'
         OR outbox.recipient_email ~* '@[^@]*\.(example|invalid|test)$'
         OR outbox.recipient_email ~* '@example\.(com|org|net)$'
         OR outbox.recipient_email ~* '@localhost$'
         OR NOT EXISTS (
           SELECT 1
           FROM pos_accounting_profiles profile
           WHERE profile.id = (
             SELECT candidate.id
             FROM pos_accounting_profiles candidate
             WHERE candidate.organization_id = issue.organization_id
               AND candidate.effective_to IS NULL
               AND (
                 candidate.restaurant_guid IS NULL
                 OR candidate.restaurant_guid = issue.restaurant_guid
               )
             ORDER BY (candidate.restaurant_guid = issue.restaurant_guid) DESC NULLS LAST,
               candidate.profile_revision DESC
             LIMIT 1
           )
             AND profile.email_notifications_enabled = true
             AND profile.email_notifications_enabled_at IS NOT NULL
             AND issue.business_date >= (
               profile.email_notifications_enabled_at AT TIME ZONE 'UTC'
             )::date
         )
         OR NOT EXISTS (
         SELECT 1
         FROM app_user_organization_memberships membership
         JOIN app_users app_user ON app_user.email = membership.user_email
         WHERE membership.organization_id = issue.organization_id
           AND membership.user_email = outbox.recipient_email
           AND app_user.status = 'active'
           AND membership.status = 'active'
           AND membership.role IN ('owner', 'admin')
           AND (
             membership.role = 'owner'
             OR (
               membership.permissions @> '{"viewAccounting":true,"manageUserAccess":true}'::jsonb
             )
           )
         )
       )`,
  )
  const result = await query<NotificationJobRow>(
    `WITH candidates AS (
       SELECT outbox.id
       FROM pos_accounting_notification_outbox outbox
       JOIN pos_accounting_issue_states issue ON issue.id = outbox.issue_state_id
       JOIN workspace_organizations organization ON organization.id = issue.organization_id
       WHERE outbox.status IN ('pending', 'failed')
         AND outbox.available_at <= now()
         AND issue.status = 'open'
         AND issue.occurrence = outbox.occurrence
         AND organization.is_demo = false
         AND outbox.recipient_email <> 'demo-system@clawpilot.example'
         AND outbox.recipient_email !~* '@[^@]*\.(example|invalid|test)$'
         AND outbox.recipient_email !~* '@example\.(com|org|net)$'
         AND outbox.recipient_email !~* '@localhost$'
       ORDER BY outbox.available_at, outbox.created_at, outbox.id
       FOR UPDATE OF outbox SKIP LOCKED
       LIMIT $1
     ), claimed AS (
       UPDATE pos_accounting_notification_outbox outbox SET
         status = 'processing', attempt_count = outbox.attempt_count + 1,
         locked_at = now(), locked_by = $2, lock_token = gen_random_uuid(), updated_at = now()
       FROM candidates
       WHERE outbox.id = candidates.id
       RETURNING outbox.*
     )
     SELECT claimed.id::text AS outbox_id, claimed.issue_state_id::text,
       claimed.occurrence, claimed.recipient_email, app_user.display_name AS recipient_name,
       issue.organization_id::text, organization.name AS organization_name,
       issue.restaurant_guid::text,
       COALESCE(location.location_name, location.restaurant_name) AS restaurant_name,
       issue.business_date::text, claimed.issues, claimed.attempt_count,
       claimed.lock_token::text
     FROM claimed
     JOIN pos_accounting_issue_states issue ON issue.id = claimed.issue_state_id
     JOIN workspace_organizations organization ON organization.id = issue.organization_id
     JOIN toast_locations location
       ON location.organization_id = issue.organization_id
      AND location.restaurant_guid = issue.restaurant_guid
     JOIN app_users app_user ON app_user.email = claimed.recipient_email
     ORDER BY claimed.created_at, claimed.id`,
    [Math.max(1, Math.min(input.limit, 20)), cleanText(input.workerId, 'pos-notification-worker', 200)],
  )
  return result.rows.map(toNotificationJob)
}

export async function completePosAccountingNotificationInPostgres(input: {
  job: PosAccountingNotificationJob
  providerMessageId: string | null
}) {
  return withTransaction(async (client) => {
    const completed = await client.query(
      `UPDATE pos_accounting_notification_outbox SET
         status = 'succeeded', sent_at = now(), provider_message_id = $3,
         last_error = NULL, locked_at = NULL, locked_by = NULL, lock_token = NULL,
         updated_at = now()
       WHERE id = $1::uuid AND status = 'processing' AND lock_token = $2::uuid
       RETURNING id`,
      [input.job.outboxId, input.job.lockToken, input.providerMessageId],
    )
    if (!completed.rows[0]) return false
    await client.query(
      `UPDATE pos_accounting_issue_states SET
         last_notified_at = now(), notification_count = notification_count + 1, updated_at = now()
       WHERE id = $1::uuid`,
      [input.job.issueStateId],
    )
    return true
  })
}

export async function failPosAccountingNotificationInPostgres(input: {
  job: PosAccountingNotificationJob
  error: string
}) {
  const dead = input.job.attemptCount >= MAX_DELIVERY_ATTEMPTS
  const retrySeconds = Math.min(3600, 30 * (2 ** Math.max(0, input.job.attemptCount - 1)))
  const result = await query(
    `UPDATE pos_accounting_notification_outbox SET
       status = $3, available_at = CASE WHEN $3 = 'dead' THEN available_at ELSE now() + make_interval(secs => $5) END,
       last_error = $4, locked_at = NULL, locked_by = NULL, lock_token = NULL, updated_at = now()
     WHERE id = $1::uuid AND status = 'processing' AND lock_token = $2::uuid
     RETURNING id`,
    [input.job.outboxId, input.job.lockToken, dead ? 'dead' : 'failed', cleanText(input.error, 'Email delivery failed', 1000), retrySeconds],
  )
  return { accepted: Boolean(result.rows[0]), dead }
}

export async function processPosAccountingNotificationOutbox(input: {
  limit?: number
  workerId?: string
} = {}) {
  const workerId = cleanText(
    input.workerId || process.env.RAILWAY_REPLICA_ID || process.env.HOSTNAME || crypto.randomUUID(),
    'pos-notification-worker',
    200,
  )
  const jobs = await claimPosAccountingNotificationsInPostgres({ limit: input.limit || 2, workerId })
  let succeeded = 0
  let failed = 0
  let dead = 0
  for (const job of jobs) {
    try {
      const result = await sendPosAccountingIssueEmail({
        to: job.recipientEmail,
        recipientName: job.recipientName,
        organizationName: job.organizationName,
        restaurantName: job.restaurantName,
        restaurantGuid: job.restaurantGuid,
        businessDate: job.businessDate,
        issues: job.issues,
      })
      if (!await completePosAccountingNotificationInPostgres({ job, providerMessageId: result.messageId })) {
        throw new Error('POS accounting notification worker lease expired')
      }
      succeeded += 1
    } catch (error) {
      const outcome = await failPosAccountingNotificationInPostgres({
        job,
        error: error instanceof Error ? error.message : 'Email delivery failed',
      })
      if (outcome.accepted) failed += 1
      if (outcome.dead) dead += 1
    }
  }
  return { claimed: jobs.length, succeeded, failed, dead }
}
