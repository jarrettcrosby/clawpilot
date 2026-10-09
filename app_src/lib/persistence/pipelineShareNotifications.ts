import { query } from '@/lib/persistence/postgres'
import type { PipelineOutboxItem } from '@/lib/persistence/pipeline'
import {
  createPipelineShareMailDraft,
  findPipelineShareMailDraft,
  findSentPipelineShareMail,
  PipelineShareMailError,
  sendPipelineShareMailDraft,
  verifyPipelineShareMailSender,
  type PipelineGoogleShareMailInput,
  type PipelineShareMailBinding,
} from '@/lib/matonMail'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const RESOURCE_PATTERN = /^[A-Za-z0-9_-]{1,256}$/
const EMAIL_PATTERN = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/

/** A known Google identity is positive evidence, not an email-domain guess.
 * Unknown addresses retain Google's required visitor/PIN invitation. */
export async function pipelineShareRecipientHasVerifiedGoogleAccount(recipientEmail: string) {
  const result = await query<{ verified: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM app_effective_google_identities identity
       WHERE identity.provider = 'google' AND identity.user_email = $1 AND identity.verified_email = $1
     ) OR EXISTS (
       SELECT 1 FROM user_maton_connections connection
       WHERE connection.owner_email = $1 AND connection.account_email = $1
         AND connection.app IN ('google-mail', 'google-calendar', 'google-drive', 'google-sheets', 'google-meet')
         AND connection.status = 'ACTIVE' AND connection.source = 'maton'
         AND connection.method IN ('oauth2', 'oauth_2')
     ) AS verified`,
    [recipientEmail],
  )
  return result.rows[0]?.verified === true
}

export class PipelineShareNotificationError extends Error {
  constructor(message: string, readonly permanent = false) {
    super(message)
    this.name = 'PipelineShareNotificationError'
  }
}

export async function enqueuePipelineGoogleShareNotificationInPostgres(input: {
  pipelineId: string
  resourceId: string
  recipientEmail: string
  googleRole: 'reader' | 'writer'
}) {
  const recipientEmail = input.recipientEmail.trim().toLowerCase()
  if (!UUID_PATTERN.test(input.pipelineId) || !RESOURCE_PATTERN.test(input.resourceId)
    || recipientEmail.length > 254 || !EMAIL_PATTERN.test(recipientEmail)
    || (input.googleRole !== 'reader' && input.googleRole !== 'writer')) {
    throw new PipelineShareNotificationError('Pipeline share notification context is invalid', true)
  }
  const payload = { pipelineId: input.pipelineId, resourceId: input.resourceId, recipientEmail, googleRole: input.googleRole }
  const result = await query<{ id: string; status: string }>(
    `INSERT INTO sync_outbox (aggregate_type, aggregate_id, operation, target_system, payload, status, attempts, idempotency_key, updated_at)
     SELECT 'pipeline_google_share', pipeline.id::text, 'notify_pipeline_google_share', 'pipeline_internal_v1', $4::jsonb, 'queued', 0, $5, now()
     FROM pipeline_spaces pipeline
     JOIN app_users recipient ON recipient.email = $3 AND recipient.status <> 'disabled'
     WHERE pipeline.id = $1::uuid AND pipeline.drive_folder_id = $2
       AND (pipeline.owner_email = $3 OR EXISTS (
         SELECT 1 FROM pipeline_space_members member WHERE member.pipeline_id = pipeline.id AND member.user_email = $3
       ))
     ON CONFLICT (target_system, idempotency_key) WHERE idempotency_key IS NOT NULL
     DO UPDATE SET updated_at = sync_outbox.updated_at
     RETURNING id::text, status`,
    [input.pipelineId, input.resourceId, recipientEmail, JSON.stringify(payload), `pipeline-share:${input.pipelineId}:${input.resourceId}:${recipientEmail}`],
  )
  if (!result.rows[0]) throw new PipelineShareNotificationError('Pipeline share recipient is no longer authorized', true)
  return result.rows[0]
}

type NotificationContext = {
  pipeline_id: string
  pipeline_name: string
  organization_name: string
  sheet_id: string | null
  drive_folder_id: string
  provisioning_status: string
  sync_enabled: boolean
  permission_id: string | null
  google_role: 'reader' | 'writer' | null
  desired_role: 'reader' | 'writer'
  recipient_status: string
  membership_status: string
  expired: boolean
}

async function notificationContext(item: PipelineOutboxItem) {
  const pipelineId = String(item.payload.pipelineId || '')
  const resourceId = String(item.payload.resourceId || '')
  const recipientEmail = String(item.payload.recipientEmail || '')
  if (!UUID_PATTERN.test(pipelineId) || !RESOURCE_PATTERN.test(resourceId)
    || recipientEmail.length > 254 || !EMAIL_PATTERN.test(recipientEmail) || recipientEmail !== recipientEmail.toLowerCase()) {
    throw new PipelineShareNotificationError('Pipeline share notification context is invalid', true)
  }
  const result = await query<NotificationContext>(
    `SELECT pipeline.id::text AS pipeline_id, pipeline.name AS pipeline_name,
            organization.name AS organization_name, pipeline.sheet_id, pipeline.drive_folder_id,
            pipeline.provisioning_status, pipeline.sync_enabled,
            recipient.status AS recipient_status, membership.status AS membership_status,
            permission.permission_id, permission.google_role,
            CASE WHEN pipeline.owner_email = $4 OR member.access_role = 'editor' THEN 'writer' ELSE 'reader' END AS desired_role,
            outbox.created_at < now() - interval '24 hours' AS expired
     FROM sync_outbox outbox
     JOIN pipeline_spaces pipeline ON pipeline.id = $3::uuid AND pipeline.drive_folder_id = $5
     JOIN workspace_organizations organization ON organization.id = pipeline.workspace_organization_id
     JOIN app_users recipient ON recipient.email = $4 AND recipient.status <> 'disabled'
     JOIN app_user_organization_memberships membership ON membership.user_email = recipient.email
       AND membership.organization_id = pipeline.workspace_organization_id
       AND membership.status IN ('invited', 'active') AND membership.trashed_at IS NULL
     LEFT JOIN pipeline_space_members member ON member.pipeline_id = pipeline.id AND member.user_email = $4
     LEFT JOIN pipeline_google_permissions permission ON permission.pipeline_id = pipeline.id
       AND permission.resource_id = pipeline.drive_folder_id AND permission.user_email = $4
     WHERE outbox.id = $1::uuid AND outbox.lock_token = $2 AND outbox.status = 'processing'
       AND outbox.operation = 'notify_pipeline_google_share'
       AND (pipeline.owner_email = $4 OR member.user_email IS NOT NULL)`,
    [item.id, item.lockToken, pipelineId, recipientEmail, resourceId],
  )
  return { context: result.rows[0] || null, recipientEmail }
}

async function deferNotification(item: PipelineOutboxItem) {
  const result = await query(
    `UPDATE sync_outbox SET status = 'queued', attempts = GREATEST(attempts - 1, 0),
       available_at = now() + interval '60 seconds', last_error = 'Waiting for verified pipeline workbook access',
       locked_at = NULL, lock_token = NULL, updated_at = now()
     WHERE id = $1::uuid AND lock_token = $2 AND status = 'processing'`,
    [item.id, item.lockToken],
  )
  if (result.rowCount !== 1) throw new PipelineShareNotificationError('Pipeline share notification lease was lost')
}

async function reserveDraftCreation(item: PipelineOutboxItem, context: NotificationContext, mailBinding: PipelineShareMailBinding) {
  const result = await query(
    `UPDATE sync_outbox SET payload = payload || jsonb_build_object('draftCreationReserved', true, 'draftSheetId', $3::text, 'draftAccessRole', $4::text, 'mailBinding', $5::jsonb), updated_at = now()
     WHERE id = $1::uuid AND lock_token = $2 AND status = 'processing'
       AND COALESCE((payload->>'draftCreationReserved')::boolean, false) = false`,
    [item.id, item.lockToken, context.sheet_id, context.desired_role, JSON.stringify(mailBinding)],
  )
  return result.rowCount === 1
}

async function saveDraft(item: PipelineOutboxItem, draftId: string) {
  const result = await query(
    `UPDATE sync_outbox SET payload = payload || jsonb_build_object('draftId', $3::text), updated_at = now()
     WHERE id = $1::uuid AND lock_token = $2 AND status = 'processing'`,
    [item.id, item.lockToken, draftId],
  )
  if (result.rowCount !== 1) throw new PipelineShareNotificationError('Pipeline share notification lease was lost')
}

async function saveDelivery(item: PipelineOutboxItem, messageId: string) {
  const result = await query(
    `UPDATE sync_outbox SET payload = payload || jsonb_build_object('providerMessageId', $3::text), updated_at = now()
     WHERE id = $1::uuid AND lock_token = $2 AND status = 'processing'`,
    [item.id, item.lockToken, messageId],
  )
  if (result.rowCount !== 1) throw new PipelineShareNotificationError('Pipeline share notification lease was lost')
}

export async function deliverPipelineGoogleShareNotification(input: {
  item: PipelineOutboxItem
  verifyAccess: (input: { pipelineId: string; resourceId: string; recipientEmail: string; googleRole: 'reader' | 'writer'; permissionId: string }) => Promise<void>
}): Promise<'delivered' | 'deferred' | 'obsolete'> {
  const { item } = input
  const { context, recipientEmail } = await notificationContext(item)
  // A revoked recipient, replaced folder, or deleted pipeline must never receive a stale invite.
  if (!context) return 'obsolete'
  const roleMatches = context.google_role === context.desired_role
    || (context.google_role === 'writer' && context.desired_role === 'reader')
  if (context.recipient_status !== 'active' || context.membership_status !== 'active'
    || context.provisioning_status !== 'ready' || !context.sync_enabled || !context.sheet_id || !context.permission_id || !roleMatches) {
    if (context.expired) throw new PipelineShareNotificationError('Pipeline share notification could not verify workbook access within 24 hours; operator review is required', true)
    await deferNotification(item)
    return 'deferred'
  }
  await input.verifyAccess({
    pipelineId: context.pipeline_id, resourceId: context.drive_folder_id,
    recipientEmail, googleRole: context.desired_role, permissionId: context.permission_id,
  })
  if (typeof item.payload.providerMessageId === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(item.payload.providerMessageId)) {
    return 'delivered'
  }
  const mailBinding = await verifyPipelineShareMailSender()
  if (item.payload.draftCreationReserved) {
    const previousBinding = item.payload.mailBinding as Partial<PipelineShareMailBinding> | undefined
    if (!previousBinding || previousBinding.mailboxEmail !== mailBinding.mailboxEmail
      || previousBinding.senderEmail !== mailBinding.senderEmail
      || previousBinding.connectionFingerprint !== mailBinding.connectionFingerprint) {
      throw new PipelineShareNotificationError('Pipeline invitation mail connection or sender changed; operator review is required', true)
    }
  }
  const rfcMessageId = `clawpilot-pipeline-share-${item.id}@notifications.clawpilot`
  const existingMessageId = await findSentPipelineShareMail(rfcMessageId)
  if (existingMessageId) {
    await saveDelivery(item, existingMessageId)
    return 'delivered'
  }
  if (item.payload.draftCreationReserved && (item.payload.draftSheetId !== context.sheet_id || item.payload.draftAccessRole !== context.desired_role)) {
    throw new PipelineShareNotificationError('Pipeline workbook or recipient role changed after the invitation draft was prepared; operator review is required', true)
  }
  let draftId = typeof item.payload.draftId === 'string' ? item.payload.draftId : null
  if (!draftId) {
    draftId = await findPipelineShareMailDraft(rfcMessageId)
    if (!draftId) {
      if (!await reserveDraftCreation(item, context, mailBinding)) {
        throw new PipelineShareNotificationError('Pipeline share draft creation is unconfirmed; retry checks the original draft without creating another. If no draft is recovered, operator review is required')
      }
      const mailInput: PipelineGoogleShareMailInput = {
        to: recipientEmail, pipelineName: context.pipeline_name, organizationName: context.organization_name,
        folderId: context.drive_folder_id, sheetId: context.sheet_id, accessRole: context.desired_role,
      }
      try {
        draftId = await createPipelineShareMailDraft(mailInput, rfcMessageId)
      } catch (error) {
        if (error instanceof PipelineShareMailError && error.ambiguous) {
          draftId = await findPipelineShareMailDraft(rfcMessageId)
        }
        if (!draftId) throw error
      }
    }
    await saveDraft(item, draftId)
  }
  let messageId: string
  try {
    messageId = await sendPipelineShareMailDraft(draftId)
  } catch (error) {
    if (error instanceof PipelineShareMailError && (error.ambiguous || error.status === 404)) {
      const recoveredMessageId = await findSentPipelineShareMail(rfcMessageId)
      if (recoveredMessageId) {
        await saveDelivery(item, recoveredMessageId)
        return 'delivered'
      }
    }
    throw error
  }
  await saveDelivery(item, messageId)
  return 'delivered'
}
