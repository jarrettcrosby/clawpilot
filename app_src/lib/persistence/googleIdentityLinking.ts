import crypto from 'crypto'
import { recordAuditEvent } from '@/lib/auditWriter'
import {
  GoogleSsoError,
  googleSsoClientConfiguration,
  type VerifiedGoogleIdentity,
} from '@/lib/googleSso'
import {
  acquireTransactionAdvisoryLock,
  query,
  withTransaction,
} from '@/lib/persistence/postgres'
import {
  canManageUserAccess,
  normalizeUserEmail,
  type AppUser,
} from '@/lib/users'
import { requireWorkspaceAppUser } from '@/lib/workspaceMemberships'

const IDEMPOTENCY_KEY = /^[\x21-\x7e]{8,200}$/

export type GoogleUserAuthState = {
  organizationId: string
  organizationName: string
  linkingAvailable: boolean
  // Compatibility fields for native/web clients released while Google
  // enablement was organization-scoped. They no longer grant authority.
  enabled: boolean
  rowVersion: number
  canManage: boolean
  platformConfigured: boolean
  webClientId: string | null
  identity: {
    linked: boolean
    email: string
    linkedAt: string | null
  }
}

export type GooglePolicySnapshot = {
  organizationId: string
  enabled: boolean
  rowVersion: number
}

export type GoogleIdentityLinkResult = {
  linked: true
  email: string
  linkedAt: string
  alreadyLinked: boolean
}

type GoogleUserStateRow = {
  organization_id: string
  organization_name: string
  row_version: number | string
  linked_at: string | null
}

type ReceiptRow = {
  command_type: 'google_policy_update' | 'google_identity_link'
  request_hash: string
  result: unknown
}

function activeOrganization(actor: AppUser): string {
  const organizationId = String(actor.organizationId || '').trim()
  if (!organizationId) {
    throw new GoogleSsoError(
      'GOOGLE_SSO_WORKSPACE_REQUIRED',
      'Choose an active organization before changing Google sign-in',
      400,
    )
  }
  return organizationId
}

function integerVersion(value: unknown, field = 'expectedRowVersion'): number {
  const version = Number(value)
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new GoogleSsoError(
      'GOOGLE_SSO_ROW_VERSION_INVALID',
      `${field} must be a non-negative integer`,
      400,
    )
  }
  return version
}

function commandKey(value: unknown): string {
  const key = String(value || '').trim()
  if (!IDEMPOTENCY_KEY.test(key)) {
    throw new GoogleSsoError(
      'GOOGLE_SSO_IDEMPOTENCY_KEY_INVALID',
      'A valid Idempotency-Key header is required',
      400,
    )
  }
  return key
}

function requestHash(value: Record<string, unknown>): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function policyFromReceipt(value: unknown): GooglePolicySnapshot {
  const row = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return {
    organizationId: String(row.organizationId || ''),
    enabled: row.enabled === true,
    rowVersion: integerVersion(row.rowVersion, 'rowVersion'),
  }
}

function linkFromReceipt(value: unknown): GoogleIdentityLinkResult {
  const row = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const email = normalizeUserEmail(row.email)
  const linkedAt = String(row.linkedAt || '').trim()
  if (!linkedAt || !Number.isFinite(Date.parse(linkedAt))) {
    throw new Error('Stored Google identity receipt is invalid')
  }
  return {
    linked: true,
    email,
    linkedAt,
    alreadyLinked: row.alreadyLinked === true,
  }
}

function assertReceipt(
  receipt: ReceiptRow,
  commandType: ReceiptRow['command_type'],
  hash: string,
) {
  if (receipt.command_type !== commandType || receipt.request_hash !== hash) {
    throw new GoogleSsoError(
      'GOOGLE_SSO_IDEMPOTENCY_CONFLICT',
      'Idempotency-Key was already used for a different Google security command',
      409,
    )
  }
}

