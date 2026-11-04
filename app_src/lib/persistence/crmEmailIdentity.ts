import crypto from 'node:crypto'
import type { PoolClient } from 'pg'
import type { VerifiedGoogleIdentity } from '@/lib/googleSso'
import { recordAuditEvent } from '@/lib/auditWriter'
import { query, withTransaction } from '@/lib/persistence/postgres'
import {
  assertSameRetainedGmailEvidence, gmailEvidenceHash, gmailIntakeProvenance,
  retainedGmailMessageEvidence, verifyGmailMailboxBinding,
  type GmailMessageEvidence, type VerifiedGmailMailboxIdentity,
} from '@/lib/crm/emailIdentity'

const unavailable = () => new Error('Verified Gmail source identity is unavailable or changed')
type VerifiedMailboxBindInput = {
  ownerEmail: string; connectionId: string; identity: VerifiedGoogleIdentity; observedAccountEmail: string
}

/** Only call after cryptographic Google ID-token verification AND an independent
 * selected Maton Gmail-profile read. This function is not a public command that
 * accepts a caller-provided Google subject. Tokens are never retained. */
export async function bindVerifiedGmailMailboxInPostgres(input: VerifiedMailboxBindInput) {
  const email = input.observedAccountEmail.trim().toLowerCase()
  if (email !== input.identity.email.trim().toLowerCase() || !input.identity.subject) throw unavailable()
  return withTransaction(async client => {
    // Mailbox/binding writes have native initial-source fences. Acquire their
    // control first, never after locking a connection or canonical identity.
    const control = await client.query('SELECT singleton FROM crm_native_email_publication_control WHERE singleton FOR UPDATE')
    if (control.rows.length !== 1) throw unavailable()
    return bindVerifiedGmailMailboxWithClient(client, input)
  })
}

async function bindVerifiedGmailMailboxWithClient(client: PoolClient, input: VerifiedMailboxBindInput) {
    const email = input.observedAccountEmail.trim().toLowerCase()
    if (email !== input.identity.email.trim().toLowerCase() || !input.identity.subject) throw unavailable()
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`crm-mailbox-binding:${input.ownerEmail}:${input.connectionId}`])
    const connection = await client.query(`SELECT connection.connection_id FROM user_maton_connections connection
      JOIN app_users owner_user ON owner_user.email=connection.owner_email AND owner_user.status='active'
      WHERE connection.owner_email=$1 AND connection.connection_id=$2 AND connection.app='google-mail'
        AND connection.source='maton' AND connection.status='ACTIVE' AND connection.is_selected
        AND lower(btrim(connection.account_email))=$3 FOR SHARE OF connection, owner_user`,
    [input.ownerEmail, input.connectionId, email])
    if (connection.rows.length !== 1) throw unavailable()
    const current = await client.query<{ provider_account_id: string }>(`SELECT mailbox.provider_account_id
      FROM crm_email_mailbox_bindings binding JOIN crm_email_mailboxes mailbox ON mailbox.id=binding.mailbox_id
      WHERE binding.owner_email=$1 AND binding.connection_id=$2 FOR UPDATE OF binding`, [input.ownerEmail, input.connectionId])
    if (current.rows[0] && current.rows[0].provider_account_id !== input.identity.subject) throw unavailable()
    const mailbox = await client.query<{ id: string }>(`INSERT INTO crm_email_mailboxes
      (owner_email,provider,provider_account_id,account_email,verified_at) VALUES($1,'gmail',$2,$3,date_trunc('milliseconds',now()))
      ON CONFLICT(owner_email,provider,provider_account_id) DO UPDATE SET account_email=EXCLUDED.account_email
      RETURNING id::text`, [input.ownerEmail, input.identity.subject, email])
    await client.query(`INSERT INTO crm_email_mailbox_bindings(owner_email,connection_id,mailbox_id,account_email,verified_at)
      VALUES($1,$2,$3::uuid,$4,date_trunc('milliseconds',now())) ON CONFLICT(owner_email,connection_id) DO UPDATE SET
      account_email=EXCLUDED.account_email,verified_at=EXCLUDED.verified_at
      WHERE crm_email_mailbox_bindings.mailbox_id=EXCLUDED.mailbox_id`,
    [input.ownerEmail, input.connectionId, mailbox.rows[0].id, email])
    await recordAuditEvent({ actor: input.ownerEmail, eventType: 'crm.mailbox_identity.verified', aggregateType: 'crm_email_mailbox',
      aggregateId: mailbox.rows[0].id, eventKey: `crm-mailbox-verified:${mailbox.rows[0].id}:${input.connectionId}`,
      payload: { connectionId: input.connectionId, mailboxId: mailbox.rows[0].id, accountEmail: email, provider: 'gmail' } }, client)
    return { mailboxId: mailbox.rows[0].id, accountEmail: email, verified: true }
}

export type GmailMailboxLabelRepairScope = {
  ownerEmail: string; connectionId: string; pipelineId: string; workspaceOrganizationId: string
}
export type GmailMailboxLabelRepairSnapshot = GmailMailboxLabelRepairScope & {
  accountEmail: string | null; connectionUpdatedAt: string; remoteUpdatedAt: string | null
  remoteCreatedAt: string | null; lastRefreshedAt: string | null; keyVersion: number; keyRotatedAt: string | null
  credentialUpdatedAt: string
  keyMaterialSha256: string; authoritySha256: string
  mailboxId: string | null; providerAccountId: string | null
  bindingAccountEmail: string | null; bindingVerifiedAt: string | null
}
export type GmailMailboxLabelRepairObservation = {
  snapshot: GmailMailboxLabelRepairSnapshot; accountEmail: string; observedAt: string
}
type LabelRepairRow = {
  account_email: string | null; connection_updated_at: string; remote_updated_at: string | null
  remote_created_at: string | null; last_refreshed_at: string | null; api_key_version: number; key_rotated_at: string | null; key_revoked_at: string | null
  credential_updated_at: string
  api_key_ciphertext: Buffer | null; api_key_iv: Buffer | null; api_key_tag: Buffer | null
  authority: Record<string, unknown>
}
function repairCanonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(repairCanonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${repairCanonical((value as Record<string, unknown>)[key])}`).join(',')}}`
  throw unavailable()
}
const repairHash = (value: unknown) => crypto.createHash('sha256').update(repairCanonical(value)).digest('hex')
const repairedEmail = (value: unknown) => {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!email || email.length > 254 || !/^[\x21-\x7e]+$/.test(email) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw unavailable()
  return email
}

async function assertRepairControl(client: PoolClient, lock: boolean) {
  const control = await client.query(`SELECT active_operation_id,active_transition_id,active_initial_enrollment_id
    FROM crm_native_email_publication_control WHERE singleton${lock ? ' FOR UPDATE' : ''}`)
  if (control.rows.length !== 1 || Object.values(control.rows[0]).some(value => value !== null)) throw unavailable()
}