export async function getGoogleUserAuthState(
  actor: AppUser,
): Promise<GoogleUserAuthState> {
  const organizationId = activeOrganization(actor)
  const result = await query<GoogleUserStateRow>(
    `SELECT organization.id::text AS organization_id,
       organization.name AS organization_name,
       COALESCE(policy.row_version, 0)::text AS row_version,
       identity.linked_at::text
     FROM workspace_organizations organization
     JOIN app_user_organization_memberships membership
       ON membership.organization_id = organization.id
      AND membership.user_email = $2
      AND membership.status = 'active'
     LEFT JOIN app_organization_auth_policies policy
       ON policy.organization_id = organization.id
     LEFT JOIN app_user_external_identities identity
       ON identity.provider = 'google'
      AND identity.user_email = $2
     WHERE organization.id = $1::uuid
     LIMIT 1`,
    [organizationId, actor.email],
  )
  const state = result.rows[0]
  if (!state) {
    throw new GoogleSsoError(
      'GOOGLE_SSO_WORKSPACE_REQUIRED',
      'Active organization is not available',
      404,
    )
  }
  const client = googleSsoClientConfiguration()
  return {
    organizationId: state.organization_id,
    organizationName: state.organization_name,
    linkingAvailable: client.configured,
    enabled: client.configured,
    rowVersion: integerVersion(state.row_version, 'rowVersion'),
    canManage: false,
    platformConfigured: client.configured,
    webClientId: client.clientId,
    identity: {
      linked: Boolean(state.linked_at),
      email: actor.email,
      linkedAt: state.linked_at,
    },
  }
}

// Retained for source/API compatibility while callers migrate to the
// user-scoped name. Organization policy rows no longer authorize Google login.
export const getGoogleOrganizationAuthState = getGoogleUserAuthState