async function readLabelRepairSnapshotWithClient(client: PoolClient, scope: GmailMailboxLabelRepairScope, lock: boolean) {
  if (scope.ownerEmail !== repairedEmail(scope.ownerEmail) || !/^[\w-]{1,200}$/.test(scope.connectionId)) throw unavailable()
  // Credential writers take credential before connection. Keep that ordering
  // after the native control, rather than deadlocking a key/connection refresh.
  if (lock) {
    const credential = await client.query('SELECT owner_email FROM user_maton_credentials WHERE owner_email=$1 FOR SHARE', [scope.ownerEmail])
    if (credential.rows.length !== 1) throw unavailable()
  }
  const rows = await client.query<LabelRepairRow>(`SELECT connection.account_email,
    connection.updated_at::text AS connection_updated_at,connection.remote_created_at::text,connection.remote_updated_at::text,connection.last_refreshed_at::text,
    credential.api_key_version,credential.key_rotated_at::text,credential.key_revoked_at::text,credential.updated_at::text AS credential_updated_at,
    credential.api_key_ciphertext,credential.api_key_iv,credential.api_key_tag,
    jsonb_build_object('ownerRole',owner_user.role,'ownerStatus',owner_user.status,'ownerPermissions',owner_user.permissions,
      'membershipRole',membership.role,'membershipStatus',membership.status,'membershipPermissions',membership.permissions,
      'workspaceId',workspace.id,'workspaceParentId',workspace.parent_id,'workspaceType',workspace.organization_type,
      'pipelineOwner',pipeline.owner_email) AS authority
    FROM user_maton_connections connection
    JOIN user_maton_credentials credential ON credential.owner_email=connection.owner_email
    JOIN app_users owner_user ON owner_user.email=connection.owner_email AND owner_user.status='active'
    JOIN pipeline_spaces pipeline ON pipeline.owner_email=owner_user.email
    JOIN workspace_organizations workspace ON workspace.id=pipeline.workspace_organization_id AND NOT workspace.is_demo
    JOIN app_user_organization_memberships membership ON membership.user_email=owner_user.email
      AND membership.organization_id=workspace.id AND membership.status='active' AND membership.trashed_at IS NULL
      AND (membership.role='owner' OR COALESCE((membership.permissions->>'viewCrm')::boolean,true))
    WHERE connection.owner_email=$1 AND connection.connection_id=$2
      AND connection.app='google-mail' AND connection.source='maton' AND connection.status='ACTIVE' AND connection.is_selected
      AND pipeline.id=$3::uuid AND pipeline.workspace_organization_id=$4::uuid AND NOT pipeline.reference_access_disabled
    ${lock ? 'FOR UPDATE OF connection FOR SHARE OF credential,owner_user,pipeline,workspace,membership' : ''}`,
  [scope.ownerEmail, scope.connectionId, scope.pipelineId, scope.workspaceOrganizationId])
  if (rows.rows.length !== 1) throw unavailable()
  const row = rows.rows[0]
  if (row.key_revoked_at !== null || !Number.isSafeInteger(row.api_key_version) || row.api_key_version < 0
    || !Buffer.isBuffer(row.api_key_ciphertext) || row.api_key_ciphertext.length < 16 || row.api_key_ciphertext.length > 4096
    || !Buffer.isBuffer(row.api_key_iv) || row.api_key_iv.length !== 12
    || !Buffer.isBuffer(row.api_key_tag) || row.api_key_tag.length !== 16) throw unavailable()
  const bindings = await client.query<{ mailbox_id: string; provider: string; provider_account_id: string; account_email: string; verified_at: string }>(
    `SELECT mailbox.id::text AS mailbox_id,mailbox.provider,mailbox.provider_account_id,binding.account_email,binding.verified_at::text
     FROM crm_email_mailbox_bindings binding JOIN crm_email_mailboxes mailbox ON mailbox.id=binding.mailbox_id AND mailbox.owner_email=binding.owner_email
     WHERE binding.owner_email=$1 AND binding.connection_id=$2${lock ? ' FOR UPDATE OF binding,mailbox' : ''}`,
  [scope.ownerEmail, scope.connectionId])
  if (bindings.rows.length > 1 || bindings.rows.some(binding => binding.provider !== 'gmail')) throw unavailable()
  const binding = bindings.rows[0]
  return { ...scope, accountEmail: row.account_email, connectionUpdatedAt: row.connection_updated_at,
    remoteCreatedAt: row.remote_created_at, remoteUpdatedAt: row.remote_updated_at, lastRefreshedAt: row.last_refreshed_at,
    keyVersion: row.api_key_version, keyRotatedAt: row.key_rotated_at, credentialUpdatedAt: row.credential_updated_at,
    keyMaterialSha256: crypto.createHash('sha256').update(row.api_key_ciphertext).update(row.api_key_iv).update(row.api_key_tag).digest('hex'),
    authoritySha256: repairHash(row.authority), mailboxId: binding?.mailbox_id || null,
    providerAccountId: binding?.provider_account_id || null, bindingAccountEmail: binding?.account_email || null,
    bindingVerifiedAt: binding?.verified_at || null } satisfies GmailMailboxLabelRepairSnapshot
}

/** Read-only metadata capture only; never a label repair or identity proof. */
export async function readGmailMailboxLabelRepairSnapshotInPostgres(scope: GmailMailboxLabelRepairScope) {
  return withTransaction(async client => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await assertRepairControl(client, false)
    return readLabelRepairSnapshotWithClient(client, scope, false)
  })
}

function validateRepairObservation(observation: GmailMailboxLabelRepairObservation, identity: VerifiedGoogleIdentity) {
  const accountEmail = repairedEmail(observation.accountEmail)
  const observedAt = Date.parse(observation.observedAt)
  if (!Number.isFinite(observedAt) || observedAt > Date.now() || Date.now() - observedAt > 30_000
    || accountEmail !== repairedEmail(identity.email) || !identity.subject
    || observation.snapshot.providerAccountId !== null && observation.snapshot.providerAccountId !== identity.subject) throw unavailable()
  return accountEmail
}

function labelRepairDigest(snapshot: GmailMailboxLabelRepairSnapshot, accountEmail: string, subject: string, expiresAt: string) {
  const secret = process.env.APP_SESSION_SECRET
  if (!secret || secret.length < 32) throw unavailable()
  return crypto.createHmac('sha256', secret).update(repairCanonical({ version: 1,
    purpose: 'clawpilot-gmail-connection-label-repair', snapshot,
    accountEmail, verifiedSubjectSha256: repairHash(subject), expiresAt })).digest('hex')
}

export function prepareGmailMailboxLabelRepairPreview(input: {
  observation: GmailMailboxLabelRepairObservation; identity: VerifiedGoogleIdentity
}) {
  const accountEmail = validateRepairObservation(input.observation, input.identity)
  const expiresAt = new Date(Date.now() + 300_000).toISOString()
  return { required: input.observation.snapshot.accountEmail?.trim().toLowerCase() !== accountEmail,
    oldAccountEmail: input.observation.snapshot.accountEmail || '', newAccountEmail: accountEmail,
    expectedDigest: labelRepairDigest(input.observation.snapshot, accountEmail, input.identity.subject, expiresAt), expiresAt }
}