export async function updateGoogleOrganizationPolicy(input: {
  actor: AppUser
  enabled: boolean
  expectedRowVersion: unknown
  idempotencyKey: unknown
}): Promise<GooglePolicySnapshot> {
  const organizationId = activeOrganization(input.actor)
  if (!canManageUserAccess(input.actor)) {
    throw new GoogleSsoError(
      'GOOGLE_SSO_POLICY_FORBIDDEN',
      'Manage user access permission is required to configure Google sign-in',
      403,
    )
  }
  if (input.enabled && !googleSsoClientConfiguration().configured) {
    throw new GoogleSsoError(
      'GOOGLE_SSO_NOT_CONFIGURED',
      'The platform Google OAuth client must be configured before an organization can enable Google sign-in',
      503,
    )
  }
  const expectedRowVersion = integerVersion(input.expectedRowVersion)
  const idempotencyKey = commandKey(input.idempotencyKey)
  const hash = requestHash({
    command: 'google_policy_update',
    organizationId,
    enabled: input.enabled,
    expectedRowVersion,
  })

  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(client, `google-auth-policy:${organizationId}`)
    const receipt = await client.query<ReceiptRow>(
      `SELECT command_type, request_hash, result
       FROM app_auth_mutation_receipts
       WHERE organization_id = $1::uuid
         AND actor_email = $2
         AND idempotency_key = $3
       FOR UPDATE`,
      [organizationId, input.actor.email, idempotencyKey],
    )
    if (receipt.rows[0]) {
      assertReceipt(receipt.rows[0], 'google_policy_update', hash)
      return policyFromReceipt(receipt.rows[0].result)
    }

    const membership = await client.query<{ allowed: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM app_user_organization_memberships
         WHERE user_email = $1
           AND organization_id = $2::uuid
           AND status = 'active'
       ) AS allowed`,
      [input.actor.email, organizationId],
    )
    if (!membership.rows[0]?.allowed) {
      throw new GoogleSsoError(
        'GOOGLE_SSO_POLICY_FORBIDDEN',
        'Active organization access is required to configure Google sign-in',
        403,
      )
    }

    const current = await client.query<{
      google_sign_in_enabled: boolean
      row_version: number | string
    }>(
      `SELECT google_sign_in_enabled, row_version::text
       FROM app_organization_auth_policies
       WHERE organization_id = $1::uuid
       FOR UPDATE`,
      [organizationId],
    )
    const currentRowVersion = current.rows[0]
      ? integerVersion(current.rows[0].row_version, 'rowVersion')
      : 0
    if (currentRowVersion !== expectedRowVersion) {
      throw new GoogleSsoError(
        'GOOGLE_SSO_POLICY_CHANGED',
        'Google sign-in settings changed. Reload before saving again',
        409,
      )
    }

    const nextRowVersion = currentRowVersion + 1
    const updated = await client.query<{
      organization_id: string
      google_sign_in_enabled: boolean
      row_version: number | string
    }>(
      `INSERT INTO app_organization_auth_policies (
         organization_id, google_sign_in_enabled, row_version,
         created_by, updated_by, created_at, updated_at
       ) VALUES ($1::uuid, $2, $3, $4, $4, now(), now())
       ON CONFLICT (organization_id) DO UPDATE SET
         google_sign_in_enabled = EXCLUDED.google_sign_in_enabled,
         row_version = EXCLUDED.row_version,
         updated_by = EXCLUDED.updated_by,
         updated_at = now()
       WHERE app_organization_auth_policies.row_version = $5
       RETURNING organization_id::text, google_sign_in_enabled, row_version::text`,
      [
        organizationId,
        input.enabled,
        nextRowVersion,
        input.actor.email,
        currentRowVersion,
      ],
    )
    if (!updated.rows[0]) {
      throw new GoogleSsoError(
        'GOOGLE_SSO_POLICY_CHANGED',
        'Google sign-in settings changed. Reload before saving again',
        409,
      )
    }
    const result: GooglePolicySnapshot = {
      organizationId: updated.rows[0].organization_id,
      enabled: updated.rows[0].google_sign_in_enabled,
      rowVersion: integerVersion(updated.rows[0].row_version, 'rowVersion'),
    }
    await client.query(
      `INSERT INTO app_auth_mutation_receipts (
         organization_id, actor_email, idempotency_key,
         command_type, request_hash, result, created_at
       ) VALUES ($1::uuid, $2, $3, 'google_policy_update', $4, $5::jsonb, now())`,
      [organizationId, input.actor.email, idempotencyKey, hash, JSON.stringify(result)],
    )
    await recordAuditEvent({
      actor: input.actor.email,
      subject: input.actor.email,
      eventType: 'auth.organization.google_policy.updated',
      aggregateType: 'workspace_organization',
      aggregateId: organizationId,
      organizationId,
      eventKey: `google-auth-policy:${organizationId}:${input.actor.email}:${idempotencyKey}`,
      payload: {
        enabled: result.enabled,
        fromRowVersion: currentRowVersion,
        rowVersion: result.rowVersion,
      },
    }, client)
    return result
  })
}

export async function linkGoogleIdentity(input: {
  actor: AppUser
  identity: VerifiedGoogleIdentity
  idempotencyKey: unknown
}): Promise<GoogleIdentityLinkResult> {
  const organizationId = activeOrganization(input.actor)
  const actorEmail = normalizeUserEmail(input.actor.email)
  if (input.identity.email !== actorEmail) {
    throw new GoogleSsoError(
      'GOOGLE_SSO_EMAIL_MISMATCH',
      `Choose the Google account for ${actorEmail}`,
      403,
    )
  }
  const idempotencyKey = commandKey(input.idempotencyKey)
  const hash = requestHash({
    command: 'google_identity_link',
    organizationId,
    email: actorEmail,
    subject: input.identity.subject,
  })

  return withTransaction(async (client) => {
    const identityLocks = [
      `google-identity-email:${actorEmail}`,
      `google-identity-subject:${input.identity.subject}`,
    ].sort()
    for (const lock of identityLocks) {
      await acquireTransactionAdvisoryLock(client, lock)
    }
    const receipt = await client.query<ReceiptRow>(
      `SELECT command_type, request_hash, result
       FROM app_auth_mutation_receipts
       WHERE organization_id = $1::uuid
         AND actor_email = $2
         AND idempotency_key = $3
       FOR UPDATE`,
      [organizationId, actorEmail, idempotencyKey],
    )
    if (receipt.rows[0]) {
      assertReceipt(receipt.rows[0], 'google_identity_link', hash)
      return linkFromReceipt(receipt.rows[0].result)
    }

    const membership = await client.query<{ organization_id: string }>(
      `SELECT membership.organization_id::text
       FROM app_user_organization_memberships membership
       JOIN app_users app_user ON app_user.email = membership.user_email
       WHERE membership.organization_id = $1::uuid
         AND membership.user_email = $2
         AND membership.status = 'active'
         AND app_user.status = 'active'
       FOR SHARE OF membership, app_user`,
      [organizationId, actorEmail],
    )
    if (!membership.rows[0]) {
      throw new GoogleSsoError(
        'GOOGLE_SSO_ACCESS_DENIED',
        'An active ClawPilot organization membership is required to link Google',
        403,
      )
    }

    const existing = await client.query<{
      provider_subject: string
      user_email: string
      linked_at: string
    }>(
      `SELECT provider_subject, user_email, linked_at::text
       FROM app_user_external_identities
       WHERE provider = 'google'
         AND (provider_subject = $1 OR user_email = $2)
       FOR UPDATE`,
      [input.identity.subject, actorEmail],
    )
    const subjectIdentity = existing.rows.find(
      (row) => row.provider_subject === input.identity.subject,
    )
    const userIdentity = existing.rows.find((row) => row.user_email === actorEmail)
    if (
      (subjectIdentity && subjectIdentity.user_email !== actorEmail)
      || (userIdentity && userIdentity.provider_subject !== input.identity.subject)
    ) {
      throw new GoogleSsoError(
        'GOOGLE_SSO_IDENTITY_CONFLICT',
        'This Google account cannot be linked to the current ClawPilot user',
        409,
      )
    }

    const alreadyLinked = Boolean(subjectIdentity && userIdentity)
    const linkedAt = subjectIdentity?.linked_at || userIdentity?.linked_at || new Date().toISOString()
    if (!alreadyLinked) {
      await client.query(
        `INSERT INTO app_user_external_identities (
           provider, provider_subject, user_email, verified_email,
           linked_organization_id, linked_by, row_version, linked_at
         ) VALUES ('google', $1, $2, $2, $3::uuid, $2, 0, $4::timestamptz)`,
        [input.identity.subject, actorEmail, organizationId, linkedAt],
      )
    }
    const result: GoogleIdentityLinkResult = {
      linked: true,
      email: actorEmail,
      linkedAt,
      alreadyLinked,
    }
    await client.query(
      `INSERT INTO app_auth_mutation_receipts (
         organization_id, actor_email, idempotency_key,
         command_type, request_hash, result, created_at
       ) VALUES ($1::uuid, $2, $3, 'google_identity_link', $4, $5::jsonb, now())`,
      [organizationId, actorEmail, idempotencyKey, hash, JSON.stringify(result)],
    )
    if (!alreadyLinked) {
      await recordAuditEvent({
        actor: actorEmail,
        subject: actorEmail,
        eventType: 'auth.identity.google.linked',
        aggregateType: 'app_user',
        aggregateId: actorEmail,
        organizationId,
        eventKey: `google-identity-link:${organizationId}:${actorEmail}:${idempotencyKey}`,
        payload: {
          provider: 'google',
          verifiedEmail: actorEmail,
          linkedOrganizationId: organizationId,
        },
      }, client)
    }
    return result
  })
}

export async function resolveLinkedGoogleIdentity(
  identity: VerifiedGoogleIdentity,
): Promise<AppUser> {
  const result = await query<{
    user_email: string
    user_status: string
    organization_id: string | null
  }>(
    `SELECT identity.user_email, app_user.status AS user_status,
       eligible.organization_id::text
     FROM app_user_external_identities identity
     JOIN app_users app_user ON app_user.email = identity.user_email
     LEFT JOIN LATERAL (
       SELECT membership.organization_id
       FROM app_user_organization_memberships membership
       WHERE membership.user_email = identity.user_email
         AND membership.status = 'active'
       ORDER BY
         (membership.organization_id = identity.linked_organization_id) DESC,
         membership.is_default DESC,
         membership.created_at,
         membership.organization_id
       LIMIT 1
     ) eligible ON true
     WHERE identity.provider = 'google'
       AND identity.provider_subject = $1
       AND identity.user_email = $2
       AND identity.verified_email = $2
     LIMIT 1`,
    [identity.subject, identity.email],
  )
  const linked = result.rows[0]
  if (!linked) {
    throw new GoogleSsoError(
      'GOOGLE_SSO_LINK_REQUIRED',
      'Sign in with a magic code, then link this Google account in Security settings',
      403,
    )
  }
  if (linked.user_status !== 'active') {
    throw new GoogleSsoError(
      'GOOGLE_SSO_ACCESS_DENIED',
      'This Google account is not authorized for ClawPilot',
      403,
    )
  }
  if (!linked.organization_id) {
    throw new GoogleSsoError(
      'GOOGLE_SSO_ACCESS_DENIED',
      'This Google account has no active ClawPilot organization membership',
      403,
    )
  }
  return requireWorkspaceAppUser(linked.user_email, linked.organization_id)
}