export async function applyGmailMailboxLabelRepairInPostgres(input: {
  observation: GmailMailboxLabelRepairObservation; identity: VerifiedGoogleIdentity; expectedDigest: string; expiresAt: string
}) {
  const accountEmail = validateRepairObservation(input.observation, input.identity)
  const expires = Date.parse(input.expiresAt)
  if (!Number.isFinite(expires) || new Date(expires).toISOString() !== input.expiresAt || expires <= Date.now()
    || expires > Date.now() + 300_000 || !/^[a-f0-9]{64}$/.test(input.expectedDigest)
    || input.observation.snapshot.accountEmail?.trim().toLowerCase() === accountEmail) throw unavailable()
  const expected = Buffer.from(input.expectedDigest, 'hex')
  const digest = labelRepairDigest(input.observation.snapshot, accountEmail, input.identity.subject, input.expiresAt)
  if (!crypto.timingSafeEqual(expected, Buffer.from(digest, 'hex'))) throw unavailable()
  return withTransaction(async client => {
    await assertRepairControl(client, true) // Always before credential/source/connection/binding locks.
    const scope = input.observation.snapshot
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`crm-mailbox-binding:${scope.ownerEmail}:${scope.connectionId}`])
    const current = await readLabelRepairSnapshotWithClient(client, {
      ownerEmail: scope.ownerEmail, connectionId: scope.connectionId, pipelineId: scope.pipelineId,
      workspaceOrganizationId: scope.workspaceOrganizationId,
    }, true)
    if (repairHash(current) !== repairHash(scope)
      || current.providerAccountId !== null && current.providerAccountId !== input.identity.subject
      || !crypto.timingSafeEqual(expected, Buffer.from(labelRepairDigest(current, accountEmail, input.identity.subject, input.expiresAt), 'hex'))) throw unavailable()
    // A contended control/credential lock must not extend a reviewed ticket
    // or turn an old provider observation into current evidence.
    validateRepairObservation(input.observation, input.identity)
    if (Date.now() >= expires) throw unavailable()
    const updated = await client.query(`UPDATE user_maton_connections SET account_email=$3,updated_at=clock_timestamp()
      WHERE owner_email=$1 AND connection_id=$2 AND account_email IS NOT DISTINCT FROM $4
        AND updated_at=$5::timestamptz AND app='google-mail' AND source='maton' AND status='ACTIVE' AND is_selected
      RETURNING connection_id`, [scope.ownerEmail, scope.connectionId, accountEmail, current.accountEmail, current.connectionUpdatedAt])
    if (updated.rows.length !== 1) throw unavailable()
    const bound = await bindVerifiedGmailMailboxWithClient(client, { ownerEmail: scope.ownerEmail, connectionId: scope.connectionId,
      identity: input.identity, observedAccountEmail: accountEmail })
    await recordAuditEvent({ actor: scope.ownerEmail, eventType: 'crm.mailbox_connection_label.corrected', aggregateType: 'crm_email_mailbox',
      aggregateId: bound.mailboxId, eventKey: `crm-mailbox-label-repaired:${input.expectedDigest}`,
      organizationId: scope.workspaceOrganizationId,
      payload: { connectionId: scope.connectionId, pipelineId: scope.pipelineId, oldAccountEmail: current.accountEmail,
        newAccountEmail: accountEmail, reviewedDigest: input.expectedDigest, mailboxId: bound.mailboxId } }, client)
    return { ...bound, connectionLabelUpdated: true }
  })
}

export async function readVerifiedGmailMailboxIdentityInPostgres(input: {
  ownerEmail: string; connectionId: string; accountEmail: string
}): Promise<VerifiedGmailMailboxIdentity | null> {
  const result = await query<{ id: string; provider_account_id: string; account_email: string; verified_at: Date }>(`
    SELECT mailbox.id::text,mailbox.provider_account_id,binding.account_email,binding.verified_at
    FROM crm_email_mailboxes mailbox JOIN crm_email_mailbox_bindings binding
      ON binding.mailbox_id=mailbox.id AND binding.owner_email=mailbox.owner_email
    JOIN user_maton_connections connection ON connection.owner_email=binding.owner_email
      AND connection.connection_id=binding.connection_id AND connection.app='google-mail'
      AND connection.source='maton' AND connection.status='ACTIVE' AND connection.is_selected
    JOIN app_users owner_user ON owner_user.email=mailbox.owner_email AND owner_user.status='active'
    WHERE mailbox.owner_email=$1 AND binding.connection_id=$2
      AND lower(btrim(binding.account_email))=$3 AND lower(btrim(connection.account_email))=$3
      AND COALESCE((to_jsonb(connection)->>'remote_updated_at')::timestamptz,'-infinity')<=binding.verified_at`,
  [input.ownerEmail, input.connectionId, input.accountEmail.trim().toLowerCase()])
  if (result.rows.length !== 1) return null
  const row = result.rows[0]
  return { version: 1, provider: 'gmail', mailboxId: row.id, providerAccountId: row.provider_account_id,
    accountEmail: row.account_email, verifiedAt: new Date(row.verified_at).toISOString(), verifiedConnectionId: input.connectionId }
}

export async function lockGmailMailboxBindingWithClient(client: PoolClient, input: {
  ownerEmail: string; connectionId: string; identity: VerifiedGmailMailboxIdentity; observedAt: string
}) {
  verifyGmailMailboxBinding({ identity: input.identity, connectionId: input.connectionId,
    profileEmail: input.identity.accountEmail, observedAt: input.observedAt })
  const result = await client.query(`SELECT mailbox.id FROM crm_email_mailboxes mailbox
    JOIN crm_email_mailbox_bindings binding ON binding.mailbox_id=mailbox.id AND binding.owner_email=mailbox.owner_email
    JOIN user_maton_connections connection ON connection.owner_email=binding.owner_email
      AND connection.connection_id=binding.connection_id AND connection.app='google-mail'
      AND connection.source='maton' AND connection.status='ACTIVE' AND connection.is_selected
    WHERE mailbox.id=$1::uuid AND mailbox.owner_email=$2 AND mailbox.provider='gmail'
      AND mailbox.provider_account_id=$3 AND binding.connection_id=$4
      AND lower(btrim(binding.account_email))=$5 AND lower(btrim(connection.account_email))=$5
      AND COALESCE((to_jsonb(connection)->>'remote_updated_at')::timestamptz,'-infinity')<=binding.verified_at
      AND binding.verified_at=$6::timestamptz FOR SHARE OF mailbox,binding,connection`,
  [input.identity.mailboxId, input.ownerEmail, input.identity.providerAccountId, input.connectionId,
    input.identity.accountEmail, input.identity.verifiedAt])
  if (result.rows.length !== 1) throw unavailable()
}

export async function ensureGmailSourceWithClient(client: PoolClient, input: {
  ownerEmail: string; connectionId: string; identity: VerifiedGmailMailboxIdentity; observedAt: string
  intakePipelineId: string; intakeWorkspaceId: string; evidence: GmailMessageEvidence
}) {
  await lockGmailMailboxBindingWithClient(client, input)
  const provenance = gmailIntakeProvenance({ ...input, intakeWorkspaceOrganizationId: input.intakeWorkspaceId })
  const hash = gmailEvidenceHash(input.evidence)
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',
    [`crm-email-source:${input.identity.mailboxId}:${input.evidence.messageId}`])
  await client.query(`INSERT INTO crm_email_sources(mailbox_id,owner_email,provider_message_id,provider_thread_id,
    intake_pipeline_id,intake_workspace_id,observed_connection_id,observed_account_email,evidence,evidence_hash,provenance)
    VALUES($1::uuid,$2,$3,$4,$5::uuid,$6::uuid,$7,$8,$9::jsonb,$10,$11::jsonb)
    ON CONFLICT(mailbox_id,provider_message_id) DO NOTHING`,
  [input.identity.mailboxId, input.ownerEmail, input.evidence.messageId, input.evidence.threadId,
    input.intakePipelineId, input.intakeWorkspaceId, input.connectionId, input.identity.accountEmail,
    JSON.stringify(input.evidence), hash, JSON.stringify(provenance)])
  const selected = await client.query<{ id: string; evidence_hash: string; owner_email: string }>(`SELECT id::text,evidence_hash,owner_email
    FROM crm_email_sources WHERE mailbox_id=$1::uuid AND provider_message_id=$2 FOR UPDATE`,
  [input.identity.mailboxId, input.evidence.messageId])
  const row = selected.rows[0]
  if (!row || row.evidence_hash !== hash || row.owner_email !== input.ownerEmail) throw unavailable()
  return { sourceId: row.id, provenance }
}

export async function recordGmailMessageIntakeInPostgres(input: {
  ownerEmail: string; connectionId: string; intakePipelineId: string
  mailboxIdentity: VerifiedGmailMailboxIdentity | null; observedAccountEmail: string; observedAt: string
  messageEvidence: GmailMessageEvidence; rawMetadata: Record<string, unknown>
}): Promise<{ id: string; pipelineId: string; inserted: boolean; identityStatus: 'verified' | 'unknown'; sourceId?: string }> {
  return withTransaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`crm-email-intake:${input.ownerEmail}:${input.messageEvidence.messageId}`])
    const scope = await client.query<{ workspace_id: string }>(`SELECT pipeline.workspace_organization_id::text AS workspace_id
      FROM pipeline_spaces pipeline JOIN app_users owner_user ON owner_user.email=pipeline.owner_email AND owner_user.status='active'
      JOIN app_user_organization_memberships membership ON membership.organization_id=pipeline.workspace_organization_id
        AND membership.user_email=pipeline.owner_email AND membership.status='active'
      JOIN user_maton_connections connection ON connection.owner_email=pipeline.owner_email
        AND connection.connection_id=$3 AND connection.app='google-mail' AND connection.source='maton'
        AND connection.status='ACTIVE' AND connection.is_selected AND lower(btrim(connection.account_email))=$4
      WHERE pipeline.id=$1::uuid AND pipeline.owner_email=$2 AND NOT pipeline.reference_access_disabled
      FOR SHARE OF pipeline,owner_user,membership,connection`,
    [input.intakePipelineId, input.ownerEmail, input.connectionId, input.observedAccountEmail.trim().toLowerCase()])
    if (scope.rows.length !== 1) throw unavailable()
    if (input.mailboxIdentity) verifyGmailMailboxBinding({ identity: input.mailboxIdentity, connectionId: input.connectionId,
      profileEmail: input.observedAccountEmail, observedAt: input.observedAt })
    const source = input.mailboxIdentity ? await ensureGmailSourceWithClient(client, {
      ownerEmail: input.ownerEmail, connectionId: input.connectionId, identity: input.mailboxIdentity,
      observedAt: input.observedAt, intakePipelineId: input.intakePipelineId,
      intakeWorkspaceId: scope.rows[0].workspace_id, evidence: input.messageEvidence,
    }) : null
    const evidence = input.messageEvidence
    const raw = { ...input.rawMetadata, provider: 'gmail', emailAddressHeaders: evidence.emailAddressHeaders,
      identityStatus: source ? 'verified' : 'unknown',
      ...(source ? { intakeProvenance: source.provenance } : { originalMailboxProvenance: 'unknown',
        intakeObservation: { version: 1, observedConnectionId: input.connectionId,
          observedAccountEmail: input.observedAccountEmail, observedAt: input.observedAt,
          intakePipelineId: input.intakePipelineId, intakeWorkspaceOrganizationId: scope.rows[0].workspace_id,
          providerAccountIdentity: 'unknown' } }) }
    const inserted = await client.query<{ id: string }>(`INSERT INTO crm_inbound_messages
      (owner_email,pipeline_id,external_message_id,external_thread_id,sender_email,recipient_emails,subject,received_at,
       snippet,body_text,marker_references,raw_metadata,mailbox_id,canonical_source_id)
      VALUES($1,$2::uuid,$3,$4,$5,$6,$7,$8::timestamptz,$9,$10,$11,$12::jsonb,$13::uuid,$14::uuid)
      ON CONFLICT(owner_email,external_message_id) DO NOTHING RETURNING id::text`,
    [input.ownerEmail, input.intakePipelineId, evidence.messageId, evidence.threadId, evidence.senderEmail,
      evidence.recipientEmails, evidence.subject, evidence.receivedAt, evidence.snippet, evidence.bodyText,
      evidence.markerReferences, JSON.stringify(raw), input.mailboxIdentity?.mailboxId || null, source?.sourceId || null])
    const selected = await client.query<Record<string, unknown>>(`SELECT * FROM crm_inbound_messages
      WHERE owner_email=$1 AND external_message_id=$2 FOR UPDATE`, [input.ownerEmail, evidence.messageId])
    const cached = selected.rows[0]
    if (!cached) throw unavailable()
    const verified = Boolean(source && cached.canonical_source_id === source.sourceId
      && cached.mailbox_id === input.mailboxIdentity!.mailboxId)
    if (verified) assertSameRetainedGmailEvidence(retainedGmailMessageEvidence(cached), evidence)
    // A second mailbox's colliding provider ID is preserved in canonical sources
    // but cannot borrow the old cache, links or activity. It remains held.
    return { id: String(cached.id), pipelineId: String(cached.pipeline_id), inserted: inserted.rows.length === 1,
      identityStatus: verified ? 'verified' : 'unknown', ...(source ? { sourceId: source.sourceId } : {}) }
  })
}

export function gmailDecisionId() { return crypto.randomUUID() }
